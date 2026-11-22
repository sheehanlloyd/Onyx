/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The determinism measure (L15, R-54, H-6): given the same unit run several
 * times, how many of the repetitions are the same trajectory as the first,
 * where the others first differ, and whose doing that was.
 *
 * A trajectory is what a trace keeps of a run: for each model turn the
 * digest of the request, the text of the response, and each tool call with
 * the digests of its arguments and its result. Two are the same when all of
 * that is equal, turn for turn.
 *
 * Where two first differ says who differed. The request of a turn is made
 * by the harness from what came before it: if everything before a turn is
 * equal and the requests are not, the harness (or a tool's result) was not
 * deterministic. If the requests are equal and the responses are not, the
 * runtime was not.
 */

export interface IOnyxTrajectoryToolCall {
	readonly name: string;
	readonly argumentsDigest: string;
	readonly resultDigest?: string;
	readonly ok?: boolean;
}

export interface IOnyxTrajectoryTurn {
	readonly requestDigest: string;
	readonly responseText: string;
	readonly toolCalls: readonly IOnyxTrajectoryToolCall[];
}

export interface IOnyxTrajectory {
	readonly turns: readonly IOnyxTrajectoryTurn[];
	/** What the run came to, in whatever terms the caller scores it: compared for equality only. */
	readonly outcome: string;
	/** Whether the trace says the runtime honoured the seed. */
	readonly seedHonoured: boolean | 'unknown';
}

/**
 * Who a divergence is attributed to. `runtime`: the same request got a
 * different response. `harness`: a different request, or a different tool
 * result, followed an identical past. `length`: one run stopped where the
 * other went on with an identical past, which is the harness too (the
 * decision to stop is its own) but is named apart.
 */
export type OnyxDivergenceSource = 'runtime' | 'harness' | 'length';

export interface IOnyxDivergence {
	/** The first turn that differs, counted from 1. */
	readonly turn: number;
	readonly source: OnyxDivergenceSource;
	/** What differed at that turn. */
	readonly what: 'request' | 'response' | 'tool-calls' | 'tool-results' | 'length';
}

const sameCalls = (first: readonly IOnyxTrajectoryToolCall[], second: readonly IOnyxTrajectoryToolCall[]) =>
	first.length === second.length && first.every((call, index) => call.name === second[index].name && call.argumentsDigest === second[index].argumentsDigest);
const sameResults = (first: readonly IOnyxTrajectoryToolCall[], second: readonly IOnyxTrajectoryToolCall[]) =>
	first.every((call, index) => call.resultDigest === second[index].resultDigest && call.ok === second[index].ok);

/** Where two trajectories first differ; `undefined` when they are the same. */
export function firstDivergence(first: IOnyxTrajectory, second: IOnyxTrajectory): IOnyxDivergence | undefined {
	const shared = Math.min(first.turns.length, second.turns.length);
	for (let index = 0; index < shared; index++) {
		const a = first.turns[index];
		const b = second.turns[index];
		if (a.requestDigest !== b.requestDigest) {
			return { turn: index + 1, source: 'harness', what: 'request' };
		}
		if (a.responseText !== b.responseText) {
			return { turn: index + 1, source: 'runtime', what: 'response' };
		}
		// The calls are read out of the response: with equal text, different calls are the harness's reading.
		if (!sameCalls(a.toolCalls, b.toolCalls)) {
			return { turn: index + 1, source: a.responseText === '' ? 'runtime' : 'harness', what: 'tool-calls' };
		}
		if (!sameResults(a.toolCalls, b.toolCalls)) {
			return { turn: index + 1, source: 'harness', what: 'tool-results' };
		}
	}
	return first.turns.length === second.turns.length ? undefined : { turn: shared + 1, source: 'length', what: 'length' };
}

export interface IOnyxDeterminismUnit {
	/** What was repeated: a model, a configuration and a task. */
	readonly key: string;
	readonly group: string;
	/** The repetitions, in the order they ran. The first is what the others are compared with. */
	readonly repetitions: readonly IOnyxTrajectory[];
}

export interface IOnyxDeterminismGroup {
	readonly group: string;
	readonly units: number;
	/** Repetitions after the first: each is one comparison. */
	readonly comparisons: number;
	readonly identical: number;
	/** Units whose every repetition is the same as its first. */
	readonly unitsAllIdentical: number;
	/** How many comparisons first differ at each turn: index 0 is turn 1. */
	readonly firstDivergingTurn: readonly number[];
	readonly bySource: Readonly<Record<OnyxDivergenceSource, number>>;
	/** Of the comparisons that differ, how many ended with a different outcome. */
	readonly divergedWithADifferentOutcome: number;
	/** Comparisons where either trace does not say the seed was honoured: counted in the totals and here. */
	readonly seedNotKnownHonoured: number;
	/** The comparisons that are the harness's doing, by unit: the study is invalid while there are any. */
	readonly harnessDivergences: readonly { readonly key: string; readonly repetition: number; readonly turn: number; readonly what: string }[];
}

/** The measure, by group (a model, usually). Units with fewer than two repetitions are counted and compared with nothing. */
export function measureDeterminism(units: readonly IOnyxDeterminismUnit[]): IOnyxDeterminismGroup[] {
	const groups = new Map<string, { units: number; comparisons: number; identical: number; unitsAllIdentical: number; turns: number[]; bySource: Record<OnyxDivergenceSource, number>; changed: number; seed: number; harness: { key: string; repetition: number; turn: number; what: string }[] }>();
	for (const unit of units) {
		let group = groups.get(unit.group);
		if (!group) {
			group = { units: 0, comparisons: 0, identical: 0, unitsAllIdentical: 0, turns: [], bySource: { runtime: 0, harness: 0, length: 0 }, changed: 0, seed: 0, harness: [] };
			groups.set(unit.group, group);
		}
		group.units++;
		const [reference, ...others] = unit.repetitions;
		let all = others.length > 0;
		others.forEach((repetition, index) => {
			group.comparisons++;
			if (reference.seedHonoured !== true || repetition.seedHonoured !== true) {
				group.seed++;
			}
			const divergence = firstDivergence(reference, repetition);
			if (!divergence) {
				group.identical++;
				return;
			}
			all = false;
			group.turns[divergence.turn - 1] = (group.turns[divergence.turn - 1] ?? 0) + 1;
			group.bySource[divergence.source]++;
			if (repetition.outcome !== reference.outcome) {
				group.changed++;
			}
			if (divergence.source !== 'runtime') {
				group.harness.push({ key: unit.key, repetition: index + 2, turn: divergence.turn, what: divergence.what });
			}
		});
		if (all) {
			group.unitsAllIdentical++;
		}
	}
	return [...groups].map(([name, group]) => ({
		group: name, units: group.units, comparisons: group.comparisons, identical: group.identical, unitsAllIdentical: group.unitsAllIdentical,
		firstDivergingTurn: Array.from(group.turns, count => count ?? 0), bySource: group.bySource, divergedWithADifferentOutcome: group.changed, seedNotKnownHonoured: group.seed, harnessDivergences: group.harness,
	}));
}

/** H-6 by its registered thresholds, from the identical share and its 95% interval. */
export function decideH6(share: { readonly low: number; readonly value: number; readonly high: number }): 'supported' | 'refuted' | 'inconclusive' {
	if (share.value >= 0.9 && share.low >= 0.8) {
		return 'supported';
	}
	return share.high < 0.9 ? 'refuted' : 'inconclusive';
}
