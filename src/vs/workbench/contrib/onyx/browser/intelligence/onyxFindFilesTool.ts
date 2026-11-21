/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { toErrorMessage } from '../../../../../base/common/errorMessage.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { QueryBuilder } from '../../../../services/search/common/queryBuilder.js';
import { ISearchService } from '../../../../services/search/common/search.js';
import { ILanguageModelToolsService, IToolData, IToolImpl, IToolInvocation, IToolResult, ToolDataSource } from '../../../chat/common/tools/languageModelToolsService.js';
import { ONYX_FIND_DEFAULT_RESULTS, ONYX_FIND_MAX_RESULTS } from '../../common/onyxReadTools.js';
import { workspacePathProblem } from '../../common/onyxWorkspacePaths.js';
import { IOnyxWorkspaceAccessService } from './onyxWorkspaceAccess.js';

export const ONYX_FIND_FILES_TOOL_ID = 'onyx_findFiles';

/**
 * Finds workspace files by glob through the search service (B1), so excludes
 * and ignore files apply and nothing is spawned from Onyx code. The glob is
 * matched against the search's results, not passed as an include, because an
 * include overrides ignore files. Symbolic links are not followed.
 */
export class OnyxFindFilesToolContribution extends Disposable {

	static readonly ID = 'workbench.contrib.onyxFindFilesTool';

	private readonly _queryBuilder: QueryBuilder;

	constructor(
		@ILanguageModelToolsService toolsService: ILanguageModelToolsService,
		@IOnyxWorkspaceAccessService private readonly _accessService: IOnyxWorkspaceAccessService,
		@IWorkspaceContextService private readonly _workspaceService: IWorkspaceContextService,
		@ISearchService private readonly _searchService: ISearchService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();
		this._queryBuilder = instantiationService.createInstance(QueryBuilder);

		const toolData: IToolData = {
			id: ONYX_FIND_FILES_TOOL_ID,
			toolReferenceName: 'findFiles',
			displayName: localize('onyx.findFiles.displayName', "Find Files"),
			modelDescription: `Finds workspace files whose path matches a glob pattern, e.g. "**/*.test.ts" or "src/**/config.json". Ignored and excluded files are left out. Returns up to ${ONYX_FIND_DEFAULT_RESULTS} paths by default ("maxResults" up to ${ONYX_FIND_MAX_RESULTS}).`,
			userDescription: localize('onyx.findFiles.userDescription', "Find files in the workspace by glob pattern"),
			source: ToolDataSource.Internal,
			canBeReferencedInPrompt: true,
			runsInWorkspace: true,
			inputSchema: {
				type: 'object',
				properties: {
					pattern: { type: 'string', description: 'Glob pattern matched against workspace-relative paths, e.g. "**/*.ts".' },
					maxResults: { type: 'number', description: `How many paths to return (default ${ONYX_FIND_DEFAULT_RESULTS}, max ${ONYX_FIND_MAX_RESULTS}).` },
				},
				required: ['pattern'],
			},
		};

		const impl: IToolImpl = {
			prepareToolInvocation: async (context) => ({
				invocationMessage: localize('onyx.findFiles.invoking', "Finding files matching {0}", String((context.parameters as { pattern?: unknown }).pattern ?? '')),
			}),
			invoke: (invocation, _countTokens, _progress, token) => this._invoke(invocation, token),
		};

		this._register(toolsService.registerToolData(toolData));
		this._register(toolsService.registerToolImplementation(ONYX_FIND_FILES_TOOL_ID, impl));
	}

	private async _invoke(invocation: IToolInvocation, token: CancellationToken): Promise<IToolResult> {
		const parameters = invocation.parameters as { pattern?: unknown; maxResults?: unknown };
		const pattern = typeof parameters.pattern === 'string' ? parameters.pattern.trim() : '';
		if (!pattern) {
			return errorResult('a non-empty "pattern" string is required.');
		}
		if (parameters.maxResults !== undefined && typeof parameters.maxResults !== 'number') {
			return errorResult('"maxResults" must be a number.');
		}
		const problem = workspacePathProblem(pattern);
		if (problem) {
			return errorResult(`"${pattern}" was refused: ${problem}.`);
		}
		const folders = this._workspaceService.getWorkspace().folders;
		if (folders.length === 0) {
			return errorResult('No workspace folder is open.');
		}
		const limit = Math.max(1, Math.min(typeof parameters.maxResults === 'number' && parameters.maxResults > 0 ? Math.floor(parameters.maxResults) : ONYX_FIND_DEFAULT_RESULTS, ONYX_FIND_MAX_RESULTS));
		// A pattern without a slash names files at any depth, as it does in .gitignore.
		const glob = pattern.includes('/') || pattern.startsWith('**') ? pattern.replace(/^\.\//, '') : `**/${pattern}`;

		try {
			const query = this._queryBuilder.file([...folders], {
				filePattern: glob,
				shouldGlobSearch: true,
				maxResults: limit + 1,
				ignoreSymlinks: true,
				_reason: 'onyxFindFiles',
			});
			const complete = await this._searchService.fileSearch(query, token);
			const paths: string[] = [];
			for (const match of complete.results) {
				const qualified = this._accessService.qualify(match.resource);
				if (qualified !== undefined) {
					paths.push(qualified);
				}
			}
			paths.sort((a, b) => a.localeCompare(b));
			if (paths.length === 0) {
				return { content: [{ kind: 'text', value: `No files match "${pattern}". Ignored and excluded files are not searched.` }] };
			}
			const shown = paths.slice(0, limit);
			const more = paths.length > limit || complete.limitHit;
			const lines = [`${shown.length} file${shown.length === 1 ? '' : 's'} matching "${pattern}"${more ? ' (more exist)' : ''}:`, ...shown];
			if (more) {
				lines.push(`[more files match; narrow the pattern, or pass "maxResults" up to ${ONYX_FIND_MAX_RESULTS}]`);
			}
			return { content: [{ kind: 'text', value: lines.join('\n') }], toolResultDetails: complete.results.slice(0, limit).map(match => match.resource) };
		} catch (error) {
			if (token.isCancellationRequested) {
				return errorResult('cancelled.');
			}
			return errorResult(`the file search failed: ${toErrorMessage(error)}`);
		}
	}
}

function errorResult(message: string): IToolResult {
	return { content: [{ kind: 'text', value: `Error: ${message}` }], toolResultError: true };
}
