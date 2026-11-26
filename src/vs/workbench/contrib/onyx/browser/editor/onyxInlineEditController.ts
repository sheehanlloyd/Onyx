/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../media/onyxInlineEdit.css';
import * as DOM from '../../../../../base/browser/dom.js';
import * as aria from '../../../../../base/browser/ui/aria/aria.js';
import { CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { autorun } from '../../../../../base/common/observable.js';
import { KeyCode, KeyMod } from '../../../../../base/common/keyCodes.js';
import { ICodeEditor } from '../../../../../editor/browser/editorBrowser.js';
import { EditorAction2, registerEditorContribution, EditorContributionInstantiation } from '../../../../../editor/browser/editorExtensions.js';
import { Position } from '../../../../../editor/common/core/position.js';
import { Range } from '../../../../../editor/common/core/range.js';
import { IEditorContribution } from '../../../../../editor/common/editorCommon.js';
import { IModelDeltaDecoration, TrackedRangeStickiness } from '../../../../../editor/common/model.js';
import { ZoneWidget } from '../../../../../editor/contrib/zoneWidget/browser/zoneWidget.js';
import { localize, localize2 } from '../../../../../nls.js';
import { ContextKeyExpr, IContextKey, IContextKeyService, RawContextKey } from '../../../../../platform/contextkey/common/contextkey.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { KeybindingWeight } from '../../../../../platform/keybinding/common/keybindingsRegistry.js';
import { registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { EditorContextKeys } from '../../../../../editor/common/editorContextKeys.js';
import { ILabelService } from '../../../../../platform/label/common/label.js';
import { IOnyxReviewHunk } from '../../common/onyxChangeSet.js';
import { IOnyxChangeSetService } from '../changes/onyxChangeSetService.js';
import { IOnyxWorkspaceAccessService } from '../intelligence/onyxWorkspaceAccess.js';
import { OnyxInlineEditSession } from './onyxInlineEditSession.js';
import { IOnyxControlPlaneService } from '../controlPlane/onyxControlPlaneService.js';
import { IOnyxModelService } from '../model/onyxLanguageModelProvider.js';

export const CONTEXT_ONYX_INLINE_EDIT_ACTIVE = new RawContextKey<boolean>('onyxInlineEditActive', false);
export const CONTEXT_ONYX_INLINE_EDIT_REVIEW = new RawContextKey<boolean>('onyxInlineEditReview', false);

const enum SessionState { Idle, Prompting, Streaming, Review }

/**
 * The inline edit surface — Onyx's "select code, say what to change, review
 * the result in place" moment. The model replies in the SEARCH/REPLACE format
 * (small models cannot be trusted with unified diffs). Its reply is never
 * written into the buffer: it is staged as a proposal in Onyx Changes (B9),
 * shown here as a read-only preview under the lines it would replace, and
 * reaches the file only when a hunk is kept: ⌘Enter keeps the current hunk
 * as one undoable edit, ⌘⌫ rejects it, F7 walks, Escape discards what is
 * left. Until then the file, its dirty state and what a save writes are the
 * user's own. When the reply cannot be used, or the file changed while the
 * model was working, nothing is staged and the widget says so.
 */
export class OnyxInlineEditController implements IEditorContribution {

	static readonly ID = 'editor.contrib.onyxInlineEdit';

	static get(editor: ICodeEditor): OnyxInlineEditController | null {
		return editor.getContribution<OnyxInlineEditController>(OnyxInlineEditController.ID);
	}

	private readonly _activeKey: IContextKey<boolean>;
	private readonly _reviewKey: IContextKey<boolean>;

	private _state = SessionState.Idle;
	private _widget: OnyxInlineEditWidget | undefined;
	private _cancellation: CancellationTokenSource | undefined;
	private _session: OnyxInlineEditSession | undefined;
	/** The proposal under review here: the change set's path for the file and the generation this review is of. */
	private _review: { readonly path: string; readonly generation: number } | undefined;
	private _currentHunkId: string | undefined;
	private _decorationIds: string[] = [];
	private _zoneIds: string[] = [];
	/** What lasts as long as the widget is open: the watch on the editor's model and on the change set. */
	private readonly _sessionListeners = new DisposableStore();

	constructor(
		private readonly _editor: ICodeEditor,
		@IOnyxModelService private readonly _modelService: IOnyxModelService,
		@IOnyxControlPlaneService private readonly _controlPlaneService: IOnyxControlPlaneService,
		@ILabelService private readonly _labelService: ILabelService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IOnyxChangeSetService private readonly _changeSetService: IOnyxChangeSetService,
		@IOnyxWorkspaceAccessService private readonly _workspaceAccessService: IOnyxWorkspaceAccessService,
	) {
		this._activeKey = CONTEXT_ONYX_INLINE_EDIT_ACTIVE.bindTo(contextKeyService);
		this._reviewKey = CONTEXT_ONYX_INLINE_EDIT_REVIEW.bindTo(contextKeyService);
	}

	dispose(): void {
		this._teardown();
		this._sessionListeners.dispose();
	}

	show(): void {
		if (this._state !== SessionState.Idle) {
			this._widget?.focusInput();
			return;
		}
		const model = this._editor.getModel();
		if (!model) {
			return;
		}
		const selection = this._editor.getSelection() ?? new Range(1, 1, 1, 1);
		// Whole lines only: hunk review is a line-level experience.
		const endLine = selection.endColumn === 1 && selection.endLineNumber > selection.startLineNumber ? selection.endLineNumber - 1 : selection.endLineNumber;
		const lineRange = new Range(selection.startLineNumber, 1, endLine, model.getLineMaxColumn(endLine));

		this._state = SessionState.Prompting;
		this._activeKey.set(true);
		this._widget = new OnyxInlineEditWidget(this._editor, {
			onSubmit: instruction => this._submit(lineRange, instruction),
			onCancel: () => this.cancel(),
		});
		this._widget.show(new Position(endLine, 1), 3);
		this._widget.focusInput();
		// Another file in this editor, or the file closing, ends the request: a reply that still arrives
		// belongs to a text that is no longer here, and is not staged (R-14).
		this._sessionListeners.add(this._editor.onDidChangeModel(() => this._abandon()));
		this._sessionListeners.add(model.onWillDispose(() => this._abandon()));
	}

	/** The editor no longer shows the file the request was made in. Whatever is already staged stays in Onyx Changes. */
	private _abandon(): void {
		this._session?.cancel();
		this._cancellation?.cancel();
		this._teardown();
	}

	private async _submit(lineRange: Range, instruction: string): Promise<void> {
		const model = this._editor.getModel();
		if (!model || this._state !== SessionState.Prompting || !instruction.trim()) {
			return;
		}
		this._state = SessionState.Streaming;
		// What the request is made from is fixed here: the file, the lines, its text and its version (B9).
		const session = new OnyxInlineEditSession(model, lineRange, this._changeSetService, this._workspaceAccessService);
		this._session = session;
		const path = this._labelService.getUriLabel(model.uri, { relative: true });
		const cancellation = new CancellationTokenSource();
		this._cancellation = cancellation;
		this._widget?.setStatus(localize('onyx.inlineEdit.thinking', "Editing locally…"), 'polite');

		// The request, from the run to the staging, is the session's (L1: the simulation rig runs the same code).
		let streamed = 0;
		const result = await session.request(instruction, path, model.getLanguageId(), { modelService: this._modelService, controlPlaneService: this._controlPlaneService }, cancellation, text => {
			streamed += text.length;
			this._widget?.setStatus(localize('onyx.inlineEdit.streaming', "Streaming the edit… {0} characters", streamed));
		}, () => this._session === session);
		if (result.kind === 'cancelled' || this._session !== session) {
			return;
		}
		if (result.kind === 'failed') {
			this._state = SessionState.Prompting;
			this._widget?.setStatus(localize('onyx.inlineEdit.error', "The request failed: {0}", result.message));
			return;
		}
		if (result.outcome.kind === 'staged') {
			this._beginReview(result.outcome.path, result.outcome.generation);
			return;
		}
		// Nothing was staged, and nothing in the buffer changed: the prompt stays open for another try.
		this._state = SessionState.Prompting;
		this._widget?.setStatus(result.outcome.message, 'assertive');
	}

	/** The hunks of the proposal this review is of, while it is still that generation; empty once it is not. */
	private _reviewHunks(): readonly IOnyxReviewHunk[] {
		const review = this._review;
		const staged = review ? this._changeSetService.files.get().find(file => file.proposal.path === review.path) : undefined;
		return staged && review && staged.generation === review.generation ? staged.hunks : [];
	}

	private _beginReview(path: string, generation: number): void {
		this._review = { path, generation };
		this._state = SessionState.Review;
		this._reviewKey.set(true);
		this._currentHunkId = this._reviewHunks()[0]?.id;
		// The change set is the review's state: whenever it changes (a hunk kept or rejected here or in Onyx
		// Changes, the file edited, the agent staging the file again) the preview is drawn again from it.
		this._sessionListeners.add(autorun(reader => {
			this._changeSetService.files.read(reader);
			this._renderReview();
		}));
		this._focusHunk();
	}

	/**
	 * Draws the proposal over the file without touching it: a tint on the
	 * lines each hunk would replace, and under them a read-only zone with
	 * the lines it proposes. Neither is part of the text model.
	 */
	private _renderReview(): void {
		const model = this._editor.getModel();
		if (!model || this._state !== SessionState.Review) {
			return;
		}
		const hunks = this._reviewHunks();
		if (hunks.length === 0) {
			// Everything was kept or rejected, or the proposal is no longer the one reviewed here.
			this._teardown();
			this._editor.focus();
			return;
		}
		if (!hunks.some(hunk => hunk.id === this._currentHunkId)) {
			this._currentHunkId = hunks[0].id;
		}
		const lineCount = model.getLineCount();
		const decorations: IModelDeltaDecoration[] = [];
		const zones: { readonly afterLineNumber: number; readonly lines: readonly string[] }[] = [];
		for (const hunk of hunks) {
			const first = Math.min(Math.max(1, hunk.originalStart + 1), lineCount);
			const last = Math.min(Math.max(first, hunk.originalStart + hunk.originalLength), lineCount);
			if (hunk.originalLength > 0) {
				decorations.push({
					range: new Range(first, 1, last, model.getLineMaxColumn(last)),
					options: { description: 'onyx-inline-edit-hunk', isWholeLine: true, className: hunk.newLines.length === 0 ? 'onyx-inline-hunk-deletion' : 'onyx-inline-hunk', stickiness: TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges },
				});
			}
			if (hunk.newLines.length > 0) {
				zones.push({ afterLineNumber: hunk.originalLength > 0 ? last : Math.min(hunk.originalStart, lineCount), lines: hunk.newLines });
			}
		}
		this._decorationIds = model.deltaDecorations(this._decorationIds, decorations);
		this._editor.changeViewZones(accessor => {
			for (const id of this._zoneIds) {
				accessor.removeZone(id);
			}
			this._zoneIds = zones.map(zone => {
				const domNode = DOM.$('.onyx-inline-proposal');
				domNode.setAttribute('aria-label', localize('onyx.inlineEdit.proposalAria', "Proposed lines, not yet in the file"));
				for (const line of zone.lines) {
					DOM.append(domNode, DOM.$('.onyx-inline-proposal-line')).textContent = `+ ${line}`;
				}
				return accessor.addZone({ afterLineNumber: zone.afterLineNumber, heightInLines: zone.lines.length, domNode });
			});
		});
		const position = hunks.findIndex(hunk => hunk.id === this._currentHunkId);
		this._widget?.setStatus(localize('onyx.inlineEdit.review', "Proposed, not yet in the file: hunk {0} of {1} — ⌘⏎ keep · ⌘⌫ reject · F7 next · ⌥D diff · esc discard the rest", position + 1, hunks.length), 'polite');
	}

	private _focusHunk(): void {
		const hunk = this._reviewHunks().find(candidate => candidate.id === this._currentHunkId);
		const model = this._editor.getModel();
		if (!hunk || !model) {
			return;
		}
		const line = Math.min(Math.max(1, hunk.originalStart + 1), model.getLineCount());
		this._editor.revealLineInCenterIfOutsideViewport(line);
		this._editor.setPosition(new Position(line, 1));
	}

	nextHunk(direction: 1 | -1): void {
		const hunks = this._reviewHunks();
		if (this._state !== SessionState.Review || hunks.length === 0) {
			return;
		}
		const index = Math.max(0, hunks.findIndex(hunk => hunk.id === this._currentHunkId));
		this._currentHunkId = hunks[(index + direction + hunks.length) % hunks.length].id;
		this._focusHunk();
		this._renderReview();
	}

	/** Keeps the current hunk: the change set applies it, by its id, as one undoable edit (B7, B8). */
	async acceptCurrentHunk(): Promise<void> {
		const review = this._review;
		const hunkId = this._currentHunkId;
		if (this._state !== SessionState.Review || !review || !hunkId) {
			return;
		}
		const outcome = await this._changeSetService.acceptHunk(review.path, hunkId);
		if (!outcome.applied) {
			this._widget?.setStatus(outcome.message, 'assertive');
			return;
		}
		this._focusHunk();
	}

	/** Rejects the current hunk: it leaves the proposal. The buffer was never changed by it, so there is nothing to restore. */
	rejectCurrentHunk(): void {
		const review = this._review;
		const hunkId = this._currentHunkId;
		if (this._state !== SessionState.Review || !review || !hunkId) {
			return;
		}
		this._changeSetService.rejectHunk(review.path, hunkId);
		this._focusHunk();
	}

	/** Opens the proposal under review in a diff editor (C1). The review here goes on; both show the same change set. */
	async openDiff(): Promise<void> {
		if (this._state === SessionState.Review && this._review) {
			await this._changeSetService.openDiff(this._review.path);
		}
	}

	/** Escape: streaming cancels; review discards what is left of the proposal; prompting closes. */
	cancel(): void {
		if (this._state === SessionState.Streaming) {
			this._session?.cancel();
			this._cancellation?.cancel();
			this._session = undefined;
			this._state = SessionState.Prompting;
			this._widget?.setStatus(localize('onyx.inlineEdit.cancelled', "Cancelled."));
			return;
		}
		if (this._state === SessionState.Review) {
			const review = this._review;
			// Only the proposal reviewed here: one the agent staged since is not this review's to discard.
			if (review && this._reviewHunks().length > 0) {
				this._changeSetService.rejectFile(review.path);
			}
			this._teardown();
			this._editor.focus();
			return;
		}
		this._teardown();
	}

	private _teardown(): void {
		const model = this._editor.getModel();
		if (model && this._decorationIds.length) {
			model.deltaDecorations(this._decorationIds, []);
		}
		this._decorationIds = [];
		if (this._zoneIds.length) {
			this._editor.changeViewZones(accessor => {
				for (const id of this._zoneIds) {
					accessor.removeZone(id);
				}
			});
		}
		this._zoneIds = [];
		this._state = SessionState.Idle;
		this._session = undefined;
		this._review = undefined;
		this._currentHunkId = undefined;
		this._activeKey.set(false);
		this._reviewKey.set(false);
		this._cancellation?.dispose(true);
		this._cancellation = undefined;
		this._widget?.dispose();
		this._widget = undefined;
		this._sessionListeners.clear();
	}
}

/** The floating input under the selection: one line of intent, one line of status. */
class OnyxInlineEditWidget extends ZoneWidget {

	private _input: HTMLInputElement | undefined;
	private _status: HTMLElement | undefined;

	constructor(
		editor: ICodeEditor,
		private readonly _callbacks: { onSubmit(instruction: string): void; onCancel(): void },
	) {
		super(editor, { showFrame: false, showArrow: false, className: 'onyx-inline-edit-zone' });
		this.create();
	}

	protected _fillContainer(container: HTMLElement): void {
		const root = DOM.append(container, DOM.$('.onyx-inline-edit'));
		const inputRow = DOM.append(root, DOM.$('.onyx-inline-edit-row'));
		const gem = DOM.append(inputRow, DOM.$('span.codicon.codicon-sparkle.onyx-inline-edit-gem'));
		gem.ariaHidden = 'true';
		this._input = DOM.append(inputRow, DOM.$('input.onyx-inline-edit-input')) as HTMLInputElement;
		this._input.placeholder = localize('onyx.inlineEdit.placeholder', "Describe the change — ⏎ to edit locally, esc to close");
		this._input.setAttribute('aria-label', localize('onyx.inlineEdit.ariaLabel', "Onyx inline edit instruction"));
		this._input.addEventListener('keydown', event => {
			if (event.key === 'Enter') {
				event.preventDefault();
				this._callbacks.onSubmit(this._input?.value ?? '');
			} else if (event.key === 'Escape') {
				event.preventDefault();
				this._callbacks.onCancel();
			}
		});
		this._status = DOM.append(root, DOM.$('.onyx-inline-edit-status'));
		this._status.setAttribute('aria-live', 'polite');
	}

	focusInput(): void {
		this._input?.focus();
	}

	setStatus(text: string, announce?: 'polite' | 'assertive'): void {
		if (this._status) {
			this._status.textContent = text;
		}
		if (announce === 'assertive') {
			aria.alert(text);
		} else if (announce === 'polite') {
			aria.status(text);
		}
	}
}

registerEditorContribution(OnyxInlineEditController.ID, OnyxInlineEditController, EditorContributionInstantiation.Lazy);

registerAction2(class OnyxInlineEditAction extends EditorAction2 {
	constructor() {
		super({
			id: 'onyx.inlineEdit',
			title: localize2('onyx.inlineEdit', "Onyx: Edit Selection Inline"),
			f1: true,
			precondition: ContextKeyExpr.and(EditorContextKeys.writable, EditorContextKeys.editorTextFocus),
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib + 1,
				primary: KeyMod.CtrlCmd | KeyCode.KeyI,
				when: ContextKeyExpr.and(EditorContextKeys.writable, EditorContextKeys.editorTextFocus),
			},
		});
	}

	runEditorCommand(_accessor: ServicesAccessor, editor: ICodeEditor): void {
		OnyxInlineEditController.get(editor)?.show();
	}
});

registerAction2(class OnyxInlineEditAcceptAction extends EditorAction2 {
	constructor() {
		super({
			id: 'onyx.inlineEdit.acceptHunk',
			title: localize2('onyx.inlineEdit.accept', "Onyx: Keep Current Inline Edit Hunk"),
			precondition: CONTEXT_ONYX_INLINE_EDIT_REVIEW,
			keybinding: { weight: KeybindingWeight.WorkbenchContrib + 10, primary: KeyMod.CtrlCmd | KeyCode.Enter, when: CONTEXT_ONYX_INLINE_EDIT_REVIEW },
		});
	}
	runEditorCommand(_accessor: ServicesAccessor, editor: ICodeEditor): void {
		OnyxInlineEditController.get(editor)?.acceptCurrentHunk();
	}
});

registerAction2(class OnyxInlineEditOpenDiffAction extends EditorAction2 {
	constructor() {
		super({
			id: 'onyx.inlineEdit.openDiff',
			title: localize2('onyx.inlineEdit.openDiff', "Onyx: Open Inline Edit Proposal in Diff Editor"),
			precondition: CONTEXT_ONYX_INLINE_EDIT_REVIEW,
			keybinding: { weight: KeybindingWeight.WorkbenchContrib + 10, primary: KeyMod.Alt | KeyCode.KeyD, when: CONTEXT_ONYX_INLINE_EDIT_REVIEW },
		});
	}
	runEditorCommand(_accessor: ServicesAccessor, editor: ICodeEditor): void {
		OnyxInlineEditController.get(editor)?.openDiff();
	}
});

registerAction2(class OnyxInlineEditRejectAction extends EditorAction2 {
	constructor() {
		super({
			id: 'onyx.inlineEdit.rejectHunk',
			title: localize2('onyx.inlineEdit.reject', "Onyx: Reject Current Inline Edit Hunk"),
			precondition: CONTEXT_ONYX_INLINE_EDIT_REVIEW,
			keybinding: { weight: KeybindingWeight.WorkbenchContrib + 10, primary: KeyMod.CtrlCmd | KeyCode.Backspace, when: CONTEXT_ONYX_INLINE_EDIT_REVIEW },
		});
	}
	runEditorCommand(_accessor: ServicesAccessor, editor: ICodeEditor): void {
		OnyxInlineEditController.get(editor)?.rejectCurrentHunk();
	}
});

registerAction2(class OnyxInlineEditNextAction extends EditorAction2 {
	constructor() {
		super({
			id: 'onyx.inlineEdit.nextHunk',
			title: localize2('onyx.inlineEdit.next', "Onyx: Next Inline Edit Hunk"),
			precondition: CONTEXT_ONYX_INLINE_EDIT_REVIEW,
			keybinding: { weight: KeybindingWeight.WorkbenchContrib + 10, primary: KeyCode.F7, when: CONTEXT_ONYX_INLINE_EDIT_REVIEW },
		});
	}
	runEditorCommand(_accessor: ServicesAccessor, editor: ICodeEditor): void {
		OnyxInlineEditController.get(editor)?.nextHunk(1);
	}
});

registerAction2(class OnyxInlineEditPreviousAction extends EditorAction2 {
	constructor() {
		super({
			id: 'onyx.inlineEdit.previousHunk',
			title: localize2('onyx.inlineEdit.previous', "Onyx: Previous Inline Edit Hunk"),
			precondition: CONTEXT_ONYX_INLINE_EDIT_REVIEW,
			keybinding: { weight: KeybindingWeight.WorkbenchContrib + 10, primary: KeyMod.Shift | KeyCode.F7, when: CONTEXT_ONYX_INLINE_EDIT_REVIEW },
		});
	}
	runEditorCommand(_accessor: ServicesAccessor, editor: ICodeEditor): void {
		OnyxInlineEditController.get(editor)?.nextHunk(-1);
	}
});

registerAction2(class OnyxInlineEditCancelAction extends EditorAction2 {
	constructor() {
		super({
			id: 'onyx.inlineEdit.cancel',
			title: localize2('onyx.inlineEdit.cancel', "Onyx: Close Inline Edit"),
			precondition: CONTEXT_ONYX_INLINE_EDIT_ACTIVE,
			keybinding: { weight: KeybindingWeight.WorkbenchContrib + 10, primary: KeyCode.Escape, when: CONTEXT_ONYX_INLINE_EDIT_ACTIVE },
		});
	}
	runEditorCommand(_accessor: ServicesAccessor, editor: ICodeEditor): void {
		OnyxInlineEditController.get(editor)?.cancel();
	}
});
