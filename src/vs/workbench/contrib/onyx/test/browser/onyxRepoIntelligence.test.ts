/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { SymbolKind } from '../../../../../editor/common/languages.js';
import { elideMiddle } from '../../common/onyxContextCompression.js';
import { mergeContextSignals } from '../../browser/intelligence/onyxContextRanker.js';
import { ISymbolMatch, rankSymbolMatches } from '../../browser/intelligence/onyxRetrievalTool.js';

suite('OnyxRepoIntelligence', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('mergeContextSignals', () => {

		test('active editor dominates, sources accumulate, order is deterministic', () => {
			const ranked = mergeContextSignals({
				activePath: 'src/loop.ts',
				visiblePaths: ['src/loop.ts', 'src/view.ts'],
				historyPaths: ['src/view.ts', 'src/old.ts'],
				gitRecentPaths: ['src/loop.ts', 'README.md'],
			}, 10);
			assert.deepStrictEqual(ranked.map(f => f.path), ['src/loop.ts', 'src/view.ts', 'src/old.ts', 'README.md']);
			assert.deepStrictEqual(ranked[0].reasons, ['active editor', 'recently committed']);
			assert.deepStrictEqual(ranked[1].reasons, ['visible editor', 'recently opened']);
		});

		test('recency decays within a source and the limit truncates', () => {
			const ranked = mergeContextSignals({
				activePath: undefined,
				visiblePaths: [],
				historyPaths: ['a.ts', 'b.ts', 'c.ts'],
				gitRecentPaths: [],
			}, 2);
			assert.deepStrictEqual(ranked.map(f => f.path), ['a.ts', 'b.ts']);
			assert.ok(ranked[0].score > ranked[1].score);
		});

		test('empty signals produce an empty ranking', () => {
			assert.deepStrictEqual(mergeContextSignals({ activePath: undefined, visiblePaths: [], historyPaths: [], gitRecentPaths: [] }, 5), []);
		});
	});

	suite('elideMiddle', () => {

		test('short text passes through untouched', () => {
			assert.strictEqual(elideMiddle('hello', 100), 'hello');
		});

		test('long text keeps head and tail and marks the elision', () => {
			const lines = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n');
			const result = elideMiddle(lines, 500);
			assert.ok(result.length < lines.length);
			assert.ok(result.startsWith('line 0'));
			assert.ok(result.trimEnd().endsWith('line 199'));
			assert.ok(/\[… \d+ characters elided …\]/.test(result));
		});

		test('cuts on line boundaries when possible', () => {
			const text = Array.from({ length: 50 }, (_, i) => `abcdefghij ${i}`).join('\n');
			const result = elideMiddle(text, 300);
			const [head] = result.split('\n[…');
			assert.ok(head.endsWith(head.split('\n').pop()!));
			assert.ok(!head.split('\n').pop()!.startsWith('bcdef'), 'head should not cut mid-line');
		});
	});

	suite('rankSymbolMatches', () => {

		const symbol = (name: string, kind: SymbolKind, path: string, line = 1): ISymbolMatch =>
			({ name, containerName: undefined, kind, uri: URI.file(path), startLineNumber: line, endLineNumber: line + 5 });

		test('exact beats prefix beats substring beats fuzzy', () => {
			const ranked = rankSymbolMatches('run', [
				symbol('rerun', SymbolKind.Function, '/a.ts'),
				symbol('runLoop', SymbolKind.Function, '/b.ts'),
				symbol('run', SymbolKind.Function, '/c.ts'),
				symbol('r_u_n_ish', SymbolKind.Function, '/d.ts'),
			], 10);
			assert.deepStrictEqual(ranked.map(s => s.name), ['run', 'runLoop', 'rerun', 'r_u_n_ish']);
		});

		test('definition kinds win ties and the limit applies', () => {
			const ranked = rankSymbolMatches('parse', [
				symbol('parse', SymbolKind.Variable, '/var.ts'),
				symbol('parse', SymbolKind.Class, '/class.ts'),
				symbol('parse', SymbolKind.Function, '/func.ts'),
			], 2);
			assert.deepStrictEqual(ranked.map(s => s.uri.path), ['/class.ts', '/func.ts']);
		});
	});
});
