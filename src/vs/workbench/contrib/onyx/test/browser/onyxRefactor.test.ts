/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { applyTextEdits, buildNameSuggestionPrompt, parseNameSuggestions, renamePlaceholder } from '../../common/onyxRefactor.js';

const CONTENT = ['function old(a) {', '\treturn old2(a) + old(a - 1);', '}'].join('\n');

suite('OnyxRefactor', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('applyTextEdits', () => {

		test('multiple edits in one file apply back-to-front without drift', () => {
			const result = applyTextEdits(CONTENT, [
				{ startLineNumber: 1, startColumn: 10, endLineNumber: 1, endColumn: 13, text: 'renamed' },
				{ startLineNumber: 2, startColumn: 19, endLineNumber: 2, endColumn: 22, text: 'renamed' },
			]);
			assert.deepStrictEqual(result, { kind: 'applied', content: ['function renamed(a) {', '\treturn old2(a) + renamed(a - 1);', '}'].join('\n') });
		});

		test('overlapping and out-of-range edits are rejected, never guessed', () => {
			assert.deepStrictEqual(applyTextEdits(CONTENT, [
				{ startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 10, text: 'x' },
				{ startLineNumber: 1, startColumn: 5, endLineNumber: 1, endColumn: 12, text: 'y' },
			]), { kind: 'error', error: 'the language service produced overlapping edits' });
			assert.deepStrictEqual(applyTextEdits('short', [
				{ startLineNumber: 9, startColumn: 1, endLineNumber: 9, endColumn: 99, text: 'x' },
			]), { kind: 'error', error: 'the language service produced an out-of-range edit' });
		});

		test('property: single-token replacements at random positions round-trip', () => {
			let seed = 7;
			const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
			for (let i = 0; i < 100; i++) {
				const lines = Array.from({ length: 1 + Math.floor(random() * 8) }, (_, l) => `line${l} token${l} end${l}`);
				const content = lines.join('\n');
				const line = 1 + Math.floor(random() * lines.length);
				const col = 1 + Math.floor(random() * lines[line - 1].length);
				const result = applyTextEdits(content, [{ startLineNumber: line, startColumn: col, endLineNumber: line, endColumn: col, text: '#' }]);
				assert.strictEqual(result.kind, 'applied', `iteration ${i}`);
				const applied = result as { kind: 'applied'; content: string };
				assert.strictEqual(applied.content.length, content.length + 1, `iteration ${i}: one char inserted`);
				assert.strictEqual(applied.content.replace('#', ''), content, `iteration ${i}: rest untouched`);
			}
		});
	});

	test('name suggestions parse from messy replies; invalid identifiers and echoes are dropped', () => {
		const reply = [
			'1. `applyDiscount` — says what it does',
			'- computeTotal: shorter',
			'not a suggestion line!',
			'2. bad-name — dashes are not identifiers',
			'oldName — the current name, echoed',
			'extra — beyond the cap',
		].join('\n');
		assert.deepStrictEqual(parseNameSuggestions(reply, 'oldName', 3), [
			{ name: 'applyDiscount', reason: 'says what it does' },
			{ name: 'computeTotal', reason: 'shorter' },
			{ name: 'extra', reason: 'beyond the cap' },
		]);
		assert.strictEqual(parseNameSuggestions('total\ntotal\ntotal', 'x', 3).length, 1);
	});

	test('the naming prompt asks for names, never edits', () => {
		const prompt = buildNameSuggestionPrompt('rename', 'foo', 'typescript', 'const foo = 1;');
		assert.ok(prompt.includes('Suggest 3 better names'));
		assert.ok(prompt.includes('name — short reason'));
	});

	test('placeholder rename is word-bounded and rejects invalid names', () => {
		const extracted = 'function newFunction() {}\nconst x = newFunction(); // newFunctionOther stays';
		assert.strictEqual(renamePlaceholder(extracted, 'newFunction', 'computeSum'),
			'function computeSum() {}\nconst x = computeSum(); // newFunctionOther stays');
		assert.strictEqual(renamePlaceholder(extracted, 'newFunction', 'not valid!'), extracted);
	});
});
