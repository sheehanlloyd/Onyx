/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { SymbolKind, symbolKindNames } from '../../../../../editor/common/languages.js';
import { ITextModelService } from '../../../../../editor/common/services/resolverService.js';
import { ILabelService } from '../../../../../platform/label/common/label.js';
import { getWorkspaceSymbols } from '../../../search/common/search.js';
import { ILanguageModelToolsService, IToolData, IToolImpl, IToolInvocation, IToolResult, ToolDataSource } from '../../../chat/common/tools/languageModelToolsService.js';

export const ONYX_RETRIEVAL_TOOL_ID = 'onyx_repoSymbols';

const DEFAULT_RESULTS = 8;
const MAX_RESULTS = 20;
const SNIPPET_LINES = 12;
const SNIPPET_LINE_CAP = 200;

/**
 * Symbol-aware retrieval for agents: resolves a name to its definitions using
 * the workspace's own language services (the same index behind Go To Symbol),
 * so the model can jump straight to the right code instead of grepping line
 * ranges. Deterministic, local, and no extra index to build or ship.
 */
export class OnyxRetrievalToolContribution extends Disposable {

	static readonly ID = 'workbench.contrib.onyxRetrievalTool';

	constructor(
		@ILanguageModelToolsService toolsService: ILanguageModelToolsService,
		@ITextModelService private readonly _textModelService: ITextModelService,
		@ILabelService private readonly _labelService: ILabelService,
	) {
		super();

		const toolData: IToolData = {
			id: ONYX_RETRIEVAL_TOOL_ID,
			toolReferenceName: 'repoSymbols',
			displayName: localize('onyx.retrieval.displayName', "Find Symbols in Repo"),
			modelDescription: 'Finds where a symbol (function, class, method, interface, variable) is defined in the workspace, using the editor\'s language services. Returns each match with its kind, file path, line number and a source snippet. Prefer this over text search when you know an identifier\'s name.',
			userDescription: localize('onyx.retrieval.userDescription', "Find symbol definitions in the workspace"),
			source: ToolDataSource.Internal,
			canBeReferencedInPrompt: true,
			runsInWorkspace: true,
			inputSchema: {
				type: 'object',
				properties: {
					query: { type: 'string', description: 'Symbol name or prefix to search for, e.g. "AgentLoop" or "invokeTool".' },
					maxResults: { type: 'number', description: `How many matches to return (default ${DEFAULT_RESULTS}, max ${MAX_RESULTS}).` },
				},
				required: ['query'],
			},
		};

		const impl: IToolImpl = {
			prepareToolInvocation: async (context) => ({
				invocationMessage: localize('onyx.retrieval.invoking', "Searching workspace symbols for \"{0}\"", String((context.parameters as { query?: unknown }).query ?? '')),
			}),
			invoke: (invocation, countTokens, progress, token) => this._invoke(invocation, token),
		};

		this._register(toolsService.registerToolData(toolData));
		this._register(toolsService.registerToolImplementation(ONYX_RETRIEVAL_TOOL_ID, impl));
	}

	private async _invoke(invocation: IToolInvocation, token: CancellationToken): Promise<IToolResult> {
		const parameters = invocation.parameters as { query?: unknown; maxResults?: unknown };
		const query = typeof parameters.query === 'string' ? parameters.query.trim() : '';
		if (!query) {
			return { content: [{ kind: 'text', value: 'Error: a non-empty "query" string is required.' }], toolResultError: true };
		}
		const limit = Math.min(typeof parameters.maxResults === 'number' && parameters.maxResults > 0 ? Math.floor(parameters.maxResults) : DEFAULT_RESULTS, MAX_RESULTS);

		const items = await getWorkspaceSymbols(query, token);
		const ranked = rankSymbolMatches(query, items.map(item => ({
			name: item.symbol.name,
			containerName: item.symbol.containerName,
			kind: item.symbol.kind,
			uri: item.symbol.location.uri,
			startLineNumber: item.symbol.location.range?.startLineNumber ?? 1,
			endLineNumber: item.symbol.location.range?.endLineNumber ?? 1,
		})), limit);

		if (ranked.length === 0) {
			return { content: [{ kind: 'text', value: `No workspace symbols match "${query}". Try a shorter prefix, or a text search instead.` }] };
		}

		const sections: string[] = [`${ranked.length} symbol(s) matching "${query}":`];
		for (const match of ranked) {
			const path = this._labelService.getUriLabel(match.uri, { relative: true });
			const kindName = symbolKindNames[match.kind] ?? 'symbol';
			const container = match.containerName ? ` (in ${match.containerName})` : '';
			const snippet = await this._snippet(match.uri, match.startLineNumber, match.endLineNumber);
			sections.push(`${kindName} ${match.name}${container} — ${path}:${match.startLineNumber}${snippet ? `\n${snippet}` : ''}`);
		}

		return {
			content: [{ kind: 'text', value: sections.join('\n\n') }],
			toolResultDetails: ranked.map(match => match.uri),
		};
	}

	/** First lines of the symbol's body, via the text model so unsaved edits are honored. */
	private async _snippet(uri: URI, startLineNumber: number, endLineNumber: number): Promise<string | undefined> {
		try {
			const reference = await this._textModelService.createModelReference(uri);
			try {
				const model = reference.object.textEditorModel;
				const lastLine = Math.min(Math.max(endLineNumber, startLineNumber), startLineNumber + SNIPPET_LINES - 1, model.getLineCount());
				const lines: string[] = [];
				for (let line = startLineNumber; line <= lastLine; line++) {
					lines.push(model.getLineContent(line).slice(0, SNIPPET_LINE_CAP));
				}
				if (lastLine < endLineNumber) {
					lines.push(`… (${endLineNumber - lastLine} more lines)`);
				}
				return lines.join('\n');
			} finally {
				reference.dispose();
			}
		} catch {
			return undefined;
		}
	}
}

/** A symbol match reduced to what ranking and formatting need. */
export interface ISymbolMatch {
	readonly name: string;
	readonly containerName: string | undefined;
	readonly kind: SymbolKind;
	readonly uri: URI;
	readonly startLineNumber: number;
	readonly endLineNumber: number;
}

/** Definition-like symbols outrank members and locals when scores tie. */
const KIND_PRIORITY: Partial<Record<SymbolKind, number>> = {
	[SymbolKind.Class]: 0,
	[SymbolKind.Interface]: 0,
	[SymbolKind.Enum]: 0,
	[SymbolKind.Struct]: 0,
	[SymbolKind.Function]: 1,
	[SymbolKind.Method]: 1,
	[SymbolKind.Constructor]: 1,
	[SymbolKind.Namespace]: 2,
	[SymbolKind.Module]: 2,
};

/**
 * Deterministic ranking of provider results: exact name match, then prefix,
 * then substring, then whatever fuzzy matches the providers returned; ties
 * break on kind (definitions first), name length, then path for stability.
 */
export function rankSymbolMatches(query: string, matches: readonly ISymbolMatch[], limit: number): ISymbolMatch[] {
	const needle = query.toLowerCase();
	const nameScore = (name: string): number => {
		const lower = name.toLowerCase();
		if (lower === needle) { return 0; }
		if (lower.startsWith(needle)) { return 1; }
		if (lower.includes(needle)) { return 2; }
		return 3;
	};
	return [...matches]
		.sort((a, b) =>
			nameScore(a.name) - nameScore(b.name)
			|| (KIND_PRIORITY[a.kind] ?? 3) - (KIND_PRIORITY[b.kind] ?? 3)
			|| a.name.length - b.name.length
			|| a.uri.toString().localeCompare(b.uri.toString())
			|| a.startLineNumber - b.startLineNumber)
		.slice(0, limit);
}
