/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { stripReasoning } from './onyxReasoning.js';

/**
 * Grammar-constrained tool calling for small models. A model that keeps
 * mangling the tool_calls channel can still emit valid JSON when the runtime
 * enforces a schema (OpenAI `response_format: json_schema` — GBNF underneath
 * on llama.cpp/Ollama). The envelope forces every turn into one of exactly
 * two shapes — call a tool, or give the final answer — so a constrained turn
 * cannot be malformed, only wrong. Pure: schema building and parsing here,
 * the agent loop decides when to engage it.
 */

export interface IOnyxEnvelopeTool {
	readonly name: string;
	readonly description?: string;
	readonly inputSchema?: object;
}

/**
 * OpenAI `response_format` payload constraining a turn to the tool/answer
 * envelope. With `anchoredEdit` (L7) the envelope has a third action,
 * `edit`, whose arguments follow that schema: the anchors and the path are
 * enumerated, so a runtime that enforces the schema cannot produce one that
 * is not on the list.
 */
export function buildToolEnvelopeFormat(tools: readonly IOnyxEnvelopeTool[], anchoredEdit?: object): unknown {
	return {
		type: 'json_schema',
		json_schema: {
			name: 'onyx_agent_step',
			strict: true,
			schema: {
				type: 'object',
				properties: {
					action: { type: 'string', enum: anchoredEdit ? ['tool', 'answer', 'edit'] : ['tool', 'answer'] },
					tool: { type: 'string', enum: tools.map(tool => tool.name) },
					arguments: { type: 'object' },
					answer: { type: 'string' },
					...(anchoredEdit ? { edit: anchoredEdit } : {}),
				},
				required: ['action'],
				additionalProperties: false,
			},
		},
	};
}

/** The system-prompt line that teaches the envelope. Kept in one place so prompt and schema cannot drift. */
export function toolEnvelopeInstruction(): string {
	return 'Respond with exactly one JSON object per turn: {"action":"tool","tool":"<name>","arguments":{...}} to call a tool, or {"action":"answer","answer":"<your final answer>"} when done. No other text.';
}

/** The tool an `edit` action of the envelope calls. */
export const ONYX_ANCHORED_EDIT_TOOL = 'editFile';

export type OnyxEnvelopeResult =
	| { readonly kind: 'tool'; readonly name: string; readonly parameters: object }
	| { readonly kind: 'answer'; readonly text: string }
	| { readonly kind: 'invalid'; readonly raw: string };

/**
 * Parses a constrained turn. Tolerates prose around the JSON (some runtimes
 * only *bias* the sampling) by extracting the first balanced object.
 */
export function parseToolEnvelope(modelReply: string, knownTools: readonly string[]): OnyxEnvelopeResult {
	// The first JSON object in a reasoning model's thinking is a thought, not the turn (C4).
	const thought = stripReasoning(modelReply);
	if (thought.unterminated) {
		return { kind: 'invalid', raw: modelReply };
	}
	const text = thought.text;
	const json = extractFirstJsonObject(text);
	if (!json) {
		return { kind: 'invalid', raw: text };
	}
	try {
		const parsed = JSON.parse(json) as { action?: string; tool?: string; arguments?: unknown; answer?: unknown; edit?: unknown };
		if (parsed.action === 'edit' && knownTools.includes(ONYX_ANCHORED_EDIT_TOOL)) {
			// An anchored edit (L7) is a call of the edit tool with the anchor arguments. Whether those arguments
			// are on this turn's list is checked where every call's arguments are, before anything is dispatched.
			return { kind: 'tool', name: ONYX_ANCHORED_EDIT_TOOL, parameters: typeof parsed.edit === 'object' && parsed.edit !== null ? parsed.edit as object : {} };
		}
		if (parsed.action === 'tool' && typeof parsed.tool === 'string' && knownTools.includes(parsed.tool)) {
			return { kind: 'tool', name: parsed.tool, parameters: typeof parsed.arguments === 'object' && parsed.arguments !== null ? parsed.arguments as object : {} };
		}
		if (parsed.action === 'answer') {
			return { kind: 'answer', text: typeof parsed.answer === 'string' ? parsed.answer : '' };
		}
		return { kind: 'invalid', raw: text };
	} catch {
		return { kind: 'invalid', raw: text };
	}
}

/**
 * Repairs a native tool call whose arguments are the constrained envelope
 * itself. Seen live with llama3.2:3b under constrained decoding: the model
 * emits a tool_calls entry whose `arguments` is the whole
 * `{"action":"tool","tool":...,"arguments":{...}}` object. The intent is
 * unambiguous, so it is unwrapped instead of failing the call — but only
 * when the inner tool is known; anything else passes through untouched.
 */
export function unwrapEnvelopeParameters(name: string, parameters: unknown, knownTools: readonly string[]): { readonly name: string; readonly parameters: object } {
	const fallback = { name, parameters: typeof parameters === 'object' && parameters !== null ? parameters as object : {} };
	if (typeof parameters !== 'object' || parameters === null) {
		return fallback;
	}
	const candidate = parameters as { action?: unknown; tool?: unknown; arguments?: unknown };
	if (candidate.action !== 'tool' || typeof candidate.tool !== 'string' || !knownTools.includes(candidate.tool)) {
		return fallback;
	}
	return {
		name: candidate.tool,
		parameters: typeof candidate.arguments === 'object' && candidate.arguments !== null ? candidate.arguments as object : {},
	};
}

function extractFirstJsonObject(text: string): string | undefined {
	const start = text.indexOf('{');
	if (start < 0) {
		return undefined;
	}
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = start; i < text.length; i++) {
		const char = text[i];
		if (escaped) {
			escaped = false;
			continue;
		}
		if (char === '\\') {
			escaped = inString;
			continue;
		}
		if (char === '"') {
			inString = !inString;
			continue;
		}
		if (inString) {
			continue;
		}
		if (char === '{') {
			depth++;
		} else if (char === '}') {
			depth--;
			if (depth === 0) {
				return text.slice(start, i + 1);
			}
		}
	}
	return undefined;
}

/**
 * Reads a constrained turn's envelope as it arrives and hands back the text
 * of its `answer` as soon as it can be shown (C6, R-28). A constrained turn
 * is one JSON object, `{"action":"answer","answer":"…"}` or
 * `{"action":"tool",…}`; until this existed nothing of it was shown before
 * the whole object had arrived.
 *
 * Only the object's own keys are followed. The answer is released once the
 * action is known to be `answer`; an answer that arrives before its action
 * is kept until the action does. A tool turn releases nothing.
 */
export class OnyxEnvelopeAnswerStream {

	private _depth = 0;
	private _inString = false;
	private _escaped = false;
	private _unicode: string | undefined;
	private _pendingSurrogate = '';
	/** What the string being read is: a key of the envelope, the value of one of its keys, or something nested. */
	private _role: 'key' | 'action' | 'answer' | 'other' = 'other';
	private _afterColon = false;
	private _key = '';
	private _action = '';
	private _actionKnown = false;
	private _answer = '';
	private _shown = 0;

	/** The answer text shown so far. */
	get shown(): string {
		return this._answer.slice(0, this._shown);
	}

	/** Takes a chunk of the envelope; returns the answer text that can be shown now. */
	push(chunk: string): string {
		for (const char of chunk) {
			if (this._inString) {
				this._stringChar(char);
			} else {
				this._structureChar(char);
			}
		}
		if (!this._actionKnown || this._action !== 'answer') {
			return '';
		}
		const release = this._answer.slice(this._shown);
		this._shown = this._answer.length;
		return release;
	}

	private _structureChar(char: string): void {
		switch (char) {
			case '"':
				this._inString = true;
				if (this._depth !== 1) {
					this._role = 'other';
				} else if (!this._afterColon) {
					this._role = 'key';
					this._key = '';
				} else {
					this._role = this._key === 'action' ? 'action' : this._key === 'answer' ? 'answer' : 'other';
				}
				break;
			case ':':
				if (this._depth === 1) {
					this._afterColon = true;
				}
				break;
			case ',':
				if (this._depth === 1) {
					this._afterColon = false;
				}
				break;
			case '{':
			case '[':
				this._depth++;
				break;
			case '}':
			case ']':
				this._depth--;
				break;
		}
	}

	private _stringChar(char: string): void {
		if (this._unicode !== undefined) {
			this._unicode += char;
			if (this._unicode.length === 4) {
				const code = Number.parseInt(this._unicode, 16);
				this._unicode = undefined;
				if (!Number.isNaN(code)) {
					this._decoded(String.fromCharCode(code));
				}
			}
			return;
		}
		if (this._escaped) {
			this._escaped = false;
			if (char === 'u') {
				this._unicode = '';
				return;
			}
			this._decoded(ESCAPES[char] ?? char);
			return;
		}
		if (char === '\\') {
			this._escaped = true;
			return;
		}
		if (char === '"') {
			this._inString = false;
			if (this._role === 'action') {
				this._actionKnown = true;
			}
			return;
		}
		this._decoded(char);
	}

	private _decoded(text: string): void {
		switch (this._role) {
			case 'key':
				this._key += text;
				break;
			case 'action':
				this._action += text;
				break;
			case 'answer': {
				// A character outside the basic plane arrives as two escapes; it is shown whole or not yet.
				const code = text.charCodeAt(0);
				if (text.length === 1 && code >= 0xd800 && code <= 0xdbff) {
					this._pendingSurrogate = text;
					break;
				}
				this._answer += this._pendingSurrogate + text;
				this._pendingSurrogate = '';
				break;
			}
		}
	}
}

const ESCAPES: Readonly<Record<string, string>> = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '/': '/', '\\': '\\', '"': '"' };
