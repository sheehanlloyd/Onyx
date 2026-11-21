/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { runWithFakedTimers } from '../../../../../base/test/common/timeTravelScheduler.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { decodeNumberedSearch, formatNumberedLines, ONYX_GREP_MAX_MATCHES, ONYX_GREP_MAX_MATCHES_PER_FILE, ONYX_READ_FILE_MAX_BYTES, ONYX_READ_FILE_MAX_LINES, replacementCarriesNumbering, resolveLineRange, splitLines } from '../../common/onyxReadTools.js';
import { workspacePathProblem } from '../../common/onyxWorkspacePaths.js';
import { SIM_OUTSIDE_CANARY } from './sim/onyxSimCanary.js';
import { OnyxSimEpisode, SIM_FILES, SIM_TARGET_FILE } from './sim/onyxSimEpisode.js';
import { OnyxSimRig } from './sim/onyxSimRig.js';

/**
 * B1: Onyx's own read-side tools. The pure half is the numbered read format
 * and its one decoder (R-24). The service half drives the real tools in the
 * simulation rig over an in-memory disk with the real exclude and ignore-file
 * handling: limits and refusals, and the read side of containment (R-30).
 */

const SOURCE = [
	'function total(values) {',
	'\tlet sum = 0;',
	'\tfor (const value of values) {',
	'\t\tsum += value;',
	'\t}',
	'\treturn sum;',
	'}',
	'',
].join('\n');

function episode(files: Record<string, string>): OnyxSimEpisode {
	return { name: 'read-tools', seed: 0, persona: 'well-behaved', prompt: 'read', files: { ...SIM_FILES, ...files }, target: SIM_TARGET_FILE, turns: [], dialogDefault: 'deny', userSteps: [], faults: [] };
}

/** Runs `body` against a prepared rig under virtual time and disposes it. */
async function withRig<T>(files: Record<string, string>, body: (rig: OnyxSimRig) => Promise<T>): Promise<T> {
	return runWithFakedTimers({ useFakeTimers: true, maxTaskCount: 200_000 }, async () => {
		const rig = new OnyxSimRig(episode(files));
		try {
			await rig.prepare();
			return await body(rig);
		} finally {
			await rig.dispose();
		}
	});
}

suite('OnyxReadTools', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('R-24: a numbered SEARCH is decoded only when it is the read result of those lines; literal source that looks numbered is left alone', () => {
		const numbered = formatNumberedLines(splitLines(SOURCE).slice(1, 4), 2);
		const literal = 'const table = `\n12| not a line number\n13| just text\n`;\n';
		assert.deepStrictEqual({
			format: numbered,
			// The tool's own wrapper for lines 2 to 4: decoded to the exact source, tabs and all.
			decoded: decodeNumberedSearch(numbered, SOURCE),
			// Exact source is tried first, so source text that resembles the wrapper is never stripped.
			literalSource: decodeNumberedSearch('12| not a line number\n13| just text', literal),
			// Not shaped like a read result: the caller's normal matching decides.
			plain: decodeNumberedSearch('\tlet sum = 0;', 'something else entirely'),
			mixed: decodeNumberedSearch('2| \tlet sum = 0;\n\tfor (const value of values) {', 'nothing here'),
			// Shaped like one, but not the file: refused, never guessed.
			wrongContent: decodeNumberedSearch('2| \tlet sum = 1;', SOURCE).kind,
			wrongIndentation: decodeNumberedSearch('2| let sum = 0;', SOURCE).kind,
			wrongLineNumber: decodeNumberedSearch('3| \tlet sum = 0;', SOURCE).kind,
			notConsecutive: decodeNumberedSearch('2| \tlet sum = 0;\n4| \t\tsum += value;', SOURCE).kind,
			pastTheEnd: decodeNumberedSearch('40| }', SOURCE).kind,
			emptyLineKeepsItsNumber: decodeNumberedSearch('7| }\n8|', `${SOURCE}\ntail\n`).kind,
			replacementNumbered: replacementCarriesNumbering('2| \tlet sum = 1;\n3| \tfor (const value of values) {', 2),
			replacementPlain: replacementCarriesNumbering('\tlet sum = 1;', 2),
		}, {
			format: '2| \tlet sum = 0;\n3| \tfor (const value of values) {\n4| \t\tsum += value;',
			decoded: { kind: 'decoded', text: '\tlet sum = 0;\n\tfor (const value of values) {\n\t\tsum += value;', startLine: 2, endLine: 4 },
			literalSource: { kind: 'exact' },
			plain: { kind: 'plain' },
			mixed: { kind: 'plain' },
			wrongContent: 'refused',
			wrongIndentation: 'refused',
			wrongLineNumber: 'refused',
			notConsecutive: 'refused',
			pastTheEnd: 'refused',
			emptyLineKeepsItsNumber: 'decoded',
			replacementNumbered: true,
			replacementPlain: false,
		});
	});

	test('line ranges are 1-based and inclusive, clamp at the end of the file, clip at the per-call cap and reject nonsense', () => {
		assert.deepStrictEqual({
			whole: resolveLineRange(7, undefined, undefined),
			middle: resolveLineRange(7, 3, 5),
			pastEnd: resolveLineRange(7, 5, 500),
			clipped: resolveLineRange(1000, 1, undefined),
			startPastEnd: resolveLineRange(7, 9, undefined).ok,
			inverted: resolveLineRange(7, 5, 2).ok,
			zero: resolveLineRange(7, 0, undefined).ok,
			fraction: resolveLineRange(7, 1.5, undefined).ok,
			lines: splitLines('a\r\nb\n\nc\n'),
		}, {
			whole: { ok: true, startLine: 1, endLine: 7, totalLines: 7, clipped: false },
			middle: { ok: true, startLine: 3, endLine: 5, totalLines: 7, clipped: false },
			pastEnd: { ok: true, startLine: 5, endLine: 7, totalLines: 7, clipped: false },
			clipped: { ok: true, startLine: 1, endLine: ONYX_READ_FILE_MAX_LINES, totalLines: 1000, clipped: true },
			startPastEnd: false,
			inverted: false,
			zero: false,
			fraction: false,
			lines: ['a', 'b', '', 'c'],
		});
	});

	test('R-30, read side: a path that could leave the workspace is refused before anything is resolved', () => {
		assert.deepStrictEqual(
			['../secret', 'src/../../secret', '/etc/passwd', '~/.ssh/id_rsa', 'C:\\Windows\\win.ini', 'src\\math.ts', 'a..b.ts', 'src/math.ts', '.', ''].map(path => [path, workspacePathProblem(path) === undefined]),
			[['../secret', false], ['src/../../secret', false], ['/etc/passwd', false], ['~/.ssh/id_rsa', false], ['C:\\Windows\\win.ini', false], ['src\\math.ts', false], ['a..b.ts', false], ['src/math.ts', true], ['.', true], ['', true]]);
	});

	test('readFile: numbered lines, ranges, the live buffer, and refusals that name the limit', async () => {
		const outcome = await withRig({ 'big.txt': 'x'.repeat(ONYX_READ_FILE_MAX_BYTES + 1), 'long.txt': Array.from({ length: ONYX_READ_FILE_MAX_LINES + 50 }, (_, index) => `line ${index + 1}`).join('\n'), 'image.bin': 'PNG\u0000\u0001\u0002', 'empty.txt': '' }, async rig => {
			const whole = await rig.invokeTool('readFile', { path: 'src/util.ts' });
			const range = await rig.invokeTool('readFile', { path: 'src/math.ts', startLine: 2, endLine: 3 });
			const long = await rig.invokeTool('readFile', { path: 'long.txt' });
			await rig.typeInto(SIM_TARGET_FILE, 1, '// typed and not saved\n');
			const live = await rig.invokeTool('readFile', { path: SIM_TARGET_FILE, startLine: 1, endLine: 1 });
			const refusals: Record<string, { ok: boolean; text: string }> = {};
			for (const [name, parameters] of Object.entries({
				tooBig: { path: 'big.txt' }, binary: { path: 'image.bin' }, directory: { path: 'src' }, missing: { path: 'src/nope.ts' },
				noPath: {}, badStart: { path: 'src/math.ts', startLine: 'two' }, inverted: { path: 'src/math.ts', startLine: 5, endLine: 2 }, pastEnd: { path: 'src/util.ts', startLine: 99 },
			})) {
				refusals[name] = await rig.invokeTool('readFile', parameters);
			}
			return {
				whole: whole.text,
				range: range.text,
				longHeader: long.text.split('\n')[0],
				longLastLines: long.text.split('\n').slice(-2),
				live: live.text,
				empty: (await rig.invokeTool('readFile', { path: 'empty.txt' })).text,
				refusals: Object.fromEntries(Object.entries(refusals).map(([name, result]) => [name, result.ok ? 'NOT REFUSED' : result.text.replace(/could not be read: .*$/s, 'could not be read: …')])),
			};
		});
		assert.deepStrictEqual(outcome, {
			whole: 'src/util.ts (lines 1-3 of 3)\n1| export function clamp(value: number, min: number, max: number): number {\n2| \treturn Math.min(max, Math.max(min, value));\n3| }',
			// The target file is open in an editor, so the read comes from its live model.
			range: 'src/math.ts (lines 2-3 of 11, as open in the editor)\n2| \treturn a + b;\n3| }',
			longHeader: `long.txt (lines 1-${ONYX_READ_FILE_MAX_LINES} of ${ONYX_READ_FILE_MAX_LINES + 50})`,
			longLastLines: [`${ONYX_READ_FILE_MAX_LINES}| line ${ONYX_READ_FILE_MAX_LINES}`, `[one call returns at most ${ONYX_READ_FILE_MAX_LINES} lines; call readFile again with "startLine": ${ONYX_READ_FILE_MAX_LINES + 1} for more]`],
			live: 'src/math.ts (lines 1-1 of 12, as open in the editor)\n1| // typed and not saved',
			empty: 'empty.txt is empty (0 lines).',
			refusals: {
				tooBig: 'Error: big.txt is 1.0 MB; readFile reads files up to 1.0 MB. Use grep to find the part you need.',
				binary: 'Error: image.bin is a binary file; readFile reads text.',
				directory: 'Error: src is a directory. Use listDirectory.',
				missing: 'Error: src/nope.ts could not be read: …',
				noPath: 'Error: a non-empty "path" string is required.',
				badStart: 'Error: "startLine" must be a number.',
				inverted: 'Error: "endLine" (2) is before "startLine" (5).',
				pastEnd: 'Error: "startLine" (99) is past the end of the file, which has 3 lines.',
			},
		});
	});

	test('listDirectory and findFiles: one level with type and size, ignore files and excludes honoured, results capped', async () => {
		const outcome = await withRig({
			'.gitignore': 'ignored.txt\nbuild/\nsrc/generated.ts\nonly.txt\n',
			'ignored.txt': 'ignored\n',
			'build/out.js': 'built\n',
			'src/generated.ts': 'generated\n',
			'src/nested/deep.ts': 'deep\n',
			'empty-of-visible/only.txt': 'x\n',
			...Object.fromEntries(Array.from({ length: 60 }, (_, index) => [`many/file-${String(index).padStart(2, '0')}.md`, `${index}\n`])),
		}, async rig => ({
			root: (await rig.invokeTool('listDirectory', { path: '.' })).text,
			src: (await rig.invokeTool('listDirectory', { path: 'src' })).text,
			aFile: (await rig.invokeTool('listDirectory', { path: 'README.md' })).text,
			missing: (await rig.invokeTool('listDirectory', { path: 'nowhere' })).ok,
			typescript: (await rig.invokeTool('findFiles', { pattern: '**/*.ts' })).text,
			bareName: (await rig.invokeTool('findFiles', { pattern: 'README.md' })).text,
			ignoredOnly: (await rig.invokeTool('findFiles', { pattern: 'build/**' })).text,
			cappedHeader: (await rig.invokeTool('findFiles', { pattern: 'many/*.md' })).text.split('\n')[0],
			cappedCount: (await rig.invokeTool('findFiles', { pattern: 'many/*.md' })).text.split('\n').filter(line => line.startsWith('many/')).length,
			raised: (await rig.invokeTool('findFiles', { pattern: 'many/*.md', maxResults: 500 })).text.split('\n').filter(line => line.startsWith('many/')).length,
			noPattern: (await rig.invokeTool('findFiles', {})).text,
		}));
		assert.deepStrictEqual(outcome, {
			// build/ and ignored.txt are ignored by name, empty-of-visible/ holds only an ignored file, and
			// link-outside.txt is a symbolic link, which searches do not follow.
			root: [
				'.: 4 entries',
				'dir   many/',
				'dir   src/',
				'file  .gitignore  (45 B)',
				'file  README.md  (75 B)',
				'[4 entries left out: ignored, excluded, a symbolic link, or a directory with no visible files]',
			].join('\n'),
			src: [
				'src: 3 entries',
				'dir   nested/',
				'file  math.ts  (270 B)',
				'file  util.ts  (120 B)',
				'[1 entry left out: ignored, excluded, a symbolic link, or a directory with no visible files]',
			].join('\n'),
			aFile: 'Error: README.md is a file. Use readFile.',
			missing: false,
			typescript: '3 files matching "**/*.ts":\nsrc/math.ts\nsrc/nested/deep.ts\nsrc/util.ts',
			bareName: '1 file matching "README.md":\nREADME.md',
			ignoredOnly: 'No files match "build/**". Ignored and excluded files are not searched.',
			cappedHeader: '50 files matching "many/*.md" (more exist):',
			cappedCount: 50,
			raised: 60,
			noPattern: 'Error: a non-empty "pattern" string is required.',
		});
	});

	test('grep: literal and regex, path:line: text, capped per file and in total, cancellation passed through', async () => {
		const outcome = await withRig({
			'.gitignore': 'ignored.txt\n',
			'ignored.txt': 'needle in an ignored file\n',
			'notes/a.md': Array.from({ length: 20 }, (_, index) => `needle ${index}`).join('\n'),
			...Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`notes/many-${String(index).padStart(2, '0')}.md`, 'needle one\nneedle two\nneedle three\nneedle four\nneedle five\nneedle six\nneedle seven\nneedle eight\n'])),
		}, async rig => {
			const literal = await rig.invokeTool('grep', { pattern: 'a + b' });
			const regex = await rig.invokeTool('grep', { pattern: 'return a [+*] b;', regex: true });
			const scoped = await rig.invokeTool('grep', { pattern: 'export function', include: 'src/util.ts' });
			const flood = await rig.invokeTool('grep', { pattern: 'needle' });
			const floodLines = flood.text.split('\n');
			// Cancelled once the tool is running and its search begins. (A call whose token is already cancelled is
			// never handed to a tool: the tools service refuses it.)
			const cancellation = new CancellationTokenSource();
			rig.search.beforeNextTextSearch = () => cancellation.cancel();
			const cancelled = await rig.invokeTool('grep', { pattern: 'needle' }, cancellation.token);
			const cancelledQuery = rig.search.queries[rig.search.queries.length - 1];
			cancellation.dispose();
			return {
				literal: literal.text,
				regex: regex.text,
				scoped: scoped.text,
				floodHeader: floodLines[0],
				floodFooter: floodLines[floodLines.length - 1],
				floodTotal: floodLines.filter(line => /^notes\//.test(line)).length,
				floodFromOneFile: floodLines.filter(line => line.startsWith('notes/a.md:')).length,
				ignoredFileSearched: flood.text.includes('ignored.txt'),
				none: (await rig.invokeTool('grep', { pattern: 'no such text anywhere' })).text,
				caseSensitive: (await rig.invokeTool('grep', { pattern: 'ADDNUMBERS', caseSensitive: true })).text.split('\n')[0],
				caseInsensitive: (await rig.invokeTool('grep', { pattern: 'ADDNUMBERS' })).text.split('\n')[0],
				invalidRegex: (await rig.invokeTool('grep', { pattern: '(unclosed', regex: true })).text.split(':').slice(0, 2).join(':'),
				emptyPattern: (await rig.invokeTool('grep', { pattern: '  ' })).text,
				cancelled: cancelled.text,
				everySearchIgnoredSymlinks: rig.search.queries.every(query => query.ignoreSymlinks),
				theCancelledSearchSawTheToken: cancelledQuery.cancelled,
			};
		});
		assert.deepStrictEqual(outcome, {
			literal: '1 matching line in 1 file for "a + b":\nsrc/math.ts:2: \treturn a + b;',
			regex: '2 matching lines in 1 file for "return a [+*] b;":\nsrc/math.ts:2: \treturn a + b;\nsrc/math.ts:6: \treturn a * b;',
			scoped: '1 matching line in 1 file for "export function":\nsrc/util.ts:1: export function clamp(value: number, min: number, max: number): number {',
			floodHeader: `${ONYX_GREP_MAX_MATCHES} matching lines in 13 files for "needle":`,
			floodFooter: `[more lines match and are not shown (at most ${ONYX_GREP_MAX_MATCHES} in total, ${ONYX_GREP_MAX_MATCHES_PER_FILE} per file); narrow the pattern or add "include"]`,
			floodTotal: ONYX_GREP_MAX_MATCHES,
			floodFromOneFile: ONYX_GREP_MAX_MATCHES_PER_FILE,
			ignoredFileSearched: false,
			none: 'No lines match "no such text anywhere". Ignored and excluded files are not searched.',
			caseSensitive: 'No lines match "ADDNUMBERS". Ignored and excluded files are not searched.',
			caseInsensitive: '2 matching lines in 1 file for "ADDNUMBERS":',
			invalidRegex: 'Error: "(unclosed" is not a valid regular expression',
			emptyPattern: 'Error: a non-empty "pattern" string is required.',
			cancelled: 'Error: cancelled.',
			everySearchIgnoredSymlinks: true,
			theCancelledSearchSawTheToken: true,
		});
	});

	test('R-30, read side: traversal, an absolute path and a symbolic link out of the workspace are refused by every read tool, and no result carries the file outside', async () => {
		const outcome = await withRig({}, async rig => {
			const attempts: [string, unknown][] = [
				['readFile', { path: '../outside/secret.txt' }],
				['readFile', { path: 'src/../../outside/secret.txt' }],
				['readFile', { path: '/outside/secret.txt' }],
				['readFile', { path: 'link-outside.txt' }],
				['listDirectory', { path: '..' }],
				['listDirectory', { path: '/outside' }],
				['findFiles', { pattern: '../**' }],
				['findFiles', { pattern: '/outside/**' }],
				['grep', { pattern: 'CANARY', include: '../**' }],
				['grep', { pattern: 'CANARY' }],
				['findFiles', { pattern: '**/*.txt' }],
			];
			const results: { tool: string; ok: boolean; firstLine: string; leaked: boolean }[] = [];
			for (const [tool, parameters] of attempts) {
				const result = await rig.invokeTool(tool, parameters);
				results.push({ tool, ok: result.ok, firstLine: result.text.split('\n')[0], leaked: result.text.includes(SIM_OUTSIDE_CANARY) });
			}
			return results;
		});
		assert.deepStrictEqual(outcome, [
			{ tool: 'readFile', ok: false, firstLine: 'Error: "../outside/secret.txt" was refused: the path contains "..", which could leave the workspace.', leaked: false },
			{ tool: 'readFile', ok: false, firstLine: 'Error: "src/../../outside/secret.txt" was refused: the path contains "..", which could leave the workspace.', leaked: false },
			{ tool: 'readFile', ok: false, firstLine: 'Error: "/outside/secret.txt" was refused: absolute paths are not allowed; give a path relative to the workspace.', leaked: false },
			{ tool: 'readFile', ok: false, firstLine: 'Error: "link-outside.txt" was refused: it resolves to a location outside the workspace through a symbolic link.', leaked: false },
			{ tool: 'listDirectory', ok: false, firstLine: 'Error: ".." was refused: the path contains "..", which could leave the workspace.', leaked: false },
			{ tool: 'listDirectory', ok: false, firstLine: 'Error: "/outside" was refused: absolute paths are not allowed; give a path relative to the workspace.', leaked: false },
			{ tool: 'findFiles', ok: false, firstLine: 'Error: "../**" was refused: the path contains "..", which could leave the workspace.', leaked: false },
			{ tool: 'findFiles', ok: false, firstLine: 'Error: "/outside/**" was refused: absolute paths are not allowed; give a path relative to the workspace.', leaked: false },
			{ tool: 'grep', ok: false, firstLine: 'Error: "../**" was refused: the path contains "..", which could leave the workspace.', leaked: false },
			// The link is inside the workspace; searches do not follow symbolic links, so its target is never read.
			{ tool: 'grep', ok: true, firstLine: 'No lines match "CANARY". Ignored and excluded files are not searched.', leaked: false },
			{ tool: 'findFiles', ok: true, firstLine: 'No files match "**/*.txt". Ignored and excluded files are not searched.', leaked: false },
		]);
	});
});
