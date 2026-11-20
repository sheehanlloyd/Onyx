/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { stripReasoning } from './onyxReasoning.js';

/** A tool invocation a model wrote into its prose instead of the tool-call channel. */
export interface IOnyxTextToolCall {
	readonly name: string;
	readonly parameters: object;
}

/**
 * How long a reply is withheld while nothing has yet decided whether it is a
 * tool call (C5). Past this it is shown: holding text back on a guess is how
 * a fenced answer came to show nothing until it was finished.
 */
const MAX_UNDECIDED_CHARS = 400;
/**
 * How long a tool call in progress is withheld. More than one reply can
 * produce under the output cap, so a call is held to its end and runs,
 * instead of being cut loose half way and shown as JSON.
 */
const MAX_HELD_CHARS = 32_000;

/** Wrappers some chat templates put around a tool call written as text. */
const WRAPPER_PREFIXES = ['<tool_call>', '<|tool_call|>', '[TOOL_CALLS]'];
/** Keys whose value names the tool. */
const NAME_KEYS = new Set(['tool', 'name', 'tool_name', 'function_name']);
/** Other keys a tool call written as JSON can open with. */
const CALL_KEYS = new Set(['function', 'arguments', 'parameters', 'args', 'input', 'parameter']);

/**
 * Recognizes a tool call a model emitted as *text*. Smaller local models
 * routinely ignore the tool-call channel and print the JSON instead; without
 * this the user sees a raw object where an answer should be and the agent loop
 * stops one step short of doing the work.
 *
 * Deliberately strict: the whole message must be the envelope, and the name
 * must be a tool that was actually offered, so ordinary prose that happens to
 * contain JSON is never hijacked.
 */
export function parseTextToolCall(modelReply: string, offeredToolNames: readonly string[]): IOnyxTextToolCall | undefined {
	// A call written inside a reasoning model's thinking is a thought, not a call (C4).
	const thought = stripReasoning(modelReply);
	if (thought.unterminated) {
		return undefined;
	}
	const body = unwrapEnvelope(thought.text.trim());
	if (!body.startsWith('{') || !body.endsWith('}')) {
		return undefined;
	}
	let parsed: Record<string, unknown>;
	try {
		parsed = JSON.parse(body);
	} catch {
		return undefined;
	}

	const name = firstString(parsed, ['name', 'tool', 'tool_name', 'function_name']) ?? nestedFunctionName(parsed);
	if (!name || !offeredToolNames.includes(name)) {
		return undefined;
	}
	return { name, parameters: extractParameters(parsed) };
}

/**
 * Whether the reply so far can still be a tool call written as text, and so
 * should not be shown yet (C5, R-27).
 *
 * Withheld: a known tool-call wrapper; a JSON object whose first key is one
 * a call opens with, and, when that key names the tool, whose value is still
 * the start of a tool on offer; the same inside a fence marked `json` or not
 * marked. Shown at once: a fence with any other language, JSON that is not a
 * call, and anything that nothing has decided within
 * {@link MAX_UNDECIDED_CHARS}.
 */
export function couldBeToolEnvelope(text: string, offeredToolNames?: readonly string[]): boolean {
	const trimmed = text.trimStart();
	if (trimmed.length === 0) {
		return true; // nothing to judge yet
	}
	if (trimmed.length > MAX_HELD_CHARS) {
		return false; // whatever this is, stop withholding it
	}
	const undecided = trimmed.length <= MAX_UNDECIDED_CHARS;

	let body = trimmed;
	if (trimmed.startsWith('`')) {
		if (trimmed.length < 3) {
			return '```'.startsWith(trimmed); // "``" could become a fence
		}
		if (!trimmed.startsWith('```')) {
			return false;
		}
		const lineEnd = trimmed.indexOf('\n');
		const info = (lineEnd === -1 ? trimmed.slice(3) : trimmed.slice(3, lineEnd)).trim().toLowerCase();
		if (lineEnd === -1) {
			// The fence's language is still arriving. Only `json`, or none, can open a tool call.
			return undecided && 'json'.startsWith(info);
		}
		if (info !== '' && info !== 'json') {
			return false; // a fence of code in some language: prose, and it streams
		}
		body = trimmed.slice(lineEnd + 1).trimStart();
		if (body.length === 0) {
			return undecided;
		}
	} else {
		const wrapper = WRAPPER_PREFIXES.find(prefix => prefix.startsWith(trimmed) || trimmed.startsWith(prefix));
		if (wrapper) {
			return true; // a known wrapper, or still the start of one
		}
	}

	if (!body.startsWith('{')) {
		return false;
	}
	// A JSON object. What it opens with decides.
	const opening = /^\{\s*"(?<key>[^"\\]*)"\s*:\s*(?<rest>[\s\S]*)$/.exec(body)?.groups;
	if (!opening) {
		// The first key has not arrived whole. `{`, `{ "to` and `{"tool"` can still become a call; `{}` and `{ 1` cannot.
		return undecided && /^\{\s*("[^"\\]*"?\s*)?$/.test(body);
	}
	if (NAME_KEYS.has(opening.key)) {
		// The value has to be, or still be the start of, the name of a tool on offer.
		const value = /^"(?<name>[^"\\]*)(?<closed>")?/.exec(opening.rest)?.groups;
		if (!value) {
			return opening.rest.length === 0 ? true : false;
		}
		if (!offeredToolNames) {
			return true;
		}
		return value.closed ? offeredToolNames.includes(value.name) : offeredToolNames.some(name => name.startsWith(value.name));
	}
	if (opening.key === 'action') {
		// The constrained envelope: {"action":"tool",…} or {"action":"answer",…}.
		const value = /^"(?<action>[^"\\]*)/.exec(opening.rest)?.groups?.action;
		return value === undefined ? opening.rest.length === 0 : 'tool'.startsWith(value) || 'answer'.startsWith(value) || value === 'tool' || value === 'answer';
	}
	if (opening.key === 'type') {
		// The API's own shape written out as text: {"type":"function","function":{…}}.
		const value = /^"(?<type>[^"\\]*)/.exec(opening.rest)?.groups?.type;
		return value === undefined ? opening.rest.length === 0 : 'function'.startsWith(value);
	}
	return CALL_KEYS.has(opening.key);
}

function unwrapEnvelope(text: string): string {
	const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(text);
	if (fenced) {
		return fenced[1].trim();
	}
	const tagged = /^<\|?tool_call\|?>\s*([\s\S]*?)\s*<\/\|?tool_call\|?>$/.exec(text) ?? /^<\|?tool_call\|?>\s*([\s\S]*)$/.exec(text);
	if (tagged) {
		return tagged[1].trim();
	}
	if (text.startsWith('[TOOL_CALLS]')) {
		return text.slice('[TOOL_CALLS]'.length).trim();
	}
	return text;
}

function firstString(source: Record<string, unknown>, keys: readonly string[]): string | undefined {
	for (const key of keys) {
		const value = source[key];
		if (typeof value === 'string' && value.trim()) {
			return value.trim();
		}
	}
	return undefined;
}

/** `{"type":"function","function":{"name":…}}` — the OpenAI shape, written as prose. */
function nestedFunctionName(source: Record<string, unknown>): string | undefined {
	const fn = source.function;
	return fn && typeof fn === 'object' ? firstString(fn as Record<string, unknown>, ['name']) : undefined;
}

function extractParameters(source: Record<string, unknown>): object {
	const fn = source.function;
	const holder = (fn && typeof fn === 'object' ? fn as Record<string, unknown> : source);
	for (const key of ['parameters', 'arguments', 'args', 'input', 'parameter']) {
		const value = holder[key];
		if (value && typeof value === 'object' && !Array.isArray(value)) {
			return value as object;
		}
		if (typeof value === 'string') {
			try {
				const nested = JSON.parse(value);
				if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
					return nested as object;
				}
			} catch {
				// not JSON — fall through to the next key
			}
		}
	}
	return {};
}

/**
 * Streams assistant text to the transcript, holding back a leading tool
 * envelope until it is clear whether the turn is prose or a mis-channelled
 * tool call. Everything that is prose still streams token by token.
 */
export class OnyxAssistantTextStream {

	private _held = '';
	private _deciding = true;
	private _text = '';

	constructor(
		private readonly _offeredToolNames: readonly string[],
		private readonly _emit: (text: string) => void,
	) { }

	append(chunk: string): void {
		if (!this._deciding) {
			this._text += chunk;
			this._emit(chunk);
			return;
		}
		this._held += chunk;
		if (this._withhold(this._held)) {
			return;
		}
		this._deciding = false;
		this._text += this._held;
		this._emit(this._held);
		this._held = '';
	}

	/** Whether the reply so far is still withheld. */
	protected _withhold(soFar: string): boolean {
		return couldBeToolEnvelope(soFar, this._offeredToolNames);
	}

	/**
	 * Ends the turn. Returns the prose the model actually produced and, when
	 * the held text turned out to be a tool call written as prose, that call.
	 *
	 * `raw` is everything the model emitted this turn, including a held
	 * envelope that the prose path is about to consume. A grammar-constrained
	 * turn needs it: there, the envelope *is* the whole turn, and judging the
	 * grammar by whatever is left after the repair path takes its share scores
	 * a perfectly valid constrained turn as a failure.
	 */
	finish(): { readonly text: string; readonly toolCall: IOnyxTextToolCall | undefined; readonly raw: string } {
		const raw = this._text + this._held;
		if (!this._held) {
			return { text: this._text, toolCall: undefined, raw };
		}
		const toolCall = parseTextToolCall(this._held, this._offeredToolNames);
		if (toolCall) {
			this._held = '';
			return { text: this._text, toolCall, raw };
		}
		this._text += this._held;
		this._emit(this._held);
		this._held = '';
		return { text: this._text, toolCall: undefined, raw };
	}
}
