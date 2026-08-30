/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { AsyncIterableSource } from '../../../../../base/common/async.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { localize } from '../../../../../nls.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { createDecorator, IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IOnyxDiscoveredModel, IOnyxRuntimeService } from '../../../../../platform/onyxRuntime/common/onyxRuntime.js';
import { nullExtensionDescription } from '../../../../services/extensions/common/extensions.js';
import { ExtensionIdentifier } from '../../../../../platform/extensions/common/extensions.js';
import { IChatMessage, IChatResponsePart, ILanguageModelChatMetadataAndIdentifier, ILanguageModelChatProvider, ILanguageModelChatRequestOptions, ILanguageModelChatResponse } from '../../../chat/common/languageModels.js';
import { getOnyxEndpointSettings, OnyxSettingId } from '../../common/onyxConfiguration.js';
import { humanizeRuntimeError } from '../../common/onyxRuntimeErrors.js';
import { IOnyxModelProfile, ONYX_AUTO_MODEL_ID, ONYX_VENDOR } from '../../common/onyxTypes.js';
import { IOnyxProfileService } from '../profiles/onyxProfileService.js';
import { IOnyxRouterService } from '../routing/onyxRouterService.js';
import { estimateMessageTokens, estimateTokens, IRequestTool, ToolCallAccumulator, toWireMessages, toWireTools } from './onyxOpenAITranslator.js';

export const IOnyxModelService = createDecorator<IOnyxModelService>('onyxModelService');

/** Residency hint sent to runtimes that honor `keep_alive` (Ollama). */
const KEEP_ALIVE = '30m';
/** Fallback residency when holding this model with the other warm ones would not fit in memory. */
const SHORT_KEEP_ALIVE = '5m';
/** A model used within this window is assumed still resident — must not exceed {@link KEEP_ALIVE}. */
const RESIDENCY_WINDOW_MS = 25 * 60 * 1000;
/** Rough resident size of a Q4-quantized model, in GB per billion parameters. */
const GB_PER_BILLION = 0.75;

/** A model Onyx can serve requests with: its runtime metadata plus the effective harness profile. */
export interface IOnyxKnownModel {
	/** Stable key used for profiles, stats and routing: `<host:port>/<modelId>`. */
	readonly key: string;
	readonly discovered: IOnyxDiscoveredModel;
	readonly profile: IOnyxModelProfile;
	readonly apiKey?: string;
}

/** Telemetry-free, local-only measurements for one completed request. */
export interface IOnyxRequestMeasurement {
	readonly modelKey: string;
	readonly requestedModelId: string;
	readonly timeToFirstTokenMs: number | undefined;
	readonly tokensPerSecond: number | undefined;
	/** Wall-clock spent generating (first token → done). The local cost of the request. */
	readonly generationMs: number | undefined;
	readonly promptTokens: number | undefined;
	readonly completionTokens: number | undefined;
	readonly toolCallCount: number;
	readonly toolCallParseFailures: number;
	readonly finishReason: string | undefined;
	readonly errorMessage?: string;
	/** Whether the model had to be loaded for this request (no recent use). */
	readonly wasCold: boolean;
}

export interface IOnyxModelService extends ILanguageModelChatProvider {
	readonly _serviceBrand: undefined;
	readonly onDidChangeModels: Event<void>;
	/** Fires after every request completes (successfully or not) with its local measurements. */
	readonly onDidMeasureRequest: Event<IOnyxRequestMeasurement>;
	getKnownModels(): readonly IOnyxKnownModel[];
	getKnownModel(key: string): IOnyxKnownModel | undefined;
	refresh(): Promise<void>;
	/** Whether the model was used recently enough that its weights should still be resident. */
	isWarm(modelKey: string): boolean;
	/** Loads a model's weights ahead of use. Fire-and-forget. */
	warmUp(modelKey: string): Promise<void>;
	/** Fires when a request starts against a cold model and again when its first token arrives. */
	readonly onDidChangeLoading: Event<{ readonly modelKey: string; readonly loading: boolean }>;
}

export class OnyxModelService extends Disposable implements IOnyxModelService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;
	readonly onDidChangeModels = this._onDidChange.event;

	private readonly _onDidMeasureRequest = this._register(new Emitter<IOnyxRequestMeasurement>());
	readonly onDidMeasureRequest = this._onDidMeasureRequest.event;

	private _models = new Map<string, IOnyxKnownModel>();
	private _refreshing: Promise<void> | undefined;

	private readonly _onDidChangeLoading = this._register(new Emitter<{ modelKey: string; loading: boolean }>());
	readonly onDidChangeLoading = this._onDidChangeLoading.event;

	/** Last time a request against each model finished — the residency clock. */
	private readonly _lastUsedAt = new Map<string, number>();
	private _totalMemoryGb: number | undefined;

	constructor(
		@IOnyxRuntimeService private readonly _runtimeService: IOnyxRuntimeService,
		@IOnyxProfileService private readonly _profileService: IOnyxProfileService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();
		this._register(this._runtimeService.onDidChangeRuntimes(endpoints => {
			this._rebuildFromDiscovery(endpoints.flatMap(e => e.models));
		}));
		this._register(this._configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(OnyxSettingId.Endpoints) || e.affectsConfiguration(OnyxSettingId.DiscoveryEnabled)) {
				this.refresh();
			}
		}));
		this._register(this._profileService.onDidChangeProfiles(() => this._reapplyProfiles()));
	}

	refresh(): Promise<void> {
		this._refreshing ??= this._doRefresh().finally(() => { this._refreshing = undefined; });
		return this._refreshing;
	}

	private async _doRefresh(): Promise<void> {
		const settings = getOnyxEndpointSettings(this._configurationService);
		const discoveryEnabled = this._configurationService.getValue<boolean>(OnyxSettingId.DiscoveryEnabled) !== false;

		const discovered: IOnyxDiscoveredModel[] = [];
		if (discoveryEnabled) {
			try {
				const endpoints = await this._runtimeService.discoverRuntimes(settings.map(s => s.baseUrl));
				discovered.push(...endpoints.flatMap(e => e.models));
			} catch (err) {
				this._logService.warn('[onyx] runtime discovery failed', err);
			}
		}

		// Explicitly configured models are exposed even when the endpoint could
		// not be probed (e.g. a server that only implements /chat/completions).
		for (const setting of settings) {
			for (const modelId of setting.models ?? []) {
				const baseUrl = normalizeConfiguredBaseUrl(setting.baseUrl);
				if (!discovered.some(m => m.baseUrl === baseUrl && m.id === modelId)) {
					discovered.push({ id: modelId, baseUrl, runtime: 'generic', contextLength: setting.contextWindow });
				}
			}
		}

		this._rebuildFromDiscovery(discovered);
	}

	private _rebuildFromDiscovery(discovered: readonly IOnyxDiscoveredModel[]): void {
		const settings = getOnyxEndpointSettings(this._configurationService);
		const next = new Map<string, IOnyxKnownModel>();
		for (const model of discovered) {
			const key = modelKey(model);
			const setting = settings.find(s => normalizeConfiguredBaseUrl(s.baseUrl) === model.baseUrl);
			const withOverrides = setting?.contextWindow ? { ...model, contextLength: setting.contextWindow } : model;
			next.set(key, {
				key,
				discovered: withOverrides,
				profile: this._profileService.getProfile(key, withOverrides),
				apiKey: setting?.apiKey,
			});
		}
		const changed = next.size !== this._models.size || [...next.keys()].some(k => !this._models.has(k));
		this._models = next;
		if (changed) {
			this._onDidChange.fire();
		}
	}

	private _reapplyProfiles(): void {
		for (const [key, model] of this._models) {
			this._models.set(key, { ...model, profile: this._profileService.getProfile(key, model.discovered) });
		}
		this._onDidChange.fire();
	}

	getKnownModels(): readonly IOnyxKnownModel[] {
		return [...this._models.values()];
	}

	getKnownModel(key: string): IOnyxKnownModel | undefined {
		return this._models.get(key);
	}

	async provideLanguageModelChatInfo(): Promise<ILanguageModelChatMetadataAndIdentifier[]> {
		if (this._models.size === 0) {
			await this.refresh();
		}
		const infos: ILanguageModelChatMetadataAndIdentifier[] = [];
		if (this._models.size > 0) {
			infos.push(this._autoModelInfo());
		}
		for (const model of this._models.values()) {
			infos.push({
				identifier: `${ONYX_VENDOR}:${model.key}`,
				metadata: {
					extension: nullExtensionDescription.identifier,
					name: model.discovered.id,
					id: model.key,
					vendor: ONYX_VENDOR,
					version: '1.0',
					family: model.profile.family,
					detail: modelDetail(model),
					maxInputTokens: model.profile.contextLength,
					maxOutputTokens: 4096,
					isDefaultForLocation: {},
					isUserSelectable: true,
					capabilities: {
						toolCalling: model.profile.toolCallQuality > 0,
						agentMode: model.profile.toolCallQuality > 0,
						vision: model.profile.supportsVision,
					},
				},
			});
		}
		return infos;
	}

	private _autoModelInfo(): ILanguageModelChatMetadataAndIdentifier {
		return {
			identifier: `${ONYX_VENDOR}:${ONYX_AUTO_MODEL_ID}`,
			metadata: {
				extension: nullExtensionDescription.identifier,
				name: localize('onyx.autoModel', "Auto"),
				id: ONYX_AUTO_MODEL_ID,
				vendor: ONYX_VENDOR,
				version: '1.0',
				family: 'onyx-auto',
				tooltip: localize('onyx.autoModel.tooltip', "Onyx routes each request to the best local model, using performance measured on this machine."),
				maxInputTokens: Math.max(8192, ...[...this._models.values()].map(m => m.profile.contextLength)),
				maxOutputTokens: 4096,
				isDefaultForLocation: {},
				isUserSelectable: true,
				capabilities: { toolCalling: true, agentMode: true },
			},
		};
	}

	isWarm(modelKey: string): boolean {
		const lastUsed = this._lastUsedAt.get(modelKey);
		return lastUsed !== undefined && Date.now() - lastUsed < RESIDENCY_WINDOW_MS;
	}

	/**
	 * Long residency only while the warm set fits comfortably in unified
	 * memory; otherwise a short keep_alive lets the runtime evict soon. The
	 * machine profile is fetched once — total memory does not change.
	 */
	private _keepAliveFor(model: IOnyxKnownModel): string {
		if (this._totalMemoryGb === undefined) {
			this._totalMemoryGb = 16;
			this._runtimeService.getMachineProfile()
				.then(profile => { this._totalMemoryGb = Math.max(8, Math.round(profile.totalMemoryBytes / (1024 ** 3))); })
				.catch(() => { /* keep the conservative default */ });
		}
		const budgetGb = this._totalMemoryGb * 0.6;
		let residentGb = (model.profile.parameterB ?? 8) * GB_PER_BILLION;
		for (const [key, lastUsed] of this._lastUsedAt) {
			if (key !== model.key && Date.now() - lastUsed < RESIDENCY_WINDOW_MS) {
				residentGb += (this._models.get(key)?.profile.parameterB ?? 0) * GB_PER_BILLION;
			}
		}
		return residentGb <= budgetGb ? KEEP_ALIVE : SHORT_KEEP_ALIVE;
	}

	async warmUp(modelKey: string): Promise<void> {
		const model = this._models.get(modelKey);
		if (!model || model.discovered.runtime !== 'ollama' || this.isWarm(modelKey)) {
			return;
		}
		this._logService.trace(`[onyx] warming up ${modelKey}`);
		await this._runtimeService.warmUpModel(model.discovered.baseUrl, model.discovered.id, this._keepAliveFor(model));
		this._lastUsedAt.set(modelKey, Date.now());
	}

	async sendChatRequest(modelId: string, messages: IChatMessage[], _from: ExtensionIdentifier | undefined, options: ILanguageModelChatRequestOptions, token: CancellationToken): Promise<ILanguageModelChatResponse> {
		const model = this._resolveModel(modelId, messages);
		if (!model) {
			throw new Error(`Onyx model not found: ${modelId}`);
		}
		const wasCold = !this.isWarm(model.key);
		if (wasCold) {
			// The compute view swaps "generating" for "loading model" until the
			// first token proves the weights are in memory.
			this._onDidChangeLoading.fire({ modelKey: model.key, loading: true });
		}

		const tools = (options.tools as IRequestTool[] | undefined) ?? [];
		const operationId = generateUuid();
		const source = new AsyncIterableSource<IChatResponsePart | IChatResponsePart[]>();
		const accumulator = new ToolCallAccumulator();
		const store = new DisposableStore();

		const startedAt = Date.now();
		let firstTokenAt: number | undefined;
		let promptTokens: number | undefined;
		let completionTokens: number | undefined;
		let streamedChars = 0;
		let toolCallCount = 0;

		const result = new Promise<void>((resolve, reject) => {
			store.add(this._runtimeService.onDidStream(event => {
				if (event.operationId !== operationId) {
					return;
				}
				switch (event.kind) {
					case 'delta':
						if (firstTokenAt === undefined) {
							firstTokenAt = Date.now();
							this._onDidChangeLoading.fire({ modelKey: model.key, loading: false });
						}
						streamedChars += event.text.length;
						source.emitOne({ type: 'text', value: event.text });
						break;
					case 'toolCallDelta':
						if (firstTokenAt === undefined) {
							firstTokenAt = Date.now();
							this._onDidChangeLoading.fire({ modelKey: model.key, loading: false });
						}
						accumulator.append(event.index, event.id, event.name, event.argumentsDelta);
						break;
					case 'usage':
						promptTokens = event.promptTokens;
						completionTokens = event.completionTokens;
						break;
					case 'done': {
						const toolParts = accumulator.complete();
						toolCallCount = toolParts.length;
						if (toolParts.length) {
							source.emitOne(toolParts);
						}
						source.resolve();
						this._lastUsedAt.set(model.key, Date.now());
						this._measure(model, modelId, { startedAt, firstTokenAt, promptTokens, completionTokens, streamedChars, toolCallCount, parseFailures: accumulator.parseFailures, finishReason: event.finishReason, wasCold });
						resolve();
						break;
					}
					case 'error': {
						// Transport failures reach the user as sentences, not as
						// undici's `terminated` / `ECONNREFUSED`.
						const error = new Error(humanizeRuntimeError(event.message, model.discovered.id));
						source.reject(error);
						this._onDidChangeLoading.fire({ modelKey: model.key, loading: false });
						this._measure(model, modelId, { startedAt, firstTokenAt, promptTokens, completionTokens, streamedChars, toolCallCount, parseFailures: accumulator.parseFailures, finishReason: 'error', errorMessage: event.message, wasCold });
						reject(error);
						break;
					}
				}
			}));

			store.add(token.onCancellationRequested(() => {
				this._runtimeService.cancel(operationId);
			}));

			this._runtimeService.startChatCompletion(operationId, {
				baseUrl: model.discovered.baseUrl,
				apiKey: model.apiKey,
				model: model.discovered.id,
				messages: toWireMessages(messages),
				tools: tools.length ? toWireTools(tools.slice(0, model.profile.maxTools)) : undefined,
				temperature: model.profile.temperature,
				// Residency: ask Ollama to hold the weights between requests, so
				// the next request pays prompt-processing, not model loading.
				keepAlive: model.discovered.runtime === 'ollama' ? this._keepAliveFor(model) : undefined,
				responseFormat: options.modelOptions?.['responseFormat'],
			}).catch(reject);
		}).finally(() => store.dispose());

		return { stream: source.asyncIterable, result };
	}

	private _resolveModel(modelId: string, messages: readonly IChatMessage[]): IOnyxKnownModel | undefined {
		// The LM service hands providers the full identifier (`onyx:<key>`).
		const key = modelId.startsWith(`${ONYX_VENDOR}:`) ? modelId.slice(ONYX_VENDOR.length + 1) : modelId;
		if (key !== ONYX_AUTO_MODEL_ID) {
			return this._models.get(key);
		}
		// The router is resolved lazily to avoid a construction-time service cycle
		// (the router itself routes over this service's model list).
		return this._instantiationService.invokeFunction(accessor => accessor.get(IOnyxRouterService).pickModel(messages, this.getKnownModels()));
	}

	private _measure(model: IOnyxKnownModel, requestedModelId: string, raw: { startedAt: number; firstTokenAt: number | undefined; promptTokens: number | undefined; completionTokens: number | undefined; streamedChars: number; toolCallCount: number; parseFailures: number; finishReason: string | undefined; errorMessage?: string; wasCold: boolean }): void {
		const generationMs = raw.firstTokenAt !== undefined ? Date.now() - raw.firstTokenAt : undefined;
		const completionTokenEstimate = raw.completionTokens ?? estimateTokens(' '.repeat(raw.streamedChars));
		this._onDidMeasureRequest.fire({
			modelKey: model.key,
			requestedModelId,
			timeToFirstTokenMs: raw.firstTokenAt !== undefined ? raw.firstTokenAt - raw.startedAt : undefined,
			tokensPerSecond: generationMs && generationMs > 0 ? (completionTokenEstimate / (generationMs / 1000)) : undefined,
			generationMs,
			promptTokens: raw.promptTokens,
			completionTokens: raw.completionTokens,
			toolCallCount: raw.toolCallCount,
			toolCallParseFailures: raw.parseFailures,
			finishReason: raw.finishReason,
			errorMessage: raw.errorMessage,
			wasCold: raw.wasCold,
		});
	}

	async provideTokenCount(_modelId: string, message: string | IChatMessage): Promise<number> {
		return typeof message === 'string' ? estimateTokens(message) : estimateMessageTokens(message);
	}
}

function modelKey(model: IOnyxDiscoveredModel): string {
	return `${hostPort(model.baseUrl)}/${model.id}`;
}

function hostPort(baseUrl: string): string {
	try {
		const url = new URL(baseUrl);
		return url.host;
	} catch {
		return baseUrl;
	}
}

function modelDetail(model: IOnyxKnownModel): string {
	const parts: string[] = [runtimeLabel(model.discovered.runtime)];
	if (model.profile.parameterB) {
		parts.push(`${model.profile.parameterB}B`);
	}
	if (model.discovered.quantization) {
		parts.push(model.discovered.quantization);
	}
	return parts.join(' · ');
}

function runtimeLabel(runtime: IOnyxDiscoveredModel['runtime']): string {
	switch (runtime) {
		case 'ollama': return 'Ollama';
		case 'lmstudio': return 'LM Studio';
		case 'llamacpp': return 'llama.cpp';
		case 'vllm': return 'vLLM';
		default: return 'Local';
	}
}

function normalizeConfiguredBaseUrl(url: string): string {
	let normalized = url.trim().replace(/\/+$/, '');
	if (!/^https?:\/\//.test(normalized)) {
		normalized = `http://${normalized}`;
	}
	if (!normalized.endsWith('/v1')) {
		normalized = `${normalized}/v1`;
	}
	return normalized;
}
