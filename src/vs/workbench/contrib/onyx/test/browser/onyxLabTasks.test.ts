/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { failToPassVerdict, interpretOracleProbe, IOnyxOracleProbeStep, oracleConsentLines, oracleGate, oracleSandboxProfile, oracleUnsupportedProbe } from '../../../../../platform/onyxRuntime/common/onyxOracle.js';
import { addedLineDigests, classifyHoldout, contentHoldsLines, countTasks, deriveRequestTasks, IOnyxJournaledRequest, IOnyxRequestTaskLookup, latestPublication, maxTaskFileChars, taskFitsContext, taskInstruction } from '../../common/onyxLabTasks.js';
import { modelPublishedAt } from '../../common/onyxModelCatalog.js';
import { IOnyxBenchCommitCandidate, selectBenchmarkCommits } from '../../common/onyxRepoBench.js';

/**
 * L10, the pure half of R-50: which commits are held out for a model, which
 * of a user's requests become tasks, and when the executable oracle may
 * run at all.
 */
suite('OnyxLabTasks', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const commit = (hash: string, authoredAt: string | undefined, subject = 'Tighten the retry loop'): IOnyxBenchCommitCandidate => ({ hash, subject, files: ['src/retry.ts'], insertions: 6, deletions: 2, ...(authoredAt ? { authoredAt } : {}) });

	test('R-50: only commits authored after the model was published count as held out; with no date every task is labelled unknown', () => {
		const candidates = [
			commit('a1', '2024-09-10T12:00:00Z'), // before
			commit('a2', '2024-09-19T23:00:00+08:00'), // the day itself
			commit('a3', '2024-09-20T09:00:00Z'), // the next morning, which is still the 19th somewhere
			commit('a4', '2024-09-21T00:00:00Z'), // later, anywhere
			commit('a5', '2026-03-01T10:00:00Z'),
			commit('a6', undefined), // no date
		];
		const published = modelPublishedAt('qwen2.5-coder:7b');
		assert.deepStrictEqual({
			published,
			each: candidates.map(candidate => classifyHoldout(candidate.authoredAt, published)),
			heldOutTasks: selectBenchmarkCommits(candidates, 10, { publishedAt: published }).map(task => [task.hash, task.holdout]),
			aModelWithNoDate: selectBenchmarkCommits(candidates, 10, { publishedAt: modelPublishedAt('qwen2.5-coder:14b') }).map(task => [task.hash, task.holdout]),
			noHoldoutAskedFor: selectBenchmarkCommits(candidates, 10).map(task => [task.hash, task.holdout]),
			forSeveralModels: latestPublication([modelPublishedAt('qwen2.5-coder:7b'), modelPublishedAt('llama3.2:3b')]),
			oneOfThemUndated: latestPublication([modelPublishedAt('qwen2.5-coder:7b'), modelPublishedAt('qwen2.5-coder:14b')]),
		}, {
			published: '2024-09-19',
			each: ['not-held-out', 'not-held-out', 'not-held-out', 'held-out', 'held-out', 'unknown'],
			heldOutTasks: [['a4', 'held-out'], ['a5', 'held-out']],
			aModelWithNoDate: [['a1', 'unknown'], ['a2', 'unknown'], ['a3', 'unknown'], ['a4', 'unknown'], ['a5', 'unknown'], ['a6', 'unknown']],
			noHoldoutAskedFor: [['a1', undefined], ['a2', undefined], ['a3', undefined], ['a4', undefined], ['a5', undefined], ['a6', undefined]],
			forSeveralModels: '2024-09-25',
			oneOfThemUndated: undefined,
		});
	});

	test('R-50: a request becomes a task only when its proposal was accepted and the accepted lines were later committed', () => {
		const digests = addedLineDigests(['\tconst limit = 5;', '', '\treturn retry(limit);']);
		const requests: IOnyxJournaledRequest[] = [
			{ runId: 'accepted-and-committed', request: 'Cap the retries at five', head: 'base1', accepted: [{ path: 'src/retry.ts', addedLineDigests: digests }] },
			{ runId: 'accepted-never-committed', request: 'Rename the helper', head: 'base1', accepted: [{ path: 'src/helper.ts', addedLineDigests: addedLineDigests(['export function assist() { }']) }] },
			{ runId: 'nothing-accepted', request: 'Explain this file', head: 'base1', accepted: [] },
			{ runId: 'base-gone', request: 'Add a timeout', head: 'rebased-away', accepted: [{ path: 'src/retry.ts', addedLineDigests: digests }] },
			{ runId: 'no-text', request: '  ', head: 'base1', accepted: [{ path: 'src/retry.ts', addedLineDigests: digests }] },
		];
		const lookup: IOnyxRequestTaskLookup = {
			isReachable: commit => commit === 'base1',
			firstCommitContaining: (path, wanted) => path === 'src/retry.ts' && contentHoldsLines('const limit = 5;\nreturn retry(limit);\n', wanted) ? { commit: 'c9', authoredAt: '2026-11-02T10:00:00Z' } : undefined,
		};
		const optedIn = deriveRequestTasks(true, requests, lookup);
		assert.deepStrictEqual({
			tasks: optedIn.tasks.map(task => [task.runId, task.instruction, task.base, task.commit, task.file]),
			skipped: optedIn.skipped,
			withoutTheOptIn: deriveRequestTasks(false, requests, lookup),
			digestsHoldNoText: digests.every(digest => /^[0-9a-f]{8}$/.test(digest)) && digests.length === 2,
			aLineMissing: contentHoldsLines('const limit = 5;\n', digests),
		}, {
			tasks: [['accepted-and-committed', 'Cap the retries at five', 'base1', 'c9', 'src/retry.ts']],
			skipped: { 'no-request-text': 1, 'nothing-accepted': 1, 'base-unreachable': 1, 'never-committed': 1 },
			withoutTheOptIn: { tasks: [], requests: 0, skipped: { 'no-request-text': 0, 'nothing-accepted': 0, 'base-unreachable': 0, 'never-committed': 0 } },
			digestsHoldNoText: true,
			aLineMissing: false,
		});
	});

	test('R-50: the oracle is unavailable when the sandbox probe fails or consent is absent, and never for another command than the one agreed to', () => {
		const good: IOnyxOracleProbeStep[] = [
			{ what: 'sandboxed-run', exitCode: 0, observed: true, output: '' },
			{ what: 'network-outside-sandbox', exitCode: 0, observed: true, output: '' },
			{ what: 'network-inside-sandbox', exitCode: 1, observed: false, output: 'Operation not permitted' },
			{ what: 'write-outside-worktree', exitCode: 1, observed: false, output: 'Operation not permitted' },
			{ what: 'write-inside-worktree', exitCode: 0, observed: true, output: '' },
		];
		const swap = (what: IOnyxOracleProbeStep['what'], change: Partial<IOnyxOracleProbeStep>) => good.map(step => step.what === what ? { ...step, ...change } : step);
		const available = interpretOracleProbe(good);
		const consent = { command: 'node --test test/sum.test.mjs', maxRuns: 2 };
		assert.deepStrictEqual({
			available: available.available,
			networkGotThrough: interpretOracleProbe(swap('network-inside-sandbox', { exitCode: 0, observed: true })).reason,
			writeGotOut: interpretOracleProbe(swap('write-outside-worktree', { observed: true })).reason,
			noControl: interpretOracleProbe(swap('network-outside-sandbox', { observed: false })).reason,
			cannotWriteInside: interpretOracleProbe(swap('write-inside-worktree', { exitCode: 1, observed: false })).reason,
			sandboxDidNotStart: interpretOracleProbe(swap('sandboxed-run', { exitCode: undefined })).reason,
			noSandboxOnThisPlatform: oracleUnsupportedProbe('linux').available,
			gate: {
				allGood: oracleGate(available, consent, consent.command, 0),
				notProbed: oracleGate(undefined, consent, consent.command, 0),
				probeFailed: oracleGate(oracleUnsupportedProbe('linux'), consent, consent.command, 0),
				noConsent: oracleGate(available, undefined, consent.command, 0),
				anotherCommand: oracleGate(available, consent, `${consent.command} && curl example.invalid`, 0),
				runsUsedUp: oracleGate(available, consent, consent.command, 2),
			},
			consentSaysWhatRuns: oracleConsentLines(consent),
			verdicts: [failToPassVerdict(1, 0), failToPassVerdict(1, 1), failToPassVerdict(0, 0), failToPassVerdict(1, undefined)],
			profile: oracleSandboxProfile('/private/tmp/w "x"').split('\n').slice(2),
		}, {
			available: true,
			networkGotThrough: 'a network connection was made from inside the sandbox',
			writeGotOut: 'a file was written outside the worktree from inside the sandbox',
			noControl: 'the probe could not reach its own listener outside the sandbox, so it cannot show that the sandbox is what blocks the network',
			cannotWriteInside: 'a file could not be written inside the worktree from inside the sandbox',
			sandboxDidNotStart: 'a command could not be started inside the sandbox',
			noSandboxOnThisPlatform: false,
			gate: {
				allGood: { allowed: true },
				notProbed: { allowed: false, reason: 'the sandbox has not been probed' },
				probeFailed: { allowed: false, reason: 'no sandbox is available on linux: the executable oracle needs one that denies the network and writes outside the worktree' },
				noConsent: { allowed: false, reason: 'the user has not agreed to run a verification command on model-written code' },
				anotherCommand: { allowed: false, reason: 'the command is not, byte for byte, the one the user agreed to' },
				runsUsedUp: { allowed: false, reason: 'the command has been run 2 times, the most the user agreed to' },
			},
			consentSaysWhatRuns: [
				'node --test test/sum.test.mjs',
				'29 bytes; it will be run at most 2 times.',
				'This runs your command on code a model wrote. It runs inside a sandbox that denies network access and every write outside a disposable copy of the repository. Nothing is run if you do not agree.',
			],
			verdicts: ['fail-to-pass', 'fails-after', 'passes-before', 'not-run'],
			profile: ['(deny network*)', '(deny file-write*)', '(allow file-write* (subpath "/private/tmp/w \\"x\\"") (literal "/dev/null") (literal "/dev/zero") (literal "/dev/dtracehelper") (literal "/dev/tty") (regex #"^/dev/fd/") (regex #"^/dev/ttys[0-9]+$"))'],
		});
	});

	test('a model is not given a task it could not read, counts are by source and holdout, and an instruction is the message without its trailers', () => {
		assert.deepStrictEqual({
			caps: [maxTaskFileChars(4096), maxTaskFileChars(8192), maxTaskFileChars(16_384), maxTaskFileChars(undefined)],
			fits: [taskFitsContext(4000, 4096), taskFitsContext(6000, 4096), taskFitsContext(12_000, 16_384), taskFitsContext(12_001, 131_072), taskFitsContext(0, 16_384)],
			counts: countTasks([
				{ id: '1', commit: 'a', file: 'x.ts', source: 'history', holdout: 'held-out' },
				{ id: '2', commit: 'b', file: 'y.ts', source: 'history', holdout: 'unknown', testFile: 'y.test.ts' },
				{ id: '3', commit: 'c', file: 'z.ts', source: 'request', holdout: 'held-out' },
			]),
			instruction: taskInstruction('Cap the retries at five\n\nThe loop never gave up when the server was down.\n\n\n\nCo-authored-by: Someone <someone@example.invalid>\nSigned-off-by: Someone\nFixes: #12\n'),
			long: taskInstruction('x'.repeat(2000)).length,
		}, {
			caps: [4915, 9830, 12_000, 0],
			fits: [true, false, true, false, false],
			counts: { total: 3, bySource: { history: 2, request: 1 }, byHoldout: { 'held-out': 2, 'not-held-out': 0, unknown: 1 }, withTests: 1 },
			instruction: 'Cap the retries at five\n\nThe loop never gave up when the server was down.',
			long: 1501,
		});
	});
});
