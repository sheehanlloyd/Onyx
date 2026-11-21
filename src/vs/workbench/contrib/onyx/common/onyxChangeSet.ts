/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { applyEditBlocks, computeLineHunks, describeEditRefusal, IOnyxEditBlock, IOnyxEditHunk, IOnyxEditRefusal } from './onyxInlineEdit.js';

/**
 * The change-set model behind "Onyx Changes": every edit the agent proposes is
 * staged here — against the buffer content it saw — instead of being written
 * into the file. The user then accepts or rejects per file or per hunk, and
 * only acceptance touches the buffer. All of this is pure so the exact
 * semantics of merging successive agent edits, carving a proposal into hunks,
 * partially accepting them, and rebasing onto a buffer that changed underneath
 * can be tested without a workbench.
 */

export interface IOnyxProposedFile {
	/** Workspace-qualified path, as the tools and journal use everywhere. */
	readonly path: string;
	readonly kind: 'create' | 'modify';
	/** The content the proposal is diffed against ('' for a created file). */
	readonly base: string;
	/** The full content the agent wants the file to have. */
	readonly proposed: string;
	/** Set when the buffer changed after staging; the diff shown may be stale until rebased. */
	readonly stale: boolean;
}

export type OnyxProposeResult =
	| { readonly ok: true; readonly file: IOnyxProposedFile; readonly appliedCount: number }
	| { readonly ok: false; readonly error: string };

/**
 * Stages one tool call's SEARCH/REPLACE blocks on top of whatever is already
 * proposed for the file. Successive calls compose: each applies to the
 * previous call's proposed content, so the agent can keep editing while the
 * user reviews. A block whose SEARCH cannot be found fails the whole call
 * with a message the model can act on — a partially applied tool call would
 * leave the model's picture of the file wrong. "Found" means exactly, at
 * exactly one place (B6, DEC-07): nothing is trimmed or re-indented.
 */
export function proposeEdits(existing: IOnyxProposedFile | undefined, path: string, currentContent: string | undefined, blocks: readonly IOnyxEditBlock[]): OnyxProposeResult {
	if (currentContent === undefined) {
		// Creating a new file: exactly one block, with an empty SEARCH.
		if (existing) {
			return applyOnTop(existing, blocks);
		}
		if (blocks.length !== 1 || blocks[0].search.trim() !== '') {
			return { ok: false, error: `File ${path} does not exist. To create it, pass a single edit with an empty "search" and the full content as "replace".` };
		}
		return { ok: true, appliedCount: 1, file: { path, kind: 'create', base: '', proposed: blocks[0].replace, stale: false } };
	}
	if (existing) {
		return applyOnTop(existing, blocks);
	}
	if (blocks.some(block => block.search.trim() === '')) {
		return { ok: false, error: `File ${path} already exists — every edit needs a non-empty "search". Read the file and quote the lines to change.` };
	}
	const applied = applyEditBlocks(currentContent, blocks);
	if (applied.failed.length > 0) {
		return { ok: false, error: searchFailureMessage(path, applied.refusals) };
	}
	return { ok: true, appliedCount: applied.appliedCount, file: { path, kind: 'modify', base: currentContent, proposed: applied.text, stale: false } };
}

function applyOnTop(existing: IOnyxProposedFile, blocks: readonly IOnyxEditBlock[]): OnyxProposeResult {
	if (blocks.some(block => block.search.trim() === '')) {
		return { ok: false, error: `${existing.path} already has staged content — every further edit needs a non-empty "search".` };
	}
	const applied = applyEditBlocks(existing.proposed, blocks);
	if (applied.failed.length > 0) {
		return { ok: false, error: searchFailureMessage(existing.path, applied.refusals) };
	}
	return { ok: true, appliedCount: applied.appliedCount, file: { ...existing, proposed: applied.text } };
}

function searchFailureMessage(path: string, refusals: readonly IOnyxEditRefusal[]): string {
	return `Edit refused for ${path} (staged content included). ${describeEditRefusal(refusals[0])}`;
}

/** The reviewable units of a proposal, in file order. */
export function proposalHunks(file: IOnyxProposedFile): IOnyxEditHunk[] {
	return computeLineHunks(file.base, file.proposed);
}

/**
 * Rebuilds the proposed content from the base plus a chosen subset of hunks —
 * the "reject this hunk" primitive. Keeping every hunk reproduces `proposed`;
 * keeping none reproduces `base`.
 */
export function applyHunkSelection(base: string, hunks: readonly IOnyxEditHunk[], keep: (index: number) => boolean): string {
	const lines = base.split('\n');
	const out: string[] = [];
	let cursor = 0;
	hunks.forEach((hunk, index) => {
		out.push(...lines.slice(cursor, hunk.originalStart));
		out.push(...(keep(index) ? hunk.newLines : hunk.originalLines));
		cursor = hunk.originalStart + hunk.originalLength;
	});
	out.push(...lines.slice(cursor));
	return out.join('\n');
}

/**
 * The most a proposal may be before it is diffed (B7, I-13, R-38). The line
 * diff builds a table of one cell per pair of lines, so its cost is the
 * product of the two sides. A proposal over any of these is refused before
 * that table is allocated, on every path that diffs: an agent edit, an
 * inline edit, a refactor, a restored proposal.
 */
export const ONYX_PROPOSAL_LIMITS = {
	/** Lines on either side. */
	maxLinesPerSide: 1000,
	/** Cells of the diff table, its sentinel row and column included. */
	maxDiffCells: 1_000_000,
	/** Base and proposed text together, as UTF-8. */
	maxCombinedBytes: 256 * 1024,
} as const;

function utf8Length(text: string): number {
	let bytes = 0;
	for (let index = 0; index < text.length; index++) {
		const code = text.charCodeAt(index);
		if (code < 0x80) {
			bytes += 1;
		} else if (code < 0x800) {
			bytes += 2;
		} else if (code >= 0xd800 && code <= 0xdbff) {
			bytes += 4;
			index++;
		} else {
			bytes += 3;
		}
	}
	return bytes;
}

function lineCount(text: string): number {
	let lines = 1;
	for (let index = text.indexOf('\n'); index !== -1; index = text.indexOf('\n', index + 1)) {
		lines++;
	}
	return lines;
}

/** Why a proposal is too large to be diffed, or undefined when it is not. Costs one pass over the text and allocates nothing. */
export function proposalSizeProblem(base: string, proposed: string): string | undefined {
	const bytes = utf8Length(base) + utf8Length(proposed);
	if (bytes > ONYX_PROPOSAL_LIMITS.maxCombinedBytes) {
		return `the file and the proposed content together are ${bytes} bytes; a proposal is reviewed up to ${ONYX_PROPOSAL_LIMITS.maxCombinedBytes}`;
	}
	const baseLines = lineCount(base);
	const proposedLines = lineCount(proposed);
	if (baseLines > ONYX_PROPOSAL_LIMITS.maxLinesPerSide || proposedLines > ONYX_PROPOSAL_LIMITS.maxLinesPerSide) {
		return `the file has ${baseLines} lines and the proposed content ${proposedLines}; a proposal is reviewed up to ${ONYX_PROPOSAL_LIMITS.maxLinesPerSide} lines a side`;
	}
	if ((baseLines + 1) * (proposedLines + 1) > ONYX_PROPOSAL_LIMITS.maxDiffCells) {
		return `comparing ${baseLines} lines with ${proposedLines} is more than a proposal is reviewed at`;
	}
	return undefined;
}

/** A hunk under review: the lines it replaces, what it puts there, and a name that does not change (B7). */
export interface IOnyxReviewHunk extends IOnyxEditHunk {
	/**
	 * Given once, when the proposal generation is opened, from the
	 * generation and the hunk's place in it. It is never recomputed from
	 * where the hunk has moved to, and never given to another hunk.
	 */
	readonly id: string;
}

/** A hunk that could not be carried onto the buffer as it now is. Nothing of it is applied. */
export interface IOnyxHunkConflict {
	readonly id: string;
	/** `missing`: its lines and their context are no longer in the buffer. `ambiguous`: they are there more than once. */
	readonly reason: 'missing' | 'ambiguous';
	/** Both texts, for the reader: what the hunk expected to replace, and what it proposed. */
	readonly originalLines: readonly string[];
	readonly newLines: readonly string[];
	/** The 1-based line it was at in the base it was reviewed against. */
	readonly wasAtLine: number;
}

/**
 * One generation of a proposal under review (B7). A generation begins when
 * the agent, an inline edit or a refactor stages content for a file, and
 * ends when it stages again: every hunk id of the earlier generation is gone
 * then, so a review of it cannot be accepted by mistake.
 */
export interface IOnyxReview {
	readonly generation: number;
	readonly hunks: readonly IOnyxReviewHunk[];
	readonly conflicts: readonly IOnyxHunkConflict[];
}

/** Opens a generation: diffs the proposal once and names its hunks. Refuses a proposal too large to diff (R-38). */
export function openReview(base: string, proposed: string, generation: number): { readonly ok: true; readonly review: IOnyxReview } | { readonly ok: false; readonly error: string } {
	const problem = proposalSizeProblem(base, proposed);
	if (problem) {
		return { ok: false, error: problem };
	}
	return { ok: true, review: { generation, hunks: computeLineHunks(base, proposed).map((hunk, index) => ({ ...hunk, id: `g${generation}.h${index + 1}` })), conflicts: [] } };
}

/** The content a review proposes: the base with every hunk of the review applied. */
export function reviewProposed(base: string, hunks: readonly IOnyxEditHunk[]): string {
	return applyHunkSelection(base, hunks, () => true);
}

/** How many lines of unchanged text on each side tie a hunk to its place (B7, step 4). */
const CONTEXT_LINES = 3;

function linesEqual(lines: readonly string[], at: number, pattern: readonly string[]): boolean {
	if (at < 0 || at + pattern.length > lines.length) {
		return false;
	}
	for (let offset = 0; offset < pattern.length; offset++) {
		if (lines[at + offset] !== pattern[offset]) {
			return false;
		}
	}
	return true;
}

/**
 * Carries a review onto a buffer that changed underneath it (B7, DEC-07).
 * Each hunk is looked for by its own lines with up to three lines of the old
 * base on each side, exactly. Found at one place, it keeps its id and moves
 * there. Found nowhere, or at more than one place, it becomes a conflict
 * that keeps both texts and is never applied: there is no trimming and no
 * choosing of the nearest or the first. A hunk that would overlap one
 * already placed is a conflict too.
 */
export function rebaseReview(review: IOnyxReview, oldBase: string, newBase: string): IOnyxReview {
	if (oldBase === newBase) {
		return review;
	}
	const oldLines = oldBase.split('\n');
	const newLines = newBase.split('\n');
	const hunks: IOnyxReviewHunk[] = [];
	const conflicts: IOnyxHunkConflict[] = [...review.conflicts];
	let floor = 0;
	for (const hunk of review.hunks) {
		const before = oldLines.slice(Math.max(0, hunk.originalStart - CONTEXT_LINES), hunk.originalStart);
		const after = oldLines.slice(hunk.originalStart + hunk.originalLength, hunk.originalStart + hunk.originalLength + CONTEXT_LINES);
		const pattern = [...before, ...hunk.originalLines, ...after];
		// At the start or the end of the file there are fewer lines of context to take; the rule is the same.
		const found: number[] = [];
		for (let at = 0; at + pattern.length <= newLines.length && found.length < 2; at++) {
			if (linesEqual(newLines, at, pattern)) {
				found.push(at);
			}
		}
		const conflict = (reason: IOnyxHunkConflict['reason']) => conflicts.push({ id: hunk.id, reason, originalLines: hunk.originalLines, newLines: hunk.newLines, wasAtLine: hunk.originalStart + 1 });
		if (found.length !== 1) {
			conflict(found.length === 0 ? 'missing' : 'ambiguous');
			continue;
		}
		const originalStart = found[0] + before.length;
		if (originalStart < floor) {
			conflict('ambiguous');
			continue;
		}
		floor = originalStart + hunk.originalLength;
		hunks.push({ ...hunk, originalStart });
	}
	return { generation: review.generation, hunks, conflicts };
}

/**
 * Accepts some hunks of a review whose base is the buffer as it is: the new
 * base is the old one with those hunks applied, and the hunks that remain
 * keep their ids and move by the lines the accepted ones added or removed.
 */
export function acceptReviewHunks(review: IOnyxReview, base: string, accept: (id: string) => boolean): { readonly base: string; readonly review: IOnyxReview } {
	const newBase = applyHunkSelection(base, review.hunks, index => accept(review.hunks[index].id));
	let shift = 0;
	const hunks: IOnyxReviewHunk[] = [];
	for (const hunk of review.hunks) {
		if (accept(hunk.id)) {
			shift += hunk.newLines.length - hunk.originalLength;
		} else {
			hunks.push({ ...hunk, originalStart: hunk.originalStart + shift });
		}
	}
	return { base: newBase, review: { generation: review.generation, hunks, conflicts: review.conflicts } };
}

/** Drops one hunk or one conflict from a review. The other hunks keep their ids and their places. */
export function rejectReviewHunk(review: IOnyxReview, id: string): IOnyxReview {
	return { generation: review.generation, hunks: review.hunks.filter(hunk => hunk.id !== id), conflicts: review.conflicts.filter(conflict => conflict.id !== id) };
}

/** The scheme of the read-only document that shows a file as its proposal would leave it (C1). */
export const ONYX_PROPOSAL_SCHEME = 'onyx-proposal';

/** Where each hunk's lines are in the proposed content: the 1-based first line and how many lines it puts there (none for a deletion). */
export function proposedHunkRanges(hunks: readonly IOnyxReviewHunk[]): { readonly id: string; readonly startLine: number; readonly lineCount: number }[] {
	let shift = 0;
	return hunks.map(hunk => {
		const range = { id: hunk.id, startLine: hunk.originalStart + shift + 1, lineCount: hunk.newLines.length };
		shift += hunk.newLines.length - hunk.originalLength;
		return range;
	});
}

/**
 * The hunk a line of the proposed content belongs to (C1): the one whose
 * proposed lines include it, or the deletion that happened right there.
 * A line no hunk touches belongs to none: nothing is accepted by proximity.
 */
export function hunkAtProposedLine(hunks: readonly IOnyxReviewHunk[], line: number): IOnyxReviewHunk | undefined {
	const ranges = proposedHunkRanges(hunks);
	const index = ranges.findIndex(range => range.lineCount > 0 ? line >= range.startLine && line < range.startLine + range.lineCount : line === range.startLine || line === range.startLine - 1);
	return index === -1 ? undefined : hunks[index];
}

export interface IOnyxRebaseResult {
	readonly file: IOnyxProposedFile;
	/** Hunks that could not be carried onto the new base: dropped from the proposal, not guessed. */
	readonly droppedHunks: number;
}

/**
 * Re-anchors a proposal onto a buffer that changed underneath it, by
 * `rebaseReview`'s rule. For callers that hold a proposal and no review; the
 * change set keeps the review, and with it the conflicts and the hunk ids.
 */
export function rebaseProposal(file: IOnyxProposedFile, newBase: string): IOnyxRebaseResult {
	if (newBase === file.base) {
		return { file: file.stale ? { ...file, stale: false } : file, droppedHunks: 0 };
	}
	const opened = openReview(file.base, file.proposed, 0);
	if (!opened.ok) {
		return { file: { ...file, base: newBase, proposed: newBase, stale: false }, droppedHunks: 1 };
	}
	const rebased = rebaseReview(opened.review, file.base, newBase);
	return { file: { ...file, base: newBase, proposed: reviewProposed(newBase, rebased.hunks), stale: false }, droppedHunks: rebased.conflicts.length };
}

export interface IOnyxChangeSetSummary {
	readonly fileCount: number;
	readonly addedLines: number;
	readonly removedLines: number;
}

export function summarizeChangeSet(files: readonly IOnyxProposedFile[]): IOnyxChangeSetSummary {
	let addedLines = 0;
	let removedLines = 0;
	for (const file of files) {
		for (const hunk of proposalHunks(file)) {
			addedLines += hunk.newLines.length;
			removedLines += hunk.originalLines.length;
		}
	}
	return { fileCount: files.length, addedLines, removedLines };
}

/**
 * A minimal unified diff for one proposal — enough for the change-risk
 * scorer's textual signals and for journaling what was staged.
 */
export function proposalToUnifiedDiff(file: IOnyxProposedFile): string {
	const lines: string[] = [`diff --git a/${file.path} b/${file.path}`, `--- a/${file.path}`, `+++ b/${file.path}`];
	for (const hunk of proposalHunks(file)) {
		lines.push(`@@ -${hunk.originalStart + 1},${hunk.originalLength} +${hunk.originalStart + 1},${hunk.newLines.length} @@`);
		for (const removed of hunk.originalLines) {
			lines.push(`-${removed}`);
		}
		for (const added of hunk.newLines) {
			lines.push(`+${added}`);
		}
	}
	return lines.join('\n');
}
