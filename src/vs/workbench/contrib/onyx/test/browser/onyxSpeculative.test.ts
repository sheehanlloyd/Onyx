/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { runWithFakedTimers } from '../../../../../base/test/common/timeTravelScheduler.js';
import { Emitter } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { INotificationService, Severity } from '../../../../../platform/notification/common/notification.js';
import { IOnyxChatParams, IOnyxDiscoveredModel, IOnyxRuntimeService, IOnyxStreamEvent } from '../../../../../platform/onyxRuntime/common/onyxRuntime.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { TestStorageService } from '../../../../test/common/workbenchTestServices.js';
import { OnyxSpeculativeService } from '../../browser/compute/onyxSpeculativeService.js';
import { IOnyxKnownModel, IOnyxModelService } from '../../browser/model/onyxLanguageModelProvider.js';
import { candidateDrafts, draftAttachment, formatSpeculativeReadout, medianSpeed, speculativeSetupHint, speculativeSupport } from '../../common/onyxSpeculative.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { OnyxSettingId } from '../../common/onyxConfiguration.js';

suite('OnyxSpeculative', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('every supporting runtime configures the draft at load time, never per request', () => {
		// Verified against a real LM Studio 0.4.23: a per-request `draft_model`
		// is rejected with "must be configured at load time, not prediction
		// time" — so Onyx never puts a draft on the wire.
		assert.deepStrictEqual({
			lmstudio: speculativeSupport('lmstudio'),
			llamacpp: speculativeSupport('llamacpp'),
			vllm: speculativeSupport('vllm'),
			ollama: speculativeSupport('ollama'),
			generic: speculativeSupport('generic'),
		}, {
			lmstudio: 'load-time',
			llamacpp: 'load-time',
			vllm: 'load-time',
			ollama: 'unsupported',
			generic: 'unsupported',
		});
	});

	test('the shipped setting describes a pairing recorded at load time, never a per-request draft (A5)', () => {
		const properties = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).getConfigurationProperties();
		const description = properties[OnyxSettingId.SpeculativePairs].markdownDescription ?? '';
		assert.deepStrictEqual({
			saysLoadTime: /load time/.test(description),
			saysRecordedForMeasurement: /recorded/.test(description) && /measure/i.test(description),
			claimsPerRequestDraft: /per-request/.test(description) || /applied only/i.test(description),
		}, {
			saysLoadTime: true,
			saysRecordedForMeasurement: true,
			claimsPerRequestDraft: false,
		});
	});

	test('the setup hint names the runtime\'s own mechanism, with both models filled in', () => {
		const hints = {
			lmstudio: speculativeSetupHint('lmstudio', 'qwen-7b', 'qwen-0.5b'),
			llamacpp: speculativeSetupHint('llamacpp', 'qwen-7b', 'qwen-0.5b'),
			vllm: speculativeSetupHint('vllm', 'qwen-7b', 'qwen-0.5b'),
			ollama: speculativeSetupHint('ollama', 'qwen-7b', 'qwen-0.5b'),
		};
		assert.deepStrictEqual({
			lmstudioMentionsFlag: hints.lmstudio.includes('--speculative-draft-model qwen-0.5b'),
			llamacppMentionsFlag: hints.llamacpp.includes('--model-draft qwen-0.5b'),
			vllmMentionsFlag: hints.vllm.includes('--speculative-model qwen-0.5b'),
			ollamaSaysNo: hints.ollama.includes('no speculative decoding option'),
			allNameTheTarget: Object.values(hints).every(hint => hint.includes('qwen-7b') || hint.includes('no speculative')),
		}, {
			lmstudioMentionsFlag: true,
			llamacppMentionsFlag: true,
			vllmMentionsFlag: true,
			ollamaSaysNo: true,
			allNameTheTarget: true,
		});
	});

	test('candidate drafts: smaller only, same family first, target excluded', () => {
		const models = [
			{ id: 'qwen:32b', family: 'qwen', parameterB: 32 },
			{ id: 'qwen:0.5b', family: 'qwen', parameterB: 0.5 },
			{ id: 'qwen:7b', family: 'qwen', parameterB: 7 },
			{ id: 'llama:1b', family: 'llama', parameterB: 1 },
			{ id: 'mystery', family: undefined, parameterB: undefined },
		];
		const drafts = candidateDrafts(models, { id: 'qwen:32b', family: 'qwen', parameterB: 32 });
		assert.deepStrictEqual(drafts.map(draft => ({ id: draft.modelId, sameFamily: draft.sameFamily })), [
			{ id: 'qwen:0.5b', sameFamily: true },
			{ id: 'qwen:7b', sameFamily: true },
			{ id: 'llama:1b', sameFamily: false },
			{ id: 'mystery', sameFamily: false },
		]);
	});

	test('the readout claims a speedup only when one was measured, says code and prose apart, and puts nothing down to a draft the runtime said was not attached', () => {
		const speed = (tokensPerSecond: number) => ({ tokensPerSecond, timeToFirstTokenMs: 30 });
		const base = { targetKey: 'localhost:1234/qwen2.5-coder-7b-instruct', draftModelId: 'qwen2.5-coder-0.5b-instruct', measuredAt: 0 };
		// As measured on LM Studio 0.4.23 (docs/research/results/2026-11-24-speculative/): code faster, prose not.
		const measured = { ...base, withDraft: speed(66.1), withoutDraft: speed(48.5), prose: { withDraft: speed(44.5), withoutDraft: speed(47.3) } };
		assert.deepStrictEqual({
			attached: formatSpeculativeReadout({ ...measured, attachment: 'attached' }),
			runtimeDoesNotSay: formatSpeculativeReadout({ ...measured, attachment: 'unknown' }),
			proseSlower: formatSpeculativeReadout({ ...measured, prose: { withDraft: speed(36.8), withoutDraft: speed(47.3) }, attachment: 'attached' }),
			notAttached: formatSpeculativeReadout({ ...measured, attachment: 'not-attached' }),
			anotherDraft: formatSpeculativeReadout({ ...measured, attachment: 'other', attachedDraft: 'qwen2.5-coder-1.5b-instruct' }),
			// Kept from before 2026-11-24: one prompt, said as such.
			older: formatSpeculativeReadout({ ...base, withDraft: speed(40), withoutDraft: speed(25) }),
		}, {
			attached: 'speculative decoding (qwen2.5-coder-7b-instruct, draft qwen2.5-coder-0.5b-instruct, attached): code 36% faster (66.1 vs 48.5 tok/s); prose no measured effect (44.5 vs 47.3 tok/s); measured on this machine',
			runtimeDoesNotSay: 'speculative decoding (qwen2.5-coder-7b-instruct, draft qwen2.5-coder-0.5b-instruct): code 36% faster (66.1 vs 48.5 tok/s); prose no measured effect (44.5 vs 47.3 tok/s); measured on this machine',
			proseSlower: 'speculative decoding (qwen2.5-coder-7b-instruct, draft qwen2.5-coder-0.5b-instruct, attached): code 36% faster (66.1 vs 48.5 tok/s); prose 22% slower (36.8 vs 47.3 tok/s); measured on this machine',
			notAttached: 'speculative decoding (qwen2.5-coder-7b-instruct): the runtime said no draft was attached when it was measured again, so nothing was measured with qwen2.5-coder-0.5b-instruct',
			anotherDraft: 'speculative decoding (qwen2.5-coder-7b-instruct): the runtime had qwen2.5-coder-1.5b-instruct attached, not qwen2.5-coder-0.5b-instruct, so the numbers are not about qwen2.5-coder-0.5b-instruct',
			older: 'speculative decoding (qwen2.5-coder-7b-instruct, draft qwen2.5-coder-0.5b-instruct): one prompt: 60% faster (40.0 vs 25.0 tok/s), measured on this machine',
		});
	});

	test('a speed is the median of the rounds, not the best; what the runtime says about the draft decides what the numbers are about', () => {
		const speed = (tokensPerSecond: number, timeToFirstTokenMs = 30) => ({ tokensPerSecond, timeToFirstTokenMs });
		assert.deepStrictEqual({
			median: medianSpeed([speed(60.3), speed(68.2), speed(66.1)]),
			evenCount: medianSpeed([speed(40, 10), speed(50, 20)]),
			attachment: [
				draftAttachment('qwen2.5-coder-0.5b-instruct', { known: true, draft: 'qwen2.5-coder-0.5b-instruct' }),
				draftAttachment('qwen2.5-coder-0.5b-instruct', { known: true, draft: 'qwen2.5-coder-1.5b-instruct' }),
				draftAttachment('qwen2.5-coder-0.5b-instruct', { known: true, draft: undefined }),
				draftAttachment('qwen2.5-coder-0.5b-instruct', { known: false, draft: undefined }),
			],
		}, {
			median: speed(66.1),
			evenCount: speed(40, 10),
			attachment: ['attached', 'other', 'not-attached', 'unknown'],
		});
	});
});

/**
 * The measurement flow of "Onyx: Measure Speculative Decoding", against an LM
 * Studio whose REST list says what draft is attached and whose speed follows
 * it: code twice as fast with the draft, prose a fifth slower. The service,
 * its median and its readout are the real ones; the runtime, the pickers, the
 * dialog and the clock are simulated. The dialog stands for the user, who
 * loads the target (or not) with a draft before saying "Measure Again".
 */
suite('OnyxSpeculativeService', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();
	const TARGET = 'qwen2.5-coder-7b-instruct';
	const DRAFT = 'qwen2.5-coder-0.5b-instruct';

	async function measure(initialDraft: string | undefined, draftAfterEnabling: string | undefined) {
		return runWithFakedTimers({ useFakeTimers: true }, async () => {
			const disposables = store.add(new DisposableStore());
			let attached = initialDraft;
			const streams = disposables.add(new Emitter<IOnyxStreamEvent>());
			const notes: { severity: Severity; message: string }[] = [];
			let dialogs = 0;
			let requests = 0;
			const discovered = (id: string, parameterB: number): IOnyxDiscoveredModel => ({ id, baseUrl: 'http://127.0.0.1:1234/v1', runtime: 'lmstudio', family: 'qwen2', parameterB });
			const known = (id: string, parameterB: number) => ({ key: `127.0.0.1:1234/${id}`, discovered: discovered(id, parameterB), profile: { parameterB } }) as unknown as IOnyxKnownModel;
			const models = [known(TARGET, 7), known(DRAFT, 0.5)];
			const runtime = new class extends mock<IOnyxRuntimeService>() {
				override readonly onDidStream = streams.event;
				override async listLoadedModels() {
					return [{ id: TARGET, contextLength: 8192, speculativeDraft: { known: true, ...(attached ? { draft: attached } : {}) } }];
				}
				override async startChatCompletion(operationId: string, params: IOnyxChatParams) {
					requests++;
					const code = String(params.messages[0].content).startsWith('Write a TypeScript');
					// 100 tokens. Without a draft 2 s; with the draft code takes 1 s and prose 2.5 s.
					const generationMs = attached === DRAFT ? (code ? 1000 : 2500) : 2000;
					setTimeout(() => streams.fire({ operationId, kind: 'delta', text: 'x' }), 20);
					setTimeout(() => {
						streams.fire({ operationId, kind: 'usage', promptTokens: 40, completionTokens: 100 });
						streams.fire({ operationId, kind: 'done', finishReason: 'length', ending: 'complete' });
					}, 20 + generationMs);
				}
			};
			const quickInput = new class extends mock<IQuickInputService>() {
				override async pick(picks: unknown) {
					const items = picks as { label: string }[];
					return (items.find(item => item.label === TARGET) ?? items.find(item => item.label === DRAFT)) as never;
				}
			};
			const dialog = new class extends mock<IDialogService>() {
				override async confirm() {
					dialogs++;
					attached = draftAfterEnabling;
					return { confirmed: true };
				}
			};
			const notification = new class extends mock<INotificationService>() {
				override notify(notice: { severity: Severity; message: string }) {
					notes.push({ severity: notice.severity, message: notice.message });
					return undefined as never;
				}
			};
			const modelService = new class extends mock<IOnyxModelService>() {
				override getKnownModels() { return models; }
			};
			const service = disposables.add(new OnyxSpeculativeService(modelService, runtime, new TestConfigurationService(), quickInput, dialog, notification, disposables.add(new TestStorageService())));
			await service.pairAndMeasure();
			const stored = service.measurements.get()[0];
			disposables.dispose();
			return {
				dialogs, requests,
				attachment: stored?.attachment,
				code: stored ? [stored.withoutDraft.tokensPerSecond, stored.withDraft.tokensPerSecond] : undefined,
				prose: stored?.prose ? [stored.prose.withoutDraft.tokensPerSecond, stored.prose.withDraft.tokensPerSecond] : undefined,
				last: notes.at(-1),
			};
		});
	}

	test('a draft that is attached is measured, code and prose apart, each the median of three rounds after a warm-up', async () => {
		assert.deepStrictEqual(await measure(undefined, DRAFT), {
			dialogs: 1, requests: 16,
			attachment: 'attached', code: [50, 100], prose: [50, 40],
			last: { severity: Severity.Info, message: 'speculative decoding (qwen2.5-coder-7b-instruct, draft qwen2.5-coder-0.5b-instruct, attached): code 100% faster (100.0 vs 50.0 tok/s); prose 20% slower (40.0 vs 50.0 tok/s); measured on this machine' },
		});
	});

	test('a draft the user did not get attached is said to be not attached, and nothing is put down to it', async () => {
		assert.deepStrictEqual(await measure(undefined, undefined), {
			dialogs: 1, requests: 8,
			attachment: 'not-attached', code: [50, 50], prose: [50, 50],
			last: { severity: Severity.Warning, message: 'speculative decoding (qwen2.5-coder-7b-instruct): the runtime said no draft was attached when it was measured again, so nothing was measured with qwen2.5-coder-0.5b-instruct' },
		});
	});

	test('a target already loaded with a draft is not measured as if it had none', async () => {
		const result = await measure(DRAFT, DRAFT);
		assert.deepStrictEqual({ ...result, last: result.last?.severity }, { dialogs: 0, requests: 0, attachment: undefined, code: undefined, prose: undefined, last: Severity.Warning });
	});
});
