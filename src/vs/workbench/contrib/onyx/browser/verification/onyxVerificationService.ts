/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableMap, DisposableStore, IDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { IObservable, ISettableObservable, autorun, observableValue } from '../../../../../base/common/observable.js';
import { isEqual } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { EndOfLinePreference } from '../../../../../editor/common/model.js';
import { IModelService } from '../../../../../editor/common/services/model.js';
import { IInstantiationService, createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { IMarker, IMarkerService, MarkerSeverity } from '../../../../../platform/markers/common/markers.js';
import { ITextFileService } from '../../../../services/textfile/common/textfiles.js';
import { traceDigest } from '../../common/onyxTrace.js';
import { describeVerification, diffProblems, IOnyxCheckOutcome, IOnyxProblem, IOnyxVerificationResult, ONYX_VERIFICATION_TIMING } from '../../common/onyxVerification.js';
import { IOnyxChangeSetService, IOnyxStagedFile } from '../changes/onyxChangeSetService.js';
import { IOnyxControlPlaneService } from '../controlPlane/onyxControlPlaneService.js';
import { OnyxTaskVerification } from './onyxTaskVerification.js';

export const IOnyxVerificationService = createDecorator<IOnyxVerificationService>('onyxVerificationService');

/**
 * Verification of what was accepted (C2, R-21). Nothing is verified while a
 * proposal is only staged: the file does not hold it. When a hunk is
 * accepted, the diagnostics of the file as it then is are awaited and
 * compared, problem by problem, with those from just before the acceptance.
 * Agent edits, inline edits and refactors are all accepted through the change
 * set, so this is the one path for all of them.
 */
export interface IOnyxVerificationService {
	readonly _serviceBrand: undefined;
	/** One result a file: the latest staging or acceptance of it. */
	readonly results: IObservable<readonly IOnyxVerificationResult[]>;
	resultFor(path: string): IOnyxVerificationResult | undefined;
}

export class OnyxVerificationService extends Disposable implements IOnyxVerificationService {

	declare readonly _serviceBrand: undefined;

	private readonly _resultsObs: ISettableObservable<readonly IOnyxVerificationResult[]> = observableValue(this, []);
	readonly results: IObservable<readonly IOnyxVerificationResult[]> = this._resultsObs;

	/** The problems of a file just before an acceptance changed it. */
	private readonly _before = new Map<string, readonly IOnyxProblem[]>();
	/** What is still going on for a file: the wait for diagnostics, the watch for a later change, the wait for a save. */
	private readonly _watches = this._register(new DisposableMap<string, IDisposable>());

	constructor(
		@IOnyxChangeSetService private readonly _changeSetService: IOnyxChangeSetService,
		@IMarkerService private readonly _markerService: IMarkerService,
		@IModelService private readonly _modelService: IModelService,
		@ITextFileService private readonly _textFileService: ITextFileService,
		@IOnyxControlPlaneService private readonly _controlPlaneService: IOnyxControlPlaneService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
	) {
		super();
		// Staged and not accepted: there is nothing to verify, and the result says so.
		this._register(autorun(reader => this._followStaging(this._changeSetService.files.read(reader))));
		this._register(this._changeSetService.onWillApply(({ path }) => {
			const uri = this._changeSetService.fileUri(path);
			// What a later change to the file means is decided anew by this acceptance.
			this._watches.deleteAndDispose(path);
			this._before.set(path, uri ? this._problems(path, uri) : []);
		}));
		this._register(this._changeSetService.onDidApply(({ path, generation, runId }) => this._verify(path, generation, runId)));
	}

	/**
	 * Keeps "not applied" true. A file with staged changes and no acceptance
	 * says so; a proposal that was rejected whole leaves nothing behind.
	 * The results are this service's own state, read as it is: the staging
	 * is what this follows.
	 */
	private _followStaging(staged: readonly IOnyxStagedFile[]): void {
		for (const file of staged) {
			const current = this.resultFor(file.proposal.path);
			if (!current || (current.generation !== file.generation && current.state !== 'running')) {
				this._set({ path: file.proposal.path, generation: file.generation, state: 'not applied', contentHash: null, stagedHunksLeft: file.hunks.length, diff: null, check: null });
			} else if (current.stagedHunksLeft !== file.hunks.length) {
				this._set({ ...current, stagedHunksLeft: file.hunks.length });
			}
		}
		// An acceptance whose proposal has nothing staged any more is no longer partial.
		for (const result of this._resultsObs.get()) {
			if (result.stagedHunksLeft > 0 && !staged.some(file => file.proposal.path === result.path)) {
				this._set({ ...result, stagedHunksLeft: 0 });
			}
		}
		const kept = this._resultsObs.get().filter(result => result.state !== 'not applied' || staged.some(file => file.proposal.path === result.path));
		if (kept.length !== this._resultsObs.get().length) {
			this._resultsObs.set(kept, undefined);
		}
	}

	resultFor(path: string): IOnyxVerificationResult | undefined {
		return this._resultsObs.get().find(result => result.path === path);
	}

	private _stagedHunksLeft(path: string): number {
		return this._changeSetService.files.get().find(file => file.proposal.path === path)?.hunks.length ?? 0;
	}

	private _set(result: IOnyxVerificationResult): void {
		this._resultsObs.set([...this._resultsObs.get().filter(other => other.path !== result.path), result], undefined);
	}

	private _problems(path: string, uri: URI): IOnyxProblem[] {
		return this._markerService.read({ resource: uri, severities: MarkerSeverity.Error | MarkerSeverity.Warning }).map((marker: IMarker) => ({
			path,
			severity: marker.severity === MarkerSeverity.Error ? 'error' as const : 'warning' as const,
			source: marker.source ?? marker.owner,
			code: typeof marker.code === 'string' ? marker.code : marker.code?.value ?? '',
			message: marker.message,
			line: marker.startLineNumber,
		}));
	}

	private _contentHash(uri: URI): string | null {
		const model = this._modelService.getModel(uri);
		return model ? traceDigest(model.getValue(EndOfLinePreference.LF)) : null;
	}

	/**
	 * An acceptance just changed the file. Fresh diagnostics for it are
	 * awaited: the first report for the file starts a short settling time,
	 * and when that passes the problems are compared with those from before
	 * the acceptance. If no report arrives in time, nothing is known and the
	 * result says so. If the file changes meanwhile or afterwards, the
	 * result is about content that is gone, and says that.
	 */
	private _verify(path: string, generation: number, runId: string | undefined): void {
		const uri = this._changeSetService.fileUri(path);
		if (!uri) {
			return;
		}
		const before = this._before.get(path) ?? [];
		const contentHash = this._contentHash(uri);
		const store = new DisposableStore();
		this._watches.set(path, store);
		let result: IOnyxVerificationResult = { path, generation, state: 'running', contentHash, stagedHunksLeft: 0, diff: null, check: null };
		const publish = (next: IOnyxVerificationResult, announce: boolean) => {
			// How much of the proposal is still staged is read when the result is published, not when the acceptance began.
			result = { ...next, stagedHunksLeft: this._stagedHunksLeft(path) };
			this._set(result);
			if (announce && runId) {
				this._controlPlaneService.appendActivity(runId, { kind: 'note', label: describeVerification(result), ok: result.state === 'verified' ? true : result.state === 'new problems' ? false : undefined, location: { path, line: result.diff?.introduced[0]?.line ?? 1 } });
			}
		};
		publish(result, false);

		let settle: ReturnType<typeof setTimeout> | undefined;
		const giveUp = setTimeout(() => finish('timed out'), ONYX_VERIFICATION_TIMING.refreshTimeoutMs);
		const waiting = new DisposableStore();
		store.add(waiting);
		waiting.add(toDisposable(() => { clearTimeout(giveUp); clearTimeout(settle); }));
		const finish = (state: 'compare' | 'timed out') => {
			waiting.dispose();
			if (state === 'timed out') {
				publish({ ...result, state: 'timed out' }, true);
			} else {
				const diff = diffProblems(before, this._problems(path, uri));
				publish({ ...result, state: diff.introduced.length > 0 ? 'new problems' : 'verified', diff }, true);
			}
			this._runCheck(path, uri, runId, store, () => result, next => publish(next, false));
		};
		waiting.add(this._markerService.onMarkerChanged(resources => {
			if (resources.some(resource => isEqual(resource, uri))) {
				clearTimeout(settle);
				settle = setTimeout(() => finish('compare'), ONYX_VERIFICATION_TIMING.settleMs);
			}
		}));
		// The file changing after the acceptance: whatever is known, or was about to be, is about other content.
		const model = this._modelService.getModel(uri);
		if (model) {
			store.add(model.onDidChangeContent(() => {
				if (this._contentHash(uri) !== contentHash) {
					store.dispose();
					publish({ ...result, state: 'stale' }, true);
				}
			}));
		}
	}

	/**
	 * The project check, when one is configured. It reads the disk, so it
	 * runs only on an accepted file that is saved: Onyx does not save for
	 * the user, and says which file is unsaved instead. When the user saves
	 * it, the check runs then, on what was saved.
	 */
	private _runCheck(path: string, uri: URI, runId: string | undefined, store: DisposableStore, current: () => IOnyxVerificationResult, publish: (result: IOnyxVerificationResult) => void): void {
		const check = this._instantiationService.createInstance(OnyxTaskVerification);
		if (!check.enabled || !runId) {
			return;
		}
		const note = (label: string, ok: boolean | undefined) => this._controlPlaneService.appendActivity(runId, { kind: 'note', label, ok, location: { path, line: 1 } });
		const run = async () => {
			const savedHash = this._contentHash(uri);
			const outcome: IOnyxCheckOutcome = await check.run(runId, note, [{ path, contentHash: savedHash ?? '' }]);
			if (current().contentHash === savedHash) {
				publish({ ...current(), check: outcome });
			}
		};
		if (!this._textFileService.isDirty(uri)) {
			run();
			return;
		}
		publish({ ...current(), check: { kind: 'not run', reason: 'unsaved', unsavedFiles: [path] } });
		note(`Checks not run: ${path} has unsaved changes, and the check reads the saved file. Save it to run the check on what you accepted`, undefined);
		store.add(this._textFileService.files.onDidSave(event => {
			if (isEqual(event.model.resource, uri)) {
				run();
			}
		}));
	}
}
