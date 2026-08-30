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

export interface IOnyxSpeculativeMeasurement {
	readonly targetKey: string;
	readonly draftModelId: string;
	readonly withDraft: { readonly tokensPerSecond: number; readonly timeToFirstTokenMs: number };
	readonly withoutDraft: { readonly tokensPerSecond: number; readonly timeToFirstTokenMs: number };
	readonly measuredAt: number;
}

/**
 * One plain sentence about what was actually measured. A difference under the
 * noise floor is reported as "no measured effect" — the draft may be
 * mismatched, or the runtime may have silently ignored the parameter, and
 * claiming a speedup either way would be a lie.
 */
export function formatSpeculativeReadout(measurement: IOnyxSpeculativeMeasurement): string {
	const speedup = measurement.withoutDraft.tokensPerSecond > 0
		? measurement.withDraft.tokensPerSecond / measurement.withoutDraft.tokensPerSecond
		: 1;
	const withText = `${measurement.withDraft.tokensPerSecond.toFixed(1)} tok/s`;
	const withoutText = `${measurement.withoutDraft.tokensPerSecond.toFixed(1)} tok/s`;
	const target = measurement.targetKey.split('/').pop() ?? measurement.targetKey;
	if (speedup >= 1.1) {
		return `speculative decoding (${target}): ${withText} with draft ${measurement.draftModelId} vs ${withoutText} without — ${((speedup - 1) * 100).toFixed(0)}% faster, measured on this machine`;
	}
	if (speedup <= 0.9) {
		return `speculative decoding (${target}): draft ${measurement.draftModelId} made it slower here (${withText} vs ${withoutText}) — consider removing the pairing`;
	}
	// Measured on a real LM Studio: a validated, genuinely attached draft can
	// still show nothing when the target is already fast — verifying the
	// draft's tokens costs about what it saves. Speculation pays when the
	// target is much larger than the draft, so that is what this says.
	return `speculative decoding (${target}): no measured effect with draft ${measurement.draftModelId} (${withText} vs ${withoutText}) — the draft is probably too close in size to the target to pay for itself`;
}
