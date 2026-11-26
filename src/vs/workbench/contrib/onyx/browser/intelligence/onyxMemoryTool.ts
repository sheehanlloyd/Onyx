/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import Severity from '../../../../../base/common/severity.js';
import { localize } from '../../../../../nls.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { ILanguageModelToolsService, IToolData, IToolImpl, IToolInvocation, IToolResult, ToolDataSource } from '../../../chat/common/tools/languageModelToolsService.js';
import { OnyxNoteOrigin } from '../../common/onyxMemoryOrigin.js';
import { IOnyxHarnessConfigService } from '../agent/onyxHarnessConfigService.js';
import { IOnyxControlPlaneService } from '../controlPlane/onyxControlPlaneService.js';
import { closableBy } from '../terminal/onyxTerminalTool.js';
import { IOnyxMemoryService } from './onyxMemoryService.js';

export const ONYX_MEMORY_TOOL_ID = 'onyx_memory';

/**
 * Lets the agent ask to write to its per-workspace memory. Reading needs no
 * tool: the prompt builder injects the notes into every later request, which
 * is exactly why a write is not the model's to make (I-14). A note is stored
 * only after the user confirms a dialog that shows the note and where its
 * text came from: their own request, something a tool returned in this run,
 * or the model. Declined, the call returns an error result and nothing is
 * stored.
 */
export class OnyxMemoryToolContribution extends Disposable {

	static readonly ID = 'workbench.contrib.onyxMemoryTool';

	constructor(
		@ILanguageModelToolsService toolsService: ILanguageModelToolsService,
		@IOnyxMemoryService private readonly _memoryService: IOnyxMemoryService,
		@IDialogService private readonly _dialogService: IDialogService,
		@IOnyxControlPlaneService private readonly _controlPlaneService: IOnyxControlPlaneService,
		@IOnyxHarnessConfigService private readonly _harnessConfigService: IOnyxHarnessConfigService,
	) {
		super();

		const toolData: IToolData = {
			id: ONYX_MEMORY_TOOL_ID,
			toolReferenceName: 'remember',
			displayName: localize('onyx.memory.displayName', "Remember for This Workspace"),
			modelDescription: 'Asks the user to save one short, durable fact about this workspace for future sessions (e.g. "unit tests run with scripts/test.sh", "the API client lives in src/net/"). The user sees the note and decides; a declined note must not be retried. Existing notes are already shown in your instructions; only propose NEW facts that will stay true and useful. One concise sentence per call.',
			userDescription: localize('onyx.memory.userDescription', "Propose a note for the agent's workspace memory; you confirm each one"),
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
				invocationMessage: localize('onyx.memory.invoking', "Proposing a note to remember: {0}", String((context.parameters as { note?: unknown }).note ?? '')),
			}),
			invoke: (invocation, _countTokens, _progress, token) => this._invoke(invocation, token),
		};

		this._register(toolsService.registerToolData(toolData));
		this._register(toolsService.registerToolImplementation(ONYX_MEMORY_TOOL_ID, impl));
	}

	private async _invoke(invocation: IToolInvocation, token: CancellationToken): Promise<IToolResult> {
		const note = (invocation.parameters as { note?: unknown }).note;
		if (typeof note !== 'string' || !note.trim()) {
			return { content: [{ kind: 'text', value: 'Error: a non-empty "note" string is required.' }], toolResultError: true };
		}
		const text = note.trim();
		const runId = this._controlPlaneService.runs.get().find(run => run.requestId === invocation.chatRequestId)?.runId;
		const origin: OnyxNoteOrigin = runId ? this._controlPlaneService.originOf(runId, text) : { kind: 'model' };
		// In a campaign nobody is there to be asked (L9): the note is declined without a dialog, as a person saying no would.
		const confirmed = !this._harnessConfigService.campaignPolicy && await this._confirm(text, origin, token);
		if (token.isCancellationRequested) {
			// Stop while the dialog was open (B10, I-05): Stop closed it, and nothing is remembered whatever it said.
			return { content: [{ kind: 'text', value: 'The run was stopped by the user while the note was being confirmed. Nothing was remembered.' }], toolResultError: true };
		}
		if (!confirmed) {
			return { content: [{ kind: 'text', value: 'Error: the user declined to store this note. Nothing was remembered; do not ask again.' }], toolResultError: true };
		}
		this._memoryService.addNote(text);
		return { content: [{ kind: 'text', value: `Remembered for this workspace: ${text}` }] };
	}

	/**
	 * The only way a note reaches the memory: the user presses Remember on a
	 * dialog that shows the note and where its text came from.
	 */
	protected async _confirm(text: string, origin: OnyxNoteOrigin, token: CancellationToken = CancellationToken.None): Promise<boolean> {
		const confirmation = await this._dialogService.prompt<boolean>({
			type: origin.kind === 'tool-result' || (origin.kind === 'context' && origin.source === 'playbooks') ? Severity.Warning : Severity.Info,
			message: localize('onyx.memory.confirm', "The agent wants to remember a note for this workspace"),
			detail: [
				text,
				'',
				originLine(origin),
				localize('onyx.memory.confirm.effect', "A remembered note is added to every later prompt in this workspace until you clear the agent memory."),
			].join('\n'),
			buttons: [{ label: localize('onyx.memory.confirm.remember', "Remember"), run: () => true }],
			cancelButton: { label: localize('onyx.memory.confirm.decline', "Don't Remember"), run: () => false },
			...closableBy(token),
		});
		return confirmation.result === true && !token.isCancellationRequested;
	}
}

/** The line of the confirmation that says where the note's text came from. */
function originLine(origin: OnyxNoteOrigin): string {
	switch (origin.kind) {
		case 'user':
			return localize('onyx.memory.origin.user', "Where this text came from: your own request.");
		case 'tool-result':
			return localize('onyx.memory.origin.toolResult', "Where this text came from: the output of the {0} tool in this run. Text from a file or a command can carry instructions.", origin.tool);
		case 'context':
			return origin.source === 'memory'
				? localize('onyx.memory.origin.memory', "Where this text came from: a note remembered in an earlier session, which this run's prompt carries.")
				: localize('onyx.memory.origin.playbooks', "Where this text came from: the repository's playbook index, which this run's prompt carries. Text from the repository can carry instructions.");
		case 'model':
			return localize('onyx.memory.origin.model', "Where this text came from: the model wrote it; it is not in your request or in anything a tool returned in this run.");
	}
}
