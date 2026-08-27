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
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { ViewPane } from '../../../../browser/parts/views/viewPane.js';
import { IViewletViewOptions } from '../../../../browser/parts/views/viewsViewlet.js';
import { IViewDescriptorService } from '../../../../common/views.js';
import { IOnyxActivityEntry, IOnyxControlPlaneService, IOnyxLiveRun } from './onyxControlPlaneService.js';

const $ = DOM.$;

/**
 * The heart of the control plane: every agent run as a live, inspectable
 * timeline — what the agent did, in which order, and why — with pause, stop
 * and redirect controls wired straight into the loop's gates.
 */
export class OnyxActivityViewPane extends ViewPane {

	static readonly ID = 'workbench.view.onyx.activity';

	private _content: HTMLElement | undefined;
	private readonly _expandedRuns = new Set<string>();

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
		@IQuickInputService private readonly _quickInputService: IQuickInputService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		this._content = DOM.append(container, $('.onyx-view'));

		this._register(autorun(reader => {
			const runs = this._controlPlaneService.runs.read(reader);
			const selected = this._controlPlaneService.selectedRun.read(reader);
			// Register nested observable reads so any run's status/activity change re-renders.
			for (const run of runs) {
				run.status.read(reader);
				run.activity.read(reader);
			}
			this._render(runs, selected);
		}));
	}

	private _render(runs: readonly IOnyxLiveRun[], selected: IOnyxLiveRun | undefined): void {
		const content = this._content;
		if (!content) {
			return;
		}
		DOM.clearNode(content);

		if (runs.length === 0) {
			const empty = DOM.append(content, $('.onyx-empty'));
			DOM.append(empty, $('span.codicon.codicon-pulse'));
			empty.appendChild(document.createTextNode(localize('onyx.activity.empty', "No agent runs yet. Ask the Onyx agent something in chat and every step will show up here — live, with reasons.")));
			return;
		}

		for (const run of runs) {
			this._renderRun(content, run, run === selected);
		}
	}

	private _renderRun(parent: HTMLElement, run: IOnyxLiveRun, isSelected: boolean): void {
		const status = run.status.get();
		const runElement = DOM.append(parent, $(`.onyx-run.${status}`));
		runElement.classList.toggle('selected', isSelected);

		const header = DOM.append(runElement, $('.onyx-run-header'));
		DOM.append(header, $('.onyx-run-status'));
		const title = DOM.append(header, $('.onyx-run-title'));
		title.textContent = run.title || localize('onyx.activity.untitled', "Untitled run");
		title.title = run.title;
		const chip = DOM.append(header, $('.onyx-chip'));
		chip.textContent = run.task;

		const actions = DOM.append(header, $('.onyx-run-actions'));
		if (status === 'running') {
			this._iconButton(actions, 'debug-pause', localize('onyx.activity.pause', "Pause after the current step"), () => this._controlPlaneService.pause(run.runId));
			this._iconButton(actions, 'comment-discussion', localize('onyx.activity.redirect', "Redirect the agent"), () => this._redirect(run.runId));
			this._iconButton(actions, 'debug-stop', localize('onyx.activity.stop', "Stop this run"), () => this._controlPlaneService.stop(run.runId));
		} else if (status === 'paused') {
			this._iconButton(actions, 'debug-continue', localize('onyx.activity.resume', "Resume"), () => this._controlPlaneService.resume(run.runId));
			this._iconButton(actions, 'comment-discussion', localize('onyx.activity.redirect', "Redirect the agent"), () => this._redirect(run.runId));
			this._iconButton(actions, 'debug-stop', localize('onyx.activity.stop', "Stop this run"), () => this._controlPlaneService.stop(run.runId));
		}

		header.addEventListener('click', () => {
			this._controlPlaneService.selectRun(run.runId);
			if (this._expandedRuns.has(run.runId)) {
				this._expandedRuns.delete(run.runId);
			} else {
				this._expandedRuns.add(run.runId);
			}
			this._rerender();
		});

		const expanded = this._expandedRuns.has(run.runId) || status === 'running' || status === 'paused';
		if (expanded) {
			const body = DOM.append(runElement, $('.onyx-run-body'));
			const timeline = DOM.append(body, $('.onyx-timeline'));
			for (const entry of run.activity.get()) {
				this._renderEntry(timeline, entry);
			}
		}
	}

	private _renderEntry(timeline: HTMLElement, entry: IOnyxActivityEntry): void {
		const element = DOM.append(timeline, $('.onyx-timeline-entry'));
		if (entry.ok === true) {
			element.classList.add('ok');
		} else if (entry.ok === false) {
			element.classList.add('error');
		}
		const label = DOM.append(element, $('.onyx-timeline-label'));
		const kind = DOM.append(label, $('span.onyx-timeline-kind'));
		kind.textContent = entryKindLabel(entry.kind);
		label.appendChild(document.createTextNode(entry.label));
		if (entry.reason) {
			const reason = DOM.append(element, $('span.onyx-timeline-reason'));
			reason.textContent = entry.reason;
		}
	}

	private _iconButton(parent: HTMLElement, codicon: string, title: string, onClick: () => void): void {
		const button = DOM.append(parent, $(`button.onyx-icon-button.codicon.codicon-${codicon}`)) as HTMLButtonElement;
		button.title = title;
		button.addEventListener('click', event => {
			event.stopPropagation();
			onClick();
		});
	}

	private async _redirect(runId: string): Promise<void> {
		const instruction = await this._quickInputService.input({
			prompt: localize('onyx.activity.redirectPrompt', "Tell the agent what to do differently. It is applied before its next step."),
			placeHolder: localize('onyx.activity.redirectPlaceholder', "e.g. Stop editing tests, focus on the parser first"),
		});
		if (instruction) {
			this._controlPlaneService.redirect(runId, instruction);
		}
	}

	private _rerender(): void {
		this._render(this._controlPlaneService.runs.get(), this._controlPlaneService.selectedRun.get());
	}
}

function entryKindLabel(kind: IOnyxActivityEntry['kind']): string {
	switch (kind) {
		case 'turn': return localize('onyx.entry.turn', "turn");
		case 'toolCall': return localize('onyx.entry.toolCall', "tool");
		case 'toolResult': return localize('onyx.entry.toolResult', "result");
		case 'route': return localize('onyx.entry.route', "route");
		case 'steer': return localize('onyx.entry.steer', "steer");
		default: return localize('onyx.entry.note', "note");
	}
}
