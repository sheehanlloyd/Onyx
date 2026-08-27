/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { ILanguageModelToolsService, IToolData, IToolImpl, IToolResult, ToolDataSource } from '../../../chat/common/tools/languageModelToolsService.js';
import { IOnyxMemoryService } from './onyxMemoryService.js';

export const ONYX_MEMORY_TOOL_ID = 'onyx_memory';

/**
 * Lets the agent write to its per-workspace memory. Reading needs no tool —
 * the prompt builder injects the notes into every request — so the tool
 * surface stays minimal for small models: one action, one argument.
 */
export class OnyxMemoryToolContribution extends Disposable {

	static readonly ID = 'workbench.contrib.onyxMemoryTool';

	constructor(
		@ILanguageModelToolsService toolsService: ILanguageModelToolsService,
		@IOnyxMemoryService memoryService: IOnyxMemoryService,
	) {
		super();

		const toolData: IToolData = {
			id: ONYX_MEMORY_TOOL_ID,
			toolReferenceName: 'remember',
			displayName: localize('onyx.memory.displayName', "Remember for This Workspace"),
			modelDescription: 'Saves one short, durable fact about this workspace for future sessions (e.g. "unit tests run with scripts/test.sh", "the API client lives in src/net/"). Existing notes are already shown in your instructions; only save NEW facts that will stay true and useful. One concise sentence per call.',
			userDescription: localize('onyx.memory.userDescription', "Save a note to the agent's workspace memory"),
			source: ToolDataSource.Internal,
			canBeReferencedInPrompt: true,
			runsInWorkspace: true,
			inputSchema: {
				type: 'object',
				properties: {
					note: { type: 'string', description: 'The fact to remember, as one concise sentence.' },
				},
				required: ['note'],
			},
		};

		const impl: IToolImpl = {
			prepareToolInvocation: async (context) => ({
				invocationMessage: localize('onyx.memory.invoking', "Remembering: {0}", String((context.parameters as { note?: unknown }).note ?? '')),
			}),
			invoke: async (invocation): Promise<IToolResult> => {
				const note = (invocation.parameters as { note?: unknown }).note;
				if (typeof note !== 'string' || !note.trim()) {
					return { content: [{ kind: 'text', value: 'Error: a non-empty "note" string is required.' }], toolResultError: true };
				}
				memoryService.addNote(note);
				return { content: [{ kind: 'text', value: `Remembered for this workspace: ${note.trim()}` }] };
			},
		};

		this._register(toolsService.registerToolData(toolData));
		this._register(toolsService.registerToolImplementation(ONYX_MEMORY_TOOL_ID, impl));
	}
}
