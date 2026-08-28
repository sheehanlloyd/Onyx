/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IOnyxRequestRecord, IOnyxRunEvent } from './onyxTypes.js';

/**
 * Structural diff of two journaled runs — the "why did this one go wrong?"
 * tool. Runs are reduced to comparable digests (routing, then per-turn model,
 * tool schema, new messages and tool activity, then the outcome), aligned by
 * turn number, and unchanged stretches are elided so the differences carry
 * the whole view. Pure: the inspector renders the result, nothing here does.
 */

/** One aligned row of the diff: a label and the two runs' values for it. */
export interface IOnyxDiffRow {
	readonly label: string;
	readonly left: string | undefined;
	readonly right: string | undefined;
	readonly changed: boolean;
}

export type IOnyxRunDiffSection =
	| { readonly kind: 'meta'; readonly rows: readonly IOnyxDiffRow[] }
	| { readonly kind: 'turn'; readonly turn: number; readonly changed: boolean; readonly rows: readonly IOnyxDiffRow[] }
	| { readonly kind: 'elision'; readonly turns: number }
	| { readonly kind: 'outcome'; readonly rows: readonly IOnyxDiffRow[] };

interface ITurnDigest {
	readonly turn: number;
	readonly model: string;
	readonly tools: string;
	/** Messages this turn added over the previous one — the marginal prompt. */
	readonly newMessages: string;
	readonly toolActivity: string;
}

interface IRunDigest {
	readonly title: string;
	readonly modelKey: string;
	readonly task: string;
	readonly route: string;
	readonly turns: readonly ITurnDigest[];
	readonly outcome: string;
	readonly notes: string;
}

interface ISnapshotMessage {
	readonly role?: number;
	readonly content?: readonly { readonly type?: string; readonly value?: string; readonly name?: string }[];
}

function messageText(message: ISnapshotMessage): string {
	return (message.content ?? [])
		.map(part => part.type === 'tool_use' ? `⚙ ${part.name ?? 'tool'}` : part.value ?? `[${part.type}]`)
		.join('\n');
}

function digestRun(record: IOnyxRequestRecord): IRunDigest {
	const events = record.events;
	const data = (event: IOnyxRunEvent) => event.data as { kind?: string; label?: string; reason?: string; ok?: boolean; status?: string; turn?: number; model?: string; tools?: string[]; messages?: ISnapshotMessage[] } | undefined;

	const route = events
		.filter(event => event.kind === 'note' && data(event)?.kind === 'route')
		.map(event => `${data(event)?.label ?? ''}${data(event)?.reason ? ` — ${data(event)?.reason}` : ''}`)
		.join('; ');

	const turns: ITurnDigest[] = [];
	let previousMessageCount = 0;
	// Tool activity between one snapshot and the next belongs to that snapshot's turn.
	const snapshotIndexes = events.map((event, index) => event.kind === 'promptSnapshot' ? index : -1).filter(index => index >= 0);
	snapshotIndexes.forEach((eventIndex, turnIndex) => {
		const snapshot = data(events[eventIndex]);
		const until = snapshotIndexes[turnIndex + 1] ?? events.length;
		const activity = events.slice(eventIndex, until)
			.filter(event => event.kind === 'toolCall' || event.kind === 'toolResult')
			.map(event => event.kind === 'toolCall' ? `→ ${data(event)?.label}` : `← ${data(event)?.label}${data(event)?.ok === false ? ' ✗' : ''}`)
			.join('\n');
		const messages = snapshot?.messages ?? [];
		const fresh = messages.slice(previousMessageCount).map(messageText).join('\n---\n');
		previousMessageCount = messages.length;
		turns.push({
			turn: snapshot?.turn ?? turnIndex + 1,
			model: snapshot?.model ?? '?',
			tools: (snapshot?.tools ?? []).join(', '),
			newMessages: fresh,
			toolActivity: activity,
		});
	});

	const outcome = events.filter(event => event.kind === 'outcome').map(event => data(event)?.status ?? '?').join(', ');
	const notes = events
		.filter(event => event.kind === 'note' && data(event)?.kind !== 'route')
		.map(event => `${data(event)?.label ?? ''}${data(event)?.ok === false ? ' ✗' : ''}`)
		.join('\n');

	return { title: record.title, modelKey: record.modelKey, task: record.task, route, turns, outcome, notes };
}

function row(label: string, left: string | undefined, right: string | undefined): IOnyxDiffRow {
	return { label, left, right, changed: (left ?? '') !== (right ?? '') };
}

/**
 * Diffs two runs into aligned sections. Turns are aligned by index; a stretch
 * of two or more identical turns collapses into one elision marker so long
 * agent runs stay readable.
 */
export function diffRuns(left: IOnyxRequestRecord, right: IOnyxRequestRecord): IOnyxRunDiffSection[] {
	const a = digestRun(left);
	const b = digestRun(right);
	const sections: IOnyxRunDiffSection[] = [];

	sections.push({
		kind: 'meta',
		rows: [
			row('request', a.title, b.title),
			row('task', a.task, b.task),
			row('routing', a.route, b.route),
		],
	});

	const turnCount = Math.max(a.turns.length, b.turns.length);
	let identicalStreak: { kind: 'turn'; turn: number; changed: boolean; rows: readonly IOnyxDiffRow[] }[] = [];
	const flushStreak = () => {
		// One identical turn is cheaper to show than an elision marker.
		if (identicalStreak.length >= 2) {
			sections.push({ kind: 'elision', turns: identicalStreak.length });
		} else {
			sections.push(...identicalStreak);
		}
		identicalStreak = [];
	};
	for (let index = 0; index < turnCount; index++) {
		const turnA = a.turns[index];
		const turnB = b.turns[index];
		const rows = [
			row('model', turnA?.model, turnB?.model),
			row('tools', turnA?.tools, turnB?.tools),
			row('new messages', turnA?.newMessages, turnB?.newMessages),
			row('tool activity', turnA?.toolActivity, turnB?.toolActivity),
		].filter(item => (item.left ?? '') !== '' || (item.right ?? '') !== '');
		const changed = rows.some(item => item.changed);
		const section = { kind: 'turn' as const, turn: index + 1, changed, rows };
		if (changed) {
			flushStreak();
			sections.push(section);
		} else {
			identicalStreak.push(section);
		}
	}
	flushStreak();

	sections.push({
		kind: 'outcome',
		rows: [
			row('outcome', a.outcome, b.outcome),
			row('notes', a.notes, b.notes),
		],
	});

	return sections;
}
