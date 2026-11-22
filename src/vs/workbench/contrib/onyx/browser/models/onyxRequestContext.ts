/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { toErrorMessage } from '../../../../../base/common/errorMessage.js';
import { localize } from '../../../../../nls.js';
import { INotificationService, Severity } from '../../../../../platform/notification/common/notification.js';
import { IProgressService, ProgressLocation } from '../../../../../platform/progress/common/progress.js';
import { IQuickInputService, IQuickPickItem } from '../../../../../platform/quickinput/common/quickInput.js';
import { describeAllocation } from '../../common/onyxContextAllocation.js';
import { IOnyxKnownModel, IOnyxModelService } from '../model/onyxLanguageModelProvider.js';
import { IOnyxContextAllocationService } from './onyxContextAllocationService.js';

interface IModelPick extends IQuickPickItem {
	readonly model: IOnyxKnownModel;
}

/** One line per model on where its context stands, for the configuration view (B15, step 6). */
export function describeModelContexts(models: readonly IOnyxKnownModel[], allocationService: IOnyxContextAllocationService): string[] {
	return models.map(model => {
		const record = allocationService.record(model.key);
		const inForce = !!allocationService.inForce(model.key, model.discovered);
		return localize('onyx.context.line', "{0}: budgeted at {1} tokens. {2}", model.discovered.id, model.profile.contextLength, describeAllocation(record, inForce, model.discovered.serverContextLength));
	});
}

/**
 * "Onyx: Request a Larger Model Context" and "Onyx: Remove Model Context
 * Alias" (B15). The first asks a runtime to give a model more context than
 * its default, after the user agrees to what that creates, and uses the
 * result only when a check has seen it work. The second undoes it.
 */
export class OnyxRequestContext {

	constructor(
		@IOnyxModelService private readonly _modelService: IOnyxModelService,
		@IOnyxContextAllocationService private readonly _allocationService: IOnyxContextAllocationService,
		@IQuickInputService private readonly _quickInputService: IQuickInputService,
		@IProgressService private readonly _progressService: IProgressService,
		@INotificationService private readonly _notificationService: INotificationService,
	) { }

	private async _pick(candidates: readonly IOnyxKnownModel[], title: string): Promise<IOnyxKnownModel | undefined> {
		if (candidates.length <= 1) {
			return candidates[0];
		}
		return (await this._quickInputService.pick<IModelPick>(candidates.map(candidate => ({
			label: candidate.discovered.id,
			description: candidate.discovered.baseUrl,
			detail: describeAllocation(this._allocationService.record(candidate.key), !!this._allocationService.inForce(candidate.key, candidate.discovered), candidate.discovered.serverContextLength),
			model: candidate,
		})), { title }))?.model;
	}

	async request(): Promise<void> {
		await this._modelService.refresh();
		const known = this._modelService.getKnownModels();
		if (known.length === 0) {
			this._notificationService.notify({ severity: Severity.Info, message: localize('onyx.context.noModels', "There is no local model to request a context for. Start a local runtime, then try again.") });
			return;
		}
		const model = await this._pick(known, localize('onyx.context.pick.title', "Request a larger context for a model"));
		if (!model) {
			return;
		}
		const source = new CancellationTokenSource();
		try {
			const outcome = await this._progressService.withProgress({
				location: ProgressLocation.Notification,
				title: localize('onyx.context.progress', "Requesting and checking a context for {0}", model.discovered.id),
				cancellable: true,
			}, () => this._allocationService.request({ modelKey: model.key, discovered: model.discovered, apiKey: model.apiKey }, source.token), () => source.cancel());
			if (outcome.kind === 'cancelled') {
				return;
			}
			await this._modelService.refresh();
			const refreshed = this._modelService.getKnownModel(model.key) ?? model;
			this._notificationService.notify({
				severity: outcome.kind === 'recorded' && outcome.record.status === 'verified' ? Severity.Info : Severity.Warning,
				message: outcome.kind === 'nothing-to-request' ? outcome.reason : describeModelContexts([refreshed], this._allocationService)[0],
			});
		} catch (error) {
			this._notificationService.notify({ severity: Severity.Error, message: localize('onyx.context.failed', "The context for {0} could not be requested: {1}", model.discovered.id, toErrorMessage(error)) });
		} finally {
			source.dispose();
		}
	}

	async remove(): Promise<void> {
		await this._modelService.refresh();
		const withRecord = this._modelService.getKnownModels().filter(model => this._allocationService.record(model.key));
		if (withRecord.length === 0) {
			this._notificationService.notify({ severity: Severity.Info, message: localize('onyx.context.nothingToRemove', "Onyx has not requested a context for any model on a running runtime.") });
			return;
		}
		const model = await this._pick(withRecord, localize('onyx.context.remove.title', "Remove a model's context alias"));
		if (!model) {
			return;
		}
		const error = await this._allocationService.undo(model.key, model.discovered);
		await this._modelService.refresh();
		this._notificationService.notify(error
			? { severity: Severity.Error, message: localize('onyx.context.remove.failed', "The alias for {0} could not be removed: {1}", model.discovered.id, error) }
			: { severity: Severity.Info, message: localize('onyx.context.remove.done', "{0} is back on the server's own allocation; the alias is removed.", model.discovered.id) });
	}
}
