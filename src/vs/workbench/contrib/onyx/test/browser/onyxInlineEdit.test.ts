/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { applyEditBlocks, computeLineHunks, parseInlineEdits } from '../../common/onyxInlineEdit.js';

suite('OnyxInlineEdit', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('parseInlineEdits', () => {

		test('a well-formed block parses exactly', () => {
			const parsed = parseInlineEdits('<<<<<<< SEARCH\nlet a = 1;\n=======\nconst a = 1;\n>>>>>>> REPLACE');
			assert.deepStrictEqual(parsed, { kind: 'blocks', blocks: [{ search: 'let a = 1;', replace: 'const a = 1;' }] });
		});

		test('marker sloppiness is tolerated: short markers, no REPLACE label, wrapping fence', () => {
			const reply = [
				'```ts',
				'<<<< SEARCH',
				'foo();',
				'====',
				'bar();',
				'>>>>',
				'```',
			].join('\n');
			assert.deepStrictEqual(parseInlineEdits(reply), { kind: 'blocks', blocks: [{ search: 'foo();', replace: 'bar();' }] });
		});

		test('multiple blocks, including one opened before the previous closed', () => {
			const reply = [
				'<<<<<<< SEARCH', 'a;', '=======', 'A;', '>>>>>>> REPLACE',
				'<<<<<<< SEARCH', 'b;', '=======', 'B;',
				'<<<<<<< SEARCH', 'c;', '=======', 'C;', '>>>>>>> REPLACE',
			].join('\n');
			const parsed = parseInlineEdits(reply);
			assert.deepStrictEqual(parsed, {
				kind: 'blocks', blocks: [
					{ search: 'a;', replace: 'A;' },
					{ search: 'b;', replace: 'B;' },
					{ search: 'c;', replace: 'C;' },
				]
			});
		});

		test('a truncated final block keeps its partial replacement', () => {
			const parsed = parseInlineEdits('<<<<<<< SEARCH\nold();\n=======\nnew(');
			assert.deepStrictEqual(parsed, { kind: 'blocks', blocks: [{ search: 'old();', replace: 'new(' }] });
		});

		test('markers echoed inside the reply never reach the buffer', () => {
			// Observed live from qwen2.5-coder:1.5b: it repeats the format inside
			// its own replacement, which used to write the markers into the file.
			const reply = [
				'<<<<<<< SEARCH',
				'export function subtotal(items: Item[]): number {',
				'=======',
				'<<<<<<< SEARCH',
				'export function subtotal(items: Item[]): number {',
				'\treturn items.reduce((a, i) => a + i.price, 0);',
				'>>>>>>> REPLACE',
				'>>>>>>> REPLACE',
			].join('\n');
			const parsed = parseInlineEdits(reply);
			assert.ok(parsed.kind === 'blocks');
			const bodies = parsed.blocks.flatMap(block => [block.search, block.replace]).join('\n');
			assert.deepStrictEqual(
				{ hasSearchMarker: bodies.includes('<<<'), hasReplaceMarker: bodies.includes('>>>'), keepsCode: bodies.includes('reduce') },
				{ hasSearchMarker: false, hasReplaceMarker: false, keepsCode: true });
		});

		test('a reply with no divider becomes a rewrite, markers stripped', () => {
			// llama3.2:3b does exactly this every time: it emits both markers and
			// puts only the NEW code between them, with no `=======`. Before this
			// was handled, the markers were pasted into the user's file.
			const reply = [
				'<<<<<<< SEARCH',
				'export function applyDiscount(items: Item[], percent: number): number {',
				'\treturn items.reduce((total, item) => total + item.price, 0) * (1 - percent / 100);',
				'}',
				'>>>>>>> REPLACE',
			].join('\n');
			const parsed = parseInlineEdits(reply);
			assert.ok(parsed.kind === 'rewrite');
			assert.deepStrictEqual(
				{ leaksMarkers: /<{4,}|>{4,}/.test(parsed.text), keepsCode: parsed.text.includes('reduce'), startsClean: parsed.text.startsWith('export function') },
				{ leaksMarkers: false, keepsCode: true, startsClean: true });
		});

		test('a fenced reply without markers is a whole-selection rewrite', () => {
			const parsed = parseInlineEdits('```python\ndef f():\n    return 2\n```');
			assert.deepStrictEqual(parsed, { kind: 'rewrite', text: 'def f():\n    return 2' });
		});

		test('bare code without markers is a rewrite; prose is unparseable', () => {
			assert.deepStrictEqual([
				parseInlineEdits('const x = compute();\nreturn x;').kind,
				parseInlineEdits('I cannot help with that request because it is unclear.').kind,
				parseInlineEdits('').kind,
			], ['rewrite', 'unparseable', 'unparseable']);
		});
	});

	suite('computeLineHunks', () => {

		test('changes group into hunks with originals preserved', () => {
			const hunks = computeLineHunks('a\nb\nc\nd', 'a\nB\nc\nd\ne');
			assert.deepStrictEqual(hunks, [
				{ originalStart: 1, originalLength: 1, newLines: ['B'], originalLines: ['b'] },
				{ originalStart: 4, originalLength: 0, newLines: ['e'], originalLines: [] },
			]);
		});

		test('identical texts produce no hunks; a full rewrite produces one', () => {
			assert.deepStrictEqual([
				computeLineHunks('x\ny', 'x\ny'),
				computeLineHunks('x', 'completely\ndifferent').length,
			], [[], 1]);
		});
	});

	suite('applyEditBlocks', () => {

		const original = [
			'function greet(name) {',
			'\tconst count = add(1, 2);',
			'\treturn `Hello ${name}`;',
			'}',
		].join('\n');

		test('exact match applies in place', () => {
			const applied = applyEditBlocks(original, [{ search: '\treturn `Hello ${name}`;', replace: '\treturn `Hi ${name}`;' }]);
			assert.deepStrictEqual(
				{ appliedCount: applied.appliedCount, failed: applied.failed, hasNew: applied.text.includes('Hi ${name}') },
				{ appliedCount: 1, failed: [], hasNew: true });
		});

		test('whitespace drift falls back to trimmed matching and re-indents', () => {
			// The model claimed 4-space indentation; the file uses tabs.
			const applied = applyEditBlocks(original, [{ search: '    const count = add(1, 2);', replace: '    const count = add(2, 3);' }]);
			assert.deepStrictEqual(
				{ appliedCount: applied.appliedCount, line: applied.text.split('\n')[1] },
				{ appliedCount: 1, line: '\tconst count = add(2, 3);' });
		});

		test('off-by-one hunks anchor on a unique first line', () => {
			// SEARCH quotes one line too many (a line that does not exist).
			const applied = applyEditBlocks(original, [{ search: '\tconst count = add(1, 2);\n\tlet unrelated = 0;', replace: '\tconst count = 3;\n\tlet unrelated = 0;' }]);
			assert.deepStrictEqual(
				{ appliedCount: applied.appliedCount, second: applied.text.split('\n')[1], third: applied.text.split('\n')[2] },
				{ appliedCount: 1, second: '\tconst count = 3;', third: '\tlet unrelated = 0;' });
		});

		test('an unlocatable block is reported, not guessed', () => {
			const block = { search: 'this text exists nowhere', replace: 'x' };
			const applied = applyEditBlocks(original, [block]);
			assert.deepStrictEqual(
				{ text: applied.text, appliedCount: applied.appliedCount, failed: applied.failed },
				{ text: original, appliedCount: 0, failed: [block] });
		});

		test('later blocks apply against the result of earlier ones', () => {
			const applied = applyEditBlocks('a\nb\nc', [
				{ search: 'b', replace: 'B' },
				{ search: 'B\nc', replace: 'B\nC' },
			]);
			assert.deepStrictEqual({ text: applied.text, appliedCount: applied.appliedCount }, { text: 'a\nB\nC', appliedCount: 2 });
		});

		test('an empty SEARCH never applies', () => {
			const applied = applyEditBlocks('a', [{ search: '', replace: 'x' }]);
			assert.deepStrictEqual({ appliedCount: applied.appliedCount, failedCount: applied.failed.length }, { appliedCount: 0, failedCount: 1 });
		});
	});
});
