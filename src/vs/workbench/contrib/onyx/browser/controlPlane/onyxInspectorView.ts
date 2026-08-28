/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as DOM from '../../../../../base/browser/dom.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
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
import { diffRuns, IOnyxRunDiffSection } from '../../common/onyxRunDiff.js';
import { IOnyxRequestRecord, IOnyxRunSummary } from '../../common/onyxTypes.js';
import { IOnyxOutcomeService } from '../outcomes/onyxOutcomeService.js';
import { renderOnyxEmptyState } from './onyxEmptyState.js';

const $ = DOM.$;

/**
 * Replay for past agent runs: every run persisted in the workspace journal,
 * expandable to the exact wire-level prompt each turn sent to the model —
 * messages, tool schemas, routing, results. Reproducibility beats vibes.
 */
export class OnyxInspectorViewPane extends ViewPane {

	static readonly ID = 'workbench.view.onyx.inspector';

	private _content: HTMLElement | undefined;
	private _openRunId: string | undefined;
	/** First run picked for comparison; the next pick renders the diff. */
	private _compareAnchorId: string | undefined;
	private _diffPair: [string, string] | undefined;
	private readonly _emptyStateDisposables = this._register(new DisposableStore());

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
		@IOnyxOutcomeService private readonly _outcomeService: IOnyxOutcomeService,
		@IClipboardService private readonly _clipboardService: IClipboardService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
		this._register(this._outcomeService.onDidChangeRuns(() => this._refresh()));
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		this._content = DOM.append(container, $('.onyx-view'));
		this._refresh();
	}

	private async _refresh(): Promise<void> {
		const content = this._content;
		if (!content) {
			return;
		}
		const runs = await this._outcomeService.listRuns();
		const open = this._openRunId ? await this._outcomeService.readRun(this._openRunId) : undefined;
		const diffPair = this._diffPair;
		const diffRecords = diffPair
			? await Promise.all([this._outcomeService.readRun(diffPair[0]), this._outcomeService.readRun(diffPair[1])])
			: undefined;
		if (!this._content) {
			return;
		}
		DOM.clearNode(content);
		this._emptyStateDisposables.clear();

		if (diffRecords && diffRecords[0] && diffRecords[1]) {
			this._renderDiff(content, diffRecords[0], diffRecords[1]);
			return;
		}

		if (runs.length === 0) {
			renderOnyxEmptyState(content, {
				headline: localize('onyx.inspector.empty.headline', "No journaled runs"),
				body: localize('onyx.inspector.empty', "Past runs are journaled here per workspace. Open one to replay the exact prompt, tools and results every turn sent to the model."),
			}, this._clipboardService, this._emptyStateDisposables);
			return;
		}

		for (const run of runs) {
			this._renderRunRow(content, run, open?.runId === run.runId ? open : undefined);
		}
	}

	private _renderRunRow(parent: HTMLElement, run: IOnyxRunSummary, detail: IOnyxRequestRecord | undefined): void {
		const row = DOM.append(parent, $(`.onyx-run.${run.status}`));
		row.classList.toggle('selected', !!detail);

		const header = DOM.append(row, $('.onyx-run-header'));
		DOM.append(header, $('.onyx-run-status'));
		const title = DOM.append(header, $('.onyx-run-title'));
		title.textContent = run.title || localize('onyx.inspector.untitled', "Untitled run");
		title.title = `${run.modelKey} · ${new Date(run.startedAt).toLocaleString()}`;
		const meta = DOM.append(header, $('span.onyx-inspector-meta'));
		meta.textContent = localize('onyx.inspector.meta', "{0} turns · {1} tools", run.turnCount, run.toolCallCount);
		const chip = DOM.append(header, $('.onyx-chip'));
		chip.textContent = run.task;

		const compare = DOM.append(header, $('button.onyx-icon-button.codicon.codicon-git-compare')) as HTMLButtonElement;
		compare.classList.toggle('checked', this._compareAnchorId === run.runId);
		compare.title = this._compareAnchorId === undefined
			? localize('onyx.inspector.compare', "Compare this run with another")
			: this._compareAnchorId === run.runId
				? localize('onyx.inspector.compareCancel', "Cancel comparison")
				: localize('onyx.inspector.compareWith', "Compare with the marked run");
		compare.addEventListener('click', event => {
			event.stopPropagation();
			if (this._compareAnchorId === undefined) {
				this._compareAnchorId = run.runId;
			} else if (this._compareAnchorId === run.runId) {
				this._compareAnchorId = undefined;
			} else {
				this._diffPair = [this._compareAnchorId, run.runId];
				this._compareAnchorId = undefined;
			}
			this._refresh();
		});

		header.addEventListener('click', () => {
			this._openRunId = this._openRunId === run.runId ? undefined : run.runId;
			this._refresh();
		});

		if (detail) {
			const body = DOM.append(row, $('.onyx-run-body'));
			for (const event of detail.events) {
				if (event.kind === 'promptSnapshot') {
					this._renderSnapshot(body, event.data);
				}
			}
			if (!detail.events.some(e => e.kind === 'promptSnapshot')) {
				const none = DOM.append(body, $('.onyx-inspector-none'));
				none.textContent = localize('onyx.inspector.noSnapshots', "No prompt snapshots were journaled for this run.");
			}
		}
	}

	private _renderDiff(parent: HTMLElement, first: IOnyxRequestRecord, second: IOnyxRequestRecord): void {
		// Older run on the left so reading order matches time.
		const [left, right] = first.startedAt <= second.startedAt ? [first, second] : [second, first];
		const container = DOM.append(parent, $('.onyx-run-diff'));

		const toolbar = DOM.append(container, $('.onyx-run-diff-toolbar'));
		const back = DOM.append(toolbar, $('button.onyx-icon-button.codicon.codicon-arrow-left')) as HTMLButtonElement;
		back.title = localize('onyx.inspector.diffBack', "Back to the run list");
		back.addEventListener('click', () => {
			this._diffPair = undefined;
			this._refresh();
		});
		const heading = DOM.append(toolbar, $('span.onyx-run-diff-title'));
		heading.textContent = localize('onyx.inspector.diffTitle', "Comparing two runs");

		const columns = DOM.append(container, $('.onyx-run-diff-columns'));
		DOM.append(columns, $('span')).textContent = `${left.title} · ${new Date(left.startedAt).toLocaleTimeString()}`;
		DOM.append(columns, $('span')).textContent = `${right.title} · ${new Date(right.startedAt).toLocaleTimeString()}`;

		for (const section of diffRuns(left, right)) {
			this._renderDiffSection(container, section);
		}
	}

	private _renderDiffSection(parent: HTMLElement, section: IOnyxRunDiffSection): void {
		if (section.kind === 'elision') {
			const elision = DOM.append(parent, $('.onyx-run-diff-elision'));
			elision.textContent = localize('onyx.inspector.diffElision', "· {0} identical turns ·", section.turns);
			return;
		}
		const block = DOM.append(parent, $('.onyx-run-diff-section'));
		const header = DOM.append(block, $('.onyx-run-diff-section-header'));
		header.textContent = section.kind === 'turn'
			? localize('onyx.inspector.diffTurn', "Turn {0}", section.turn)
			: section.kind === 'outcome'
				? localize('onyx.inspector.diffOutcome', "Outcome")
				: localize('onyx.inspector.diffMeta', "Request");
		for (const row of section.rows) {
			const rowElement = DOM.append(block, $('.onyx-run-diff-row'));
			rowElement.classList.toggle('changed', row.changed);
			DOM.append(rowElement, $('span.onyx-run-diff-label')).textContent = row.label;
			const cells = DOM.append(rowElement, $('.onyx-run-diff-cells'));
			for (const value of [row.left, row.right]) {
				const cell = DOM.append(cells, $('pre.onyx-run-diff-cell'));
				cell.textContent = value ?? '—';
			}
		}
	}

	private _renderSnapshot(parent: HTMLElement, data: unknown): void {
		const snapshot = data as { turn?: number; model?: string; tools?: string[]; messages?: { role: number; content: { type: string; value?: string; name?: string }[] }[] };
		const section = DOM.append(parent, $('.onyx-inspector-snapshot'));
		const header = DOM.append(section, $('.onyx-inspector-snapshot-header'));
		header.textContent = localize('onyx.inspector.turnHeader', "Turn {0} → {1}", snapshot.turn ?? '?', snapshot.model ?? '?');
		if (snapshot.tools?.length) {
			const tools = DOM.append(section, $('.onyx-inspector-tools'));
			tools.textContent = localize('onyx.inspector.tools', "tools: {0}", snapshot.tools.join(', '));
		}
		for (const message of snapshot.messages ?? []) {
			const messageElement = DOM.append(section, $('.onyx-inspector-message'));
			const role = DOM.append(messageElement, $('span.onyx-inspector-role'));
			role.textContent = roleLabel(message.role);
			const text = (message.content ?? [])
				.map(part => part.type === 'tool_use' ? `⚙ ${part.name}` : part.value ?? `[${part.type}]`)
				.join('\n');
			const pre = DOM.append(messageElement, $('pre.onyx-inspector-pre'));
			pre.textContent = text;
		}
	}
}

function roleLabel(role: number): string {
	switch (role) {
		case 0: return localize('onyx.inspector.system', "system");
		case 2: return localize('onyx.inspector.assistant', "assistant");
		default: return localize('onyx.inspector.user', "user");
	}
}
