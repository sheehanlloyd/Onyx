/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { IObservable, ISettableObservable, observableValue } from '../../../../../base/common/observable.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { createDecorator, ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { INotificationService, Severity } from '../../../../../platform/notification/common/notification.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IOnyxRuntimeService } from '../../../../../platform/onyxRuntime/common/onyxRuntime.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { ILanguageModelToolsService, IToolData, IToolImpl, IToolInvocation, IToolResult, ToolDataSource } from '../../../chat/common/tools/languageModelToolsService.js';
import { buildApprovalRequest, clampCommandOutput, IOnyxCommandInvocation, normalizeCommand, OnyxTerminalDecision } from '../../common/onyxTerminalPolicy.js';
import { LEGACY_TERMINAL_ALLOWLIST_KEY, ONYX_PROJECT_CONFIG_PATH } from '../../common/onyxProjectConfig.js';
import { IOnyxControlPlaneService } from '../controlPlane/onyxControlPlaneService.js';

export const ONYX_TERMINAL_TOOL_ID = 'onyx_terminal';

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 10 * 60_000;
/** What the model gets back; the journal carries the same capped text. */
const MODEL_OUTPUT_BUDGET = 12_000;
/** Streaming chunks posted to the run timeline, so a long build stays legible. */
const TIMELINE_CHUNK_CHARS = 800;
const TIMELINE_MAX_CHUNKS = 6;

/** Past approval decisions, kept in machine-local workspace storage for inspection. They authorize nothing. */
const APPROVAL_HISTORY_KEY = 'onyx.terminal.approvalHistory';
const APPROVAL_HISTORY_MAX = 200;

export const IOnyxTerminalService = createDecorator<IOnyxTerminalService>('onyxTerminalService');

export interface IOnyxRunningCommand {
	readonly operationId: string;
	readonly command: string;
	readonly startedAt: number;
	readonly runId: string | undefined;
}

/** One past decision. A record of what happened; never consulted for authority. */
export interface IOnyxApprovalRecord {
	readonly at: number;
	readonly command: string;
	readonly cwd: string;
	readonly timeoutMs: number;
	readonly decision: OnyxTerminalDecision;
}

/** An execution that is not a terminal-tool command but needs the same per-invocation approval: a project check task. */
export interface IOnyxExecutionRequest {
	/** What is being asked about: a project check task, or one call to a network tool. */
	readonly kind: 'task' | 'network';
	/** The line that names what will run, e.g. `Task: npm: test` or `Tool: openBrowserPage {"url":…}`. */
	readonly subject: string;
	/** Who configured it, in words the dialog shows. */
	readonly configuredBy: string;
	readonly runId: string | undefined;
}

/**
 * The approval gate and executor behind the agent's terminal tool. The
 * alpha contract (B2): every shell invocation asks, with Run Once or Deny,
 * and a decision covers that invocation's exact command bytes, working
 * directory and timeout. Nothing is remembered as permission: no session
 * grant, no persistent grant, and no repository allowlist. Past decisions
 * are kept in machine-local workspace storage for inspection only. The
 * policy text (what a command looks like) is pure logic in
 * `onyxTerminalPolicy.ts`; this service owns the dialog, the dispatch,
 * streaming output into the run timeline, hard timeouts and the kill switch.
 */
export interface IOnyxTerminalService {
	readonly _serviceBrand: undefined;
	readonly running: IObservable<readonly IOnyxRunningCommand[]>;
	runCommand(command: string, cwdHint: string | undefined, timeoutMs: number, chatRequestId: string | undefined, token: CancellationToken): Promise<IToolResult>;
	/** Asks for this one execution; resolves true only on an explicit Run Once. */
	confirmExecution(request: IOnyxExecutionRequest): Promise<boolean>;
	killAll(): void;
	/** Past decisions for this workspace, oldest first. Inspection only. */
	approvalHistory(): readonly IOnyxApprovalRecord[];
	/**
	 * Removes the legacy grants (`terminalAllowlist`) from each workspace
	 * folder's `.onyx/config.json` and clears the approval history. Resolves
	 * with how many legacy entries were removed. They were already inactive.
	 */
	clearLegacyGrants(): Promise<number>;
}

export class OnyxTerminalService extends Disposable implements IOnyxTerminalService {

	declare readonly _serviceBrand: undefined;

	private readonly _runningObs: ISettableObservable<readonly IOnyxRunningCommand[]> = observableValue(this, []);
	readonly running: IObservable<readonly IOnyxRunningCommand[]> = this._runningObs;

	constructor(
		@IOnyxRuntimeService private readonly _runtimeService: IOnyxRuntimeService,
		@IOnyxControlPlaneService private readonly _controlPlaneService: IOnyxControlPlaneService,
		@IWorkspaceContextService protected readonly _workspaceService: IWorkspaceContextService,
		@IDialogService private readonly _dialogService: IDialogService,
		@IFileService protected readonly _fileService: IFileService,
		@INotificationService private readonly _notificationService: INotificationService,
		@IStorageService private readonly _storageService: IStorageService,
	) {
		super();
	}

	async runCommand(command: string, cwdHint: string | undefined, timeoutMs: number, chatRequestId: string | undefined, token: CancellationToken): Promise<IToolResult> {
		const folder = this._workspaceService.getWorkspace().folders[0];
		if (!folder) {
			return errorResult('No workspace folder is open — there is nowhere to run the command.');
		}
		const invocation: IOnyxCommandInvocation = { command, cwd: folder.uri.fsPath, timeoutMs };
		const runId = chatRequestId ? this._controlPlaneService.runs.get().find(run => run.requestId === chatRequestId)?.runId : undefined;
		const label = normalizeCommand(command);

		const decision = await this._authorize(invocation);
		this._remember(invocation, decision);
		if (runId) {
			this._controlPlaneService.recordApproval(runId, { command: invocation.command, cwd: invocation.cwd, timeoutMs: invocation.timeoutMs, decision, source: 'dialog' });
		}
		if (decision !== 'allow-once') {
			this._appendActivity(runId, { kind: 'note', label: localize('onyx.terminal.denied', "Command denied by the user"), reason: label, ok: false });
			return { content: [{ kind: 'text', value: 'The user denied this command. Do not retry it; ask the user what to do instead, or continue without it.' }] };
		}

		const operationId = `terminal-${generateUuid()}`;
		const running: IOnyxRunningCommand = { operationId, command: label, startedAt: Date.now(), runId };
		this._runningObs.set([...this._runningObs.get(), running], undefined);
		this._appendActivity(runId, { kind: 'note', label: localize('onyx.terminal.running', "Running: {0}", label) });

		// Stream output into the timeline in bounded chunks; the full (capped)
		// text still reaches the model and the journal at the end.
		let pendingChunk = '';
		let chunksPosted = 0;
		const listener = this._runtimeService.onDidCommandOutput(event => {
			if (event.operationId !== operationId) {
				return;
			}
			pendingChunk += event.text;
			if (pendingChunk.length >= TIMELINE_CHUNK_CHARS && chunksPosted < TIMELINE_MAX_CHUNKS) {
				this._appendActivity(runId, { kind: 'note', label: localize('onyx.terminal.output', "Output"), reason: pendingChunk.slice(0, TIMELINE_CHUNK_CHARS) });
				pendingChunk = '';
				chunksPosted++;
			}
		});
		const cancelListener = token.onCancellationRequested(() => this._runtimeService.killCommand(operationId));

		try {
			// The approved bytes, the approved directory, the approved timeout: nothing else is dispatched.
			const result = await this._runtimeService.execCommand(operationId, invocation.cwd, invocation.command, invocation.timeoutMs);
			const verdict = result.timedOut
				? localize('onyx.terminal.timedOut', "Timed out after {0}s and was killed", Math.round(timeoutMs / 1000))
				: result.killed
					? localize('onyx.terminal.killed', "Killed before it finished")
					: localize('onyx.terminal.exited', "Exited with code {0} in {1}s", result.exitCode ?? '?', (result.durationMs / 1000).toFixed(1));
			this._appendActivity(runId, { kind: 'note', label: verdict, ok: !result.timedOut && !result.killed && result.exitCode === 0 });
			const status = result.timedOut ? `timed out after ${timeoutMs}ms (killed)` : result.killed ? 'killed by the user' : `exit code ${result.exitCode ?? 'unknown'}`;
			return { content: [{ kind: 'text', value: `Command finished: ${status}.\nOutput:\n${clampCommandOutput(result.output, MODEL_OUTPUT_BUDGET) || '(no output)'}` }], toolResultError: result.exitCode !== 0 || result.timedOut || result.killed ? true : undefined };
		} finally {
			listener.dispose();
			cancelListener.dispose();
			this._runningObs.set(this._runningObs.get().filter(entry => entry.operationId !== operationId), undefined);
		}
	}

	async confirmExecution(request: IOnyxExecutionRequest): Promise<boolean> {
		const result = await this._dialogService.prompt<OnyxTerminalDecision>({
			type: request.kind === 'network' ? Severity.Warning : Severity.Info,
			message: request.kind === 'network'
				? localize('onyx.terminal.approveNetwork', "The agent wants to use the network")
				: localize('onyx.terminal.approveCheck', "Onyx wants to run a project check"),
			detail: [
				request.subject,
				'',
				request.kind === 'network'
					? localize('onyx.terminal.approveNetwork.enabledBy', "Enabled by: {0}", request.configuredBy)
					: localize('onyx.terminal.approveCheck.configuredBy', "Configured by: {0}", request.configuredBy),
				request.kind === 'network'
					? localize('onyx.terminal.approveNetwork.leaves', "This sends a request to another machine. What the request carries is shown above; what the other side does with it is not.")
					: localize('onyx.terminal.approveCheck.unseen', "A task runs commands from this workspace's task configuration. This dialog cannot show them; open the task to read them."),
			].join('\n'),
			buttons: [{ label: localize('onyx.terminal.allowOnce', "Run Once"), run: () => 'allow-once' }],
			cancelButton: { label: localize('onyx.terminal.deny', "Deny"), run: () => 'deny' },
		});
		const decision: OnyxTerminalDecision = result.result === 'allow-once' ? 'allow-once' : 'deny';
		if (request.runId) {
			this._controlPlaneService.recordApproval(request.runId, { command: request.subject, cwd: null, timeoutMs: null, decision, source: 'dialog' });
		}
		return decision === 'allow-once';
	}

	killAll(): void {
		const running = this._runningObs.get();
		for (const entry of running) {
			this._runtimeService.killCommand(entry.operationId);
		}
		if (running.length === 0) {
			this._notificationService.notify({ severity: Severity.Info, message: localize('onyx.terminal.nothingRunning', "No agent terminal command is running.") });
		}
	}

	approvalHistory(): readonly IOnyxApprovalRecord[] {
		try {
			const parsed: unknown = JSON.parse(this._storageService.get(APPROVAL_HISTORY_KEY, StorageScope.WORKSPACE, '[]'));
			return Array.isArray(parsed) ? parsed as IOnyxApprovalRecord[] : [];
		} catch {
			return [];
		}
	}

	async clearLegacyGrants(): Promise<number> {
		let removed = 0;
		for (const folder of this._workspaceService.getWorkspace().folders) {
			const uri = folder.toResource(ONYX_PROJECT_CONFIG_PATH);
			let parsed: unknown;
			try {
				parsed = JSON.parse((await this._fileService.readFile(uri)).value.toString());
			} catch {
				continue; // no config in this folder, or not JSON: nothing of ours to remove
			}
			if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
				continue;
			}
			const config = parsed as Record<string, unknown>;
			const legacy = config[LEGACY_TERMINAL_ALLOWLIST_KEY];
			if (legacy === undefined) {
				continue;
			}
			removed += Array.isArray(legacy) ? legacy.length : 1;
			delete config[LEGACY_TERMINAL_ALLOWLIST_KEY];
			await this._fileService.writeFile(uri, VSBuffer.fromString(JSON.stringify(config, undefined, '\t') + '\n'));
		}
		this._storageService.remove(APPROVAL_HISTORY_KEY, StorageScope.WORKSPACE);
		return removed;
	}

	/**
	 * The one source of authority for an invocation: the user's answer to a
	 * dialog that shows that invocation. Nothing else is consulted, whatever
	 * the repository, an earlier answer or stored data says.
	 */
	protected async _authorize(invocation: IOnyxCommandInvocation): Promise<OnyxTerminalDecision> {
		return this._askForApproval(invocation);
	}

	protected async _askForApproval(invocation: IOnyxCommandInvocation): Promise<OnyxTerminalDecision> {
		const approval = this._approvalRequest(invocation);
		const result = await this._dialogService.prompt<OnyxTerminalDecision>({
			type: approval.dangerous ? Severity.Warning : Severity.Info,
			message: approval.dangerous
				? localize('onyx.terminal.approveDangerous', "The agent wants to run a command that looks dangerous")
				: localize('onyx.terminal.approve', "The agent wants to run a terminal command"),
			detail: approval.detail,
			buttons: [{ label: localize('onyx.terminal.allowOnce', "Run Once"), run: () => 'allow-once' }],
			cancelButton: { label: localize('onyx.terminal.deny', "Deny"), run: () => 'deny' },
		});
		return result.result === 'allow-once' ? 'allow-once' : 'deny';
	}

	/** What the dialog says about an invocation: the exact command, where, for how long, and what it looks like. */
	protected _approvalRequest(invocation: IOnyxCommandInvocation) {
		return buildApprovalRequest(invocation);
	}

	private _remember(invocation: IOnyxCommandInvocation, decision: OnyxTerminalDecision): void {
		const history = [...this.approvalHistory(), { at: Date.now(), command: invocation.command, cwd: invocation.cwd, timeoutMs: invocation.timeoutMs, decision }];
		this._storageService.store(APPROVAL_HISTORY_KEY, JSON.stringify(history.slice(-APPROVAL_HISTORY_MAX)), StorageScope.WORKSPACE, StorageTarget.MACHINE);
	}

	private _appendActivity(runId: string | undefined, entry: { kind: 'note'; label: string; reason?: string; ok?: boolean }): void {
		if (runId) {
			this._controlPlaneService.appendActivity(runId, entry);
		}
	}
}

/**
 * Registers the terminal tool with the tools service. The tool itself is a
 * thin veneer: parameter validation here, the approval and the execution in
 * the terminal service, the decision with the user.
 */
export class OnyxTerminalToolContribution extends Disposable {

	static readonly ID = 'workbench.contrib.onyxTerminalTool';

	constructor(
		@ILanguageModelToolsService toolsService: ILanguageModelToolsService,
		@IOnyxTerminalService private readonly _terminalService: IOnyxTerminalService,
	) {
		super();

		const toolData: IToolData = {
			id: ONYX_TERMINAL_TOOL_ID,
			toolReferenceName: 'terminal',
			displayName: localize('onyx.terminal.displayName', "Run Terminal Command"),
			modelDescription: 'Proposes one shell command to run in the workspace root. The user is asked to approve every command before it runs, each time; a denied command must not be retried. Output is returned when the command finishes. Use for builds, tests, git status and similar read-mostly commands. Keep commands short and non-interactive.',
			userDescription: localize('onyx.terminal.userDescription', "Let the agent propose shell commands, each gated on your approval"),
			source: ToolDataSource.Internal,
			canBeReferencedInPrompt: true,
			runsInWorkspace: true,
			inputSchema: {
				type: 'object',
				properties: {
					command: { type: 'string', description: 'The shell command to run, e.g. "npm test". Non-interactive commands only.' },
					timeoutSeconds: { type: 'number', description: 'Kill the command after this many seconds (default 60, max 600).' },
				},
				required: ['command'],
			},
		};

		const impl: IToolImpl = {
			prepareToolInvocation: async (context) => ({
				invocationMessage: localize('onyx.terminal.invoking', "Proposing command: {0}", String((context.parameters as { command?: unknown }).command ?? '')),
			}),
			invoke: (invocation, _countTokens, _progress, token) => this._invoke(invocation, token),
		};

		this._register(toolsService.registerToolData(toolData));
		this._register(toolsService.registerToolImplementation(ONYX_TERMINAL_TOOL_ID, impl));
	}

	private async _invoke(invocation: IToolInvocation, token: CancellationToken): Promise<IToolResult> {
		const parameters = invocation.parameters as { command?: unknown; timeoutSeconds?: unknown };
		// The command is passed on exactly as the model wrote it: what the user
		// approves is what runs, so nothing here trims or rewrites it.
		const command = typeof parameters.command === 'string' ? parameters.command : '';
		if (!command.trim()) {
			return errorResult('A non-empty "command" string is required.');
		}
		const timeoutMs = Math.min(typeof parameters.timeoutSeconds === 'number' && parameters.timeoutSeconds > 0 ? parameters.timeoutSeconds * 1000 : DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
		return this._terminalService.runCommand(command, undefined, timeoutMs, invocation.chatRequestId, token);
	}
}

function errorResult(message: string): IToolResult {
	return { content: [{ kind: 'text', value: `Error: ${message}` }], toolResultError: true };
}

registerAction2(class KillOnyxTerminalCommandAction extends Action2 {
	constructor() {
		super({
			id: 'onyx.terminal.killRunning',
			title: localize2('onyx.terminal.killRunning', "Onyx: Kill Running Terminal Command"),
			f1: true,
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		accessor.get(IOnyxTerminalService).killAll();
	}
});

registerAction2(class ShowOnyxApprovalHistoryAction extends Action2 {
	constructor() {
		super({
			id: 'onyx.terminal.showApprovalHistory',
			title: localize2('onyx.terminal.showApprovalHistory', "Onyx: Show Terminal Approval History"),
			f1: true,
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const history = accessor.get(IOnyxTerminalService).approvalHistory();
		const lines = [
			'// Terminal approval history for this workspace (read-only view, stored on this machine only).',
			'// A record of past decisions. It authorizes nothing: every command asks again, every time.',
			JSON.stringify(history.map(record => ({ ...record, at: new Date(record.at).toISOString() })), undefined, '\t'),
		];
		await accessor.get(IEditorService).openEditor({ resource: undefined, contents: lines.join('\n'), languageId: 'jsonc', options: { pinned: true } });
	}
});

registerAction2(class ClearOnyxLegacyGrantsAction extends Action2 {
	constructor() {
		super({
			id: 'onyx.terminal.clearLegacyGrants',
			title: localize2('onyx.terminal.clearLegacyGrants', "Onyx: Clear Legacy Terminal Grants"),
			f1: true,
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const terminalService = accessor.get(IOnyxTerminalService);
		const dialogService = accessor.get(IDialogService);
		const notificationService = accessor.get(INotificationService);
		const confirmation = await dialogService.confirm({
			message: localize('onyx.terminal.clearLegacy.message', "Clear legacy terminal grants?"),
			detail: localize('onyx.terminal.clearLegacy.detail', "Earlier versions wrote \"always run\" decisions into {0} as \"terminalAllowlist\". Those entries are inactive: every command asks, every time. This removes them from that file in each workspace folder and clears this workspace's approval history. The rest of the file is kept.", ONYX_PROJECT_CONFIG_PATH),
			primaryButton: localize('onyx.terminal.clearLegacy.confirm', "Clear"),
		});
		if (!confirmation.confirmed) {
			return;
		}
		const removed = await terminalService.clearLegacyGrants();
		notificationService.notify({
			severity: Severity.Info,
			message: removed === 0
				? localize('onyx.terminal.clearLegacy.none', "No legacy terminal grants were found. The approval history was cleared.")
				: localize('onyx.terminal.clearLegacy.done', "Removed {0} legacy terminal grant(s) and cleared the approval history.", removed),
		});
	}
});
