/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { extractDocSnippet, extractJsDocSections, jsDocSectionsToIndexText } from '../../../../../platform/onyxRuntime/common/onyxDocsExtract.js';

suite('OnyxDocsExtract', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('extractJsDocSections', () => {

		test('multi-line and single-line blocks each keep their signature and position', () => {
			const source = [
				'export interface Options {',
				'\t/**',
				'\t * The port to listen on.',
				'\t * Defaults to 3000.',
				'\t */',
				'\tport?: number;',
				'',
				'\t/** Enables verbose logging. */',
				'\tverbose?: boolean;',
				'}',
			].join('\n');
			assert.deepStrictEqual(extractJsDocSections(source, 10), [
				{ comment: 'The port to listen on.\nDefaults to 3000.', signature: 'port?: number;', line: 1 },
				{ comment: 'Enables verbose logging.', signature: 'verbose?: boolean;', line: 7 },
			]);
		});

		test('type noise without doc comments extracts nothing; the cap holds', () => {
			const noise = 'export type A = string | number;\nexport declare function f(x: A): void;';
			assert.deepStrictEqual(extractJsDocSections(noise, 10), []);
			const many = Array.from({ length: 50 }, (_, i) => `/** doc ${i} */\nconst x${i} = ${i};`).join('\n');
			assert.strictEqual(extractJsDocSections(many, 5).length, 5);
		});

		test('index text interleaves signatures with their docs', () => {
			const text = jsDocSectionsToIndexText([{ comment: 'Adds numbers.', signature: 'function add(a, b);', line: 0 }]);
			assert.strictEqual(text, 'function add(a, b);\nAdds numbers.');
		});
	});

	suite('extractDocSnippet', () => {

		test('short documents come back whole from line 1', () => {
			assert.deepStrictEqual(extractDocSnippet('one\ntwo', 'query', 24), { startLine: 1, text: 'one\ntwo' });
		});

		test('the densest window wins and markdown snaps to its heading', () => {
			const lines = [
				'# Intro',
				...Array.from({ length: 40 }, (_, i) => `filler line ${i}`),
				'## Middleware',
				'Middleware functions handle errors.',
				'Use error middleware last.',
				...Array.from({ length: 40 }, (_, i) => `more filler ${i}`),
			];
			const snippet = extractDocSnippet(lines.join('\n'), 'middleware errors', 10);
			assert.strictEqual(snippet.startLine, 42);
			assert.ok(snippet.text.startsWith('## Middleware'));
			assert.ok(snippet.text.includes('handle errors'));
		});

		test('a query with no indexable terms falls back to the top of the file', () => {
			const content = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n');
			const snippet = extractDocSnippet(content, '???', 5);
			assert.strictEqual(snippet.startLine, 1);
			assert.strictEqual(snippet.text.split('\n').length, 5);
		});
	});
});
