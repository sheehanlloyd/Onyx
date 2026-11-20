/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * What the terminal service keeps of a command's output while it runs (B5,
 * I-13). The run timeline shows the start of the output in a few short
 * notes; the model gets the start and the end when the command finishes.
 * Nothing else is held: a command that prints for ten minutes costs the
 * window no more than one that prints a line.
 */
export const ONYX_TERMINAL_OUTPUT_LIMITS = {
	/** Characters in one timeline note of live output. */
	timelineChunkChars: 800,
	/** Timeline notes of live output per command. */
	timelineChunks: 6,
	/** The most output text the terminal service holds for one command while it runs. */
	retainedChars: 800,
	/** The most output text returned to the model (and so to the journal) for one command. */
	modelChars: 12_000,
} as const;

/**
 * Turns output events of any size into at most `timelineChunks` notes of
 * `timelineChunkChars`, holding at most one unfinished note. Once the notes
 * are used up, further output is counted and dropped.
 */
export class OnyxTimelineOutput {

	private _pending = '';
	private _posted = 0;
	private _seen = 0;

	/** Takes output as it arrives; returns the notes that are now complete. */
	push(text: string): string[] {
		this._seen += text.length;
		const chunks: string[] = [];
		let offset = 0;
		while (offset < text.length && this._posted < ONYX_TERMINAL_OUTPUT_LIMITS.timelineChunks) {
			const taken = text.slice(offset, offset + ONYX_TERMINAL_OUTPUT_LIMITS.timelineChunkChars - this._pending.length);
			offset += taken.length;
			this._pending += taken;
			if (this._pending.length >= ONYX_TERMINAL_OUTPUT_LIMITS.timelineChunkChars) {
				chunks.push(this._pending);
				this._pending = '';
				this._posted++;
			}
		}
		return chunks;
	}

	/** What is held right now. */
	get retainedChars(): number {
		return this._pending.length;
	}

	/** Everything that arrived, in characters, shown or not. */
	get seenChars(): number {
		return this._seen;
	}
}
