/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The private benchmark's task set (L10). Tasks come from two places, the
 * repository's history and the user's own accepted requests, and a set
 * says for each task where it came from and whether it is held out in
 * time: authored after the model was published, so that the model cannot
 * have been trained on it. Everything here is pure; git and the journal
 * are read by the callers.
 *
 * A task set names commits and digests, never content. What a model is
 * shown is read from the repository when a campaign runs, and nothing of
 * it leaves the machine (DEC-10).
 */

import { traceDigest } from './onyxTrace.js';

/** `held-out`: authored after the model was published. `unknown`: the model's publication date is not known. */
export type OnyxHoldout = 'held-out' | 'not-held-out' | 'unknown';

/**
 * Whether a commit is held out for a model: authored on a later day than
 * the day the model was published. The day itself does not count: a
 * publication date says nothing about the hour, and a task is held out
 * only when that is certain. With no publication date, or no authoring
 * date, it is unknown.
 */
export function classifyHoldout(authoredAt: string | undefined, publishedAt: string | undefined): OnyxHoldout {
	if (!authoredAt || !publishedAt) {
		return 'unknown';
	}
	const authored = Date.parse(authoredAt);
	const published = Date.parse(`${publishedAt.slice(0, 10)}T00:00:00Z`);
	if (Number.isNaN(authored) || Number.isNaN(published)) {
		return 'unknown';
	}
	// The whole of the publication day, in the timezone furthest ahead, is taken as "not later".
	return authored >= published + 38 * 3600_000 ? 'held-out' : 'not-held-out';
}

/**
 * The latest publication date among models, as the day that decides what
 * is held out for all of them; undefined when any of them has no date,
 * because then nothing can be said to be held out for the set.
 */
export function latestPublication(dates: readonly (string | undefined)[]): string | undefined {
	if (dates.length === 0 || dates.some(date => !date || Number.isNaN(Date.parse(date)))) {
		return undefined;
	}
	return [...dates as readonly string[]].sort().at(-1)!.slice(0, 10);
}

/**
 * The context-fit rule: a model is not scored on a task it could not read.
 * A single-file task needs the file in the prompt and room to write the
 * changed part of it back; a file is taken to fit when it is at most two
 * fifths of the context, at three characters a token, and never more than
 * the product's own cap for a task's file.
 */
export const ONYX_TASK_FILE_CHAR_CAP = 12_000;
export function maxTaskFileChars(contextTokens: number | undefined): number {
	if (!contextTokens || contextTokens <= 0) {
		return 0;
	}
	return Math.min(ONYX_TASK_FILE_CHAR_CAP, Math.floor(contextTokens * 0.4 * 3));
}
export function taskFitsContext(beforeChars: number, contextTokens: number | undefined): boolean {
	return beforeChars > 0 && beforeChars <= maxTaskFileChars(contextTokens);
}

/** Below this many scored tasks for a model, models are not ranked: the result says there are not enough tasks. */
export const ONYX_MIN_TASKS_TO_RANK = 10;

export type OnyxTaskSource = 'history' | 'request';

export interface IOnyxTaskSetEntry {
	readonly id: string;
	readonly commit: string;
	readonly file: string;
	readonly source: OnyxTaskSource;
	readonly holdout: OnyxHoldout;
	readonly authoredAt?: string;
	readonly beforeChars?: number;
	/** A test file the same commit changed, when it changed exactly one: what an execution-checked score runs (tier 2). */
	readonly testFile?: string;
}

export interface IOnyxTaskCounts {
	readonly total: number;
	readonly bySource: Readonly<Record<OnyxTaskSource, number>>;
	readonly byHoldout: Readonly<Record<OnyxHoldout, number>>;
	readonly withTests: number;
}

/** Task counts by source and by held-out status: what a report states before any score. */
export function countTasks(tasks: readonly IOnyxTaskSetEntry[]): IOnyxTaskCounts {
	const bySource: Record<OnyxTaskSource, number> = { history: 0, request: 0 };
	const byHoldout: Record<OnyxHoldout, number> = { 'held-out': 0, 'not-held-out': 0, unknown: 0 };
	for (const task of tasks) {
		bySource[task.source]++;
		byHoldout[task.holdout]++;
	}
	return { total: tasks.length, bySource, byHoldout, withTests: tasks.filter(task => task.testFile !== undefined).length };
}

/** A digest of a task set: over the ids and the content hashes, never the content. */
export function taskSetHash(tasks: readonly { readonly commit: string; readonly file: string; readonly beforeHash?: string; readonly afterHash?: string }[]): string {
	return traceDigest(tasks.map(task => `${task.commit}:${task.file}:${task.beforeHash ?? ''}:${task.afterHash ?? ''}`).join('\n'));
}

// --- Source 2: the user's own requests ----------------------------------------------------------------------------

/** What a run's journal says about one request, as far as a task needs it. */
export interface IOnyxJournaledRequest {
	readonly runId: string;
	/** The user's request, as typed. */
	readonly request: string | undefined;
	/** The commit the workspace was at when the run started. */
	readonly head: string | undefined;
	/** What the user accepted of the run's proposals: the file, and digests of the lines the accepted hunks added. */
	readonly accepted: readonly { readonly path: string; readonly addedLineDigests: readonly string[] }[];
}

/** What the repository answers about a request (git, read by the caller). */
export interface IOnyxRequestTaskLookup {
	/** Whether a commit is reachable in the repository as it is now. */
	isReachable(commit: string): boolean;
	/**
	 * The first commit after `sinceCommit` in which `path` holds every one
	 * of the lines, by digest; undefined when no commit does.
	 */
	firstCommitContaining(path: string, addedLineDigests: readonly string[], sinceCommit: string): { readonly commit: string; readonly authoredAt: string } | undefined;
}

export type OnyxRequestSkip = 'no-request-text' | 'nothing-accepted' | 'base-unreachable' | 'never-committed';

export type OnyxRequestTaskOutcome =
	| { readonly kind: 'task'; readonly task: IOnyxRequestTask }
	| { readonly kind: 'skipped'; readonly runId: string; readonly reason: OnyxRequestSkip };

/**
 * A task made of a request: the instruction is what the user asked for,
 * the base is the commit the workspace was at, and the reference is the
 * file at the first commit that holds what the user accepted.
 */
export interface IOnyxRequestTask {
	readonly id: string;
	readonly runId: string;
	readonly instruction: string;
	readonly base: string;
	readonly commit: string;
	readonly file: string;
	readonly authoredAt: string;
	readonly source: 'request';
}

/**
 * Turns one journaled request into a task, or says why not. Only a request
 * whose proposal was accepted and whose accepted lines were later
 * committed becomes one: that is the user saying twice that the change was
 * right. A request that touched several files gives a task for the first
 * of them that was committed.
 */
export function deriveRequestTask(request: IOnyxJournaledRequest, lookup: IOnyxRequestTaskLookup): OnyxRequestTaskOutcome {
	const skip = (reason: OnyxRequestSkip): OnyxRequestTaskOutcome => ({ kind: 'skipped', runId: request.runId, reason });
	if (!request.request || !request.request.trim()) {
		return skip('no-request-text');
	}
	const accepted = request.accepted.filter(entry => entry.addedLineDigests.length > 0);
	if (accepted.length === 0) {
		return skip('nothing-accepted');
	}
	if (!request.head || !lookup.isReachable(request.head)) {
		return skip('base-unreachable');
	}
	for (const entry of accepted) {
		const found = lookup.firstCommitContaining(entry.path, entry.addedLineDigests, request.head);
		if (found) {
			return { kind: 'task', task: { id: `request-${request.runId}`, runId: request.runId, instruction: request.request.trim(), base: request.head, commit: found.commit, file: entry.path, authoredAt: found.authoredAt, source: 'request' } };
		}
	}
	return skip('never-committed');
}

export interface IOnyxRequestTaskSummary {
	readonly tasks: readonly IOnyxRequestTask[];
	readonly requests: number;
	readonly skipped: Readonly<Record<OnyxRequestSkip, number>>;
}

/** Every request of a journal, as tasks and as counted skips. With the workspace's opt-in absent there are no tasks and nothing is read. */
export function deriveRequestTasks(optedIn: boolean, requests: readonly IOnyxJournaledRequest[], lookup: IOnyxRequestTaskLookup): IOnyxRequestTaskSummary {
	const skipped: Record<OnyxRequestSkip, number> = { 'no-request-text': 0, 'nothing-accepted': 0, 'base-unreachable': 0, 'never-committed': 0 };
	if (!optedIn) {
		return { tasks: [], requests: 0, skipped };
	}
	const tasks: IOnyxRequestTask[] = [];
	for (const request of requests) {
		const outcome = deriveRequestTask(request, lookup);
		if (outcome.kind === 'task') {
			tasks.push(outcome.task);
		} else {
			skipped[outcome.reason]++;
		}
	}
	return { tasks, requests: requests.length, skipped };
}

/** The digests an acceptance records for the lines it added: one a non-empty line, of the line trimmed. */
export function addedLineDigests(addedLines: readonly string[]): string[] {
	return addedLines.map(line => line.trim()).filter(line => line.length > 0).map(traceDigest);
}

/** Whether a file's content holds every one of the lines, by digest, at least as often as they were added. */
export function contentHoldsLines(content: string, digests: readonly string[]): boolean {
	const present = new Map<string, number>();
	for (const line of content.split('\n')) {
		const trimmed = line.trim();
		if (trimmed) {
			const digest = traceDigest(trimmed);
			present.set(digest, (present.get(digest) ?? 0) + 1);
		}
	}
	const wanted = new Map<string, number>();
	for (const digest of digests) {
		wanted.set(digest, (wanted.get(digest) ?? 0) + 1);
	}
	for (const [digest, count] of wanted) {
		if ((present.get(digest) ?? 0) < count) {
			return false;
		}
	}
	return digests.length > 0;
}

/** The most characters of a commit message a task's instruction carries. */
export const ONYX_TASK_INSTRUCTION_CHARS = 1500;

/**
 * A history task's instruction: the commit's message, subject and body,
 * without its trailers (sign-offs, co-authors, review links) and without
 * the hashes of other commits, cut to a bounded length. The subject alone
 * is often a label; the body is where an author says what the change is.
 */
export function taskInstruction(message: string): string {
	const kept = message.replace(/\r\n/g, '\n').split('\n').filter(line => !/^\s*(Signed-off-by|Co-authored-by|Reviewed-by|Acked-by|Cc|Change-Id|Fixes|Refs?|Closes|Resolves|See also)\s*:/i.test(line) && !/^\s*\(cherry picked from commit [0-9a-f]+\)\s*$/i.test(line));
	const text = kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
	return text.length > ONYX_TASK_INSTRUCTION_CHARS ? `${text.slice(0, ONYX_TASK_INSTRUCTION_CHARS).trimEnd()}…` : text;
}

/**
 * What a run's journal says about its request (source 2): the request as
 * the user typed it, the commit the workspace was at, and the lines each
 * acceptance added, by digest. Journals written before acceptances carried
 * digests give a request with nothing accepted.
 */
export function journaledRequest(runId: string, events: readonly { readonly kind: string; readonly data?: unknown }[]): IOnyxJournaledRequest {
	let request: string | undefined;
	let head: string | undefined;
	const accepted = new Map<string, string[]>();
	const record = (value: unknown): Record<string, unknown> | undefined => typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
	for (const event of events) {
		const data = record(event.data);
		if (!data) {
			continue;
		}
		if (event.kind === 'promptSnapshot') {
			const meta = record(data.resumeMeta);
			if (meta && typeof meta.head === 'string' && head === undefined) {
				head = meta.head;
			}
			if (request === undefined && Array.isArray(data.messages)) {
				// The last user message of the first snapshot is the request, as the resume digest reads it.
				const users = data.messages.map(record).filter(message => message?.role === 1);
				const parts = users.at(-1)?.content;
				if (Array.isArray(parts)) {
					request = parts.map(record).filter(part => part?.type === 'text').map(part => typeof part?.value === 'string' ? part.value : '').join('');
				}
			}
		}
		if (event.kind === 'acceptance' && typeof data.path === 'string' && Array.isArray(data.added)) {
			const digests = data.added.filter((digest): digest is string => typeof digest === 'string');
			accepted.set(data.path, [...(accepted.get(data.path) ?? []), ...digests]);
		}
	}
	return { runId, request, head, accepted: [...accepted].map(([path, addedLineDigests]) => ({ path, addedLineDigests })) };
}
