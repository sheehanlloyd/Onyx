/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The tool capability contract (B3, DEC-03). A reviewed table keyed by tool
 * id says, for every tool that can reach the model, what it is able to do
 * and which gate stands in front of each thing it can do. A tool that is
 * not in the table never enters a request: an unknown tool is excluded, not
 * guessed at.
 *
 * The rules the table encodes:
 * - a write goes through Onyx Changes (staged, reviewed, accepted);
 * - a shell or process execution goes through the Onyx approval dialog, once
 *   per invocation (B2);
 * - a write to state that later prompts read (a memory note) needs a
 *   confirmation that shows where the text came from (I-14);
 * - a network action needs the user's opt-in and then an approval per action.
 * A tool that cannot meet the gate for something it can do is `excluded`,
 * whatever settings say. Opting in to network tools changes none of the
 * other gates and does not enlarge the slot budget.
 *
 * Pure data and pure functions: plain Node imports this for the packaged
 * inventory check (R-05).
 */

export type OnyxToolCapability =
	/** Reads workspace files, editor state or an index built from them. */
	| 'read'
	/** Changes workspace files. */
	| 'write'
	/** Starts a process, a task, a terminal command or installs something. */
	| 'execute'
	/** Sends or fetches anything beyond the configured model runtime. */
	| 'network'
	/** Writes state that later prompts read: memory, pins, playbooks. */
	| 'persist';

/** What stands between a capability and its effect. */
export type OnyxToolGate =
	/** Nothing is needed: the capability has no effect outside the conversation. */
	| 'none'
	/** The effect is a staged proposal in Onyx Changes; nothing changes until the user accepts it. */
	| 'onyx-changes'
	/** The Onyx approval dialog, once per invocation, showing exactly what will run. */
	| 'onyx-approval'
	/** A confirmation that shows the text to be stored and where it came from. */
	| 'onyx-confirmation';

export type OnyxToolAvailability =
	/** In the default inventory. */
	| 'default'
	/** Only with the named opt-in. */
	| 'network'
	/** Never exposed, with the reason. */
	| 'excluded';

export interface IOnyxToolContractEntry {
	/** The registry id. */
	readonly id: string;
	/** The reference name the model sees. */
	readonly name: string;
	readonly capabilities: readonly OnyxToolCapability[];
	/** The gate for each capability that has an effect. */
	readonly gates: Readonly<Partial<Record<OnyxToolCapability, OnyxToolGate>>>;
	readonly availability: OnyxToolAvailability;
	/** Why it is available, or why it is not. */
	readonly reason: string;
}

/** The version of the reviewed table. Bump it whenever a row changes; the packaged check compares against it. */
export const ONYX_TOOL_CONTRACT_VERSION = 1;

/** The setting that opts in to the reviewed network tools. Off by default. */
export const ONYX_NETWORK_TOOLS_SETTING = 'onyx.agent.networkTools';

const EXECUTES_WITHOUT_ONYX_APPROVAL = 'executes without the Onyx approval dialog; the alpha asks for every shell invocation (DEC-03, B2)';
const WRITES_WITHOUT_ONYX_CHANGES = 'writes without staging in Onyx Changes (DEC-03)';
const NOT_PART_OF_THE_WORKFLOW = 'chat-stack plumbing, not part of the supported workflow';
const READS_OUTSIDE_THE_WORKSPACE_FILES = 'reads terminal or task output, which is outside the workspace files and may hold secrets';
const DRIVES_A_BROWSER_PAGE = 'acts on a web page (clicks, types, runs script) with no Onyx gate per action';

export const ONYX_TOOL_CONTRACT: readonly IOnyxToolContractEntry[] = [
	// --- Onyx's own tools ---------------------------------------------------
	{ id: 'onyx_readFile', name: 'readFile', capabilities: ['read'], gates: { read: 'none' }, availability: 'default', reason: 'essential: reads workspace files, contained to the workspace roots' },
	{ id: 'onyx_listDirectory', name: 'listDirectory', capabilities: ['read'], gates: { read: 'none' }, availability: 'default', reason: 'essential: lists one workspace directory' },
	{ id: 'onyx_findFiles', name: 'findFiles', capabilities: ['read'], gates: { read: 'none' }, availability: 'default', reason: 'essential: finds workspace files by glob' },
	{ id: 'onyx_grep', name: 'grep', capabilities: ['read'], gates: { read: 'none' }, availability: 'default', reason: 'essential: searches workspace text' },
	{ id: 'onyx_editFile', name: 'editFile', capabilities: ['write'], gates: { write: 'onyx-changes' }, availability: 'default', reason: 'essential: the only write path; every edit is staged for review' },
	{ id: 'onyx_terminal', name: 'terminal', capabilities: ['execute'], gates: { execute: 'onyx-approval' }, availability: 'default', reason: 'essential: every invocation asks, Run Once or Deny' },
	{ id: 'onyx_repoSymbols', name: 'repoSymbols', capabilities: ['read'], gates: { read: 'none' }, availability: 'default', reason: 'optional: symbol lookup through the language services' },
	{ id: 'onyx_docs', name: 'docs', capabilities: ['read'], gates: { read: 'none' }, availability: 'default', reason: 'optional: searches the offline documentation mirror; no network' },
	{ id: 'onyx_memory', name: 'remember', capabilities: ['persist'], gates: { persist: 'onyx-confirmation' }, availability: 'default', reason: 'optional: stores a note only after the user confirms it with its origin shown (I-14)' },
	{ id: 'onyx_playbook', name: 'playbook', capabilities: ['read'], gates: { read: 'none' }, availability: 'default', reason: 'optional: fetches a repository playbook; repository-authored text, and it grants nothing' },

	{ id: 'onyx_debugState', name: 'debugState', capabilities: ['read'], gates: { read: 'none' }, availability: 'default', reason: 'reads the paused debug session the user started; read-only' },

	// --- core tools that read, reviewed -------------------------------------
	{ id: 'vscode_listCodeUsages', name: 'usages', capabilities: ['read'], gates: { read: 'none' }, availability: 'default', reason: 'reads references through the language services' },
	{ id: 'testFailure', name: 'testFailure', capabilities: ['read'], gates: { read: 'none' }, availability: 'default', reason: 'reads the last test results the user produced' },

	// --- network tools, behind the opt-in and a per-action approval ---------
	{ id: 'open_browser_page', name: 'openBrowserPage', capabilities: ['network'], gates: { network: 'onyx-approval' }, availability: 'network', reason: 'opens a URL in the integrated browser; asks for each URL' },
	{ id: 'read_page', name: 'readPage', capabilities: ['read'], gates: { read: 'none' }, availability: 'network', reason: 'reads a page the agent opened with approval' },
	{ id: 'vscode_fetchWebPage_internal', name: 'vscode_fetchWebPage_internal', capabilities: ['network'], gates: { network: 'onyx-approval' }, availability: 'network', reason: 'fetches a URL; asks for each URL' },

	// --- excluded: execution outside the Onyx approval ----------------------
	{ id: 'run_in_terminal', name: 'runInTerminal', capabilities: ['execute', 'write', 'network'], gates: {}, availability: 'excluded', reason: EXECUTES_WITHOUT_ONYX_APPROVAL },
	{ id: 'send_to_terminal', name: 'sendToTerminal', capabilities: ['execute'], gates: {}, availability: 'excluded', reason: EXECUTES_WITHOUT_ONYX_APPROVAL },
	{ id: 'kill_terminal', name: 'killTerminal', capabilities: ['execute'], gates: {}, availability: 'excluded', reason: EXECUTES_WITHOUT_ONYX_APPROVAL },
	{ id: 'run_task', name: 'runTask', capabilities: ['execute'], gates: {}, availability: 'excluded', reason: EXECUTES_WITHOUT_ONYX_APPROVAL },
	{ id: 'create_and_run_task', name: 'createAndRunTask', capabilities: ['write', 'execute'], gates: {}, availability: 'excluded', reason: EXECUTES_WITHOUT_ONYX_APPROVAL },
	{ id: 'runTests', name: 'runTests', capabilities: ['execute'], gates: {}, availability: 'excluded', reason: EXECUTES_WITHOUT_ONYX_APPROVAL },
	{ id: 'run_playwright_code', name: 'runPlaywrightCode', capabilities: ['execute', 'network'], gates: {}, availability: 'excluded', reason: 'runs arbitrary script against a web page' },
	{ id: 'runSubagent', name: 'runSubagent', capabilities: ['read', 'write', 'execute', 'network'], gates: {}, availability: 'excluded', reason: 'starts another agent run whose tools are not this contract\'s' },
	{ id: 'vscode_installExtensions', name: 'installExtensions', capabilities: ['execute', 'network'], gates: {}, availability: 'excluded', reason: 'installs code from a marketplace' },

	// --- excluded: writes outside Onyx Changes ------------------------------
	{ id: 'vscode_renameSymbol', name: 'rename', capabilities: ['write'], gates: {}, availability: 'excluded', reason: WRITES_WITHOUT_ONYX_CHANGES },
	{ id: 'vscode_editFile_internal', name: 'vscode_editFile_internal', capabilities: ['write'], gates: {}, availability: 'excluded', reason: WRITES_WITHOUT_ONYX_CHANGES },
	{ id: 'setArtifacts', name: 'artifacts', capabilities: ['persist'], gates: {}, availability: 'excluded', reason: 'writes session state with no Onyx confirmation' },
	{ id: 'setArtifactRules', name: 'artifactRules', capabilities: ['persist'], gates: {}, availability: 'excluded', reason: 'writes session state with no Onyx confirmation' },

	// --- excluded: network without a gate Onyx owns --------------------------
	{ id: 'vscode_searchExtensions_internal', name: 'extensions', capabilities: ['network', 'read'], gates: {}, availability: 'excluded', reason: 'queries an extension marketplace' },
	{ id: 'navigate_page', name: 'navigatePage', capabilities: ['network'], gates: {}, availability: 'excluded', reason: DRIVES_A_BROWSER_PAGE },
	{ id: 'click_element', name: 'clickElement', capabilities: ['network', 'write'], gates: {}, availability: 'excluded', reason: DRIVES_A_BROWSER_PAGE },
	{ id: 'drag_element', name: 'dragElement', capabilities: ['network', 'write'], gates: {}, availability: 'excluded', reason: DRIVES_A_BROWSER_PAGE },
	{ id: 'hover_element', name: 'hoverElement', capabilities: ['network'], gates: {}, availability: 'excluded', reason: DRIVES_A_BROWSER_PAGE },
	{ id: 'type_in_page', name: 'typeInPage', capabilities: ['network', 'write'], gates: {}, availability: 'excluded', reason: DRIVES_A_BROWSER_PAGE },
	{ id: 'handle_dialog', name: 'handleDialog', capabilities: ['network', 'read', 'write'], gates: {}, availability: 'excluded', reason: 'answers page dialogs and can upload local files' },
	{ id: 'screenshot_page', name: 'screenshotPage', capabilities: ['read'], gates: {}, availability: 'excluded', reason: 'returns an image; the supported models are text-only' },
	{ id: 'list_browser_pages', name: 'list_browser_pages', capabilities: ['read'], gates: {}, availability: 'excluded', reason: 'only useful with the browser tools that are excluded' },

	// --- excluded: reads beyond the workspace files --------------------------
	{ id: 'get_terminal_output', name: 'getTerminalOutput', capabilities: ['read'], gates: {}, availability: 'excluded', reason: READS_OUTSIDE_THE_WORKSPACE_FILES },
	{ id: 'terminal_selection', name: 'terminalSelection', capabilities: ['read'], gates: {}, availability: 'excluded', reason: READS_OUTSIDE_THE_WORKSPACE_FILES },
	{ id: 'terminal_last_command', name: 'terminalLastCommand', capabilities: ['read'], gates: {}, availability: 'excluded', reason: READS_OUTSIDE_THE_WORKSPACE_FILES },
	{ id: 'get_task_output', name: 'getTaskOutput', capabilities: ['read'], gates: {}, availability: 'excluded', reason: READS_OUTSIDE_THE_WORKSPACE_FILES },

	// --- excluded: chat-stack plumbing --------------------------------------
	{ id: 'vscode_askQuestions', name: 'askQuestions', capabilities: [], gates: {}, availability: 'excluded', reason: NOT_PART_OF_THE_WORKFLOW },
	{ id: 'vscode_reviewPlan', name: 'reviewPlan', capabilities: [], gates: {}, availability: 'excluded', reason: NOT_PART_OF_THE_WORKFLOW },
	{ id: 'manage_todo_list', name: 'todo', capabilities: ['persist'], gates: {}, availability: 'excluded', reason: NOT_PART_OF_THE_WORKFLOW },
	{ id: 'vscode_get_confirmation', name: 'vscode_get_confirmation', capabilities: [], gates: {}, availability: 'excluded', reason: NOT_PART_OF_THE_WORKFLOW },
	{ id: 'vscode_get_confirmation_with_options', name: 'vscode_get_confirmation_with_options', capabilities: [], gates: {}, availability: 'excluded', reason: NOT_PART_OF_THE_WORKFLOW },
	{ id: 'vscode_get_modified_files_confirmation', name: 'vscode_get_modified_files_confirmation', capabilities: [], gates: {}, availability: 'excluded', reason: NOT_PART_OF_THE_WORKFLOW },
	{ id: 'vscode_get_terminal_confirmation', name: 'vscode_get_terminal_confirmation', capabilities: [], gates: {}, availability: 'excluded', reason: NOT_PART_OF_THE_WORKFLOW },
	{ id: 'task_complete', name: 'task_complete', capabilities: [], gates: {}, availability: 'excluded', reason: NOT_PART_OF_THE_WORKFLOW },
	{ id: 'inline_chat_exit', name: 'inline_chat_exit', capabilities: [], gates: {}, availability: 'excluded', reason: NOT_PART_OF_THE_WORKFLOW },
	{ id: 'vscode_reportCustomizationMigration', name: 'report_customization_migration', capabilities: [], gates: {}, availability: 'excluded', reason: NOT_PART_OF_THE_WORKFLOW },
];

const BY_ID: ReadonlyMap<string, IOnyxToolContractEntry> = new Map(ONYX_TOOL_CONTRACT.map(entry => [entry.id, entry]));

export function contractEntry(id: string): IOnyxToolContractEntry | undefined {
	return BY_ID.get(id);
}

/** What a registered tool looks like to the contract. */
export interface IOnyxRegisteredTool {
	readonly id: string;
	/** The reference name the registry gives it; shown when the tool is not in the table. */
	readonly name: string;
	/** Where the registry got it: Onyx and core tools are `internal`; the rest are named for the reason given on exclusion. */
	readonly source?: 'internal' | 'extension' | 'mcp' | 'other';
}

export interface IOnyxToolGateOptions {
	/** The user's opt-in to the reviewed network tools (`onyx.agent.networkTools`). */
	readonly networkTools: boolean;
}

export type OnyxToolAdmission =
	| { readonly admitted: true; readonly entry: IOnyxToolContractEntry }
	| { readonly admitted: false; readonly reason: string };

/**
 * Whether a registered tool may be offered to a model. A tool that is not in
 * the reviewed table is refused whatever it claims to be; a tool whose gate
 * is not met is refused whatever the settings say; a network tool needs the
 * opt-in, and the opt-in admits nothing but the reviewed network rows.
 */
export function admitTool(tool: IOnyxRegisteredTool, options: IOnyxToolGateOptions): OnyxToolAdmission {
	const entry = BY_ID.get(tool.id);
	if (!entry) {
		const kind = tool.source === 'mcp'
			? 'an MCP tool; MCP tools cannot be classified and one that writes would bypass Onyx Changes, so they are unavailable in the alpha'
			: tool.source === 'extension'
				? 'contributed by an extension and not in the reviewed tool contract'
				: 'not in the reviewed tool contract';
		return { admitted: false, reason: kind };
	}
	if (entry.availability === 'excluded') {
		return { admitted: false, reason: entry.reason };
	}
	if (entry.availability === 'network' && !options.networkTools) {
		return { admitted: false, reason: `a network tool; off unless "${ONYX_NETWORK_TOOLS_SETTING}" is on` };
	}
	return { admitted: true, entry };
}

/** Whether calling this tool needs the Onyx approval dialog for that one call, asked by the agent loop itself. */
export function needsApprovalPerCall(id: string): boolean {
	const entry = BY_ID.get(id);
	// The terminal tool asks inside its own service, with the command; this is for tools Onyx does not implement.
	return !!entry && entry.gates.network === 'onyx-approval';
}

/** The reference names of the tools that write state later prompts read. */
export function persistingTools(): string[] {
	return ONYX_TOOL_CONTRACT.filter(entry => entry.availability !== 'excluded' && entry.capabilities.includes('persist')).map(entry => entry.name);
}

/** The names the contract can ever expose under the given options: the inventory a packaged build is checked against. */
export function contractInventory(options: IOnyxToolGateOptions): string[] {
	return ONYX_TOOL_CONTRACT.filter(entry => entry.availability === 'default' || (entry.availability === 'network' && options.networkTools)).map(entry => entry.name);
}

export interface IOnyxToolInventory {
	readonly exposed: readonly { readonly id: string; readonly name: string; readonly capabilities: readonly OnyxToolCapability[]; readonly gates: string; readonly reason: string }[];
	readonly excluded: readonly { readonly id: string; readonly name: string; readonly reason: string }[];
}

/** Every registered tool, sorted into what the contract admits and what it refuses, each with its reason. */
export function describeToolInventory(registered: readonly IOnyxRegisteredTool[], options: IOnyxToolGateOptions): IOnyxToolInventory {
	const exposed: { id: string; name: string; capabilities: readonly OnyxToolCapability[]; gates: string; reason: string }[] = [];
	const excluded: { id: string; name: string; reason: string }[] = [];
	for (const tool of registered) {
		const admission = admitTool(tool, options);
		if (admission.admitted) {
			const entry = admission.entry;
			const gates = entry.capabilities.map(capability => `${capability}: ${entry.gates[capability] ?? 'none'}`).join(', ');
			exposed.push({ id: entry.id, name: entry.name, capabilities: entry.capabilities, gates, reason: entry.reason });
		} else {
			excluded.push({ id: tool.id, name: tool.name, reason: admission.reason });
		}
	}
	return { exposed, excluded };
}
