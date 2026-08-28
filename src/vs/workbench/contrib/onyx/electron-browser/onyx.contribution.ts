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
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { ILanguageModelsService } from '../../chat/common/languageModels.js';
import { ChatAgentVoteDirection, IChatService } from '../../chat/common/chatService/chatService.js';
import { ONYX_VENDOR } from '../common/onyxTypes.js';
import { OnyxChatAgentContribution } from '../browser/agent/onyxChatAgent.js';
import { OnyxInlineCompletionsContribution } from '../browser/autocomplete/onyxInlineCompletions.js';
import { IOnyxMemoryService, OnyxMemoryService } from '../browser/intelligence/onyxMemoryService.js';
import { OnyxMemoryToolContribution } from '../browser/intelligence/onyxMemoryTool.js';
import { OnyxRetrievalToolContribution } from '../browser/intelligence/onyxRetrievalTool.js';
import { OnyxBenchmark } from '../browser/benchmark/onyxBenchmark.js';
import { IOnyxDetectedRuntime, ONYX_DETECT_RUNTIMES_COMMAND_ID } from '../browser/onboarding/onyxRuntimeStep.js';
import { IOnyxControlPlaneService, OnyxControlPlaneService } from '../browser/controlPlane/onyxControlPlaneService.js';
import { IOnyxModelService, OnyxModelService } from '../browser/model/onyxLanguageModelProvider.js';
import { IOnyxOutcomeService, OnyxOutcomeService } from '../browser/outcomes/onyxOutcomeService.js';
import { OnyxChatWelcomeContribution } from '../browser/onyxChatWelcome.js';
import { OnyxCodeActionsContribution } from '../browser/editor/onyxCodeActions.js';
import { IOnyxLedgerService, OnyxLedgerService } from '../browser/compute/onyxLedgerService.js';
import { OnyxModelLibrary } from '../browser/models/onyxModelLibrary.js';
import { OnyxReviewChanges } from '../browser/review/onyxReviewChanges.js';
import { OnyxCommitMessageGenerator } from '../browser/scm/onyxCommitMessage.js';
import { OnyxStatusBarContribution } from '../browser/onyxStatusBar.js';
import { IOnyxProfileService, OnyxProfileService } from '../browser/profiles/onyxProfileService.js';
import { IOnyxRouterService, OnyxRouterService } from '../browser/routing/onyxRouterService.js';

registerSharedProcessRemoteService(IOnyxRuntimeService, 'onyxRuntime');

registerSingleton(IOnyxProfileService, OnyxProfileService, InstantiationType.Delayed);
registerSingleton(IOnyxRouterService, OnyxRouterService, InstantiationType.Delayed);
registerSingleton(IOnyxModelService, OnyxModelService, InstantiationType.Delayed);
registerSingleton(IOnyxControlPlaneService, OnyxControlPlaneService, InstantiationType.Delayed);
registerSingleton(IOnyxOutcomeService, OnyxOutcomeService, InstantiationType.Delayed);
registerSingleton(IOnyxMemoryService, OnyxMemoryService, InstantiationType.Delayed);
registerSingleton(IOnyxLedgerService, OnyxLedgerService, InstantiationType.Delayed);

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
			onyxControlPlaneService.updateCompute({
				modelKey: measurement.modelKey,
				tokensPerSecond: measurement.tokensPerSecond,
				timeToFirstTokenMs: measurement.timeToFirstTokenMs,
			});
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
