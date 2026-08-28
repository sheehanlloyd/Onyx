/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IntervalTimer } from '../../../../../base/common/async.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { IObservable, ISettableObservable, observableValue } from '../../../../../base/common/observable.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IOnyxPowerState, IOnyxRuntimeService } from '../../../../../platform/onyxRuntime/common/onyxRuntime.js';
import { OnyxSettingId } from '../../common/onyxConfiguration.js';
import { decideEnergyPolicy, IOnyxEnergyDecision, OnyxEnergyPolicySetting } from '../../common/onyxEnergyPolicy.js';

export const IOnyxEnergyService = createDecorator<IOnyxEnergyService>('onyxEnergyService');

/**
 * Watches power source and thermal pressure through the shared process and
 * keeps the current scheduling decision observable. The router and the
 * autocomplete provider consult the decision; the Compute view shows its
 * reason. Polling is deliberately slow (30s) — power state changes at human
 * timescales and `pmset` costs a process spawn.
 */
export interface IOnyxEnergyService {
	readonly _serviceBrand: undefined;
	readonly state: IObservable<IOnyxPowerState>;
	readonly decision: IObservable<IOnyxEnergyDecision>;
}

const POLL_INTERVAL_MS = 30_000;
const NOMINAL: IOnyxPowerState = { onBattery: false, thermal: 'unknown', cpuSpeedLimit: undefined };

export class OnyxEnergyService extends Disposable implements IOnyxEnergyService {

	declare readonly _serviceBrand: undefined;

	private readonly _state: ISettableObservable<IOnyxPowerState> = observableValue(this, NOMINAL);
	private readonly _decision: ISettableObservable<IOnyxEnergyDecision>;

	constructor(
		@IOnyxRuntimeService private readonly _runtimeService: IOnyxRuntimeService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();
		this._decision = observableValue(this, decideEnergyPolicy(NOMINAL, this._setting()));

		const timer = this._register(new IntervalTimer());
		timer.cancelAndSet(() => this._poll(), POLL_INTERVAL_MS);
		this._register(this._configurationService.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(OnyxSettingId.EnergyPolicy)) {
				this._decision.set(decideEnergyPolicy(this._state.get(), this._setting()), undefined);
			}
		}));
		this._poll();
	}

	get state(): IObservable<IOnyxPowerState> { return this._state; }
	get decision(): IObservable<IOnyxEnergyDecision> { return this._decision; }

	private _setting(): OnyxEnergyPolicySetting {
		const value = this._configurationService.getValue<string>(OnyxSettingId.EnergyPolicy);
		return value === 'performance' || value === 'efficiency' ? value : 'balanced';
	}

	private async _poll(): Promise<void> {
		try {
			const state = await this._runtimeService.getPowerState();
			this._state.set(state, undefined);
			const decision = decideEnergyPolicy(state, this._setting());
			const previous = this._decision.get();
			if (decision.reason !== previous.reason || decision.maxParameterB !== previous.maxParameterB) {
				this._logService.info(`[onyx] energy policy: ${decision.downshifted ? decision.reason : 'full speed'}`);
			}
			this._decision.set(decision, undefined);
		} catch {
			// Shared process unavailable: keep the last known decision.
		}
	}
}
