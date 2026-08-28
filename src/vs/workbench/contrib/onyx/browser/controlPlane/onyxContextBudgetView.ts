/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as DOM from '../../../../../base/browser/dom.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { autorun } from '../../../../../base/common/observable.js';
import { localize } from '../../../../../nls.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
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
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { estimateTokens } from '../model/onyxOpenAITranslator.js';
import { OnyxContextRanker } from '../intelligence/onyxContextRanker.js';
import { IOnyxPinService } from '../intelligence/onyxPinService.js';
import { renderOnyxEmptyState } from './onyxEmptyState.js';
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
	private readonly _emptyStateDisposables = this._register(new DisposableStore());
	private readonly _contextRanker: OnyxContextRanker;
	private _renderSequence = 0;

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
		@IOnyxPinService private readonly _pinService: IOnyxPinService,
		@IQuickInputService private readonly _quickInputService: IQuickInputService,
		@IClipboardService private readonly _clipboardService: IClipboardService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
		this._contextRanker = instantiationService.createInstance(OnyxContextRanker);
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		this._content = DOM.append(container, $('.onyx-view'));

		this._register(autorun(reader => {
			const run = this._controlPlaneService.selectedRun.read(reader);
			const slices = run?.contextBudget.read(reader) ?? [];
			this._pinService.pins.read(reader);
			this._pinService.exclusions.read(reader);
			this._render(slices);
		}));
	}

	private _render(slices: readonly IOnyxBudgetSlice[]): void {
		const content = this._content;
		if (!content) {
			return;
		}
		DOM.clearNode(content);
		this._emptyStateDisposables.clear();

		const nonEmpty = slices.filter(s => s.tokens > 0);
		if (nonEmpty.length === 0) {
			renderOnyxEmptyState(content, {
				headline: localize('onyx.budget.empty.headline', "No context to show"),
				body: localize('onyx.budget.empty', "The breakdown of the selected run appears here: exactly what the model was sent, token by token."),
			}, this._clipboardService, this._emptyStateDisposables);
			this._renderSteering(content);
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

		this._renderSteering(content);
	}

	/**
	 * The editable half of the budget: pins, the ranked files the next prompt
	 * will carry (each evictable), and the live token cost of that section.
	 */
	private _renderSteering(parent: HTMLElement): void {
		const container = DOM.append(parent, $('.onyx-budget-steering'));
		const sequence = ++this._renderSequence;

		const header = DOM.append(container, $('.onyx-budget-steering-header'));
		const title = DOM.append(header, $('span'));
		title.textContent = localize('onyx.budget.nextPrompt', "Next prompt");
		const pinButton = DOM.append(header, $('button.onyx-icon-button.codicon.codicon-pin')) as HTMLButtonElement;
		pinButton.title = localize('onyx.budget.pinFile', "Pin a file into every prompt");
		pinButton.addEventListener('click', () => this._pickFileToPin());

		const listElement = DOM.append(container, $('.onyx-budget-files'));
		const estimateElement = DOM.append(container, $('.onyx-budget-estimate'));

		this._contextRanker.rank(10).then(ranked => {
			if (sequence !== this._renderSequence || !listElement.isConnected) {
				return;
			}
			const pins = new Set(this._pinService.pins.get());
			for (const file of ranked) {
				const row = DOM.append(listElement, $('.onyx-budget-file'));
				row.classList.toggle('pinned', pins.has(file.path));
				const icon = DOM.append(row, $(`span.codicon.codicon-${pins.has(file.path) ? 'pinned' : 'file'}`));
				icon.ariaHidden = 'true';
				const name = DOM.append(row, $('span.onyx-budget-file-path'));
				name.textContent = file.path;
				name.title = file.reasons.join(', ');
				const evict = DOM.append(row, $('button.onyx-icon-button.codicon.codicon-close')) as HTMLButtonElement;
				evict.title = pins.has(file.path)
					? localize('onyx.budget.unpin', "Unpin {0}", file.path)
					: localize('onyx.budget.evict', "Keep {0} out of the prompt", file.path);
				evict.addEventListener('click', () => {
					if (pins.has(file.path)) {
						this._pinService.unpin(file.path);
					} else {
						this._pinService.exclude(file.path);
					}
				});
			}
			// The same shape the prompt builder renders, so the number is honest.
			const sectionText = ranked.map(file => `- ${file.path} (${file.reasons.join(', ')})`).join('\n');
			estimateElement.textContent = localize('onyx.budget.estimate', "≈{0} tokens of workspace context", formatTokens(estimateTokens(sectionText)));

			const excluded = this._pinService.exclusions.get();
			if (excluded.length) {
				const excludedRow = DOM.append(container, $('.onyx-budget-excluded'));
				const label = DOM.append(excludedRow, $('span.onyx-budget-excluded-label'));
				label.textContent = localize('onyx.budget.excluded', "Kept out:");
				for (const path of excluded) {
					const chip = DOM.append(excludedRow, $('button.onyx-budget-excluded-chip')) as HTMLButtonElement;
					chip.textContent = path;
					chip.title = localize('onyx.budget.readmit', "Let {0} back into the ranking", path);
					chip.addEventListener('click', () => this._pinService.readmit(path));
				}
			}
		});
	}

	private async _pickFileToPin(): Promise<void> {
		const candidates = await this._contextRanker.rank(30);
		const pins = new Set(this._pinService.pins.get());
		const picked = await this._quickInputService.pick(
			candidates.filter(file => !pins.has(file.path)).map(file => ({ label: file.path, description: file.reasons.join(', ') })),
			{ placeHolder: localize('onyx.budget.pinPlaceholder', "Pin a file into every prompt for this workspace") });
		if (picked) {
			this._pinService.pin(picked.label);
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
