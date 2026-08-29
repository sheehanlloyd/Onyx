/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { parsePlaybook, renderPlaybookIndex, renderPlaybookInvocation } from '../../common/onyxPlaybooks.js';

const VALID = [
	'---',
	'name: upstream-merge',
	'description: Merge upstream safely',
	'when-to-use: When syncing with upstream',
	'tools: terminal, editFile',
	'model: qwen2.5-coder:14b',
	'---',
	'',
	'1. Read REBASE.md.',
	'2. Merge.',
].join('\n');

suite('OnyxPlaybooks', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('a valid playbook parses completely', () => {
		assert.deepStrictEqual(parsePlaybook(VALID), {
			playbook: {
				name: 'upstream-merge',
				description: 'Merge upstream safely',
				whenToUse: 'When syncing with upstream',
				tools: ['terminal', 'editFile'],
				modelHint: 'qwen2.5-coder:14b',
				body: '1. Read REBASE.md.\n2. Merge.',
			},
			problems: [],
		});
	});

	test('problem table: each malformation is named and unusable files yield no playbook', () => {
		const table: [source: string, expectUsable: boolean, problemHint: string][] = [
			['no frontmatter at all', false, 'missing frontmatter'],
			['---\nname: x\ndescription: d', false, 'unterminated'],
			['---\nname: Bad Name!\ndescription: d\n---\nbody', false, 'name:'],
			['---\nname: ok-name\n---\nbody', false, 'description: required'],
			['---\nname: ok-name\ndescription: d\n---\n', false, 'body after the frontmatter is empty'],
			['---\nname: ok-name\ndescription: d\nmystery: x\n---\nbody', true, 'unknown frontmatter key "mystery"'],
			['---\nname: ok-name\nname: twice\ndescription: d\n---\nbody', true, 'duplicate frontmatter key "name"'],
		];
		assert.deepStrictEqual(
			table.map(([source]) => {
				const parsed = parsePlaybook(source);
				return { usable: !!parsed.playbook, firstProblem: parsed.problems[0] ?? '' };
			}).map((result, i) => ({ usable: result.usable, mentions: result.firstProblem.includes(table[i][2]) })),
			table.map(([, expectUsable]) => ({ usable: expectUsable, mentions: true })),
		);
	});

	test('invocation frames the recipe and appends extra instructions', () => {
		const { playbook } = parsePlaybook(VALID);
		const text = renderPlaybookInvocation(playbook!, 'only do step 1');
		assert.ok(text.startsWith('Follow this repository playbook ("upstream-merge"):'));
		assert.ok(text.includes('1. Read REBASE.md.'));
		assert.ok(text.endsWith('Additional instructions for this run: only do step 1'));
	});

	test('the index is one line per playbook and absent when there are none', () => {
		const { playbook } = parsePlaybook(VALID);
		assert.strictEqual(renderPlaybookIndex([]), undefined);
		const index = renderPlaybookIndex([playbook!]);
		assert.ok(index!.includes('- upstream-merge: When syncing with upstream'));
	});
});
