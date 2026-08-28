/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { Position } from '../../../../../editor/common/core/position.js';
import { SymbolKind, symbolKindNames } from '../../../../../editor/common/languages.js';
import { ILanguageFeaturesService } from '../../../../../editor/common/services/languageFeatures.js';
import { ITextModelService } from '../../../../../editor/common/services/resolverService.js';
import { ILabelService } from '../../../../../platform/label/common/label.js';
import { CallHierarchyItem, CallHierarchyProviderRegistry } from '../../../callHierarchy/common/callHierarchy.js';
import { getWorkspaceSymbols } from '../../../search/common/search.js';
import { ILanguageModelToolsService, IToolData, IToolImpl, IToolInvocation, IToolResult, ToolDataSource } from '../../../chat/common/tools/languageModelToolsService.js';
import { IOnyxRuntimeService } from '../../../../../platform/onyxRuntime/common/onyxRuntime.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IWorkbenchEnvironmentService } from '../../../../services/environment/common/environmentService.js';
import { buildCoChangeIndex, coChangedWith } from '../../common/onyxCoChange.js';
import { blendRetrievalSignals } from '../../common/onyxRetrievalBlend.js';
import { qualifyWorkspacePath, resolveWorkspacePath } from '../../common/onyxWorkspacePaths.js';
import { bm25PersistPath } from './onyxWorkspaceIndex.js';

export const ONYX_RETRIEVAL_TOOL_ID = 'onyx_repoSymbols';

const DEFAULT_RESULTS = 8;
const MAX_RESULTS = 20;
const SNIPPET_LINES = 12;
const SNIPPET_LINE_CAP = 200;
const MAX_CALL_EDGES = 8;

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
		@ILanguageFeaturesService private readonly _languageFeaturesService: ILanguageFeaturesService,
		@IOnyxRuntimeService private readonly _runtimeService: IOnyxRuntimeService,
		@IWorkspaceContextService private readonly _workspaceService: IWorkspaceContextService,
		@IWorkbenchEnvironmentService private readonly _environmentService: IWorkbenchEnvironmentService,
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
					expand: { type: 'boolean', description: 'Also report the call graph of the best match: which functions call it and which it calls, each with file and line. Use when you need to understand how a symbol is used before changing it.' },
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
		const parameters = invocation.parameters as { query?: unknown; maxResults?: unknown; expand?: unknown };
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
			startColumn: item.symbol.location.range?.startColumn ?? 1,
			endLineNumber: item.symbol.location.range?.endLineNumber ?? 1,
		})), limit);

		const blendedSection = await this._blendedFiles(query, ranked.map(match => this._labelService.getUriLabel(match.uri, { relative: true })));

		if (ranked.length === 0) {
			return {
				content: [{
					kind: 'text', value: blendedSection
						? `No workspace symbols match "${query}", but these files match by content:\n${blendedSection}`
						: `No workspace symbols match "${query}". Try a shorter prefix, or a text search instead.`
				}]
			};
		}

		const sections: string[] = [`${ranked.length} symbol(s) matching "${query}":`];
		for (const match of ranked) {
			const path = this._labelService.getUriLabel(match.uri, { relative: true });
			const kindName = symbolKindNames[match.kind] ?? 'symbol';
			const container = match.containerName ? ` (in ${match.containerName})` : '';
			const snippet = await this._snippet(match.uri, match.startLineNumber, match.endLineNumber);
			sections.push(`${kindName} ${match.name}${container} — ${path}:${match.startLineNumber}${snippet ? `\n${snippet}` : ''}`);
		}
		if (parameters.expand === true) {
			sections.push(await this._callGraph(ranked[0], token));
		}
		if (blendedSection) {
			sections.push(`Files most relevant to "${query}" (symbols ⊕ content ⊕ co-change):\n${blendedSection}`);
		}

		return {
			content: [{ kind: 'text', value: sections.join('\n\n') }],
			toolResultDetails: ranked.map(match => match.uri),
		};
	}

	/**
	 * The blended file ranking: symbol hits ⊕ BM25 content hits from the
	 * shared-process index ⊕ historical co-change partners of the best
	 * symbol file. Empty string when no signal produced anything (e.g. the
	 * index has not been built yet).
	 */
	private async _blendedFiles(query: string, symbolPaths: readonly string[]): Promise<string> {
		const folders = this._workspaceService.getWorkspace().folders.filter(folder => folder.uri.scheme === 'file');
		if (folders.length === 0) {
			return '';
		}
		const folderRefs = folders.map(f => ({ name: f.name, index: f.index }));
		const contentHits: { path: string; score: number }[] = [];
		let coChangePartners: { path: string; strength: number }[] = [];
		for (const folder of folders) {
			try {
				const hits = await this._runtimeService.searchWorkspaceIndex(folder.uri.fsPath, bm25PersistPath(this._environmentService, this._workspaceService, folder).fsPath, query, 8);
				contentHits.push(...hits.map(hit => ({ path: qualifyWorkspacePath(folderRefs, folder.index, hit.path), score: hit.score })));
			} catch {
				// index unavailable: symbols and history still blend
			}
		}
		const topSymbolPath = symbolPaths[0];
		if (topSymbolPath) {
			try {
				const resolved = resolveWorkspacePath(folderRefs, topSymbolPath);
				const folder = resolved ? folders.find(f => f.index === resolved.folderIndex) : undefined;
				if (resolved && folder) {
					const groups = await this._runtimeService.gitCommitFileGroups(folder.uri.fsPath, 150);
					coChangePartners = coChangedWith(buildCoChangeIndex(groups), resolved.relativePath, 5)
						.map(partner => ({ path: qualifyWorkspacePath(folderRefs, folder.index, partner.path), strength: partner.strength }));
				}
			} catch {
				// no git history: blend without it
			}
		}
		const blended = blendRetrievalSignals({ symbolPaths, contentHits, coChangePartners }, 8);
		if (blended.length === 0) {
			return '';
		}
		return blended.map(file => `- ${file.path} (${file.reasons.join(', ')})`).join('\n');
	}

	/**
	 * Call-graph context for the best match: who calls it and what it calls,
	 * from the language's call-hierarchy provider (the machinery behind the
	 * editor's Show Call Hierarchy). Falls back to plain references when the
	 * language has no call-hierarchy support.
	 */
	private async _callGraph(match: ISymbolMatch, token: CancellationToken): Promise<string> {
		const describe = (item: CallHierarchyItem): string =>
			`${item.name} (${this._labelService.getUriLabel(item.uri, { relative: true })}:${item.range.startLineNumber})`;
		try {
			const reference = await this._textModelService.createModelReference(match.uri);
			try {
				const model = reference.object.textEditorModel;
				// Workspace-symbol ranges often start at the line (on `export`
				// or `function`), but hierarchy/reference providers want the
				// identifier itself — aim at the name within the line.
				const lineContent = match.startLineNumber <= model.getLineCount() ? model.getLineContent(match.startLineNumber) : '';
				// Provider names may decorate the identifier (TS reports `foo()`),
				// so search for the bare leading identifier.
				const identifier = match.name.match(/^[\w$]+/)?.[0] ?? match.name;
				const nameIndex = lineContent.indexOf(identifier);
				const position = new Position(match.startLineNumber, nameIndex >= 0 ? nameIndex + 1 : match.startColumn);
				const [provider] = CallHierarchyProviderRegistry.ordered(model);
				if (provider) {
					const session = await provider.prepareCallHierarchy(model, position, token);
					const root = session?.roots[0];
					if (session && root) {
						try {
							const incoming = (await provider.provideIncomingCalls(root, token)) ?? [];
							const outgoing = (await provider.provideOutgoingCalls(root, token)) ?? [];
							return [
								`Call graph of ${match.name}:`,
								`- called by: ${incoming.length ? incoming.slice(0, MAX_CALL_EDGES).map(call => describe(call.from)).join(', ') : '(nothing in the workspace)'}`,
								`- calls: ${outgoing.length ? outgoing.slice(0, MAX_CALL_EDGES).map(call => describe(call.to)).join(', ') : '(nothing)'}`,
							].join('\n');
						} finally {
							session.dispose();
						}
					}
				}
				const [referenceProvider] = this._languageFeaturesService.referenceProvider.ordered(model);
				if (referenceProvider) {
					const references = (await referenceProvider.provideReferences(model, position, { includeDeclaration: false }, token)) ?? [];
					const listed = references.slice(0, MAX_CALL_EDGES)
						.map(location => `${this._labelService.getUriLabel(location.uri, { relative: true })}:${location.range.startLineNumber}`);
					return `References to ${match.name} (${references.length}): ${listed.join(', ') || '(none in the workspace)'}`;
				}
				return `Call graph of ${match.name}: not available for this language.`;
			} finally {
				reference.dispose();
			}
		} catch {
			return `Call graph of ${match.name}: not available.`;
		}
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
	readonly startColumn: number;
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
