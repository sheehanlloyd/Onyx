/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../common/onyxConfiguration.js';
import '../browser/controlPlane/onyxControlPlane.contribution.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSharedProcessRemoteService } from '../../../../platform/ipc/electron-browser/services.js';
import { IOnyxRuntimeService } from '../../../../platform/onyxRuntime/common/onyxRuntime.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { ILanguageModelsService } from '../../chat/common/languageModels.js';
import { ONYX_VENDOR } from '../common/onyxTypes.js';
import { OnyxChatAgentContribution } from '../browser/agent/onyxChatAgent.js';
import { IOnyxControlPlaneService, OnyxControlPlaneService } from '../browser/controlPlane/onyxControlPlaneService.js';
import { IOnyxModelService, OnyxModelService } from '../browser/model/onyxLanguageModelProvider.js';
import { IOnyxProfileService, OnyxProfileService } from '../browser/profiles/onyxProfileService.js';
import { IOnyxRouterService, OnyxRouterService } from '../browser/routing/onyxRouterService.js';

registerSharedProcessRemoteService(IOnyxRuntimeService, 'onyxRuntime');

registerSingleton(IOnyxProfileService, OnyxProfileService, InstantiationType.Delayed);
registerSingleton(IOnyxRouterService, OnyxRouterService, InstantiationType.Delayed);
registerSingleton(IOnyxModelService, OnyxModelService, InstantiationType.Delayed);
registerSingleton(IOnyxControlPlaneService, OnyxControlPlaneService, InstantiationType.Delayed);

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

		onyxModelService.refresh();
	}
}

registerWorkbenchContribution2(OnyxModelsContribution.ID, OnyxModelsContribution, WorkbenchPhase.AfterRestored);
registerWorkbenchContribution2(OnyxChatAgentContribution.ID, OnyxChatAgentContribution, WorkbenchPhase.AfterRestored);

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
