/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { equals } from '../../../base/common/objects.js';
import { ILogService } from '../../log/common/log.js';
import { IOnyxChatParams, IOnyxDiscoveredModel, IOnyxEndpoint, IOnyxRuntimeService, IOnyxStreamEvent, OnyxRuntimeKind } from '../common/onyxRuntime.js';

/** Base URLs probed even when the user configured nothing: the default ports of Ollama, LM Studio, llama.cpp server and vLLM. */
const WELL_KNOWN_BASE_URLS: readonly { url: string; kind: OnyxRuntimeKind }[] = [
	{ url: 'http://localhost:11434/v1', kind: 'ollama' },
	{ url: 'http://localhost:1234/v1', kind: 'lmstudio' },
	{ url: 'http://localhost:8080/v1', kind: 'llamacpp' },
	{ url: 'http://localhost:8000/v1', kind: 'vllm' },
];

const PROBE_TIMEOUT_MS = 1500;
const WATCH_INTERVAL_MS = 30_000;

interface IOpenAIModelList {
	readonly data?: readonly { readonly id: string }[];
}

interface IOllamaTagsResponse {
	readonly models?: readonly {
		readonly name: string;
		readonly details?: {
			readonly family?: string;
			readonly parameter_size?: string; // e.g. "14.8B"
			readonly quantization_level?: string; // e.g. "Q4_K_M"
		};
	}[];
}

interface IOllamaShowResponse {
	readonly capabilities?: readonly string[]; // e.g. ["completion", "tools", "vision"]
	readonly model_info?: Record<string, unknown>; // contains "<arch>.context_length"
}

/** One parsed chat-completions SSE payload (the fields we consume). */
interface ISseChunk {
	readonly usage?: { readonly prompt_tokens?: number; readonly completion_tokens?: number };
	readonly choices?: readonly {
		readonly finish_reason?: string;
		readonly delta?: {
			readonly content?: string;
			readonly tool_calls?: readonly { readonly index?: number; readonly id?: string; readonly function?: { readonly name?: string; readonly arguments?: string } }[];
		};
	}[];
}

export class OnyxRuntimeService extends Disposable implements IOnyxRuntimeService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeRuntimes = this._register(new Emitter<readonly IOnyxEndpoint[]>());
	readonly onDidChangeRuntimes = this._onDidChangeRuntimes.event;

	private readonly _onDidStream = this._register(new Emitter<IOnyxStreamEvent>());
	readonly onDidStream = this._onDidStream.event;

	private readonly _operations = new Map<string, AbortController>();
	private readonly _modelDetailCache = new Map<string, Partial<IOnyxDiscoveredModel>>();
	private _lastDiscovered: readonly IOnyxEndpoint[] = [];
	private _watchedBaseUrls: readonly string[] = [];
	private _watchTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(
		@ILogService private readonly _logService: ILogService,
	) {
		super();
	}

	override dispose(): void {
		if (this._watchTimer) {
			clearTimeout(this._watchTimer);
		}
		for (const controller of this._operations.values()) {
			controller.abort();
		}
		super.dispose();
	}

	async discoverRuntimes(extraBaseUrls: readonly string[]): Promise<readonly IOnyxEndpoint[]> {
		const candidates = new Map<string, OnyxRuntimeKind>();
		for (const { url, kind } of WELL_KNOWN_BASE_URLS) {
			candidates.set(url, kind);
		}
		for (const url of extraBaseUrls) {
			const normalized = normalizeBaseUrl(url);
			if (!candidates.has(normalized)) {
				candidates.set(normalized, 'generic');
			}
		}

		const probes = [...candidates].map(async ([baseUrl, kindHint]): Promise<IOnyxEndpoint | undefined> => {
			const models = await this._tryListModels(baseUrl, kindHint);
			if (!models) {
				return undefined;
			}
			const kind = models[0]?.runtime ?? kindHint;
			return { baseUrl, kind, displayName: runtimeDisplayName(kind), models };
		});

		const endpoints = (await Promise.all(probes)).filter((e): e is IOnyxEndpoint => !!e);
		this._watchedBaseUrls = [...candidates.keys()];
		this._updateDiscovered(endpoints);
		this._scheduleWatch();
		return endpoints;
	}

	async listModels(baseUrl: string): Promise<readonly IOnyxDiscoveredModel[]> {
		return await this._tryListModels(normalizeBaseUrl(baseUrl), 'generic') ?? [];
	}

	async startChatCompletion(operationId: string, params: IOnyxChatParams): Promise<void> {
		const controller = new AbortController();
		this._operations.set(operationId, controller);
		try {
			const response = await fetch(`${normalizeBaseUrl(params.baseUrl)}/chat/completions`, {
				method: 'POST',
				signal: controller.signal,
				headers: {
					'Content-Type': 'application/json',
					...(params.apiKey ? { 'Authorization': `Bearer ${params.apiKey}` } : {}),
				},
				body: JSON.stringify({
					model: params.model,
					messages: params.messages,
					stream: true,
					stream_options: { include_usage: true },
					...(params.tools?.length ? { tools: params.tools } : {}),
					...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
					...(params.maxTokens !== undefined ? { max_tokens: params.maxTokens } : {}),
				}),
			});

			if (!response.ok || !response.body) {
				const body = await response.text().catch(() => '');
				this._emitError(operationId, `${response.status} ${response.statusText}${body ? `: ${truncate(body, 400)}` : ''}`);
				return;
			}

			await this._pumpSse(operationId, response.body);
		} catch (err) {
			if (!controller.signal.aborted) {
				this._emitError(operationId, err instanceof Error ? err.message : String(err));
			} else {
				this._onDidStream.fire({ operationId, kind: 'done', finishReason: 'cancelled' });
			}
		} finally {
			this._operations.delete(operationId);
		}
	}

	async cancel(operationId: string): Promise<void> {
		this._operations.get(operationId)?.abort();
	}

	private async _pumpSse(operationId: string, body: ReadableStream<Uint8Array>): Promise<void> {
		const decoder = new TextDecoder();
		let buffered = '';
		let sawDone = false;
		let finishReason: string | undefined;

		const reader = body.getReader();
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) {
					break;
				}
				buffered += decoder.decode(value, { stream: true });

				// One network read usually carries several SSE events; coalescing
				// their text deltas into a single event keeps IPC traffic low.
				let textDelta = '';
				let newlineIndex;
				while ((newlineIndex = buffered.indexOf('\n')) >= 0) {
					const line = buffered.slice(0, newlineIndex).trimEnd();
					buffered = buffered.slice(newlineIndex + 1);
					if (!line.startsWith('data:')) {
						continue;
					}
					const payload = line.slice(5).trim();
					if (payload === '[DONE]') {
						sawDone = true;
						continue;
					}
					let parsed: ISseChunk;
					try {
						parsed = JSON.parse(payload);
					} catch {
						this._logService.trace('[onyxRuntime] skipping malformed SSE payload', truncate(payload, 200));
						continue;
					}
					if (parsed.usage) {
						this._onDidStream.fire({
							operationId, kind: 'usage',
							promptTokens: parsed.usage.prompt_tokens ?? 0,
							completionTokens: parsed.usage.completion_tokens ?? 0,
						});
					}
					const choice = parsed.choices?.[0];
					if (!choice) {
						continue;
					}
					if (choice.finish_reason) {
						finishReason = choice.finish_reason;
					}
					if (typeof choice.delta?.content === 'string' && choice.delta.content.length > 0) {
						textDelta += choice.delta.content;
					}
					for (const toolCall of choice.delta?.tool_calls ?? []) {
						this._onDidStream.fire({
							operationId, kind: 'toolCallDelta',
							index: toolCall.index ?? 0,
							id: toolCall.id,
							name: toolCall.function?.name,
							argumentsDelta: toolCall.function?.arguments,
						});
					}
				}
				if (textDelta) {
					this._onDidStream.fire({ operationId, kind: 'delta', text: textDelta });
				}
				if (sawDone) {
					break;
				}
			}
			this._onDidStream.fire({ operationId, kind: 'done', finishReason });
		} finally {
			reader.releaseLock();
		}
	}

	private _emitError(operationId: string, message: string): void {
		this._logService.warn(`[onyxRuntime] chat completion failed: ${message}`);
		this._onDidStream.fire({ operationId, kind: 'error', message });
	}

	private async _tryListModels(baseUrl: string, kindHint: OnyxRuntimeKind): Promise<IOnyxDiscoveredModel[] | undefined> {
		const list = await this._fetchJson<IOpenAIModelList>(`${baseUrl}/models`);
		if (!list?.data) {
			return undefined;
		}
		// An Ollama server enriches its models via the native API regardless of
		// which port it was found on; detection is by response, not by port.
		const ollamaTags = await this._fetchJson<IOllamaTagsResponse>(`${ollamaRootUrl(baseUrl)}/api/tags`);
		const runtime: OnyxRuntimeKind = ollamaTags?.models ? 'ollama' : kindHint;

		const models: IOnyxDiscoveredModel[] = [];
		for (const entry of list.data) {
			const tag = ollamaTags?.models?.find(m => m.name === entry.id);
			const detail = runtime === 'ollama' ? await this._getOllamaDetail(baseUrl, entry.id) : undefined;
			models.push({
				id: entry.id,
				baseUrl,
				runtime,
				family: tag?.details?.family ?? parseFamily(entry.id),
				parameterB: parseParameterB(tag?.details?.parameter_size) ?? parseParameterBFromId(entry.id),
				quantization: tag?.details?.quantization_level,
				contextLength: detail?.contextLength,
				supportsTools: detail?.supportsTools,
				supportsVision: detail?.supportsVision,
			});
		}
		return models;
	}

	private async _getOllamaDetail(baseUrl: string, modelId: string): Promise<Partial<IOnyxDiscoveredModel> | undefined> {
		const cacheKey = `${baseUrl}|${modelId}`;
		const cached = this._modelDetailCache.get(cacheKey);
		if (cached) {
			return cached;
		}
		const show = await this._fetchJson<IOllamaShowResponse>(`${ollamaRootUrl(baseUrl)}/api/show`, { model: modelId });
		if (!show) {
			return undefined;
		}
		let contextLength: number | undefined;
		for (const [key, value] of Object.entries(show.model_info ?? {})) {
			if (key.endsWith('.context_length') && typeof value === 'number') {
				contextLength = value;
				break;
			}
		}
		const detail: Partial<IOnyxDiscoveredModel> = {
			contextLength,
			supportsTools: show.capabilities?.includes('tools'),
			supportsVision: show.capabilities?.includes('vision'),
		};
		this._modelDetailCache.set(cacheKey, detail);
		return detail;
	}

	private async _fetchJson<T>(url: string, postBody?: object): Promise<T | undefined> {
		try {
			const response = await fetch(url, {
				method: postBody ? 'POST' : 'GET',
				signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
				...(postBody ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(postBody) } : {}),
			});
			if (!response.ok) {
				return undefined;
			}
			return await response.json() as T;
		} catch {
			return undefined;
		}
	}

	private _updateDiscovered(endpoints: readonly IOnyxEndpoint[]): void {
		if (!equals(endpoints, this._lastDiscovered)) {
			this._lastDiscovered = endpoints;
			this._onDidChangeRuntimes.fire(endpoints);
		}
	}

	private _scheduleWatch(): void {
		if (this._watchTimer) {
			clearTimeout(this._watchTimer);
		}
		this._watchTimer = setTimeout(async () => {
			if (this._store.isDisposed) {
				return;
			}
			const probes = this._watchedBaseUrls.map(async (baseUrl): Promise<IOnyxEndpoint | undefined> => {
				const kindHint = WELL_KNOWN_BASE_URLS.find(w => w.url === baseUrl)?.kind ?? 'generic';
				const models = await this._tryListModels(baseUrl, kindHint);
				if (!models) {
					return undefined;
				}
				const kind = models[0]?.runtime ?? kindHint;
				return { baseUrl, kind, displayName: runtimeDisplayName(kind), models };
			});
			this._updateDiscovered((await Promise.all(probes)).filter((e): e is IOnyxEndpoint => !!e));
			this._scheduleWatch();
		}, WATCH_INTERVAL_MS);
	}
}

function truncate(text: string, maxLength: number): string {
	return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

function normalizeBaseUrl(url: string): string {
	let normalized = url.trim().replace(/\/+$/, '');
	if (!/^https?:\/\//.test(normalized)) {
		normalized = `http://${normalized}`;
	}
	if (!normalized.endsWith('/v1')) {
		normalized = `${normalized}/v1`;
	}
	return normalized;
}

/** `http://localhost:11434/v1` → `http://localhost:11434` (the Ollama native API lives at the root). */
function ollamaRootUrl(baseUrl: string): string {
	return baseUrl.replace(/\/v1$/, '');
}

function runtimeDisplayName(kind: OnyxRuntimeKind): string {
	switch (kind) {
		case 'ollama': return 'Ollama';
		case 'lmstudio': return 'LM Studio';
		case 'llamacpp': return 'llama.cpp';
		case 'vllm': return 'vLLM';
		default: return 'OpenAI-compatible server';
	}
}

/** `qwen2.5-coder:14b-instruct-q4_K_M` → `qwen2.5-coder`. */
function parseFamily(modelId: string): string | undefined {
	const base = modelId.split(':')[0].split('/').pop();
	return base || undefined;
}

/** `"14.8B"` → 14.8 */
function parseParameterB(size: string | undefined): number | undefined {
	const match = size?.match(/([\d.]+)\s*B/i);
	return match ? Number(match[1]) : undefined;
}

/** `qwen2.5-coder:14b` or `Qwen2.5-Coder-14B-Instruct` → 14 */
function parseParameterBFromId(modelId: string): number | undefined {
	const match = modelId.match(/(\d+(?:\.\d+)?)\s*[bB](?![a-zA-Z0-9])/);
	return match ? Number(match[1]) : undefined;
}
