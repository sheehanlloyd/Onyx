/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * L14: the three lab-only comparator appliers do what the study says they
 * do, on files where the right answer is known, including the cases in
 * which each is silently wrong, which is what the study counts. And nothing
 * under `src/` imports them.
 *
 *   node --test test/onyx/checks/l14-appliers.test.mts
 */

import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { fuzzy, FUZZY_THRESHOLD, lineSimilarity, uniqueFirstLine, whitespaceInsensitive } from '../lab/appliers.mts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const FILE = ['function total(values) {', '\tlet sum = 0;', '\tfor (const value of values) {', '\t\tsum += value;', '\t}', '\treturn sum;', '}', '', 'function count(values) {', '\treturn values.length;', '}'].join('\n');

test('L14: each comparator places what it is described to place, refuses what it should, and is wrong where the study says it can be', () => {
	const exact = { search: '\treturn sum;', replace: '\treturn sum / 2;' };
	const reindented = { search: '    return sum;', replace: '    return sum / 2;' };
	// The model misquotes the second line; the first line is unique in the file.
	const misquoted = { search: '\tfor (const value of values) {\n\t\tsum = sum + value;', replace: '\tfor (const value of values) {\n\t\tsum += value * 2;' };
	// One character off in one line of three.
	const nearly = { search: '\tlet sum = 0;\n\tfor (const value of valuez) {\n\t\tsum += value;', replace: '\tlet sum = 1;\n\tfor (const value of values) {\n\t\tsum += value;' };
	const absent = { search: 'const nothing = like(this);\nanywhere();', replace: 'x' };
	const changed = (result: string | undefined) => result === undefined ? 'refused' : result.split('\n').flatMap((line, index) => line !== FILE.split('\n')[index] ? [index + 1] : []).join(',');
	assert.deepStrictEqual({
		whitespace: [changed(whitespaceInsensitive(FILE, exact)), changed(whitespaceInsensitive(FILE, reindented)), changed(whitespaceInsensitive(FILE, misquoted)), changed(whitespaceInsensitive(FILE, absent))],
		// Placed by its first line alone: the misquoted second line is replaced all the same, which is the silent error.
		firstLine: [changed(uniqueFirstLine(FILE, exact)), changed(uniqueFirstLine(FILE, misquoted)), changed(uniqueFirstLine(FILE, { search: '}', replace: '};' })), changed(uniqueFirstLine(FILE, absent))],
		fuzzy: [changed(fuzzy(FILE, exact)), changed(fuzzy(FILE, nearly)), changed(fuzzy(FILE, absent))],
		similarity: [lineSimilarity('abc', 'abc'), lineSimilarity('abc', 'xyz'), lineSimilarity('return sum;', 'return sums;') > FUZZY_THRESHOLD],
		theReindentedReplacementKeepsTheModelsIndentation: whitespaceInsensitive(FILE, reindented)?.split('\n')[5],
	}, {
		whitespace: ['6', '6', 'refused', 'refused'],
		firstLine: ['6', '4', 'refused', 'refused'],
		fuzzy: ['6', '2', 'refused'],
		similarity: [1, 0, true],
		theReindentedReplacementKeepsTheModelsIndentation: '    return sum / 2;',
	});
});

test('L14: the comparators are lab-only: no file under src/ names them', () => {
	const found = (() => {
		try {
			return execFileSync('git', ['-C', repoRoot, 'grep', '-l', '-E', 'lab/appliers|whitespaceInsensitive|uniqueFirstLine', '--', 'src'], { encoding: 'utf8' }).trim();
		} catch {
			return '';
		}
	})();
	assert.equal(found, '');
});
