/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	aggregateModules, chooseGranularity, extractImportSpecifiers, moduleOf, resolveRelativeImport
} from '../../../../../platform/onyxRuntime/common/onyxArchitecture.js';

suite('OnyxArchitecture', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('module assignment and granularity adapt to the tree shape', () => {
		assert.deepStrictEqual({
			root: moduleOf('index.ts', 2),
			shallow: moduleOf('src/app.ts', 2),
			deep: moduleOf('src/vs/workbench/contrib/onyx/browser/x.ts', 2),
			flatRepo: chooseGranularity(['a/x.ts', 'b/y.ts', 'c/z.ts'], 24),
			deepRepo: chooseGranularity(Array.from({ length: 60 }, (_, i) => `src/vs/mod${i % 30}/sub/file${i}.ts`), 24),
		}, {
			root: '.',
			shallow: 'src',
			deep: 'src/vs',
			flatRepo: 4,      // deepening never reaches 24 modules; the walk stops at max depth
			deepRepo: 3,      // src/vs/modN reaches the target at depth 3
		});
	});

	test('import resolution: relative paths resolve, bare packages and escapes do not', () => {
		assert.deepStrictEqual({
			sibling: resolveRelativeImport('src/a/b.ts', './c.js'),
			parent: resolveRelativeImport('src/a/b.ts', '../lib/util'),
			bare: resolveRelativeImport('src/a/b.ts', 'lodash'),
			escape: resolveRelativeImport('a.ts', '../../outside'),
		}, {
			sibling: 'src/a/c.js',
			parent: 'src/lib/util',
			bare: undefined,
			escape: undefined,
		});
	});

	test('import extraction covers the common forms across languages', () => {
		const source = [
			`import { x } from './a.js';`,
			`import * as fs from 'fs';`,
			`const y = require('./b');`,
			`await import('./lazy.js');`,
			`import './side-effect.js';`,
			`from ..utils import helper`,
		].join('\n');
		assert.deepStrictEqual(extractImportSpecifiers(source).sort(), ['./a.js', './b', './lazy.js', './side-effect.js', '..utils', 'fs'].sort());
	});

	test('aggregation: edges, fan-in, churn and heat land on the right modules', () => {
		const files = [
			{ path: 'core/a.ts', lines: 100, imports: [] },
			{ path: 'core/b.ts', lines: 50, imports: [] },
			{ path: 'ui/view.ts', lines: 200, imports: ['core/a.ts', 'core/b.ts'] },
			{ path: 'cli/main.ts', lines: 30, imports: ['core/a.ts'] },
		];
		const churn = new Map([['ui/view.ts', 9], ['core/a.ts', 3]]);
		const result = aggregateModules(files, 1, churn);
		assert.deepStrictEqual(result.modules.map(module => ({
			id: module.id,
			fanIn: module.fanIn,
			churn: module.churnCommits,
			deps: module.dependencies,
		})), [
			{ id: 'ui', fanIn: 0, churn: 9, deps: [{ to: 'core', count: 2 }] },
			{ id: 'core', fanIn: 2, churn: 3, deps: [] },
			{ id: 'cli', fanIn: 0, churn: 0, deps: [{ to: 'core', count: 1 }] },
		]);
		assert.strictEqual(result.totalFiles, 4);
		// ui is the hottest (churn-heavy), core second (fan-in).
		assert.ok(result.modules[0].heat >= result.modules[1].heat);
	});
});
