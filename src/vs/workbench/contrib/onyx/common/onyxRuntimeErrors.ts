/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';

/**
 * Turns transport-level failures into sentences a person can act on. A local
 * runtime dying mid-stream surfaces as undici's `terminated`, a stopped server
 * as `ECONNREFUSED`, a too-long prompt as a 400 about context length — none of
 * which tell the user what to do. Everything Onyx shows about a failed request
 * goes through here, so "the model process died" never reaches the UI as
 * `terminated`. Unknown errors pass through unchanged: inventing an
 * explanation would be worse than showing the raw one.
 */
export function humanizeRuntimeError(raw: string, modelId?: string): string {
	const text = raw.trim();
	const model = modelId ? ` (${modelId})` : '';

	if (/^terminated$|socket hang up|ECONNRESET|premature close|aborted/i.test(text)) {
		return localize('onyx.error.terminated', "The local runtime stopped responding mid-answer{0}. Its process may have exited or run out of memory — check that it is still running, then try again.", model);
	}
	if (/ECONNREFUSED|fetch failed|ENOTFOUND|EHOSTUNREACH|network error/i.test(text)) {
		return localize('onyx.error.unreachable', "Could not reach the local runtime{0}. Start it (for example `ollama serve`) and try again.", model);
	}
	if (/timeout|ETIMEDOUT|timed out/i.test(text)) {
		return localize('onyx.error.timeout', "The local runtime took too long to answer{0}. A smaller model, or a shorter prompt, will respond faster.", model);
	}
	if (/context length|context window|too many tokens|maximum context|prompt is too long/i.test(text)) {
		return localize('onyx.error.context', "This request is longer than the model's context window{0}. Onyx will trim history on the next turn; you can also pick a model with a larger window.", model);
	}
	if (/\b404\b|model not found|no such model|does not exist/i.test(text)) {
		return localize('onyx.error.missingModel', "The runtime does not have that model loaded{0}. Pull it with Onyx: Manage Models, or pick another model.", model);
	}
	if (/out of memory|OOM|insufficient memory|cannot allocate/i.test(text)) {
		return localize('onyx.error.memory', "The runtime ran out of memory loading the model{0}. Try a smaller model or a lower quantization — Onyx: Manage Models shows what fits this Mac.", model);
	}
	if (/\b5\d\d\b/.test(text)) {
		return localize('onyx.error.serverError', "The local runtime returned an error{0}: {1}", model, text);
	}
	return text;
}
