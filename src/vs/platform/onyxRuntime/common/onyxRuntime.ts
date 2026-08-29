/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IOnyxArchitectureMap } from './onyxArchitecture.js';
import { Event } from '../../../base/common/event.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';

export const IOnyxRuntimeService = createDecorator<IOnyxRuntimeService>('onyxRuntimeService');

/** Kind of local inference runtime detected behind a base URL. */
export type OnyxRuntimeKind = 'ollama' | 'lmstudio' | 'llamacpp' | 'vllm' | 'generic';

/** A reachable OpenAI-compatible endpoint on the local machine. */
export interface IOnyxEndpoint {
	/** Normalized base URL ending in `/v1`, e.g. `http://localhost:11434/v1`. */
	readonly baseUrl: string;
	readonly kind: OnyxRuntimeKind;
	/** Human-readable runtime name, e.g. `Ollama 0.6.2`. */
	readonly displayName: string;
	readonly models: readonly IOnyxDiscoveredModel[];
}

/** A model advertised by a local runtime, with whatever metadata the runtime exposes. */
export interface IOnyxDiscoveredModel {
	/** Model id as used in chat-completion requests, e.g. `qwen2.5-coder:14b`. */
	readonly id: string;
	readonly baseUrl: string;
	readonly runtime: OnyxRuntimeKind;
	/** Model family parsed from runtime metadata or the id, e.g. `qwen2.5-coder`. */
	readonly family?: string;
	/** Parameter count in billions, when the runtime reports it (e.g. 14.8). */
	readonly parameterB?: number;
	/** Quantization label, e.g. `Q4_K_M`. */
	readonly quantization?: string;
	/** Context window length in tokens, when the runtime reports it. */
	readonly contextLength?: number;
	/** Whether the runtime declares tool/function-calling support for this model. */
	readonly supportsTools?: boolean;
	/** Whether the runtime declares vision support for this model. */
	readonly supportsVision?: boolean;
	/**
	 * Whether the serving runtime supports constrained decoding via OpenAI
	 * `response_format: json_schema` (Ollama, llama.cpp, vLLM, LM Studio do;
	 * unknown runtimes are assumed not to).
	 */
	readonly supportsJsonSchema?: boolean;
}

/** OpenAI chat-completions wire shapes. Kept loose on purpose: they mirror the JSON we send/receive. */
export interface IOnyxWireMessage {
	readonly role: 'system' | 'user' | 'assistant' | 'tool';
	readonly content: string | null;
	readonly name?: string;
	readonly tool_calls?: readonly IOnyxWireToolCall[];
	readonly tool_call_id?: string;
}

export interface IOnyxWireToolCall {
	readonly id: string;
	readonly type: 'function';
	readonly function: { readonly name: string; readonly arguments: string };
}

export interface IOnyxWireTool {
	readonly type: 'function';
	readonly function: {
		readonly name: string;
		readonly description?: string;
		readonly parameters?: object;
	};
}

export interface IOnyxChatParams {
	readonly baseUrl: string;
	readonly apiKey?: string;
	readonly model: string;
	readonly messages: readonly IOnyxWireMessage[];
	readonly tools?: readonly IOnyxWireTool[];
	readonly temperature?: number;
	readonly maxTokens?: number;
	/** Residency hint (e.g. `30m`), sent as Ollama's `keep_alive`. Only set for runtimes that honor it. */
	readonly keepAlive?: string;
	/** OpenAI `response_format` payload for constrained decoding, verbatim. */
	readonly responseFormat?: unknown;
	/** Draft model for speculative decoding, sent as `draft_model`. Only set for runtimes that accept it per request. */
	readonly draftModel?: string;
}

export interface IOnyxCompletionParams {
	readonly baseUrl: string;
	readonly apiKey?: string;
	readonly model: string;
	/** Text before the cursor. */
	readonly prompt: string;
	/** Text after the cursor; sent as the OpenAI `suffix` for fill-in-the-middle models. */
	readonly suffix?: string;
	readonly maxTokens: number;
	readonly stop?: readonly string[];
	/** Residency hint (e.g. `30m`), sent as Ollama's `keep_alive`. Only set for runtimes that honor it. */
	readonly keepAlive?: string;
}

/** What this Mac can actually run, as read from the OS in the shared process. */
export interface IOnyxMachineProfile {
	/** Total (unified, on Apple Silicon) system memory in bytes. */
	readonly totalMemoryBytes: number;
	readonly freeMemoryBytes: number;
	readonly cpuModel: string;
	readonly cpuCount: number;
	/** `arm64` on Apple Silicon. */
	readonly arch: string;
	readonly platform: string;
}

/** Progress of an `ollama pull`, normalized from the runtime's NDJSON stream. */
export interface IOnyxPullProgress {
	readonly operationId: string;
	readonly status: string;
	readonly completedBytes?: number;
	readonly totalBytes?: number;
	readonly done: boolean;
	readonly error?: string;
}

/** Which slice of the repository's uncommitted state to diff. */
export type OnyxDiffMode = 'unstaged' | 'staged' | 'head';

/** What the machine reports about its power situation. */
export interface IOnyxPowerState {
	readonly onBattery: boolean;
	/** 'serious' when the OS reports CPU speed limiting; 'unknown' when it reports nothing. */
	readonly thermal: 'nominal' | 'serious' | 'unknown';
	/** CPU speed limit in percent when the OS reports one (macOS `pmset -g therm`). */
	readonly cpuSpeedLimit: number | undefined;
}

/** A slice of a repository diff, capped so it can be put in a prompt. */
export interface IOnyxDiff {
	/** The diff text, already truncated to the requested budget. */
	readonly text: string;
	/** Paths touched, in the order git reported them (not truncated). */
	readonly files: readonly string[];
	/** Whether {@link text} was cut short. */
	readonly truncated: boolean;
}

export type IOnyxStreamEvent =
	| { readonly operationId: string; readonly kind: 'delta'; readonly text: string }
	| { readonly operationId: string; readonly kind: 'toolCallDelta'; readonly index: number; readonly id?: string; readonly name?: string; readonly argumentsDelta?: string }
	| { readonly operationId: string; readonly kind: 'usage'; readonly promptTokens: number; readonly completionTokens: number }
	| { readonly operationId: string; readonly kind: 'done'; readonly finishReason: string | undefined }
	| { readonly operationId: string; readonly kind: 'error'; readonly message: string };

/** One commit summarized for on-your-repo benchmark selection. */
export interface IOnyxCommitCandidate {
	readonly hash: string;
	readonly subject: string;
	readonly files: readonly string[];
	readonly insertions: number;
	readonly deletions: number;
}

export interface IOnyxDocsIndexStats {
	readonly files: number;
	readonly buildMs: number;
	readonly truncated: boolean;
	/** Epoch ms of the last full build (0 when only loaded from disk without a stamp). */
	readonly builtAt: number;
}

/** One hit from the offline documentation mirror. */
export interface IOnyxDocsHit {
	/** Workspace-relative path of the source document. */
	readonly path: string;
	readonly score: number;
	/** 1-based line where the snippet starts. */
	readonly line: number;
	readonly snippet: string;
}

/** Live output of a shell command started via {@link IOnyxRuntimeService.execCommand}. */
export interface IOnyxCommandOutputEvent {
	readonly operationId: string;
	readonly stream: 'stdout' | 'stderr';
	readonly text: string;
}

export interface IOnyxCommandResult {
	/** Undefined when the process was killed before exiting on its own. */
	readonly exitCode: number | undefined;
	readonly timedOut: boolean;
	readonly killed: boolean;
	readonly durationMs: number;
	/** Combined output, capped; the live stream carries the full text. */
	readonly output: string;
}

/**
 * Runs in the shared process, where Node.js APIs are available and localhost
 * requests are not subject to renderer CORS. Owns all HTTP traffic to local
 * inference runtimes: discovery probes and streaming chat completions.
 * Streaming results are delivered via {@link onDidStream}, correlated by
 * `operationId` (RPC over the proxy channel is stateless, so cancellation and
 * streaming both key off caller-supplied ids).
 */
export interface IOnyxRuntimeService {
	readonly _serviceBrand: undefined;

	/** Fires whenever the set of reachable runtimes or their model lists change. */
	readonly onDidChangeRuntimes: Event<readonly IOnyxEndpoint[]>;

	/** Streaming events for in-flight chat completions started via {@link startChatCompletion}. */
	readonly onDidStream: Event<IOnyxStreamEvent>;

	/** Progress events for downloads started via {@link pullModel}. */
	readonly onDidPullProgress: Event<IOnyxPullProgress>;

	/**
	 * Probes the well-known local runtime ports plus the given base URLs and
	 * returns every reachable endpoint with its models. Also (re)starts the
	 * background watcher over the discovered set.
	 */
	discoverRuntimes(extraBaseUrls: readonly string[]): Promise<readonly IOnyxEndpoint[]>;

	/** Lists models for one endpoint, enriched with runtime-specific metadata where available. */
	listModels(baseUrl: string): Promise<readonly IOnyxDiscoveredModel[]>;

	/**
	 * Starts a streaming chat completion. Resolves once the stream has ended
	 * (successfully or not); deltas, usage and errors arrive on {@link onDidStream}.
	 */
	startChatCompletion(operationId: string, params: IOnyxChatParams): Promise<void>;

	/**
	 * Non-streaming fill-in-the-middle completion (`/v1/completions` with
	 * prompt + suffix), used for inline autocomplete. Returns the completion
	 * text, or undefined on any failure — autocomplete never surfaces errors.
	 */
	completeText(operationId: string, params: IOnyxCompletionParams): Promise<string | undefined>;

	cancel(operationId: string): Promise<void>;

	/**
	 * Workspace-relative paths of files touched by the most recent commits of
	 * the git repository at `repoPath`, most recent first, de-duplicated.
	 * Returns an empty list when git is unavailable or the path is not a
	 * repository. Runs here because the renderer cannot spawn processes.
	 */
	gitRecentFiles(repoPath: string, maxCommits: number): Promise<readonly string[]>;

	/**
	 * Per-commit file groups for the most recent commits, oldest entry last.
	 * Feeds co-change mining: files that keep changing together are related in
	 * ways no import graph shows.
	 */
	gitCommitFileGroups(repoPath: string, maxCommits: number): Promise<readonly (readonly string[])[]>;

	/**
	 * A diff of the repository at `repoPath`, capped at `maxChars`:
	 * `'staged'` is the index (`--cached`), `'unstaged'` the working tree
	 * against the index, and `'head'` everything uncommitted (staged and
	 * unstaged, `git diff HEAD`). Returns empty text when git is unavailable
	 * or there is nothing to diff.
	 */
	gitDiff(repoPath: string, mode: OnyxDiffMode, maxChars: number): Promise<IOnyxDiff>;

	/**
	 * Recent non-merge commits with per-file change counts (`git log
	 * --numstat`), for on-your-repo benchmark task selection.
	 */
	gitCommitCandidates(repoPath: string, maxCommits: number): Promise<readonly IOnyxCommitCandidate[]>;

	/** A file's content at a revision (`git show rev:path`), or undefined when absent. */
	gitShowFile(repoPath: string, revision: string, path: string): Promise<string | undefined>;

	/** What this machine can run — used to size model recommendations. */
	getMachineProfile(): Promise<IOnyxMachineProfile>;

	/**
	 * Power source and thermal pressure (macOS `pmset`; other platforms
	 * report "plugged in, unknown"). Drives energy-aware routing downshifts.
	 */
	getPowerState(): Promise<IOnyxPowerState>;

	/**
	 * Loads a model into the runtime ahead of use (a one-token completion
	 * with a residency hint). Fire-and-forget: failure means a cold start,
	 * nothing worse.
	 */
	warmUpModel(baseUrl: string, model: string, keepAlive: string): Promise<void>;

	/**
	 * Ensures the embedding-free BM25 index for the workspace root exists
	 * (loading the persisted copy at `persistPath` or building fresh) and
	 * returns its stats.
	 */
	ensureWorkspaceIndex(rootPath: string, persistPath: string): Promise<{ files: number; buildMs: number; truncated: boolean }>;

	/** Searches the workspace index; empty until {@link ensureWorkspaceIndex} has run. */
	searchWorkspaceIndex(rootPath: string, persistPath: string, query: string, limit: number): Promise<readonly { path: string; score: number }[]>;

	/** Re-indexes changed files (workspace-relative paths); deleted files drop out. */
	updateWorkspaceIndex(rootPath: string, persistPath: string, changedFiles: readonly string[]): Promise<void>;

	/**
	 * Creates a detached git worktree of the repository's HEAD for tournament
	 * isolation. Leftover `onyx-tournament-*` worktrees from crashed sessions
	 * are pruned on the first call.
	 */
	worktreeCreate(repoPath: string, id: string): Promise<{ readonly worktreePath: string }>;

	/** Writes one file inside a tournament worktree (path is repo-relative). */
	worktreeWriteFile(worktreePath: string, relativePath: string, content: string): Promise<void>;

	/** The worktree's diff against HEAD — what this contestant actually changed. */
	worktreeDiff(worktreePath: string): Promise<IOnyxDiff>;

	/** Removes a tournament worktree and its registration. Safe to call twice. */
	worktreeRemove(repoPath: string, worktreePath: string): Promise<void>;

	/** Applies a unified diff to the real working tree (`git apply`). Throws when it does not apply. */
	applyDiff(repoPath: string, diffText: string): Promise<void>;

	/**
	 * Downloads a model through the Ollama native API at `baseUrl`. Progress
	 * arrives on {@link onDidPullProgress}; the promise resolves when the pull
	 * finishes or fails. Cancel with {@link cancel}.
	 */
	pullModel(operationId: string, baseUrl: string, model: string): Promise<void>;

	/**
	 * Ensures the offline documentation mirror for the workspace root exists —
	 * the workspace's markdown, package READMEs and dependency JSDoc, indexed
	 * with explicit caps and a freshness stamp. No network is ever involved.
	 */
	ensureDocsIndex(rootPath: string, persistPath: string): Promise<IOnyxDocsIndexStats>;

	/** Searches the documentation mirror; each hit carries a snippet with its real line number. */
	searchDocsIndex(rootPath: string, persistPath: string, query: string, limit: number): Promise<readonly IOnyxDocsHit[]>;

	/** Re-indexes changed workspace markdown; dependency docs refresh on the age stamp instead. */
	updateDocsIndex(rootPath: string, persistPath: string, changedFiles: readonly string[]): Promise<void>;

	/**
	 * The workspace's architecture map: modules, dependency edges, churn and
	 * fan-in hot spots. Cached against a cheap workspace signature; `force`
	 * rebuilds. Runs here because walking 18k files belongs off the renderer.
	 */
	analyzeArchitecture(rootPath: string, persistPath: string, force: boolean): Promise<IOnyxArchitectureMap>;

	/** Live stdout/stderr of commands started via {@link execCommand}. */
	readonly onDidCommandOutput: Event<IOnyxCommandOutputEvent>;

	/**
	 * Runs one shell command in `cwd` with a hard timeout, streaming output on
	 * {@link onDidCommandOutput}. Runs here because the renderer cannot spawn
	 * processes. The caller is responsible for having obtained approval — this
	 * method executes, it does not decide.
	 */
	execCommand(operationId: string, cwd: string, command: string, timeoutMs: number): Promise<IOnyxCommandResult>;

	/** Kills a running command (its whole process group) started via {@link execCommand}. */
	killCommand(operationId: string): Promise<void>;
}
