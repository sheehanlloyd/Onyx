/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Context aliases (B15). An Ollama server gives a model the context its own
 * parameters name, and ignores a context size sent with an OpenAI-style
 * request. The one way to ask for a context that such a request then gets is
 * a second model name over the same weights whose parameters carry `num_ctx`.
 * Onyx names the ones it creates so that it can recognise them, never mistake
 * a model the user made for one of its own, and remove exactly what it made.
 */

const ALIAS_SUFFIX = /-onyx-ctx(?<tokens>[1-9]\d{3,6})$/;

/** The smallest and the largest context an alias is ever made for. */
export const ONYX_CONTEXT_ALIAS_BOUNDS = { minTokens: 2048, maxTokens: 1_048_576 } as const;

/** The name of the alias of `model` with a context of `tokens`: `qwen2.5-coder:7b-onyx-ctx16384`. */
export function contextAliasName(model: string, tokens: number): string {
	const base = parseContextAlias(model)?.base ?? model;
	// Ollama reads `name` as `name:latest`; the suffix belongs to the tag.
	return `${base.includes(':') ? base : `${base}:latest`}-onyx-ctx${Math.floor(tokens)}`;
}

/** The model an alias name stands for and its context, when the name is one of Onyx's. */
export function parseContextAlias(name: string): { readonly base: string; readonly tokens: number } | undefined {
	const match = ALIAS_SUFFIX.exec(name);
	if (!match?.groups) {
		return undefined;
	}
	const tokens = Number(match.groups.tokens);
	if (tokens < ONYX_CONTEXT_ALIAS_BOUNDS.minTokens || tokens > ONYX_CONTEXT_ALIAS_BOUNDS.maxTokens) {
		return undefined;
	}
	return { base: name.slice(0, match.index), tokens };
}

/** Whether two model names are the same model to Ollama: `name` and `name:latest` are. */
export function sameOllamaModel(a: string, b: string): boolean {
	const full = (name: string) => name.includes(':') ? name : `${name}:latest`;
	return full(a) === full(b);
}
