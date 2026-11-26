/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Verification of what was accepted (C2, R-21). Pure: what a problem's
 * identity is, how two sets of problems are compared, and the states a
 * verification can be in. A count of problems hides one error being swapped
 * for another; an identity does not.
 */

/** A diagnostic as the comparison sees it. */
export interface IOnyxProblem {
	/** The file, as the change set names it. */
	readonly path: string;
	/** `error` or `warning`; hints and information are not problems here. */
	readonly severity: 'error' | 'warning';
	/** Who reported it (`ts`, `eslint`). */
	readonly source: string;
	readonly code: string;
	readonly message: string;
	/** 1-based. Shown to the reader; not part of the identity, because an edit above a problem moves it without changing it. */
	readonly line: number;
}

/**
 * What makes two diagnostics the same problem: the file, who reported it,
 * its code, its severity and its message. Not its line: an accepted edit
 * moves the lines below it, and a problem that only moved is not new.
 */
export function problemIdentity(problem: IOnyxProblem): string {
	return JSON.stringify([problem.path, problem.severity, problem.source, problem.code, problem.message]);
}

export interface IOnyxProblemDiff {
	/** Problems that are there now and were not before, each one counted as often as it is new. */
	readonly introduced: readonly IOnyxProblem[];
	/** Problems that were there before and are not now. */
	readonly resolved: readonly IOnyxProblem[];
	readonly before: number;
	readonly after: number;
}

/**
 * Compares the problems before an acceptance with those after it, by
 * identity and with multiplicity: three copies of a message where there
 * were two is one new problem. One error swapped for another is one
 * introduced and one resolved, although the count did not move.
 */
export function diffProblems(before: readonly IOnyxProblem[], after: readonly IOnyxProblem[]): IOnyxProblemDiff {
	const remaining = new Map<string, number>();
	for (const problem of before) {
		const identity = problemIdentity(problem);
		remaining.set(identity, (remaining.get(identity) ?? 0) + 1);
	}
	const introduced: IOnyxProblem[] = [];
	for (const problem of after) {
		const identity = problemIdentity(problem);
		const left = remaining.get(identity) ?? 0;
		if (left > 0) {
			remaining.set(identity, left - 1);
		} else {
			introduced.push(problem);
		}
	}
	const resolved: IOnyxProblem[] = [];
	for (const problem of before) {
		const identity = problemIdentity(problem);
		const left = remaining.get(identity) ?? 0;
		if (left > 0) {
			remaining.set(identity, left - 1);
			resolved.push(problem);
		}
	}
	return { introduced, resolved, before: before.length, after: after.length };
}

/** How long a verification waits for diagnostics of the accepted content, and how long it lets them settle. */
export const ONYX_VERIFICATION_TIMING = {
	/** After an acceptance, fresh diagnostics for the file have this long to arrive. */
	refreshTimeoutMs: 15_000,
	/** Once they arrive, this much quiet ends the wait: language services report in several steps. */
	settleMs: 750,
} as const;

export type OnyxVerificationState =
	/** Something is staged for the file and nothing of it was accepted: there is nothing to verify yet. */
	| 'not applied'
	/** A hunk was accepted; fresh diagnostics for that content are awaited. */
	| 'running'
	/**
	 * Fresh diagnostics arrived for the accepted content, and none of them is a
	 * new problem; or the file had no problems before, has none after, no
	 * report came in the wait (`unreported`), and a language service answers
	 * for the file (`languageService`): one that finds a clean file still clean
	 * reports nothing, because nothing changed.
	 */
	| 'verified'
	/**
	 * No problem before, none after, no report in the wait, and no language
	 * service answers for the file's language (C2): nothing looked at the
	 * accepted content, so the absence of a report says nothing about it.
	 */
	| 'not checked'
	/** Fresh diagnostics arrived, and some are problems that were not there before the acceptance. */
	| 'new problems'
	/** No fresh diagnostics arrived in time for a file that had problems before: nothing is known about the accepted content. */
	| 'timed out'
	/** The file changed after the acceptance, so the result is about content that is no longer there. */
	| 'stale';

/** What is known about the verification of one file's accepted content. */
export interface IOnyxVerificationResult {
	readonly path: string;
	/** The proposal generation the accepted hunks belonged to. */
	readonly generation: number;
	readonly state: OnyxVerificationState;
	/** A digest of the content that was verified, or is being verified: the buffer right after the acceptance. */
	readonly contentHash: string | null;
	/** Hunks of the file's proposal that are still staged. Above zero after an acceptance, the result is partial: it covers what was accepted and not these. */
	readonly stagedHunksLeft: number;
	readonly diff: IOnyxProblemDiff | null;
	/** For `verified`: no diagnostics report arrived; the verdict rests on no problem before, none after, and none reported. */
	readonly unreported?: boolean;
	/** For an unreported `verified`: what the language service attached to the file answers for it (`symbols`, `definitions`, `hovers`, `references`). */
	readonly languageService?: readonly string[];
	/** What a project check found for this content, when one ran, and what it ran on. */
	readonly check: IOnyxCheckOutcome | null;
}

/** A project check (a task that reads the disk) after an acceptance. */
export type IOnyxCheckOutcome =
	/** The accepted file has unsaved changes. The check reads the disk, and Onyx does not save for the user. */
	| { readonly kind: 'not run'; readonly reason: 'unsaved'; readonly unsavedFiles: readonly string[] }
	| { readonly kind: 'not run'; readonly reason: 'not approved' | 'no task' }
	| { readonly kind: 'ran'; readonly task: string; readonly passed: boolean; readonly exitCode: number | null; readonly seconds: number; readonly savedFiles: readonly { readonly path: string; readonly contentHash: string }[] };

/** One line that says where a verification stands, for the timeline and the review. Never more than was checked. */
export function describeVerification(result: IOnyxVerificationResult): string {
	const line = describeVerificationState(result);
	if (result.state === 'not applied' || result.stagedHunksLeft === 0) {
		return line;
	}
	return `${line}. Partial: ${result.stagedHunksLeft === 1 ? '1 hunk is' : `${result.stagedHunksLeft} hunks are`} still staged and not part of this`;
}

function describeVerificationState(result: IOnyxVerificationResult): string {
	const file = result.path;
	switch (result.state) {
		case 'not applied': return `Verification: not applied — ${file} has staged changes and none was accepted, so nothing was checked`;
		case 'running': return `Verification: running — waiting for diagnostics of the accepted content of ${file}`;
		case 'timed out': return `Verification: timed out — no fresh diagnostics for ${file} arrived, so nothing is known about what was accepted`;
		case 'stale': return `Verification: stale — ${file} changed after the acceptance; the result was for content that is no longer there`;
		case 'not checked': return `Verification: not checked — no problems were reported for ${file}, but no language service answers for its language, so nothing looked at the accepted content`;
		case 'verified': return result.unreported
			? `Verification: verified — no problems in ${file} before or after the acceptance, and none reported while waiting; a language service answers for the file (${(result.languageService ?? []).join(', ')}), and a clean file that stays clean gets no new report`
			: `Verification: verified — no new problems in ${file} after the acceptance (${result.diff?.after ?? 0} in all${result.diff?.resolved.length ? `, ${result.diff.resolved.length} resolved` : ''})`;
		case 'new problems': {
			const introduced = result.diff?.introduced ?? [];
			const first = introduced[0];
			return `Verification: new problems — ${introduced.length} in ${file} after the acceptance${first ? `, first at line ${first.line}: ${first.message}` : ''}`;
		}
	}
}
