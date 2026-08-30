/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as DOM from '../../../../../base/browser/dom.js';
import * as aria from '../../../../../base/browser/ui/aria/aria.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { autorun } from '../../../../../base/common/observable.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { ContextKeyExpr, IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../../platform/hover/browser/hover.js';
import { IInstantiationService, ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { ViewPane } from '../../../../browser/parts/views/viewPane.js';
import { IViewletViewOptions } from '../../../../browser/parts/views/viewsViewlet.js';
import { IViewDescriptorService } from '../../../../common/views.js';
import { IOnyxStagedFile, IOnyxChangeSetService } from './onyxChangeSetService.js';
import { summarizeChangeSet } from '../../common/onyxChangeSet.js';

const $ = DOM.$;

/**
 * "Onyx Changes": the review surface for everything the agent wants to edit.
 * Each file shows its staged diff as hunks with per-hunk and per-file accept
 * and reject; nothing reaches a buffer until accepted here. The view stays
 * calm while the agent keeps editing — proposals update in place, and the
 * user's position in the review is never yanked away.
 */
export class OnyxChangesViewPane extends ViewPane {

	static readonly ID = 'workbench.view.onyx.changes';

	private _content: HTMLElement | undefined;
	private _firstHeader: HTMLElement | undefined;
	private readonly _expandedFiles = new Set<string>();
	private readonly _renderDisposables = this._register(new DisposableStore());
	private _lastAnnouncedCount = 0;

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
		@IOnyxChangeSetService private readonly _changeSetService: IOnyxChangeSetService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		this._content = DOM.append(container, $('.onyx-view.onyx-changes'));
		this._register(autorun(reader => {
			const files = this._changeSetService.files.read(reader);
			this._render(files);
		}));
		// Coming back to the view is the moment staleness matters: re-check every
		// proposal against its live buffer so the diffs shown are the truth.
		this._register(this.onDidChangeBodyVisibility(visible => {
			if (visible) {
				this._changeSetService.refresh();
			}
		}));
	}

	override focus(): void {
		super.focus();
		this._firstHeader?.focus();
	}

	private _render(files: readonly IOnyxStagedFile[]): void {
		const content = this._content;
		if (!content) {
			return;
		}
		this._renderDisposables.clear();
		DOM.clearNode(content);
		this._firstHeader = undefined;

		// A polite announcement when the staged set grows, so a screen-reader
		// user hears that the agent proposed something without watching a view.
		if (files.length !== this._lastAnnouncedCount) {
			if (files.length > this._lastAnnouncedCount) {
				aria.status(files.length === 1
					? localize('onyx.changes.announce.one', "Onyx staged edits to 1 file, pending your review.")
					: localize('onyx.changes.announce', "Onyx staged edits to {0} files, pending your review.", files.length));
			}
			this._lastAnnouncedCount = files.length;
		}

		if (files.length === 0) {
			const empty = DOM.append(content, $('.onyx-empty'));
			DOM.append(empty, $('.onyx-empty-headline')).textContent = localize('onyx.changes.empty.headline', "No proposed changes");
			DOM.append(empty, $('.onyx-empty-body')).textContent = localize('onyx.changes.empty.body', "When the agent proposes edits, each file lands here as a reviewable diff. Nothing touches your code until you accept it.");
			return;
		}

		const summary = summarizeChangeSet(files.map(file => file.proposal));
		const header = DOM.append(content, $('.onyx-changes-summary'));
		header.textContent = summary.fileCount === 1
			? localize('onyx.changes.summary.one', "1 file · +{0} −{1}", summary.addedLines, summary.removedLines)
			: localize('onyx.changes.summary', "{0} files · +{1} −{2}", summary.fileCount, summary.addedLines, summary.removedLines);
		const headerActions = DOM.append(header, $('.onyx-run-actions'));
		this._textButton(headerActions, localize('onyx.changes.acceptAll', "Accept All"), localize('onyx.changes.acceptAllTitle', "Apply every staged edit"), async () => {
			const applied = await this._changeSetService.acceptAll();
			aria.status(applied === 1
				? localize('onyx.changes.acceptedAll.one', "Applied edits to 1 file.")
				: localize('onyx.changes.acceptedAll', "Applied edits to {0} files.", applied));
		});
		this._textButton(headerActions, localize('onyx.changes.rejectAll', "Reject All"), localize('onyx.changes.rejectAllTitle', "Discard every staged edit — files stay untouched"), () => {
			this._changeSetService.rejectAll();
			aria.status(localize('onyx.changes.rejectedAll', "All staged edits discarded. No file was changed."));
		});

		for (const file of files) {
			this._renderFile(content, file);
		}
	}

	private _renderFile(parent: HTMLElement, file: IOnyxStagedFile): void {
		const element = DOM.append(parent, $('.onyx-change-file'));
		const header = DOM.append(element, $('.onyx-change-file-header'));
		this._firstHeader ??= header;
		header.tabIndex = 0;
		header.setAttribute('role', 'button');
		const expanded = this._expandedFiles.has(file.proposal.path);
		header.setAttribute('aria-expanded', String(expanded));

		const name = DOM.append(header, $('.onyx-change-file-path'));
		name.textContent = file.proposal.path;
		name.title = file.proposal.path;
		if (file.proposal.kind === 'create') {
			DOM.append(header, $('.onyx-chip')).textContent = localize('onyx.changes.new', "new file");
		}
		const counts = summarizeChangeSet([file.proposal]);
		const stat = DOM.append(header, $('.onyx-change-file-stat'));
		stat.textContent = `+${counts.addedLines} −${counts.removedLines}`;
		if (file.risk) {
			const risk = DOM.append(header, $(`.onyx-chip.onyx-risk-${file.risk.level}`));
			risk.textContent = localize('onyx.changes.risk', "{0} risk", file.risk.level);
			risk.title = file.risk.reason;
		}

		const actions = DOM.append(header, $('.onyx-run-actions'));
		this._iconButton(actions, 'go-to-file', localize('onyx.changes.open', "Open the file"), () => this._changeSetService.openDiff(file.proposal.path));
		this._iconButton(actions, 'check', localize('onyx.changes.acceptFile', "Accept all edits in this file"), () => this._changeSetService.acceptFile(file.proposal.path));
		this._iconButton(actions, 'close', localize('onyx.changes.rejectFile', "Reject all edits in this file"), () => this._changeSetService.rejectFile(file.proposal.path));

		const toggle = () => {
			if (this._expandedFiles.has(file.proposal.path)) {
				this._expandedFiles.delete(file.proposal.path);
			} else {
				this._expandedFiles.add(file.proposal.path);
			}
			this._render(this._changeSetService.files.get());
		};
		header.addEventListener('click', toggle);
		header.addEventListener('keydown', event => {
			if (event.key === 'Enter' || event.key === ' ') {
				event.preventDefault();
				toggle();
			}
		});

		if (!expanded) {
			return;
		}
		const body = DOM.append(element, $('.onyx-change-file-body'));
		file.hunks.forEach((hunk, index) => {
			const hunkElement = DOM.append(body, $('.onyx-change-hunk'));
			const hunkHeader = DOM.append(hunkElement, $('.onyx-change-hunk-header'));
			DOM.append(hunkHeader, $('span.onyx-change-hunk-line')).textContent = localize('onyx.changes.hunkAt', "Line {0}", hunk.originalStart + 1);
			const hunkActions = DOM.append(hunkHeader, $('.onyx-run-actions'));
			this._iconButton(hunkActions, 'check', localize('onyx.changes.acceptHunk', "Accept this hunk"), () => this._changeSetService.acceptHunk(file.proposal.path, index));
			this._iconButton(hunkActions, 'close', localize('onyx.changes.rejectHunk', "Reject this hunk"), () => this._changeSetService.rejectHunk(file.proposal.path, index));
			const lines = DOM.append(hunkElement, $('.onyx-change-hunk-lines'));
			for (const removed of hunk.originalLines) {
				DOM.append(lines, $('.onyx-change-line.removed')).textContent = `− ${removed}`;
			}
			for (const added of hunk.newLines) {
				DOM.append(lines, $('.onyx-change-line.added')).textContent = `+ ${added}`;
			}
		});
	}

	private _iconButton(parent: HTMLElement, codicon: string, title: string, onClick: () => void): void {
		const button = DOM.append(parent, $(`button.onyx-icon-button.codicon.codicon-${codicon}`)) as HTMLButtonElement;
		button.title = title;
		button.setAttribute('aria-label', title);
		button.addEventListener('click', event => {
			event.stopPropagation();
			onClick();
		});
	}

	private _textButton(parent: HTMLElement, label: string, title: string, onClick: () => void): void {
		const button = DOM.append(parent, $('button.onyx-text-button')) as HTMLButtonElement;
		button.textContent = label;
		button.title = title;
		button.addEventListener('click', event => {
			event.stopPropagation();
			onClick();
		});
	}
}

registerAction2(class AcceptAllOnyxChangesAction extends Action2 {
	constructor() {
		super({
			id: 'onyx.changes.acceptAll',
			title: localize2('onyx.changes.acceptAllAction', "Onyx: Accept All Proposed Changes"),
			icon: Codicon.checkAll,
			f1: true,
			menu: { id: MenuId.ViewTitle, when: ContextKeyExpr.equals('view', OnyxChangesViewPane.ID), group: 'navigation', order: 1 },
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(IOnyxChangeSetService).acceptAll();
	}
});

registerAction2(class RejectAllOnyxChangesAction extends Action2 {
	constructor() {
		super({
			id: 'onyx.changes.rejectAll',
			title: localize2('onyx.changes.rejectAllAction', "Onyx: Reject All Proposed Changes"),
			icon: Codicon.clearAll,
			f1: true,
			menu: { id: MenuId.ViewTitle, when: ContextKeyExpr.equals('view', OnyxChangesViewPane.ID), group: 'navigation', order: 2 },
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		accessor.get(IOnyxChangeSetService).rejectAll();
	}
});
