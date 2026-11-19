/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * A small deterministic generator (mulberry32) for the simulation rig. One
 * seed decides everything an episode does; the same seed must give the same
 * sequence on every machine, so nothing here depends on Math.random, the
 * clock or the platform.
 */
export class OnyxSimRandom {

	private _state: number;

	constructor(seed: number) {
		this._state = (seed >>> 0) || 0x9e3779b9;
	}

	/** A float in [0, 1). */
	next(): number {
		this._state = (this._state + 0x6d2b79f5) >>> 0;
		let t = this._state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	}

	/** An integer in [min, max]. */
	int(min: number, max: number): number {
		return min + Math.floor(this.next() * (max - min + 1));
	}

	chance(probability: number): boolean {
		return this.next() < probability;
	}

	pick<T>(items: readonly T[]): T {
		return items[Math.floor(this.next() * items.length)];
	}

	/** A fresh generator derived from this one, so sub-streams stay independent of consumption order. */
	fork(label: string): OnyxSimRandom {
		let hash = 2166136261;
		for (let i = 0; i < label.length; i++) {
			hash = Math.imul(hash ^ label.charCodeAt(i), 16777619);
		}
		return new OnyxSimRandom((hash ^ Math.floor(this.next() * 4294967296)) >>> 0);
	}
}
