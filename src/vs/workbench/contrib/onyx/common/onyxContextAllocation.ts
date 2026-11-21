/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';

/**
 * Context allocation (B15, R-61): asking a runtime for the context a model can
 * use, and believing only what was then seen to work.
 *
 * Three numbers are kept apart everywhere. **Requested** is what Onyx asked
 * for. **Reported** is what the runtime says it allocated afterwards.
 * **Verified** is what a probe saw: a code planted at the start of a prompt
 * came back from a prompt longer than the old allocation, and was lost from
 * one longer than the new. The budget (B13) is given the verified number and
 * no other. A request the runtime ignored, or a report the probe could not
 * confirm, leaves the server's own allocation in force.
 *
 * Pure, and importable from plain Node: the lab scripts use the same rules.
 */
export const ONYX_CONTEXT_ALLOCATION = {
	/** What is asked for when the user has set nothing: enough for several tool results in a turn, far below what the pinned models were trained with. */
	defaultRequestTokens: 16_384,
	/** The share of the machine's memory a loaded model and its context may take together. The rest is the editor's, the system's and the user's. */
	memoryShare: 0.5,
	/**
	 * What a token of context is taken to cost in memory. Measured on the
	 * reference machine (Ollama 0.33.0, from 4,096 to 16,384 tokens): 69 KiB a
	 * token for the 7B model and 35 KiB for the 1.5B
	 * (docs/research/results/2026-11-21-context-allocation). The larger is
	 * rounded up by a third, so the ceiling errs low.
	 */
	bytesPerContextToken: 96 * 1024,
	/** A model whose size the runtime does not give is taken to need this share of the machine's memory before any context. */
	unknownModelShare: 0.25,
	/** Targets are whole multiples of this. */
	stepTokens: 1024,
	/** Below this there is nothing worth asking for: the eight-tool agent needs about this much to hold one tool result (B13). */
	minRequestTokens: 4096,
	/**
	 * The verification prompts, as shares of an allocation. The control is a share of the old allocation in
	 * estimated tokens (four characters a token). The other two are shares of the new one in the runtime's own
	 * count, once the control has shown how the runtime counts the probe's text: nine tenths of the allocation
	 * has to keep its start, and a prompt a quarter longer than the allocation has to lose it.
	 */
	controlShare: 0.5,
	insideShare: 0.9,
	pastShare: 1.25,
} as const;

export type OnyxContextLimit = 'trained' | 'memory' | 'setting';

export interface IOnyxContextTargetInput {
	/** What the model was trained with, as the runtime reports it. Unknown: nothing is requested. */
	readonly trainedTokens?: number;
	readonly machineMemoryBytes?: number;
	/** The size of the model's files on the runtime. */
	readonly modelBytes?: number;
	/** The user's setting; `0` means "keep the server's allocation". Unset: the default. */
	readonly settingTokens?: number;
	/** What the server allocates today, when known. A target that is no larger is not worth a request. */
	readonly currentTokens?: number;
}

export interface IOnyxContextTarget {
	/** The context to ask for, or undefined when nothing should be asked. */
	readonly tokens: number | undefined;
	/** Which of the three bounds decided the number. */
	readonly limitedBy: OnyxContextLimit | undefined;
	/** The ceiling from the machine's memory, in tokens, when the memory is known. */
	readonly memoryCeilingTokens: number | undefined;
	/** Why nothing is asked for, when nothing is. */
	readonly reason?: 'trained-unknown' | 'kept-by-setting' | 'no-room' | 'nothing-to-gain';
}

/** The ceiling the machine's memory puts on a model's context: half the memory, less the model, at 96 KiB a token. */
export function memoryCeilingTokens(machineMemoryBytes: number, modelBytes: number | undefined): number {
	const model = modelBytes ?? machineMemoryBytes * ONYX_CONTEXT_ALLOCATION.unknownModelShare;
	const room = machineMemoryBytes * ONYX_CONTEXT_ALLOCATION.memoryShare - model;
	return Math.max(0, Math.floor(room / ONYX_CONTEXT_ALLOCATION.bytesPerContextToken));
}

/**
 * The context to ask for: the smallest of what the model was trained with,
 * what the machine's memory allows and what the user set, rounded down to a
 * whole step. Never more than the trained context, and nothing at all when
 * that is unknown.
 */
export function contextTarget(input: IOnyxContextTargetInput): IOnyxContextTarget {
	const memoryCeiling = input.machineMemoryBytes && input.machineMemoryBytes > 0 ? memoryCeilingTokens(input.machineMemoryBytes, input.modelBytes) : undefined;
	if (!input.trainedTokens || input.trainedTokens <= 0) {
		return { tokens: undefined, limitedBy: undefined, memoryCeilingTokens: memoryCeiling, reason: 'trained-unknown' };
	}
	if (input.settingTokens === 0) {
		return { tokens: undefined, limitedBy: undefined, memoryCeilingTokens: memoryCeiling, reason: 'kept-by-setting' };
	}
	const setting = input.settingTokens && input.settingTokens > 0 ? input.settingTokens : ONYX_CONTEXT_ALLOCATION.defaultRequestTokens;
	const bounds: (readonly [OnyxContextLimit, number])[] = [['trained', input.trainedTokens], ['setting', setting]];
	if (memoryCeiling !== undefined) {
		bounds.push(['memory', memoryCeiling]);
	}
	let limitedBy: OnyxContextLimit = 'trained';
	let smallest = Number.MAX_SAFE_INTEGER;
	for (const [limit, tokens] of bounds) {
		if (tokens < smallest) {
			smallest = tokens;
			limitedBy = limit;
		}
	}
	// Whole steps, except that the trained context itself may be asked for exactly.
	const tokens = smallest === input.trainedTokens ? smallest : Math.floor(smallest / ONYX_CONTEXT_ALLOCATION.stepTokens) * ONYX_CONTEXT_ALLOCATION.stepTokens;
	if (tokens < ONYX_CONTEXT_ALLOCATION.minRequestTokens) {
		return { tokens: undefined, limitedBy, memoryCeilingTokens: memoryCeiling, reason: 'no-room' };
	}
	if (input.currentTokens !== undefined && tokens <= input.currentTokens) {
		return { tokens: undefined, limitedBy, memoryCeilingTokens: memoryCeiling, reason: 'nothing-to-gain' };
	}
	return { tokens, limitedBy, memoryCeilingTokens: memoryCeiling };
}

/** What a verification prompt is for. */
export type OnyxCanaryRole =
	/** Inside the old allocation: shows the model can do the task at all. */
	| 'control'
	/** Past the old allocation and inside the new: shows the new allocation is real. */
	| 'inside'
	/** Past the new allocation: shows the cut. */
	| 'past';

export interface IOnyxCanaryStep {
	readonly role: OnyxCanaryRole;
	/** The prompt's size as it was sent, in estimated tokens (four characters a token). */
	readonly sentTokens: number;
	/** What the runtime counted for the prompt, when it said. A runtime that cut the prompt counts what was left. */
	readonly promptTokens: number | null;
	readonly recalled: boolean;
}

/**
 * The prompts that verify an allocation, in estimated tokens. `previousTokens`
 * is what the server allocated before the request, when known; without it
 * the control is half of the smallest allocation worth asking for.
 * `countedPerEstimatedToken` is what the control showed about how the runtime
 * counts the probe's text; with it the two longer prompts are sized in the
 * runtime's tokens.
 */
export function canaryPlan(reportedTokens: number, previousTokens: number | undefined, countedPerEstimatedToken = 1): readonly { readonly role: OnyxCanaryRole; readonly sentTokens: number }[] {
	const old = previousTokens && previousTokens < reportedTokens ? previousTokens : ONYX_CONTEXT_ALLOCATION.minRequestTokens;
	// How many tokens the runtime counts for one estimated token of the probe's text. Outside a plausible
	// range it is not believed, and the estimate stands.
	const ratio = countedPerEstimatedToken > 0.4 && countedPerEstimatedToken < 2.5 ? countedPerEstimatedToken : 1;
	return [
		{ role: 'control', sentTokens: Math.max(512, Math.round(Math.min(old, reportedTokens) * ONYX_CONTEXT_ALLOCATION.controlShare)) },
		{ role: 'inside', sentTokens: Math.round(reportedTokens * ONYX_CONTEXT_ALLOCATION.insideShare / ratio) },
		{ role: 'past', sentTokens: Math.round(reportedTokens * ONYX_CONTEXT_ALLOCATION.pastShare / ratio) },
	];
}

export type OnyxAllocationStatus =
	/** The allocation was seen to work. The budget uses `verifiedTokens`. */
	| 'verified'
	/** The runtime reports no more than it allocated before: the request was not honoured. */
	| 'ignored'
	/** The runtime reports the context asked for, and a prompt inside it lost its start: it serves less than it reports. */
	| 'over-reported'
	/** The probe could not decide: the model did not recall the code even from a short prompt, or a probe request failed. */
	| 'unverified'
	/** The user was asked and said no. Nothing was created or changed. */
	| 'declined';

export interface IOnyxAllocationVerdict {
	readonly status: Exclude<OnyxAllocationStatus, 'declined'>;
	/** The context the budget may use, when the allocation was seen to work. Never more than the runtime reported. */
	readonly verifiedTokens: number | null;
	/** Whether a prompt longer than the reported context was seen to lose its start. */
	readonly cutObserved: boolean;
}

/**
 * What the probe's steps say about an allocation. Verified means: the code
 * came back from the control and from a prompt the runtime itself counted as
 * longer than the old allocation. The verified number is the reported one,
 * never the size of a prompt and never more than the runtime said.
 */
export function judgeAllocation(input: { readonly requestedTokens: number; readonly reportedTokens: number | undefined; readonly previousTokens: number | undefined; readonly steps: readonly IOnyxCanaryStep[] }): IOnyxAllocationVerdict {
	const { reportedTokens, previousTokens, steps } = input;
	const past = steps.find(step => step.role === 'past');
	const cutObserved = !!past && !past.recalled;
	if (reportedTokens === undefined || reportedTokens <= 0) {
		return { status: 'unverified', verifiedTokens: null, cutObserved };
	}
	if (previousTokens !== undefined && reportedTokens <= previousTokens) {
		return { status: 'ignored', verifiedTokens: null, cutObserved };
	}
	const control = steps.find(step => step.role === 'control');
	const inside = steps.find(step => step.role === 'inside');
	if (!control?.recalled || !inside) {
		return { status: 'unverified', verifiedTokens: null, cutObserved };
	}
	if (!inside.recalled) {
		return { status: 'over-reported', verifiedTokens: null, cutObserved };
	}
	// The inside prompt has to have been longer than the old allocation by the runtime's own count; a runtime
	// that counts nothing leaves the estimate, which runs high, so the bar is the estimate less a fifth.
	const insideTokens = inside.promptTokens ?? Math.floor(inside.sentTokens * 0.8);
	if (previousTokens !== undefined && insideTokens <= previousTokens) {
		return { status: 'unverified', verifiedTokens: null, cutObserved };
	}
	return { status: 'verified', verifiedTokens: Math.min(reportedTokens, input.requestedTokens), cutObserved };
}

/** How a context was applied to the runtime. */
export type OnyxAllocationMechanism = 'derived-model';

/** What is kept for a model whose context Onyx asked for, or was told not to ask for. */
export interface IOnyxAllocationRecord {
	readonly version: 1;
	/** The model the record is about, as the runtime lists it. */
	readonly model: string;
	/** The weights and runtime the record was made for: another digest or runtime version is another subject. */
	readonly digest: string | null;
	readonly runtime: { readonly name: string; readonly version: string | null };
	readonly status: OnyxAllocationStatus;
	readonly mechanism: OnyxAllocationMechanism | null;
	/** The name requests are sent to when the record is in force. */
	readonly alias: string | null;
	readonly requestedTokens: number | null;
	readonly reportedTokens: number | null;
	readonly verifiedTokens: number | null;
	/** What the server allocated for the model before anything was asked. */
	readonly previousTokens: number | null;
	readonly cutObserved: boolean;
	readonly steps: readonly IOnyxCanaryStep[];
	/** ISO 8601. */
	readonly decidedAt: string;
}

/** The three numbers as a trace, a datasheet and a manifest carry them. Null: not known, or not applicable. */
export interface IOnyxContextNumbersRecord {
	readonly requestedTokens: number | null;
	readonly reportedTokens: number | null;
	readonly verifiedTokens: number | null;
	readonly mechanism: OnyxAllocationMechanism | null;
}

/**
 * Whether a record is in force for a model as the runtime lists it now: it
 * was verified, for these weights on this runtime version, and the alias it
 * names is still there.
 */
export function allocationInForce(record: IOnyxAllocationRecord | undefined, model: { readonly id: string; readonly digest?: string; readonly runtime: string; readonly runtimeVersion?: string }, listedAliases: readonly string[]): record is IOnyxAllocationRecord & { readonly alias: string; readonly verifiedTokens: number } {
	return !!record
		&& record.status === 'verified'
		&& record.model === model.id
		&& typeof record.verifiedTokens === 'number' && record.verifiedTokens > 0
		&& (record.digest ?? null) === (model.digest ?? null)
		&& record.runtime.name === model.runtime
		&& (record.runtime.version ?? null) === (model.runtimeVersion ?? null)
		&& typeof record.alias === 'string' && listedAliases.includes(record.alias);
}

/** The one command that undoes an alias, as the user would type it. */
export function removeAliasCommand(alias: string): string {
	return `ollama rm ${alias}`;
}

/** Where a model's context stands, in one sentence for the configuration view and the model library. */
export function describeAllocation(record: IOnyxAllocationRecord | undefined, inForce: boolean, serverTokens: number | undefined): string {
	const server = serverTokens !== undefined
		? localize('onyx.context.server.known', "the server's own allocation of {0} tokens is in force", serverTokens)
		: localize('onyx.context.server.unknown', "the server's own allocation is in force (it reports a number once the model is loaded)");
	if (!record) {
		return localize('onyx.context.none', "No context was requested; {0}.", server);
	}
	switch (record.status) {
		case 'declined':
			return localize('onyx.context.declined', "You declined a larger context; nothing was created or changed, and {0}.", server);
		case 'ignored':
			return localize('onyx.context.ignored', "Onyx requested {0} tokens and the runtime did not honour it (it reports {1}); {2}.", record.requestedTokens ?? 0, record.reportedTokens ?? 0, server);
		case 'over-reported':
			return localize('onyx.context.overReported', "Onyx requested {0} tokens and the runtime reports {1}, but a prompt inside that lost its start; the report is not used, and {2}.", record.requestedTokens ?? 0, record.reportedTokens ?? 0, server);
		case 'unverified':
			return localize('onyx.context.unverified', "Onyx requested {0} tokens and could not verify the result; {1}.", record.requestedTokens ?? 0, server);
		case 'verified':
			return inForce
				? localize('onyx.context.verified', "{0} tokens, verified: requested {1}, the runtime reports {2}, and a prompt past the old allocation kept its start{3}. Applied as the model alias {4}; undo with `{5}`.",
					record.verifiedTokens ?? 0, record.requestedTokens ?? 0, record.reportedTokens ?? 0,
					record.cutObserved ? localize('onyx.context.cutSeen', " while one past the new allocation lost it") : '',
					record.alias ?? '', removeAliasCommand(record.alias ?? ''))
				: localize('onyx.context.stale', "A context of {0} tokens was verified earlier, but the model, the runtime or the alias has changed since; {1}.", record.verifiedTokens ?? 0, server);
	}
}
