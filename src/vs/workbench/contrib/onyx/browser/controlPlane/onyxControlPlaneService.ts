/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { derived, IObservable, ISettableObservable, observableValue } from '../../../../../base/common/observable.js';
import { URI } from '../../../../../base/common/uri.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { IOnyxBudgetSlice, IOnyxRunEvent, OnyxRunStatus, OnyxTaskKind } from '../../common/onyxTypes.js';

export const IOnyxControlPlaneService = createDecorator<IOnyxControlPlaneService>('onyxControlPlaneService');

/** Live compute readout for the most recent / current request. */
export interface IOnyxComputeState {
	readonly endpoint: string | undefined;
	readonly modelKey: string | undefined;
	readonly tokensPerSecond: number | undefined;
	readonly timeToFirstTokenMs: number | undefined;
	readonly inFlight: boolean;
	/** A cold model is being loaded; cleared by the first streamed token. */
	readonly loadingModel?: boolean;
}

/** One entry in a run's activity timeline, as shown in the control plane. */
export interface IOnyxActivityEntry {
	readonly at: number;
	readonly kind: 'turn' | 'toolCall' | 'toolResult' | 'route' | 'note' | 'steer';
	readonly label: string;
	/** Why the agent did this — routing reasons, tool intent, etc. */
	readonly reason?: string;
	readonly ok?: boolean;
	/**
	 * Where in the workspace this entry points, if anywhere. Stored as a
	 * workspace-relative path (not a URI) so it survives the run journal and
	 * still resolves after the workspace moves.
	 */
	readonly location?: { readonly path: string; readonly line: number };
}

export interface IOnyxLiveRun {
	readonly runId: string;
	readonly sessionResource: URI;
	readonly requestId: string;
	readonly title: string;
	readonly task: OnyxTaskKind;
	readonly modelKey: string;
	readonly startedAt: number;
	readonly status: IObservable<OnyxRunStatus>;
	readonly activity: IObservable<readonly IOnyxActivityEntry[]>;
	readonly contextBudget: IObservable<readonly IOnyxBudgetSlice[]>;
	readonly turnCount: IObservable<number>;
}

/** Handle given to the agent loop for one run; the loop reports through it and honors its gates. */
export interface IOnyxRunHandle {
	readonly runId: string;
	activity(entry: Omit<IOnyxActivityEntry, 'at'>): void;
	/** Records journal-only data (e.g. the exact wire request) without adding a visible timeline entry. */
	snapshot(data: unknown): void;
	setContextBudget(slices: readonly IOnyxBudgetSlice[]): void;
	setTurnCount(count: number): void;
	/**
	 * Called between loop iterations. Resolves when the run may continue —
	 * immediately when running, after resume when paused — and returns any
	 * steering messages the user injected meanwhile. Returns `undefined`
	 * when the run was stopped.
	 */
	gate(): Promise<{ steerMessages: readonly string[] } | undefined>;
	complete(status: Extract<OnyxRunStatus, 'completed' | 'failed' | 'cancelled'>): void;
}

/**
 * The live model behind the Onyx control plane: every agent run registers here,
 * views observe it, and pause/stop/redirect flow back to the loop through the
 * run handle's gate. Journal persistence subscribes to {@link onDidRecordEvent}.
 */
export interface IOnyxControlPlaneService {
	readonly _serviceBrand: undefined;

	readonly runs: IObservable<readonly IOnyxLiveRun[]>;
	readonly compute: IObservable<IOnyxComputeState>;
	/** The run the control plane views focus on: user-selected, or the most recent. */
	readonly selectedRun: IObservable<IOnyxLiveRun | undefined>;
	readonly onDidBeginRun: Event<IOnyxLiveRun>;
	readonly onDidRecordEvent: Event<{ readonly runId: string; readonly event: IOnyxRunEvent }>;

	beginRun(info: { sessionResource: URI; requestId: string; title: string; task: OnyxTaskKind; modelKey: string }): IOnyxRunHandle;
	getRun(runId: string): IOnyxLiveRun | undefined;
	selectRun(runId: string | undefined): void;
	updateCompute(state: Partial<IOnyxComputeState>): void;

	pause(runId: string): void;
	resume(runId: string): void;
	stop(runId: string): void;
	/** Injects a steering instruction the loop picks up at its next gate. */
	redirect(runId: string, instruction: string): void;
}

const MAX_RETAINED_RUNS = 50;

class LiveRun implements IOnyxLiveRun {

	readonly startedAt = Date.now();
	readonly statusObs: ISettableObservable<OnyxRunStatus> = observableValue(this, 'running');
	readonly activityObs: ISettableObservable<readonly IOnyxActivityEntry[]> = observableValue(this, []);
	readonly contextBudgetObs: ISettableObservable<readonly IOnyxBudgetSlice[]> = observableValue(this, []);
	readonly turnCountObs: ISettableObservable<number> = observableValue(this, 0);

	pendingSteer: string[] = [];
	resumeGate: (() => void) | undefined;

	constructor(
		readonly runId: string,
		readonly sessionResource: URI,
		readonly requestId: string,
		readonly title: string,
		readonly task: OnyxTaskKind,
		readonly modelKey: string,
	) { }

	get status(): IObservable<OnyxRunStatus> { return this.statusObs; }
	get activity(): IObservable<readonly IOnyxActivityEntry[]> { return this.activityObs; }
	get contextBudget(): IObservable<readonly IOnyxBudgetSlice[]> { return this.contextBudgetObs; }
	get turnCount(): IObservable<number> { return this.turnCountObs; }
}

export class OnyxControlPlaneService extends Disposable implements IOnyxControlPlaneService {

	declare readonly _serviceBrand: undefined;

	private readonly _runsObs: ISettableObservable<readonly IOnyxLiveRun[]> = observableValue(this, []);
	readonly runs: IObservable<readonly IOnyxLiveRun[]> = this._runsObs;

	private readonly _computeObs: ISettableObservable<IOnyxComputeState> = observableValue(this, { endpoint: undefined, modelKey: undefined, tokensPerSecond: undefined, timeToFirstTokenMs: undefined, inFlight: false });
	readonly compute: IObservable<IOnyxComputeState> = this._computeObs;

	private readonly _onDidBeginRun = this._register(new Emitter<IOnyxLiveRun>());
	readonly onDidBeginRun = this._onDidBeginRun.event;

	private readonly _onDidRecordEvent = this._register(new Emitter<{ runId: string; event: IOnyxRunEvent }>());
	readonly onDidRecordEvent = this._onDidRecordEvent.event;

	private readonly _liveRuns = new Map<string, LiveRun>();
	private _runCounter = 0;

	private readonly _selectedRunId: ISettableObservable<string | undefined> = observableValue(this, undefined);
	readonly selectedRun: IObservable<IOnyxLiveRun | undefined> = derived(reader => {
		const selectedId = this._selectedRunId.read(reader);
		const runs = this._runsObs.read(reader);
		return (selectedId !== undefined ? runs.find(r => r.runId === selectedId) : undefined) ?? runs[0];
	});

	selectRun(runId: string | undefined): void {
		this._selectedRunId.set(runId, undefined);
	}

	beginRun(info: { sessionResource: URI; requestId: string; title: string; task: OnyxTaskKind; modelKey: string }): IOnyxRunHandle {
		const runId = `run-${Date.now()}-${this._runCounter++}`;
		const run = new LiveRun(runId, info.sessionResource, info.requestId, info.title, info.task, info.modelKey);
		this._liveRuns.set(runId, run);
		const retained = [run, ...this._runsObs.get()].slice(0, MAX_RETAINED_RUNS);
		this._runsObs.set(retained, undefined);
		this._onDidBeginRun.fire(run);

		const service = this;
		return {
			runId,
			activity(entry) {
				const full = { ...entry, at: Date.now() };
				run.activityObs.set([...run.activityObs.get(), full], undefined);
				service._onDidRecordEvent.fire({ runId, event: { t: full.at - run.startedAt, kind: entryKindToEventKind(full.kind), data: full } });
			},
			snapshot(data) {
				service._onDidRecordEvent.fire({ runId, event: { t: Date.now() - run.startedAt, kind: 'promptSnapshot', data } });
			},
			setContextBudget(slices) {
				run.contextBudgetObs.set(slices, undefined);
			},
			setTurnCount(count) {
				run.turnCountObs.set(count, undefined);
			},
			async gate() {
				if (run.statusObs.get() === 'cancelled') {
					return undefined;
				}
				if (run.statusObs.get() === 'paused') {
					await new Promise<void>(resolve => { run.resumeGate = resolve; });
					if (run.statusObs.get() === 'cancelled') {
						return undefined;
					}
				}
				const steerMessages = run.pendingSteer;
				run.pendingSteer = [];
				return { steerMessages };
			},
			complete(status) {
				run.statusObs.set(status, undefined);
				run.resumeGate?.();
				service._onDidRecordEvent.fire({ runId, event: { t: Date.now() - run.startedAt, kind: 'outcome', data: { status } } });
			},
		};
	}

	getRun(runId: string): IOnyxLiveRun | undefined {
		return this._liveRuns.get(runId);
	}

	updateCompute(state: Partial<IOnyxComputeState>): void {
		this._computeObs.set({ ...this._computeObs.get(), ...state }, undefined);
	}

	pause(runId: string): void {
		const run = this._liveRuns.get(runId);
		if (run && run.statusObs.get() === 'running') {
			run.statusObs.set('paused', undefined);
		}
	}

	resume(runId: string): void {
		const run = this._liveRuns.get(runId);
		if (run && run.statusObs.get() === 'paused') {
			run.statusObs.set('running', undefined);
			run.resumeGate?.();
			run.resumeGate = undefined;
		}
	}

	stop(runId: string): void {
		const run = this._liveRuns.get(runId);
		if (run && (run.statusObs.get() === 'running' || run.statusObs.get() === 'paused')) {
			run.statusObs.set('cancelled', undefined);
			run.resumeGate?.();
			run.resumeGate = undefined;
		}
	}

	redirect(runId: string, instruction: string): void {
		const run = this._liveRuns.get(runId);
		if (run) {
			run.pendingSteer.push(instruction);
		}
	}
}

function entryKindToEventKind(kind: IOnyxActivityEntry['kind']): IOnyxRunEvent['kind'] {
	switch (kind) {
		case 'toolCall': return 'toolCall';
		case 'toolResult': return 'toolResult';
		case 'turn': return 'turn';
		default: return 'note';
	}
}
