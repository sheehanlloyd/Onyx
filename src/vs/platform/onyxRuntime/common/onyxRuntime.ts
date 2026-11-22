/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IOnyxArchitectureMap } from './onyxArchitecture.js';
import { Event } from '../../../base/common/event.js';
import { IOnyxOracleProbe } from './onyxOracle.js';
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
	/** Context window length in tokens, when the runtime reports it: what the model's architecture allows. */
	readonly contextLength?: number;
	/**
	 * The context the server is configured to allocate for this model, when
	 * it says (B13): Ollama's `num_ctx` parameter, LM Studio's loaded context
	 * length. Often far smaller than what the architecture allows, and the
	 * number a prompt actually has to fit.
	 */
	readonly serverContextLength?: number;
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
	/**
	 * Where the model runs, as the runtime reports it (B14, DEC-04). `local`:
	 * the server identified itself and says it runs the model. `cloud`: the
	 * server says the model is served from elsewhere. Absent: the server did
	 * not say, which is not the same as local. A URL is never the evidence.
	 */
	readonly execution?: 'local' | 'cloud';
	/** Where the runtime says a cloud-backed model is served from. */
	readonly remoteHost?: string;
	/** The runtime's content digest for the weights (Ollama reports one per tag); provenance for traces (L3). */
	readonly digest?: string;
	/** The runtime's reported version, when it reports one (L3). */
	readonly runtimeVersion?: string;
	/** The size of the model's files on the runtime, in bytes, when it says (B15: what loading it costs before any context). */
	readonly sizeBytes?: number;
	/**
	 * Set when this entry is a context alias Onyx created (B15): a second name
	 * over the weights of `base` whose parameters ask for `tokens` of context.
	 * Such an entry is not a model to offer; it is how `base` is requested.
	 */
	readonly contextAlias?: { readonly base: string; readonly tokens: number };
}

/** The outcome of asking a runtime to create or remove a context alias (B15). */
export type OnyxContextAliasResult = { readonly ok: true; readonly alias: string } | { readonly ok: false; readonly error: string };

/** A model a runtime has in memory, and what it allocated for it, as the runtime reports them. */
export interface IOnyxLoadedModel {
	readonly id: string;
	/** The context the runtime allocated when it loaded the model, in tokens: the number a prompt really has to fit. */
	readonly contextLength?: number;
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
	/** Sent as `seed` when a profile or a manifest sets one (L3); the stream's `done` says whether the runtime echoed it. */
	readonly seed?: number;
	/** Sequences at which the runtime is asked to end the reply. Sent only by the datasheet's probe of whether it does (L5). */
	readonly stop?: readonly string[];
	/** Asks for token log-probabilities; the stream's `done` says whether any came back (L5). */
	readonly logprobs?: boolean;
	/** How long to wait for the first byte of the response. Default {@link ONYX_STREAM_DEADLINES}. */
	readonly firstByteTimeoutMs?: number;
	/** How long the stream may then stay silent before it is called stalled. Default {@link ONYX_STREAM_DEADLINES}. */
	readonly idleTimeoutMs?: number;
}

/**
 * How long a chat request may say nothing (B12). The first byte gets longer:
 * a cold model is loaded and a long prompt evaluated before anything is
 * sent. After that, silence for this long means the runtime is stuck, and
 * the request is ended as `stalled` rather than left to hang.
 */
export const ONYX_STREAM_DEADLINES = {
	firstByteMs: 600_000,
	idleMs: 180_000,
} as const;

/**
 * How a chat stream ended (B12). `complete`: the runtime sent a finish
 * reason or `[DONE]`. `truncated`: the body ended without either. `stalled`:
 * nothing arrived within the deadline. `cancelled`: the caller stopped it.
 * A stream that failed ends with the `error` event instead.
 */
export type OnyxStreamEnding = 'complete' | 'truncated' | 'stalled' | 'cancelled';

/** How much of a tree one index may cover. Past either cap the index holds the highest-priority files and says it is truncated. */
export interface IOnyxIndexLimits {
	readonly maxFiles: number;
	readonly maxTotalBytes: number;
}

/**
 * The default caps (C7). Measured on this repository in November 2026 with
 * the index as it is built here: 18,212 eligible files holding 216 MB of
 * text. All of them indexed retain 284 MB of memory and 53 MB on disk and
 * take about 8 seconds to build; the first 5,000 retain 74 MB, the first
 * 12,000 retain 185 MB. Memory follows the text indexed, at 1.3 to 1.6 times
 * its size, so the byte cap is the bound on memory: about 400 MB at 256 MB
 * of text, whatever the file cap. The earlier caps (5,000 files, 64 MB)
 * indexed 27% of this repository. `onyx.index.maxFiles` moves the file cap.
 */
export const ONYX_INDEX_LIMITS: IOnyxIndexLimits = { maxFiles: 20_000, maxTotalBytes: 256 * 1024 * 1024 };

/**
 * A harness configuration asked for from outside the product (L4): a named
 * entry of a lab manifest, as far as it differs from what the product would
 * run. Reading it decides nothing. Whether it is applied is the workbench's
 * decision, and a packaged build refuses every one.
 */
export interface IOnyxLabHarnessRequest {
	/** The manifest it came from, for the record: its name, not where it is on disk. */
	readonly manifest: string;
	/** The entry's name in the manifest. */
	readonly name: string;
	/** The fields to change, as the manifest has them. Untrusted until checked. */
	readonly configuration: unknown;
	/** Why the manifest could not be read or has no such entry. A request with a problem is refused. */
	readonly problem?: string;
}

/**
 * A campaign this process was started to run (L9): the work order its
 * environment names, as text. Reading it decides nothing. Whether the
 * campaign runs is the workbench's decision, and a packaged build refuses
 * every one.
 */
export interface IOnyxLabCampaignRequest {
	/** The work order as JSON text; undefined when it could not be read. Untrusted until checked. */
	readonly order: string | undefined;
	/** Why the order could not be read. */
	readonly problem?: string;
}

export type OnyxLabCheckoutResult = { readonly ok: true; readonly head: string } | { readonly ok: false; readonly error: string };

/** What decides which files a workspace index covers, beyond its built-in rules (C7). */
export interface IOnyxIndexOptions extends Partial<IOnyxIndexLimits> {
	/** Glob patterns, relative to the root, for files and folders to leave out: the workspace's `files.exclude` and `search.exclude`. */
	readonly exclude?: readonly string[];
}

/** What an index says about itself: how big, how it came to be, and whether the caps cut it short. */
export interface IOnyxIndexStats {
	readonly files: number;
	/**
	 * How many files the index's rules make eligible, indexed or not.
	 * `files / eligibleFiles` is the coverage (C7). A file past the cap is
	 * counted by its path alone, without looking at its size, so on a truncated
	 * index the number can be high by the few files too large to index.
	 */
	readonly eligibleFiles: number;
	readonly buildMs: number;
	/** True when caps stopped the walk before the workspace was fully covered. Survives persistence. */
	readonly truncated: boolean;
	/** Built from the tree just now, loaded from its file unchanged, or loaded and brought up to date with the tree. */
	readonly source: 'built' | 'loaded' | 'reconciled';
	/** When the index was built from the tree, as epoch milliseconds. */
	readonly builtAt: number;
	/** What bringing a loaded index up to date changed. */
	readonly reconciled?: { readonly added: number; readonly updated: number; readonly removed: number };
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
	/** Thinking the runtime sends beside the text, in `reasoning` or `reasoning_content` (C4). Not part of the answer. */
	| { readonly operationId: string; readonly kind: 'reasoning'; readonly text: string }
	| { readonly operationId: string; readonly kind: 'toolCallDelta'; readonly index: number; readonly id?: string; readonly name?: string; readonly argumentsDelta?: string }
	| { readonly operationId: string; readonly kind: 'usage'; readonly promptTokens: number; readonly completionTokens: number }
	| { readonly operationId: string; readonly kind: 'done'; readonly ending: OnyxStreamEnding; readonly finishReason: string | undefined; readonly seedHonoured?: boolean; readonly fingerprint?: string; readonly logprobs?: boolean }
	| { readonly operationId: string; readonly kind: 'error'; readonly message: string };

/** One commit summarized for on-your-repo benchmark selection. */
export interface IOnyxCommitCandidate {
	readonly hash: string;
	/** When the commit was authored, ISO 8601. */
	readonly authoredAt?: string;
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
	/** Combined output, capped: the start and the end of what the command printed when it printed more. */
	readonly output: string;
	/** Everything the command printed, in characters, including what was left out of `output`. */
	readonly outputChars: number;
	readonly outputTruncated: boolean;
	/** Names of the environment variables that were withheld because they look like secrets. Names only. */
	readonly withheldEnvironment: readonly string[];
	/** Set when nothing was started, with the reason. */
	readonly refusal: OnyxCommandRefusal | undefined;
}

/**
 * Why a command was not started. `unsupported-platform`: this platform has no tested way to run and end one in
 * this release (DEC-02). `sandbox-unavailable`: the command was to run inside a sandbox and none can be started
 * here; it is never run without one (L10, DEC-10). `not-a-worktree`: a verification command runs only in a
 * linked worktree, never in a repository's own working tree.
 */
export type OnyxCommandRefusal = 'unsupported-platform' | 'sandbox-unavailable' | 'not-a-worktree';

export interface IOnyxCommandOptions {
	/**
	 * Pass the whole environment to the command. Without it, variables whose
	 * names look like secrets are withheld (`onyx.terminal.passEnvironment`).
	 */
	readonly passEnvironment?: boolean;
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
	 * The models the runtime at this endpoint has in memory now (Ollama's
	 * `/api/ps`). Undefined when the runtime does not say, which is not the
	 * same as none being loaded.
	 */
	listLoadedModels(baseUrl: string): Promise<readonly IOnyxLoadedModel[] | undefined>;

	/**
	 * Asks an Ollama server for a second name over `model`'s weights whose
	 * parameters carry a context of `tokens` (B15). It creates a model on the
	 * user's runtime, so a caller asks the user first. No weights are copied:
	 * the new name points at the files `model` already has. Any other context
	 * alias of the same model is left alone; `removeContextAlias` removes one.
	 */
	createContextAlias(baseUrl: string, model: string, tokens: number): Promise<OnyxContextAliasResult>;

	/** Removes a context alias. Refuses a name that is not one of Onyx's aliases, whatever the caller says. */
	removeContextAlias(baseUrl: string, alias: string): Promise<OnyxContextAliasResult>;

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
	ensureWorkspaceIndex(rootPath: string, persistPath: string): Promise<IOnyxIndexStats>;

	/**
	 * Sets what the index for a workspace root covers (C7). An index that is
	 * already there under other options is dropped, and the next use loads or
	 * builds one under these.
	 */
	configureWorkspaceIndex(rootPath: string, options: IOnyxIndexOptions): Promise<void>;

	/**
	 * The harness configuration this process was started with a request for,
	 * from the lab manifest its environment names (L4). Undefined on every
	 * ordinary start.
	 */
	labHarnessRequest(): Promise<IOnyxLabHarnessRequest | undefined>;

	/** The campaign work order this process's environment names (L9); undefined on every ordinary start. */
	labCampaignRequest(): Promise<IOnyxLabCampaignRequest | undefined>;

	/**
	 * Checks the campaign's worktree out at a revision (L9). It acts only on
	 * the worktree the work order names, and only when that is a linked
	 * worktree of a repository: never the repository's own working tree.
	 */
	labCheckout(revision: string): Promise<OnyxLabCheckoutResult>;

	/**
	 * Writes to the two files the work order names (L9): `record` appends one
	 * line to the campaign's records, `status` replaces its status file.
	 * Without a work order it does nothing.
	 */
	labWrite(kind: 'record' | 'status', text: string): Promise<void>;

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

	/**
	 * Live stdout/stderr of commands started via {@link execCommand}. Bounded:
	 * no event carries more than `ONYX_COMMAND_OUTPUT_LIMITS.eventChars`, and
	 * one command streams at most `streamedChars`; the rest is counted in the
	 * result and not sent.
	 */
	readonly onDidCommandOutput: Event<IOnyxCommandOutputEvent>;

	/**
	 * Runs one shell command in `cwd` with a hard timeout, streaming output on
	 * {@link onDidCommandOutput}. Runs here because the renderer cannot spawn
	 * processes. The caller is responsible for having obtained approval — this
	 * method executes, it does not decide. Every command still running when
	 * this service is disposed, or when its process exits, is killed.
	 */
	execCommand(operationId: string, cwd: string, command: string, timeoutMs: number, options?: IOnyxCommandOptions): Promise<IOnyxCommandResult>;

	/** Kills a running command (its whole process group) started via {@link execCommand}. */
	killCommand(operationId: string): Promise<void>;

	/** Probes whether a sandbox that denies the network and writes outside a worktree can be established here (L10, DEC-10). */
	oracleProbe(): Promise<IOnyxOracleProbe>;

	/**
	 * Runs a verification command inside the sandbox, in a linked worktree
	 * (L10, DEC-10). Nothing is run outside the sandbox: where it cannot be
	 * started, or the folder is not a linked worktree, the result is a
	 * refusal. Whether the user agreed is the caller's to have established.
	 */
	oracleRun(worktree: string, command: string, timeoutMs: number): Promise<IOnyxCommandResult>;
}
