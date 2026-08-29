/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * End-to-end check for the Onyx agent surface against the mock runtime.
 *
 *   node test/onyx/run-e2e.mts [--keep]
 *
 * Builds a throwaway workspace and profile, starts the mock runtime, launches
 * Code OSS with remote debugging, drives the chat surface with @playwright/cli
 * and asserts on the run journal Onyx writes per workspace. Exits non-zero on
 * the first failed assertion.
 *
 * Requires a current `npm run compile` (or `transpile-client` plus built-in
 * extensions) - it runs the app, it does not build it.
 */

import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const keep = process.argv.includes('--keep');
const mockPort = Number(process.env.ONYX_MOCK_PORT ?? 11434);
const lmStudioPort = Number(process.env.ONYX_MOCK_LMSTUDIO_PORT ?? 1234);
const cdpPort = Number(process.env.ONYX_CDP_PORT ?? 9333);
const session = `onyx-e2e-${process.pid}`;

const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onyx-e2e-'));
const workspace = path.join(runDir, 'ws');
const userDataDir = path.join(runDir, 'user-data');
const extensionsDir = path.join(runDir, 'extensions');

const children: ReturnType<typeof spawn>[] = [];
const failures: string[] = [];

function check(name: string, condition: boolean, detail?: string) {
	if (condition) {
		console.log(`  ok   ${name}`);
	} else {
		console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
		failures.push(name);
	}
}

function sleep(ms: number) {
	return new Promise(resolve => setTimeout(resolve, ms));
}

function pw(...args: string[]) {
	return execFileSync('npx', ['@playwright/cli', `-s=${session}`, ...args], { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function git(...args: string[]) {
	return execFileSync('git', ['-C', workspace, '-c', 'user.email=onyx-e2e@localhost', '-c', 'user.name=onyx-e2e', ...args], { encoding: 'utf8' });
}

function seedWorkspace() {
	fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
	// A tsconfig is required: without a project the TS server answers workspace
	// symbol queries but silently has no call hierarchy.
	fs.writeFileSync(path.join(workspace, 'tsconfig.json'), JSON.stringify({
		compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'bundler', strict: true, noEmit: true },
		include: ['src'],
	}, null, '\t'));
	// A file that stays closed in the editor: the review/commit checks modify it
	// on disk, which must not collide with unsaved editor buffers.
	fs.writeFileSync(path.join(workspace, 'src', 'util.ts'), [
		'export function clamp(value: number, min: number, max: number): number {',
		'\treturn Math.min(max, Math.max(min, value));',
		'}',
		'',
	].join('\n'));
	fs.writeFileSync(path.join(workspace, 'src', 'math.ts'), [
		'export function addNumbers(a: number, b: number): number {',
		'\treturn a + b;',
		'}',
		'',
		'export function computeTotal(values: number[]): number {',
		'\tlet total = 0;',
		'\tfor (const value of values) {',
		'\t\ttotal = addNumbers(total, value);',
		'\t}',
		'\treturn total;',
		'}',
		'',
	].join('\n'));
	fs.writeFileSync(path.join(workspace, 'src', 'report.ts'), [
		'import { computeTotal } from \'./math.js\';',
		'',
		'export function summarize(values: number[]): string {',
		'\treturn `total=${computeTotal(values)}`;',
		'}',
		'',
	].join('\n'));
	// A doc for the offline docs mirror to find.
	fs.mkdirSync(path.join(workspace, 'docs'), { recursive: true });
	fs.writeFileSync(path.join(workspace, 'docs', 'notes.md'), [
		'# Project notes',
		'',
		'## Clamp helper',
		'',
		'The clamp helper bounds a value between min and max.',
		'Use clamp instead of manual Math.min/Math.max chains.',
		'',
	].join('\n'));
	// A playbook for the playbook tool to fetch.
	fs.mkdirSync(path.join(workspace, '.onyx', 'playbooks'), { recursive: true });
	fs.writeFileSync(path.join(workspace, '.onyx', 'playbooks', 'e2e-recipe.md'), [
		'---',
		'name: e2e-recipe',
		'description: A recipe used by the end-to-end test',
		'when-to-use: When the E2E asks for it',
		'---',
		'',
		'1. Confirm the recipe body reached the model.',
		'',
	].join('\n'));
	// Native dialogs are invisible to CDP; the terminal approval needs DOM dialogs.
	fs.mkdirSync(path.join(userDataDir, 'User'), { recursive: true });
	fs.writeFileSync(path.join(userDataDir, 'User', 'settings.json'), JSON.stringify({
		'window.dialogStyle': 'custom',
		'files.simpleDialog.enable': true,
	}, null, '\t'));
	// The commit-message and review flows diff a real repository.
	git('init', '-q');
	git('add', '-A');
	git('commit', '-qm', 'initial');
	// A small, single-file second commit: the repo benchmark needs one to
	// generate a task from.
	fs.appendFileSync(path.join(workspace, 'src', 'math.ts'), [
		'export function scaleAll(values: number[], factor: number): number[] {',
		'\treturn values.map(value => value * factor);',
		'}',
		'',
	].join('\n'));
	git('add', '-A');
	git('commit', '-qm', 'Add scaleAll helper for uniform scaling');
}

async function isListening(port: number): Promise<boolean> {
	try {
		const response = await fetch(`http://127.0.0.1:${port}/json/version`);
		return response.ok;
	} catch {
		return false;
	}
}

async function waitForCdp(timeoutMs: number) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const response = await fetch(`http://127.0.0.1:${cdpPort}/json/version`);
			if (response.ok) {
				return true;
			}
		} catch {
			// not up yet
		}
		await sleep(500);
	}
	return false;
}

/**
 * Waits for *our* mock, not merely for something on the port: a real Ollama
 * left running there would answer every probe and quietly turn this into a
 * non-deterministic test against live models.
 */
async function waitForMock(timeoutMs: number) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const response = await fetch(`http://127.0.0.1:${mockPort}/v1/models`);
			if (response.ok) {
				const body = await response.json() as { data?: { id: string }[] };
				return (body.data ?? []).some(model => model.id.startsWith('mock-'));
			}
		} catch {
			// not up yet
		}
		await sleep(200);
	}
	return false;
}

function journalDir(): string | undefined {
	const storageRoot = path.join(userDataDir, 'User', 'workspaceStorage');
	if (!fs.existsSync(storageRoot)) {
		return undefined;
	}
	for (const hash of fs.readdirSync(storageRoot)) {
		const candidate = path.join(storageRoot, hash, 'onyx', 'journal', 'runs');
		if (fs.existsSync(candidate)) {
			return candidate;
		}
	}
	return undefined;
}

/** Every journaled run, oldest first, with its events parsed. */
function readRuns() {
	const dir = journalDir();
	if (!dir) {
		return [];
	}
	return fs.readdirSync(dir)
		.filter(name => name.endsWith('.jsonl'))
		.sort()
		.map(name => ({
			name,
			events: fs.readFileSync(path.join(dir, name), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as { kind: string; data?: any }),
		}));
}

/**
 * Types into a real editor so the inline-completion provider fires. Ghost text
 * is deliberately scoped to document editors, so this must not go through the
 * chat input.
 */
async function typeInEditor() {
	// Activate both tabs first: cross-file FIM context only reads text models
	// that are already loaded, and a tab that was never focused has none.
	pw('run-code', 'async (page) => { const tabs = await page.$$(".tabs-container .tab"); for (const tab of tabs) { await tab.click(); await page.waitForTimeout(400); } }');
	pw('run-code', 'async (page) => { const el = await page.$(".editor-instance .monaco-editor .view-lines"); if (!el) { return; } const r = await el.boundingBox(); await page.mouse.click(r.x + 60, r.y + 20); }');
	pw('press', 'Meta+ArrowDown');
	for (const key of ['e', 'x', 'p', 'o', 'r', 't', 'Space', 'c', 'o', 'n', 's', 't', 'Space', 'q']) {
		pw('press', key);
	}
	await sleep(5000);
}

/**
 * Runs a workbench command through the Command Palette. The quick-input box is
 * a real `<input>`, so Playwright's fill works — unlike the Monaco chat input.
 */
async function runCommand(label: string) {
	pw('press', 'F1');
	await sleep(800);
	pw('run-code', `async (page) => { await page.fill('.quick-input-box input', ${JSON.stringify('>' + label)}); }`);
	await sleep(1000);
	pw('press', 'Enter');
}

/** The run index Onyx persists next to the journal; title/task/status per run. */
function readRunIndex(): { title: string; task: string; status: string; runId: string }[] {
	const dir = journalDir();
	if (!dir) {
		return [];
	}
	const indexPath = path.join(path.dirname(dir), 'index.json');
	if (!fs.existsSync(indexPath)) {
		return [];
	}
	try {
		return JSON.parse(fs.readFileSync(indexPath, 'utf8'));
	} catch {
		return [];
	}
}

async function send(prompt: string) {
	const focusScript = path.join(repoRoot, '.claude', 'skills', 'launch', 'playwrightScripts', 'focus-chat-input.ts');
	const paste = path.join(repoRoot, '.claude', 'skills', 'launch', 'scripts', 'monaco-paste.sh');
	pw('run-code', `--filename=${focusScript}`);
	execFileSync(paste, ['--session', session, prompt], { cwd: repoRoot, encoding: 'utf8' });
	pw('press', 'Enter');
}

async function main() {
	console.log(`run dir: ${runDir}`);
	// A workbench left over from an earlier run would answer every probe and
	// this one would then drive the wrong window.
	if (await isListening(cdpPort)) {
		throw new Error(`something is already debugging on :${cdpPort} — close it, or set ONYX_CDP_PORT`);
	}
	seedWorkspace();

	children.push(spawn(process.execPath, [path.join(repoRoot, 'test', 'onyx', 'mock-ollama.mts')], {
		cwd: repoRoot,
		env: { ...process.env, ONYX_MOCK_PORT: String(mockPort) },
		stdio: 'ignore',
	}));
	if (!await waitForMock(10_000)) {
		throw new Error(`the mock runtime never answered on :${mockPort} — stop any real runtime on that port, or set ONYX_MOCK_PORT`);
	}
	// A second mock posing as LM Studio (its port, no Ollama native API), so
	// the speculative-decoding flow has a per-request-draft runtime to talk to.
	children.push(spawn(process.execPath, [path.join(repoRoot, 'test', 'onyx', 'mock-ollama.mts')], {
		cwd: repoRoot,
		env: { ...process.env, ONYX_MOCK_PORT: String(lmStudioPort), ONYX_MOCK_KIND: 'lmstudio' },
		stdio: 'ignore',
	}));

	children.push(spawn(path.join(repoRoot, 'scripts', 'code.sh'), [
		`--user-data-dir=${userDataDir}`,
		`--extensions-dir=${extensionsDir}`,
		`--remote-debugging-port=${cdpPort}`,
		'--disable-workspace-trust',
		'--skip-release-notes',
		workspace,
		// Opened up front so the TypeScript server has a project (without one it
		// answers workspace-symbol queries but has no call hierarchy) and the
		// context ranker has editor signals to rank.
		path.join(workspace, 'src', 'math.ts'),
		path.join(workspace, 'src', 'report.ts'),
	], { cwd: repoRoot, env: { ...process.env, VSCODE_SKIP_PRELAUNCH: '1' }, stdio: 'ignore', detached: true }));

	if (!await waitForCdp(120_000)) {
		throw new Error('the workbench never opened a CDP endpoint');
	}
	pw('attach', `--cdp=http://127.0.0.1:${cdpPort}`);
	await sleep(6000);

	// Onboarding: "Connect a Local Runtime" then "Make It Yours".
	for (let i = 0; i < 2; i++) {
		try {
			pw('click', 'button.onboarding-a-btn-primary');
		} catch {
			break; // already dismissed
		}
		await sleep(1500);
	}
	await sleep(2000);

	// Give the TypeScript server time to load the project before asking for symbols.
	await sleep(15000);

	await send('TOOLTEST exercise the tool loop');
	await sleep(9000);
	await send('SYMTEST computeTotal EXPAND');
	await sleep(14000);
	await send('MEMTEST this project indents with tabs');
	await sleep(9000);
	// Prompts are built once per run, so a fact remembered during a run first
	// shows up in the next one — hence a fourth, deliberately boring request.
	await send('Thanks, that is all.');
	await sleep(9000);

	const runs = readRuns();
	check('four runs were journaled', runs.length >= 4, `saw ${runs.length}`);

	const all = runs.flatMap(run => run.events);
	const toolCalls: string[] = all.filter(event => event.kind === 'toolCall').map(event => event.data?.label);
	check('the tool loop ran', toolCalls.length >= 3, `tool calls: ${toolCalls.join(', ') || 'none'}`);
	check('repoSymbols was called', toolCalls.includes('repoSymbols'));
	check('remember was called', toolCalls.includes('remember'));

	// resumeMeta snapshots are journal-only metadata; the prompt checks want
	// the last snapshot that actually carried messages.
	const snapshots = all.filter(event => event.kind === 'promptSnapshot' && (event.data as { messages?: unknown[] })?.messages);
	const lastPrompt = JSON.stringify(snapshots[snapshots.length - 1]?.data ?? {});
	const promptDetail = () => {
		const context = /Workspace context[^"]{0,400}/.exec(lastPrompt)?.[0] ?? lastPrompt.slice(0, 400);
		return context.replaceAll('\\n', ' ');
	};
	check('the prompt carries workspace context', lastPrompt.includes('Files the user is working on'), promptDetail());
	check('the prompt carries agent memory', lastPrompt.includes('Facts remembered from earlier sessions'), promptDetail());

	const symbolResult = snapshots.map(snapshot => JSON.stringify(snapshot.data)).find(text => text.includes('Call graph of computeTotal'));
	check('repoSymbols returned a call graph', !!symbolResult, 'no call-graph section in any tool result');

	const verdicts = all.filter(event => event.kind === 'note' && /Verification/.test(event.data?.label ?? ''));
	check('post-run verification reported', verdicts.length >= 1, 'no verification note');

	await typeInEditor();
	// The FIM model is the smallest one discovered; with two mock endpoints it
	// can live on either, so ask both for the last completion request.
	let lastCompletion: { prompt?: string } | undefined;
	for (const port of [mockPort, lmStudioPort]) {
		const candidate = await fetch(`http://127.0.0.1:${port}/debug/last-completion`)
			.then(response => response.json() as Promise<{ prompt?: string }>)
			.catch(() => undefined);
		if (candidate?.prompt) {
			lastCompletion = candidate;
		}
	}
	check('inline completions reached the runtime', !!lastCompletion?.prompt, 'no fill-in-the-middle request was recorded');
	check('the completion prompt carries the file being edited', !!lastCompletion?.prompt?.includes('export function '), lastCompletion?.prompt?.slice(0, 80));
	check('the completion prompt carries cross-file context', !!lastCompletion?.prompt?.includes('Context from'), lastCompletion?.prompt?.slice(0, 120));

	// --- Fix with Onyx: the truncated `export const q` line the FIM typing left
	// behind is a real TS error; the code action must route it into chat.
	await sleep(8000); // let the TS server produce the diagnostic
	pw('press', 'Meta+.');
	await sleep(2500);
	const fixClicked = pw('run-code', `async (page) => {
		const rows = await page.$$('.action-widget [role=option], .action-widget .monaco-list-row');
		for (const row of rows) {
			if ((await row.textContent())?.includes('Fix with Onyx')) {
				const box = await row.boundingBox();
				await page.mouse.click(box.x + 12, box.y + box.height / 2);
				return 'clicked';
			}
		}
		return 'not-found';
	}`);
	await sleep(9000);
	check('Fix with Onyx routed into a chat run', readRunIndex().some(run => run.title.startsWith('Fix this problem')), fixClicked.includes('clicked') ? 'no run titled "Fix this problem…"' : 'code action not found in the action widget');

	// --- Explain with Onyx on a selection.
	pw('press', 'Escape');
	pw('run-code', 'async (page) => { const el = await page.$(".editor-instance .monaco-editor .view-lines"); const r = await el.boundingBox(); await page.mouse.click(r.x + 60, r.y + 20); }');
	pw('press', 'Meta+a');
	pw('press', 'Meta+.');
	await sleep(2500);
	const explainClicked = pw('run-code', `async (page) => {
		const rows = await page.$$('.action-widget [role=option], .action-widget .monaco-list-row');
		for (const row of rows) {
			if ((await row.textContent())?.includes('Explain with Onyx')) {
				const box = await row.boundingBox();
				await page.mouse.click(box.x + 12, box.y + box.height / 2);
				return 'clicked';
			}
		}
		return 'not-found';
	}`);
	await sleep(9000);
	check('Explain with Onyx routed into a chat run', readRunIndex().some(run => run.title.startsWith('Explain this code')), explainClicked.includes('clicked') ? 'no run titled "Explain this code…"' : 'code action not found in the action widget');

	// --- Model library: the quick pick opens with the machine-sized catalog.
	await runCommand('Onyx: Manage Models');
	await sleep(3000);
	const libraryState = pw('run-code', `async (page) => {
		const title = await page.$('.quick-input-titlebar');
		const rows = await page.$$('.quick-input-list .monaco-list-row');
		const texts = [];
		for (const row of rows.slice(0, 12)) { texts.push(await row.textContent()); }
		return JSON.stringify({ title: title ? await title.textContent() : '', rows: texts.join(' | ') });
	}`);
	check('the model library opens', libraryState.includes('Onyx model library'), libraryState.slice(0, 160));
	check('the library lists installed mock models', libraryState.includes('mock-coder'), 'installed models missing from the pick');
	pw('press', 'Escape');
	await sleep(1000);

	// --- Commit message: staged diff → routed one-shot → SCM input + journal.
	fs.appendFileSync(path.join(workspace, 'src', 'util.ts'), '\nexport function double(value: number): number {\n\treturn value * 2;\n}\n');
	git('add', '-A');
	await runCommand('Onyx: Generate Commit Message');
	await sleep(9000);
	const commitRun = readRunIndex().find(run => run.title.startsWith('Commit message'));
	check('the commit-message run was journaled', !!commitRun && commitRun.status === 'completed', JSON.stringify(readRunIndex().map(run => run.title)));
	const lastChat = await fetch(`http://127.0.0.1:${mockPort}/debug/last-chat`)
		.then(response => response.json() as Promise<{ messages?: { role: string; content: string }[] }>)
		.catch(() => undefined);
	check('the commit prompt reached the runtime', JSON.stringify(lastChat ?? {}).includes('git commit messages'), 'no commit-message system prompt in the last chat request');

	// --- Inline edit (Cmd+I): the widget, a streamed SEARCH/REPLACE edit, and
	// the hunk review keyboard flow.
	pw('run-code', 'async (page) => { const tabs = await page.$$(".tabs-container .tab"); for (const tab of tabs) { const t = await tab.textContent(); if (t && t.includes("math.ts")) { await tab.click(); break; } } }');
	await sleep(1500);
	pw('run-code', 'async (page) => { const el = await page.$(".editor-instance .monaco-editor .view-lines"); const r = await el.boundingBox(); await page.mouse.click(r.x + 60, r.y + 12); }');
	pw('press', 'Meta+Home');
	for (let i = 0; i < 3; i++) {
		pw('press', 'Shift+ArrowDown');
	}
	pw('press', 'Meta+i');
	await sleep(1500);
	const widgetOpened = pw('run-code', 'async (page) => { const input = await page.$(".onyx-inline-edit-input"); if (!input) { return "missing"; } await input.fill("mark this function"); return "filled"; }');
	check('the inline edit widget opens on the selection', widgetOpened.includes('filled'), widgetOpened.slice(0, 120));
	pw('press', 'Enter');
	await sleep(6000);
	const hunkState = pw('run-code', `async (page) => page.evaluate(() => ({
		edited: Array.from(document.querySelectorAll('.editor-instance .view-line')).some(l => (l.textContent || '').includes('edited-by-mock')),
		decorated: !!document.querySelector('.onyx-inline-hunk'),
	}))`);
	check('the inline edit applied a reviewable hunk', /"edited"\s*:\s*true/.test(hunkState) && /"decorated"\s*:\s*true/.test(hunkState), hunkState.slice(0, 160));
	// Undo the hunk: the original line must come back verbatim.
	pw('run-code', 'async (page) => { const ed = await page.$(".editor-instance .native-edit-context, .editor-instance textarea.inputarea"); await ed.focus(); }');
	pw('press', 'Meta+Backspace');
	await sleep(1500);
	const afterReject = pw(`run-code`, `async (page) => page.evaluate(() => Array.from(document.querySelectorAll('.editor-instance .view-line')).some(l => (l.textContent || '').includes('edited-by-mock')))`);
	check('undoing a hunk restores the original line', /false/.test(afterReject), afterReject.slice(0, 120));
	check('the inline edit run was journaled', readRunIndex().some(run => run.title.startsWith('Inline edit')), JSON.stringify(readRunIndex().map(run => run.title).slice(0, 6)));

	// --- Review: staged + unstaged changes reviewed, journaled with a snapshot.
	fs.appendFileSync(path.join(workspace, 'src', 'util.ts'), '\nexport function triple(value: number): number {\n\treturn value * 3;\n}\n');
	await runCommand('Onyx: Review My Changes');
	await sleep(10000);
	const reviewRun = readRunIndex().find(run => run.task === 'review');
	check('the review run was journaled', !!reviewRun && reviewRun.status === 'completed', JSON.stringify(readRunIndex().map(run => run.task)));
	const reviewEvents = reviewRun ? readRuns().find(run => run.name.startsWith(reviewRun.runId))?.events ?? [] : [];
	check('the review run carries a replayable prompt snapshot', reviewEvents.some(event => event.kind === 'promptSnapshot'), 'no promptSnapshot event in the review journal');
	check('the review produced a file:line finding', reviewEvents.some(event => event.kind === 'note' && event.data?.location?.path), 'no finding with a location');

	// --- Staged edits (Onyx Changes): the agent's edits stage for review and
	// only an explicit accept touches the buffer.
	await send('EDITTEST src/math.ts stage an edit for review');
	await sleep(9000);
	const mathOnDisk = fs.readFileSync(path.join(workspace, 'src', 'math.ts'), 'utf8');
	check('agent edits stage instead of writing the file', !mathOnDisk.includes('edited-by-mock'), 'the tool wrote into the file without review');
	const stagedSnapshot = JSON.stringify(readRuns().flatMap(run => run.events).filter(event => event.kind === 'promptSnapshot').slice(-2));
	check('the edit tool reported the staged review to the model', stagedSnapshot.includes('reviews them in Onyx Changes'), 'no staging summary in the tool result');
	pw('press', 'Meta+Control+o'); // open the control plane
	await sleep(2000);
	const changesState = pw('run-code', `async (page) => page.evaluate(() => ({
		files: Array.from(document.querySelectorAll('.onyx-change-file-path')).map(el => el.textContent),
	}))`);
	check('the staged file appears in Onyx Changes', changesState.includes('src/math.ts'), changesState.slice(0, 160));
	pw('run-code', 'async (page) => { const el = await page.$(".onyx-changes-summary button"); await el.click(); }'); // Accept All
	await sleep(2500);
	const acceptedState = pw('run-code', `async (page) => page.evaluate(() => ({
		empty: !!document.querySelector('.onyx-changes .onyx-empty'),
	}))`);
	check('accepting applies and clears the staged set', /"empty"\s*:\s*true/.test(acceptedState), acceptedState.slice(0, 120));

	// --- Terminal tool: approval dialog, execution, journaled output.
	await send('TERMTEST echo onyx-e2e-terminal-ok');
	await sleep(6000);
	const approval = pw('run-code', `async (page) => {
		const detail = await page.$('.monaco-dialog-box .dialog-message-detail');
		if (!detail) { return 'no-dialog'; }
		const text = await detail.textContent();
		const buttons = await page.$$('.monaco-dialog-box a.monaco-text-button');
		for (const button of buttons) {
			if ((await button.textContent())?.includes('Run Once')) { await button.click(); return 'approved:' + text; }
		}
		return 'no-run-once:' + text;
	}`);
	check('the terminal tool asks before running', approval.includes('approved:'), approval.slice(0, 160));
	check('the approval names the exact command', approval.includes('echo onyx-e2e-terminal-ok'), approval.slice(0, 160));
	await sleep(6000);
	const terminalNotes = readRuns().flatMap(run => run.events).filter(event => event.kind === 'note').map(event => String(event.data?.label ?? ''));
	check('the command ran and its exit landed on the timeline', terminalNotes.some(label => label.startsWith('Running: echo onyx-e2e-terminal-ok')) && terminalNotes.some(label => label.startsWith('Exited with code 0')), terminalNotes.slice(-6).join(' | '));

	// --- Offline docs mirror: the docs tool finds the workspace's own docs.
	await send('DOCTEST clamp helper bounds');
	await sleep(10000);
	const docsNotes = readRuns().flatMap(run => run.events).filter(event => event.kind === 'note').map(event => `${event.data?.label} ${event.data?.reason ?? ''}`);
	check('the docs tool searched the offline mirror', docsNotes.some(note => note.includes('offline docs mirror') && note.includes('docs/notes.md')), docsNotes.slice(-4).join(' | '));

	// --- Playbooks: the index reaches the prompt and the tool fetches the recipe.
	await send('PBTEST e2e-recipe');
	await sleep(9000);
	const playbookSnapshots = readRuns().flatMap(run => run.events).filter(event => event.kind === 'promptSnapshot').map(event => JSON.stringify(event.data));
	check('the prompt advertises the repository playbooks', playbookSnapshots.some(text => text.includes('ships playbooks') && text.includes('e2e-recipe')), 'no playbook index in any prompt');
	check('the playbook tool fetched the recipe body', playbookSnapshots.some(text => text.includes('Follow this repository playbook') && text.includes('Confirm the recipe body reached the model')), 'the recipe body never reached a tool result');

	// --- Resume: stop a deliberately slow run mid-stream, then resume it.
	await send('SLOWTEST take your time with this one');
	await sleep(4000);
	const stopClicked = pw('run-code', `async (page) => {
		const stop = await page.$('.onyx-run.running .codicon-debug-stop');
		if (!stop) { return 'no-stop-button'; }
		await stop.click(); return 'stopped';
	}`);
	await sleep(3000);
	check('a streaming run can be stopped from the control plane', stopClicked.includes('stopped'), stopClicked);
	await runCommand('Onyx: Resume an Interrupted Run');
	await sleep(2500);
	pw('press', 'Enter'); // pick the stopped run
	await sleep(8000);
	const resumeRun = readRunIndex().find(run => run.title.startsWith('Resume an interrupted task'));
	check('resuming rebuilds the task as a new run', !!resumeRun, JSON.stringify(readRunIndex().map(run => run.title).slice(0, 6)));

	// --- Refactor engine: model-suggested rename staged through Onyx Changes.
	pw('run-code', 'async (page) => { const tabs = await page.$$(".tabs-container .tab"); for (const tab of tabs) { const t = await tab.textContent(); if (t && t.includes("report.ts")) { await tab.click(); break; } } }');
	await sleep(1500);
	pw('run-code', 'async (page) => { const el = await page.$(".editor-instance .monaco-editor .view-lines"); const r = await el.boundingBox(); await page.mouse.click(r.x + 60, r.y + 20); }');
	pw('press', 'Control+g');
	await sleep(800);
	pw('run-code', `async (page) => { await page.fill('.quick-input-box input', ':3:20'); }`);
	pw('press', 'Enter');
	await sleep(1000);
	await runCommand('Onyx: Rename Symbol with Onyx');
	await sleep(9000);
	const renamePick = pw('run-code', `async (page) => {
		const rows = await page.$$('.quick-input-widget .monaco-list-row');
		const texts = [];
		for (const row of rows) { texts.push(await row.getAttribute('aria-label')); }
		if (texts.some(text => text && text.includes('mockSuggestedName'))) { await page.keyboard.press('Enter'); return 'picked:' + texts.join(';'); }
		return 'no-suggestions:' + texts.join(';');
	}`);
	check('the rename flow offers model-suggested names', renamePick.includes('picked:'), renamePick.slice(0, 200));
	await sleep(4000);
	// The rename routed a naming run through chat, which swapped the aux bar
	// away from the control plane — bring it back before reading the view.
	pw('press', 'Meta+Control+o');
	await sleep(1500);
	const renameStaged = pw('run-code', `async (page) => page.evaluate(() => ({
		files: Array.from(document.querySelectorAll('.onyx-change-file-path')).map(el => el.textContent),
		notifications: Array.from(document.querySelectorAll('.notifications-toasts .notification-list-item-message')).map(el => el.textContent),
	}))`);
	check('the rename staged into Onyx Changes, not the buffer', renameStaged.includes('report.ts'), renameStaged.slice(0, 300));
	pw('run-code', 'async (page) => { const buttons = await page.$$(".onyx-changes-summary button"); await buttons[1].click(); }'); // Reject All
	await sleep(1500);

	// --- Repo benchmark: history-derived tasks, scored, results doc.
	await runCommand('Onyx: Benchmark on This Repo');
	await sleep(3000);
	pw('press', 'Enter'); // accept the preselected models
	await sleep(15000);
	const benchRun = readRunIndex().find(run => run.title.startsWith('Repo benchmark'));
	check('the repo benchmark journaled a run', !!benchRun && benchRun.status === 'completed', JSON.stringify(readRunIndex().map(run => run.title).slice(0, 4)));
	const benchDoc = pw('run-code', `async (page) => page.evaluate(() => Array.from(document.querySelectorAll('.editor-instance .view-line')).map(l => l.textContent).join('\\n').slice(0, 400))`);
	check('the benchmark opened its evidence document', benchDoc.includes('Onyx repo benchmark'), benchDoc.slice(0, 160));

	// --- Speculative decoding: pair a draft on the LM Studio mock and verify
	// the draft went over the wire.
	await runCommand('Onyx: Measure Speculative Decoding');
	await sleep(2500);
	pw('run-code', `async (page) => { const rows = await page.$$('.quick-input-widget .monaco-list-row'); for (const row of rows) { if ((await row.getAttribute('aria-label'))?.includes('32b')) { await row.click(); return; } } }`);
	await sleep(1500);
	pw('run-code', `async (page) => { const rows = await page.$$('.quick-input-widget .monaco-list-row'); for (const row of rows) { if ((await row.getAttribute('aria-label'))?.includes('7b')) { await row.click(); return; } } }`);
	await sleep(15000);
	const lmChats = await fetch(`http://127.0.0.1:${lmStudioPort}/debug/recent-chats`)
		.then(response => response.json() as Promise<{ model?: string; draft_model?: string }[]>)
		.catch(() => [] as { model?: string; draft_model?: string }[]);
	check('speculative decoding sent draft_model to the runtime', lmChats.some(chat => chat.draft_model === 'mock-coder:7b'), `recent chats: ${lmChats.length}, with draft: ${lmChats.filter(chat => chat.draft_model).length}`);

	// --- Architecture map: modules, timing, and a model summary render.
	await runCommand('Open Architecture Map');
	await sleep(9000);
	const archState = pw('run-code', `async (page) => page.evaluate(() => ({
		header: document.querySelector('.onyx-arch-header')?.textContent ?? '',
		modules: Array.from(document.querySelectorAll('.onyx-arch-module-name')).map(el => el.textContent),
		summary: Array.from(document.querySelectorAll('.onyx-arch-module-summary')).map(el => el.textContent).join(' | '),
	}))`);
	check('the architecture map renders modules with timing', archState.includes('analyzed in') && archState.includes('src'), archState.slice(0, 200));
	check('hot modules get a local-model summary', archState.includes('Mock summary'), archState.slice(0, 240));

	// --- Debug assistant: without a paused session the designed message shows.
	await runCommand('Onyx: Explain This Failure');
	await sleep(2500);
	const debugNotification = pw('run-code', `async (page) => page.evaluate(() => Array.from(document.querySelectorAll('.notifications-toasts .notification-list-item-message')).map(el => el.textContent).join(' | '))`);
	check('explain-failure explains when no session is paused', debugNotification.includes('No debug session is running'), debugNotification.slice(0, 160));
}

try {
	await main();
} catch (error) {
	console.error(`\nE2E aborted: ${error instanceof Error ? error.message : String(error)}`);
	failures.push('harness');
} finally {
	try {
		pw('close');
	} catch {
		// session may never have attached
	}
	// Detached children are their own process group: code.sh spawns Electron, so
	// killing only the shell would leave the app holding the debug port and the
	// next run would fail to start. Electron does not always honor SIGTERM
	// during shutdown, hence the SIGKILL sweep.
	for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
		for (const child of children) {
			try {
				process.kill(child.pid ? -child.pid : 0, signal);
			} catch {
				// already gone
			}
		}
		if (signal === 'SIGTERM') {
			await sleep(2000);
		}
	}
	if (keep) {
		console.log(`\nkept ${runDir}`);
	} else {
		fs.rmSync(runDir, { recursive: true, force: true });
	}
}

console.log(failures.length ? `\n${failures.length} check(s) failed` : '\nall checks passed');
process.exit(failures.length ? 1 : 0);
