/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as DOM from '../../../../../base/browser/dom.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { IOnyxActivityEntry } from './onyxControlPlaneService.js';

const $ = DOM.$;

/** Fixed row height in pixels — the contract that makes windowing exact. */
const ROW_HEIGHT = 22;
/** Rows rendered beyond the viewport on each side, so scrolling never flashes blank. */
const OVERSCAN = 8;
const VIEWPORT_HEIGHT = 320;

/**
 * A windowed timeline for very long runs. The expanded view of a 5,000-step
 * run must scroll like 5,000 steps while costing the DOM ~40 rows: a spacer
 * establishes the true scroll height and only the visible slice (plus
 * overscan) exists as elements, re-rendered on scroll. Rows are deliberately
 * one fixed-height line — the detail lives in the tooltip and the Inspector,
 * and fixed heights are what make exact windowing possible.
 */
export class OnyxVirtualTimeline extends Disposable {

	private readonly _viewport: HTMLElement;
	private readonly _spacer: HTMLElement;
	private readonly _window: HTMLElement;
	private _entries: readonly IOnyxActivityEntry[] = [];
	private _firstRendered = -1;
	private _lastRendered = -1;

	constructor(
		parent: HTMLElement,
		private readonly _openLocation: (location: { path: string; line: number }) => void,
	) {
		super();
		this._viewport = DOM.append(parent, $('.onyx-virtual-timeline'));
		this._viewport.style.maxHeight = `${VIEWPORT_HEIGHT}px`;
		this._viewport.setAttribute('role', 'list');
		this._viewport.setAttribute('aria-label', localize('onyx.virtualTimeline.aria', "Run timeline"));
		this._viewport.tabIndex = 0;
		this._spacer = DOM.append(this._viewport, $('.onyx-virtual-timeline-spacer'));
		this._window = DOM.append(this._spacer, $('.onyx-virtual-timeline-window'));
		this._register(DOM.addDisposableListener(this._viewport, 'scroll', () => this._renderWindow(false)));
	}

	setEntries(entries: readonly IOnyxActivityEntry[]): void {
		this._entries = entries;
		this._spacer.style.height = `${entries.length * ROW_HEIGHT}px`;
		this._renderWindow(true);
	}

	/** How many rows the DOM currently holds — the number the perf claim rests on. */
	get renderedRowCount(): number {
		return this._window.childElementCount;
	}

	scrollToEnd(): void {
		this._viewport.scrollTop = this._viewport.scrollHeight;
	}

	private _renderWindow(force: boolean): void {
		const first = Math.max(0, Math.floor(this._viewport.scrollTop / ROW_HEIGHT) - OVERSCAN);
		const visible = Math.ceil(this._viewport.clientHeight / ROW_HEIGHT) || Math.ceil(VIEWPORT_HEIGHT / ROW_HEIGHT);
		const last = Math.min(this._entries.length - 1, first + visible + OVERSCAN * 2);
		if (!force && first === this._firstRendered && last === this._lastRendered) {
			return;
		}
		this._firstRendered = first;
		this._lastRendered = last;
		DOM.clearNode(this._window);
		this._window.style.transform = `translateY(${first * ROW_HEIGHT}px)`;
		for (let index = first; index <= last; index++) {
			this._renderRow(this._entries[index], index);
		}
	}

	private _renderRow(entry: IOnyxActivityEntry, index: number): void {
		const row = DOM.append(this._window, $('.onyx-virtual-timeline-row'));
		row.style.height = `${ROW_HEIGHT}px`;
		row.setAttribute('role', 'listitem');
		if (entry.ok === true) {
			row.classList.add('ok');
		} else if (entry.ok === false) {
			row.classList.add('error');
		}
		const kind = DOM.append(row, $('span.onyx-timeline-kind'));
		kind.textContent = entry.kind;
		const label = DOM.append(row, $('span.onyx-virtual-timeline-text'));
		label.textContent = entry.label;
		const tooltip = [`#${index + 1}`, entry.label, entry.reason].filter(Boolean).join(' — ');
		row.title = tooltip;
		if (entry.location) {
			const location = entry.location;
			row.classList.add('linked');
			// A plain listener, not a registered disposable: rows are discarded
			// wholesale on scroll and the listener goes with the node.
			row.addEventListener('click', () => this._openLocation(location));
		}
	}
}
