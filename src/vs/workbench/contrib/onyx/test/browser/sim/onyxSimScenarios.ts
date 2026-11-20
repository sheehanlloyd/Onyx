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
	// Codex N2: hunk 0 is invalidated by the user's typing above it, then the user accepts what was shown as
	// hunk 0; nothing from hunk 1 may be applied and the typed text must survive (I-09).
	scenario('audit-n2-type-above-then-accept-hunk-0', 'EDITTEST src/math.ts two hunks', [
		{
			kind: 'toolCalls', calls: [
				{ tool: 'editFile', arguments: { path: 'src/math.ts', search: '\treturn a + b;', replace: '\treturn b + a; // hunk 0' }, id: 'edit_1' },
				{ tool: 'editFile', arguments: { path: 'src/math.ts', search: '\treturn a * b;', replace: '\treturn b * a; // hunk 1' }, id: 'edit_2' },
			],
		},
		{ kind: 'text', text: 'Staged two hunks.' },
	], {
		userSteps: [
			{ at: 'afterRun', occurrence: 2, step: { kind: 'typeInTarget', text: '// user typed above hunk 0\n', line: 1 } },
			{ at: 'afterRun', occurrence: 2, step: { kind: 'acceptHunk', path: 'src/math.ts', hunk: 0 } },
		],
	}),
	// Claude H4: a proposal against base V, the buffer edited above the hunk so that duplicates shift; accepting
	// must re-anchor to the right duplicate or conflict, never the first occurrence by default.
	scenario('audit-h4-duplicates-shift-then-accept', 'EDITTEST src/math.ts the closing brace', [
		{ kind: 'toolCall', tool: 'editFile', arguments: { path: 'src/math.ts', search: '\treturn a * b;\n}', replace: '\treturn a * b;\n} // multiply' }, id: 'edit_1' },
		{ kind: 'text', text: 'Staged.' },
	], {
		userSteps: [
			{ at: 'afterRun', occurrence: 2, step: { kind: 'typeInTarget', text: 'export function extra(): number {\n\treturn 0;\n}\n', line: 1 } },
			{ at: 'afterRun', occurrence: 2, step: { kind: 'acceptHunk', path: 'src/math.ts', hunk: 0 } },
		],
	}),
	// Claude H6 / Codex N9: an 8k-token profile and sixteen turns of large tool results; the prompt must never
	// exceed the budget and every request must carry max_tokens (I-04).
	scenario('audit-h6-context-budget', 'Run the checks until they pass.', Array.from({ length: 16 }, (): OnyxSimEpisode['turns'][number] => ({ kind: 'toolCall', tool: 'terminal', arguments: { command: 'npm test' } })), {
		dialogDefault: 'allow-once',
		profile: { promptStyle: 'compact', contextLength: 2048, maxTools: 8 },
		faults: Array.from({ length: 16 }, (_, index) => ({ at: 'afterToolDispatch' as const, occurrence: index + 1, step: { kind: 'outputFlood' as const, bytes: 20_000 } })),
	}),
	scenario('e2e-readedittest-no-read-tool', 'READEDITTEST src/math.ts', [
		{ kind: 'text', text: 'I have no read tool: readFile was not offered, so I cannot read the file before editing it.' },
	]),
];
