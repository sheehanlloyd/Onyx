/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../../base/common/network.js';
import { URI } from '../../../../../base/common/uri.js';
import { Range } from '../../../../../editor/common/core/range.js';
import { Selection } from '../../../../../editor/common/core/selection.js';
import { CodeAction, CodeActionContext, CodeActionList, CodeActionProvider } from '../../../../../editor/common/languages.js';
import { ITextModel } from '../../../../../editor/common/model.js';
import { ILanguageFeaturesService } from '../../../../../editor/common/services/languageFeatures.js';
import { localize } from '../../../../../nls.js';
import { CommandsRegistry, ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IMarkerService, MarkerSeverity } from '../../../../../platform/markers/common/markers.js';
import { IWorkbenchContribution } from '../../../../common/contributions.js';
import { buildExplainPrompt, buildFixPrompt } from '../../common/onyxQuickActions.js';

/** Internal command the code actions invoke; not in the command palette because it needs arguments. */
const ONYX_ASK_COMMAND_ID = 'onyx.askAboutCode';

/** Lines of context sent around a diagnostic. Enough to see the statement, not the file. */
const CONTEXT_LINES = 12;

interface IAskArgs {
	readonly query: string;
	readonly uri: URI;
	readonly range: { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number };
}

CommandsRegistry.registerCommand(ONYX_ASK_COMMAND_ID, async (accessor, args: IAskArgs) => {
	// Both quick actions land in the ordinary chat surface: the same agent,
	// the same routing, the same control-plane run. Nothing bespoke to review.
	await accessor.get(ICommandService).executeCommand('workbench.action.chat.open', {
		query: args.query,
		attachFiles: [{ uri: URI.revive(args.uri), range: args.range }],
	});
});

/**
 * The two things people want from a model without leaving the editor: make
 * this error go away, and tell me what this does.
 */
export class OnyxCodeActionsContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.onyxCodeActions';

	constructor(
		@ILanguageFeaturesService languageFeaturesService: ILanguageFeaturesService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();
		const provider = instantiationService.createInstance(OnyxCodeActionProvider);
		this._register(languageFeaturesService.codeActionProvider.register('*', provider));
	}
}

export class OnyxCodeActionProvider implements CodeActionProvider {

	readonly displayName = 'Onyx';

	constructor(
		@IMarkerService private readonly _markerService: IMarkerService,
	) { }

	provideCodeActions(model: ITextModel, range: Range | Selection, _context: CodeActionContext, _token: CancellationToken): CodeActionList {
		if (model.uri.scheme !== Schemas.file && model.uri.scheme !== Schemas.untitled && model.uri.scheme !== Schemas.vscodeRemote) {
			return { actions: [], dispose: () => { } };
		}

		const actions: CodeAction[] = [];
		const path = basename(model.uri);

		const markers = this._markerService.read({ resource: model.uri })
			.filter(marker => marker.severity >= MarkerSeverity.Warning && Range.areIntersectingOrTouching(marker, range));
		if (markers.length) {
			const line = markers[0].startLineNumber;
			actions.push({
				title: localize('onyx.codeAction.fix', "Fix with Onyx"),
				kind: 'quickfix',
				diagnostics: [...markers],
				command: {
					id: ONYX_ASK_COMMAND_ID,
					title: localize('onyx.codeAction.fix', "Fix with Onyx"),
					arguments: [{
						query: buildFixPrompt({
							path,
							line,
							diagnostics: markers.map(marker => marker.message),
							snippet: readLines(model, line - CONTEXT_LINES, line + CONTEXT_LINES),
						}),
						uri: model.uri,
						range: rangeAround(model, line),
					} satisfies IAskArgs],
				},
			});
		}

		if (!range.isEmpty()) {
			actions.push({
				title: localize('onyx.codeAction.explain', "Explain with Onyx"),
				kind: 'refactor',
				command: {
					id: ONYX_ASK_COMMAND_ID,
					title: localize('onyx.codeAction.explain', "Explain with Onyx"),
					arguments: [{
						query: buildExplainPrompt({
							path,
							startLine: range.startLineNumber,
							endLine: range.endLineNumber,
							snippet: model.getValueInRange(range),
						}),
						uri: model.uri,
						range: {
							startLineNumber: range.startLineNumber,
							startColumn: range.startColumn,
							endLineNumber: range.endLineNumber,
							endColumn: range.endColumn,
						},
					} satisfies IAskArgs],
				},
			});
		}

		return { actions, dispose: () => { } };
	}
}

function rangeAround(model: ITextModel, line: number): IAskArgs['range'] {
	const start = Math.max(1, line - CONTEXT_LINES);
	const end = Math.min(model.getLineCount(), line + CONTEXT_LINES);
	return { startLineNumber: start, startColumn: 1, endLineNumber: end, endColumn: model.getLineMaxColumn(end) };
}

function readLines(model: ITextModel, fromLine: number, toLine: number): string {
	const start = Math.max(1, fromLine);
	const end = Math.min(model.getLineCount(), toLine);
	return model.getValueInRange(new Range(start, 1, end, model.getLineMaxColumn(end)));
}

function basename(uri: URI): string {
	const segments = uri.path.split('/');
	return segments[segments.length - 1] || uri.path;
}
