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

	test('C7: when the cap cuts, source directories are indexed before tests, documentation and examples, the workspace\'s own before a nested project\'s, and the index says how much of what was eligible it holds', () => withTree({
		'docs/guide.md': 'guideword\n',
		'examples/demo.ts': 'export const exampleword = 1;\n',
		'src/core/engine.ts': 'export const engineword = 1;\n',
		'src/core/engine.test.ts': 'export const enginetestword = 1;\n',
		'src/ui/view.ts': 'export const viewword = 1;\n',
		'test/integration/run.ts': 'export const integrationword = 1;\n',
		'tools/release.ts': 'export const releaseword = 1;\n',
		'aaa-first-alphabetically/fixtures/sample.ts': 'export const fixtureword = 1;\n',
		'aaa-plugins/alpha/src/plugin.ts': 'export const pluginword = 1;\n',
	}, async (root, persistPath) => {
		const build = async (maxFiles: number) => {
			const indexer = new OnyxWorkspaceIndexer(root, join(persistPath, '..', `cap-${maxFiles}.json`), { maxFiles });
			const stats = await indexer.ensure();
			const indexed = indexer.indexedPaths();
			indexer.dispose();
			return { indexed, files: stats.files, eligibleFiles: stats.eligibleFiles, truncated: stats.truncated };
		};
		const roomy = await build(100);
		assert.deepStrictEqual({ two: await build(2), four: await build(4), roomy: { ...roomy, indexed: roomy.indexed.length } }, {
			// The source folder at the root of the workspace, ahead of one that sorts before it but sits inside another project.
			two: { indexed: ['src/core/engine.ts', 'src/ui/view.ts'], files: 2, eligibleFiles: 9, truncated: true },
			// Then the nested project's source, then the file that is neither source nor test. Tests, docs, examples and fixtures wait.
			four: { indexed: ['aaa-plugins/alpha/src/plugin.ts', 'src/core/engine.ts', 'src/ui/view.ts', 'tools/release.ts'], files: 4, eligibleFiles: 9, truncated: true },
			roomy: { indexed: 9, files: 9, eligibleFiles: 9, truncated: false },
		});
	}));

	test('C7: the root .gitignore and the workspace\'s exclude patterns are honoured, for the build and for later updates; changing the patterns rebuilds the index', () => withTree({
		'.gitignore': ['# build output', 'generated/', '*.snap.ts', '/root-only.ts', '!kept-anyway.ts'].join('\n'),
		'src/app.ts': 'export const appword = 1;\n',
		'src/app.snap.ts': 'export const snapword = 1;\n',
		'src/root-only.ts': 'export const nestedrootonlyword = 1;\n',
		'root-only.ts': 'export const rootonlyword = 1;\n',
		'generated/client.ts': 'export const generatedword = 1;\n',
		'packages/a/generated/types.ts': 'export const nestedgeneratedword = 1;\n',
		'third_party/lib.ts': 'export const thirdpartyword = 1;\n',
	}, async (root, persistPath) => {
		const indexer = new OnyxWorkspaceIndexer(root, persistPath, { exclude: ['**/third_party/**'] });
		const built = await indexer.ensure();
		const afterBuild = indexer.indexedPaths();
		// A watcher reports changes to files that are excluded: they stay out.
		await fs.promises.writeFile(join(root, 'generated/client.ts'), 'export const generatedword = 2; // changed\n');
		await indexer.update(['generated/client.ts', 'third_party/lib.ts', 'src/app.ts']);
		const afterUpdate = indexer.indexedPaths();
		await indexer.flush();
		indexer.dispose();

		const same = new OnyxWorkspaceIndexer(root, persistPath, { exclude: ['**/third_party/**'] });
		const sameStats = await same.ensure();
		same.dispose();
		const widened = new OnyxWorkspaceIndexer(root, persistPath, { exclude: [] });
		const widenedStats = await widened.ensure();
		const widenedPaths = widened.indexedPaths();
		widened.dispose();

		assert.deepStrictEqual({
			afterBuild, eligible: built.eligibleFiles, afterUpdate,
			samePatterns: sameStats.source,
			otherPatterns: { source: widenedStats.source, paths: widenedPaths },
		}, {
			// `/root-only.ts` is anchored to the root: the file of that name under src/ is indexed.
			afterBuild: ['src/app.ts', 'src/root-only.ts'],
			eligible: 2,
			afterUpdate: ['src/app.ts', 'src/root-only.ts'],
			samePatterns: 'loaded',
			otherPatterns: { source: 'built', paths: ['src/app.ts', 'src/root-only.ts', 'third_party/lib.ts'] },
		});
	}));

	test('C7: a pattern that names a folder keeps what is under it out of later updates too; an edited .gitignore takes effect at the next use; the eligible count follows the tree', () => withTree({
		'.gitignore': 'scratch/\n',
		'src/app.ts': 'export const appword = 1;\n',
		'src/legacy/old.ts': 'export const legacyword = 1;\n',
		'vendored/lib/deep.ts': 'export const vendoredword = 1;\n',
		'scratch/notes.ts': 'export const scratchword = 1;\n',
	}, async (root, persistPath) => {
		// The way the workbench's own exclude settings are written: the folder, not what is under it.
		const indexer = new OnyxWorkspaceIndexer(root, persistPath, { exclude: ['**/vendored'] });
		const built = await indexer.ensure();
		const afterBuild = indexer.indexedPaths();

		await fs.promises.writeFile(join(root, 'src/added.ts'), 'export const addedword = 1;\n');
		await indexer.update(['vendored/lib/deep.ts', 'scratch/notes.ts', 'src/added.ts']);
		const afterUpdate = { paths: indexer.indexedPaths(), files: indexer.stats.files, eligibleFiles: indexer.stats.eligibleFiles };

		// The ignore file changes while the index is in use, and the watcher reports it.
		await fs.promises.writeFile(join(root, '.gitignore'), 'scratch/\nsrc/legacy/\n');
		await indexer.update(['.gitignore']);
		const afterIgnore = { finds: await paths(indexer, 'legacyword'), paths: indexer.indexedPaths(), source: indexer.stats.source, eligibleFiles: indexer.stats.eligibleFiles };
		indexer.dispose();

		assert.deepStrictEqual({ afterBuild, eligible: built.eligibleFiles, afterUpdate, afterIgnore }, {
			afterBuild: ['src/app.ts', 'src/legacy/old.ts'],
			eligible: 2,
			afterUpdate: { paths: ['src/added.ts', 'src/app.ts', 'src/legacy/old.ts'], files: 3, eligibleFiles: 3 },
			afterIgnore: { finds: [], paths: ['src/added.ts', 'src/app.ts'], source: 'built', eligibleFiles: 2 },
		});
	}));

	test('C7: the index is persisted a document to a line, so it is written and read a batch at a time; a file cut off part-way is rebuilt, not loaded', () => withTree({
		'src/alpha.ts': 'export const alphaword = 1;\n',
		'src/beta.ts': 'export const betaword = 2;\n',
		'src/gamma.ts': 'export const gammaword = 3;\n',
	}, async (root, persistPath) => {
		const first = new OnyxWorkspaceIndexer(root, persistPath, { maxFiles: 50 });
		await first.ensure();
		await first.flush();
		first.dispose();
		const written = await fs.promises.readFile(persistPath, 'utf8');
		const lines = written.split('\n').filter(line => line.length > 0);
		const header = JSON.parse(lines[0]) as { format: number; root: string; limits: { maxFiles: number }; exclusions: string[]; truncated: boolean; eligibleFiles: number };
		const documents = lines.slice(1).map(line => (JSON.parse(line) as [path: string, mtimeMs: number, size: number, length: number, terms: Record<string, number>]));
		const left = (await fs.promises.readdir(join(persistPath, '..'))).sort();

		// A write that stopped part-way: the last document's line is incomplete.
		await fs.promises.writeFile(persistPath, written.slice(0, written.length - 12));
		const second = new OnyxWorkspaceIndexer(root, persistPath, { maxFiles: 50 });
		const reloaded = await second.ensure();
		const found = await paths(second, 'gammaword');
		second.dispose();

		assert.deepStrictEqual({
			header: { format: header.format, rootIsRecorded: header.root === root, maxFiles: header.limits.maxFiles, exclusions: header.exclusions, truncated: header.truncated, eligibleFiles: header.eligibleFiles },
			documents: documents.map(([path, , size, length, terms]) => ({ path, size, length, terms: Object.keys(terms).length > 0 })),
			left,
			cutOff: { source: reloaded.source, files: reloaded.files, found },
		}, {
			header: { format: 3, rootIsRecorded: true, maxFiles: 50, exclusions: [], truncated: false, eligibleFiles: 3 },
			// One term each: the tokenizer drops the keywords and the digit.
			documents: [
				{ path: 'src/alpha.ts', size: 28, length: 1, terms: true },
				{ path: 'src/beta.ts', size: 27, length: 1, terms: true },
				{ path: 'src/gamma.ts', size: 28, length: 1, terms: true },
			],
			// The file is written beside itself and moved into place: nothing half-written is left behind.
			left: ['bm25.json'],
			cutOff: { source: 'built', files: 3, found: ['src/gamma.ts'] },
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
