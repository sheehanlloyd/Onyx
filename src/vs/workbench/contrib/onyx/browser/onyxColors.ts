/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { registerColor, transparent } from '../../../../platform/theme/common/colorRegistry.js';

export const onyxAccent = registerColor(
	'onyx.accent',
	{ dark: '#8A63F5', light: '#6B4EE6', hcDark: '#B79CFF', hcLight: '#4A2FBF' },
	localize('onyxAccent', "Accent color used across the Onyx control plane."),
);

export const onyxAccentSoft = registerColor(
	'onyx.accentSoft',
	{ dark: transparent(onyxAccent, 0.15), light: transparent(onyxAccent, 0.12), hcDark: null, hcLight: null },
	localize('onyxAccentSoft', "Soft accent background used across the Onyx control plane."),
);

export const onyxGlow = registerColor(
	'onyx.glow',
	{ dark: transparent(onyxAccent, 0.4), light: transparent(onyxAccent, 0.3), hcDark: null, hcLight: null },
	localize('onyxGlow', "Glow color for live activity indicators in the Onyx control plane."),
);

export const onyxOk = registerColor(
	'onyx.ok',
	{ dark: '#3FB68B', light: '#1B8A5A', hcDark: '#89D185', hcLight: '#0F6B3F' },
	localize('onyxOk', "Color for successful steps in the Onyx control plane."),
);

export const onyxWarn = registerColor(
	'onyx.warn',
	{ dark: '#E5B45B', light: '#B07D28', hcDark: '#FFD68A', hcLight: '#8A5E14' },
	localize('onyxWarn', "Color for attention states in the Onyx control plane."),
);

export const onyxError = registerColor(
	'onyx.error',
	{ dark: '#E36D6D', light: '#C4314B', hcDark: '#FF9C9C', hcLight: '#A11835' },
	localize('onyxError', "Color for failed steps in the Onyx control plane."),
);
