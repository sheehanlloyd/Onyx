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
import { createDecorator, ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { INotificationService, Severity } from '../../../../../platform/notification/common/notification.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { IOnyxRuntimeService, IOnyxStreamEvent } from '../../../../../platform/onyxRuntime/common/onyxRuntime.js';
import { OnyxSettingId } from '../../common/onyxConfiguration.js';
import { candidateDrafts, formatSpeculativeReadout, IOnyxSpeculativeMeasurement, speculativeSupport } from '../../common/onyxSpeculative.js';
import { IOnyxModelService } from '../model/onyxLanguageModelProvider.js';

export const IOnyxSpeculativeService = createDecorator<IOnyxSpeculativeService>('onyxSpeculativeService');

const STORAGE_KEY = 'onyx.speculative.measurements';
/** Enough tokens that tok/s means generation, not TTFT noise. */
const MEASURE_MAX_TOKENS = 160;
const MEASURE_ROUNDS = 2;
const MEASURE_PROMPT = 'Write a paragraph explaining what a binary search tree is, then list three balanced variants with one sentence each.';

/**
 * Speculative-decoding pairing and its honest measurement. A pairing is only
 * a configuration entry until this service has raced the same prompt with and
 * without the draft on this machine; the Compute view then shows exactly what
 * was measured, including "no effect" when the runtime ignored the draft.
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
		const capable = models.filter(model => speculativeSupport(model.discovered.runtime) === 'per-request');
		if (capable.length === 0) {
			const kinds = [...new Set(models.map(model => model.discovered.runtime))];
			this._notificationService.notify({
				severity: Severity.Info,
				message: kinds.includes('llamacpp') || kinds.includes('vllm')
					? localize('onyx.speculative.serverSide', "Your runtime configures speculative decoding at server launch, not per request — start it with a draft model (e.g. llama.cpp --model-draft) and Onyx benefits automatically.")
					: localize('onyx.speculative.unsupported', "No connected runtime accepts a per-request draft model. LM Studio does; Ollama currently does not."),
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

		// Persist the pairing, then measure it.
		const pairs = { ...(this._configurationService.getValue<Record<string, string>>(OnyxSettingId.SpeculativePairs) ?? {}) };
		pairs[target.model.key] = draft.label;
		await this._configurationService.updateValue(OnyxSettingId.SpeculativePairs, pairs);

		this._notificationService.notify({ severity: Severity.Info, message: localize('onyx.speculative.measuring', "Measuring {0} with and without draft {1}…", target.model.discovered.id, draft.label) });
		try {
			const withDraft = await this._measureOnce(target.model.discovered.baseUrl, target.model.discovered.id, draft.label);
			const withoutDraft = await this._measureOnce(target.model.discovered.baseUrl, target.model.discovered.id, undefined);
			const measurement: IOnyxSpeculativeMeasurement = {
				targetKey: target.model.key,
				draftModelId: draft.label,
				withDraft,
				withoutDraft,
				measuredAt: Date.now(),
			};
			const next = [...this._measurementsObs.get().filter(entry => entry.targetKey !== measurement.targetKey), measurement];
			this._measurementsObs.set(next, undefined);
			this._storageService.store(STORAGE_KEY, JSON.stringify(next), StorageScope.APPLICATION, StorageTarget.MACHINE);
			this._notificationService.notify({ severity: Severity.Info, message: formatSpeculativeReadout(measurement) });
		} catch (error) {
			this._notificationService.notify({ severity: Severity.Error, message: localize('onyx.speculative.failed', "Speculative measurement failed: {0}", error instanceof Error ? error.message : String(error)) });
		}
	}

	/** Best-of-N: the fastest round, so a cold start does not poison the comparison. */
	private async _measureOnce(baseUrl: string, model: string, draftModel: string | undefined): Promise<{ tokensPerSecond: number; timeToFirstTokenMs: number }> {
		let best: { tokensPerSecond: number; timeToFirstTokenMs: number } | undefined;
		for (let round = 0; round < MEASURE_ROUNDS + 1; round++) {
			const sample = await this._sample(baseUrl, model, draftModel);
			if (round === 0) {
				continue; // warm-up round: load the weights, discard the numbers
			}
			if (!best || sample.tokensPerSecond > best.tokensPerSecond) {
				best = sample;
			}
		}
		return best!;
	}

	private _sample(baseUrl: string, model: string, draftModel: string | undefined): Promise<{ tokensPerSecond: number; timeToFirstTokenMs: number }> {
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
				messages: [{ role: 'user', content: MEASURE_PROMPT }],
				maxTokens: MEASURE_MAX_TOKENS,
				temperature: 0,
				draftModel,
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
