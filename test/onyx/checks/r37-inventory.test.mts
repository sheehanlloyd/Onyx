/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * R-37 (A1, DEC-06): the inventory in disposable repositories with staged,
 * unstaged, untracked and deleted files, and separately with a missing real
 * index. Every intended difference is inventoried; the real index's presence
 * and hash and the user's file contents are unchanged.
 *
 *   node --test test/onyx/checks/r37-inventory.test.mts
 */

import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const inventoryScript = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'run-inventory.mts');

function git(repo: string, ...args: string[]): string {
	return execFileSync('git', ['-C', repo, '-c', 'user.email=r37@localhost', '-c', 'user.name=r37', ...args], { encoding: 'utf8' });
}

/** A repository with one commit, then one staged, one unstaged, one untracked and one deleted path. */
function disposableRepository(): string {
	const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'onyx-r37-'));
	git(repo, 'init', '-q', '-b', 'main');
	fs.writeFileSync(path.join(repo, 'staged.txt'), 'staged original\n');
	fs.writeFileSync(path.join(repo, 'unstaged.txt'), 'unstaged original\n');
	fs.writeFileSync(path.join(repo, 'deleted.txt'), 'deleted original\n');
	fs.writeFileSync(path.join(repo, 'kept.txt'), 'kept\n');
	git(repo, 'add', '-A');
	git(repo, 'commit', '-q', '-m', 'base');
	fs.writeFileSync(path.join(repo, 'staged.txt'), 'staged edited\n');
	git(repo, 'add', 'staged.txt');
	fs.writeFileSync(path.join(repo, 'unstaged.txt'), 'unstaged edited\n');
	fs.writeFileSync(path.join(repo, 'untracked.txt'), 'new file\n');
	fs.rmSync(path.join(repo, 'deleted.txt'));
	return repo;
}

function snapshot(repo: string): Record<string, string> {
	const files: Record<string, string> = {};
	for (const name of fs.readdirSync(repo)) {
		if (name !== '.git') {
			files[name] = createHash('sha256').update(fs.readFileSync(path.join(repo, name))).digest('hex');
		}
	}
	const indexPath = path.join(repo, '.git', 'index');
	files['.git/index'] = fs.existsSync(indexPath) ? createHash('sha256').update(fs.readFileSync(indexPath)).digest('hex') : 'missing';
	return files;
}

function runInventory(repo: string) {
	const jsonOut = path.join(repo, '..', `${path.basename(repo)}-inventory.json`);
	const stdout = execFileSync(process.execPath, [inventoryScript, '--repo', repo, '--json-out', jsonOut], { encoding: 'utf8' });
	const result = JSON.parse(fs.readFileSync(jsonOut, 'utf8'));
	fs.rmSync(jsonOut, { force: true });
	return { stdout, result };
}

const expectedDifferences = [
	{ status: 'D', path: 'deleted.txt' },
	{ status: 'M', path: 'staged.txt' },
	{ status: 'M', path: 'unstaged.txt' },
	{ status: 'A', path: 'untracked.txt' },
];

test('R-37: staged, unstaged, untracked and deleted paths are inventoried and the real index is untouched', () => {
	const repo = disposableRepository();
	try {
		const before = snapshot(repo);
		const { result } = runInventory(repo);
		assert.deepStrictEqual({
			differences: result.headToWorktree,
			realIndexStatus: result.realIndexStatus.sort(),
			indexPresent: result.realIndex.present,
			indexUnchanged: result.indexUnchanged,
			filesAfter: snapshot(repo),
		}, {
			differences: expectedDifferences,
			// The real-index view keeps the staged/unstaged distinction the temporary index cannot.
			realIndexStatus: [' D deleted.txt', ' M unstaged.txt', '?? untracked.txt', 'M  staged.txt'],
			indexPresent: true,
			indexUnchanged: true,
			filesAfter: before,
		});
	} finally {
		fs.rmSync(repo, { recursive: true, force: true });
	}
});

test('R-37: a repository whose real index is missing is inventoried and the index stays missing', () => {
	const repo = disposableRepository();
	try {
		fs.rmSync(path.join(repo, '.git', 'index'));
		const before = snapshot(repo);
		const { result } = runInventory(repo);
		assert.deepStrictEqual({
			differences: result.headToWorktree,
			indexPresent: result.realIndex.present,
			indexAfter: result.realIndexAfter.present,
			indexUnchanged: result.indexUnchanged,
			filesAfter: snapshot(repo),
		}, {
			differences: expectedDifferences,
			indexPresent: false,
			indexAfter: false,
			indexUnchanged: true,
			filesAfter: before,
		});
		assert.equal(before['.git/index'], 'missing');
	} finally {
		fs.rmSync(repo, { recursive: true, force: true });
	}
});
