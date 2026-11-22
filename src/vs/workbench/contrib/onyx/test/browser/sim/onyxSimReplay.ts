/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { runWithFakedTimers } from '../../../../../../base/test/common/timeTravelScheduler.js';
import { diffRuns } from '../../../common/onyxRunDiff.js';
import { IOnyxRequestRecord, IOnyxRunEvent } from '../../../common/onyxTypes.js';
import { OnyxSimEpisode, OnyxSimModelTurn } from './onyxSimEpisode.js';
import { IOnyxSimResult, IOnyxSimRigOptions, OnyxSimRig } from './onyxSimRig.js';

/**
 * Trace conformance replay (L8, R-48). A recorded trace is a run that
 * happened: the world it ran in, every response the model gave, and the
 * sequence of events the harness produced. Replaying it serves the same
 * responses to the harness as it is now, in the simulation rig, and
 * compares the events. The same events are a pass. Different events are a
 * change in the harness's behaviour, shown at the first place it differs:
 * the change is either a regression to fix, or intended, and then the
 * expected trace is replaced together with one line saying why.
 *
 * What is served back is the model's responses. Tool results are not served
 * back: the rig's tools are the product's own, run again on the same files,
 * and what they return is part of the events compared. A tool whose output
 * changed is a behaviour change like any other.
 */

/** A recorded run, as `test/onyx/traces/<name>.json` holds it. */
export interface IOnyxRecordedTrace {
	readonly version: 1;
	readonly name: string;
	/** `mock`: the responses are a script. `model`: they were recorded from a real model, named below. */
	readonly source: 'mock' | 'model';
	readonly model: { readonly identifier: string; readonly digest: string; readonly runtime: string } | null;
	/** What the trace is in the corpus for: a persona of the simulated model, a supported workflow, or both. */
	readonly covers: { readonly persona?: string; readonly workflow?: string };
	/** One line: why this is the expected trace. Replaced whenever the expected events are. */
	readonly reason: string;
	/** The world and the responses: the files, the request, the user's steps, and every model turn in order. */
	readonly episode: OnyxSimEpisode;
	/** The canonical event sequence of the run, one event a line. */
	readonly expected: readonly string[];
	/** The run's journal when it was recorded, for a readable difference. Not compared. */
	readonly journal: readonly string[];
}

const lines = (text: string): string[] => text.split('\n').filter(line => line.length > 0);

/** A trace of a run that just happened. Its episode holds the turns that were served, so a recording of a live model replays without it. */
export function recordTrace(meta: Pick<IOnyxRecordedTrace, 'name' | 'source' | 'model' | 'covers' | 'reason'>, result: IOnyxSimResult): IOnyxRecordedTrace {
	return {
		version: 1, ...meta,
		episode: { ...result.episode, name: meta.name, turns: meta.source === 'model' ? [...result.servedTurns] : result.episode.turns },
		expected: lines(result.trace),
		journal: lines(result.journal),
	};
}

export function serializeTrace(trace: IOnyxRecordedTrace): string {
	return JSON.stringify(trace, undefined, '\t') + '\n';
}

/** Runs an episode in the rig under virtual time. */
export async function runEpisode(episode: OnyxSimEpisode, options: IOnyxSimRigOptions = {}): Promise<IOnyxSimResult> {
	return runWithFakedTimers({ useFakeTimers: true, maxTaskCount: 2_000_000 }, async () => {
		const rig = new OnyxSimRig(episode, [], options);
		try {
			return await rig.run();
		} finally {
			await rig.dispose();
		}
	});
}

export interface IOnyxDivergence {
	/** 1-based: the first event that is not the expected one. */
	readonly event: number;
	readonly expected: string | undefined;
	readonly actual: string | undefined;
	/** The events just before it, which are the same on both sides. */
	readonly before: readonly string[];
}

/** Where two event sequences first differ, or undefined when they are the same. */
export function firstDivergence(expected: readonly string[], actual: readonly string[]): IOnyxDivergence | undefined {
	const length = Math.max(expected.length, actual.length);
	for (let index = 0; index < length; index++) {
		if (expected[index] !== actual[index]) {
			return { event: index + 1, expected: expected[index], actual: actual[index], before: expected.slice(Math.max(0, index - 2), index) };
		}
	}
	return undefined;
}

function asRecord(name: string, journal: readonly string[]): IOnyxRequestRecord {
	const events: IOnyxRunEvent[] = [];
	for (const line of journal) {
		try {
			events.push(JSON.parse(line) as IOnyxRunEvent);
		} catch {
			// a torn line is not an event
		}
	}
	return { runId: name, startedAt: 0, title: name, task: 'implement', modelKey: 'recorded', status: 'completed', turnCount: 0, toolCallCount: 0, events };
}

const clip = (text: string | undefined): string => text === undefined ? '(nothing: the sequence ends here)' : text.length > 400 ? `${text.slice(0, 400)}…` : text;

/** The report a failed replay prints: the first event that differs, and the first turn of the two journals that differs, row by row. */
export function describeDivergence(trace: IOnyxRecordedTrace, divergence: IOnyxDivergence, actual: IOnyxSimResult): string {
	const report = [
		`trace ${trace.name}: the harness no longer does what this trace records. First divergence at event ${divergence.event} of ${trace.expected.length}.`,
		...divergence.before.map(line => `    same  ${clip(line)}`),
		`  expected  ${clip(divergence.expected)}`,
		`    actual  ${clip(divergence.actual)}`,
	];
	const sections = diffRuns(asRecord(`${trace.name} (recorded)`, trace.journal), asRecord(`${trace.name} (now)`, lines(actual.journal)));
	const changed = sections.find(section => (section.kind === 'turn' && section.changed) || (section.kind === 'outcome' && section.rows.some(row => row.changed)));
	if (changed && changed.kind !== 'elision') {
		report.push(changed.kind === 'turn' ? `  the first turn that differs is turn ${changed.turn}:` : '  the outcome differs:');
		for (const row of changed.rows.filter(candidate => candidate.changed)) {
			report.push(`    ${row.label}`, `      recorded  ${clip(row.left)}`, `      now       ${clip(row.right)}`);
		}
	}
	report.push('  Fix the regression, or, if the change is intended, record the new expected trace with one line saying why (test/onyx/README.md, "Trace conformance replay").');
	return report.join('\n');
}

export type OnyxReplayOutcome =
	| { readonly identical: true; readonly result: IOnyxSimResult }
	| { readonly identical: false; readonly result: IOnyxSimResult; readonly divergence: IOnyxDivergence; readonly report: string };

/** Replays a recorded trace through the harness as it is now and compares the events. */
export async function replayTrace(trace: IOnyxRecordedTrace, options: IOnyxSimRigOptions = {}): Promise<OnyxReplayOutcome> {
	const result = await runEpisode(trace.episode, options);
	const divergence = firstDivergence(trace.expected, lines(result.trace));
	return divergence ? { identical: false, result, divergence, report: describeDivergence(trace, divergence, result) } : { identical: true, result };
}

/**
 * The trace with the events of `result` as the expected ones. A new
 * expected trace always arrives with its reason: one line, not empty, and
 * not the reason it had.
 */
export function updateExpected(trace: IOnyxRecordedTrace, result: IOnyxSimResult, reason: string): { readonly ok: true; readonly trace: IOnyxRecordedTrace } | { readonly ok: false; readonly error: string } {
	const line = reason.trim();
	if (line === '' || line.includes('\n')) {
		return { ok: false, error: 'a new expected trace needs a reason: one line saying why the harness now behaves differently' };
	}
	if (line === trace.reason) {
		return { ok: false, error: 'the reason is the one the trace already had: say why the behaviour changed this time' };
	}
	return { ok: true, trace: { ...trace, reason: line, expected: lines(result.trace), journal: lines(result.journal) } };
}

/** A run that followed a recorded trace up to a turn and then went its own way. */
export interface IOnyxCounterfactual {
	/** Always this: the result is of a run that was executed, not of a calculation over the record. */
	readonly label: 'executed counterfactual';
	readonly trace: string;
	/** How many recorded model turns were served before the continuation began. */
	readonly prefixTurns: number;
	readonly continuation: 'mock' | 'live';
	readonly result: IOnyxSimResult;
}

/**
 * Cut-point mode: serves the record's first `prefixTurns` model turns and
 * then continues, with a scripted continuation (the mock) or a live source.
 * Two harness configurations run this way saw the same model responses up
 * to the cut, so what differs afterwards is the harness. Whatever comes of
 * it is an executed counterfactual: one run under each arm, and nothing
 * more is claimed for it.
 */
export async function runFromCutPoint(trace: IOnyxRecordedTrace, prefixTurns: number, continuation: readonly OnyxSimModelTurn[] | NonNullable<IOnyxSimRigOptions['liveTurn']>, options: IOnyxSimRigOptions = {}): Promise<IOnyxCounterfactual> {
	const prefix = trace.episode.turns.slice(0, prefixTurns);
	const scripted = typeof continuation !== 'function';
	const episode: OnyxSimEpisode = { ...trace.episode, name: `${trace.name}@${prefix.length}`, turns: scripted ? [...prefix, ...continuation] : prefix };
	const result = await runEpisode(episode, scripted ? options : { ...options, liveTurn: continuation });
	return { label: 'executed counterfactual', trace: trace.name, prefixTurns: prefix.length, continuation: scripted ? 'mock' : 'live', result };
}
