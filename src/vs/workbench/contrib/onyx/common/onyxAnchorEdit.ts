/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IOnyxPromptEvidence } from './onyxEditCertificate.js';

/**
 * Constrained anchors (L7, R-47, experimental): an edit protocol whose
 * anchors cannot be invented. In a constrained turn the model names the
 * first and the last line to replace, and the schema for those two names is
 * an enumeration of the lines the model was shown this turn. A runtime that
 * enforces the schema then cannot produce an anchor that is not on that
 * list.
 *
 * What this does not do: it does not make the anchors the right ones. The
 * model can still pick a line that exists and is the wrong line. And the
 * harness trusts none of it: an anchor pair is resolved against the file as
 * it is, and refused when a line is not there, is there more than once, or
 * the pair is in the wrong order.
 *
 * Pure. The list is read from the prompt the turn is sent, after eviction:
 * the numbered results of `readFile`.
 */

/** The most the enumeration may hold. Past either, the turn falls back to free-form SEARCH/REPLACE. */
export const ONYX_ANCHOR_LIMITS = {
	/** Distinct anchors. */
	maxAnchors: 400,
	/** Their characters together: the grammar a runtime builds grows with them. */
	maxChars: 24_000,
} as const;

/** The lines of one file the model was shown this turn, by number. A file read twice keeps the later text of a line. */
export interface IOnyxShownFile {
	readonly path: string;
	readonly lines: ReadonlyMap<number, string>;
}

const READ_HEADER = /^(?<path>.+) \(lines (?<start>\d+)-(?<end>\d+) of \d+(?:, as open in the editor)?\)$/;
const NUMBERED_LINE = /^(?<number>\d+)\|(?: (?<text>.*))?$/;

/** The files and lines the model is shown in a turn: every `readFile` result still in the prompt. */
export function shownFiles(evidence: IOnyxPromptEvidence): IOnyxShownFile[] {
	const files = new Map<string, Map<number, string>>();
	for (const segment of evidence.segments) {
		if (segment.source !== 'tool-result' || segment.tool !== 'readFile') {
			continue;
		}
		const [first, ...rest] = segment.text.split('\n');
		const header = READ_HEADER.exec(first);
		if (!header?.groups) {
			continue;
		}
		const lines = files.get(header.groups.path) ?? new Map<number, string>();
		files.set(header.groups.path, lines);
		for (const line of rest) {
			const numbered = NUMBERED_LINE.exec(line);
			// A line the read cut short cannot be quoted, and what follows the numbered lines is the tool's own note.
			if (!numbered?.groups || line.includes(' more characters on this line …]')) {
				continue;
			}
			lines.set(Number(numbered.groups.number), numbered.groups.text ?? '');
		}
	}
	return [...files].map(([path, lines]) => ({ path, lines }));
}

export interface IOnyxAnchorOffer {
	/** The files that have anchors on offer. */
	readonly paths: readonly string[];
	/**
	 * The anchors: a line's own text when no other line shown for its file
	 * has that text, and B1's numbered form (`12| text`) when one does.
	 * Blank lines are not anchors.
	 */
	readonly anchors: readonly string[];
	readonly chars: number;
}

export type OnyxAnchorOfferResult =
	| { readonly kind: 'offer'; readonly offer: IOnyxAnchorOffer }
	/** Nothing the model was shown this turn can be anchored on. */
	| { readonly kind: 'none' }
	/** There is more than the enumeration may hold: the turn uses free-form SEARCH/REPLACE. */
	| { readonly kind: 'too-large'; readonly anchors: number; readonly chars: number };

/** The anchors a turn may offer, or why it offers none. */
export function buildAnchorOffer(files: readonly IOnyxShownFile[]): OnyxAnchorOfferResult {
	const anchors = new Set<string>();
	const paths: string[] = [];
	for (const file of files) {
		const counts = new Map<string, number>();
		for (const text of file.lines.values()) {
			counts.set(text, (counts.get(text) ?? 0) + 1);
		}
		let any = false;
		for (const [number, text] of file.lines) {
			if (text.trim() === '') {
				continue;
			}
			anchors.add((counts.get(text) ?? 0) > 1 ? `${number}| ${text}` : text);
			any = true;
		}
		if (any) {
			paths.push(file.path);
		}
	}
	if (anchors.size === 0) {
		return { kind: 'none' };
	}
	let chars = 0;
	for (const anchor of anchors) {
		chars += anchor.length;
	}
	if (anchors.size > ONYX_ANCHOR_LIMITS.maxAnchors || chars > ONYX_ANCHOR_LIMITS.maxChars) {
		return { kind: 'too-large', anchors: anchors.size, chars };
	}
	return { kind: 'offer', offer: { paths, anchors: [...anchors], chars } };
}

/** The schema of an anchored edit's arguments: both anchors and the path are chosen from what is on offer. */
export function anchorEditSchema(offer: IOnyxAnchorOffer): object {
	return {
		type: 'object',
		properties: {
			path: { type: 'string', enum: [...offer.paths] },
			startAnchor: { type: 'string', enum: [...offer.anchors] },
			endAnchor: { type: 'string', enum: [...offer.anchors] },
			replace: { type: 'string' },
		},
		required: ['path', 'startAnchor', 'endAnchor', 'replace'],
		additionalProperties: false,
	};
}

/** The line of the instruction that teaches the anchored edit. One place, so that the prompt and the schema cannot drift. */
export function anchorEditInstruction(): string {
	return 'To change lines of a file you have read this turn, respond with {"action":"edit","edit":{"path":"<the file>","startAnchor":"<the first line to replace, exactly as it was read>","endAnchor":"<the last line to replace; the same line to replace one>","replace":"<the new lines>"}}. Where a line was read more than once in the file, give it with its number, as "12| text".';
}

/** Whether a call's arguments are meant as an anchored edit: they name an anchor. Whether they are a valid one is another question. */
export function isAnchoredCall(parameters: unknown): boolean {
	return typeof parameters === 'object' && parameters !== null && (Object.hasOwn(parameters, 'startAnchor') || Object.hasOwn(parameters, 'endAnchor'));
}

/** The arguments of an anchored edit, when that is what a call's arguments are. */
export function readAnchorArguments(parameters: unknown): { readonly path: string; readonly startAnchor: string; readonly endAnchor: string; readonly replace: string } | undefined {
	if (typeof parameters !== 'object' || parameters === null) {
		return undefined;
	}
	const given: { path?: unknown; startAnchor?: unknown; endAnchor?: unknown; replace?: unknown } = parameters;
	return typeof given.path === 'string' && typeof given.startAnchor === 'string' && typeof given.endAnchor === 'string' && typeof given.replace === 'string'
		? { path: given.path.trim(), startAnchor: given.startAnchor, endAnchor: given.endAnchor, replace: given.replace }
		: undefined;
}

export type OnyxAnchorResolution =
	/** The lines to replace, 1-based and inclusive, and the content the file would have. */
	| { readonly ok: true; readonly startLine: number; readonly endLine: number; readonly replaced: string; readonly proposed: string }
	| { readonly ok: false; readonly reason: string };

function resolveOne(lines: readonly string[], anchor: string, which: 'startAnchor' | 'endAnchor'): { readonly ok: true; readonly line: number } | { readonly ok: false; readonly reason: string } {
	const numbered = NUMBERED_LINE.exec(anchor);
	if (numbered?.groups && !lines.includes(anchor)) {
		// The numbered form names one line. It is that line or it is nothing: the file may have changed since it was read.
		const number = Number(numbered.groups.number);
		const text = numbered.groups.text ?? '';
		if (number < 1 || number > lines.length || lines[number - 1] !== text) {
			return { ok: false, reason: `the ${which} names line ${number}, and line ${number} of the file is not that text. Read the file again.` };
		}
		return { ok: true, line: number };
	}
	const places: number[] = [];
	lines.forEach((line, index) => {
		if (line === anchor) {
			places.push(index + 1);
		}
	});
	if (places.length === 0) {
		return { ok: false, reason: `the ${which} is not a line of the file. Read the file again and choose a line as it is.` };
	}
	if (places.length > 1) {
		return { ok: false, reason: `the ${which} is duplicated: that text is on lines ${places.slice(0, 5).join(', ')}${places.length > 5 ? ` and ${places.length - 5} more` : ''}. Give it with its number, as "${places[0]}| ${anchor}".` };
	}
	return { ok: true, line: places[0] };
}

/**
 * Resolves an anchor pair against the file as it is (R-47). Each anchor has
 * to be exactly one line of it, and the first may not come after the last.
 * Nothing is trimmed and nothing is guessed: the same rule as B6, for
 * lines.
 */
export function resolveAnchorEdit(base: string, startAnchor: string, endAnchor: string, replace: string): OnyxAnchorResolution {
	const lines = base.split('\n');
	const start = resolveOne(lines, startAnchor, 'startAnchor');
	if (!start.ok) {
		return { ok: false, reason: start.reason };
	}
	const end = resolveOne(lines, endAnchor, 'endAnchor');
	if (!end.ok) {
		return { ok: false, reason: end.reason };
	}
	if (start.line > end.line) {
		return { ok: false, reason: `the anchors are reversed: the startAnchor is line ${start.line} and the endAnchor is line ${end.line}. The startAnchor is the first line to replace.` };
	}
	const replacement = replace === '' ? [] : replace.replace(/\n$/, '').split('\n');
	return {
		ok: true, startLine: start.line, endLine: end.line,
		replaced: lines.slice(start.line - 1, end.line).join('\n'),
		proposed: [...lines.slice(0, start.line - 1), ...replacement, ...lines.slice(end.line)].join('\n'),
	};
}
