/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../../base/common/network.js';
import { localize } from '../../../../../nls.js';
import { IOnyxRuntimeService } from '../../../../../platform/onyxRuntime/common/onyxRuntime.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { ILanguageModelToolsService, IToolData, IToolImpl, IToolInvocation, IToolResult, ToolDataSource } from '../../../chat/common/tools/languageModelToolsService.js';
import { IWorkbenchEnvironmentService } from '../../../../services/environment/common/environmentService.js';
import { qualifyWorkspacePath } from '../../common/onyxWorkspacePaths.js';
import { IOnyxControlPlaneService } from '../controlPlane/onyxControlPlaneService.js';
import { docsPersistPath } from './onyxWorkspaceIndex.js';

export const ONYX_DOCS_TOOL_ID = 'onyx_docs';

const DEFAULT_RESULTS = 4;
const MAX_RESULTS = 8;

/**
 * The `docs` tool: the agent's window into the offline documentation mirror —
 * the workspace's own markdown, dependency READMEs, and the JSDoc inside type
 * declarations, indexed locally with no network involved. When the mirror
 * contributed to an answer, a control-plane note names exactly which
 * documents were used.
 */
export class OnyxDocsToolContribution extends Disposable {

	static readonly ID = 'workbench.contrib.onyxDocsTool';

	constructor(
		@ILanguageModelToolsService toolsService: ILanguageModelToolsService,
		@IOnyxRuntimeService private readonly _runtimeService: IOnyxRuntimeService,
		@IWorkspaceContextService private readonly _workspaceService: IWorkspaceContextService,
		@IWorkbenchEnvironmentService private readonly _environmentService: IWorkbenchEnvironmentService,
		@IOnyxControlPlaneService private readonly _controlPlaneService: IOnyxControlPlaneService,
	) {
		super();

		const toolData: IToolData = {
			id: ONYX_DOCS_TOOL_ID,
			toolReferenceName: 'docs',
			displayName: localize('onyx.docs.displayName', "Search Local Documentation"),
			modelDescription: 'Searches documentation available on this machine: the project\'s markdown files, the READMEs of installed dependencies, and the API docs inside their type declarations. Use for "how do I use library X" and "what does this project\'s docs say about Y" questions. Entirely offline.',
			userDescription: localize('onyx.docs.userDescription', "Search the offline documentation mirror"),
			source: ToolDataSource.Internal,
			canBeReferencedInPrompt: true,
			runsInWorkspace: true,
			inputSchema: {
				type: 'object',
				properties: {
					query: { type: 'string', description: 'What to look up, e.g. "express middleware error handling".' },
					maxResults: { type: 'number', description: `How many documents to return (default ${DEFAULT_RESULTS}, max ${MAX_RESULTS}).` },
				},
				required: ['query'],
			},
		};

		const impl: IToolImpl = {
			prepareToolInvocation: async (context) => ({
				invocationMessage: localize('onyx.docs.invoking', "Searching local docs for \"{0}\"", String((context.parameters as { query?: unknown }).query ?? '')),
			}),
			invoke: (invocation, _countTokens, _progress, token) => this._invoke(invocation, token),
		};

		this._register(toolsService.registerToolData(toolData));
		this._register(toolsService.registerToolImplementation(ONYX_DOCS_TOOL_ID, impl));
	}

	private async _invoke(invocation: IToolInvocation, _token: CancellationToken): Promise<IToolResult> {
		const parameters = invocation.parameters as { query?: unknown; maxResults?: unknown };
		const query = typeof parameters.query === 'string' ? parameters.query.trim() : '';
		if (!query) {
			return { content: [{ kind: 'text', value: 'Error: a non-empty "query" string is required.' }], toolResultError: true };
		}
		const limit = Math.min(typeof parameters.maxResults === 'number' && parameters.maxResults > 0 ? Math.floor(parameters.maxResults) : DEFAULT_RESULTS, MAX_RESULTS);

		const folders = this._workspaceService.getWorkspace().folders.filter(folder => folder.uri.scheme === Schemas.file);
		if (folders.length === 0) {
			return { content: [{ kind: 'text', value: 'No local workspace folder is open, so there is no documentation mirror to search.' }] };
		}
		const folderRefs = folders.map(f => ({ name: f.name, index: f.index }));

		const sections: string[] = [];
		const usedDocs: { path: string; line: number }[] = [];
		for (const folder of folders) {
			const persist = docsPersistPath(this._environmentService, this._workspaceService, folder).fsPath;
			const stats = await this._runtimeService.ensureDocsIndex(folder.uri.fsPath, persist);
			const hits = await this._runtimeService.searchDocsIndex(folder.uri.fsPath, persist, query, limit);
			if (stats.truncated && sections.length === 0) {
				sections.push('(Note: the documentation mirror hit its size cap; coverage is partial.)');
			}
			for (const hit of hits.slice(0, limit)) {
				const qualified = qualifyWorkspacePath(folderRefs, folder.index, hit.path);
				usedDocs.push({ path: qualified, line: hit.line });
				sections.push(`## ${qualified}:${hit.line}\n${hit.snippet}`);
			}
		}

		if (usedDocs.length === 0) {
			return { content: [{ kind: 'text', value: `No local documentation matches "${query}". The mirror covers this workspace's markdown and installed dependencies only.` }] };
		}

		// The control plane says when an answer leaned on docs, and on which.
		const runId = invocation.chatRequestId ? this._controlPlaneService.runs.get().find(run => run.requestId === invocation.chatRequestId)?.runId : undefined;
		if (runId) {
			this._controlPlaneService.appendActivity(runId, {
				kind: 'note',
				label: localize('onyx.docs.used', "Answer used the offline docs mirror"),
				reason: usedDocs.map(doc => doc.path).join(', '),
				location: { path: usedDocs[0].path, line: usedDocs[0].line },
			});
		}

		return { content: [{ kind: 'text', value: `${usedDocs.length} document(s) matching "${query}":\n\n${sections.join('\n\n')}` }] };
	}
}
