/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * On-your-repo benchmarks: real past commits become tasks — the model sees
 * the file as it was and the commit message, and must reproduce the change
 * the author actually made. Scores are computed against the author's real
 * "after", so "the router learns" is literally true on the user's own code.
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

export interface IOnyxBenchScore {
	/** 0..1 — F1 over changed lines against the author's real change. */
	readonly score: number;
	/** Why the score is what it is, one short phrase. */
	readonly reason: string;
}

/**
 * Scores a model's reply against the author's actual result. The reply is
 * applied to the "before" content with the product's own edit applier; the
 * score is the F1 of changed lines (relative to "before") between the
 * model's result and the author's. Unparseable replies score 0 — a model
 * that cannot produce an applicable edit has failed the task, whatever prose
 * it wrote.
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

	const beforeLines = countLines(beforeContent);
	const realAdded = diffAddedLines(beforeLines, realAfterContent);
	const modelAdded = diffAddedLines(beforeLines, modelAfter);
	if (realAdded.size === 0) {
		// A pure deletion commit: score on what was removed instead.
		const realRemoved = diffAddedLines(countLines(realAfterContent), beforeContent);
		const modelRemoved = diffAddedLines(countLines(modelAfter), beforeContent);
		return f1Score(realRemoved, modelRemoved, 'removed lines');
	}
	return f1Score(realAdded, modelAdded, 'added lines');
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

/** Lines (trimmed, non-empty) present in `content` beyond their count in `baseline`. */
function diffAddedLines(baseline: Map<string, number>, content: string): Map<string, number> {
	const added = new Map<string, number>();
	const seen = new Map<string, number>();
	for (const line of content.split('\n')) {
		const key = line.trim();
		if (!key) {
			continue;
		}
		const occurrence = (seen.get(key) ?? 0) + 1;
		seen.set(key, occurrence);
		if (occurrence > (baseline.get(key) ?? 0)) {
			added.set(key, (added.get(key) ?? 0) + 1);
		}
	}
	return added;
}

function f1Score(real: Map<string, number>, model: Map<string, number>, what: string): IOnyxBenchScore {
	let overlap = 0;
	let realTotal = 0;
	let modelTotal = 0;
	for (const count of real.values()) {
		realTotal += count;
	}
	for (const count of model.values()) {
		modelTotal += count;
	}
	for (const [line, count] of real) {
		overlap += Math.min(count, model.get(line) ?? 0);
	}
	if (realTotal === 0 && modelTotal === 0) {
		return { score: 1, reason: 'no change was needed and none was made' };
	}
	const precision = modelTotal > 0 ? overlap / modelTotal : 0;
	const recall = realTotal > 0 ? overlap / realTotal : 0;
	const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
	return { score: round2(f1), reason: `${Math.round(recall * 100)}% of the author's ${what} reproduced, ${Math.round(precision * 100)}% of the model's on target` };
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
