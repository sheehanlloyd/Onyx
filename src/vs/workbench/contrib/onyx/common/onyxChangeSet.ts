/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { applyEditBlocks, computeLineHunks, IOnyxEditBlock, IOnyxEditHunk } from './onyxInlineEdit.js';

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
 * leave the model's picture of the file wrong.
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
		return { ok: false, error: searchFailureMessage(path, applied.failed) };
	}
	return { ok: true, appliedCount: applied.appliedCount, file: { path, kind: 'modify', base: currentContent, proposed: applied.text, stale: false } };
}

function applyOnTop(existing: IOnyxProposedFile, blocks: readonly IOnyxEditBlock[]): OnyxProposeResult {
	if (blocks.some(block => block.search.trim() === '')) {
		return { ok: false, error: `${existing.path} already has staged content — every further edit needs a non-empty "search".` };
	}
	const applied = applyEditBlocks(existing.proposed, blocks);
	if (applied.failed.length > 0) {
		return { ok: false, error: searchFailureMessage(existing.path, applied.failed) };
	}
	return { ok: true, appliedCount: applied.appliedCount, file: { ...existing, proposed: applied.text } };
}

function searchFailureMessage(path: string, failed: readonly IOnyxEditBlock[]): string {
	const first = failed[0].search.split('\n').slice(0, 3).join('\n');
	return `Could not find the "search" text in ${path} (staged content included). Not found:\n${first}\nRe-read the file and quote the lines exactly.`;
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

export interface IOnyxRebaseResult {
	readonly file: IOnyxProposedFile;
	/** Hunks whose anchor no longer exists in the new base — dropped, not guessed. */
	readonly droppedHunks: number;
}

/**
 * Re-anchors a proposal onto a buffer that changed underneath it. Each hunk is
 * replayed as a SEARCH/REPLACE block (with one line of leading context so pure
 * insertions have an anchor); a hunk whose anchor vanished is dropped and
 * counted rather than applied somewhere wrong. Matching here is deliberately
 * stricter than the model-facing applier: the user edited this file, so a
 * fuzzy "probably meant here" application would silently corrupt their work.
 */
export function rebaseProposal(file: IOnyxProposedFile, newBase: string): IOnyxRebaseResult {
	if (newBase === file.base) {
		return { file: file.stale ? { ...file, stale: false } : file, droppedHunks: 0 };
	}
	const baseLines = file.base.split('\n');
	const blocks: IOnyxEditBlock[] = proposalHunks(file).map(hunk => {
		const context = hunk.originalStart > 0 ? [baseLines[hunk.originalStart - 1]] : [];
		return {
			search: [...context, ...hunk.originalLines].join('\n'),
			replace: [...context, ...hunk.newLines].join('\n'),
		};
	});
	let proposed = newBase;
	let dropped = 0;
	for (const block of blocks) {
		if (block.search === '') {
			// An insertion at the very top of an empty file: prepend.
			proposed = block.replace + (proposed ? '\n' + proposed : '');
			continue;
		}
		const replaced = strictReplace(proposed, block);
		if (replaced === undefined) {
			dropped++;
		} else {
			proposed = replaced;
		}
	}
	if (proposed === newBase) {
		// Nothing survived: the proposal has no remaining effect.
		return { file: { ...file, base: newBase, proposed: newBase, stale: false }, droppedHunks: dropped };
	}
	return { file: { ...file, base: newBase, proposed, stale: false }, droppedHunks: dropped };
}

/** Exact match, or line-trimmed match — never an anchor guess. */
function strictReplace(text: string, block: IOnyxEditBlock): string | undefined {
	const index = text.indexOf(block.search);
	if (index >= 0) {
		return text.slice(0, index) + block.replace + text.slice(index + block.search.length);
	}
	const textLines = text.split('\n');
	const searchLines = block.search.split('\n').map(line => line.trim());
	for (let start = 0; start + searchLines.length <= textLines.length; start++) {
		let matches = true;
		for (let offset = 0; offset < searchLines.length; offset++) {
			if (textLines[start + offset].trim() !== searchLines[offset]) {
				matches = false;
				break;
			}
		}
		if (matches) {
			return [...textLines.slice(0, start), ...block.replace.split('\n'), ...textLines.slice(start + searchLines.length)].join('\n');
		}
	}
	return undefined;
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
