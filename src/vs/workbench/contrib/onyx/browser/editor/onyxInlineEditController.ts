/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../media/onyxInlineEdit.css';
import * as DOM from '../../../../../base/browser/dom.js';
import * as aria from '../../../../../base/browser/ui/aria/aria.js';
import { CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { KeyCode, KeyMod } from '../../../../../base/common/keyCodes.js';
import { URI } from '../../../../../base/common/uri.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
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
import { applyEditBlocks, buildInlineEditPrompt, computeLineHunks, IOnyxEditHunk, ONYX_INLINE_EDIT_SYSTEM_PROMPT, parseInlineEdits } from '../../common/onyxInlineEdit.js';
import { runOneShot } from '../agent/onyxOneShot.js';
import { IOnyxControlPlaneService } from '../controlPlane/onyxControlPlaneService.js';
import { IOnyxModelService } from '../model/onyxLanguageModelProvider.js';

export const CONTEXT_ONYX_INLINE_EDIT_ACTIVE = new RawContextKey<boolean>('onyxInlineEditActive', false);
export const CONTEXT_ONYX_INLINE_EDIT_REVIEW = new RawContextKey<boolean>('onyxInlineEditReview', false);

const enum SessionState { Idle, Prompting, Streaming, Review }

/** One hunk under review: its tracked decoration plus what to restore on reject. */
interface IReviewHunk {
	readonly decorationId: string;
	readonly hunk: IOnyxEditHunk;
	resolved: boolean;
}

/**
 * The inline edit surface — Onyx's "select code, say what to change, review
 * the diff in place" moment. The model replies in the SEARCH/REPLACE format
 * (small models cannot be trusted with unified diffs), the parsed result is
 * applied as one undoable edit, and every changed region becomes a reviewable
 * hunk with a keyboard flow: ⌘Enter keeps a hunk, ⌘⌫ restores it, F7 walks,
 * Escape finishes. When the reply cannot be parsed, the buffer is untouched
 * and the widget says so — a wrong edit is worse than no edit.
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
	private _hunks: IReviewHunk[] = [];
	private _currentHunk = 0;
	private _selectionStartLine = 1;

	constructor(
		private readonly _editor: ICodeEditor,
		@IOnyxModelService private readonly _modelService: IOnyxModelService,
		@IOnyxControlPlaneService private readonly _controlPlaneService: IOnyxControlPlaneService,
		@ILabelService private readonly _labelService: ILabelService,
		@IContextKeyService contextKeyService: IContextKeyService,
	) {
		this._activeKey = CONTEXT_ONYX_INLINE_EDIT_ACTIVE.bindTo(contextKeyService);
		this._reviewKey = CONTEXT_ONYX_INLINE_EDIT_REVIEW.bindTo(contextKeyService);
	}

	dispose(): void {
		this._teardown();
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
		this._selectionStartLine = selection.startLineNumber;
		const lineRange = new Range(selection.startLineNumber, 1, endLine, model.getLineMaxColumn(endLine));

		this._state = SessionState.Prompting;
		this._activeKey.set(true);
		this._widget = new OnyxInlineEditWidget(this._editor, {
			onSubmit: instruction => this._submit(lineRange, instruction),
			onCancel: () => this.cancel(),
		});
		this._widget.show(new Position(endLine, 1), 3);
		this._widget.focusInput();
	}

	private async _submit(lineRange: Range, instruction: string): Promise<void> {
		const model = this._editor.getModel();
		if (!model || this._state !== SessionState.Prompting || !instruction.trim()) {
			return;
		}
		this._state = SessionState.Streaming;
		const original = model.getValueInRange(lineRange);
		const path = this._labelService.getUriLabel(model.uri, { relative: true });
		this._cancellation = new CancellationTokenSource();
		this._widget?.setStatus(localize('onyx.inlineEdit.thinking', "Editing locally…"), 'polite');

		const run = this._controlPlaneService.beginRun({
			sessionResource: URI.from({ scheme: 'onyx-inline-edit', path: `/${generateUuid()}` }),
			requestId: generateUuid(),
			title: localize('onyx.inlineEdit.runTitle', "Inline edit: {0}", instruction.slice(0, 60)),
			task: 'quick-edit',
			modelKey: 'auto',
		});

		let streamed = 0;
		try {
			const reply = await runOneShot(
				this._modelService,
				ONYX_INLINE_EDIT_SYSTEM_PROMPT,
				buildInlineEditPrompt(path, model.getLanguageId(), original, instruction),
				this._cancellation.token,
				{
					run,
					controlPlane: this._controlPlaneService,
					onDelta: text => {
						streamed += text.length;
						this._widget?.setStatus(localize('onyx.inlineEdit.streaming', "Streaming the edit… {0} characters", streamed));
					},
				});
			if (this._cancellation.token.isCancellationRequested) {
				run.complete('cancelled');
				return;
			}
			this._applyReply(lineRange, original, reply, run);
		} catch (error) {
			run.activity({ kind: 'note', label: localize('onyx.inlineEdit.failed', "Inline edit failed"), reason: error instanceof Error ? error.message : String(error), ok: false });
			run.complete('failed');
			this._state = SessionState.Prompting;
			this._widget?.setStatus(localize('onyx.inlineEdit.error', "The request failed: {0}", error instanceof Error ? error.message : String(error)));
		}
	}

	private _applyReply(lineRange: Range, original: string, reply: string, run: ReturnType<IOnyxControlPlaneService['beginRun']>): void {
		const model = this._editor.getModel();
		if (!model) {
			return;
		}
		const parsed = parseInlineEdits(reply);
		let newText: string | undefined;
		if (parsed.kind === 'blocks') {
			const applied = applyEditBlocks(original, parsed.blocks);
			if (applied.appliedCount > 0) {
				newText = applied.text;
				if (applied.failed.length > 0) {
					run.activity({ kind: 'note', label: localize('onyx.inlineEdit.partial', "{0} of {1} edit blocks could not be located", applied.failed.length, parsed.blocks.length), ok: false });
				}
			}
		} else if (parsed.kind === 'rewrite') {
			newText = parsed.text;
		}

		if (newText === undefined || newText === original) {
			// Degrade honestly: nothing in the buffer changed.
			run.activity({ kind: 'note', label: localize('onyx.inlineEdit.unparseable', "The model's reply was not a usable edit — nothing was changed"), ok: false });
			run.complete('failed');
			this._state = SessionState.Prompting;
			this._widget?.setStatus(localize('onyx.inlineEdit.noEdit', "The model's reply was not a usable edit. Nothing was changed — try rephrasing."), 'assertive');
			return;
		}

		const hunks = computeLineHunks(original, newText);
		this._editor.pushUndoStop();
		this._editor.executeEdits('onyx.inlineEdit', [{ range: lineRange, text: newText }]);
		this._editor.pushUndoStop();
		run.activity({ kind: 'note', label: hunks.length === 1 ? localize('onyx.inlineEdit.oneHunk', "Applied 1 hunk for review") : localize('onyx.inlineEdit.hunks', "Applied {0} hunks for review", hunks.length), ok: true });
		run.complete('completed');

		this._beginReview(hunks);
	}

	private _beginReview(hunks: readonly IOnyxEditHunk[]): void {
		const model = this._editor.getModel();
		if (!model) {
			return;
		}
		// Where each hunk landed in the buffer: original position shifted by the
		// line delta of every hunk before it.
		let shift = 0;
		const decorations: IModelDeltaDecoration[] = [];
		for (const hunk of hunks) {
			const startLine = this._selectionStartLine + hunk.originalStart + shift;
			const isDeletion = hunk.newLines.length === 0;
			const endLine = isDeletion ? startLine : startLine + hunk.newLines.length - 1;
			const boundedStart = Math.min(Math.max(1, startLine), model.getLineCount());
			const boundedEnd = Math.min(Math.max(boundedStart, endLine), model.getLineCount());
			decorations.push({
				range: new Range(boundedStart, 1, boundedEnd, model.getLineMaxColumn(boundedEnd)),
				options: {
					description: 'onyx-inline-edit-hunk',
					isWholeLine: true,
					className: isDeletion ? 'onyx-inline-hunk-deletion' : 'onyx-inline-hunk',
					stickiness: TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
				},
			});
			shift += hunk.newLines.length - hunk.originalLength;
		}
		const ids = model.deltaDecorations([], decorations);
		this._hunks = hunks.map((hunk, index) => ({ decorationId: ids[index], hunk, resolved: false }));
		this._currentHunk = 0;
		this._state = SessionState.Review;
		this._reviewKey.set(true);
		this._focusHunk(0);
		this._updateReviewStatus();
	}

	private _updateReviewStatus(): void {
		const remaining = this._hunks.filter(hunk => !hunk.resolved).length;
		if (remaining === 0) {
			this._finishReview();
			return;
		}
		this._widget?.setStatus(localize('onyx.inlineEdit.review', "Reviewing hunk {0} of {1} — ⌘⏎ keep · ⌘⌫ undo hunk · F7 next · esc keep the rest", this._currentHunk + 1, this._hunks.length), 'polite');
	}

	private _focusHunk(index: number): void {
		const model = this._editor.getModel();
		const entry = this._hunks[index];
		if (!model || !entry) {
			return;
		}
		const range = model.getDecorationRange(entry.decorationId);
		if (range) {
			this._editor.revealRangeInCenterIfOutsideViewport(range);
			this._editor.setPosition(range.getStartPosition());
		}
	}

	nextHunk(direction: 1 | -1): void {
		if (this._state !== SessionState.Review || this._hunks.length === 0) {
			return;
		}
		for (let step = 1; step <= this._hunks.length; step++) {
			const index = (this._currentHunk + direction * step + this._hunks.length * step) % this._hunks.length;
			if (!this._hunks[index].resolved) {
				this._currentHunk = index;
				break;
			}
		}
		this._focusHunk(this._currentHunk);
		this._updateReviewStatus();
	}

	acceptCurrentHunk(): void {
		if (this._state !== SessionState.Review) {
			return;
		}
		const entry = this._hunks[this._currentHunk];
		const model = this._editor.getModel();
		if (!entry || entry.resolved || !model) {
			return;
		}
		entry.resolved = true;
		model.deltaDecorations([entry.decorationId], []);
		this._advanceOrFinish();
	}

	rejectCurrentHunk(): void {
		if (this._state !== SessionState.Review) {
			return;
		}
		const entry = this._hunks[this._currentHunk];
		const model = this._editor.getModel();
		if (!entry || entry.resolved || !model) {
			return;
		}
		const range = model.getDecorationRange(entry.decorationId);
		if (range) {
			const originalText = entry.hunk.originalLines.join('\n');
			if (entry.hunk.newLines.length === 0) {
				// The hunk was a deletion: restore the lines above the marker line.
				this._editor.executeEdits('onyx.inlineEdit.reject', [{ range: new Range(range.startLineNumber, 1, range.startLineNumber, 1), text: `${originalText}\n` }]);
			} else {
				this._editor.executeEdits('onyx.inlineEdit.reject', [{ range, text: originalText }]);
			}
		}
		entry.resolved = true;
		model.deltaDecorations([entry.decorationId], []);
		this._advanceOrFinish();
	}

	private _advanceOrFinish(): void {
		const nextUnresolved = this._hunks.findIndex(hunk => !hunk.resolved);
		if (nextUnresolved < 0) {
			this._finishReview();
			return;
		}
		this._currentHunk = nextUnresolved;
		this._focusHunk(this._currentHunk);
		this._updateReviewStatus();
	}

	/** Escape: streaming cancels; review keeps every remaining hunk; prompting closes. */
	cancel(): void {
		if (this._state === SessionState.Streaming) {
			this._cancellation?.cancel();
			this._state = SessionState.Prompting;
			this._widget?.setStatus(localize('onyx.inlineEdit.cancelled', "Cancelled."));
			return;
		}
		if (this._state === SessionState.Review) {
			this._finishReview();
			return;
		}
		this._teardown();
	}

	private _finishReview(): void {
		const model = this._editor.getModel();
		if (model) {
			model.deltaDecorations(this._hunks.map(hunk => hunk.decorationId), []);
		}
		this._teardown();
		this._editor.focus();
	}

	private _teardown(): void {
		this._state = SessionState.Idle;
		this._hunks = [];
		this._activeKey.set(false);
		this._reviewKey.set(false);
		this._cancellation?.dispose(true);
		this._cancellation = undefined;
		this._widget?.dispose();
		this._widget = undefined;
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

registerAction2(class OnyxInlineEditRejectAction extends EditorAction2 {
	constructor() {
		super({
			id: 'onyx.inlineEdit.rejectHunk',
			title: localize2('onyx.inlineEdit.reject', "Onyx: Undo Current Inline Edit Hunk"),
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
