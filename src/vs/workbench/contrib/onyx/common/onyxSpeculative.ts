/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Speculative decoding support: a small draft model proposes tokens and the
 * large target verifies them, which can raise tok/s without changing output.
 *
 * Every runtime Onyx speaks to configures this when the model is LOADED, not
 * per request — LM Studio 0.4.x rejects a per-request draft outright ("Engine
 * protocol speculative decoding must be configured at load time, not
 * prediction time"), and llama.cpp and vLLM take it as a server flag. So Onyx
 * never sends a draft on the wire; it tells you how to enable it on your
 * runtime, and then measures honestly whether it actually helped on this
 * machine. That measurement is the feature — a speedup is never claimed
 * unless it was observed here.
 */

import { OnyxRuntimeKind } from '../../../../platform/onyxRuntime/common/onyxRuntime.js';

export type OnyxSpeculativeSupport =
	/**
	 * The runtime supports it, but only as part of loading the model — Onyx
	 * cannot switch it on for one request, so it explains how and measures.
	 */
	| 'load-time'
	/** The runtime has no speculative decoding surface Onyx can reach. */
	| 'unsupported';

/** What each runtime can do today; measurement remains the ground truth. */
export function speculativeSupport(runtime: OnyxRuntimeKind): OnyxSpeculativeSupport {
	switch (runtime) {
		// Verified against LM Studio 0.4.23: a per-request `draft_model` is
		// rejected with an explicit "configure at load time" error.
		case 'lmstudio': return 'load-time';
		case 'llamacpp': return 'load-time';
		case 'vllm': return 'load-time';
		case 'ollama': return 'unsupported';
		default: return 'unsupported';
	}
}

/** How to actually turn it on, per runtime — shown verbatim to the user. */
export function speculativeSetupHint(runtime: OnyxRuntimeKind, target: string, draft: string): string {
	switch (runtime) {
		case 'lmstudio':
			return `In LM Studio, reload ${target} with a draft model — in the app's model settings enable speculative decoding and pick ${draft}, or run:\n  lms load ${target} --speculative-draft-simple --speculative-draft-model ${draft}`;
		case 'llamacpp':
			return `Restart llama.cpp's server with a draft model:\n  llama-server -m ${target} --model-draft ${draft}`;
		case 'vllm':
			return `Restart vLLM with a draft model:\n  vllm serve ${target} --speculative-model ${draft}`;
		default:
			return `${runtime} has no speculative decoding option Onyx can reach.`;
	}
}

export interface IOnyxDraftCandidate {
	readonly modelId: string;
	readonly parameterB: number | undefined;
	/** Same model family as the target — drafts from another family rarely verify. */
	readonly sameFamily: boolean;
}

/**
 * Which installed models make plausible drafts for a target: smaller ones
 * first, same-family ones preferred (a draft is only useful when the target
 * accepts most of its proposals, which needs a shared tokenizer and similar
 * training). The target itself is excluded.
 */
export function candidateDrafts(
	models: readonly { readonly id: string; readonly family: string | undefined; readonly parameterB: number | undefined }[],
	target: { readonly id: string; readonly family: string | undefined; readonly parameterB: number | undefined },
): IOnyxDraftCandidate[] {
	return models
		.filter(model => model.id !== target.id)
		.filter(model => model.parameterB === undefined || target.parameterB === undefined || model.parameterB < target.parameterB)
		.map(model => ({
			modelId: model.id,
			parameterB: model.parameterB,
			sameFamily: !!model.family && !!target.family && model.family === target.family,
		}))
		.sort((a, b) => Number(b.sameFamily) - Number(a.sameFamily) || (a.parameterB ?? Infinity) - (b.parameterB ?? Infinity));
}

/**
 * The two kinds of text a speculative measurement uses. Measured on LM Studio
 * 0.4.23 with a 0.5B draft for a 7B target, code went 1.36 times as fast and
 * general prose 0.94 times (`docs/research/results/2026-11-24-speculative/`):
 * one number for both would be wrong for one of them.
 */
export const ONYX_SPECULATIVE_PROMPTS = {
	code: 'Write a TypeScript function that parses an ISO 8601 date string and returns the number of whole days between it and another such date. Explain each step in a comment.',
	prose: 'In about two hundred words, explain to a new programmer why version control matters, using one concrete example.',
} as const;

export type OnyxSpeculativeContent = keyof typeof ONYX_SPECULATIVE_PROMPTS;

/** One speed: generated tokens a second, and the time to the first token. */
export interface IOnyxSpeculativeSpeed {
	readonly tokensPerSecond: number;
	readonly timeToFirstTokenMs: number;
}

/**
 * Whether the runtime said the draft was attached to the target when the
 * "with draft" numbers were taken. `attached`: it named the draft that was
 * chosen. `other`: it named another one. `not-attached`: it said the target
 * had none. `unknown`: it does not say (only LM Studio does, in its REST
 * model list).
 */
export type OnyxDraftAttachment = 'attached' | 'other' | 'not-attached' | 'unknown';

export interface IOnyxSpeculativeMeasurement {
	readonly targetKey: string;
	readonly draftModelId: string;
	/** Code, without and with the draft: the median of the rounds. Measurements from before 2026-11-24 have one prompt only, here. */
	readonly withDraft: IOnyxSpeculativeSpeed;
	readonly withoutDraft: IOnyxSpeculativeSpeed;
	/** Prose, the same way. Absent from measurements taken before 2026-11-24. */
	readonly prose?: { readonly withDraft: IOnyxSpeculativeSpeed; readonly withoutDraft: IOnyxSpeculativeSpeed };
	/** What the runtime said about the draft when the "with" numbers were taken. Absent from measurements taken before 2026-11-24. */
	readonly attachment?: OnyxDraftAttachment;
	/** The draft the runtime named, when it named one. */
	readonly attachedDraft?: string;
	readonly measuredAt: number;
}

/** The middle of the numbers (the lower middle for an even count): what a round usually does, not its best day. */
export function medianSpeed(samples: readonly IOnyxSpeculativeSpeed[]): IOnyxSpeculativeSpeed {
	const middle = (values: readonly number[]) => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.floor((sorted.length - 1) / 2)] ?? 0; };
	return { tokensPerSecond: middle(samples.map(sample => sample.tokensPerSecond)), timeToFirstTokenMs: middle(samples.map(sample => sample.timeToFirstTokenMs)) };
}

/** What the runtime's answer about the loaded target means for the measurement. */
export function draftAttachment(chosenDraft: string, reported: { readonly known: boolean; readonly draft: string | undefined }): OnyxDraftAttachment {
	if (!reported.known) {
		return 'unknown';
	}
	if (reported.draft === undefined) {
		return 'not-attached';
	}
	return reported.draft === chosenDraft ? 'attached' : 'other';
}

function describeChange(kind: string, withDraft: IOnyxSpeculativeSpeed, withoutDraft: IOnyxSpeculativeSpeed): string {
	const speedup = withoutDraft.tokensPerSecond > 0 ? withDraft.tokensPerSecond / withoutDraft.tokensPerSecond : 1;
	const numbers = `${withDraft.tokensPerSecond.toFixed(1)} vs ${withoutDraft.tokensPerSecond.toFixed(1)} tok/s`;
	if (speedup >= 1.1) {
		return `${kind} ${((speedup - 1) * 100).toFixed(0)}% faster (${numbers})`;
	}
	if (speedup <= 0.9) {
		return `${kind} ${((1 - speedup) * 100).toFixed(0)}% slower (${numbers})`;
	}
	return `${kind} no measured effect (${numbers})`;
}

/**
 * One plain sentence about what was actually measured. A difference under the
 * noise floor is reported as "no measured effect". Code and prose are
 * reported apart. A draft the runtime said was not attached, or was another
 * one, is said as such and no speed is put down to it.
 */
export function formatSpeculativeReadout(measurement: IOnyxSpeculativeMeasurement): string {
	const target = measurement.targetKey.split('/').pop() ?? measurement.targetKey;
	if (measurement.attachment === 'not-attached') {
		return `speculative decoding (${target}): the runtime said no draft was attached when it was measured again, so nothing was measured with ${measurement.draftModelId}`;
	}
	if (measurement.attachment === 'other') {
		return `speculative decoding (${target}): the runtime had ${measurement.attachedDraft ?? 'another draft'} attached, not ${measurement.draftModelId}, so the numbers are not about ${measurement.draftModelId}`;
	}
	const attached = measurement.attachment === 'attached' ? ', attached' : '';
	if (!measurement.prose) {
		// A measurement from before code and prose were measured apart: one prompt, said as such.
		return `speculative decoding (${target}, draft ${measurement.draftModelId}${attached}): ${describeChange('one prompt:', measurement.withDraft, measurement.withoutDraft)}, measured on this machine`;
	}
	return `speculative decoding (${target}, draft ${measurement.draftModelId}${attached}): ${describeChange('code', measurement.withDraft, measurement.withoutDraft)}; ${describeChange('prose', measurement.prose.withDraft, measurement.prose.withoutDraft)}; measured on this machine`;
}
