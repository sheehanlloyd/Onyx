/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { IOnyxDiscoveredModel, IOnyxRuntimeService } from '../../../../../platform/onyxRuntime/common/onyxRuntime.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { datasheetStaleness, IOnyxDatasheet } from '../../common/onyxDatasheet.js';
import { OnyxProbeName, OnyxRuntimeProbeTransport, runDatasheetProbes } from '../../common/onyxDatasheetProbes.js';

export const IOnyxDatasheetService = createDecorator<IOnyxDatasheetService>('onyxDatasheetService');

/** What a measurement is run against: a model the model service knows, with where its runtime is. */
export interface IOnyxDatasheetTarget {
	/** The key profiles and statistics are kept under: `<host:port>/<modelId>`. */
	readonly modelKey: string;
	readonly discovered: IOnyxDiscoveredModel;
	readonly apiKey?: string;
}

/**
 * Model datasheets (L5): measuring a model, keeping what was measured, and
 * saying whether it still describes the model. A datasheet is kept on this
 * machine, under the model's key, and goes nowhere else (DEC-10). Measuring
 * happens only when the user asks for it.
 */
export interface IOnyxDatasheetService {
	readonly _serviceBrand: undefined;
	/** Fires with a model's key when its datasheet is stored. */
	readonly onDidChange: Event<string>;
	/** The stored datasheet when it still describes the model; undefined when there is none or it is stale. */
	current(modelKey: string, discovered: IOnyxDiscoveredModel): IOnyxDatasheet | undefined;
	/** Whatever is stored for the model, with why it is not used when it is not. */
	stored(modelKey: string, discovered: IOnyxDiscoveredModel): { readonly datasheet: IOnyxDatasheet; readonly stale: string | undefined } | undefined;
	/** Runs the probe suite against the model and stores the result. Rejects, storing nothing, when cancelled. */
	measure(target: IOnyxDatasheetTarget, token: CancellationToken, onProgress?: (probe: OnyxProbeName, done: number, total: number) => void): Promise<IOnyxDatasheet>;
	/** Stores a datasheet that was measured elsewhere on this machine. */
	store(modelKey: string, datasheet: IOnyxDatasheet): void;
	/** Every stored datasheet, for the diagnostics bundle. */
	exportAll(): Record<string, IOnyxDatasheet>;
}

const STORAGE_KEY = 'onyx.datasheets';

export class OnyxDatasheetService extends Disposable implements IOnyxDatasheetService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<string>());
	readonly onDidChange = this._onDidChange.event;

	private readonly _datasheets: Map<string, IOnyxDatasheet>;

	constructor(
		@IStorageService private readonly _storageService: IStorageService,
		@IOnyxRuntimeService private readonly _runtimeService: IOnyxRuntimeService,
	) {
		super();
		this._datasheets = new Map(Object.entries(this._storageService.getObject<Record<string, IOnyxDatasheet>>(STORAGE_KEY, StorageScope.APPLICATION, {}))
			// Anything that is not a datasheet in this format is left out: a later format reads its own.
			.filter(([, datasheet]) => datasheet?.version === 1 && typeof datasheet.model === 'string'));
	}

	current(modelKey: string, discovered: IOnyxDiscoveredModel): IOnyxDatasheet | undefined {
		const found = this.stored(modelKey, discovered);
		return found && found.stale === undefined ? found.datasheet : undefined;
	}

	stored(modelKey: string, discovered: IOnyxDiscoveredModel): { readonly datasheet: IOnyxDatasheet; readonly stale: string | undefined } | undefined {
		const datasheet = this._datasheets.get(modelKey);
		return datasheet ? { datasheet, stale: datasheetStaleness(datasheet, discovered) } : undefined;
	}

	async measure(target: IOnyxDatasheetTarget, token: CancellationToken, onProgress?: (probe: OnyxProbeName, done: number, total: number) => void): Promise<IOnyxDatasheet> {
		const { discovered } = target;
		// Whether the model is in memory before anything is sent decides whether the first reply is a cold one.
		const loadedBefore = await this._loaded(discovered);
		const transport = new OnyxRuntimeProbeTransport(this._runtimeService, { baseUrl: discovered.baseUrl, apiKey: target.apiKey, model: discovered.id }, `onyx-datasheet-${generateUuid()}`);
		const datasheet = await runDatasheetProbes(transport, {
			model: discovered.id,
			digest: discovered.digest,
			runtime: discovered.runtime,
			runtimeVersion: discovered.runtimeVersion,
			serverContextTokens: discovered.serverContextLength,
			loadedAtStart: loadedBefore?.loaded,
		}, token, {
			onProgress,
			// Once the model has answered it is loaded, and the runtime can say what it allocated for it.
			resolveServerContextTokens: async () => (await this._loaded(discovered))?.contextLength ?? discovered.serverContextLength,
		});
		this.store(target.modelKey, datasheet);
		return datasheet;
	}

	/** Whether the runtime has the model in memory and what context it allocated, when the runtime can say. */
	private async _loaded(discovered: IOnyxDiscoveredModel): Promise<{ readonly loaded: boolean; readonly contextLength?: number } | undefined> {
		try {
			const loaded = await this._runtimeService.listLoadedModels(discovered.baseUrl);
			if (!loaded) {
				return undefined;
			}
			const entry = loaded.find(model => model.id === discovered.id);
			return { loaded: !!entry, contextLength: entry?.contextLength };
		} catch {
			return undefined;
		}
	}

	store(modelKey: string, datasheet: IOnyxDatasheet): void {
		this._datasheets.set(modelKey, datasheet);
		this._storageService.store(STORAGE_KEY, JSON.stringify(Object.fromEntries(this._datasheets)), StorageScope.APPLICATION, StorageTarget.MACHINE);
		this._onDidChange.fire(modelKey);
	}

	exportAll(): Record<string, IOnyxDatasheet> {
		return Object.fromEntries(this._datasheets);
	}
}
