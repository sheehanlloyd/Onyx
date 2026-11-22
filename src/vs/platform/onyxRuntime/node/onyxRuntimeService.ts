/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import { join } from '../../../base/common/path.js';
import { Emitter } from '../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../base/common/lifecycle.js';
import { equals } from '../../../base/common/objects.js';
import { ILogService } from '../../log/common/log.js';
import { OnyxArchitectureScanner } from './onyxArchitectureScanner.js';
import { IOnyxCommandProcess, OnyxCommandRunner } from './onyxCommandRunner.js';
import { OnyxDocsIndexer } from './onyxDocsIndexer.js';
import { labCampaignPaths, readLabCampaignRequest, readLabHarnessRequest } from './onyxLabManifest.js';
import { probeOracleSandbox, runOracleCommand } from './onyxOracle.js';
import { IOnyxOracleProbe } from '../common/onyxOracle.js';
import { OnyxWorkspaceIndexer } from './onyxWorkspaceIndexer.js';
import { IOnyxArchitectureMap } from '../common/onyxArchitecture.js';
import { contextAliasName, ONYX_CONTEXT_ALIAS_BOUNDS, parseContextAlias, sameOllamaModel } from '../common/onyxContextAlias.js';
import { IOnyxChatParams, IOnyxCommandOptions, IOnyxIndexOptions, IOnyxIndexStats, IOnyxLabCampaignRequest, IOnyxLabHarnessRequest, IOnyxLoadedModel, OnyxLabCheckoutResult, ONYX_STREAM_DEADLINES, IOnyxCommandOutputEvent, IOnyxCommandResult, IOnyxCommitCandidate, IOnyxCompletionParams, IOnyxDiff, IOnyxDiscoveredModel, IOnyxDocsHit, IOnyxDocsIndexStats, IOnyxEndpoint, IOnyxMachineProfile, IOnyxPullProgress, IOnyxPowerState, IOnyxRuntimeService, IOnyxStreamEvent, OnyxContextAliasResult, OnyxDiffMode, OnyxRuntimeKind } from '../common/onyxRuntime.js';

/** Base URLs probed even when the user configured nothing: the default ports of Ollama, LM Studio, llama.cpp server and vLLM. */
const WELL_KNOWN_BASE_URLS: readonly { url: string; kind: OnyxRuntimeKind }[] = [
	{ url: 'http://localhost:11434/v1', kind: 'ollama' },
	{ url: 'http://localhost:1234/v1', kind: 'lmstudio' },
	{ url: 'http://localhost:8080/v1', kind: 'llamacpp' },
	{ url: 'http://localhost:8000/v1', kind: 'vllm' },
];

const PROBE_TIMEOUT_MS = 1500;
/** Creating or removing a context alias writes a manifest on the runtime; it copies no weights (B15). */
const ALIAS_TIMEOUT_MS = 30_000;
const WATCH_INTERVAL_MS = 30_000;
const COMPLETION_TIMEOUT_MS = 15_000;
const GIT_RECENT_CACHE_MS = 60_000;

interface IOpenAIModelList {
	/** `owned_by` is how llama.cpp's server (`llamacpp`) and vLLM (`vllm`) name themselves in their model list. */
	readonly data?: readonly { readonly id: string; readonly owned_by?: string }[];
}

interface IOllamaTagsResponse {
	readonly models?: readonly {
		readonly name: string;
		readonly digest?: string;
		readonly size?: number;
		/** Set for a model Ollama forwards to a remote service instead of running: the remote name and where it is served. */
		readonly remote_model?: string;
		readonly remote_host?: string;
		readonly details?: {
			readonly family?: string;
			readonly parameter_size?: string; // e.g. "14.8B"
			readonly quantization_level?: string; // e.g. "Q4_K_M"
		};
	}[];
}

/**
 * LM Studio's native model list. Its OpenAI-compatible `/v1/models` lists
 * embedding models alongside chat models with no way to tell them apart —
 * routing a chat request to an embedding model fails every time — so the
 * native endpoint is consulted for the type and the richer metadata.
 */
interface ILmStudioModelList {
	readonly data?: readonly {
		readonly id: string;
		readonly type?: string; // 'llm' | 'embeddings' | 'vlm'
		readonly arch?: string;
		readonly quantization?: string;
		readonly max_context_length?: number;
		/** Present for a model that is loaded: the context it was loaded with. */
		readonly loaded_context_length?: number;
	}[];
}

interface IOllamaShowResponse {
	readonly capabilities?: readonly string[]; // e.g. ["completion", "tools", "vision"]
	readonly model_info?: Record<string, unknown>; // contains "<arch>.context_length"
	/** The Modelfile's parameters as text, one `name value` per line; holds `num_ctx` when the model sets one. */
	readonly parameters?: string;
}

/** Ollama's `/api/ps`: the models it has in memory, each with the context it was loaded with. */
interface IOllamaLoadedResponse {
	readonly models?: readonly { readonly name?: string; readonly model?: string; readonly context_length?: number }[];
}

/** One parsed chat-completions SSE payload (the fields we consume). */
interface ISseChunk {
	readonly usage?: { readonly prompt_tokens?: number; readonly completion_tokens?: number };
	/** Non-standard: a runtime (or the mock) that echoes the requested seed says it honoured it (L3). */
	readonly seed?: number;
	readonly system_fingerprint?: string;
	readonly choices?: readonly {
		readonly finish_reason?: string;
		/** Token log-probabilities, when they were asked for and the runtime returns them. */
		readonly logprobs?: { readonly content?: readonly object[] | null } | null;
		readonly delta?: {
			readonly content?: string;
			/** A reasoning model's thinking: `reasoning` on Ollama's OpenAI-compatible endpoint, `reasoning_content` on LM Studio, llama.cpp and vLLM. */
			readonly reasoning?: string;
			readonly reasoning_content?: string;
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
	private readonly _runningCommands = new Map<string, IOnyxCommandProcess>();
	private readonly _modelDetailCache = new Map<string, Partial<IOnyxDiscoveredModel>>();
	private readonly _gitRecentCache = new Map<string, { at: number; files: readonly string[] }>();
	private readonly _gitGroupsCache = new Map<string, { at: number; groups: readonly (readonly string[])[] }>();
	private _lastDiscovered: readonly IOnyxEndpoint[] = [];
	private _watchedBaseUrls: readonly string[] = [];
	private _watchTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(
		@ILogService private readonly _logService: ILogService,
		private readonly _commandRunner: OnyxCommandRunner = new OnyxCommandRunner(),
	) {
		super();
		// This process can exit without disposing its services. The kill is
		// synchronous, so it still happens from an exit handler.
		const onExit = () => this._killAllCommands();
		process.once('exit', onExit);
		this._register(toDisposable(() => process.removeListener('exit', onExit)));
	}

	override dispose(): void {
		if (this._watchTimer) {
			clearTimeout(this._watchTimer);
		}
		for (const controller of this._operations.values()) {
			controller.abort();
		}
		this._killAllCommands();
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
		// A request that says nothing for too long is ended as stalled, not left to hang (B12). The clock is
		// restarted by every read; the first byte gets the longer deadline.
		let stalled = false;
		let watchdog: ReturnType<typeof setTimeout> | undefined;
		const expect = (withinMs: number) => {
			clearTimeout(watchdog);
			watchdog = setTimeout(() => {
				stalled = true;
				controller.abort();
			}, withinMs);
		};
		const idleMs = params.idleTimeoutMs ?? ONYX_STREAM_DEADLINES.idleMs;
		expect(params.firstByteTimeoutMs ?? ONYX_STREAM_DEADLINES.firstByteMs);
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
					...(params.seed !== undefined ? { seed: params.seed } : {}),
					...(params.maxTokens !== undefined ? { max_tokens: params.maxTokens } : {}),
					...(params.keepAlive ? { keep_alive: params.keepAlive } : {}),
					...(params.responseFormat ? { response_format: params.responseFormat } : {}),
					...(params.stop?.length ? { stop: params.stop } : {}),
					...(params.logprobs ? { logprobs: true } : {}),
				}),
			});

			if (!response.ok || !response.body) {
				const body = await response.text().catch(() => '');
				this._emitError(operationId, `${response.status} ${response.statusText}${body ? `: ${truncate(body, 400)}` : ''}`);
				return;
			}

			await this._pumpSse(operationId, response.body, params.seed, () => expect(idleMs));
		} catch (err) {
			if (!controller.signal.aborted) {
				this._emitError(operationId, err instanceof Error ? err.message : String(err));
			} else if (stalled) {
				this._logService.warn('[onyxRuntime] chat completion stalled: nothing arrived within the deadline');
				this._onDidStream.fire({ operationId, kind: 'done', finishReason: undefined, ending: 'stalled' });
			} else {
				this._onDidStream.fire({ operationId, kind: 'done', finishReason: 'cancelled', ending: 'cancelled' });
			}
		} finally {
			clearTimeout(watchdog);
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
		const raw = await this._git(repoPath, ['log', '--no-merges', '--numstat', '--pretty=format:@@%H|%aI|%s', '-n', String(clamp(maxCommits, 1, 500))], 4 * 1024 * 1024);
		const candidates: { hash: string; authoredAt: string; subject: string; files: string[]; insertions: number; deletions: number }[] = [];
		let current: { hash: string; authoredAt: string; subject: string; files: string[]; insertions: number; deletions: number } | undefined;
		for (const line of raw.split('\n')) {
			if (line.startsWith('@@')) {
				const separator = line.indexOf('|');
				const second = line.indexOf('|', separator + 1);
				current = { hash: line.slice(2, separator), authoredAt: line.slice(separator + 1, second), subject: line.slice(second + 1), files: [], insertions: 0, deletions: 0 };
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
	private readonly _indexOptions = new Map<string, IOnyxIndexOptions>();

	private _indexer(rootPath: string, persistPath: string): OnyxWorkspaceIndexer {
		let indexer = this._indexers.get(rootPath);
		if (!indexer) {
			indexer = new OnyxWorkspaceIndexer(rootPath, persistPath, this._indexOptions.get(rootPath));
			this._indexers.set(rootPath, indexer);
		}
		return indexer;
	}

	async listLoadedModels(baseUrl: string): Promise<readonly IOnyxLoadedModel[] | undefined> {
		const loaded = await this._fetchJson<IOllamaLoadedResponse>(`${ollamaRootUrl(normalizeBaseUrl(baseUrl))}/api/ps`);
		if (!Array.isArray(loaded?.models)) {
			// No such endpoint, or not this shape: the runtime has not said, which is not "nothing is loaded".
			return undefined;
		}
		return loaded.models
			.map(model => ({ id: model.name ?? model.model ?? '', ...(typeof model.context_length === 'number' && model.context_length > 0 ? { contextLength: model.context_length } : {}) }))
			.filter(model => model.id.length > 0);
	}

	async createContextAlias(baseUrl: string, model: string, tokens: number): Promise<OnyxContextAliasResult> {
		const root = ollamaRootUrl(normalizeBaseUrl(baseUrl));
		if (!Number.isInteger(tokens) || tokens < ONYX_CONTEXT_ALIAS_BOUNDS.minTokens || tokens > ONYX_CONTEXT_ALIAS_BOUNDS.maxTokens) {
			return { ok: false, error: `a context of ${tokens} tokens is outside what an alias is made for` };
		}
		if (parseContextAlias(model)) {
			return { ok: false, error: `${model} is itself a context alias` };
		}
		const alias = contextAliasName(model, tokens);
		try {
			const response = await fetch(`${root}/api/create`, {
				method: 'POST',
				signal: AbortSignal.timeout(ALIAS_TIMEOUT_MS),
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ model: alias, from: model, parameters: { num_ctx: tokens }, stream: false }),
			});
			if (!response.ok) {
				return { ok: false, error: `${response.status} ${response.statusText}: ${truncate(await response.text().catch(() => ''), 300)}` };
			}
		} catch (err) {
			return { ok: false, error: err instanceof Error ? err.message : String(err) };
		}
		// What was asked for is read back: the alias has to exist and name the context in its parameters.
		const show = await this._fetchJson<IOllamaShowResponse>(`${root}/api/show`, { model: alias });
		const numCtx = /^\s*num_ctx\s+(?<tokens>\d+)\s*$/m.exec(show?.parameters ?? '')?.groups?.tokens;
		if (numCtx === undefined || Number(numCtx) !== tokens) {
			return { ok: false, error: `the runtime accepted the request, but ${alias} does not carry a context of ${tokens} tokens` };
		}
		return { ok: true, alias };
	}

	async removeContextAlias(baseUrl: string, alias: string): Promise<OnyxContextAliasResult> {
		if (!parseContextAlias(alias)) {
			return { ok: false, error: `${alias} is not a context alias; Onyx removes only the aliases it names` };
		}
		try {
			const response = await fetch(`${ollamaRootUrl(normalizeBaseUrl(baseUrl))}/api/delete`, {
				method: 'DELETE',
				signal: AbortSignal.timeout(ALIAS_TIMEOUT_MS),
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ model: alias }),
			});
			if (!response.ok) {
				return { ok: false, error: `${response.status} ${response.statusText}: ${truncate(await response.text().catch(() => ''), 300)}` };
			}
		} catch (err) {
			return { ok: false, error: err instanceof Error ? err.message : String(err) };
		}
		this._modelDetailCache.delete(`${normalizeBaseUrl(baseUrl)}|${alias}`);
		return { ok: true, alias };
	}

	async labHarnessRequest(): Promise<IOnyxLabHarnessRequest | undefined> {
		return readLabHarnessRequest(process.env, path => fs.promises.readFile(path, 'utf8'));
	}

	private _labCampaign: Promise<IOnyxLabCampaignRequest | undefined> | undefined;

	async labCampaignRequest(): Promise<IOnyxLabCampaignRequest | undefined> {
		this._labCampaign ??= readLabCampaignRequest(process.env, path => fs.promises.readFile(path, 'utf8'));
		return this._labCampaign;
	}

	async labCheckout(revision: string): Promise<OnyxLabCheckoutResult> {
		const paths = labCampaignPaths((await this.labCampaignRequest())?.order);
		if (!paths) {
			return { ok: false, error: 'this process was not started with a campaign work order' };
		}
		if (!/^[0-9a-f]{7,40}(~1)?$/i.test(revision)) {
			return { ok: false, error: 'a campaign checks out a commit by its hash, or that commit\'s parent' };
		}
		// A linked worktree keeps its own git directory under the repository's: the two differ. In a
		// repository's own working tree they are the same, and that tree is never checked out by a campaign.
		const gitDir = (await this._git(paths.worktree, ['rev-parse', '--absolute-git-dir'])).trim();
		const commonDir = (await this._git(paths.worktree, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim();
		if (!gitDir || !commonDir || gitDir === commonDir) {
			return { ok: false, error: 'the campaign\'s folder is not a linked worktree; a campaign never checks out a repository\'s own working tree' };
		}
		const failure = await new Promise<string | undefined>(resolve => {
			execFile('git', ['-C', paths.worktree, 'checkout', '--quiet', '--detach', revision], { timeout: 120_000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, GIT_LFS_SKIP_SMUDGE: '1' } },
				err => resolve(err ? err.message.slice(0, 400) : undefined));
		});
		if (failure !== undefined) {
			return { ok: false, error: failure };
		}
		return { ok: true, head: (await this._git(paths.worktree, ['rev-parse', 'HEAD'])).trim() };
	}

	async labWrite(kind: 'record' | 'status', text: string): Promise<void> {
		const paths = labCampaignPaths((await this.labCampaignRequest())?.order);
		if (!paths) {
			return;
		}
		if (kind === 'record') {
			await fs.promises.appendFile(paths.recordsPath, text.endsWith('\n') ? text : `${text}\n`);
		} else {
			await fs.promises.writeFile(paths.statusPath, text);
		}
	}

	async configureWorkspaceIndex(rootPath: string, options: IOnyxIndexOptions): Promise<void> {
		const before = JSON.stringify(this._indexOptions.get(rootPath) ?? {});
		this._indexOptions.set(rootPath, options);
		if (before !== JSON.stringify(options)) {
			// An index made under other rules is not this index. The next use loads or builds one under these.
			this._indexers.get(rootPath)?.dispose();
			this._indexers.delete(rootPath);
		}
	}

	async ensureWorkspaceIndex(rootPath: string, persistPath: string): Promise<IOnyxIndexStats> {
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

	private async _pumpSse(operationId: string, body: ReadableStream<Uint8Array>, requestedSeed: number | undefined, onBytes: () => void): Promise<void> {
		const decoder = new TextDecoder();
		let buffered = '';
		let sawDone = false;
		let finishReason: string | undefined;
		let echoedSeed: number | undefined;
		let fingerprint: string | undefined;
		let sawLogprobs = false;

		const reader = body.getReader();
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) {
					break;
				}
				onBytes();
				buffered += decoder.decode(value, { stream: true });

				// One network read usually carries several SSE events; coalescing
				// their text deltas into a single event keeps IPC traffic low.
				let textDelta = '';
				let reasoningDelta = '';
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
					if (typeof parsed.seed === 'number') {
						echoedSeed = parsed.seed;
					}
					if (typeof parsed.system_fingerprint === 'string') {
						fingerprint = parsed.system_fingerprint;
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
					if (choice.logprobs?.content?.length) {
						sawLogprobs = true;
					}
					if (typeof choice.delta?.content === 'string' && choice.delta.content.length > 0) {
						textDelta += choice.delta.content;
					}
					const reasoning = choice.delta?.reasoning ?? choice.delta?.reasoning_content;
					if (typeof reasoning === 'string' && reasoning.length > 0) {
						reasoningDelta += reasoning;
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
				// Thinking first: within one read it precedes the text it led to.
				if (reasoningDelta) {
					this._onDidStream.fire({ operationId, kind: 'reasoning', text: reasoningDelta });
				}
				if (textDelta) {
					this._onDidStream.fire({ operationId, kind: 'delta', text: textDelta });
				}
				if (sawDone) {
					break;
				}
			}
			// A body that ends without a finish reason and without [DONE] was cut off, whatever it carried (B12).
			const ending = finishReason !== undefined || sawDone ? 'complete' : 'truncated';
			if (ending === 'truncated') {
				this._logService.warn('[onyxRuntime] chat completion truncated: the body ended without a finish reason or [DONE]');
			}
			// Honoured only when the runtime echoed the seed it was sent; a silent runtime leaves it unknown.
			this._onDidStream.fire({ operationId, kind: 'done', finishReason, ending, fingerprint, seedHonoured: requestedSeed !== undefined && echoedSeed === requestedSeed ? true : undefined, ...(sawLogprobs ? { logprobs: true } : {}) });
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
		// LM Studio's native list, same idea: detection is by response.
		const lmStudioList = ollamaTags?.models
			? undefined
			: await this._fetchJson<ILmStudioModelList>(`${ollamaRootUrl(baseUrl)}/api/v0/models`);
		// What the server says it is. A well-known port is a hint for a name to show, never an identification.
		const ownedBy = list.data.map(entry => entry.owned_by).find(owner => owner === 'llamacpp' || owner === 'vllm');
		const identified: OnyxRuntimeKind | undefined = ollamaTags?.models ? 'ollama' : lmStudioList?.data ? 'lmstudio' : ownedBy === 'llamacpp' ? 'llamacpp' : ownedBy === 'vllm' ? 'vllm' : undefined;
		const runtime: OnyxRuntimeKind = identified ?? kindHint;
		// The runtime's own version, for trace provenance (L3); only Ollama reports one today.
		const ollamaVersion = runtime === 'ollama' ? (await this._fetchJson<{ readonly version?: string }>(`${ollamaRootUrl(baseUrl)}/api/version`))?.version : undefined;
		// What an Ollama server allocated for the models it has in memory. For a loaded model this is the
		// number a prompt has to fit, whatever the model's own parameters name (B13).
		const loaded = runtime === 'ollama' ? await this.listLoadedModels(baseUrl) : undefined;

		const models: IOnyxDiscoveredModel[] = [];
		for (const entry of list.data) {
			const tag = ollamaTags?.models?.find(m => m.name === entry.id);
			const native = lmStudioList?.data?.find(m => m.id === entry.id);
			// Embedding models answer /v1/models but cannot serve a chat
			// completion; routing to one fails every request it wins.
			if (native?.type && native.type !== 'llm' && native.type !== 'vlm') {
				continue;
			}
			const detail = runtime === 'ollama' ? await this._getOllamaDetail(baseUrl, entry.id) : undefined;
			const alias = parseContextAlias(entry.id);
			models.push({
				id: entry.id,
				baseUrl,
				runtime,
				family: tag?.details?.family ?? native?.arch ?? parseFamily(entry.id),
				parameterB: parseParameterB(tag?.details?.parameter_size) ?? parseParameterBFromId(entry.id),
				quantization: tag?.details?.quantization_level ?? native?.quantization,
				contextLength: detail?.contextLength ?? native?.max_context_length,
				serverContextLength: loaded?.find(model => model.id === entry.id)?.contextLength ?? detail?.serverContextLength ?? native?.loaded_context_length,
				supportsTools: detail?.supportsTools,
				supportsVision: detail?.supportsVision ?? (native?.type === 'vlm' ? true : undefined),
				// The four known runtimes all accept OpenAI `response_format:
				// json_schema`; an unidentified server cannot be assumed to.
				supportsJsonSchema: runtime !== 'generic',
				// Where the model runs, in the runtime's own account (B14). Ollama marks a model it forwards
				// with a remote host, and names cloud models with a `cloud` tag; a server that did not
				// identify itself has said nothing, and nothing is assumed for it.
				...executionOf(identified, entry.id, tag),
				digest: tag?.digest,
				runtimeVersion: ollamaVersion,
				...(typeof tag?.size === 'number' ? { sizeBytes: tag.size } : {}),
				// One of Onyx's own context aliases, when the model it stands for is here too (B15).
				...(runtime === 'ollama' && alias && list.data.some(other => sameOllamaModel(other.id, alias.base)) ? { contextAlias: alias } : {}),
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
		// What the server will allocate, when the model says: `num_ctx` in its parameters.
		const numCtx = /^\s*num_ctx\s+(?<tokens>\d+)\s*$/m.exec(show.parameters ?? '')?.groups?.tokens;
		const detail: Partial<IOnyxDiscoveredModel> = {
			contextLength,
			serverContextLength: numCtx !== undefined ? Number(numCtx) : undefined,
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

	/**
	 * Starts nothing itself: which shell, which spawn options and how the
	 * process tree ends are the runner's (`onyxCommandRunner.ts`, DEC-02).
	 */
	async execCommand(operationId: string, cwd: string, command: string, timeoutMs: number, options?: IOnyxCommandOptions): Promise<IOnyxCommandResult> {
		const running = this._commandRunner.start(
			{ cwd, command, timeoutMs, passEnvironment: options?.passEnvironment === true },
			(stream, text) => this._onDidCommandOutput.fire({ operationId, stream, text }));
		this._runningCommands.set(operationId, running);
		try {
			return await running.result;
		} finally {
			this._runningCommands.delete(operationId);
		}
	}

	async oracleProbe(): Promise<IOnyxOracleProbe> {
		return probeOracleSandbox(this._commandRunner, process.platform, os.tmpdir());
	}

	async oracleRun(worktree: string, command: string, timeoutMs: number): Promise<IOnyxCommandResult> {
		const gitDir = (await this._git(worktree, ['rev-parse', '--absolute-git-dir'])).trim();
		const commonDir = (await this._git(worktree, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim();
		if (!gitDir || !commonDir || gitDir === commonDir) {
			return { exitCode: undefined, timedOut: false, killed: false, durationMs: 0, output: '', outputChars: 0, outputTruncated: false, withheldEnvironment: [], refusal: 'not-a-worktree' };
		}
		return runOracleCommand(this._commandRunner, worktree, command, timeoutMs);
	}

	async killCommand(operationId: string): Promise<void> {
		this._runningCommands.get(operationId)?.kill();
	}

	private _killAllCommands(): void {
		for (const running of this._runningCommands.values()) {
			running.kill();
		}
	}
}

/** What an identified runtime reports about where one of its models runs. */
function executionOf(identified: OnyxRuntimeKind | undefined, modelId: string, tag: { readonly remote_model?: string; readonly remote_host?: string } | undefined): { readonly execution?: 'local' | 'cloud'; readonly remoteHost?: string } {
	if (!identified) {
		return {};
	}
	if (identified === 'ollama' && (tag?.remote_host || tag?.remote_model || /(^|[:-])cloud$/.test(modelId))) {
		return { execution: 'cloud', remoteHost: tag?.remote_host };
	}
	return { execution: 'local' };
}

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
