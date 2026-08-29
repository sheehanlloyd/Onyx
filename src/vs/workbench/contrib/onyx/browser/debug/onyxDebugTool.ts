/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILabelService } from '../../../../../platform/label/common/label.js';
import { INotificationService, Severity } from '../../../../../platform/notification/common/notification.js';
import { IDebugService, IStackFrame, State } from '../../../debug/common/debug.js';
import { ILanguageModelToolsService, IToolData, IToolImpl, IToolResult, ToolDataSource } from '../../../chat/common/tools/languageModelToolsService.js';
import { buildExplainFailurePrompt, formatDebugSnapshot, IOnyxDebugSnapshot, IOnyxDebugVariable } from '../../common/onyxDebugContext.js';

export const ONYX_DEBUG_TOOL_ID = 'onyx_debugState';

/**
 * The debug-aware assistant: a read-only window onto the paused debugger.
 * The `debugState` tool lets the agent see the stack, frames and variable
 * values exactly as the debug views show them; "Onyx: Explain This Failure"
 * sends the same snapshot through the ordinary chat surface, where the full
 * text is visible before and after sending — nothing reaches the model that
 * the user cannot read in the request itself.
 */
export class OnyxDebugToolContribution extends Disposable {

	static readonly ID = 'workbench.contrib.onyxDebugTool';

	constructor(
		@ILanguageModelToolsService toolsService: ILanguageModelToolsService,
		@IDebugService private readonly _debugService: IDebugService,
		@ILabelService private readonly _labelService: ILabelService,
	) {
		super();

		const toolData: IToolData = {
			id: ONYX_DEBUG_TOOL_ID,
			toolReferenceName: 'debugState',
			displayName: localize('onyx.debug.displayName', "Read Paused Debugger State"),
			modelDescription: 'Reads the currently paused debug session: the call stack with file and line per frame, and the variable values visible in the paused frame. Read-only. Use when the user asks about a crash, an exception, or why execution stopped. Fails when no debug session is paused.',
			userDescription: localize('onyx.debug.userDescription', "Let the agent read the paused debugger (read-only)"),
			source: ToolDataSource.Internal,
			canBeReferencedInPrompt: true,
			runsInWorkspace: true,
			inputSchema: { type: 'object', properties: {} },
		};

		const impl: IToolImpl = {
			prepareToolInvocation: async () => ({
				invocationMessage: localize('onyx.debug.invoking', "Reading the paused debugger state"),
			}),
			invoke: (_invocation, _countTokens, _progress, token) => this._invoke(token),
		};

		this._register(toolsService.registerToolData(toolData));
		this._register(toolsService.registerToolImplementation(ONYX_DEBUG_TOOL_ID, impl));
	}

	private async _invoke(_token: CancellationToken): Promise<IToolResult> {
		const snapshot = await captureDebugSnapshot(this._debugService, this._labelService);
		if (typeof snapshot === 'string') {
			return { content: [{ kind: 'text', value: `Error: ${snapshot}` }], toolResultError: true };
		}
		return { content: [{ kind: 'text', value: formatDebugSnapshot(snapshot) }] };
	}
}

/** The paused state as pure data, or a sentence explaining why there is none. */
export async function captureDebugSnapshot(debugService: IDebugService, labelService: ILabelService): Promise<IOnyxDebugSnapshot | string> {
	if (debugService.state !== State.Stopped) {
		return debugService.state === State.Inactive
			? 'No debug session is running. Start one and pause (or hit a breakpoint) first.'
			: 'The debug session is running, not paused — the stack is only readable while stopped.';
	}
	const viewModel = debugService.getViewModel();
	const frame = viewModel.focusedStackFrame;
	const thread = viewModel.focusedThread ?? frame?.thread;
	const session = viewModel.focusedSession ?? thread?.session;
	if (!frame || !thread || !session) {
		return 'The debugger is stopped but no stack frame is focused. Focus a frame in the Call Stack view.';
	}

	const frames = thread.getCallStack().map((stackFrame: IStackFrame) => ({
		name: stackFrame.name,
		path: labelService.getUriLabel(stackFrame.source.uri, { relative: true }),
		line: stackFrame.range.startLineNumber,
	}));

	const variables: IOnyxDebugVariable[] = [];
	try {
		for (const scope of await frame.getScopes()) {
			if (scope.expensive) {
				continue; // expensive scopes (e.g. Globals) can stall the adapter
			}
			for (const child of await scope.getChildren()) {
				variables.push({ scope: scope.name, name: child.name, value: child.value ?? '' });
			}
		}
	} catch {
		// A misbehaving adapter still leaves the stack usable.
	}

	return {
		sessionName: session.name,
		threadName: thread.name,
		stoppedReason: thread.stoppedDetails?.reason,
		frames,
		variables,
	};
}

registerAction2(class ExplainFailureAction extends Action2 {
	constructor() {
		super({
			id: 'onyx.explainFailure',
			title: localize2('onyx.explainFailure', "Onyx: Explain This Failure"),
			f1: true,
			menu: [
				{ id: MenuId.DebugCallStackContext, group: 'z_onyx', order: 10 },
			],
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const debugService = accessor.get(IDebugService);
		const labelService = accessor.get(ILabelService);
		const commandService = accessor.get(ICommandService);
		const notificationService = accessor.get(INotificationService);

		const snapshot = await captureDebugSnapshot(debugService, labelService);
		if (typeof snapshot === 'string') {
			notificationService.notify({ severity: Severity.Info, message: snapshot });
			return;
		}
		// The full prompt lands in the chat input where the user can read (and
		// edit) exactly what will be sent — that is the no-silent-redaction rule.
		await commandService.executeCommand('workbench.action.chat.open', {
			query: buildExplainFailurePrompt(snapshot),
		});
	}
});
