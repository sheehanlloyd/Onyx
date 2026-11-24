/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { IObservable, ISettableObservable, observableValue } from '../../../../../base/common/observable.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { createDecorator, ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { INotificationService, Severity } from '../../../../../platform/notification/common/notification.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { IOnyxRuntimeService, IOnyxStreamEvent } from '../../../../../platform/onyxRuntime/common/onyxRuntime.js';
import { OnyxSettingId } from '../../common/onyxConfiguration.js';
import { candidateDrafts, draftAttachment, formatSpeculativeReadout, IOnyxSpeculativeMeasurement, IOnyxSpeculativeSpeed, medianSpeed, ONYX_SPECULATIVE_PROMPTS, speculativeSetupHint, speculativeSupport } from '../../common/onyxSpeculative.js';
import { IOnyxModelService } from '../model/onyxLanguageModelProvider.js';

export const IOnyxSpeculativeService = createDecorator<IOnyxSpeculativeService>('onyxSpeculativeService');

const STORAGE_KEY = 'onyx.speculative.measurements';
/** Enough tokens that tok/s means generation, not TTFT noise. */
const MEASURE_MAX_TOKENS = 160;
const MEASURE_ROUNDS = 3;

interface IOnyxSpeculativeSpeeds { readonly code: IOnyxSpeculativeSpeed; readonly prose: IOnyxSpeculativeSpeed }

/**
 * Speculative-decoding pairing and its honest measurement. Every runtime that
 * supports it wants the draft configured when the model LOADS, so Onyx cannot
 * flip it on mid-session: it measures the target as it stands, tells the user
 * exactly how to enable the draft on their runtime, waits, then runs the same
 * prompt again. The Compute view reports only what was measured here —
 * including "no measured effect".
 */
export interface IOnyxSpeculativeService {
	readonly _serviceBrand: undefined;
	/** Latest measurement per target model key. */
	readonly measurements: IObservable<readonly IOnyxSpeculativeMeasurement[]>;
	/** Runs the pairing picker, then measures the chosen pair. */
	pairAndMeasure(): Promise<void>;
}

export class OnyxSpeculativeService extends Disposable implements IOnyxSpeculativeService {

	declare readonly _serviceBrand: undefined;

	private readonly _measurementsObs: ISettableObservable<readonly IOnyxSpeculativeMeasurement[]>;
	readonly measurements: IObservable<readonly IOnyxSpeculativeMeasurement[]>;

	constructor(
		@IOnyxModelService private readonly _modelService: IOnyxModelService,
		@IOnyxRuntimeService private readonly _runtimeService: IOnyxRuntimeService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IQuickInputService private readonly _quickInputService: IQuickInputService,
		@IDialogService private readonly _dialogService: IDialogService,
		@INotificationService private readonly _notificationService: INotificationService,
		@IStorageService private readonly _storageService: IStorageService,
	) {
		super();
		let persisted: IOnyxSpeculativeMeasurement[] = [];
		try {
			persisted = JSON.parse(this._storageService.get(STORAGE_KEY, StorageScope.APPLICATION, '[]'));
		} catch {
			// corrupt storage: start empty
		}
		this._measurementsObs = observableValue(this, persisted);
		this.measurements = this._measurementsObs;
	}

	async pairAndMeasure(): Promise<void> {
		const models = this._modelService.getKnownModels();
		const capable = models.filter(model => speculativeSupport(model.discovered.runtime) === 'load-time');
		if (capable.length === 0) {
			this._notificationService.notify({
				severity: Severity.Info,
				message: localize('onyx.speculative.unsupported', "No connected runtime supports speculative decoding. LM Studio, llama.cpp and vLLM do; Ollama currently does not."),
			});
			return;
		}

		const target = await this._quickInputService.pick(capable.map(model => ({
			label: model.discovered.id,
			description: model.discovered.baseUrl,
			model,
		})), { placeHolder: localize('onyx.speculative.pickTarget', "Which model should get a draft?") });
		if (!target) {
			return;
		}
		const candidates = candidateDrafts(
			models.filter(model => model.discovered.baseUrl === target.model.discovered.baseUrl).map(model => ({ id: model.discovered.id, family: model.discovered.family, parameterB: model.profile.parameterB })),
			{ id: target.model.discovered.id, family: target.model.discovered.family, parameterB: target.model.profile.parameterB },
		);
		if (candidates.length === 0) {
			this._notificationService.notify({ severity: Severity.Info, message: localize('onyx.speculative.noDrafts', "No smaller model is installed on that runtime to act as a draft.") });
			return;
		}
		const draft = await this._quickInputService.pick(candidates.map(candidate => ({
			label: candidate.modelId,
			description: [candidate.parameterB ? `${candidate.parameterB}B` : undefined, candidate.sameFamily ? localize('onyx.speculative.sameFamily', "same family") : localize('onyx.speculative.otherFamily', "different family — drafts rarely verify")].filter(Boolean).join(' · '),
		})), { placeHolder: localize('onyx.speculative.pickDraft', "Which smaller model drafts for it?") });
		if (!draft) {
			return;
		}

		// Remember the intended pairing so the Compute view can label the
		// measurement, then take the BEFORE number with the model as it is now.
		const pairs = { ...(this._configurationService.getValue<Record<string, string>>(OnyxSettingId.SpeculativePairs) ?? {}) };
		pairs[target.model.key] = draft.label;
		await this._configurationService.updateValue(OnyxSettingId.SpeculativePairs, pairs);

		const baseUrl = target.model.discovered.baseUrl;
		const targetId = target.model.discovered.id;
		// The "before" numbers have to be without a draft: a target that already has one attached is not measured.
		const before = await this._draftOf(baseUrl, targetId);
		if (before.known && before.draft) {
			this._notificationService.notify({ severity: Severity.Warning, message: localize('onyx.speculative.alreadyAttached', "{0} is loaded with {1} attached as a draft, so Onyx cannot measure it without one. Load it without a draft first (for example: lms load {0}), then measure again.", targetId, before.draft) });
			return;
		}

		let baseline: IOnyxSpeculativeSpeeds;
		try {
			this._notificationService.notify({ severity: Severity.Info, message: localize('onyx.speculative.baselining', "Measuring {0} as it is loaded now…", targetId) });
			baseline = await this._measure(baseUrl, targetId);
		} catch (error) {
			this._notificationService.notify({ severity: Severity.Error, message: localize('onyx.speculative.failed', "Speculative measurement failed: {0}", error instanceof Error ? error.message : String(error)) });
			return;
		}

		// Every runtime that supports this configures it when the model loads, so
		// Onyx cannot switch it on itself — it says exactly how, waits for the
		// user to do it, and then measures the same prompts again.
		const proceed = await this._dialogService.confirm({
			message: localize('onyx.speculative.enableNow', "Enable speculative decoding for {0}, then measure again?", targetId),
			detail: [
				localize('onyx.speculative.baselineIsBoth', "Right now {0} generates code at {1} tok/s and prose at {2} tok/s on this machine.", targetId, baseline.code.tokensPerSecond.toFixed(1), baseline.prose.tokensPerSecond.toFixed(1)),
				'',
				speculativeSetupHint(target.model.discovered.runtime, targetId, draft.label),
				'',
				localize('onyx.speculative.thenContinue', "Do that, then continue — Onyx runs the identical prompt again and reports the honest difference."),
			].join('\n'),
			primaryButton: localize('onyx.speculative.measureAgain', "Measure Again"),
		});
		if (!proceed.confirmed) {
			return;
		}

		try {
			// Whether the runtime has the draft attached now: when it says, nothing is put down to a draft it does not have.
			const after = await this._draftOf(baseUrl, targetId);
			const attachment = draftAttachment(draft.label, after);
			const withDraft = attachment === 'not-attached' || attachment === 'other' ? baseline : await this._measure(baseUrl, targetId);
			const measurement: IOnyxSpeculativeMeasurement = {
				targetKey: target.model.key,
				draftModelId: draft.label,
				withDraft: withDraft.code,
				withoutDraft: baseline.code,
				prose: { withDraft: withDraft.prose, withoutDraft: baseline.prose },
				attachment,
				...(after.draft ? { attachedDraft: after.draft } : {}),
				measuredAt: Date.now(),
			};
			const next = [...this._measurementsObs.get().filter(entry => entry.targetKey !== measurement.targetKey), measurement];
			this._measurementsObs.set(next, undefined);
			this._storageService.store(STORAGE_KEY, JSON.stringify(next), StorageScope.APPLICATION, StorageTarget.MACHINE);
			this._notificationService.notify({ severity: attachment === 'not-attached' || attachment === 'other' ? Severity.Warning : Severity.Info, message: formatSpeculativeReadout(measurement) });
		} catch (error) {
			this._notificationService.notify({ severity: Severity.Error, message: localize('onyx.speculative.failed', "Speculative measurement failed: {0}", error instanceof Error ? error.message : String(error)) });
		}
	}

	/** What the runtime says about the draft attached to a loaded model: known only where the runtime says (LM Studio). */
	private async _draftOf(baseUrl: string, model: string): Promise<{ readonly known: boolean; readonly draft: string | undefined }> {
		try {
			const loaded = (await this._runtimeService.listLoadedModels(baseUrl))?.find(entry => entry.id === model);
			return loaded?.speculativeDraft ? { known: loaded.speculativeDraft.known, draft: loaded.speculativeDraft.draft } : { known: false, draft: undefined };
		} catch {
			return { known: false, draft: undefined };
		}
	}

	/** Code and prose, each the median of the rounds after a discarded warm-up. */
	private async _measure(baseUrl: string, model: string): Promise<IOnyxSpeculativeSpeeds> {
		return { code: await this._measureOnce(baseUrl, model, ONYX_SPECULATIVE_PROMPTS.code), prose: await this._measureOnce(baseUrl, model, ONYX_SPECULATIVE_PROMPTS.prose) };
	}

	/** The median of the rounds after a discarded warm-up: what a round usually does, not its best day. */
	private async _measureOnce(baseUrl: string, model: string, prompt: string): Promise<IOnyxSpeculativeSpeed> {
		const samples: IOnyxSpeculativeSpeed[] = [];
		for (let round = 0; round < MEASURE_ROUNDS + 1; round++) {
			const sample = await this._sample(baseUrl, model, prompt);
			if (round > 0) {
				samples.push(sample); // round 0 loads the weights; its numbers are discarded
			}
		}
		return medianSpeed(samples);
	}

	private _sample(baseUrl: string, model: string, prompt: string): Promise<IOnyxSpeculativeSpeed> {
		return new Promise((resolve, reject) => {
			const operationId = `speculative-${generateUuid()}`;
			const startedAt = Date.now();
			let firstTokenAt: number | undefined;
			let completionTokens = 0;
			let streamedChars = 0;
			const listener = this._runtimeService.onDidStream((event: IOnyxStreamEvent) => {
				if (event.operationId !== operationId) {
					return;
				}
				switch (event.kind) {
					case 'delta':
						firstTokenAt ??= Date.now();
						streamedChars += event.text.length;
						break;
					case 'usage':
						completionTokens = event.completionTokens;
						break;
					case 'done': {
						listener.dispose();
						const ttft = (firstTokenAt ?? Date.now()) - startedAt;
						const generationMs = Date.now() - (firstTokenAt ?? startedAt);
						const tokens = completionTokens || Math.ceil(streamedChars / 4);
						resolve({ tokensPerSecond: generationMs > 0 ? tokens / (generationMs / 1000) : 0, timeToFirstTokenMs: ttft });
						break;
					}
					case 'error':
						listener.dispose();
						reject(new Error(event.message));
						break;
				}
			});
			this._runtimeService.startChatCompletion(operationId, {
				baseUrl,
				model,
				messages: [{ role: 'user', content: prompt }],
				maxTokens: MEASURE_MAX_TOKENS,
				temperature: 0,
			}).catch(reject);
		});
	}
}

registerAction2(class MeasureSpeculativeDecodingAction extends Action2 {
	constructor() {
		super({
			id: 'onyx.measureSpeculative',
			title: localize2('onyx.measureSpeculative', "Onyx: Measure Speculative Decoding"),
			f1: true,
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(IOnyxSpeculativeService).pairAndMeasure();
	}
});
