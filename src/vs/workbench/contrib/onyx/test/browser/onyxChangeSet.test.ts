/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { acceptReviewHunks, hunkAtProposedLine, proposedHunkRanges, ONYX_PROPOSAL_LIMITS, openReview, proposalSizeProblem, rebaseReview, rejectReviewHunk, reviewProposed,
	applyHunkSelection, IOnyxProposedFile, proposalHunks, proposalToUnifiedDiff, proposeEdits, rebaseProposal, summarizeChangeSet
} from '../../common/onyxChangeSet.js';

const FILE = ['function add(a, b) {', '\treturn a + b;', '}', '', 'function sub(a, b) {', '\treturn a - b;', '}'].join('\n');

function proposed(base: string, proposedContent: string): IOnyxProposedFile {
	return { path: 'src/math.ts', kind: 'modify', base, proposed: proposedContent, stale: false };
}

suite('OnyxChangeSet', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('proposeEdits', () => {

		test('a first edit stages against the current content', () => {
			const result = proposeEdits(undefined, 'src/math.ts', FILE, [{ search: '\treturn a + b;', replace: '\treturn a + b; // sum' }]);
			assert.deepStrictEqual(result, {
				ok: true,
				appliedCount: 1,
				file: { path: 'src/math.ts', kind: 'modify', base: FILE, proposed: FILE.replace('return a + b;', 'return a + b; // sum'), stale: false },
			});
		});

		test('successive edits compose on the staged content, not the buffer', () => {
			const first = proposeEdits(undefined, 'src/math.ts', FILE, [{ search: 'function add(a, b) {', replace: 'function add(first, second) {' }]);
			assert.ok(first.ok);
			const second = proposeEdits(first.file, 'src/math.ts', undefined, [{ search: 'function add(first, second) {', replace: 'export function add(first, second) {' }]);
			assert.ok(second.ok);
			assert.strictEqual(second.file.proposed.startsWith('export function add(first, second) {'), true);
			assert.strictEqual(second.file.base, FILE);
		});

		test('an unfindable search fails the whole call with an actionable message', () => {
			const result = proposeEdits(undefined, 'src/math.ts', FILE, [{ search: 'no such line', replace: 'x' }]);
			assert.ok(!result.ok);
			assert.ok(result.error.includes('no such line'));
		});

		test('R-07, R-08, R-33: a search that is not in the file exactly once stages nothing and says why: the first unmatched line, the number of places, or the indentation', () => {
			const outcome = (search: string) => { const result = proposeEdits(undefined, 'src/math.ts', FILE, [{ search, replace: 'x' }]); return result.ok ? 'staged' : result.error; };
			const twice = FILE + '\n' + FILE;
			const ambiguous = proposeEdits(undefined, 'src/math.ts', twice, [{ search: '\treturn a + b;', replace: '\treturn b + a;' }]);
			const composed = proposeEdits(proposed(FILE, FILE.replace('a + b', 'a + b + 0')), 'src/math.ts', FILE, [{ search: '  return a + b + 0;', replace: 'x' }]);
			assert.deepStrictEqual({
				firstLineUniqueRestInvented: outcome('\treturn a + b;\n\tconsole.log(a);'),
				reindented: outcome('    return a + b;'),
				ambiguous: ambiguous.ok ? 'staged' : ambiguous.error,
				// The same rule against content that is already staged.
				composed: composed.ok ? 'staged' : composed.error,
			}, {
				firstLineUniqueRestInvented: 'Edit refused for src/math.ts (staged content included). The "search" text is not in the file exactly as quoted. The first line that does not match is line 2 of it: "\\tconsole.log(a);". Nothing was changed. Quote the lines exactly as they are in the file, including indentation.',
				reindented: 'Edit refused for src/math.ts (staged content included). The "search" text is in the file only with different indentation: the file indents these lines with tabs. Nothing was changed. Quote the lines exactly as the file has them, tabs included, and indent the new lines the same way.',
				ambiguous: 'Edit refused for src/math.ts (staged content included). The "search" text occurs 2 times in the file, so it does not say which place to change. Nothing was changed. Quote more of the surrounding lines so that the text occurs exactly once: for a closing "}", quote the line before it as well.',
				composed: 'Edit refused for src/math.ts (staged content included). The "search" text is in the file only with different indentation: the file indents these lines with tabs. Nothing was changed. Quote the lines exactly as the file has them, tabs included, and indent the new lines the same way.',
			});
		});

		test('creating a file needs an empty search and stages the full content', () => {
			const rejected = proposeEdits(undefined, 'src/new.ts', undefined, [{ search: 'something', replace: 'x' }]);
			assert.ok(!rejected.ok);
			const created = proposeEdits(undefined, 'src/new.ts', undefined, [{ search: '', replace: 'export const x = 1;' }]);
			assert.deepStrictEqual(created, {
				ok: true,
				appliedCount: 1,
				file: { path: 'src/new.ts', kind: 'create', base: '', proposed: 'export const x = 1;', stale: false },
			});
		});

		test('an empty search against an existing file is refused', () => {
			const result = proposeEdits(undefined, 'src/math.ts', FILE, [{ search: '', replace: 'overwrite everything' }]);
			assert.ok(!result.ok);
		});
	});

	suite('hunks and selection', () => {

		test('accept-all reproduces the proposal, reject-all the base, mixed selections compose', () => {
			const modified = FILE
				.replace('function add(a, b) {', 'export function add(a, b) {')
				.replace('\treturn a - b;', '\treturn a - b; // difference');
			const file = proposed(FILE, modified);
			const hunks = proposalHunks(file);
			assert.strictEqual(hunks.length, 2);
			assert.deepStrictEqual({
				all: applyHunkSelection(FILE, hunks, () => true),
				none: applyHunkSelection(FILE, hunks, () => false),
				firstOnly: applyHunkSelection(FILE, hunks, index => index === 0),
			}, {
				all: modified,
				none: FILE,
				firstOnly: FILE.replace('function add(a, b) {', 'export function add(a, b) {'),
			});
		});

		test('property: random line edits always round-trip through hunks', () => {
			// A deterministic pseudo-random walk over many shapes of edit.
			let seed = 42;
			const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
			for (let iteration = 0; iteration < 200; iteration++) {
				const lineCount = 1 + Math.floor(random() * 12);
				const baseLines = Array.from({ length: lineCount }, (_, i) => `line ${i} ${Math.floor(random() * 4)}`);
				const modifiedLines = baseLines.flatMap(line => {
					const roll = random();
					if (roll < 0.2) { return []; }                       // delete
					if (roll < 0.4) { return [line + ' changed']; }      // modify
					if (roll < 0.55) { return [line, `inserted ${Math.floor(random() * 100)}`]; } // insert after
					return [line];                                       // keep
				});
				const base = baseLines.join('\n');
				const modified = modifiedLines.join('\n');
				const hunks = proposalHunks(proposed(base, modified));
				assert.strictEqual(applyHunkSelection(base, hunks, () => true), modified, `iteration ${iteration}: accept-all`);
				assert.strictEqual(applyHunkSelection(base, hunks, () => false), base, `iteration ${iteration}: reject-all`);
			}
		});
	});

	suite('rebaseProposal', () => {

		test('an untouched base is returned as-is', () => {
			const file = proposed(FILE, FILE.replace('a + b', 'a + b + 0'));
			assert.deepStrictEqual(rebaseProposal(file, FILE), { file, droppedHunks: 0 });
		});

		test('a proposal survives unrelated edits elsewhere in the file', () => {
			const file = proposed(FILE, FILE.replace('\treturn a - b;', '\treturn a - b; // diff'));
			const newBase = '// new header\n' + FILE;
			const rebased = rebaseProposal(file, newBase);
			assert.deepStrictEqual({
				droppedHunks: rebased.droppedHunks,
				proposed: rebased.file.proposed,
				base: rebased.file.base,
			}, {
				droppedHunks: 0,
				proposed: '// new header\n' + FILE.replace('\treturn a - b;', '\treturn a - b; // diff'),
				base: newBase,
			});
		});

		test('a hunk whose anchor vanished is dropped, never guessed', () => {
			const file = proposed(FILE, FILE.replace('\treturn a - b;', '\treturn b - a;'));
			const newBase = FILE.split('\n').filter(line => !line.includes('a - b')).join('\n');
			const rebased = rebaseProposal(file, newBase);
			assert.deepStrictEqual({ droppedHunks: rebased.droppedHunks, proposed: rebased.file.proposed }, { droppedHunks: 1, proposed: newBase });
		});

		test('R-09: the buffer is edited above a hunk and the hunk\'s lines occur twice: the hunk follows its own place, never the first occurrence', () => {
			const twin = ['function first() {', '\tlog("start");', '\treturn compute();', '}', '', 'function second() {', '\tlog("start");', '\treturn compute();', '}'].join('\n');
			// The proposal changes the second `return compute();`. The line before it is the same in both functions:
			// one line of context does not tell them apart, three do.
			const file = proposed(twin, twin.replace('function second() {\n\tlog("start");\n\treturn compute();', 'function second() {\n\tlog("start");\n\treturn compute() + 1;'));
			// The user adds two lines at the top: both occurrences move down, the first one is still first.
			const newBase = '// header\n// more\n' + twin;
			const rebased = rebaseProposal(file, newBase);
			assert.deepStrictEqual({ dropped: rebased.droppedHunks, proposed: rebased.file.proposed }, { dropped: 0, proposed: '// header\n// more\n' + file.proposed });
		});

		test('R-09: when the hunk\'s lines and their context are in the buffer twice, it is a conflict, not a choice', () => {
			const block = ['function work() {', '\tprepare();', '\treturn run();', '}'].join('\n');
			const file = proposed(block, block.replace('\treturn run();', '\treturn run(true);'));
			// The user duplicates the whole function while the proposal waits.
			const newBase = block + '\n' + block;
			const rebased = rebaseProposal(file, newBase);
			assert.deepStrictEqual({ dropped: rebased.droppedHunks, proposed: rebased.file.proposed }, { dropped: 1, proposed: newBase });
		});

		test('R-10: a hunk whose context no longer exists is a conflict that keeps both texts; the hunks that still correspond keep their ids', () => {
			const opened = openReview(FILE, FILE.replace('\treturn a + b;', '\treturn b + a;').replace('\treturn a - b;', '\treturn b - a;'), 7);
			assert.ok(opened.ok);
			// The user rewrites the first function; the second is untouched.
			const newBase = FILE.replace('\treturn a + b;', '\treturn Number(a) + Number(b);');
			const rebased = rebaseReview(opened.review, FILE, newBase);
			assert.deepStrictEqual({
				idsBefore: opened.review.hunks.map(hunk => hunk.id),
				hunks: rebased.hunks.map(hunk => ({ id: hunk.id, line: hunk.originalStart + 1, newLines: hunk.newLines })),
				conflicts: rebased.conflicts,
				proposed: reviewProposed(newBase, rebased.hunks),
			}, {
				idsBefore: ['g7.h1', 'g7.h2'],
				hunks: [{ id: 'g7.h2', line: 6, newLines: ['\treturn b - a;'] }],
				conflicts: [{ id: 'g7.h1', reason: 'missing', originalLines: ['\treturn a + b;'], newLines: ['\treturn b + a;'], wasAtLine: 2 }],
				proposed: newBase.replace('\treturn a - b;', '\treturn b - a;'),
			});
		});

		test('B7: accepting some hunks moves the rest by the lines added or removed and keeps their ids; a new generation shares no id with the one before', () => {
			const opened = openReview(FILE, FILE.replace('\treturn a + b;', '\tconst sum = a + b;\n\treturn sum;').replace('\treturn a - b;', '\treturn b - a;'), 3);
			assert.ok(opened.ok);
			const accepted = acceptReviewHunks(opened.review, FILE, id => id === 'g3.h1');
			const next = openReview(FILE, FILE.replace('\treturn a - b;', '\treturn b - a;'), 4);
			assert.ok(next.ok);
			assert.deepStrictEqual({
				base: accepted.base,
				rest: accepted.review.hunks.map(hunk => ({ id: hunk.id, line: hunk.originalStart + 1 })),
				restProposed: reviewProposed(accepted.base, accepted.review.hunks),
				rejected: rejectReviewHunk(opened.review, 'g3.h1').hunks.map(hunk => hunk.id),
				nextGeneration: next.review.hunks.map(hunk => hunk.id),
			}, {
				base: FILE.replace('\treturn a + b;', '\tconst sum = a + b;\n\treturn sum;'),
				rest: [{ id: 'g3.h2', line: 7 }],
				restProposed: FILE.replace('\treturn a + b;', '\tconst sum = a + b;\n\treturn sum;').replace('\treturn a - b;', '\treturn b - a;'),
				rejected: ['g3.h2'],
				nextGeneration: ['g4.h1'],
			});
		});

		test('C1: a line of the proposed content names the hunk it belongs to, and a line no hunk touches names none', () => {
			// Hunk 1 replaces one line by two; hunk 2 deletes a line; hunk 3 replaces the last line.
			const base = ['one', 'two', 'three', 'four', 'five', 'six', 'seven'].join('\n');
			const next = ['one', 'TWO-A', 'TWO-B', 'three', 'five', 'six', 'SEVEN'].join('\n');
			const opened = openReview(base, next, 5);
			assert.ok(opened.ok);
			const at = (line: number) => hunkAtProposedLine(opened.review.hunks, line)?.id ?? 'none';
			assert.deepStrictEqual({
				ranges: proposedHunkRanges(opened.review.hunks),
				byLine: [1, 2, 3, 4, 5, 6, 7].map(at),
			}, {
				ranges: [{ id: 'g5.h1', startLine: 2, lineCount: 2 }, { id: 'g5.h2', startLine: 5, lineCount: 0 }, { id: 'g5.h3', startLine: 7, lineCount: 1 }],
				// Line 4 (`three`) is next to the deletion and line 5 (`five`) is where it happened; line 6 is untouched.
				byLine: ['none', 'g5.h1', 'g5.h1', 'g5.h2', 'g5.h2', 'none', 'g5.h3'],
			});
		});

		test('R-38, as it stands with C9: a proposal over the documented size is refused before it is diffed, by lines and by bytes; 6,000 lines a side is reviewed', () => {
			const lines = (count: number) => Array.from({ length: count }, (_, index) => `line ${index}`).join('\n');
			const outcome = (base: string, next: string) => { const opened = openReview(base, next, 1); return opened.ok ? 'reviewed' : opened.error; };
			assert.deepStrictEqual({
				limits: ONYX_PROPOSAL_LIMITS,
				sixThousandLines: outcome(lines(6000), lines(6000).replace('line 3000', 'line three thousand')),
				atTheLineLimit: outcome(lines(19_999), lines(19_999) + '\nmore'),
				tooManyLines: outcome(lines(20_001), lines(20_001) + '\nmore'),
				tooManyBytes: outcome('a'.repeat(1000 * 1024), 'b'.repeat(25 * 1024)),
				multibyteCountsAsBytes: outcome('é'.repeat(270 * 1024), 'é'.repeat(260 * 1024)),
				sizeOnly: proposalSizeProblem('a', 'b'),
			}, {
				limits: { maxLinesPerSide: 20_000, maxCombinedBytes: 1_048_576 },
				sixThousandLines: 'reviewed',
				atTheLineLimit: 'reviewed',
				tooManyLines: 'the file has 20001 lines and the proposed content 20002; a proposal is reviewed up to 20000 lines a side',
				tooManyBytes: 'the file and the proposed content together are 1049600 bytes; a proposal is reviewed up to 1048576',
				multibyteCountsAsBytes: 'the file and the proposed content together are 1085440 bytes; a proposal is reviewed up to 1048576',
				sizeOnly: undefined,
			});
		});

		test('R-33: rebasing never re-anchors on a line that only matches after trimming: a hunk whose lines the user re-indented is dropped', () => {
			const file = proposed(FILE, FILE.replace('\treturn a - b;', '\treturn b - a;'));
			// The user re-indented the file with spaces while the proposal waited.
			const newBase = FILE.replace(/\t/g, '    ');
			const rebased = rebaseProposal(file, newBase);
			assert.deepStrictEqual({ droppedHunks: rebased.droppedHunks, proposed: rebased.file.proposed }, { droppedHunks: 1, proposed: newBase });
		});
	});

	test('summary and unified diff agree on the counts', () => {
		const file = proposed(FILE, FILE.replace('\treturn a + b;', '\tconst sum = a + b;\n\treturn sum;'));
		const summary = summarizeChangeSet([file]);
		const diff = proposalToUnifiedDiff(file);
		assert.deepStrictEqual({
			summary,
			plusLines: diff.split('\n').filter(line => line.startsWith('+') && !line.startsWith('+++')).length,
			minusLines: diff.split('\n').filter(line => line.startsWith('-') && !line.startsWith('---')).length,
			header: diff.startsWith('diff --git a/src/math.ts b/src/math.ts'),
		}, {
			summary: { fileCount: 1, addedLines: 2, removedLines: 1 },
			plusLines: 2,
			minusLines: 1,
			header: true,
		});
	});
});
