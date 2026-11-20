/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Reasoning models (C4, R-26). A model that thinks before it answers sends
 * its thinking one of two ways: inside `<think>…</think>` in the text, or in
 * a field of its own beside the text. Either way the thinking is not the
 * answer: it is shown as a note, never parsed for a tool call or an edit,
 * and never fed back into the conversation.
 *
 * A reply whose thinking was opened and never closed did not get as far as
 * an answer. It is treated as cut off (B12), whatever the stream said about
 * how it ended.
 */

/** The tags a model's thinking is wrapped in. `<think>` is the common one; a few templates write `<thinking>`. */
const TAGS: readonly { readonly open: string; readonly close: string }[] = [
	{ open: '<think>', close: '</think>' },
	{ open: '<thinking>', close: '</thinking>' },
];

export interface IOnyxReasoningSplit {
	/** What the model said: the text with its thinking taken out. */
	readonly text: string;
	/** What the model thought, in order, blocks separated by a blank line. */
	readonly reasoning: string;
	/** True when thinking was opened and not closed by the end: the reply stopped before its answer. */
	readonly unterminated: boolean;
}

/**
 * Takes model text apart as it arrives. Thinking tags can be split across
 * chunks at any character, so the end of a chunk that could be the start of
 * a tag is held until the next chunk decides it.
 */
export class OnyxReasoningFilter {

	private _buffer = '';
	/** The closing tag being waited for, while inside a block of thinking. */
	private _closing: string | undefined;
	private readonly _blocks: string[] = [];
	private _current = '';
	private _fielded = '';
	/** The blank line a model leaves between its thinking and its answer is neither; it is dropped once. */
	private _trimNext = false;

	/** Takes a chunk; returns the text in it that is the model's answer and can be shown now. */
	push(chunk: string): string {
		this._buffer += chunk;
		let visible = '';
		for (; ;) {
			if (this._closing === undefined) {
				const opened = this._findOpen();
				if (!opened) {
					// No tag here. Everything but a tail that could still become one is answer text.
					const held = heldTail(this._buffer, TAGS.map(tag => tag.open));
					visible += this._answer(this._buffer.slice(0, this._buffer.length - held));
					this._buffer = this._buffer.slice(this._buffer.length - held);
					return visible;
				}
				visible += this._answer(this._buffer.slice(0, opened.index));
				this._buffer = this._buffer.slice(opened.index + opened.tag.open.length);
				this._closing = opened.tag.close;
				this._current = '';
			} else {
				const closedAt = this._buffer.indexOf(this._closing);
				if (closedAt === -1) {
					const held = heldTail(this._buffer, [this._closing]);
					this._current += this._buffer.slice(0, this._buffer.length - held);
					this._buffer = this._buffer.slice(this._buffer.length - held);
					return visible;
				}
				this._current += this._buffer.slice(0, closedAt);
				this._buffer = this._buffer.slice(closedAt + this._closing.length);
				this._blocks.push(this._current.trim());
				this._closing = undefined;
				this._current = '';
				this._trimNext = true;
			}
		}
	}

	/** Adds thinking that arrived in a field of its own. */
	addReasoning(text: string): void {
		this._fielded += text;
	}

	/** Ends the reply. `text` is whatever was still held and turned out to be answer text. */
	finish(): IOnyxReasoningSplit {
		const unterminated = this._closing !== undefined;
		let text = '';
		if (unterminated) {
			this._blocks.push((this._current + this._buffer).trim());
		} else {
			text = this._answer(this._buffer);
		}
		this._buffer = '';
		this._closing = undefined;
		const reasoning = [this._fielded.trim(), ...this._blocks].filter(block => block.length > 0).join('\n\n');
		return { text, reasoning, unterminated };
	}

	/** Answer text, less the whitespace that directly follows a block of thinking. */
	private _answer(text: string): string {
		if (!this._trimNext) {
			return text;
		}
		const trimmed = text.replace(/^\s+/, '');
		if (trimmed) {
			this._trimNext = false;
		}
		return trimmed;
	}

	private _findOpen(): { readonly index: number; readonly tag: typeof TAGS[number] } | undefined {
		let best: { index: number; tag: typeof TAGS[number] } | undefined;
		for (const tag of TAGS) {
			const index = this._buffer.indexOf(tag.open);
			if (index !== -1 && (!best || index < best.index)) {
				best = { index, tag };
			}
		}
		return best;
	}
}

/** How many characters at the end of `text` could be the beginning of one of `tags`. */
function heldTail(text: string, tags: readonly string[]): number {
	const longest = Math.max(...tags.map(tag => tag.length)) - 1;
	for (let length = Math.min(longest, text.length); length > 0; length--) {
		const tail = text.slice(text.length - length);
		if (tags.some(tag => tag.startsWith(tail))) {
			return length;
		}
	}
	return 0;
}

/** A whole reply taken apart at once: what the one-shot parsers (edits, review findings, envelopes) call first. */
export function stripReasoning(text: string): IOnyxReasoningSplit {
	const filter = new OnyxReasoningFilter();
	const visible = filter.push(text);
	const end = filter.finish();
	return { text: visible + end.text, reasoning: end.reasoning, unterminated: end.unterminated };
}
