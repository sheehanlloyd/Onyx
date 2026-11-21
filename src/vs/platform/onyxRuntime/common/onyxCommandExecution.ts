/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The pure half of command execution (B5): the documented caps on what one
 * command's output may occupy, the capture that keeps the start and the end
 * of an output of any length, and the environment a command is started
 * with. The process half is `node/onyxCommandRunner.ts`.
 */

/** What one command's output may occupy on its way to the caller (I-13). `docs/SUPPORT.md` states the same numbers. */
export const ONYX_COMMAND_OUTPUT_LIMITS = {
	/** The most text one output event carries. */
	eventChars: 8 * 1024,
	/** The most text streamed as events for one command. Past it, output is counted and discarded. */
	streamedChars: 256 * 1024,
	/** The most text in a result's `output`: the start and the end of what the command printed. */
	resultChars: 200_000,
} as const;

/** How much of a captured output is its start; the rest of the cap, less the elision note, is its end. */
const CAPTURE_HEAD_SHARE = 0.5;
/** Room kept for the line that says how much was left out. */
const CAPTURE_NOTE_CHARS = 120;

/**
 * Keeps the first and the last part of a text that arrives in pieces, in
 * bounded memory whatever its length. A failing build says what went wrong
 * at the end and what it was doing at the start; the middle is what goes.
 */
export class OnyxOutputCapture {

	private readonly _headChars: number;
	private readonly _tailChars: number;
	private _head = '';
	private _tail = '';
	private _total = 0;

	constructor(maxChars: number = ONYX_COMMAND_OUTPUT_LIMITS.resultChars) {
		const room = Math.max(0, maxChars - CAPTURE_NOTE_CHARS);
		this._headChars = Math.floor(room * CAPTURE_HEAD_SHARE);
		this._tailChars = room - this._headChars;
	}

	append(text: string): void {
		this._total += text.length;
		let rest = text;
		if (this._head.length < this._headChars) {
			const taken = rest.slice(0, this._headChars - this._head.length);
			this._head += taken;
			rest = rest.slice(taken.length);
		}
		if (rest.length > 0 && this._tailChars > 0) {
			// Only the last `_tailChars` characters can ever be shown; nothing more is kept.
			this._tail = rest.length >= this._tailChars ? rest.slice(rest.length - this._tailChars) : (this._tail + rest).slice(-this._tailChars);
		}
	}

	/** Everything that was appended, in characters, kept or not. */
	get totalChars(): number {
		return this._total;
	}

	get truncated(): boolean {
		return this._total > this._head.length + this._tail.length;
	}

	/** What is held right now. Never more than the cap, for any input. */
	get retainedChars(): number {
		return this._head.length + this._tail.length;
	}

	text(): string {
		if (!this.truncated) {
			return this._head + this._tail;
		}
		const elided = this._total - this._head.length - this._tail.length;
		return `${this._head}\n[… ${elided} characters of output left out …]\n${this._tail}`;
	}
}

/**
 * Splits one piece of output into events no larger than the per-event cap,
 * and stops once the per-command stream cap is used up. Returns the pieces
 * to send; `streamedChars` is how much has gone out so far.
 */
export class OnyxOutputStreamBudget {

	private _streamed = 0;

	constructor(private readonly _limits: { readonly eventChars: number; readonly streamedChars: number } = ONYX_COMMAND_OUTPUT_LIMITS) { }

	get streamedChars(): number {
		return this._streamed;
	}

	take(text: string): string[] {
		const pieces: string[] = [];
		let offset = 0;
		while (offset < text.length && this._streamed < this._limits.streamedChars) {
			const size = Math.min(this._limits.eventChars, this._limits.streamedChars - this._streamed, text.length - offset);
			pieces.push(text.slice(offset, offset + size));
			offset += size;
			this._streamed += size;
		}
		return pieces;
	}
}

/**
 * Environment variables whose names match are withheld from a command unless
 * the user turned `onyx.terminal.passEnvironment` on. This is defense in
 * depth and nothing more: a secret under another name, in a file, or in a
 * credential helper is not touched by it.
 */
export const ONYX_WITHHELD_ENVIRONMENT_NAME = /(TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL)/i;

export interface IOnyxCommandEnvironment {
	readonly environment: Record<string, string>;
	/** Names that were left out, sorted. Names only; the values are never recorded. */
	readonly withheld: readonly string[];
}

/** The environment a command is started with: the given one, less the variables whose names look like secrets. */
export function commandEnvironment(environment: Readonly<Record<string, string | undefined>>, passEnvironment: boolean): IOnyxCommandEnvironment {
	const kept: Record<string, string> = {};
	const withheld: string[] = [];
	for (const name of Object.keys(environment)) {
		const value = environment[name];
		if (value === undefined) {
			continue;
		}
		if (!passEnvironment && ONYX_WITHHELD_ENVIRONMENT_NAME.test(name)) {
			withheld.push(name);
		} else {
			kept[name] = value;
		}
	}
	return { environment: kept, withheld: withheld.sort() };
}
