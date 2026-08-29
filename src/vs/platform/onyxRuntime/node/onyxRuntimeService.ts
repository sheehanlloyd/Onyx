/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFile, spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import { join } from '../../../base/common/path.js';
import { Emitter } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { equals } from '../../../base/common/objects.js';
import { ILogService } from '../../log/common/log.js';
import { OnyxArchitectureScanner } from './onyxArchitectureScanner.js';
import { OnyxDocsIndexer } from './onyxDocsIndexer.js';
import { OnyxWorkspaceIndexer } from './onyxWorkspaceIndexer.js';
import { IOnyxArchitectureMap } from '../common/onyxArchitecture.js';
import { IOnyxChatParams, IOnyxCommandOutputEvent, IOnyxCommandResult, IOnyxCommitCandidate, IOnyxCompletionParams, IOnyxDiff, IOnyxDiscoveredModel, IOnyxDocsHit, IOnyxDocsIndexStats, IOnyxEndpoint, IOnyxMachineProfile, IOnyxPullProgress, IOnyxPowerState, IOnyxRuntimeService, IOnyxStreamEvent, OnyxDiffMode, OnyxRuntimeKind } from '../common/onyxRuntime.js';

/** Base URLs probed even when the user configured nothing: the default ports of Ollama, LM Studio, llama.cpp server and vLLM. */
const WELL_KNOWN_BASE_URLS: readonly { url: string; kind: OnyxRuntimeKind }[] = [
	{ url: 'http://localhost:11434/v1', kind: 'ollama' },
	{ url: 'http://localhost:1234/v1', kind: 'lmstudio' },
	{ url: 'http://localhost:8080/v1', kind: 'llamacpp' },
	{ url: 'http://localhost:8000/v1', kind: 'vllm' },
];

const PROBE_TIMEOUT_MS = 1500;
const WATCH_INTERVAL_MS = 30_000;
const COMPLETION_TIMEOUT_MS = 15_000;
const GIT_RECENT_CACHE_MS = 60_000;

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

	private readonly _onDidPullProgress = this._register(new Emitter<IOnyxPullProgress>());
	readonly onDidPullProgress = this._onDidPullProgress.event;

	private readonly _onDidCommandOutput = this._register(new Emitter<IOnyxCommandOutputEvent>());
	readonly onDidCommandOutput = this._onDidCommandOutput.event;

	private readonly _operations = new Map<string, AbortController>();
	private readonly _runningCommands = new Map<string, { kill: () => void }>();
	private readonly _modelDetailCache = new Map<string, Partial<IOnyxDiscoveredModel>>();
	private readonly _gitRecentCache = new Map<string, { at: number; files: readonly string[] }>();
	private readonly _gitGroupsCache = new Map<string, { at: number; groups: readonly (readonly string[])[] }>();
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
		for (const indexer of this._indexers.values()) {
			indexer.dispose();
		}
		for (const indexer of this._docsIndexers.values()) {
			indexer.dispose();
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
					...(params.keepAlive ? { keep_alive: params.keepAlive } : {}),
					...(params.responseFormat ? { response_format: params.responseFormat } : {}),
					...(params.draftModel ? { draft_model: params.draftModel } : {}),
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

	async completeText(operationId: string, params: IOnyxCompletionParams): Promise<string | undefined> {
		const controller = new AbortController();
		this._operations.set(operationId, controller);
		const timeout = setTimeout(() => controller.abort(), COMPLETION_TIMEOUT_MS);
		try {
			const response = await fetch(`${normalizeBaseUrl(params.baseUrl)}/completions`, {
				method: 'POST',
				signal: controller.signal,
				headers: {
					'Content-Type': 'application/json',
					...(params.apiKey ? { 'Authorization': `Bearer ${params.apiKey}` } : {}),
				},
				body: JSON.stringify({
					model: params.model,
					prompt: params.prompt,
					...(params.suffix ? { suffix: params.suffix } : {}),
					max_tokens: params.maxTokens,
					temperature: 0,
					...(params.stop?.length ? { stop: params.stop } : {}),
					...(params.keepAlive ? { keep_alive: params.keepAlive } : {}),
					stream: false,
				}),
			});
			if (!response.ok) {
				return undefined;
			}
			const body = await response.json() as { choices?: { text?: string }[] };
			return body.choices?.[0]?.text ?? undefined;
		} catch {
			return undefined;
		} finally {
			clearTimeout(timeout);
			this._operations.delete(operationId);
		}
	}

	async cancel(operationId: string): Promise<void> {
		this._operations.get(operationId)?.abort();
	}

	async gitRecentFiles(repoPath: string, maxCommits: number): Promise<readonly string[]> {
		const cached = this._gitRecentCache.get(repoPath);
		if (cached && Date.now() - cached.at < GIT_RECENT_CACHE_MS) {
			return cached.files;
		}
		const files = await new Promise<readonly string[]>(resolve => {
			execFile('git', ['-C', repoPath, 'log', '--name-only', '--pretty=format:', '--diff-filter=ACMR', '-n', String(Math.max(1, Math.min(maxCommits, 100)))], { timeout: 5000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
				if (error) {
					resolve([]);
					return;
				}
				const seen = new Set<string>();
				for (const line of stdout.split('\n')) {
					const file = line.trim();
					if (file) {
						seen.add(file);
					}
				}
				resolve([...seen]);
			});
		});
		this._gitRecentCache.set(repoPath, { at: Date.now(), files });
		return files;
	}

	async gitCommitFileGroups(repoPath: string, maxCommits: number): Promise<readonly (readonly string[])[]> {
		// Co-change is a property of history, not of the last minute, and this
		// runs on the prompt path — so it is cached as aggressively as recency.
		const cacheKey = `${repoPath}|${maxCommits}`;
		const cached = this._gitGroupsCache.get(cacheKey);
		if (cached && Date.now() - cached.at < GIT_RECENT_CACHE_MS) {
			return cached.groups;
		}
		// A record separator between commits is the only reliable way to tell
		// "changed together" apart from "changed recently" in one git call.
		const stdout = await this._git(repoPath, ['log', '--name-only', '--pretty=format:%x1e', '--diff-filter=ACMR', '-n', String(clamp(maxCommits, 1, 200))]);
		const groups: string[][] = [];
		for (const block of stdout.split('\u001e')) {
			const files = block.split('\n').map(line => line.trim()).filter(Boolean);
			if (files.length > 0) {
				groups.push(files);
			}
		}
		this._gitGroupsCache.set(cacheKey, { at: Date.now(), groups });
		return groups;
	}

	async gitCommitCandidates(repoPath: string, maxCommits: number): Promise<readonly IOnyxCommitCandidate[]> {
		const raw = await this._git(repoPath, ['log', '--no-merges', '--numstat', '--pretty=format:@@%H|%s', '-n', String(clamp(maxCommits, 1, 500))], 4 * 1024 * 1024);
		const candidates: { hash: string; subject: string; files: string[]; insertions: number; deletions: number }[] = [];
		let current: { hash: string; subject: string; files: string[]; insertions: number; deletions: number } | undefined;
		for (const line of raw.split('\n')) {
			if (line.startsWith('@@')) {
				const separator = line.indexOf('|');
				current = { hash: line.slice(2, separator), subject: line.slice(separator + 1), files: [], insertions: 0, deletions: 0 };
				candidates.push(current);
				continue;
			}
			const match = line.match(/^(?<ins>\d+|-)\t(?<del>\d+|-)\t(?<path>.+)$/);
			if (match?.groups && current) {
				current.files.push(match.groups.path);
				current.insertions += match.groups.ins === '-' ? 0 : Number(match.groups.ins);
				current.deletions += match.groups.del === '-' ? 0 : Number(match.groups.del);
			}
		}
		return candidates;
	}

	async gitShowFile(repoPath: string, revision: string, path: string): Promise<string | undefined> {
		// Reject anything that could smuggle flags or ranges into git.
		if (!/^[0-9a-f]{4,40}(\^|~\d*)?$/i.test(revision) || path.startsWith('-')) {
			return undefined;
		}
		const content = await this._git(repoPath, ['show', `${revision}:${path}`], 2 * 1024 * 1024);
		return content || undefined; // '' means git failed (file absent at that revision)
	}

	async gitDiff(repoPath: string, mode: OnyxDiffMode, maxChars: number): Promise<IOnyxDiff> {
		const selector = mode === 'staged' ? ['--cached'] : mode === 'head' ? ['HEAD'] : [];
		const base = ['diff', '--no-color', '--no-ext-diff', ...selector];
		const [text, names] = await Promise.all([
			this._git(repoPath, [...base, '-U3'], 8 * 1024 * 1024),
			this._git(repoPath, [...base, '--name-only']),
		]);
		const files = names.split('\n').map(line => line.trim()).filter(Boolean);
		const limit = Math.max(0, maxChars);
		return { text: text.length > limit ? text.slice(0, limit) : text, files, truncated: text.length > limit };
	}

	private readonly _indexers = new Map<string, OnyxWorkspaceIndexer>();

	private _indexer(rootPath: string, persistPath: string): OnyxWorkspaceIndexer {
		let indexer = this._indexers.get(rootPath);
		if (!indexer) {
			indexer = new OnyxWorkspaceIndexer(rootPath, persistPath);
			this._indexers.set(rootPath, indexer);
		}
		return indexer;
	}

	async ensureWorkspaceIndex(rootPath: string, persistPath: string): Promise<{ files: number; buildMs: number; truncated: boolean }> {
		return this._indexer(rootPath, persistPath).ensure();
	}

	async searchWorkspaceIndex(rootPath: string, persistPath: string, query: string, limit: number): Promise<readonly { path: string; score: number }[]> {
		return this._indexer(rootPath, persistPath).search(query, limit);
	}

	async updateWorkspaceIndex(rootPath: string, persistPath: string, changedFiles: readonly string[]): Promise<void> {
		return this._indexer(rootPath, persistPath).update(changedFiles);
	}

	private readonly _docsIndexers = new Map<string, OnyxDocsIndexer>();

	private _docsIndexer(rootPath: string, persistPath: string): OnyxDocsIndexer {
		let indexer = this._docsIndexers.get(rootPath);
		if (!indexer) {
			indexer = new OnyxDocsIndexer(rootPath, persistPath);
			this._docsIndexers.set(rootPath, indexer);
		}
		return indexer;
	}

	async ensureDocsIndex(rootPath: string, persistPath: string): Promise<IOnyxDocsIndexStats> {
		return this._docsIndexer(rootPath, persistPath).ensure();
	}

	async searchDocsIndex(rootPath: string, persistPath: string, query: string, limit: number): Promise<readonly IOnyxDocsHit[]> {
		return this._docsIndexer(rootPath, persistPath).search(query, limit);
	}

	async updateDocsIndex(rootPath: string, persistPath: string, changedFiles: readonly string[]): Promise<void> {
		return this._docsIndexer(rootPath, persistPath).update(changedFiles);
	}

	private _worktreesPruned = false;

	async worktreeCreate(repoPath: string, id: string): Promise<{ worktreePath: string }> {
		if (!this._worktreesPruned) {
			this._worktreesPruned = true;
			await this._pruneTournamentWorktrees(repoPath);
		}
		const worktreePath = join(os.tmpdir(), `onyx-tournament-${id}`);
		await this._git(repoPath, ['worktree', 'add', '--detach', worktreePath, 'HEAD']);
		return { worktreePath };
	}

	async worktreeWriteFile(worktreePath: string, relativePath: string, content: string): Promise<void> {
		// The relative path must stay inside the worktree — this API writes
		// tournament candidates, not arbitrary files.
		const target = join(worktreePath, relativePath);
		if (!target.startsWith(worktreePath)) {
			throw new Error(`refusing to write outside the worktree: ${relativePath}`);
		}
		await fs.promises.writeFile(target, content, 'utf8');
	}

	async worktreeDiff(worktreePath: string): Promise<IOnyxDiff> {
		const base = ['diff', '--no-color', '--no-ext-diff', 'HEAD'];
		const [text, names] = await Promise.all([
			this._git(worktreePath, [...base, '-U3'], 8 * 1024 * 1024),
			this._git(worktreePath, [...base, '--name-only']),
		]);
		const files = names.split('\n').map(line => line.trim()).filter(Boolean);
		return { text, files, truncated: false };
	}

	async worktreeRemove(repoPath: string, worktreePath: string): Promise<void> {
		try {
			await this._git(repoPath, ['worktree', 'remove', '--force', worktreePath]);
		} catch {
			// already gone or busy; pruning sweeps stragglers
		}
		try {
			await this._git(repoPath, ['worktree', 'prune']);
		} catch {
			// best effort
		}
	}

	async applyDiff(repoPath: string, diffText: string): Promise<void> {
		// `git apply` reads the patch from a file: stdin plumbing through
		// execFile is not worth the fragility for a local temp write.
		const patchPath = join(os.tmpdir(), `onyx-apply-${Date.now()}.patch`);
		await fs.promises.writeFile(patchPath, diffText, 'utf8');
		try {
			await this._git(repoPath, ['apply', '--whitespace=nowarn', patchPath]);
		} finally {
			await fs.promises.rm(patchPath, { force: true });
		}
	}

	/** Sweeps worktrees a crashed session left behind. */
	private async _pruneTournamentWorktrees(repoPath: string): Promise<void> {
		try {
			const list = await this._git(repoPath, ['worktree', 'list', '--porcelain']);
			const leftovers = list.split('\n')
				.filter(line => line.startsWith('worktree ') && line.includes('onyx-tournament-'))
				.map(line => line.slice('worktree '.length).trim());
			for (const leftover of leftovers) {
				await this.worktreeRemove(repoPath, leftover);
				await fs.promises.rm(leftover, { recursive: true, force: true }).catch(() => { });
			}
		} catch {
			// no worktrees, or an older git: nothing to sweep
		}
	}

	async warmUpModel(baseUrl: string, model: string, keepAlive: string): Promise<void> {
		// A one-token completion forces the runtime to load the weights and,
		// where keep_alive is honored, hold them. Failures are irrelevant: the
		// worst case is the cold start the warm-up was trying to avoid.
		try {
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), 120_000);
			await fetch(`${normalizeBaseUrl(baseUrl)}/completions`, {
				method: 'POST',
				signal: controller.signal,
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ model, prompt: ' ', max_tokens: 1, keep_alive: keepAlive, stream: false }),
			}).finally(() => clearTimeout(timeout));
		} catch {
			// see above
		}
	}

	async getPowerState(): Promise<IOnyxPowerState> {
		if (os.platform() !== 'darwin') {
			// Power-aware scheduling is a macOS feature for now; elsewhere the
			// policy sees "plugged in, nominal" and never downshifts.
			return { onBattery: false, thermal: 'unknown', cpuSpeedLimit: undefined };
		}
		const run = (args: readonly string[]) => new Promise<string>(resolve => {
			execFile('pmset', args, { timeout: 3000 }, (error, stdout) => resolve(error ? '' : stdout));
		});
		const [batt, therm] = await Promise.all([run(['-g', 'batt']), run(['-g', 'therm'])]);
		const onBattery = /'Battery Power'/.test(batt);
		const speedMatch = therm.match(/CPU_Speed_Limit\s*=\s*(?<limit>\d+)/);
		const cpuSpeedLimit = speedMatch?.groups?.limit ? Number(speedMatch.groups.limit) : undefined;
		const thermal = cpuSpeedLimit !== undefined
			? (cpuSpeedLimit < 100 ? 'serious' : 'nominal')
			: /No thermal warning level/.test(therm) ? 'nominal' : 'unknown';
		return { onBattery, thermal, cpuSpeedLimit };
	}

	async getMachineProfile(): Promise<IOnyxMachineProfile> {
		const cpus = os.cpus();
		return {
			totalMemoryBytes: os.totalmem(),
			freeMemoryBytes: os.freemem(),
			cpuModel: cpus[0]?.model ?? 'unknown',
			cpuCount: cpus.length,
			arch: os.arch(),
			platform: os.platform(),
		};
	}

	async pullModel(operationId: string, baseUrl: string, model: string): Promise<void> {
		const controller = new AbortController();
		this._operations.set(operationId, controller);
		try {
			const response = await fetch(`${ollamaRootUrl(normalizeBaseUrl(baseUrl))}/api/pull`, {
				method: 'POST',
				signal: controller.signal,
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ model, stream: true }),
			});
			if (!response.ok || !response.body) {
				this._onDidPullProgress.fire({ operationId, status: `${response.status} ${response.statusText}`, done: true, error: `${response.status} ${response.statusText}` });
				return;
			}
			await this._pumpPull(operationId, response.body);
		} catch (err) {
			const message = controller.signal.aborted ? 'cancelled' : (err instanceof Error ? err.message : String(err));
			this._onDidPullProgress.fire({ operationId, status: message, done: true, error: controller.signal.aborted ? undefined : message });
		} finally {
			this._operations.delete(operationId);
		}
	}

	/** Ollama's pull API streams one JSON object per line, not SSE. */
	private async _pumpPull(operationId: string, body: ReadableStream<Uint8Array>): Promise<void> {
		const decoder = new TextDecoder();
		const reader = body.getReader();
		let buffered = '';
		let lastEmit = 0;
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) {
					break;
				}
				buffered += decoder.decode(value, { stream: true });
				let newlineIndex;
				let latest: { status?: string; completed?: number; total?: number; error?: string } | undefined;
				while ((newlineIndex = buffered.indexOf('\n')) >= 0) {
					const line = buffered.slice(0, newlineIndex).trim();
					buffered = buffered.slice(newlineIndex + 1);
					if (!line) {
						continue;
					}
					try {
						latest = JSON.parse(line);
					} catch {
						this._logService.trace('[onyxRuntime] skipping malformed pull payload', truncate(line, 200));
					}
				}
				// Ollama emits a line per chunk; throttling keeps IPC sane on a
				// multi-gigabyte download without losing the final state.
				const now = Date.now();
				if (latest && (now - lastEmit > 250)) {
					lastEmit = now;
					this._onDidPullProgress.fire({
						operationId,
						status: latest.error ?? latest.status ?? 'downloading',
						completedBytes: latest.completed,
						totalBytes: latest.total,
						done: false,
						error: latest.error,
					});
				}
			}
			this._onDidPullProgress.fire({ operationId, status: 'success', done: true });
		} finally {
			reader.releaseLock();
		}
	}

	private _git(repoPath: string, args: readonly string[], maxBuffer = 1024 * 1024): Promise<string> {
		return new Promise<string>(resolve => {
			execFile('git', ['-C', repoPath, ...args], { timeout: 10_000, maxBuffer }, (error, stdout) => {
				resolve(error ? '' : stdout);
			});
		});
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
				// The four known runtimes all accept OpenAI `response_format:
				// json_schema`; an unidentified server cannot be assumed to.
				supportsJsonSchema: runtime !== 'generic',
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

	private readonly _architectureScanners = new Map<string, OnyxArchitectureScanner>();

	async analyzeArchitecture(rootPath: string, persistPath: string, force: boolean): Promise<IOnyxArchitectureMap> {
		let scanner = this._architectureScanners.get(rootPath);
		if (!scanner) {
			scanner = new OnyxArchitectureScanner(rootPath, persistPath, () => this.gitCommitFileGroups(rootPath, 300));
			this._architectureScanners.set(rootPath, scanner);
		}
		return scanner.analyze(force);
	}

	async execCommand(operationId: string, cwd: string, command: string, timeoutMs: number): Promise<IOnyxCommandResult> {
		const startedAt = Date.now();
		return new Promise<IOnyxCommandResult>(resolve => {
			// Its own process group (detached) so a kill reaches the whole tree,
			// not just the shell that spawned it.
			const child = spawn('/bin/sh', ['-c', command], { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
			let output = '';
			let done = false;
			let timedOut = false;
			let killed = false;

			const killTree = () => {
				try {
					if (child.pid) {
						process.kill(-child.pid, 'SIGKILL');
					}
				} catch {
					child.kill('SIGKILL');
				}
			};
			this._runningCommands.set(operationId, { kill: () => { killed = true; killTree(); } });

			const timer = setTimeout(() => {
				timedOut = true;
				killTree();
			}, Math.max(1000, timeoutMs));

			const onData = (stream: 'stdout' | 'stderr') => (data: Buffer) => {
				const text = data.toString();
				if (output.length < MAX_COMMAND_OUTPUT_CHARS) {
					output += text;
				}
				this._onDidCommandOutput.fire({ operationId, stream, text });
			};
			child.stdout?.on('data', onData('stdout'));
			child.stderr?.on('data', onData('stderr'));

			const finish = (exitCode: number | undefined) => {
				if (done) {
					return;
				}
				done = true;
				clearTimeout(timer);
				this._runningCommands.delete(operationId);
				resolve({ exitCode, timedOut, killed, durationMs: Date.now() - startedAt, output: output.slice(0, MAX_COMMAND_OUTPUT_CHARS) });
			};
			child.on('error', err => {
				output += `\n${err.message}`;
				finish(undefined);
			});
			child.on('close', code => finish(code ?? undefined));
		});
	}

	async killCommand(operationId: string): Promise<void> {
		this._runningCommands.get(operationId)?.kill();
	}
}

const MAX_COMMAND_OUTPUT_CHARS = 200_000;

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(value, max));
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
