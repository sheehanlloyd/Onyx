/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Resumable runs: the pure logic that decides which journaled runs can be
 * picked up again, distills a run's journal into a resume briefing, and
 * words every "the world moved on" condition — a vanished model, a changed
 * workspace, a half-reviewed edit set — as an explicit message. A resume is
 * never silent about what it cannot restore.
 */

import { IOnyxRunEvent, IOnyxRunSummary } from './onyxTypes.js';

/**
 * Runs worth offering to resume: anything that never completed. A run still
 * marked `running` in the journal is a crash — nothing updates it once the
 * window is gone — and `failed`/`cancelled` runs are interruptions by
 * definition. Newest first, capped so the picker stays a picker.
 */
export function findResumableRuns(summaries: readonly IOnyxRunSummary[], limit: number): IOnyxRunSummary[] {
	return summaries
		.filter(summary => summary.status !== 'completed')
		.slice(0, limit);
}

interface ISnapshotMessagePart { readonly type: string; readonly value?: string; readonly name?: string }
interface ISnapshotMessage { readonly role: number; readonly content: readonly ISnapshotMessagePart[] }
interface IPromptSnapshot { readonly turn?: number; readonly model?: string; readonly messages?: readonly ISnapshotMessage[] }

export interface IOnyxResumeDigest {
	/** The user's original request, as sent to the model. */
	readonly originalRequest: string;
	/** What happened, one line per step worth retelling. */
	readonly progress: readonly string[];
	/** Whether the journal was truncated — the digest may then be missing detail. */
	readonly truncated: boolean;
}

const MAX_PROGRESS_LINES = 20;
const MAX_LINE_CHARS = 200;

/** Distills a run's journal into what a fresh request needs to continue the work. */
export function buildResumeDigest(events: readonly IOnyxRunEvent[]): IOnyxResumeDigest {
	let originalRequest = '';
	const progress: string[] = [];
	let truncated = false;

	for (const event of events) {
		const data = event.data as Record<string, unknown> | undefined;
		if (!data) {
			continue;
		}
		if (event.kind === 'promptSnapshot' && !originalRequest) {
			const snapshot = data as IPromptSnapshot;
			// The last user message of the first snapshot is the original request.
			const userMessages = (snapshot.messages ?? []).filter(message => message.role === 1);
			const last = userMessages[userMessages.length - 1];
			originalRequest = last?.content.filter(part => part.type === 'text').map(part => part.value ?? '').join('') ?? '';
			if (originalRequest.includes('[truncated]')) {
				truncated = true;
			}
		}
		if (event.kind === 'toolCall') {
			progress.push(`called tool ${String(data.label ?? '?')}${data.reason ? ` (${clip(String(data.reason))})` : ''}`);
		}
		if (event.kind === 'toolResult' && data.ok === false) {
			progress.push(`tool ${String(data.label ?? '?')} failed${data.reason ? `: ${clip(String(data.reason))}` : ''}`);
		}
		if (event.kind === 'note' && typeof data.label === 'string' && /staged|Staged|Running:|Exited|allowed|denied/i.test(data.label)) {
			progress.push(clip(`${data.label}${data.reason ? ` — ${clip(String(data.reason))}` : ''}`));
		}
	}
	if (progress.length > MAX_PROGRESS_LINES) {
		progress.splice(0, progress.length - MAX_PROGRESS_LINES);
		truncated = true;
	}
	return { originalRequest: clipTo(originalRequest, 2000), progress, truncated };
}

function clip(text: string): string {
	return clipTo(text, MAX_LINE_CHARS);
}

function clipTo(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max)}…` : text;
}

export interface IOnyxResumeConditions {
	/** The model that served the run is still available. */
	readonly modelAvailable: boolean;
	readonly originalModelKey: string;
	/** Git HEAD at run time vs now; undefined when either is unknown. */
	readonly headMoved: boolean | undefined;
	/** Staged-but-unreviewed edits restored from the interrupted session. */
	readonly pendingEditFiles: number;
}

/**
 * The designed messages for everything a resume cannot silently restore.
 * Empty means a clean resume; each entry is shown to the user before the
 * resumed request is sent.
 */
export function resumeConditionMessages(conditions: IOnyxResumeConditions): string[] {
	const messages: string[] = [];
	if (!conditions.modelAvailable) {
		messages.push(`The model that ran this (${conditions.originalModelKey}) is no longer available — the resumed run will be routed to the best model that is.`);
	}
	if (conditions.headMoved === true) {
		messages.push('The workspace has changed since this run (git HEAD moved). The agent will re-read the current state rather than trusting what it saw before.');
	}
	if (conditions.pendingEditFiles > 0) {
		messages.push(`${conditions.pendingEditFiles} file(s) of proposed edits from the interrupted run are still staged in Onyx Changes — review them there; the resumed run knows about them.`);
	}
	return messages;
}

/** The chat request that continues an interrupted run, digest and caveats included. */
export function buildResumePrompt(title: string, digest: IOnyxResumeDigest, conditionMessages: readonly string[]): string {
	const parts = [
		`Resume an interrupted task. The original request was:\n${digest.originalRequest || title}`,
	];
	if (digest.progress.length > 0) {
		parts.push(`Progress before the interruption:\n${digest.progress.map(line => `- ${line}`).join('\n')}`);
	}
	if (digest.truncated) {
		parts.push('(The interruption record is incomplete; verify earlier steps before repeating them.)');
	}
	if (conditionMessages.length > 0) {
		parts.push(`Changed since then:\n${conditionMessages.map(message => `- ${message}`).join('\n')}`);
	}
	parts.push('Continue from where it stopped. Do not redo work that already succeeded; verify instead.');
	return parts.join('\n\n');
}
