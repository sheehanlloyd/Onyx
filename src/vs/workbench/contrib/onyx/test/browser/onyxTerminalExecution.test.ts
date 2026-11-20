/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { runWithFakedTimers } from '../../../../../base/test/common/timeTravelScheduler.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ONYX_TERMINAL_OUTPUT_LIMITS, OnyxTimelineOutput } from '../../common/onyxTerminalOutput.js';
import { OnyxSimEpisode, OnyxSimModelTurn, SIM_FILES, SIM_TARGET_FILE } from './sim/onyxSimEpisode.js';
import { allCheckers } from './sim/onyxSimInvariants.js';
import { OnyxSimRig } from './sim/onyxSimRig.js';
import { runEpisode } from './sim/onyxSimRun.js';

/**
 * B5, on the renderer's side of the process boundary (R-18, service layer):
 * what the terminal service keeps of a command's output, where it runs the
 * command, what environment it asks for, and what happens to a running
 * command when the window closes. The real terminal tool and service run in
 * the simulation rig; the runtime is the rig's recording executor, which
 * hands back whatever it is told to, however large.
 */

function terminal(command: string, extra: Record<string, unknown> = {}): OnyxSimModelTurn {
	return { kind: 'toolCall', tool: 'terminal', arguments: { command, ...extra } };
}

const DONE: OnyxSimModelTurn = { kind: 'text', text: 'Done.' };

function episode(extra: Partial<OnyxSimEpisode>): OnyxSimEpisode {
	return { name: 'execution', seed: 0, persona: 'well-behaved', prompt: 'Run the build', files: SIM_FILES, target: SIM_TARGET_FILE, turns: [DONE], dialogDefault: 'allow-once', userSteps: [], faults: [], ...extra };
}

/** The classes this item owns; other classes are other items' baseline exceptions until their owners land. */
function ownViolations(violations: readonly { readonly invariant: string }[]): string[] {
	return violations.map(violation => violation.invariant).filter(invariant => /^I-(06\/cwd|07\/cwd|10|13\/(unbounded-output|command-outlives-window))/.test(invariant));
}

suite('OnyxTerminalExecution', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('the timeline keeps the start of an output in a few short notes and holds at most one unfinished note, whatever arrives', () => {
		const output = new OnyxTimelineOutput();
		const notes: string[] = [];
		let peak = 0;
		for (const size of [3, 5_000_000, 1, 70_000, 799, 801]) {
			notes.push(...output.push('y'.repeat(size)));
			peak = Math.max(peak, output.retainedChars);
		}
		assert.deepStrictEqual(
			{ notes: notes.map(note => note.length), peak, seen: output.seenChars, limits: ONYX_TERMINAL_OUTPUT_LIMITS },
			{ notes: [800, 800, 800, 800, 800, 800], peak: 3, seen: 5_071_604, limits: { timelineChunkChars: 800, timelineChunks: 6, retainedChars: 800, modelChars: 12_000 } });
	});

	test('R-18: fifty megabytes of output from an approved command leave the terminal service holding less than one timeline note and the model a bounded result', async function () {
		this.timeout(60_000);
		const result = await runEpisode(episode({
			turns: [terminal('npm run build'), DONE],
			// Twelve events of more than four megabytes each: the service's bound cannot lean on the runtime's.
			faults: [{ at: 'afterToolDispatch', occurrence: 0, step: { kind: 'outputFlood', bytes: 50 * 1024 * 1024 } }],
		}), allCheckers());
		const terminalResult = result.toolResults.find(entry => entry.toolId === 'onyx_terminal');
		assert.deepStrictEqual({
			ran: result.commands.map(command => command.command),
			heldAtMost: (result.peakRetainedOutputChars ?? Number.POSITIVE_INFINITY) <= ONYX_TERMINAL_OUTPUT_LIMITS.retainedChars,
			modelResultBounded: (terminalResult?.text.length ?? Number.POSITIVE_INFINITY) <= ONYX_TERMINAL_OUTPUT_LIMITS.modelChars + 600,
			modelResultSaysHowMuch: /52428800 characters/.test(terminalResult?.text ?? ''),
			violations: ownViolations(result.violations),
		}, {
			ran: ['npm run build'],
			heldAtMost: true,
			modelResultBounded: true,
			modelResultSaysHowMuch: true,
			violations: [],
		});
	});

	test('a command runs in the directory of the workspace the call names, and a directory outside the workspace is refused before anyone is asked', () => runWithFakedTimers({ useFakeTimers: true, maxTaskCount: 200_000 }, async () => {
		const rig = new OnyxSimRig(episode({}));
		const calls: Record<string, unknown> = {};
		try {
			await rig.prepare();
			await rig.linkDirectory('linked-dir', '/outside');
			for (const cwd of [undefined, '.', 'src', 'src/', '../outside', '/outside', 'src/../..', 'src/math.ts', 'no-such-dir', 'linked-dir', 42]) {
				const before = { commands: rig.runtime.commands.length, dialogs: rig.dialogs.prompts.length };
				const result = await rig.invokeTool('terminal', { command: 'ls', ...(cwd === undefined ? {} : { cwd }) });
				const ran = rig.runtime.commands.slice(before.commands).map(command => command.cwd);
				const asked = rig.dialogs.prompts.slice(before.dialogs).map(prompt => /^Working directory: (?<cwd>.*)$/m.exec(prompt.detail)?.groups?.cwd);
				calls[String(cwd)] = ran.length ? { ranIn: ran[0], promptSaid: asked[0] } : { refused: !result.ok, asked: asked.length };
			}
		} finally {
			await rig.dispose();
		}
		const refused = { refused: true, asked: 0 };
		assert.deepStrictEqual(calls, {
			'undefined': { ranIn: '/ws', promptSaid: '/ws' },
			'.': { ranIn: '/ws', promptSaid: '/ws' },
			'src': { ranIn: '/ws/src', promptSaid: '/ws/src' },
			'src/': { ranIn: '/ws/src', promptSaid: '/ws/src' },
			'../outside': refused,
			'/outside': refused,
			'src/../..': refused,
			'src/math.ts': refused,
			'no-such-dir': refused,
			'linked-dir': refused,
			'42': refused,
		});
	}));

	test('variables that are secrets by name are withheld from a command unless the user turned onyx.terminal.passEnvironment on, and then the prompt says so', async () => {
		const summarize = async (passEnvironment: boolean) => {
			// The command fails: that is when a withheld credential is worth mentioning to the model.
			const result = await runEpisode(episode({
				turns: [terminal('npm test'), DONE],
				faults: [{ at: 'afterToolDispatch', occurrence: 0, step: { kind: 'commandExit', exitCode: 1 } }],
				...(passEnvironment ? { passEnvironment } : {}),
			}), allCheckers());
			return {
				askedForWholeEnvironment: result.commands.map(command => command.passEnvironment),
				promptMentionsEnvironment: result.dialogs.map(dialog => /environment/i.test(dialog.detail)),
				modelToldWhatWasWithheld: result.toolResults.filter(entry => entry.toolId === 'onyx_terminal').map(entry => /2 environment variables/.test(entry.text)),
				secretValuesInResult: result.toolResults.some(entry => /sim-token-1f0c|sim-secret-9be2/.test(entry.text)),
				violations: ownViolations(result.violations),
			};
		};
		assert.deepStrictEqual({ byDefault: await summarize(false), optedIn: await summarize(true) }, {
			byDefault: { askedForWholeEnvironment: [false], promptMentionsEnvironment: [false], modelToldWhatWasWithheld: [true], secretValuesInResult: false, violations: [] },
			optedIn: { askedForWholeEnvironment: [true], promptMentionsEnvironment: [true], modelToldWhatWasWithheld: [false], secretValuesInResult: false, violations: [] },
		});
	});

	test('R-18: a command that is running when the window closes is killed', async () => {
		const result = await runEpisode(episode({
			turns: [terminal('npm run watch'), DONE],
			userSteps: [{ at: 'commandRunning', occurrence: 1, step: { kind: 'closeWindow' } }],
		}), allCheckers());
		assert.deepStrictEqual({
			ran: result.commands.map(command => command.command),
			killed: result.trace.split('\n').some(line => line.includes('"kind":"commandResult"') && line.includes('"killed":true')),
			violations: ownViolations(result.violations),
		}, {
			ran: ['npm run watch'],
			killed: true,
			violations: [],
		});
	});

	test('R-40: on a platform the runner does not support, the tool says so and nothing is dispatched', async () => {
		const result = await runEpisode(episode({ turns: [terminal('npm test'), DONE], commandRefusal: 'unsupported-platform' }), allCheckers());
		const terminalResult = result.toolResults.find(entry => entry.toolId === 'onyx_terminal');
		assert.deepStrictEqual({
			dispatched: result.commands.length,
			ok: terminalResult?.ok,
			saysWhy: /not supported on this platform/.test(terminalResult?.text ?? ''),
			saysItRan: /Command finished/.test(terminalResult?.text ?? ''),
		}, {
			dispatched: 0,
			ok: false,
			saysWhy: true,
			saysItRan: false,
		});
	});
});
