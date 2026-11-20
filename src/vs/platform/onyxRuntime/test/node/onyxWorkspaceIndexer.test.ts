/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as fs from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { OnyxWorkspaceIndexer } from '../../node/onyxWorkspaceIndexer.js';

/**
 * R-19, the index half (B12): a persisted index is not believed just because
 * it is there. It says which tree it was built from and when; a load checks
 * it against the tree as it is now and repairs or rebuilds it; and whether
 * the caps cut the walk short survives a restart.
 */
suite('OnyxWorkspaceIndexer', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	async function withTree<T>(files: Record<string, string>, body: (root: string, persistPath: string) => Promise<T>): Promise<T> {
		const base = await fs.promises.mkdtemp(join(tmpdir(), 'onyx-index-test-'));
		try {
			const root = join(base, 'workspace');
			for (const [path, content] of Object.entries(files)) {
				await fs.promises.mkdir(join(root, path, '..'), { recursive: true });
				await fs.promises.writeFile(join(root, path), content);
			}
			return await body(root, join(base, 'state', 'bm25.json'));
		} finally {
			await fs.promises.rm(base, { recursive: true, force: true });
		}
	}

	const paths = async (indexer: OnyxWorkspaceIndexer, query: string) => (await indexer.search(query, 10)).map(hit => hit.path).sort();

	test('R-19: a persisted index older than the tree is reconciled on load: changed, added and deleted files are seen, and nothing stale is served', () => withTree({
		'src/alpha.ts': 'export const alphaoldword = 1;\n',
		'src/beta.ts': 'export const betaword = 2;\n',
		'src/gamma.ts': 'export const gammaword = 3;\n',
	}, async (root, persistPath) => {
		const first = new OnyxWorkspaceIndexer(root, persistPath);
		const built = await first.ensure();
		await first.flush();
		first.dispose();

		// The tree moves on while nobody is watching: one file changes, one is added, one is deleted.
		await fs.promises.writeFile(join(root, 'src/alpha.ts'), 'export const alphanewword = 1; // and longer now\n');
		await fs.promises.writeFile(join(root, 'src/delta.ts'), 'export const deltaword = 4;\n');
		await fs.promises.rm(join(root, 'src/gamma.ts'));

		const second = new OnyxWorkspaceIndexer(root, persistPath);
		const loaded = await second.ensure();
		const found = {
			oldAlpha: await paths(second, 'alphaoldword'),
			newAlpha: await paths(second, 'alphanewword'),
			beta: await paths(second, 'betaword'),
			deleted: await paths(second, 'gammaword'),
			added: await paths(second, 'deltaword'),
		};
		second.dispose();

		assert.deepStrictEqual({
			built: { files: built.files, source: built.source, truncated: built.truncated },
			loaded: { files: loaded.files, source: loaded.source, truncated: loaded.truncated, reconciled: loaded.reconciled, builtAtIsRecorded: typeof loaded.builtAt === 'number' && loaded.builtAt > 0 },
			found,
		}, {
			built: { files: 3, source: 'built', truncated: false },
			loaded: { files: 3, source: 'reconciled', truncated: false, reconciled: { added: 1, updated: 1, removed: 1 }, builtAtIsRecorded: true },
			found: { oldAlpha: [], newAlpha: ['src/alpha.ts'], beta: ['src/beta.ts'], deleted: [], added: ['src/delta.ts'] },
		});
	}));

	test('R-19: that the caps cut the walk short survives persistence, and a file that is not this index is rebuilt, not trusted', () => withTree({
		'a.ts': 'export const firstword = 1;\n',
		'b.ts': 'export const two = 2;\n',
		'c.ts': 'export const three = 3;\n',
		'd.ts': 'export const four = 4;\n',
	}, async (root, persistPath) => {
		const capped = new OnyxWorkspaceIndexer(root, persistPath, { maxFiles: 2 });
		const built = await capped.ensure();
		await capped.flush();
		capped.dispose();

		const reloaded = new OnyxWorkspaceIndexer(root, persistPath, { maxFiles: 2 });
		const loaded = await reloaded.ensure();
		reloaded.dispose();

		// The same file, read by an indexer for another root: not its index.
		const otherRoot = join(root, '..', 'elsewhere');
		await fs.promises.mkdir(otherRoot, { recursive: true });
		await fs.promises.writeFile(join(otherRoot, 'only.ts'), 'export const elsewhereword = 5;\n');
		const foreign = new OnyxWorkspaceIndexer(otherRoot, persistPath);
		const foreignStats = await foreign.ensure();
		const foreignFinds = { own: await paths(foreign, 'elsewhereword'), theOtherTrees: await paths(foreign, 'firstword') };
		foreign.dispose();

		// A file in the format an earlier build wrote (the bare index, no record of where it came from).
		await fs.promises.writeFile(persistPath, JSON.stringify({ version: 1, docs: { 'ghost.ts': { tf: { ghostword: 1 }, length: 1 } } }));
		const legacy = new OnyxWorkspaceIndexer(root, persistPath);
		const legacyStats = await legacy.ensure();
		const ghost = await paths(legacy, 'ghostword');
		legacy.dispose();

		assert.deepStrictEqual({
			built: { files: built.files, truncated: built.truncated, source: built.source },
			loaded: { files: loaded.files, truncated: loaded.truncated, source: loaded.source },
			foreign: { source: foreignStats.source, files: foreignStats.files, ...foreignFinds },
			legacy: { source: legacyStats.source, files: legacyStats.files, ghost },
		}, {
			built: { files: 2, truncated: true, source: 'built' },
			loaded: { files: 2, truncated: true, source: 'loaded' },
			foreign: { source: 'built', files: 1, own: ['only.ts'], theOtherTrees: [] },
			legacy: { source: 'built', files: 4, ghost: [] },
		});
	}));
});
