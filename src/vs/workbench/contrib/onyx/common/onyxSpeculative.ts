/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Speculative decoding support: a small draft model proposes tokens and the
 * large target verifies them, which can raise tok/s without changing output.
 * Onyx's stance is honesty-first — support differs per runtime and the only
 * trustworthy signal is a measurement taken on this machine, so this module
 * holds the pure parts: which runtimes can take a per-request draft model at
 * all, which installed models make plausible drafts, and how a measured
 * comparison is summarized without ever inventing a speedup.
 */

import { OnyxRuntimeKind } from '../../../../platform/onyxRuntime/common/onyxRuntime.js';

export type OnyxSpeculativeSupport =
	/** The runtime accepts a per-request draft model (LM Studio). */
	| 'per-request'
	/** The server decides at launch (llama.cpp `--model-draft`); a request cannot turn it on. */
	| 'server-configured'
	/** The runtime has no speculative decoding surface Onyx can reach. */
	| 'unsupported';

/** What each runtime can do today; measurement remains the ground truth. */
export function speculativeSupport(runtime: OnyxRuntimeKind): OnyxSpeculativeSupport {
	switch (runtime) {
		case 'lmstudio': return 'per-request';
		case 'llamacpp': return 'server-configured';
		case 'ollama': return 'unsupported';
		case 'vllm': return 'server-configured';
		default: return 'unsupported';
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
	return `speculative decoding (${target}): no measured effect with draft ${measurement.draftModelId} (${withText} vs ${withoutText}) — the runtime may ignore the draft`;
}
