/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ChatMessageRole, IChatMessage } from '../../../chat/common/languageModels.js';
import { effectiveContext, IOnyxBudgetedMessage, isContextOverflowError, ONYX_EVICTED_RESULT_MARKER, ONYX_EVICTION_POLICIES, OnyxEvictionPolicy, outputCapTokens, planTurn } from '../../common/onyxContextBudget.js';
import { OnyxSimEpisode, OnyxSimModelTurn, SIM_FILES, SIM_TARGET_FILE } from './sim/onyxSimEpisode.js';
import { allCheckers } from './sim/onyxSimInvariants.js';
import { IOnyxSimResult } from './sim/onyxSimRig.js';
import { runEpisode } from './sim/onyxSimRun.js';

/**
 * B13: context that fits (R-16, I-04). The service half runs the real agent
 * loop in the simulation rig against a runtime that rejects any request
 * larger than the context it allocates, the way a strict server does. The
 * pure half is the plan: what is set aside, what is dropped, in what order.
 */

const WINDOW = 8192;

/** Fifteen files of 20,000 characters, each starting with its own marker, and a command that prints one. */
const BIG_FILES = Object.fromEntries(Array.from({ length: 15 }, (_, index) => {
	const number = String(index + 1).padStart(2, '0');
	return [`big-${number}.txt`, `MARKER-${number} ${'y'.repeat(20_000)}`];
}));

function cat(number: number): OnyxSimModelTurn {
	return { kind: 'toolCall', tool: 'terminal', arguments: { command: `cat big-${String(number).padStart(2, '0')}.txt` } };
}

const DONE: OnyxSimModelTurn = { kind: 'text', text: 'Done.' };

function episode(extra: Partial<OnyxSimEpisode>): OnyxSimEpisode {
	return {
		name: 'context', seed: 0, persona: 'well-behaved', prompt: 'Print the logs one by one.', files: { ...SIM_FILES, ...BIG_FILES }, target: SIM_TARGET_FILE,
		turns: [DONE], dialogDefault: 'allow-once', userSteps: [], faults: [], profile: { promptStyle: 'full', contextLength: WINDOW, maxTools: 8 }, ...extra,
	};
}

function notes(result: IOnyxSimResult, pattern: RegExp): string[] {
	return result.journal.split('\n').filter(line => line.trim()).map(line => JSON.parse(line) as { kind: string; data: { label?: string } }).filter(entry => entry.kind === 'note' && pattern.test(entry.data.label ?? '')).map(entry => entry.data.label ?? '');
}

const text = (value: string): IChatMessage => ({ role: ChatMessageRole.User, content: [{ type: 'text', value }] });
const estimate = (message: IChatMessage) => Math.ceil(JSON.stringify(message.content).length / 4);

suite('OnyxContextBudget', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('R-16: fifteen large tool results against an 8k window and a runtime that rejects anything larger: every request fits with its output cap, whole calls are evicted oldest first and the timeline says so', async function () {
		this.timeout(60_000);
		const result = await runEpisode(episode({ turns: [...Array.from({ length: 15 }, (_, index) => cat(index + 1)), DONE], runtimeContextTokens: WINDOW }), allCheckers());
		const last = result.requests.at(-1);
		const evicted = notes(result, /^Evicted \d+ earlier tool result/);
		assert.deepStrictEqual({
			status: result.status,
			requests: result.requests.length,
			everyRequestCarriesAnOutputCap: result.requests.every(request => typeof request.maxTokens === 'number' && request.maxTokens > 0),
			everyRequestFitsWithItsOutput: result.requests.every(request => request.promptTokens + (request.maxTokens ?? 0) <= WINDOW),
			rejectedByTheRuntime: result.trace.includes('"fault":"contextOverflow"'),
			timelineSaysEvicted: evicted.length > 0,
			theNewestResultIsStillThere: last?.text.includes('MARKER-15'),
			theOldestWentFirst: last?.text.includes('MARKER-01'),
			everyCommandRan: result.commands.length,
			violations: result.violations.map(violation => violation.invariant).filter(invariant => invariant.startsWith('I-04')),
		}, {
			status: 'completed',
			requests: 16,
			everyRequestCarriesAnOutputCap: true,
			everyRequestFitsWithItsOutput: true,
			rejectedByTheRuntime: false,
			timelineSaysEvicted: true,
			theNewestResultIsStillThere: true,
			theOldestWentFirst: false,
			everyCommandRan: 15,
			violations: [],
		});
	});

	test('R-16: when the runtime allocates less than the model reports, the overflow is learned from: earlier results are dropped, the turn is sent once more, and later requests fit what was learned; a request that cannot be made smaller is reported, not sent again', async function () {
		this.timeout(60_000);
		// The model says 8k; the server allocated 4k and rejects the fourth request.
		const smaller = await runEpisode(episode({ turns: [cat(1), cat(2), cat(3), cat(4), cat(5), DONE], runtimeContextTokens: 4096 }), allCheckers());
		const afterTheOverflow = smaller.requests.slice(smaller.requests.findIndex(request => request.promptTokens > 4096) + 1);
		// A server that allocated less than the system prompt needs: the first request is rejected, there is
		// nothing to drop, and the same request is not sent again.
		const hopeless = await runEpisode(episode({ turns: [cat(1), DONE], runtimeContextTokens: 300 }), allCheckers());
		assert.deepStrictEqual({
			smaller: {
				status: smaller.status,
				overflows: smaller.trace.split('"fault":"contextOverflow"').length - 1,
				// What was learned is the size of the request that was rejected: less than the model had claimed.
				learned: smaller.observedContexts.length === 1 && smaller.observedContexts[0] < WINDOW,
				// Later requests are planned against what was learned, and the runtime accepts every one of them.
				laterRequestsFit: afterTheOverflow.length > 0 && afterTheOverflow.every(request => request.promptTokens + (request.maxTokens ?? 0) <= smaller.observedContexts[0]),
				timelineSaysSo: notes(smaller, /^The runtime rejected the prompt as too long/).length,
				everyCommandRan: smaller.commands.length,
			},
			hopeless: {
				status: hopeless.status,
				requests: hopeless.requests.length,
				saysWhy: /context window/.test(hopeless.errorMessage ?? ''),
			},
		}, {
			smaller: { status: 'completed', overflows: 1, learned: true, laterRequestsFit: true, timelineSaysSo: 1, everyCommandRan: 5 },
			hopeless: { status: 'failed', requests: 1, saysWhy: true },
		});
	});

	test('R-56: a scripted 16-turn run under each eviction policy, against a runtime that counts the prompt tokens it has to process again: every request fits under every policy (R-16), and block eviction processes fewer tokens again than oldest-first', async function () {
		this.timeout(120_000);
		// A runtime that keeps the previous prompt evaluated re-processes what follows the longest prefix the next
		// prompt shares with it. Characters over four, as the harness estimates.
		const reprocessed = (texts: readonly string[]) => texts.map((prompt, index) => {
			const previous = index === 0 ? '' : texts[index - 1];
			let common = 0;
			while (common < previous.length && common < prompt.length && previous[common] === prompt[common]) {
				common++;
			}
			return Math.ceil((prompt.length - common) / 4);
		});
		const run = async (policy: OnyxEvictionPolicy) => {
			const base = episode({ turns: [...Array.from({ length: 15 }, (_, index) => cat(index + 1)), DONE], runtimeContextTokens: WINDOW });
			// Results of about 500 tokens: several fit the window at once, so that what a policy keeps is what differs.
			const configuration = { toolCallProtocol: 'repaired-text', editProtocol: 'search-replace', promptStyle: 'full', toolResultChars: 2000, evictionPolicy: policy, contextTokens: WINDOW, turnCap: 16, verificationFeedback: true, readToolLineNumbering: true, toolSlotPolicy: 'essentials-first', maxTools: 8 };
			const result = await runEpisode(base, allCheckers(), { labHarness: { request: { manifest: 'r56', name: policy, configuration }, packaged: false } });
			const perTurn = reprocessed(result.requests.map(request => request.text));
			return {
				status: result.status,
				requests: result.requests.length,
				everyRequestFitsWithItsOutput: result.requests.every(request => request.promptTokens + (request.maxTokens ?? 0) <= WINDOW),
				rejectedByTheRuntime: result.trace.includes('"fault":"contextOverflow"'),
				// The checker that a run uses the product's own configuration fires by design here; every other one counts.
				violations: result.violations.map(violation => violation.invariant).filter(invariant => invariant !== 'R-44/configuration-not-default'),
				theNewestResultIsStillThere: result.requests.at(-1)?.text.includes('MARKER-15'),
				markers: result.requests.at(-1)?.text.split(ONYX_EVICTED_RESULT_MARKER).length! - 1 > 0,
				// The first request has nothing before it; it is the same under every policy and left out.
				reprocessedAfterTheFirst: perTurn.slice(1).reduce((sum, tokens) => sum + tokens, 0),
			};

		};
		const [oldest, block, placeholder] = [await run(ONYX_EVICTION_POLICIES[0]), await run(ONYX_EVICTION_POLICIES[1]), await run(ONYX_EVICTION_POLICIES[2])];
		const sound = (markers: boolean) => ({ status: 'completed', requests: 16, everyRequestFitsWithItsOutput: true, rejectedByTheRuntime: false, violations: [], theNewestResultIsStillThere: true, markers });
		const { reprocessedAfterTheFirst: oldestTokens, ...oldestRest } = oldest;
		const { reprocessedAfterTheFirst: blockTokens, ...blockRest } = block;
		const { reprocessedAfterTheFirst: placeholderTokens, ...placeholderRest } = placeholder;
		assert.deepStrictEqual({
			policies: ONYX_EVICTION_POLICIES,
			oldest: oldestRest, block: blockRest, placeholder: placeholderRest,
			// 32,499 tokens over turns 2 to 16 under oldest-first and 10,841 under block eviction when this was written.
			blockAsAShareOfOldest: Math.round(blockTokens / oldestTokens * 10) / 10,
			// Replacing the oldest result changes the prompt just as near its start as dropping it does, so on this
			// script the placeholder policy saves nothing. That is measured here and not required to be otherwise:
			// it is one of the three policies H-9 compares, and it is not adopted unless it wins there.
			placeholderIsWithinATenthOfOldest: Math.abs(placeholderTokens - oldestTokens) <= oldestTokens / 10,
		}, {
			policies: ['oldest-results-first', 'block-to-low-watermark', 'placeholder-results'],
			oldest: sound(false), block: sound(false), placeholder: sound(true),
			blockAsAShareOfOldest: 0.3,
			placeholderIsWithinATenthOfOldest: true,
		});
	});

	test('a window too small for the instructions and the tool schemas is refused with the numbers, before anything is sent; four thousand tokens is enough for the eight-tool agent', async function () {
		this.timeout(60_000);
		const measure = async (promptStyle: 'compact' | 'full', contextLength: number, maxTools: number) => {
			const result = await runEpisode(episode({ files: SIM_FILES, prompt: 'Change addNumbers to add the arguments in the other order.', turns: [DONE], profile: { promptStyle, contextLength, maxTools } }), allCheckers());
			const first = result.requests[0];
			return {
				status: result.status,
				requests: result.requests.length,
				tools: result.advertised[0]?.length ?? 0,
				// The eight-tool base request is about 1,400 estimated tokens; this is a bound, not that number.
				baseUnder2000: first === undefined ? 'nothing sent' : first.promptTokens < 2000,
				fitsWithItsOutput: first === undefined ? 'nothing sent' : first.promptTokens + (first.maxTokens ?? 0) <= contextLength,
				saysTheNumbers: result.errorMessage === undefined ? 'no error' : /come to about \d+ tokens, and \d+ are available/.test(result.errorMessage),
			};
		};
		const ran = (tools: number) => ({ status: 'completed', requests: 1, tools, baseUnder2000: true, fitsWithItsOutput: true, saysTheNumbers: 'no error' });
		assert.deepStrictEqual({
			compact2k: await measure('compact', 2048, 8),
			compact2kReadOnly: await measure('compact', 2048, 4),
			compact4k: await measure('compact', 4096, 8),
			compact8k: await measure('compact', 8192, 8),
			full8k: await measure('full', 8192, 8),
		}, {
			compact2k: { status: 'failed', requests: 0, tools: 0, baseUnder2000: 'nothing sent', fitsWithItsOutput: 'nothing sent', saysTheNumbers: true },
			// Four slots is the read-only set: about half the schemas, and it fits two thousand tokens.
			compact2kReadOnly: ran(4),
			compact4k: ran(8),
			compact8k: ran(8),
			full8k: ran(8),
		});
	});

	test('planTurn: schemas and the output cap come off the top; whole calls go oldest first, then history, then workspace context; the newest result is cut last; a request that cannot fit is said not to', () => {
		const call = (id: string): IOnyxBudgetedMessage => ({ kind: 'turn', message: { role: ChatMessageRole.Assistant, content: [{ type: 'tool_use', name: 'terminal', toolCallId: id, parameters: { command: id } }] } });
		const result = (id: string, chars: number): IOnyxBudgetedMessage => ({ kind: 'turn', message: { role: ChatMessageRole.User, content: [{ type: 'tool_result', toolCallId: id, value: [{ type: 'text', value: `${id}:${'r'.repeat(chars)}` }] }] } });
		const base: IOnyxBudgetedMessage[] = [
			{ kind: 'system', message: { role: ChatMessageRole.System, content: [{ type: 'text', value: 's'.repeat(400) }] } },
			{ kind: 'history', message: text('h1'.repeat(200)) },
			{ kind: 'history', message: text('h2'.repeat(200)) },
			{ kind: 'workspace', message: text('w'.repeat(800)) },
			{ kind: 'request', message: text('do the thing') },
		];
		const describe = (plan: ReturnType<typeof planTurn>) => ({
			kinds: plan.messages.map(entry => entry.kind === 'turn' ? (entry.message.content[0] as { toolCallId?: string }).toolCallId : entry.kind).join(' '),
			calls: plan.evictedCalls, results: plan.evictedResults, history: plan.evictedHistory, workspace: plan.droppedWorkspaceContext, shrank: plan.shrankNewestResults, fits: plan.fits,
			withinBudget: plan.messageTokens <= plan.messageBudgetTokens,
		});
		// About 1,000 tokens a result, and about 2,000.
		const turns = [call('a'), result('a', 4000), call('b'), result('b', 4000), call('c'), result('c', 4000)];
		const bigTurns = [call('a'), result('a', 8000), call('b'), result('b', 8000), call('c'), result('c', 8000)];
		assert.deepStrictEqual({
			caps: [2048, 4096, 8192, 32768, 131072].map(outputCapTokens),
			roomy: describe(planTurn({ messages: [...base, ...turns], contextTokens: 32768, schemaTokens: 900, estimate })),
			tight: describe(planTurn({ messages: [...base, ...bigTurns], contextTokens: 8192, schemaTokens: 900, estimate })),
			tighter: describe(planTurn({ messages: [...base, ...turns], contextTokens: 4096, schemaTokens: 900, estimate })),
			oneHugeResult: describe(planTurn({ messages: [...base, call('z'), result('z', 60_000)], contextTokens: 4096, schemaTokens: 900, estimate })),
			impossible: describe(planTurn({ messages: base, contextTokens: 1024, schemaTokens: 900, estimate })),
			effective: [effectiveContext({ architectural: 32768 }), effectiveContext({ architectural: 32768, serverConfigured: 4096 }), effectiveContext({ architectural: 32768, serverConfigured: 8192, observed: 6000 }), effectiveContext({})],
			overflowWording: ['the request exceeds the available context size', 'This model\'s maximum context length is 8192 tokens', 'prompt is too long: 9000 tokens > 8192', 'context window exceeded', 'ECONNREFUSED', '500 Internal Server Error'].map(isContextOverflowError),
		}, {
			caps: [307, 614, 1228, 4096, 4096],
			roomy: { kinds: 'system history history workspace request a a b b c c', calls: 0, results: 0, history: 0, workspace: false, shrank: false, fits: true, withinBudget: true },
			tight: { kinds: 'system history history workspace request b b c c', calls: 1, results: 1, history: 0, workspace: false, shrank: false, fits: true, withinBudget: true },
			tighter: { kinds: 'system history history workspace request c c', calls: 2, results: 2, history: 0, workspace: false, shrank: false, fits: true, withinBudget: true },
			oneHugeResult: { kinds: 'system request z z', calls: 0, results: 0, history: 2, workspace: true, shrank: true, fits: true, withinBudget: true },
			impossible: { kinds: 'system request', calls: 0, results: 0, history: 2, workspace: true, shrank: false, fits: false, withinBudget: false },
			effective: [{ tokens: 32768, source: 'architectural' }, { tokens: 4096, source: 'server' }, { tokens: 6000, source: 'observed' }, { tokens: 8192, source: 'default' }],
			overflowWording: [true, true, true, true, false, false],
		});
	});
});
