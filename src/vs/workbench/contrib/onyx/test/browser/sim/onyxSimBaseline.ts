/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { OnyxSimEpisode, SIM_FILES } from './onyxSimEpisode.js';

/**
 * The baseline exceptions (L2, R-42): every violation class the simulator
 * found on the unmodified harness, the audit finding it corresponds to, the
 * item that owns the fix, and the shrunk script that reproduces it. The
 * exporter writes this table to `test/onyx/sim/baseline-exceptions.json` and
 * each script to `test/onyx/sim/baseline/<class>.json`. A class that is not
 * here fails the campaign: new violations are triaged, never ignored. When an
 * owner item lands, its class comes out of this table and the gate must show
 * zero violations of that invariant (Section 12, Assurance).
 *
 * Generated from the shrunk scripts of the 2026-11-19 baseline campaign
 * (1,000 seeded episodes from seed 1 plus the scripted scenarios), then
 * annotated by hand.
 */

export interface IOnyxSimBaselineException {
	/** `<invariant>/<class>` as the checkers report it. */
	readonly class: string;
	readonly owner: string;
	readonly finding: string;
	/** The shrunk script, or the name of the scripted scenario that reproduces the class. */
	readonly script: OnyxSimEpisode;
}

const SIM_FILE_TEXT = SIM_FILES;

function repeat(marker: string): string {
	const match = /^<<repeat:(?<char>.):(?<count>\d+)>>$/.exec(marker);
	return match?.groups ? match.groups.char.repeat(Number(match.groups.count)) : marker;
}

function script(episode: Omit<OnyxSimEpisode, 'files'>): OnyxSimEpisode {
	return {
		...episode,
		files: SIM_FILE_TEXT,
		turns: episode.turns.map(turn => turn.kind === 'toolCall' && typeof turn.arguments === 'object' && turn.arguments !== null && typeof (turn.arguments as { replace?: unknown }).replace === 'string'
			? { ...turn, arguments: { ...(turn.arguments as Record<string, unknown>), replace: repeat((turn.arguments as { replace: string }).replace) } }
			: turn),
	};
}

export const BASELINE_EXCEPTIONS: readonly IOnyxSimBaselineException[] = [
	{
		class: 'I-03/no-time-budget',
		owner: 'B10',
		finding: 'Codex N5 (R-15): a run the user paused and did not resume never ends on its own. (The other way into this class, a stream that never produces a token, was closed by B12\'s deadlines.)',
		script: script({
			name: 'I-03-no-time-budget',
			seed: 28,
			persona: 'obedient',
			prompt: 'Run the',
			target: 'src/math.ts',
			turns: [
				{
					kind: 'toolCall',
					tool: 'terminal',
					arguments: {
						command: 'rm -rf /',
					},
				},
			],
			dialogDefault: 'deny',
			userSteps: [
				{
					at: 'betweenChunks',
					occurrence: 3,
					step: {
						kind: 'pause',
					},
				},
			],
			faults: [],
		}),
	},
	{
		class: 'I-03/status-overwritten',
		owner: 'B10',
		finding: 'Codex N5 (R-15): Stop sets `cancelled`, and the loop then records `completed` when the stream ends without a tool call',
		script: script({
			name: 'I-03-status-overwritten',
			seed: 30,
			persona: 'well-behaved',
			prompt: 'Run the',
			target: 'src/math.ts',
			turns: [
				{
					kind: 'text',
					text: 'Done.',
				},
			],
			dialogDefault: 'dismiss',
			// Stop while the reply is streaming. (Until B12 this script was a stream that never said anything,
			// stopped by the rig's watchdog; such a run now ends at the product's own deadline.)
			userSteps: [
				{
					at: 'betweenChunks',
					occurrence: 1,
					step: {
						kind: 'stop',
					},
				},
			],
			faults: [],
		}),
	},
	{
		class: 'I-05/command-after-stop',
		owner: 'B10',
		finding: 'Codex N5 (R-15): Stop is honoured only at the gate after a tool turn; a command dispatched in the current turn still runs',
		script: script({
			name: 'I-05-command-after-stop',
			seed: 172,
			persona: 'well-behaved',
			prompt: 'Run the',
			target: 'src/math.ts',
			turns: [
				{
					kind: 'toolCall',
					tool: 'terminal',
					arguments: {
						command: 'ls src',
					},
				},
			],
			dialogDefault: 'allow-once',
			userSteps: [
				{
					at: 'beforeToolDispatch',
					occurrence: 1,
					step: {
						kind: 'stop',
					},
				},
			],
			faults: [],
		}),
	},
	{
		class: 'I-05/dispatch-after-stop',
		owner: 'B10',
		finding: 'Codex N5 (R-15), found by the 20,000-episode campaign in Module 2: Stop is honoured only at the gate after a tool turn; a tool whose approval dialog was open when the user pressed Stop is still dispatched when the dialog is answered',
		script: script({
			name: 'I-05-dispatch-after-stop',
			seed: 5545,
			persona: 'squatter',
			prompt: 'Run the',
			target: 'src/math.ts',
			turns: [
				{
					kind: 'toolCall',
					tool: 'vscode_fetchWebPage_internal',
					arguments: {
						command: 'echo sq',
						path: 'src/ma',
						url: 'https:',
						task: 'build',
						newName: 'x',
					},
				},
			],
			dialogDefault: 'allow-once',
			userSteps: [
				{
					at: 'dialogOpen',
					occurrence: 1,
					step: {
						kind: 'stop',
					},
				},
			],
			faults: [],
			profile: {
				promptStyle: 'compact',
				contextLength: 4096,
				maxTools: 24,
			},
			networkTools: true,
		}),
	},
	{
		class: 'I-05/stage-after-stop',
		owner: 'B10',
		finding: 'Codex N5 (R-15): Stop is honoured only at the gate after a tool turn; an edit in the current turn is still staged',
		script: script({
			name: 'I-05-stage-after-stop',
			seed: 68,
			persona: 'looping',
			prompt: 'Tidy ',
			target: 'src/math.ts',
			turns: [
				{
					kind: 'toolCall',
					tool: 'editFile',
					arguments: {
						path: 'src/math.ts',
						search: '\treturn a + b;',
						replace: '\treturn b + a; // edited-by-sim',
					},
				},
			],
			dialogDefault: 'deny',
			userSteps: [
				{
					at: 'beforeToolDispatch',
					occurrence: 1,
					step: {
						kind: 'stop',
					},
				},
			],
			faults: [],
		}),
	},
];
