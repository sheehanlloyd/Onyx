/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The Module 2 gate boxes that are about documents and tables, not behaviour:
 * `docs/SUPPORT.md` lists the tools the product can expose and records the
 * optional items as included, and no baseline exception is left for an
 * invariant this module owns.
 *
 *   node --test test/onyx/checks/module2-gate.test.mts
 *
 * Needs `pnpm run transpile-client` first: the tool contract is read from `out/`.
 */

import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const support = fs.readFileSync(path.join(repoRoot, 'docs', 'SUPPORT.md'), 'utf8');

/** A section of the document, from its heading to the next one of the same level. */
function section(heading: string): string {
	const start = support.indexOf(`\n## ${heading}`);
	assert.notEqual(start, -1, `docs/SUPPORT.md has no section "${heading}"`);
	const end = support.indexOf('\n## ', start + 1);
	return support.slice(start, end === -1 ? undefined : end);
}

/** The backticked names in the first cell of every table row of a text. */
function firstCellNames(text: string): string[] {
	return text.split('\n').filter(line => line.startsWith('| `')).flatMap(line => [...(line.split('|')[1] ?? '').matchAll(/`(?<name>[^`]+)`/g)].map(match => match.groups?.name ?? ''));
}

test('Module 2 gate: docs/SUPPORT.md lists exactly the tools the contract can expose, by default and with the network opt-in', async () => {
	const contractPath = path.join(repoRoot, 'out', 'vs', 'workbench', 'contrib', 'onyx', 'common', 'onyxToolContract.js');
	assert.equal(fs.existsSync(contractPath), true, 'run `pnpm run transpile-client` first');
	const contract = await import(pathToFileURL(contractPath).href) as { contractInventory(options: { networkTools: boolean }): string[] };
	const byDefault = contract.contractInventory({ networkTools: false });
	const withNetwork = contract.contractInventory({ networkTools: true });
	// The section lists what can be exposed, then what is excluded whatever the settings. Only the first part is the inventory.
	const contractSection = section('Tool capability contract');
	const excludedFrom = contractSection.indexOf('**Excluded, whatever the settings.**');
	assert.notEqual(excludedFrom, -1, 'the section no longer says where the excluded tools begin');
	const documented = firstCellNames(contractSection.slice(0, excludedFrom));
	assert.deepStrictEqual({
		contractHasTools: byDefault.length >= 6 && withNetwork.length > byDefault.length,
		exposedAndNotDocumented: withNetwork.filter(name => !documented.includes(name)),
		documentedAndNotExposed: documented.filter(name => !withNetwork.includes(name)),
	}, { contractHasTools: true, exposedAndNotDocumented: [], documentedAndNotExposed: [] });
});

test('Module 2 gate: docs/SUPPORT.md records C6 and C7 as included', () => {
	const states = Object.fromEntries(section('Optional feature states').split('\n')
		.map(line => /^\|\s*(?<item>[A-Z]\d{1,2})\b[^|]*\|\s*(?<state>planned|included|deferred)\s*\|/.exec(line)?.groups)
		.filter((groups): groups is { item: string; state: string } => !!groups)
		.map(groups => [groups.item, groups.state]));
	assert.deepStrictEqual({ C6: states.C6, C7: states.C7 }, { C6: 'included', C7: 'included' });
});

function moduleThreeGateRunsTheCampaign(): boolean {
	const gate = path.join(repoRoot, 'test', 'onyx', 'gates', 'module-3.json');
	if (!fs.existsSync(gate)) {
		return false;
	}
	const checks = (JSON.parse(fs.readFileSync(gate, 'utf8')) as { checks: { id: string; command?: string[] }[] }).checks;
	return checks.some(check => check.command?.includes('test/onyx/sim/run-campaign.mts') === true && check.command.includes('20000'));
}

test('Module 2 gate: no baseline exception is left for an invariant this module owns, and every one that is left has an owner in Module 3', () => {
	const table = JSON.parse(fs.readFileSync(path.join(repoRoot, 'test', 'onyx', 'sim', 'baseline-exceptions.json'), 'utf8')) as { exceptions: { class: string; owner: string }[] };
	// I-02, I-04, I-06, I-10, I-11 and I-14 whole; I-07 on the read side; I-13 for retained output. What I-13 says
	// about the size of a proposal is B7's, and what I-07 says about writes is Module 3's.
	const owned = (cls: string) => /^I-(02|04|06|10|11|14)\//.test(cls) || (cls.startsWith('I-07/') && !/write/.test(cls)) || (cls.startsWith('I-13/') && cls !== 'I-13/oversized-proposal');
	const moduleThree = new Set(['B6', 'B7', 'B8', 'B9', 'B10', 'C1', 'C2', 'C3', 'C8', 'C9', 'C10', 'L6', 'L7', 'L8']);
	assert.deepStrictEqual({
		stillOpenForThisModule: table.exceptions.map(exception => exception.class).filter(owned),
		ownedOutsideModuleThree: table.exceptions.filter(exception => !exception.owner.split(',').map(item => item.trim()).every(item => moduleThree.has(item))).map(exception => `${exception.class} (${exception.owner})`),
		// Module 2 left eight entries, all Module 3's. Module 3 empties the table (its gate requires that), and an
		// empty table is right only then: when Module 3's gate file is there and runs the campaign against it.
		emptyOnlyUnderModuleThreesGate: table.exceptions.length > 0 || moduleThreeGateRunsTheCampaign(),
	}, { stillOpenForThisModule: [], ownedOutsideModuleThree: [], emptyOnlyUnderModuleThreesGate: true });
});
