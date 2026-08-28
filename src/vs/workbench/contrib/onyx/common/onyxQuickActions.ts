/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** Longest snippet a quick action puts in the prompt; past this the file attachment carries the context. */
export const ONYX_QUICK_ACTION_MAX_SNIPPET = 1600;

/**
 * The prompt for "Fix with Onyx". The diagnostic is the whole point, so it
 * leads; the snippet is evidence. The instruction to make the smallest change
 * matters more with a small model, which will happily rewrite the file.
 */
export function buildFixPrompt(options: { path: string; line: number; diagnostics: readonly string[]; snippet: string }): string {
	return [
		`Fix this problem in ${options.path}:${options.line}.`,
		'',
		'Reported by the language server:',
		...options.diagnostics.map(message => `- ${message}`),
		'',
		'Code around it:',
		'```',
		clip(options.snippet, ONYX_QUICK_ACTION_MAX_SNIPPET),
		'```',
		'',
		'Make the smallest change that fixes it. Explain the cause in one sentence, then apply the edit.',
	].join('\n');
}

/**
 * The prompt for "Explain with Onyx". Explicitly asks for what the code does
 * *and* what it assumes — a plain restatement of the syntax is the failure
 * mode of small models on this task.
 */
export function buildExplainPrompt(options: { path: string; startLine: number; endLine: number; snippet: string }): string {
	const where = options.startLine === options.endLine ? `${options.path}:${options.startLine}` : `${options.path}:${options.startLine}-${options.endLine}`;
	return [
		`Explain this code from ${where}.`,
		'',
		'```',
		clip(options.snippet, ONYX_QUICK_ACTION_MAX_SNIPPET),
		'```',
		'',
		'Cover what it does, what it assumes about its inputs, and anything that would break it. Do not restate it line by line.',
	].join('\n');
}

function clip(text: string, maxChars: number): string {
	return text.length <= maxChars ? text : `${text.slice(0, maxChars)}\n… snippet truncated …`;
}
