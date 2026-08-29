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
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IOnyxRuntimeService } from '../../../../../platform/onyxRuntime/common/onyxRuntime.js';
import { ILanguageModelToolsService, IToolData, IToolImpl, IToolInvocation, IToolResult, ToolDataSource } from '../../../chat/common/tools/languageModelToolsService.js';
import { clampCommandOutput, evaluateCommand, normalizeCommand, OnyxTerminalDecision } from '../../common/onyxTerminalPolicy.js';
import { ONYX_PROJECT_CONFIG_PATH } from '../../common/onyxProjectConfig.js';
import { IOnyxProjectConfigService } from '../config/onyxProjectConfigService.js';
import { IOnyxControlPlaneService } from '../controlPlane/onyxControlPlaneService.js';

export const ONYX_TERMINAL_TOOL_ID = 'onyx_terminal';

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 10 * 60_000;
/** What the model gets back; the journal carries the same capped text. */
const MODEL_OUTPUT_BUDGET = 12_000;
/** Streaming chunks posted to the run timeline, so a long build stays legible. */
const TIMELINE_CHUNK_CHARS = 800;
const TIMELINE_MAX_CHUNKS = 6;

export const IOnyxTerminalService = createDecorator<IOnyxTerminalService>('onyxTerminalService');

export interface IOnyxRunningCommand {
	readonly operationId: string;
	readonly command: string;
	readonly startedAt: number;
	readonly runId: string | undefined;
}

/**
 * The approval gate and executor behind the agent's terminal tool. The policy
 * (what is dangerous, what an allowlist covers) is pure logic in
 * `onyxTerminalPolicy.ts`; this service owns the human side — the approval
 * dialog, the session allowlist, persisting "always allow" decisions into
 * `.onyx/config.json` — and the run side: streaming output into the run
 * timeline, hard timeouts, and the kill switch. Nothing executes without an
 * explicit decision trail.
 */
export interface IOnyxTerminalService {
	readonly _serviceBrand: undefined;
	readonly running: IObservable<readonly IOnyxRunningCommand[]>;
	runCommand(command: string, cwdHint: string | undefined, timeoutMs: number, chatRequestId: string | undefined, token: CancellationToken): Promise<IToolResult>;
	killAll(): void;
}

export class OnyxTerminalService extends Disposable implements IOnyxTerminalService {

	declare readonly _serviceBrand: undefined;

	private readonly _runningObs: ISettableObservable<readonly IOnyxRunningCommand[]> = observableValue(this, []);
	readonly running: IObservable<readonly IOnyxRunningCommand[]> = this._runningObs;

	private readonly _sessionAllowlist: string[] = [];

	constructor(
		@IOnyxRuntimeService private readonly _runtimeService: IOnyxRuntimeService,
		@IOnyxProjectConfigService private readonly _projectConfigService: IOnyxProjectConfigService,
		@IOnyxControlPlaneService private readonly _controlPlaneService: IOnyxControlPlaneService,
		@IWorkspaceContextService private readonly _workspaceService: IWorkspaceContextService,
		@IDialogService private readonly _dialogService: IDialogService,
		@IFileService private readonly _fileService: IFileService,
		@INotificationService private readonly _notificationService: INotificationService,
	) {
		super();
	}

	async runCommand(command: string, cwdHint: string | undefined, timeoutMs: number, chatRequestId: string | undefined, token: CancellationToken): Promise<IToolResult> {
		const folder = this._workspaceService.getWorkspace().folders[0];
		if (!folder) {
			return errorResult('No workspace folder is open — there is nowhere to run the command.');
		}
		const cwd = folder.uri.fsPath;
		const runId = chatRequestId ? this._controlPlaneService.runs.get().find(run => run.requestId === chatRequestId)?.runId : undefined;

		const workspaceAllowlist = this._projectConfigService.resolved.get().config.terminalAllowlist ?? [];
		const evaluation = evaluateCommand(command, workspaceAllowlist, this._sessionAllowlist);
		let decision: OnyxTerminalDecision;
		if (evaluation.autoAllowed) {
			decision = 'allow-session';
			this._appendActivity(runId, { kind: 'note', label: localize('onyx.terminal.autoAllowed', "Command allowed by the workspace allowlist"), reason: normalizeCommand(command) });
		} else {
			decision = await this._askForApproval(evaluation.approval!);
			if (decision === 'deny') {
				this._appendActivity(runId, { kind: 'note', label: localize('onyx.terminal.denied', "Command denied by the user"), reason: normalizeCommand(command), ok: false });
				return { content: [{ kind: 'text', value: 'The user denied this command. Do not retry it; ask the user what to do instead, or continue without it.' }] };
			}
			if (decision === 'allow-session') {
				this._sessionAllowlist.push(normalizeCommand(command));
			}
			if (decision === 'allow-always') {
				this._sessionAllowlist.push(normalizeCommand(command));
				await this._persistAllow(command);
			}
		}

		const operationId = `terminal-${generateUuid()}`;
		const running: IOnyxRunningCommand = { operationId, command: normalizeCommand(command), startedAt: Date.now(), runId };
		this._runningObs.set([...this._runningObs.get(), running], undefined);
		this._appendActivity(runId, { kind: 'note', label: localize('onyx.terminal.running', "Running: {0}", normalizeCommand(command)) });

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
			const result = await this._runtimeService.execCommand(operationId, cwd, command, timeoutMs);
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

	killAll(): void {
		const running = this._runningObs.get();
		for (const entry of running) {
			this._runtimeService.killCommand(entry.operationId);
		}
		if (running.length === 0) {
			this._notificationService.notify({ severity: Severity.Info, message: localize('onyx.terminal.nothingRunning', "No agent terminal command is running.") });
		}
	}

	private async _askForApproval(approval: { message: string; detail: string; dangerous: boolean; offeredDecisions: readonly OnyxTerminalDecision[] }): Promise<OnyxTerminalDecision> {
		const buttons: { label: string; run: () => OnyxTerminalDecision }[] = [];
		if (approval.offeredDecisions.includes('allow-once')) {
			buttons.push({ label: localize('onyx.terminal.allowOnce', "Run Once"), run: () => 'allow-once' });
		}
		if (approval.offeredDecisions.includes('allow-session')) {
			buttons.push({ label: localize('onyx.terminal.allowSession', "Run for This Session"), run: () => 'allow-session' });
		}
		if (approval.offeredDecisions.includes('allow-always')) {
			buttons.push({ label: localize('onyx.terminal.allowAlways', "Always Run This Command"), run: () => 'allow-always' });
		}
		const result = await this._dialogService.prompt<OnyxTerminalDecision>({
			type: approval.dangerous ? Severity.Warning : Severity.Info,
			message: approval.dangerous
				? localize('onyx.terminal.approveDangerous', "The agent wants to run a command that looks dangerous")
				: localize('onyx.terminal.approve', "The agent wants to run a terminal command"),
			detail: approval.detail,
			buttons,
			cancelButton: { label: localize('onyx.terminal.deny', "Deny"), run: () => 'deny' },
		});
		return result.result ?? 'deny';
	}

	/** "Always allow" decisions are team-visible: they land in the checked-in config. */
	private async _persistAllow(command: string): Promise<void> {
		const folder = this._workspaceService.getWorkspace().folders[0];
		if (!folder) {
			return;
		}
		const uri = folder.toResource(ONYX_PROJECT_CONFIG_PATH);
		let existing: Record<string, unknown> = {};
		try {
			const content = await this._fileService.readFile(uri);
			const parsed: unknown = JSON.parse(content.value.toString());
			if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
				existing = parsed as Record<string, unknown>;
			}
		} catch {
			// No config yet (or unreadable): start fresh with just the allowlist.
		}
		const allowlist = Array.isArray(existing.terminalAllowlist) ? existing.terminalAllowlist.filter((entry): entry is string => typeof entry === 'string') : [];
		const normalized = normalizeCommand(command);
		if (!allowlist.includes(normalized)) {
			allowlist.push(normalized);
		}
		existing.terminalAllowlist = allowlist;
		await this._fileService.writeFile(uri, VSBuffer.fromString(JSON.stringify(existing, undefined, '\t') + '\n'));
	}

	private _appendActivity(runId: string | undefined, entry: { kind: 'note'; label: string; reason?: string; ok?: boolean }): void {
		if (runId) {
			this._controlPlaneService.appendActivity(runId, entry);
		}
	}
}

/**
 * Registers the terminal tool with the tools service. The tool itself is a
 * thin veneer: parameter validation here, policy and execution in the
 * terminal service, decisions with the user.
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
			modelDescription: 'Proposes one shell command to run in the workspace root. The user must approve it before it runs; a denied command must not be retried. Output is returned when the command finishes. Use for builds, tests, git status and similar read-mostly commands. Keep commands short and non-interactive.',
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
		const command = typeof parameters.command === 'string' ? parameters.command.trim() : '';
		if (!command) {
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
