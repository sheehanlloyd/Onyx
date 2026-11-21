/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import type * as http from 'http';
import { AddressInfo } from 'net';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { OnyxRuntimeService } from '../../../../../platform/onyxRuntime/node/onyxRuntimeService.js';
import { IOnyxDatasheet, measuredContextTokens } from '../../common/onyxDatasheet.js';
import { OnyxRuntimeProbeTransport, runDatasheetProbes } from '../../common/onyxDatasheetProbes.js';

/**
 * R-45, the node half (L5): the probe suite against runtimes whose behaviour
 * is known, through the real runtime service and a real HTTP server. Each
 * mock is told what to do; the datasheet has to say what it did, in counts.
 */

interface IMockBehaviour {
	/** A call on the tool channel, the call written as JSON text, or prose with no call in it. */
	readonly toolCalls: 'native' | 'text' | 'prose';
	/** Whether a `response_format` schema decides the reply. */
	readonly enforcesSchema: boolean;
	/** The prompt is cut to its last this-many tokens (four characters each) before it is "read". */
	readonly contextTokens: number;
	/** Whether the same seed gives the same reply. */
	readonly deterministic: boolean;
	readonly honoursCapAndStop: boolean;
	readonly logprobs: boolean;
	readonly reasoning: 'none' | 'tags' | 'field';
	/** Every request fails with this status. */
	readonly failsWith?: number;
}

interface IChatBody {
	readonly messages: readonly { readonly role: string; readonly content: string | null }[];
	readonly tools?: readonly object[];
	readonly response_format?: { readonly json_schema?: { readonly name?: string } };
	readonly max_tokens?: number;
	readonly stop?: readonly string[];
	readonly seed?: number;
	readonly logprobs?: boolean;
}

suite('OnyxDatasheetProbes', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	async function serve(behaviour: IMockBehaviour): Promise<{ readonly baseUrl: string; readonly bodies: IChatBody[]; close(): Promise<void> }> {
		const { createServer } = await import('http');
		const bodies: IChatBody[] = [];
		let counter = 0;
		const server = createServer((request: http.IncomingMessage, response: http.ServerResponse) => {
			let raw = '';
			request.setEncoding('utf8');
			request.on('data', chunk => { raw += chunk; });
			request.on('end', () => {
				if (behaviour.failsWith) {
					response.writeHead(behaviour.failsWith, { 'Content-Type': 'text/plain' });
					response.end('the model could not be loaded');
					return;
				}
				const body = JSON.parse(raw) as IChatBody;
				bodies.push(body);
				const prompt = body.messages.at(-1)?.content ?? '';
				const chunk = (delta: object, finish: string | null, extra: object = {}) => `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish, ...extra }] })}\n\n`;
				let promptTokens = Math.ceil(prompt.length / 4);
				let completionTokens = 8;
				let finish = 'stop';
				const parts: string[] = [];
				const say = (text: string, extra: object = {}) => parts.push(chunk({ content: text }, null, extra));

				if (body.tools?.length) {
					const path = /the file (?<path>\S+) contain/.exec(prompt)?.groups?.path ?? 'unknown';
					if (behaviour.toolCalls === 'native') {
						parts.push(chunk({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'readFile', arguments: JSON.stringify({ path }) } }] }, null));
						finish = 'tool_calls';
					} else {
						say(behaviour.toolCalls === 'text' ? JSON.stringify({ tool: 'readFile', arguments: { path } }) : `I would open ${path} and look.`);
					}
				} else if (body.response_format) {
					const instances: Record<string, object> = { object: { answer: 'red' }, enum: { color: 'green' }, nested: { file: { path: 'src/math.ts', lines: { start: 1, end: 10 } } } };
					say(behaviour.enforcesSchema ? JSON.stringify(instances[body.response_format.json_schema?.name ?? ''] ?? {}) : 'The sky is blue, and src/math.ts comes first.');
				} else if (prompt.includes('Remember this code')) {
					// A runtime with a smaller context keeps the end of the prompt and loses its start.
					const kept = promptTokens > behaviour.contextTokens ? prompt.slice(prompt.length - behaviour.contextTokens * 4) : prompt;
					promptTokens = Math.min(promptTokens, behaviour.contextTokens);
					say(/ZEBRA-\d+/.exec(kept)?.[0] ?? 'I was not given a code.');
				} else if (prompt.includes('Count from 1 to 100')) {
					if (behaviour.honoursCapAndStop) {
						say('1\n2\n3\n4\n5\n6');
						completionTokens = body.max_tokens ?? 0;
						finish = 'length';
					} else {
						say(Array.from({ length: 60 }, (_, index) => index + 1).join('\n'));
						completionTokens = 120;
					}
				} else if (prompt.includes('Count from 1 to 6')) {
					say(behaviour.honoursCapAndStop && body.stop?.includes('4') ? '1 2 3 ' : '1 2 3 4 5 6');
				} else if (prompt.includes('17 plus 25')) {
					if (behaviour.reasoning === 'field') {
						parts.push(chunk({ content: '', reasoning: '17 and 25 make 42.' }, null));
						say('42');
					} else {
						say(behaviour.reasoning === 'tags' ? '<think>17 and 25 make 42.</think>42' : '42');
					}
				} else if (prompt.includes('about the sea')) {
					say(behaviour.deterministic ? `The sea is wide (${body.seed}).` : `The sea is wide, said the ${++counter}th gull.`);
				} else if (prompt.includes('Say hello')) {
					say('Hello there.', behaviour.logprobs && body.logprobs ? { logprobs: { content: [{ token: 'Hello', logprob: -0.1 }] } } : {});
				} else {
					say('Version control keeps every change to a project and who made it. '.repeat(8));
					completionTokens = 130;
				}
				response.writeHead(200, { 'Content-Type': 'text/event-stream' });
				response.write(parts.join(''));
				response.write(chunk({}, finish));
				response.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens } })}\n\n`);
				response.end('data: [DONE]\n\n');
			});
		});
		await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
		const { port } = server.address() as AddressInfo;
		return {
			baseUrl: `http://127.0.0.1:${port}/v1`,
			bodies,
			close: () => new Promise(resolve => {
				server.closeAllConnections();
				server.close(() => resolve());
			}),
		};
	}

	/** Runs the suite against a mock and returns the datasheet without its date, and what the suite sent. */
	async function measure(behaviour: IMockBehaviour, loadedAtStart: boolean | undefined = false, context: { readonly serverContextTokens?: number; readonly requestedContextTokens?: number; readonly contextMechanism?: 'derived-model' } = {}): Promise<{ readonly datasheet: Omit<IOnyxDatasheet, 'measuredAt' | 'speed'>; readonly speed: IOnyxDatasheet['speed']; readonly bodies: IChatBody[] }> {
		const server = await serve(behaviour);
		const disposables = store.add(new DisposableStore());
		try {
			const service = disposables.add(new OnyxRuntimeService(new NullLogService()));
			// A clock that moves ten milliseconds every time it is read: timings come out the same on every machine.
			let clock = 0;
			const transport = new OnyxRuntimeProbeTransport(service, { baseUrl: server.baseUrl, model: 'mock-coder:7b' }, 'probe', () => clock += 10);
			const { measuredAt, speed, ...datasheet } = await runDatasheetProbes(transport, { model: 'mock-coder:7b', digest: 'abc123', runtime: 'ollama', runtimeVersion: '0.0.1', serverContextTokens: undefined, ...context, loadedAtStart }, CancellationToken.None,
				{ toolTrials: 4, trials: 3, ...(context.serverContextTokens === undefined ? { maxContextProbeTokens: 8192 } : {}), now: () => new Date('2026-11-21T00:00:00Z') });
			assert.strictEqual(measuredAt, '2026-11-21T00:00:00.000Z');
			return { datasheet, speed, bodies: server.bodies };
		} finally {
			disposables.dispose();
			await server.close();
		}
	}

	const STRICT_SMALL: IMockBehaviour = { toolCalls: 'text', enforcesSchema: true, contextTokens: 3000, deterministic: true, honoursCapAndStop: true, logprobs: false, reasoning: 'none' };
	const LAX_LARGE: IMockBehaviour = { toolCalls: 'native', enforcesSchema: false, contextTokens: 1_000_000, deterministic: false, honoursCapAndStop: false, logprobs: true, reasoning: 'tags' };

	test('R-45: a model that writes its tool calls as text, on a runtime that enforces schemas and allocates 3,000 tokens: the datasheet says each of those, in counts', async function () {
		this.timeout(60_000);
		const { datasheet, speed, bodies } = await measure(STRICT_SMALL);
		assert.deepStrictEqual({ datasheet, speed, requests: bodies.length, toolRequestsCarriedTheTool: bodies.filter(body => body.tools?.length).length }, {
			datasheet: {
				version: 2, model: 'mock-coder:7b', digest: 'abc123', runtime: { name: 'ollama', version: '0.0.1' },
				nativeToolCalls: { successes: 0, trials: 4 },
				repairableTextCalls: { successes: 4, trials: 4 },
				schemaEnforced: { object: { successes: 3, trials: 3 }, enum: { successes: 3, trials: 3 }, nested: { successes: 3, trials: 3 } },
				// 1,024 and 2,048 recalled, 4,096 lost; then the gap halved twice: 3,072 lost, 2,560 recalled.
				context: {
					recalledUpToTokens: 2560, failedFromTokens: 3072, serverReportedTokens: null, requestedTokens: null, verifiedTokens: null, cutObserved: false, mechanism: null,
					steps: [{ promptTokens: 1024, recalled: true, sentTokens: 1024 }, { promptTokens: 2048, recalled: true, sentTokens: 2048 }, { promptTokens: 4096, recalled: false, sentTokens: 4096 }, { promptTokens: 3072, recalled: false, sentTokens: 3072 }, { promptTokens: 2560, recalled: true, sentTokens: 2560 }],
				},
				outputCapHonoured: { successes: 3, trials: 3 },
				stopHonoured: { successes: 3, trials: 3 },
				reasoning: { style: 'none', replies: { successes: 0, trials: 3 } },
				seedRepeatable: { successes: 3, trials: 3 },
				logprobs: { successes: 0, trials: 3 },
				unmeasured: [],
			},
			// The clock moves 10 ms a reading: first token at 10 ms, 130 tokens in the 10 ms after it.
			speed: { coldFirstTokenMs: 10, warmFirstTokenMs: 10, tokensPerSecond: 13_000 },
			requests: 4 + 9 + 5 + 6 + 3 + 6 + 3 + 1,
			toolRequestsCarriedTheTool: 4,
		});
	});

	test('R-61: when the server says what it allocated, the probe goes past it on purpose: a context that is really served is verified with the cut seen, and one the server only claims is not', async function () {
		this.timeout(60_000);
		// The runtime serves 3,000 tokens. Once it says so, and the context was asked for; once it claims 12,000.
		const honest = await measure(STRICT_SMALL, false, { serverContextTokens: 3000, requestedContextTokens: 3000, contextMechanism: 'derived-model' });
		const claimed = await measure(STRICT_SMALL, false, { serverContextTokens: 12_000 });
		assert.deepStrictEqual({ honest: honest.datasheet.context, honestBudget: measuredContextTokens({ ...honest.datasheet, measuredAt: '', speed: honest.speed }), claimed: claimed.datasheet.context, claimedBudget: measuredContextTokens({ ...claimed.datasheet, measuredAt: '', speed: claimed.speed }) }, {
			honest: {
				recalledUpToTokens: 2700, failedFromTokens: null, serverReportedTokens: 3000, requestedTokens: 3000, verifiedTokens: 3000, cutObserved: true, mechanism: 'derived-model',
				steps: [
					{ promptTokens: 1024, recalled: true, sentTokens: 1024, role: 'control' }, { promptTokens: 2048, recalled: true, sentTokens: 2048, role: 'control' },
					{ promptTokens: 2700, recalled: true, sentTokens: 2700, role: 'inside' }, { promptTokens: 3750, recalled: false, sentTokens: 3750, role: 'past' },
				],
			},
			honestBudget: 3000,
			claimed: {
				recalledUpToTokens: 2048, failedFromTokens: 4096, serverReportedTokens: 12_000, requestedTokens: null, verifiedTokens: null, cutObserved: false, mechanism: null,
				steps: [
					{ promptTokens: 1024, recalled: true, sentTokens: 1024, role: 'control' }, { promptTokens: 2048, recalled: true, sentTokens: 2048, role: 'control' },
					{ promptTokens: 4096, recalled: false, sentTokens: 4096, role: 'control' },
				],
			},
			// The longest prompt that kept its start: less than was claimed, and less than is served.
			claimedBudget: 2048,
		});
	});

	test('R-45: a model that calls tools natively, on a runtime that ignores schemas, caps, stops and seeds: the datasheet says each of those too', async function () {
		this.timeout(60_000);
		const { datasheet, speed } = await measure(LAX_LARGE, true);
		assert.deepStrictEqual({ datasheet, speed }, {
			datasheet: {
				version: 2, model: 'mock-coder:7b', digest: 'abc123', runtime: { name: 'ollama', version: '0.0.1' },
				nativeToolCalls: { successes: 4, trials: 4 },
				// Every reply had a native call, so there was none left to read as text.
				repairableTextCalls: { successes: 0, trials: 0 },
				schemaEnforced: { object: { successes: 0, trials: 3 }, enum: { successes: 0, trials: 3 }, nested: { successes: 0, trials: 3 } },
				// No limit found up to the largest prompt the probe was allowed to send.
				context: {
					recalledUpToTokens: 8192, failedFromTokens: null, serverReportedTokens: null, requestedTokens: null, verifiedTokens: null, cutObserved: false, mechanism: null,
					steps: [{ promptTokens: 1024, recalled: true, sentTokens: 1024 }, { promptTokens: 2048, recalled: true, sentTokens: 2048 }, { promptTokens: 4096, recalled: true, sentTokens: 4096 }, { promptTokens: 8192, recalled: true, sentTokens: 8192 }],
				},
				outputCapHonoured: { successes: 0, trials: 3 },
				stopHonoured: { successes: 0, trials: 3 },
				reasoning: { style: 'tags', replies: { successes: 3, trials: 3 } },
				seedRepeatable: { successes: 0, trials: 3 },
				logprobs: { successes: 3, trials: 3 },
				unmeasured: [{ probe: 'cold first token', reason: 'the model was already loaded when the measurement began' }],
			},
			speed: { coldFirstTokenMs: null, warmFirstTokenMs: 10, tokensPerSecond: 13_000 },
		});
	});

	test('R-45: prose where a call was asked for is neither a native call nor a readable one; thinking in a field of its own is seen as that', async function () {
		this.timeout(60_000);
		const { datasheet } = await measure({ ...STRICT_SMALL, toolCalls: 'prose', reasoning: 'field' });
		assert.deepStrictEqual({ native: datasheet.nativeToolCalls, repairable: datasheet.repairableTextCalls, reasoning: datasheet.reasoning }, {
			native: { successes: 0, trials: 4 },
			repairable: { successes: 0, trials: 4 },
			reasoning: { style: 'field', replies: { successes: 3, trials: 3 } },
		});
	});

	test('R-45: a runtime that fails every request measures nothing: no tally has a trial, and each probe says why in the runtime\'s words', async function () {
		this.timeout(60_000);
		const { datasheet, speed } = await measure({ ...STRICT_SMALL, failsWith: 500 }, undefined);
		const none = { successes: 0, trials: 0 };
		assert.deepStrictEqual({
			tallies: [datasheet.nativeToolCalls, datasheet.repairableTextCalls, datasheet.schemaEnforced.object, datasheet.schemaEnforced.enum, datasheet.schemaEnforced.nested, datasheet.outputCapHonoured, datasheet.stopHonoured, datasheet.reasoning.replies, datasheet.seedRepeatable, datasheet.logprobs],
			context: { recalledUpToTokens: datasheet.context.recalledUpToTokens, failedFromTokens: datasheet.context.failedFromTokens },
			speed,
			unmeasured: datasheet.unmeasured.map(entry => entry.probe),
			everyReasonIsTheRuntimes: datasheet.unmeasured.filter(entry => !['context', 'cold first token'].includes(entry.probe)).every(entry => entry.reason.includes('500') && entry.reason.includes('the model could not be loaded')),
		}, {
			tallies: [none, none, none, none, none, none, none, none, none, none],
			// The shortest prompt was not recalled: a limit below it, or no answer at all. Either way nothing was measured.
			context: { recalledUpToTokens: null, failedFromTokens: 1024 },
			speed: { coldFirstTokenMs: null, warmFirstTokenMs: null, tokensPerSecond: null },
			unmeasured: ['tool calls', 'schema enforcement (object)', 'schema enforcement (enum)', 'schema enforcement (nested)', 'context', 'output cap', 'stop sequence', 'reasoning', 'seed', 'log-probabilities', 'speed', 'cold first token'],
			everyReasonIsTheRuntimes: true,
		});
	});
});
