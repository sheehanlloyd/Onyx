/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { timeout } from '../../../../../../base/common/async.js';
import { CancellationToken } from '../../../../../../base/common/cancellation.js';
import { CancellationError } from '../../../../../../base/common/errors.js';
import { Emitter, Event } from '../../../../../../base/common/event.js';
import { Disposable, IDisposable, toDisposable } from '../../../../../../base/common/lifecycle.js';
import { observableValue } from '../../../../../../base/common/observable.js';
import { URI } from '../../../../../../base/common/uri.js';
import { IConfirmation, IConfirmationResult, IDialogService, IInput, IInputResult, IPrompt, IPromptBaseButton, IPromptResult, IPromptResultWithCancel, IPromptWithCustomCancel, IPromptWithDefaultCancel } from '../../../../../../platform/dialogs/common/dialogs.js';
import { ExtensionIdentifier } from '../../../../../../platform/extensions/common/extensions.js';
import { FileSystemProviderCapabilities, FileType, IFileService, IFileSystemProviderWithFileRealpathCapability, IStat } from '../../../../../../platform/files/common/files.js';
import { InMemoryFileSystemProvider } from '../../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { FileSystemFileSearchProvider } from '../../../../../services/search/common/fileSystemFileSearchProvider.js';
import { IFileMatch, IFileQuery, ISearchComplete, ISearchService, ITextQuery, OneLineRange, QueryType, TextSearchMatch } from '../../../../../services/search/common/search.js';
import { OnyxBm25Index } from '../../../../../../platform/onyxRuntime/common/onyxBm25.js';
import { commandEnvironment } from '../../../../../../platform/onyxRuntime/common/onyxCommandExecution.js';
import { extractDocSnippet } from '../../../../../../platform/onyxRuntime/common/onyxDocsExtract.js';
import { IOnyxChatParams, IOnyxCommandOptions, IOnyxIndexStats, IOnyxLabHarnessRequest, IOnyxCommandOutputEvent, IOnyxCommandResult, IOnyxCommitCandidate, IOnyxCompletionParams, IOnyxDiff, IOnyxDiscoveredModel, IOnyxDocsHit, IOnyxDocsIndexStats, IOnyxEndpoint, IOnyxMachineProfile, IOnyxPowerState, IOnyxPullProgress, IOnyxRuntimeService, IOnyxStreamEvent, OnyxCommandRefusal, OnyxDiffMode, OnyxContextAliasResult, IOnyxLoadedModel } from '../../../../../../platform/onyxRuntime/common/onyxRuntime.js';
import { IChatMessage, ILanguageModelChatMetadata, ILanguageModelChatMetadataAndIdentifier, ILanguageModelChatProvider, ILanguageModelChatRequestOptions, ILanguageModelChatResponse, ILanguageModelChatSelector, ILanguageModelsService } from '../../../../chat/common/languageModels.js';
import { CountTokensCallback, IToolData, IToolImpl, IToolInvocation, IToolResult } from '../../../../chat/common/tools/languageModelToolsService.js';
import { ITaskService } from '../../../../tasks/common/taskService.js';
import { ITaskSummary } from '../../../../tasks/common/taskSystem.js';
import { InMemoryTask, RunOptions, Task, TaskGroup } from '../../../../tasks/common/tasks.js';
import { seedProfile } from '../../../common/onyxSeedProfiles.js';
import { isAnchoredCall } from '../../../common/onyxAnchorEdit.js';
import { IOnyxEnergyDecision } from '../../../common/onyxEnergyPolicy.js';
import { IOnyxModelProfile, IOnyxObservedStats } from '../../../common/onyxTypes.js';
import { IOnyxEnergyService } from '../../../browser/compute/onyxEnergyService.js';
import { IOnyxPinService } from '../../../browser/intelligence/onyxPinService.js';
import { IOnyxRequestMeasurement } from '../../../browser/model/onyxLanguageModelProvider.js';
import { IOnyxProfileService } from '../../../browser/profiles/onyxProfileService.js';
import { OnyxSimBoundary, OnyxSimModelTurn, SIM_PROCESS_ENVIRONMENT, SIM_SECRET_ENVIRONMENT_NAMES } from './onyxSimEpisode.js';
import { digest, OnyxSimTrace } from './onyxSimTrace.js';

/**
 * The boundaries the rig simulates (L1): the runtime (a scripted stream and a
 * recording command executor), the dialog service (scripted decisions), the
 * core language-model and tool registries (minimal, deterministic), and the
 * passive Onyx services the loop reads configuration from. Everything else
 * in the run is the real product.
 */

/** Lets the scheduler act at a boundary the fakes own. */
export interface IOnyxSimScheduler {
	boundary(name: OnyxSimBoundary): Promise<void>;
	/** The fault scheduled for the boundary the caller just reached, consumed once. */
	takeFault(name: OnyxSimBoundary): import('./onyxSimEpisode.js').OnyxSimFault | undefined;
}

export const SIM_BASE_URL = 'http://localhost:11434/v1';
export const SIM_MODEL_ID = 'sim-coder:7b';
export const SIM_MODEL_KEY = 'localhost:11434/sim-coder:7b';
/** A model the same runtime reports as cloud-backed: reachable through loopback, run somewhere else (B14). */
export const SIM_CLOUD_MODEL_ID = 'sim-coder:480b-cloud';
export const SIM_CLOUD_MODEL_KEY = 'localhost:11434/sim-coder:480b-cloud';

export interface IOnyxSimCommandScript {
	readonly exitCode: number;
	readonly output: string;
	readonly timedOut?: boolean;
}

/**
 * The runtime boundary. Chat completions come from the persona's scripted
 * turns, rendered into exactly the stream events the real shared-process
 * service emits (including its current quirk: a body that ends without
 * `[DONE]` is reported as `done` with no finish reason, and a cancel ends
 * with `done`/`cancelled`). Commands are recorded, never executed.
 */
export class OnyxSimRuntimeService extends Disposable implements IOnyxRuntimeService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeRuntimes = this._register(new Emitter<readonly IOnyxEndpoint[]>());
	readonly onDidChangeRuntimes = this._onDidChangeRuntimes.event;
	private readonly _onDidStream = this._register(new Emitter<IOnyxStreamEvent>());
	readonly onDidStream = this._onDidStream.event;
	private readonly _onDidPullProgress = this._register(new Emitter<IOnyxPullProgress>());
	readonly onDidPullProgress = this._onDidPullProgress.event;
	private readonly _onDidCommandOutput = this._register(new Emitter<IOnyxCommandOutputEvent>());
	readonly onDidCommandOutput = this._onDidCommandOutput.event;

	readonly requests: IOnyxChatParams[] = [];
	readonly commands: { readonly operationId: string; readonly cwd: string; readonly command: string; readonly timeoutMs: number; readonly passEnvironment: boolean }[] = [];
	private readonly _cancelled = new Set<string>();
	private readonly _killed = new Set<string>();
	private readonly _running = new Set<string>();
	private _turnIndex = 0;
	private _disposedByFault = false;

	constructor(
		private readonly _turns: readonly OnyxSimModelTurn[],
		private readonly _persona: string,
		private readonly _scheduler: IOnyxSimScheduler,
		private readonly _trace: OnyxSimTrace,
		private readonly _commandScript: (command: string) => IOnyxSimCommandScript,
		private readonly _commandRefusal: OnyxCommandRefusal | undefined = undefined,
		private readonly _runtimeContextTokens: number | undefined = undefined,
		private readonly _enforcesJsonSchema = false,
		/** Asked for a turn when the script has none left (L8): a model that is really there, or a continuation after a cut point. */
		private readonly _liveTurn: ((params: IOnyxChatParams) => Promise<OnyxSimModelTurn>) | undefined = undefined,
		/** An LM Studio that loads the model on demand at this context (B15); undefined for the usual Ollama. */
		private readonly _lmStudioLoadsAt: number | undefined = undefined,
	) {
		super();
	}

	/** Commands that were dispatched and have neither finished nor been killed. */
	runningCommands(): string[] {
		return [...this._running].filter(operationId => !this._killed.has(operationId));
	}

	wasKilled(operationId: string): boolean {
		return this._killed.has(operationId);
	}

	/** Whether the LM Studio has loaded the model: on the first request or a warm-up, as LM Studio does. */
	private _lmStudioLoaded = false;
	/** Prompts an LM Studio received that were longer than what it loaded the model at: cut, and nothing said. */
	readonly silentlyCut: number[] = [];

	get endpoint(): IOnyxEndpoint {
		return this._lmStudioLoadsAt !== undefined
			? { baseUrl: SIM_BASE_URL, kind: 'lmstudio', displayName: 'LM Studio (simulated)', models: [this.model] }
			: { baseUrl: SIM_BASE_URL, kind: 'ollama', displayName: 'Ollama (simulated)', models: [this.model, this.cloudModel] };
	}

	get model(): IOnyxDiscoveredModel {
		if (this._lmStudioLoadsAt !== undefined) {
			// LM Studio reports the trained context always, and what it loaded the model at only once it is loaded.
			return { id: SIM_MODEL_ID, baseUrl: SIM_BASE_URL, runtime: 'lmstudio', family: 'sim', parameterB: 7, contextLength: 32768, ...(this._lmStudioLoaded ? { serverContextLength: this._lmStudioLoadsAt } : {}), supportsTools: true, supportsJsonSchema: this._enforcesJsonSchema, execution: 'local' };
		}
		// An Ollama on this machine that reports the model as one it runs itself.
		return { id: SIM_MODEL_ID, baseUrl: SIM_BASE_URL, runtime: 'ollama', family: 'sim', parameterB: 7, contextLength: 16384, supportsTools: true, supportsJsonSchema: this._enforcesJsonSchema, execution: 'local' };
	}

	get cloudModel(): IOnyxDiscoveredModel {
		return { id: SIM_CLOUD_MODEL_ID, baseUrl: SIM_BASE_URL, runtime: 'ollama', family: 'sim', parameterB: 480, contextLength: 131072, supportsTools: true, supportsJsonSchema: false, execution: 'cloud', remoteHost: 'https://ollama.com:443' };
	}

	announce(): void {
		this._onDidChangeRuntimes.fire([this.endpoint]);
	}

	/** The environment fault "service dispose": the shared process went away mid-run. */
	simulateDispose(): void {
		this._disposedByFault = true;
	}

	async discoverRuntimes(): Promise<readonly IOnyxEndpoint[]> {
		return [this.endpoint];
	}

	async listModels(): Promise<readonly IOnyxDiscoveredModel[]> {
		return [this.model];
	}

	/**
	 * What a runtime that enforces the envelope schema makes of a scripted turn: the model cannot write
	 * anything but the envelope, so an answer arrives inside one and a tool call arrives as a tool action,
	 * as text. Thinking, cut-off streams and errors are not the grammar's to shape.
	 */
	private _constrain(turn: OnyxSimModelTurn, constrained: boolean): OnyxSimModelTurn {
		if (!constrained) {
			return turn;
		}
		if (turn.kind === 'text' && !turn.text.includes('<think>')) {
			return { ...turn, text: JSON.stringify({ action: 'answer', answer: turn.text }) };
		}
		if (turn.kind === 'toolCall' && turn.argumentsText === undefined) {
			// An anchored edit (L7) is the envelope's own `edit` action. Which anchors a script names is the
			// script's business: a runtime that only claims to enforce a schema lets any through.
			if (turn.tool === 'editFile' && isAnchoredCall(turn.arguments)) {
				return { kind: 'text', text: JSON.stringify({ action: 'edit', edit: turn.arguments }), reasoning: turn.reasoning };
			}
			return { kind: 'text', text: JSON.stringify({ action: 'tool', tool: turn.tool, arguments: turn.arguments }), reasoning: turn.reasoning };
		}
		return turn;
	}

	/** Every turn that was served, in order, as it was before any constraining: what a recording of this run holds (L8). */
	readonly servedTurns: OnyxSimModelTurn[] = [];

	/** The next turn: the script's, then a live one when there is a live source, then the persona's fallback. */
	private async _takeTurn(params: IOnyxChatParams): Promise<OnyxSimModelTurn> {
		const turn = this._turnIndex >= this._turns.length && this._liveTurn ? await this._liveTurn(params) : this._nextTurn();
		this.servedTurns.push(turn);
		return turn;
	}

	/** The next scripted turn; the looping persona repeats its last turn, every other persona falls back to a plain answer. */
	private _nextTurn(): OnyxSimModelTurn {
		if (this._turnIndex < this._turns.length) {
			return this._turns[this._turnIndex++];
		}
		if (this._persona === 'looping' && this._turns.length) {
			return this._turns[this._turns.length - 1];
		}
		return { kind: 'text', text: 'Done.' };
	}

	/**
	 * The reply to the next request, when it is an inline edit's (B9, D12): the user asked for it, so it is not
	 * the script's next turn, and its chunks are `inlineStreaming` boundaries, where the user may keep typing.
	 */
	inlineReply: string | undefined;

	async startChatCompletion(operationId: string, params: IOnyxChatParams): Promise<void> {
		this.requests.push(params);
		const inlineReply = this.inlineReply;
		this.inlineReply = undefined;
		const chunkBoundary: OnyxSimBoundary = inlineReply !== undefined ? 'inlineStreaming' : 'betweenChunks';
		const lastUser = [...params.messages].reverse().find(message => message.role === 'user');
		// Everything the request carries: message text, the calls the model made, and the tool schemas.
		const promptChars = params.messages.reduce((total, message) => total + String(message.content ?? '').length + (message.tool_calls ?? []).reduce((sum, call) => sum + call.function.name.length + call.function.arguments.length, 0), 0);
		const toolsChars = params.tools?.length ? JSON.stringify(params.tools).length : 0;
		this._trace.record({
			kind: 'request',
			turn: this.requests.length,
			model: params.model,
			tools: (params.tools ?? []).map(tool => tool.function.name),
			messageCount: params.messages.length,
			roles: params.messages.map(message => message.role),
			lastUserDigest: digest(String(lastUser?.content ?? '')),
			promptChars,
			toolsChars,
			temperature: params.temperature,
			maxTokens: params.maxTokens,
		});
		if (this._lmStudioLoadsAt !== undefined) {
			this._lmStudioLoaded = true;
			if (Math.ceil((promptChars + toolsChars) / 4) > this._lmStudioLoadsAt) {
				this.silentlyCut.push(Math.ceil((promptChars + toolsChars) / 4));
			}
		}
		if (this._runtimeContextTokens !== undefined && Math.ceil((promptChars + toolsChars) / 4) > this._runtimeContextTokens) {
			// A runtime that checks: the prompt does not fit what it allocated, and it says so.
			this._trace.record({ kind: 'fault', fault: 'contextOverflow', detail: `${Math.ceil((promptChars + toolsChars) / 4)} > ${this._runtimeContextTokens}` });
			this._emit({ operationId, kind: 'error', message: '400 Bad Request: the request exceeds the available context size, try increasing it' });
			return;
		}
		if (this._disposedByFault) {
			this._emit({ operationId, kind: 'error', message: 'the runtime service was disposed' });
			return;
		}
		const turn: OnyxSimModelTurn = inlineReply !== undefined ? { kind: 'text', text: inlineReply, chunks: 4 } : this._constrain(await this._takeTurn(params), params.responseFormat !== undefined);
		const op = this._trace.canonical('op', operationId);
		const emit = async (event: IOnyxStreamEvent, size: number, finishReason?: string) => {
			await this._scheduler.boundary(chunkBoundary);
			if (this._cancelled.has(operationId)) {
				return false;
			}
			const fault = this._scheduler.takeFault(chunkBoundary);
			if (fault?.kind === 'earlyEndOfStream') {
				this._trace.record({ kind: 'fault', fault: fault.kind });
				this._trace.record({ kind: 'chunk', op, delta: 'done', size: 0 });
				// The body ended without a finish reason and without [DONE]: the runtime says so (B12).
				this._emit({ operationId, kind: 'done', finishReason: undefined, ending: 'truncated' });
				return false;
			}
			if (fault?.kind === 'timeout') {
				this._trace.record({ kind: 'fault', fault: fault.kind });
				this._trace.record({ kind: 'chunk', op, delta: 'error', size: 0 });
				this._emit({ operationId, kind: 'error', message: 'fetch failed: the request timed out' });
				return false;
			}
			this._trace.record({ kind: 'chunk', op, delta: event.kind === 'toolCallDelta' ? 'toolCall' : event.kind === 'delta' ? 'text' : event.kind, size, finishReason });
			this._emit(event);
			return true;
		};
		await timeout(1);
		// Thinking sent in a field of its own arrives before the reply it leads to (C4).
		if ((turn.kind === 'text' || turn.kind === 'toolCall') && turn.reasoning) {
			for (const piece of split(turn.reasoning, 3)) {
				if (!await emit({ operationId, kind: 'reasoning', text: piece }, piece.length)) { return; }
			}
		}
		switch (turn.kind) {
			case 'text': {
				for (const piece of split(turn.text, turn.chunks ?? Math.min(8, Math.max(1, Math.ceil(turn.text.length / 24))))) {
					if (!await emit({ operationId, kind: 'delta', text: piece }, piece.length)) { return; }
				}
				if (!await emit({ operationId, kind: 'usage', promptTokens: 420, completionTokens: 25 }, 0)) { return; }
				await emit({ operationId, kind: 'done', finishReason: 'stop', ending: 'complete', seedHonoured: params.seed !== undefined ? true : undefined }, 0, 'stop');
				return;
			}
			case 'toolCall':
			case 'toolCalls': {
				const calls = turn.kind === 'toolCall' ? [{ tool: turn.tool, arguments: turn.arguments, id: turn.id, argumentsText: turn.argumentsText, chunks: turn.chunks }] : turn.calls.map(call => ({ ...call, argumentsText: undefined, chunks: undefined }));
				for (let index = 0; index < calls.length; index++) {
					const call = calls[index];
					const argumentsText = call.argumentsText ?? JSON.stringify(call.arguments);
					if (!await emit({ operationId, kind: 'toolCallDelta', index, id: call.id ?? `call_${index + 1}`, name: call.tool, argumentsDelta: '' }, 0)) { return; }
					for (const piece of split(argumentsText, call.chunks ?? 2)) {
						if (!await emit({ operationId, kind: 'toolCallDelta', index, argumentsDelta: piece }, piece.length)) { return; }
					}
				}
				if (!await emit({ operationId, kind: 'usage', promptTokens: 420, completionTokens: 25 }, 0)) { return; }
				await emit({ operationId, kind: 'done', finishReason: 'tool_calls', ending: 'complete', seedHonoured: params.seed !== undefined ? true : undefined }, 0, 'tool_calls');
				return;
			}
			case 'textToolCall': {
				const text = `I will call the tool now.\n{"tool":"${turn.tool}","arguments":${JSON.stringify(turn.arguments)}}`;
				for (const piece of split(text, 4)) {
					if (!await emit({ operationId, kind: 'delta', text: piece }, piece.length)) { return; }
				}
				await emit({ operationId, kind: 'done', finishReason: 'stop', ending: 'complete' }, 0, 'stop');
				return;
			}
			case 'truncated': {
				for (const piece of split(turn.text, 3)) {
					if (!await emit({ operationId, kind: 'delta', text: piece }, piece.length)) { return; }
				}
				// The body ended without a finish reason and without [DONE].
				await emit({ operationId, kind: 'done', finishReason: undefined, ending: 'truncated' }, 0);
				return;
			}
			case 'stall':
				// Nothing arrives, ever, not even the runtime's own word that the request stalled: the window's
				// deadline, a cancel, or the rig's watchdog ends it.
				return;
			case 'error':
				await emit({ operationId, kind: 'error', message: turn.message }, 0);
				return;
		}
	}

	private _emit(event: IOnyxStreamEvent): void {
		this._onDidStream.fire(event);
	}

	async completeText(_operationId: string, _params: IOnyxCompletionParams): Promise<string | undefined> {
		return undefined;
	}

	async cancel(operationId: string): Promise<void> {
		if (!this._cancelled.has(operationId)) {
			this._cancelled.add(operationId);
			this._trace.record({ kind: 'chunk', op: this._trace.canonical('op', operationId), delta: 'done', size: 0, finishReason: 'cancelled' });
			this._emit({ operationId, kind: 'done', finishReason: 'cancelled', ending: 'cancelled' });
		}
	}

	async execCommand(operationId: string, cwd: string, command: string, timeoutMs: number, options?: IOnyxCommandOptions): Promise<IOnyxCommandResult> {
		if (this._commandRefusal) {
			// The runner refuses before anything is started: there is no dispatch to record.
			return { exitCode: undefined, timedOut: false, killed: false, durationMs: 0, output: '', outputChars: 0, outputTruncated: false, withheldEnvironment: [], refusal: this._commandRefusal };
		}
		const passEnvironment = options?.passEnvironment === true;
		// The command's environment, by the product's own rule over the seeded process environment.
		const child = commandEnvironment(SIM_PROCESS_ENVIRONMENT, passEnvironment);
		const secretEnvironment = SIM_SECRET_ENVIRONMENT_NAMES.filter(name => child.environment[name] !== undefined).length;
		this.commands.push({ operationId, cwd, command, timeoutMs, passEnvironment });
		const op = this._trace.canonical('op', operationId);
		this._trace.record({ kind: 'commandDispatch', op, command, cwd, ...(secretEnvironment > 0 ? { secretEnvironment } : {}) });
		this._running.add(operationId);
		try {
			// The command is running: this is when a window can close under it.
			await this._scheduler.boundary('commandRunning');
			return await this._runCommand(operationId, op, command, child.withheld);
		} finally {
			this._running.delete(operationId);
		}
	}

	private async _runCommand(operationId: string, op: string, command: string, withheldEnvironment: readonly string[]): Promise<IOnyxCommandResult> {
		const scripted = this._commandScript(command);
		const fault = this._scheduler.takeFault('afterToolDispatch');
		let output = scripted.output;
		let exitCode: number | undefined = scripted.exitCode;
		let timedOut = scripted.timedOut ?? false;
		if (fault?.kind === 'commandExit') {
			this._trace.record({ kind: 'fault', fault: fault.kind, detail: String(fault.exitCode) });
			exitCode = fault.exitCode;
		} else if (fault?.kind === 'outputFlood') {
			this._trace.record({ kind: 'fault', fault: fault.kind, detail: String(fault.bytes) });
			output = 'x'.repeat(fault.bytes);
		} else if (fault?.kind === 'timeout') {
			this._trace.record({ kind: 'fault', fault: fault.kind });
			timedOut = true;
			exitCode = undefined;
		}
		for (const piece of split(output, Math.min(12, Math.max(1, Math.ceil(output.length / 700))))) {
			await timeout(1);
			if (this._killed.has(operationId)) {
				break;
			}
			this._onDidCommandOutput.fire({ operationId, stream: 'stdout', text: piece });
		}
		const killed = this._killed.has(operationId);
		// A runtime that hands back everything it has, however much: the renderer's own bounds must hold regardless.
		const result: IOnyxCommandResult = { exitCode: killed ? undefined : exitCode, timedOut, killed, durationMs: 5, output, outputChars: output.length, outputTruncated: false, withheldEnvironment, refusal: undefined };
		this._trace.record({ kind: 'commandResult', op, exitCode: result.exitCode, timedOut, killed });
		return result;
	}

	async killCommand(operationId: string): Promise<void> {
		this._killed.add(operationId);
	}

	async gitRecentFiles(): Promise<readonly string[]> { return []; }
	async gitCommitFileGroups(): Promise<readonly (readonly string[])[]> { return []; }
	async gitDiff(_repoPath: string, _mode: OnyxDiffMode, _maxChars: number): Promise<IOnyxDiff> { return { text: '', files: [], truncated: false }; }
	async gitCommitCandidates(): Promise<readonly IOnyxCommitCandidate[]> { return [{ hash: 'sim0000', subject: 'sim', files: [], insertions: 0, deletions: 0 }]; }
	async gitShowFile(): Promise<string | undefined> { return undefined; }
	async getMachineProfile(): Promise<IOnyxMachineProfile> { return { totalMemoryBytes: 32 * 1024 ** 3, freeMemoryBytes: 16 * 1024 ** 3, cpuModel: 'sim', cpuCount: 8, arch: 'arm64', platform: 'darwin' }; }
	async getPowerState(): Promise<IOnyxPowerState> { return { onBattery: false, thermal: 'nominal', cpuSpeedLimit: undefined }; }
	async warmUpModel(): Promise<void> {
		if (this._lmStudioLoadsAt !== undefined) {
			this._lmStudioLoaded = true;
		}
	}
	async ensureWorkspaceIndex(): Promise<IOnyxIndexStats> { return { files: 0, eligibleFiles: 0, buildMs: 0, truncated: false, source: 'built', builtAt: 0 }; }
	async configureWorkspaceIndex(): Promise<void> { }
	async listLoadedModels(): Promise<readonly IOnyxLoadedModel[] | undefined> {
		return this._lmStudioLoadsAt === undefined ? undefined : this._lmStudioLoaded ? [{ id: SIM_MODEL_ID, contextLength: this._lmStudioLoadsAt }] : [];
	}
	async createContextAlias(): Promise<OnyxContextAliasResult> { return { ok: false, error: 'the simulated runtime creates nothing' }; }
	async removeContextAlias(): Promise<OnyxContextAliasResult> { return { ok: false, error: 'the simulated runtime removes nothing' }; }
	/** What a lab manifest named by the environment would ask for; nothing unless a test sets it. */
	labHarness: IOnyxLabHarnessRequest | undefined;
	async labHarnessRequest(): Promise<IOnyxLabHarnessRequest | undefined> { return this.labHarness; }
	async labCampaignRequest(): Promise<undefined> { return undefined; }
	async gitCommitMessage(): Promise<undefined> { return undefined; }
	async gitCommitsTouching(): Promise<undefined> { return undefined; }
	async evictLoadedModels(): Promise<undefined> { return undefined; }
	async oracleProbe(): Promise<{ readonly available: false; readonly reason: string; readonly steps: readonly [] }> { return { available: false, reason: 'not simulated', steps: [] }; }
	async oracleRun(): Promise<IOnyxCommandResult> { throw new Error('not simulated'); }
	async labCheckout(): Promise<{ readonly ok: false; readonly error: string }> { return { ok: false, error: 'not simulated' }; }
	async labWrite(): Promise<void> { }
	async searchWorkspaceIndex(): Promise<readonly { path: string; score: number }[]> { return []; }
	async updateWorkspaceIndex(): Promise<void> { }
	async worktreeCreate(): Promise<{ readonly worktreePath: string }> { throw new Error('not simulated'); }
	async worktreeWriteFile(): Promise<void> { throw new Error('not simulated'); }
	async worktreeDiff(): Promise<IOnyxDiff> { throw new Error('not simulated'); }
	async worktreeRemove(): Promise<void> { throw new Error('not simulated'); }
	async applyDiff(): Promise<void> { throw new Error('not simulated'); }
	async pullModel(): Promise<void> { throw new Error('not simulated'); }
	/**
	 * The documentation mirror (D11). What the node indexer would walk is supplied by the rig: the workspace's
	 * markdown, outside dot-directories and build output. The index and the snippets are the product's own
	 * (`OnyxBm25Index`, `extractDocSnippet`); only the walk of a real disk is not.
	 */
	docsCorpus: (() => Promise<readonly { readonly path: string; readonly content: string }[]>) | undefined;
	private _docs: { readonly index: OnyxBm25Index; readonly contents: ReadonlyMap<string, string> } | undefined;
	async ensureDocsIndex(): Promise<IOnyxDocsIndexStats> {
		const index = new OnyxBm25Index();
		const contents = new Map<string, string>();
		for (const document of await this.docsCorpus?.() ?? []) {
			index.addDocument(document.path, document.content);
			contents.set(document.path, document.content);
		}
		this._docs = { index, contents };
		return { files: index.documentCount, buildMs: 0, truncated: false, builtAt: Date.now() };
	}
	async searchDocsIndex(_rootPath: string, _persistPath: string, query: string, limit: number): Promise<readonly IOnyxDocsHit[]> {
		const docs = this._docs;
		if (!docs) {
			return [];
		}
		return docs.index.search(query, limit).map(hit => {
			const snippet = extractDocSnippet(docs.contents.get(hit.path) ?? '', query, 24);
			return { path: hit.path, score: hit.score, line: snippet.startLine, snippet: snippet.text };
		});
	}
	async updateDocsIndex(): Promise<void> { }
	analyzeArchitecture(): ReturnType<IOnyxRuntimeService['analyzeArchitecture']> { throw new Error('not simulated'); }
}

function split(text: string, pieces: number): string[] {
	if (text.length === 0 || pieces <= 1) {
		return [text];
	}
	const size = Math.ceil(text.length / pieces);
	const out: string[] = [];
	for (let index = 0; index < text.length; index += size) {
		out.push(text.slice(index, index + size));
	}
	return out;
}

export type OnyxSimDialogDecision = 'allow-once' | 'allow-session' | 'allow-always' | 'deny' | 'dismiss';

/**
 * The dialog boundary. Every prompt is a scheduler boundary (the user may act
 * while it is open), then answered by the scripted decision: a pending user
 * step if one is due, else the episode's default.
 */
export class OnyxSimDialogService implements IDialogService {

	declare readonly _serviceBrand: undefined;
	readonly onWillShowDialog = Event.None;
	readonly onDidShowDialog = Event.None;
	private _handledPromptButtons: IPromptBaseButton<unknown>[] = [];
	/** Every dialog asked, with how it ended. `closedByStop`: the run was stopped while it was open and the stop closed it (B10). */
	readonly prompts: { readonly message: string; readonly detail: string; readonly buttons: readonly string[]; readonly decision: OnyxSimDialogDecision; readonly granted: boolean; readonly closedByStop: boolean; /** How many tool results the run had returned when the dialog opened (I-14). */ readonly toolResultsBefore: number }[] = [];
	/** How many tool results there are so far: set by the rig, so a dialog can say what the model had seen when it opened. */
	toolResultCount: () => number = () => 0;
	private _pending: OnyxSimDialogDecision | undefined;
	private _openDialogs = 0;

	constructor(
		private readonly _default: OnyxSimDialogDecision,
		private readonly _scheduler: IOnyxSimScheduler,
		private readonly _trace: OnyxSimTrace,
	) { }

	/** A user step decided the next dialog. */
	decideNext(decision: OnyxSimDialogDecision): void {
		this._pending = decision;
	}

	/** Whether a prompt or confirmation is open: asked and not yet answered. */
	get hasDialog(): boolean {
		return this._openDialogs > 0;
	}

	prompt<T>(prompt: IPromptWithCustomCancel<T>): Promise<IPromptResultWithCancel<T>>;
	prompt<T>(prompt: IPromptWithDefaultCancel<T>): Promise<IPromptResult<T>>;
	prompt<T>(prompt: IPrompt<T>): Promise<IPromptResult<T>>;
	async prompt<T>(prompt: IPrompt<T> | IPromptWithCustomCancel<T>): Promise<IPromptResult<T> | IPromptResultWithCancel<T>> {
		this._openDialogs++;
		const toolResultsBefore = this.toolResultCount();
		try {
			await this._scheduler.boundary('dialogOpen');
			const detail = typeof prompt.detail === 'string' ? prompt.detail : prompt.detail?.value ?? '';
			if (prompt.token?.isCancellationRequested) {
				// The run was stopped while the dialog was open, and the dialog was given the run's token: the
				// workbench closes it as if its cancel button had been pressed, and nobody answers it (B10).
				this._pending = undefined;
				this.prompts.push({ message: prompt.message, detail, buttons: (prompt.buttons ?? []).map(button => button.label), decision: 'dismiss', granted: false, closedByStop: true, toolResultsBefore });
				this._trace.record({ kind: 'dialog', message: prompt.message, decision: 'closed by stop', granted: false });
				const cancel = prompt.cancelButton;
				return { result: typeof cancel === 'object' && cancel ? await cancel.run({ checkboxChecked: false }) : undefined };
			}
			const decision = this._pending ?? this._default;
			this._pending = undefined;
			// A user who wants to run the command presses a button; one who does not, cancels or dismisses.
			const granted = decision !== 'dismiss' && decision !== 'deny' && (prompt.buttons ?? []).length > 0;
			this.prompts.push({ message: prompt.message, detail, buttons: (prompt.buttons ?? []).map(button => button.label), decision, granted, closedByStop: false, toolResultsBefore });
			this._trace.record({ kind: 'dialog', message: prompt.message, decision, granted });
			this._handledPromptButtons = [...(prompt.buttons ?? [])];
			if (decision === 'dismiss') {
				return { result: undefined };
			}
			if (decision === 'deny') {
				const cancel = prompt.cancelButton;
				return { result: typeof cancel === 'object' && cancel ? await cancel.run({ checkboxChecked: false }) : undefined };
			}
			// The terminal service's buttons return the decision they stand for; pick the one that matches.
			for (const button of prompt.buttons ?? []) {
				const value = await button.run({ checkboxChecked: false });
				if (value === decision) {
					return { result: value };
				}
			}
			// The decision was not offered (a dangerous command offers only Run Once): the user picks the first.
			const first = prompt.buttons?.[0];
			return { result: first ? await first.run({ checkboxChecked: false }) : undefined };
		} finally {
			this._openDialogs--;
		}
	}

	/** The buttons the last prompt offered, for assertions on what the user was shown. */
	get lastButtons(): readonly IPromptBaseButton<unknown>[] {
		return this._handledPromptButtons;
	}

	async confirm(_confirmation: IConfirmation): Promise<IConfirmationResult> {
		this._openDialogs++;
		try {
			await this._scheduler.boundary('dialogOpen');
			return { confirmed: this._default !== 'deny' && this._default !== 'dismiss' };
		} finally {
			this._openDialogs--;
		}
	}

	async input(_input: IInput): Promise<IInputResult> {
		return { confirmed: false, values: [] };
	}

	async info(): Promise<void> { }
	async warn(): Promise<void> { }
	async error(): Promise<void> { }
	async about(): Promise<void> { }
}

/**
 * The core language-model registry, reduced to what the loop calls, routing
 * every request to the real Onyx provider. Registered as a partial stub.
 */
export class OnyxSimLanguageModelsService implements Pick<ILanguageModelsService, 'getLanguageModelIds' | 'lookupLanguageModel' | 'selectLanguageModels' | 'sendChatRequest' | 'hasResolvedVendor' | 'computeTokenLength'> {

	declare readonly _serviceBrand: undefined;
	readonly onDidChangeLanguageModelVendors = Event.None;
	readonly onDidChangeLanguageModels = Event.None;
	private _infos: ILanguageModelChatMetadataAndIdentifier[] = [];

	constructor(private readonly _provider: ILanguageModelChatProvider) { }

	async refresh(): Promise<void> {
		this._infos = await this._provider.provideLanguageModelChatInfo({ silent: true }, CancellationToken.None);
	}

	getLanguageModelIds(): string[] { return this._infos.map(info => info.identifier); }
	lookupLanguageModel(modelId: string): ILanguageModelChatMetadata | undefined { return this._infos.find(info => info.identifier === modelId)?.metadata; }
	hasResolvedVendor(): boolean { return true; }
	async selectLanguageModels(_selector: ILanguageModelChatSelector): Promise<string[]> { return this.getLanguageModelIds(); }
	async sendChatRequest(modelId: string, from: ExtensionIdentifier | undefined, messages: IChatMessage[], options: ILanguageModelChatRequestOptions, token: CancellationToken): Promise<ILanguageModelChatResponse> {
		const response = await this._provider.sendChatRequest(modelId, messages, from, options, token);
		// The provider's `result` rejects on a stream error. The loop observes
		// it only after the stream itself threw, so without an observer here
		// every stream error is also an unhandled rejection in the window.
		// Recorded as a stream error; the product's own handling is unchanged.
		response.result.catch((error: unknown) => {
			this.streamErrors.push(error instanceof Error ? error.message : String(error));
		});
		return response;
	}
	async computeTokenLength(): Promise<number> { return 0; }
	readonly streamErrors: string[] = [];
}

/**
 * The core tool registry: holds the tools the Onyx contributions register
 * and dispatches to them, with a scheduler boundary before and after each
 * dispatch and the tool-error fault in between. It is deliberately minimal;
 * the real service's confirmations and sessions belong to Module 2's scope.
 */
export class OnyxSimToolsService {

	declare readonly _serviceBrand: undefined;
	readonly onDidChangeTools = Event.None;
	private readonly _data = new Map<string, IToolData>();
	private readonly _impls = new Map<string, IToolImpl>();
	readonly invocations: { readonly toolId: string; readonly parameters: unknown }[] = [];
	/** The text of every tool result, in dispatch order: what the model is about to be shown. */
	readonly results: { readonly toolId: string; readonly text: string; readonly ok: boolean }[] = [];

	constructor(private readonly _scheduler: IOnyxSimScheduler, private readonly _trace: OnyxSimTrace) { }

	registerToolData(toolData: IToolData): IDisposable {
		this._data.set(toolData.id, toolData);
		return toDisposable(() => this._data.delete(toolData.id));
	}

	registerToolImplementation(id: string, tool: IToolImpl): IDisposable {
		this._impls.set(id, tool);
		return toDisposable(() => this._impls.delete(id));
	}

	registerTool(toolData: IToolData, tool: IToolImpl): IDisposable {
		const a = this.registerToolData(toolData);
		const b = this.registerToolImplementation(toolData.id, tool);
		return toDisposable(() => { a.dispose(); b.dispose(); });
	}

	getTools(): Iterable<IToolData> {
		return [...this._data.values()];
	}

	getTool(id: string): IToolData | undefined {
		return this._data.get(id);
	}

	getToolByName(name: string): IToolData | undefined {
		return [...this._data.values()].find(tool => tool.toolReferenceName === name);
	}

	async invokeTool(invocation: IToolInvocation, countTokens: CountTokensCallback, token: CancellationToken): Promise<IToolResult> {
		const tool = this._data.get(invocation.toolId);
		const impl = this._impls.get(invocation.toolId);
		const name = tool?.toolReferenceName ?? invocation.toolId;
		const call = this._trace.canonical('call', invocation.callId);
		this.invocations.push({ toolId: invocation.toolId, parameters: invocation.parameters });
		this._trace.record({ kind: 'toolDispatch', call, tool: name, argumentsDigest: digest(JSON.stringify(invocation.parameters)) });
		await this._scheduler.boundary('beforeToolDispatch');
		const fault = this._scheduler.takeFault('beforeToolDispatch');
		if (fault?.kind === 'toolError') {
			this._trace.record({ kind: 'fault', fault: fault.kind, detail: fault.message });
			this._trace.record({ kind: 'toolResult', call, tool: name, ok: false, resultDigest: digest(fault.message) });
			return { content: [{ kind: 'text', value: `Error: ${fault.message}` }], toolResultError: true };
		}
		if (!impl) {
			const message = `Error: no implementation registered for ${invocation.toolId}`;
			this._trace.record({ kind: 'toolResult', call, tool: name, ok: false, resultDigest: digest(message) });
			return { content: [{ kind: 'text', value: message }], toolResultError: true };
		}
		// As the product's tools service does: a call whose token is cancelled before the tool is entered is not invoked.
		if (token.isCancellationRequested) {
			this._trace.record({ kind: 'toolResult', call, tool: name, ok: false, resultDigest: digest('cancelled') });
			throw new CancellationError();
		}
		const result = await impl.invoke(invocation, countTokens, { report: () => { } }, token);
		const text = result.content.map(part => part.kind === 'text' ? part.value : '').join('');
		this.results.push({ toolId: invocation.toolId, text, ok: !result.toolResultError });
		this._trace.record({ kind: 'toolResult', call, tool: name, ok: !result.toolResultError, resultDigest: digest(text) });
		await this._scheduler.boundary('afterToolDispatch');
		return result;
	}
}

export class OnyxSimProfileService implements IOnyxProfileService {
	declare readonly _serviceBrand: undefined;
	readonly onDidChangeProfiles = Event.None;
	/** What the loop reported as fitting after an overflow, newest last. */
	readonly observedContexts: number[] = [];
	/**
	 * `contextFromDiscovery`: the context is the one the product's own seed profile takes from what discovery
	 * found (B15), not the episode's fixed number. For an LM Studio episode, whose discovery changes when the
	 * model is loaded.
	 */
	constructor(private readonly _profile: IOnyxModelProfile, private readonly _contextFromDiscovery = false) { }
	/** The profile, with the context narrowed to what an overflow taught, as the real service does. */
	getProfile(_modelKey?: string, discovered?: IOnyxDiscoveredModel): IOnyxModelProfile {
		const base = this._contextFromDiscovery && discovered ? (() => { const seeded = seedProfile(discovered); return { ...this._profile, contextLength: seeded.contextLength, context: seeded.context }; })() : this._profile;
		const observed = this.observedContexts.at(-1);
		return observed === undefined ? base : { ...base, contextLength: Math.min(base.contextLength, observed) };
	}
	reportContextOverflow(_modelKey: string, observedTokens: number): void { this.observedContexts.push(observedTokens); }
	getStats(): IOnyxObservedStats | undefined { return undefined; }
	reportMeasurement(_measurement: IOnyxRequestMeasurement): void { }
	reportOutcome(): void { }
	reportFimMeasurement(): void { }
	reportConstrainedOutcome(): void { }
	reportBenchScore(): void { }
	setOverride(): void { }
	exportAll(): { stats: Record<string, IOnyxObservedStats>; overrides: Record<string, Partial<IOnyxModelProfile>> } { return { stats: {}, overrides: {} }; }
}

export class OnyxSimEnergyService implements IOnyxEnergyService {
	declare readonly _serviceBrand: undefined;
	readonly state = observableValue<IOnyxPowerState>(this, { onBattery: false, thermal: 'nominal', cpuSpeedLimit: undefined });
	readonly decision = observableValue<IOnyxEnergyDecision>(this, { maxParameterB: undefined, autocompleteEnabled: true, autocompleteExtraDebounceMs: 0, downshifted: false, reason: '' });
}

export class OnyxSimPinService implements IOnyxPinService {
	declare readonly _serviceBrand: undefined;
	readonly pins = observableValue<readonly string[]>(this, []);
	readonly exclusions = observableValue<readonly string[]>(this, []);
	pin(): void { }
	unpin(): void { }
	exclude(): void { }
	readmit(): void { }
}


/**
 * The task boundary. A workspace has one test task, as a repository's
 * `tasks.json` would define it; running it is recorded as a command dispatch,
 * because that is what it is (I-02), and never executed.
 */
export class OnyxSimTaskService implements Pick<ITaskService, 'tasks' | 'run'> {
	declare readonly _serviceBrand: undefined;
	readonly ran: string[] = [];

	constructor(private readonly _trace: OnyxSimTrace) { }

	async tasks(): Promise<Task[]> {
		return [new InMemoryTask('sim-test', { kind: 'inMemory', label: 'sim' }, 'npm: test', 'inMemory', RunOptions.defaults, { identifier: 'npm: test', group: TaskGroup.Test._id })];
	}

	async run(task: Task | undefined): Promise<ITaskSummary> {
		const label = task?._label ?? 'unknown';
		this.ran.push(label);
		const op = this._trace.canonical('op', `task-${this.ran.length}`);
		this._trace.record({ kind: 'commandDispatch', op, command: `Task: ${label}`, cwd: undefined });
		this._trace.record({ kind: 'commandResult', op, exitCode: 0, timedOut: false, killed: false });
		return { exitCode: 0 };
	}
}

export function simWorkspaceUri(): URI {
	return URI.file('/ws');
}

/**
 * Tools the core registry holds that are not Onyx's: reviewed read tools, the
 * network tools behind the opt-in, tools the contract excludes, and tools it
 * has never heard of (an MCP tool, an extension tool, a new core tool, and
 * one squatting on an essential tool's name). The fakes do nothing but
 * answer; what matters is whether the harness ever offers or calls them.
 */
export const SIM_CORE_TOOLS: readonly { readonly id: string; readonly name: string; readonly source: 'internal' | 'extension' | 'mcp' }[] = [
	{ id: 'vscode_listCodeUsages', name: 'usages', source: 'internal' },
	{ id: 'testFailure', name: 'testFailure', source: 'internal' },
	{ id: 'open_browser_page', name: 'openBrowserPage', source: 'internal' },
	{ id: 'read_page', name: 'readPage', source: 'internal' },
	{ id: 'vscode_fetchWebPage_internal', name: 'vscode_fetchWebPage_internal', source: 'internal' },
	{ id: 'run_in_terminal', name: 'runInTerminal', source: 'internal' },
	{ id: 'run_task', name: 'runTask', source: 'internal' },
	{ id: 'create_and_run_task', name: 'createAndRunTask', source: 'internal' },
	{ id: 'vscode_renameSymbol', name: 'rename', source: 'internal' },
	{ id: 'run_playwright_code', name: 'runPlaywrightCode', source: 'internal' },
	{ id: 'kill_terminal', name: 'killTerminal', source: 'internal' },
	{ id: 'runTests', name: 'runTests', source: 'internal' },
	{ id: 'manage_todo_list', name: 'todo', source: 'internal' },
	{ id: 'vscode_brandNewTool_internal', name: 'brandNewTool', source: 'internal' },
	{ id: 'mcp_filesystem_write', name: 'mcp_filesystem_write', source: 'mcp' },
	{ id: 'acme_deploy', name: 'acme_deploy', source: 'extension' },
	{ id: 'copilot_readFile', name: 'readFile', source: 'extension' },
];

/**
 * The in-memory file system with symbolic links: a linked path reads as its
 * target's content, reports the link type, and resolves to the target's real
 * path. That is all a link is to the code under test.
 */
export class OnyxSimFileSystemProvider extends InMemoryFileSystemProvider implements IFileSystemProviderWithFileRealpathCapability {

	private readonly _links = new Map<string, string>();

	override get capabilities(): FileSystemProviderCapabilities {
		return super.capabilities | FileSystemProviderCapabilities.FileRealpath;
	}

	/** Declares that the file already written at `path` is a link to `target`. */
	addLink(path: string, target: string): void {
		this._links.set(path, target);
	}

	async realpath(resource: URI): Promise<string> {
		return this.realLocation(resource.path);
	}

	/** Where a path really is, links followed. The same answer `realpath` gives, for a check that cannot wait. */
	realLocation(path: string): string {
		for (const [link, target] of this._links) {
			if (path === link || path.startsWith(`${link}/`)) {
				return target + path.slice(link.length);
			}
		}
		return path;
	}

	override async stat(resource: URI): Promise<IStat> {
		const stat = await super.stat(resource);
		return this._links.has(resource.path) ? { ...stat, type: stat.type | FileType.SymbolicLink } : stat;
	}

	override async readdir(resource: URI): Promise<[string, FileType][]> {
		const entries = await super.readdir(resource);
		const prefix = resource.path.endsWith('/') ? resource.path : `${resource.path}/`;
		return entries.map(([name, type]) => this._links.has(prefix + name) ? [name, type | FileType.SymbolicLink] : [name, type]);
	}
}

/**
 * The search boundary. File search is upstream's own provider for file
 * systems without native search, walking the in-memory disk with the real
 * exclude and ignore-file handling; text search greps the files it finds.
 */
export class OnyxSimSearchService extends Disposable implements Pick<ISearchService, 'fileSearch' | 'textSearch'> {

	declare readonly _serviceBrand: undefined;
	private readonly _files: FileSystemFileSearchProvider;
	readonly queries: { readonly kind: 'file' | 'text'; readonly ignoreSymlinks: boolean; readonly cancelled: boolean }[] = [];

	constructor(private readonly _fileService: IFileService) {
		super();
		this._files = this._register(new FileSystemFileSearchProvider(_fileService));
	}

	async fileSearch(query: IFileQuery, token: CancellationToken = CancellationToken.None): Promise<ISearchComplete> {
		this.queries.push({ kind: 'file', ignoreSymlinks: query.folderQueries.every(folder => folder.ignoreSymlinks === true), cancelled: token.isCancellationRequested });
		return this._files.fileSearch(query, token);
	}

	/** Called once, as the next text search begins: the moment a test cancels a search that is already under way. */
	beforeNextTextSearch: (() => void) | undefined;

	async textSearch(query: ITextQuery, token: CancellationToken = CancellationToken.None): Promise<ISearchComplete> {
		this.beforeNextTextSearch?.();
		this.beforeNextTextSearch = undefined;
		this.queries.push({ kind: 'text', ignoreSymlinks: query.folderQueries.every(folder => folder.ignoreSymlinks === true), cancelled: token.isCancellationRequested });
		const files = await this._files.fileSearch({ type: QueryType.File, folderQueries: query.folderQueries, includePattern: query.includePattern, excludePattern: query.excludePattern }, token);
		const source = query.contentPattern.isRegExp ? query.contentPattern.pattern : query.contentPattern.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		const pattern = new RegExp(source, query.contentPattern.isCaseSensitive ? '' : 'i');
		const results: IFileMatch[] = [];
		let matches = 0;
		let limitHit = false;
		for (const file of [...files.results].sort((a, b) => a.resource.path.localeCompare(b.resource.path))) {
			const text = (await this._fileService.readFile(file.resource)).value.toString();
			const fileMatches: TextSearchMatch[] = [];
			text.split('\n').forEach((line, index) => {
				const match = pattern.exec(line);
				if (!match) {
					return;
				}
				if (query.maxResults !== undefined && matches >= query.maxResults) {
					limitHit = true;
					return;
				}
				matches++;
				fileMatches.push(new TextSearchMatch(line, new OneLineRange(index, match.index, match.index + match[0].length), query.previewOptions));
			});
			if (fileMatches.length) {
				results.push({ resource: file.resource, results: fileMatches });
			}
		}
		return { results, limitHit, messages: [] };
	}
}
