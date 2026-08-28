/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as DOM from '../../../../../base/browser/dom.js';
import { autorun } from '../../../../../base/common/observable.js';
import { localize } from '../../../../../nls.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { ViewPane } from '../../../../browser/parts/views/viewPane.js';
import { IViewletViewOptions } from '../../../../browser/parts/views/viewsViewlet.js';
import { IViewDescriptorService } from '../../../../common/views.js';
import { formatCount, IOnyxLedgerEntry, summarize } from '../../common/onyxLedger.js';
import { IOnyxLedgerService } from '../compute/onyxLedgerService.js';
import { IOnyxComputeState, IOnyxControlPlaneService } from './onyxControlPlaneService.js';

const $ = DOM.$;

type LedgerScope = 'session' | 'allTime';

/**
 * The local equivalent of a cloud bill. The top half is the request in flight;
 * the bottom half is the ledger — what each model has actually cost this
 * machine in tokens, throughput and time spent holding weights in memory.
 */
export class OnyxComputeViewPane extends ViewPane {

	static readonly ID = 'workbench.view.onyx.compute';

	private _content: HTMLElement | undefined;
	private _scope: LedgerScope = 'session';

	constructor(
		options: IViewletViewOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
		@IOnyxControlPlaneService private readonly _controlPlaneService: IOnyxControlPlaneService,
		@IOnyxLedgerService private readonly _ledgerService: IOnyxLedgerService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		this._content = DOM.append(container, $('.onyx-view'));

		this._register(autorun(reader => {
			this._render(
				this._controlPlaneService.compute.read(reader),
				this._ledgerService.session.read(reader),
				this._ledgerService.allTime.read(reader),
			);
		}));
	}

	private _render(state: IOnyxComputeState, session: readonly IOnyxLedgerEntry[], allTime: readonly IOnyxLedgerEntry[]): void {
		const content = this._content;
		if (!content) {
			return;
		}
		DOM.clearNode(content);

		this._sectionLabel(content, localize('onyx.compute.now', "Right now"));
		const grid = DOM.append(content, $('.onyx-compute-grid'));

		const model = this._stat(grid, localize('onyx.compute.model', "Model"), state.modelKey ?? '—', undefined, state.inFlight);
		model.classList.add('onyx-compute-model');

		this._stat(grid,
			localize('onyx.compute.throughput', "Generation"),
			state.tokensPerSecond !== undefined ? state.tokensPerSecond.toFixed(0) : '—',
			localize('onyx.compute.toksec', "tok/s"),
			state.inFlight);

		this._stat(grid,
			localize('onyx.compute.ttft', "First token"),
			state.timeToFirstTokenMs !== undefined ? (state.timeToFirstTokenMs / 1000).toFixed(2) : '—',
			's',
			state.inFlight);

		this._stat(grid,
			localize('onyx.compute.state', "State"),
			state.inFlight ? localize('onyx.compute.generating', "generating") : localize('onyx.compute.idle', "idle"),
			undefined,
			state.inFlight);

		this._sectionLabel(content, localize('onyx.compute.ledger', "Compute spent"));
		this._renderScopeToggle(content);
		this._renderLedger(content, this._scope === 'session' ? session : allTime);
	}

	private _renderScopeToggle(parent: HTMLElement): void {
		const toggle = DOM.append(parent, $('.onyx-ledger-toggle'));
		const add = (scope: LedgerScope, label: string) => {
			const button = DOM.append(toggle, $('button')) as HTMLButtonElement;
			button.type = 'button';
			button.textContent = label;
			button.classList.toggle('checked', this._scope === scope);
			button.setAttribute('aria-pressed', String(this._scope === scope));
			button.addEventListener('click', () => {
				this._scope = scope;
				this._render(this._controlPlaneService.compute.get(), this._ledgerService.session.get(), this._ledgerService.allTime.get());
			});
		};
		add('session', localize('onyx.compute.session', "This session"));
		add('allTime', localize('onyx.compute.allTime', "All time"));
	}

	private _renderLedger(parent: HTMLElement, entries: readonly IOnyxLedgerEntry[]): void {
		if (entries.length === 0) {
			const none = DOM.append(parent, $('.onyx-inspector-none'));
			none.textContent = localize('onyx.compute.noLedger', "No requests recorded yet.");
			return;
		}

		const ledger = DOM.append(parent, $('.onyx-ledger'));
		for (const entry of entries) {
			const stats = summarize(entry);
			const row = DOM.append(ledger, $('.onyx-ledger-row'));

			const name = DOM.append(row, $('.onyx-ledger-model'));
			name.textContent = entry.modelKey;
			name.title = entry.modelKey;

			const headline = DOM.append(row, $('.onyx-ledger-headline'));
			headline.textContent = localize('onyx.compute.requests', "{0} req", entry.requests);

			const detail = DOM.append(row, $('.onyx-ledger-detail'));
			detail.textContent = [
				localize('onyx.compute.tokens', "{0} tokens", formatCount(stats.totalTokens)),
				stats.tokensPerSecond !== undefined ? localize('onyx.compute.avgSpeed', "{0} tok/s avg", stats.tokensPerSecond.toFixed(0)) : undefined,
				stats.averageTtftMs !== undefined ? localize('onyx.compute.avgTtft', "{0}s to first token", (stats.averageTtftMs / 1000).toFixed(2)) : undefined,
				stats.acceptRate !== undefined ? localize('onyx.compute.accepted', "{0}% kept", Math.round(stats.acceptRate * 100)) : undefined,
				// Not watts: a machine-independent stand-in for "how much model, held for how long".
				stats.parameterSeconds > 0 ? localize('onyx.compute.paramSeconds', "{0} B·s", formatCount(stats.parameterSeconds)) : undefined,
				entry.failures > 0 ? localize('onyx.compute.failures', "{0} failed", entry.failures) : undefined,
			].filter(Boolean).join(' · ');
		}
	}

	private _sectionLabel(parent: HTMLElement, text: string): void {
		const label = DOM.append(parent, $('.onyx-section-label'));
		label.textContent = text;
	}

	private _stat(parent: HTMLElement, label: string, value: string, unit: string | undefined, live: boolean): HTMLElement {
		const stat = DOM.append(parent, $('.onyx-stat'));
		stat.classList.toggle('live', live);
		const labelElement = DOM.append(stat, $('.onyx-stat-label'));
		labelElement.textContent = label;
		const valueElement = DOM.append(stat, $('.onyx-stat-value'));
		valueElement.textContent = value;
		if (unit) {
			const unitElement = DOM.append(valueElement, $('span.unit'));
			unitElement.textContent = unit;
		}
		return stat;
	}
}
