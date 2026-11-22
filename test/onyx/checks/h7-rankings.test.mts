/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * H-7's decision on campaigns whose answer is known: two repositories whose
 * best model differs by a wide margin in each (supported); the same model
 * ahead in both, which two repositories cannot refute (inconclusive); and a
 * repository in which no model solves anything, which has no ranking
 * (inconclusive).
 *
 *   node --test test/onyx/checks/h7-rankings.test.mts
 */

import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** A results directory in which each model solves the first so many of 40 tasks. */
function campaign(parent: string, name: string, solved: Record<string, number>): string {
	const directory = path.join(parent, name);
	fs.mkdirSync(directory, { recursive: true });
	const results = Object.entries(solved).flatMap(([model, count]) => Array.from({ length: 40 }, (_, task) => ({ unit: `${model}|t${task}`, model, task: `t${task}`, outcome: 'attempted', success: task < count, score: task < count ? 1 : 0 })));
	fs.writeFileSync(path.join(directory, 'results.jsonl'), results.map(result => JSON.stringify(result)).join('\n') + '\n');
	fs.writeFileSync(path.join(directory, 'tasks.json'), JSON.stringify({ name, tasks: [] }));
	return directory;
}

test('H-7 is supported only when the top model differs with a significant difference in each repository, and a repository nobody solves has no ranking', () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onyx-h7-'));
	try {
		const decide = (label: string, first: Record<string, number>, second: Record<string, number>) => {
			const a = campaign(path.join(dir, label), 'a', first);
			const b = campaign(path.join(dir, label), 'b', second);
			const run = spawnSync(process.execPath, [path.join(repoRoot, 'test', 'onyx', 'lab', 'analyze-rankings.mts'), a, b], { encoding: 'utf8' });
			const outcome: { outcome: string } = JSON.parse(fs.readFileSync(path.join(a, 'outcome-H-7.json'), 'utf8'));
			const rankings: { repositories: { ranking: string[] | null; topRanked: string[] | null }[]; comparisons: { kendallTau: number; topDiffers: boolean }[] } = JSON.parse(fs.readFileSync(path.join(a, 'rankings.json'), 'utf8'));
			return { exit: run.status, outcome: outcome.outcome, tops: rankings.repositories.map(repository => repository.topRanked), tau: rankings.comparisons.map(comparison => comparison.kendallTau), topDiffers: rankings.comparisons.map(comparison => comparison.topDiffers) };
		};
		assert.deepStrictEqual({
			swapped: decide('swapped', { big: 30, mid: 10, small: 2 }, { big: 4, mid: 12, small: 30 }),
			// The top differs, by one task in one repository: that is not a significant difference.
			nearlyTied: decide('nearly-tied', { big: 20, mid: 5, small: 19 }, { big: 5, mid: 4, small: 25 }),
			sameOrder: decide('same-order', { big: 30, mid: 10, small: 2 }, { big: 25, mid: 12, small: 3 }),
			nobodySolves: decide('nobody', { big: 30, mid: 10, small: 2 }, { big: 0, mid: 0, small: 0 }),
		}, {
			swapped: { exit: 0, outcome: 'supported', tops: [['big'], ['small']], tau: [-1], topDiffers: [true] },
			nearlyTied: { exit: 0, outcome: 'inconclusive', tops: [['big'], ['small']], tau: [1 / 3], topDiffers: [true] },
			sameOrder: { exit: 0, outcome: 'inconclusive', tops: [['big'], ['big']], tau: [1], topDiffers: [false] },
			nobodySolves: { exit: 0, outcome: 'inconclusive', tops: [['big'], null], tau: [], topDiffers: [] },
		});
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
