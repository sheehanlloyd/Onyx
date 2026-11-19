/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { OnyxSimEpisode, SIM_FILES, SIM_TARGET_FILE } from './onyxSimEpisode.js';

/**
 * The end-to-end mock scenarios as episode scripts (L1): what
 * `mock-ollama.mts` answers to TOOLTEST, EDITTEST, TERMTEST and SLOWTEST, in
 * the same data form the rig consumes. `test/onyx/sim/export-episodes.mts`
 * writes these to `test/onyx/sim/episodes/*.json`, which the mock replays
 * over the real SSE path (`ONYX_MOCK_EPISODE`), so one episode runs at the
 * service layer in milliseconds and again through the node and end-to-end
 * layers. A self-check keeps the JSON files equal to this source.
 */

function scenario(name: string, prompt: string, turns: OnyxSimEpisode['turns'], extra: Partial<OnyxSimEpisode> = {}): OnyxSimEpisode {
	return {
		name,
		seed: 0,
		persona: 'well-behaved',
		prompt,
		files: SIM_FILES,
		target: SIM_TARGET_FILE,
		turns,
		dialogDefault: 'allow-once',
		userSteps: [],
		faults: [],
		...extra,
	};
}

export const SIM_SCENARIOS: readonly OnyxSimEpisode[] = [
	scenario('e2e-tooltest', 'TOOLTEST exercise the tool loop', [
		{ kind: 'toolCall', tool: 'terminal', arguments: { command: 'git status' }, id: 'call_1' },
		{ kind: 'text', text: 'Hello from the model! Tool result received; task complete. All inference is local.' },
	]),
	scenario('e2e-edittest', 'EDITTEST src/math.ts stage an edit for review', [
		{
			kind: 'toolCalls', calls: [
				{ tool: 'editFile', arguments: { path: 'src/math.ts', search: 'return a + b;', replace: 'return b + a; // edited-by-mock' }, id: 'edit_1' },
				{ tool: 'editFile', arguments: { path: 'src/math.ts', search: 'return a * b;', replace: 'return b * a; // edited-by-mock' }, id: 'edit_2' },
			],
		},
		{ kind: 'text', text: 'Staged two edits for review in Onyx Changes.' },
	], {
		userSteps: [{ at: 'afterRun', occurrence: 2, step: { kind: 'acceptAll' } }],
	}),
	scenario('e2e-termtest', 'TERMTEST echo onyx-e2e-terminal-ok', [
		{ kind: 'toolCall', tool: 'terminal', arguments: { command: 'echo onyx-e2e-terminal-ok' }, id: 'term_1' },
		{ kind: 'text', text: 'The command ran and exited with code 0.' },
	], {
		userSteps: [{ at: 'dialogOpen', occurrence: 1, step: { kind: 'dialog', decision: 'allow-once' } }],
	}),
	scenario('e2e-termtest-denied', 'TERMTEST rm -rf node_modules', [
		{ kind: 'toolCall', tool: 'terminal', arguments: { command: 'rm -rf node_modules' }, id: 'term_1' },
		{ kind: 'text', text: 'The user denied the command; I did not retry it.' },
	], {
		dialogDefault: 'deny',
	}),
	scenario('e2e-slowtest-stop', 'SLOWTEST take your time with this one', [
		{ kind: 'text', text: Array.from({ length: 100 }, (_, index) => `slow-word-${index}`).join(' '), chunks: 100 },
	], {
		userSteps: [{ at: 'betweenChunks', occurrence: 20, step: { kind: 'stop' } }],
	}),
	scenario('e2e-readedittest-no-read-tool', 'READEDITTEST src/math.ts', [
		{ kind: 'text', text: 'I have no read tool: readFile was not offered, so I cannot read the file before editing it.' },
	]),
];
