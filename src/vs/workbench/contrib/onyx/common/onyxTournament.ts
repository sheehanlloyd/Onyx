/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Tournament mode: the same edit instruction raced across several local
 * models, each candidate applied in its own git worktree so nothing touches
 * the real tree until the user picks a winner. This file holds the pure
 * parts — how many contestants this machine can hold at once, and the
 * comparison document the user judges from.
 */

export interface IOnyxTournamentCandidate {
	readonly modelKey: string;
	readonly durationMs: number;
	readonly tokensPerSecond: number | undefined;
	/** The candidate's diff against HEAD; empty when the model produced no usable edit. */
	readonly diffText: string;
	readonly changedFiles: readonly string[];
	readonly failed?: string;
}

/**
 * How many models may run concurrently: each contestant holds its weights in
 * memory at once, so unified memory is the ceiling — never more than 4, and
 * always at least 1 so a small machine still gets a sequential tournament.
 */
export function decideTournamentConcurrency(memoryGb: number, modelSizesGb: readonly number[]): number {
	if (modelSizesGb.length === 0) {
		return 1;
	}
	const budget = memoryGb * 0.6;
	const average = modelSizesGb.reduce((total, size) => total + size, 0) / modelSizesGb.length;
	return Math.max(1, Math.min(4, Math.floor(budget / Math.max(1, average))));
}

/** Counts added/removed lines of a unified diff, for the comparison summary. */
export function diffStats(diffText: string): { added: number; removed: number } {
	let added = 0;
	let removed = 0;
	for (const line of diffText.split('\n')) {
		if (line.startsWith('+') && !line.startsWith('+++')) {
			added++;
		} else if (line.startsWith('-') && !line.startsWith('---')) {
			removed++;
		}
	}
	return { added, removed };
}

/** The side-by-side comparison document, one section per contestant. */
export function buildComparisonDocument(instruction: string, candidates: readonly IOnyxTournamentCandidate[]): string {
	const lines: string[] = [
		`# Onyx tournament — "${instruction}"`,
		'',
		`${candidates.length === 1 ? '1 model' : `${candidates.length} models`} attempted the same edit in isolated git worktrees. Pick a winner to apply its diff to your working tree; every other worktree is discarded.`,
		'',
	];
	for (const candidate of candidates) {
		const stats = diffStats(candidate.diffText);
		lines.push(`## ${candidate.modelKey}`);
		lines.push('');
		if (candidate.failed) {
			lines.push(`_No usable edit: ${candidate.failed}_`);
		} else {
			lines.push(`${(candidate.durationMs / 1000).toFixed(1)}s · ${candidate.tokensPerSecond ? `${Math.round(candidate.tokensPerSecond)} tok/s · ` : ''}+${stats.added} −${stats.removed} in ${candidate.changedFiles.join(', ') || 'no files'}`);
			lines.push('');
			lines.push('```diff');
			lines.push(candidate.diffText.trimEnd());
			lines.push('```');
		}
		lines.push('');
	}
	return lines.join('\n');
}
