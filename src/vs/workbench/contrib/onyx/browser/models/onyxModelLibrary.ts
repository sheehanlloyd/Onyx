/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { localize } from '../../../../../nls.js';
import { INotificationService, Severity } from '../../../../../platform/notification/common/notification.js';
import { IOnyxEndpoint, IOnyxRuntimeService } from '../../../../../platform/onyxRuntime/common/onyxRuntime.js';
import { IProgressService, ProgressLocation } from '../../../../../platform/progress/common/progress.js';
import { IQuickInputService, IQuickPickItem, IQuickPickSeparator } from '../../../../../platform/quickinput/common/quickInput.js';
import { formatSize, fitModel, IOnyxCatalogModel, ONYX_MODEL_CATALOG, recommendForMachine, toGigabytes } from '../../common/onyxModelCatalog.js';
import { IOnyxModelService } from '../model/onyxLanguageModelProvider.js';

interface IModelPickItem extends IQuickPickItem {
	readonly catalogModel?: IOnyxCatalogModel;
}

/**
 * The model library: what is installed, what is worth installing on *this*
 * machine, and one click to get it. Model choice on a laptop is a memory
 * decision, so the machine's unified memory drives every recommendation
 * instead of a generic "recommended" badge.
 */
export class OnyxModelLibrary {

	constructor(
		@IOnyxRuntimeService private readonly _runtimeService: IOnyxRuntimeService,
		@IOnyxModelService private readonly _modelService: IOnyxModelService,
		@IQuickInputService private readonly _quickInputService: IQuickInputService,
		@IProgressService private readonly _progressService: IProgressService,
		@INotificationService private readonly _notificationService: INotificationService,
	) { }

	async show(): Promise<void> {
		const [machine, endpoints] = await Promise.all([
			this._runtimeService.getMachineProfile(),
			this._runtimeService.discoverRuntimes([]),
		]);
		const memoryGb = toGigabytes(machine.totalMemoryBytes);
		const tier = recommendForMachine(memoryGb);
		const installed = new Set(this._modelService.getKnownModels().map(model => model.discovered.id));

		const picks = buildPicks(installed, memoryGb, tier.recommended);
		const selected = await this._quickInputService.pick<IModelPickItem>(picks, {
			title: localize('onyx.models.title', "Onyx model library"),
			placeHolder: localize('onyx.models.placeholder', "{0} unified memory · {1} — {2}", `${memoryGb} GB`, tier.label, tier.guidance),
			matchOnDescription: true,
			matchOnDetail: true,
		});

		if (!selected?.catalogModel || installed.has(selected.catalogModel.id)) {
			return;
		}
		await this._install(selected.catalogModel, endpoints);
	}

	private async _install(model: IOnyxCatalogModel, endpoints: readonly IOnyxEndpoint[]): Promise<void> {
		const ollama = endpoints.find(endpoint => endpoint.kind === 'ollama');
		if (!ollama) {
			// Every other runtime installs models its own way, so the honest
			// answer is the command, not a button that would silently do nothing.
			this._notificationService.notify({
				severity: Severity.Info,
				message: localize('onyx.models.noOllama', "Onyx can install models automatically only through Ollama. For other runtimes, load `{0}` the way that runtime expects.", model.id),
			});
			return;
		}

		const operationId = generateUuid();
		await this._progressService.withProgress({
			location: ProgressLocation.Notification,
			title: localize('onyx.models.pulling', "Downloading {0}", model.label),
			cancellable: true,
		}, async progress => {
			const store = new DisposableStore();
			const cancellation = new CancellationTokenSource();
			store.add(cancellation);
			try {
				let lastPercent = 0;
				store.add(this._runtimeService.onDidPullProgress(event => {
					if (event.operationId !== operationId || event.done) {
						return;
					}
					const percent = event.totalBytes ? Math.floor((event.completedBytes ?? 0) / event.totalBytes * 100) : undefined;
					progress.report({
						message: percent !== undefined ? `${event.status} · ${percent}%` : event.status,
						increment: percent !== undefined ? percent - lastPercent : undefined,
					});
					if (percent !== undefined) {
						lastPercent = percent;
					}
				}));
				await this._runtimeService.pullModel(operationId, ollama.baseUrl, model.id);
			} finally {
				store.dispose();
			}
		}, () => this._runtimeService.cancel(operationId));

		await this._modelService.refresh();
		const nowInstalled = this._modelService.getKnownModels().some(known => known.discovered.id === model.id);
		this._notificationService.notify({
			severity: nowInstalled ? Severity.Info : Severity.Warning,
			message: nowInstalled
				? localize('onyx.models.installed', "{0} is ready. Onyx will route to it when it is the best fit.", model.label)
				: localize('onyx.models.installFailed', "{0} did not finish downloading. Check that Ollama is still running.", model.label),
		});
	}
}

/**
 * Groups the catalog into what is already here, what this machine should run
 * next, and what it cannot run — so the list answers "what should I do?"
 * rather than listing every model with equal weight.
 */
export function buildPicks(installed: ReadonlySet<string>, memoryGb: number, recommended: readonly string[]): (IModelPickItem | IQuickPickSeparator)[] {
	const picks: (IModelPickItem | IQuickPickSeparator)[] = [];
	const installedModels = ONYX_MODEL_CATALOG.filter(model => installed.has(model.id));
	const others = ONYX_MODEL_CATALOG.filter(model => !installed.has(model.id));
	const isRecommended = (model: IOnyxCatalogModel) => recommended.includes(model.id);

	if (installedModels.length) {
		picks.push({ type: 'separator', label: localize('onyx.models.installedGroup', "Installed") });
		for (const model of installedModels) {
			picks.push(toPick(model, memoryGb, true, isRecommended(model)));
		}
	}

	const suggested = others.filter(isRecommended);
	if (suggested.length) {
		picks.push({ type: 'separator', label: localize('onyx.models.recommendedGroup', "Recommended for {0} GB", memoryGb) });
		for (const model of suggested) {
			picks.push(toPick(model, memoryGb, false, true));
		}
	}

	const rest = others.filter(model => !isRecommended(model));
	if (rest.length) {
		picks.push({ type: 'separator', label: localize('onyx.models.otherGroup', "Also available") });
		for (const model of rest) {
			picks.push(toPick(model, memoryGb, false, false));
		}
	}

	return picks;
}

function toPick(model: IOnyxCatalogModel, memoryGb: number, isInstalled: boolean, isRecommended: boolean): IModelPickItem {
	const fit = fitModel(model, memoryGb);
	const badges = [
		roleLabel(model.role),
		formatSize(model.downloadGb),
		model.quantization,
		fit === 'tooLarge' ? localize('onyx.models.tooLarge', "needs more memory") : undefined,
		fit === 'tight' ? localize('onyx.models.tight', "tight fit") : undefined,
	].filter(Boolean).join(' · ');

	return {
		label: isInstalled ? `$(check) ${model.label}` : (isRecommended ? `$(star-full) ${model.label}` : model.label),
		description: badges,
		detail: isInstalled ? localize('onyx.models.alreadyInstalled', "Installed — {0}", model.note) : model.note,
		catalogModel: model,
	};
}

function roleLabel(role: IOnyxCatalogModel['role']): string {
	switch (role) {
		case 'autocomplete': return localize('onyx.models.role.autocomplete', "autocomplete");
		case 'agent': return localize('onyx.models.role.agent', "agent");
		case 'chat': return localize('onyx.models.role.chat', "chat");
	}
}
