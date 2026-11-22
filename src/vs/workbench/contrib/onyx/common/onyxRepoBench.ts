/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * On-your-repo benchmarks: real past commits become tasks — the model sees
 * the file as it was and the commit message, and must reproduce the change
 * the author actually made. Scores are computed against the author's real
 * "after": lines added and lines removed, with a cap when the reply removes
 * something the author kept.
 * Everything here is pure: commit selection, prompt construction, scoring
 * and aggregation are decided (and tested) without git or a model.
 */

import { applyEditBlocks, parseInlineEdits } from './onyxInlineEdit.js';
import { OnyxTaskKind } from './onyxTypes.js';

export interface IOnyxBenchCommitCandidate {
	readonly hash: string;
	readonly subject: string;
	/** Paths changed by the commit. */
	readonly files: readonly string[];
	readonly insertions: number;
	readonly deletions: number;
}

export interface IOnyxBenchTask {
	readonly hash: string;
	readonly subject: string;
	readonly file: string;
	readonly kind: OnyxTaskKind;
}

/** A commit's task kind, by the same intuition the router uses for requests. */
export function classifyCommitTask(candidate: IOnyxBenchCommitCandidate): OnyxTaskKind {
	const changed = candidate.insertions + candidate.deletions;
	if (/\bfix|bug|crash|npe|null|regression\b/i.test(candidate.subject)) {
		return 'debug';
	}
	if (changed <= 12 && candidate.files.length === 1) {
		return 'quick-edit';
	}
	return 'implement';
}

/**
 * Which commits make fair benchmark tasks: exactly one changed file (so the
 * "before" fits a prompt), a real change but not a rewrite, no merges or
 * mechanical commits. Picks spread across history rather than clustering on
 * the newest commits, deterministically.
 */
export function selectBenchmarkCommits(candidates: readonly IOnyxBenchCommitCandidate[], count: number): IOnyxBenchTask[] {
	const eligible = candidates.filter(candidate => {
		const changed = candidate.insertions + candidate.deletions;
		return candidate.files.length === 1
			&& changed >= 3 && changed <= 80
			&& !/^merge\b|^revert\b|^bump\b|^wip\b/i.test(candidate.subject)
			&& !/\.(lock|min\.js|map|svg|png|ico)$/.test(candidate.files[0])
			&& candidate.subject.trim().length >= 8;
	});
	if (eligible.length === 0) {
		return [];
	}
	const picked: IOnyxBenchTask[] = [];
	const step = Math.max(1, Math.floor(eligible.length / count));
	for (let i = 0; i < eligible.length && picked.length < count; i += step) {
		const candidate = eligible[i];
		picked.push({ hash: candidate.hash, subject: candidate.subject, file: candidate.files[0], kind: classifyCommitTask(candidate) });
	}
	return picked;
}

/** System prompt for a bench attempt — the same edit format the product uses. */
export const ONYX_BENCH_SYSTEM_PROMPT = [
	'You are editing one file to implement a requested change.',
	'Reply ONLY with one or more edit blocks in exactly this format:',
	'<<<<<<< SEARCH',
	'(lines copied exactly from the file)',
	'=======',
	'(the replacement lines)',
	'>>>>>>> REPLACE',
	'Do not explain. Do not use markdown fences.',
].join('\n');

export function buildBenchPrompt(task: IOnyxBenchTask, beforeContent: string): string {
	return [
		`File: ${task.file}`,
		'Current content:',
		beforeContent,
		'',
		`Change to make: ${task.subject}`,
	].join('\n');
}

/**
 * The name and version of the score, stored with every result and with the
 * routing data it feeds (C8). A change to how an attempt is scored changes
 * this, and scores kept under another name are discarded, not mixed in.
 */
export const ONYX_BENCH_METRIC = 'changed-line-f1-preserving/2';

/** The most an attempt can score when it removed a line the author kept. */
export const ONYX_BENCH_PRESERVATION_CAP = 0.5;

export interface IOnyxBenchScore {
	/**
	 * 0..1: F1 over changed lines, added and removed together, against the
	 * author's real change; at most `ONYX_BENCH_PRESERVATION_CAP` when the
	 * reply removed a line the author kept.
	 */
	readonly score: number;
	/** Why the score is what it is, one short phrase. */
	readonly reason: string;
	/** `ONYX_BENCH_METRIC`. Absent on the two results that never reached the scorer (prose, nothing placed). */
	readonly metric?: string;
	/** Present when the cap applied. */
	readonly preservation?: { readonly removedLinesTheAuthorKept: number; readonly scoreBeforeCap: number };
}

/**
 * Scores a model's reply against the author's actual result (C8, R-22).
 * The reply is applied to the "before" content with the product's own edit
 * applier. The score is the F1 between the model's changed lines and the
 * author's, where a changed line is a line added or a line removed relative
 * to "before": a reply has to add what the author added and remove what the
 * author removed, and nothing else.
 *
 * Preservation: a line the reply removed and the author kept is damage that
 * precision alone prices too gently (one deleted import among ten good
 * lines still scores 0.95). Any such line caps the score at
 * `ONYX_BENCH_PRESERVATION_CAP`, and the reason names it.
 *
 * Lines are compared trimmed and as a multiset; empty lines are ignored.
 * Unparseable replies score 0: a model that cannot produce an applicable
 * edit has failed the task, whatever prose it wrote.
 */
export function scoreBenchAttempt(beforeContent: string, realAfterContent: string, modelReply: string): IOnyxBenchScore {
	const parsed = parseInlineEdits(modelReply);
	let modelAfter: string;
	if (parsed.kind === 'blocks') {
		const applied = applyEditBlocks(beforeContent, parsed.blocks);
		if (applied.appliedCount === 0) {
			return { score: 0, reason: 'no edit block could be located in the file' };
		}
		modelAfter = applied.text;
	} else if (parsed.kind === 'rewrite') {
		modelAfter = parsed.text;
	} else {
		return { score: 0, reason: 'reply was prose, not an edit' };
	}
	return scoreBenchProposal(beforeContent, realAfterContent, modelAfter);
}

/**
 * Scores a file as a model proposed it against the author's actual result:
 * the second half of `scoreBenchAttempt`, for a proposal that did not arrive
 * as a reply to parse (an agent run stages its edits; the lab reads the
 * staged file, L9).
 */
export function scoreBenchProposal(beforeContent: string, realAfterContent: string, modelAfter: string): IOnyxBenchScore {
	const before = countLines(beforeContent);
	const real = changedLines(before, countLines(realAfterContent));
	const model = changedLines(before, countLines(modelAfter));
	const realTotal = total(real.added) + total(real.removed);
	const modelTotal = total(model.added) + total(model.removed);
	if (realTotal === 0 && modelTotal === 0) {
		return { score: 1, reason: 'no change was needed and none was made', metric: ONYX_BENCH_METRIC };
	}
	const overlap = overlapOf(real.added, model.added) + overlapOf(real.removed, model.removed);
	const precision = modelTotal > 0 ? overlap / modelTotal : 0;
	const recall = realTotal > 0 ? overlap / realTotal : 0;
	const f1 = round2(precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0);
	const detail = `${Math.round(recall * 100)}% of the author's changed lines reproduced, ${Math.round(precision * 100)}% of the model's on target`;

	// Lines the reply removed beyond what the author removed.
	let lost = 0;
	let firstLost: string | undefined;
	for (const [line, count] of model.removed) {
		const beyond = count - (real.removed.get(line) ?? 0);
		if (beyond > 0) {
			lost += beyond;
			firstLost ??= line;
		}
	}
	if (lost > 0) {
		const shown = firstLost!.length > 60 ? `${firstLost!.slice(0, 60)}…` : firstLost!;
		const removed = `the reply removed ${lost} line${lost === 1 ? '' : 's'} the author kept ("${shown}")`;
		return {
			score: Math.min(f1, ONYX_BENCH_PRESERVATION_CAP),
			// "Capped" is said only when the cap lowered the score.
			reason: f1 > ONYX_BENCH_PRESERVATION_CAP ? `capped at ${ONYX_BENCH_PRESERVATION_CAP}: ${removed}; before the cap ${f1} (${detail})` : `${detail}; ${removed}`,
			metric: ONYX_BENCH_METRIC,
			preservation: { removedLinesTheAuthorKept: lost, scoreBeforeCap: f1 },
		};
	}
	return { score: f1, reason: detail, metric: ONYX_BENCH_METRIC };
}

/** The routing data a benchmark feeds: a mean score and a sample count a task kind, and the metric they were scored with. */
export interface IOnyxBenchRoutingData {
	readonly benchScores: Record<string, number>;
	readonly benchSamples: Record<string, number>;
	readonly benchMetric?: string;
}

/**
 * Routing data as it may be used under the current metric (C8). Scores kept
 * under another metric, or under none (before the metric had a name), are
 * not comparable with new ones and are dropped: an empty record under the
 * current name.
 */
export function benchRoutingDataForCurrentMetric(stored: Partial<IOnyxBenchRoutingData>): Required<IOnyxBenchRoutingData> {
	if (stored.benchMetric !== ONYX_BENCH_METRIC) {
		return { benchScores: {}, benchSamples: {}, benchMetric: ONYX_BENCH_METRIC };
	}
	return { benchScores: stored.benchScores ?? {}, benchSamples: stored.benchSamples ?? {}, benchMetric: ONYX_BENCH_METRIC };
}

function countLines(content: string): Map<string, number> {
	const counts = new Map<string, number>();
	for (const line of content.split('\n')) {
		const key = line.trim();
		if (key) {
			counts.set(key, (counts.get(key) ?? 0) + 1);
		}
	}
	return counts;
}

/** The lines `after` has beyond `before`, and the lines `before` has beyond `after`, each with how many. */
function changedLines(before: Map<string, number>, after: Map<string, number>): { readonly added: Map<string, number>; readonly removed: Map<string, number> } {
	const added = new Map<string, number>();
	const removed = new Map<string, number>();
	for (const [line, count] of after) {
		const beyond = count - (before.get(line) ?? 0);
		if (beyond > 0) {
			added.set(line, beyond);
		}
	}
	for (const [line, count] of before) {
		const beyond = count - (after.get(line) ?? 0);
		if (beyond > 0) {
			removed.set(line, beyond);
		}
	}
	return { added, removed };
}

function total(lines: Map<string, number>): number {
	let sum = 0;
	for (const count of lines.values()) {
		sum += count;
	}
	return sum;
}

function overlapOf(real: Map<string, number>, model: Map<string, number>): number {
	let overlap = 0;
	for (const [line, count] of real) {
		overlap += Math.min(count, model.get(line) ?? 0);
	}
	return overlap;
}

function round2(value: number): number {
	return Math.round(value * 100) / 100;
}

export interface IOnyxBenchResult {
	readonly modelKey: string;
	readonly task: IOnyxBenchTask;
	readonly score: IOnyxBenchScore;
	readonly durationMs: number;
}

export interface IOnyxBenchAggregate {
	readonly modelKey: string;
	readonly kind: OnyxTaskKind;
	readonly meanScore: number;
	readonly taskCount: number;
}

export function aggregateBenchResults(results: readonly IOnyxBenchResult[]): IOnyxBenchAggregate[] {
	const groups = new Map<string, { modelKey: string; kind: OnyxTaskKind; total: number; count: number }>();
	for (const result of results) {
		const key = `${result.modelKey}|${result.task.kind}`;
		const group = groups.get(key) ?? { modelKey: result.modelKey, kind: result.task.kind, total: 0, count: 0 };
		group.total += result.score.score;
		group.count++;
		groups.set(key, group);
	}
	return [...groups.values()]
		.map(group => ({ modelKey: group.modelKey, kind: group.kind, meanScore: round2(group.total / group.count), taskCount: group.count }))
		.sort((a, b) => a.modelKey.localeCompare(b.modelKey) || a.kind.localeCompare(b.kind));
}
