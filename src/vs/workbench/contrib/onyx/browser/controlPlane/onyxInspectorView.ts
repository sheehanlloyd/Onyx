/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as DOM from '../../../../../base/browser/dom.js';
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
import { IOnyxRequestRecord, IOnyxRunSummary } from '../../common/onyxTypes.js';
import { IOnyxOutcomeService } from '../outcomes/onyxOutcomeService.js';

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
		if (!this._content) {
			return;
		}
		DOM.clearNode(content);

		if (runs.length === 0) {
			const empty = DOM.append(content, $('.onyx-empty'));
			DOM.append(empty, $('span.codicon.codicon-history'));
			empty.appendChild(document.createTextNode(localize('onyx.inspector.empty', "Past runs are journaled here per workspace. Open one to replay the exact prompt, tools and results every turn sent to the model.")));
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
