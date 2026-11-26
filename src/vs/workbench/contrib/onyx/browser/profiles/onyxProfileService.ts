/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RunOnceScheduler } from '../../../../../base/common/async.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { IOnyxDiscoveredModel } from '../../../../../platform/onyxRuntime/common/onyxRuntime.js';
import { applyDatasheet } from '../../common/onyxDatasheet.js';
import { benchRoutingDataForCurrentMetric, ONYX_BENCH_METRIC } from '../../common/onyxRepoBench.js';
import { seedProfile } from '../../common/onyxSeedProfiles.js';
import { IOnyxModelProfile, IOnyxObservedStats } from '../../common/onyxTypes.js';
import { IOnyxRequestMeasurement } from '../model/onyxLanguageModelProvider.js';
import { IOnyxContextAllocationService } from '../models/onyxContextAllocationService.js';
import { IOnyxDatasheetService } from '../models/onyxDatasheetService.js';

export const IOnyxProfileService = createDecorator<IOnyxProfileService>('onyxProfileService');

/**
 * The learning half of the harness: keeps per-model rolling statistics measured
 * on this machine and merges them (together with user overrides) into the seed
 * profile. Everything is stored locally under machine-scoped storage — nothing
 * syncs, nothing leaves the device.
 */
export interface IOnyxProfileService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeProfiles: Event<void>;
	getProfile(modelKey: string, discovered: IOnyxDiscoveredModel): IOnyxModelProfile;
	getStats(modelKey: string): IOnyxObservedStats | undefined;
	reportMeasurement(measurement: IOnyxRequestMeasurement): void;
	/** Records the user's verdict on a response (kept edits / thumbs up = accepted). */
	reportOutcome(modelKey: string, accepted: boolean): void;
	/** Records the end-to-end latency of one inline (FIM) completion. */
	reportFimMeasurement(modelKey: string, latencyMs: number): void;
	setOverride(modelKey: string, patch: Partial<IOnyxModelProfile>): void;
	/** Records whether one grammar-constrained turn produced a valid envelope. */
	reportConstrainedOutcome(modelKey: string, ok: boolean): void;
	/**
	 * Records that the runtime rejected a request of about `observedTokens`
	 * as too long (B13). The model's context is budgeted at no more than that
	 * from then on, until it is measured (L5) or the record is cleared.
	 */
	reportContextOverflow(modelKey: string, observedTokens: number): void;
	/** Records one on-your-repo benchmark score (0..1) for a task kind. */
	reportBenchScore(modelKey: string, taskKind: string, score: number): void;
	/** Everything measured and overridden, for the diagnostics bundle. */
	exportAll(): { stats: Record<string, IOnyxObservedStats>; overrides: Record<string, Partial<IOnyxModelProfile>> };
}

const STATS_STORAGE_KEY = 'onyx.profiles.stats';
const OVERRIDES_STORAGE_KEY = 'onyx.profiles.overrides';

/** EMA smoothing: each new sample carries this weight. */
const EMA_ALPHA = 0.2;

interface IMutableStats {
	sampleCount: number;
	tokensPerSecond: number;
	timeToFirstTokenMs: number;
	toolCallParseFailureRate: number;
	/** Requests that carried a tool call on the tool channel, or one that failed to parse: what the failure rate is a rate of. */
	toolCallSamples: number;
	acceptRate: number;
	acceptSampleCount: number;
	fimLatencyMs: number;
	fimSampleCount: number;
	ttftColdMs: number;
	ttftColdSamples: number;
	ttftWarmMs: number;
	ttftWarmSamples: number;
	constrainedTurns: number;
	constrainedFailures: number;
	/** Mean on-your-repo benchmark score per task kind, with its sample count. */
	benchScores: Record<string, number>;
	benchSamples: Record<string, number>;
	/** The metric the bench scores were taken with (C8). Scores under another one are dropped when they are loaded. */
	benchMetric: string;
	observedContextTokens?: number;
}

export class OnyxProfileService extends Disposable implements IOnyxProfileService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeProfiles = this._register(new Emitter<void>());
	readonly onDidChangeProfiles = this._onDidChangeProfiles.event;

	private readonly _stats: Map<string, IMutableStats>;
	private readonly _overrides: Map<string, Partial<IOnyxModelProfile>>;
	private readonly _persistScheduler: RunOnceScheduler;

	constructor(
		@IStorageService private readonly _storageService: IStorageService,
		@IOnyxDatasheetService private readonly _datasheetService: IOnyxDatasheetService,
		@IOnyxContextAllocationService private readonly _allocationService: IOnyxContextAllocationService,
	) {
		super();
		// A context that was just verified, or just undone, is another budget from that moment (B15). What an
		// overflow taught about the old allocation says nothing about the new one.
		this._register(this._allocationService.onDidChange(modelKey => {
			const stats = this._stats.get(modelKey);
			if (stats?.observedContextTokens !== undefined && this._allocationService.record(modelKey)?.status === 'verified') {
				stats.observedContextTokens = undefined;
				this._persistScheduler.schedule();
			}
			this._onDidChangeProfiles.fire();
		}));
		// A model that has just been measured has another profile from that moment.
		this._register(this._datasheetService.onDidChange(() => this._onDidChangeProfiles.fire()));
		this._stats = new Map(Object.entries(this._storageService.getObject<Record<string, Partial<IMutableStats>>>(STATS_STORAGE_KEY, StorageScope.APPLICATION, {}))
			.map(([key, stored]) => [key, { ...emptyStats(), ...stored, ...benchRoutingDataForCurrentMetric(stored) }]));
		this._overrides = new Map(Object.entries(this._storageService.getObject<Record<string, Partial<IOnyxModelProfile>>>(OVERRIDES_STORAGE_KEY, StorageScope.APPLICATION, {})));
		this._persistScheduler = this._register(new RunOnceScheduler(() => this._persist(), 5000));
	}

	getProfile(modelKey: string, discovered: IOnyxDiscoveredModel): IOnyxModelProfile {
		const stats = this._stats.get(modelKey);
		let profile = seedProfile(discovered, stats?.observedContextTokens);
		// Observed parse failures outweigh the size-class guess in both directions, once there are tool calls to
		// go on. Requests alone are not: a constrained turn's call is decoded from text and is never on the tool
		// channel, so a model kept in the envelope showed a failure rate of zero after three requests, was judged a
		// reliable caller, and left the envelope in the middle of a session (2026-11-26).
		if (stats && stats.toolCallSamples >= 3) {
			const observedQuality = 1 - stats.toolCallParseFailureRate;
			const toolCallQuality = profile.toolCallQuality * 0.4 + observedQuality * 0.6;
			profile = {
				...profile,
				toolCallQuality,
				promptStyle: toolCallQuality < 0.7 ? 'compact' : profile.promptStyle,
				maxTools: toolCallQuality < 0.5 ? Math.min(profile.maxTools, 3) : profile.maxTools,
			};
		}
		// What was measured for this model replaces what was guessed for it (L5), and says which is which.
		// The user's own override still has the last word.
		profile = applyDatasheet(profile, this._datasheetService.current(modelKey, discovered));
		// A context Onyx asked for is budgeted only when it was verified, and then at the verified number and
		// no other (B15, R-61). The server's number for the model's own name describes another allocation, and
		// so does a datasheet measured under it; an overflow learned since still narrows it.
		const allocation = this._allocationService.inForce(modelKey, discovered);
		if (allocation) {
			const observed = this._stats.get(modelKey)?.observedContextTokens;
			const contextLength = Math.min(allocation.verifiedTokens, discovered.contextLength ?? allocation.verifiedTokens, observed ?? allocation.verifiedTokens);
			profile = {
				...profile,
				contextLength,
				context: { ...profile.context, requested: allocation.requestedTokens ?? undefined, reported: allocation.reportedTokens ?? undefined, verified: allocation.verifiedTokens, source: contextLength === allocation.verifiedTokens ? 'verified' : 'observed' },
				...(profile.provenance ? { provenance: { ...profile.provenance, contextLength: 'measured' } } : {}),
			};
		}
		const override = this._overrides.get(modelKey);
		return override ? { ...profile, ...override } : profile;
	}

	getStats(modelKey: string): IOnyxObservedStats | undefined {
		const stats = this._stats.get(modelKey);
		return stats ? { ...stats } : undefined;
	}

	exportAll(): { stats: Record<string, IOnyxObservedStats>; overrides: Record<string, Partial<IOnyxModelProfile>> } {
		return {
			stats: Object.fromEntries([...this._stats.entries()].map(([key, stats]) => [key, { ...stats }])),
			overrides: Object.fromEntries([...this._overrides.entries()].map(([key, override]) => [key, { ...override }])),
		};
	}

	reportMeasurement(measurement: IOnyxRequestMeasurement): void {
		const stats = this._getOrCreateStats(measurement.modelKey);
		stats.sampleCount++;
		if (measurement.tokensPerSecond !== undefined) {
			stats.tokensPerSecond = ema(stats.tokensPerSecond, measurement.tokensPerSecond);
		}
		if (measurement.timeToFirstTokenMs !== undefined) {
			stats.timeToFirstTokenMs = ema(stats.timeToFirstTokenMs, measurement.timeToFirstTokenMs);
			// Cold and warm first tokens are different phenomena (weight loading
			// vs prompt processing); a merged EMA would blur both numbers.
			if (measurement.wasCold === true) {
				stats.ttftColdSamples++;
				stats.ttftColdMs = ema(stats.ttftColdMs, measurement.timeToFirstTokenMs);
			} else if (measurement.wasCold === false) {
				stats.ttftWarmSamples++;
				stats.ttftWarmMs = ema(stats.ttftWarmMs, measurement.timeToFirstTokenMs);
			}
		}
		if (measurement.toolCallCount + measurement.toolCallParseFailures > 0) {
			const failureShare = measurement.toolCallParseFailures / (measurement.toolCallCount + measurement.toolCallParseFailures);
			stats.toolCallParseFailureRate = ema(stats.toolCallParseFailureRate, failureShare);
			stats.toolCallSamples++;
		}
		this._didChange();
	}

	reportOutcome(modelKey: string, accepted: boolean): void {
		const stats = this._getOrCreateStats(modelKey);
		stats.acceptSampleCount++;
		stats.acceptRate = ema(stats.acceptRate === 0 && stats.acceptSampleCount === 1 ? (accepted ? 1 : 0) : stats.acceptRate, accepted ? 1 : 0);
		this._didChange();
	}

	reportContextOverflow(modelKey: string, observedTokens: number): void {
		const stats = this._getOrCreateStats(modelKey);
		const observed = Math.max(1, Math.floor(observedTokens));
		// Only ever narrower: one overflow at a small size outweighs any number of larger requests that fit.
		stats.observedContextTokens = stats.observedContextTokens === undefined ? observed : Math.min(stats.observedContextTokens, observed);
		this._persistScheduler.schedule();
		this._onDidChangeProfiles.fire();
	}

	reportConstrainedOutcome(modelKey: string, ok: boolean): void {
		const stats = this._getOrCreateStats(modelKey);
		stats.constrainedTurns++;
		if (!ok) {
			stats.constrainedFailures++;
		}
		this._didChange();
	}

	reportBenchScore(modelKey: string, taskKind: string, score: number): void {
		const stats = this._getOrCreateStats(modelKey);
		const samples = stats.benchSamples[taskKind] ?? 0;
		const mean = stats.benchScores[taskKind] ?? 0;
		// A running mean, not an EMA: bench runs are rare, deliberate events
		// and every task should count equally within a suite.
		stats.benchScores[taskKind] = (mean * samples + score) / (samples + 1);
		stats.benchSamples[taskKind] = samples + 1;
		this._didChange();
	}

	reportFimMeasurement(modelKey: string, latencyMs: number): void {
		const stats = this._getOrCreateStats(modelKey);
		stats.fimSampleCount++;
		stats.fimLatencyMs = ema(stats.fimLatencyMs, latencyMs);
		this._didChange();
	}

	setOverride(modelKey: string, patch: Partial<IOnyxModelProfile>): void {
		this._overrides.set(modelKey, { ...this._overrides.get(modelKey), ...patch });
		this._didChange();
	}

	private _getOrCreateStats(modelKey: string): IMutableStats {
		let stats = this._stats.get(modelKey);
		if (!stats) {
			stats = emptyStats();
			this._stats.set(modelKey, stats);
		}
		return stats;
	}

	private _didChange(): void {
		this._persistScheduler.schedule();
		this._onDidChangeProfiles.fire();
	}

	private _persist(): void {
		this._storageService.store(STATS_STORAGE_KEY, JSON.stringify(Object.fromEntries(this._stats)), StorageScope.APPLICATION, StorageTarget.MACHINE);
		this._storageService.store(OVERRIDES_STORAGE_KEY, JSON.stringify(Object.fromEntries(this._overrides)), StorageScope.APPLICATION, StorageTarget.MACHINE);
	}
}

function emptyStats(): IMutableStats {
	return { sampleCount: 0, tokensPerSecond: 0, timeToFirstTokenMs: 0, toolCallParseFailureRate: 0, toolCallSamples: 0, acceptRate: 0.5, acceptSampleCount: 0, fimLatencyMs: 0, fimSampleCount: 0, ttftColdMs: 0, ttftColdSamples: 0, ttftWarmMs: 0, ttftWarmSamples: 0, constrainedTurns: 0, constrainedFailures: 0, benchScores: {}, benchSamples: {}, benchMetric: ONYX_BENCH_METRIC };
}

function ema(previous: number, sample: number): number {
	return previous === 0 ? sample : previous * (1 - EMA_ALPHA) + sample * EMA_ALPHA;
}
