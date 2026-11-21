/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { AsyncIterableSource } from '../../../../../base/common/async.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { localize } from '../../../../../nls.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { createDecorator, IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IOnyxDiscoveredModel, IOnyxRuntimeService, ONYX_STREAM_DEADLINES, OnyxStreamEnding } from '../../../../../platform/onyxRuntime/common/onyxRuntime.js';
import { nullExtensionDescription } from '../../../../services/extensions/common/extensions.js';
import { ExtensionIdentifier } from '../../../../../platform/extensions/common/extensions.js';
import { IChatMessage, IChatResponsePart, ILanguageModelChatMetadataAndIdentifier, ILanguageModelChatProvider, ILanguageModelChatRequestOptions, ILanguageModelChatResponse } from '../../../chat/common/languageModels.js';
import { getOnyxEndpointSettings, normalizeEndpointBaseUrl, OnyxSettingId } from '../../common/onyxConfiguration.js';
import { isContextOverflowError } from '../../common/onyxContextBudget.js';
import { classifyTransport, decideInferenceUse, describeExecution, describeRefusal, describeTransport, IOnyxInferenceLocation, IOnyxInferencePolicy, locationBadge, OnyxLocationRefusal } from '../../common/onyxInferenceLocation.js';
import { humanizeRuntimeError } from '../../common/onyxRuntimeErrors.js';
import { IOnyxModelProfile, ONYX_AUTO_MODEL_ID, ONYX_VENDOR } from '../../common/onyxTypes.js';
import { IOnyxContextNumbersRecord } from '../../common/onyxContextAllocation.js';
import { IOnyxContextAllocationService } from '../models/onyxContextAllocationService.js';
import { IOnyxProfileService } from '../profiles/onyxProfileService.js';
import { IOnyxRouterService } from '../routing/onyxRouterService.js';
import { IOnyxEndpointSecretService } from './onyxEndpointSecrets.js';
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
	/** From the system's secret storage (B11). Held in memory for requests; never written to a file by Onyx. */
	readonly apiKey?: string;
	/** Where requests go and where the runtime says the model runs (B14). */
	readonly location: IOnyxInferenceLocation;
	/** The name requests are sent to, when it is not the model's own: a verified context alias (B15). */
	readonly wireModel?: string;
	/** What Onyx asked the runtime for, what it reported and what was verified, for the trace (B15). */
	readonly contextNumbers?: IOnyxContextNumbersRecord;
}

/** A discovered model that is not used under the user's inference settings, and why. */
export interface IOnyxRefusedModel {
	readonly model: IOnyxKnownModel;
	readonly refusal: OnyxLocationRefusal;
}

/** The runtime rejected the request because the prompt did not fit its context (B13). */
export class OnyxContextOverflowError extends Error { }

/** How one chat request ended: what `ILanguageModelChatResponse.result` resolves with for an Onyx model. */
export interface IOnyxStreamOutcome {
	readonly finishReason: string | undefined;
	readonly seedHonoured: boolean | undefined;
	/** `truncated` and `stalled` mean the reply is incomplete: nothing from it may be run, staged or called complete (B12). */
	readonly ending: OnyxStreamEnding;
}

/**
 * The window's own allowance on top of the runtime's deadlines. The runtime
 * ends a silent request itself; this clock is for a runtime service that
 * cannot, so a run never waits on one for ever.
 */
const WINDOW_DEADLINE_GRACE_MS = 15_000;

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
	/** The models Onyx uses: every chooser draws from this list, so a refused model cannot be picked by any of them. */
	getKnownModels(): readonly IOnyxKnownModel[];
	getKnownModel(key: string): IOnyxKnownModel | undefined;
	/** Models that were discovered and are not used, with the reason (B14). For display; nothing is sent to them. */
	getRefusedModels(): readonly IOnyxRefusedModel[];
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
	private _refused = new Map<string, IOnyxRefusedModel>();
	private _refreshing: Promise<void> | undefined;

	private readonly _onDidChangeLoading = this._register(new Emitter<{ modelKey: string; loading: boolean }>());
	readonly onDidChangeLoading = this._onDidChangeLoading.event;

	/** Last time a request against each model finished — the residency clock. */
	private readonly _lastUsedAt = new Map<string, number>();
	private _totalMemoryGb: number | undefined;
	/** Endpoint API keys by normalized base URL, as last read from the secret storage. */
	private _apiKeys: ReadonlyMap<string, string> = new Map();

	constructor(
		@IOnyxRuntimeService private readonly _runtimeService: IOnyxRuntimeService,
		@IOnyxProfileService private readonly _profileService: IOnyxProfileService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@ILogService private readonly _logService: ILogService,
		@IOnyxEndpointSecretService private readonly _endpointSecretService: IOnyxEndpointSecretService,
		@IOnyxContextAllocationService private readonly _allocationService: IOnyxContextAllocationService,
	) {
		super();
		this._register(this._endpointSecretService.onDidChange(() => this.refresh()));
		this._register(this._runtimeService.onDidChangeRuntimes(endpoints => {
			this._rebuildFromDiscovery(endpoints.flatMap(e => e.models));
		}));
		this._register(this._configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(OnyxSettingId.Endpoints) || e.affectsConfiguration(OnyxSettingId.DiscoveryEnabled) || e.affectsConfiguration(OnyxSettingId.InferenceStrictLocal) || e.affectsConfiguration(OnyxSettingId.InferenceAllowLan)) {
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
		try {
			this._apiKeys = await this._endpointSecretService.configuredApiKeys();
		} catch (err) {
			this._logService.warn('[onyx] endpoint keys could not be read', err);
		}

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
				const baseUrl = normalizeEndpointBaseUrl(setting.baseUrl);
				if (!discovered.some(m => m.baseUrl === baseUrl && m.id === modelId)) {
					discovered.push({ id: modelId, baseUrl, runtime: 'generic', contextLength: setting.contextWindow });
				}
			}
		}

		this._rebuildFromDiscovery(discovered);
	}

	private _rebuildFromDiscovery(discovered: readonly IOnyxDiscoveredModel[]): void {
		const settings = getOnyxEndpointSettings(this._configurationService);
		const policy = this._inferencePolicy();
		const next = new Map<string, IOnyxKnownModel>();
		const refused = new Map<string, IOnyxRefusedModel>();
		// Which context aliases the runtimes list decides which recorded allocations still hold (B15).
		this._allocationService.noteListed(discovered);
		for (const model of discovered) {
			if (model.contextAlias) {
				// Not a model to offer: it is how the model it stands for is requested.
				continue;
			}
			const key = modelKey(model);
			const setting = settings.find(s => normalizeEndpointBaseUrl(s.baseUrl) === model.baseUrl);
			const withOverrides = setting?.contextWindow ? { ...model, contextLength: setting.contextWindow } : model;
			// Transport from the address; execution from what the runtime reported, and `unknown` when it
			// reported nothing. A loopback address settles the first and says nothing about the second.
			const location: IOnyxInferenceLocation = { transport: classifyTransport(model.baseUrl), execution: model.execution ?? 'unknown', remoteHost: model.remoteHost };
			const known: IOnyxKnownModel = {
				key,
				discovered: withOverrides,
				profile: this._profileService.getProfile(key, withOverrides),
				apiKey: this._apiKeys.get(model.baseUrl),
				location,
				wireModel: this._allocationService.wireModel(key, withOverrides),
				contextNumbers: this._allocationService.numbers(key, withOverrides),
			};
			const decision = this._decideUse(location, policy);
			if (decision.allowed) {
				next.set(key, known);
			} else {
				refused.set(key, { model: known, refusal: decision.refusal });
			}
		}
		const changed = next.size !== this._models.size || [...next.keys()].some(k => !this._models.has(k)) || refused.size !== this._refused.size || [...refused.keys()].some(k => !this._refused.has(k));
		this._models = next;
		this._refused = refused;
		if (changed) {
			this._onDidChange.fire();
		}
	}

	private _reapplyProfiles(): void {
		for (const [key, model] of this._models) {
			this._models.set(key, { ...model, profile: this._profileService.getProfile(key, model.discovered), wireModel: this._allocationService.wireModel(key, model.discovered), contextNumbers: this._allocationService.numbers(key, model.discovered) });
		}
		this._onDidChange.fire();
	}

	getKnownModels(): readonly IOnyxKnownModel[] {
		return [...this._models.values()];
	}

	getKnownModel(key: string): IOnyxKnownModel | undefined {
		return this._models.get(key);
	}

	getRefusedModels(): readonly IOnyxRefusedModel[] {
		return [...this._refused.values()];
	}

	/** The user's inference settings. User-scoped: a workspace cannot loosen them. */
	private _inferencePolicy(): IOnyxInferencePolicy {
		return {
			strictLocal: this._configurationService.getValue<boolean>(OnyxSettingId.InferenceStrictLocal) !== false,
			allowLan: this._configurationService.getValue<boolean>(OnyxSettingId.InferenceAllowLan) === true,
		};
	}

	/** Whether a model at this location is used under the user's settings. */
	protected _decideUse(location: IOnyxInferenceLocation, policy: IOnyxInferencePolicy): ReturnType<typeof decideInferenceUse> {
		return decideInferenceUse(location, policy);
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
					tooltip: locationTooltip(model),
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
		// Models that were found and are not used stay visible, labelled, with the reason: choosing one
		// explains itself instead of failing silently or vanishing (B14).
		for (const { model, refusal } of this._refused.values()) {
			infos.push({
				identifier: `${ONYX_VENDOR}:${model.key}`,
				metadata: {
					extension: nullExtensionDescription.identifier,
					name: model.discovered.id,
					id: model.key,
					vendor: ONYX_VENDOR,
					version: '1.0',
					family: model.profile.family,
					detail: `${modelDetail(model)} · ${localize('onyx.location.notUsed', "not used")}`,
					tooltip: `${describeRefusal(refusal)} ${locationTooltip(model)}`,
					maxInputTokens: model.profile.contextLength,
					maxOutputTokens: 4096,
					isDefaultForLocation: {},
					isUserSelectable: true,
					capabilities: {},
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
				tooltip: localize('onyx.autoModel.tooltip', "Onyx routes each request to the best of the models it uses, by performance measured on this machine. Models it found and does not use are listed below with the reason."),
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
		// Only a model that is used: nothing, not even a warm-up, is sent to a refused one.
		const model = this._models.get(modelKey);
		if (!model || model.discovered.runtime !== 'ollama' || this.isWarm(modelKey)) {
			return;
		}
		this._logService.trace(`[onyx] warming up ${modelKey}`);
		await this._runtimeService.warmUpModel(model.discovered.baseUrl, model.wireModel ?? model.discovered.id, this._keepAliveFor(model));
		this._lastUsedAt.set(modelKey, Date.now());
	}

	async sendChatRequest(modelId: string, messages: IChatMessage[], _from: ExtensionIdentifier | undefined, options: ILanguageModelChatRequestOptions, token: CancellationToken): Promise<ILanguageModelChatResponse> {
		const refused = this._refused.get(modelId.startsWith(`${ONYX_VENDOR}:`) ? modelId.slice(ONYX_VENDOR.length + 1) : modelId);
		if (refused) {
			// Said in full, because this is where a user who picked the model finds out why nothing happens.
			throw new Error(`${refused.model.discovered.id}: ${describeRefusal(refused.refusal)} ${locationTooltip(refused.model)}`);
		}
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

		const result = new Promise<IOnyxStreamOutcome>((resolve, reject) => {
			let settled = false;
			let watchdog: ReturnType<typeof setTimeout> | undefined;
			store.add(toDisposable(() => clearTimeout(watchdog)));
			const deadlines = this._streamDeadlines();
			const expect = (withinMs: number) => {
				clearTimeout(watchdog);
				if (!Number.isFinite(withinMs)) {
					return;
				}
				watchdog = setTimeout(() => {
					if (settled) {
						return;
					}
					// Nothing arrived, not even the runtime's own word that the request stalled.
					settled = true;
					this._logService.warn(`[onyx] ${model.key}: nothing arrived within ${withinMs} ms; the request is stopped as stalled`);
					this._runtimeService.cancel(operationId);
					this._onDidChangeLoading.fire({ modelKey: model.key, loading: false });
					source.resolve();
					this._measure(model, modelId, { startedAt, firstTokenAt, promptTokens, completionTokens, streamedChars, toolCallCount, parseFailures: accumulator.parseFailures, finishReason: 'stalled', wasCold });
					resolve({ finishReason: undefined, seedHonoured: undefined, ending: 'stalled' });
				}, withinMs);
			};
			expect(deadlines.firstByteMs);
			store.add(this._runtimeService.onDidStream(event => {
				if (event.operationId !== operationId || settled) {
					return;
				}
				if (event.kind !== 'done' && event.kind !== 'error') {
					expect(deadlines.idleMs);
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
					case 'reasoning':
						if (firstTokenAt === undefined) {
							firstTokenAt = Date.now();
							this._onDidChangeLoading.fire({ modelKey: model.key, loading: false });
						}
						// The model's thinking, as its own kind of part: the reader shows it and never parses it (C4).
						source.emitOne({ type: 'thinking', value: event.text });
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
						settled = true;
						// A reply that was cut off or went silent carries no tool call worth running: what arrived
						// of one is incomplete by definition, even when it happens to parse.
						const incomplete = event.ending === 'truncated' || event.ending === 'stalled';
						const toolParts = incomplete ? [] : accumulator.complete();
						toolCallCount = toolParts.length;
						if (toolParts.length) {
							source.emitOne(toolParts);
						}
						source.resolve();
						this._lastUsedAt.set(model.key, Date.now());
						this._measure(model, modelId, { startedAt, firstTokenAt, promptTokens, completionTokens, streamedChars, toolCallCount, parseFailures: accumulator.parseFailures, finishReason: event.finishReason, wasCold });
						if (incomplete) {
							this._onDidChangeLoading.fire({ modelKey: model.key, loading: false });
						}
						resolve({ finishReason: event.finishReason, seedHonoured: event.seedHonoured, ending: event.ending });
						break;
					}
					case 'error': {
						settled = true;
						// Transport failures reach the user as sentences, not as
						// undici's `terminated` / `ECONNREFUSED`.
						const message = humanizeRuntimeError(event.message, model.discovered.id, { tokens: model.profile.contextLength, source: model.profile.context?.source ?? 'default' });
						const error = isContextOverflowError(event.message) ? new OnyxContextOverflowError(message) : new Error(message);
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
				// The verified context alias when there is one: the same weights, with the context that was asked for (B15).
				model: model.wireModel ?? model.discovered.id,
				messages: toWireMessages(messages),
				tools: tools.length ? toWireTools(tools.slice(0, model.profile.maxTools)) : undefined,
				temperature: model.profile.temperature,
				seed: model.profile.seed,
				// The output cap the loop set aside room for (B13). A caller that sets none sends none.
				maxTokens: typeof options.modelOptions?.maxTokens === 'number' && options.modelOptions.maxTokens > 0 ? options.modelOptions.maxTokens : undefined,
				// Residency: ask Ollama to hold the weights between requests, so
				// the next request pays prompt-processing, not model loading.
				keepAlive: model.discovered.runtime === 'ollama' ? this._keepAliveFor(model) : undefined,
				responseFormat: options.modelOptions?.responseFormat,
			}).catch(reject);
		}).finally(() => store.dispose());

		return { stream: source.asyncIterable, result };
	}

	/** How long this window waits for a request to say something before it stops it as stalled. */
	protected _streamDeadlines(): { readonly firstByteMs: number; readonly idleMs: number } {
		return { firstByteMs: ONYX_STREAM_DEADLINES.firstByteMs + WINDOW_DEADLINE_GRACE_MS, idleMs: ONYX_STREAM_DEADLINES.idleMs + WINDOW_DEADLINE_GRACE_MS };
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
	// Anything other than "this machine, run by the runtime itself" is said on the row.
	const badge = locationBadge(model.location);
	if (badge) {
		parts.push(badge);
	}
	return parts.join(' · ');
}

/** Where requests go and where the runtime says the model runs: two sentences, kept apart (DEC-04). */
function locationTooltip(model: IOnyxKnownModel): string {
	return `${describeTransport(model.location.transport)} ${describeExecution(model.location, runtimeLabel(model.discovered.runtime))}`;
}

function runtimeLabel(runtime: IOnyxDiscoveredModel['runtime']): string {
	switch (runtime) {
		case 'ollama': return 'Ollama';
		case 'lmstudio': return 'LM Studio';
		case 'llamacpp': return 'llama.cpp';
		case 'vllm': return 'vLLM';
		// A server that speaks the API and did not say what it is. Not "local": nothing establishes that.
		default: return 'OpenAI-compatible';
	}
}

