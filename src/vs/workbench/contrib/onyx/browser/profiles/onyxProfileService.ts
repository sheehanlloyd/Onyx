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
import { seedProfile } from '../../common/onyxSeedProfiles.js';
import { IOnyxModelProfile, IOnyxObservedStats } from '../../common/onyxTypes.js';
import { IOnyxRequestMeasurement } from '../model/onyxLanguageModelProvider.js';

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
	setOverride(modelKey: string, patch: Partial<IOnyxModelProfile>): void;
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
	acceptRate: number;
	acceptSampleCount: number;
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
	) {
		super();
		this._stats = new Map(Object.entries(this._storageService.getObject<Record<string, IMutableStats>>(STATS_STORAGE_KEY, StorageScope.APPLICATION, {})));
		this._overrides = new Map(Object.entries(this._storageService.getObject<Record<string, Partial<IOnyxModelProfile>>>(OVERRIDES_STORAGE_KEY, StorageScope.APPLICATION, {})));
		this._persistScheduler = this._register(new RunOnceScheduler(() => this._persist(), 5000));
	}

	getProfile(modelKey: string, discovered: IOnyxDiscoveredModel): IOnyxModelProfile {
		let profile = seedProfile(discovered);
		const stats = this._stats.get(modelKey);
		if (stats && stats.sampleCount >= 3) {
			// Observed parse failures outweigh the size-class guess in both directions.
			const observedQuality = 1 - stats.toolCallParseFailureRate;
			const toolCallQuality = profile.toolCallQuality * 0.4 + observedQuality * 0.6;
			profile = {
				...profile,
				toolCallQuality,
				promptStyle: toolCallQuality < 0.7 ? 'compact' : profile.promptStyle,
				maxTools: toolCallQuality < 0.5 ? Math.min(profile.maxTools, 3) : profile.maxTools,
			};
		}
		const override = this._overrides.get(modelKey);
		return override ? { ...profile, ...override } : profile;
	}

	getStats(modelKey: string): IOnyxObservedStats | undefined {
		const stats = this._stats.get(modelKey);
		return stats ? { ...stats } : undefined;
	}

	reportMeasurement(measurement: IOnyxRequestMeasurement): void {
		const stats = this._getOrCreateStats(measurement.modelKey);
		stats.sampleCount++;
		if (measurement.tokensPerSecond !== undefined) {
			stats.tokensPerSecond = ema(stats.tokensPerSecond, measurement.tokensPerSecond);
		}
		if (measurement.timeToFirstTokenMs !== undefined) {
			stats.timeToFirstTokenMs = ema(stats.timeToFirstTokenMs, measurement.timeToFirstTokenMs);
		}
		if (measurement.toolCallCount + measurement.toolCallParseFailures > 0) {
			const failureShare = measurement.toolCallParseFailures / (measurement.toolCallCount + measurement.toolCallParseFailures);
			stats.toolCallParseFailureRate = ema(stats.toolCallParseFailureRate, failureShare);
		}
		this._didChange();
	}

	reportOutcome(modelKey: string, accepted: boolean): void {
		const stats = this._getOrCreateStats(modelKey);
		stats.acceptSampleCount++;
		stats.acceptRate = ema(stats.acceptRate === 0 && stats.acceptSampleCount === 1 ? (accepted ? 1 : 0) : stats.acceptRate, accepted ? 1 : 0);
		this._didChange();
	}

	setOverride(modelKey: string, patch: Partial<IOnyxModelProfile>): void {
		this._overrides.set(modelKey, { ...this._overrides.get(modelKey), ...patch });
		this._didChange();
	}

	private _getOrCreateStats(modelKey: string): IMutableStats {
		let stats = this._stats.get(modelKey);
		if (!stats) {
			stats = { sampleCount: 0, tokensPerSecond: 0, timeToFirstTokenMs: 0, toolCallParseFailureRate: 0, acceptRate: 0.5, acceptSampleCount: 0 };
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

function ema(previous: number, sample: number): number {
	return previous === 0 ? sample : previous * (1 - EMA_ALPHA) + sample * EMA_ALPHA;
}
