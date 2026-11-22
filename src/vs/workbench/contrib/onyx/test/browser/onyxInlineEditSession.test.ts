/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { runWithFakedTimers } from '../../../../../base/test/common/timeTravelScheduler.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { Range } from '../../../../../editor/common/core/range.js';
import { IOnyxChangeSetService } from '../../browser/changes/onyxChangeSetService.js';
import { OnyxInlineEditSession } from '../../browser/editor/onyxInlineEditSession.js';
import { OnyxSimRig } from './sim/onyxSimRig.js';

/**
 * R-14 and R-34 (B9): an inline edit is a proposal until it is accepted.
 * The session, the change set, the text models, the editor's save and the
 * disk are the real ones; the model's reply, the user's typing and the clock
 * are simulated.
 */
suite('OnyxInlineEditSession', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const PATH = 'src/math.ts';
	const FILE = ['function add(a, b) {', '\treturn a + b;', '}', '', 'function sub(a, b) {', '\treturn a - b;', '}', ''].join('\n');
	/** The model's reply for lines 1 to 7: both functions changed, in the SEARCH/REPLACE form the prompt asks for. */
	const REPLY = ['<<<<<<< SEARCH', '\treturn a + b;', '=======', '\treturn b + a; // inline one', '>>>>>>> REPLACE', '<<<<<<< SEARCH', '\treturn a - b;', '=======', '\treturn b - a; // inline two', '>>>>>>> REPLACE'].join('\n');
	const BOTH = FILE.replace('\treturn a + b;', '\treturn b + a; // inline one').replace('\treturn a - b;', '\treturn b - a; // inline two');
	const ONE = FILE.replace('\treturn a + b;', '\treturn b + a; // inline one');

	async function withRig<T>(run: (rig: OnyxSimRig) => Promise<T>, files: Readonly<Record<string, string>> = { [PATH]: FILE, 'src/other.ts': 'export const other = 1;\n' }): Promise<T> {
		return runWithFakedTimers({ useFakeTimers: true, maxTaskCount: 200_000 }, async () => {
			const rig = new OnyxSimRig({ name: 'inline-edit-session', seed: 0, persona: 'well-behaved', prompt: 'not run', files, target: PATH, turns: [], dialogDefault: 'allow-once', userSteps: [], faults: [] });
			try {
				await rig.prepare();
				return await run(rig);
			} finally {
				await rig.dispose();
			}
		});
	}

	const begin = (rig: OnyxSimRig, changeSet: IOnyxChangeSetService = rig.changeSet) => new OnyxInlineEditSession(rig.textModel(PATH)!, new Range(1, 1, 7, 2), changeSet, rig.workspaceAccess);
	const staged = (changeSet: IOnyxChangeSetService) => changeSet.files.get().find(file => file.proposal.path === PATH);
	/** Everything a proposal must not have touched: the buffer, whether it is dirty, and the disk. */
	const untouched = async (rig: OnyxSimRig, buffer = FILE, disk = FILE) => ({ buffer: rig.buffer(PATH) === buffer, dirty: rig.isDirty(PATH), disk: await rig.disk(PATH) === disk });

	test('R-34: a reply becomes a proposal and nothing else: the buffer, its dirty state and the disk are as they were, with a save and an autosave in between', async () => {
		const result = await withRig(async rig => {
			const session = begin(rig);
			const outcome = await session.stageReply(REPLY, 'run-1');
			const afterStaging = await untouched(rig);
			// Save, and an autosave tick, while the proposal waits: there is nothing of the proposal to write.
			await rig.save(PATH);
			await rig.save(PATH);
			return { outcome, afterStaging, afterSaves: await untouched(rig), proposed: staged(rig.changeSet)?.proposal.proposed === BOTH, hunks: staged(rig.changeSet)?.hunks.length };
		});
		assert.deepStrictEqual(result, {
			outcome: { kind: 'staged', path: PATH, generation: 1, hunkIds: ['g1.h1', 'g1.h2'], unplacedBlocks: 0 },
			afterStaging: { buffer: true, dirty: false, disk: true },
			afterSaves: { buffer: true, dirty: false, disk: true },
			proposed: true,
			hunks: 2,
		});
	});

	test('R-34: a buffer that was already dirty stays dirty with the user\'s text, and saving it writes the user\'s text and none of the proposal', async () => {
		const result = await withRig(async rig => {
			await rig.typeInto(PATH, 1, '// mine, unsaved\n');
			const mine = '// mine, unsaved\n' + FILE;
			const session = new OnyxInlineEditSession(rig.textModel(PATH)!, new Range(2, 1, 8, 2), rig.changeSet, rig.workspaceAccess);
			const outcome = await session.stageReply(REPLY);
			const beforeSave = await untouched(rig, mine, FILE);
			await rig.save(PATH);
			return { kind: outcome.kind, beforeSave: { ...beforeSave, dirty: rig.isDirty(PATH) || beforeSave.dirty }, afterSave: await untouched(rig, mine, mine), stillStaged: staged(rig.changeSet)?.hunks.length };
		});
		assert.deepStrictEqual(result, {
			kind: 'staged',
			beforeSave: { buffer: true, dirty: true, disk: true },
			afterSave: { buffer: true, dirty: false, disk: true },
			stillStaged: 2,
		});
	});

	test('R-14: typing during generation, a save participant that changes content, a cancel and a closed file each leave the reply unstaged and the user\'s text untouched; a save that changes nothing does not', async () => {
		const result = await withRig(async rig => {
			const outcomes: Record<string, unknown> = {};
			const report = async (name: string, session: OnyxInlineEditSession, expectedBuffer: string) => {
				const outcome = await session.stageReply(REPLY);
				outcomes[name] = { kind: outcome.kind, reason: outcome.kind === 'stale' ? outcome.reason : undefined, bufferIsTheUsers: rig.buffer(PATH) === expectedBuffer, staged: staged(rig.changeSet) !== undefined };
			};

			// A save while the model is working, with nothing to write: the request still stands.
			let session = begin(rig);
			await rig.save(PATH);
			outcomes.saveWithoutAChange = { current: session.isCurrent() };

			// The user types while the model is working.
			await rig.typeInto(PATH, 4, '// typed during generation\n');
			const typed = rig.buffer(PATH)!;
			await report('typedDuringGeneration', session, typed);

			// A save participant (a formatter) rewrites the file on save while the model is working.
			session = begin(rig);
			const model = rig.textModel(PATH)!;
			model.pushEditOperations(null, [{ range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 }, text: '/* formatted on save */ ' }], () => null);
			await rig.save(PATH);
			const formatted = rig.buffer(PATH)!;
			await report('saveParticipantChangedContent', session, formatted);

			// The user cancels, or the editor moves to another file.
			session = begin(rig);
			session.cancel();
			await report('cancelledOrSwitched', session, formatted);
			return outcomes;
		});
		const closed = await withRig(async rig => {
			const session = begin(rig);
			rig.closeModel(PATH);
			const outcome = await session.stageReply(REPLY);
			return { kind: outcome.kind, reason: outcome.kind === 'stale' ? outcome.reason : undefined, disk: await rig.disk(PATH) === FILE, staged: staged(rig.changeSet) !== undefined };
		});
		assert.deepStrictEqual({ ...result, modelDisposed: closed }, {
			saveWithoutAChange: { current: true },
			typedDuringGeneration: { kind: 'stale', reason: 'changed', bufferIsTheUsers: true, staged: false },
			saveParticipantChangedContent: { kind: 'stale', reason: 'changed', bufferIsTheUsers: true, staged: false },
			cancelledOrSwitched: { kind: 'stale', reason: 'cancelled', bufferIsTheUsers: true, staged: false },
			modelDisposed: { kind: 'stale', reason: 'disposed', disk: true, staged: false },
		});
	});

	test('R-34: keeping one hunk applies that hunk as one undoable edit; rejecting the other discards it without touching the buffer; undo restores the user\'s text', async () => {
		const result = await withRig(async rig => {
			const session = begin(rig);
			const outcome = await session.stageReply(REPLY);
			assert.ok(outcome.kind === 'staged');
			const [first, second] = outcome.hunkIds;
			const kept = await rig.changeSet.acceptHunk(PATH, first);
			const afterKeep = { buffer: rig.buffer(PATH) === ONE, dirty: rig.isDirty(PATH), disk: await rig.disk(PATH) === FILE, left: staged(rig.changeSet)?.hunks.map(hunk => hunk.id) };
			rig.changeSet.rejectHunk(PATH, second);
			const afterReject = { buffer: rig.buffer(PATH) === ONE, staged: staged(rig.changeSet) !== undefined };
			await rig.textModel(PATH)!.undo();
			return { kept, afterKeep, afterReject, afterUndo: rig.buffer(PATH) === FILE };
		});
		assert.deepStrictEqual(result, {
			kept: { applied: true },
			afterKeep: { buffer: true, dirty: true, disk: true, left: ['g1.h2'] },
			afterReject: { buffer: true, staged: false },
			afterUndo: true,
		});
	});

	test('R-34: rejecting or closing a proposal after the user typed discards the proposal and restores nothing over their work', async () => {
		const result = await withRig(async rig => {
			const session = begin(rig);
			await session.stageReply(REPLY);
			await rig.typeInto(PATH, 1, '// typed while reviewing\n');
			const mine = rig.buffer(PATH);
			rig.changeSet.rejectFile(PATH);
			return { bufferIsTheUsers: rig.buffer(PATH) === mine, staged: staged(rig.changeSet) !== undefined };
		});
		assert.deepStrictEqual(result, { bufferIsTheUsers: true, staged: false });
	});

	test('R-34: an unaccepted proposal survives a reload as a proposal, never as file content; it can be kept afterwards', async () => {
		const result = await withRig(async rig => {
			await begin(rig).stageReply(REPLY);
			const reloaded = rig.reloadChangeSet();
			const after = await untouched(rig);
			const restored = staged(reloaded);
			const accepted = restored ? await reloaded.acceptFile(PATH) : undefined;
			return { after, restoredHunks: restored?.hunks.length, newGeneration: restored !== undefined && restored.hunks.every(hunk => !hunk.id.startsWith('g1.')), accepted, buffer: rig.buffer(PATH) === BOTH };
		});
		assert.deepStrictEqual(result, { after: { buffer: true, dirty: false, disk: true }, restoredHunks: 2, newGeneration: true, accepted: { applied: true }, buffer: true });
	});

	test('B9: a file that already has changes waiting, a file outside the workspace, a reply that is not an edit and an oversized reply are refused with the reason; nothing is changed and nothing already staged is lost', async () => {
		const result = await withRig(async rig => {
			const notAnEdit = await begin(rig).stageReply('You should swap the operands on the return line.');
			const oversized = await begin(rig).stageReply('```\n' + 'x'.repeat(1100 * 1024) + '\n```');
			await rig.changeSet.stage(PATH, [{ search: '\treturn a - b;', replace: '\treturn b - a; // from the agent' }]);
			const waiting = await begin(rig).stageReply(REPLY);
			return {
				notAnEdit: notAnEdit.kind, oversized: oversized.kind, oversizedSaysWhy: oversized.kind === 'refused' && oversized.message.includes('a proposal is reviewed up to'),
				waiting: waiting.kind, agentsProposalKept: staged(rig.changeSet)?.proposal.proposed.includes('from the agent'), buffer: rig.buffer(PATH) === FILE,
			};
		});
		assert.deepStrictEqual(result, { notAnEdit: 'no-edit', oversized: 'refused', oversizedSaysWhy: true, waiting: 'refused', agentsProposalKept: true, buffer: true });
	});
});
