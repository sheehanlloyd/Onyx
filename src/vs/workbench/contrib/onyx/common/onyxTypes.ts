/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export const ONYX_VENDOR = 'onyx';

/** Identifier of the synthetic routing model shown as "Onyx: Auto" in the model picker. */
export const ONYX_AUTO_MODEL_ID = 'auto';

/** What kind of work a request is, as classified by the router. */
export type OnyxTaskKind = 'quick-edit' | 'implement' | 'debug' | 'plan' | 'chat';

/** How the harness should shape prompts and tool exposure for a model. */
export type OnyxPromptStyle = 'compact' | 'full';

/**
 * The effective harness profile for one model: static seed knowledge merged
 * with locally observed behavior and user overrides. This is what makes a
 * 7B model get a different agent harness than a 70B model.
 */
export interface IOnyxModelProfile {
	/** 0..1 — how reliably the model emits well-formed tool calls. */
	readonly toolCallQuality: number;
	readonly contextLength: number;
	/** Maximum number of tools to expose in a single request. */
	readonly maxTools: number;
	readonly temperature: number;
	readonly promptStyle: OnyxPromptStyle;
	readonly family: string;
	readonly parameterB: number | undefined;
	readonly supportsVision: boolean;
}

/** Locally measured, per-model rolling statistics. All local; never leaves the machine. */
export interface IOnyxObservedStats {
	readonly sampleCount: number;
	/** Exponential moving averages. */
	readonly tokensPerSecond: number;
	readonly timeToFirstTokenMs: number;
	/** 0..1 rates over the sample window. */
	readonly toolCallParseFailureRate: number;
	readonly acceptRate: number;
	/** How many accept/reject verdicts back the accept rate. */
	readonly acceptSampleCount: number;
	/** EMA of end-to-end inline-completion latency, and how many completions back it. */
	readonly fimLatencyMs: number;
	readonly fimSampleCount: number;
}

/** One event in a run's journal. */
export interface IOnyxRunEvent {
	/** Milliseconds since the run started. */
	readonly t: number;
	readonly kind: 'promptSnapshot' | 'firstToken' | 'toolCall' | 'toolResult' | 'turn' | 'outcome' | 'note';
	readonly data: unknown;
}

export type OnyxRunStatus = 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';

/** Summary of a run, as listed in the journal index and the timeline view. */
export interface IOnyxRunSummary {
	readonly runId: string;
	readonly startedAt: number;
	readonly title: string;
	readonly task: OnyxTaskKind;
	readonly modelKey: string;
	readonly status: OnyxRunStatus;
	readonly turnCount: number;
	readonly toolCallCount: number;
}

/** A full run record: summary plus its event journal. */
export interface IOnyxRequestRecord extends IOnyxRunSummary {
	readonly events: readonly IOnyxRunEvent[];
}

/** One slice of the context-budget breakdown for an in-flight request. */
export interface IOnyxBudgetSlice {
	readonly category: 'system' | 'history' | 'attachments' | 'toolSchemas' | 'toolResults' | 'workspace';
	readonly tokens: number;
}
