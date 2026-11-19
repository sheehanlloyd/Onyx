/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * A1 / DEC-06: inventory an owner's checkout without touching its index.
 *
 *   node test/onyx/run-inventory.mts [--repo <path>] [--json-out <file>]
 *
 * Records the starting revision, whether the real index exists and its hash,
 * the real-index status (`git --no-optional-locks status --porcelain=v1`, which
 * keeps the staged/unstaged distinction), and then a combined HEAD-to-worktree
 * inventory taken through a temporary index: `read-tree HEAD`, `add -A`, and
 * `diff --cached` against HEAD. The temporary `git add` may create blob
 * objects; it never writes to the real index. The run fails if the real
 * index's presence or hash changed while it ran.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

interface IInventory {
	readonly repository: string;
	readonly revision: string;
	readonly realIndex: { readonly present: boolean; readonly sha256?: string };
	/** `git --no-optional-locks status --porcelain=v1`: staged vs unstaged preserved. */
	readonly realIndexStatus: string[];
	/** `git diff --cached --name-status HEAD` through the temporary index. */
	readonly headToWorktree: { readonly status: string; readonly path: string }[];
	readonly headToWorktreeStat: string;
	readonly realIndexAfter: { readonly present: boolean; readonly sha256?: string };
	readonly indexUnchanged: boolean;
}

function argValue(flag: string): string | undefined {
	const index = process.argv.indexOf(flag);
	return index === -1 ? undefined : process.argv[index + 1];
}

function git(repo: string, args: string[], env?: NodeJS.ProcessEnv): string {
	return execFileSync('git', ['-C', repo, '--no-optional-locks', ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, env: { ...process.env, ...env } });
}

function indexState(repo: string): { present: boolean; sha256?: string } {
	const gitDir = path.resolve(repo, git(repo, ['rev-parse', '--git-dir']).trim());
	const indexPath = path.join(gitDir, 'index');
	if (!fs.existsSync(indexPath)) {
		return { present: false };
	}
	return { present: true, sha256: createHash('sha256').update(fs.readFileSync(indexPath)).digest('hex') };
}

export function inventory(repo: string): IInventory {
	const revision = git(repo, ['rev-parse', 'HEAD']).trim();
	const realIndex = indexState(repo);
	const realIndexStatus = git(repo, ['status', '--porcelain=v1']).split('\n').filter(line => line.length > 0);

	const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onyx-index-audit.'));
	let headToWorktree: { status: string; path: string }[];
	let headToWorktreeStat: string;
	try {
		const env = { GIT_INDEX_FILE: path.join(temporaryDir, 'index') };
		git(repo, ['read-tree', 'HEAD'], env);
		git(repo, ['add', '-A', '--', '.'], env);
		headToWorktree = git(repo, ['diff', '--cached', '--name-status', 'HEAD'], env)
			.split('\n')
			.filter(line => line.length > 0)
			.map(line => {
				const match = /^(?<status>\S+)\t(?<path>.+)$/.exec(line);
				return { status: match?.groups?.status ?? line, path: match?.groups?.path ?? '' };
			});
		headToWorktreeStat = git(repo, ['diff', '--cached', '--stat', 'HEAD'], env).trimEnd();
	} finally {
		fs.rmSync(temporaryDir, { recursive: true, force: true });
	}

	const realIndexAfter = indexState(repo);
	const indexUnchanged = realIndexAfter.present === realIndex.present && realIndexAfter.sha256 === realIndex.sha256;
	return { repository: path.resolve(repo), revision, realIndex, realIndexStatus, headToWorktree, headToWorktreeStat, realIndexAfter, indexUnchanged };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
	const repo = path.resolve(argValue('--repo') ?? process.cwd());
	const result = inventory(repo);
	const jsonOut = argValue('--json-out');
	if (jsonOut) {
		fs.mkdirSync(path.dirname(jsonOut), { recursive: true });
		fs.writeFileSync(jsonOut, JSON.stringify(result, undefined, '\t'));
	}
	console.log(`repository: ${result.repository}`);
	console.log(`revision: ${result.revision}`);
	console.log(`real index: ${result.realIndex.present ? `present, sha256 ${result.realIndex.sha256}` : 'missing'}`);
	console.log(`real-index status entries: ${result.realIndexStatus.length}`);
	const counts = new Map<string, number>();
	for (const entry of result.headToWorktree) {
		counts.set(entry.status, (counts.get(entry.status) ?? 0) + 1);
	}
	console.log(`HEAD-to-worktree differences: ${result.headToWorktree.length}${counts.size ? ` (${[...counts].map(([status, count]) => `${status}: ${count}`).join(', ')})` : ''}`);
	for (const entry of result.headToWorktree) {
		console.log(`  ${entry.status}\t${entry.path}`);
	}
	console.log(`real index after: ${result.realIndexAfter.present ? `present, sha256 ${result.realIndexAfter.sha256}` : 'missing'} (${result.indexUnchanged ? 'unchanged' : 'CHANGED'})`);
	if (!result.indexUnchanged) {
		process.exitCode = 1;
	}
}
