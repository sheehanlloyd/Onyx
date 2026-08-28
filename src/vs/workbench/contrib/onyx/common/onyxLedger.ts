/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** Running totals for one model. Additive on purpose: session and all-time are the same shape. */
export interface IOnyxLedgerEntry {
	readonly modelKey: string;
	readonly requests: number;
	readonly failures: number;
	readonly promptTokens: number;
	readonly completionTokens: number;
	/** Wall-clock the model spent generating, in milliseconds. */
	readonly generationMs: number;
	readonly ttftMsTotal: number;
	readonly ttftSamples: number;
	readonly accepted: number;
	readonly rejected: number;
	/** Parameter count in billions, kept so the energy proxy survives a restart. */
	readonly parameterB: number | undefined;
}

/** What one measured request contributes to a ledger. */
export interface IOnyxLedgerSample {
	readonly modelKey: string;
	readonly promptTokens: number | undefined;
	readonly completionTokens: number | undefined;
	readonly generationMs: number | undefined;
	readonly timeToFirstTokenMs: number | undefined;
	readonly failed: boolean;
	readonly parameterB: number | undefined;
}

export function emptyLedgerEntry(modelKey: string, parameterB?: number): IOnyxLedgerEntry {
	return { modelKey, requests: 0, failures: 0, promptTokens: 0, completionTokens: 0, generationMs: 0, ttftMsTotal: 0, ttftSamples: 0, accepted: 0, rejected: 0, parameterB };
}

export function addSample(entry: IOnyxLedgerEntry, sample: IOnyxLedgerSample): IOnyxLedgerEntry {
	return {
		...entry,
		requests: entry.requests + 1,
		failures: entry.failures + (sample.failed ? 1 : 0),
		promptTokens: entry.promptTokens + (sample.promptTokens ?? 0),
		completionTokens: entry.completionTokens + (sample.completionTokens ?? 0),
		generationMs: entry.generationMs + (sample.generationMs ?? 0),
		ttftMsTotal: entry.ttftMsTotal + (sample.timeToFirstTokenMs ?? 0),
		ttftSamples: entry.ttftSamples + (sample.timeToFirstTokenMs !== undefined ? 1 : 0),
		parameterB: sample.parameterB ?? entry.parameterB,
	};
}

export function addOutcome(entry: IOnyxLedgerEntry, accepted: boolean): IOnyxLedgerEntry {
	return { ...entry, accepted: entry.accepted + (accepted ? 1 : 0), rejected: entry.rejected + (accepted ? 0 : 1) };
}

/** The numbers a person actually reads, derived rather than stored so they can never drift from the totals. */
export interface IOnyxLedgerSummary {
	readonly tokensPerSecond: number | undefined;
	readonly averageTtftMs: number | undefined;
	readonly acceptRate: number | undefined;
	/**
	 * The local analogue of a cloud bill. Cloud tools price a request in
	 * dollars per token; locally the real cost is how long you held how big a
	 * model on the machine, so: billions of parameters × seconds of generation.
	 */
	readonly parameterSeconds: number;
	readonly totalTokens: number;
}

export function summarize(entry: IOnyxLedgerEntry): IOnyxLedgerSummary {
	const seconds = entry.generationMs / 1000;
	const verdicts = entry.accepted + entry.rejected;
	return {
		tokensPerSecond: seconds > 0 && entry.completionTokens > 0 ? entry.completionTokens / seconds : undefined,
		averageTtftMs: entry.ttftSamples > 0 ? entry.ttftMsTotal / entry.ttftSamples : undefined,
		acceptRate: verdicts > 0 ? entry.accepted / verdicts : undefined,
		parameterSeconds: (entry.parameterB ?? 0) * seconds,
		totalTokens: entry.promptTokens + entry.completionTokens,
	};
}

/** Folds two ledgers together, entry by entry. Used to render "all time" as stored plus this session. */
export function mergeLedgers(a: readonly IOnyxLedgerEntry[], b: readonly IOnyxLedgerEntry[]): IOnyxLedgerEntry[] {
	const merged = new Map<string, IOnyxLedgerEntry>();
	for (const entry of [...a, ...b]) {
		const existing = merged.get(entry.modelKey);
		merged.set(entry.modelKey, existing ? addEntries(existing, entry) : entry);
	}
	return [...merged.values()].sort((x, y) => y.requests - x.requests);
}

function addEntries(a: IOnyxLedgerEntry, b: IOnyxLedgerEntry): IOnyxLedgerEntry {
	return {
		modelKey: a.modelKey,
		requests: a.requests + b.requests,
		failures: a.failures + b.failures,
		promptTokens: a.promptTokens + b.promptTokens,
		completionTokens: a.completionTokens + b.completionTokens,
		generationMs: a.generationMs + b.generationMs,
		ttftMsTotal: a.ttftMsTotal + b.ttftMsTotal,
		ttftSamples: a.ttftSamples + b.ttftSamples,
		accepted: a.accepted + b.accepted,
		rejected: a.rejected + b.rejected,
		parameterB: a.parameterB ?? b.parameterB,
	};
}

/** `1234` → `1.2k`, `1234567` → `1.2M`. */
export function formatCount(value: number): string {
	if (value >= 1_000_000) {
		return `${(value / 1_000_000).toFixed(1)}M`;
	}
	if (value >= 1_000) {
		return `${(value / 1_000).toFixed(1)}k`;
	}
	return String(Math.round(value));
}
