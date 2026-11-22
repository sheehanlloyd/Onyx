/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { decideH6, firstDivergence, IOnyxTrajectory, IOnyxTrajectoryTurn, measureDeterminism } from '../../common/onyxDeterminism.js';

/**
 * R-54 (L15), the pure half: the determinism measure on trajectories whose
 * differences are planted. Identical repetitions count as identical; a
 * difference is reported at the turn it was planted at, and attributed to
 * the runtime or to the harness by what differs first.
 */
suite('OnyxDeterminism', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const turn = (index: number, change: Partial<IOnyxTrajectoryTurn> = {}): IOnyxTrajectoryTurn => ({ requestDigest: `request-${index}`, responseText: `response ${index}`, toolCalls: [{ name: 'readFile', argumentsDigest: `arguments-${index}`, resultDigest: `result-${index}`, ok: true }], ...change });
	const run = (turns: number, changes: Record<number, Partial<IOnyxTrajectoryTurn>> = {}, outcome = 'attempted|true|1'): IOnyxTrajectory => ({ turns: Array.from({ length: turns }, (_, index) => turn(index + 1, changes[index + 1])), outcome, seedHonoured: true });

	test('R-54: identical repetitions are 100% identical; a difference planted at a known turn is reported at that turn, and attributed by what differs first', () => {
		const same = measureDeterminism([{ key: 'a', group: 'model', repetitions: [run(4), run(4), run(4)] }, { key: 'b', group: 'model', repetitions: [run(2), run(2), run(2)] }]);
		const planted = measureDeterminism([
			// The runtime answered the same request differently at turn 3, and the run ended differently.
			{ key: 'a', group: 'model', repetitions: [run(4), run(4), run(4, { 3: { responseText: 'something else' }, 4: { requestDigest: 'follows from it' } }, 'attempted|false|0')] },
			// The harness built a different request at turn 2 from an identical past.
			{ key: 'b', group: 'model', repetitions: [run(3), run(3, { 2: { requestDigest: 'not the same' } })] },
			// A tool gave a different result for the same call at turn 1; one run stopped a turn early.
			{ key: 'c', group: 'other', repetitions: [run(3), run(3, { 1: { toolCalls: [{ name: 'readFile', argumentsDigest: 'arguments-1', resultDigest: 'changed', ok: true }] } }), run(2)] },
			// One repetition: nothing to compare.
			{ key: 'd', group: 'other', repetitions: [run(3)] },
		]);
		assert.deepStrictEqual({
			same,
			planted,
			firstDivergence: [firstDivergence(run(3), run(3)), firstDivergence(run(3), run(3, { 2: { toolCalls: [] } }))],
		}, {
			same: [{ group: 'model', units: 2, comparisons: 4, identical: 4, unitsAllIdentical: 2, firstDivergingTurn: [], bySource: { runtime: 0, harness: 0, length: 0 }, divergedWithADifferentOutcome: 0, seedNotKnownHonoured: 0, harnessDivergences: [] }],
			planted: [
				{
					group: 'model', units: 2, comparisons: 3, identical: 1, unitsAllIdentical: 0, firstDivergingTurn: [0, 1, 1], bySource: { runtime: 1, harness: 1, length: 0 }, divergedWithADifferentOutcome: 1, seedNotKnownHonoured: 0,
					harnessDivergences: [{ key: 'b', repetition: 2, turn: 2, what: 'request' }],
				},
				{
					group: 'other', units: 2, comparisons: 2, identical: 0, unitsAllIdentical: 0, firstDivergingTurn: [1, 0, 1], bySource: { runtime: 0, harness: 1, length: 1 }, divergedWithADifferentOutcome: 0, seedNotKnownHonoured: 0,
					harnessDivergences: [{ key: 'c', repetition: 2, turn: 1, what: 'tool-results' }, { key: 'c', repetition: 3, turn: 3, what: 'length' }],
				},
			],
			firstDivergence: [undefined, { turn: 2, source: 'harness', what: 'tool-calls' }],
		});
	});

	test('H-6 is decided by its registered thresholds, and a trace that does not say the seed was honoured is counted as that', () => {
		const unknownSeed = measureDeterminism([{ key: 'a', group: 'model', repetitions: [{ ...run(2), seedHonoured: 'unknown' }, run(2)] }]);
		assert.deepStrictEqual({
			decisions: [decideH6({ value: 0.95, low: 0.85, high: 0.99 }), decideH6({ value: 0.95, low: 0.75, high: 0.99 }), decideH6({ value: 0.5, low: 0.4, high: 0.6 }), decideH6({ value: 0.85, low: 0.7, high: 0.93 })],
			seedNotKnownHonoured: unknownSeed[0].seedNotKnownHonoured,
			stillCompared: unknownSeed[0].identical,
		}, {
			decisions: ['supported', 'inconclusive', 'refuted', 'inconclusive'],
			seedNotKnownHonoured: 1,
			stillCompared: 1,
		});
	});
});
