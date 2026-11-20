/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { ISecretStorageService } from '../../../../../platform/secrets/common/secrets.js';
import { getOnyxEndpointSettings, IOnyxEndpointSetting, normalizeEndpointBaseUrl, OnyxSettingId } from '../../common/onyxConfiguration.js';

export const IOnyxEndpointSecretService = createDecorator<IOnyxEndpointSecretService>('onyxEndpointSecretService');

/**
 * Where an endpoint's API key lives (B11): the system's secret storage,
 * under the endpoint's base URL, and not `settings.json`. A key that an
 * earlier version let the user write into `onyx.endpoints` is moved here the
 * first time it is seen, and removed from the setting.
 *
 * Nothing here is touched unless an endpoint is configured: a user with only
 * auto-discovered local runtimes never causes a read of the secret storage.
 */
export interface IOnyxEndpointSecretService {
	readonly _serviceBrand: undefined;
	readonly onDidChange: Event<void>;
	setApiKey(baseUrl: string, apiKey: string | undefined): Promise<void>;
	/**
	 * The key of every configured endpoint that has one, by normalized base
	 * URL. Moves keys still written in the setting into secret storage first;
	 * a key that could not be moved is still returned, so the endpoint works.
	 */
	configuredApiKeys(): Promise<ReadonlyMap<string, string>>;
}

const SECRET_KEY_PREFIX = 'onyx.endpoint.apiKey:';

export class OnyxEndpointSecretService extends Disposable implements IOnyxEndpointSecretService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

	constructor(
		@ISecretStorageService private readonly _secretStorageService: ISecretStorageService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();
		this._register(this._secretStorageService.onDidChangeSecret(key => {
			if (key.startsWith(SECRET_KEY_PREFIX)) {
				this._onDidChange.fire();
			}
		}));
	}

	async setApiKey(baseUrl: string, apiKey: string | undefined): Promise<void> {
		const key = SECRET_KEY_PREFIX + normalizeEndpointBaseUrl(baseUrl);
		if (apiKey) {
			await this._secretStorageService.set(key, apiKey);
		} else {
			await this._secretStorageService.delete(key);
		}
		this._onDidChange.fire();
	}

	async configuredApiKeys(): Promise<ReadonlyMap<string, string>> {
		const endpoints = getOnyxEndpointSettings(this._configurationService);
		const keys = new Map<string, string>();
		if (endpoints.length === 0) {
			return keys;
		}
		const legacy = endpoints.filter(endpoint => typeof endpoint.apiKey === 'string' && endpoint.apiKey.length > 0);
		for (const endpoint of legacy) {
			// Still usable if the move below fails: an endpoint must not stop working because a file is read-only.
			keys.set(normalizeEndpointBaseUrl(endpoint.baseUrl), endpoint.apiKey!);
		}
		if (legacy.length > 0) {
			await this._moveOutOfSettings(endpoints, legacy);
		}
		for (const endpoint of endpoints) {
			const baseUrl = normalizeEndpointBaseUrl(endpoint.baseUrl);
			try {
				const stored = await this._secretStorageService.get(SECRET_KEY_PREFIX + baseUrl);
				if (stored) {
					keys.set(baseUrl, stored);
				}
			} catch (error) {
				this._logService.warn('[onyx] could not read an endpoint key from the secret storage', error instanceof Error ? error.message : String(error));
			}
		}
		return keys;
	}

	/** Stores each key that is written in `onyx.endpoints`, then rewrites the setting without them. */
	private async _moveOutOfSettings(endpoints: readonly IOnyxEndpointSetting[], legacy: readonly IOnyxEndpointSetting[]): Promise<void> {
		try {
			for (const endpoint of legacy) {
				await this._secretStorageService.set(SECRET_KEY_PREFIX + normalizeEndpointBaseUrl(endpoint.baseUrl), endpoint.apiKey!);
			}
			const withoutKeys = endpoints.map(endpoint => {
				const { apiKey: _moved, ...rest } = endpoint;
				return rest;
			});
			// `onyx.endpoints` is a machine-scoped setting: it lives in the user's local settings.
			await this._configurationService.updateValue(OnyxSettingId.Endpoints, withoutKeys, ConfigurationTarget.USER_LOCAL);
			this._logService.info(`[onyx] moved ${legacy.length} endpoint API key(s) from settings into the secret storage`);
		} catch (error) {
			this._logService.warn('[onyx] could not move endpoint API keys out of settings; they stay there and are still used', error instanceof Error ? error.message : String(error));
		}
	}
}
