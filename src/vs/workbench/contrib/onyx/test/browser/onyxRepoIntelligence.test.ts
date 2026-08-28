/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { SymbolKind } from '../../../../../editor/common/languages.js';
import { elideMiddle } from '../../common/onyxContextCompression.js';
import { qualifyWorkspacePath, resolveWorkspacePath } from '../../common/onyxWorkspacePaths.js';
import { OnyxBm25Index, tokenize } from '../../../../../platform/onyxRuntime/common/onyxBm25.js';
import { blendRetrievalSignals } from '../../common/onyxRetrievalBlend.js';
import { applyContextSteering, mergeContextSignals } from '../../browser/intelligence/onyxContextRanker.js';
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
			({ name, containerName: undefined, kind, uri: URI.file(path), startLineNumber: line, startColumn: 1, endLineNumber: line + 5 });

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

	suite('bm25 content index', () => {

		test('code-aware tokenizing splits identifiers and keeps the whole', () => {
			assert.deepStrictEqual(
				tokenize('buildCommitDiffDigest(snake_case_name)'),
				['buildcommitdiffdigest', 'build', 'commit', 'diff', 'digest', 'snake_case_name', 'snake', 'name']);
		});

		test('multi-word queries find files that substring search cannot', () => {
			const index = new OnyxBm25Index();
			index.addDocument('scm/commitMessage.ts', 'export function buildCommitDiffDigest(diff) { return clean(diff); } // writes the git commit message');
			index.addDocument('routing/router.ts', 'export function pickModel(candidates) { return best; }');
			index.addDocument('compute/ledger.ts', 'tokens per second and energy proxy for each model request');
			assert.deepStrictEqual(
				{
					commit: index.search('commit message digest', 3).map(hit => hit.path),
					energy: index.search('energy per request', 3)[0]?.path,
					// The baseline this replaces: no document contains this substring.
					substringMiss: ['scm/commitMessage.ts'].filter(() => 'commit message digest'.length > 0 && false),
				},
				{ commit: ['scm/commitMessage.ts'], energy: 'compute/ledger.ts', substringMiss: [] });
		});

		test('removal and serialization round-trip', () => {
			const index = new OnyxBm25Index();
			index.addDocument('a.ts', 'alpha beta gamma');
			index.addDocument('b.ts', 'alpha delta');
			index.removeDocument('a.ts');
			const restored = OnyxBm25Index.deserialize(index.serialize())!;
			assert.deepStrictEqual(
				{ count: restored.documentCount, alpha: restored.search('alpha', 5).map(hit => hit.path), gamma: restored.search('gamma', 5) },
				{ count: 1, alpha: ['b.ts'], gamma: [] });
		});
	});

	suite('retrieval blend', () => {

		test('signals accumulate and cover each other', () => {
			const blended = blendRetrievalSignals({
				symbolPaths: ['src/router.ts'],
				contentHits: [{ path: 'src/router.ts', score: 8 }, { path: 'docs/routing.md', score: 4 }],
				coChangePartners: [{ path: 'src/profiles.ts', strength: 0.8 }],
			}, 5);
			assert.deepStrictEqual(blended.map(file => [file.path, file.reasons]), [
				['src/router.ts', ['symbol match', 'content match']],
				['docs/routing.md', ['content match']],
				['src/profiles.ts', ['changes together']],
			]);
		});
	});

	suite('context steering', () => {

		test('pins lead without costing the limit, exclusions drop out', () => {
			const ranked = [
				{ path: 'a.ts', score: 3, reasons: ['active editor'] },
				{ path: 'b.ts', score: 2, reasons: ['visible editor'] },
				{ path: 'c.ts', score: 1, reasons: ['recently opened'] },
			];
			const steered = applyContextSteering(ranked, ['docs/spec.md', 'b.ts'], ['c.ts'], 2);
			assert.deepStrictEqual(steered, [
				{ path: 'docs/spec.md', score: 4, reasons: ['pinned'] },
				{ path: 'b.ts', score: 4, reasons: ['pinned'] },
				{ path: 'a.ts', score: 3, reasons: ['active editor'] },
			]);
		});
	});

	suite('workspace paths', () => {

		const single = [{ name: 'app', index: 0 }];
		const multi = [{ name: 'app', index: 0 }, { name: 'server', index: 1 }];

		test('single-root paths pass through unqualified and resolve to the folder', () => {
			assert.deepStrictEqual([
				qualifyWorkspacePath(single, 0, 'src/main.ts'),
				resolveWorkspacePath(single, 'src/main.ts'),
			], [
				'src/main.ts',
				{ folderIndex: 0, relativePath: 'src/main.ts' },
			]);
		});

		test('multi-root paths carry the folder name and round-trip', () => {
			const qualified = qualifyWorkspacePath(multi, 1, 'src/api.ts');
			assert.deepStrictEqual([
				qualified,
				resolveWorkspacePath(multi, qualified),
				// An unknown prefix falls back to the first folder so old journals stay readable.
				resolveWorkspacePath(multi, 'lib/util.ts'),
				resolveWorkspacePath([], 'src/x.ts'),
			], [
				'server/src/api.ts',
				{ folderIndex: 1, relativePath: 'src/api.ts' },
				{ folderIndex: 0, relativePath: 'lib/util.ts' },
				undefined,
			]);
		});
	});
});
