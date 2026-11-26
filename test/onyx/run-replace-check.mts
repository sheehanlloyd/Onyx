/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Manual update, rollback and uninstall, as docs/UPDATING.md describes them (D3).
 *
 *   node test/onyx/run-replace-check.mts --app <path/to/Onyx.app> [--replacement <path/to/other/Onyx.app>] [--json-out <file>]
 *
 * 1. Installs a copy of the application into a throwaway "Applications" folder
 *    and runs the packaged smoke in release mode on it, which leaves settings
 *    and a run journal in a throwaway data folder.
 * 2. Update: deletes the application bundle, puts the replacement in its place
 *    (the same build when none is given), starts it on the same data, and
 *    compares the settings file and every journal file with what was there.
 * 3. Rollback: the same, back to the first application.
 * 4. Uninstall: deletes the application and checks that the data is still
 *    there; then removes the data as the documented commands do and checks
 *    that the workspace's own files are untouched.
 *
 * What it does not show: anything about `~/Library/Application Support`. It
 * uses its own data folder so that it can never touch a real profile. That an
 * application bundle holds no user data is what makes the two equivalent.
 */

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function argValue(flag: string): string | undefined {
	const index = process.argv.indexOf(flag);
	return index === -1 ? undefined : process.argv[index + 1];
}

const appArg = argValue('--app') ?? process.env.ONYX_PACKAGED_APP;
const replacementArg = argValue('--replacement') ?? appArg;
const jsonOut = argValue('--json-out');
if (!appArg || !replacementArg || !fs.existsSync(appArg) || !fs.existsSync(replacementArg)) {
	console.error('usage: node test/onyx/run-replace-check.mts --app <path/to/Onyx.app> [--replacement <path/to/other/Onyx.app>] [--json-out <file>]');
	process.exit(2);
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const original = path.resolve(appArg);
const replacement = path.resolve(replacementArg);
const cdpPort = Number(process.env.ONYX_CDP_PORT ?? 9333);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onyx-replace-'));
const installed = path.join(root, 'Applications', path.basename(original));

interface ICheck { readonly name: string; readonly ok: boolean; readonly detail?: string }
const checks: ICheck[] = [];

function check(name: string, ok: boolean, detail?: string) {
	checks.push({ name, ok, detail });
	console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail && !ok ? ` — ${detail}` : ''}`);
}

function sleep(ms: number) {
	return new Promise(resolve => setTimeout(resolve, ms));
}

function install(source: string) {
	fs.rmSync(installed, { recursive: true, force: true });
	fs.mkdirSync(path.dirname(installed), { recursive: true });
	execFileSync('ditto', [source, installed]);
}

function commitOf(app: string): string {
	return (JSON.parse(fs.readFileSync(path.join(app, 'Contents', 'Resources', 'app', 'product.json'), 'utf8')) as { commit?: string }).commit ?? 'unknown';
}

/** Path → SHA-256 for the settings file and every journal file under a data folder. */
function snapshot(userDataDir: string): Map<string, string> {
	const files = new Map<string, string>();
	const add = (file: string) => files.set(path.relative(userDataDir, file), crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'));
	const settings = path.join(userDataDir, 'User', 'settings.json');
	if (fs.existsSync(settings)) {
		add(settings);
	}
	const walk = (directory: string) => {
		for (const entry of fs.existsSync(directory) ? fs.readdirSync(directory, { withFileTypes: true }) : []) {
			const full = path.join(directory, entry.name);
			if (entry.isDirectory()) {
				walk(full);
			} else {
				add(full);
			}
		}
	};
	const storage = path.join(userDataDir, 'User', 'workspaceStorage');
	for (const workspaceId of fs.existsSync(storage) ? fs.readdirSync(storage) : []) {
		walk(path.join(storage, workspaceId, 'onyx', 'journal'));
	}
	return files;
}

function differences(before: Map<string, string>, after: Map<string, string>): string[] {
	const changed: string[] = [];
	for (const [file, digest] of before) {
		if (!after.has(file)) {
			changed.push(`${file}: gone`);
		} else if (after.get(file) !== digest) {
			changed.push(`${file}: changed`);
		}
	}
	return changed;
}

/** Starts the installed application on the kept data, waits for a workbench window, and quits it. */
async function launchAndQuit(runDir: string): Promise<boolean> {
	const executable = path.join(installed, 'Contents', 'MacOS', fs.readdirSync(path.join(installed, 'Contents', 'MacOS'))[0]);
	const child = spawn(executable, [
		`--user-data-dir=${path.join(runDir, 'user-data')}`,
		`--extensions-dir=${path.join(runDir, 'extensions')}`,
		`--remote-debugging-port=${cdpPort}`,
		'--use-mock-keychain',
		'--disable-workspace-trust',
		'--skip-release-notes',
		'--disable-updates',
		path.join(runDir, 'ws'),
	], { cwd: runDir, stdio: 'ignore', detached: true });
	let opened = false;
	const deadline = Date.now() + 120_000;
	while (Date.now() < deadline && !opened) {
		await sleep(1500);
		try {
			const pages = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json() as { type: string; url: string }[];
			opened = pages.some(page => page.type === 'page' && page.url.includes('workbench'));
		} catch {
			// not listening yet
		}
	}
	// Long enough for the workbench to read its storage and for anything that rewrites a file at startup to do so.
	await sleep(8000);
	for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
		try {
			process.kill(-child.pid!, signal);
		} catch {
			// already gone
		}
		await sleep(2500);
	}
	return opened;
}

async function main(): Promise<number> {
	console.log(`replace check · ${path.basename(original)} ${commitOf(original).slice(0, 11)} → ${commitOf(replacement).slice(0, 11)}${original === replacement ? ' (a second copy of the same build)' : ''}`);

	install(original);
	const smoke = spawnSync(process.execPath, [path.join(repoRoot, 'test', 'onyx', 'run-packaged-smoke.mts'), '--app', installed, '--mode', 'release', '--keep'], { cwd: repoRoot, encoding: 'utf8', env: process.env, timeout: 20 * 60_000, maxBuffer: 64 * 1024 * 1024 });
	const runDir = /^kept (?<directory>.+)$/m.exec(smoke.stdout ?? '')?.groups?.directory.trim();
	check('an agent run in the installed application left settings and a journal', smoke.status === 0 && !!runDir, `${smoke.stdout ?? ''}${smoke.stderr ?? ''}`.trim().split('\n').slice(-3).join(' ⏎ '));
	if (smoke.status !== 0 || !runDir) {
		return 1;
	}
	const userDataDir = path.join(runDir, 'user-data');
	const before = snapshot(userDataDir);
	const journalRuns = [...before.keys()].filter(file => /onyx\/journal\/runs\/.+\.jsonl$/.test(file));
	check('the data to preserve exists: a settings file and at least one run journal', before.has(path.join('User', 'settings.json')) && journalRuns.length > 0, `${before.size} files, ${journalRuns.length} run journals`);

	install(replacement);
	const updated = await launchAndQuit(runDir);
	check('update: the replacement application opens a window on the existing data', updated);
	const afterUpdate = differences(before, snapshot(userDataDir));
	check('update: the settings file and every journal file are byte for byte what they were', afterUpdate.length === 0, afterUpdate.join('; '));

	install(original);
	const rolledBack = await launchAndQuit(runDir);
	check('rollback: the earlier application opens a window on the same data', rolledBack);
	const afterRollback = differences(before, snapshot(userDataDir));
	check('rollback: the settings file and every journal file are byte for byte what they were', afterRollback.length === 0, afterRollback.join('; '));

	// Uninstall, step one: the application goes to the Trash. Nothing else may go with it.
	fs.rmSync(installed, { recursive: true, force: true });
	const afterRemoval = differences(before, snapshot(userDataDir));
	check('uninstall: deleting the application leaves settings and journals where they were', !fs.existsSync(installed) && afterRemoval.length === 0, afterRemoval.join('; '));

	// Step two, the user's choice: the documented removal of the data folder and the extensions folder.
	const workspaceFiles = fs.readdirSync(path.join(runDir, 'ws')).sort();
	fs.rmSync(userDataDir, { recursive: true, force: true });
	fs.rmSync(path.join(runDir, 'extensions'), { recursive: true, force: true });
	check('uninstall: removing the data folders removes the data and leaves the workspace alone',
		!fs.existsSync(userDataDir) && JSON.stringify(fs.readdirSync(path.join(runDir, 'ws')).sort()) === JSON.stringify(workspaceFiles));

	fs.rmSync(runDir, { recursive: true, force: true });
	const failed = checks.filter(entry => !entry.ok);
	if (jsonOut) {
		fs.mkdirSync(path.dirname(path.resolve(jsonOut)), { recursive: true });
		fs.writeFileSync(path.resolve(jsonOut), JSON.stringify({ ranAt: new Date().toISOString(), original: commitOf(original), replacement: commitOf(replacement), sameBuild: original === replacement, preservedFiles: before.size, runJournals: journalRuns.length, checks, passed: failed.length === 0 }, undefined, '\t'));
	}
	console.log(failed.length ? `replace check: ${failed.length} of ${checks.length} checks FAILED` : `replace check: all ${checks.length} checks passed`);
	return failed.length ? 1 : 0;
}

main().then(code => {
	fs.rmSync(root, { recursive: true, force: true });
	process.exit(code);
}, error => {
	console.error(error);
	fs.rmSync(root, { recursive: true, force: true });
	process.exit(1);
});
