/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * End-to-end check for the Onyx agent surface against the mock runtime.
 *
 *   node test/onyx/run-e2e.mts [--keep]
 *
 * By default it launches the build from sources. With `ONYX_E2E_APP` set to a
 * packaged application bundle it drives that instead: the soak and the egress
 * audit (D8) run the same suite on the release candidate. `ONYX_E2E_ARGS`
 * adds launch arguments, separated by spaces (the audit's proxy).
 *
 * Builds a throwaway workspace and profile, starts the mock runtime, launches
 * Code OSS with remote debugging, drives the chat surface with @playwright/cli
 * and asserts on the run journal Onyx writes per workspace. Exits non-zero on
 * the first failed assertion.
 *
 * Requires a current `pnpm run compile` (or `transpile-client` plus built-in
 * extensions) - it runs the app, it does not build it.
 */

import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const keep = process.argv.includes('--keep');
const mockPort = Number(process.env.ONYX_MOCK_PORT ?? 11434);
const lmStudioPort = Number(process.env.ONYX_MOCK_LMSTUDIO_PORT ?? 1234);
const cdpPort = Number(process.env.ONYX_CDP_PORT ?? 9333);
const session = `onyx-e2e-${process.pid}`;
const packagedApp = process.env.ONYX_E2E_APP ? path.resolve(process.env.ONYX_E2E_APP) : undefined;
const extraLaunchArgs = (process.env.ONYX_E2E_ARGS ?? '').split(' ').filter(Boolean);

const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onyx-e2e-'));
const workspace = path.join(runDir, 'ws');
const userDataDir = path.join(runDir, 'user-data');
const extensionsDir = path.join(runDir, 'extensions');

const children: ReturnType<typeof spawn>[] = [];
const failures: string[] = [];
/** Counted so the run reports its own total — the docs quote this number, and a
 *  number nobody can re-derive from the output is a number that drifts. */
let checksRun = 0;

function check(name: string, condition: boolean, detail?: string) {
	checksRun++;
	if (condition) {
		console.log(`  ok   ${name}`);
	} else {
		console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
		failures.push(name);
	}
}

/** The seeded contents of `src/math.ts`, shared so a mid-run reset cannot drift from it. */
const MATH_TS_CONTENT = [
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
	// The second line the mock's EDITTEST edits: without it the flow stages one hunk, not two (R-25 needs two).
	'export function multiply(a: number, b: number): number {',
	'\treturn a * b;',
	'}',
	'',
].join('\n');

function sleep(ms: number) {
	return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Polls until `condition` holds, or the timeout expires. Returns whether it
 * held, so the caller's own `check` still reports the real failure.
 *
 * Fixed sleeps were tuned on a fast laptop and made six checks fail on a
 * GitHub runner: the agent run simply had not been journaled yet when the
 * assertion read it. Worse, one of them failed *quietly* — with nothing
 * staged, "accepting clears the staged set" saw an already-empty view and
 * passed. Waiting on the condition costs nothing when it is already true.
 */
/**
 * Clicks in the Changes view go through Playwright locators, not element handles: the view re-renders
 * when its state changes, and a handle taken before a re-render is detached by the time it is clicked
 * (seen on a loaded machine, 2026-11-24).
 */
async function waitUntil(condition: () => boolean, timeoutMs = 20_000, stepMs = 500): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (condition()) {
			return true;
		}
		await sleep(stepMs);
	}
	return condition();
}

/**
 * The installed @playwright/cli, run with this Node. Resolved from the
 * repository's own dependencies, the way the launch skill's paste helper does,
 * so no package manager's runner (npx, pnpm exec) sits between the suite and
 * the driver.
 */
const playwrightCli = createRequire(import.meta.url).resolve('@playwright/cli/playwright-cli.js');

/** How often the driver's session was found gone while the workbench was still there, and was attached again. */
let sessionsLost = 0;

/** How often a paste left the chat input empty and was made again (see `send`). */
let pasteRetries = 0;

/** Whether the workbench still answers on its debugging port. Synchronous: it is asked from inside `pw`. */
function workbenchAnswers(): boolean {
	try {
		return execFileSync('curl', ['-s', '-m', '3', `http://127.0.0.1:${cdpPort}/json/version`], { encoding: 'utf8' }).includes('webSocketDebuggerUrl');
	} catch {
		return false;
	}
}

/**
 * The longest one driver command may take. No command of this suite waits in
 * the page for more than a few seconds; the limit is there because a command
 * that never returns otherwise holds the whole run with no output at all (a
 * soak run on 2026-11-24 stood at its second command for 62 minutes).
 */
const driverCommandTimeoutMs = Number(process.env.ONYX_E2E_DRIVER_TIMEOUT_MS ?? 120_000);

function pwOnce(...args: string[]) {
	try {
		return execFileSync(process.execPath, [playwrightCli, `-s=${session}`, ...args], { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: driverCommandTimeoutMs, killSignal: 'SIGKILL' });
	} catch (error) {
		if ((error as { code?: string }).code === 'ETIMEDOUT') {
			throw new Error(`the driver command "${args[0]}" did not return in ${driverCommandTimeoutMs / 1000} s; the workbench ${workbenchAnswers() ? 'still answers' : 'no longer answers'} on :${cdpPort}`, { cause: error });
		}
		throw error;
	}
}

/**
 * One command of the driver. The driver keeps its attachment to the
 * workbench in a process of its own, and that process has been seen to go
 * away in the middle of a run while the workbench was untouched ("The
 * browser … is not open"), three times on 2026-11-21 on a loaded machine and
 * at a different step each time. When that happens and the workbench still
 * answers on its debugging port, the driver is attached again and the
 * command is sent once more; it is counted and printed, never silent. When
 * the workbench does not answer, nothing is retried: that is a failure of
 * the product or of the machine, and the run aborts saying which.
 */
function pw(...args: string[]) {
	try {
		return pwOnce(...args);
	} catch (error) {
		const output = String((error as { stdout?: unknown }).stdout ?? '');
		if (args[0] === 'attach' || args[0] === 'close' || !/is not open, please run open first/.test(output)) {
			throw error;
		}
		if (!workbenchAnswers()) {
			throw new Error(`the driver's session is gone and the workbench no longer answers on :${cdpPort}: the application has exited or its main process is blocked`, { cause: error });
		}
		sessionsLost++;
		console.error(`  note  the driver's session was gone while the workbench still answered on :${cdpPort}; attached again (${sessionsLost}) before: ${args[0]}`);
		pwOnce('attach', `--cdp=http://127.0.0.1:${cdpPort}`);
		const focus = emulateFocus();
		if (focus !== 'focus:true') {
			console.error(`  note  focus emulation after attaching again: ${focus}`);
		}
		return pwOnce(...args);
	}
}

/**
 * Makes the page behave as focused whatever the operating system says, as a
 * browser Playwright launches itself does. Attaching over CDP to Electron's own
 * context leaves this off, so without it a test window that another
 * application covers or takes the focus from loses its editor focus. The CDP
 * session that carries the setting is kept by the driver's process; a new
 * attachment needs it again.
 */
function emulateFocus(): string {
	try {
		return pwValue(pwOnce('run-code', `async (page) => {
			const cdp = await page.context().newCDPSession(page);
			await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
			globalThis.__onyxFocusSession = cdp;
			return await page.evaluate(() => 'focus:' + document.hasFocus());
		}`));
	} catch (error) {
		// Just after attaching, the driver can have no page yet and tries to open one, which Electron refuses.
		return `failed: ${String((error as { stdout?: unknown }).stdout ?? error).split('\n').find(line => /Error/.test(line)) ?? 'unknown'}`;
	}
}

/** Focus emulation once the driver has the workbench page; it is retried while the page is not there yet. */
async function emulateFocusWhenReady() {
	let result = '';
	await waitUntil(() => (result = emulateFocus()) === 'focus:true', 30_000, 2000);
	if (result !== 'focus:true') {
		throw new Error(`focus emulation did not take: ${result}`);
	}
}

/**
 * The value a `run-code` call returned, without the driver's echo of the code
 * that produced it. The echo contains every literal the script can return, so
 * a check on the raw output for a prefix such as "approved:" is true whether
 * or not the script returned it.
 */
function pwValue(output: string): string {
	const raw = /### Result\n(?<value>[\s\S]*?)\n### Ran Playwright code/.exec(output)?.groups?.value ?? output;
	try {
		const parsed: unknown = JSON.parse(raw);
		return typeof parsed === 'string' ? parsed : raw;
	} catch {
		return raw;
	}
}

/**
 * Flags that keep the workbench under test away from the developer's login
 * keychain. On macOS the workbench reads its "Safe Storage" key at startup,
 * synchronously, on the main thread. When the key was created by a different
 * Electron binary (any Electron upgrade of an unsigned build), macOS asks the
 * user for permission and the call blocks until they answer; the debugging
 * endpoint is served from that thread, so it answers once and then hangs, and
 * the driver times out "retrieving websocket url". That was the whole of the
 * end-to-end break after the move to upstream 1.147.0 (Electron 43). A mock
 * keychain removes the prompt and the dependency on per-machine state.
 */
const isolationArgs = process.platform === 'darwin' ? ['--use-mock-keychain'] : [];

/**
 * The suite's window is not always in front. The soak starts a new one every
 * few minutes on a machine that may be in use, and as soon as another
 * application comes forward the window loses its focus and may be covered.
 * Without these, Chromium then treats the page as hidden and stops animation
 * frames, which the driver waits on before a click; and the editor sees the
 * window's blur, so typing raises no inline completion and the code-action
 * widget does not open (both seen in the soak of 2026-11-24). These switches
 * keep a covered window's page running; `emulateFocus` below keeps its focus.
 */
const backgroundArgs = ['--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling'];

const accessibilityOut = process.env.ONYX_E2E_A11Y_OUT ? path.resolve(process.env.ONYX_E2E_A11Y_OUT) : undefined;

/**
 * The accessibility pass (D8) rides on this suite, so that it looks at every Onyx surface the suite
 * opens and not at a list someone remembered. With `ONYX_E2E_A11Y_OUT` set, a script in the page
 * (a) records everything written to the workbench's screen-reader live regions, which is how a state
 * change is announced, and (b) twice a second looks at each Onyx surface on screen (the first-run
 * dialog, a dialog box, the quick input, the Onyx views, an inline proposal) and records every
 * interactive element in it that has no accessible name or cannot take keyboard focus. The record is
 * written at the end of the run. It is an inventory for a person to read, not a pass or a fail.
 */
function installAccessibilityProbe() {
	if (!accessibilityOut) {
		return;
	}
	pw('run-code', `async (page) => page.evaluate(() => {
		if (window.__onyxA11y) { return; }
		const record = window.__onyxA11y = { announcements: [], surfaces: {}, problems: {} };
		const live = document.querySelector('.monaco-aria-container');
		if (live) {
			new MutationObserver(() => {
				for (const region of live.querySelectorAll('[aria-live], [role=alert], [role=status]')) {
					const text = (region.textContent || '').trim();
					if (text && record.announcements[record.announcements.length - 1] !== text) { record.announcements.push(text); }
				}
			}).observe(live, { childList: true, subtree: true, characterData: true });
		}
		const surfaces = {
			'first-run dialog': '.onboarding-a-overlay.visible',
			'dialog': '.monaco-dialog-box',
			'quick input': '.quick-input-widget:not([style*="display: none"])',
			'Onyx view': '[id^="workbench.view.onyx"], .onyx-changes, .onyx-run',
			'inline proposal': '.onyx-inline-hunk, .onyx-inline-edit-input',
			'title bar': '.titlebar-right',
		};
		const interactive = 'a[href], a.monaco-button, a.action-label, button, input, select, textarea, [role=button], [role=checkbox], [role=link], [role=menuitem], [role=tab], [role=treeitem], [role=listitem][tabindex], [tabindex]:not([tabindex="-1"])';
		const named = element => !!((element.getAttribute('aria-label') || '').trim() || element.getAttribute('aria-labelledby') || (element.textContent || '').trim() || (element.getAttribute('title') || '').trim() || (element.getAttribute('placeholder') || '').trim() || (element.labels && element.labels.length));
		const focusable = element => element.tabIndex >= 0 || !!element.closest('[role=tree], [role=list], [role=listbox], [role=toolbar], [role=tablist], [role=menu], [role=radiogroup], .monaco-list, .monaco-action-bar, .monaco-toolbar');
		setInterval(() => {
			for (const [name, selector] of Object.entries(surfaces)) {
				for (const surface of document.querySelectorAll(selector)) {
					if (!surface.getClientRects().length) { continue; }
					record.surfaces[name] = (record.surfaces[name] || 0) + 1;
					for (const element of surface.querySelectorAll(interactive)) {
						// A presentational element (a toolbar separator) is not interactive whatever its tag; a radio group keeps one radio in the tab order and moves between them with the arrow keys.
						if (!element.getClientRects().length || element.getAttribute('aria-hidden') === 'true' || element.getAttribute('role') === 'presentation') { continue; }
						const problem = !named(element) ? 'no accessible name' : !focusable(element) ? 'not reachable by keyboard' : undefined;
						if (problem) {
							const key = name + ' | ' + problem + ' | ' + element.tagName.toLowerCase() + '.' + String(element.className).split(' ').filter(Boolean).slice(0, 3).join('.') + (element.getAttribute('role') ? '[role=' + element.getAttribute('role') + ']' : '');
							record.problems[key] = (record.problems[key] || 0) + 1;
						}
					}
				}
			}
		}, 500);
	})`);
}

/** Writes what the probe saw. Called once, at the end; a window that was reloaded on the way has lost its record and says so. */
function writeAccessibilityRecord() {
	if (!accessibilityOut) {
		return;
	}
	try {
		const raw = pwValue(pw('run-code', 'async (page) => page.evaluate(() => JSON.stringify(window.__onyxA11y ?? { lost: true }))'));
		fs.writeFileSync(accessibilityOut, JSON.stringify(JSON.parse(raw), undefined, '\t'));
	} catch (error) {
		fs.writeFileSync(accessibilityOut, JSON.stringify({ failed: String(error).split('\n')[0] }));
	}
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
	fs.writeFileSync(path.join(workspace, 'src', 'math.ts'), MATH_TS_CONTENT);
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
		// A blocked main process accepts the connection and never answers.
		const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(3000) });
		return response.ok;
	} catch {
		return false;
	}
}

async function waitForCdp(timeoutMs: number) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await isListening(cdpPort)) {
			return true;
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
async function waitForMockOn(port: number, timeoutMs: number) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const response = await fetch(`http://127.0.0.1:${port}/v1/models`);
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

function waitForMock(timeoutMs: number) {
	return waitForMockOn(mockPort, timeoutMs);
}

/** Whether anything already answers the OpenAI model list on a port. */
async function isOpenAiEndpoint(port: number): Promise<boolean> {
	try {
		const response = await fetch(`http://127.0.0.1:${port}/v1/models`, { signal: AbortSignal.timeout(1500) });
		return response.ok;
	} catch {
		return false;
	}
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
		.map(name => {
			const raw = fs.readFileSync(path.join(dir, name), 'utf8');
			return {
				name,
				raw,
				events: raw.trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as { kind: string; data?: any }),
			};
		});
}

/**
 * The primary modifier of the editor's default keybindings on this platform:
 * ⌘ on macOS, Ctrl elsewhere. The suite runs under Xvfb on Linux in CI, where
 * a hard-coded Meta would press nothing.
 */
const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
const toDocumentStart = process.platform === 'darwin' ? 'Meta+Home' : 'Control+Home';
const toDocumentEnd = process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End';

/**
 * Focuses the active editor's input element through the DOM. A synthesized
 * mouse click at a bounding-box coordinate does not land under Xvfb; a focus
 * call does, and it is what a keyboard user's Tab order would do.
 */
function focusEditor() {
	pw('run-code', 'async (page) => { const ed = await page.$(".editor-instance .native-edit-context, .editor-instance textarea.inputarea"); if (!ed) { throw new Error("no editor input element"); } await ed.focus(); }');
}

/**
 * Opens a file through Quick Open (a real `<input>`, so fill works) and
 * leaves the editor focused — the keyboard equivalent of clicking its tab.
 */
async function openFile(name: string) {
	pw('press', `${mod}+p`);
	await sleep(800);
	pw('run-code', `async (page) => { await page.fill('.quick-input-box input', ${JSON.stringify(name)}); }`);
	await sleep(800);
	pw('press', 'Enter');
	await sleep(1200);
	focusEditor();
}

/**
 * Picks a code action by title from the open action widget with the
 * keyboard: the widget focuses its first action on open, ArrowDown moves
 * through enabled actions and Enter runs the focused one. Returns
 * `picked:<index>` or `not-found:<titles>`.
 */
function pickCodeAction(title: string) {
	return pw('run-code', `async (page) => {
		await page.waitForSelector('.action-widget [role=option]', { timeout: 5000 });
		const rows = await page.$$('.action-widget [role=option]');
		const titles = [];
		for (const row of rows) {
			if ((await row.getAttribute('aria-disabled')) === 'true') { continue; }
			titles.push(((await row.textContent()) || '').trim());
		}
		const index = titles.findIndex(text => text.includes(${JSON.stringify(title)}));
		if (index === -1) { return 'not-found:' + titles.join(' | '); }
		for (let i = 0; i < index; i++) { await page.keyboard.press('ArrowDown'); }
		await page.keyboard.press('Enter');
		return 'picked:' + index;
	}`);
}

/**
 * Types into a real editor so the inline-completion provider fires. Ghost text
 * is deliberately scoped to document editors, so this must not go through the
 * chat input.
 */
async function typeInEditor() {
	// Activate both tabs first: cross-file FIM context only reads text models
	// that are already loaded, and a tab that was never focused has none.
	await openFile('math.ts');
	await openFile('report.ts');
	pw('press', toDocumentEnd);
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
	// The first-run dialog can come up later than the two moments this runner waits for it at: on a loaded
	// machine it has appeared a minute in. It is modal, so it is looked for before every command and prompt.
	await dismissOnboarding(0);
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

/** True while the first-run dialog covers the window. It is modal: every click lands on it. */
function onboardingShown(): boolean {
	try {
		return pwValue(pw('run-code', 'async (page) => page.evaluate(() => String(!!document.querySelector(".onboarding-a-overlay.visible")))')) === 'true';
	} catch {
		return false;
	}
}

/**
 * Steps through the first-run dialog ("Connect a Local Runtime", then "Make It
 * Yours") if it is up, waiting up to `waitMs` for it to appear. It appears some
 * time after the window does. On a slow machine that was later than the fixed
 * pause this runner used to allow, and the dialog then took every later click.
 */
async function dismissOnboarding(waitMs: number): Promise<void> {
	const deadline = Date.now() + waitMs;
	for (; ;) {
		if (onboardingShown()) {
			for (let step = 0; step < 6 && onboardingShown(); step++) {
				try {
					pw('click', 'button.onboarding-a-btn-primary');
				} catch {
					// the dialog moved to its next step under the click
				}
				await sleep(1200);
			}
			return;
		}
		if (Date.now() >= deadline) {
			return;
		}
		await sleep(1000);
	}
}

async function send(prompt: string) {
	await dismissOnboarding(0);
	const focusScript = path.join(repoRoot, '.agents', 'skills', 'launch', 'playwrightScripts', 'focus-chat-input.ts');
	const paste = path.join(repoRoot, '.agents', 'skills', 'launch', 'scripts', 'monaco-paste.sh');
	// The helper dispatches a synthetic paste event and reads the input back. Once, on CI (2026-11-25,
	// 35701feb292), the first prompt of a run read back as an empty input: the event was dropped, not
	// garbled. An input that is still empty is pasted into again, at most three times in all, and each
	// retry is printed; a read-back with other text in it still stops the run. No check asserts on the
	// paste itself: every check asserts on what the prompt caused.
	for (let attempt = 1; ; attempt++) {
		pw('run-code', `--filename=${focusScript}`);
		try {
			// The helper makes up to three driver calls of its own; it gets their limit three times over.
			execFileSync(paste, ['--session', session, prompt], { cwd: repoRoot, encoding: 'utf8', timeout: driverCommandTimeoutMs * 3, killSignal: 'SIGKILL' });
			break;
		} catch (error) {
			if ((error as { code?: string }).code === 'ETIMEDOUT') {
				throw new Error(`pasting the prompt did not finish in ${driverCommandTimeoutMs * 3 / 1000} s; the workbench ${workbenchAnswers() ? 'still answers' : 'no longer answers'} on :${cdpPort}`, { cause: error });
			}
			if (attempt >= 3 || !pasteLeftInputEmpty(String((error as { stdout?: unknown }).stdout ?? ''))) {
				throw error;
			}
			console.log(`  note: the paste of "${prompt.slice(0, 40)}" left the chat input empty; pasting again (attempt ${attempt + 1} of 3)`);
			pasteRetries++;
			await sleep(2000);
		}
	}
	pw('press', 'Enter');
}

/** Whether the paste helper's report says the chat input read back empty after the paste. */
function pasteLeftInputEmpty(stdout: string): boolean {
	try {
		const report = JSON.parse(stdout.trim().split('\n').pop() ?? '') as { ok?: boolean; actualLength?: number };
		return report.ok === false && typeof report.actualLength === 'number' && report.actualLength <= 1;
	} catch {
		return false;
	}
}

async function main() {
	console.log(`run dir: ${runDir}`);
	// A workbench left over from an earlier run would answer every probe and
	// this one would then drive the wrong window.
	if (await isListening(cdpPort)) {
		throw new Error(`something is already debugging on :${cdpPort} — close it, or set ONYX_CDP_PORT`);
	}
	seedWorkspace();

	// Detached like the workbench below: teardown kills by process *group*
	// (negative pid), and a non-detached child sits in this runner's own group,
	// so `kill(-pid)` names a group that does not exist, throws ESRCH into an
	// empty catch, and leaves a mock listening on :11434 for the next session
	// to mistake for a real Ollama.
	children.push(spawn(process.execPath, [path.join(repoRoot, 'test', 'onyx', 'mock-ollama.mts')], {
		cwd: repoRoot,
		env: { ...process.env, ONYX_MOCK_PORT: String(mockPort) },
		stdio: 'ignore',
		detached: true,
	}));
	if (!await waitForMock(10_000)) {
		throw new Error(`the mock runtime never answered on :${mockPort} — stop any real runtime on that port, or set ONYX_MOCK_PORT`);
	}
	// A second mock posing as LM Studio (its port, no Ollama native API), so
	// the speculative-decoding flow has a runtime that supports a load-time draft.
	// A real LM Studio on that port would answer every probe and silently turn
	// the speculative check into a test against live models.
	if (await isOpenAiEndpoint(lmStudioPort)) {
		throw new Error(`something already serves an OpenAI API on :${lmStudioPort} (a real LM Studio?) — stop it, or set ONYX_MOCK_LMSTUDIO_PORT`);
	}
	children.push(spawn(process.execPath, [path.join(repoRoot, 'test', 'onyx', 'mock-ollama.mts')], {
		cwd: repoRoot,
		env: { ...process.env, ONYX_MOCK_PORT: String(lmStudioPort), ONYX_MOCK_KIND: 'lmstudio' },
		stdio: 'ignore',
		detached: true,
	}));
	if (!await waitForMockOn(lmStudioPort, 10_000)) {
		throw new Error(`the LM Studio mock never answered on :${lmStudioPort}`);
	}

	const executable = packagedApp
		? path.join(packagedApp, 'Contents', 'MacOS', fs.readdirSync(path.join(packagedApp, 'Contents', 'MacOS'))[0])
		: path.join(repoRoot, 'scripts', 'code.sh');
	if (packagedApp) {
		console.log(`driving the packaged application: ${packagedApp}`);
	}
	children.push(spawn(executable, [
		`--user-data-dir=${userDataDir}`,
		`--extensions-dir=${extensionsDir}`,
		`--remote-debugging-port=${cdpPort}`,
		...isolationArgs,
		...backgroundArgs,
		...extraLaunchArgs,
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
	try {
		pw('attach', `--cdp=http://127.0.0.1:${cdpPort}`);
	} catch (error) {
		// Name the cause when the endpoint came up and then went silent,
		// instead of leaving a 30-second driver timeout to be guessed at.
		if (!await isListening(cdpPort)) {
			throw new Error(`the debugging endpoint on :${cdpPort} answered and then stopped: the workbench's main process is blocked, which on macOS means a system prompt (the login keychain) is waiting for an answer`, { cause: error });
		}
		throw error;
	}
	await sleep(6000);
	await emulateFocusWhenReady();
	// The soak runs this suite on a machine that may be in use, where the window is soon behind another
	// application. A covered window stopped animation frames and the driver's clicks timed out; a window
	// without focus raised no inline completion (2026-11-24). Both are set up above and checked here.
	const workbenchPid = children[children.length - 1].pid;
	const workbenchCommand = execFileSync('ps', ['-o', 'command=', '-p', String(workbenchPid)], { encoding: 'utf8' });
	const pageState = pwValue(pw('run-code', 'async (page) => page.evaluate(() => document.hasFocus() + "/" + document.visibilityState)'));
	check('the window keeps its focus and keeps rendering when another application covers it (focus emulation and the background switches)', pageState === 'true/visible' && backgroundArgs.every(arg => workbenchCommand.includes(arg)), `${pageState}; ${backgroundArgs.filter(arg => !workbenchCommand.includes(arg)).join(' ') || 'switches present'}`);
	installAccessibilityProbe();

	// Onboarding: "Connect a Local Runtime" then "Make It Yours".
	await dismissOnboarding(30_000);
	await sleep(2000);

	// Give the TypeScript server time to load the project before asking for symbols.
	await sleep(15000);

	await dismissOnboarding(0);
	await send('TOOLTEST exercise the tool loop');
	await sleep(9000);
	await send('SYMTEST computeTotal EXPAND');
	await sleep(14000);
	// "remember" is an optional tool: on the eight-slot profile it is offered
	// when the user asks for it by name, in place of the last default (R-36).
	await send('MEMTEST remember that this project indents with tabs');
	// A note the model asks to store needs the user's confirmation first, with
	// the note and where its text came from on show (B3, I-14, R-59).
	let memoryConfirmation = 'no-dialog';
	await waitUntil(() => {
		memoryConfirmation = pwValue(pw('run-code', `async (page) => {
			const detail = await page.$('.monaco-dialog-box .dialog-message-detail');
			if (!detail) { return 'no-dialog'; }
			const text = await detail.textContent();
			const buttons = await page.$$('.monaco-dialog-box a.monaco-text-button');
			for (const button of buttons) {
				if (((await button.textContent()) || '').trim() === 'Remember') { await button.click(); return 'confirmed:' + text; }
			}
			return 'no-remember-button:' + text;
		}`));
		return memoryConfirmation !== 'no-dialog';
	}, 20_000, 1000);
	await sleep(6000);
	// Prompts are built once per run, so a fact remembered during a run first
	// shows up in the next one — hence a fourth, deliberately boring request.
	await send('Thanks, that is all.');
	await sleep(9000);

	const runs = readRuns();
	check('four runs were journaled', runs.length >= 4, `saw ${runs.length}`);
	check('R-59: storing a note asked first, showing the note and that its text came from the user\'s own request', memoryConfirmation.startsWith('confirmed:') && memoryConfirmation.includes('this project indents with tabs') && memoryConfirmation.includes('Where this text came from: your own request.'), memoryConfirmation.slice(0, 300));

	// B3: upstream's Agent Host (the Copilot SDK harness) is excluded. When it
	// starts it writes agenthost.log into the window's log directory, so the
	// absence of that file after several agent runs is the evidence.
	const agentHostLogs = fs.existsSync(path.join(userDataDir, 'logs')) ? fs.readdirSync(path.join(userDataDir, 'logs'), { recursive: true, encoding: 'utf8' }).filter(name => /agenthost/i.test(name)) : ['no logs directory'];
	check('the Agent Host did not start: no agenthost log in this profile', agentHostLogs.length === 0, agentHostLogs.join(', '));

	// R-43 (L3): every agent run's journal is a schema-valid v2 trace, read
	// through the product's own reader from compiled output.
	const traceModule = await import(pathToFileURL(path.join(repoRoot, 'out', 'vs', 'workbench', 'contrib', 'onyx', 'common', 'onyxTrace.js')).href) as {
		parseTrace(text: string): { header?: { v: number; sampling: { seed: number | null } }; turns: { seed: { requested: number | null; honoured: boolean | 'unknown' } }[] };
		validateTrace(trace: unknown): { ok: boolean; version: number; errors: readonly string[] };
	};
	const traces = runs.map(run => {
		const trace = traceModule.parseTrace(run.raw);
		const validation = traceModule.validateTrace(trace);
		return { name: run.name, ok: validation.ok, version: validation.version, turns: trace.turns.length, errors: validation.errors, seed: trace.turns[0]?.seed };
	});
	check('R-43: every agent run journals a schema-valid v2 trace with at least one turn', traces.every(trace => trace.ok && trace.version === 2 && trace.turns >= 1), JSON.stringify(traces.filter(trace => !trace.ok || trace.turns < 1).map(trace => ({ name: trace.name, errors: trace.errors, turns: trace.turns }))));
	check('R-43: a run without a profile seed records the seed as unknown, never as honoured', traces.every(trace => trace.seed && trace.seed.requested === null && trace.seed.honoured === 'unknown'), JSON.stringify(traces.map(trace => trace.seed)));

	// R-36, dev half of the dev/packaged parity: a default run on the 7B
	// profile advertises the six essential tools and the two documented
	// optional ones, all Onyx's own, with the Copilot extension disabled.
	const headers = runs.map(run => run.events.find(event => event.kind === 'trace')?.data as { model?: { identifier?: string }; tools?: { name: string }[] } | undefined);
	const firstHeader = headers[0];
	const expectedTools = ['readFile', 'listDirectory', 'findFiles', 'grep', 'editFile', 'terminal', 'repoSymbols', 'docs'];
	check('R-36: a default run on the 7B profile advertises the six essentials and the two documented optional tools', JSON.stringify(firstHeader?.tools?.map(tool => tool.name)) === JSON.stringify(expectedTools) && !!firstHeader?.model?.identifier?.includes('mock-coder:7b'), JSON.stringify({ model: firstHeader?.model?.identifier, tools: firstHeader?.tools?.map(tool => tool.name) }));
	check('R-36: an optional tool asked for by name takes the last spare slot', headers.some(header => JSON.stringify(header?.tools?.map(tool => tool.name)) === JSON.stringify([...expectedTools.slice(0, 7), 'remember'])), JSON.stringify(headers.map(header => header?.tools?.map(tool => tool.name).slice(6))));

	const all = runs.flatMap(run => run.events);
	const toolCalls: string[] = all.filter(event => event.kind === 'toolCall').map(event => event.data?.label);
	check('the first tool call was Onyx\'s own listDirectory, and it listed the workspace', toolCalls[0] === 'listDirectory' && JSON.stringify(all.filter(event => event.kind === 'promptSnapshot')).includes('dir   src/'), `tool calls: ${toolCalls.join(', ') || 'none'}`);
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

	// C2: a run that staged nothing and accepted nothing has nothing to verify, and says nothing about verification.
	const verdicts = all.filter(event => event.kind === 'note' && /^Verification/.test(event.data?.label ?? ''));
	check('R-21: runs that accepted nothing report no verification verdict', verdicts.length === 0, verdicts.map(event => String(event.data?.label)).slice(0, 3).join(' | '));

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
	pw('press', `${mod}+.`);
	await sleep(2500);
	const fixPicked = pickCodeAction('Fix with Onyx');
	await waitUntil(() => readRunIndex().some(run => run.title.startsWith('Fix this problem')));
	check('Fix with Onyx routed into a chat run', readRunIndex().some(run => run.title.startsWith('Fix this problem')), fixPicked.includes('picked:') ? 'no run titled "Fix this problem…"' : `code action not found in the action widget: ${fixPicked.slice(0, 160)}`);

	// --- Explain with Onyx on a selection.
	pw('press', 'Escape');
	focusEditor();
	pw('press', `${mod}+a`);
	pw('press', `${mod}+.`);
	await sleep(2500);
	const explainPicked = pickCodeAction('Explain with Onyx');
	await waitUntil(() => readRunIndex().some(run => run.title.startsWith('Explain this code')));
	check('Explain with Onyx routed into a chat run', readRunIndex().some(run => run.title.startsWith('Explain this code')), explainPicked.includes('picked:') ? 'no run titled "Explain this code…"' : `code action not found in the action widget: ${explainPicked.slice(0, 160)}`);

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
	await openFile('math.ts');
	pw('press', toDocumentStart);
	for (let i = 0; i < 3; i++) {
		pw('press', 'Shift+ArrowDown');
	}
	pw('press', `${mod}+i`);
	await sleep(1500);
	const widgetOpened = pwValue(pw('run-code', 'async (page) => { const input = await page.$(".onyx-inline-edit-input"); if (!input) { return "missing"; } await input.fill("mark this function"); return "filled"; }'));
	check('the inline edit widget opens on the selection', widgetOpened === 'filled', widgetOpened.slice(0, 120));
	pw('press', 'Enter');
	// The reply is staged for review (B9, R-34): the proposed lines are on show in a read-only zone, and
	// nothing of them is in the file until a hunk is kept.
	const readHunkState = () => pw('run-code', `async (page) => page.evaluate(() => ({
		inBuffer: Array.from(document.querySelectorAll('.editor-instance .view-line')).some(l => (l.textContent || '').includes('edited-by-mock')),
		proposed: Array.from(document.querySelectorAll('.editor-instance .onyx-inline-proposal-line')).some(l => (l.textContent || '').includes('edited-by-mock')),
		decorated: !!document.querySelector('.onyx-inline-hunk'),
	}))`);
	await waitUntil(() => /"proposed"\s*:\s*true/.test(readHunkState()));
	const hunkState = readHunkState();
	check('the inline edit is staged for review and nothing of it is in the file', /"proposed"\s*:\s*true/.test(hunkState) && /"decorated"\s*:\s*true/.test(hunkState) && /"inBuffer"\s*:\s*false/.test(hunkState), hunkState.slice(0, 200));
	// Keep the hunk: only now does the file change.
	focusEditor();
	pw('press', `${mod}+Enter`);
	await waitUntil(() => /"inBuffer"\s*:\s*true/.test(readHunkState()));
	const keptState = readHunkState();
	check('keeping the hunk applies it to the file', /"inBuffer"\s*:\s*true/.test(keptState) && /"proposed"\s*:\s*false/.test(keptState), keptState.slice(0, 200));
	// The kept hunk is one undoable edit: undo brings the original line back verbatim.
	focusEditor();
	pw('press', `${mod}+z`);
	await waitUntil(() => /"inBuffer"\s*:\s*false/.test(readHunkState()));
	const afterUndo = readHunkState();
	check('undoing the kept hunk restores the original line', /"inBuffer"\s*:\s*false/.test(afterUndo), afterUndo.slice(0, 200));
	await waitUntil(() => readRunIndex().some(run => run.title.startsWith('Inline edit')));
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
	// The inline-edit test above left math.ts open, and on a slower runner its
	// undo can leave the buffer out of step with disk. The mock's editFile
	// SEARCH block is matched against the file, so a stale buffer means nothing
	// stages and three checks below fail for a reason that has nothing to do
	// with staging. Revert the editor and put the file back to known content so
	// a failure here means the edit tool broke.
	fs.writeFileSync(path.join(workspace, 'src', 'math.ts'), MATH_TS_CONTENT);
	await sleep(1500);
	await send('EDITTEST src/math.ts stage an edit for review');
	const readStagedSnapshot = () => JSON.stringify(readRuns().flatMap(run => run.events).filter(event => event.kind === 'promptSnapshot').slice(-2));
	await waitUntil(() => readStagedSnapshot().includes('reviews them in Onyx Changes'));
	const mathOnDisk = fs.readFileSync(path.join(workspace, 'src', 'math.ts'), 'utf8');
	check('agent edits stage instead of writing the file', !mathOnDisk.includes('edited-by-mock'), 'the tool wrote into the file without review');
	check('the edit tool reported the staged review to the model', readStagedSnapshot().includes('reviews them in Onyx Changes'), 'no staging summary in the tool result');
	await runCommand('Open Onyx Control Plane');
	const readChangesState = () => pw('run-code', `async (page) => page.evaluate(() => ({
		files: Array.from(document.querySelectorAll('.onyx-change-file-path')).map(el => el.textContent),
	}))`);
	await waitUntil(() => readChangesState().includes('src/math.ts'));
	const changesState = readChangesState();
	const wasStaged = changesState.includes('src/math.ts');
	check('the staged file appears in Onyx Changes', wasStaged, changesState.slice(0, 160));
	// --- R-25 (C1): the proposal in a real diff editor. Open it from Onyx Changes, accept one hunk from the
	// editor, and the file holds that hunk and not the other; the side bar follows.
	const openedDiff = pwValue(pw('run-code', `async (page) => {
		const open = await page.$('.onyx-change-file-header .codicon-go-to-file');
		if (!open) { return 'no-open-button'; }
		await open.click(); return 'opened';
	}`));
	const readDiffState = () => pw('run-code', `async (page) => page.evaluate(() => {
		const lines = side => Array.from(document.querySelectorAll('.monaco-diff-editor .editor.' + side + ' .view-line')).map(l => (l.textContent || '').replace(/\\u00a0/g, ' '));
		const has = (side, text) => lines(side).some(l => l.includes(text));
		return {
			diff: !!document.querySelector('.monaco-diff-editor'),
			fileHasFirst: has('original', 'return b + a; // edited-by-mock'),
			fileHasSecond: has('original', 'return b * a; // edited-by-mock'),
			proposalHasFirst: has('modified', 'return b + a; // edited-by-mock'),
			proposalHasSecond: has('modified', 'return b * a; // edited-by-mock'),
			stat: (document.querySelector('.onyx-change-file-stat') || {}).textContent || '',
		};
	})`);
	await waitUntil(() => /"proposalHasFirst"\s*:\s*true/.test(readDiffState()));
	const diffState = readDiffState();
	check('R-25: the proposal opens in a diff editor, the file on the left without the edits and the proposal on the right with them', openedDiff === 'opened' && /"diff"\s*:\s*true/.test(diffState) && /"fileHasFirst"\s*:\s*false/.test(diffState) && /"fileHasSecond"\s*:\s*false/.test(diffState) && /"proposalHasFirst"\s*:\s*true/.test(diffState) && /"proposalHasSecond"\s*:\s*true/.test(diffState), `${openedDiff}; ${diffState.slice(0, 260)}`);
	// The caret goes to the first changed line of the proposal, and that hunk is accepted from the editor.
	pw('run-code', 'async (page) => { const ed = await page.$(".monaco-diff-editor .editor.modified .native-edit-context, .monaco-diff-editor .editor.modified textarea.inputarea"); if (!ed) { throw new Error("no proposal editor input"); } await ed.focus(); }');
	pw('press', 'Control+g');
	await sleep(800);
	pw('run-code', `async (page) => { await page.fill('.quick-input-box input', ':2'); }`);
	pw('press', 'Enter');
	await sleep(800);
	await runCommand('Onyx: Accept Hunk at Cursor');
	await waitUntil(() => /"fileHasFirst"\s*:\s*true/.test(readDiffState()));
	const acceptedHunkState = readDiffState();
	check('R-25: accepting one hunk from the editor puts that hunk in the file and not the other, and the side bar shows one hunk left', /"fileHasFirst"\s*:\s*true/.test(acceptedHunkState) && /"fileHasSecond"\s*:\s*false/.test(acceptedHunkState) && /"stat"\s*:\s*"\+1 −1"/.test(acceptedHunkState), acceptedHunkState.slice(0, 260));
	// R-21 (C2), end to end: before the acceptance the run's timeline said "not applied"; after it, a result for
	// the accepted content arrives, and it is never the old "no new problems" said of an unapplied edit.
	// The notes are read run by run: the inline edit above has verification notes of its own.
	const verificationNotesByRun = () => readRuns().map(run => run.events.filter(event => event.kind === 'note' && /^Verification/.test(event.data?.label ?? '')).map(event => String(event.data?.label)));
	const settled = /^Verification: (verified|new problems|timed out)/;
	const agentRunNotes = () => verificationNotesByRun().find(labels => labels.some(label => label.startsWith('Verification: not applied'))) ?? [];
	await waitUntil(() => agentRunNotes().some(label => settled.test(label)), 30_000);
	const verificationSeen = agentRunNotes();
	check('R-21: verification says "not applied" while the edit is only staged, and reports on the accepted content after the acceptance', verificationSeen.length >= 2 && verificationSeen[0].startsWith('Verification: not applied') && settled.test(verificationSeen[verificationSeen.length - 1]) && verificationSeen[verificationSeen.length - 1].includes('Partial: 1 hunk is still staged'), verificationSeen.join(' | ').slice(0, 400));
	// The inline edit went through the same path: its kept hunk was verified, and undoing it made that result stale.
	const inlineRunNotes = verificationNotesByRun().find(labels => labels.some(label => label.startsWith('Verification: stale'))) ?? [];
	check('R-21: an inline edit is verified through the same path: undoing the kept hunk makes its result stale', inlineRunNotes.length > 0 && !inlineRunNotes.some(label => label.startsWith('Verification: not applied')), verificationNotesByRun().flat().join(' | ').slice(0, 400));
	// Back to the side bar for the rest: Accept All takes the hunk that is left.
	pw('run-code', 'async (page) => { await page.locator(".onyx-changes-summary button").first().click(); }'); // Accept All
	const readAcceptedState = () => pw('run-code', `async (page) => page.evaluate(() => ({
		empty: !!document.querySelector('.onyx-changes .onyx-empty'),
	}))`);
	await waitUntil(() => /"empty"\s*:\s*true/.test(readAcceptedState()));
	const acceptedState = readAcceptedState();
	// Guarded on `wasStaged`: an empty view is only evidence of accepting when
	// something was staged to begin with. Without that this check passed on a
	// run where the edit had never arrived.
	check('accepting applies and clears the staged set', wasStaged && /"empty"\s*:\s*true/.test(acceptedState), wasStaged ? acceptedState.slice(0, 120) : 'nothing was staged, so an empty view proves nothing');

	// --- Read → staged edit with Onyx's own read tool (R-31, the dev half of
	// what the packaged smoke checks): the mock reads math.ts through
	// readFile and proposes an edit whose SEARCH text is a line it read back.
	const toolCallsBeforeRead = readRuns().flatMap(run => run.events).filter(event => event.kind === 'toolCall').length;
	await send('READEDITTEST src/math.ts');
	const readEditCalls = () => readRuns().flatMap(run => run.events).filter(event => event.kind === 'toolCall').slice(toolCallsBeforeRead).map(event => String(event.data?.label ?? ''));
	await waitUntil(() => readEditCalls().includes('editFile'), 40_000);
	// Sending focused the chat, which hides the Control Plane and its Changes view.
	await runCommand('Open Onyx Control Plane');
	await waitUntil(() => readChangesState().includes('src/math.ts'));
	const readResult = JSON.stringify(readRuns().flatMap(run => run.events).filter(event => event.kind === 'promptSnapshot').slice(-2));
	check('R-31: the model read the file through Onyx\'s own readFile tool, as numbered lines', readEditCalls()[0] === 'readFile' && /src\/math\.ts \(lines 1-\d+ of \d+/.test(readResult) && readResult.includes('1| export function addNumbers'), `tool calls: ${readEditCalls().join(', ') || 'none'}`);
	check('R-31: the edit that quotes the line it read is staged, not written', readChangesState().includes('src/math.ts') && !fs.readFileSync(path.join(workspace, 'src', 'math.ts'), 'utf8').includes('edited-by-mock // edited-by-mock'), readChangesState().slice(0, 160));
	pw('run-code', 'async (page) => { const reject = page.locator(".onyx-changes-summary button").nth(1); if (await reject.count()) { await reject.click(); } }'); // Reject All
	await waitUntil(() => /"empty"\s*:\s*true/.test(readAcceptedState()));

	// --- C3: one editFile call that carries two edits stages two hunks, as one proposal.
	const toolCallsBeforeMulti = readRuns().flatMap(run => run.events).filter(event => event.kind === 'toolCall').length;
	await send('MULTIEDITTEST src/util.ts two edits in one call');
	const multiEditCalls = () => readRuns().flatMap(run => run.events).filter(event => event.kind === 'toolCall').slice(toolCallsBeforeMulti).map(event => String(event.data?.label ?? ''));
	await waitUntil(() => multiEditCalls().includes('editFile') && readStagedSnapshot().includes('Staged 2 edit(s) to src/util.ts'), 40_000);
	await runCommand('Open Onyx Control Plane');
	await waitUntil(() => readChangesState().includes('src/util.ts'));
	const readMultiState = () => pw('run-code', `async (page) => page.evaluate(() => ({
		stat: (document.querySelector('.onyx-change-file-stat') || {}).textContent || '',
		hunks: document.querySelectorAll('.onyx-change-hunk:not(.onyx-change-conflict)').length,
		certificates: Array.from(document.querySelectorAll('.onyx-change-hunk-certificate')).map(el => el.textContent),
	}))`);
	// A file in Onyx Changes is collapsed until its header is clicked; its hunks are rendered when it is open.
	pw('run-code', 'async (page) => { const header = await page.$(".onyx-change-file-path"); await header.click(); }');
	await waitUntil(() => /"hunks"\s*:\s*2/.test(readMultiState()));
	const multiState = readMultiState();
	const utilOnDisk = fs.readFileSync(path.join(workspace, 'src', 'util.ts'), 'utf8');
	check('C3: one editFile call with two edits stages two hunks for the file, and writes nothing', multiEditCalls().filter(label => label === 'editFile').length === 1 && readStagedSnapshot().includes('Staged 2 edit(s) to src/util.ts') && /"hunks"\s*:\s*2/.test(multiState) && /"stat"\s*:\s*"\+2 −2"/.test(multiState) && !utilOnDisk.includes('multi-edit-by-mock'), `${multiEditCalls().join(',')} ${multiState.slice(0, 200)}`);
	// R-46 (L6), end to end: each staged hunk shows one line of what was checked for it, the journal holds a
	// sealed certificate for each edit of the call, and no line claims more than was checked.
	const certificateLines: string[] = JSON.parse(/"certificates"\s*:\s*(\[[^\]]*\])/.exec(multiState)?.[1] ?? '[]');
	const journaledCertificates = readRuns().flatMap(run => run.events).filter(event => event.kind === 'editCertificate' && event.data?.certificate?.path === 'src/util.ts');
	check('R-46: each staged hunk shows what was checked for it, and the journal holds a sealed certificate for each edit', certificateLines.length === 2 && certificateLines.every(line => /^Anchored exactly once · /.test(line) && !/proof|correct|safe|guarantee/i.test(line)) && journaledCertificates.length === 2 && journaledCertificates.every(event => typeof event.data?.seal === 'string' && event.data?.certificate?.anchor?.matchCount === 1 && event.data?.certificate?.protocol === 'multi-edit'), `${certificateLines.join(' | ')} ; ${journaledCertificates.length} in the journal`);
	pw('run-code', 'async (page) => { const reject = page.locator(".onyx-changes-summary button").nth(1); if (await reject.count()) { await reject.click(); } }'); // Reject All
	await waitUntil(() => /"empty"\s*:\s*true/.test(readAcceptedState()));

	// --- Terminal tool: approval dialog, execution, journaled output.
	await send('TERMTEST echo onyx-e2e-terminal-ok');
	await sleep(6000);
	const approval = pwValue(pw('run-code', `async (page) => {
		const detail = await page.$('.monaco-dialog-box .dialog-message-detail');
		if (!detail) { return 'no-dialog'; }
		const text = await detail.textContent();
		const buttons = await page.$$('.monaco-dialog-box a.monaco-text-button');
		const labels = [];
		for (const button of buttons) { labels.push(((await button.textContent()) || '').trim()); }
		for (const button of buttons) {
			if ((await button.textContent())?.includes('Run Once')) { await button.click(); return 'approved:' + text + ' buttons=' + labels.sort().join('+'); }
		}
		return 'no-run-once:' + text + ' buttons=' + labels.sort().join('+');
	}`));
	check('the terminal tool asks before running', approval.startsWith('approved:'), approval.slice(0, 160));
	check('the approval names the exact command', approval.startsWith('approved:echo onyx-e2e-terminal-ok'), approval.slice(0, 160));
	check('the approval offers Run Once and Deny, and nothing that outlives the invocation (B2)', /buttons=Deny\+Run Once$/.test(approval), approval.slice(0, 400));
	await sleep(6000);
	const terminalNotes = readRuns().flatMap(run => run.events).filter(event => event.kind === 'note').map(event => String(event.data?.label ?? ''));
	check('the command ran and its exit landed on the timeline', terminalNotes.some(label => label.startsWith('Running: echo onyx-e2e-terminal-ok')) && terminalNotes.some(label => label.startsWith('Exited with code 0')), terminalNotes.slice(-6).join(' | '));

	// R-03 and R-04, end to end: the identical command asks again, and a
	// denial keeps it from running. The first approval covered one invocation.
	await send('TERMTEST echo onyx-e2e-terminal-ok');
	await sleep(6000);
	const secondApproval = pwValue(pw('run-code', `async (page) => {
		const detail = await page.$('.monaco-dialog-box .dialog-message-detail');
		if (!detail) { return 'no-dialog'; }
		const text = await detail.textContent();
		const buttons = await page.$$('.monaco-dialog-box a.monaco-text-button');
		for (const button of buttons) {
			if ((await button.textContent())?.includes('Deny')) { await button.click(); return 'denied:' + text; }
		}
		return 'no-deny:' + text;
	}`));
	check('R-03: the same command asks again; the earlier approval covers nothing', secondApproval.startsWith('denied:echo onyx-e2e-terminal-ok'), secondApproval.slice(0, 200));
	await sleep(5000);
	const notesAfterDenial = readRuns().flatMap(run => run.events).filter(event => event.kind === 'note').map(event => String(event.data?.label ?? ''));
	check('R-04: the denied command was not dispatched', notesAfterDenial.filter(label => label.startsWith('Running: echo onyx-e2e-terminal-ok')).length === 1 && notesAfterDenial.includes('Command denied by the user'), notesAfterDenial.slice(-6).join(' | '));

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

	// --- R-15: Stop means stop. A slow stream that would end in a tool call is stopped from the run list. The
	// journal has to say `cancelled` within two seconds, the tool must never be called, and the status must
	// still be `cancelled` after the stream would have ended.
	await send('SLOWTOOLTEST think slowly, then list the folder');
	await waitUntil(() => readRunIndex().some(run => run.title.startsWith('SLOWTOOLTEST') && run.status === 'running'), 15_000, 250);
	await sleep(2500);
	await runCommand('Open Onyx Control Plane');
	await sleep(1500);
	const slowStop = pwValue(pw('run-code', `async (page) => {
		const stop = await page.$('.onyx-run.running .codicon-debug-stop');
		if (!stop) { return 'no-stop-button'; }
		await stop.click(); return 'stopped';
	}`));
	const stoppedAt = Date.now();
	const slowRun = () => readRunIndex().find(run => run.title.startsWith('SLOWTOOLTEST'));
	await waitUntil(() => slowRun()?.status === 'cancelled', 10_000, 100);
	const cancelledAfterMs = Date.now() - stoppedAt;
	check('R-15: Stop from the run list journals the run as cancelled within two seconds', slowStop === 'stopped' && slowRun()?.status === 'cancelled' && cancelledAfterMs <= 2000, `${slowStop}; status ${slowRun()?.status} after ${cancelledAfterMs} ms`);
	// Past the point where the stream would have ended and asked for its tool.
	await sleep(13_000);
	const slowEvents = readRuns().find(run => run.events.some((event: { data?: { status?: string } }) => event.data?.status === 'cancelled') && JSON.stringify(run.events).includes('SLOWTOOLTEST'))?.events ?? [];
	const slowToolCalls = slowEvents.filter((event: { kind?: string }) => event.kind === 'toolCall' || event.kind === 'toolResult').length;
	const slowOutcomes = slowEvents.filter((event: { kind?: string }) => event.kind === 'outcome').map((event: { data?: { status?: string } }) => event.data?.status);
	check('R-15: the tool call the stopped stream would have made never happens, and the status is not overwritten', slowEvents.length > 0 && slowToolCalls === 0 && slowOutcomes.length === 1 && slowOutcomes[0] === 'cancelled' && slowRun()?.status === 'cancelled', `events ${slowEvents.length}; tool events ${slowToolCalls}; outcomes ${JSON.stringify(slowOutcomes)}; status ${slowRun()?.status}`);

	// --- Resume: stop a deliberately slow run mid-stream, then resume it.
	await send('SLOWTEST take your time with this one');
	await sleep(4000);
	// Sending focused the chat, which hides the Control Plane; the Stop button lives on its run list.
	await runCommand('Open Onyx Control Plane');
	await sleep(1500);
	const stopClicked = pwValue(pw('run-code', `async (page) => {
		const stop = await page.$('.onyx-run.running .codicon-debug-stop');
		if (!stop) { return 'no-stop-button'; }
		await stop.click(); return 'stopped';
	}`));
	await sleep(3000);
	check('a streaming run can be stopped from the control plane', stopClicked === 'stopped', stopClicked);
	await runCommand('Onyx: Resume an Interrupted Run');
	await sleep(2500);
	pw('press', 'Enter'); // pick the stopped run
	await sleep(8000);
	const resumeRun = readRunIndex().find(run => run.title.startsWith('Resume an interrupted task'));
	check('resuming rebuilds the task as a new run', !!resumeRun, JSON.stringify(readRunIndex().map(run => run.title).slice(0, 6)));

	// --- Refactor engine: model-suggested rename staged through Onyx Changes.
	await openFile('report.ts');
	pw('press', 'Control+g');
	await sleep(800);
	pw('run-code', `async (page) => { await page.fill('.quick-input-box input', ':3:20'); }`);
	pw('press', 'Enter');
	await sleep(1000);
	await runCommand('Onyx: Rename Symbol');
	await sleep(9000);
	const renamePick = pwValue(pw('run-code', `async (page) => {
		const rows = await page.$$('.quick-input-widget .monaco-list-row');
		const texts = [];
		for (const row of rows) { texts.push(await row.getAttribute('aria-label')); }
		if (texts.some(text => text && text.includes('mockSuggestedName'))) { await page.keyboard.press('Enter'); return 'picked:' + texts.join(';'); }
		return 'no-suggestions:' + texts.join(';');
	}`));
	check('the rename flow offers model-suggested names', renamePick.startsWith('picked:'), renamePick.slice(0, 200));
	await sleep(4000);
	// The rename routed a naming run through chat, which swapped the aux bar
	// away from the control plane — bring it back before reading the view.
	await runCommand('Open Onyx Control Plane');
	await sleep(1500);
	const renameStaged = pw('run-code', `async (page) => page.evaluate(() => ({
		files: Array.from(document.querySelectorAll('.onyx-change-file-path')).map(el => el.textContent),
		notifications: Array.from(document.querySelectorAll('.notifications-toasts .notification-list-item-message')).map(el => el.textContent),
	}))`);
	check('the rename staged into Onyx Changes, not the buffer', renameStaged.includes('report.ts'), renameStaged.slice(0, 300));
	pw('run-code', 'async (page) => { await page.locator(".onyx-changes-summary button").nth(1).click(); }'); // Reject All
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

	// --- R-51 (L11): Measure Models for This Repository, against the mock. The estimate is shown before it starts;
	// the scorecard carries provenance, each model's datasheet where there is one, and counts; below the minimum
	// sample it does not rank; the router's hit rate is printed with its denominator; a measurement stopped
	// midway is labelled partial.
	const scorecardDirs = () => {
		const root = path.join(workspace, '.onyx', 'scorecards');
		return fs.existsSync(root) ? fs.readdirSync(root).sort().map(name => path.join(root, name)) : [];
	};
	const dialogText = () => pwValue(pw('run-code', `async (page) => { const box = await page.$('.monaco-dialog-box'); return box ? ((await box.textContent()) || '') : 'no-dialog'; }`));
	const clickDialogButton = (label: string) => pwValue(pw('run-code', `async (page) => {
		const buttons = await page.$$('.monaco-dialog-box a.monaco-text-button');
		for (const button of buttons) {
			if (((await button.textContent()) || '').trim() === ${JSON.stringify(label)}) { await button.click(); return 'clicked'; }
		}
		return 'no-button';
	}`));
	const quickPickShows = (text: string) => pwValue(pw('run-code', `async (page) => { const widget = await page.$('.quick-input-widget'); const shown = widget && await widget.isVisible(); return shown && ((await widget.textContent()) || '').includes(${JSON.stringify(text)}) ? 'yes' : 'no'; }`)) === 'yes';
	await runCommand('Onyx: Measure Models for This Repository');
	await waitUntil(() => quickPickShows('mock-coder'), 15_000, 500);
	pw('press', 'Enter'); // accept the preselected models
	let measureDialog = 'no-dialog';
	await waitUntil(() => { measureDialog = dialogText(); return measureDialog !== 'no-dialog'; }, 30_000, 500);
	check('R-51: the measurement says what it will do and how long it expects to take before it starts', /Measure \d+ model\(s\) on \d+ task\(s\)/.test(measureDialog) && /\d+ units, (about|no estimate)/.test(measureDialog) && /One model is loaded at a time/.test(measureDialog), measureDialog.slice(0, 300));
	const beforeMeasure = scorecardDirs().length;
	clickDialogButton('Measure');
	await waitUntil(() => quickPickShows('Save the scorecard'), 120_000, 500);
	pw('press', 'Enter'); // the first choice: save it into the workspace
	await waitUntil(() => scorecardDirs().length > beforeMeasure && fs.existsSync(path.join(scorecardDirs().at(-1)!, 'scorecard.json')), 20_000, 250);
	interface IScorecardFile { partial: boolean; plannedUnits: number; attempts: { outcome: string; score: number | null }[]; skips: unknown[]; models: { id: string; runtime: string }[]; tasks: { total: number; bySource: { history: number } }; repository: { commit: string | null }; machine: { cpu: string }; ranking: { ranked: boolean; reason?: string }; routing: { tournament: { of: number }; outcomes: { of: number } } | null }
	const readCard = (dir: string | undefined) => ({
		json: dir && fs.existsSync(path.join(dir, 'scorecard.json')) ? JSON.parse(fs.readFileSync(path.join(dir, 'scorecard.json'), 'utf8')) as IScorecardFile : undefined,
		markdown: dir && fs.existsSync(path.join(dir, 'scorecard.md')) ? fs.readFileSync(path.join(dir, 'scorecard.md'), 'utf8') : '',
		svg: dir && fs.existsSync(path.join(dir, 'scorecard.svg')) ? fs.readFileSync(path.join(dir, 'scorecard.svg'), 'utf8') : '',
	});
	const whole = readCard(scorecardDirs().at(-1));
	const measureRun = readRunIndex().find(run => run.title.startsWith('Measure models'));
	// Two endpoints serve models of the same names here: each is a model of its own in the scorecard.
	check('R-51: the measurement ran every planned unit against two or more models and journaled a completed run', !!whole.json && !whole.json.partial && whole.json.attempts.length === whole.json.plannedUnits && whole.json.models.length >= 2 && new Set(whole.json.models.map(model => model.id)).size === whole.json.models.length && whole.json.attempts.every(attempt => attempt.outcome === 'attempted') && measureRun?.status === 'completed', `${whole.json?.attempts.length} of ${whole.json?.plannedUnits}; models ${whole.json?.models.length}; run ${measureRun?.status}`);
	check('R-51: the scorecard has provenance, a datasheet section for every model, and the task counts', !!whole.json && /^[0-9a-f]{40}$/.test(whole.json.repository.commit ?? '') && whole.json.machine.cpu.length > 0 && whole.json.tasks.total >= 1 && whole.json.tasks.bySource.history === whole.json.tasks.total
		&& whole.markdown.includes('## Provenance') && whole.markdown.includes('Weights digest:') && (whole.markdown.match(/- Datasheet/g) ?? []).length === whole.json.models.length && /\d+ tasks: \d+ from this repository's history, 0 from your own accepted requests\./.test(whole.markdown)
		&& whole.svg.startsWith('<svg') && whole.svg.includes('metric changed-line-f1-preserving/2'), whole.markdown.slice(0, 400));
	check('R-51: below the minimum sample the scorecard says there are not enough tasks to rank, and does not rank', whole.json?.ranking.ranked === false && whole.json?.ranking.reason === 'too-few-tasks' && whole.markdown.includes('**Not enough tasks to rank.**') && !whole.markdown.includes('**Ranking**') && whole.svg.includes('Not ranked'), JSON.stringify(whole.json?.ranking));
	check('R-51: the router\'s hit rate is printed with its denominators and as logged choices, not a comparison', !!whole.json?.routing && whole.markdown.includes(` of ${whole.json.routing.tournament.of} tournaments.`) && whole.markdown.includes(` of ${whole.json.routing.outcomes.of} runs with a recorded outcome.`) && whole.markdown.includes('not a randomized comparison'), whole.markdown.split('\n').filter(line => /tournament|recorded outcome|randomized/.test(line)).join(' / ').slice(0, 300));

	// A cancel midway: three more commits, the middle one answered slowly, and Stop while it is in flight.
	fs.writeFileSync(path.join(workspace, 'src', 'slow.ts'), ['export function slowWords(): string[] {', `\treturn [${Array.from({ length: 70 }, (_, index) => `'w${index}'`).join(', ')}];`, '}', ''].join('\n'));
	git('add', '-A');
	git('commit', '-qm', 'Add the slow word list');
	fs.appendFileSync(path.join(workspace, 'src', 'slow.ts'), ['export function slowCount(): number {', '\tconst words = slowWords();', '\treturn words.length;', '}', ''].join('\n'));
	git('add', '-A');
	git('commit', '-qm', 'SLOWTEST count the slow words');
	fs.appendFileSync(path.join(workspace, 'src', 'math.ts'), ['export function halveAll(values: number[]): number[] {', '\treturn values.map(value => value / 2);', '}', ''].join('\n'));
	git('add', '-A');
	git('commit', '-qm', 'Add halveAll helper');
	await runCommand('Onyx: Measure Models for This Repository');
	await waitUntil(() => quickPickShows('mock-coder'), 15_000, 500);
	pw('press', 'Enter');
	await waitUntil(() => dialogText() !== 'no-dialog', 30_000, 500);
	const beforeCancel = scorecardDirs().length;
	const measureRuns = () => readRunIndex().filter(run => run.title.startsWith('Measure models'));
	const runsBefore = measureRuns().length;
	clickDialogButton('Measure');
	await waitUntil(() => measureRuns().length > runsBefore && measureRuns().some(run => run.status === 'running'), 30_000, 250);
	// The newest commit is answered at once; the slow one is then in flight for many seconds.
	await sleep(4000);
	await runCommand('Open Onyx Control Plane');
	await sleep(1500);
	const measureStop = pwValue(pw('run-code', `async (page) => {
		const stop = await page.$('.onyx-run.running .codicon-debug-stop');
		if (!stop) { return 'no-stop-button'; }
		await stop.click(); return 'stopped';
	}`));
	await waitUntil(() => measureRuns().some(run => run.status === 'cancelled'), 15_000, 250);
	await waitUntil(() => quickPickShows('Save the scorecard'), 30_000, 500);
	pw('press', 'Enter');
	await waitUntil(() => scorecardDirs().length > beforeCancel && fs.existsSync(path.join(scorecardDirs().at(-1)!, 'scorecard.json')), 20_000, 250);
	const stopped = readCard(scorecardDirs().length > beforeCancel ? scorecardDirs().at(-1) : undefined);
	check('R-51: a measurement stopped midway is labelled partial, lists what did not run, and is not ranked', measureStop === 'stopped' && measureRuns().some(run => run.status === 'cancelled') && !!stopped.json && stopped.json.partial && stopped.json.attempts.length >= 1 && stopped.json.attempts.length < stopped.json.plannedUnits && stopped.json.skips.length === stopped.json.plannedUnits - stopped.json.attempts.length
		&& stopped.markdown.startsWith('# Onyx scorecard (partial)') && stopped.markdown.includes('**Not ranked: this is a partial result.**') && stopped.json.ranking.reason === 'partial', `${measureStop}; ${stopped.json?.attempts.length} of ${stopped.json?.plannedUnits}; skips ${stopped.json?.skips.length}`);

	// --- Speculative decoding: the pairing flow reaches the "enable it on your
	// runtime, then measure again" gate. Onyx never puts a draft on the wire —
	// every runtime that supports this configures it at model load time.
	await runCommand('Onyx: Measure Speculative Decoding');
	await sleep(2500);
	pw('run-code', `async (page) => { const rows = await page.$$('.quick-input-widget .monaco-list-row'); for (const row of rows) { if ((await row.getAttribute('aria-label'))?.includes('32b')) { await row.click(); return; } } }`);
	await sleep(1500);
	pw('run-code', `async (page) => { const rows = await page.$$('.quick-input-widget .monaco-list-row'); for (const row of rows) { if ((await row.getAttribute('aria-label'))?.includes('7b')) { await row.click(); return; } } }`);
	await sleep(14000);
	const speculativeGate = pw('run-code', `async (page) => page.evaluate(() => ({
		detail: document.querySelector('.monaco-dialog-box .dialog-message-detail')?.textContent ?? '(no dialog)',
	}))`);
	check('speculative decoding measures a baseline and explains how to enable the draft',
		speculativeGate.includes('tok/s on this machine') && speculativeGate.includes('--speculative-draft-model'),
		speculativeGate.slice(0, 220));
	const lmChats = await fetch(`http://127.0.0.1:${lmStudioPort}/debug/recent-chats`)
		.then(response => response.json() as Promise<{ model?: string; draft_model?: string }[]>)
		.catch(() => [] as { model?: string; draft_model?: string }[]);
	check('no draft_model is ever sent on the wire', lmChats.every(chat => chat.draft_model === undefined),
		`${lmChats.filter(chat => chat.draft_model).length} of ${lmChats.length} chats carried a draft`);
	pw('run-code', `async (page) => { const buttons = await page.$$('.monaco-dialog-box a.monaco-text-button'); for (const b of buttons) { if ((await b.textContent())?.includes('Cancel')) { await b.click(); return; } } await page.keyboard.press('Escape'); }`);
	await sleep(1500);

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
	// A failed driver command carries what it printed; without it an abort
	// names the command and nothing about why it failed.
	const output = error as { stdout?: unknown; stderr?: unknown };
	for (const [stream, text] of [['stdout', output.stdout], ['stderr', output.stderr]] as const) {
		if (typeof text === 'string' && text.trim()) {
			console.error(`--- ${stream} of the failed command (last 2000 characters)\n${text.trim().slice(-2000)}`);
		}
	}
	if (error instanceof Error && error.cause instanceof Error) {
		console.error(`caused by: ${error.cause.message}`);
	}
	// What the window showed when the run stopped. The run directory is
	// removed afterwards unless --keep was passed.
	try {
		pw('screenshot', `--filename=${path.join(runDir, 'abort.png')}`);
		console.error(`screenshot at the abort: ${path.join(runDir, 'abort.png')}${keep ? '' : ' (pass --keep to keep it)'}`);
	} catch {
		// no attached session to capture
	}
	failures.push('harness');
} finally {
	writeAccessibilityRecord();
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
			if (!child.pid) {
				continue;
			}
			try {
				process.kill(-child.pid, signal);
			} catch {
				// The group is gone (or never existed); try the process itself
				// rather than leaving a listener behind.
				try {
					process.kill(child.pid, signal);
				} catch {
					// already gone
				}
			}
		}
		if (signal === 'SIGTERM') {
			await sleep(2000);
		}
	}
	// On CI a failed run keeps its directory, so that the upload step has its logs and abort screenshot.
	if (keep || (process.env.CI && failures.length)) {
		console.log(`\nkept ${runDir}`);
	} else {
		fs.rmSync(runDir, { recursive: true, force: true });
	}
}

console.log(failures.length
	? `\n${failures.length} of ${checksRun} checks failed`
	: `\nall ${checksRun} checks passed${sessionsLost ? ` (the driver's session was lost and attached again ${sessionsLost} time${sessionsLost === 1 ? '' : 's'}; the workbench was not restarted)` : ''}${pasteRetries ? ` (a paste left the chat input empty and was made again ${pasteRetries} time${pasteRetries === 1 ? '' : 's'})` : ''}`);
process.exit(failures.length ? 1 : 0);
