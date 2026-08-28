/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../common/onyxConfiguration.js';
import '../browser/controlPlane/onyxControlPlane.contribution.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSharedProcessRemoteService } from '../../../../platform/ipc/electron-browser/services.js';
import { IOnyxRuntimeService } from '../../../../platform/onyxRuntime/common/onyxRuntime.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService, IQuickPickItem, IQuickPickSeparator } from '../../../../platform/quickinput/common/quickInput.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IHostService } from '../../../services/host/browser/host.js';
import { buildHubEntries } from '../common/onyxHub.js';
import { qualifyWorkspacePath } from '../common/onyxWorkspacePaths.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { ILanguageModelsService } from '../../chat/common/languageModels.js';
import { ChatAgentVoteDirection, IChatService } from '../../chat/common/chatService/chatService.js';
import { ONYX_VENDOR } from '../common/onyxTypes.js';
import { OnyxChatAgentContribution } from '../browser/agent/onyxChatAgent.js';
import { OnyxInlineCompletionsContribution } from '../browser/autocomplete/onyxInlineCompletions.js';
import { IOnyxMemoryService, OnyxMemoryService } from '../browser/intelligence/onyxMemoryService.js';
import { OnyxMemoryToolContribution } from '../browser/intelligence/onyxMemoryTool.js';
import { OnyxRetrievalToolContribution } from '../browser/intelligence/onyxRetrievalTool.js';
import { OnyxWorkspaceIndexContribution } from '../browser/intelligence/onyxWorkspaceIndex.js';
import { OnyxBenchmark } from '../browser/benchmark/onyxBenchmark.js';
import { IOnyxDetectedRuntime, ONYX_DETECT_RUNTIMES_COMMAND_ID } from '../browser/onboarding/onyxRuntimeStep.js';
import { IOnyxControlPlaneService, OnyxControlPlaneService } from '../browser/controlPlane/onyxControlPlaneService.js';
import { IOnyxModelService, OnyxModelService } from '../browser/model/onyxLanguageModelProvider.js';
import { IOnyxOutcomeService, OnyxOutcomeService } from '../browser/outcomes/onyxOutcomeService.js';
import { OnyxChatWelcomeContribution } from '../browser/onyxChatWelcome.js';
import { OnyxControlPlaneAccessibilityHelp, OnyxControlPlaneAccessibleView, OnyxInlineEditAccessibilityHelp } from '../browser/onyxAccessibility.js';
import { AccessibleViewRegistry } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { OnyxCodeActionsContribution } from '../browser/editor/onyxCodeActions.js';
import '../browser/editor/onyxInlineEditController.js';
import { IOnyxLedgerService, OnyxLedgerService } from '../browser/compute/onyxLedgerService.js';
import { IOnyxPinService, OnyxPinService } from '../browser/intelligence/onyxPinService.js';
import { IOnyxEnergyService, OnyxEnergyService } from '../browser/compute/onyxEnergyService.js';
import { IOnyxPromptCacheService, OnyxPromptCacheService } from '../browser/agent/onyxPromptCache.js';
import { IOnyxProjectConfigService, OnyxProjectConfigService } from '../browser/config/onyxProjectConfigService.js';
import { OnyxDiagnosticsExport } from '../browser/diagnostics/onyxDiagnosticsExport.js';
import { OnyxModelLibrary } from '../browser/models/onyxModelLibrary.js';
import { OnyxIdleReviewContribution } from '../browser/review/onyxIdleReview.js';
import { OnyxTournament } from '../browser/tournament/onyxTournament.js';
import { OnyxReviewChanges } from '../browser/review/onyxReviewChanges.js';
import { OnyxCommitMessageGenerator } from '../browser/scm/onyxCommitMessage.js';
import { OnyxStatusBarContribution } from '../browser/onyxStatusBar.js';
import { IOnyxProfileService, OnyxProfileService } from '../browser/profiles/onyxProfileService.js';
import { IOnyxRouterService, OnyxRouterService } from '../browser/routing/onyxRouterService.js';

registerSharedProcessRemoteService(IOnyxRuntimeService, 'onyxRuntime');

AccessibleViewRegistry.register(new OnyxControlPlaneAccessibilityHelp());
AccessibleViewRegistry.register(new OnyxControlPlaneAccessibleView());
AccessibleViewRegistry.register(new OnyxInlineEditAccessibilityHelp());

registerSingleton(IOnyxProfileService, OnyxProfileService, InstantiationType.Delayed);
registerSingleton(IOnyxRouterService, OnyxRouterService, InstantiationType.Delayed);
registerSingleton(IOnyxModelService, OnyxModelService, InstantiationType.Delayed);
registerSingleton(IOnyxControlPlaneService, OnyxControlPlaneService, InstantiationType.Delayed);
registerSingleton(IOnyxOutcomeService, OnyxOutcomeService, InstantiationType.Delayed);
registerSingleton(IOnyxMemoryService, OnyxMemoryService, InstantiationType.Delayed);
registerSingleton(IOnyxLedgerService, OnyxLedgerService, InstantiationType.Delayed);
registerSingleton(IOnyxPinService, OnyxPinService, InstantiationType.Delayed);
registerSingleton(IOnyxEnergyService, OnyxEnergyService, InstantiationType.Delayed);
registerSingleton(IOnyxPromptCacheService, OnyxPromptCacheService, InstantiationType.Delayed);
registerSingleton(IOnyxProjectConfigService, OnyxProjectConfigService, InstantiationType.Delayed);

/**
 * Registers the `onyx` language model vendor and provider with the chat stack
 * and connects request measurements to the local learning loop.
 */
class OnyxModelsContribution extends Disposable {

	static readonly ID = 'workbench.contrib.onyxModels';

	constructor(
		@ILanguageModelsService languageModelsService: ILanguageModelsService,
		@IOnyxModelService onyxModelService: IOnyxModelService,
		@IOnyxProfileService onyxProfileService: IOnyxProfileService,
		@IOnyxControlPlaneService onyxControlPlaneService: IOnyxControlPlaneService,
		// Constructed here so the compute ledger sees every request from the first one.
		@IOnyxLedgerService onyxLedgerService: IOnyxLedgerService,
		@IChatService chatService: IChatService,
		@IHostService hostService: IHostService,
		@IOnyxPromptCacheService onyxPromptCacheService: IOnyxPromptCacheService,
		// Constructed here so it journals runs from the very first request.
		@IOnyxOutcomeService _onyxOutcomeService: IOnyxOutcomeService,
	) {
		super();

		// Order matters: the vendor descriptor must exist before the provider
		// registers under it (registerLanguageModelProvider throws otherwise).
		const vendorDescriptor = { vendor: ONYX_VENDOR, displayName: localize('onyx.vendor', "Onyx Local"), configuration: undefined, managementCommand: undefined, when: undefined };
		languageModelsService.deltaLanguageModelChatProviderDescriptors([vendorDescriptor], []);
		this._register({ dispose: () => languageModelsService.deltaLanguageModelChatProviderDescriptors([], [vendorDescriptor]) });
		this._register(languageModelsService.registerLanguageModelProvider(ONYX_VENDOR, onyxModelService));

		this._register(onyxModelService.onDidMeasureRequest(measurement => {
			onyxProfileService.reportMeasurement(measurement);
			if (measurement.timeToFirstTokenMs !== undefined) {
				onyxPromptCacheService.noteFirstToken(measurement.timeToFirstTokenMs);
			}
			onyxControlPlaneService.updateCompute({
				modelKey: measurement.modelKey,
				tokensPerSecond: measurement.tokensPerSecond,
				timeToFirstTokenMs: measurement.timeToFirstTokenMs,
			});
		}));
		this._register(onyxModelService.onDidChangeLoading(({ loading }) => {
			onyxControlPlaneService.updateCompute({ loadingModel: loading });
		}));

		// Pre-warm on window focus: coming back to the editor is the strongest
		// signal that a request is about to happen, and loading weights is the
		// one latency Onyx can pay before the user asks. Rate-limited so focus
		// flapping never turns into a stream of one-token requests.
		let lastWarmUpAt = 0;
		this._register(hostService.onDidChangeFocus(focused => {
			if (!focused || Date.now() - lastWarmUpAt < 5 * 60 * 1000) {
				return;
			}
			lastWarmUpAt = Date.now();
			const currentKey = onyxControlPlaneService.compute.get().modelKey;
			const candidates = new Set<string>();
			if (currentKey && onyxModelService.getKnownModel(currentKey)) {
				candidates.add(currentKey);
			}
			for (const key of candidates) {
				onyxModelService.warmUp(key).catch(() => { /* cold start at worst */ });
			}
		}));

		// The learning loop's outcome signal: votes and kept code count as
		// accept/reject evidence for the model that served the request.
		this._register(chatService.onDidPerformUserAction(event => {
			const run = onyxControlPlaneService.runs.get().find(r => r.requestId === event.requestId);
			if (!run || !run.modelKey.startsWith(`${ONYX_VENDOR}:`)) {
				return;
			}
			const modelKey = run.modelKey.slice(ONYX_VENDOR.length + 1);
			if (event.action.kind === 'vote') {
				const accepted = event.action.direction === ChatAgentVoteDirection.Up;
				onyxProfileService.reportOutcome(modelKey, accepted);
				onyxLedgerService.reportOutcome(modelKey, accepted);
			} else if (event.action.kind === 'insert' || event.action.kind === 'apply' || event.action.kind === 'copy') {
				onyxProfileService.reportOutcome(modelKey, true);
				onyxLedgerService.reportOutcome(modelKey, true);
			}
		}));

		onyxModelService.refresh();
	}
}

registerWorkbenchContribution2(OnyxModelsContribution.ID, OnyxModelsContribution, WorkbenchPhase.AfterRestored);
registerWorkbenchContribution2(OnyxChatAgentContribution.ID, OnyxChatAgentContribution, WorkbenchPhase.AfterRestored);
registerWorkbenchContribution2(OnyxStatusBarContribution.ID, OnyxStatusBarContribution, WorkbenchPhase.AfterRestored);
registerWorkbenchContribution2(OnyxInlineCompletionsContribution.ID, OnyxInlineCompletionsContribution, WorkbenchPhase.Eventually);
registerWorkbenchContribution2(OnyxRetrievalToolContribution.ID, OnyxRetrievalToolContribution, WorkbenchPhase.AfterRestored);
registerWorkbenchContribution2(OnyxMemoryToolContribution.ID, OnyxMemoryToolContribution, WorkbenchPhase.AfterRestored);
registerWorkbenchContribution2(OnyxChatWelcomeContribution.ID, OnyxChatWelcomeContribution, WorkbenchPhase.BlockRestore);
registerWorkbenchContribution2(OnyxCodeActionsContribution.ID, OnyxCodeActionsContribution, WorkbenchPhase.Eventually);
registerWorkbenchContribution2(OnyxWorkspaceIndexContribution.ID, OnyxWorkspaceIndexContribution, WorkbenchPhase.Eventually);
registerWorkbenchContribution2(OnyxIdleReviewContribution.ID, OnyxIdleReviewContribution, WorkbenchPhase.Eventually);

registerAction2(class BenchmarkOnyxModelsAction extends Action2 {
	constructor() {
		super({
			id: 'onyx.benchmarkModels',
			title: localize2('onyx.benchmarkModels', "Onyx: Benchmark Local Models"),
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const instantiationService = accessor.get(IInstantiationService);
		await instantiationService.createInstance(OnyxBenchmark).run();
	}
});

registerAction2(class ClearOnyxMemoryAction extends Action2 {
	constructor() {
		super({
			id: 'onyx.clearMemory',
			title: localize2('onyx.clearMemory', "Onyx: Clear Agent Memory for This Workspace"),
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		accessor.get(IOnyxMemoryService).clear();
	}
});

registerAction2(class ManageOnyxModelsAction extends Action2 {
	constructor() {
		super({
			id: 'onyx.manageModels',
			title: localize2('onyx.manageModels', "Onyx: Manage Models"),
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(IInstantiationService).createInstance(OnyxModelLibrary).show();
	}
});

registerAction2(class ReviewChangesWithOnyxAction extends Action2 {
	constructor() {
		super({
			id: 'onyx.reviewChanges',
			title: localize2('onyx.reviewChanges', "Onyx: Review My Changes"),
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(IInstantiationService).createInstance(OnyxReviewChanges).run();
	}
});

registerAction2(class GenerateCommitMessageAction extends Action2 {
	constructor() {
		super({
			id: 'onyx.generateCommitMessage',
			title: localize2('onyx.generateCommitMessage', "Onyx: Generate Commit Message"),
			icon: Codicon.sparkle,
			f1: true,
			menu: {
				id: MenuId.SCMInputBox,
				when: ContextKeyExpr.equals('scmProvider', 'git'),
				group: 'inline',
			},
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(IInstantiationService).createInstance(OnyxCommitMessageGenerator).generate(undefined);
	}
});

registerAction2(class RunOnyxTournamentAction extends Action2 {
	constructor() {
		super({
			id: 'onyx.runInParallel',
			title: localize2('onyx.runInParallel', "Onyx: Run in Parallel (Tournament)"),
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(IInstantiationService).createInstance(OnyxTournament).run();
	}
});

registerAction2(class ShowOnyxProjectConfigAction extends Action2 {
	constructor() {
		super({
			id: 'onyx.showProjectConfig',
			title: localize2('onyx.showProjectConfig', "Onyx: Show Effective Project Configuration"),
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const projectConfigService = accessor.get(IOnyxProjectConfigService);
		const configurationService = accessor.get(IConfigurationService);
		const editorService = accessor.get(IEditorService);
		const resolved = projectConfigService.resolved.get();
		const userVerification = configurationService.getValue<string>('onyx.verification.task');
		const lines = [
			'// Effective Onyx project configuration (read-only view)',
			resolved.sources.length
				? `// From .onyx/config.json in: ${resolved.sources.join(', ')} — per-user settings always win`
				: '// No .onyx/config.json found in this workspace',
			...resolved.problems.map(problem => `// PROBLEM: ${problem}`),
			...(userVerification && resolved.config.verificationTask
				? [`// NOTE: verificationTask "${resolved.config.verificationTask}" is overridden by the user setting onyx.verification.task = "${userVerification}"`]
				: []),
			JSON.stringify(resolved.config, undefined, '\t'),
		];
		await editorService.openEditor({ resource: undefined, contents: lines.join('\n'), languageId: 'jsonc', options: { pinned: true } });
	}
});

registerAction2(class ExportOnyxDiagnosticsAction extends Action2 {
	constructor() {
		super({
			id: 'onyx.exportDiagnostics',
			title: localize2('onyx.exportDiagnostics', "Onyx: Export Diagnostics"),
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(IInstantiationService).createInstance(OnyxDiagnosticsExport).run();
	}
});

registerAction2(class OpenOnyxHubAction extends Action2 {
	constructor() {
		super({
			id: 'onyx.openHub',
			title: localize2('onyx.openHub', "Open Onyx Hub"),
			f1: true,
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib,
				primary: KeyMod.CtrlCmd | KeyMod.WinCtrl | KeyCode.KeyH,
			},
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const modelService = accessor.get(IOnyxModelService);
		const controlPlaneService = accessor.get(IOnyxControlPlaneService);
		const ledgerService = accessor.get(IOnyxLedgerService);
		const outcomeService = accessor.get(IOnyxOutcomeService);
		const memoryService = accessor.get(IOnyxMemoryService);
		const pinService = accessor.get(IOnyxPinService);
		const quickInputService = accessor.get(IQuickInputService);
		const commandService = accessor.get(ICommandService);

		const models = modelService.getKnownModels();
		const compute = controlPlaneService.compute.get();
		const startOfDay = new Date().setHours(0, 0, 0, 0);
		const runsToday = (await outcomeService.listRuns()).filter(run => run.startedAt >= startOfDay).length;

		const entries = buildHubEntries({
			modelsReady: models.length,
			endpointCount: new Set(models.map(model => model.discovered.baseUrl)).size,
			currentModelKey: compute.modelKey,
			inFlight: compute.inFlight,
			tokensPerSecond: compute.tokensPerSecond,
			sessionRequests: ledgerService.session.get().reduce((total, entry) => total + entry.requests, 0),
			runsToday,
			memoryFacts: memoryService.getNotes().length,
			pinnedFiles: pinService.pins.get().length,
		});

		const picks: (IQuickPickItem & { commandId?: string } | IQuickPickSeparator)[] = [];
		for (const entry of entries) {
			if (entry.group) {
				picks.push({ type: 'separator', label: entry.group });
			}
			picks.push({ id: entry.id, label: entry.label, description: entry.description, commandId: entry.commandId });
		}
		const picked = await quickInputService.pick(picks, {
			title: localize('onyx.hub.title', "Onyx"),
			placeHolder: localize('onyx.hub.placeholder', "Everything Onyx, one place — models, runs, review, compute"),
			matchOnDescription: true,
		});
		if (picked?.commandId) {
			await commandService.executeCommand(picked.commandId);
		}
	}
});

registerAction2(class PinActiveFileAction extends Action2 {
	constructor() {
		super({
			id: 'onyx.pinActiveFile',
			title: localize2('onyx.pinActiveFile', "Onyx: Pin Active File to Context"),
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const editorService = accessor.get(IEditorService);
		const workspaceService = accessor.get(IWorkspaceContextService);
		const pinService = accessor.get(IOnyxPinService);
		const notificationService = accessor.get(INotificationService);
		const resource = editorService.activeEditor?.resource;
		const folders = workspaceService.getWorkspace().folders;
		const folder = resource ? workspaceService.getWorkspaceFolder(resource) : undefined;
		if (!resource || !folder) {
			notificationService.notify({ severity: Severity.Info, message: localize('onyx.pin.noFile', "Open a workspace file to pin it into the prompt.") });
			return;
		}
		const relative = resource.path.slice(folder.uri.path.length + 1);
		pinService.pin(qualifyWorkspacePath(folders.map(f => ({ name: f.name, index: f.index })), folder.index, relative));
	}
});

registerAction2(class ShowOnyxRuntimesAction extends Action2 {
	constructor() {
		super({
			id: 'onyx.showLocalRuntimes',
			title: localize2('onyx.showLocalRuntimes', "Onyx: Show Local Runtimes"),
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const onyxModelService = accessor.get(IOnyxModelService);
		const quickInputService = accessor.get(IQuickInputService);
		await onyxModelService.refresh();
		const models = onyxModelService.getKnownModels();
		if (models.length === 0) {
			await quickInputService.pick([{ label: localize('onyx.noRuntimes', "No local runtimes found. Start Ollama, LM Studio, llama.cpp or vLLM, or configure onyx.endpoints.") }]);
			return;
		}
		await quickInputService.pick(models.map(model => ({
			label: model.discovered.id,
			description: model.discovered.baseUrl,
			detail: [
				model.discovered.runtime,
				model.profile.parameterB ? `${model.profile.parameterB}B` : undefined,
				model.discovered.quantization,
				`${model.profile.contextLength} ctx`,
				`tools: ${model.discovered.supportsTools === undefined ? 'unknown' : model.discovered.supportsTools}`,
			].filter(Boolean).join(' · '),
		})), { placeHolder: localize('onyx.runtimesPlaceholder', "Discovered local models") });
	}
});

/**
 * Onboarding (and any other browser-layer surface that must stay free of
 * Electron dependencies) asks for the current runtime picture through this
 * command rather than importing the shared-process service directly.
 */
CommandsRegistry.registerCommand(ONYX_DETECT_RUNTIMES_COMMAND_ID, async (accessor): Promise<readonly IOnyxDetectedRuntime[]> => {
	const runtimeService = accessor.get(IOnyxRuntimeService);
	try {
		const endpoints = await runtimeService.discoverRuntimes([]);
		return endpoints
			.filter(endpoint => endpoint.models.length > 0)
			.map(endpoint => ({
				displayName: endpoint.displayName,
				host: new URL(endpoint.baseUrl).host,
				modelCount: endpoint.models.length,
			}));
	} catch {
		return [];
	}
});
