/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Range } from '../../../../../editor/common/core/range.js';
import { EndOfLinePreference, ITextModel } from '../../../../../editor/common/model.js';
import { localize } from '../../../../../nls.js';
import { applyEditBlocks, parseInlineEdits } from '../../common/onyxInlineEdit.js';
import { IOnyxChangeSetService } from '../changes/onyxChangeSetService.js';
import { IOnyxWorkspaceAccessService } from '../intelligence/onyxWorkspaceAccess.js';

/** Why a reply was not staged. In every case the user's text is as they left it. */
export type OnyxInlineStaleReason =
	/** The request was cancelled, or the editor moved to another file. */
	| 'cancelled'
	/** The file's text model is gone. */
	| 'disposed'
	/** The file's text is not what the request was made from: the user typed, or a save participant changed it. */
	| 'changed';

export type OnyxInlineStageOutcome =
	/** The reply is a proposal in the change set. Nothing was written into the buffer. */
	| { readonly kind: 'staged'; readonly path: string; readonly generation: number; readonly hunkIds: readonly string[]; readonly unplacedBlocks: number }
	| { readonly kind: 'stale'; readonly reason: OnyxInlineStaleReason; readonly message: string }
	/** The reply was not an edit, or changed nothing. */
	| { readonly kind: 'no-edit'; readonly message: string }
	/** The change set would not take it: the file is outside the workspace, already has changes waiting, or the proposal is too large. */
	| { readonly kind: 'refused'; readonly message: string };

/**
 * One inline edit request, from the moment it is made to the moment its
 * reply is staged (B9, R-14, R-34). What the request was made from is
 * captured at the start: the file, the lines selected, the file's whole
 * text and its version. A reply is staged only against that same text, as a
 * proposal in the change set (B7): this class never edits the buffer, never
 * saves and never changes whether the file is dirty. Keeping or rejecting
 * the proposal is the change set's business, by generation and hunk id.
 */
export class OnyxInlineEditSession {

	/** The selected lines as they were, joined by `\n`. This is what the model is shown. */
	readonly original: string;
	/** The path the change set knows the file by, or undefined when the file is not in the workspace. */
	readonly path: string | undefined;

	private readonly _baseText: string;
	private readonly _baseVersionId: number;
	private readonly _startLine: number;
	private readonly _endLine: number;
	private _cancelled = false;

	constructor(
		private readonly _model: ITextModel,
		lineRange: Range,
		private readonly _changeSetService: IOnyxChangeSetService,
		workspaceAccessService: IOnyxWorkspaceAccessService,
	) {
		this._startLine = lineRange.startLineNumber;
		this._endLine = lineRange.endLineNumber;
		this._baseText = _model.getValue(EndOfLinePreference.LF);
		this._baseVersionId = _model.getVersionId();
		this.original = this._baseText.split('\n').slice(this._startLine - 1, this._endLine).join('\n');
		this.path = workspaceAccessService.qualify(_model.uri);
	}

	/** The request is over: the user cancelled, or the editor shows another file now. A reply that still arrives is not staged. */
	cancel(): void {
		this._cancelled = true;
	}

	/** Whether the file is still the text the request was made from. A save that changes nothing leaves it so. */
	isCurrent(): boolean {
		return !this._cancelled && !this._model.isDisposed() && (this._model.getVersionId() === this._baseVersionId || this._model.getValue(EndOfLinePreference.LF) === this._baseText);
	}

	/**
	 * Stages the model's reply as a proposal for the file, or says why not.
	 * The identity, version and content of the file are checked first; if
	 * any of them moved, nothing is staged and the user is offered a fresh
	 * request.
	 */
	async stageReply(reply: string, runId?: string): Promise<OnyxInlineStageOutcome> {
		const stale = this._staleness();
		if (stale) {
			return stale;
		}
		const parsed = parseInlineEdits(reply);
		let newText: string | undefined;
		let unplacedBlocks = 0;
		if (parsed.kind === 'blocks') {
			const applied = applyEditBlocks(this.original, parsed.blocks);
			unplacedBlocks = applied.failed.length;
			newText = applied.appliedCount > 0 ? applied.text : undefined;
		} else if (parsed.kind === 'rewrite') {
			newText = parsed.text;
		}
		if (newText === undefined || newText === this.original) {
			return { kind: 'no-edit', message: localize('onyx.inlineEdit.noEdit', "The model's reply was not a usable edit. Nothing was changed — try rephrasing.") };
		}
		if (this.path === undefined) {
			return { kind: 'refused', message: localize('onyx.inlineEdit.outside', "Inline edits are staged for review, and only files in the workspace can be. Nothing was changed.") };
		}
		if (this._changeSetService.files.get().some(file => file.proposal.path === this.path)) {
			return { kind: 'refused', message: localize('onyx.inlineEdit.alreadyStaged', "This file already has changes waiting in Onyx Changes. Accept or reject them first; nothing was changed.") };
		}
		// The whole file as it would be: the text the request was made from, with the selected lines replaced.
		const lines = this._baseText.split('\n');
		const proposed = [...lines.slice(0, this._startLine - 1), ...newText.split('\n'), ...lines.slice(this._endLine)].join('\n');
		const outcome = await this._changeSetService.stageProposal(this.path, proposed, runId);
		// Staging read the file itself. Whatever happened while it did, the request's own text is checked once more.
		const staleAfter = this._staleness();
		if (staleAfter) {
			if (outcome.ok) {
				this._changeSetService.rejectFile(this.path);
			}
			return staleAfter;
		}
		if (!outcome.ok) {
			return { kind: 'refused', message: outcome.error };
		}
		const staged = this._changeSetService.files.get().find(file => file.proposal.path === this.path);
		if (!staged) {
			return { kind: 'no-edit', message: localize('onyx.inlineEdit.noChange', "The edit leaves the file as it is. Nothing was changed.") };
		}
		return { kind: 'staged', path: this.path, generation: staged.generation, hunkIds: staged.hunks.map(hunk => hunk.id), unplacedBlocks };
	}

	private _staleness(): (OnyxInlineStageOutcome & { kind: 'stale' }) | undefined {
		if (this._cancelled) {
			return { kind: 'stale', reason: 'cancelled', message: localize('onyx.inlineEdit.stale.cancelled', "Cancelled. Nothing was changed.") };
		}
		if (this._model.isDisposed()) {
			return { kind: 'stale', reason: 'disposed', message: localize('onyx.inlineEdit.stale.disposed', "The file was closed while the model was working. Nothing was changed.") };
		}
		if (!this.isCurrent()) {
			return { kind: 'stale', reason: 'changed', message: localize('onyx.inlineEdit.stale.changed', "The file changed while the model was working, so its edit no longer fits what you see. Nothing was changed — press ⏎ to ask again with the current text.") };
		}
		return undefined;
	}
}
