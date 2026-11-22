/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { SIM_LINK_PATH, SIM_OUTSIDE_CANARY } from './onyxSimCanary.js';
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
	// R-12 proper: the user changes the very line hunk 0 replaces, then accepts what is still shown as hunk 0.
	// It is refused; nothing of hunk 1 is applied in its place, and what the user typed stays.
	scenario('audit-n2-edit-hunk-0-then-accept-hunk-0', 'EDITTEST src/math.ts two hunks', [
		{
			kind: 'toolCalls', calls: [
				{ tool: 'editFile', arguments: { path: 'src/math.ts', search: '\treturn a + b;', replace: '\treturn b + a; // hunk 0' }, id: 'edit_1' },
				{ tool: 'editFile', arguments: { path: 'src/math.ts', search: '\treturn a * b;', replace: '\treturn b * a; // hunk 1' }, id: 'edit_2' },
			],
		},
		{ kind: 'text', text: 'Staged two hunks.' },
	], {
		userSteps: [
			{ at: 'afterRun', occurrence: 2, step: { kind: 'typeInTarget', text: '/* mine */', line: 2 } },
			{ at: 'afterRun', occurrence: 2, step: { kind: 'acceptHunk', path: 'src/math.ts', hunk: 0 } },
		],
	}),
	// Codex N3 (R-13): a function is deleted and the user accepts; the buffer has to be the proposal, with no line left where the function was.
	scenario('b8-delete-lines-then-accept-all', 'EDITTEST src/math.ts remove multiply', [
		{ kind: 'toolCall', tool: 'editFile', arguments: { path: 'src/math.ts', search: 'export function multiply(a: number, b: number): number {\n\treturn a * b;\n}\n\n', replace: '' }, id: 'edit_1' },
		{ kind: 'text', text: 'Staged the removal.' },
	], {
		userSteps: [{ at: 'afterRun', occurrence: 2, step: { kind: 'acceptAll' } }],
	}),
	// C3: several edits in one editFile call are one proposal, placed in order, or nothing.
	scenario('c3-two-edits-in-one-call-then-accept-all', 'MULTIEDITTEST src/math.ts swap the operands', [
		{ kind: 'toolCall', tool: 'editFile', arguments: { path: 'src/math.ts', edits: [{ search: '\treturn a + b;', replace: '\treturn b + a; // first of two' }, { search: '\treturn a * b;', replace: '\treturn b * a; // second of two' }] }, id: 'edit_1' },
		{ kind: 'text', text: 'Staged both edits.' },
	], {
		userSteps: [{ at: 'afterRun', occurrence: 2, step: { kind: 'acceptAll' } }],
	}),
	scenario('c3-one-edit-of-two-cannot-be-placed', 'MULTIEDITTEST src/math.ts swap the operands', [
		{ kind: 'toolCall', tool: 'editFile', arguments: { path: 'src/math.ts', edits: [{ search: '\treturn a + b;', replace: '\treturn b + a; // first of two' }, { search: '\treturn a / b;', replace: '\treturn b / a;' }] }, id: 'edit_1' },
		{ kind: 'text', text: 'The second edit was refused, so nothing is staged.' },
	]),
	// C10 (R-30, write side): an edit to a symbolic link that leaves the workspace is refused, and one to a file
	// whose name merely contains two dots is staged and accepted.
	scenario('c10-edit-through-a-link-is-refused', 'Update the linked file', [
		{ kind: 'toolCall', tool: 'editFile', arguments: { path: SIM_LINK_PATH, search: SIM_OUTSIDE_CANARY, replace: 'overwritten by the model' }, id: 'edit_1' },
		{ kind: 'text', text: 'The edit was refused.' },
	]),
	scenario('c10-a-name-with-two-dots-is-a-name', 'Add a note', [
		{ kind: 'toolCall', tool: 'editFile', arguments: { path: 'notes/v1..v2.md', search: '', replace: '# from v1 to v2\n' }, id: 'edit_1' },
		{ kind: 'text', text: 'Staged the note.' },
	], {
		userSteps: [{ at: 'afterRun', occurrence: 2, step: { kind: 'acceptAll' } }],
	}),
	// B9 (R-34): an inline edit after a run. The reply is staged; the buffer and the disk stay the user's, through a save.
	scenario('b9-inline-edit-stages-then-save', 'What does addNumbers do?', [
		{ kind: 'text', text: 'It adds two numbers.' },
	], {
		userSteps: [
			{ at: 'afterRun', occurrence: 2, step: { kind: 'inlineEdit', startLine: 1, endLine: 3, reply: '<<<<<<< SEARCH\n\treturn a + b;\n=======\n\treturn b + a; // inline\n>>>>>>> REPLACE' } },
			{ at: 'afterRun', occurrence: 2, step: { kind: 'save' } },
		],
	}),
	// B10 (R-15, I-03, I-05): Stop means stop. The first is R-15 itself at the service layer: a slow stream that
	// would end in a tool call, stopped half way. The other five are what the baseline campaign found.
	scenario('b10-stop-during-slow-stream-before-a-tool-call', 'SLOWTOOLTEST think, then list the folder', [
		{ kind: 'toolCall', tool: 'terminal', arguments: { command: 'ls src && echo ' + Array.from({ length: 40 }, (_, index) => `slow-word-${index}`).join(' ') }, chunks: 40 },
		{ kind: 'text', text: 'Listed.' },
	], {
		userSteps: [{ at: 'betweenChunks', occurrence: 10, step: { kind: 'stop' } }],
	}),
	scenario('b10-paused-and-never-resumed', 'Run the checks', [
		{ kind: 'toolCall', tool: 'terminal', arguments: { command: 'npm test' } },
	], {
		dialogDefault: 'deny',
		userSteps: [{ at: 'betweenChunks', occurrence: 3, step: { kind: 'pause' } }],
	}),
	scenario('b10-stop-then-the-stream-ends', 'What does it do?', [
		{ kind: 'text', text: 'Done.' },
	], {
		dialogDefault: 'dismiss',
		userSteps: [{ at: 'betweenChunks', occurrence: 1, step: { kind: 'stop' } }],
	}),
	scenario('b10-stop-before-a-command', 'List the folder', [
		{ kind: 'toolCall', tool: 'terminal', arguments: { command: 'ls src' } },
	], {
		userSteps: [{ at: 'beforeToolDispatch', occurrence: 1, step: { kind: 'stop' } }],
	}),
	scenario('b10-stop-before-an-edit', 'Change addNumbers', [
		{ kind: 'toolCall', tool: 'editFile', arguments: { path: 'src/math.ts', search: '\treturn a + b;', replace: '\treturn b + a; // edited-by-sim' } },
	], {
		dialogDefault: 'deny',
		userSteps: [{ at: 'beforeToolDispatch', occurrence: 1, step: { kind: 'stop' } }],
	}),
	scenario('b10-stop-while-an-approval-dialog-is-open', 'Fetch the page', [
		{ kind: 'toolCall', tool: 'vscode_fetchWebPage_internal', arguments: { url: 'https://example.test/' } },
	], {
		networkTools: true,
		profile: { promptStyle: 'compact', contextLength: 4096, maxTools: 24 },
		userSteps: [{ at: 'dialogOpen', occurrence: 1, step: { kind: 'stop' } }],
	}),
	// C2 with B2: the repository names a check task. The user accepts the edit and saves; the check then asks,
	// like any execution, and here the answer is no: nothing runs.
	scenario('c2-check-task-asks-after-accept-and-save', 'EDITTEST src/math.ts with a check configured', [
		{ kind: 'toolCall', tool: 'editFile', arguments: { path: 'src/math.ts', search: '\treturn a + b;', replace: '\treturn b + a;' }, id: 'edit_1' },
		{ kind: 'text', text: 'Staged.' },
	], {
		dialogDefault: 'deny',
		projectConfig: { verificationTask: 'test' },
		userSteps: [{ at: 'afterRun', occurrence: 2, step: { kind: 'acceptAll' } }, { at: 'afterRun', occurrence: 2, step: { kind: 'save' } }],
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
		profile: { promptStyle: 'compact', contextLength: 4096, maxTools: 8 },
		faults: Array.from({ length: 16 }, (_, index) => ({ at: 'afterToolDispatch' as const, occurrence: index + 1, step: { kind: 'outputFlood' as const, bytes: 20_000 } })),
	}),
	// R-31: the model reads the file through Onyx's own read tool, then proposes an edit whose SEARCH text is
	// the line it read back; the staged hunk must equal the content read.
	scenario('e2e-readedittest', 'READEDITTEST src/math.ts', [
		{ kind: 'toolCall', tool: 'readFile', arguments: { path: 'src/math.ts' }, id: 'read_1' },
		{ kind: 'toolCall', tool: 'editFile', arguments: { path: 'src/math.ts', search: '\treturn a + b;', replace: '\treturn a + b; // edited-by-mock' }, id: 'edit_after_read' },
		{ kind: 'text', text: 'Read the file, then staged one edit for review.' },
	]),
	// R-24: the SEARCH text is copied from the numbered read result, prefixes included. They are decoded
	// because they are provably the tool's own wrapper for the lines as they are in the file.
	scenario('b1-numbered-search-is-decoded', 'Change addNumbers in src/math.ts', [
		{ kind: 'toolCall', tool: 'readFile', arguments: { path: 'src/math.ts', startLine: 1, endLine: 3 }, id: 'read_1' },
		{ kind: 'toolCall', tool: 'editFile', arguments: { path: 'src/math.ts', search: '1| export function addNumbers(a: number, b: number): number {\n2| \treturn a + b;', replace: 'export function addNumbers(a: number, b: number): number {\n\treturn b + a;' }, id: 'edit_1' },
		{ kind: 'text', text: 'Staged.' },
	]),
	// R-30, read side: traversal, an absolute path, a symbolic link out of the workspace, and searches aimed
	// at the file outside it. Every call is refused or finds nothing; the canary never reaches the model.
	scenario('b1-read-escape-attempts', 'Show me the secret file', [
		{ kind: 'toolCall', tool: 'readFile', arguments: { path: '../outside/secret.txt' }, id: 'read_1' },
		{ kind: 'toolCall', tool: 'readFile', arguments: { path: '/outside/secret.txt' }, id: 'read_2' },
		{ kind: 'toolCall', tool: 'readFile', arguments: { path: 'link-outside.txt' }, id: 'read_3' },
		{ kind: 'toolCall', tool: 'listDirectory', arguments: { path: '../outside' }, id: 'list_1' },
		{ kind: 'toolCall', tool: 'grep', arguments: { pattern: 'CANARY' }, id: 'grep_1' },
		{ kind: 'toolCall', tool: 'findFiles', arguments: { pattern: '**/*.txt' }, id: 'find_1' },
		{ kind: 'text', text: 'I could not read anything outside the workspace.' },
	]),
	// R-36: the project excludes an essential tool. The run refuses and names it; no request is sent.
	scenario('b1-essential-tool-excluded', 'Change addNumbers in src/math.ts', [
		{ kind: 'toolCall', tool: 'editFile', arguments: { path: 'src/math.ts', search: '\treturn a + b;', replace: '\treturn b + a;' }, id: 'edit_1' },
	], {
		projectConfig: { disabledTools: ['onyx_terminal'] },
	}),
	// R-36: a profile with fewer than six slots gets the read tools and nothing that writes or executes.
	scenario('b1-read-only-profile', 'What does addNumbers do?', [
		{ kind: 'toolCall', tool: 'readFile', arguments: { path: 'src/math.ts' }, id: 'read_1' },
		{ kind: 'toolCall', tool: 'editFile', arguments: { path: 'src/math.ts', search: '\treturn a + b;', replace: '\treturn b + a;' }, id: 'edit_1' },
		{ kind: 'text', text: 'It adds two numbers.' },
	], {
		profile: { maxTools: 3 },
	}),
];
