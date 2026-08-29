/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { HierarchicalKind } from '../../../../../base/common/hierarchicalKind.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../../base/common/network.js';
import { URI } from '../../../../../base/common/uri.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { Progress } from '../../../../../platform/progress/common/progress.js';
import { ICodeEditor, isCodeEditor } from '../../../../../editor/browser/editorBrowser.js';
import { Position } from '../../../../../editor/common/core/position.js';
import { Range } from '../../../../../editor/common/core/range.js';
import { Selection } from '../../../../../editor/common/core/selection.js';
import { ITextModel } from '../../../../../editor/common/model.js';
import { CodeActionProvider, CodeActionTriggerType, IWorkspaceTextEdit, WorkspaceEdit } from '../../../../../editor/common/languages.js';
import { ILanguageFeaturesService } from '../../../../../editor/common/services/languageFeatures.js';
import { ITextModelService } from '../../../../../editor/common/services/resolverService.js';
import { getCodeActions } from '../../../../../editor/contrib/codeAction/browser/codeAction.js';
import { CodeActionKind } from '../../../../../editor/contrib/codeAction/common/types.js';
import { rename } from '../../../../../editor/contrib/rename/browser/rename.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { IInstantiationService, ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { IMarkerService, MarkerSeverity } from '../../../../../platform/markers/common/markers.js';
import { INotificationService, Severity } from '../../../../../platform/notification/common/notification.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { applyTextEdits, buildNameSuggestionPrompt, IOnyxTextEdit, parseNameSuggestions, renamePlaceholder } from '../../common/onyxRefactor.js';
import { qualifyWorkspacePath } from '../../common/onyxWorkspacePaths.js';
import { runOneShot } from '../agent/onyxOneShot.js';
import { IOnyxChangeSetService } from '../changes/onyxChangeSetService.js';
import { IOnyxControlPlaneService } from '../controlPlane/onyxControlPlaneService.js';
import { IOnyxModelService } from '../model/onyxLanguageModelProvider.js';

const SNIPPET_LINES = 24;
const NAME_SUGGESTION_CAP = 3;
/** Placeholders TS extraction inserts; renamed in the staged text before review. */
const EXTRACTION_PLACEHOLDERS = ['newFunction', 'newMethod', 'newLocal'];

/**
 * The multi-file refactor engine. The language services do every mechanical
 * edit — rename sites, extraction — because they are correct across files;
 * the local model only proposes names. Every resulting edit is STAGED into
 * Onyx Changes for per-file, per-hunk review, and after the user accepts, a
 * verification pass compares the workspace's error markers against the
 * pre-refactor baseline and says what changed.
 */
export class OnyxRefactorEngine {

	constructor(
		@ILanguageFeaturesService private readonly _languageFeaturesService: ILanguageFeaturesService,
		@ITextModelService private readonly _textModelService: ITextModelService,
		@IOnyxModelService private readonly _modelService: IOnyxModelService,
		@IOnyxChangeSetService private readonly _changeSetService: IOnyxChangeSetService,
		@IOnyxControlPlaneService private readonly _controlPlaneService: IOnyxControlPlaneService,
		@IWorkspaceContextService private readonly _workspaceService: IWorkspaceContextService,
		@IEditorService private readonly _editorService: IEditorService,
		@IQuickInputService private readonly _quickInputService: IQuickInputService,
		@INotificationService private readonly _notificationService: INotificationService,
		@IMarkerService private readonly _markerService: IMarkerService,
	) { }

	async renameSymbol(): Promise<void> {
		const context = this._activeEditorContext();
		if (!context) {
			return;
		}
		const { model, position } = context;
		const word = model.getWordAtPosition(position);
		if (!word) {
			this._notificationService.notify({ severity: Severity.Info, message: localize('onyx.refactor.noSymbol', "Put the cursor on the symbol to rename.") });
			return;
		}
		if (this._languageFeaturesService.renameProvider.all(model).length === 0) {
			this._notificationService.notify({ severity: Severity.Info, message: localize('onyx.refactor.noRename', "No rename support for this language — the language service does the mechanical work here.") });
			return;
		}

		const newName = await this._pickName('rename', word.word, model, position.lineNumber);
		if (!newName) {
			return;
		}

		const cancellation = new CancellationTokenSource();
		try {
			const edit = await rename(this._languageFeaturesService.renameProvider, model, position, newName);
			if (edit.rejectReason) {
				this._notificationService.notify({ severity: Severity.Warning, message: localize('onyx.refactor.renameRejected', "The language service rejected the rename: {0}", edit.rejectReason) });
				return;
			}
			await this._stageWorkspaceEdit(edit, localize('onyx.refactor.renameTitle', "Rename {0} → {1}", word.word, newName), undefined);
		} finally {
			cancellation.dispose();
		}
	}

	async extractFunction(): Promise<void> {
		const context = this._activeEditorContext();
		if (!context || !context.selection || context.selection.isEmpty()) {
			this._notificationService.notify({ severity: Severity.Info, message: localize('onyx.refactor.noSelection', "Select the code to extract first.") });
			return;
		}
		await this._applyCodeActionRefactor(context.model, context.selection, CodeActionKind.RefactorExtract.value, 'extract', localize('onyx.refactor.extractTitle', "Extract function"));
	}

	async moveSymbol(): Promise<void> {
		const context = this._activeEditorContext();
		if (!context) {
			return;
		}
		const selection = context.selection && !context.selection.isEmpty()
			? context.selection
			: this._wordSelection(context.model, context.position);
		if (!selection) {
			this._notificationService.notify({ severity: Severity.Info, message: localize('onyx.refactor.noSymbol', "Put the cursor on the symbol to rename.") });
			return;
		}
		await this._applyCodeActionRefactor(context.model, selection, CodeActionKind.RefactorMove.value, undefined, localize('onyx.refactor.moveTitle', "Move symbol"));
	}

	private async _applyCodeActionRefactor(model: ITextModel, selection: Selection, kind: string, nameWith: 'extract' | undefined, title: string): Promise<void> {
		const cancellation = new CancellationTokenSource();
		try {
			const actions = await getCodeActions(
				this._languageFeaturesService.codeActionProvider,
				model,
				selection,
				{ type: CodeActionTriggerType.Invoke, triggerAction: undefined!, filter: { include: new HierarchicalKind(kind) } },
				Progress.None as Progress<CodeActionProvider>,
				cancellation.token,
			);
			try {
				const usable = actions.validActions.filter(item => !item.action.disabled);
				if (usable.length === 0) {
					this._notificationService.notify({ severity: Severity.Info, message: localize('onyx.refactor.noActions', "The language service offers no \"{0}\" refactoring here.", kind) });
					return;
				}
				const picked = usable.length === 1 ? usable[0] : await this._quickInputService.pick(usable.map(item => ({ label: item.action.title, item })), { placeHolder: localize('onyx.refactor.pickAction', "Which refactoring?") }).then(chosen => chosen?.item);
				if (!picked) {
					return;
				}
				await picked.resolve(cancellation.token);
				const edit = picked.action.edit;
				if (!edit || edit.edits.length === 0) {
					this._notificationService.notify({ severity: Severity.Warning, message: localize('onyx.refactor.noEdit', "The language service returned no edit for \"{0}\".", picked.action.title) });
					return;
				}
				let chosenName: string | undefined;
				if (nameWith === 'extract') {
					chosenName = await this._pickName('extract', 'newFunction', model, selection.startLineNumber);
					if (!chosenName) {
						return;
					}
				}
				await this._stageWorkspaceEdit(edit, title, chosenName);
			} finally {
				actions.dispose();
			}
		} finally {
			cancellation.dispose();
		}
	}

	/** Names come from the model (or the user); edits never do. */
	private async _pickName(kind: 'rename' | 'extract', currentName: string, model: ITextModel, aroundLine: number): Promise<string | undefined> {
		const startLine = Math.max(1, aroundLine - SNIPPET_LINES / 2);
		const snippet = model.getValueInRange(new Range(startLine, 1, Math.min(model.getLineCount(), startLine + SNIPPET_LINES), 1));

		const handle = this._controlPlaneService.beginRun({
			sessionResource: URI.from({ scheme: 'onyx-refactor', path: `/${generateUuid()}` }),
			requestId: generateUuid(),
			title: kind === 'rename'
				? localize('onyx.refactor.nameRun', "Name suggestions for {0}", currentName)
				: localize('onyx.refactor.extractRun', "Name for extracted function"),
			task: 'quick-edit',
			modelKey: 'auto',
		});
		const cancellation = new CancellationTokenSource();
		let suggestions: { name: string; reason: string }[] = [];
		try {
			const reply = await runOneShot(
				this._modelService,
				'You suggest identifier names. Follow the reply format exactly.',
				buildNameSuggestionPrompt(kind, currentName, model.getLanguageId(), snippet),
				cancellation.token,
				{ run: handle, controlPlane: this._controlPlaneService },
			);
			suggestions = parseNameSuggestions(reply, currentName, NAME_SUGGESTION_CAP);
			handle.complete('completed');
		} catch {
			handle.complete('failed');
			// No model (or it failed): naming falls back to the user, honestly.
		} finally {
			cancellation.dispose();
		}

		const custom = { label: localize('onyx.refactor.customName', "Type a name…"), description: '' };
		const picked = await this._quickInputService.pick([
			...suggestions.map(suggestion => ({ label: suggestion.name, description: suggestion.reason })),
			custom,
		], { placeHolder: suggestions.length ? localize('onyx.refactor.pickName', "Pick a name (suggested by the local model)") : localize('onyx.refactor.pickNameNoModel', "No model suggestions available — type a name") });
		if (!picked) {
			return undefined;
		}
		if (picked === custom || picked.label === custom.label) {
			const typed = await this._quickInputService.input({ prompt: localize('onyx.refactor.typeName', "New name"), value: currentName });
			return typed?.trim() || undefined;
		}
		return picked.label;
	}

	/** Converts a language-service WorkspaceEdit into staged, reviewable proposals. */
	private async _stageWorkspaceEdit(edit: WorkspaceEdit, title: string, renameExtractionTo: string | undefined): Promise<void> {
		const folders = this._workspaceService.getWorkspace().folders.map(f => ({ name: f.name, index: f.index }));
		const byResource = new Map<string, { uri: URI; edits: IOnyxTextEdit[] }>();
		for (const entry of edit.edits) {
			const textEdit = entry as IWorkspaceTextEdit;
			if (!textEdit.resource || !textEdit.textEdit) {
				this._notificationService.notify({ severity: Severity.Warning, message: localize('onyx.refactor.unsupportedEdit', "This refactoring includes a file create/rename/delete, which the review surface does not stage yet — run it via the editor's own refactor command instead.") });
				return;
			}
			const key = textEdit.resource.toString();
			const group = byResource.get(key) ?? { uri: textEdit.resource, edits: [] };
			group.edits.push({
				startLineNumber: textEdit.textEdit.range.startLineNumber,
				startColumn: textEdit.textEdit.range.startColumn,
				endLineNumber: textEdit.textEdit.range.endLineNumber,
				endColumn: textEdit.textEdit.range.endColumn,
				text: textEdit.textEdit.text,
			});
			byResource.set(key, group);
		}

		const baseline = this._markerService.read({ severities: MarkerSeverity.Error }).length;
		const stagedPaths: string[] = [];
		for (const group of byResource.values()) {
			const folder = this._workspaceService.getWorkspaceFolder(group.uri);
			if (!folder || group.uri.scheme !== Schemas.file) {
				continue;
			}
			const reference = await this._textModelService.createModelReference(group.uri);
			try {
				const content = reference.object.textEditorModel.getValue();
				const applied = applyTextEdits(content, group.edits);
				if (applied.kind === 'error') {
					this._notificationService.notify({ severity: Severity.Error, message: localize('onyx.refactor.badEdit', "Refactoring aborted: {0}. No file was changed.", applied.error) });
					return;
				}
				let proposed = applied.content;
				if (renameExtractionTo) {
					for (const placeholder of EXTRACTION_PLACEHOLDERS) {
						proposed = renamePlaceholder(proposed, placeholder, renameExtractionTo);
					}
				}
				const relative = group.uri.path.slice(folder.uri.path.length + 1);
				const qualified = qualifyWorkspacePath(folders, folder.index, relative);
				await this._changeSetService.stageProposal(qualified, proposed);
				stagedPaths.push(qualified);
			} finally {
				reference.dispose();
			}
		}
		if (stagedPaths.length === 0) {
			this._notificationService.notify({ severity: Severity.Info, message: localize('onyx.refactor.nothingStaged', "The refactoring produced no stageable change.") });
			return;
		}

		// The verification pass: once every staged file has been applied (or the
		// listener times out), compare error markers against the baseline.
		this._watchForVerification(new Set(stagedPaths), baseline, title);
		this._notificationService.notify({
			severity: Severity.Info,
			message: localize('onyx.refactor.staged', "{0}: {1} file(s) staged in Onyx Changes — review and accept there.", title, stagedPaths.length),
		});
	}

	private _watchForVerification(paths: Set<string>, baselineErrors: number, title: string): void {
		const store = new DisposableStore();
		const timeout = setTimeout(() => store.dispose(), 10 * 60_000);
		store.add({ dispose: () => clearTimeout(timeout) });
		store.add(this._changeSetService.onDidApply(({ path }) => {
			paths.delete(path);
			if (paths.size > 0) {
				return;
			}
			// Give the language services a beat to re-check, then report honestly.
			setTimeout(() => {
				const errors = this._markerService.read({ severities: MarkerSeverity.Error }).length;
				const delta = errors - baselineErrors;
				this._notificationService.notify({
					severity: delta > 0 ? Severity.Warning : Severity.Info,
					message: delta > 0
						? localize('onyx.refactor.verifyBad', "{0} applied — {1} new error(s) appeared. Check the Problems panel.", title, delta)
						: localize('onyx.refactor.verifyOk', "{0} applied and verified: no new errors.", title),
				});
				store.dispose();
			}, 1500);
		}));
	}

	private _activeEditorContext(): { editor: ICodeEditor; model: ITextModel; position: Position; selection: Selection | undefined } | undefined {
		const control = this._editorService.activeTextEditorControl;
		const editor = control && isCodeEditor(control) ? control : undefined;
		const model = editor?.getModel() ?? null;
		const position = editor?.getPosition() ?? undefined;
		if (!editor || !model || !position) {
			this._notificationService.notify({ severity: Severity.Info, message: localize('onyx.refactor.noEditor', "Open a file and put the cursor on the code to refactor.") });
			return undefined;
		}
		return { editor, model, position, selection: editor.getSelection() ?? undefined };
	}

	private _wordSelection(model: ITextModel, position: Position): Selection | undefined {
		const word = model.getWordAtPosition(position);
		return word ? new Selection(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn) : undefined;
	}
}

registerAction2(class OnyxRenameAction extends Action2 {
	constructor() {
		super({ id: 'onyx.refactor.rename', title: localize2('onyx.refactor.rename', "Onyx: Rename Symbol with Onyx"), f1: true });
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(IInstantiationService).createInstance(OnyxRefactorEngine).renameSymbol();
	}
});

registerAction2(class OnyxExtractAction extends Action2 {
	constructor() {
		super({ id: 'onyx.refactor.extract', title: localize2('onyx.refactor.extract', "Onyx: Extract Function with Onyx"), f1: true });
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(IInstantiationService).createInstance(OnyxRefactorEngine).extractFunction();
	}
});

registerAction2(class OnyxMoveAction extends Action2 {
	constructor() {
		super({ id: 'onyx.refactor.move', title: localize2('onyx.refactor.move', "Onyx: Move Symbol with Onyx"), f1: true });
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(IInstantiationService).createInstance(OnyxRefactorEngine).moveSymbol();
	}
});
