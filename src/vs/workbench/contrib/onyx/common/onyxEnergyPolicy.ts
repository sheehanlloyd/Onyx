/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Energy- and thermal-aware scheduling: on battery or under thermal pressure
 * a laptop should not be asked to hold a 30B model at full tilt. The policy
 * maps (power state × user setting) to concrete knobs — a parameter cap for
 * routing and a debounce/off switch for autocomplete — plus the one plain
 * sentence the Compute view shows so the downshift is never mysterious.
 * Pure and exhaustively unit-tested; the platform layer supplies the state.
 */

import { IOnyxPowerState } from '../../../../platform/onyxRuntime/common/onyxRuntime.js';

export type OnyxEnergyPolicySetting = 'balanced' | 'performance' | 'efficiency';

export interface IOnyxEnergyDecision {
	/** Routing must not pick models above this size, in billions of parameters. */
	readonly maxParameterB: number | undefined;
	readonly autocompleteEnabled: boolean;
	/** Extra debounce for ghost text, on top of the provider's default. */
	readonly autocompleteExtraDebounceMs: number;
	/** Whether anything was downshifted at all. */
	readonly downshifted: boolean;
	/** One plain sentence for the Compute view. Empty when nothing changed. */
	readonly reason: string;
}

const FULL_SPEED: IOnyxEnergyDecision = { maxParameterB: undefined, autocompleteEnabled: true, autocompleteExtraDebounceMs: 0, downshifted: false, reason: '' };

export function decideEnergyPolicy(state: IOnyxPowerState, setting: OnyxEnergyPolicySetting): IOnyxEnergyDecision {
	if (setting === 'performance') {
		return FULL_SPEED;
	}

	const hot = state.thermal === 'serious';

	if (setting === 'efficiency') {
		if (state.onBattery && hot) {
			return { maxParameterB: 4, autocompleteEnabled: false, autocompleteExtraDebounceMs: 0, downshifted: true, reason: 'On battery and running hot, so Onyx is using its smallest models and autocomplete is off.' };
		}
		if (state.onBattery) {
			return { maxParameterB: 4, autocompleteEnabled: false, autocompleteExtraDebounceMs: 0, downshifted: true, reason: 'On battery in efficiency mode, so Onyx is using its smallest models and autocomplete is off.' };
		}
		if (hot) {
			return { maxParameterB: 4, autocompleteEnabled: true, autocompleteExtraDebounceMs: 500, downshifted: true, reason: 'The machine is running hot, so Onyx is using its smallest models and completing less often.' };
		}
		return { maxParameterB: 8, autocompleteEnabled: true, autocompleteExtraDebounceMs: 200, downshifted: true, reason: 'Efficiency mode keeps Onyx on models up to 8B even on power.' };
	}

	// balanced (the default)
	if (state.onBattery && hot) {
		return { maxParameterB: 4, autocompleteEnabled: true, autocompleteExtraDebounceMs: 700, downshifted: true, reason: 'On battery and running hot, so Onyx routes to models up to 4B and completes less often.' };
	}
	if (hot) {
		return { maxParameterB: 8, autocompleteEnabled: true, autocompleteExtraDebounceMs: 500, downshifted: true, reason: 'The machine is running hot, so Onyx routes to models up to 8B and completes less often.' };
	}
	if (state.onBattery) {
		return { maxParameterB: 8, autocompleteEnabled: true, autocompleteExtraDebounceMs: 300, downshifted: true, reason: 'On battery, so Onyx routes to models up to 8B to stretch the charge.' };
	}
	return FULL_SPEED;
}

/**
 * Applies the decision's cap to routing candidates. When every candidate is
 * above the cap the smallest one stays: a downshift must never mean "no
 * model at all".
 */
export function capCandidatesByParameter<T extends { readonly parameterB: number | undefined }>(candidates: readonly T[], maxParameterB: number | undefined): T[] {
	if (maxParameterB === undefined || candidates.length === 0) {
		return [...candidates];
	}
	const within = candidates.filter(candidate => (candidate.parameterB ?? maxParameterB) <= maxParameterB);
	if (within.length > 0) {
		return within;
	}
	const smallest = [...candidates].sort((a, b) => (a.parameterB ?? Number.MAX_VALUE) - (b.parameterB ?? Number.MAX_VALUE))[0];
	return [smallest];
}
