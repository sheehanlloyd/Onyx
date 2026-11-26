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

/** The keys a tool call written as JSON may carry, and nothing else, when prose comes before it. */
const TRAILING_CALL_KEYS = new Set([...NAME_KEYS, ...CALL_KEYS, 'type', 'id']);

/**
 * A tool call a model wrote as JSON at the end of a reply, after some prose:
 * "Let me read the file. {"name": "readFile", "arguments": {...}}", with or
 * without a `json` fence around the object. Stricter than a whole-message call,
 * because prose may quote JSON: the object must be the last thing in the reply,
 * must parse, must name a tool on offer, must carry nothing but the keys a call
 * has, and its arguments must be an object. Returns the prose before it too.
 */
export function parseTrailingToolCall(modelReply: string, offeredToolNames: readonly string[]): { readonly prose: string; readonly call: IOnyxTextToolCall } | undefined {
	const thought = stripReasoning(modelReply);
	if (thought.unterminated) {
		return undefined;
	}
	const text = thought.text.trimEnd();
	const fenced = /```(?:json)?[ \t]*\n(?<body>\{[\s\S]*\})\s*```$/.exec(text);
	const start = fenced ? fenced.index : lastObjectStart(text);
	if (start === undefined || start < 0) {
		return undefined;
	}
	const body = fenced?.groups?.body ?? text.slice(start);
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		return undefined;
	}
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
		return undefined;
	}
	const record = parsed as Record<string, unknown>;
	if (Object.keys(record).some(key => !TRAILING_CALL_KEYS.has(key))) {
		return undefined;
	}
	const name = firstString(record, ['name', 'tool', 'tool_name', 'function_name']) ?? nestedFunctionName(record);
	const holder = record.function && typeof record.function === 'object' ? record.function as Record<string, unknown> : record;
	const argumentsValue = ['arguments', 'parameters', 'args', 'input', 'parameter'].map(key => holder[key]).find(value => value !== undefined);
	const argumentsOk = argumentsValue === undefined || (typeof argumentsValue === 'object' && argumentsValue !== null && !Array.isArray(argumentsValue)) || (typeof argumentsValue === 'string' && isJsonObject(argumentsValue));
	if (!name || !offeredToolNames.includes(name) || !argumentsOk) {
		return undefined;
	}
	return { prose: text.slice(0, start).trimEnd(), call: { name, parameters: extractParameters(record) } };
}

/**
 * Whether a reply's text holds a tool call that is still only text: a JSON object naming a tool on offer
 * as a call does, or the envelope's tool action. A run must not end "completed" on one (it was not run).
 */
export function findUnexecutedToolCall(reply: string, offeredToolNames: readonly string[]): string | undefined {
	// A call inside the model's thinking is a thought, not a call (C4), here as in the text repair.
	const text = stripReasoning(reply).text;
	for (let index = text.indexOf('{'); index !== -1 && index < text.length; index = text.indexOf('{', index + 1)) {
		const end = matchingBrace(text, index);
		if (end === undefined) {
			continue;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(text.slice(index, end + 1));
		} catch {
			continue;
		}
		if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
			continue;
		}
		const record = parsed as Record<string, unknown>;
		const name = record.action === 'tool' ? firstString(record, ['tool']) : firstString(record, ['name', 'tool', 'tool_name', 'function_name']) ?? nestedFunctionName(record);
		const callShaped = record.action === 'tool' || ['arguments', 'parameters', 'args', 'input', 'function'].some(key => record[key] !== undefined);
		if (name && callShaped && offeredToolNames.includes(name)) {
			return name;
		}
	}
	return undefined;
}

/** Whether the text ends inside a code block: an odd number of lines open a fence. */
function insideFence(text: string): boolean {
	return (text.match(/^[ \t]*```/gm) ?? []).length % 2 === 1;
}

function isJsonObject(text: string): boolean {
	try {
		const value = JSON.parse(text);
		return typeof value === 'object' && value !== null && !Array.isArray(value);
	} catch {
		return false;
	}
}

/** Where the JSON object that ends the text begins: the `{` whose matching brace is the text's last character. */
function lastObjectStart(text: string): number | undefined {
	if (!text.endsWith('}')) {
		return undefined;
	}
	for (let index = text.lastIndexOf('{'); index !== -1; index = index === 0 ? -1 : text.lastIndexOf('{', index - 1)) {
		if (matchingBrace(text, index) === text.length - 1) {
			// The object has to begin a line of its own, or follow prose after a space: not the middle of a word.
			return index === 0 || /\s/.test(text[index - 1]) ? index : undefined;
		}
	}
	return undefined;
}

/** The index of the brace that closes the one at `open`, strings and escapes respected; undefined when it does not close. */
function matchingBrace(text: string, open: number): number | undefined {
	let depth = 0;
	let inString = false;
	for (let index = open; index < text.length; index++) {
		const character = text[index];
		if (inString) {
			if (character === '\\') {
				index++;
			} else if (character === '"') {
				inString = false;
			}
		} else if (character === '"') {
			inString = true;
		} else if (character === '{') {
			depth++;
		} else if (character === '}') {
			depth--;
			if (depth === 0) {
				return index;
			}
		}
	}
	return undefined;
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

/** What a reply's text goes through on its way to the transcript, and what is known about it when the reply ends. */
export interface IOnyxAssistantTextStream {
	append(chunk: string): void;
	/** The prose of the turn, the tool call it turned out to be when it was one, and everything the model emitted. */
	finish(): { readonly text: string; readonly toolCall: IOnyxTextToolCall | undefined; readonly raw: string };
}

/**
 * The reply as it is, shown as it arrives: nothing is withheld and nothing
 * in it is read as a tool call. What the bare native tool-call protocol
 * uses (L4), where a call counts only when it comes on the tool channel.
 */
export class OnyxPlainTextStream implements IOnyxAssistantTextStream {

	private _text = '';

	constructor(private readonly _emit: (text: string) => void) { }

	append(chunk: string): void {
		this._text += chunk;
		this._emit(chunk);
	}

	finish(): { readonly text: string; readonly toolCall: undefined; readonly raw: string } {
		return { text: this._text, toolCall: undefined, raw: this._text };
	}
}

/**
 * Streams assistant text to the transcript, holding back a leading tool
 * envelope until it is clear whether the turn is prose or a mis-channelled
 * tool call. Everything that is prose still streams token by token.
 */
export class OnyxAssistantTextStream implements IOnyxAssistantTextStream {

	private _held = '';
	private _deciding = true;
	private _text = '';
	/** After prose: a line that may open a tool call written at the end of the reply, held until that is decided. */
	private _tail = '';

	constructor(
		private readonly _offeredToolNames: readonly string[],
		private readonly _emit: (text: string) => void,
	) { }

	append(chunk: string): void {
		if (!this._deciding) {
			this._appendProse(chunk);
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

	/**
	 * Prose streams, except from a line that can still open a tool call written as JSON after it (a `{`, or a
	 * fence that can be `json`): that much is held until it is known, and if the reply ends on a call there,
	 * the call runs and is not shown as text.
	 */
	private _appendProse(chunk: string): void {
		const pending = this._tail + chunk;
		const lineStarts: number[] = [];
		for (let index = 0; index < pending.length; index++) {
			if (index === 0 ? this._text.length === 0 || this._text.endsWith('\n') : pending[index - 1] === '\n') {
				lineStarts.push(index);
			}
		}
		const hold = lineStarts.find(start => {
			const line = pending.slice(start);
			if (/^[ \t]*`/.test(line) && insideFence(this._text + pending.slice(0, start))) {
				return false; // the fence that closes a code block, not one that opens a call
			}
			return /^[ \t]*[{`]/.test(line) || line.trim() === '' ? this._withhold(line) : false;
		});
		const shown = hold === undefined ? pending : pending.slice(0, hold);
		this._tail = hold === undefined ? '' : pending.slice(hold);
		if (shown) {
			this._text += shown;
			this._emit(shown);
		}
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
		const raw = this._text + this._held + this._tail;
		if (this._tail) {
			// Only what was held: a call that began in text already shown is not taken back from the transcript.
			const trailing = parseTrailingToolCall(this._tail, this._offeredToolNames);
			if (trailing) {
				this._tail = '';
				return { text: this._text, toolCall: trailing.call, raw };
			}
			this._text += this._tail;
			this._emit(this._tail);
			this._tail = '';
		}
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
