/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../../base/common/event.js';
import { CancellationToken, CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { derived, IObservable, ISettableObservable, observableValue } from '../../../../../base/common/observable.js';
import { URI } from '../../../../../base/common/uri.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { IOnyxTraceCertificate, IOnyxTraceCertificateOutcome } from '../../common/onyxEditCertificate.js';
import { IOnyxTraceAcceptance, IOnyxTraceApproval, IOnyxTraceHeader, IOnyxTraceTurn } from '../../common/onyxTrace.js';
import { describeNoteOrigin, IOnyxContextText, IOnyxRunText, OnyxContextSource, OnyxNoteOrigin } from '../../common/onyxMemoryOrigin.js';
import { IOnyxBudgetSlice, IOnyxRunEvent, isTerminalRunStatus, ONYX_RUN_BUDGET, OnyxRunStatus, OnyxTaskKind, OnyxTerminalRunStatus } from '../../common/onyxTypes.js';

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
	/** Records a trace v2 header or turn (L3): journal-only, no timeline entry. */
	record(data: IOnyxTraceHeader | IOnyxTraceTurn): void;
	setContextBudget(slices: readonly IOnyxBudgetSlice[]): void;
	setTurnCount(count: number): void;
	/** Records what a tool returned to the model in this run, so a later question about where some text came from can be answered (I-14). */
	noteToolResult(tool: string, text: string): void;
	/** Records workspace text the run's prompt carries besides the request (D11): remembered notes, the playbook index. */
	noteContext(source: OnyxContextSource, text: string): void;
	/**
	 * Called between loop iterations. Resolves when the run may continue —
	 * immediately when running, after resume when paused — and returns any
	 * steering messages the user injected meanwhile. Returns `undefined`
	 * when the run was stopped.
	 */
	gate(): Promise<{ steerMessages: readonly string[] } | undefined>;
	/**
	 * Ends the run. The first terminal status a run reaches is its status:
	 * a later call, or a call after Stop, changes nothing (B10, I-03).
	 */
	complete(status: OnyxTerminalRunStatus): void;
	/**
	 * Cancelled when the run is stopped, when the request it began with is
	 * cancelled, or when the run ends any other way than by completing
	 * (B10). Everything the run owns takes this token: inference, every tool
	 * invocation, approval dialogs and child commands.
	 */
	readonly token: CancellationToken;
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

	/** `request` is the user's whole message, kept so a later origin question can be answered (I-14); `title` is its start. */
	/** `token`: the cancellation of the request the run begins with; the run's own token is cancelled with it (B10). */
	beginRun(info: { sessionResource: URI; requestId: string; title: string; task: OnyxTaskKind; modelKey: string; request?: string; token?: CancellationToken }): IOnyxRunHandle;
	getRun(runId: string): IOnyxLiveRun | undefined;
	/**
	 * Appends a timeline entry to a live run from outside its loop — tools
	 * that stream progress (the terminal tool's output) report through this.
	 */
	appendActivity(runId: string, entry: Omit<IOnyxActivityEntry, 'at'>): void;
	/** Writes one record into a live run's journal on behalf of a service that does not own the run: an edit certificate (L6), what became of it. An acceptance usually comes after its run has ended; the record is still written, as an activity is. */
	recordTrace(runId: string, data: IOnyxTraceCertificate | IOnyxTraceCertificateOutcome): void;
	selectRun(runId: string | undefined): void;
	updateCompute(state: Partial<IOnyxComputeState>): void;
	/** The terminal service records every approval decision with its source (L3, I-02). */
	recordApproval(runId: string, approval: Omit<IOnyxTraceApproval, 'kind'>): void;
	/** Where a piece of text came from, as far as this run can tell: the user's request, a tool result, or the model itself (I-14). */
	originOf(runId: string, text: string): OnyxNoteOrigin;
	/** The change set service records every accepted hunk or file (L3, I-09). */
	recordAcceptance(runId: string, acceptance: Omit<IOnyxTraceAcceptance, 'kind'>): void;

	pause(runId: string): void;
	resume(runId: string): void;
	stop(runId: string): void;
	/** Injects a steering instruction the loop picks up at its next gate. */
	redirect(runId: string, instruction: string): void;
}

const MAX_RETAINED_RUNS = 50;
/** How many tool results, and how much of each, a run keeps for origin questions. */
const MAX_ORIGIN_TEXTS = 32;
const MAX_ORIGIN_TEXT_CHARS = 64 * 1024;

/** A run as the control plane holds it while it is live. Exported for the service's subclasses; nothing else builds one. */
export class OnyxLiveRun implements IOnyxLiveRun {

	readonly startedAt = Date.now();
	readonly statusObs: ISettableObservable<OnyxRunStatus> = observableValue(this, 'running');
	readonly activityObs: ISettableObservable<readonly IOnyxActivityEntry[]> = observableValue(this, []);
	readonly contextBudgetObs: ISettableObservable<readonly IOnyxBudgetSlice[]> = observableValue(this, []);
	readonly turnCountObs: ISettableObservable<number> = observableValue(this, 0);

	pendingSteer: string[] = [];
	resumeGate: (() => void) | undefined;
	/** The run's own cancellation, linked to the request it began with. */
	readonly cancellation: CancellationTokenSource;
	/** What ends with the run: the watch on the request's token, a pause's time budget. */
	readonly listeners = new DisposableStore();
	/** What tools returned to the model in this run, newest last, bounded. */
	readonly toolResults: IOnyxRunText[] = [];
	readonly contextTexts: IOnyxContextText[] = [];

	constructor(
		readonly runId: string,
		readonly sessionResource: URI,
		readonly requestId: string,
		readonly title: string,
		readonly task: OnyxTaskKind,
		readonly modelKey: string,
		/** The user's whole request; `title` is its first line, cut. */
		readonly request: string,
		parentToken: CancellationToken | undefined,
	) {
		this.cancellation = new CancellationTokenSource(parentToken);
	}

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

	protected readonly _onDidRecordEvent = this._register(new Emitter<{ runId: string; event: IOnyxRunEvent }>());
	readonly onDidRecordEvent = this._onDidRecordEvent.event;

	private readonly _liveRuns = new Map<string, OnyxLiveRun>();
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

	beginRun(info: { sessionResource: URI; requestId: string; title: string; task: OnyxTaskKind; modelKey: string; request?: string; token?: CancellationToken }): IOnyxRunHandle {
		const runId = `run-${Date.now()}-${this._runCounter++}`;
		const run = new OnyxLiveRun(runId, info.sessionResource, info.requestId, info.title, info.task, info.modelKey, info.request ?? info.title, info.token);
		// The request being cancelled (the chat's own stop button) ends the run as Stop does.
		if (info.token) {
			run.listeners.add(info.token.onCancellationRequested(() => this._finish(run, 'cancelled')));
		}
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
			record(data) {
				service._onDidRecordEvent.fire({ runId, event: { t: Date.now() - run.startedAt, kind: data.kind, data } });
			},
			setContextBudget(slices) {
				run.contextBudgetObs.set(slices, undefined);
			},
			setTurnCount(count) {
				run.turnCountObs.set(count, undefined);
			},
			noteToolResult(tool, text) {
				run.toolResults.push({ tool, text: text.length > MAX_ORIGIN_TEXT_CHARS ? text.slice(0, MAX_ORIGIN_TEXT_CHARS) : text });
				if (run.toolResults.length > MAX_ORIGIN_TEXTS) {
					run.toolResults.shift();
				}
			},
			noteContext(source, text) {
				run.contextTexts.push({ source, text: text.length > MAX_ORIGIN_TEXT_CHARS ? text.slice(0, MAX_ORIGIN_TEXT_CHARS) : text });
				if (run.contextTexts.length > MAX_ORIGIN_TEXTS) {
					run.contextTexts.shift();
				}
			},
			async gate() {
				if (isTerminalRunStatus(run.statusObs.get())) {
					return undefined;
				}
				if (run.statusObs.get() === 'paused') {
					// A pause waits for the user, and not for ever: left alone it ends the run, and says which way (I-03).
					const budget = setTimeout(() => service._finish(run, 'budget-exhausted'), service._pauseBudgetMs());
					try {
						await new Promise<void>(resolve => { run.resumeGate = resolve; });
					} finally {
						clearTimeout(budget);
					}
					if (isTerminalRunStatus(run.statusObs.get())) {
						return undefined;
					}
				}
				const steerMessages = run.pendingSteer;
				run.pendingSteer = [];
				return { steerMessages };
			},
			complete(status) {
				service._finish(run, status);
			},
			token: run.cancellation.token,
		};
	}

	getRun(runId: string): IOnyxLiveRun | undefined {
		return this._liveRuns.get(runId);
	}

	recordTrace(runId: string, data: IOnyxTraceCertificate | IOnyxTraceCertificateOutcome): void {
		const run = this._liveRuns.get(runId);
		if (run) {
			this._onDidRecordEvent.fire({ runId, event: { t: Date.now() - run.startedAt, kind: data.kind, data } });
		}
	}

	appendActivity(runId: string, entry: Omit<IOnyxActivityEntry, 'at'>): void {
		const run = this._liveRuns.get(runId);
		if (!run) {
			return;
		}
		const full = { ...entry, at: Date.now() };
		run.activityObs.set([...run.activityObs.get(), full], undefined);
		this._onDidRecordEvent.fire({ runId, event: { t: full.at - run.startedAt, kind: entryKindToEventKind(full.kind), data: full } });
	}

	updateCompute(state: Partial<IOnyxComputeState>): void {
		this._computeObs.set({ ...this._computeObs.get(), ...state }, undefined);
	}

	recordApproval(runId: string, approval: Omit<IOnyxTraceApproval, 'kind'>): void {
		const run = this._liveRuns.get(runId);
		if (run) {
			this._onDidRecordEvent.fire({ runId, event: { t: Date.now() - run.startedAt, kind: 'approval', data: { kind: 'approval', ...approval } } });
		}
	}

	originOf(runId: string, text: string): OnyxNoteOrigin {
		const run = this._liveRuns.get(runId);
		return run ? describeNoteOrigin(text, run.request, run.toolResults, run.contextTexts) : { kind: 'model' };
	}

	recordAcceptance(runId: string, acceptance: Omit<IOnyxTraceAcceptance, 'kind'>): void {
		const run = this._liveRuns.get(runId);
		if (run) {
			this._onDidRecordEvent.fire({ runId, event: { t: Date.now() - run.startedAt, kind: 'acceptance', data: { kind: 'acceptance', ...acceptance } } });
		}
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

	override dispose(): void {
		// A run that is still live when the window goes owns a token and listeners; they go with it.
		for (const run of this._liveRuns.values()) {
			run.listeners.dispose();
			run.cancellation.dispose(true);
		}
		super.dispose();
	}

	/** How long a paused run waits for the user before it ends as `budget-exhausted`. */
	protected _pauseBudgetMs(): number {
		return ONYX_RUN_BUDGET.pausedMs;
	}

	stop(runId: string): void {
		const run = this._liveRuns.get(runId);
		if (run) {
			this._finish(run, 'cancelled');
		}
	}

	/**
	 * Ends a run (B10). The first terminal status is the run's status and
	 * the only outcome its journal holds; a later attempt to end it another
	 * way changes nothing. Ending in any way but completing cancels what
	 * the run owns: the model request in flight, a tool that is running, a
	 * dialog that is open, a child command.
	 */
	protected _finish(run: OnyxLiveRun, status: OnyxTerminalRunStatus): void {
		if (isTerminalRunStatus(run.statusObs.get())) {
			return;
		}
		run.statusObs.set(status, undefined);
		this._onDidRecordEvent.fire({ runId: run.runId, event: { t: Date.now() - run.startedAt, kind: 'outcome', data: { status } } });
		if (status !== 'completed') {
			run.cancellation.cancel();
		}
		run.listeners.dispose();
		run.cancellation.dispose();
		run.resumeGate?.();
		run.resumeGate = undefined;
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
