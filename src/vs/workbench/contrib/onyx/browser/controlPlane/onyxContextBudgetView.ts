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
import { IOnyxBudgetSlice } from '../../common/onyxTypes.js';
import { IOnyxControlPlaneService } from './onyxControlPlaneService.js';

const $ = DOM.$;

const SLICE_COLORS: Record<IOnyxBudgetSlice['category'], string> = {
	system: 'var(--vscode-onyx-accent)',
	history: 'color-mix(in srgb, var(--vscode-onyx-accent) 55%, var(--vscode-foreground) 20%)',
	attachments: 'var(--vscode-onyx-ok)',
	toolSchemas: 'var(--vscode-onyx-warn)',
	toolResults: 'color-mix(in srgb, var(--vscode-onyx-error) 70%, transparent)',
	workspace: 'color-mix(in srgb, var(--vscode-onyx-ok) 55%, var(--vscode-foreground) 20%)',
};

/**
 * Shows what the selected run's prompt window is actually made of — most
 * users have no idea what their agent "sees"; this view makes it exact.
 */
export class OnyxContextBudgetViewPane extends ViewPane {

	static readonly ID = 'workbench.view.onyx.contextBudget';

	private _content: HTMLElement | undefined;

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
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		this._content = DOM.append(container, $('.onyx-view'));

		this._register(autorun(reader => {
			const run = this._controlPlaneService.selectedRun.read(reader);
			const slices = run?.contextBudget.read(reader) ?? [];
			this._render(slices);
		}));
	}

	private _render(slices: readonly IOnyxBudgetSlice[]): void {
		const content = this._content;
		if (!content) {
			return;
		}
		DOM.clearNode(content);

		const nonEmpty = slices.filter(s => s.tokens > 0);
		if (nonEmpty.length === 0) {
			const empty = DOM.append(content, $('.onyx-empty'));
			DOM.append(empty, $('span.codicon.codicon-layers'));
			empty.appendChild(document.createTextNode(localize('onyx.budget.empty', "The context breakdown of the selected run appears here: exactly what the model was sent, token by token.")));
			return;
		}

		const total = nonEmpty.reduce((sum, s) => sum + s.tokens, 0);
		const totalElement = DOM.append(content, $('.onyx-budget-total'));
		totalElement.textContent = localize('onyx.budget.total', "{0} tokens sent to the model", formatTokens(total));

		const bar = DOM.append(content, $('.onyx-budget-bar'));
		for (const slice of nonEmpty) {
			const sliceElement = DOM.append(bar, $('.onyx-budget-slice'));
			sliceElement.style.width = `${(slice.tokens / total) * 100}%`;
			sliceElement.style.background = SLICE_COLORS[slice.category];
			sliceElement.title = `${categoryLabel(slice.category)}: ${formatTokens(slice.tokens)}`;
		}

		const legend = DOM.append(content, $('.onyx-budget-legend'));
		for (const slice of nonEmpty) {
			const swatch = DOM.append(legend, $('.onyx-budget-swatch'));
			swatch.style.background = SLICE_COLORS[slice.category];
			const label = DOM.append(legend, $('span'));
			label.textContent = categoryLabel(slice.category);
			const tokens = DOM.append(legend, $('span.onyx-budget-tokens'));
			tokens.textContent = formatTokens(slice.tokens);
		}
	}
}

function categoryLabel(category: IOnyxBudgetSlice['category']): string {
	switch (category) {
		case 'system': return localize('onyx.budget.system', "System prompt");
		case 'history': return localize('onyx.budget.history', "Conversation history");
		case 'attachments': return localize('onyx.budget.attachments', "Attachments");
		case 'toolSchemas': return localize('onyx.budget.toolSchemas', "Tool definitions");
		case 'toolResults': return localize('onyx.budget.toolResults', "Tool results");
		case 'workspace': return localize('onyx.budget.workspace', "Workspace context");
	}
}

function formatTokens(tokens: number): string {
	return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens);
}
