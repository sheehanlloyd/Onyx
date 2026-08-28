/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

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

/** OpenAI `response_format` payload constraining a turn to the tool/answer envelope. */
export function buildToolEnvelopeFormat(tools: readonly IOnyxEnvelopeTool[]): unknown {
	return {
		type: 'json_schema',
		json_schema: {
			name: 'onyx_agent_step',
			strict: true,
			schema: {
				type: 'object',
				properties: {
					action: { type: 'string', enum: ['tool', 'answer'] },
					tool: { type: 'string', enum: tools.map(tool => tool.name) },
					arguments: { type: 'object' },
					answer: { type: 'string' },
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

export type OnyxEnvelopeResult =
	| { readonly kind: 'tool'; readonly name: string; readonly parameters: object }
	| { readonly kind: 'answer'; readonly text: string }
	| { readonly kind: 'invalid'; readonly raw: string };

/**
 * Parses a constrained turn. Tolerates prose around the JSON (some runtimes
 * only *bias* the sampling) by extracting the first balanced object.
 */
export function parseToolEnvelope(text: string, knownTools: readonly string[]): OnyxEnvelopeResult {
	const json = extractFirstJsonObject(text);
	if (!json) {
		return { kind: 'invalid', raw: text };
	}
	try {
		const parsed = JSON.parse(json) as { action?: string; tool?: string; arguments?: unknown; answer?: unknown };
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
