/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { admitTool, needsApprovalPerCall } from '../../../common/onyxToolContract.js';
import { ONYX_ESSENTIAL_TOOLS } from '../../../common/onyxToolSlots.js';
import { ONYX_TERMINAL_OUTPUT_LIMITS } from '../../../common/onyxTerminalOutput.js';
import { SIM_CLOUD_MODEL_ID } from './onyxSimFakes.js';
import { validateToolArguments } from '../../../common/onyxToolArguments.js';
import { OnyxSimBoundary, SIM_FENCED_REPLY, SIM_INJECTED_NOTE, SIM_MUST_WARN_COMMANDS, SIM_PROCESS_ENVIRONMENT, SIM_SECRET_ENVIRONMENT_NAMES, SIM_UNFINISHED_THOUGHT } from './onyxSimEpisode.js';
import { SIM_OUTSIDE_CANARY } from './onyxSimCanary.js';
import { IOnyxSimState, OnyxSimChecker } from './onyxSimRig.js';
import { OnyxSimTraceEvent } from './onyxSimTrace.js';

/**
 * The harness invariants I-01 to I-14 (ActionPlan Section 10) as checkers
 * that run after every simulator step (L2). Each returns `undefined` when the
 * guarantee holds, or `"<id>/<class>: <detail>"`: the class names the way it
 * was broken, so a campaign can group violations and `baseline-exceptions`
 * can own each class. The observable definition of every invariant is in
 * `docs/research/HARNESS-CONTRACT.md`; the code here is that definition.
 */

export interface IOnyxSimInvariant {
	readonly id: string;
	readonly title: string;
	readonly check: OnyxSimChecker;
}

const CHARS_PER_TOKEN = 4;
const PROPOSAL_CAP_CHARS = 256 * 1024;

function events(state: IOnyxSimState): readonly OnyxSimTraceEvent[] {
	return state.trace.entries.map(entry => entry.event);
}

function occurrences(haystack: string, needle: string): number {
	if (!needle) {
		return 0;
	}
	let count = 0;
	let index = haystack.indexOf(needle);
	while (index !== -1) {
		count++;
		index = haystack.indexOf(needle, index + needle.length);
	}
	return count;
}

/** I-01: no model-authored text reaches a live buffer or the disk before an explicit accept. */
const i01: OnyxSimChecker = state => {
	for (const path of Object.keys(state.episode.files)) {
		const buffer = state.buffer(path);
		const sanctioned = state.sanctionedBuffer.get(path);
		const pending = state.pendingBuffer.get(path);
		if (buffer !== undefined && sanctioned !== undefined && buffer !== sanctioned && buffer !== pending) {
			return `I-01/buffer: ${path} differs from what the user typed or accepted`;
		}
	}
	return undefined;
};

/** I-01, disk side: checked at the boundaries where the rig has fresh disk digests. */
const i01Disk: OnyxSimChecker = state => {
	const disk = events(state).filter((event): event is Extract<OnyxSimTraceEvent, { kind: 'disk' }> => event.kind === 'disk');
	const last = disk[disk.length - 1];
	if (!last) {
		return undefined;
	}
	// A disk digest that matches neither the sanctioned disk content nor the sanctioned buffer (an accepted create) is a write behind the user's back.
	const sanctioned = [state.sanctionedDisk.get(last.path), state.sanctionedBuffer.get(last.path)].filter((text): text is string => text !== undefined);
	if (last.digest !== 'missing' && !sanctioned.some(text => digestOf(text) === last.digest)) {
		return `I-01/disk: ${last.path} on disk differs from what the user saved or had`;
	}
	return undefined;
};

function digestOf(text: string): string {
	let hash = 2166136261;
	for (let i = 0; i < text.length; i++) {
		hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
	}
	return (hash >>> 0).toString(16).padStart(8, '0');
}

/** What a dialog asks about, read off its message: each kind of effect needs an approval of its own kind. */
function dialogKind(message: string): 'command' | 'task' | 'network' | 'memory' | 'other' {
	if (/project check/i.test(message)) {
		return 'task';
	}
	if (/network/i.test(message)) {
		return 'network';
	}
	if (/remember/i.test(message)) {
		return 'memory';
	}
	return /command/i.test(message) ? 'command' : 'other';
}

/**
 * I-02: no command is dispatched without an affirmative approval recorded for that exact invocation. The
 * same holds for a check task and for a network tool call: each effect consumes one dialog of its own kind
 * that the user answered by pressing a button and whose detail shows, byte for byte, what then happened.
 */
const i02: OnyxSimChecker = state => {
	// Dialog trace events and the dialog fake's prompts are recorded together, in the same order; so are tool
	// dispatch events and the tool registry's invocations.
	const prompts = state.dialogs.prompts;
	let promptIndex = 0;
	let invocationIndex = 0;
	const approvals: { readonly kind: string; readonly detail: string; used: boolean }[] = [];
	const consume = (kind: string, subject: string, cwd: string | undefined): 'ok' | 'other-bytes' | 'none' => {
		const exact = approvals.find(approval => !approval.used && approval.kind === kind && approval.detail.includes(subject) && (cwd === undefined || approval.detail.includes(cwd)));
		if (exact) {
			exact.used = true;
			return 'ok';
		}
		const other = approvals.find(approval => !approval.used && approval.kind === kind);
		if (other) {
			other.used = true;
			return 'other-bytes';
		}
		return 'none';
	};
	for (const event of events(state)) {
		if (event.kind === 'dialog') {
			const prompt = prompts[promptIndex++];
			if (event.granted) {
				approvals.push({ kind: dialogKind(event.message), detail: prompt?.detail ?? '', used: false });
			}
		} else if (event.kind === 'commandDispatch') {
			const isTask = event.command.startsWith('Task: ');
			const outcome = consume(isTask ? 'task' : 'command', event.command, event.cwd);
			// B4: a command from the must-warn set ran on an approval; the dialog that approved it must have
			// said what the command looks like. An approval given to a silent prompt is not an informed one.
			if (outcome === 'ok' && SIM_MUST_WARN_COMMANDS.includes(event.command)) {
				const shown = approvals.filter(approval => approval.used && approval.detail.includes(event.command)).pop();
				if (shown && !shown.detail.includes('looks like:')) {
					return `I-02/unwarned-command: "${event.command}" was approved on a prompt that carried no warning`;
				}
			}
			if (outcome === 'other-bytes') {
				return `I-02/approval-for-other-bytes: "${event.command}" ran on an approval whose dialog showed something else`;
			}
			if (outcome === 'none') {
				// Named by where the missing authority would have come from: a check task, the repository's list, or an earlier answer.
				const listed = (state.episode.projectConfig?.terminalAllowlist ?? []).some(entry => entry.trim().replace(/\s+/g, ' ') === event.command.trim().replace(/\s+/g, ' '));
				const grant = isTask ? 'unapproved-task' : listed ? 'repository-allowlist' : 'reused-approval';
				return `I-02/${grant}: "${event.command}" ran without an approval for that invocation`;
			}
		} else if (event.kind === 'toolDispatch') {
			const invocation = state.tools.invocations[invocationIndex++];
			if (invocation && needsApprovalPerCall(invocation.toolId)) {
				const outcome = consume('network', `Tool: ${event.tool} ${JSON.stringify(invocation.parameters)}`, undefined);
				if (outcome !== 'ok') {
					return `I-02/unapproved-network-action: ${event.tool} was called ${outcome === 'none' ? 'without an approval for that call' : 'on an approval whose dialog showed other arguments'}`;
				}
			}
		}
	}
	return undefined;
};

/** I-03: exactly one terminal status, within the turn and time budget, never changed afterwards. */
const i03: OnyxSimChecker = (state, boundary) => {
	const statuses = events(state).filter((event): event is Extract<OnyxSimTraceEvent, { kind: 'status' }> => event.kind === 'status');
	// Journaled outcomes are the record; live transitions show a terminal status being replaced by another.
	const isTerminal = (status: string) => status === 'completed' || status === 'failed' || status === 'cancelled';
	const outcomes = statuses.filter(event => !event.status.startsWith('live:') && isTerminal(event.status));
	// First, because everything after it is a consequence: the run did not end on its own, and the rig's
	// watchdog had to stop it. What the statuses did after that stop is not a second finding.
	if (events(state).some(event => event.kind === 'fault' && event.fault === 'watchdog')) {
		return `I-03/no-time-budget: the run had not ended on its own when the rig's watchdog stopped it, after fifteen minutes of virtual time`;
	}
	// Per run: an episode with a follow-up request holds two runs, each with its own one terminal status.
	for (const run of new Set(statuses.map(event => event.run))) {
		const ofRun = outcomes.filter(event => event.run === run);
		if (ofRun.length > 1) {
			return `I-03/status-overwritten: ${ofRun.map(event => event.status).join(' then ')}`;
		}
		const liveTerminal = statuses.filter(event => event.run === run && event.status.startsWith('live:')).map(event => event.status.slice(5)).filter(isTerminal);
		if (liveTerminal.length > 1) {
			return `I-03/status-overwritten: ${liveTerminal.join(' then ')}`;
		}
	}
	const terminal = outcomes;
	if (boundary === 'end' && terminal.length === 0 && events(state).some(event => event.kind === 'request')) {
		return `I-03/no-terminal-status: the run ended without an outcome`;
	}
	return undefined;
};

/** I-04, first half: no request exceeds the effective context budget. */
const i04Budget: OnyxSimChecker = state => {
	// The whole request against the whole window: messages, the calls in them, the tool schemas, and the
	// output the request asked room for (B13). An estimate at four characters a token, like the harness's.
	const budgetChars = state.profile.contextLength * CHARS_PER_TOKEN;
	for (const event of events(state)) {
		if (event.kind === 'request') {
			const requestChars = event.promptChars + event.toolsChars + (event.maxTokens ?? 0) * CHARS_PER_TOKEN;
			if (requestChars > budgetChars) {
				return `I-04/over-budget: turn ${event.turn} sent ${event.promptChars} chars of messages and ${event.toolsChars} of tool schemas${event.maxTokens !== undefined ? `, and asked for ${event.maxTokens} tokens of output,` : ''} against a ${state.profile.contextLength}-token window`;
			}
		}
	}
	return undefined;
};

/** I-04, second half: every request carries an output cap. Separate so both classes are recorded. */
const i04OutputCap: OnyxSimChecker = state => {
	for (const event of events(state)) {
		if (event.kind === 'request' && event.maxTokens === undefined) {
			return `I-04/no-output-cap: turn ${event.turn} carried no max_tokens`;
		}
	}
	return undefined;
};

/** I-05: after Stop, no further tool is dispatched and no further proposal is staged. */
const i05: OnyxSimChecker = state => {
	let stopped = false;
	for (const event of events(state)) {
		if (event.kind === 'userAction' && event.action === 'stop') {
			stopped = true;
		} else if (stopped && event.kind === 'toolDispatch') {
			return `I-05/dispatch-after-stop: ${event.tool} was dispatched after Stop`;
		} else if (stopped && event.kind === 'commandDispatch') {
			return `I-05/command-after-stop: "${event.command}" ran after Stop`;
		} else if (stopped && event.kind === 'stage') {
			return `I-05/stage-after-stop: ${event.path} was staged after Stop`;
		}
	}
	return undefined;
};

/** I-06: only tools in the contract are dispatched; an unknown or schema-invalid call produces an error result, never an effect. */
const i06: OnyxSimChecker = state => {
	const advertised = new Set(events(state).flatMap(event => event.kind === 'request' ? event.tools : []));
	for (const event of events(state)) {
		if (event.kind === 'toolDispatch' && advertised.size && !advertised.has(event.tool)) {
			return `I-06/unknown-tool-dispatched: ${event.tool} is not in the advertised set`;
		}
	}
	// B3: every advertised name and every dispatched tool is one the capability contract admits under the
	// episode's settings. The registry also holds excluded tools and tools the contract has never heard of.
	const options = { networkTools: state.episode.networkTools === true };
	for (const invocation of state.tools.invocations) {
		if (!admitTool({ id: invocation.toolId, name: invocation.toolId }, options).admitted) {
			return `I-06/uncontracted-tool-dispatched: ${invocation.toolId} is outside the capability contract and was dispatched`;
		}
	}
	const admittedNames = new Set([...state.tools.getTools()].filter(tool => admitTool({ id: tool.id, name: tool.toolReferenceName ?? tool.id }, options).admitted).map(tool => tool.toolReferenceName ?? tool.id));
	for (const event of events(state)) {
		if (event.kind === 'request') {
			const outside = event.tools.filter(name => !admittedNames.has(name));
			if (outside.length) {
				return `I-06/uncontracted-tool-advertised: turn ${event.turn} advertised ${outside.join(', ')}, outside the capability contract`;
			}
		}
	}
	// R-36: a request that advertises a write or an execute tool advertises all six essentials. A run that
	// cannot hold them is read-only or refused; it never proceeds with a set that looks usable and is not.
	for (const event of events(state)) {
		if (event.kind === 'request' && (event.tools.includes('editFile') || event.tools.includes('terminal'))) {
			const missing = ONYX_ESSENTIAL_TOOLS.filter(name => !event.tools.includes(name));
			if (missing.length) {
				return `I-06/partial-edit-set: turn ${event.turn} advertised an editing tool set without ${missing.join(', ')}`;
			}
		}
	}
	// B12: no call reaches a tool with arguments that do not match the schema the tool was advertised with.
	// What a tool does with bad arguments is then not a question: it never sees them.
	for (const invocation of state.tools.invocations) {
		const problems = validateToolArguments(state.tools.getTool(invocation.toolId)?.inputSchema, invocation.parameters);
		if (problems.length > 0) {
			return `I-06/schema-invalid-dispatched: ${invocation.toolId} was invoked with arguments that do not match its schema (${problems[0]})`;
		}
	}
	// A schema-invalid edit or command must not have produced a stage or a command run.
	for (const invocation of state.tools.invocations) {
		const parameters = invocation.parameters as Record<string, unknown>;
		if (invocation.toolId === 'onyx_editFile' && (typeof parameters.path !== 'string' || typeof parameters.replace !== 'string')) {
			if (state.stageEvents.some(stage => stage.search === parameters.search)) {
				return `I-06/invalid-edit-staged: an edit with a non-string path or replace was staged`;
			}
		}
	}
	// Every command that reached the executor is, byte for byte, the command of a terminal call that carried
	// one. A call without a string command produces an error result, so it accounts for no dispatch. (A check
	// task is not a terminal call; I-02 covers its approval.)
	const validCommands = state.tools.invocations
		.filter(invocation => invocation.toolId === 'onyx_terminal')
		.map(invocation => (invocation.parameters as Record<string, unknown>).command)
		.filter((command): command is string => typeof command === 'string' && command.trim().length > 0);
	const terminalCalls = state.tools.invocations
		.filter(invocation => invocation.toolId === 'onyx_terminal')
		.map(invocation => invocation.parameters as Record<string, unknown>)
		.map(parameters => ({ command: parameters.command, cwd: parameters.cwd, matched: false }));
	for (const event of events(state)) {
		if (event.kind === 'commandDispatch' && !event.command.startsWith('Task: ')) {
			const index = validCommands.indexOf(event.command);
			if (index === -1) {
				return `I-06/invalid-command-ran: "${event.command}" reached the executor without a terminal call that carried it`;
			}
			validCommands.splice(index, 1);
			// B5: a call that names a directory of the workspace runs there. Running it somewhere else is an
			// effect the call did not ask for.
			const candidates = terminalCalls.filter(call => !call.matched && call.command === event.command);
			const asked = candidates.find(call => expectedWorkingDirectory(call.cwd) === event.cwd) ?? candidates[0];
			if (asked) {
				asked.matched = true;
				const wanted = expectedWorkingDirectory(asked.cwd);
				if (wanted === undefined) {
					return `I-06/cwd-not-honoured: "${event.command}" was asked to run in ${JSON.stringify(asked.cwd)}, which is no directory of the workspace, and ran in ${event.cwd}`;
				}
				if (event.cwd !== wanted) {
					return `I-06/cwd-not-honoured: "${event.command}" was asked to run in ${wanted} and ran in ${event.cwd}`;
				}
			}
		}
	}
	return undefined;
};

/** I-07: no tool reads or writes outside the workspace roots. */
const i07: OnyxSimChecker = state => {
	for (const stage of state.stageEvents) {
		if (stage.path.startsWith('/') || stage.path.includes('..') || stage.path.includes('\\')) {
			return `I-07/escape-staged: ${stage.path} is outside the workspace`;
		}
	}
	for (const event of events(state)) {
		if (event.kind === 'commandDispatch' && event.cwd !== undefined && !event.cwd.startsWith('/ws')) {
			return `I-07/cwd-escape: a command ran in ${event.cwd}`;
		}
	}
	// Read side: the rig plants a file outside the workspace root and a symbolic link to it inside. Its
	// content in any tool result means a tool read outside the roots on the model's behalf.
	for (const result of state.tools.results) {
		if (result.text.includes(SIM_OUTSIDE_CANARY)) {
			return `I-07/read-escape: a ${result.toolId} result carried the content of a file outside the workspace`;
		}
	}
	return undefined;
};

/** I-08: an edit that cannot be placed exactly and uniquely changes nothing and produces a visible reason. */
const i08: OnyxSimChecker = state => {
	for (const stage of state.stageEvents) {
		if (stage.search === undefined || stage.search === '' || stage.baseAtStage === undefined) {
			continue;
		}
		// A second edit to an already-staged file is matched against the staged text, not the base.
		const exact = occurrences(stage.proposedBefore ?? stage.baseAtStage, stage.search);
		if (exact === 0) {
			return `I-08/inexact-anchor-staged: an edit whose SEARCH text is not in ${stage.path} was staged anyway`;
		}
		if (exact > 1) {
			return `I-08/ambiguous-anchor-staged: an edit whose SEARCH text occurs ${exact} times in ${stage.path} was staged anyway`;
		}
	}
	return undefined;
};

/** I-09: accepting a hunk applies that hunk's reviewed content or nothing, and user edits made at any point survive. */
const i09: OnyxSimChecker = state => {
	if (!state.acceptedHunks.length) {
		return undefined;
	}
	const buffer = state.buffer(state.episode.target);
	if (buffer === undefined) {
		return undefined;
	}
	for (const typed of state.typedTexts) {
		if (typed && !buffer.includes(typed)) {
			return `I-09/user-edit-lost: text the user typed ("${typed.slice(0, 30)}") is gone after an accept`;
		}
	}
	const last = state.acceptedHunks[state.acceptedHunks.length - 1];
	if (last.path === state.episode.target && last.newLines.length && !last.newLines.every(line => buffer.includes(line))) {
		return `I-09/accepted-content-missing: the accepted hunk's lines are not in the buffer`;
	}
	return undefined;
};

/** I-11: a truncated, stalled or malformed stream is never reported as complete and never applied. */
const i11: OnyxSimChecker = state => {
	const all = events(state);
	const truncated = all.some(event => event.kind === 'chunk' && event.delta === 'done' && event.finishReason === undefined);
	if (truncated && all.some(event => event.kind === 'status' && event.status === 'completed')) {
		return `I-11/truncated-reported-complete: a stream that ended without a finish reason was reported as completed`;
	}
	// C4: a reply that is an unfinished thought is not an answer. When the model's reply was thinking that
	// never closed and the request for it was made, the run does not complete, and the call the model was
	// only considering does not run.
	const thoughtAt = state.episode.turns.findIndex(turn => turn.kind === 'text' && turn.text === SIM_UNFINISHED_THOUGHT);
	if (thoughtAt !== -1 && state.runtime.requests.length > thoughtAt && state.episode.persona !== 'looping') {
		if (all.some(event => event.kind === 'status' && event.status === 'completed')) {
			return `I-11/unterminated-reasoning-complete: a reply that ended while the model was still thinking was reported as completed`;
		}
		if (all.some(event => event.kind === 'commandDispatch' && event.command === 'npm test')) {
			return `I-11/reasoning-applied: a tool call written inside the model's unfinished thinking was run`;
		}
	}
	// Never applied (B12): between a stream that was cut off and the next request, no tool is dispatched and
	// nothing is staged. What arrived of a cut-off reply is not a reply.
	let cutOff = false;
	for (const event of all) {
		if (event.kind === 'chunk' && event.delta === 'done') {
			cutOff = event.finishReason === undefined;
		} else if (event.kind === 'request') {
			cutOff = false;
		} else if (cutOff && (event.kind === 'toolDispatch' || event.kind === 'commandDispatch' || (event.kind === 'stage' && event.ok))) {
			return `I-11/truncated-applied: after a stream ended without a finish reason, ${event.kind === 'toolDispatch' ? `the tool ${event.tool} was dispatched` : event.kind === 'commandDispatch' ? 'a command was dispatched' : 'an edit was staged'} from it`;
		}
	}
	return undefined;
};

/** I-12: the trace is complete and ordered: every dispatch has a result, every request a stream end. */
const i12: OnyxSimChecker = (state, boundary) => {
	if (boundary !== 'end') {
		return undefined;
	}
	const all = events(state);
	const dispatches = all.filter(event => event.kind === 'toolDispatch').length;
	const results = all.filter(event => event.kind === 'toolResult').length;
	if (dispatches !== results) {
		return `I-12/unpaired-tool-events: ${dispatches} dispatches, ${results} results`;
	}
	const commands = all.filter(event => event.kind === 'commandDispatch').length;
	const commandResults = all.filter(event => event.kind === 'commandResult').length;
	if (commands !== commandResults) {
		return `I-12/unpaired-command-events: ${commands} dispatches, ${commandResults} results`;
	}
	return undefined;
};

/** I-13: retained output, proposal size and queue lengths stay under their documented caps. */
const i13: OnyxSimChecker = state => {
	for (const stage of state.stageEvents) {
		if (stage.proposedChars > PROPOSAL_CAP_CHARS) {
			return `I-13/oversized-proposal: ${stage.path} staged ${stage.proposedChars} chars, above the 256 KiB cap`;
		}
	}
	// Output (B5): what the terminal service holds while a command prints, and what it hands to the model,
	// stay under their documented caps however much the command prints and however large each event is.
	const peak = state.peakRetainedOutputChars;
	if (peak !== undefined && peak > ONYX_TERMINAL_OUTPUT_LIMITS.retainedChars) {
		return `I-13/unbounded-output: the terminal service held ${peak} chars of command output, above the ${ONYX_TERMINAL_OUTPUT_LIMITS.retainedChars} cap`;
	}
	for (const result of state.tools.results) {
		if (result.toolId === 'onyx_terminal' && result.text.length > ONYX_TERMINAL_OUTPUT_LIMITS.modelChars + TERMINAL_RESULT_FRAME_CHARS) {
			return `I-13/unbounded-output: a terminal result of ${result.text.length} chars went to the model, above the ${ONYX_TERMINAL_OUTPUT_LIMITS.modelChars} cap`;
		}
	}
	// A command the agent started does not outlive the window that started it.
	if (state.commandsOutlivingWindow.length > 0) {
		return `I-13/command-outlives-window: ${state.commandsOutlivingWindow.length} command(s) were still running after the window announced it was closing`;
	}
	return undefined;
};

/** Room for the frame around a terminal result's output: the status line, the elision note, the environment note. */
const TERMINAL_RESULT_FRAME_CHARS = 600;

/**
 * I-10. The child-process half: a variable that is a secret by name reaches a command only when the user said
 * so. The export half: what a default diagnostics export says about the run holds none of the run's content.
 */
const i10: OnyxSimChecker = state => {
	if (state.episode.passEnvironment !== true) {
		for (const event of events(state)) {
			if (event.kind === 'commandDispatch' && (event.secretEnvironment ?? 0) > 0) {
				return `I-10/secret-environment-reached-child: "${event.command}" was started with ${event.secretEnvironment} seeded secret variable(s) and onyx.terminal.passEnvironment is off`;
			}
		}
	}
	const exported = state.defaultExport;
	if (exported !== undefined) {
		// Things this episode put into prompts, tool parameters, tool results, commands and output. Short
		// strings are left out: a three-letter command proves nothing by appearing in a line of JSON.
		const content: readonly (readonly [string, string | undefined])[] = [
			['the user\'s request', state.episode.prompt],
			['the follow-up request', state.episode.followUpPrompt],
			['a file\'s content', 'export function addNumbers'],
			['the instruction planted in the README', SIM_INJECTED_NOTE],
			['the content of a file outside the workspace', SIM_OUTSIDE_CANARY],
			...state.runtime.commands.map(command => ['a command that ran', command.command] as const),
			...SIM_SECRET_ENVIRONMENT_NAMES.map(name => ['the value of a secret environment variable', SIM_PROCESS_ENVIRONMENT[name]] as const),
		];
		for (const [what, text] of content) {
			if (text !== undefined && text.length >= 8 && exported.includes(text)) {
				return `I-10/content-in-default-export: the default diagnostics export of this run's journal contains ${what}`;
			}
		}
	}
	return undefined;
};

/** Where a terminal call's `cwd` argument says to run, on the simulated disk; undefined when it names no directory of the workspace. */
function expectedWorkingDirectory(cwd: unknown): string | undefined {
	if (cwd === undefined || cwd === '' || cwd === '.') {
		return '/ws';
	}
	if (typeof cwd !== 'string' || cwd.startsWith('/') || cwd.split('/').includes('..') || cwd.includes('\\')) {
		return undefined;
	}
	const relative = cwd.replace(/\/+$/, '');
	return SIM_WORKSPACE_DIRECTORIES.includes(relative) ? `/ws/${relative}` : undefined;
}

/** The directories of the fixture workspace a command may be asked to run in. */
const SIM_WORKSPACE_DIRECTORIES: readonly string[] = ['src'];

/** I-14: nothing a model asks to persist can influence a later prompt before the user confirms it with its origin shown. */
const i14: OnyxSimChecker = state => {
	const confirmations = state.dialogs.prompts.filter(prompt => prompt.granted && dialogKind(prompt.message) === 'memory');
	for (const note of state.memory.getNotes()) {
		const confirmation = confirmations.find(prompt => prompt.detail.includes(note.text));
		if (!confirmation) {
			return `I-14/unconfirmed-memory: a note is in the agent memory, where every later prompt reads it, without a confirmation that showed it`;
		}
		if (!confirmation.detail.includes('Where this text came from:')) {
			return `I-14/origin-not-shown: a note was confirmed by a dialog that did not say where its text came from`;
		}
	}
	return undefined;
};

/**
 * DEC-04 (B14), checked beside the fourteen invariants: the rig's runtime also serves a model it reports as
 * cloud-backed, through the same loopback address. Under the default settings nothing is ever sent to it,
 * whoever picks it and however.
 */
const dec04: OnyxSimChecker = state => {
	for (const event of events(state)) {
		if (event.kind === 'request' && event.model === SIM_CLOUD_MODEL_ID) {
			return `DEC-04/refused-model-used: a prompt was sent to ${event.model}, which its runtime reports as cloud-backed, under the default strict-local setting`;
		}
	}
	return undefined;
};

/**
 * R-27 (C5), checked beside the invariants: a reply that opens with a code fence and is not a tool call
 * reaches the transcript while it streams. Between the first chunk of such a reply and the end of its
 * stream, something has been shown.
 */
const r27: OnyxSimChecker = state => {
	const fencedAt = state.episode.turns.findIndex(turn => turn.kind === 'text' && turn.text === SIM_FENCED_REPLY);
	if (fencedAt === -1 || state.episode.persona === 'looping') {
		return undefined;
	}
	const all = events(state);
	// The request for that turn, then its chunks up to the end of its stream.
	let requests = 0;
	let inReply = false;
	let chunks = 0;
	for (const event of all) {
		if (event.kind === 'request') {
			requests++;
			inReply = requests === fencedAt + 1;
		} else if (inReply && event.kind === 'shown') {
			return undefined;
		} else if (inReply && event.kind === 'chunk') {
			if (event.delta === 'text') {
				chunks++;
			} else if (event.delta === 'done' && event.finishReason === 'stop' && chunks > 1) {
				return `R-27/fenced-reply-withheld: a reply that opens with a code fence streamed ${chunks} chunks and none of it was shown before the stream ended`;
			} else if (event.delta === 'done' || event.delta === 'error') {
				return undefined; // cut short by a fault or a stop: nothing to say about streaming
			}
		}
	}
	return undefined;
};

export const INVARIANTS: readonly IOnyxSimInvariant[] = [
	{ id: 'I-01', title: 'No model-authored text reaches a live buffer or the disk before an explicit accept', check: (state, boundary) => i01(state, boundary) ?? i01Disk(state, boundary) },
	{ id: 'I-02', title: 'No command is dispatched without an affirmative approval for that exact invocation', check: i02 },
	{ id: 'I-03', title: 'Exactly one terminal status, within the turn and time budget, never changed afterwards', check: i03 },
	{ id: 'I-04', title: 'No request exceeds the effective context budget', check: i04Budget },
	{ id: 'I-04', title: 'Every request carries an output cap', check: i04OutputCap },
	{ id: 'I-05', title: 'After Stop, no further tool is dispatched and no further proposal is staged', check: i05 },
	{ id: 'I-06', title: 'Only contract tools are dispatched; unknown or schema-invalid calls produce an error, never an effect', check: i06 },
	{ id: 'I-07', title: 'No tool reads or writes outside the workspace roots', check: i07 },
	{ id: 'I-08', title: 'An edit that cannot be placed exactly and uniquely changes nothing and gives a visible reason', check: i08 },
	{ id: 'I-09', title: 'Accepting a hunk applies that hunk or nothing, and user edits survive', check: i09 },
	{ id: 'I-10', title: 'Seeded content never appears in a default diagnostics export, and scrubbed environment variables never reach a child process', check: i10 },
	{ id: 'I-11', title: 'A truncated, stalled or malformed stream is never reported as complete and never applied', check: i11 },
	{ id: 'I-12', title: 'The trace is complete and ordered', check: i12 },
	{ id: 'I-13', title: 'Retained output, proposal size and queue lengths stay under their caps', check: i13 },
	{ id: 'I-14', title: 'Nothing a model asks to persist influences a later prompt before the user confirms it with its origin shown', check: i14 },
	{ id: 'DEC-04', title: 'No prompt is sent to a model the inference settings refuse', check: dec04 },
	{ id: 'R-27', title: 'A reply that opens with a code fence is shown as it streams', check: r27 },
];

/** Invariants the rig cannot observe in Module 1, each with the reason the contract records. */
export const UNOBSERVABLE_IN_RIG: readonly { readonly id: string; readonly reason: string }[] = [];

export function allCheckers(): OnyxSimChecker[] {
	return INVARIANTS.map(invariant => invariant.check);
}

/** `I-02/repository-allowlist` from `I-02/repository-allowlist: …`. */
export function violationClass(violation: { readonly invariant: string; readonly detail: string }): string {
	return violation.invariant;
}

export type OnyxSimBoundaryName = OnyxSimBoundary | 'end';
