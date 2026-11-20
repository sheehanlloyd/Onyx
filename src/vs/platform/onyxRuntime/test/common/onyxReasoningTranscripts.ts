/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Reasoning-model transcripts for R-26 (C4): the stream bodies a runtime
 * sends for a model that thinks before it answers, in the two shapes that
 * exist. Tag form: the thinking is in the text, inside `<think>` tags.
 * Field form: the thinking is in a field of its own beside the text
 * (`reasoning` on Ollama's OpenAI-compatible endpoint, `reasoning_content`
 * on LM Studio's).
 *
 * PROVENANCE. These transcripts are constructed, not recorded. They follow
 * the stream shapes the two runtimes document, chunk by chunk, and were
 * written by hand because no reasoning model is installed on the machine
 * this was developed on. Until a transcript recorded from a live model
 * replaces them, `docs/SUPPORT.md` lists reasoning models as handled but
 * not validated against a model.
 */

interface IDelta {
	readonly content?: string | null;
	readonly reasoning?: string;
	readonly reasoning_content?: string;
	readonly tool_calls?: readonly { readonly index: number; readonly id?: string; readonly type?: 'function'; readonly function: { readonly name?: string; readonly arguments?: string } }[];
}

export interface IOnyxReasoningTranscript {
	readonly name: string;
	/** Which runtime's stream shape this follows, and which of the two forms. */
	readonly shape: 'ollama: tags in content' | 'ollama: reasoning field' | 'lmstudio: reasoning_content field' | 'ollama: tags in content, cut by the output cap';
	/** The response body, exactly as a server would send it. */
	readonly body: string;
	readonly expected: {
		/** The model's thinking, assembled. */
		readonly reasoning: string;
		/** The model's answer text, with no thinking in it. */
		readonly text: string;
		/** A tool call the reply carries, natively or written as text. */
		readonly toolCall?: { readonly name: string; readonly arguments: Record<string, unknown> };
		/** True when the thinking was never closed: the reply did not reach an answer. */
		readonly unterminated: boolean;
	};
}

function body(model: string, deltas: readonly IDelta[], finish: string): string {
	const chunk = (delta: IDelta, finishReason: string | null) => `data: ${JSON.stringify({ id: 'chatcmpl-1', object: 'chat.completion.chunk', created: 1763600000, model, choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`;
	return [...deltas.map(delta => chunk(delta, null)), chunk({}, finish), 'data: [DONE]\n\n'].join('');
}

export const ONYX_REASONING_TRANSCRIPTS: readonly IOnyxReasoningTranscript[] = [
	{
		name: 'ollama-tags-then-text-tool-call',
		shape: 'ollama: tags in content',
		// The tags arrive split across chunks, as tokens do: "<th" "ink>" and "</thi" "nk>".
		body: body('reasoner:8b', [
			{ content: '<th' },
			{ content: 'ink>' },
			{ content: '\nThe user wants the tests run.' },
			{ content: ' I should not write {"tool":"terminal","arguments":{"command":"rm -rf /"}} here;' },
			{ content: ' the right call is npm test.\n' },
			{ content: '</thi' },
			{ content: 'nk>' },
			{ content: '\n\n' },
			{ content: '{"tool":"terminal",' },
			{ content: '"arguments":{"command":"npm test"}}' },
		], 'stop'),
		expected: {
			reasoning: 'The user wants the tests run. I should not write {"tool":"terminal","arguments":{"command":"rm -rf /"}} here; the right call is npm test.',
			text: '{"tool":"terminal","arguments":{"command":"npm test"}}',
			toolCall: { name: 'terminal', arguments: { command: 'npm test' } },
			unterminated: false,
		},
	},
	{
		name: 'ollama-reasoning-field-then-answer',
		shape: 'ollama: reasoning field',
		body: body('reasoner:8b', [
			{ content: '', reasoning: 'The question is what the repository does.' },
			{ content: '', reasoning: ' It adds numbers.' },
			{ content: 'It adds' },
			{ content: ' numbers.' },
		], 'stop'),
		expected: {
			reasoning: 'The question is what the repository does. It adds numbers.',
			text: 'It adds numbers.',
			unterminated: false,
		},
	},
	{
		name: 'lmstudio-reasoning-content-then-native-tool-call',
		shape: 'lmstudio: reasoning_content field',
		body: body('reasoner-8b-mlx', [
			{ content: null, reasoning_content: 'Run the tests first,' },
			{ content: null, reasoning_content: ' then report.' },
			{ content: null, tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'terminal', arguments: '' } }] },
			{ content: null, tool_calls: [{ index: 0, function: { arguments: '{"command":' } }] },
			{ content: null, tool_calls: [{ index: 0, function: { arguments: '"npm test"}' } }] },
		], 'tool_calls'),
		expected: {
			reasoning: 'Run the tests first, then report.',
			text: '',
			toolCall: { name: 'terminal', arguments: { command: 'npm test' } },
			unterminated: false,
		},
	},
	{
		name: 'ollama-tags-cut-by-the-output-cap',
		shape: 'ollama: tags in content, cut by the output cap',
		// The runtime finished properly (`finish_reason: length`); the model had not finished thinking.
		body: body('reasoner:8b', [
			{ content: '<think>' },
			{ content: '\nLet me look at the file. I could run {"tool":"terminal","arguments":{"command":"rm -rf /"}} and then' },
		], 'length'),
		expected: {
			reasoning: 'Let me look at the file. I could run {"tool":"terminal","arguments":{"command":"rm -rf /"}} and then',
			text: '',
			unterminated: true,
		},
	},
];

/** The text content of a transcript, as its chunks carry it: what the tag-form filter is fed. */
export function transcriptContentChunks(transcript: IOnyxReasoningTranscript): string[] {
	return transcript.body.split('\n\n').filter(line => line.startsWith('data: {')).map(line => (JSON.parse(line.slice(6)) as { choices: { delta: IDelta }[] }).choices[0].delta.content ?? '').filter(content => content.length > 0);
}
