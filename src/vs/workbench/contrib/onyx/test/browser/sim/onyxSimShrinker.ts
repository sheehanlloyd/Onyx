/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { OnyxSimEpisode, OnyxSimModelTurn } from './onyxSimEpisode.js';

/**
 * Shrinking (L1): on a violation, reduce the script while the violation
 * persists and hand back the minimal script as a ready-to-commit regression
 * fixture. Each candidate is one reduction: drop a user step, drop a fault,
 * drop a model turn, shorten a string, or simplify the persona label. The
 * predicate runs the candidate and says whether the same violation is still
 * found; a candidate that no longer violates is discarded.
 */

export type OnyxSimViolationPredicate = (episode: OnyxSimEpisode) => Promise<boolean>;

function shortenTurn(turn: OnyxSimModelTurn): OnyxSimModelTurn | undefined {
	switch (turn.kind) {
		case 'text':
		case 'truncated':
			return turn.text.length > 8 ? { ...turn, text: turn.text.slice(0, Math.ceil(turn.text.length / 2)) } : undefined;
		case 'toolCall': {
			if (turn.argumentsText && turn.argumentsText.length > 8) {
				return { ...turn, argumentsText: turn.argumentsText.slice(0, Math.ceil(turn.argumentsText.length / 2)) };
			}
			if (typeof turn.arguments === 'object' && turn.arguments !== null) {
				const entries = Object.entries(turn.arguments as Record<string, unknown>);
				const long = entries.find(([, value]) => typeof value === 'string' && value.length > 8);
				if (long) {
					const [key, value] = long;
					return { ...turn, arguments: { ...(turn.arguments as Record<string, unknown>), [key]: (value as string).slice(0, Math.ceil((value as string).length / 2)) } };
				}
			}
			return undefined;
		}
		default:
			return undefined;
	}
}

function* candidates(episode: OnyxSimEpisode): Generator<OnyxSimEpisode> {
	for (let index = 0; index < episode.userSteps.length; index++) {
		yield { ...episode, userSteps: episode.userSteps.filter((_, i) => i !== index) };
	}
	for (let index = 0; index < episode.faults.length; index++) {
		yield { ...episode, faults: episode.faults.filter((_, i) => i !== index) };
	}
	if (episode.turns.length > 1) {
		for (let index = 0; index < episode.turns.length; index++) {
			yield { ...episode, turns: episode.turns.filter((_, i) => i !== index) };
		}
	}
	for (let index = 0; index < episode.turns.length; index++) {
		const shorter = shortenTurn(episode.turns[index]);
		if (shorter) {
			yield { ...episode, turns: episode.turns.map((turn, i) => i === index ? shorter : turn) };
		}
	}
	if (episode.projectConfig) {
		yield { ...episode, projectConfig: undefined };
	}
	if (episode.profile) {
		yield { ...episode, profile: undefined };
	}
	if (episode.prompt.length > 8) {
		yield { ...episode, prompt: episode.prompt.slice(0, Math.ceil(episode.prompt.length / 2)) };
	}
}

export function episodeSize(episode: OnyxSimEpisode): number {
	return JSON.stringify(episode).length;
}

/**
 * Greedy, deterministic: takes the first candidate that still violates,
 * restarts from it, and stops when no candidate does. Bounded by
 * `maxRuns` predicate evaluations so a flaky predicate cannot loop forever.
 */
export async function shrinkEpisode(episode: OnyxSimEpisode, stillViolates: OnyxSimViolationPredicate, maxRuns = 400): Promise<{ readonly episode: OnyxSimEpisode; readonly runs: number; readonly before: number; readonly after: number }> {
	let current = episode;
	let runs = 0;
	let progressed = true;
	while (progressed && runs < maxRuns) {
		progressed = false;
		for (const candidate of candidates(current)) {
			if (runs >= maxRuns) {
				break;
			}
			runs++;
			if (await stillViolates(candidate)) {
				current = { ...candidate, name: `${episode.name}-shrunk` };
				progressed = true;
				break;
			}
		}
	}
	return { episode: current, runs, before: episodeSize(episode), after: episodeSize(current) };
}
