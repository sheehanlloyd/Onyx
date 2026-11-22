/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Writes what a committed task set is, beside it (L10): `summary.json`, the
 * counts by source and by held-out status and how the set was selected, and
 * `trace-digests.json`, each task's commit, file and content hashes. It
 * also checks the set against the repository: every commit is there and
 * every hash is the hash of the file at that commit.
 *
 *   node test/onyx/lab/describe-task-set.mts docs/research/results/<date>-task-set [--repo <path>]
 */

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const directory = process.argv[2];
if (!directory) {
	console.error('usage: node test/onyx/lab/describe-task-set.mts <results directory> [--repo <path>]');
	process.exit(2);
}
const repoFlag = process.argv.indexOf('--repo');
const repo = path.resolve(repoFlag === -1 ? repoRoot : process.argv[repoFlag + 1]);
const digest = (text: string) => crypto.createHash('sha256').update(text).digest('hex');
const show = (revision: string, file: string): string | undefined => {
	try {
		return execFileSync('git', ['-C', repo, 'show', `${revision}:${file}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
	} catch {
		return undefined;
	}
};

interface ITask { readonly id: string; readonly commit: string; readonly file: string; readonly source: string; readonly holdout: string; readonly authoredAt: string; readonly beforeHash: string; readonly afterHash: string; readonly kind: string; readonly testFile?: string }
const set: { name: string; hash: string; head: string; holdout: object; counts: object; selection: object; tasks: ITask[] } = JSON.parse(fs.readFileSync(path.join(directory, 'tasks.json'), 'utf8'));

const mismatches: string[] = [];
for (const task of set.tasks) {
	const before = show(`${task.commit}~1`, task.file);
	const after = show(task.commit, task.file);
	if (before === undefined || after === undefined || digest(before) !== task.beforeHash || digest(after) !== task.afterHash) {
		mismatches.push(task.id);
	}
}
const count = (key: (task: ITask) => string): Record<string, number> => {
	const counts: Record<string, number> = {};
	for (const task of set.tasks) {
		counts[key(task)] = (counts[key(task)] ?? 0) + 1;
	}
	return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
};
const authored = set.tasks.map(task => task.authoredAt).sort();
fs.writeFileSync(path.join(directory, 'summary.json'), JSON.stringify({
	taskSet: set.name, hash: set.hash, readBackFrom: set.head, tasks: set.tasks.length,
	counts: set.counts, holdout: set.holdout, selection: set.selection,
	byYear: count(task => task.authoredAt.slice(0, 4)), byKind: count(task => task.kind), byFileType: count(task => path.extname(task.file) || '(none)'),
	authoredFrom: authored[0], authoredTo: authored.at(-1),
	fromYourOwnRequests: { tasks: 0, reason: 'source 2 needs a workspace\'s opt-in and its run journal with accepted proposals; this set was built without one, from history alone' },
	executionChecked: { tasksWhoseCommitAlsoChangedOneTestFile: set.tasks.filter(task => task.testFile !== undefined).length },
	checkedAgainstTheRepository: { tasksWhoseHashesMatch: set.tasks.length - mismatches.length, mismatches },
}, undefined, '\t') + '\n');
fs.writeFileSync(path.join(directory, 'trace-digests.json'), JSON.stringify(Object.fromEntries(set.tasks.map(task => [task.id, { commit: task.commit, file: task.file, beforeHash: task.beforeHash, afterHash: task.afterHash }])), undefined, '\t') + '\n');
console.log(`${set.tasks.length} tasks, ${mismatches.length} that do not match the repository; wrote summary.json and trace-digests.json`);
process.exit(mismatches.length === 0 ? 0 : 1);
