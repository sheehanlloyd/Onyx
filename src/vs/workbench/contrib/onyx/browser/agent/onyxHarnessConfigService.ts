/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { IEnvironmentService } from '../../../../../platform/environment/common/environment.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IOnyxLabHarnessRequest, IOnyxRuntimeService } from '../../../../../platform/onyxRuntime/common/onyxRuntime.js';
import { deriveHarnessConfig, IOnyxHarnessConfig, IOnyxHarnessFacts, IOnyxLabSampling, IOnyxResolvedHarness, resolveHarnessConfig } from '../../common/onyxHarnessConfig.js';
import { IOnyxModelProfile } from '../../common/onyxTypes.js';

export const IOnyxHarnessConfigService = createDecorator<IOnyxHarnessConfigService>('onyxHarnessConfigService');

/**
 * Where a run's harness configuration comes from (L4). The agent loop asks
 * for it once a run and reads nothing else; a tool that has a switch of its
 * own asks which configuration the request it is serving runs under.
 */
export interface IOnyxHarnessConfigService {
	readonly _serviceBrand: undefined;
	/** The configuration a run for this model uses, with what was asked for from outside, if anything, and whether it was applied. */
	resolve(profile: IOnyxModelProfile, facts: IOnyxHarnessFacts): Promise<IOnyxResolvedHarness>;
	/** Says which configuration a chat request runs under, until the returned handle is disposed. */
	begin(requestId: string, configuration: IOnyxHarnessConfig): IDisposable;
	/** The configuration of a running request. Undefined for a request that is not an Onyx agent run. */
	forRequest(requestId: string | undefined): IOnyxHarnessConfig | undefined;
	/**
	 * What the campaign engine asks the next runs to use (L9), in place of
	 * what the environment named: a campaign changes configuration between
	 * units without restarting the window. It is a request like the
	 * environment's, checked the same way, and a packaged build refuses it.
	 * `undefined` ends it.
	 */
	setLabOverride(override: { readonly request: IOnyxLabHarnessRequest; readonly sampling?: IOnyxLabSampling } | undefined): void;
}

export class OnyxHarnessConfigService implements IOnyxHarnessConfigService {

	declare readonly _serviceBrand: undefined;

	/** What this window's process was started with. It does not change, so it is asked for once. */
	private _requested: Promise<IOnyxLabHarnessRequest | undefined> | undefined;
	private readonly _running = new Map<string, IOnyxHarnessConfig>();
	private _override: { readonly request: IOnyxLabHarnessRequest; readonly sampling?: IOnyxLabSampling } | undefined;

	constructor(
		@IOnyxRuntimeService private readonly _runtimeService: IOnyxRuntimeService,
		@IEnvironmentService private readonly _environmentService: IEnvironmentService,
		@ILogService private readonly _logService: ILogService,
	) { }

	async resolve(profile: IOnyxModelProfile, facts: IOnyxHarnessFacts): Promise<IOnyxResolvedHarness> {
		this._requested ??= this._readRequest();
		const override = this._override;
		const resolved = resolveHarnessConfig(deriveHarnessConfig(profile, facts), override ? override.request : await this._requested, this._environmentService.isBuilt ? 'packaged' : 'development', override?.sampling);
		if (resolved.refused) {
			this._logService.warn(`[onyx] lab harness configuration ${resolved.requested?.name} was not applied: ${resolved.refused}`);
		}
		return resolved;
	}

	private async _readRequest(): Promise<IOnyxLabHarnessRequest | undefined> {
		try {
			return await this._runtimeService.labHarnessRequest();
		} catch (error) {
			// The question could not be asked. As far as this window can tell, nothing was requested.
			this._logService.warn('[onyx] could not ask for a lab harness request', error);
			return undefined;
		}
	}

	setLabOverride(override: { readonly request: IOnyxLabHarnessRequest; readonly sampling?: IOnyxLabSampling } | undefined): void {
		this._override = override;
	}

	begin(requestId: string, configuration: IOnyxHarnessConfig): IDisposable {
		this._running.set(requestId, configuration);
		return toDisposable(() => {
			if (this._running.get(requestId) === configuration) {
				this._running.delete(requestId);
			}
		});
	}

	forRequest(requestId: string | undefined): IOnyxHarnessConfig | undefined {
		return requestId === undefined ? undefined : this._running.get(requestId);
	}
}
