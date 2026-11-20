/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { toErrorMessage } from '../../../../../base/common/errorMessage.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../../base/common/network.js';
import { localize } from '../../../../../nls.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IOnyxRuntimeService } from '../../../../../platform/onyxRuntime/common/onyxRuntime.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IWorkbenchEnvironmentService } from '../../../../services/environment/common/environmentService.js';
import { QueryBuilder } from '../../../../services/search/common/queryBuilder.js';
import { ISearchService, resultIsMatch } from '../../../../services/search/common/search.js';
import { ILanguageModelToolsService, IToolData, IToolImpl, IToolInvocation, IToolResult, ToolDataSource } from '../../../chat/common/tools/languageModelToolsService.js';
import { formatGrepMatch, ONYX_GREP_LINE_MAX_CHARS, ONYX_GREP_MAX_MATCHES, ONYX_GREP_MAX_MATCHES_PER_FILE, ONYX_GREP_SUGGESTIONS } from '../../common/onyxReadTools.js';
import { qualifyWorkspacePath, workspacePathProblem } from '../../common/onyxWorkspacePaths.js';
import { IOnyxWorkspaceAccessService } from './onyxWorkspaceAccess.js';
import { bm25PersistPath } from './onyxWorkspaceIndex.js';

export const ONYX_GREP_TOOL_ID = 'onyx_grep';

/** Matches fetched from the search before the per-file and total caps are applied. */
const SEARCH_MATCH_BUDGET = 400;

/**
 * Text search over the workspace through the search service (B1): a literal
 * string or a regular expression, results as `path:line: text`, capped per
 * file and in total, with the cancellation token passed through. Only when
 * nothing matches exactly does it append content-ranked suggestions from the
 * BM25 index, labelled as suggestions and never as matches.
 */
export class OnyxGrepToolContribution extends Disposable {

	static readonly ID = 'workbench.contrib.onyxGrepTool';

	private readonly _queryBuilder: QueryBuilder;

	constructor(
		@ILanguageModelToolsService toolsService: ILanguageModelToolsService,
		@IOnyxWorkspaceAccessService private readonly _accessService: IOnyxWorkspaceAccessService,
		@IWorkspaceContextService private readonly _workspaceService: IWorkspaceContextService,
		@ISearchService private readonly _searchService: ISearchService,
		@IOnyxRuntimeService private readonly _runtimeService: IOnyxRuntimeService,
		@IWorkbenchEnvironmentService private readonly _environmentService: IWorkbenchEnvironmentService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();
		this._queryBuilder = instantiationService.createInstance(QueryBuilder);

		const toolData: IToolData = {
			id: ONYX_GREP_TOOL_ID,
			toolReferenceName: 'grep',
			displayName: localize('onyx.grep.displayName', "Search Text"),
			modelDescription: `Searches the text of workspace files and returns matching lines as "path:line: text". "pattern" is a literal string unless "regex" is true. Use "include" (a glob such as "src/**/*.ts") to limit the files searched. Ignored and excluded files are not searched. Returns at most ${ONYX_GREP_MAX_MATCHES} lines, ${ONYX_GREP_MAX_MATCHES_PER_FILE} per file.`,
			userDescription: localize('onyx.grep.userDescription', "Search the text of workspace files"),
			source: ToolDataSource.Internal,
			canBeReferencedInPrompt: true,
			runsInWorkspace: true,
			inputSchema: {
				type: 'object',
				properties: {
					pattern: { type: 'string', description: 'The text to search for. A literal string unless "regex" is true.' },
					regex: { type: 'boolean', description: 'Treat "pattern" as a regular expression. Default false.' },
					caseSensitive: { type: 'boolean', description: 'Match case exactly. Default false.' },
					include: { type: 'string', description: 'Glob limiting which files are searched, e.g. "src/**/*.ts".' },
				},
				required: ['pattern'],
			},
		};

		const impl: IToolImpl = {
			prepareToolInvocation: async (context) => ({
				invocationMessage: localize('onyx.grep.invoking', "Searching for {0}", String((context.parameters as { pattern?: unknown }).pattern ?? '')),
			}),
			invoke: (invocation, _countTokens, _progress, token) => this._invoke(invocation, token),
		};

		this._register(toolsService.registerToolData(toolData));
		this._register(toolsService.registerToolImplementation(ONYX_GREP_TOOL_ID, impl));
	}

	private async _invoke(invocation: IToolInvocation, token: CancellationToken): Promise<IToolResult> {
		const parameters = invocation.parameters as { pattern?: unknown; regex?: unknown; caseSensitive?: unknown; include?: unknown };
		const pattern = typeof parameters.pattern === 'string' ? parameters.pattern : '';
		if (!pattern.trim()) {
			return errorResult('a non-empty "pattern" string is required.');
		}
		for (const name of ['regex', 'caseSensitive'] as const) {
			if (parameters[name] !== undefined && typeof parameters[name] !== 'boolean') {
				return errorResult(`"${name}" must be true or false.`);
			}
		}
		if (parameters.include !== undefined && typeof parameters.include !== 'string') {
			return errorResult('"include" must be a glob string.');
		}
		const isRegExp = parameters.regex === true;
		if (isRegExp) {
			try {
				new RegExp(pattern);
			} catch (error) {
				return errorResult(`"${pattern}" is not a valid regular expression: ${toErrorMessage(error)}`);
			}
		}
		const include = typeof parameters.include === 'string' ? parameters.include.trim() : '';
		if (include) {
			const problem = workspacePathProblem(include);
			if (problem) {
				return errorResult(`"${include}" was refused: ${problem}.`);
			}
		}
		const folders = this._workspaceService.getWorkspace().folders;
		if (folders.length === 0) {
			return errorResult('No workspace folder is open.');
		}

		const lines: string[] = [];
		let filesWithMatches = 0;
		let omitted = 0;
		let limitHit = false;
		try {
			const query = this._queryBuilder.text({ pattern, isRegExp, isCaseSensitive: parameters.caseSensitive === true }, folders.map(folder => folder.uri), {
				includePattern: include ? [include.includes('/') || include.startsWith('**') ? include : `**/${include}`] : undefined,
				maxResults: SEARCH_MATCH_BUDGET,
				ignoreSymlinks: true,
				previewOptions: { matchLines: 1, charsPerLine: ONYX_GREP_LINE_MAX_CHARS },
				_reason: 'onyxGrep',
			});
			const complete = await this._searchService.textSearch(query, token);
			limitHit = !!complete.limitHit;
			const files = [...complete.results].sort((a, b) => a.resource.toString().localeCompare(b.resource.toString()));
			for (const file of files) {
				const path = this._accessService.qualify(file.resource);
				if (path === undefined) {
					continue;
				}
				const seenLines = new Set<number>();
				let fromThisFile = 0;
				for (const result of file.results ?? []) {
					if (!resultIsMatch(result)) {
						continue;
					}
					const lineNumber = (result.rangeLocations[0]?.source.startLineNumber ?? 0) + 1;
					if (seenLines.has(lineNumber)) {
						continue;
					}
					seenLines.add(lineNumber);
					if (fromThisFile >= ONYX_GREP_MAX_MATCHES_PER_FILE || lines.length >= ONYX_GREP_MAX_MATCHES) {
						omitted++;
						continue;
					}
					lines.push(formatGrepMatch(path, lineNumber, result.previewText.split(/\r?\n/)[0]));
					fromThisFile++;
				}
				if (seenLines.size > 0) {
					filesWithMatches++;
				}
			}
		} catch (error) {
			if (token.isCancellationRequested) {
				return errorResult('cancelled.');
			}
			return errorResult(`the text search failed: ${toErrorMessage(error)}`);
		}

		if (lines.length === 0) {
			const suggestions = await this._suggestions(pattern);
			const scope = include ? ` in files matching "${include}"` : '';
			return {
				content: [{
					kind: 'text', value: suggestions.length
						? `No lines match "${pattern}"${scope}. These files are not matches; they rank highest for the same words in the content index:\n${suggestions.join('\n')}`
						: `No lines match "${pattern}"${scope}. Ignored and excluded files are not searched.`
				}]
			};
		}
		const header = `${lines.length} matching line${lines.length === 1 ? '' : 's'} in ${filesWithMatches} file${filesWithMatches === 1 ? '' : 's'} for "${pattern}":`;
		const footer = omitted > 0 || limitHit
			? [`[more lines match and are not shown (at most ${ONYX_GREP_MAX_MATCHES} in total, ${ONYX_GREP_MAX_MATCHES_PER_FILE} per file); narrow the pattern or add "include"]`]
			: [];
		return { content: [{ kind: 'text', value: [header, ...lines, ...footer].join('\n') }] };
	}

	/** Content-ranked files from the BM25 index, for a search that found no exact hit. */
	private async _suggestions(pattern: string): Promise<string[]> {
		const folders = this._workspaceService.getWorkspace().folders;
		const folderRefs = folders.map(folder => ({ name: folder.name, index: folder.index }));
		const suggestions: string[] = [];
		for (const folder of folders) {
			if (folder.uri.scheme !== Schemas.file) {
				continue;
			}
			try {
				const hits = await this._runtimeService.searchWorkspaceIndex(folder.uri.fsPath, bm25PersistPath(this._environmentService, this._workspaceService, folder).fsPath, pattern, ONYX_GREP_SUGGESTIONS);
				for (const hit of hits) {
					suggestions.push(qualifyWorkspacePath(folderRefs, folder.index, hit.path));
				}
			} catch {
				// No index for this folder: there is nothing to suggest.
			}
		}
		return suggestions.slice(0, ONYX_GREP_SUGGESTIONS);
	}
}

function errorResult(message: string): IToolResult {
	return { content: [{ kind: 'text', value: `Error: ${message}` }], toolResultError: true };
}
