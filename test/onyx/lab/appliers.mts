/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Comparator appliers for the edit-mechanism study (L14, H-3). These place
 * an edit where the product refuses to: they are here to be measured
 * against exact-or-refuse (DEC-07), and they are lab-only code. Nothing
 * under `src/` imports this file, no setting selects it, and it is not in
 * the product bundle (DEC-10, R-44).
 *
 * Each takes the file as it was and one SEARCH/REPLACE block and returns
 * the file with the block placed, or undefined when it places nothing.
 */

export interface IEditBlock { readonly search: string; readonly replace: string }
export type Applier = (file: string, block: IEditBlock) => string | undefined;

const lines = (text: string): string[] => text.split('\n');
/** A SEARCH text's lines without the empty line a trailing newline leaves. */
function searchLines(search: string): string[] {
	const split = lines(search);
	return split.length > 1 && split[split.length - 1] === '' ? split.slice(0, -1) : split;
}
function replaceAt(file: string[], start: number, count: number, replace: string): string {
	const replacement = replace === '' ? [] : searchLines(replace);
	return [...file.slice(0, start), ...replacement, ...file.slice(start + count)].join('\n');
}

/** Whitespace-insensitive: lines are compared trimmed, and the first place where every line matches is taken. */
export const whitespaceInsensitive: Applier = (file, block) => {
	const wanted = searchLines(block.search).map(line => line.trim());
	if (wanted.length === 0 || wanted.every(line => line === '')) {
		return undefined;
	}
	const have = lines(file);
	for (let start = 0; start + wanted.length <= have.length; start++) {
		if (wanted.every((line, offset) => have[start + offset].trim() === line)) {
			return replaceAt(have, start, wanted.length, block.replace);
		}
	}
	return undefined;
};

/**
 * Unique-first-line: the edit is placed by the first line of its SEARCH
 * text, where that line occurs exactly once in the file, and replaces as
 * many lines as the SEARCH text has, whatever those lines are. This is the
 * fallback an audit found in the product before B6.
 */
export const uniqueFirstLine: Applier = (file, block) => {
	const wanted = searchLines(block.search);
	const first = wanted[0]?.trim();
	if (!first) {
		return undefined;
	}
	const have = lines(file);
	const places = have.flatMap((line, index) => line.trim() === first ? [index] : []);
	return places.length === 1 ? replaceAt(have, places[0], wanted.length, block.replace) : undefined;
};

/** The similarity of two lines, 0 to 1: one less their edit distance over the longer length, compared trimmed. */
export function lineSimilarity(left: string, right: string): number {
	const a = left.trim();
	const b = right.trim();
	if (a === b) {
		return 1;
	}
	const longer = Math.max(a.length, b.length);
	if (longer === 0) {
		return 1;
	}
	// Two rows of the edit-distance table are enough.
	let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
	for (let i = 1; i <= a.length; i++) {
		const current = [i];
		for (let j = 1; j <= b.length; j++) {
			current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1));
		}
		previous = current;
	}
	return 1 - previous[b.length] / longer;
}

export const FUZZY_THRESHOLD = 0.8;

/**
 * Fuzzy: the window of the file, as long as the SEARCH text, whose lines
 * are on average most similar to it, taken when that mean similarity is at
 * least 0.8. The first such window wins a tie.
 */
export const fuzzy: Applier = (file, block) => {
	const wanted = searchLines(block.search);
	if (wanted.length === 0 || wanted.every(line => line.trim() === '')) {
		return undefined;
	}
	const have = lines(file);
	let best = -1;
	let bestScore = 0;
	for (let start = 0; start + wanted.length <= have.length; start++) {
		let total = 0;
		for (let offset = 0; offset < wanted.length; offset++) {
			total += lineSimilarity(wanted[offset], have[start + offset]);
		}
		const score = total / wanted.length;
		if (score > bestScore) {
			bestScore = score;
			best = start;
		}
	}
	return best >= 0 && bestScore >= FUZZY_THRESHOLD ? replaceAt(have, best, wanted.length, block.replace) : undefined;
};

export const COMPARATORS: Readonly<Record<string, Applier>> = { 'whitespace-insensitive': whitespaceInsensitive, 'unique-first-line': uniqueFirstLine, fuzzy };
