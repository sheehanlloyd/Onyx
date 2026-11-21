/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { timeout } from '../../../../../base/common/async.js';
import { runWithFakedTimers } from '../../../../../base/test/common/timeTravelScheduler.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IMarkerData, MarkerSeverity } from '../../../../../platform/markers/common/markers.js';
import { URI } from '../../../../../base/common/uri.js';
import { describeVerification, diffProblems, IOnyxProblem, problemIdentity } from '../../common/onyxVerification.js';
import { OnyxSimRig } from './sim/onyxSimRig.js';

/**
 * R-21 (C2): verification is of what was accepted. The verification service,
 * the change set, the text models, the marker service, the editor's save and
 * the task gate are the real ones; the diagnostics a language service would
 * report, the user and the clock are simulated.
 */
suite('OnyxVerification', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const PATH = 'src/math.ts';
	const FILE = ['function add(a, b) {', '\treturn a + b;', '}', '', 'function sub(a, b) {', '\treturn a - b;', '}', ''].join('\n');
	const ADD = { search: '\treturn a + b;', replace: '\treturn b + a; // first' };
	const SUB = { search: '\treturn a - b;', replace: '\treturn b - a; // second' };

	async function withRig<T>(run: (rig: OnyxSimRig) => Promise<T>, verificationTask?: string): Promise<T> {
		return runWithFakedTimers({ useFakeTimers: true, maxTaskCount: 200_000 }, async () => {
			const rig = new OnyxSimRig({ name: 'verification', seed: 0, persona: 'well-behaved', prompt: 'not run', files: { [PATH]: FILE }, target: PATH, turns: [], dialogDefault: 'allow-once', userSteps: [], faults: [], ...(verificationTask ? { projectConfig: { verificationTask } } : {}) });
			try {
				await rig.prepare();
				return await run(rig);
			} finally {
				await rig.dispose();
			}
		});
	}

	const problem = (message: string, line: number, code = 'TS2322'): IMarkerData => ({ severity: MarkerSeverity.Error, source: 'ts', code, message, startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: 5 });
	/** What a language service does: replaces its diagnostics for the file. */
	const report = (rig: OnyxSimRig, uri: URI, problems: IMarkerData[]) => rig.markers.changeOne('typescript', uri, problems);
	const state = (rig: OnyxSimRig) => rig.verification.resultFor(PATH)?.state;
	const notes = (rig: OnyxSimRig, runId: string) => (rig.controlPlane.getRun(runId)?.activity.get() ?? []).map(entry => entry.label).filter(label => label.startsWith('Verification') || label.startsWith('Checks') || label.startsWith('Running checks'));

	test('R-21: staged and not accepted is "not applied"; once accepted, one error swapped for another is a new problem although the count did not move', async () => {
		const result = await withRig(async rig => {
			const uri = rig.uri(PATH);
			const run = rig.controlPlane.beginRun({ sessionResource: URI.parse('onyx-test://verification'), requestId: 'r1', title: 'verification', task: 'quick-edit', modelKey: 'auto' });
			// One error is on record before anything is staged.
			report(rig, uri, [problem('Type \'string\' is not assignable to type \'number\'.', 6)]);
			await rig.changeSet.stage(PATH, [ADD], run.runId);
			const staged = state(rig);
			// Diagnostics change while the proposal is only staged: still nothing was applied, so nothing is verified.
			await timeout(20_000);
			const stillStaged = state(rig);
			await rig.changeSet.acceptHunk(PATH, rig.changeSet.files.get()[0].hunks[0].id);
			const afterAccept = state(rig);
			// The language service reports on the accepted content: the old error is gone, another is there. One before, one after.
			report(rig, uri, [problem('Cannot find name \'c\'.', 2, 'TS2304')]);
			await timeout(1000);
			const verdict = rig.verification.resultFor(PATH)!;
			run.complete('completed');
			return {
				staged, stillStaged, afterAccept,
				state: verdict.state, counts: [verdict.diff?.before, verdict.diff?.after],
				introduced: verdict.diff?.introduced.map(entry => `${entry.line}: ${entry.message}`), resolved: verdict.diff?.resolved.map(entry => entry.message),
				acceptedContentIsOnRecord: verdict.contentHash !== null && verdict.generation === 1,
				timeline: notes(rig, run.runId),
			};
		});
		assert.deepStrictEqual(result, {
			staged: 'not applied', stillStaged: 'not applied', afterAccept: 'running',
			state: 'new problems', counts: [1, 1],
			introduced: ['2: Cannot find name \'c\'.'], resolved: ['Type \'string\' is not assignable to type \'number\'.'],
			acceptedContentIsOnRecord: true,
			timeline: ['Verification: new problems — 1 in src/math.ts after the acceptance, first at line 2: Cannot find name \'c\'.'],
		});
	});

	test('R-21: a problem that only moved is not new; an acceptance of one hunk of two says it is partial; no report in time is "timed out", not "verified"; a change to the file afterwards makes the result stale', async () => {
		const result = await withRig(async rig => {
			const uri = rig.uri(PATH);
			report(rig, uri, [problem('Unused variable.', 6, 'TS6133')]);
			await rig.changeSet.stage(PATH, [{ search: 'function add(a, b) {', replace: '// added above\nfunction add(a, b) {' }, SUB]);
			const [first, second] = rig.changeSet.files.get()[0].hunks.map(hunk => hunk.id);
			await rig.changeSet.acceptHunk(PATH, first);
			// The same problem, one line further down because a line was added above it.
			report(rig, uri, [problem('Unused variable.', 7, 'TS6133')]);
			await timeout(1000);
			const moved = state(rig);
			const partial = describeVerification(rig.verification.resultFor(PATH)!);
			// The second hunk: no language service reports anything afterwards.
			await rig.changeSet.acceptHunk(PATH, second);
			const running = state(rig);
			await timeout(16_000);
			const silent = state(rig);
			// The user types: what was verified, or not, is no longer the file.
			await rig.typeInto(PATH, 1, '// typed afterwards\n');
			return { moved, partial, running, silent, afterTyping: state(rig), says: describeVerification(rig.verification.resultFor(PATH)!) };
		});
		assert.deepStrictEqual(result, {
			moved: 'verified',
			partial: 'Verification: verified — no new problems in src/math.ts after the acceptance (1 in all). Partial: 1 hunk is still staged and not part of this',
			running: 'running', silent: 'timed out', afterTyping: 'stale',
			says: 'Verification: stale — src/math.ts changed after the acceptance; the result was for content that is no longer there',
		});
	});

	test('R-21: the project check runs only on the accepted file as saved: an unsaved buffer is named and not saved for the user, and the check runs when they save it', async () => {
		const result = await withRig(async rig => {
			const uri = rig.uri(PATH);
			const run = rig.controlPlane.beginRun({ sessionResource: URI.parse('onyx-test://verification'), requestId: 'r2', title: 'verification', task: 'quick-edit', modelKey: 'auto' });
			await rig.changeSet.stage(PATH, [ADD], run.runId);
			await rig.changeSet.acceptFile(PATH);
			report(rig, uri, []);
			report(rig, uri, [problem('A warning that was there all along.', 1)]);
			await timeout(1000);
			const unsaved = { check: rig.verification.resultFor(PATH)?.check, dirty: rig.isDirty(PATH), disk: await rig.disk(PATH) === FILE, tasksRan: [...rig.tasks.ran] };
			await rig.save(PATH);
			await timeout(1000);
			const check = rig.verification.resultFor(PATH)?.check;
			run.complete('completed');
			return {
				unsaved,
				afterSave: { kind: check?.kind, passed: check?.kind === 'ran' ? check.passed : undefined, savedFiles: check?.kind === 'ran' ? check.savedFiles.map(file => file.path) : undefined, tasksRan: [...rig.tasks.ran], dialogs: rig.dialogs.prompts.length },
				timeline: notes(rig, run.runId).filter(label => !label.startsWith('Verification')),
			};
		}, 'test');
		assert.deepStrictEqual(result, {
			unsaved: { check: { kind: 'not run', reason: 'unsaved', unsavedFiles: [PATH] }, dirty: true, disk: true, tasksRan: [] },
			afterSave: { kind: 'ran', passed: true, savedFiles: [PATH], tasksRan: ['npm: test'], dialogs: 1 },
			timeline: [
				'Checks not run: src/math.ts has unsaved changes, and the check reads the saved file. Save it to run the check on what you accepted',
				'Running checks: npm: test on the accepted, saved src/math.ts',
				'Checks passed: npm: test (0.0s)',
			],
		});
	});

	test('problems are compared by identity and with multiplicity, never by count', () => {
		const one = (message: string, line: number, path = PATH): IOnyxProblem => ({ path, severity: 'error', source: 'ts', code: 'TS1', message, line });
		const diff = (before: IOnyxProblem[], after: IOnyxProblem[]) => { const result = diffProblems(before, after); return { introduced: result.introduced.map(entry => entry.message), resolved: result.resolved.map(entry => entry.message) }; };
		assert.deepStrictEqual({
			lineIsNotIdentity: problemIdentity(one('a', 1)) === problemIdentity(one('a', 99)),
			fileIsIdentity: problemIdentity(one('a', 1)) === problemIdentity(one('a', 1, 'src/other.ts')),
			swapped: diff([one('a', 1)], [one('b', 1)]),
			oneMoreOfTheSame: diff([one('a', 1), one('a', 5)], [one('a', 1), one('a', 5), one('a', 9)]),
			fewer: diff([one('a', 1), one('b', 2)], [one('b', 7)]),
			unchanged: diff([one('a', 1)], [one('a', 3)]),
		}, {
			lineIsNotIdentity: true, fileIsIdentity: false,
			swapped: { introduced: ['b'], resolved: ['a'] },
			oneMoreOfTheSame: { introduced: ['a'], resolved: [] },
			fewer: { introduced: [], resolved: ['a'] },
			unchanged: { introduced: [], resolved: [] },
		});
	});
});
