/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Deterministic context compression for small models. Nothing here calls a
 * model: long text is elided head-and-tail so a 7B model's context window is
 * spent on the most informative parts (starts carry signatures and intent,
 * ends carry results and errors), and the elision is explicit in the text so
 * the model knows content was dropped.
 */

/** Share of the kept budget given to the head of the text; the rest goes to the tail. */
const HEAD_SHARE = 0.7;

/**
 * Caps `text` at roughly `maxChars` by keeping the head and tail and marking
 * the elided middle. Cuts on line boundaries where possible so code stays
 * readable. Returns the input unchanged when it already fits.
 */
export function elideMiddle(text: string, maxChars: number): string {
	if (text.length <= maxChars || maxChars <= 0) {
		return text;
	}
	const headBudget = Math.floor(maxChars * HEAD_SHARE);
	const tailBudget = maxChars - headBudget;

	let headEnd = text.lastIndexOf('\n', headBudget);
	if (headEnd < headBudget / 2) {
		headEnd = headBudget; // no usable newline: cut mid-line rather than dropping most of the budget
	}
	let tailStart = text.indexOf('\n', text.length - tailBudget);
	if (tailStart === -1 || tailStart > text.length - tailBudget / 2) {
		tailStart = text.length - tailBudget;
	}

	const elided = tailStart - headEnd;
	return `${text.slice(0, headEnd)}\n[… ${elided} characters elided …]\n${text.slice(tailStart + 1)}`;
}

/**
 * Budget for one tool result fed back into the conversation, by prompt style.
 * Small models drown in long tool output; large ones can afford more of it.
 */
export function toolResultBudget(promptStyle: 'compact' | 'full'): number {
	return promptStyle === 'compact' ? 4_000 : 16_000;
}

/**
 * Budget for one history message when rebuilding the conversation. Compact
 * models get aggressively shortened turns; full models keep most of them.
 */
export function historyMessageBudget(promptStyle: 'compact' | 'full'): number {
	return promptStyle === 'compact' ? 2_000 : 8_000;
}
