/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IOnyxDiscoveredModel } from '../../../../platform/onyxRuntime/common/onyxRuntime.js';
import { IOnyxModelProfile } from './onyxTypes.js';

/**
 * Builds the starting profile for a model from what its runtime reports plus
 * size-class heuristics. Local observation (parse failures, accept rates)
 * refines these numbers over time — this table only has to be roughly right.
 */
export function seedProfile(model: IOnyxDiscoveredModel): IOnyxModelProfile {
	const parameterB = model.parameterB;
	const sizeClass = classifySize(parameterB);
	return {
		toolCallQuality: model.supportsTools === false ? 0 : seedToolCallQuality(sizeClass),
		contextLength: model.contextLength ?? 8192,
		maxTools: seedMaxTools(sizeClass),
		temperature: 0.2,
		promptStyle: sizeClass === 'large' ? 'full' : 'compact',
		family: model.family ?? model.id,
		parameterB,
		supportsVision: model.supportsVision ?? false,
	};
}

type SizeClass = 'tiny' | 'small' | 'medium' | 'large';

function classifySize(parameterB: number | undefined): SizeClass {
	if (parameterB === undefined) {
		return 'medium'; // unknown size: assume mid-range, observation corrects it
	}
	if (parameterB < 4) {
		return 'tiny';
	}
	if (parameterB < 15) {
		return 'small';
	}
	if (parameterB < 40) {
		return 'medium';
	}
	return 'large';
}

function seedToolCallQuality(sizeClass: SizeClass): number {
	switch (sizeClass) {
		case 'tiny': return 0.35;
		case 'small': return 0.6;
		case 'medium': return 0.8;
		case 'large': return 0.9;
	}
}

function seedMaxTools(sizeClass: SizeClass): number {
	switch (sizeClass) {
		case 'tiny': return 3;
		case 'small': return 6;
		case 'medium': return 12;
		case 'large': return 24;
	}
}
