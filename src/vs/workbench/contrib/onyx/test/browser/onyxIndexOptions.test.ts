/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { describeIndexCoverage, workspaceIndexOptions } from '../../common/onyxIndexOptions.js';

/**
 * C7: what the workbench tells the content index to cover, and what the
 * index's numbers are turned into for the reader of a search result.
 */
suite('OnyxIndexOptions', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('C7: the index leaves out what the explorer and the search leave out, and takes its file cap from the setting when that is a usable number', () => {
		assert.deepStrictEqual({
			fromSettings: workspaceIndexOptions(
				{ '**/.git': true, '**/generated': true, '**/*.js': { when: '$(basename).ts' }, '**/kept': false, '!**/generated/shown': true },
				{ '**/node_modules': true, '**/generated': true, '**/snapshots/**': true },
				30_000),
			noSettings: workspaceIndexOptions(undefined, undefined, undefined),
			caps: [12, 5_000_000, 'many', 2500.7, Number.NaN].map(value => workspaceIndexOptions({}, {}, value).maxFiles),
		}, {
			// Sorted and without repeats, so the same settings always describe the same index. A pattern that is
			// switched off is not applied; one that depends on a sibling file is not applied either; and one that
			// brings files back (`!`) is not an exclusion.
			fromSettings: { exclude: ['**/.git', '**/generated', '**/node_modules', '**/snapshots/**'], maxFiles: 30_000 },
			noSettings: { exclude: [], maxFiles: 20_000 },
			// Below the range, above it, not a number, a fraction, not a number at all.
			caps: [500, 100_000, 20_000, 2500, 20_000],
		});
	});

	test('C7: a search result says how much of the workspace the index holds whenever that is not all of it', () => {
		assert.deepStrictEqual([
			describeIndexCoverage({ files: 5000, eligibleFiles: 18_210, truncated: true }),
			describeIndexCoverage({ files: 18_210, eligibleFiles: 18_210, truncated: false }),
			// The walk itself was cut short: every file it listed is indexed, and there are more it never listed.
			describeIndexCoverage({ files: 9000, eligibleFiles: 9000, truncated: true }),
			describeIndexCoverage({ files: 0, eligibleFiles: 0, truncated: false }),
		], [
			'The content index holds 5000 of 18210 eligible files (27%): source folders first, tests and documentation last. A file it does not hold cannot be ranked.',
			undefined,
			'The content index holds 9000 files and the workspace has more than it could list. A file it does not hold cannot be ranked.',
			undefined,
		]);
	});
});
