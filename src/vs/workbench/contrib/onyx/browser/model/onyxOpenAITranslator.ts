/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IOnyxWireMessage, IOnyxWireTool, IOnyxWireToolCall } from '../../../../../platform/onyxRuntime/common/onyxRuntime.js';
import { ChatMessageRole, IChatMessage, IChatResponseToolUsePart } from '../../../chat/common/languageModels.js';

/** The tool shape the chat stack passes in `options.tools` (mirrors `vscode.LanguageModelChatTool`). */
export interface IRequestTool {
	readonly name: string;
	readonly description?: string;
	readonly inputSchema?: object;
}

/**
 * Translates the chat stack's message model to OpenAI chat-completions wire
 * messages. Tool results become `role: 'tool'` messages; assistant tool-use
 * parts become `tool_calls`; thinking parts are dropped (they must not be
 * replayed to OpenAI-compatible endpoints).
 */
export function toWireMessages(messages: readonly IChatMessage[]): IOnyxWireMessage[] {
	const wire: IOnyxWireMessage[] = [];
	for (const message of messages) {
		const role = toWireRole(message.role);
		let text = '';
		const toolCalls: IOnyxWireToolCall[] = [];
		for (const part of message.content) {
			switch (part.type) {
				case 'text':
					text += part.value;
					break;
				case 'tool_use':
					toolCalls.push({
						id: part.toolCallId,
						type: 'function',
						function: { name: part.name, arguments: JSON.stringify(part.parameters ?? {}) },
					});
					break;
				case 'tool_result': {
					// Tool results are standalone `tool` messages keyed by call id;
					// flush them immediately so ordering is preserved.
					const resultText = part.value.map(v => v.type === 'text' ? v.value : '').join('');
					wire.push({ role: 'tool', content: resultText, tool_call_id: part.toolCallId });
					break;
				}
				// thinking / image / data parts are not sent to the endpoint
			}
		}
		if (text || toolCalls.length) {
			wire.push({
				role,
				content: text || null,
				...(toolCalls.length ? { tool_calls: toolCalls } : {}),
			});
		}
	}
	return wire;
}

function toWireRole(role: ChatMessageRole): 'system' | 'user' | 'assistant' {
	switch (role) {
		case ChatMessageRole.System: return 'system';
		case ChatMessageRole.Assistant: return 'assistant';
		default: return 'user';
	}
}

export function toWireTools(tools: readonly IRequestTool[]): IOnyxWireTool[] {
	return tools.map(tool => ({
		type: 'function' as const,
		function: {
			name: tool.name,
			description: tool.description,
			parameters: tool.inputSchema ?? { type: 'object', properties: {} },
		},
	}));
}

/** Accumulates streamed OpenAI `tool_calls` fragments into complete tool-use parts. */
export class ToolCallAccumulator {

	private readonly _calls = new Map<number, { id: string; name: string; args: string }>();
	private _parseFailures = 0;

	get parseFailures(): number {
		return this._parseFailures;
	}

	append(index: number, id: string | undefined, name: string | undefined, argumentsDelta: string | undefined): void {
		let call = this._calls.get(index);
		if (!call) {
			// Name and args accumulate below; initialize empty so the first
			// fragment isn't counted twice.
			call = { id: id ?? `onyx_call_${index}_${Date.now()}`, name: '', args: '' };
			this._calls.set(index, call);
		}
		if (id) {
			call.id = id;
		}
		if (name) {
			call.name += name;
		}
		if (argumentsDelta) {
			call.args += argumentsDelta;
		}
	}

	/** Finalizes all accumulated calls, repairing near-miss JSON from smaller models where possible. */
	complete(): IChatResponseToolUsePart[] {
		const parts: IChatResponseToolUsePart[] = [];
		for (const call of this._calls.values()) {
			if (!call.name) {
				this._parseFailures++;
				continue;
			}
			const parameters = this._parseArguments(call.args);
			if (parameters === undefined) {
				this._parseFailures++;
				continue;
			}
			parts.push({ type: 'tool_use', name: call.name, toolCallId: call.id, parameters });
		}
		this._calls.clear();
		return parts;
	}

	private _parseArguments(raw: string): unknown | undefined {
		const trimmed = raw.trim();
		if (!trimmed) {
			return {};
		}
		for (const candidate of repairCandidates(trimmed)) {
			try {
				return JSON.parse(candidate);
			} catch {
				// try the next repair
			}
		}
		return undefined;
	}
}

/**
 * Yields progressively more aggressive repairs of almost-JSON emitted by small
 * models: fenced code blocks, trailing commas, single-quoted strings, and a
 * truncated object missing its closing braces.
 */
function* repairCandidates(raw: string): Generator<string> {
	yield raw;

	const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
	if (fenced) {
		yield fenced[1];
	}

	const noTrailingCommas = raw.replace(/,\s*([}\]])/g, '$1');
	if (noTrailingCommas !== raw) {
		yield noTrailingCommas;
	}

	const opens = (raw.match(/{/g) ?? []).length;
	const closes = (raw.match(/}/g) ?? []).length;
	if (opens > closes) {
		yield raw + '}'.repeat(opens - closes);
	}
}

/**
 * Cheap token estimate: ~4 characters per token with a small floor per
 * message for role/format overhead. Deliberately conservative — the prompt
 * builder clamps against 85% of the model's context window.
 */
export function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

export function estimateMessageTokens(message: IChatMessage): number {
	let total = 4; // per-message format overhead
	for (const part of message.content) {
		switch (part.type) {
			case 'text':
				total += estimateTokens(part.value);
				break;
			case 'tool_use':
				total += estimateTokens(part.name) + estimateTokens(JSON.stringify(part.parameters ?? {}));
				break;
			case 'tool_result':
				total += part.value.reduce((sum, v) => sum + (v.type === 'text' ? estimateTokens(v.value) : 0), 0);
				break;
			case 'thinking':
				total += estimateTokens(Array.isArray(part.value) ? part.value.join('') : part.value);
				break;
		}
	}
	return total;
}
