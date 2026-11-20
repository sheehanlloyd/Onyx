/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { toErrorMessage } from '../../../../../base/common/errorMessage.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IUriIdentityService } from '../../../../../platform/uriIdentity/common/uriIdentity.js';
import { QueryBuilder } from '../../../../services/search/common/queryBuilder.js';
import { ISearchService } from '../../../../services/search/common/search.js';
import { ILanguageModelToolsService, IToolData, IToolImpl, IToolInvocation, IToolResult, ToolDataSource } from '../../../chat/common/tools/languageModelToolsService.js';
import { formatSize, ONYX_LIST_MAX_ENTRIES } from '../../common/onyxReadTools.js';
import { IOnyxWorkspaceAccessService } from './onyxWorkspaceAccess.js';

export const ONYX_LIST_DIRECTORY_TOOL_ID = 'onyx_listDirectory';

/** Files below the listed directory that are examined to decide which subdirectories have visible content. */
const VISIBLE_DESCENDANT_PROBE = 20_000;

/**
 * One level of a workspace directory, with each entry's type and size (B1).
 * What is visible is decided by the search service, so `files.exclude`,
 * `search.exclude` and ignore files apply exactly as they do to search: a
 * file is listed when a file search finds it, and a directory when a file
 * search finds something inside it.
 */
export class OnyxListDirectoryToolContribution extends Disposable {

	static readonly ID = 'workbench.contrib.onyxListDirectoryTool';

	private readonly _queryBuilder: QueryBuilder;

	constructor(
		@ILanguageModelToolsService toolsService: ILanguageModelToolsService,
		@IOnyxWorkspaceAccessService private readonly _accessService: IOnyxWorkspaceAccessService,
		@IFileService private readonly _fileService: IFileService,
		@ISearchService private readonly _searchService: ISearchService,
		@IUriIdentityService private readonly _uriIdentityService: IUriIdentityService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();
		this._queryBuilder = instantiationService.createInstance(QueryBuilder);

		const toolData: IToolData = {
			id: ONYX_LIST_DIRECTORY_TOOL_ID,
			toolReferenceName: 'listDirectory',
			displayName: localize('onyx.listDirectory.displayName', "List Directory"),
			modelDescription: `Lists one level of a workspace directory: each entry's name, whether it is a file or a directory, and file sizes. Pass a workspace-relative path, or "." for the workspace root. Ignored and excluded entries are left out. Returns at most ${ONYX_LIST_MAX_ENTRIES} entries.`,
			userDescription: localize('onyx.listDirectory.userDescription', "List the contents of a workspace directory"),
			source: ToolDataSource.Internal,
			canBeReferencedInPrompt: true,
			runsInWorkspace: true,
			inputSchema: {
				type: 'object',
				properties: {
					path: { type: 'string', description: 'Workspace-relative directory path, e.g. "src". Use "." for the workspace root.' },
				},
				required: ['path'],
			},
		};

		const impl: IToolImpl = {
			prepareToolInvocation: async (context) => ({
				invocationMessage: localize('onyx.listDirectory.invoking', "Listing {0}", String((context.parameters as { path?: unknown }).path ?? '.')),
			}),
			invoke: (invocation, _countTokens, _progress, token) => this._invoke(invocation, token),
		};

		this._register(toolsService.registerToolData(toolData));
		this._register(toolsService.registerToolImplementation(ONYX_LIST_DIRECTORY_TOOL_ID, impl));
	}

	private async _invoke(invocation: IToolInvocation, token: CancellationToken): Promise<IToolResult> {
		const parameters = invocation.parameters as { path?: unknown };
		if (parameters.path !== undefined && typeof parameters.path !== 'string') {
			return errorResult('"path" must be a string.');
		}
		const resolved = await this._accessService.resolve(typeof parameters.path === 'string' ? parameters.path : '.');
		if (!resolved.ok) {
			return errorResult(resolved.error);
		}
		const label = resolved.qualifiedPath || '.';
		let children: readonly { name: string; isDirectory: boolean; isSymbolicLink: boolean; size: number }[];
		try {
			const stat = await this._fileService.resolve(resolved.uri, { resolveMetadata: true });
			if (!stat.isDirectory) {
				return errorResult(`${label} is a file. Use readFile.`);
			}
			children = (stat.children ?? []).map(child => ({ name: child.name, isDirectory: child.isDirectory, isSymbolicLink: child.isSymbolicLink, size: child.size }));
		} catch (error) {
			return errorResult(`${label} could not be listed: ${toErrorMessage(error)}`);
		}

		// One file search rooted at the workspace folder decides visibility, so
		// excludes and ignore files mean what they mean everywhere else. The
		// pattern is matched against results, not handed to the search as an
		// include: an include overrides ignore files.
		const prefix = resolved.relativePath ? `${resolved.relativePath}/` : '';
		const visibleFiles = new Set<string>();
		const visibleDirectories = new Set<string>();
		let probeTruncated = false;
		try {
			const query = this._queryBuilder.file([resolved.folder], {
				// A path with glob characters in it cannot be a pattern; every
				// file is fetched instead and narrowed below by location.
				filePattern: prefix && !GLOB_CHARACTERS.test(prefix) ? `${prefix}**` : undefined,
				shouldGlobSearch: true,
				maxResults: VISIBLE_DESCENDANT_PROBE,
				ignoreSymlinks: true,
				_reason: 'onyxListDirectory',
			});
			const complete = await this._searchService.fileSearch(query, token);
			probeTruncated = !!complete.limitHit;
			for (const match of complete.results) {
				const relative = this._uriIdentityService.extUri.relativePath(resolved.uri, match.resource);
				if (!relative) {
					continue;
				}
				const slash = relative.indexOf('/');
				if (slash === -1) {
					visibleFiles.add(relative);
				} else {
					visibleDirectories.add(relative.slice(0, slash));
				}
			}
		} catch (error) {
			if (token.isCancellationRequested) {
				return errorResult('cancelled.');
			}
			return errorResult(`${label} could not be listed: ${toErrorMessage(error)}`);
		}

		const shown: string[] = [];
		let hidden = 0;
		const sorted = [...children].sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name));
		for (const child of sorted) {
			const visible = child.isDirectory
				? visibleDirectories.has(child.name) || probeTruncated
				: visibleFiles.has(child.name) || (probeTruncated && !child.isSymbolicLink);
			if (!visible) {
				hidden++;
				continue;
			}
			if (shown.length < ONYX_LIST_MAX_ENTRIES) {
				shown.push(child.isDirectory ? `dir   ${child.name}/` : `file  ${child.name}  (${formatSize(child.size)})`);
			}
		}
		const visibleCount = sorted.length - hidden;
		const lines = [`${label}: ${visibleCount} entr${visibleCount === 1 ? 'y' : 'ies'}`, ...shown];
		if (visibleCount > shown.length) {
			lines.push(`[${visibleCount - shown.length} more entries not shown; listDirectory returns at most ${ONYX_LIST_MAX_ENTRIES}. Use findFiles with a pattern.]`);
		}
		if (hidden > 0) {
			lines.push(`[${hidden} entr${hidden === 1 ? 'y' : 'ies'} left out: ignored, excluded, a symbolic link, or a directory with no visible files]`);
		}
		if (probeTruncated) {
			lines.push('[this directory is too large to check every entry against the ignore rules; some listed entries may be ignored files]');
		}
		return { content: [{ kind: 'text', value: lines.join('\n') }], toolResultDetails: [resolved.uri] };
	}
}

const GLOB_CHARACTERS = /[*?[\]{}]/;

function errorResult(message: string): IToolResult {
	return { content: [{ kind: 'text', value: `Error: ${message}` }], toolResultError: true };
}
