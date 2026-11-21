/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Pure logic behind the agent's read-side tools (B1): the caps every tool
 * names in its refusals, the numbered read-result format, and the one place
 * that format is decoded again (R-24). Nothing here touches a service, so the
 * benchmark harness and plain Node can import it.
 */

/** A file larger than this is refused by `readFile`, with the cap named in the message. */
export const ONYX_READ_FILE_MAX_BYTES = 1024 * 1024;
/** Lines returned by one `readFile` call; the rest is reachable through `startLine`/`endLine`. */
export const ONYX_READ_FILE_MAX_LINES = 400;
/** One line of a read result is cut here, and says so, so a minified file cannot fill the context. */
export const ONYX_READ_LINE_MAX_CHARS = 1000;
/** Entries one `listDirectory` call returns. */
export const ONYX_LIST_MAX_ENTRIES = 200;
/** Directories probed for visible content in one `listDirectory` call. */
export const ONYX_LIST_MAX_DIRECTORY_PROBES = 64;
/** Paths one `findFiles` call returns, by default and at most. */
export const ONYX_FIND_DEFAULT_RESULTS = 50;
export const ONYX_FIND_MAX_RESULTS = 200;
/** Matching lines one `grep` call returns in total, and per file. */
export const ONYX_GREP_MAX_MATCHES = 60;
export const ONYX_GREP_MAX_MATCHES_PER_FILE = 8;
/** One matching line is cut here. */
export const ONYX_GREP_LINE_MAX_CHARS = 240;
/** Content-ranked suggestions appended to a `grep` that found nothing. */
export const ONYX_GREP_SUGGESTIONS = 5;

/** Splits text into lines the way an editor counts them, without the empty line a final newline adds. */
export function splitLines(text: string): string[] {
	const lines = text.split(/\r\n|\r|\n/);
	if (lines.length > 1 && lines[lines.length - 1] === '') {
		lines.pop();
	}
	return lines;
}

export type OnyxLineRange =
	| { readonly ok: true; readonly startLine: number; readonly endLine: number; readonly totalLines: number; readonly clipped: boolean }
	| { readonly ok: false; readonly error: string };

/**
 * Resolves a requested 1-based inclusive line range against a file's line
 * count. A range past the end is clamped; an inverted or non-positive range
 * is an error the model can read. `clipped` says the per-call line cap cut it.
 */
export function resolveLineRange(totalLines: number, startLine: number | undefined, endLine: number | undefined, maxLines: number = ONYX_READ_FILE_MAX_LINES): OnyxLineRange {
	if (startLine !== undefined && (!Number.isInteger(startLine) || startLine < 1)) {
		return { ok: false, error: `"startLine" must be a whole number from 1; got ${startLine}.` };
	}
	if (endLine !== undefined && (!Number.isInteger(endLine) || endLine < 1)) {
		return { ok: false, error: `"endLine" must be a whole number from 1; got ${endLine}.` };
	}
	const start = startLine ?? 1;
	if (endLine !== undefined && endLine < start) {
		return { ok: false, error: `"endLine" (${endLine}) is before "startLine" (${start}).` };
	}
	if (totalLines === 0) {
		return { ok: true, startLine: 1, endLine: 0, totalLines, clipped: false };
	}
	if (start > totalLines) {
		return { ok: false, error: `"startLine" (${start}) is past the end of the file, which has ${totalLines} line${totalLines === 1 ? '' : 's'}.` };
	}
	const wantedEnd = Math.min(endLine ?? totalLines, totalLines);
	const end = Math.min(wantedEnd, start + maxLines - 1);
	return { ok: true, startLine: start, endLine: end, totalLines, clipped: end < wantedEnd };
}

/** One line of a numbered read result: `12| text`. This is the only numbering format the harness emits. */
export function numberedLine(lineNumber: number, text: string): string {
	return `${lineNumber}| ${text}`;
}

/**
 * Renders a slice of a file as a numbered read result. Over-long lines are
 * cut with a marker that names how much is missing; a cut line cannot be
 * quoted for an edit, and the marker says so by not being source text.
 */
export function formatNumberedLines(lines: readonly string[], firstLineNumber: number, lineMaxChars: number = ONYX_READ_LINE_MAX_CHARS, numbered = true): string {
	const cut = (line: string) => line.length > lineMaxChars
		? `${line.slice(0, lineMaxChars)} [… ${line.length - lineMaxChars} more characters on this line …]`
		: line;
	// Without numbers the lines go out as they are: a lab arm of the harness configuration (L4), never the product's default.
	return lines.map((line, index) => numbered ? numberedLine(firstLineNumber + index, cut(line)) : cut(line)).join('\n');
}

const NUMBERED_LINE = /^(?<number>\d+)\|(?: (?<text>.*)|(?<empty>))$/;

export type OnyxNumberedDecoding =
	/** The text occurs in the file as written: nothing is decoded, even if it looks numbered. */
	| { readonly kind: 'exact' }
	/** The text is not shaped like a numbered read result: the caller's normal matching applies. */
	| { readonly kind: 'plain' }
	/** Every line is `N| text`, the numbers are consecutive and each text is exactly line N of the file. */
	| { readonly kind: 'decoded'; readonly text: string; readonly startLine: number; readonly endLine: number }
	/** Shaped like a numbered read result but not the file as it is now: refused, never guessed. */
	| { readonly kind: 'refused'; readonly reason: string };

/**
 * R-24. A model that read a file through `readFile` sometimes copies the
 * `12| ` prefixes into an edit's SEARCH text. They are decoded only when they
 * are provably the tool's own wrapper: the exact source text is tried first,
 * every line must carry the prefix, the numbers must run consecutively, and
 * the text after each prefix must equal that line of the file character for
 * character. Source that itself looks like `12| …` therefore matches exactly
 * and is never stripped, and indentation is never altered to force a match.
 */
export function decodeNumberedSearch(search: string, fileText: string): OnyxNumberedDecoding {
	if (search === '' || fileText.includes(search)) {
		return { kind: 'exact' };
	}
	const searchLines = splitLines(search);
	const parsed: { number: number; text: string }[] = [];
	for (const line of searchLines) {
		const match = NUMBERED_LINE.exec(line);
		if (!match?.groups) {
			return { kind: 'plain' };
		}
		parsed.push({ number: Number(match.groups.number), text: match.groups.text ?? '' });
	}
	if (parsed.length === 0) {
		return { kind: 'plain' };
	}
	for (let index = 1; index < parsed.length; index++) {
		if (parsed[index].number !== parsed[index - 1].number + 1) {
			return { kind: 'refused', reason: `the search text looks like numbered readFile output, but its line numbers are not consecutive (${parsed[index - 1].number} is followed by ${parsed[index].number}). Quote the lines without the "N| " prefix.` };
		}
	}
	const fileLines = splitLines(fileText);
	const first = parsed[0].number;
	const last = parsed[parsed.length - 1].number;
	for (const entry of parsed) {
		const actual = fileLines[entry.number - 1];
		if (actual === undefined || actual !== entry.text) {
			return { kind: 'refused', reason: `the search text looks like numbered readFile output for lines ${first} to ${last}, but line ${entry.number} of the file is not that text now. Read the file again and quote the lines without the "N| " prefix.` };
		}
	}
	return { kind: 'decoded', text: fileLines.slice(first - 1, last).join('\n'), startLine: first, endLine: last };
}

/**
 * Whether replacement text carries the read-result prefix on every non-empty
 * line with the given numbering. Used only after `decodeNumberedSearch`
 * decoded the SEARCH side: the same wrapper on the REPLACE side cannot be
 * checked against anything, so the edit is refused instead of guessed at.
 */
export function replacementCarriesNumbering(replace: string, startLine: number): boolean {
	const lines = splitLines(replace).filter(line => line.length > 0);
	if (lines.length === 0) {
		return false;
	}
	return lines.every((line, index) => {
		const match = NUMBERED_LINE.exec(line);
		return !!match?.groups && Number(match.groups.number) === startLine + index;
	});
}

/** One `grep` hit, rendered as `path:line: text`, cut at the documented width. */
export function formatGrepMatch(path: string, lineNumber: number, text: string, lineMaxChars: number = ONYX_GREP_LINE_MAX_CHARS): string {
	const line = text.replace(/\r?\n$/, '');
	return `${path}:${lineNumber}: ${line.length > lineMaxChars ? `${line.slice(0, lineMaxChars)} […]` : line}`;
}

/** A byte count as a short size, for directory listings. */
export function formatSize(bytes: number): string {
	if (bytes < 1024) {
		return `${bytes} B`;
	}
	if (bytes < 1024 * 1024) {
		return `${(bytes / 1024).toFixed(1)} KB`;
	}
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
