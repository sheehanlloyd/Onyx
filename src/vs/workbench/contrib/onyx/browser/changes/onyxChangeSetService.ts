/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../../../base/common/buffer.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { IObservable, ISettableObservable, observableValue } from '../../../../../base/common/observable.js';
import { URI } from '../../../../../base/common/uri.js';
import { EditOperation } from '../../../../../editor/common/core/editOperation.js';
import { Range } from '../../../../../editor/common/core/range.js';
import { ITextModel } from '../../../../../editor/common/model.js';
import { ITextModelService } from '../../../../../editor/common/services/resolverService.js';
import { localize } from '../../../../../nls.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { createDecorator, IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { INotificationService, Severity } from '../../../../../platform/notification/common/notification.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import {
	applyHunkSelection, IOnyxProposedFile, proposalHunks, proposalToUnifiedDiff, proposeEdits, rebaseProposal, summarizeChangeSet
} from '../../common/onyxChangeSet.js';
import { IOnyxChangeRisk } from '../../common/onyxChangeRisk.js';
import { IOnyxEditBlock, IOnyxEditHunk } from '../../common/onyxInlineEdit.js';
import { resolveWorkspacePath } from '../../common/onyxWorkspacePaths.js';
import { OnyxChangeRiskCollector } from '../intelligence/onyxChangeRiskCollector.js';

export const IOnyxChangeSetService = createDecorator<IOnyxChangeSetService>('onyxChangeSetService');

const STAGED_STORAGE_KEY = 'onyx.changes.staged';

/** One staged file plus everything the review surface shows about it. */
export interface IOnyxStagedFile {
	readonly proposal: IOnyxProposedFile;
	readonly hunks: readonly IOnyxEditHunk[];
	readonly risk: IOnyxChangeRisk | undefined;
	/** The run that most recently staged into this file, for the timeline link. */
	readonly runId: string | undefined;
}

export type OnyxStageOutcome =
	| { readonly ok: true; readonly summary: string }
	| { readonly ok: false; readonly error: string };

/**
 * Holds the agent's proposed edits between "the model asked for a change" and
 * "the user accepted it". Nothing here touches a buffer until an accept; a
 * rejected proposal simply disappears, because the file was never modified.
 * This is the seam that makes an agentic editor trustworthy: the working tree
 * only ever changes by explicit human decision.
 */
export interface IOnyxChangeSetService {
	readonly _serviceBrand: undefined;

	readonly files: IObservable<readonly IOnyxStagedFile[]>;
	readonly onDidApply: Event<{ readonly path: string }>;

	/** Stages SEARCH/REPLACE blocks for a workspace-qualified path. Never edits the buffer. */
	stage(path: string, blocks: readonly IOnyxEditBlock[], runId?: string): Promise<OnyxStageOutcome>;

	/**
	 * Stages complete proposed content for a path (the refactor engine's entry:
	 * language services compute whole-file results). Replaces any existing
	 * proposal for the file. Never edits the buffer.
	 */
	stageProposal(path: string, proposedContent: string, runId?: string): Promise<OnyxStageOutcome>;

	acceptFile(path: string): Promise<boolean>;
	rejectFile(path: string): void;
	/** Accepts one hunk (by index into the staged file's hunks); the rest stay staged. */
	acceptHunk(path: string, hunkIndex: number): Promise<boolean>;
	rejectHunk(path: string, hunkIndex: number): void;
	acceptAll(): Promise<number>;
	rejectAll(): void;

	/** Re-checks every staged file against its live buffer, rebasing stale proposals. */
	refresh(): Promise<void>;
	openDiff(path: string): Promise<void>;
}

export class OnyxChangeSetService extends Disposable implements IOnyxChangeSetService {

	declare readonly _serviceBrand: undefined;

	private readonly _filesObs: ISettableObservable<readonly IOnyxStagedFile[]> = observableValue(this, []);
	readonly files: IObservable<readonly IOnyxStagedFile[]> = this._filesObs;

	private readonly _onDidApply = this._register(new Emitter<{ path: string }>());
	readonly onDidApply = this._onDidApply.event;

	constructor(
		@IWorkspaceContextService private readonly _workspaceService: IWorkspaceContextService,
		@ITextModelService private readonly _textModelService: ITextModelService,
		@IFileService private readonly _fileService: IFileService,
		@IEditorService private readonly _editorService: IEditorService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@IStorageService private readonly _storageService: IStorageService,
		@INotificationService private readonly _notificationService: INotificationService,
	) {
		super();
		// Staged edits survive a crash: restore them marked stale, so the next
		// look at the view rebases each proposal against today's buffers and
		// drops (with a count, never silently) whatever no longer applies.
		try {
			const persisted: IOnyxProposedFile[] = JSON.parse(this._storageService.get(STAGED_STORAGE_KEY, StorageScope.WORKSPACE, '[]'));
			if (Array.isArray(persisted) && persisted.length > 0) {
				this._filesObs.set(persisted.map(proposal => ({
					proposal: { ...proposal, stale: true },
					hunks: proposalHunks(proposal),
					risk: undefined,
					runId: undefined,
				})), undefined);
			}
		} catch {
			// corrupt storage: start with an empty change set
		}
		this._register(this._storageService.onWillSaveState(() => this._persist()));
	}

	private _persist(): void {
		const proposals = this._filesObs.get().map(file => file.proposal);
		if (proposals.length === 0) {
			this._storageService.remove(STAGED_STORAGE_KEY, StorageScope.WORKSPACE);
		} else {
			this._storageService.store(STAGED_STORAGE_KEY, JSON.stringify(proposals), StorageScope.WORKSPACE, StorageTarget.MACHINE);
		}
	}

	async stage(path: string, blocks: readonly IOnyxEditBlock[], runId?: string): Promise<OnyxStageOutcome> {
		const uri = this._resolveUri(path);
		if (!uri) {
			return { ok: false, error: `Path "${path}" is not inside the workspace.` };
		}
		const existing = this._filesObs.get().find(file => file.proposal.path === path);
		const current = existing ? undefined : await this._readCurrentContent(uri);
		const result = proposeEdits(existing?.proposal, path, existing ? existing.proposal.base : current, blocks);
		if (!result.ok) {
			return { ok: false, error: result.error };
		}
		const hunks = proposalHunks(result.file);
		if (hunks.length === 0) {
			this._remove(path);
			return { ok: true, summary: `No change left for ${path}: the edits cancel out. Nothing is staged.` };
		}
		const staged: IOnyxStagedFile = { proposal: result.file, hunks, risk: existing?.risk, runId: runId ?? existing?.runId };
		this._upsert(staged);
		this._scoreRisk(staged.proposal).catch(() => { /* risk stays unknown */ });
		const summary = summarizeChangeSet([result.file]);
		return {
			ok: true,
			summary: `Staged ${result.appliedCount} edit(s) to ${path} (+${summary.addedLines} −${summary.removedLines}). The user reviews them in Onyx Changes before anything is applied — do not re-apply the same edit.`,
		};
	}

	async stageProposal(path: string, proposedContent: string, runId?: string): Promise<OnyxStageOutcome> {
		const uri = this._resolveUri(path);
		if (!uri) {
			return { ok: false, error: `Path "${path}" is not inside the workspace.` };
		}
		const current = await this._readCurrentContent(uri);
		const proposal: IOnyxProposedFile = current === undefined
			? { path, kind: 'create', base: '', proposed: proposedContent, stale: false }
			: { path, kind: 'modify', base: current, proposed: proposedContent, stale: false };
		const hunks = proposalHunks(proposal);
		if (hunks.length === 0) {
			this._remove(path);
			return { ok: true, summary: `No change for ${path}.` };
		}
		const staged: IOnyxStagedFile = { proposal, hunks, risk: undefined, runId };
		this._upsert(staged);
		this._scoreRisk(proposal).catch(() => { /* risk stays unknown */ });
		const summary = summarizeChangeSet([proposal]);
		return { ok: true, summary: `Staged ${path} (+${summary.addedLines} −${summary.removedLines}).` };
	}

	async acceptFile(path: string): Promise<boolean> {
		const staged = this._filesObs.get().find(file => file.proposal.path === path);
		if (!staged) {
			return false;
		}
		return this._applySafely(staged, () => true);
	}

	async acceptHunk(path: string, hunkIndex: number): Promise<boolean> {
		const staged = this._filesObs.get().find(file => file.proposal.path === path);
		if (!staged || hunkIndex < 0 || hunkIndex >= staged.hunks.length) {
			return false;
		}
		return this._applySafely(staged, index => index === hunkIndex);
	}

	/** An accept that cannot land (file deleted, buffer unavailable) says so and leaves the proposal staged. */
	private async _applySafely(staged: IOnyxStagedFile, keep: (index: number) => boolean): Promise<boolean> {
		try {
			return await this._apply(staged, keep);
		} catch (error) {
			this._notificationService.notify({
				severity: Severity.Error,
				message: localize('onyx.changes.applyFailed', "Could not apply the staged edit to {0}: {1}. The proposal stays staged.", staged.proposal.path, error instanceof Error ? error.message : String(error)),
			});
			return false;
		}
	}

	rejectFile(path: string): void {
		this._remove(path);
	}

	rejectHunk(path: string, hunkIndex: number): void {
		const staged = this._filesObs.get().find(file => file.proposal.path === path);
		if (!staged) {
			return;
		}
		const proposed = applyHunkSelection(staged.proposal.base, staged.hunks, index => index !== hunkIndex);
		const proposal: IOnyxProposedFile = { ...staged.proposal, proposed };
		const hunks = proposalHunks(proposal);
		if (hunks.length === 0) {
			this._remove(path);
			return;
		}
		this._upsert({ ...staged, proposal, hunks });
	}

	async acceptAll(): Promise<number> {
		let applied = 0;
		for (const staged of [...this._filesObs.get()]) {
			if (await this._applySafely(staged, () => true)) {
				applied++;
			}
		}
		return applied;
	}

	rejectAll(): void {
		this._filesObs.set([], undefined);
		this._persist();
	}

	async refresh(): Promise<void> {
		for (const staged of [...this._filesObs.get()]) {
			if (staged.proposal.kind === 'create') {
				continue;
			}
			const uri = this._resolveUri(staged.proposal.path);
			const current = uri ? await this._readCurrentContent(uri) : undefined;
			if (current === undefined) {
				// The file is gone. Keep the proposal (rejecting it is the user's
				// call) but say so, rather than leaving a diff against nothing.
				this._notificationService.notify({
					severity: Severity.Warning,
					message: localize('onyx.changes.fileGone', "{0} no longer exists, so its staged edit cannot be applied. Reject it in Onyx Changes when you are ready.", staged.proposal.path),
				});
				continue;
			}
			if (current === staged.proposal.base) {
				continue;
			}
			const rebased = rebaseProposal(staged.proposal, current);
			const hunks = proposalHunks(rebased.file);
			// A hunk whose anchor vanished is dropped rather than applied in the
			// wrong place — but never silently: that is the whole promise of this
			// surface.
			if (rebased.droppedHunks > 0) {
				this._notificationService.notify({
					severity: Severity.Info,
					message: localize('onyx.changes.rebaseDropped', "{0} changed underneath {1} staged edit(s), so they no longer apply and were dropped. The rest were re-anchored to your current file.", staged.proposal.path, rebased.droppedHunks),
				});
			}
			if (hunks.length === 0) {
				this._remove(staged.proposal.path);
			} else {
				this._upsert({ ...staged, proposal: rebased.file, hunks });
			}
		}
	}

	async openDiff(path: string): Promise<void> {
		const staged = this._filesObs.get().find(file => file.proposal.path === path);
		const uri = this._resolveUri(path);
		if (!staged || !uri) {
			return;
		}
		await this._editorService.openEditor({ resource: uri, options: { preserveFocus: true } });
	}

	/**
	 * Applies the selected hunks to the real buffer. The buffer may have moved
	 * since staging — the proposal is rebased onto its live content first, so
	 * an accept can never blindly overwrite edits the user made meanwhile.
	 */
	private async _apply(staged: IOnyxStagedFile, keep: (index: number) => boolean): Promise<boolean> {
		const uri = this._resolveUri(staged.proposal.path);
		if (!uri) {
			return false;
		}
		if (staged.proposal.kind === 'create') {
			const content = keep(0) || staged.hunks.length === 1 ? staged.proposal.proposed : applyHunkSelection('', staged.hunks, keep);
			await this._fileService.createFile(uri, VSBuffer.fromString(content), { overwrite: false });
			this._remove(staged.proposal.path);
			this._onDidApply.fire({ path: staged.proposal.path });
			await this._editorService.openEditor({ resource: uri, options: { preserveFocus: true } });
			return true;
		}

		const reference = await this._textModelService.createModelReference(uri);
		try {
			const model = reference.object.textEditorModel;
			let proposal = staged.proposal;
			let hunks = staged.hunks;
			const live = model.getValue();
			if (live !== proposal.base) {
				const rebased = rebaseProposal(proposal, live);
				proposal = rebased.file;
				hunks = proposalHunks(proposal);
				if (hunks.length === 0) {
					this._remove(staged.proposal.path);
					return false;
				}
			}
			const edits = hunks
				.filter((_, index) => keep(index))
				.map(hunk => this._hunkToEdit(model, hunk));
			if (edits.length === 0) {
				return false;
			}
			model.pushStackElement();
			model.pushEditOperations(null, edits, () => null);
			model.pushStackElement();

			const remaining = applyHunkSelection(proposal.base, hunks, index => !keep(index));
			const newBase = model.getValue();
			if (remaining === proposal.base) {
				this._remove(staged.proposal.path);
			} else {
				// Rebase what is left onto the buffer as it now stands.
				const rebasedRest = rebaseProposal({ ...proposal, base: proposal.base, proposed: remaining }, newBase);
				const restHunks = proposalHunks(rebasedRest.file);
				if (restHunks.length === 0) {
					this._remove(staged.proposal.path);
				} else {
					this._upsert({ ...staged, proposal: rebasedRest.file, hunks: restHunks });
				}
			}
			this._onDidApply.fire({ path: staged.proposal.path });
			return true;
		} finally {
			reference.dispose();
		}
	}

	private _hunkToEdit(model: ITextModel, hunk: IOnyxEditHunk) {
		const startLine = hunk.originalStart + 1;
		if (hunk.originalLength === 0) {
			// Pure insertion: before the line that follows the insertion point.
			const line = Math.min(startLine, model.getLineCount());
			const insertAtEnd = startLine > model.getLineCount();
			const text = insertAtEnd ? '\n' + hunk.newLines.join('\n') : hunk.newLines.join('\n') + '\n';
			const position = insertAtEnd
				? new Range(model.getLineCount(), model.getLineMaxColumn(model.getLineCount()), model.getLineCount(), model.getLineMaxColumn(model.getLineCount()))
				: new Range(line, 1, line, 1);
			return EditOperation.replace(position, text);
		}
		const endLine = hunk.originalStart + hunk.originalLength;
		const range = new Range(startLine, 1, endLine, model.getLineMaxColumn(endLine));
		return EditOperation.replace(range, hunk.newLines.join('\n'));
	}

	private async _scoreRisk(proposal: IOnyxProposedFile): Promise<void> {
		const resolved = resolveWorkspacePath(this._folderRefs(), proposal.path);
		const folder = resolved ? this._workspaceService.getWorkspace().folders.find(f => f.index === resolved.folderIndex) : undefined;
		if (!folder) {
			return;
		}
		const diff = proposalToUnifiedDiff(proposal);
		// Guard: the collector is instantiated per call; risk is advisory.
		const collector = this._instantiationService.createInstance(OnyxChangeRiskCollector);
		const risks = await collector.collect(folder, diff);
		const risk = risks.find(r => proposal.path.endsWith(r.path)) ?? risks[0];
		if (!risk) {
			return;
		}
		const current = this._filesObs.get().find(file => file.proposal.path === proposal.path);
		if (current) {
			this._upsert({ ...current, risk });
		}
	}

	private _upsert(staged: IOnyxStagedFile): void {
		const files = this._filesObs.get();
		const index = files.findIndex(file => file.proposal.path === staged.proposal.path);
		const next = index >= 0 ? files.map((file, i) => i === index ? staged : file) : [...files, staged];
		this._filesObs.set(next, undefined);
		this._persist();
	}

	private _remove(path: string): void {
		this._filesObs.set(this._filesObs.get().filter(file => file.proposal.path !== path), undefined);
		this._persist();
	}

	private _folderRefs() {
		return this._workspaceService.getWorkspace().folders.map(f => ({ name: f.name, index: f.index }));
	}

	private _resolveUri(path: string): URI | undefined {
		if (path.includes('..') || path.startsWith('/') || path.includes('\\')) {
			return undefined;
		}
		const resolved = resolveWorkspacePath(this._folderRefs(), path);
		if (!resolved) {
			return undefined;
		}
		const folder = this._workspaceService.getWorkspace().folders.find(f => f.index === resolved.folderIndex);
		return folder?.toResource(resolved.relativePath);
	}

	private async _readCurrentContent(uri: URI): Promise<string | undefined> {
		if (!await this._fileService.exists(uri)) {
			return undefined;
		}
		const reference = await this._textModelService.createModelReference(uri);
		try {
			return reference.object.textEditorModel.getValue();
		} finally {
			reference.dispose();
		}
	}
}

/** The user-facing name of the review surface, shared by view, tool text and help. */
export function onyxChangesViewTitle(): string {
	return localize('onyx.changes.title', "Onyx Changes");
}
