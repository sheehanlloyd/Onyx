/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { runWithFakedTimers } from '../../../../../base/test/common/timeTravelScheduler.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IOnyxStagedFile } from '../../browser/changes/onyxChangeSetService.js';
import { OnyxSimRig } from './sim/onyxSimRig.js';

/**
 * The change set through the real service, real text models and the
 * in-memory disk of the simulation rig (B7; R-09 to R-12, R-38). Nothing of
 * the service is stubbed: only the files, the user's typing and the clock
 * are simulated.
 */
suite('OnyxChangeSetService', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const PATH = 'src/math.ts';
	const FILE = ['function add(a, b) {', '\treturn a + b;', '}', '', 'function sub(a, b) {', '\treturn a - b;', '}', ''].join('\n');
	const ADD = { search: '\treturn a + b;', replace: '\treturn b + a; // first' };
	const PASTED = 'function add(a, b) {\n\treturn a + b;\n}\n\nfunction sub(a, b) {\n';
	const SUB = { search: '\treturn a - b;', replace: '\treturn b - a; // second' };

	async function withRig<T>(run: (rig: OnyxSimRig) => Promise<T>, files: Readonly<Record<string, string>> = { [PATH]: FILE }): Promise<T> {
		return runWithFakedTimers({ useFakeTimers: true, maxTaskCount: 200_000 }, async () => {
			const rig = new OnyxSimRig({ name: 'change-set-service', seed: 0, persona: 'well-behaved', prompt: 'not run', files, target: PATH, turns: [], dialogDefault: 'allow-once', userSteps: [], faults: [] });
			try {
				await rig.prepare();
				return await run(rig);
			} finally {
				await rig.dispose();
			}
		});
	}

	const staged = (rig: OnyxSimRig): IOnyxStagedFile | undefined => rig.changeSet.files.get().find(file => file.proposal.path === PATH);
	const shown = (rig: OnyxSimRig) => ({
		hunks: (staged(rig)?.hunks ?? []).map(hunk => `${hunk.id} line ${hunk.originalStart + 1}: ${hunk.newLines.join('|')}`),
		conflicts: (staged(rig)?.conflicts ?? []).map(conflict => `${conflict.id} ${conflict.reason}: ${conflict.originalLines.join('|')} -> ${conflict.newLines.join('|')}`),
	});

	test('R-11: a hunk accepted by its id after the buffer changed above it applies that same change at its new place, and the other hunk stays staged under its own id', async () => {
		const result = await withRig(async rig => {
			await rig.changeSet.stage(PATH, [ADD, SUB]);
			const before = shown(rig);
			const [first, second] = staged(rig)!.hunks.map(hunk => hunk.id);
			// The user types two lines at the top while the review is open.
			await rig.typeInto(PATH, 1, '// typed by the user\n// and another\n');
			const outcome = await rig.changeSet.acceptHunk(PATH, second);
			return { before, first, outcome, buffer: rig.buffer(PATH), after: shown(rig), baseIsTheBuffer: staged(rig)?.proposal.base === rig.buffer(PATH) };
		});
		assert.deepStrictEqual(result, {
			before: { hunks: ['g1.h1 line 2: \treturn b + a; // first', 'g1.h2 line 6: \treturn b - a; // second'], conflicts: [] },
			first: 'g1.h1',
			outcome: { applied: true },
			buffer: '// typed by the user\n// and another\n' + FILE.replace(SUB.search, SUB.replace),
			after: { hunks: ['g1.h1 line 4: \treturn b + a; // first'], conflicts: [] },
			baseIsTheBuffer: true,
		});
	});

	test('R-12: the user edits the lines of hunk 1, then accepts what was shown as hunk 1: it is refused with "look again", nothing of hunk 2 is applied, and hunk 1 is on show as a conflict with both texts', async () => {
		const result = await withRig(async rig => {
			await rig.changeSet.stage(PATH, [ADD, SUB]);
			const [first] = staged(rig)!.hunks.map(hunk => hunk.id);
			// The user rewrites the very line hunk 1 would replace.
			const model = rig.textModel(PATH)!;
			model.pushEditOperations(null, [{ range: { startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: model.getLineMaxColumn(2) }, text: '\treturn Number(a) + Number(b);' }], () => null);
			const userText = rig.buffer(PATH);
			const outcome = await rig.changeSet.acceptHunk(PATH, first);
			const again = await rig.changeSet.acceptHunk(PATH, first);
			return { outcome, again: again.applied === false ? again.reason : 'applied', bufferIsTheUsers: rig.buffer(PATH) === userText, shown: shown(rig) };
		});
		assert.deepStrictEqual(result, {
			outcome: { applied: false, reason: 'conflict', message: 'The review of src/math.ts changed; look again. Nothing was applied.' },
			again: 'conflict',
			bufferIsTheUsers: true,
			shown: { hunks: ['g1.h2 line 6: \treturn b - a; // second'], conflicts: ['g1.h1 missing: \treturn a + b; -> \treturn b + a; // first'] },
		});
	});

	test('R-11: a new proposal generation arriving during review invalidates the ids that were on show; an id of the old generation applies nothing', async () => {
		const result = await withRig(async rig => {
			await rig.changeSet.stage(PATH, [ADD]);
			const old = staged(rig)!.hunks[0].id;
			// The agent edits the same file again while the user is looking at the first proposal.
			await rig.changeSet.stage(PATH, [SUB]);
			const outcome = await rig.changeSet.acceptHunk(PATH, old);
			const untouched = rig.buffer(PATH) === FILE;
			const current = shown(rig);
			const accepted = await rig.changeSet.acceptHunk(PATH, staged(rig)!.hunks[0].id);
			return { old, outcome: outcome.applied === false ? outcome.reason : 'applied', untouched, current, accepted, buffer: rig.buffer(PATH), left: shown(rig) };
		});
		assert.deepStrictEqual(result, {
			old: 'g1.h1',
			outcome: 'review-changed',
			untouched: true,
			current: { hunks: ['g2.h1 line 2: \treturn b + a; // first', 'g2.h2 line 6: \treturn b - a; // second'], conflicts: [] },
			accepted: { applied: true },
			buffer: FILE.replace(ADD.search, ADD.replace),
			left: { hunks: ['g2.h2 line 6: \treturn b - a; // second'], conflicts: [] },
		});
	});

	test('R-09, R-10: the same lines duplicated in the buffer make the hunk a conflict; accepting the file applies nothing while a conflict is on show; dismissing the conflict leaves the rest acceptable', async () => {
		const result = await withRig(async rig => {
			await rig.changeSet.stage(PATH, [ADD, SUB]);
			// The user pastes a second copy of the first function above the original, with the three lines that
			// follow it as well: the hunk's lines and their context are now in the file twice.
			await rig.typeInto(PATH, 1, PASTED);
			const userText = rig.buffer(PATH);
			await rig.changeSet.refresh();
			const afterRefresh = shown(rig);
			const whole = await rig.changeSet.acceptFile(PATH);
			const untouched = rig.buffer(PATH) === userText;
			rig.changeSet.rejectHunk(PATH, 'g1.h1');
			const rest = await rig.changeSet.acceptFile(PATH);
			return { afterRefresh, whole: whole.applied === false ? whole.reason : 'applied', untouched, rest, buffer: rig.buffer(PATH), staged: staged(rig) === undefined ? 'nothing' : 'something' };
		});
		assert.deepStrictEqual(result, {
			afterRefresh: { hunks: ['g1.h2 line 11: \treturn b - a; // second'], conflicts: ['g1.h1 ambiguous: \treturn a + b; -> \treturn b + a; // first'] },
			whole: 'conflict',
			untouched: true,
			rest: { applied: true },
			buffer: PASTED + FILE.replace(SUB.search, SUB.replace),
			staged: 'nothing',
		});
	});

	test('R-09 to R-12 for a file that is not open in an editor: the proposal is against its content on disk, and an accept after that content changed carries the hunk over or refuses', async () => {
		const OTHER = 'src/closed.ts';
		const result = await withRig(async rig => {
			await rig.changeSet.stage(OTHER, [{ search: 'const two = 2;', replace: 'const two = 2; // staged' }]);
			const file = () => rig.changeSet.files.get().find(candidate => candidate.proposal.path === OTHER);
			const version = file()?.baseVersion;
			const id = file()!.hunks[0].id;
			// The file changes on disk while it is closed: a line added above the hunk.
			await rig.writeDisk(OTHER, '// changed on disk\nconst one = 1;\nconst two = 2;\nconst three = 3;\n');
			const outcome = await rig.changeSet.acceptHunk(OTHER, id);
			return { hashed: typeof version?.contentHash === 'string' && version.contentHash.length === 8, outcome, content: rig.buffer(OTHER) ?? await rig.disk(OTHER), staged: file() === undefined ? 'nothing' : 'something' };
		}, { [PATH]: FILE, 'src/closed.ts': 'const one = 1;\nconst two = 2;\nconst three = 3;\n' });
		assert.deepStrictEqual(result, {
			hashed: true,
			outcome: { applied: true },
			content: '// changed on disk\nconst one = 1;\nconst two = 2; // staged\nconst three = 3;\n',
			staged: 'nothing',
		});
	});

	test('R-38: an oversized proposal from an agent edit or a whole-file proposal is refused before it is diffed; the buffer and the proposal already staged are as they were', async () => {
		const result = await withRig(async rig => {
			await rig.changeSet.stage(PATH, [ADD]);
			const before = shown(rig);
			const huge = 'x'.repeat(300 * 1024);
			const edit = await rig.changeSet.stage(PATH, [{ search: SUB.search, replace: huge }]);
			const whole = await rig.changeSet.stageProposal(PATH, Array.from({ length: 1200 }, (_, index) => `line ${index}`).join('\n'));
			return { edit: edit.ok ? 'staged' : edit.error.replace(/\d{6,}/, 'N'), whole: whole.ok ? 'staged' : whole.error, unchanged: JSON.stringify(shown(rig)) === JSON.stringify(before), buffer: rig.buffer(PATH) === FILE };
		});
		assert.deepStrictEqual(result, {
			edit: 'Edit refused for src/math.ts: the file and the proposed content together are N bytes; a proposal is reviewed up to 262144. Nothing was staged; the edits already staged for the file are unchanged. Make a smaller edit.',
			whole: 'Proposal refused for src/math.ts: the file has 8 lines and the proposed content 1200; a proposal is reviewed up to 1000 lines a side. Nothing was staged, and anything already staged for the file is unchanged.',
			unchanged: true,
			buffer: true,
		});
	});

	suite('R-13: accepted edits through the text model', () => {

		const LINES = ['one', 'two', 'three', 'four', 'five', 'six'];
		const text = (lines: readonly string[], eol = '\n', finalNewline = true) => lines.join(eol) + (finalNewline ? eol : '');
		const without = (...indexes: number[]) => LINES.filter((_, index) => !indexes.includes(index));

		/** Stages `proposed` for a file that holds `base`, accepts it whole and then, in a second rig, hunk by hunk; returns both buffers. */
		async function accept(base: string, proposed: string): Promise<{ readonly whole: string | undefined; readonly hunkByHunk: string | undefined; readonly hunks: number; readonly undone: string | undefined }> {
			const lf = (value: string) => value.replace(/\r\n/g, '\n');
			const whole = await withRig(async rig => {
				await rig.changeSet.stageProposal(PATH, lf(proposed));
				const hunks = staged(rig)?.hunks.length ?? 0;
				await rig.changeSet.acceptFile(PATH);
				const buffer = rig.buffer(PATH);
				// One accept is one undoable edit: undoing it gives the file back as it was.
				await rig.textModel(PATH)!.undo();
				return { buffer, hunks, undone: rig.buffer(PATH) };
			}, { [PATH]: base });
			const hunkByHunk = await withRig(async rig => {
				await rig.changeSet.stageProposal(PATH, lf(proposed));
				// Last hunk first, then the others: each accept leaves the rest to be carried over.
				for (let guard = 0; guard < 20 && staged(rig); guard++) {
					const hunks = staged(rig)!.hunks;
					await rig.changeSet.acceptHunk(PATH, hunks[hunks.length - 1].id);
				}
				return rig.buffer(PATH);
			}, { [PATH]: base });
			return { whole: whole.buffer, hunkByHunk, hunks: whole.hunks, undone: whole.undone };
		}

		test('R-13: deleting the first line, a middle line, the last line, every line, and lines in two hunks one line apart leaves the buffer equal to the proposal, byte for byte', async () => {
			const cases: Record<string, readonly string[]> = {
				first: without(0), middle: without(2), last: without(5), firstTwo: without(0, 1), lastTwo: without(4, 5),
				// Two hunks with one unchanged line between them, and a deletion next to a change.
				adjacentHunks: without(1, 3), deletionNextToAChange: ['one', 'THREE', 'four', 'five', 'six'],
				all: [],
			};
			const outcomes: Record<string, string> = {};
			for (const [name, lines] of Object.entries(cases)) {
				const base = text(LINES);
				const proposed = lines.length ? text(lines) : '';
				const result = await accept(base, proposed);
				outcomes[name] = result.whole === proposed && result.hunkByHunk === proposed && result.undone === base ? 'equal' : JSON.stringify(result);
			}
			assert.deepStrictEqual(outcomes, Object.fromEntries(Object.keys(cases).map(name => [name, 'equal'])));
		});

		test('R-13: the same deletions in a file with CRLF line endings keep every remaining line ending as it was', async () => {
			const cases: Record<string, readonly string[]> = { first: without(0), middle: without(2), last: without(5), adjacentHunks: without(1, 3), insertion: ['one', 'two', 'new', 'three', 'four', 'five', 'six'], replacement: ['one', 'TWO', 'three', 'four', 'five', 'six'] };
			const outcomes: Record<string, string> = {};
			for (const [name, lines] of Object.entries(cases)) {
				const proposed = text(lines, '\r\n');
				const result = await accept(text(LINES, '\r\n'), proposed);
				outcomes[name] = result.whole === proposed && result.hunkByHunk === proposed ? 'equal' : JSON.stringify(result);
			}
			assert.deepStrictEqual(outcomes, Object.fromEntries(Object.keys(cases).map(name => [name, 'equal'])));
		});

		test('R-13: a file with no final newline: deleting or changing its last line, and adding or removing the final newline, give exactly the proposal', async () => {
			const cases: Record<string, readonly [base: string, proposed: string]> = {
				deleteLast: [text(LINES, '\n', false), text(without(5), '\n', false)],
				deleteFirst: [text(LINES, '\n', false), text(without(0), '\n', false)],
				changeLast: [text(LINES, '\n', false), text([...without(5), 'SIX'], '\n', false)],
				appendALine: [text(LINES, '\n', false), text([...LINES, 'seven'], '\n', false)],
				addTheFinalNewline: [text(LINES, '\n', false), text(LINES)],
				removeTheFinalNewline: [text(LINES), text(LINES, '\n', false)],
				deleteAll: [text(LINES, '\n', false), ''],
			};
			const outcomes: Record<string, string> = {};
			for (const [name, [base, proposed]] of Object.entries(cases)) {
				const result = await accept(base, proposed);
				outcomes[name] = result.whole === proposed && result.hunkByHunk === proposed ? 'equal' : JSON.stringify(result);
			}
			assert.deepStrictEqual(outcomes, Object.fromEntries(Object.keys(cases).map(name => [name, 'equal'])));
		});
	});
});
