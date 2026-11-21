/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { IOnyxChatParams, IOnyxRuntimeService, IOnyxStreamEvent, IOnyxWireMessage, IOnyxWireTool, OnyxStreamEnding } from '../../../../platform/onyxRuntime/common/onyxRuntime.js';
import { IOnyxContextStep, IOnyxDatasheet, tallyOf } from './onyxDatasheet.js';
import { stripReasoning } from './onyxReasoning.js';
import { parseTextToolCall } from './onyxTextToolCalls.js';
import { validateToolArguments } from './onyxToolArguments.js';

/**
 * The probe suite that produces a model's datasheet (L5): about thirty-five
 * short requests, each asking one question of the model and its runtime, and
 * the scoring of what comes back. The suite talks to a transport, not to a
 * runtime, so the same probes run from the workbench, from a script, and
 * against a mock runtime whose behaviour is known.
 *
 * The prompts are fixed and carry nothing of the user's: no file, no path,
 * no workspace text. What a probe sends is in this file and nowhere else.
 */

export interface IOnyxProbeRequest {
	readonly messages: readonly IOnyxWireMessage[];
	readonly tools?: readonly IOnyxWireTool[];
	readonly temperature?: number;
	readonly maxTokens?: number;
	readonly responseFormat?: unknown;
	readonly seed?: number;
	readonly stop?: readonly string[];
	readonly logprobs?: boolean;
}

export interface IOnyxProbeReply {
	readonly text: string;
	/** Thinking the runtime sent in a field of its own. */
	readonly reasoning: string;
	readonly toolCalls: readonly { readonly name: string; readonly argumentsText: string }[];
	readonly finishReason: string | undefined;
	/** How the stream ended; `error` when the request failed, with the message in `error`. */
	readonly ending: OnyxStreamEnding | 'error';
	readonly error?: string;
	readonly promptTokens: number | undefined;
	readonly completionTokens: number | undefined;
	readonly firstTokenMs: number | undefined;
	readonly totalMs: number;
	/** Whether the reply carried token log-probabilities. */
	readonly logprobs: boolean;
}

export interface IOnyxProbeTransport {
	send(request: IOnyxProbeRequest, token: CancellationToken): Promise<IOnyxProbeReply>;
}

/** What the suite is told about its subject before it starts. */
export interface IOnyxProbeSubject {
	readonly model: string;
	readonly digest: string | undefined;
	readonly runtime: string;
	readonly runtimeVersion: string | undefined;
	/** The context the server says it allocates, when it says. The context probe does not go past it. */
	readonly serverContextTokens: number | undefined;
	/** Whether the model was already loaded when the suite began. Unknown: the cold first token is not measured. */
	readonly loadedAtStart: boolean | undefined;
}

/** The steps of the suite, as progress names them. */
export type OnyxProbeName = 'tool calls' | 'schema enforcement' | 'context' | 'output cap and stop' | 'reasoning' | 'seed' | 'log-probabilities and speed' | 'done';

export interface IOnyxProbeOptions {
	/** Trials for the tool-call probe. */
	readonly toolTrials?: number;
	/** Trials for each of the other counted probes. */
	readonly trials?: number;
	/** The largest prompt the context probe sends, in estimated tokens. */
	readonly maxContextProbeTokens?: number;
	/** Called before each probe with its name and how far the suite is. */
	readonly onProgress?: (probe: OnyxProbeName, done: number, total: number) => void;
	/**
	 * Asked just before the context probe, when the model has answered and is
	 * therefore loaded: what the server says it allocated for it. Takes the
	 * place of the subject's number when it gives one.
	 */
	readonly resolveServerContextTokens?: () => Promise<number | undefined>;
	/** The clock for the datasheet's date. */
	readonly now?: () => Date;
}

const SYSTEM = 'You are a coding assistant. Use the tools you are given when you need them.';

const READ_FILE_TOOL: IOnyxWireTool = {
	type: 'function',
	function: {
		name: 'readFile',
		description: 'Reads a file in the workspace and returns its text.',
		parameters: { type: 'object', properties: { path: { type: 'string', description: 'Workspace-relative path of the file.' } }, required: ['path'], additionalProperties: false },
	},
};

/** The files the tool-call probe asks about, one a trial. None of them exists: only the call is looked at. */
const PROBE_PATHS = ['src/math.ts', 'README.md', 'package.json', 'src/util.ts', 'docs/guide.md', 'src/index.ts', 'test/math.test.ts', 'LICENSE'];

const user = (content: string): IOnyxWireMessage => ({ role: 'user', content });
const system = (content: string): IOnyxWireMessage => ({ role: 'system', content });

function jsonSchemaFormat(name: string, schema: object): unknown {
	// The same wrapper the constrained tool-or-answer envelope is sent in.
	return { type: 'json_schema', json_schema: { name, strict: true, schema } };
}

const OBJECT_SCHEMA = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false };
const ENUM_SCHEMA = { type: 'object', properties: { color: { type: 'string', enum: ['red', 'green'] } }, required: ['color'], additionalProperties: false };
const NESTED_SCHEMA = {
	type: 'object',
	properties: {
		file: {
			type: 'object',
			properties: {
				path: { type: 'string' },
				lines: { type: 'object', properties: { start: { type: 'number' }, end: { type: 'number' } }, required: ['start', 'end'], additionalProperties: false },
			},
			required: ['path', 'lines'],
			additionalProperties: false,
		},
	},
	required: ['file'],
	additionalProperties: false,
};

/** Whether a reply is JSON that matches a schema, and nothing else. */
export function matchesSchema(text: string, schema: object): boolean {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stripReasoning(text).text.trim());
	} catch {
		return false;
	}
	return typeof parsed === 'object' && parsed !== null && validateToolArguments(schema, parsed).length === 0;
}

/** Whether a reply carries a valid call to `readFile` for `path` on the tool channel. */
export function isValidNativeCall(reply: IOnyxProbeReply, path: string): boolean {
	return reply.toolCalls.some(call => {
		if (call.name !== READ_FILE_TOOL.function.name) {
			return false;
		}
		try {
			const parsed: unknown = JSON.parse(call.argumentsText);
			return validateToolArguments(READ_FILE_TOOL.function.parameters, parsed).length === 0 && (parsed as { path?: unknown }).path === path;
		} catch {
			return false;
		}
	});
}

/** Whether the text repair reads a call to `readFile` out of a reply that put none on the tool channel. */
export function isRepairableTextCall(reply: IOnyxProbeReply): boolean {
	const call = parseTextToolCall(reply.text, [READ_FILE_TOOL.function.name]);
	return call?.name === READ_FILE_TOOL.function.name && validateToolArguments(READ_FILE_TOOL.function.parameters, call.parameters).length === 0;
}

const CANARY = 'ZEBRA-7421';
const FILLER_LINE = 'The quick brown fox jumps over the lazy dog while the build runs.\n';

/** A prompt of about `tokens` tokens with a code at its very start and a question about the code at its end. */
export function canaryPrompt(tokens: number): string {
	const opening = `Remember this code, you will be asked for it: ${CANARY}.\n\n`;
	const closing = '\nWhat was the code you were asked to remember? Reply with the code only.';
	// Four characters a token, the estimate the harness budgets with.
	const fillerChars = Math.max(0, tokens * 4 - opening.length - closing.length);
	return opening + FILLER_LINE.repeat(Math.ceil(fillerChars / FILLER_LINE.length)).slice(0, fillerChars) + closing;
}

function median(values: readonly number[]): number | null {
	if (values.length === 0) {
		return null;
	}
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** A probe was interrupted: the suite stops and produces no datasheet. */
export class OnyxProbesCancelledError extends Error {
	constructor() {
		super('The measurement was cancelled.');
	}
}

/**
 * Runs the suite and returns the datasheet. A request that fails counts as
 * a failed trial of its probe; a probe whose every request failed is listed
 * as not measured, with the runtime's own words. Cancelling stops the suite
 * with `OnyxProbesCancelledError`: half a datasheet is not a datasheet.
 */
export async function runDatasheetProbes(transport: IOnyxProbeTransport, subject: IOnyxProbeSubject, token: CancellationToken, options: IOnyxProbeOptions = {}): Promise<IOnyxDatasheet> {
	const toolTrials = options.toolTrials ?? 5;
	const trials = options.trials ?? 3;
	const unmeasured: { probe: string; reason: string }[] = [];
	const warmFirstTokens: number[] = [];
	let requests = 0;
	let firstReply: IOnyxProbeReply | undefined;

	const totalProbes = 7;
	let probesDone = 0;
	const begin = (probe: OnyxProbeName) => options.onProgress?.(probe, probesDone++, totalProbes);

	const send = async (request: IOnyxProbeRequest, short = true): Promise<IOnyxProbeReply> => {
		if (token.isCancellationRequested) {
			throw new OnyxProbesCancelledError();
		}
		const reply = await transport.send(request, token);
		if (token.isCancellationRequested || reply.ending === 'cancelled') {
			throw new OnyxProbesCancelledError();
		}
		requests++;
		if (requests === 1) {
			firstReply = reply;
		} else if (short && reply.firstTokenMs !== undefined) {
			warmFirstTokens.push(reply.firstTokenMs);
		}
		return reply;
	};
	/** Lists a probe as not measured when every one of its requests failed, and says why. */
	const noteFailures = (probe: string, replies: readonly IOnyxProbeReply[]) => {
		if (replies.length > 0 && replies.every(reply => reply.ending === 'error')) {
			unmeasured.push({ probe, reason: replies[0].error ?? 'every request failed' });
			return true;
		}
		return false;
	};

	// 1 and 2. Tool calls: on the tool channel, and readable as text when not.
	begin('tool calls');
	const toolReplies: { reply: IOnyxProbeReply; path: string }[] = [];
	for (let trial = 0; trial < toolTrials; trial++) {
		const path = PROBE_PATHS[trial % PROBE_PATHS.length];
		toolReplies.push({ path, reply: await send({ messages: [system(SYSTEM), user(`What does the file ${path} contain? Read it with the tool before you answer.`)], tools: [READ_FILE_TOOL], temperature: 0.2, maxTokens: 200 }) });
	}
	const toolsFailed = noteFailures('tool calls', toolReplies.map(entry => entry.reply));
	const answered = toolsFailed ? [] : toolReplies.filter(entry => entry.reply.ending !== 'error');
	const nativeToolCalls = tallyOf(answered.map(entry => isValidNativeCall(entry.reply, entry.path)));
	const repairableTextCalls = tallyOf(answered.filter(entry => !isValidNativeCall(entry.reply, entry.path)).map(entry => isRepairableTextCall(entry.reply)));

	// 3. Schema enforcement. Each prompt asks for something the schema does not allow, so a reply that
	// matches the schema anyway was made to.
	begin('schema enforcement');
	const schemaProbe = async (name: string, schema: object, prompt: string) => {
		const replies: IOnyxProbeReply[] = [];
		for (let trial = 0; trial < trials; trial++) {
			replies.push(await send({ messages: [user(prompt)], responseFormat: jsonSchemaFormat(name, schema), temperature: 0.2, maxTokens: 120 }));
		}
		return noteFailures(`schema enforcement (${name})`, replies) ? tallyOf([]) : tallyOf(replies.filter(reply => reply.ending !== 'error').map(reply => matchesSchema(reply.text, schema)));
	};
	const schemaEnforced = {
		object: await schemaProbe('object', OBJECT_SCHEMA, 'Do not use JSON. In one plain English sentence, name a primary colour.'),
		enum: await schemaProbe('enum', ENUM_SCHEMA, 'What colour is a clear sky at noon? Answer truthfully.'),
		nested: await schemaProbe('nested', NESTED_SCHEMA, 'Do not use JSON. In one plain sentence: which file should be read first, src/math.ts lines 1 to 10 or README.md?'),
	};

	// 4. Context by canary recall: a code at the start of a prompt, a question about it at the end. Sizes
	// double until the code is lost or the bound is reached, then the gap is halved twice.
	begin('context');
	const serverContextTokens = (await options.resolveServerContextTokens?.()) ?? subject.serverContextTokens;
	const maxContextProbeTokens = Math.min(options.maxContextProbeTokens ?? 16_384, serverContextTokens ?? Number.MAX_SAFE_INTEGER);
	const steps: IOnyxContextStep[] = [];
	/** Tokens the runtime counted for a prompt of a given character length, for sizing a prompt it cut. */
	let charsPerToken = 4;
	const recall = async (tokens: number): Promise<boolean> => {
		const prompt = canaryPrompt(tokens);
		const reply = await send({ messages: [user(prompt)], temperature: 0, maxTokens: 24 }, false);
		const recalled = reply.ending !== 'error' && reply.text.includes(CANARY);
		if (recalled && reply.promptTokens) {
			charsPerToken = prompt.length / reply.promptTokens;
		}
		// A prompt whose start was lost was cut by the runtime, and what the runtime counted is what was left of it.
		steps.push({ promptTokens: recalled && reply.promptTokens ? reply.promptTokens : Math.round(prompt.length / charsPerToken), recalled });
		return recalled;
	};
	let lastGood: number | undefined;
	let firstBad: number | undefined;
	for (let size = 1024; size <= maxContextProbeTokens; size *= 2) {
		if (await recall(size)) {
			lastGood = size;
		} else {
			firstBad = size;
			break;
		}
	}
	for (let halving = 0; halving < 2 && lastGood !== undefined && firstBad !== undefined; halving++) {
		const middle = Math.round((lastGood + firstBad) / 2);
		if (await recall(middle)) {
			lastGood = middle;
		} else {
			firstBad = middle;
		}
	}
	const recalledSteps = steps.filter(step => step.recalled).map(step => step.promptTokens);
	const lostSteps = steps.filter(step => !step.recalled).map(step => step.promptTokens);
	if (recalledSteps.length === 0) {
		unmeasured.push({ probe: 'context', reason: steps.length === 0 ? 'the server reports a context smaller than the smallest prompt the probe sends' : 'the code was not recalled even from the shortest prompt' });
	}

	// 5. Output cap, and 6. stop sequence.
	begin('output cap and stop');
	const capReplies: IOnyxProbeReply[] = [];
	const stopReplies: IOnyxProbeReply[] = [];
	for (let trial = 0; trial < trials; trial++) {
		capReplies.push(await send({ messages: [user('Count from 1 to 100, one number on each line.')], temperature: 0.2, maxTokens: 12 }));
		stopReplies.push(await send({ messages: [user('Count from 1 to 6 with a space between the numbers, like this: 1 2 3 4 5 6')], temperature: 0.2, maxTokens: 40, stop: ['4'] }));
	}
	const outputCapHonoured = noteFailures('output cap', capReplies) ? tallyOf([]) : tallyOf(capReplies.filter(reply => reply.ending !== 'error').map(reply =>
		reply.finishReason === 'length' && (reply.completionTokens !== undefined ? reply.completionTokens <= 12 : reply.text.length <= 12 * 8)));
	const stopHonoured = noteFailures('stop sequence', stopReplies) ? tallyOf([]) : tallyOf(stopReplies.filter(reply => reply.ending !== 'error').map(reply =>
		reply.text.includes('3') && !reply.text.includes('4') && !reply.text.includes('5')));

	// 7. Reasoning: whether replies carry thinking, and how.
	begin('reasoning');
	const reasoningReplies: IOnyxProbeReply[] = [];
	for (let trial = 0; trial < trials; trial++) {
		reasoningReplies.push(await send({ messages: [user('What is 17 plus 25? Think it through, then give the number.')], temperature: 0.2, maxTokens: 300 }));
	}
	const reasoningFailed = noteFailures('reasoning', reasoningReplies);
	const thought = reasoningFailed ? [] : reasoningReplies.filter(reply => reply.ending !== 'error').map(reply => reply.reasoning.trim() ? 'field' : stripReasoning(reply.text).reasoning ? 'tags' : 'none');
	const reasoning: IOnyxDatasheet['reasoning'] = {
		style: thought.includes('field') ? 'field' : thought.includes('tags') ? 'tags' : 'none',
		replies: tallyOf(thought.map(kind => kind !== 'none')),
	};

	// 8. The same seed, sampled at a temperature above zero: the same reply, or not.
	begin('seed');
	const seedPairs: boolean[] = [];
	const seedReplies: IOnyxProbeReply[] = [];
	for (let trial = 0; trial < trials; trial++) {
		const request: IOnyxProbeRequest = { messages: [user('Write one sentence about the sea.')], temperature: 1, seed: 1000 + trial, maxTokens: 40 };
		const first = await send(request);
		const second = await send(request);
		seedReplies.push(first, second);
		if (first.ending !== 'error' && second.ending !== 'error') {
			seedPairs.push(first.text.length > 0 && first.text === second.text);
		}
	}
	const seedRepeatable = noteFailures('seed', seedReplies) ? tallyOf([]) : tallyOf(seedPairs);

	// 9. Log-probabilities, and speed on a reply long enough to time.
	begin('log-probabilities and speed');
	const logprobReplies: IOnyxProbeReply[] = [];
	for (let trial = 0; trial < trials; trial++) {
		logprobReplies.push(await send({ messages: [user('Say hello in one short sentence.')], temperature: 0.2, maxTokens: 20, logprobs: true }));
	}
	const logprobs = noteFailures('log-probabilities', logprobReplies) ? tallyOf([]) : tallyOf(logprobReplies.filter(reply => reply.ending !== 'error').map(reply => reply.logprobs));
	const timed = await send({ messages: [user('Write a paragraph of about 120 words explaining what version control is for.')], temperature: 0.2, maxTokens: 200 });
	const generationMs = timed.firstTokenMs !== undefined ? timed.totalMs - timed.firstTokenMs : undefined;
	const tokensPerSecond = timed.ending !== 'error' && timed.completionTokens && generationMs && generationMs > 0 ? timed.completionTokens / (generationMs / 1000) : null;
	if (tokensPerSecond === null) {
		unmeasured.push({ probe: 'speed', reason: timed.ending === 'error' ? timed.error ?? 'the request failed' : 'the runtime did not report how many tokens it generated' });
	}
	const coldFirstTokenMs = subject.loadedAtStart === false && firstReply?.firstTokenMs !== undefined ? firstReply.firstTokenMs : null;
	if (coldFirstTokenMs === null) {
		unmeasured.push({ probe: 'cold first token', reason: subject.loadedAtStart === false ? 'the first request produced nothing to time' : subject.loadedAtStart === true ? 'the model was already loaded when the measurement began' : 'whether the model was loaded beforehand is not known' });
	}
	options.onProgress?.('done', totalProbes, totalProbes);

	return {
		version: 1,
		model: subject.model,
		digest: subject.digest ?? null,
		runtime: { name: subject.runtime, version: subject.runtimeVersion ?? null },
		measuredAt: (options.now?.() ?? new Date()).toISOString(),
		nativeToolCalls,
		repairableTextCalls,
		schemaEnforced,
		context: {
			recalledUpToTokens: recalledSteps.length ? Math.max(...recalledSteps) : null,
			failedFromTokens: lostSteps.length ? Math.min(...lostSteps) : null,
			serverReportedTokens: serverContextTokens ?? null,
			steps,
		},
		outputCapHonoured,
		stopHonoured,
		reasoning,
		seedRepeatable,
		logprobs,
		speed: { coldFirstTokenMs, warmFirstTokenMs: median(warmFirstTokens), tokensPerSecond },
		unmeasured,
	};
}

/**
 * The transport over Onyx's runtime service: one chat completion a probe,
 * through the same request path the agent uses, with the stream's events
 * gathered into a reply. Works against the service itself and against its
 * proxy in the workbench alike.
 */
export class OnyxRuntimeProbeTransport implements IOnyxProbeTransport {

	private _sequence = 0;
	/** What every request went out as and came back as, for a record of the measurement. */
	readonly log: { readonly request: IOnyxProbeRequest; readonly reply: IOnyxProbeReply }[] = [];

	constructor(
		private readonly _runtimeService: Pick<IOnyxRuntimeService, 'startChatCompletion' | 'onDidStream' | 'cancel'>,
		private readonly _target: { readonly baseUrl: string; readonly apiKey?: string; readonly model: string },
		private readonly _idPrefix: string,
		private readonly _now: () => number = () => Date.now(),
	) { }

	async send(request: IOnyxProbeRequest, token: CancellationToken): Promise<IOnyxProbeReply> {
		const operationId = `${this._idPrefix}-${++this._sequence}`;
		const startedAt = this._now();
		let text = '';
		let reasoning = '';
		let firstTokenMs: number | undefined;
		let promptTokens: number | undefined;
		let completionTokens: number | undefined;
		let finishReason: string | undefined;
		let ending: IOnyxProbeReply['ending'] = 'truncated';
		let error: string | undefined;
		let logprobs = false;
		const calls = new Map<number, { name: string; argumentsText: string }>();
		const seen = () => { firstTokenMs ??= this._now() - startedAt; };

		const listener = this._runtimeService.onDidStream((event: IOnyxStreamEvent) => {
			if (event.operationId !== operationId) {
				return;
			}
			switch (event.kind) {
				case 'delta': seen(); text += event.text; break;
				case 'reasoning': seen(); reasoning += event.text; break;
				case 'toolCallDelta': {
					seen();
					const call = calls.get(event.index) ?? { name: '', argumentsText: '' };
					calls.set(event.index, { name: event.name ?? call.name, argumentsText: call.argumentsText + (event.argumentsDelta ?? '') });
					break;
				}
				case 'usage': promptTokens = event.promptTokens || undefined; completionTokens = event.completionTokens || undefined; break;
				case 'done': finishReason = event.finishReason; ending = event.ending; logprobs = event.logprobs === true; break;
				case 'error': ending = 'error'; error = event.message; break;
			}
		});
		const cancellation = token.onCancellationRequested(() => { this._runtimeService.cancel(operationId).catch(() => { /* already over */ }); });
		const params: IOnyxChatParams = {
			baseUrl: this._target.baseUrl,
			apiKey: this._target.apiKey,
			model: this._target.model,
			messages: request.messages,
			tools: request.tools,
			temperature: request.temperature,
			maxTokens: request.maxTokens,
			responseFormat: request.responseFormat,
			seed: request.seed,
			stop: request.stop,
			logprobs: request.logprobs,
			// A probe is a short request: a model that has not answered in five minutes is not going to.
			firstByteTimeoutMs: 300_000,
			idleTimeoutMs: 60_000,
		};
		try {
			await this._runtimeService.startChatCompletion(operationId, params);
		} catch (err) {
			ending = 'error';
			error = err instanceof Error ? err.message : String(err);
		} finally {
			listener.dispose();
			cancellation.dispose();
		}
		const reply: IOnyxProbeReply = {
			text, reasoning, toolCalls: [...calls.entries()].sort((a, b) => a[0] - b[0]).map(entry => entry[1]),
			finishReason, ending: token.isCancellationRequested ? 'cancelled' : ending, error, promptTokens, completionTokens, firstTokenMs, totalMs: this._now() - startedAt, logprobs,
		};
		this.log.push({ request, reply });
		return reply;
	}
}
