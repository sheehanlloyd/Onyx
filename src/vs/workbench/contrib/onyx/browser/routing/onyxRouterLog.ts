/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { IOnyxRouterLogEntry } from '../../common/onyxScorecard.js';
import { OnyxTaskKind, ONYX_VENDOR } from '../../common/onyxTypes.js';
import { IOnyxChangeSetService } from '../changes/onyxChangeSetService.js';
import { IOnyxControlPlaneService } from '../controlPlane/onyxControlPlaneService.js';
import { IOnyxRouterService, IOnyxRoutingDecision } from './onyxRouterService.js';

export const IOnyxRouterLogService = createDecorator<IOnyxRouterLogService>('onyxRouterLogService');

/**
 * A log of what the router picked and what the user then did (L11), kept
 * for this workspace on this machine. Two kinds of entry: a tournament, in
 * which the user picked a winner among models the router would have chosen
 * one of; and a routed run that staged an edit, with whether the user
 * accepted any of it. A scorecard reports the router's hit rate from these,
 * each rate with its denominator. They are logged choices, not a randomized
 * comparison.
 */
export interface IOnyxRouterLogService {
	readonly _serviceBrand: undefined;
	entries(): readonly IOnyxRouterLogEntry[];
	/** Records a tournament: the model the router would have picked among the candidates, and the one the user picked. */
	noteTournament(task: OnyxTaskKind, routerPick: string, tournamentPick: string): void;
}

const STORAGE_KEY = 'onyx.routerLog';
const MAX_ENTRIES = 500;
/** A run that begins within this long of a routing decision for the same model is the run that decision was for. */
const ROUTE_TO_RUN_MS = 2000;

export class OnyxRouterLogService extends Disposable implements IOnyxRouterLogService {

	declare readonly _serviceBrand: undefined;

	private readonly _entries: IOnyxRouterLogEntry[];
	private _lastDecision: { readonly decision: IOnyxRoutingDecision; readonly at: number } | undefined;
	/** Routed runs, and the index of the entry each one has once it has staged an edit. */
	private readonly _routedRuns = new Map<string, { readonly task: string; readonly routerPick: string; entry?: number }>();

	constructor(
		@IOnyxRouterService routerService: IOnyxRouterService,
		@IOnyxControlPlaneService controlPlaneService: IOnyxControlPlaneService,
		@IOnyxChangeSetService changeSetService: IOnyxChangeSetService,
		@IStorageService private readonly _storageService: IStorageService,
	) {
		super();
		this._entries = this._load();
		this._register(routerService.onDidRoute(decision => { this._lastDecision = { decision, at: Date.now() }; }));
		this._register(controlPlaneService.onDidBeginRun(run => {
			const last = this._lastDecision;
			this._lastDecision = undefined;
			if (last && Date.now() - last.at <= ROUTE_TO_RUN_MS && (run.modelKey === last.decision.modelKey || run.modelKey === `${ONYX_VENDOR}:${last.decision.modelKey}`)) {
				this._routedRuns.set(run.runId, { task: last.decision.task, routerPick: last.decision.modelKey });
			}
		}));
		this._register(changeSetService.onDidAttemptStage(attempt => {
			const routed = attempt.runId ? this._routedRuns.get(attempt.runId) : undefined;
			if (routed && attempt.ok && routed.entry === undefined) {
				// The run produced something the user can keep or not: from here on it has an outcome, and until an accept it is "not kept".
				routed.entry = this._entries.push({ task: routed.task, routerPick: routed.routerPick, accepted: false }) - 1;
				this._save();
			}
		}));
		this._register(changeSetService.onDidApply(applied => {
			const routed = applied.runId ? this._routedRuns.get(applied.runId) : undefined;
			if (routed?.entry !== undefined && this._entries[routed.entry]) {
				this._entries[routed.entry] = { ...this._entries[routed.entry], accepted: true };
				this._save();
			}
		}));
	}

	entries(): readonly IOnyxRouterLogEntry[] {
		return [...this._entries];
	}

	noteTournament(task: OnyxTaskKind, routerPick: string, tournamentPick: string): void {
		this._entries.push({ task, routerPick, tournamentPick });
		this._save();
	}

	private _load(): IOnyxRouterLogEntry[] {
		try {
			const stored: unknown = JSON.parse(this._storageService.get(STORAGE_KEY, StorageScope.WORKSPACE) ?? '[]');
			if (!Array.isArray(stored)) {
				return [];
			}
			return stored.flatMap((entry: Partial<IOnyxRouterLogEntry> | null) => entry && typeof entry.task === 'string' && typeof entry.routerPick === 'string'
				? [{ task: entry.task, routerPick: entry.routerPick, ...(typeof entry.tournamentPick === 'string' ? { tournamentPick: entry.tournamentPick } : {}), ...(typeof entry.accepted === 'boolean' ? { accepted: entry.accepted } : {}) }]
				: []);
		} catch {
			return [];
		}
	}

	private _save(): void {
		if (this._entries.length > MAX_ENTRIES) {
			const dropped = this._entries.length - MAX_ENTRIES;
			this._entries.splice(0, dropped);
			for (const routed of this._routedRuns.values()) {
				routed.entry = routed.entry === undefined || routed.entry < dropped ? undefined : routed.entry - dropped;
			}
		}
		this._storageService.store(STORAGE_KEY, JSON.stringify(this._entries), StorageScope.WORKSPACE, StorageTarget.MACHINE);
	}
}
