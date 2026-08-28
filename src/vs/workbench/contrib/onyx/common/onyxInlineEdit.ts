/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

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
export function parseInlineEdits(reply: string): OnyxInlineEditParse {
	let lines = reply.split('\n');
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

	const trimmed = reply.trim();
	const body = lines.join('\n').trim();
	if (fenced >= 0 && body) {
		// A fenced reply with no markers is the model handing back the whole thing.
		return { kind: 'rewrite', text: stripMarkers(body.split('\n')).join('\n').trim() };
	}
	if (trimmed && looksLikeCode(trimmed)) {
		return { kind: 'rewrite', text: stripMarkers(trimmed.split('\n')).join('\n').trim() };
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

export interface IOnyxAppliedEdit {
	readonly text: string;
	readonly appliedCount: number;
	/** Blocks whose SEARCH text could not be located, verbatim. */
	readonly failed: readonly IOnyxEditBlock[];
}

/**
 * Applies edit blocks to the original selection text. Matching falls back:
 * exact substring → exact after trimming each line's edges → unique
 * first-line anchor (replaces as many lines as SEARCH had). A block that
 * still cannot be located is reported, never guessed.
 */
export function applyEditBlocks(original: string, blocks: readonly IOnyxEditBlock[]): IOnyxAppliedEdit {
	let text = original;
	let appliedCount = 0;
	const failed: IOnyxEditBlock[] = [];
	for (const block of blocks) {
		const applied = applyOne(text, block);
		if (applied === undefined) {
			failed.push(block);
		} else {
			text = applied;
			appliedCount++;
		}
	}
	return { text, appliedCount, failed };
}

function applyOne(text: string, block: IOnyxEditBlock): string | undefined {
	if (block.search.length === 0) {
		return undefined;
	}
	// 1. Exact match.
	const exactIndex = text.indexOf(block.search);
	if (exactIndex >= 0) {
		return text.slice(0, exactIndex) + block.replace + text.slice(exactIndex + block.search.length);
	}
	// 2. Line-trimmed match: whitespace drift is the most common corruption.
	const textLines = text.split('\n');
	const searchLines = block.search.split('\n');
	const trimmedSearch = searchLines.map(line => line.trim());
	for (let start = 0; start + searchLines.length <= textLines.length; start++) {
		let matches = true;
		for (let offset = 0; offset < searchLines.length; offset++) {
			if (textLines[start + offset].trim() !== trimmedSearch[offset]) {
				matches = false;
				break;
			}
		}
		if (matches) {
			// Re-indent the replacement by the drift of the first matched line.
			const indent = leadingWhitespace(textLines[start]);
			const claimed = leadingWhitespace(searchLines[0]);
			const replaceLines = block.replace.split('\n').map(line => reindent(line, claimed, indent));
			return [...textLines.slice(0, start), ...replaceLines, ...textLines.slice(start + searchLines.length)].join('\n');
		}
	}
	// 3. Unique first-line anchor for off-by-one hunks: same line count is replaced.
	const anchor = trimmedSearch[0];
	if (anchor) {
		const hits = textLines.map((line, index) => line.trim() === anchor ? index : -1).filter(index => index >= 0);
		if (hits.length === 1 && hits[0] + searchLines.length <= textLines.length) {
			const start = hits[0];
			const indent = leadingWhitespace(textLines[start]);
			const claimed = leadingWhitespace(searchLines[0]);
			const replaceLines = block.replace.split('\n').map(line => reindent(line, claimed, indent));
			return [...textLines.slice(0, start), ...replaceLines, ...textLines.slice(start + searchLines.length)].join('\n');
		}
	}
	return undefined;
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

function leadingWhitespace(line: string): string {
	return line.match(/^[\t ]*/)?.[0] ?? '';
}

/** Shifts a replacement line from the indentation the model claimed to the file's actual indentation. */
function reindent(line: string, claimed: string, actual: string): string {
	if (claimed === actual || line.trim().length === 0) {
		return line;
	}
	return line.startsWith(claimed) ? actual + line.slice(claimed.length) : line;
}
