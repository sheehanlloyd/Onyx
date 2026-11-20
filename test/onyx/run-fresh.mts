/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Fresh-output protocol (Section 11, A7, R-35). Tests import compiled modules
 * from `out/`, and an existing `out/` proves nothing about freshness. This
 * runner records the source revision and a digest of the dirty source tree,
 * refreshes `out/` with `npm run transpile-client`, writes a build stamp to
 * `out/.onyx-fresh.json`, and only then runs the command it was given.
 *
 *   node test/onyx/run-fresh.mts [--json-out <file>] -- <command> [args...]
 *   node test/onyx/run-fresh.mts --stamp-only
 *
 * The module gate reads the stamp and refuses to run when it does not match
 * the current tree (`isFresh`). Harness scripts under test/onyx run from
 * source and need no build, so the digest covers `src/` only, which is what
 * the transpiler reads.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const stampPath = path.join(repoRoot, 'out', '.onyx-fresh.json');
/** What the transpiler reads; a change anywhere under it changes the digest. */
const DIGEST_SCOPE = ['src'];
const BUILD_COMMAND = ['npm', 'run', 'transpile-client'];

export interface IFreshStamp {
	readonly revision: string;
	readonly dirtyDigest: string;
	readonly dirtyEntries: number;
	readonly build: { readonly command: string; readonly startedAt: string; readonly completedAt: string; readonly durationMs: number; readonly exitCode: number };
	run?: { readonly command: string; readonly startedAt: string; readonly completedAt: string; readonly exitCode: number };
}

function git(args: string[]): string {
	return execFileSync('git', ['-C', repoRoot, '--no-optional-locks', ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

/** The current source state: HEAD plus a content digest of every modified or untracked file in scope. */
export function sourceState(): { revision: string; dirtyDigest: string; dirtyEntries: number } {
	const revision = git(['rev-parse', 'HEAD']).trim();
	const entries = git(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', ...DIGEST_SCOPE])
		.split('\0')
		.filter(entry => entry.length > 0)
		.sort();
	const hash = createHash('sha256');
	hash.update(revision);
	for (const entry of entries) {
		const status = entry.slice(0, 2);
		const file = entry.slice(3);
		hash.update(`\n${status} ${file}\n`);
		const full = path.join(repoRoot, file);
		if (fs.existsSync(full) && fs.statSync(full).isFile()) {
			hash.update(fs.readFileSync(full));
		}
	}
	return { revision, dirtyDigest: hash.digest('hex'), dirtyEntries: entries.length };
}

export function readStamp(): IFreshStamp | undefined {
	try {
		return JSON.parse(fs.readFileSync(stampPath, 'utf8')) as IFreshStamp;
	} catch {
		return undefined;
	}
}

/** Whether `out/` was refreshed from exactly the current source state. */
export function isFresh(): { fresh: boolean; reason: string; stamp?: IFreshStamp } {
	const stamp = readStamp();
	if (!stamp) {
		return { fresh: false, reason: `no build stamp at ${path.relative(repoRoot, stampPath)}; run node test/onyx/run-fresh.mts --stamp-only` };
	}
	if (stamp.build.exitCode !== 0) {
		return { fresh: false, reason: `the last recorded build exited ${stamp.build.exitCode}`, stamp };
	}
	const current = sourceState();
	if (current.revision !== stamp.revision) {
		return { fresh: false, reason: `out/ was built at ${stamp.revision.slice(0, 11)}, HEAD is ${current.revision.slice(0, 11)}`, stamp };
	}
	if (current.dirtyDigest !== stamp.dirtyDigest) {
		return { fresh: false, reason: `the source tree changed since out/ was built (${current.dirtyEntries} dirty entries now, ${stamp.dirtyEntries} then)`, stamp };
	}
	return { fresh: true, reason: `out/ built at ${stamp.build.completedAt} from ${stamp.revision.slice(0, 11)}${stamp.dirtyEntries ? ` with ${stamp.dirtyEntries} dirty entries` : ''}`, stamp };
}

/** Refreshes `out/` and writes the stamp. Returns the stamp; the build's exit code is inside it. */
export function refresh(): IFreshStamp {
	const state = sourceState();
	const startedAt = new Date();
	const build = spawnSync(BUILD_COMMAND[0], BUILD_COMMAND.slice(1), { cwd: repoRoot, stdio: 'inherit', env: process.env });
	const completedAt = new Date();
	const stamp: IFreshStamp = {
		...state,
		build: { command: BUILD_COMMAND.join(' '), startedAt: startedAt.toISOString(), completedAt: completedAt.toISOString(), durationMs: completedAt.getTime() - startedAt.getTime(), exitCode: build.status ?? 1 },
	};
	fs.mkdirSync(path.dirname(stampPath), { recursive: true });
	fs.writeFileSync(stampPath, JSON.stringify(stamp, undefined, '\t'));
	return stamp;
}

function writeStamp(stamp: IFreshStamp): void {
	fs.writeFileSync(stampPath, JSON.stringify(stamp, undefined, '\t'));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const separator = process.argv.indexOf('--');
	const command = separator === -1 ? [] : process.argv.slice(separator + 1);
	const jsonOutIndex = process.argv.indexOf('--json-out');
	const jsonOut = jsonOutIndex === -1 ? undefined : process.argv[jsonOutIndex + 1];
	const stampOnly = process.argv.includes('--stamp-only');
	if (!stampOnly && command.length === 0) {
		console.error('usage: node test/onyx/run-fresh.mts [--json-out <file>] -- <command> [args...] | --stamp-only');
		process.exit(2);
	}
	const stamp = refresh();
	console.log(`fresh: ${stamp.revision.slice(0, 11)}${stamp.dirtyEntries ? ` +${stamp.dirtyEntries} dirty` : ''} · ${stamp.build.command} exit ${stamp.build.exitCode} in ${stamp.build.durationMs} ms at ${stamp.build.completedAt}`);
	if (stamp.build.exitCode !== 0) {
		console.error('fresh: the build failed; not running the command');
		if (jsonOut) {
			fs.writeFileSync(jsonOut, JSON.stringify(stamp, undefined, '\t'));
		}
		process.exit(stamp.build.exitCode);
	}
	if (!stampOnly) {
		const startedAt = new Date();
		const run = spawnSync(command[0], command.slice(1), { cwd: repoRoot, stdio: 'inherit', env: process.env });
		const completedAt = new Date();
		stamp.run = { command: command.join(' '), startedAt: startedAt.toISOString(), completedAt: completedAt.toISOString(), exitCode: run.status ?? 1 };
		writeStamp(stamp);
		console.log(`fresh: "${stamp.run.command}" exit ${stamp.run.exitCode}`);
	}
	if (jsonOut) {
		fs.mkdirSync(path.dirname(jsonOut), { recursive: true });
		fs.writeFileSync(jsonOut, JSON.stringify(stamp, undefined, '\t'));
	}
	process.exit(stamp.run?.exitCode ?? 0);
}
