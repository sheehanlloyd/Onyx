/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RunOnceScheduler } from '../../../../../base/common/async.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { IObservable, ISettableObservable, observableValue } from '../../../../../base/common/observable.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { addOutcome, addSample, emptyLedgerEntry, IOnyxLedgerEntry, mergeLedgers } from '../../common/onyxLedger.js';
import { IOnyxModelService } from '../model/onyxLanguageModelProvider.js';

export const IOnyxLedgerService = createDecorator<IOnyxLedgerService>('onyxLedgerService');

/**
 * Compute is the local cost, so it gets a ledger. Every request the provider
 * measures lands here twice: once in a session view that resets when the
 * window does, and once in an all-time total that persists on this machine.
 */
export interface IOnyxLedgerService {
	readonly _serviceBrand: undefined;
	/** Totals since this window opened. */
	readonly session: IObservable<readonly IOnyxLedgerEntry[]>;
	/** Session totals folded into everything recorded before it. */
	readonly allTime: IObservable<readonly IOnyxLedgerEntry[]>;
	/** Records the user's verdict on a response, so accept rate can be shown per model. */
	reportOutcome(modelKey: string, accepted: boolean): void;
	/** Forgets all-time totals. The session view keeps running. */
	clear(): void;
}

const STORAGE_KEY = 'onyx.ledger.allTime';
const FLUSH_DELAY_MS = 5_000;

export class OnyxLedgerService extends Disposable implements IOnyxLedgerService {

	declare readonly _serviceBrand: undefined;

	private readonly _sessionObs: ISettableObservable<readonly IOnyxLedgerEntry[]> = observableValue(this, []);
	readonly session: IObservable<readonly IOnyxLedgerEntry[]> = this._sessionObs;

	private readonly _allTimeObs: ISettableObservable<readonly IOnyxLedgerEntry[]> = observableValue(this, []);
	readonly allTime: IObservable<readonly IOnyxLedgerEntry[]> = this._allTimeObs;

	/** What was on disk when the window opened; the session is folded on top of it for display. */
	private _persisted: readonly IOnyxLedgerEntry[] = [];
	private readonly _flush: RunOnceScheduler;

	constructor(
		@IStorageService private readonly _storageService: IStorageService,
		@IOnyxModelService modelService: IOnyxModelService,
	) {
		super();
		this._persisted = this._load();
		this._allTimeObs.set(this._persisted, undefined);

		this._flush = this._register(new RunOnceScheduler(() => this._save(), FLUSH_DELAY_MS));

		this._register(modelService.onDidMeasureRequest(measurement => {
			const parameterB = modelService.getKnownModel(measurement.modelKey)?.profile.parameterB;
			this._update(measurement.modelKey, entry => addSample(entry, {
				modelKey: measurement.modelKey,
				promptTokens: measurement.promptTokens,
				completionTokens: measurement.completionTokens,
				generationMs: measurement.generationMs,
				timeToFirstTokenMs: measurement.timeToFirstTokenMs,
				failed: !!measurement.errorMessage,
				parameterB,
			}));
		}));
	}

	reportOutcome(modelKey: string, accepted: boolean): void {
		this._update(modelKey, entry => addOutcome(entry, accepted));
	}

	clear(): void {
		this._persisted = [];
		this._storageService.remove(STORAGE_KEY, StorageScope.APPLICATION);
		this._allTimeObs.set(mergeLedgers(this._persisted, this._sessionObs.get()), undefined);
	}

	private _update(modelKey: string, apply: (entry: IOnyxLedgerEntry) => IOnyxLedgerEntry): void {
		const session = [...this._sessionObs.get()];
		const index = session.findIndex(entry => entry.modelKey === modelKey);
		const updated = apply(index >= 0 ? session[index] : emptyLedgerEntry(modelKey));
		if (index >= 0) {
			session[index] = updated;
		} else {
			session.push(updated);
		}
		this._sessionObs.set(session, undefined);
		this._allTimeObs.set(mergeLedgers(this._persisted, session), undefined);
		this._flush.schedule();
	}

	private _load(): readonly IOnyxLedgerEntry[] {
		const raw = this._storageService.get(STORAGE_KEY, StorageScope.APPLICATION);
		if (!raw) {
			return [];
		}
		try {
			const parsed = JSON.parse(raw);
			return Array.isArray(parsed) ? parsed.filter((entry: IOnyxLedgerEntry) => typeof entry?.modelKey === 'string') : [];
		} catch {
			return [];
		}
	}

	private _save(): void {
		// Persisting the merged total (not the session) keeps the stored value
		// correct even if the window is closed without another flush.
		this._storageService.store(STORAGE_KEY, JSON.stringify(this._allTimeObs.get()), StorageScope.APPLICATION, StorageTarget.MACHINE);
	}
}
