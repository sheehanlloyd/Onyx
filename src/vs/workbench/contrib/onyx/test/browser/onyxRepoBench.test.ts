/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	aggregateBenchResults, benchRoutingDataForCurrentMetric, buildBenchPrompt, classifyCommitTask, IOnyxBenchCommitCandidate, ONYX_BENCH_METRIC, scoreBenchAttempt, selectBenchmarkCommits
} from '../../common/onyxRepoBench.js';

function commit(overrides: Partial<IOnyxBenchCommitCandidate>): IOnyxBenchCommitCandidate {
	return { hash: 'a'.repeat(40), subject: 'Add helper for parsing', files: ['src/a.ts'], insertions: 6, deletions: 2, ...overrides };
}

suite('OnyxRepoBench', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('commit selection: single-file, right-sized, non-mechanical commits, spread over history', () => {
		const candidates: IOnyxBenchCommitCandidate[] = [
			commit({ hash: '1'.repeat(40) }),
			commit({ hash: '2'.repeat(40), files: ['a.ts', 'b.ts'] }),                    // two files
			commit({ hash: '3'.repeat(40), insertions: 1, deletions: 0 }),               // too small
			commit({ hash: '4'.repeat(40), insertions: 300, deletions: 100 }),           // rewrite
			commit({ hash: '5'.repeat(40), subject: 'Merge branch main' }),              // merge
			commit({ hash: '6'.repeat(40), subject: 'bump deps' }),                      // mechanical
			commit({ hash: '7'.repeat(40), files: ['yarn.lock'] }),                      // lockfile
			commit({ hash: '8'.repeat(40), subject: 'Fix crash when list empty', insertions: 4, deletions: 1 }),
		];
		const tasks = selectBenchmarkCommits(candidates, 10);
		assert.deepStrictEqual(tasks.map(task => ({ hash: task.hash[0], kind: task.kind })), [
			{ hash: '1', kind: 'quick-edit' },
			{ hash: '8', kind: 'debug' },
		]);
	});

	test('task kinds follow the commit, not a coin flip', () => {
		assert.deepStrictEqual({
			bug: classifyCommitTask(commit({ subject: 'Fix null crash in parser' })),
			small: classifyCommitTask(commit({ insertions: 4, deletions: 2 })),
			large: classifyCommitTask(commit({ insertions: 50, deletions: 20 })),
		}, { bug: 'debug', small: 'quick-edit', large: 'implement' });
	});

	test('the prompt carries the file, its content and the commit subject', () => {
		const prompt = buildBenchPrompt({ hash: 'h', subject: 'Rename x to y', file: 'src/a.ts', kind: 'quick-edit' }, 'const x = 1;');
		assert.ok(prompt.includes('src/a.ts') && prompt.includes('const x = 1;') && prompt.includes('Rename x to y'));
	});

	suite('scoreBenchAttempt', () => {
		const before = ['function add(a, b) {', '  return a + b', '}'].join('\n');
		const realAfter = ['function add(a, b) {', '  return a + b;', '}'].join('\n');

		test('an exact reproduction scores 1', () => {
			const reply = '<<<<<<< SEARCH\n  return a + b\n=======\n  return a + b;\n>>>>>>> REPLACE';
			assert.strictEqual(scoreBenchAttempt(before, realAfter, reply).score, 1);
		});

		test('a wrong edit of the right line scores a half, for the line it removed, and no more; prose scores zero with the reason named', () => {
			const wrong = '<<<<<<< SEARCH\n  return a + b\n=======\n  return b - a;\n>>>>>>> REPLACE';
			const prose = 'I think you should add a semicolon somewhere.';
			assert.deepStrictEqual({
				wrong: scoreBenchAttempt(before, realAfter, wrong).score,
				prose: scoreBenchAttempt(before, realAfter, prose),
			}, {
				// Since C8 removed lines count: the reply removed the line the author removed, and added the wrong one.
				wrong: 0.5,
				prose: { score: 0, reason: 'reply was prose, not an edit' },
			});
		});

		test('pure deletions are scored on what was removed', () => {
			const withExtra = ['keep();', 'remove();', 'keep2();'].join('\n');
			const deleted = ['keep();', 'keep2();'].join('\n');
			const goodReply = '<<<<<<< SEARCH\nremove();\n=======\n>>>>>>> REPLACE';
			assert.strictEqual(scoreBenchAttempt(withExtra, deleted, goodReply).score, 1);
		});

		test('R-22: a reply that reproduces the author\'s added lines and deletes an unrelated line scores strictly below 1, capped, with the line and the reason named', () => {
			const file = ['import { log } from \'./log\';', 'function add(a, b) {', '  return a + b', '}', 'export const VERSION = 3;'].join('\n');
			const author = file.replace('  return a + b', '  return a + b;');
			const exact = '<<<<<<< SEARCH\n  return a + b\n=======\n  return a + b;\n>>>>>>> REPLACE';
			const alsoDeletes = exact + '\n<<<<<<< SEARCH\nexport const VERSION = 3;\n=======\n>>>>>>> REPLACE';
			const alsoRewrites = exact + '\n<<<<<<< SEARCH\nexport const VERSION = 3;\n=======\nexport const VERSION = 4;\n>>>>>>> REPLACE';
			const alsoAdds = exact + '\n<<<<<<< SEARCH\nexport const VERSION = 3;\n=======\nexport const VERSION = 3;\nlog(add(1, 2));\n>>>>>>> REPLACE';
			assert.deepStrictEqual({
				exact: scoreBenchAttempt(file, author, exact),
				alsoDeletes: scoreBenchAttempt(file, author, alsoDeletes),
				alsoRewrites: scoreBenchAttempt(file, author, alsoRewrites),
				// Adding too much is imprecise, and is not a loss of the author's code: no cap.
				alsoAdds: scoreBenchAttempt(file, author, alsoAdds),
			}, {
				exact: { score: 1, reason: '100% of the author\'s changed lines reproduced, 100% of the model\'s on target', metric: ONYX_BENCH_METRIC },
				alsoDeletes: { score: 0.5, reason: 'capped at 0.5: the reply removed 1 line the author kept ("export const VERSION = 3;"); before the cap 0.8 (100% of the author\'s changed lines reproduced, 67% of the model\'s on target)', metric: ONYX_BENCH_METRIC, preservation: { removedLinesTheAuthorKept: 1, scoreBeforeCap: 0.8 } },
				alsoRewrites: { score: 0.5, reason: 'capped at 0.5: the reply removed 1 line the author kept ("export const VERSION = 3;"); before the cap 0.67 (100% of the author\'s changed lines reproduced, 50% of the model\'s on target)', metric: ONYX_BENCH_METRIC, preservation: { removedLinesTheAuthorKept: 1, scoreBeforeCap: 0.67 } },
				alsoAdds: { score: 0.8, reason: '100% of the author\'s changed lines reproduced, 67% of the model\'s on target', metric: ONYX_BENCH_METRIC },
			});
		});
	});

	test('C8: routing data scored under another metric, or under none, is dropped when it is loaded; data under the current metric is kept', () => {
		assert.deepStrictEqual({
			unnamed: benchRoutingDataForCurrentMetric({ benchScores: { debug: 1 }, benchSamples: { debug: 4 } }),
			older: benchRoutingDataForCurrentMetric({ benchScores: { debug: 1 }, benchSamples: { debug: 4 }, benchMetric: 'added-line-f1/1' }),
			current: benchRoutingDataForCurrentMetric({ benchScores: { debug: 0.5 }, benchSamples: { debug: 2 }, benchMetric: ONYX_BENCH_METRIC }),
		}, {
			unnamed: { benchScores: {}, benchSamples: {}, benchMetric: ONYX_BENCH_METRIC },
			older: { benchScores: {}, benchSamples: {}, benchMetric: ONYX_BENCH_METRIC },
			current: { benchScores: { debug: 0.5 }, benchSamples: { debug: 2 }, benchMetric: ONYX_BENCH_METRIC },
		});
	});

	test('aggregation groups by model and kind with stable ordering', () => {
		const task = { hash: 'h', subject: 's', file: 'f', kind: 'quick-edit' as const };
		const debugTask = { ...task, kind: 'debug' as const };
		const results = [
			{ modelKey: 'b', task, score: { score: 0.8, reason: '' }, durationMs: 1 },
			{ modelKey: 'b', task, score: { score: 0.4, reason: '' }, durationMs: 1 },
			{ modelKey: 'a', task: debugTask, score: { score: 1, reason: '' }, durationMs: 1 },
		];
		assert.deepStrictEqual(aggregateBenchResults(results), [
			{ modelKey: 'a', kind: 'debug', meanScore: 1, taskCount: 1 },
			{ modelKey: 'b', kind: 'quick-edit', meanScore: 0.6, taskCount: 2 },
		]);
	});
});
