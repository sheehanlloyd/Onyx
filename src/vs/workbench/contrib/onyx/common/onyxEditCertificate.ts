/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { traceDigest } from './onyxTrace.js';

/**
 * Edit certificates (L6, R-46). When an edit is staged, the harness has
 * made decisions on the user's behalf: that the quoted text is in the file
 * exactly once, and against which content. A certificate is the record of
 * those decisions, with one more observation that costs nothing: whether
 * the model had been shown the text it is editing in the turn it edited it.
 *
 * A certificate says what was checked. It does not say the edit is right,
 * and nothing built on it may say so.
 *
 * Pure: the same functions make a certificate when an edit is staged and
 * recompute one from a run's journal afterwards.
 */

/** How the edit was expressed. */
export type OnyxEditProtocol =
	/** One SEARCH/REPLACE pair. */
	| 'search-replace'
	/** One of several pairs in a single call (C3). */
	| 'multi-edit'
	/** A whole new file: there is no anchor. */
	| 'new-file'
	/** An inline edit of the user's own selection (B9): the user chose the lines. */
	| 'inline'
	/** A whole-file proposal from a refactor: there is no anchor. */
	| 'whole-file'
	/** Anchors chosen from an enumeration of lines the model was shown (L7). */
	| 'constrained-anchors';

/** One piece of what the model was sent in a turn. */
export interface IOnyxPromptSegment {
	/** The message's place in the prompt. */
	readonly index: number;
	readonly source: 'system' | 'user' | 'assistant' | 'tool-result';
	/** For a tool result: the tool that produced it. */
	readonly tool?: string;
	readonly text: string;
}

/** What the model was sent in the turn that produced an edit, after eviction and compression. */
export interface IOnyxPromptEvidence {
	/** 1-based, as in the trace. */
	readonly turn: number;
	readonly segments: readonly IOnyxPromptSegment[];
	/** True when the text here is cut short (a journal's snapshot is): absence then proves nothing. */
	readonly truncated: boolean;
}

export type OnyxGrounding =
	/** Every line of the anchor was in something the model was sent this turn that the model did not write itself. */
	| 'grounded'
	/** At least one line of the anchor was in nothing the model was sent this turn, its own earlier words aside. */
	| 'ungrounded'
	/** What the model was sent is not on record, or is on record cut short and does not show the anchor. */
	| 'unknown'
	/** There is no anchor: a new file, a whole-file proposal, the user's own selection. */
	| 'not-applicable';

export interface IOnyxEditCertificate {
	readonly v: 1;
	readonly path: string;
	readonly protocol: OnyxEditProtocol;
	/** The turn that produced the edit, or null outside a run. */
	readonly turn: number | null;
	/** The tool call that carried the edit, by its id, or null when there was none (an inline edit, a refactor). */
	readonly call: string | null;
	/** Which edit of that call this was, from 0: a call may carry several (C3). */
	readonly block: number;
	/** What the edit was placed against: a digest of that text, and the text model's version when it was read. */
	readonly base: { readonly contentHash: string; readonly versionId: number | null };
	/**
	 * The quoted text as the model sent it: a digest, how many lines, and
	 * how many times it was found in the text it was placed against, which
	 * is one for every edit that was staged. Null when there is no anchor.
	 */
	readonly anchor: { readonly digest: string; readonly lines: number; readonly matchCount: number } | null;
	readonly grounding: OnyxGrounding;
	/**
	 * The latest thing the model was sent this turn, not written by the
	 * model, that holds the anchor's first line; whether it holds all of
	 * them. Null when nothing does.
	 */
	readonly provenance: { readonly segment: number; readonly source: IOnyxPromptSegment['source']; readonly tool?: string; readonly holdsEveryLine: boolean } | null;
}

/** What an anchored edit (L7) quotes, as one text: its first line and its last. */
export function anchorPairText(startAnchor: string, endAnchor: string): string {
	return `${startAnchor}\n${endAnchor}`;
}

/** The lines of an anchor that can be looked for: trimmed, the blank ones left out. */
function anchorLines(search: string): string[] {
	return search.split('\n').map(line => line.trim()).filter(line => line.length > 0);
}

/**
 * Whether the model was shown the anchor, and where. A line counts as shown
 * when it is in a segment's text, surrounding white space aside: a
 * numbered read prints `12| \treturn a;` and the model may quote it with
 * or without the number. The model's own earlier words do not count: that
 * a model repeats a line is not evidence the line is in the file.
 */
export function groundAnchor(search: string, evidence: IOnyxPromptEvidence | undefined): Pick<IOnyxEditCertificate, 'grounding' | 'provenance'> {
	const lines = anchorLines(search);
	if (lines.length === 0) {
		return { grounding: 'not-applicable', provenance: null };
	}
	if (!evidence) {
		return { grounding: 'unknown', provenance: null };
	}
	const shown = evidence.segments.filter(segment => segment.source !== 'assistant');
	const everyLineShown = lines.every(line => shown.some(segment => segment.text.includes(line)));
	let provenance: IOnyxEditCertificate['provenance'] = null;
	for (let index = shown.length - 1; index >= 0 && !provenance; index--) {
		const segment = shown[index];
		if (segment.text.includes(lines[0])) {
			provenance = { segment: segment.index, source: segment.source, ...(segment.tool ? { tool: segment.tool } : {}), holdsEveryLine: lines.every(line => segment.text.includes(line)) };
		}
	}
	return { grounding: everyLineShown ? 'grounded' : evidence.truncated ? 'unknown' : 'ungrounded', provenance };
}

export interface IOnyxCertifyInput {
	readonly path: string;
	readonly protocol: OnyxEditProtocol;
	readonly call: string | null;
	readonly block: number;
	/** The text the edit was placed against. */
	readonly base: string;
	readonly baseVersionId: number | null;
	/** The SEARCH text as the model sent it; undefined or empty when the protocol has no anchor. */
	readonly search: string | undefined;
	/** How many times the text that was looked for (after a numbered read is decoded) is in `base`. */
	readonly matchCount: number;
	readonly evidence: IOnyxPromptEvidence | undefined;
}

/** The certificate of one staged edit. */
export function certifyEdit(input: IOnyxCertifyInput): IOnyxEditCertificate {
	const anchored = input.search !== undefined && anchorLines(input.search).length > 0 && (input.protocol === 'search-replace' || input.protocol === 'multi-edit' || input.protocol === 'constrained-anchors');
	const grounded = anchored ? groundAnchor(input.search!, input.evidence) : { grounding: 'not-applicable' as const, provenance: null };
	return {
		v: 1,
		path: input.path,
		protocol: input.protocol,
		turn: input.evidence?.turn ?? null,
		call: input.call,
		block: input.block,
		base: { contentHash: traceDigest(input.base), versionId: input.baseVersionId },
		anchor: anchored ? { digest: traceDigest(input.search!), lines: input.search!.split('\n').length, matchCount: input.matchCount } : null,
		...grounded,
	};
}

/** A digest of everything a certificate says, in a fixed order: what a journal keeps beside it, so a changed certificate shows. */
export function sealCertificate(certificate: IOnyxEditCertificate): string {
	const { v, path, protocol, turn, call, block, base, anchor, grounding, provenance } = certificate;
	return traceDigest(JSON.stringify([v, path, protocol, turn, call, block, base.contentHash, base.versionId, anchor ? [anchor.digest, anchor.lines, anchor.matchCount] : null, grounding, provenance ? [provenance.segment, provenance.source, provenance.tool ?? null, provenance.holdsEveryLine] : null]));
}

/** The one line a reviewer reads for a hunk. Which words are used is the view's business; this says which case it is. */
export type OnyxCertificateSummary =
	| 'anchored-seen'
	| 'anchored-not-seen'
	| 'anchored-unknown'
	| 'new-file'
	| 'inline'
	| 'whole-file';

export function summarizeCertificate(certificate: IOnyxEditCertificate): OnyxCertificateSummary {
	switch (certificate.protocol) {
		case 'new-file': return 'new-file';
		case 'inline': return 'inline';
		case 'whole-file': return 'whole-file';
		default:
			return certificate.grounding === 'grounded' ? 'anchored-seen' : certificate.grounding === 'ungrounded' ? 'anchored-not-seen' : 'anchored-unknown';
	}
}

/**
 * A certificate with what ties it to hunks of the review: digests of the
 * lines its edit took out and of the lines it put in. A hunk belongs to the
 * latest edit that took out every line the hunk takes out, or put in every
 * line the hunk puts in.
 */
export interface IOnyxCertifiedEdit {
	readonly certificate: IOnyxEditCertificate;
	readonly seal: string;
	/** Null for an edit that covers the whole proposal: a new file, a whole-file proposal, an inline edit. */
	readonly lines: { readonly removed: readonly string[]; readonly added: readonly string[] } | null;
}

function lineDigests(text: string): string[] {
	return text.split('\n').filter(line => line.trim().length > 0).map(traceDigest);
}

/** `removed` and `added` are the whole lines the edit took out and put in; both undefined for an edit that covers the whole proposal. */
export function certifiedEdit(certificate: IOnyxEditCertificate, removed: string | undefined, added: string | undefined): IOnyxCertifiedEdit {
	return { certificate, seal: sealCertificate(certificate), lines: removed === undefined || added === undefined ? null : { removed: lineDigests(removed), added: lineDigests(added) } };
}

/** The certificate of the edit a hunk came from, or undefined when no edit on record accounts for it. */
export function certificateForHunk(edits: readonly IOnyxCertifiedEdit[], hunk: { readonly originalLines: readonly string[]; readonly newLines: readonly string[] }): IOnyxEditCertificate | undefined {
	const removed = lineDigests(hunk.originalLines.join('\n'));
	const added = lineDigests(hunk.newLines.join('\n'));
	for (let index = edits.length - 1; index >= 0; index--) {
		const edit = edits[index];
		if (edit.lines === null) {
			return edit.certificate;
		}
		const tookOut = removed.length > 0 && removed.every(line => edit.lines!.removed.includes(line));
		const putIn = added.length > 0 && added.every(line => edit.lines!.added.includes(line));
		if (tookOut || putIn) {
			return edit.certificate;
		}
	}
	return undefined;
}

// --- offline: from a run's journal -------------------------------------------

/** A certificate as a journal holds it. */
export interface IOnyxTraceCertificate {
	readonly kind: 'editCertificate';
	readonly certificate: IOnyxEditCertificate;
	readonly seal: string;
	/** The generation and the hunks the edit became, as the review named them. */
	readonly generation: number;
	readonly hunks: readonly string[];
}

/** What a journal says became of certified hunks: the content after an acceptance, and what verification (C2) found. */
export interface IOnyxTraceCertificateOutcome {
	readonly kind: 'editCertificateOutcome';
	readonly path: string;
	readonly generation: number;
	/** A digest of the file's content right after the acceptance. */
	readonly appliedContentHash: string | null;
	/** `running`, `verified`, `new problems`, `timed out` or `stale`: C2's state for that content. Never more than was checked. */
	readonly verification: string;
}

export interface IOnyxCertificateCheck {
	readonly path: string;
	readonly turn: number | null;
	readonly call: string | null;
	readonly block: number;
	/** `matches`: what can be recomputed from the journal is what the certificate says, and its seal is its own. */
	readonly verdict: 'matches' | 'differs' | 'not-recomputable';
	/** What differs, or why nothing could be recomputed. */
	readonly detail: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * What a turn's prompt showed the model, from the messages as a journal's
 * `promptSnapshot` holds them (and as the loop holds them, uncut, when an
 * edit is staged): one segment for every piece of text, a tool result
 * under the name of the tool whose call it answers. Also returns the edits
 * the model sent in the turn before, by the id of the call that carried
 * them: a prompt carries the previous turn's calls.
 */
export function readPromptMessages(turn: number, messages: readonly unknown[]): { readonly evidence: IOnyxPromptEvidence; readonly editsByCall: ReadonlyMap<string, readonly string[]> } {
	const segments: IOnyxPromptSegment[] = [];
	const toolByCall = new Map<string, string>();
	const editsByCall = new Map<string, readonly string[]>();
	let truncated = false;
	messages.forEach((message: unknown, index: number) => {
		if (!isRecord(message) || !Array.isArray(message.content)) {
			return;
		}
		// Roles as the chat stack numbers them: 0 system, 1 user, 2 assistant.
		const role = message.role === 0 ? 'system' : message.role === 2 ? 'assistant' : 'user';
		for (const part of message.content) {
			if (!isRecord(part)) {
				continue;
			}
			if (part.type === 'tool_use' && typeof part.name === 'string' && typeof part.toolCallId === 'string') {
				toolByCall.set(part.toolCallId, part.name);
				if (part.name === 'editFile' && isRecord(part.parameters)) {
					const parameters = part.parameters;
					editsByCall.set(part.toolCallId, Array.isArray(parameters.edits)
						? parameters.edits.map(edit => isRecord(edit) && typeof edit.search === 'string' ? edit.search : '')
						// An anchored edit (L7) quotes two lines: its first and its last.
						: typeof parameters.startAnchor === 'string' && typeof parameters.endAnchor === 'string' ? [anchorPairText(parameters.startAnchor, parameters.endAnchor)]
							: [typeof parameters.search === 'string' ? parameters.search : '']);
				}
			} else if (typeof part.value === 'string') {
				truncated ||= part.value.endsWith('… [truncated]');
				const tool = part.type === 'tool_result' && typeof part.toolCallId === 'string' ? toolByCall.get(part.toolCallId) : undefined;
				segments.push(part.type === 'tool_result' ? { index, source: 'tool-result', ...(tool ? { tool } : {}), text: part.value } : { index, source: role, text: part.value });
			}
		}
	});
	return { evidence: { turn, segments, truncated }, editsByCall };
}

/**
 * Checks every certificate in a run's journal against the journal itself
 * (R-46). For each one: its seal must be the digest of what it says, and
 * the parts that the journal can show are recomputed from the prompt of
 * the turn that produced the edit and from the edit's own arguments, which
 * the following turn's prompt carries: the anchor's digest and size, where
 * the anchor came from, and whether it was grounded.
 *
 * Two parts cannot be recomputed without the file as it then was, and are
 * not claimed to be: the digest of the base and the match count. The match
 * count of a staged edit is one by construction (B6).
 */
export function checkCertificates(journalText: string): IOnyxCertificateCheck[] {
	const snapshots = new Map<number, ReturnType<typeof readPromptMessages>>();
	const certificates: IOnyxTraceCertificate[] = [];
	for (const line of journalText.split('\n')) {
		if (!line.trim()) {
			continue;
		}
		let event: unknown;
		try {
			event = JSON.parse(line);
		} catch {
			continue;
		}
		if (!isRecord(event) || !isRecord(event.data)) {
			continue;
		}
		if (event.kind === 'promptSnapshot' && typeof event.data.turn === 'number' && Array.isArray(event.data.messages)) {
			snapshots.set(event.data.turn, readPromptMessages(event.data.turn, event.data.messages));
		} else if (event.kind === 'editCertificate' && isRecord(event.data.certificate)) {
			certificates.push(event.data as unknown as IOnyxTraceCertificate);
		}
	}
	return certificates.map(({ certificate, seal }) => {
		const where = { path: certificate.path, turn: certificate.turn, call: certificate.call, block: certificate.block };
		if (sealCertificate(certificate) !== seal) {
			return { ...where, verdict: 'differs' as const, detail: 'the certificate is not the one that was sealed' };
		}
		if (certificate.anchor === null) {
			return { ...where, verdict: 'matches' as const, detail: 'no anchor to recompute' };
		}
		const prompt = certificate.turn === null ? undefined : snapshots.get(certificate.turn);
		const search = certificate.turn === null || certificate.call === null ? undefined : snapshots.get(certificate.turn + 1)?.editsByCall.get(certificate.call)?.[certificate.block];
		if (!prompt || search === undefined) {
			return { ...where, verdict: 'not-recomputable' as const, detail: !prompt ? 'the prompt of the turn is not in the journal' : 'the edit\'s arguments are not in the journal: the run ended with this turn' };
		}
		const recomputed = groundAnchor(search, prompt.evidence);
		const differences = [
			traceDigest(search) === certificate.anchor.digest ? undefined : 'the anchor is not the text the model sent',
			search.split('\n').length === certificate.anchor.lines ? undefined : 'the anchor\'s size',
			recomputed.grounding === certificate.grounding || recomputed.grounding === 'unknown' ? undefined : `grounding: the journal shows ${recomputed.grounding}, the certificate says ${certificate.grounding}`,
			recomputed.grounding === 'unknown' || JSON.stringify(recomputed.provenance) === JSON.stringify(certificate.provenance) ? undefined : 'where the anchor came from',
		].filter(difference => difference !== undefined);
		if (differences.length > 0) {
			return { ...where, verdict: 'differs' as const, detail: differences.join('; ') };
		}
		return recomputed.grounding === 'unknown'
			? { ...where, verdict: 'not-recomputable' as const, detail: 'the journal holds the prompt cut short, and what it holds does not show the anchor' }
			: { ...where, verdict: 'matches' as const, detail: 'anchor, provenance and grounding recomputed from the journal' };
	});
}
