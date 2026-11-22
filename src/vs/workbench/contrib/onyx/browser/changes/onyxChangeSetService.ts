/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../../../base/common/buffer.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { IObservable, ISettableObservable, observableValue } from '../../../../../base/common/observable.js';
import { URI } from '../../../../../base/common/uri.js';
import { EditOperation, ISingleEditOperation } from '../../../../../editor/common/core/editOperation.js';
import { Range } from '../../../../../editor/common/core/range.js';
import { EndOfLinePreference, ITextModel } from '../../../../../editor/common/model.js';
import { ITextModelService } from '../../../../../editor/common/services/resolverService.js';
import { localize } from '../../../../../nls.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { createDecorator, IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { INotificationService, Severity } from '../../../../../platform/notification/common/notification.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import {
	acceptReviewHunks, applyHunkSelection, ONYX_PROPOSAL_SCHEME, IOnyxHunkConflict, IOnyxProposedFile, IOnyxReview, IOnyxReviewHunk, OnyxProposeResult, openReview, proposalToUnifiedDiff, proposeEdits, rebaseReview, rejectReviewHunk, reviewProposed, summarizeChangeSet
} from '../../common/onyxChangeSet.js';
import { traceDigest } from '../../common/onyxTrace.js';
import { IOnyxChangeRisk } from '../../common/onyxChangeRisk.js';
import { certificateForHunk, certifiedEdit, certifyEdit, IOnyxCertifiedEdit, IOnyxCertifyInput, IOnyxEditCertificate, IOnyxPromptEvidence } from '../../common/onyxEditCertificate.js';
import { countOccurrences, IOnyxEditBlock, IOnyxEditHunk, placeEditBlock } from '../../common/onyxInlineEdit.js';
import { decodeNumberedSearch, replacementCarriesNumbering } from '../../common/onyxReadTools.js';
import { resolveWorkspacePath, workspacePathProblem } from '../../common/onyxWorkspacePaths.js';
import { OnyxChangeRiskCollector } from '../intelligence/onyxChangeRiskCollector.js';
import { IOnyxWorkspaceAccessService } from '../intelligence/onyxWorkspaceAccess.js';
import { IOnyxControlPlaneService } from '../controlPlane/onyxControlPlaneService.js';

export const IOnyxChangeSetService = createDecorator<IOnyxChangeSetService>('onyxChangeSetService');

const STAGED_STORAGE_KEY = 'onyx.changes.staged';
/** The last proposal generation given out in this workspace, so that one after a reload never repeats an id from before it. */
const GENERATION_STORAGE_KEY = 'onyx.changes.generation';

/** One staged file plus everything the review surface shows about it. */
export interface IOnyxStagedFile {
	readonly proposal: IOnyxProposedFile;
	/** The hunks under review, each with an id that does not change while this generation lasts (B7). */
	readonly hunks: readonly IOnyxReviewHunk[];
	/** Hunks that no longer correspond to the buffer: shown with both texts, never applied. */
	readonly conflicts: readonly IOnyxHunkConflict[];
	/** Which staging of this file the hunks belong to. A later one replaces every id. */
	readonly generation: number;
	/** What the proposal was computed against: the text model's version when it was read, and a digest of its content. */
	readonly baseVersion: { readonly versionId: number | undefined; readonly contentHash: string };
	readonly risk: IOnyxChangeRisk | undefined;
	/** The run that most recently staged into this file, for the timeline link. */
	readonly runId: string | undefined;
	/** The edits the proposal was built from, each with its certificate (L6), oldest first. Empty for a proposal restored from before certificates were kept. */
	readonly edits: readonly IOnyxCertifiedEdit[];
}

/** Where a staged edit came from, for its certificate (L6). */
export interface IOnyxEditOrigin {
	/** The id of the tool call that carried the edit. */
	readonly call?: string;
	/** For a whole proposal: an inline edit of the user's selection, or a whole-file result. */
	readonly protocol?: 'inline' | 'whole-file';
}

export type OnyxStageOutcome =
	| { readonly ok: true; readonly summary: string }
	| { readonly ok: false; readonly error: string };

export interface IOnyxAppliedEvent {
	readonly path: string;
	readonly generation: number;
	readonly runId: string | undefined;
}

/** What an accept came to. `applied: false` always has the reason the user is shown. */
export type OnyxAcceptOutcome =
	| { readonly applied: true }
	| { readonly applied: false; readonly reason: 'review-changed' | 'conflict' | 'not-staged' | 'failed'; readonly message: string };

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
	/** Fires just before an accept changes a file: the last moment at which the file is as it was (C2). */
	readonly onWillApply: Event<{ readonly path: string }>;
	/** Fires when an accept has changed a file: which proposal generation the accepted hunks belonged to, and the run that staged them. */
	readonly onDidApply: Event<IOnyxAppliedEvent>;
	/** Stages SEARCH/REPLACE blocks for a workspace-qualified path. Never edits the buffer. */
	stage(path: string, blocks: readonly IOnyxEditBlock[], runId?: string, origin?: IOnyxEditOrigin): Promise<OnyxStageOutcome>;
	/**
	 * What a run's model is being sent in the turn that is starting, after
	 * eviction (L6): the edits that turn stages are certified against it.
	 * `undefined` when the run is over.
	 */
	setPromptEvidence(runId: string, evidence: IOnyxPromptEvidence | undefined): void;
	/** The certificate of the edit a staged hunk came from, or undefined when none is on record for it. */
	certificateFor(path: string, hunkId: string): IOnyxEditCertificate | undefined;
	/**
	 * Stages complete proposed content for a path (the refactor engine's entry:
	 * language services compute whole-file results). Replaces any existing
	 * proposal for the file. Never edits the buffer.
	 */
	stageProposal(path: string, proposedContent: string, runId?: string, origin?: IOnyxEditOrigin): Promise<OnyxStageOutcome>;
	acceptFile(path: string): Promise<OnyxAcceptOutcome>;
	rejectFile(path: string): void;
	/**
	 * Accepts one hunk by the id it was shown with (B7); the rest stay
	 * staged. When the buffer has changed the proposal is carried onto it
	 * first, and when the hunk is no longer there under that id the accept
	 * is refused and the review is refreshed: nothing else is applied in
	 * its place.
	 */
	acceptHunk(path: string, hunkId: string): Promise<OnyxAcceptOutcome>;
	/** Drops one hunk, or one conflict, by id. */
	rejectHunk(path: string, hunkId: string): void;
	acceptAll(): Promise<number>;
	rejectAll(): void;
	/** Re-checks every staged file against its live buffer, rebasing stale proposals. */
	refresh(): Promise<void>;
	/**
	 * Opens the proposal for review in a diff editor (C1): the file as it
	 * is on the left, the proposal on the right, in a document no editor
	 * can write to. A proposed new file has nothing to compare with and
	 * opens as that document alone.
	 */
	openDiff(path: string): Promise<void>;
	/** The file a change-set path names, when it is inside the workspace. */
	fileUri(path: string): URI | undefined;
}

/** What the user is told when what they reviewed is no longer what would be applied. */
function reviewChangedMessage(path: string): string {
	return localize('onyx.changes.reviewChanged', "The review of {0} changed; look again. Nothing was applied.", path);
}

export class OnyxChangeSetService extends Disposable implements IOnyxChangeSetService {

	declare readonly _serviceBrand: undefined;

	private readonly _filesObs: ISettableObservable<readonly IOnyxStagedFile[]> = observableValue(this, []);
	readonly files: IObservable<readonly IOnyxStagedFile[]> = this._filesObs;

	private readonly _onWillApply = this._register(new Emitter<{ path: string }>());
	readonly onWillApply = this._onWillApply.event;

	private readonly _onDidApply = this._register(new Emitter<IOnyxAppliedEvent>());
	readonly onDidApply = this._onDidApply.event;

	/** The last generation given out. Every staging of a file takes the next one. */
	private _generation = 0;

	/** What each live run's model was sent in its current turn (L6). */
	private readonly _promptEvidence = new Map<string, IOnyxPromptEvidence>();

	constructor(
		@IWorkspaceContextService private readonly _workspaceService: IWorkspaceContextService,
		@ITextModelService private readonly _textModelService: ITextModelService,
		@IFileService private readonly _fileService: IFileService,
		@IEditorService private readonly _editorService: IEditorService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@IStorageService private readonly _storageService: IStorageService,
		@INotificationService private readonly _notificationService: INotificationService,
		@IOnyxControlPlaneService private readonly _controlPlaneService: IOnyxControlPlaneService,
		@IOnyxWorkspaceAccessService private readonly _workspaceAccessService: IOnyxWorkspaceAccessService,
	) {
		super();
		// Staged edits survive a crash: restore them marked stale, so the next
		// look at the view rebases each proposal against today's buffers and
		// shows (with both texts, never silently) whatever no longer applies.
		// A restored proposal is a new generation: no earlier review of it holds.
		this._generation = this._storageService.getNumber(GENERATION_STORAGE_KEY, StorageScope.WORKSPACE, 0);
		try {
			const persisted: (IOnyxProposedFile & { edits?: readonly IOnyxCertifiedEdit[] })[] = JSON.parse(this._storageService.get(STAGED_STORAGE_KEY, StorageScope.WORKSPACE, '[]'));
			if (Array.isArray(persisted) && persisted.length > 0) {
				const restored: IOnyxStagedFile[] = [];
				for (const proposal of persisted) {
					if (typeof proposal?.path !== 'string' || typeof proposal.base !== 'string' || typeof proposal.proposed !== 'string') {
						continue;
					}
					// Refused before it is diffed when it is over the size a proposal is reviewed at (R-38).
					const opened = openReview(proposal.base, proposal.proposed, ++this._generation);
					if (!opened.ok) {
						this._notificationService.notify({ severity: Severity.Warning, message: localize('onyx.changes.restoreTooLarge', "A stored proposal for {0} was not restored: {1}. Your file was never changed by it.", proposal.path, opened.error) });
						continue;
					}
					const { edits, ...stored } = proposal;
					restored.push({ edits: Array.isArray(edits) ? edits : [], proposal: { ...stored, stale: true }, hunks: opened.review.hunks, conflicts: [], generation: opened.review.generation, baseVersion: { versionId: undefined, contentHash: traceDigest(proposal.base) }, risk: undefined, runId: undefined });
				}
				this._filesObs.set(restored, undefined);
			}
		} catch {
			// corrupt storage: start with an empty change set
		}
		this._register(this._storageService.onWillSaveState(() => this._persist()));
	}

	private _persist(): void {
		// A proposal is stored with the certificates of its edits: they hold digests and counts, no text.
		const proposals = this._filesObs.get().map(file => ({ ...file.proposal, edits: file.edits }));
		this._storageService.store(GENERATION_STORAGE_KEY, this._generation, StorageScope.WORKSPACE, StorageTarget.MACHINE);
		if (proposals.length === 0) {
			this._storageService.remove(STAGED_STORAGE_KEY, StorageScope.WORKSPACE);
		} else {
			this._storageService.store(STAGED_STORAGE_KEY, JSON.stringify(proposals), StorageScope.WORKSPACE, StorageTarget.MACHINE);
		}
	}

	setPromptEvidence(runId: string, evidence: IOnyxPromptEvidence | undefined): void {
		if (evidence) {
			this._promptEvidence.set(runId, evidence);
		} else {
			this._promptEvidence.delete(runId);
		}
	}

	certificateFor(path: string, hunkId: string): IOnyxEditCertificate | undefined {
		const staged = this._filesObs.get().find(file => file.proposal.path === path);
		const hunk = staged?.hunks.find(candidate => candidate.id === hunkId);
		return staged && hunk ? certificateForHunk(staged.edits, hunk) : undefined;
	}

	/** The certificate of one edit (L6). */
	protected _certifyEdit(input: IOnyxCertifyInput): IOnyxEditCertificate {
		return certifyEdit(input);
	}

	/**
	 * Certifies the edits of one staging (L6) and writes each certificate
	 * into the run's journal with the hunks it accounts for.
	 */
	private _certify(staged: IOnyxStagedFile, edits: readonly IOnyxCertifiedEdit[]): IOnyxStagedFile {
		const certified: IOnyxStagedFile = { ...staged, edits: [...staged.edits, ...edits] };
		if (staged.runId) {
			for (const edit of edits) {
				const hunks = certified.hunks.filter(hunk => certificateForHunk(certified.edits, hunk) === edit.certificate).map(hunk => hunk.id);
				this._controlPlaneService.recordTrace(staged.runId, { kind: 'editCertificate', certificate: edit.certificate, seal: edit.seal, generation: certified.generation, hunks });
			}
		}
		return certified;
	}

	async stage(path: string, blocks: readonly IOnyxEditBlock[], runId?: string, origin?: IOnyxEditOrigin): Promise<OnyxStageOutcome> {
		const uri = this._resolveUri(path);
		if (!uri) {
			return { ok: false, error: `Path "${path}" is not inside the workspace.` };
		}
		if (await this._leavesWorkspace(uri)) {
			return { ok: false, error: `Edit refused for ${path}: it resolves to a location outside the workspace through a symbolic link. Nothing was staged.` };
		}
		const existing = this._filesObs.get().find(file => file.proposal.path === path);
		const read = await this._readCurrent(uri);
		const current = existing ? undefined : read?.content;
		// R-24: SEARCH text copied from a numbered readFile result is decoded
		// only when it is provably that result (the exact text is tried
		// first); anything shaped like one that is not the file is refused.
		const sent = blocks;
		const decoded = decodeNumberedBlocks(blocks, existing ? read?.content : current, existing?.proposal.proposed);
		if (!decoded.ok) {
			return { ok: false, error: decoded.error };
		}
		blocks = decoded.blocks;
		const result = this._propose(existing?.proposal, path, existing ? existing.proposal.base : current, blocks);
		if (!result.ok) {
			return { ok: false, error: result.error };
		}
		// A new generation: the proposed content changed, so every hunk is named afresh and an older review
		// of this file can no longer be accepted (B7). A proposal too large to diff is refused here, before
		// the diff, and whatever was staged before stays as it was (R-38).
		const opened = this._openReview(result.file.base, result.file.proposed, this._generation + 1);
		if (!opened.ok) {
			return { ok: false, error: `Edit refused for ${path}: ${opened.error}. Nothing was staged${existing ? '; the edits already staged for the file are unchanged' : ''}. Make a smaller edit.` };
		}
		this._generation++;
		if (opened.review.hunks.length === 0) {
			this._remove(path);
			return { ok: true, summary: `No change left for ${path}: the edits cancel out. Nothing is staged.` };
		}
		const staged: IOnyxStagedFile = {
			proposal: result.file, hunks: opened.review.hunks, conflicts: [], generation: opened.review.generation,
			baseVersion: existing?.baseVersion ?? { versionId: read?.versionId, contentHash: traceDigest(result.file.base) },
			risk: existing?.risk, runId: runId ?? existing?.runId, edits: existing?.edits ?? [],
		};
		// One certificate an edit (L6): what it was placed against, how often its quoted text was there, and
		// whether the model had been shown that text in the turn that sent it.
		const evidence = runId ? this._promptEvidence.get(runId) : undefined;
		let placedAgainst = existing ? existing.proposal.proposed : current ?? '';
		const edits = blocks.map((block, index) => {
			const certificate = this._certifyEdit({
				path, protocol: result.file.kind === 'create' && !existing ? 'new-file' : blocks.length > 1 ? 'multi-edit' : 'search-replace',
				call: origin?.call ?? null, block: index, base: placedAgainst, baseVersionId: staged.baseVersion.versionId ?? null,
				search: sent[index].search, matchCount: countOccurrences(placedAgainst, block.search), evidence,
			});
			// What ties the edit to hunks is the whole lines it touched: a quote may begin in the middle of a line.
			const at = placedAgainst.indexOf(block.search);
			const placed = placeEditBlock(placedAgainst, block);
			const touched = certificate.anchor && placed.ok && at >= 0
				? { removed: wholeLines(placedAgainst, at, block.search.length), added: wholeLines(placed.text, at, block.replace.length) }
				: undefined;
			placedAgainst = placed.ok ? placed.text : placedAgainst;
			return certifiedEdit(certificate, touched?.removed, touched?.added);
		});
		this._upsert(this._certify(staged, edits));
		this._scoreRisk(staged.proposal).catch(() => { /* risk stays unknown */ });
		const summary = summarizeChangeSet([result.file]);
		return {
			ok: true,
			summary: `Staged ${result.appliedCount} edit(s) to ${path} (+${summary.addedLines} −${summary.removedLines}). The user reviews them in Onyx Changes before anything is applied — do not re-apply the same edit.`,
		};
	}

	/** Opens a generation for a proposal, refusing one that is over the size a proposal is reviewed at (B7, R-38). */
	protected _openReview(base: string, proposed: string, generation: number): ReturnType<typeof openReview> {
		return openReview(base, proposed, generation);
	}

	/** Places a tool call's blocks: exactly, and exactly once, or not at all (B6, DEC-07). */
	protected _propose(existing: IOnyxProposedFile | undefined, path: string, currentContent: string | undefined, blocks: readonly IOnyxEditBlock[]): OnyxProposeResult {
		return proposeEdits(existing, path, currentContent, blocks);
	}

	async stageProposal(path: string, proposedContent: string, runId?: string, origin?: IOnyxEditOrigin): Promise<OnyxStageOutcome> {
		const uri = this._resolveUri(path);
		if (!uri) {
			return { ok: false, error: `Path "${path}" is not inside the workspace.` };
		}
		if (await this._leavesWorkspace(uri)) {
			return { ok: false, error: `Proposal refused for ${path}: it resolves to a location outside the workspace through a symbolic link. Nothing was staged.` };
		}
		const read = await this._readCurrent(uri);
		const proposal: IOnyxProposedFile = read === undefined
			? { path, kind: 'create', base: '', proposed: proposedContent, stale: false }
			: { path, kind: 'modify', base: read.content, proposed: proposedContent, stale: false };
		const opened = this._openReview(proposal.base, proposal.proposed, this._generation + 1);
		if (!opened.ok) {
			return { ok: false, error: `Proposal refused for ${path}: ${opened.error}. Nothing was staged, and anything already staged for the file is unchanged.` };
		}
		this._generation++;
		if (opened.review.hunks.length === 0) {
			this._remove(path);
			return { ok: true, summary: `No change for ${path}.` };
		}
		const staged: IOnyxStagedFile = { proposal, hunks: opened.review.hunks, conflicts: [], generation: opened.review.generation, baseVersion: { versionId: read?.versionId, contentHash: traceDigest(proposal.base) }, risk: undefined, runId, edits: [] };
		// The whole proposal is one edit without an anchor: the user's own selection, or a whole-file result (L6).
		const certificate = certifyEdit({ path, protocol: read === undefined ? 'new-file' : origin?.protocol ?? 'whole-file', call: origin?.call ?? null, block: 0, base: proposal.base, baseVersionId: read?.versionId ?? null, search: undefined, matchCount: 0, evidence: runId ? this._promptEvidence.get(runId) : undefined });
		this._upsert(this._certify(staged, [certifiedEdit(certificate, undefined, undefined)]));
		this._scoreRisk(proposal).catch(() => { /* risk stays unknown */ });
		const summary = summarizeChangeSet([proposal]);
		return { ok: true, summary: `Staged ${path} (+${summary.addedLines} −${summary.removedLines}).` };
	}

	async acceptFile(path: string): Promise<OnyxAcceptOutcome> {
		const staged = this._filesObs.get().find(file => file.proposal.path === path);
		if (!staged) {
			return { applied: false, reason: 'not-staged', message: reviewChangedMessage(path) };
		}
		return this._applySafely(staged, undefined);
	}

	async acceptHunk(path: string, hunkId: string): Promise<OnyxAcceptOutcome> {
		const staged = this._filesObs.get().find(file => file.proposal.path === path);
		// The id names a hunk of one generation. One that is not among the hunks now staged was reviewed
		// before the proposal changed, or has become a conflict: nothing is applied in its place.
		if (!staged || !staged.hunks.some(hunk => hunk.id === hunkId)) {
			return this._refuse(path, staged?.conflicts.some(conflict => conflict.id === hunkId) ? 'conflict' : staged ? 'review-changed' : 'not-staged');
		}
		return this._applySafely(staged, hunkId);
	}

	private _refuse(path: string, reason: 'review-changed' | 'conflict' | 'not-staged'): OnyxAcceptOutcome {
		const message = reviewChangedMessage(path);
		this._notificationService.notify({ severity: Severity.Warning, message });
		return { applied: false, reason, message };
	}

	/** An accept that cannot land (file deleted, buffer unavailable) says so and leaves the proposal staged. */
	private async _applySafely(staged: IOnyxStagedFile, hunkId: string | undefined): Promise<OnyxAcceptOutcome> {
		try {
			const outcome = await this._apply(staged, hunkId);
			if (outcome.applied && staged.runId) {
				this._controlPlaneService.recordAcceptance(staged.runId, { path: staged.proposal.path, hunk: hunkId ?? 'all' });
			}
			return outcome;
		} catch (error) {
			const message = localize('onyx.changes.applyFailed', "Could not apply the staged edit to {0}: {1}. The proposal stays staged.", staged.proposal.path, error instanceof Error ? error.message : String(error));
			this._notificationService.notify({ severity: Severity.Error, message });
			return { applied: false, reason: 'failed', message };
		}
	}

	rejectFile(path: string): void {
		this._remove(path);
	}

	rejectHunk(path: string, hunkId: string): void {
		const staged = this._filesObs.get().find(file => file.proposal.path === path);
		if (!staged) {
			return;
		}
		const review = rejectReviewHunk({ generation: staged.generation, hunks: staged.hunks, conflicts: staged.conflicts }, hunkId);
		this._keepReview(staged, staged.proposal.base, review);
	}

	/** Puts a review back as the staged state of its file, or removes the file when nothing of it is left. */
	private _keepReview(staged: IOnyxStagedFile, base: string, review: IOnyxReview, baseVersionId?: number): void {
		if (review.hunks.length === 0 && review.conflicts.length === 0) {
			this._remove(staged.proposal.path);
			return;
		}
		this._upsert({
			...staged,
			proposal: { ...staged.proposal, base, proposed: reviewProposed(base, review.hunks), stale: false },
			hunks: review.hunks, conflicts: review.conflicts,
			baseVersion: base === staged.proposal.base ? staged.baseVersion : { versionId: baseVersionId, contentHash: traceDigest(base) },
		});
	}

	/** Says, once for a rebase, which hunks stopped corresponding. They stay on show as conflicts. */
	private _reportConflicts(path: string, before: number, review: IOnyxReview): void {
		const added = review.conflicts.length - before;
		if (added > 0) {
			this._notificationService.notify({
				severity: Severity.Warning,
				message: localize('onyx.changes.rebaseConflicts', "{0} changed underneath {1} staged edit(s). They no longer correspond to the file exactly and at one place, so they are shown as conflicts with both texts and will not be applied. The rest were carried over to your current file.", path, added),
			});
		}
	}

	async acceptAll(): Promise<number> {
		let applied = 0;
		for (const staged of [...this._filesObs.get()]) {
			if ((await this._applySafely(staged, undefined)).applied) {
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
			const read = uri ? await this._readCurrent(uri) : undefined;
			if (read === undefined) {
				// The file is gone. Keep the proposal (rejecting it is the user's
				// call) but say so, rather than leaving a diff against nothing.
				this._notificationService.notify({
					severity: Severity.Warning,
					message: localize('onyx.changes.fileGone', "{0} no longer exists, so its staged edit cannot be applied. Reject it in Onyx Changes when you are ready.", staged.proposal.path),
				});
				continue;
			}
			if (read.content === staged.proposal.base) {
				continue;
			}
			// A hunk that no longer corresponds becomes a conflict rather than being applied in the wrong
			// place — and never silently: that is the whole promise of this surface.
			const review = rebaseReview({ generation: staged.generation, hunks: staged.hunks, conflicts: staged.conflicts }, staged.proposal.base, read.content);
			this._reportConflicts(staged.proposal.path, staged.conflicts.length, review);
			this._keepReview(staged, read.content, review, read.versionId);
		}
	}

	async openDiff(path: string): Promise<void> {
		const staged = this._filesObs.get().find(file => file.proposal.path === path);
		const uri = this._resolveUri(path);
		if (!staged || !uri) {
			return;
		}
		const proposal = URI.from({ scheme: ONYX_PROPOSAL_SCHEME, path: `/${path}` });
		if (staged.proposal.kind === 'create') {
			await this._editorService.openEditor({ resource: proposal, label: localize('onyx.changes.newFileLabel', "{0} (proposed new file)", path), options: { pinned: true } });
			return;
		}
		// A diff editor (C1): the file as it is on the left, the proposal on the right. The proposal is a
		// document of its own that no editor can write to; the file is not touched by being looked at.
		await this._editorService.openEditor({
			original: { resource: uri },
			modified: { resource: proposal },
			label: localize('onyx.changes.diffLabel', "{0} ↔ Onyx proposal", path),
			options: { pinned: true },
		});
	}

	/**
	 * Applies one hunk, or every hunk, to the real buffer. The buffer may
	 * have moved since staging — the review is carried onto its live content
	 * first, so an accept can never blindly overwrite edits the user made
	 * meanwhile. The proposal generation and the hunk's id are checked again
	 * immediately before the edit, against the state as it is then (B7).
	 */
	private async _apply(shown: IOnyxStagedFile, hunkId: string | undefined): Promise<OnyxAcceptOutcome> {
		const path = shown.proposal.path;
		const uri = this._resolveUri(path);
		if (!uri) {
			return { applied: false, reason: 'failed', message: localize('onyx.changes.outside', "{0} is not inside the workspace.", path) };
		}
		// The file system may have changed since the proposal was staged: what would be written is checked now.
		if (await this._leavesWorkspace(uri)) {
			return { applied: false, reason: 'failed', message: localize('onyx.changes.leavesWorkspace', "{0} now resolves to a location outside the workspace through a symbolic link. Nothing was applied.", path) };
		}
		if (shown.proposal.kind === 'create') {
			const content = hunkId === undefined || shown.hunks.length === 1 ? shown.proposal.proposed : applyHunkSelection('', shown.hunks, index => shown.hunks[index].id === hunkId);
			this._onWillApply.fire({ path });
			await this._fileService.createFile(uri, VSBuffer.fromString(content), { overwrite: false });
			this._remove(path);
			this._onDidApply.fire({ path, generation: shown.generation, runId: shown.runId });
			await this._editorService.openEditor({ resource: uri, options: { preserveFocus: true } });
			return { applied: true };
		}
		const reference = await this._textModelService.createModelReference(uri);
		try {
			const model = reference.object.textEditorModel;
			// What is staged now, not what was staged when the user clicked: a newer generation may have
			// arrived while the model was being resolved.
			const staged = this._filesObs.get().find(file => file.proposal.path === path);
			if (!staged || staged.generation !== shown.generation) {
				return this._refuse(path, staged ? 'review-changed' : 'not-staged');
			}
			let review: IOnyxReview = { generation: staged.generation, hunks: staged.hunks, conflicts: staged.conflicts };
			let base = staged.proposal.base;
			const live = model.getValue(EndOfLinePreference.LF);
			if (live !== base) {
				review = rebaseReview(review, base, live);
				base = live;
				this._reportConflicts(path, staged.conflicts.length, review);
				// The review on show is the rebased one from here on, whatever happens next.
				this._keepReview(staged, base, review, model.getVersionId());
			}
			const wanted = (id: string) => hunkId === undefined || id === hunkId;
			const accepted = review.hunks.filter(hunk => wanted(hunk.id));
			if (accepted.length === 0) {
				// The hunk the user accepted did not survive the rebase: nothing else is applied in its place.
				return this._refuse(path, review.conflicts.some(conflict => conflict.id === hunkId) ? 'conflict' : 'review-changed');
			}
			if (hunkId === undefined && review.conflicts.length > 0) {
				// "Accept the file" means what was shown. With a conflict among it, part of that cannot be applied.
				return this._refuse(path, 'conflict');
			}
			this._onWillApply.fire({ path });
			model.pushStackElement();
			model.pushEditOperations(null, accepted.map(hunk => this._hunkToEdit(model, hunk)), () => null);
			model.pushStackElement();

			const rest = acceptReviewHunks(review, base, wanted);
			const newBase = model.getValue(EndOfLinePreference.LF);
			// The buffer is the old one with the accepted hunks applied, and the hunks that remain have moved by
			// what those added or removed. Should the buffer be anything else, they are found again by context.
			const remaining = newBase === rest.base ? rest.review : rebaseReview(rest.review, rest.base, newBase);
			const current = this._filesObs.get().find(file => file.proposal.path === path) ?? staged;
			this._keepReview(current, newBase, remaining, model.getVersionId());
			this._onDidApply.fire({ path, generation: staged.generation, runId: staged.runId });
			return { applied: true };
		} finally {
			reference.dispose();
		}
	}

	/**
	 * One hunk as a text-model edit (B8, R-13). A hunk is whole lines, so the
	 * edit is too, and a line that goes takes its line break with it:
	 *
	 * - a replacement covers its lines and nothing of their neighbours;
	 * - a deletion runs from the start of its first line to the start of the
	 *   line after its last, so no empty line is left behind;
	 * - a deletion that reaches the end of the buffer has no line after it,
	 *   and takes the line break before its first line instead;
	 * - an insertion goes before the line it precedes with a break after it,
	 *   or after the last line with a break before it.
	 *
	 * The text is joined with `\n`; the text model writes its own line
	 * endings, so a CRLF file stays CRLF.
	 */
	protected _hunkToEdit(model: ITextModel, hunk: IOnyxEditHunk): ISingleEditOperation {
		const lineCount = model.getLineCount();
		const startLine = hunk.originalStart + 1;
		if (hunk.originalLength === 0) {
			if (startLine > lineCount) {
				const end = model.getLineMaxColumn(lineCount);
				return EditOperation.replace(new Range(lineCount, end, lineCount, end), '\n' + hunk.newLines.join('\n'));
			}
			return EditOperation.replace(new Range(startLine, 1, startLine, 1), hunk.newLines.join('\n') + '\n');
		}
		const endLine = hunk.originalStart + hunk.originalLength;
		if (hunk.newLines.length > 0) {
			return EditOperation.replace(new Range(startLine, 1, endLine, model.getLineMaxColumn(endLine)), hunk.newLines.join('\n'));
		}
		if (endLine < lineCount) {
			return EditOperation.replace(new Range(startLine, 1, endLine + 1, 1), '');
		}
		if (startLine > 1) {
			return EditOperation.replace(new Range(startLine - 1, model.getLineMaxColumn(startLine - 1), endLine, model.getLineMaxColumn(endLine)), '');
		}
		// Every line of the buffer.
		return EditOperation.replace(new Range(1, 1, endLine, model.getLineMaxColumn(endLine)), '');
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

	fileUri(path: string): URI | undefined {
		return this._resolveUri(path);
	}

	/**
	 * The file a proposal's path names, or undefined when the path may not
	 * be used: the same rule as the read side (R-30). Absolute paths, a
	 * parent-directory segment and backslashes are refused before anything
	 * is resolved; a name that merely contains two dots is a name (C10).
	 */
	private _resolveUri(path: string): URI | undefined {
		if (!path || workspacePathProblem(path)) {
			return undefined;
		}
		const resolved = resolveWorkspacePath(this._folderRefs(), path);
		if (!resolved) {
			return undefined;
		}
		const folder = this._workspaceService.getWorkspace().folders.find(f => f.index === resolved.folderIndex);
		return folder?.toResource(resolved.relativePath);
	}

	/**
	 * Whether writing the file would leave the workspace through a symbolic
	 * link (R-30, write side, I-07): the file is a link out, or it would be
	 * created inside a directory that is one. Asked when a proposal is
	 * staged and again right before it is applied.
	 */
	protected async _leavesWorkspace(uri: URI): Promise<boolean> {
		return !await this._workspaceAccessService.isContainedForWrite(uri);
	}

	/**
	 * The file as lines joined by `\n`, whatever its own line endings are,
	 * and the text model's version at that moment. Proposals are computed
	 * and matched in that form, and applied through the text model, which
	 * keeps the file's line endings: they are never rewritten to make a
	 * SEARCH text match (B6), and a SEARCH text that carries a carriage
	 * return matches nothing.
	 */
	private async _readCurrent(uri: URI): Promise<{ readonly content: string; readonly versionId: number } | undefined> {
		if (!await this._fileService.exists(uri)) {
			return undefined;
		}
		const reference = await this._textModelService.createModelReference(uri);
		try {
			const model = reference.object.textEditorModel;
			return { content: model.getValue(EndOfLinePreference.LF), versionId: model.getVersionId() };
		} finally {
			reference.dispose();
		}
	}
}

/**
 * Applies R-24 to each block. `liveText` is the file as `readFile` shows it
 * (what a copied line number refers to); `stagedText` is the proposal the
 * block will be matched against when the file already has one.
 */
function decodeNumberedBlocks(blocks: readonly IOnyxEditBlock[], liveText: string | undefined, stagedText: string | undefined): { ok: true; blocks: readonly IOnyxEditBlock[] } | { ok: false; error: string } {
	if (liveText === undefined) {
		return { ok: true, blocks };
	}
	const out: IOnyxEditBlock[] = [];
	for (const block of blocks) {
		if (stagedText !== undefined && block.search !== '' && stagedText.includes(block.search)) {
			out.push(block); // exact against the text it will be matched with
			continue;
		}
		const decoding = decodeNumberedSearch(block.search, liveText);
		if (decoding.kind === 'refused') {
			return { ok: false, error: `Edit refused: ${decoding.reason}` };
		}
		if (decoding.kind === 'decoded') {
			if (replacementCarriesNumbering(block.replace, decoding.startLine)) {
				return { ok: false, error: 'Edit refused: the replacement text carries readFile line numbers ("N| "). They are not part of the file; send the replacement lines without them.' };
			}
			out.push({ ...block, search: decoding.text });
			continue;
		}
		out.push(block);
	}
	return { ok: true, blocks: out };
}

/** The lines of `text` that the span of `length` characters at `start` touches, whole. */
function wholeLines(text: string, start: number, length: number): string {
	const from = text.lastIndexOf('\n', start - 1) + 1;
	const end = text.indexOf('\n', start + length);
	return text.slice(from, end < 0 ? text.length : end);
}

/** The user-facing name of the review surface, shared by view, tool text and help. */
export function onyxChangesViewTitle(): string {
	return localize('onyx.changes.title', "Onyx Changes");
}
