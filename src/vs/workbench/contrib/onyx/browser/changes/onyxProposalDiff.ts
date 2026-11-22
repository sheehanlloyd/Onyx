/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Emitter } from '../../../../../base/common/event.js';
import { Disposable, DisposableMap } from '../../../../../base/common/lifecycle.js';
import { autorun } from '../../../../../base/common/observable.js';
import { URI } from '../../../../../base/common/uri.js';
import { isCodeEditor, isDiffEditor } from '../../../../../editor/browser/editorBrowser.js';
import { Range } from '../../../../../editor/common/core/range.js';
import { CodeLens, CodeLensList, CodeLensProvider } from '../../../../../editor/common/languages.js';
import { ILanguageService } from '../../../../../editor/common/languages/language.js';
import { EndOfLinePreference, ITextModel } from '../../../../../editor/common/model.js';
import { ILanguageFeaturesService } from '../../../../../editor/common/services/languageFeatures.js';
import { IModelService } from '../../../../../editor/common/services/model.js';
import { ITextModelContentProvider, ITextModelService } from '../../../../../editor/common/services/resolverService.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { INotificationService, Severity } from '../../../../../platform/notification/common/notification.js';
import { IWorkbenchContribution } from '../../../../common/contributions.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { hunkAtProposedLine, ONYX_PROPOSAL_SCHEME, proposedHunkRanges } from '../../common/onyxChangeSet.js';
import { IOnyxChangeSetService, IOnyxStagedFile } from './onyxChangeSetService.js';

/** The address of the read-only document that shows a file as its proposal would leave it. */
export function onyxProposalUri(path: string): URI {
	return URI.from({ scheme: ONYX_PROPOSAL_SCHEME, path: `/${path}` });
}

/** The change-set path a proposal document is of. */
export function onyxProposalPath(uri: URI): string | undefined {
	return uri.scheme === ONYX_PROPOSAL_SCHEME ? uri.path.replace(/^\//, '') : undefined;
}

const ACCEPT_HUNK_COMMAND = 'onyx.changes.acceptHunk';
const REJECT_HUNK_COMMAND = 'onyx.changes.rejectHunk';

/**
 * The proposal as a document (C1, R-25). `onyx-proposal:/<path>` is the
 * file as the staged proposal would leave it: a text model that is not the
 * file's, that no editor can write to, and that follows the change set as
 * hunks are kept, rejected or carried onto a changed buffer. A diff editor
 * puts the live file on the left and this document on the right; nothing
 * about the live file changes by looking.
 *
 * Each hunk carries two code lenses in the proposal document, which name it
 * by the id it has in the change set (B7), so what is accepted from the
 * editor is what the side bar would accept.
 */
export class OnyxProposalDocuments extends Disposable implements IWorkbenchContribution, ITextModelContentProvider, CodeLensProvider {

	static readonly ID = 'workbench.contrib.onyxProposalDocuments';

	private readonly _models = this._register(new DisposableMap<string, ITextModel>());
	private readonly _onDidChangeLenses = this._register(new Emitter<this>());
	readonly onDidChange = this._onDidChangeLenses.event;

	constructor(
		@ITextModelService textModelService: ITextModelService,
		@ILanguageFeaturesService languageFeaturesService: ILanguageFeaturesService,
		@IModelService private readonly _modelService: IModelService,
		@ILanguageService private readonly _languageService: ILanguageService,
		@IOnyxChangeSetService private readonly _changeSetService: IOnyxChangeSetService,
	) {
		super();
		this._register(textModelService.registerTextModelContentProvider(ONYX_PROPOSAL_SCHEME, this));
		this._register(languageFeaturesService.codeLensProvider.register({ scheme: ONYX_PROPOSAL_SCHEME }, this));
		// The documents follow the change set: a hunk kept or rejected, a rebase, a new generation.
		this._register(autorun(reader => {
			const files = this._changeSetService.files.read(reader);
			for (const [path, model] of this._models) {
				if (model.isDisposed()) {
					this._models.deleteAndLeak(path);
					continue;
				}
				const content = this._contentFor(path, files);
				if (model.getValue() !== content) {
					model.setValue(content);
				}
			}
			this._onDidChangeLenses.fire(this);
		}));
	}

	/**
	 * What the document for a path holds: the proposal while one is staged.
	 * Once none is (every hunk kept, or all rejected) it holds the file as
	 * it is, so that the diff shows no difference instead of a proposal
	 * that is no longer there.
	 */
	private _contentFor(path: string, files: readonly IOnyxStagedFile[]): string {
		const staged = files.find(file => file.proposal.path === path);
		if (staged) {
			return staged.proposal.proposed;
		}
		const file = this._changeSetService.fileUri(path);
		return (file ? this._modelService.getModel(file)?.getValue(EndOfLinePreference.LF) : undefined) ?? '';
	}

	async provideTextContent(resource: URI): Promise<ITextModel | null> {
		const path = onyxProposalPath(resource);
		if (path === undefined) {
			return null;
		}
		const existing = this._modelService.getModel(resource);
		if (existing) {
			return existing;
		}
		const model = this._modelService.createModel(this._contentFor(path, this._changeSetService.files.get()), this._languageService.createByFilepathOrFirstLine(resource), resource);
		this._models.set(path, model);
		return model;
	}

	provideCodeLenses(model: ITextModel, _token: CancellationToken): CodeLensList {
		const path = onyxProposalPath(model.uri);
		const staged = path === undefined ? undefined : this._changeSetService.files.get().find(file => file.proposal.path === path);
		if (!staged || path === undefined) {
			return { lenses: [] };
		}
		const lenses: CodeLens[] = [];
		const lastLine = model.getLineCount();
		for (const range of proposedHunkRanges(staged.hunks)) {
			const line = Math.min(Math.max(1, range.startLine), lastLine);
			const at = new Range(line, 1, line, 1);
			lenses.push({ range: at, command: { id: ACCEPT_HUNK_COMMAND, title: localize('onyx.proposal.lens.accept', "Accept Hunk"), arguments: [path, range.id] } });
			lenses.push({ range: at, command: { id: REJECT_HUNK_COMMAND, title: localize('onyx.proposal.lens.reject', "Reject Hunk"), arguments: [path, range.id] } });
		}
		if (staged.conflicts.length > 0) {
			lenses.unshift({ range: new Range(1, 1, 1, 1), command: { id: '', title: localize('onyx.proposal.lens.conflicts', "{0} conflict(s): not applied; see Onyx Changes", staged.conflicts.length) } });
		}
		return { lenses };
	}
}

/** The proposal document under the caret of the active editor, when the active editor shows one: its path, and the line the caret is on. */
function activeProposal(accessor: ServicesAccessor): { readonly path: string; readonly line: number } | undefined {
	const control = accessor.get(IEditorService).activeTextEditorControl;
	const editor = isDiffEditor(control) ? control.getModifiedEditor() : control;
	if (!isCodeEditor(editor)) {
		return undefined;
	}
	const uri = editor.getModel()?.uri;
	const path = uri ? onyxProposalPath(uri) : undefined;
	const position = editor.getPosition();
	return path !== undefined && position ? { path, line: position.lineNumber } : undefined;
}

async function actOnHunkAtCursor(accessor: ServicesAccessor, act: (changeSet: IOnyxChangeSetService, path: string, hunkId: string) => Promise<void>): Promise<void> {
	const changeSetService = accessor.get(IOnyxChangeSetService);
	const notificationService = accessor.get(INotificationService);
	const active = activeProposal(accessor);
	if (!active) {
		notificationService.notify({ severity: Severity.Info, message: localize('onyx.proposal.notActive', "Open a proposal's diff from Onyx Changes and put the caret on a changed line first.") });
		return;
	}
	const staged = changeSetService.files.get().find(file => file.proposal.path === active.path);
	const hunk = staged ? hunkAtProposedLine(staged.hunks, active.line) : undefined;
	if (!hunk) {
		// Nothing is accepted or rejected by being near it.
		notificationService.notify({ severity: Severity.Info, message: localize('onyx.proposal.noHunkHere', "The caret is not on a proposed change. Put it on a changed line, or use the lenses above each hunk.") });
		return;
	}
	await act(changeSetService, active.path, hunk.id);
}

registerAction2(class AcceptOnyxHunkAction extends Action2 {
	constructor() {
		super({ id: ACCEPT_HUNK_COMMAND, title: localize2('onyx.changes.acceptHunkCommand', "Onyx: Accept Proposed Hunk"), f1: false });
	}
	async run(accessor: ServicesAccessor, path: string, hunkId: string): Promise<void> {
		await accessor.get(IOnyxChangeSetService).acceptHunk(path, hunkId);
	}
});

registerAction2(class RejectOnyxHunkAction extends Action2 {
	constructor() {
		super({ id: REJECT_HUNK_COMMAND, title: localize2('onyx.changes.rejectHunkCommand', "Onyx: Reject Proposed Hunk"), f1: false });
	}
	async run(accessor: ServicesAccessor, path: string, hunkId: string): Promise<void> {
		accessor.get(IOnyxChangeSetService).rejectHunk(path, hunkId);
	}
});

registerAction2(class AcceptOnyxHunkAtCursorAction extends Action2 {
	constructor() {
		super({ id: 'onyx.changes.acceptHunkAtCursor', title: localize2('onyx.changes.acceptHunkAtCursor', "Onyx: Accept Hunk at Cursor"), f1: true });
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		await actOnHunkAtCursor(accessor, async (changeSet, path, hunkId) => { await changeSet.acceptHunk(path, hunkId); });
	}
});

registerAction2(class RejectOnyxHunkAtCursorAction extends Action2 {
	constructor() {
		super({ id: 'onyx.changes.rejectHunkAtCursor', title: localize2('onyx.changes.rejectHunkAtCursor', "Onyx: Reject Hunk at Cursor"), f1: true });
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		await actOnHunkAtCursor(accessor, async (changeSet, path, hunkId) => changeSet.rejectHunk(path, hunkId));
	}
});
