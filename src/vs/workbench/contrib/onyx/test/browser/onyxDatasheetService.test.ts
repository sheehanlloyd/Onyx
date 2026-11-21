/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { CancellationToken, CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { Emitter } from '../../../../../base/common/event.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IOnyxChatParams, IOnyxDiscoveredModel, IOnyxLoadedModel, IOnyxRuntimeService, IOnyxStreamEvent } from '../../../../../platform/onyxRuntime/common/onyxRuntime.js';
import { TestStorageService } from '../../../../test/common/workbenchTestServices.js';
import { OnyxContextAllocationService } from '../../browser/models/onyxContextAllocationService.js';
import { OnyxDatasheetService } from '../../browser/models/onyxDatasheetService.js';
import { buildPicks, measurementLabel } from '../../browser/models/onyxModelLibrary.js';
import { OnyxProfileService } from '../../browser/profiles/onyxProfileService.js';
import { applyDatasheet, IOnyxDatasheet, IOnyxTally } from '../../common/onyxDatasheet.js';
import { OnyxProbesCancelledError } from '../../common/onyxDatasheetProbes.js';

/**
 * R-45, the service half (L5): a datasheet is kept on the machine, changes
 * the model's profile while it describes the model, and stops being used
 * when the weights or the runtime change. Measuring stores what the probe
 * suite found and nothing when it was cancelled.
 */
suite('OnyxDatasheetService', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	const of = (successes: number, trials: number): IOnyxTally => ({ successes, trials });
	const SHEET: IOnyxDatasheet = {
		version: 2, model: 'coder:7b', digest: 'sha256:aaaa', runtime: { name: 'ollama', version: '0.33.0' }, measuredAt: '2026-11-21T00:00:00.000Z',
		nativeToolCalls: of(0, 5), repairableTextCalls: of(5, 5), schemaEnforced: { object: of(3, 3), enum: of(3, 3), nested: of(3, 3) },
		context: { recalledUpToTokens: 3900, failedFromTokens: 4600, serverReportedTokens: 4096, requestedTokens: null, verifiedTokens: null, cutObserved: false, mechanism: null, steps: [] },
		outputCapHonoured: of(3, 3), stopHonoured: of(3, 3), reasoning: { style: 'none', replies: of(0, 3) }, seedRepeatable: of(3, 3), logprobs: of(0, 3),
		speed: { coldFirstTokenMs: 2100, warmFirstTokenMs: 180, tokensPerSecond: 41 }, unmeasured: [],
	};
	const KEY = '127.0.0.1:11434/coder:7b';
	const MODEL: IOnyxDiscoveredModel = { id: 'coder:7b', baseUrl: 'http://127.0.0.1:11434/v1', runtime: 'ollama', parameterB: 7, contextLength: 32_768, supportsTools: true, supportsJsonSchema: true, digest: 'sha256:aaaa', runtimeVersion: '0.33.0' };

	/** A runtime that answers every chat with the same short text, and says the model is not loaded until it has answered once. */
	class ScriptedRuntime extends mock<IOnyxRuntimeService>() {
		private readonly _onDidStream = store.add(new Emitter<IOnyxStreamEvent>());
		override readonly onDidStream = this._onDidStream.event;
		readonly requests: IOnyxChatParams[] = [];
		cancelAfter: { readonly requests: number; readonly source: CancellationTokenSource } | undefined;

		override async startChatCompletion(operationId: string, params: IOnyxChatParams): Promise<void> {
			this.requests.push(params);
			if (this.cancelAfter && this.requests.length >= this.cancelAfter.requests) {
				this.cancelAfter.source.cancel();
			}
			this._onDidStream.fire({ operationId, kind: 'delta', text: 'ok' });
			this._onDidStream.fire({ operationId, kind: 'usage', promptTokens: 20, completionTokens: 1 });
			this._onDidStream.fire({ operationId, kind: 'done', ending: 'complete', finishReason: 'stop' });
		}
		override async cancel(): Promise<void> { }
		override async listLoadedModels(): Promise<readonly IOnyxLoadedModel[] | undefined> {
			return this.requests.length === 0 ? [] : [{ id: 'coder:7b', contextLength: 4096 }];
		}
	}

	function services(storage = store.add(new TestStorageService())) {
		const runtime = new ScriptedRuntime();
		const allocations = store.add(new OnyxContextAllocationService(storage, runtime, new class extends mock<IDialogService>() { }, new TestConfigurationService()));
		const datasheets = store.add(new OnyxDatasheetService(storage, runtime, allocations));
		const profiles = store.add(new OnyxProfileService(storage, datasheets, allocations));
		return { storage, runtime, datasheets, profiles };
	}

	test('R-45: a stored datasheet changes the model\'s profile, on this machine and after a restart, until the weights or the runtime change', () => {
		const first = services();
		const seen = (profiles: OnyxProfileService, model: IOnyxDiscoveredModel) => {
			const profile = profiles.getProfile(KEY, model);
			return { toolCallQuality: profile.toolCallQuality, contextLength: profile.contextLength, runtimeEnforcesSchema: profile.runtimeEnforcesSchema, provenance: profile.provenance };
		};
		const changed: string[] = [];
		store.add(first.datasheets.onDidChange(key => changed.push(key)));
		let profilesChanged = 0;
		store.add(first.profiles.onDidChangeProfiles(() => profilesChanged++));

		const before = seen(first.profiles, MODEL);
		first.datasheets.store(KEY, SHEET);
		const restarted = services(first.storage);
		const DEFAULTS = { toolCallQuality: 0.6, contextLength: 32_768, runtimeEnforcesSchema: undefined, provenance: { toolCallQuality: 'default', contextLength: 'default', schemaEnforcement: 'default' } };
		assert.deepStrictEqual({
			before,
			after: seen(first.profiles, MODEL),
			afterARestart: seen(restarted.profiles, MODEL),
			newWeights: seen(first.profiles, { ...MODEL, digest: 'sha256:bbbb' }),
			runtimeUpdated: seen(first.profiles, { ...MODEL, runtimeVersion: '0.34.0' }),
			whyNot: first.datasheets.stored(KEY, { ...MODEL, runtimeVersion: '0.34.0' })?.stale,
			anotherModel: seen(first.profiles, { ...MODEL, id: 'coder:1.5b' }),
			changed, profilesChanged,
		}, {
			before: DEFAULTS,
			after: { toolCallQuality: 0, contextLength: 3900, runtimeEnforcesSchema: true, provenance: { toolCallQuality: 'measured', contextLength: 'measured', schemaEnforcement: 'measured' } },
			afterARestart: { toolCallQuality: 0, contextLength: 3900, runtimeEnforcesSchema: true, provenance: { toolCallQuality: 'measured', contextLength: 'measured', schemaEnforcement: 'measured' } },
			newWeights: DEFAULTS,
			runtimeUpdated: DEFAULTS,
			whyNot: 'the runtime was 0.33.0 when it was measured and is 0.34.0 now',
			anotherModel: DEFAULTS,
			changed: [KEY], profilesChanged: 1,
		});
	});

	test('R-45: measuring runs the probes against the model\'s runtime, stores the datasheet with the model\'s digest and the runtime\'s version, and stores nothing when it is cancelled', async () => {
		const { runtime, datasheets } = services();
		const progress: string[] = [];
		const measured = await datasheets.measure({ modelKey: KEY, discovered: MODEL }, CancellationToken.None, probe => progress.push(probe));

		const cancelled = services();
		const source = store.add(new CancellationTokenSource());
		cancelled.runtime.cancelAfter = { requests: 3, source };
		let cancelledWith: unknown;
		try {
			await cancelled.datasheets.measure({ modelKey: KEY, discovered: MODEL }, source.token);
		} catch (error) {
			cancelledWith = error;
		}

		assert.deepStrictEqual({
			subject: { model: measured.model, digest: measured.digest, runtime: measured.runtime },
			storedIsWhatWasReturned: datasheets.current(KEY, MODEL) === measured,
			// "ok" is not a tool call, not JSON, not the code and not a count: the datasheet says so in counts.
			nativeToolCalls: measured.nativeToolCalls,
			schemaObject: measured.schemaEnforced.object,
			// The runtime said the model was not loaded before the first request, and what it allocated once it was.
			coldWasMeasured: measured.speed.coldFirstTokenMs !== null,
			serverReportedTokens: measured.context.serverReportedTokens,
			everyRequestWentToTheModelsRuntime: runtime.requests.every(request => request.baseUrl === MODEL.baseUrl && request.model === MODEL.id),
			progress,
			cancelled: { isCancellation: cancelledWith instanceof OnyxProbesCancelledError, stored: cancelled.datasheets.stored(KEY, MODEL), requests: cancelled.runtime.requests.length },
		}, {
			subject: { model: 'coder:7b', digest: 'sha256:aaaa', runtime: { name: 'ollama', version: '0.33.0' } },
			storedIsWhatWasReturned: true,
			nativeToolCalls: { successes: 0, trials: 5 },
			schemaObject: { successes: 0, trials: 3 },
			coldWasMeasured: true,
			serverReportedTokens: 4096,
			everyRequestWentToTheModelsRuntime: true,
			progress: ['tool calls', 'schema enforcement', 'context', 'output cap and stop', 'reasoning', 'seed', 'log-probabilities and speed', 'done'],
			cancelled: { isCancellation: true, stored: undefined, requests: 3 },
		});
	});
	test('R-45: the model library says of each installed model whether its profile was measured here, was measured and is no longer used, or is defaults', () => {
		const { profiles } = services();
		const defaults = profiles.getProfile(KEY, MODEL);
		const inconclusive: IOnyxDatasheet = { ...SHEET, nativeToolCalls: of(1, 1), schemaEnforced: { object: of(0, 0), enum: of(0, 0), nested: of(0, 0) }, context: { recalledUpToTokens: 16_384, failedFromTokens: null, serverReportedTokens: null, requestedTokens: null, verifiedTokens: null, cutObserved: false, mechanism: null, steps: [] } };
		const label = 'Measured 2026-11-21: tool calls 0 of 5, schema enforced, context 3900 tokens; the rest of the profile is defaults';
		assert.deepStrictEqual({
			never: measurementLabel(undefined, defaults),
			current: measurementLabel({ datasheet: SHEET, stale: undefined }, applyDatasheet(defaults, SHEET)),
			stale: measurementLabel({ datasheet: SHEET, stale: 'the model\'s weights have changed since it was measured' }, defaults),
			inconclusive: measurementLabel({ datasheet: inconclusive, stale: undefined }, applyDatasheet(defaults, inconclusive)),
			// In the list, after the model's own description. A model with nothing to say about it is left as it was.
			// The installed models are the ones marked with a check; the rest of the list is the catalog.
			inTheList: buildPicks([MODEL, { ...MODEL, id: 'other:3b' }], 24, [], id => id === 'coder:7b' ? label : undefined).flatMap(pick => pick.type !== 'separator' && pick.label.startsWith('$(check)') ? [pick.detail] : []),
		}, {
			never: 'Not measured: profile uses defaults',
			current: label,
			stale: 'Measured 2026-11-21, not used: the model\'s weights have changed since it was measured. Profile uses defaults',
			inconclusive: 'Measured 2026-11-21: nothing with enough trials to use; profile uses defaults',
			inTheList: [`Installed on http://127.0.0.1:11434/v1 · ${label}`, 'Installed on http://127.0.0.1:11434/v1'],
		});
	});
});
