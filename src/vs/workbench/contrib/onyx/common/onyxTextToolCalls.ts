/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** A tool invocation a model wrote into its prose instead of the tool-call channel. */
export interface IOnyxTextToolCall {
	readonly name: string;
	readonly parameters: object;
}

/** How much text may be withheld while deciding whether it is a tool envelope. */
const MAX_HELD_CHARS = 4000;

/** Wrappers small models put around tool JSON. */
const ENVELOPE_PREFIXES = ['```', '<tool_call>', '<|tool_call|>', '[TOOL_CALLS]'];

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
export function parseTextToolCall(text: string, offeredToolNames: readonly string[]): IOnyxTextToolCall | undefined {
	const body = unwrapEnvelope(text.trim());
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
 * Could this text still turn into a tool envelope if more of it arrived?
 * Used to hold back the first characters of a turn rather than streaming a
 * half-written JSON object into the transcript.
 */
export function couldBeToolEnvelope(text: string): boolean {
	const trimmed = text.trimStart();
	if (trimmed.length === 0) {
		return true; // nothing to judge yet
	}
	if (trimmed.length > MAX_HELD_CHARS) {
		return false; // whatever this is, stop withholding it
	}
	if (trimmed.startsWith('{')) {
		return true;
	}
	// A short prefix of a known wrapper is still undecided ("``" could become "```").
	return ENVELOPE_PREFIXES.some(prefix => prefix.startsWith(trimmed) || trimmed.startsWith(prefix));
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
	const fn = source['function'];
	return fn && typeof fn === 'object' ? firstString(fn as Record<string, unknown>, ['name']) : undefined;
}

function extractParameters(source: Record<string, unknown>): object {
	const fn = source['function'];
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
		if (couldBeToolEnvelope(this._held)) {
			return;
		}
		this._deciding = false;
		this._text += this._held;
		this._emit(this._held);
		this._held = '';
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
