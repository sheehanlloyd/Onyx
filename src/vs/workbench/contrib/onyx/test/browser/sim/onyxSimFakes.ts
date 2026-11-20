/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { timeout } from '../../../../../../base/common/async.js';
import { CancellationToken } from '../../../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../../../base/common/event.js';
import { Disposable, IDisposable, toDisposable } from '../../../../../../base/common/lifecycle.js';
import { IObservable, observableValue } from '../../../../../../base/common/observable.js';
import { URI } from '../../../../../../base/common/uri.js';
import { IConfirmation, IConfirmationResult, IDialogService, IInput, IInputResult, IPrompt, IPromptBaseButton, IPromptResult, IPromptResultWithCancel, IPromptWithCustomCancel, IPromptWithDefaultCancel } from '../../../../../../platform/dialogs/common/dialogs.js';
import { ExtensionIdentifier } from '../../../../../../platform/extensions/common/extensions.js';
import { IOnyxChatParams, IOnyxCommandOutputEvent, IOnyxCommandResult, IOnyxCommitCandidate, IOnyxCompletionParams, IOnyxDiff, IOnyxDiscoveredModel, IOnyxDocsHit, IOnyxDocsIndexStats, IOnyxEndpoint, IOnyxMachineProfile, IOnyxPowerState, IOnyxPullProgress, IOnyxRuntimeService, IOnyxStreamEvent, OnyxDiffMode } from '../../../../../../platform/onyxRuntime/common/onyxRuntime.js';
import { IChatMessage, ILanguageModelChatMetadata, ILanguageModelChatMetadataAndIdentifier, ILanguageModelChatProvider, ILanguageModelChatRequestOptions, ILanguageModelChatResponse, ILanguageModelChatSelector, ILanguageModelsService } from '../../../../chat/common/languageModels.js';
import { CountTokensCallback, IToolData, IToolImpl, IToolInvocation, IToolResult } from '../../../../chat/common/tools/languageModelToolsService.js';
import { IOnyxEnergyDecision } from '../../../common/onyxEnergyPolicy.js';
import { IOnyxProjectConfig } from '../../../common/onyxProjectConfig.js';
import { IOnyxModelProfile, IOnyxObservedStats } from '../../../common/onyxTypes.js';
import { IOnyxEnergyService } from '../../../browser/compute/onyxEnergyService.js';
import { IOnyxProjectConfigService, IOnyxResolvedProjectConfig } from '../../../browser/config/onyxProjectConfigService.js';
import { IOnyxPinService } from '../../../browser/intelligence/onyxPinService.js';
import { IOnyxRequestMeasurement } from '../../../browser/model/onyxLanguageModelProvider.js';
import { IOnyxDiscoveredPlaybook, IOnyxPlaybookService } from '../../../browser/playbooks/onyxPlaybookService.js';
import { IOnyxProfileService } from '../../../browser/profiles/onyxProfileService.js';
import { OnyxSimBoundary, OnyxSimModelTurn } from './onyxSimEpisode.js';
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
	readonly commands: { readonly operationId: string; readonly cwd: string; readonly command: string; readonly timeoutMs: number }[] = [];
	private readonly _cancelled = new Set<string>();
	private readonly _killed = new Set<string>();
	private _turnIndex = 0;
	private _disposedByFault = false;

	constructor(
		private readonly _turns: readonly OnyxSimModelTurn[],
		private readonly _persona: string,
		private readonly _scheduler: IOnyxSimScheduler,
		private readonly _trace: OnyxSimTrace,
		private readonly _commandScript: (command: string) => IOnyxSimCommandScript,
	) {
		super();
	}

	get endpoint(): IOnyxEndpoint {
		return { baseUrl: SIM_BASE_URL, kind: 'ollama', displayName: 'Ollama (simulated)', models: [this.model] };
	}

	get model(): IOnyxDiscoveredModel {
		return { id: SIM_MODEL_ID, baseUrl: SIM_BASE_URL, runtime: 'ollama', family: 'sim', parameterB: 7, contextLength: 16384, supportsTools: true, supportsJsonSchema: false };
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

	async startChatCompletion(operationId: string, params: IOnyxChatParams): Promise<void> {
		this.requests.push(params);
		const lastUser = [...params.messages].reverse().find(message => message.role === 'user');
		this._trace.record({
			kind: 'request',
			turn: this.requests.length,
			model: params.model,
			tools: (params.tools ?? []).map(tool => tool.function.name),
			messageCount: params.messages.length,
			roles: params.messages.map(message => message.role),
			lastUserDigest: digest(String(lastUser?.content ?? '')),
			promptChars: params.messages.reduce((total, message) => total + String(message.content ?? '').length, 0),
			temperature: params.temperature,
			maxTokens: params.maxTokens,
		});
		if (this._disposedByFault) {
			this._emit({ operationId, kind: 'error', message: 'the runtime service was disposed' });
			return;
		}
		const turn = this._nextTurn();
		const op = this._trace.canonical('op', operationId);
		const emit = async (event: IOnyxStreamEvent, size: number, finishReason?: string) => {
			await this._scheduler.boundary('betweenChunks');
			if (this._cancelled.has(operationId)) {
				return false;
			}
			const fault = this._scheduler.takeFault('betweenChunks');
			if (fault?.kind === 'earlyEndOfStream') {
				this._trace.record({ kind: 'fault', fault: fault.kind });
				this._trace.record({ kind: 'chunk', op, delta: 'done', size: 0 });
				this._emit({ operationId, kind: 'done', finishReason: undefined });
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
		switch (turn.kind) {
			case 'text': {
				for (const piece of split(turn.text, turn.chunks ?? Math.min(8, Math.max(1, Math.ceil(turn.text.length / 24))))) {
					if (!await emit({ operationId, kind: 'delta', text: piece }, piece.length)) { return; }
				}
				if (!await emit({ operationId, kind: 'usage', promptTokens: 420, completionTokens: 25 }, 0)) { return; }
				await emit({ operationId, kind: 'done', finishReason: 'stop', seedHonoured: params.seed !== undefined ? true : undefined }, 0, 'stop');
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
				await emit({ operationId, kind: 'done', finishReason: 'tool_calls', seedHonoured: params.seed !== undefined ? true : undefined }, 0, 'tool_calls');
				return;
			}
			case 'textToolCall': {
				const text = `I will call the tool now.\n{"tool":"${turn.tool}","arguments":${JSON.stringify(turn.arguments)}}`;
				for (const piece of split(text, 4)) {
					if (!await emit({ operationId, kind: 'delta', text: piece }, piece.length)) { return; }
				}
				await emit({ operationId, kind: 'done', finishReason: 'stop' }, 0, 'stop');
				return;
			}
			case 'truncated': {
				for (const piece of split(turn.text, 3)) {
					if (!await emit({ operationId, kind: 'delta', text: piece }, piece.length)) { return; }
				}
				// The body ended without [DONE]: today's runtime reports that as done with no reason.
				await emit({ operationId, kind: 'done', finishReason: undefined }, 0);
				return;
			}
			case 'stall':
				// Nothing arrives until a timeout fault, a cancel, or the rig's watchdog ends it.
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
			this._emit({ operationId, kind: 'done', finishReason: 'cancelled' });
		}
	}

	async execCommand(operationId: string, cwd: string, command: string, timeoutMs: number): Promise<IOnyxCommandResult> {
		this.commands.push({ operationId, cwd, command, timeoutMs });
		const op = this._trace.canonical('op', operationId);
		this._trace.record({ kind: 'commandDispatch', op, command, cwd });
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
		const result: IOnyxCommandResult = { exitCode: killed ? undefined : exitCode, timedOut, killed, durationMs: 5, output };
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
	async warmUpModel(): Promise<void> { }
	async ensureWorkspaceIndex(): Promise<{ files: number; buildMs: number; truncated: boolean }> { return { files: 0, buildMs: 0, truncated: false }; }
	async searchWorkspaceIndex(): Promise<readonly { path: string; score: number }[]> { return []; }
	async updateWorkspaceIndex(): Promise<void> { }
	async worktreeCreate(): Promise<{ readonly worktreePath: string }> { throw new Error('not simulated'); }
	async worktreeWriteFile(): Promise<void> { throw new Error('not simulated'); }
	async worktreeDiff(): Promise<IOnyxDiff> { throw new Error('not simulated'); }
	async worktreeRemove(): Promise<void> { throw new Error('not simulated'); }
	async applyDiff(): Promise<void> { throw new Error('not simulated'); }
	async pullModel(): Promise<void> { throw new Error('not simulated'); }
	async ensureDocsIndex(): Promise<IOnyxDocsIndexStats> { throw new Error('not simulated'); }
	async searchDocsIndex(): Promise<readonly IOnyxDocsHit[]> { return []; }
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
	readonly prompts: { readonly message: string; readonly decision: OnyxSimDialogDecision }[] = [];
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
		try {
			await this._scheduler.boundary('dialogOpen');
			const decision = this._pending ?? this._default;
			this._pending = undefined;
			this.prompts.push({ message: prompt.message, decision });
			this._trace.record({ kind: 'dialog', message: prompt.message, decision });
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
		const result = await impl.invoke(invocation, countTokens, { report: () => { } }, token);
		const text = result.content.map(part => part.kind === 'text' ? part.value : '').join('');
		this._trace.record({ kind: 'toolResult', call, tool: name, ok: !result.toolResultError, resultDigest: digest(text) });
		await this._scheduler.boundary('afterToolDispatch');
		return result;
	}
}

export class OnyxSimProfileService implements IOnyxProfileService {
	declare readonly _serviceBrand: undefined;
	readonly onDidChangeProfiles = Event.None;
	constructor(private readonly _profile: IOnyxModelProfile) { }
	getProfile(): IOnyxModelProfile { return this._profile; }
	getStats(): IOnyxObservedStats | undefined { return undefined; }
	reportMeasurement(_measurement: IOnyxRequestMeasurement): void { }
	reportOutcome(): void { }
	reportFimMeasurement(): void { }
	reportConstrainedOutcome(): void { }
	reportBenchScore(): void { }
	setOverride(): void { }
	exportAll(): { stats: Record<string, IOnyxObservedStats>; overrides: Record<string, Partial<IOnyxModelProfile>> } { return { stats: {}, overrides: {} }; }
}

export class OnyxSimProjectConfigService implements IOnyxProjectConfigService {
	declare readonly _serviceBrand: undefined;
	private readonly _resolved = observableValue<IOnyxResolvedProjectConfig>(this, { config: {}, sources: [], problems: [] });
	get resolved(): IObservable<IOnyxResolvedProjectConfig> { return this._resolved; }
	setConfig(config: IOnyxProjectConfig): void { this._resolved.set({ config, sources: ['sim'], problems: [] }, undefined); }
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

export class OnyxSimPlaybookService implements IOnyxPlaybookService {
	declare readonly _serviceBrand: undefined;
	readonly playbooks = observableValue<readonly IOnyxDiscoveredPlaybook[]>(this, []);
	getPlaybook(): IOnyxDiscoveredPlaybook | undefined { return undefined; }
}

/** The sim never runs project checks; `OnyxTaskVerification.enabled` reads the setting, which is empty. */
export const simTaskService = {};

export function simWorkspaceUri(): URI {
	return URI.file('/ws');
}
