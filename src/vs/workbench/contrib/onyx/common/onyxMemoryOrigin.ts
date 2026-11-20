/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Where the text of a note came from (B3, I-14). A model that asks to store
 * a note may be repeating the user, repeating something a tool returned (a
 * file, a command's output, a web page), or writing it itself. The user is
 * shown which before the note can reach any later prompt, because text that
 * arrived in a tool result is the injection path this guards.
 *
 * Pure: the caller supplies what the run has seen.
 */

export type OnyxNoteOrigin =
	| { readonly kind: 'user' }
	/** The text, or a run of its words, is in what the named tool returned during this run. */
	| { readonly kind: 'tool-result'; readonly tool: string }
	| { readonly kind: 'model' };

export interface IOnyxRunText {
	readonly tool: string;
	readonly text: string;
}

/** How many consecutive words of a note must appear in a source for the note to count as coming from it. */
const SHARED_WORD_RUN = 5;

function normalize(text: string): string {
	return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Whether `source` contains the whole note, or any run of five of its words. */
function sharesText(note: string, source: string): boolean {
	const normalizedNote = normalize(note);
	const normalizedSource = normalize(source);
	if (!normalizedNote || !normalizedSource) {
		return false;
	}
	if (normalizedSource.includes(normalizedNote)) {
		return true;
	}
	const words = normalizedNote.split(' ');
	for (let index = 0; index + SHARED_WORD_RUN <= words.length; index++) {
		if (normalizedSource.includes(words.slice(index, index + SHARED_WORD_RUN).join(' '))) {
			return true;
		}
	}
	return false;
}

/**
 * A tool result outranks the user's request: when the text is in both, the
 * warning that it also arrived from a tool is the one worth showing.
 */
export function describeNoteOrigin(note: string, userRequest: string, toolResults: readonly IOnyxRunText[]): OnyxNoteOrigin {
	for (let index = toolResults.length - 1; index >= 0; index--) {
		if (sharesText(note, toolResults[index].text)) {
			return { kind: 'tool-result', tool: toolResults[index].tool };
		}
	}
	if (sharesText(note, userRequest)) {
		return { kind: 'user' };
	}
	return { kind: 'model' };
}
