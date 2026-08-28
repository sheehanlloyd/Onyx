/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { IObservable, ISettableObservable, observableValue } from '../../../../../base/common/observable.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';

export const IOnyxPinService = createDecorator<IOnyxPinService>('onyxPinService');

/**
 * User-steered context: files pinned into every prompt and files evicted from
 * the automatic ranking. This is the difference between a context budget you
 * can *watch* and one you can *edit* — the ranker proposes, these lists
 * dispose. Both persist per workspace; paths are the same qualified
 * workspace-relative strings the ranker produces.
 */
export interface IOnyxPinService {
	readonly _serviceBrand: undefined;
	/** Files that always make the prompt's workspace-context section. */
	readonly pins: IObservable<readonly string[]>;
	/** Files the automatic ranking must not include. */
	readonly exclusions: IObservable<readonly string[]>;
	pin(path: string): void;
	unpin(path: string): void;
	exclude(path: string): void;
	/** Removes a path from the exclusion list, re-admitting it to the ranking. */
	readmit(path: string): void;
}

const PINS_KEY = 'onyx.context.pins';
const EXCLUSIONS_KEY = 'onyx.context.exclusions';
/** Pinning is for a handful of anchor files, not a second file explorer. */
const MAX_PINS = 12;

export class OnyxPinService extends Disposable implements IOnyxPinService {

	declare readonly _serviceBrand: undefined;

	private readonly _pins: ISettableObservable<readonly string[]>;
	private readonly _exclusions: ISettableObservable<readonly string[]>;

	constructor(
		@IStorageService private readonly _storageService: IStorageService,
	) {
		super();
		this._pins = observableValue(this, this._load(PINS_KEY));
		this._exclusions = observableValue(this, this._load(EXCLUSIONS_KEY));
	}

	get pins(): IObservable<readonly string[]> { return this._pins; }
	get exclusions(): IObservable<readonly string[]> { return this._exclusions; }

	pin(path: string): void {
		this._set(this._exclusions, EXCLUSIONS_KEY, this._exclusions.get().filter(entry => entry !== path));
		if (!this._pins.get().includes(path)) {
			this._set(this._pins, PINS_KEY, [...this._pins.get(), path].slice(-MAX_PINS));
		}
	}

	unpin(path: string): void {
		this._set(this._pins, PINS_KEY, this._pins.get().filter(entry => entry !== path));
	}

	exclude(path: string): void {
		this._set(this._pins, PINS_KEY, this._pins.get().filter(entry => entry !== path));
		if (!this._exclusions.get().includes(path)) {
			this._set(this._exclusions, EXCLUSIONS_KEY, [...this._exclusions.get(), path]);
		}
	}

	readmit(path: string): void {
		this._set(this._exclusions, EXCLUSIONS_KEY, this._exclusions.get().filter(entry => entry !== path));
	}

	private _load(key: string): readonly string[] {
		try {
			const raw = this._storageService.get(key, StorageScope.WORKSPACE);
			const parsed = raw ? JSON.parse(raw) : [];
			return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : [];
		} catch {
			return [];
		}
	}

	private _set(target: ISettableObservable<readonly string[]>, key: string, value: readonly string[]): void {
		target.set(value, undefined);
		this._storageService.store(key, JSON.stringify(value), StorageScope.WORKSPACE, StorageTarget.MACHINE);
	}
}
