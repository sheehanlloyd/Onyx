/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $ } from '../../../../base/browser/dom.js';

/**
 * The Onyx mark: a faceted gem drawn from three planes of one accent color, so
 * it reads as a single object rather than a logo pasted onto the UI. Used
 * sparingly — the onboarding hero and the control plane's resting state — where
 * a moment of identity orients the user rather than decorating the surface.
 *
 * Colors come from `currentColor` and its own opacity ramp, so the mark tracks
 * whatever theme token the caller sets on the container.
 */
export function renderOnyxGem(size: number): SVGElement {
	const svg = $.SVG<SVGSVGElement>('svg', {
		width: String(size),
		height: String(size),
		viewBox: '0 0 48 48',
		fill: 'none',
		'aria-hidden': 'true',
		class: 'onyx-gem',
	});

	// Crown (top plane), left pavilion and right pavilion. Three facets, one hue.
	svg.appendChild($.SVG('path', { d: 'M24 4 6 17l18 8 18-8Z', fill: 'currentColor', opacity: '0.95' }));
	svg.appendChild($.SVG('path', { d: 'M6 17v6l18 21V25Z', fill: 'currentColor', opacity: '0.55' }));
	svg.appendChild($.SVG('path', { d: 'M42 17v6L24 44V25Z', fill: 'currentColor', opacity: '0.32' }));
	svg.appendChild($.SVG('path', { d: 'M24 4 6 17l18 8 18-8Z', stroke: 'currentColor', 'stroke-width': '1', 'stroke-linejoin': 'round', opacity: '0.6' }));

	return svg;
}
