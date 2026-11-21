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
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { describeDatasheet, describeProvenance, IOnyxDatasheet } from '../../common/onyxDatasheet.js';
import { OnyxProbeName, OnyxProbesCancelledError } from '../../common/onyxDatasheetProbes.js';
import { IOnyxKnownModel, IOnyxModelService } from '../model/onyxLanguageModelProvider.js';
import { IOnyxDatasheetService } from './onyxDatasheetService.js';

interface IModelPick extends IQuickPickItem {
	readonly model: IOnyxKnownModel;
}

/** What the progress notification says while a probe runs. */
function probeLabel(probe: OnyxProbeName): string {
	switch (probe) {
		case 'tool calls': return localize('onyx.measure.probe.toolCalls', "tool calls");
		case 'schema enforcement': return localize('onyx.measure.probe.schema', "schema enforcement");
		case 'context': return localize('onyx.measure.probe.context', "context");
		case 'output cap and stop': return localize('onyx.measure.probe.capAndStop', "output cap and stop");
		case 'reasoning': return localize('onyx.measure.probe.reasoning', "reasoning");
		case 'seed': return localize('onyx.measure.probe.seed', "repeatability");
		case 'log-probabilities and speed': return localize('onyx.measure.probe.speed', "log-probabilities and speed");
		case 'done': return localize('onyx.measure.probe.done', "done");
	}
}

/**
 * "Onyx: Measure This Model" (L5). Runs the probe suite against a model the
 * user picks, on the runtime that serves it, and shows what was found and
 * what the model's profile now takes from it. It runs only when asked, sends
 * fixed prompts that carry nothing of the user's, and keeps the result on
 * this machine.
 */
export class OnyxMeasureModel {

	constructor(
		@IOnyxModelService private readonly _modelService: IOnyxModelService,
		@IOnyxDatasheetService private readonly _datasheetService: IOnyxDatasheetService,
		@IQuickInputService private readonly _quickInputService: IQuickInputService,
		@IProgressService private readonly _progressService: IProgressService,
		@INotificationService private readonly _notificationService: INotificationService,
		@IEditorService private readonly _editorService: IEditorService,
	) { }

	async run(): Promise<void> {
		await this._modelService.refresh();
		const known = this._modelService.getKnownModels();
		if (known.length === 0) {
			this._notificationService.notify({ severity: Severity.Info, message: localize('onyx.measure.noModels', "There is no local model to measure. Start a local runtime, then try again.") });
			return;
		}
		const model = known.length === 1 ? known[0] : (await this._quickInputService.pick<IModelPick>(known.map(candidate => {
			const stored = this._datasheetService.stored(candidate.key, candidate.discovered);
			return {
				label: candidate.discovered.id,
				description: candidate.discovered.baseUrl,
				detail: !stored
					? localize('onyx.measure.pick.never', "Not measured")
					: stored.stale
						? localize('onyx.measure.pick.stale', "Measured {0}; not used now: {1}", stored.datasheet.measuredAt.slice(0, 10), stored.stale)
						: localize('onyx.measure.pick.current', "Measured {0}", stored.datasheet.measuredAt.slice(0, 10)),
				model: candidate,
			};
		}), {
			title: localize('onyx.measure.title', "Measure a model"),
			placeHolder: localize('onyx.measure.placeholder', "About a minute of short requests to the model's own runtime. Nothing leaves this machine."),
		}))?.model;
		if (!model) {
			return;
		}

		const source = new CancellationTokenSource();
		let datasheet: IOnyxDatasheet;
		try {
			datasheet = await this._progressService.withProgress({
				location: ProgressLocation.Notification,
				title: localize('onyx.measure.progress', "Measuring {0}", model.discovered.id),
				cancellable: true,
			}, progress => this._datasheetService.measure({ modelKey: model.key, discovered: model.discovered, apiKey: model.apiKey }, source.token,
				(probe, done, total) => progress.report({ message: localize('onyx.measure.step', "{0} ({1} of {2})", probeLabel(probe), Math.min(done + 1, total), total), increment: done === 0 ? 0 : 100 / total })),
				() => source.cancel());
		} catch (error) {
			if (!(error instanceof OnyxProbesCancelledError)) {
				this._notificationService.notify({ severity: Severity.Error, message: localize('onyx.measure.failed', "{0} could not be measured: {1}", model.discovered.id, toErrorMessage(error)) });
			}
			return;
		} finally {
			source.dispose();
		}

		// The profile is rebuilt from the datasheet; read it back to say what it now uses.
		await this._modelService.refresh();
		const profile = this._modelService.getKnownModel(model.key)?.profile;
		const lines = [
			localize('onyx.measure.report.title', "Datasheet for {0}", model.discovered.id),
			localize('onyx.measure.report.subject', "Weights {0} on {1} {2}, measured {3}", datasheet.digest ?? localize('onyx.measure.report.noDigest', "(no digest reported)"), datasheet.runtime.name, datasheet.runtime.version ?? localize('onyx.measure.report.noVersion', "(version not reported)"), datasheet.measuredAt),
			'',
			...describeDatasheet(datasheet),
			'',
			localize('onyx.measure.report.profile', "What the profile uses now"),
			...(profile ? describeProvenance(profile) : []),
			'',
			localize('onyx.measure.report.footer', "A datasheet is kept on this machine and is used until the model's weights or the runtime's version change. Every result is a count of successes over trials; the trials are few, so read them as that."),
		];
		await this._editorService.openEditor({ resource: undefined, contents: lines.join('\n'), languageId: 'plaintext', options: { pinned: true } });
	}
}
