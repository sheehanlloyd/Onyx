/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';

export const IOnyxMemoryService = createDecorator<IOnyxMemoryService>('onyxMemoryService');

/** One remembered fact about this workspace. */
export interface IOnyxMemoryNote {
	/** Unix millis when the note was recorded. */
	readonly at: number;
	readonly text: string;
}

/**
 * Persistent, per-workspace agent memory. The agent records durable facts it
 * learns while working ("tests live in src/test", "the build needs Node 24")
 * and every future prompt in this workspace carries them — so the agent stops
 * rediscovering the same things run after run. Plain workspace storage on
 * this machine; nothing syncs, nothing leaves the device.
 */
export interface IOnyxMemoryService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeNotes: Event<void>;
	getNotes(): readonly IOnyxMemoryNote[];
	/** Records a note; near-duplicate texts refresh the existing note instead of stacking. */
	addNote(text: string): void;
	clear(): void;
}

const STORAGE_KEY = 'onyx.memory.notes';
const MAX_NOTES = 50;
const MAX_NOTE_CHARS = 400;

export class OnyxMemoryService extends Disposable implements IOnyxMemoryService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeNotes = this._register(new Emitter<void>());
	readonly onDidChangeNotes = this._onDidChangeNotes.event;

	private _notes: IOnyxMemoryNote[];

	constructor(
		@IStorageService private readonly _storageService: IStorageService,
	) {
		super();
		const stored = this._storageService.getObject<IOnyxMemoryNote[]>(STORAGE_KEY, StorageScope.WORKSPACE, []);
		this._notes = Array.isArray(stored) ? stored.filter(note => typeof note?.text === 'string' && typeof note?.at === 'number') : [];
	}

	getNotes(): readonly IOnyxMemoryNote[] {
		return this._notes;
	}

	addNote(text: string): void {
		const trimmed = text.trim().slice(0, MAX_NOTE_CHARS);
		if (!trimmed) {
			return;
		}
		// Refresh instead of duplicating when the same fact is re-learned.
		this._notes = this._notes.filter(note => normalize(note.text) !== normalize(trimmed));
		this._notes.push({ at: Date.now(), text: trimmed });
		if (this._notes.length > MAX_NOTES) {
			this._notes = this._notes.slice(this._notes.length - MAX_NOTES);
		}
		this._persist();
	}

	clear(): void {
		this._notes = [];
		this._persist();
	}

	private _persist(): void {
		this._storageService.store(STORAGE_KEY, JSON.stringify(this._notes), StorageScope.WORKSPACE, StorageTarget.MACHINE);
		this._onDidChangeNotes.fire();
	}
}

function normalize(text: string): string {
	return text.toLowerCase().replace(/\s+/g, ' ').trim();
}
