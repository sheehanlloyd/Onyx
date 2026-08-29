/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
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
