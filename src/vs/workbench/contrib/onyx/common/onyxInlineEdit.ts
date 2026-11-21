/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { stripReasoning } from './onyxReasoning.js';

/**
 * The inline-edit wire format and its repairer. Small local models are bad at
 * unified diffs — hunk headers drift, context lines rot — so Onyx asks for
 * SEARCH/REPLACE blocks instead: the model quotes the lines it wants changed
 * and the lines to put there. The parser is deliberately forgiving (marker
 * length, missing labels, stray code fences, truncated output, whole-file
 * rewrites) and the applier falls back from exact to whitespace-insensitive
 * matching — but when nothing can be parsed it says so rather than guessing.
 */

/** The system prompt teaching the edit format. One place, so prompt and parser cannot drift. */
export const ONYX_INLINE_EDIT_SYSTEM_PROMPT = [
	'You are Onyx, editing code locally. The user selected a piece of code and gives one instruction.',
	'Reply ONLY with one or more edit blocks in exactly this format:',
	'<<<<<<< SEARCH',
	'(lines copied exactly from the selection)',
	'=======',
	'(the replacement lines)',
	'>>>>>>> REPLACE',
	'Rules: copy SEARCH lines character-for-character from the selection. Keep each block small. Do not explain. Do not use markdown fences.',
].join('\n');

/** Builds the user message for one inline edit request. */
export function buildInlineEditPrompt(path: string, languageId: string, selection: string, instruction: string): string {
	return [
		`File: ${path} (${languageId})`,
		'Selected code:',
		selection,
		'',
		`Instruction: ${instruction}`,
	].join('\n');
}

export interface IOnyxEditBlock {
	readonly search: string;
	readonly replace: string;
}

export type OnyxInlineEditParse =
	| { readonly kind: 'blocks'; readonly blocks: readonly IOnyxEditBlock[] }
	/** No markers at all, but the reply looks like code: treat as a rewrite of the whole selection. */
	| { readonly kind: 'rewrite'; readonly text: string }
	| { readonly kind: 'unparseable'; readonly raw: string };

const SEARCH_MARKER = /^<{4,}\s*SEARCH\s*$/;
const DIVIDER_MARKER = /^={4,}\s*$/;
const REPLACE_MARKER = /^>{4,}\s*(REPLACE\s*)?$/;

/**
 * Parses a model reply into edit blocks. Tolerated deviations, all seen in
 * the wild from small models: 4–10 marker characters, a missing REPLACE
 * label, the whole reply wrapped in a markdown fence, and a truncated final
 * block (its partial replacement is kept — better one applied hunk than
 * none). A reply with no markers that still looks like code becomes a
 * whole-selection rewrite; prose becomes `unparseable`.
 */
export function parseInlineEdits(modelReply: string): OnyxInlineEditParse {
	// A reasoning model's thinking is not its answer (C4): edit blocks written while thinking are drafts,
	// and a reply that stopped mid-thought has no answer to apply.
	const thought = stripReasoning(modelReply);
	if (thought.unterminated) {
		return { kind: 'unparseable', raw: modelReply };
	}
	const reply = thought.text;
	// Bare \r counts as a line break: a model emitting old-Mac line endings
	// must not be able to smuggle a marker past the grammar inside "one line".
	let lines = reply.split(/\r\n|\r|\n/);
	// Strip a wrapping markdown fence (with or without a language tag).
	const fenced = lines.findIndex(line => line.trimStart().startsWith('```'));
	if (fenced >= 0) {
		lines = lines.filter(line => !line.trimStart().startsWith('```'));
	}

	const blocks: IOnyxEditBlock[] = [];
	let state: 'outside' | 'search' | 'replace' = 'outside';
	let search: string[] = [];
	let replace: string[] = [];
	const flush = () => {
		if (search.length > 0) {
			// Small models sometimes echo the format inside their own answer, so
			// marker-looking lines are stripped from both bodies: no real edit
			// ever contains them, and letting one through writes the marker into
			// the user's file (observed with qwen2.5-coder:1.5b).
			blocks.push({ search: stripMarkers(search).join('\n'), replace: stripMarkers(replace).join('\n') });
		}
		search = [];
		replace = [];
	};
	// Two different real failures look alike: a model that forgot to close a
	// block before opening the next, and a model that echoed the whole format
	// inside its own replacement (seen from 1.5B models). Marker balance tells
	// them apart — matched openers and closers mean nesting, an excess of
	// openers means someone forgot to close.
	/** Bodies from marker pairs that never had a divider — a whole-selection rewrite. */
	const dividerless: string[] = [];
	const openerCount = lines.filter(line => SEARCH_MARKER.test(line.trim())).length;
	const closerCount = lines.filter(line => REPLACE_MARKER.test(line.trim())).length;
	const nested = openerCount > 1 && openerCount === closerCount;
	let depth = 0;
	for (const line of lines) {
		const trimmed = line.trim();
		if (SEARCH_MARKER.test(trimmed)) {
			if (state === 'replace' && nested) {
				depth++; // an echo inside the replacement — not a new block
				continue;
			}
			if (state === 'replace') {
				flush(); // the previous block was never closed
				state = 'search';
				continue;
			}
			if (state === 'search') {
				flush(); // a new block opened before the previous closed
			}
			state = 'search';
			continue;
		}
		if (state === 'search' && DIVIDER_MARKER.test(trimmed)) {
			state = 'replace';
			continue;
		}
		if (state === 'replace' && REPLACE_MARKER.test(trimmed)) {
			if (depth > 0) {
				depth--; // closes an echoed opener, not this block
				continue;
			}
			flush();
			state = 'outside';
			continue;
		}
		if (state === 'search' && REPLACE_MARKER.test(trimmed)) {
			// No `=======` ever arrived (llama3.2:3b does this every time): the
			// model quoted only the *new* lines between the two markers. There is
			// nothing to search for, so this is a rewrite of the whole selection —
			// recorded as such rather than pasted into the file with its markers.
			dividerless.push(...stripMarkers(search));
			search = [];
			replace = [];
			state = 'outside';
			continue;
		}
		if (state === 'search') {
			search.push(line);
		} else if (state === 'replace') {
			replace.push(line);
		}
	}
	// Truncated final block: keep what arrived of the replacement.
	if (state === 'replace') {
		flush();
	}

	if (blocks.length > 0) {
		return { kind: 'blocks', blocks };
	}
	if (dividerless.length > 0) {
		return { kind: 'rewrite', text: dividerless.join('\n').trim() };
	}

	// Rewrites are built from the normalized lines (all line-ending flavors
	// split, fences removed) so a marker can never ride along inside "one line".
	const body = lines.join('\n').trim();
	if (fenced >= 0 && body) {
		// A fenced reply with no markers is the model handing back the whole thing.
		return { kind: 'rewrite', text: stripMarkers(body.split('\n')).join('\n').trim() };
	}
	if (body && looksLikeCode(body)) {
		return { kind: 'rewrite', text: stripMarkers(body.split('\n')).join('\n').trim() };
	}
	return { kind: 'unparseable', raw: reply };
}

/** Drops any line that is itself a SEARCH/REPLACE marker — never legitimate content. */
function stripMarkers(lines: readonly string[]): string[] {
	return lines.filter(line => {
		const trimmed = line.trim();
		return !SEARCH_MARKER.test(trimmed) && !REPLACE_MARKER.test(trimmed) && !DIVIDER_MARKER.test(trimmed);
	});
}

/** Heuristic: replies that are mostly prose sentences are not code. */
function looksLikeCode(text: string): boolean {
	const lines = text.split('\n');
	const codeish = lines.filter(line => /[;{}()=[\]<>]|^\s*(#|\/\/|--)|^\s{2,}\S/.test(line)).length;
	return codeish / lines.length >= 0.4;
}

/** Why a block was not placed (B6, DEC-07). The text it was meant for is unchanged. */
export interface IOnyxEditRefusal {
	readonly block: IOnyxEditBlock;
	/** `missing`: the SEARCH text is not in the text exactly. `ambiguous`: it is there more than once. `empty-search`: there is nothing to look for. */
	readonly reason: 'missing' | 'ambiguous' | 'empty-search';
	/** How many times the SEARCH text occurs, counting overlapping places. */
	readonly occurrences: number;
	/** For `missing`: the first line of the SEARCH text from which it stops matching anywhere, and its 1-based number within the SEARCH text. */
	readonly firstUnmatchedLine?: string;
	readonly firstUnmatchedLineNumber?: number;
	/** For `missing`: the text would match if its line endings were the file's. It is refused all the same. */
	readonly lineEndingsDiffer?: boolean;
}

export interface IOnyxAppliedEdit {
	readonly text: string;
	readonly appliedCount: number;
	/** Blocks whose SEARCH text could not be placed, verbatim. */
	readonly failed: readonly IOnyxEditBlock[];
	/** Why each of them could not, in the same order. */
	readonly refusals: readonly IOnyxEditRefusal[];
}

/** The places `search` occurs in `text`, counting overlapping ones, up to `limit`. */
function occurrencesOf(text: string, search: string, limit: number): number[] {
	const found: number[] = [];
	for (let index = text.indexOf(search); index !== -1 && found.length < limit; index = text.indexOf(search, index + 1)) {
		found.push(index);
	}
	return found;
}

/**
 * Places one block: the SEARCH text has to be in `text` exactly, and exactly
 * once (B6, DEC-07). Nothing is trimmed, re-indented or matched by its first
 * line, and line endings are compared as they are. A quote may begin or end
 * in the middle of a line; a block of several lines may not begin inside a
 * line's indentation, because its lines would then be indented differently
 * from one another. Anything else is a
 * refusal that says what was wrong, and `text` is not altered.
 */
export function placeEditBlock(text: string, block: IOnyxEditBlock): { readonly ok: true; readonly text: string } | { readonly ok: false; readonly refusal: IOnyxEditRefusal } {
	if (block.search.length === 0) {
		return { ok: false, refusal: { block, reason: 'empty-search', occurrences: 0 } };
	}
	const found = occurrencesOf(text, block.search, 1000);
	if (found.length === 1) {
		// A quote may begin in the middle of a line: the characters quoted are the characters replaced. One
		// case is refused. When all it leaves out before it is indentation and the block has more than one
		// line, its first line would keep the file's indentation while the others take the model's, and the
		// block's own shape would be sheared. That is a different indentation, not a shorter quote.
		const start = found[0];
		const end = start + block.search.length;
		const before = text.slice(text.lastIndexOf('\n', start - 1) + 1, start);
		if (before.length > 0 && before.trim().length === 0 && (block.search.includes('\n') || block.replace.includes('\n'))) {
			return { ok: false, refusal: { block, reason: 'missing', occurrences: 0, firstUnmatchedLine: block.search.split('\n')[0], firstUnmatchedLineNumber: 1 } };
		}
		return { ok: true, text: text.slice(0, start) + block.replace + text.slice(end) };
	}
	if (found.length > 1) {
		return { ok: false, refusal: { block, reason: 'ambiguous', occurrences: found.length } };
	}
	// Not there. The longest run of leading SEARCH lines that is somewhere in the text says where the quote goes wrong.
	const searchLines = block.search.split('\n');
	let matched = 0;
	while (matched < searchLines.length && text.includes(searchLines.slice(0, matched + 1).join('\n'))) {
		matched++;
	}
	const unix = (value: string) => value.replace(/\r\n/g, '\n');
	const lineEndingsDiffer = (text.includes('\r\n') !== block.search.includes('\r\n')) && unix(text).includes(unix(block.search));
	return { ok: false, refusal: { block, reason: 'missing', occurrences: 0, firstUnmatchedLine: searchLines[Math.min(matched, searchLines.length - 1)], firstUnmatchedLineNumber: Math.min(matched, searchLines.length - 1) + 1, ...(lineEndingsDiffer ? { lineEndingsDiffer } : {}) } };
}

/** A refusal in words the model can act on. Not localized: it is a tool result, read by the model. */
export function describeEditRefusal(refusal: IOnyxEditRefusal): string {
	switch (refusal.reason) {
		case 'empty-search':
			return 'The "search" text is empty. Nothing was changed. Quote the lines to change.';
		case 'ambiguous':
			return `The "search" text occurs ${refusal.occurrences} times in the file, so it does not say which place to change. Nothing was changed. Quote more of the surrounding lines so that the text occurs exactly once.`;
		case 'missing':
			return refusal.lineEndingsDiffer
				? 'The "search" text is in the file only with different line endings. Nothing was changed. Quote the lines with the line endings the file has.'
				: `The "search" text is not in the file exactly as quoted. The first line that does not match is line ${refusal.firstUnmatchedLineNumber ?? 1} of it: ${JSON.stringify(refusal.firstUnmatchedLine ?? '')}. Nothing was changed. Quote the lines exactly as they are in the file, including indentation.`;
	}
}

/**
 * Applies edit blocks in order, each to the result of the one before. A
 * block is placed only where its SEARCH text is exactly, and exactly once
 * (`placeEditBlock`); one that is not is reported with its reason and
 * leaves the text as it was.
 */
export function applyEditBlocks(original: string, blocks: readonly IOnyxEditBlock[]): IOnyxAppliedEdit {
	let text = original;
	let appliedCount = 0;
	const failed: IOnyxEditBlock[] = [];
	const refusals: IOnyxEditRefusal[] = [];
	for (const block of blocks) {
		const placed = placeEditBlock(text, block);
		if (placed.ok) {
			text = placed.text;
			appliedCount++;
		} else {
			failed.push(block);
			refusals.push(placed.refusal);
		}
	}
	return { text, appliedCount, failed, refusals };
}

export interface IOnyxEditHunk {
	/** 0-based line range in the ORIGINAL selection that this hunk replaces. */
	readonly originalStart: number;
	readonly originalLength: number;
	/** The replacement lines (possibly empty for a pure deletion). */
	readonly newLines: readonly string[];
	/** The original lines, kept so a rejected hunk can be restored. */
	readonly originalLines: readonly string[];
}

/**
 * Line-level hunks between the original selection and the edited result — the
 * units of the accept/reject review. A plain LCS over lines is enough here:
 * both sides came from the same selection moments apart.
 */
export function computeLineHunks(original: string, modified: string): IOnyxEditHunk[] {
	const a = original.split('\n');
	const b = modified.split('\n');
	// Longest-common-subsequence table over lines (selection-sized inputs).
	const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
	for (let i = a.length - 1; i >= 0; i--) {
		for (let j = b.length - 1; j >= 0; j--) {
			lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
		}
	}
	const hunks: IOnyxEditHunk[] = [];
	let i = 0, j = 0;
	let hunkStartA = -1, hunkStartB = -1;
	const closeHunk = (endA: number, endB: number) => {
		if (hunkStartA >= 0) {
			hunks.push({
				originalStart: hunkStartA,
				originalLength: endA - hunkStartA,
				newLines: b.slice(hunkStartB, endB),
				originalLines: a.slice(hunkStartA, endA),
			});
			hunkStartA = -1;
			hunkStartB = -1;
		}
	};
	while (i < a.length && j < b.length) {
		if (a[i] === b[j]) {
			closeHunk(i, j);
			i++; j++;
		} else {
			if (hunkStartA < 0) {
				hunkStartA = i;
				hunkStartB = j;
			}
			if (lcs[i + 1][j] >= lcs[i][j + 1]) {
				i++;
			} else {
				j++;
			}
		}
	}
	if (i < a.length || j < b.length) {
		if (hunkStartA < 0) {
			hunkStartA = i;
			hunkStartB = j;
		}
		i = a.length;
		j = b.length;
	}
	closeHunk(i, j);
	return hunks;
}
