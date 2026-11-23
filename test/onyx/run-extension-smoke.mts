/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Named extension set from Open VSX, in the packaged app (D1, R-32).
 *
 *   node test/onyx/run-extension-smoke.mts --app <path/to/Onyx.app> [--json-out <file>] [--screenshot <file>] [--keep]
 *
 * Installs each extension of the supported set (Section 2 of the release
 * definition: Python, ESLint, Prettier, GitLens) through the packaged app's
 * own command line into a throwaway profile, opens a small workspace with a
 * Python and a JavaScript file, and reads the extension host's log for each
 * extension's activation. It passes when every one installed and activated.
 *
 * This is the one Onyx check that needs the internet: the gallery is
 * open-vsx.org. It records the versions it was given, which are whatever the
 * gallery serves on the day; nothing is pinned.
 */

import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function argValue(flag: string): string | undefined {
	const index = process.argv.indexOf(flag);
	return index === -1 ? undefined : process.argv[index + 1];
}

const appPath = argValue('--app') ?? process.env.ONYX_PACKAGED_APP;
const jsonOut = argValue('--json-out');
const screenshot = argValue('--screenshot');
const keep = process.argv.includes('--keep');
if (!appPath || !fs.existsSync(appPath)) {
	console.error('usage: node test/onyx/run-extension-smoke.mts --app <path/to/Onyx.app> [--json-out <file>] [--screenshot <file>] [--keep]');
	process.exit(2);
}

/** The supported set. The identifier is the one Open VSX publishes it under. */
const EXTENSIONS: readonly { readonly id: string; readonly what: string }[] = [
	{ id: 'ms-python.python', what: 'Python' },
	{ id: 'dbaeumer.vscode-eslint', what: 'ESLint' },
	{ id: 'esbenp.prettier-vscode', what: 'Prettier' },
	{ id: 'eamodio.gitlens', what: 'GitLens' },
];

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const app = path.resolve(appPath);
const cdpPort = Number(process.env.ONYX_CDP_PORT ?? 9335);
const session = `ext-${process.pid}`;
const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onyx-ext-'));
const workspace = path.join(runDir, 'ws');
const userDataDir = path.join(runDir, 'user-data');
const extensionsDir = path.join(runDir, 'extensions');
const children: ReturnType<typeof spawn>[] = [];

interface IExtensionResult {
	readonly id: string;
	readonly what: string;
	installed: boolean;
	version: string | undefined;
	activated: boolean;
	detail: string | undefined;
}

function sleep(ms: number) {
	return new Promise(resolve => setTimeout(resolve, ms));
}

function appFile(...segments: string[]): string {
	return path.join(app, 'Contents', ...segments);
}

function cli(...args: string[]): string {
	return execFileSync(appFile('Resources', 'app', 'bin', 'code'), [`--user-data-dir=${userDataDir}`, `--extensions-dir=${extensionsDir}`, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5 * 60_000 });
}

function seedWorkspace() {
	fs.mkdirSync(workspace, { recursive: true });
	fs.writeFileSync(path.join(workspace, 'app.py'), 'def add(a, b):\n    return a + b\n\n\nprint(add(1, 2))\n');
	fs.writeFileSync(path.join(workspace, 'index.js'), 'export function add(a, b) {\n\treturn a + b;\n}\n');
	fs.writeFileSync(path.join(workspace, 'eslint.config.js'), 'export default [{ rules: { semi: "error" } }];\n');
	fs.writeFileSync(path.join(workspace, 'package.json'), JSON.stringify({ name: 'extension-smoke', private: true, type: 'module' }, undefined, '\t'));
	const git = (...args: string[]) => execFileSync('git', ['-C', workspace, '-c', 'user.name=Extension Smoke', '-c', 'user.email=smoke@example.invalid', ...args], { stdio: 'ignore' });
	git('init', '-q');
	git('add', '-A');
	git('commit', '-q', '-m', 'seed');
}

/** Every extension host log of the run, concatenated. */
function extensionHostLog(): string {
	const logs = path.join(userDataDir, 'logs');
	const found: string[] = [];
	const walk = (directory: string) => {
		for (const entry of fs.existsSync(directory) ? fs.readdirSync(directory, { withFileTypes: true }) : []) {
			const full = path.join(directory, entry.name);
			if (entry.isDirectory()) {
				walk(full);
			} else if (entry.name === 'exthost.log') {
				found.push(fs.readFileSync(full, 'utf8'));
			}
		}
	};
	walk(logs);
	return found.join('\n');
}

function activationLine(log: string, id: string): string | undefined {
	return log.split('\n').find(line => line.toLowerCase().includes(`_doactivateextension ${id.toLowerCase()},`));
}

function activationFailure(log: string, id: string): string | undefined {
	return log.split('\n').find(line => /activating extension .* failed|Activating extension .* failed/i.test(line) && line.toLowerCase().includes(id.toLowerCase()));
}

async function main(): Promise<number> {
	const product = JSON.parse(fs.readFileSync(appFile('Resources', 'app', 'product.json'), 'utf8')) as { nameShort?: string; commit?: string; extensionsGallery?: { serviceUrl?: string } };
	console.log(`extension smoke · ${product.nameShort} ${product.commit?.slice(0, 11)} · gallery ${product.extensionsGallery?.serviceUrl ?? 'NONE'}`);
	const results: IExtensionResult[] = EXTENSIONS.map(extension => ({ ...extension, installed: false, version: undefined, activated: false, detail: undefined }));
	seedWorkspace();

	for (const result of results) {
		try {
			const output = cli('--install-extension', result.id);
			result.installed = /was successfully installed|is already installed/.test(output);
			result.detail = result.installed ? undefined : output.trim().split('\n').slice(-2).join(' ');
		} catch (error) {
			const failure = error as { stdout?: string; stderr?: string; message: string };
			result.detail = `${failure.stdout ?? ''}${failure.stderr ?? ''}`.trim().split('\n').slice(-2).join(' ') || failure.message;
		}
	}
	const listed = new Map(cli('--list-extensions', '--show-versions').trim().split('\n').map(line => line.trim().toLowerCase().split('@') as [string, string]));
	for (const result of results) {
		result.version = listed.get(result.id.toLowerCase());
		result.installed = result.installed && result.version !== undefined;
	}

	if (await fetch(`http://127.0.0.1:${cdpPort}/json/version`).then(() => true, () => false)) {
		throw new Error(`something is already debugging on :${cdpPort}; close it, or set ONYX_CDP_PORT`);
	}
	const executable = appFile('MacOS', fs.readdirSync(appFile('MacOS'))[0]);
	children.push(spawn(executable, [
		`--user-data-dir=${userDataDir}`,
		`--extensions-dir=${extensionsDir}`,
		`--remote-debugging-port=${cdpPort}`,
		'--use-mock-keychain',
		'--disable-workspace-trust',
		'--skip-release-notes',
		'--disable-updates',
		workspace,
		path.join(workspace, 'index.js'),
		path.join(workspace, 'app.py'),
	], { cwd: runDir, stdio: 'ignore', detached: true }));

	const deadline = Date.now() + 180_000;
	let log = '';
	while (Date.now() < deadline) {
		await sleep(3000);
		log = extensionHostLog();
		if (results.every(result => !result.installed || activationLine(log, result.id))) {
			break;
		}
	}
	// A failed activation is logged after the attempt is: give the slowest one time to finish or fail.
	await sleep(10_000);
	log = extensionHostLog();
	for (const result of results) {
		const failure = activationFailure(log, result.id);
		result.activated = !!activationLine(log, result.id) && !failure;
		result.detail = result.detail ?? failure ?? (result.activated ? activationLine(log, result.id)?.replace(/^.*_doActivateExtension /, '') : 'no activation in the extension host log');
	}

	if (screenshot) {
		try {
			const playwrightCli = createRequire(import.meta.url).resolve('@playwright/cli/playwright-cli.js');
			const pw = (...args: string[]) => execFileSync(process.execPath, [playwrightCli, `-s=${session}`, ...args], { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
			pw('attach', `--cdp=http://127.0.0.1:${cdpPort}`);
			// The first-run dialog is modal and covers the window; step through it, then show the Extensions view.
			pw('run-code', 'async (page) => { for (let step = 0; step < 6 && await page.locator(".onboarding-a-overlay.visible").count(); step++) { await page.locator("button.onboarding-a-btn-primary").click().catch(() => undefined); await page.waitForTimeout(1200); } await page.keyboard.press("Meta+Shift+X"); await page.waitForTimeout(4000); }');
			pw('screenshot', `--filename=${path.resolve(screenshot)}`);
			pw('close');
		} catch (error) {
			console.log(`  note: no screenshot (${(error as Error).message.split('\n')[0]})`);
		}
	}

	for (const result of results) {
		const ok = result.installed && result.activated;
		console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${result.what.padEnd(9)} ${result.id}@${result.version ?? 'not installed'} — ${result.installed ? 'installed' : 'NOT installed'}, ${result.activated ? 'activated' : 'NOT activated'}${ok ? '' : ` (${result.detail})`}`);
	}
	const passed = results.every(result => result.installed && result.activated);
	if (jsonOut) {
		fs.writeFileSync(path.resolve(jsonOut), JSON.stringify({
			ranAt: new Date().toISOString(),
			product: { nameShort: product.nameShort, commit: product.commit },
			gallery: product.extensionsGallery?.serviceUrl,
			alsoInstalled: [...listed].filter(([id]) => !EXTENSIONS.some(extension => extension.id.toLowerCase() === id)).map(([id, version]) => `${id}@${version}`),
			results,
			passed,
		}, undefined, '\t'));
	}
	console.log(passed ? `extension smoke: all ${results.length} installed and activated` : 'extension smoke: FAILED');
	return passed ? 0 : 1;
}

/** SIGTERM, then SIGKILL: the application does not always leave on the first, and one left behind keeps the debugging port. */
async function cleanup() {
	for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
		for (const child of children) {
			if (!child.pid) {
				continue;
			}
			try {
				process.kill(-child.pid, signal);
			} catch {
				// already gone
			}
		}
		if (signal === 'SIGTERM') {
			await sleep(2000);
		}
	}
	if (!keep) {
		fs.rmSync(runDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
	} else {
		console.log(`kept: ${runDir}`);
	}
}

main().then(async code => {
	await cleanup();
	process.exit(code);
}, async error => {
	console.error(error);
	await cleanup();
	process.exit(1);
});
