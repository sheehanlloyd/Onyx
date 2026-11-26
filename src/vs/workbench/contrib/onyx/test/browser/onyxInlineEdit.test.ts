/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { applyEditBlocks, describeEditRefusal, computeLineHunks, IOnyxEditHunk, ONYX_DIFF_MAX_DIFFERING_LINES, parseInlineEdits } from '../../common/onyxInlineEdit.js';

suite('OnyxInlineEdit', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('parseInlineEdits', () => {

		test('a well-formed block parses exactly', () => {
			const parsed = parseInlineEdits('<<<<<<< SEARCH\nlet a = 1;\n=======\nconst a = 1;\n>>>>>>> REPLACE');
			assert.deepStrictEqual(parsed, { kind: 'blocks', blocks: [{ search: 'let a = 1;', replace: 'const a = 1;' }] });
		});

		test('marker sloppiness is tolerated: short markers, no REPLACE label, wrapping fence', () => {
			const reply = [
				'```ts',
				'<<<< SEARCH',
				'foo();',
				'====',
				'bar();',
				'>>>>',
				'```',
			].join('\n');
			assert.deepStrictEqual(parseInlineEdits(reply), { kind: 'blocks', blocks: [{ search: 'foo();', replace: 'bar();' }] });
		});

		test('multiple blocks, including one opened before the previous closed', () => {
			const reply = [
				'<<<<<<< SEARCH', 'a;', '=======', 'A;', '>>>>>>> REPLACE',
				'<<<<<<< SEARCH', 'b;', '=======', 'B;',
				'<<<<<<< SEARCH', 'c;', '=======', 'C;', '>>>>>>> REPLACE',
			].join('\n');
			const parsed = parseInlineEdits(reply);
			assert.deepStrictEqual(parsed, {
				kind: 'blocks', blocks: [
					{ search: 'a;', replace: 'A;' },
					{ search: 'b;', replace: 'B;' },
					{ search: 'c;', replace: 'C;' },
				]
			});
		});

		test('a truncated final block keeps its partial replacement', () => {
			const parsed = parseInlineEdits('<<<<<<< SEARCH\nold();\n=======\nnew(');
			assert.deepStrictEqual(parsed, { kind: 'blocks', blocks: [{ search: 'old();', replace: 'new(' }] });
		});

		test('markers echoed inside the reply never reach the buffer', () => {
			// Observed live from qwen2.5-coder:1.5b: it repeats the format inside
			// its own replacement, which used to write the markers into the file.
			const reply = [
				'<<<<<<< SEARCH',
				'export function subtotal(items: Item[]): number {',
				'=======',
				'<<<<<<< SEARCH',
				'export function subtotal(items: Item[]): number {',
				'\treturn items.reduce((a, i) => a + i.price, 0);',
				'>>>>>>> REPLACE',
				'>>>>>>> REPLACE',
			].join('\n');
			const parsed = parseInlineEdits(reply);
			assert.ok(parsed.kind === 'blocks');
			const bodies = parsed.blocks.flatMap(block => [block.search, block.replace]).join('\n');
			assert.deepStrictEqual(
				{ hasSearchMarker: bodies.includes('<<<'), hasReplaceMarker: bodies.includes('>>>'), keepsCode: bodies.includes('reduce') },
				{ hasSearchMarker: false, hasReplaceMarker: false, keepsCode: true });
		});

		test('a reply with no divider becomes a rewrite, markers stripped', () => {
			// llama3.2:3b does exactly this every time: it emits both markers and
			// puts only the NEW code between them, with no `=======`. Before this
			// was handled, the markers were pasted into the user's file.
			const reply = [
				'<<<<<<< SEARCH',
				'export function applyDiscount(items: Item[], percent: number): number {',
				'\treturn items.reduce((total, item) => total + item.price, 0) * (1 - percent / 100);',
				'}',
				'>>>>>>> REPLACE',
			].join('\n');
			const parsed = parseInlineEdits(reply);
			assert.ok(parsed.kind === 'rewrite');
			assert.deepStrictEqual(
				{ leaksMarkers: /<{4,}|>{4,}/.test(parsed.text), keepsCode: parsed.text.includes('reduce'), startsClean: parsed.text.startsWith('export function') },
				{ leaksMarkers: false, keepsCode: true, startsClean: true });
		});

		test('a fenced reply without markers is a whole-selection rewrite', () => {
			const parsed = parseInlineEdits('```python\ndef f():\n    return 2\n```');
			assert.deepStrictEqual(parsed, { kind: 'rewrite', text: 'def f():\n    return 2' });
		});

		test('bare code without markers is a rewrite; prose is unparseable', () => {
			assert.deepStrictEqual([
				parseInlineEdits('const x = compute();\nreturn x;').kind,
				parseInlineEdits('I cannot help with that request because it is unclear.').kind,
				parseInlineEdits('').kind,
			], ['rewrite', 'unparseable', 'unparseable']);
		});
	});

	suite('computeLineHunks', () => {

		test('changes group into hunks with originals preserved', () => {
			const hunks = computeLineHunks('a\nb\nc\nd', 'a\nB\nc\nd\ne');
			assert.deepStrictEqual(hunks, [
				{ originalStart: 1, originalLength: 1, newLines: ['B'], originalLines: ['b'] },
				{ originalStart: 4, originalLength: 0, newLines: ['e'], originalLines: [] },
			]);
		});

		test('identical texts produce no hunks; a full rewrite produces one', () => {
			assert.deepStrictEqual([
				computeLineHunks('x\ny', 'x\ny'),
				computeLineHunks('x', 'completely\ndifferent').length,
			], [[], 1]);
		});

		/** The base with every hunk applied. */
		const applyAll = (base: string, hunks: readonly IOnyxEditHunk[]): string => {
			const lines = base.split('\n');
			for (const hunk of [...hunks].reverse()) {
				lines.splice(hunk.originalStart, hunk.originalLength, ...hunk.newLines);
			}
			return lines.join('\n');
		};
		/** The length of a longest common subsequence, by the table the diff used to build: the reference for "shortest". */
		const lcsLength = (a: readonly string[], b: readonly string[]): number => {
			let previous = new Array<number>(b.length + 1).fill(0);
			for (let i = 1; i <= a.length; i++) {
				const row = new Array<number>(b.length + 1).fill(0);
				for (let j = 1; j <= b.length; j++) {
					row[j] = a[i - 1] === b[j - 1] ? previous[j - 1] + 1 : Math.max(previous[j], row[j - 1]);
				}
				previous = row;
			}
			return previous[b.length];
		};

		test('R-29 (C9): on 2,000 random pairs of texts full of repeated lines, the hunks reproduce the other text, are a shortest edit script, are in order, never touch, and keep the original lines', () => {
			let seed = 29;
			const random = (bound: number) => (seed = (seed * 1103515245 + 12345) % 2147483648) % bound;
			const failures: string[] = [];
			for (let round = 0; round < 2000 && failures.length < 3; round++) {
				// A small alphabet, so lines repeat and there are many equally short scripts to choose among.
				// At least one line: a text of no lines does not exist, the empty text is one empty line.
				const text = () => Array.from({ length: 1 + random(14) }, () => 'line ' + 'abcd'[random(4)]);
				const a = text();
				// Half the pairs are an edit of the first text, half are unrelated.
				const edited = a.flatMap(line => random(4) === 0 ? [] : random(4) === 0 ? [line, 'line ' + 'abcd'[random(4)]] : [line]);
				const b = round % 2 === 0 && edited.length > 0 ? edited : text();
				const hunks = computeLineHunks(a.join('\n'), b.join('\n'));
				const changed = hunks.reduce((total, hunk) => total + hunk.originalLength + hunk.newLines.length, 0);
				const problems = [
					applyAll(a.join('\n'), hunks) === b.join('\n') ? undefined : 'does not reproduce the text',
					changed === a.length + b.length - 2 * lcsLength(a, b) ? undefined : `changes ${changed} lines where ${a.length + b.length - 2 * lcsLength(a, b)} are enough`,
					hunks.every((hunk, index) => index === 0 || hunk.originalStart > hunks[index - 1].originalStart + hunks[index - 1].originalLength) ? undefined : 'hunks touch or are out of order',
					hunks.every(hunk => hunk.originalLines.join('\n') === a.slice(hunk.originalStart, hunk.originalStart + hunk.originalLength).join('\n') && hunk.originalLength + hunk.newLines.length > 0) ? undefined : 'a hunk misstates the lines it replaces',
				].filter(problem => problem !== undefined);
				if (problems.length) {
					failures.push(`${JSON.stringify(a)} -> ${JSON.stringify(b)}: ${problems.join('; ')}`);
				}
			}
			assert.deepStrictEqual(failures, []);
		});

		test('R-29 (C9): more differing lines than the search looks for come back as one hunk over the changed region, still a correct diff; one fewer is still searched', () => {
			const lines = (count: number, name: string) => Array.from({ length: count }, (_, index) => `${name} ${index}`);
			const half = ONYX_DIFF_MAX_DIFFERING_LINES / 2;
			// The same first and last line, and between them nothing in common, with one shared line in the middle.
			const pair = (each: number) => ({
				a: ['first', ...lines(each, 'old'), 'shared', ...lines(each, 'old again'), 'last'].join('\n'),
				b: ['first', ...lines(each, 'new'), 'shared', ...lines(each, 'new again'), 'last'].join('\n'),
			});
			const within = pair(half / 2);
			const beyond = pair(half / 2 + 1);
			const describe = (texts: { a: string; b: string }) => {
				const hunks = computeLineHunks(texts.a, texts.b);
				return { hunks: hunks.map(hunk => [hunk.originalStart, hunk.originalLength, hunk.newLines.length]), reproduces: applyAll(texts.a, hunks) === texts.b };
			};
			assert.deepStrictEqual({ within: describe(within), beyond: describe(beyond) }, {
				// Exactly the bound in differing lines: the shared line in the middle is found, two hunks.
				within: { hunks: [[1, half / 2, half / 2], [half / 2 + 2, half / 2, half / 2]], reproduces: true },
				// Four more: one hunk from the line after `first` to the line before `last`.
				beyond: { hunks: [[1, half + 3, half + 3]], reproduces: true },
			});
		});
	});

	suite('applyEditBlocks', () => {

		const original = [
			'function greet(name) {',
			'\tconst count = add(1, 2);',
			'\treturn `Hello ${name}`;',
			'}',
		].join('\n');

		test('exact match applies in place', () => {
			const applied = applyEditBlocks(original, [{ search: '\treturn `Hello ${name}`;', replace: '\treturn `Hi ${name}`;' }]);
			assert.deepStrictEqual(
				{ appliedCount: applied.appliedCount, failed: applied.failed, hasNew: applied.text.includes('Hi ${name}') },
				{ appliedCount: 1, failed: [], hasNew: true });
		});

		test('R-33: whitespace drift is refused, not repaired: the text is unchanged and the refusal says what was not found', () => {
			// The model claimed 4-space indentation; the file uses tabs. Before B6 this was matched after trimming and re-indented.
			const block = { search: '    const count = add(1, 2);', replace: '    const count = add(2, 3);' };
			const applied = applyEditBlocks(original, [block]);
			assert.deepStrictEqual(
				{ text: applied.text, appliedCount: applied.appliedCount, failed: applied.failed, refusals: applied.refusals.map(refusal => ({ reason: refusal.reason, occurrences: refusal.occurrences, firstUnmatchedLine: refusal.firstUnmatchedLine })) },
				{ text: original, appliedCount: 0, failed: [block], refusals: [{ reason: 'missing', occurrences: 0, firstUnmatchedLine: '    const count = add(1, 2);' }] });
		});

		test('R-07: a SEARCH whose first line is unique and whose next line is not in the file is refused, naming the first unmatched line', () => {
			// Before B6 the unique first line anchored the block and two lines the model never quoted were replaced.
			const block = { search: '\tconst count = add(1, 2);\n\tlet unrelated = 0;', replace: '\tconst count = 3;\n\tlet unrelated = 0;' };
			const applied = applyEditBlocks(original, [block]);
			assert.deepStrictEqual(
				{ text: applied.text, appliedCount: applied.appliedCount, refusal: { reason: applied.refusals[0]?.reason, firstUnmatchedLine: applied.refusals[0]?.firstUnmatchedLine }, message: applied.refusals[0] ? describeEditRefusal(applied.refusals[0]) : '' },
				{ text: original, appliedCount: 0, refusal: { reason: 'missing', firstUnmatchedLine: '\tlet unrelated = 0;' }, message: 'The "search" text is not in the file exactly as quoted. The first line that does not match is line 2 of it: "\\tlet unrelated = 0;". Nothing was changed. Quote the lines exactly as they are in the file, including indentation.' });
		});

		test('R-08: a SEARCH that occurs at two places is refused as ambiguous, whichever comes first', () => {
			const twice = 'function a() {\n\treturn value;\n}\n\nfunction b() {\n\treturn value;\n}';
			const applied = applyEditBlocks(twice, [{ search: '\treturn value;', replace: '\treturn other;' }]);
			const overlapping = applyEditBlocks('aaa', [{ search: 'aa', replace: 'b' }]);
			assert.deepStrictEqual(
				{ text: applied.text, appliedCount: applied.appliedCount, refusal: { reason: applied.refusals[0]?.reason, occurrences: applied.refusals[0]?.occurrences }, message: applied.refusals[0] ? describeEditRefusal(applied.refusals[0]) : '', overlapping: { text: overlapping.text, reason: overlapping.refusals[0]?.reason } },
				{ text: twice, appliedCount: 0, refusal: { reason: 'ambiguous', occurrences: 2 }, message: 'The "search" text occurs 2 times in the file, so it does not say which place to change. Nothing was changed. Quote more of the surrounding lines so that the text occurs exactly once: for a closing "}", quote the line before it as well.', overlapping: { text: 'aaa', reason: 'ambiguous' } });
		});

		test('a SEARCH that differs from the file only in indentation is refused, and the refusal says how the file indents (2026-11-26)', () => {
			const file = 'export function addNumbers(a: number, b: number): number {\n\treturn a + b;\n}\n';
			const applied = applyEditBlocks(file, [{ search: '  return a + b;\n}', replace: '  return a + b;\n}\n\nexport const x = 1;' }]);
			assert.deepStrictEqual({ text: applied.text, appliedCount: applied.appliedCount, indentation: applied.refusals[0]?.indentationDiffers, message: applied.refusals[0] ? describeEditRefusal(applied.refusals[0]) : '' }, {
				text: file, appliedCount: 0, indentation: { fileIndents: 'tabs' },
				message: 'The "search" text is in the file only with different indentation: the file indents these lines with tabs. Nothing was changed. Quote the lines exactly as the file has them, tabs included, and indent the new lines the same way.',
			});
		});

		test('R-33: indentation in Python and YAML, tabs against spaces, trailing spaces, whitespace inside a multiline string and line endings are never normalized to make a match', () => {
			const python = 'def total(values):\n    result = 0\n    for value in values:\n        result += value\n    return result\n';
			const yaml = 'services:\n  web:\n    image: app\n  db:\n    image: postgres\n';
			const literal = 'const text = `first line\n   indented in the string\nlast`;\n';
			const nested = 'class Sum:\n    def total(self, values):\n        result = 0\n        for value in values:\n            result += value\n        return result\n';
			const cases: Record<string, { text: string; search: string; replace?: string }> = {
				// One level less than the file has, on every line.
				pythonIndentation: { text: nested, search: '    for value in values:\n        result += value' },
				// One line, under-indented, with a replacement of two lines: the second would land a level out.
				pythonFirstLineOnly: { text: nested, search: '        result += value', replace: '        result += value\n        count += 1' },
				yamlIndentation: { text: yaml, search: 'web:\n  image: app' },
				tabsForSpaces: { text: python, search: '\tresult = 0' },
				trailingSpaces: { text: python, search: '    result = 0  \n    for value in values:' },
				trailingSpacesInTheFile: { text: 'a = 1  \nb = 2\n', search: 'a = 1\nb = 2' },
				multilineString: { text: literal, search: 'first line\nindented in the string' },
				crlfQuotedAgainstLf: { text: python, search: '    result = 0\r\n    for value in values:' },
				lfQuotedAgainstCrlf: { text: python.replace(/\n/g, '\r\n'), search: '    result = 0\n    for value in values:' },
			};
			const outcomes = Object.fromEntries(Object.entries(cases).map(([name, { text, search, replace }]) => {
				const applied = applyEditBlocks(text, [{ search, replace: replace ?? 'REPLACED' }]);
				return [name, { unchanged: applied.text === text, applied: applied.appliedCount, reason: applied.refusals[0]?.reason, lineEndings: applied.refusals[0]?.lineEndingsDiffer === true }];
			}));
			const refused = () => ({ unchanged: true, applied: 0, reason: 'missing', lineEndings: false });
			assert.deepStrictEqual(outcomes, {
				pythonIndentation: refused(), pythonFirstLineOnly: refused(), yamlIndentation: refused(), tabsForSpaces: refused(), trailingSpaces: refused(), trailingSpacesInTheFile: refused(), multilineString: refused(),
				// Refused the same way, and the refusal says the difference is the line endings.
				crlfQuotedAgainstLf: { ...refused(), lineEndings: true }, lfQuotedAgainstCrlf: { ...refused(), lineEndings: true },
			});
		});

		test('a quote that begins in the middle of a line is an exact match: the characters quoted are replaced and the rest of the line, its indentation included, stays', () => {
			const python = 'for value in values:\n        result += value\n';
			const applied = applyEditBlocks(python, [{ search: 'result += value', replace: 'result += 2 * value' }]);
			assert.deepStrictEqual({ text: applied.text, appliedCount: applied.appliedCount }, { text: 'for value in values:\n        result += 2 * value\n', appliedCount: 1 });
		});

		test('an exact SEARCH keeps the file\'s own bytes around it: CRLF line endings, tabs and trailing spaces outside the match are untouched', () => {
			const crlf = 'one\r\n\ttwo  \r\nthree\r\n';
			const applied = applyEditBlocks(crlf, [{ search: '\ttwo  ', replace: '\tTWO' }]);
			assert.deepStrictEqual({ text: applied.text, appliedCount: applied.appliedCount }, { text: 'one\r\n\tTWO\r\nthree\r\n', appliedCount: 1 });
		});

		test('an unlocatable block is reported, not guessed', () => {
			const block = { search: 'this text exists nowhere', replace: 'x' };
			const applied = applyEditBlocks(original, [block]);
			assert.deepStrictEqual(
				{ text: applied.text, appliedCount: applied.appliedCount, failed: applied.failed },
				{ text: original, appliedCount: 0, failed: [block] });
		});

		test('later blocks apply against the result of earlier ones', () => {
			const applied = applyEditBlocks('a\nb\nc', [
				{ search: 'b', replace: 'B' },
				{ search: 'B\nc', replace: 'B\nC' },
			]);
			assert.deepStrictEqual({ text: applied.text, appliedCount: applied.appliedCount }, { text: 'a\nB\nC', appliedCount: 2 });
		});

		test('an empty SEARCH never applies', () => {
			const applied = applyEditBlocks('a', [{ search: '', replace: 'x' }]);
			assert.deepStrictEqual({ appliedCount: applied.appliedCount, failedCount: applied.failed.length }, { appliedCount: 0, failedCount: 1 });
		});
	});
});
