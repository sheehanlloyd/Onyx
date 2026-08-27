/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

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
}

export type IOnyxStreamEvent =
	| { readonly operationId: string; readonly kind: 'delta'; readonly text: string }
	| { readonly operationId: string; readonly kind: 'toolCallDelta'; readonly index: number; readonly id?: string; readonly name?: string; readonly argumentsDelta?: string }
	| { readonly operationId: string; readonly kind: 'usage'; readonly promptTokens: number; readonly completionTokens: number }
	| { readonly operationId: string; readonly kind: 'done'; readonly finishReason: string | undefined }
	| { readonly operationId: string; readonly kind: 'error'; readonly message: string };

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
}
