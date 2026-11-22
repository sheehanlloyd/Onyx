/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { ILanguageModelToolsService, IToolData, IToolImpl, IToolInvocation, IToolResult, ToolDataSource } from '../../../chat/common/tools/languageModelToolsService.js';
import { IOnyxControlPlaneService } from '../controlPlane/onyxControlPlaneService.js';
import { ONYX_EDIT_CALL_MAX_EDITS, readEditArguments } from '../../common/onyxChangeSet.js';
import { IOnyxChangeSetService } from './onyxChangeSetService.js';

export const ONYX_EDIT_TOOL_ID = 'onyx_editFile';

/**
 * The agent's write path — and deliberately its only one. Edits arrive as
 * SEARCH/REPLACE pairs (the format small local models handle far better than
 * unified diffs) and are STAGED into the Onyx Changes review surface, never
 * written into the buffer. The tool's reply tells the model its edit is
 * pending human review, so the loop does not retry or double-apply.
 */
export class OnyxEditToolContribution extends Disposable {

	static readonly ID = 'workbench.contrib.onyxEditTool';

	constructor(
		@ILanguageModelToolsService toolsService: ILanguageModelToolsService,
		@IOnyxChangeSetService private readonly _changeSetService: IOnyxChangeSetService,
		@IOnyxControlPlaneService private readonly _controlPlaneService: IOnyxControlPlaneService,
	) {
		super();

		const toolData: IToolData = {
			id: ONYX_EDIT_TOOL_ID,
			toolReferenceName: 'editFile',
			displayName: localize('onyx.editTool.displayName', "Propose File Edits"),
			modelDescription: 'Proposes an edit to a workspace file. Pass the file path, the exact lines to change as "search" (copied character-for-character from the file), and the new lines as "replace". To create a new file, pass an empty "search" and the full content as "replace". Edits are staged for the user to review and accept — they are not applied immediately. To make several changes to one file in one call, pass "edits": a list of {"search", "replace"} pairs instead of "search" and "replace"; they are staged together or, if any one cannot be placed, not at all. You may also call this tool several times, for one file or several.',
			userDescription: localize('onyx.editTool.userDescription', "Stage file edits for review in Onyx Changes"),
			source: ToolDataSource.Internal,
			canBeReferencedInPrompt: true,
			runsInWorkspace: true,
			inputSchema: {
				type: 'object',
				properties: {
					path: { type: 'string', description: 'Workspace-relative path of the file, e.g. "src/app.ts".' },
					search: { type: 'string', description: 'The exact existing lines to replace. Empty when creating a new file.' },
					replace: { type: 'string', description: 'The lines to put in their place, or the full content of a new file.' },
					edits: {
						type: 'array',
						description: 'Several edits to this one file, instead of "search" and "replace". Each is placed exactly like a single edit, in order.',
						maxItems: ONYX_EDIT_CALL_MAX_EDITS,
						items: {
							type: 'object',
							properties: {
								search: { type: 'string', description: 'The exact existing lines to replace.' },
								replace: { type: 'string', description: 'The lines to put in their place.' },
							},
							required: ['search', 'replace'],
						},
					},
				},
				required: ['path'],
			},
		};

		const impl: IToolImpl = {
			prepareToolInvocation: async (context) => ({
				invocationMessage: localize('onyx.editTool.invoking', "Staging an edit to {0}", String((context.parameters as { path?: unknown }).path ?? '')),
			}),
			invoke: (invocation, _countTokens, _progress, token) => this._invoke(invocation, token),
		};

		this._register(toolsService.registerToolData(toolData));
		this._register(toolsService.registerToolImplementation(ONYX_EDIT_TOOL_ID, impl));
	}

	private async _invoke(invocation: IToolInvocation, token: CancellationToken): Promise<IToolResult> {
		if (token.isCancellationRequested) {
			// Stopped (B10, I-05): nothing more is staged for a run the user has stopped.
			return { content: [{ kind: 'text', value: 'Error: the run was stopped by the user. Nothing was staged.' }], toolResultError: true };
		}
		const parsed = readEditArguments(invocation.parameters);
		if (!parsed.ok) {
			return { content: [{ kind: 'text', value: `Error: ${parsed.error}` }], toolResultError: true };
		}
		const { path, blocks } = parsed;
		const runId = this._controlPlaneService.runs.get().find(run => run.requestId === invocation.chatRequestId)?.runId;
		const outcome = await this._changeSetService.stage(path, blocks, runId, { call: invocation.callId });
		if (!outcome.ok) {
			return { content: [{ kind: 'text', value: `Error: ${outcome.error}` }], toolResultError: true };
		}
		return { content: [{ kind: 'text', value: outcome.summary }] };
	}
}
