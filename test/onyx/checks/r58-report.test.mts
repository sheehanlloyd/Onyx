/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * R-58 (L19): every table of docs/research/REPORT.md regenerates from committed data, and a number
 * in the report or in the README's Research section with no source fails the docs check.
 *
 *   node --test test/onyx/checks/r58-report.test.mts
 *
 * The first case runs the analyze-*.mts commands that make-report.mts runs by default, which import
 * compiled modules from `out/` and read task files from the repository's history. The other cases
 * work on temporary copies and run no analysis.
 */

import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const script = path.join(repoRoot, 'test', 'onyx', 'lab', 'make-report.mts');
const report = path.join(repoRoot, 'docs', 'research', 'REPORT.md');
const numbers = path.join(repoRoot, 'docs', 'research', 'data', 'numbers.json');

function check(args: readonly string[]): { exit: number | null; output: string } {
	const run = spawnSync(process.execPath, [script, '--check', ...args], { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
	return { exit: run.status, output: `${run.stdout}${run.stderr}` };
}

/** Runs the check on copies of the report, the numbers file and a README, each changed by the caller. */
function checkCopies(change: { report?: (text: string) => string; readme?: string }): { exit: number | null; output: string } {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'onyx-r58-'));
	try {
		const reportCopy = path.join(directory, 'REPORT.md');
		const numbersCopy = path.join(directory, 'numbers.json');
		const readmeCopy = path.join(directory, 'README.md');
		const original = fs.readFileSync(report, 'utf8');
		const changed = change.report ? change.report(original) : original;
		assert.ok(!change.report || changed !== original, 'the change to the copy of the report did not apply');
		fs.writeFileSync(reportCopy, changed);
		fs.copyFileSync(numbers, numbersCopy);
		fs.writeFileSync(readmeCopy, change.readme ?? '# A project\n\n## Research\n\nNothing is quoted here.\n\n## Build\n\nPort 65000 is not in the Research section.\n');
		return check(['--skip-analyses', '--report', reportCopy, '--numbers', numbersCopy, '--readme', readmeCopy]);
	} finally {
		fs.rmSync(directory, { recursive: true, force: true });
	}
}

test('R-58: the committed report, numbers and indexes are what the committed data gives, with the analyses run again', () => {
	const result = check([]);
	assert.deepStrictEqual({ exit: result.exit, said: /^make-report: checked \d+ numbers, \d+ tables and \d+ indexes; 11 of 12 analyses run/m.test(result.output) }, { exit: 0, said: true }, result.output);
});

test('R-58: unchanged copies pass, a changed number in a generated table fails, and an unsourced number in the prose or the README fails and is named', () => {
	const unchanged = checkCopies({});
	const table = checkCopies({ report: text => text.replace('| **3,739** |', '| **3,740** |') });
	const prose = checkCopies({ report: text => text.replace('## 1 Thesis\n', '## 1 Thesis\n\nA further 7,919 runs agreed with all of this.\n') });
	const readme = checkCopies({ readme: '# A project\n\n## Research\n\nThe harness is 87.5% better.\n\n## Build\n' });
	assert.deepStrictEqual({
		unchanged: unchanged.exit,
		table: { exit: table.exit, said: /REPORT\.md: a generated table is not what the committed data gives/.test(table.output) },
		prose: { exit: prose.exit, named: /REPORT\.md:\d+: 7,919 has no source in numbers\.json/.test(prose.output) },
		readme: { exit: readme.exit, named: /README\.md:\d+: 87\.5% has no source in numbers\.json/.test(readme.output) },
	}, {
		unchanged: 0,
		table: { exit: 1, said: true },
		prose: { exit: 1, named: true },
		readme: { exit: 1, named: true },
	}, [unchanged.output, table.output, prose.output, readme.output].join('\n---\n'));
});
