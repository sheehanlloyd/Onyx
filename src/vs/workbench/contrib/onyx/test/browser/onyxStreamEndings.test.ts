/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { validateToolArguments } from '../../common/onyxToolArguments.js';
import { classifyStreamEnd } from '../../common/onyxTrace.js';
import { OnyxSimEpisode, OnyxSimModelTurn, SIM_FILES, SIM_TARGET_FILE } from './sim/onyxSimEpisode.js';
import { allCheckers } from './sim/onyxSimInvariants.js';
import { IOnyxSimResult } from './sim/onyxSimRig.js';
import { runEpisode } from './sim/onyxSimRun.js';

/**
 * B12 in the window (R-19 and R-28, service layer): what the agent loop does
 * with a reply that was cut off or went silent, and with a tool call whose
 * arguments do not match the tool's schema. The real loop, model provider
 * and tools run in the simulation rig; the runtime is scripted.
 */

function call(tool: string, args: unknown): OnyxSimModelTurn {
	return { kind: 'toolCall', tool, arguments: args };
}

const DONE: OnyxSimModelTurn = { kind: 'text', text: 'Done.' };

function episode(extra: Partial<OnyxSimEpisode>): OnyxSimEpisode {
	return { name: 'endings', seed: 0, persona: 'well-behaved', prompt: 'Run the tests', files: SIM_FILES, target: SIM_TARGET_FILE, turns: [DONE], dialogDefault: 'allow-once', userSteps: [], faults: [], ...extra };
}

function summarize(result: IOnyxSimResult) {
	const journal = result.journal.split('\n').filter(line => line.trim()).map(line => JSON.parse(line) as { kind: string; data: { streamEnd?: string } });
	return {
		status: result.status,
		saidWhy: result.errorMessage === undefined ? 'no message' : /ended before it was finished/.test(result.errorMessage) ? 'cut off' : /stopped sending/.test(result.errorMessage) ? 'stalled' : 'something else',
		streamEnds: journal.filter(entry => entry.kind === 'traceTurn').map(entry => entry.data.streamEnd),
		ran: result.commands.map(command => command.command),
		toolsInvoked: result.toolResults.map(entry => entry.toolId),
		endedByTheRigsWatchdog: result.trace.includes('"fault":"watchdog"'),
		violations: result.violations.map(violation => violation.invariant).filter(invariant => /^I-(03\/no-time-budget|06\/schema|11)/.test(invariant)),
	};
}

suite('OnyxStreamEndings', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('R-19: a reply that is cut off is not a reply: it is not parsed for a tool call, nothing from it runs, and the run does not complete', async () => {
		// Prose that happens to contain a whole tool call, on a stream that then ends with no finish signal.
		const prose = await runEpisode(episode({ turns: [{ kind: 'truncated', text: 'I will run it now.\n{"tool":"terminal","arguments":{"command":"npm test"}}' }, DONE] }), allCheckers());
		// A native tool call whose arguments arrived whole, on a stream cut off before its end (the fourth event: usage).
		const native = await runEpisode(episode({ turns: [call('terminal', { command: 'npm test' }), DONE], faults: [{ at: 'betweenChunks', occurrence: 4, step: { kind: 'earlyEndOfStream' } }] }), allCheckers());
		const cutOff = { status: 'failed', saidWhy: 'cut off', streamEnds: ['truncated'], ran: [], toolsInvoked: [], endedByTheRigsWatchdog: false, violations: [] };
		assert.deepStrictEqual({ prose: summarize(prose), native: summarize(native) }, { prose: cutOff, native: cutOff });
	});

	test('R-19: a request that never says anything is stopped at the deadline, and the run ends on its own as stalled', async () => {
		const result = await runEpisode(episode({ turns: [{ kind: 'stall' }] }), allCheckers());
		assert.deepStrictEqual(summarize(result), { status: 'failed', saidWhy: 'stalled', streamEnds: ['stalled'], ran: [], toolsInvoked: [], endedByTheRigsWatchdog: false, violations: [] });
	});

	test('R-28: a call whose arguments do not match the tool\'s schema is answered with what is wrong and never reaches the tool', async () => {
		const result = await runEpisode(episode({
			turns: [
				call('terminal', { cmd: 'npm test' }),
				call('terminal', { command: 'npm test', timeoutSeconds: 'forever' }),
				call('editFile', { path: 42, search: '\treturn a + b;', replace: '\treturn 0;' }),
				call('readFile', { path: 'src/math.ts', startLine: 'first' }),
				call('terminal', { command: 'npm test' }),
				DONE,
			],
		}), allCheckers());
		// What the model was told comes back in the next prompt, which the journal snapshots.
		const told = ['arguments.command is required', 'arguments.timeoutSeconds must be number, got string', 'arguments.path must be string, got number', 'arguments.startLine must be number, got string'].filter(problem => result.journal.includes(problem));
		assert.deepStrictEqual({ ...summarize(result), saysWhatIsWrong: told.length }, {
			status: 'completed', saidWhy: 'no message', streamEnds: ['tool_calls', 'tool_calls', 'tool_calls', 'tool_calls', 'tool_calls', 'stop'],
			// Only the last call, the valid one, reached a tool and ran a command.
			ran: ['npm test'], toolsInvoked: ['onyx_terminal'], endedByTheRigsWatchdog: false, violations: [], saysWhatIsWrong: 4,
		});
	});

	test('validateToolArguments: types, required, enum, nested properties and items; nothing is coerced', () => {
		const schema = {
			type: 'object',
			required: ['command'],
			properties: {
				command: { type: 'string' },
				timeoutSeconds: { type: 'number' },
				mode: { type: 'string', enum: ['fast', 'slow'] },
				paths: { type: 'array', items: { type: 'string' } },
				options: { type: 'object', properties: { depth: { type: 'integer' } }, additionalProperties: false },
			},
		};
		assert.deepStrictEqual({
			ok: validateToolArguments(schema, { command: 'ls', timeoutSeconds: 30, mode: 'fast', paths: ['a'], options: { depth: 2 }, extra: true }),
			missing: validateToolArguments(schema, { cmd: 'ls' }),
			notAnObject: validateToolArguments(schema, 'ls'),
			stringForNumber: validateToolArguments(schema, { command: 'ls', timeoutSeconds: '30' }),
			notInEnum: validateToolArguments(schema, { command: 'ls', mode: 'medium' }),
			badItem: validateToolArguments(schema, { command: 'ls', paths: ['a', 7] }),
			nested: validateToolArguments(schema, { command: 'ls', options: { depth: 1.5, color: 'red' } }),
			noSchema: validateToolArguments(undefined, { anything: 1 }),
			streamEnds: [classifyStreamEnd('stop', false, 'complete'), classifyStreamEnd(undefined, false, 'truncated'), classifyStreamEnd(undefined, false, 'stalled'), classifyStreamEnd('stop', false, 'truncated'), classifyStreamEnd(undefined, false), classifyStreamEnd(undefined, true, 'truncated')],
		}, {
			ok: [],
			missing: ['arguments.command is required'],
			notAnObject: ['arguments must be object, got string'],
			stringForNumber: ['arguments.timeoutSeconds must be number, got string'],
			notInEnum: ['arguments.mode must be one of "fast", "slow"'],
			badItem: ['arguments.paths[1] must be string, got number'],
			nested: ['arguments.options.depth must be integer, got number', 'arguments.options.color is not an argument of this tool'],
			noSchema: [],
			streamEnds: ['stop', 'truncated', 'stalled', 'truncated', 'truncated', 'error'],
		});
	});
});
