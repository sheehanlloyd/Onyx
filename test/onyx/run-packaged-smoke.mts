/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Packaged-app smoke harness (A8, R-31).
 *
 *   node test/onyx/run-packaged-smoke.mts --app <path/to/Onyx.app> [--mode baseline|release] [--json-out <file>] [--keep]
 *
 * Launches the packaged app (not the dev workbench) with a throwaway profile
 * and workspace against the mock runtime, drives it through CDP with
 * @playwright/cli, and records what the packaged build actually exposes.
 *
 * `--mode baseline` proves launch, profile and runtime isolation, and records
 * the tools the agent advertised, the gaps against the six essential tools
 * (B1) and the build's revision. It passes when that infrastructure works; it
 * makes no claim that reading or editing works.
 *
 * `--mode release` (the default) requires the documented contract: all six
 * essential tools advertised; a read → staged edit → accept flow in which the
 * staged hunk equals the content the model read and nothing touches the file
 * before acceptance; a reject that leaves the file untouched; and an actual
 * terminal approval dialog naming the exact command. Until B1 and B3 land it
 * fails for the missing read-side tools, which the module gate names as the
 * baseline exception owned by B1 and B3.
 */

import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function argValue(flag: string): string | undefined {
	const index = process.argv.indexOf(flag);
	return index === -1 ? undefined : process.argv[index + 1];
}

const appPath = argValue('--app');
const mode = (argValue('--mode') ?? 'release') as 'baseline' | 'release';
const jsonOut = argValue('--json-out');
const keep = process.argv.includes('--keep');
if (!appPath || !['baseline', 'release'].includes(mode)) {
	console.error('usage: node test/onyx/run-packaged-smoke.mts --app <path/to/Onyx.app> [--mode baseline|release] [--json-out <file>] [--keep]');
	process.exit(2);
}
const app = path.resolve(appPath);
const mockPort = Number(process.env.ONYX_MOCK_PORT ?? 11434);
const cdpPort = Number(process.env.ONYX_CDP_PORT ?? 9333);
// Short on purpose: the CLI's Unix socket path must stay under macOS's 104-byte limit.
const session = `pk-${process.pid}`;

/** The six essential tools B1 specifies; the supported profile keeps eight slots. */
const ESSENTIAL_TOOLS = ['readFile', 'listDirectory', 'findFiles', 'grep', 'editFile', 'terminal'];
const SLOT_CAP = 8;

const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onyx-packaged-'));
const workspace = path.join(runDir, 'ws');
const userDataDir = path.join(runDir, 'user-data');
const extensionsDir = path.join(runDir, 'extensions');
const children: ReturnType<typeof spawn>[] = [];

interface ICheck { readonly name: string; readonly ok: boolean; readonly detail?: string; readonly claim: 'infrastructure' | 'contract' }
const checks: ICheck[] = [];
const observed: Record<string, unknown> = {};

function check(claim: ICheck['claim'], name: string, ok: boolean, detail?: string) {
	checks.push({ name, ok, detail, claim });
	console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail && !ok ? ` — ${detail}` : ''}`);
}

function sleep(ms: number) {
	return new Promise(resolve => setTimeout(resolve, ms));
}

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

/** The installed @playwright/cli, run with this Node (see run-e2e.mts). */
const playwrightCli = createRequire(import.meta.url).resolve('@playwright/cli/playwright-cli.js');

function pw(...args: string[]) {
	return execFileSync(process.execPath, [playwrightCli, `-s=${session}`, ...args], { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
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

const MATH_TS = [
	'export function addNumbers(a: number, b: number): number {',
	'\treturn a + b;',
	'}',
	'',
].join('\n');

function seedWorkspace() {
	fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
	fs.writeFileSync(path.join(workspace, 'src', 'math.ts'), MATH_TS);
	fs.mkdirSync(path.join(userDataDir, 'User'), { recursive: true });
	// Native dialogs are invisible to CDP; the terminal approval needs DOM dialogs.
	fs.writeFileSync(path.join(userDataDir, 'User', 'settings.json'), JSON.stringify({ 'window.dialogStyle': 'custom', 'files.simpleDialog.enable': true }, null, '\t'));
	execFileSync('git', ['-C', workspace, 'init', '-q']);
	execFileSync('git', ['-C', workspace, '-c', 'user.email=onyx-packaged@localhost', '-c', 'user.name=onyx-packaged', 'add', '-A']);
	execFileSync('git', ['-C', workspace, '-c', 'user.email=onyx-packaged@localhost', '-c', 'user.name=onyx-packaged', 'commit', '-qm', 'initial']);
}

async function fetchJson<T>(url: string): Promise<T | undefined> {
	try {
		const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
		return response.ok ? await response.json() as T : undefined;
	} catch {
		return undefined;
	}
}

async function waitForMock(timeoutMs: number) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const body = await fetchJson<{ data?: { id: string }[] }>(`http://127.0.0.1:${mockPort}/v1/models`);
		if ((body?.data ?? []).some(model => model.id.startsWith('mock-'))) {
			return true;
		}
		await sleep(200);
	}
	return false;
}

async function waitForCdp(timeoutMs: number) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await fetchJson(`http://127.0.0.1:${cdpPort}/json/version`)) {
			return true;
		}
		await sleep(500);
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

function readRuns() {
	const dir = journalDir();
	if (!dir) {
		return [];
	}
	return fs.readdirSync(dir).filter(name => name.endsWith('.jsonl')).sort().map(name => ({
		name,
		events: fs.readFileSync(path.join(dir, name), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as { kind: string; data?: Record<string, unknown> }),
	}));
}

function readRunIndex(): { title: string; task: string; status: string; runId: string; modelKey?: string }[] {
	const dir = journalDir();
	if (!dir) {
		return [];
	}
	const indexPath = path.join(path.dirname(dir), 'index.json');
	try {
		return JSON.parse(fs.readFileSync(indexPath, 'utf8'));
	} catch {
		return [];
	}
}

async function send(prompt: string) {
	const focusScript = path.join(repoRoot, '.agents', 'skills', 'launch', 'playwrightScripts', 'focus-chat-input.ts');
	const paste = path.join(repoRoot, '.agents', 'skills', 'launch', 'scripts', 'monaco-paste.sh');
	pw('run-code', `--filename=${focusScript}`);
	execFileSync(paste, ['--session', session, prompt], { cwd: repoRoot, encoding: 'utf8' });
	pw('press', 'Enter');
}

function appExecutable(): string {
	const macos = path.join(app, 'Contents', 'MacOS');
	const entries = fs.existsSync(macos) ? fs.readdirSync(macos) : [];
	if (entries.length !== 1) {
		throw new Error(`${macos} should hold exactly one executable, found: ${entries.join(', ') || 'none'}`);
	}
	return path.join(macos, entries[0]);
}

function appProduct(): { nameShort?: string; version?: string; commit?: string; date?: string; quality?: string } {
	try {
		return JSON.parse(fs.readFileSync(path.join(app, 'Contents', 'Resources', 'app', 'product.json'), 'utf8'));
	} catch {
		return {};
	}
}

async function main() {
	console.log(`packaged smoke · mode ${mode} · ${app}`);
	console.log(`run dir: ${runDir}`);
	if (process.platform !== 'darwin') {
		throw new Error('the packaged smoke drives a macOS .app bundle (DEC-02); run it on macOS');
	}
	const product = appProduct();
	observed.product = { nameShort: product.nameShort, version: product.version, commit: product.commit, date: product.date, quality: product.quality };
	observed.sourceRevision = execFileSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
	const executable = appExecutable();
	check('infrastructure', 'the app bundle has a product.json with a commit', !!product.commit, JSON.stringify(observed.product));
	if (await fetchJson(`http://127.0.0.1:${cdpPort}/json/version`)) {
		throw new Error(`something is already debugging on :${cdpPort} — close it, or set ONYX_CDP_PORT`);
	}
	seedWorkspace();

	children.push(spawn(process.execPath, [path.join(repoRoot, 'test', 'onyx', 'mock-ollama.mts')], { cwd: repoRoot, env: { ...process.env, ONYX_MOCK_PORT: String(mockPort) }, stdio: 'ignore', detached: true }));
	if (!await waitForMock(10_000)) {
		throw new Error(`the mock runtime never answered on :${mockPort} — stop any real runtime on that port, or set ONYX_MOCK_PORT`);
	}

	children.push(spawn(executable, [
		`--user-data-dir=${userDataDir}`,
		`--extensions-dir=${extensionsDir}`,
		`--remote-debugging-port=${cdpPort}`,
		// Keeps the app under test away from the login keychain: its "Safe
		// Storage" key belongs to whichever Electron binary created it, and
		// a rebuilt app that reads it makes macOS prompt and blocks the main
		// thread, which hangs the debugging endpoint (see run-e2e.mts).
		'--use-mock-keychain',
		'--disable-workspace-trust',
		'--skip-release-notes',
		'--disable-updates',
		workspace,
		path.join(workspace, 'src', 'math.ts'),
	], { cwd: runDir, env: { ...process.env }, stdio: 'ignore', detached: true }));
	const cdpUp = await waitForCdp(120_000);
	check('infrastructure', 'the packaged app launched and opened a CDP endpoint', cdpUp);
	if (!cdpUp) {
		return;
	}
	try {
		pw('attach', `--cdp=http://127.0.0.1:${cdpPort}`);
	} catch (error) {
		// Name the cause when the endpoint came up and then went silent.
		if (!await fetchJson(`http://127.0.0.1:${cdpPort}/json/version`)) {
			throw new Error(`the debugging endpoint on :${cdpPort} answered and then stopped: the app's main process is blocked, which on macOS means a system prompt (the login keychain) is waiting for an answer`, { cause: error });
		}
		throw error;
	}
	await sleep(6000);
	await dismissOnboarding(30_000);
	await sleep(3000);
	// The DOM title carries no product name; Electron's user agent carries the
	// app name the bundle was built with, which is the signal that this window
	// is the packaged product and not a dev workbench on the same ports.
	const identity = pw('run-code', 'async (page) => page.evaluate(() => JSON.stringify({ userAgent: navigator.userAgent, title: document.title }))');
	const identityLine = identity.split('\n').find(line => line.includes('userAgent')) ?? '{}';
	try {
		observed.window = JSON.parse(JSON.parse(identityLine));
	} catch {
		observed.window = { raw: identityLine.slice(0, 200) };
	}
	const userAgent = String((observed.window as { userAgent?: string }).userAgent ?? '');
	check('infrastructure', 'the window belongs to the packaged product', userAgent.includes(`${product.nameShort ?? 'Onyx'}/`), userAgent.slice(0, 160));

	// A first agent turn: whatever tools the packaged build advertises arrive
	// at the mock in the request body. That is the observed inventory.
	await dismissOnboarding(0);
	await send('TOOLTEST inventory the tools you were given');
	await waitUntil(() => readRunIndex().length >= 1, 30_000);
	await sleep(4000);
	const lastChat = await fetchJson<{ model?: string; tools?: { function: { name: string } }[] }>(`http://127.0.0.1:${mockPort}/debug/last-chat`);
	const advertised = (lastChat?.tools ?? []).map(tool => tool.function.name);
	observed.advertisedTools = advertised;
	observed.model = lastChat?.model;
	observed.missingEssentials = ESSENTIAL_TOOLS.filter(name => !advertised.includes(name));
	check('infrastructure', 'the agent reached the mock runtime, not a real one', !!lastChat?.model && lastChat.model.startsWith('mock-'), String(lastChat?.model));
	check('infrastructure', 'the run journal lives in the throwaway profile', !!journalDir() && journalDir()!.startsWith(userDataDir), journalDir());
	check('infrastructure', 'the request carried a tool list', advertised.length > 0, 'no tools in the chat request');
	console.log(`  observed tools (${advertised.length}): ${advertised.join(', ') || 'none'}`);
	console.log(`  missing essentials: ${(observed.missingEssentials as string[]).join(', ') || 'none'}`);

	if (mode === 'baseline') {
		return;
	}

	// --- release contract -------------------------------------------------
	check('contract', 'all six essential tools are advertised', (observed.missingEssentials as string[]).length === 0, `missing: ${(observed.missingEssentials as string[]).join(', ')}`);
	check('contract', `the tool list stays within the ${SLOT_CAP}-slot supported profile`, advertised.length <= SLOT_CAP, `${advertised.length} tools`);

	// Read → staged edit: the mock reads math.ts through the read tool and
	// proposes an edit whose SEARCH text is the line it read back.
	await send('READEDITTEST src/math.ts');
	const stagedSummary = () => JSON.stringify(readRuns().flatMap(run => run.events).filter(event => event.kind === 'promptSnapshot').slice(-3));
	await waitUntil(() => stagedSummary().includes('reviews them in Onyx Changes') || stagedSummary().includes('no read tool'), 40_000);
	const toolCalls = readRuns().flatMap(run => run.events).filter(event => event.kind === 'toolCall').map(event => String(event.data?.label ?? ''));
	check('contract', 'the model read the file through the read tool before editing', toolCalls.includes('readFile'), `tool calls: ${toolCalls.join(', ') || 'none'}`);
	check('contract', 'the edit was staged, not written', fs.readFileSync(path.join(workspace, 'src', 'math.ts'), 'utf8') === MATH_TS && stagedSummary().includes('reviews them in Onyx Changes'), 'file changed on disk, or nothing was staged');
	// Whether the Changes view is on screen: a staged file's header exists and is laid out. The DOM keeps
	// the view when the chat hides it, so reading its text says nothing about whether it can be clicked.
	const changesOnScreen = () => pwValue(pw('run-code', 'async (page) => page.evaluate(() => { const header = document.querySelector(".onyx-change-file-header"); return String(!!header && header.getClientRects().length > 0); })')) === 'true';
	// On a loaded machine the command palette can take longer than a fixed pause to accept input, and the
	// command is then typed into nothing. Issue it, look for the view, and issue it again if it is not there.
	const openControlPlane = async () => {
		for (let attempt = 0; attempt < 4 && !changesOnScreen(); attempt++) {
			pw('press', 'Escape');
			pw('press', 'F1');
			await sleep(800 + attempt * 800);
			pw('run-code', 'async (page) => { await page.fill(".quick-input-box input", ">Open Onyx Control Plane"); }');
			await sleep(800 + attempt * 800);
			pw('press', 'Enter');
			await waitUntil(changesOnScreen, 8000);
		}
	};
	await dismissOnboarding(0);
	await openControlPlane();
	// A staged file is listed collapsed; its hunks render once its header is
	// expanded. A removed line reads "− <text>" and an added one "+ <text>".
	const readChanges = () => pw('run-code', 'async (page) => page.evaluate(() => JSON.stringify({ files: Array.from(document.querySelectorAll(".onyx-change-file-path")).map(el => el.textContent), removed: Array.from(document.querySelectorAll(".onyx-change-hunk .onyx-change-line.removed")).map(el => el.textContent), added: Array.from(document.querySelectorAll(".onyx-change-hunk .onyx-change-line.added")).map(el => el.textContent) }))');
	const editorText = () => pw('run-code', 'async (page) => page.evaluate(() => Array.from(document.querySelectorAll(".editor-instance .view-line")).map(l => l.textContent || "").join(" / ").slice(0, 600))');
	const editCalls = () => readRuns().flatMap(run => run.events).filter(event => event.kind === 'toolCall' && event.data?.label === 'editFile').length;
	await waitUntil(() => readChanges().includes('src/math.ts'), 15_000);
	// Expand the staged file. A click that cannot land (the view is still laying out) is tried again after
	// looking for the view once more; what is checked below is the hunk the expanded file shows.
	for (let attempt = 0; attempt < 3 && !readChanges().includes('return a + b;'); attempt++) {
		try {
			pw('run-code', 'async (page) => { const header = page.locator(".onyx-change-file-header[aria-expanded=false]").first(); if (await header.count()) { await header.click({ timeout: 8000 }); } }');
		} catch {
			await openControlPlane();
		}
		await waitUntil(() => readChanges().includes('return a + b;'), 10_000);
	}
	const changes = readChanges();
	// The hunk under review is the line the model read (R-31): removed once
	// as it is in the file, added once with the edit, and nothing else.
	const hunk = /"removed\\?":\s*\[(?<removed>[^\]]*)\],\s*\\?"added\\?":\s*\[(?<added>[^\]]*)\]/.exec(changes)?.groups;
	const oneLineEach = !!hunk && hunk.removed.includes('return a + b;') && !hunk.removed.includes('edited-by-mock') && hunk.added.includes('return a + b; // edited-by-mock') && !hunk.removed.includes(',') && !hunk.added.includes(',');
	check('contract', 'the staged hunk shows the content the model read (R-31)', changes.includes('src/math.ts') && oneLineEach, changes.slice(0, 400));
	pw('run-code', 'async (page) => { const buttons = await page.$$(".onyx-changes-summary button"); if (buttons[1]) { await buttons[1].click(); } }'); // Reject All
	await sleep(1500);
	check('contract', 'rejecting leaves the file untouched', fs.readFileSync(path.join(workspace, 'src', 'math.ts'), 'utf8') === MATH_TS && !editorText().includes('edited-by-mock'));
	const editCallsBefore = editCalls();
	await send('READEDITTEST src/math.ts');
	await waitUntil(() => editCalls() > editCallsBefore, 40_000);
	// Sending focused the chat, which hides the Control Plane and its Changes view.
	await openControlPlane();
	const stagedAgain = await waitUntil(() => editCalls() > editCallsBefore && readChanges().includes('src/math.ts'), 20_000);
	pw('run-code', 'async (page) => { const button = await page.$(".onyx-changes-summary button"); if (button) { await button.click(); } }'); // Accept All
	const accepted = await waitUntil(() => editorText().includes('edited-by-mock'), 15_000);
	check('contract', 'accepting applies the reviewed hunk to the buffer', stagedAgain && accepted, `staged again: ${stagedAgain}; changes: ${readChanges().slice(0, 200)}; editor: ${editorText().slice(0, 300)}`);

	// Terminal: an actual approval dialog naming the exact command.
	await send('TERMTEST echo onyx-packaged-terminal-ok');
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
	check('contract', 'the terminal tool asks before running', approval.startsWith('approved:'), approval.slice(0, 160));
	check('contract', 'the approval names the exact command', approval.startsWith('approved:echo onyx-packaged-terminal-ok'), approval.slice(0, 160));
	check('contract', 'the approval offers Run Once and Deny, and nothing that outlives the invocation (B2)', /buttons=Deny\+Run Once$/.test(approval), approval.slice(0, 400));
	await sleep(4000);

	// --- R-05: the tool capability contract (B3) --------------------------
	// The reviewed table is read from freshly transpiled output, the same
	// module the product was built from.
	const contractPath = path.join(repoRoot, 'out', 'vs', 'workbench', 'contrib', 'onyx', 'common', 'onyxToolContract.js');
	const contract = fs.existsSync(contractPath)
		? await import(pathToFileURL(contractPath).href) as { contractInventory(options: { networkTools: boolean }): string[]; ONYX_TOOL_CONTRACT_VERSION: number }
		: undefined;
	const defaultInventory = contract?.contractInventory({ networkTools: false }) ?? [];
	const networkInventory = contract?.contractInventory({ networkTools: true }) ?? [];
	observed.contractVersion = contract?.ONYX_TOOL_CONTRACT_VERSION;
	const supportedProfileDefault = [...ESSENTIAL_TOOLS, 'repoSymbols', 'docs'];
	check('contract', 'R-05: the default tool list is exactly the documented one for the supported profile', JSON.stringify(advertised) === JSON.stringify(supportedProfileDefault), `advertised: ${advertised.join(', ')}`);
	check('contract', 'R-05: every advertised tool is in the versioned contract\'s default inventory', !!contract && advertised.every(name => defaultInventory.includes(name)), contract ? `outside the contract: ${advertised.filter(name => !defaultInventory.includes(name)).join(', ') || 'none'}` : 'out/ has no onyxToolContract.js: run pnpm run transpile-client first');

	// The supported opt-in: the reviewed network tools. It must not enlarge
	// the slot budget, must admit nothing but the reviewed rows, and every
	// network call must still ask.
	const settingsPath = path.join(userDataDir, 'User', 'settings.json');
	fs.writeFileSync(settingsPath, JSON.stringify({ ...JSON.parse(fs.readFileSync(settingsPath, 'utf8')), 'onyx.agent.networkTools': true }, null, '\t'));
	await sleep(3000);
	const chatTools = async () => ((await fetchJson<{ tools?: { function: { name: string } }[] }>(`http://127.0.0.1:${mockPort}/debug/last-chat`))?.tools ?? []).map(tool => tool.function.name);
	const runsBeforeOptIn = readRunIndex().length;
	await send('TOOLTEST inventory the tools again');
	await waitUntil(() => readRunIndex().length > runsBeforeOptIn, 30_000);
	await sleep(4000);
	const optInDefault = await chatTools();
	check('contract', 'R-05: the network opt-in does not enlarge the slot budget or displace a tool unasked', JSON.stringify(optInDefault) === JSON.stringify(supportedProfileDefault), `advertised: ${optInDefault.join(', ')}`);
	const runsBeforeAsk = readRunIndex().length;
	await send('NETTEST https://example.com/onyx-packaged-smoke in the browser');
	await waitUntil(() => readRunIndex().length > runsBeforeAsk, 30_000);
	await sleep(5000);
	const optInAsked = ((await fetchJson<{ tools?: { function: { name: string } }[] }[]>(`http://127.0.0.1:${mockPort}/debug/recent-chats`)) ?? []).map(chat => (chat.tools ?? []).map(tool => tool.function.name)).find(names => names.includes('openBrowserPage')) ?? await chatTools();
	observed.networkOptInTools = optInAsked;
	check('contract', 'R-05: with the opt-in, a network tool asked for by name takes a spare slot, within the same eight', JSON.stringify(optInAsked) === JSON.stringify([...ESSENTIAL_TOOLS, 'openBrowserPage', 'readPage']) && !!contract && optInAsked.every(name => networkInventory.includes(name)), `advertised: ${optInAsked.join(', ')}`);
	const networkApproval = pwValue(pw('run-code', `async (page) => {
		const detail = await page.$('.monaco-dialog-box .dialog-message-detail');
		const message = await page.$('.monaco-dialog-box .dialog-message-text');
		if (!detail) { return 'no-dialog'; }
		const text = (message ? await message.textContent() : '') + ' :: ' + await detail.textContent();
		const buttons = await page.$$('.monaco-dialog-box a.monaco-text-button');
		for (const button of buttons) {
			if ((await button.textContent())?.includes('Deny')) { await button.click(); return 'denied:' + text; }
		}
		return 'no-deny:' + text;
	}`));
	check('contract', 'R-05: the opt-in does not bypass approval: a network call asks first, showing the tool and the URL', networkApproval.startsWith('denied:') && networkApproval.includes('use the network') && networkApproval.includes('Tool: openBrowserPage') && networkApproval.includes('https://example.com/onyx-packaged-smoke'), networkApproval.slice(0, 400));
	await sleep(3000);
	const networkNotes = readRuns().flatMap(run => run.events).filter(event => event.kind === 'toolResult' && event.data?.label === 'openBrowserPage').map(event => String(event.data?.reason ?? event.data?.ok));
	check('contract', 'R-05: the denied network call did not run', networkNotes.length === 1 && networkNotes[0].includes('denied by the user'), networkNotes.join(' | ') || 'no openBrowserPage result on the timeline');

	// --- The Agent Host is excluded (B3) -----------------------------------
	// When upstream's Agent Host starts it writes agenthost.log into the
	// window's log directory. Several agent runs later there must be none,
	// and asking for the Agents window must not start one either.
	const agentHostLogs = () => fs.existsSync(path.join(userDataDir, 'logs')) ? fs.readdirSync(path.join(userDataDir, 'logs'), { recursive: true, encoding: 'utf8' }).filter(name => /agenthost/i.test(name)) : ['no logs directory'];
	check('contract', 'the Agent Host did not start: no agenthost log in this profile', agentHostLogs().length === 0, agentHostLogs().join(', '));
	const pageTargets = async () => ((await fetchJson<{ type: string; url: string }[]>(`http://127.0.0.1:${cdpPort}/json/list`)) ?? []).filter(target => target.type === 'page').map(target => target.url.slice(-60));
	const targetsBefore = await pageTargets();
	pw('press', 'F1');
	await sleep(800);
	pw('run-code', 'async (page) => { await page.fill(".quick-input-box input", ">Open Agents Window"); }');
	await sleep(1000);
	pw('press', 'Enter');
	await sleep(5000);
	pw('press', 'Escape');
	const targetsAfter = await pageTargets();
	check('contract', 'asking for the Agents window opens no second workbench and starts no Agent Host', targetsAfter.length === targetsBefore.length && !targetsAfter.some(url => /sessions/.test(url)) && agentHostLogs().length === 0, `pages before: ${targetsBefore.join(' | ')}; after: ${targetsAfter.join(' | ')}; logs: ${agentHostLogs().join(', ') || 'none'}`);
}

/** What a failed driver command printed, when the error carries it. */
function driverOutput(error: unknown): string {
	if (typeof error !== 'object' || error === null) {
		return '';
	}
	const carried = error as { readonly stdout?: unknown; readonly stderr?: unknown };
	return [carried.stdout, carried.stderr].filter((part): part is string => typeof part === 'string' && part.trim().length > 0).join('\n');
}

let aborted: string | undefined;
try {
	await main();
} catch (error) {
	aborted = error instanceof Error ? error.message : String(error);
	console.error(`\npackaged smoke aborted: ${aborted}`);
	// Why the driver gave up and what the window showed. Without these, an abort that happens only on
	// another machine cannot be read.
	const output = driverOutput(error);
	if (output) {
		console.error(output.slice(-3000));
	}
	if (jsonOut) {
		try {
			pw('run-code', `async (page) => { await page.screenshot({ path: ${JSON.stringify(path.resolve(jsonOut).replace(/\.json$/, '') + '-abort.png')} }); }`);
		} catch {
			// the window is gone; there is nothing to photograph
		}
	}
} finally {
	try {
		pw('close');
	} catch {
		// never attached
	}
	for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
		for (const child of children) {
			if (!child.pid) {
				continue;
			}
			try {
				process.kill(-child.pid, signal);
			} catch {
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
	if (keep) {
		console.log(`\nkept ${runDir}`);
	} else {
		fs.rmSync(runDir, { recursive: true, force: true });
	}
}

const failed = checks.filter(entry => !entry.ok);
// The report is committed as evidence, so it names the app relative to the
// repository and never carries the home directory (the hygiene check rejects it).
const report = { mode, app: path.relative(repoRoot, app), ranAt: new Date().toISOString(), observed, checks, aborted, passed: !aborted && failed.length === 0 };
if (jsonOut) {
	fs.mkdirSync(path.dirname(jsonOut), { recursive: true });
	fs.writeFileSync(jsonOut, JSON.stringify(report, undefined, '\t').replaceAll(os.homedir(), '~'));
	console.log(`wrote ${jsonOut}`);
}
console.log(aborted
	? `\n${mode} mode: aborted after ${checks.length} check(s): ${aborted}`
	: mode === 'baseline'
		? `\nbaseline mode: ${failed.length ? `${failed.length} infrastructure check(s) failed` : 'infrastructure checks passed'}; this mode records tools and gaps and claims nothing about read or edit capability`
		: `\nrelease mode: ${failed.length ? `${failed.length} of ${checks.length} checks failed` : `all ${checks.length} checks passed`}`);
process.exit(report.passed ? 0 : 1);
