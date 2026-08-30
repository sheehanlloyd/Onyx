/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as DOM from '../../../../../base/browser/dom.js';
import * as aria from '../../../../../base/browser/ui/aria/aria.js';
import { DisposableMap, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { autorun } from '../../../../../base/common/observable.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { ViewPane } from '../../../../browser/parts/views/viewPane.js';
import { IViewletViewOptions } from '../../../../browser/parts/views/viewsViewlet.js';
import { IViewDescriptorService } from '../../../../common/views.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { resolveWorkspacePath } from '../../common/onyxWorkspacePaths.js';
import { OnyxVirtualTimeline } from './onyxVirtualTimeline.js';
import { IOnyxModelService } from '../model/onyxLanguageModelProvider.js';
import { onyxNoRuntimeState, renderOnyxEmptyState } from './onyxEmptyState.js';
import { IOnyxActivityEntry, IOnyxControlPlaneService, IOnyxLiveRun } from './onyxControlPlaneService.js';
import { IOnyxOutcomeService } from '../outcomes/onyxOutcomeService.js';

const $ = DOM.$;

/**
 * Cap on timeline entries kept in the DOM per run. Long runs can journal
 * thousands of steps; older ones collapse behind a "earlier steps" button
 * instead of being rendered (and re-rendered) on every new entry.
 */
const MAX_VISIBLE_ENTRIES = 150;

interface IRenderedRun {
	readonly element: HTMLElement;
	readonly timeline: HTMLElement | undefined;
	readonly earlierButton: HTMLButtonElement | undefined;
	/** Windowed rendering when the user expanded a very long run. */
	readonly virtualTimeline: OnyxVirtualTimeline | undefined;
	/** How many activity entries have been rendered into the timeline so far. */
	renderedCount: number;
	/** How many older entries are collapsed behind the "earlier steps" button. */
	hiddenCount: number;
	/** Everything that forces a structural rebuild when it changes. */
	readonly signature: string;
}

/**
 * The heart of the control plane: every agent run as a live, inspectable
 * timeline — what the agent did, in which order, and why — with pause, stop
 * and redirect controls wired straight into the loop's gates.
 */
export class OnyxActivityViewPane extends ViewPane {

	static readonly ID = 'workbench.view.onyx.activity';

	private _content: HTMLElement | undefined;
	/** Runs in this workspace's journal, including ones from before this window. */
	private _journaledRuns = 0;
	private readonly _expandedRuns = new Set<string>();
	private readonly _showAllRuns = new Set<string>();
	private readonly _renderedRuns = new Map<string, IRenderedRun>();
	private readonly _emptyStateDisposables = this._register(new DisposableStore());
	private readonly _virtualTimelines = this._register(new DisposableMap<string, OnyxVirtualTimeline>());

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
		@IOnyxModelService private readonly _onyxModelService: IOnyxModelService,
		@IClipboardService private readonly _clipboardService: IClipboardService,
		@IEditorService private readonly _editorService: IEditorService,
		@IWorkspaceContextService private readonly _workspaceService: IWorkspaceContextService,
		@IOnyxOutcomeService private readonly _outcomeService: IOnyxOutcomeService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
		this._register(this._outcomeService.onDidChangeRuns(() => this._refreshJournaledRunCount()));
		this._refreshJournaledRunCount();
	}

	/**
	 * This view is live: it shows the runs of *this* window and starts empty
	 * after a reload. The journal outlives the window, though, so "Nothing has
	 * run yet" is simply untrue once there is history — say what is actually
	 * true and point at the Inspector, which replays it.
	 */
	private async _refreshJournaledRunCount(): Promise<void> {
		const count = (await this._outcomeService.listRuns()).length;
		if (this._store.isDisposed || count === this._journaledRuns) {
			return;
		}
		this._journaledRuns = count;
		if (this._controlPlaneService.runs.get().length === 0) {
			this._render(this._controlPlaneService.runs.get(), this._controlPlaneService.selectedRun.get());
		}
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
		// The empty state distinguishes "no runtime" from "nothing run yet", so a
		// model appearing (or the last one vanishing) must swap it live.
		this._register(this._onyxModelService.onDidChangeModels(() => {
			if (this._controlPlaneService.runs.get().length === 0) {
				this._render(this._controlPlaneService.runs.get(), this._controlPlaneService.selectedRun.get());
			}
		}));
	}

	private _render(runs: readonly IOnyxLiveRun[], selected: IOnyxLiveRun | undefined): void {
		const content = this._content;
		if (!content) {
			return;
		}

		// Fast path: same runs in the same structural state, only new activity
		// entries appended. Long runs then cost O(new entries), not O(all).
		if (this._tryIncrementalUpdate(runs, selected)) {
			return;
		}

		DOM.clearNode(content);
		this._renderedRuns.clear();
		this._virtualTimelines.clearAndDisposeAll();
		this._emptyStateDisposables.clear();

		if (runs.length === 0) {
			// Two very different silences: nothing to run on, or nothing run yet.
			const state = this._onyxModelService.getKnownModels().length === 0
				? onyxNoRuntimeState()
				: this._journaledRuns > 0
					? {
						headline: localize('onyx.activity.empty.sinceReload.headline', "Nothing has run in this window"),
						body: this._journaledRuns === 1
							? localize('onyx.activity.empty.sinceReload.one', "This view is live, so it starts empty after a reload. The earlier run in this workspace is in the Inspector below, replayable down to the exact prompt.")
							: localize('onyx.activity.empty.sinceReload', "This view is live, so it starts empty after a reload. The {0} earlier runs in this workspace are in the Inspector below, replayable down to the exact prompt.", this._journaledRuns),
					}
					: {
						headline: localize('onyx.activity.empty.headline', "Nothing has run yet"),
						body: localize('onyx.activity.empty', "Ask the Onyx agent something in chat. Every step it takes shows up here — live, with the reason behind it."),
					};
			renderOnyxEmptyState(content, state, this._clipboardService, this._emptyStateDisposables);
			return;
		}

		for (const run of runs) {
			this._renderRun(content, run, run === selected);
		}
	}

	private _tryIncrementalUpdate(runs: readonly IOnyxLiveRun[], selected: IOnyxLiveRun | undefined): boolean {
		if (runs.length === 0 || runs.length !== this._renderedRuns.size) {
			return false;
		}
		for (const run of runs) {
			const rendered = this._renderedRuns.get(run.runId);
			if (!rendered || rendered.signature !== this._signature(run, run === selected)) {
				return false;
			}
		}
		for (const run of runs) {
			const rendered = this._renderedRuns.get(run.runId)!;
			if (rendered.virtualTimeline) {
				// Windowed mode: hand the full list over; the window re-renders itself.
				const entries = run.activity.get();
				if (entries.length !== rendered.renderedCount) {
					rendered.virtualTimeline.setEntries(entries);
					rendered.renderedCount = entries.length;
				}
				continue;
			}
			if (!rendered.timeline) {
				continue; // collapsed: entry count is not part of the signature
			}
			const entries = run.activity.get();
			for (let i = rendered.renderedCount + rendered.hiddenCount; i < entries.length; i++) {
				this._renderEntry(rendered.timeline, entries[i]);
				rendered.renderedCount++;
				// Screen readers cannot watch a timeline grow: each new step is
				// announced politely, so it never interrupts the user's own work.
				this._announce(entries[i]);
			}
			this._trimTimeline(run, rendered);
		}
		return true;
	}

	/** Keeps the DOM bounded while a run is live-appending: oldest entries move behind the "earlier steps" button. */
	private _trimTimeline(run: IOnyxLiveRun, rendered: IRenderedRun): void {
		if (!rendered.timeline || this._showAllRuns.has(run.runId)) {
			return;
		}
		while (rendered.renderedCount > MAX_VISIBLE_ENTRIES) {
			// Children are [earlier-steps button, entry, entry, ...], so the
			// oldest rendered entry is always at index 1.
			const first = rendered.timeline.children.item(1);
			if (!first) {
				break;
			}
			first.remove();
			rendered.renderedCount--;
			rendered.hiddenCount++;
		}
		if (rendered.hiddenCount > 0 && rendered.earlierButton) {
			rendered.earlierButton.textContent = localize('onyx.activity.earlier', "{0} earlier steps", rendered.hiddenCount);
			rendered.earlierButton.style.display = '';
		}
	}

	private _signature(run: IOnyxLiveRun, isSelected: boolean): string {
		const expanded = this._expandedRuns.has(run.runId) || run.status.get() === 'running' || run.status.get() === 'paused';
		return `${run.status.get()}|${expanded}|${isSelected}|${this._showAllRuns.has(run.runId)}`;
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
		let timeline: HTMLElement | undefined;
		let earlierButton: HTMLButtonElement | undefined;
		let virtualTimeline: OnyxVirtualTimeline | undefined;
		let renderedCount = 0;
		let hiddenCount = 0;
		if (expanded && this._showAllRuns.has(run.runId)) {
			// The whole history was requested: window it instead of building
			// thousands of nodes — 5,000 steps must scroll, not stall.
			const body = DOM.append(runElement, $('.onyx-run-body'));
			const entries = run.activity.get();
			virtualTimeline = new OnyxVirtualTimeline(body, location => this._openLocation(location));
			this._virtualTimelines.set(run.runId, virtualTimeline);
			virtualTimeline.setEntries(entries);
			virtualTimeline.scrollToEnd();
			renderedCount = entries.length;
		} else if (expanded) {
			const body = DOM.append(runElement, $('.onyx-run-body'));
			timeline = DOM.append(body, $('.onyx-timeline'));
			const entries = run.activity.get();
			hiddenCount = Math.max(0, entries.length - MAX_VISIBLE_ENTRIES);
			earlierButton = DOM.append(timeline, $('button.onyx-timeline-earlier')) as HTMLButtonElement;
			earlierButton.textContent = localize('onyx.activity.earlier', "{0} earlier steps", hiddenCount);
			earlierButton.style.display = hiddenCount > 0 ? '' : 'none';
			earlierButton.addEventListener('click', event => {
				event.stopPropagation();
				this._showAllRuns.add(run.runId);
				this._rerender();
			});
			for (const entry of entries.slice(hiddenCount)) {
				this._renderEntry(timeline, entry);
				renderedCount++;
			}
		}
		this._renderedRuns.set(run.runId, { element: runElement, timeline, earlierButton, virtualTimeline, renderedCount, hiddenCount, signature: this._signature(run, isSelected) });
	}

	/** Politely announces one agent step; failures are worth interrupting for. */
	private _announce(entry: IOnyxActivityEntry): void {
		const message = entry.reason ? `${entry.label} — ${entry.reason}` : entry.label;
		if (entry.ok === false) {
			aria.alert(message);
		} else {
			aria.status(message);
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
		if (entry.location) {
			const link = DOM.append(element, $('button.onyx-timeline-link')) as HTMLButtonElement;
			link.textContent = `${entry.location.path}:${entry.location.line}`;
			link.addEventListener('click', event => {
				event.stopPropagation();
				this._openLocation(entry.location!);
			});
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

	private _openLocation(location: { path: string; line: number }): void {
		const folders = this._workspaceService.getWorkspace().folders;
		const resolved = resolveWorkspacePath(folders.map(f => ({ name: f.name, index: f.index })), location.path);
		const folder = resolved ? folders.find(f => f.index === resolved.folderIndex) : undefined;
		if (!resolved || !folder) {
			return;
		}
		this._editorService.openEditor({
			resource: URI.joinPath(folder.uri, resolved.relativePath),
			options: { selection: { startLineNumber: location.line, startColumn: 1 }, pinned: true },
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
