/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ChatMessageRole, IChatMessage } from '../../chat/common/languageModels.js';
import { elideMiddle } from './onyxContextCompression.js';

/**
 * Fitting a turn into the context the model really has (B13, I-04, R-16).
 *
 * Before every request the loop asks this module what may be sent: the
 * serialized tool schemas and an output cap are set aside first, and the
 * messages have to fit in what is left. When they do not, things are dropped
 * in a fixed order, whole, oldest first, and the plan says how many. The
 * numbers are estimates (characters over four); the share kept free is what
 * absorbs the error.
 */
export const ONYX_CONTEXT_BUDGET = {
	/** The share of the context a request may plan to use: prompt, tool schemas and output cap together. */
	usableShare: 0.85,
	/** The output cap as a share of the context, and its bounds in tokens. */
	outputShare: 0.15,
	outputMinTokens: 256,
	outputMaxTokens: 4096,
	/** The least a tool result is cut down to before the request is called too large. */
	minResultChars: 400,
	/** `block-to-low-watermark`: once over the budget, earlier calls are dropped until the messages are this share of it. */
	lowWatermarkShare: 0.6,
} as const;

/**
 * What is dropped first when a turn does not fit (L17). Under every policy
 * the rest of the order is the same and the budget is never exceeded.
 *
 * - `oldest-results-first`: whole earlier tool calls with their results,
 *   oldest first, only as many as it takes. Once the budget is reached that
 *   is one every turn or so, and each one changes the prompt near its start.
 * - `block-to-low-watermark`: the same, but once over the budget it goes on
 *   down to a share of it, so that the turns that follow add to a prefix
 *   that does not change until the budget is reached again.
 * - `placeholder-results`: the earlier calls stay and the text of their
 *   results is replaced by a short marker, oldest first, only as many as it
 *   takes; the prompt before the newest replaced result does not change.
 *   When every earlier result is a marker and the turn still does not fit,
 *   whole calls are dropped as under `oldest-results-first`.
 */
export type OnyxEvictionPolicy = 'oldest-results-first' | 'block-to-low-watermark' | 'placeholder-results';
export const ONYX_EVICTION_POLICIES: readonly OnyxEvictionPolicy[] = ['oldest-results-first', 'block-to-low-watermark', 'placeholder-results'];

/** What stands in for the text of a tool result under `placeholder-results`. */
export const ONYX_EVICTED_RESULT_MARKER = '[This earlier result was removed to fit the context window. Call the tool again if it is needed.]';

/** The three numbers known about a model's context, any of which may be missing (B13). */
export interface IOnyxContextNumbers {
	/** What the model architecture allows, as the runtime reports it. */
	readonly architectural?: number;
	/** What the server is configured to allocate, when it says. */
	readonly serverConfigured?: number;
	/** What was observed to fit: learned from an overflow error, or measured (L5). */
	readonly observed?: number;
	/**
	 * An assumption that stands in for the server's number while the server
	 * cannot say it: LM Studio reports the context of a model only once the
	 * model is loaded, and loads it on demand at its own setting.
	 */
	readonly assumed?: number;
}

export type OnyxContextSource = 'observed' | 'server' | 'assumed' | 'architectural' | 'default';

/**
 * The context assumed for an LM Studio model that is not loaded yet. LM
 * Studio loads such a model on the first request, at the context its own
 * settings give it, and cuts a longer prompt without an error (measured on
 * 0.4.23: `docs/research/results/2026-11-22-lmstudio-context/`). Until it
 * is loaded and says, the budget assumes this much, not the trained
 * context, which would be four times what it was served there.
 */
export const ONYX_UNLOADED_LMSTUDIO_CONTEXT_TOKENS = 4096;

/** The context to budget against: the smallest of what is known, and which number that was. */
export function effectiveContext(numbers: IOnyxContextNumbers, fallbackTokens = 8192): { readonly tokens: number; readonly source: OnyxContextSource } {
	const known: (readonly [OnyxContextSource, number | undefined])[] = [['observed', numbers.observed], ['server', numbers.serverConfigured], ['assumed', numbers.assumed], ['architectural', numbers.architectural]];
	let best: { tokens: number; source: OnyxContextSource } | undefined;
	for (const [source, tokens] of known) {
		if (typeof tokens === 'number' && tokens > 0 && (!best || tokens < best.tokens)) {
			best = { tokens: Math.floor(tokens), source };
		}
	}
	return best ?? { tokens: fallbackTokens, source: 'default' };
}

/** The output cap sent as `max_tokens` for a context of this size. */
export function outputCapTokens(contextTokens: number): number {
	return Math.max(ONYX_CONTEXT_BUDGET.outputMinTokens, Math.min(ONYX_CONTEXT_BUDGET.outputMaxTokens, Math.floor(contextTokens * ONYX_CONTEXT_BUDGET.outputShare)));
}

/** What a message is to the budget: decides whether and when it may be dropped. */
export type OnyxBudgetedKind =
	/** System prompt and instructions: never dropped. */
	| 'system'
	/** Earlier turns of the conversation. */
	| 'history'
	/** Retrieved workspace context: background, not a request. */
	| 'workspace'
	/** The user's current request: never dropped. */
	| 'request'
	/** Messages added during this run: the model's turns and tool results. */
	| 'turn';

export interface IOnyxBudgetedMessage {
	readonly message: IChatMessage;
	readonly kind: OnyxBudgetedKind;
}

export interface IOnyxTurnPlan {
	readonly messages: readonly IOnyxBudgetedMessage[];
	/** The output cap for this request. */
	readonly maxTokens: number;
	/** What the messages had to fit in, after the schemas and the output cap. */
	readonly messageBudgetTokens: number;
	readonly messageTokens: number;
	readonly schemaTokens: number;
	/** Whole tool calls dropped with their results, oldest first, and how many results that was. */
	readonly evictedCalls: number;
	readonly evictedResults: number;
	/** Tool results whose text was replaced by the marker this turn (`placeholder-results`). */
	readonly replacedResults: number;
	readonly evictedHistory: number;
	readonly droppedWorkspaceContext: boolean;
	/** Whether the newest tool results had to be cut further to fit. */
	readonly shrankNewestResults: boolean;
	/** False when even the system prompt and the request do not fit. Nothing should be sent. */
	readonly fits: boolean;
}

function hasPart(message: IChatMessage, type: 'tool_use' | 'tool_result'): boolean {
	return message.content.some(part => part.type === type);
}

/** A model turn that called tools, with the results that answer it: `[start, end)` in the list. */
function toolGroups(messages: readonly IOnyxBudgetedMessage[]): { start: number; end: number; results: number }[] {
	const groups: { start: number; end: number; results: number }[] = [];
	for (let index = 0; index < messages.length; index++) {
		const { message, kind } = messages[index];
		if (kind !== 'turn' || message.role !== ChatMessageRole.Assistant || !hasPart(message, 'tool_use')) {
			continue;
		}
		let end = index + 1;
		let results = 0;
		while (end < messages.length && messages[end].kind === 'turn' && messages[end].message.role === ChatMessageRole.User && hasPart(messages[end].message, 'tool_result')) {
			results++;
			end++;
		}
		groups.push({ start: index, end, results });
		index = end - 1;
	}
	return groups;
}

/** The same message with every tool result's text cut to `maxChars`, keeping its start and its end. */
function shrinkResults(message: IChatMessage, maxChars: number): IChatMessage {
	return {
		...message,
		content: message.content.map(part => part.type === 'tool_result'
			? { ...part, value: part.value.map(value => value.type === 'text' ? { ...value, value: elideMiddle(value.value, maxChars) } : value) }
			: part),
	};
}

/** The same message with every tool result's text replaced by the marker; `undefined` when it already is. */
function replaceResults(message: IChatMessage): IChatMessage | undefined {
	let changed = false;
	const content = message.content.map(part => {
		if (part.type !== 'tool_result' || (part.value.length === 1 && part.value[0].type === 'text' && part.value[0].value === ONYX_EVICTED_RESULT_MARKER)) {
			return part;
		}
		changed = true;
		return { ...part, value: [{ type: 'text' as const, value: ONYX_EVICTED_RESULT_MARKER }] };
	});
	return changed ? { ...message, content } : undefined;
}

/**
 * What to send this turn. Dropped, in this order, until the rest fits:
 * whole tool calls with their results, oldest first, keeping the newest;
 * earlier conversation turns, oldest first; the retrieved workspace context;
 * then the newest results are cut further. If the system prompt and the
 * request still do not fit, the plan says so and nothing should be sent.
 */
export function planTurn(input: { readonly messages: readonly IOnyxBudgetedMessage[]; readonly contextTokens: number; readonly schemaTokens: number; readonly estimate: (message: IChatMessage) => number; readonly policy?: OnyxEvictionPolicy }): IOnyxTurnPlan {
	const policy = input.policy ?? 'oldest-results-first';
	const maxTokens = outputCapTokens(input.contextTokens);
	const budget = Math.max(0, Math.floor(input.contextTokens * ONYX_CONTEXT_BUDGET.usableShare) - maxTokens - input.schemaTokens);
	let kept = [...input.messages];
	let total = kept.reduce((sum, entry) => sum + input.estimate(entry.message), 0);
	const remove = (start: number, end: number) => {
		total -= kept.slice(start, end).reduce((sum, entry) => sum + input.estimate(entry.message), 0);
		kept = [...kept.slice(0, start), ...kept.slice(end)];
	};

	let replacedResults = 0;
	if (policy === 'placeholder-results' && total > budget) {
		const groups = toolGroups(kept);
		for (const group of groups.slice(0, -1)) {
			for (let index = group.start + 1; index < group.end && total > budget; index++) {
				const replaced = replaceResults(kept[index].message);
				if (replaced) {
					total += input.estimate(replaced) - input.estimate(kept[index].message);
					kept[index] = { ...kept[index], message: replaced };
					replacedResults++;
				}
			}
		}
	}

	let evictedCalls = 0;
	let evictedResults = 0;
	// Over the budget is what starts it under every policy; how far it goes is the policy's.
	const target = policy === 'block-to-low-watermark' && total > budget ? Math.floor(budget * ONYX_CONTEXT_BUDGET.lowWatermarkShare) : budget;
	for (let groups = toolGroups(kept); total > target && groups.length > 1; groups = toolGroups(kept)) {
		remove(groups[0].start, groups[0].end);
		evictedCalls++;
		evictedResults += groups[0].results;
	}

	let evictedHistory = 0;
	while (total > budget) {
		const index = kept.findIndex(entry => entry.kind === 'history');
		if (index === -1) {
			break;
		}
		remove(index, index + 1);
		evictedHistory++;
	}

	let droppedWorkspaceContext = false;
	if (total > budget) {
		const index = kept.findIndex(entry => entry.kind === 'workspace');
		if (index !== -1) {
			remove(index, index + 1);
			droppedWorkspaceContext = true;
		}
	}

	let shrankNewestResults = false;
	if (total > budget) {
		const newest = toolGroups(kept).pop();
		if (newest && newest.results > 0) {
			// What the results may keep between them, in characters, once everything else is counted.
			const resultTokens = kept.slice(newest.start + 1, newest.end).reduce((sum, entry) => sum + input.estimate(entry.message), 0);
			const allowedChars = Math.floor(((budget - (total - resultTokens)) * 4) / newest.results);
			if (allowedChars >= ONYX_CONTEXT_BUDGET.minResultChars) {
				for (let index = newest.start + 1; index < newest.end; index++) {
					// The cut text carries a note of what was left out; leave room for it.
					kept[index] = { ...kept[index], message: shrinkResults(kept[index].message, Math.max(ONYX_CONTEXT_BUDGET.minResultChars / 2, allowedChars - 200)) };
				}
				total = kept.reduce((sum, entry) => sum + input.estimate(entry.message), 0);
				shrankNewestResults = true;
			}
		}
	}

	return {
		messages: kept,
		maxTokens,
		messageBudgetTokens: budget,
		messageTokens: total,
		schemaTokens: input.schemaTokens,
		evictedCalls,
		evictedResults,
		replacedResults,
		evictedHistory,
		droppedWorkspaceContext,
		shrankNewestResults,
		fits: total <= budget,
	};
}

/** Whether a runtime's error says the prompt did not fit its context. Each runtime words it differently. */
export function isContextOverflowError(message: string): boolean {
	return /context (length|window|size)|too many tokens|maximum context|prompt is too long|exceeds? the (available |maximum |model'?s? )?context|n_ctx|num_ctx/i.test(message);
}
