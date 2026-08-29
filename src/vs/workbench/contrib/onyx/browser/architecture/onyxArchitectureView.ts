/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as DOM from '../../../../../base/browser/dom.js';
import * as aria from '../../../../../base/browser/ui/aria/aria.js';
import { RunOnceScheduler } from '../../../../../base/common/async.js';
import { CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../../base/common/network.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { ContextKeyExpr, IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../../platform/hover/browser/hover.js';
import { IInstantiationService, ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { joinPath } from '../../../../../base/common/resources.js';
import { IOnyxArchitectureMap, IOnyxModuleNode } from '../../../../../platform/onyxRuntime/common/onyxArchitecture.js';
import { IOnyxRuntimeService } from '../../../../../platform/onyxRuntime/common/onyxRuntime.js';
import { ViewPane } from '../../../../browser/parts/views/viewPane.js';
import { IViewletViewOptions } from '../../../../browser/parts/views/viewsViewlet.js';
import { IViewDescriptorService } from '../../../../common/views.js';
import { IWorkbenchEnvironmentService } from '../../../../services/environment/common/environmentService.js';
import { IViewsService } from '../../../../services/views/common/viewsService.js';
import { runOneShot } from '../agent/onyxOneShot.js';
import { IOnyxModelService } from '../model/onyxLanguageModelProvider.js';

const SUMMARY_STORAGE_KEY = 'onyx.architecture.summaries';
/** How many of the hottest modules get an automatic model summary. */
const AUTO_SUMMARIES = 6;

/**
 * The architecture map: the workspace as modules with dependency edges, hot
 * spots by churn and fan-in, and a short local-model summary per module.
 * Built once in the shared process, cached against a cheap signature, and
 * rendered as a navigable view — every module and dependency chip opens the
 * real code. This is the "understand a new codebase" surface.
 */
export class OnyxArchitectureViewPane extends ViewPane {

	static readonly ID = 'workbench.view.onyx.architecture';

	private _content: HTMLElement | undefined;
	private _map: IOnyxArchitectureMap | undefined;
	private _analyzing = false;
	private readonly _summaries = new Map<string, string>();
	private readonly _renderDisposables = this._register(new DisposableStore());
	private readonly _moduleElements = new Map<string, HTMLElement>();
	private _summaryGeneration = 0;

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
		@IOnyxRuntimeService private readonly _runtimeService: IOnyxRuntimeService,
		@IWorkspaceContextService private readonly _workspaceService: IWorkspaceContextService,
		@IWorkbenchEnvironmentService private readonly _environmentService: IWorkbenchEnvironmentService,
		@IOnyxModelService private readonly _modelService: IOnyxModelService,
		@ICommandService private readonly _commandService: ICommandService,
		@IStorageService private readonly _storageService: IStorageService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
		try {
			const persisted: Record<string, string> = JSON.parse(this._storageService.get(SUMMARY_STORAGE_KEY, StorageScope.WORKSPACE, '{}'));
			for (const [key, value] of Object.entries(persisted)) {
				this._summaries.set(key, value);
			}
		} catch {
			// corrupt cache: summaries regenerate
		}
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		this._content = DOM.append(container, $('.onyx-view.onyx-architecture'));
		// The first analysis is deferred a beat past visibility: when the view
		// was left open, it gets restored during workbench startup, and nothing
		// Onyx does may ride the restore path.
		const deferredRefresh = this._register(new RunOnceScheduler(() => {
			if (!this._map && !this._analyzing) {
				this.refresh(false);
			}
		}, 1500));
		this._register(this.onDidChangeBodyVisibility(visible => {
			if (visible && !this._map && !this._analyzing) {
				deferredRefresh.schedule();
			}
		}));
		this._renderState();
	}

	async refresh(force: boolean): Promise<void> {
		const folder = this._workspaceService.getWorkspace().folders.find(f => f.uri.scheme === Schemas.file);
		if (!folder || this._analyzing) {
			this._renderState();
			return;
		}
		this._analyzing = true;
		this._renderState();
		try {
			const persist = joinPath(this._environmentService.workspaceStorageHome, this._workspaceService.getWorkspace().id, 'onyx', `architecture-${folder.index}.json`).fsPath;
			this._map = await this._runtimeService.analyzeArchitecture(folder.uri.fsPath, persist, force);
			aria.status(localize('onyx.arch.ready', "Architecture map ready: {0} modules from {1} files.", this._map.modules.length, this._map.totalFiles));
		} catch (error) {
			this._map = undefined;
			aria.alert(localize('onyx.arch.failed', "Architecture analysis failed: {0}", error instanceof Error ? error.message : String(error)));
		} finally {
			this._analyzing = false;
			this._renderState();
			this._autoSummarize();
		}
	}

	private _renderState(): void {
		const content = this._content;
		if (!content) {
			return;
		}
		this._renderDisposables.clear();
		DOM.clearNode(content);
		this._moduleElements.clear();

		if (this._analyzing) {
			const empty = DOM.append(content, $('.onyx-empty'));
			DOM.append(empty, $('.onyx-empty-headline')).textContent = localize('onyx.arch.analyzing', "Mapping the workspace…");
			DOM.append(empty, $('.onyx-empty-body')).textContent = localize('onyx.arch.analyzingBody', "Reading imports, dependencies and history. On big repositories this takes a few seconds the first time; afterwards it is cached.");
			return;
		}
		const map = this._map;
		if (!map) {
			const empty = DOM.append(content, $('.onyx-empty'));
			DOM.append(empty, $('.onyx-empty-headline')).textContent = localize('onyx.arch.none', "No map yet");
			DOM.append(empty, $('.onyx-empty-body')).textContent = localize('onyx.arch.noneBody', "Open a local folder and this view maps its modules, dependencies and hot spots — all computed on this machine.");
			return;
		}

		const header = DOM.append(content, $('.onyx-arch-header'));
		header.textContent = localize('onyx.arch.summary', "{0} modules · {1} files · analyzed in {2}", map.modules.length, map.totalFiles, map.analysisMs >= 1000 ? `${(map.analysisMs / 1000).toFixed(1)}s` : `${map.analysisMs}ms`);
		if (map.truncated) {
			DOM.append(header, $('span.onyx-chip')).textContent = localize('onyx.arch.truncated', "capped");
		}

		for (const module of map.modules) {
			this._renderModule(content, module);
		}
	}

	private _renderModule(parent: HTMLElement, module: IOnyxModuleNode): void {
		const card = DOM.append(parent, $('.onyx-arch-module'));
		this._moduleElements.set(module.id, card);

		const heat = DOM.append(card, $('.onyx-arch-heat'));
		heat.style.setProperty('--onyx-heat', String(module.heat));
		heat.title = localize('onyx.arch.heatTitle', "Hot spot score {0} — churn and fan-in blended", module.heat);

		const header = DOM.append(card, $('.onyx-arch-module-header'));
		const name = DOM.append(header, $('button.onyx-arch-module-name')) as HTMLButtonElement;
		name.textContent = module.id;
		name.title = localize('onyx.arch.open', "Reveal {0} in the Explorer", module.id);
		name.addEventListener('click', () => this._reveal(module.id));

		const stats = DOM.append(header, $('.onyx-arch-module-stats'));
		stats.textContent = localize('onyx.arch.moduleStats', "{0} files · {1} lines · fan-in {2} · {3} commits", module.fileCount, formatLines(module.lines), module.fanIn, module.churnCommits);

		const summary = DOM.append(card, $('.onyx-arch-module-summary'));
		const cached = this._summaries.get(summaryKey(module));
		if (cached) {
			summary.textContent = cached;
		} else {
			const button = DOM.append(summary, $('button.onyx-arch-summarize')) as HTMLButtonElement;
			button.textContent = localize('onyx.arch.summarize', "Summarize with the local model");
			button.addEventListener('click', () => this._summarize(module, summary));
		}

		if (module.dependencies.length > 0) {
			const deps = DOM.append(card, $('.onyx-arch-deps'));
			DOM.append(deps, $('span.onyx-arch-deps-label')).textContent = localize('onyx.arch.dependsOn', "depends on");
			for (const dependency of module.dependencies.slice(0, 8)) {
				const chip = DOM.append(deps, $('button.onyx-arch-dep-chip')) as HTMLButtonElement;
				chip.textContent = `${dependency.to} ·${dependency.count}`;
				chip.title = localize('onyx.arch.depTitle', "{0} import(s) into {1} — click to jump", dependency.count, dependency.to);
				chip.addEventListener('click', () => this._scrollToModule(dependency.to));
			}
			if (module.dependencies.length > 8) {
				DOM.append(deps, $('span.onyx-arch-deps-more')).textContent = localize('onyx.arch.depsMore', "+{0} more", module.dependencies.length - 8);
			}
		}
	}

	private _scrollToModule(id: string): void {
		const element = this._moduleElements.get(id);
		if (element) {
			element.scrollIntoView({ block: 'center' });
			element.classList.remove('onyx-arch-flash');
			// Force a reflow so the animation can replay on repeated jumps.
			void element.offsetWidth;
			element.classList.add('onyx-arch-flash');
		}
	}

	private _reveal(moduleId: string): void {
		const folder = this._workspaceService.getWorkspace().folders.find(f => f.uri.scheme === Schemas.file);
		if (!folder) {
			return;
		}
		const uri = moduleId === '.' ? folder.uri : joinPath(folder.uri, moduleId);
		this._commandService.executeCommand('revealInExplorer', uri).catch(() => undefined);
	}

	/** The hottest modules get summaries on their own, one at a time, cached. */
	private _autoSummarize(): void {
		const map = this._map;
		if (!map || this._modelService.getKnownModels().length === 0) {
			return;
		}
		const generation = ++this._summaryGeneration;
		const pending = map.modules.slice(0, AUTO_SUMMARIES).filter(module => !this._summaries.has(summaryKey(module)));
		const next = async (): Promise<void> => {
			const module = pending.shift();
			if (!module || generation !== this._summaryGeneration) {
				return;
			}
			await this._summarize(module, undefined);
			await next();
		};
		next().catch(() => undefined);
	}

	private async _summarize(module: IOnyxModuleNode, target: HTMLElement | undefined): Promise<void> {
		const folder = this._workspaceService.getWorkspace().folders.find(f => f.uri.scheme === Schemas.file);
		if (!folder) {
			return;
		}
		if (target) {
			DOM.clearNode(target);
			target.textContent = localize('onyx.arch.summarizing', "Summarizing…");
		}
		const cancellation = new CancellationTokenSource();
		try {
			const prompt = [
				`Module: ${module.id} (${module.fileCount} files, ${module.lines} lines).`,
				`It depends on: ${module.dependencies.slice(0, 6).map(dependency => dependency.to).join(', ') || 'nothing internal'}.`,
				'In ONE sentence (max 20 words), state what this module is responsible for, judging by its name and dependencies. No preamble.',
			].join('\n');
			const reply = (await runOneShot(this._modelService, 'You summarize software modules in one short sentence.', prompt, cancellation.token)).trim().replace(/\s+/g, ' ');
			if (reply) {
				this._summaries.set(summaryKey(module), reply);
				this._storageService.store(SUMMARY_STORAGE_KEY, JSON.stringify(Object.fromEntries(this._summaries)), StorageScope.WORKSPACE, StorageTarget.MACHINE);
			}
			this._renderState();
		} catch {
			if (target) {
				target.textContent = localize('onyx.arch.summaryFailed', "No local model available to summarize right now.");
			}
		} finally {
			cancellation.dispose();
		}
	}
}

const $ = DOM.$;

function summaryKey(module: IOnyxModuleNode): string {
	// Lines change when the module meaningfully changes; the summary follows.
	return `${module.id}:${Math.round(module.lines / 200)}`;
}

function formatLines(lines: number): string {
	return lines >= 1000 ? `${(lines / 1000).toFixed(1)}k` : String(lines);
}

registerAction2(class RefreshArchitectureAction extends Action2 {
	constructor() {
		super({
			id: 'onyx.architecture.refresh',
			title: localize2('onyx.architecture.refresh', "Onyx: Rebuild Architecture Map"),
			icon: Codicon.refresh,
			f1: true,
			menu: { id: MenuId.ViewTitle, when: ContextKeyExpr.equals('view', OnyxArchitectureViewPane.ID), group: 'navigation' },
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const viewsService = accessor.get(IViewsService);
		const view = viewsService.getViewWithId(OnyxArchitectureViewPane.ID) as OnyxArchitectureViewPane | null
			?? await viewsService.openView<OnyxArchitectureViewPane>(OnyxArchitectureViewPane.ID, true);
		await view?.refresh(true);
	}
});
