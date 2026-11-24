/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Emitter } from '../../../../../base/common/event.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { runWithFakedTimers } from '../../../../../base/test/common/timeTravelScheduler.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { IConfirmation, IConfirmationResult, IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { contextAliasName, parseContextAlias } from '../../../../../platform/onyxRuntime/common/onyxContextAlias.js';
import { IOnyxChatParams, IOnyxDiscoveredModel, IOnyxLoadedModel, IOnyxMachineProfile, IOnyxRuntimeService, IOnyxStreamEvent, OnyxContextAliasResult } from '../../../../../platform/onyxRuntime/common/onyxRuntime.js';
import { TestStorageService } from '../../../../test/common/workbenchTestServices.js';
import { OnyxContextAllocationService } from '../../browser/models/onyxContextAllocationService.js';
import { OnyxDatasheetService } from '../../browser/models/onyxDatasheetService.js';
import { OnyxProfileService } from '../../browser/profiles/onyxProfileService.js';
import { OnyxSettingId } from '../../common/onyxConfiguration.js';
import { IOnyxBudgetedMessage, planTurn } from '../../common/onyxContextBudget.js';
import { ChatMessageRole, IChatMessage } from '../../../chat/common/languageModels.js';
import { canaryPlan, contextTarget, describeAllocation, IOnyxCanaryStep, judgeAllocation, memoryCeilingTokens } from '../../common/onyxContextAllocation.js';
import { parseTrace, validateTrace } from '../../common/onyxTrace.js';
import { OnyxSimEpisode, SIM_FILES, SIM_TARGET_FILE } from './sim/onyxSimEpisode.js';
import { OnyxSimRig } from './sim/onyxSimRig.js';

/**
 * R-61 (B15, I-04): a context is asked for with the user's consent, read
 * back, and believed only when a probe saw it work. Three runtimes are
 * simulated at the service boundary: one that honours the request, one that
 * ignores it, and one that reports a larger context than it serves.
 */
suite('OnyxContextAllocation', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	const GIB = 1024 ** 3;
	const KEY = '127.0.0.1:11434/coder:7b';
	const MODEL: IOnyxDiscoveredModel = { id: 'coder:7b', baseUrl: 'http://127.0.0.1:11434/v1', runtime: 'ollama', parameterB: 7, contextLength: 32_768, serverContextLength: 4096, supportsTools: true, supportsJsonSchema: true, digest: 'sha256:aaaa', runtimeVersion: '0.33.0', sizeBytes: 4.4 * GIB };
	const ALIAS = 'coder:7b-onyx-ctx16384';

	type Behaviour = 'honours' | 'ignores' | 'over-reports' | 'refuses-to-create';

	/**
	 * An Ollama-like runtime at the service boundary. A model name is served
	 * with some context; a prompt longer than that loses its start, as the
	 * live server was measured to do, and the runtime then counts half of
	 * what it kept.
	 */
	class FakeOllama extends mock<IOnyxRuntimeService>() {
		private readonly _onDidStream = store.add(new Emitter<IOnyxStreamEvent>());
		override readonly onDidStream = this._onDidStream.event;
		readonly created: string[] = [];
		readonly removed: string[] = [];
		readonly requests: { readonly model: string; readonly chars: number }[] = [];
		private readonly _loaded = new Set<string>();

		constructor(private readonly _behaviour: Behaviour) {
			super();
		}

		private _served(model: string): number {
			const alias = parseContextAlias(model);
			return alias && this._behaviour === 'honours' ? alias.tokens : 4096;
		}

		private _reported(model: string): number {
			const alias = parseContextAlias(model);
			return alias && this._behaviour !== 'ignores' ? alias.tokens : 4096;
		}

		override async startChatCompletion(operationId: string, params: IOnyxChatParams): Promise<void> {
			const prompt = params.messages.map(message => message.content ?? '').join('\n');
			this.requests.push({ model: params.model, chars: prompt.length });
			this._loaded.add(params.model);
			// The live tokenizer counted about 4.6 characters a token for the probe's filler.
			const tokens = Math.round(prompt.length / 4.6);
			const served = this._served(params.model);
			const kept = tokens <= served;
			this._onDidStream.fire({ operationId, kind: 'delta', text: kept ? 'ZEBRA-7421' : 'I do not know.' });
			this._onDidStream.fire({ operationId, kind: 'usage', promptTokens: kept ? tokens : Math.round(served / 2), completionTokens: 4 });
			this._onDidStream.fire({ operationId, kind: 'done', ending: 'complete', finishReason: 'stop' });
		}
		override async cancel(): Promise<void> { }
		override async listLoadedModels(): Promise<readonly IOnyxLoadedModel[] | undefined> {
			return [...this._loaded].map(id => ({ id, contextLength: this._reported(id) }));
		}
		override async getMachineProfile(): Promise<IOnyxMachineProfile> {
			return { totalMemoryBytes: 24 * GIB, freeMemoryBytes: 8 * GIB, cpuModel: 'test', cpuCount: 12, arch: 'arm64', platform: 'darwin' };
		}
		override async createContextAlias(_baseUrl: string, model: string, tokens: number): Promise<OnyxContextAliasResult> {
			if (this._behaviour === 'refuses-to-create') {
				return { ok: false, error: '400 Bad Request' };
			}
			const alias = contextAliasName(model, tokens);
			this.created.push(alias);
			return { ok: true, alias };
		}
		override async removeContextAlias(_baseUrl: string, alias: string): Promise<OnyxContextAliasResult> {
			this.removed.push(alias);
			this._loaded.delete(alias);
			return { ok: true, alias };
		}
	}

	class ScriptedDialogs extends mock<IDialogService>() {
		readonly asked: IConfirmation[] = [];
		constructor(private readonly _answer: boolean) {
			super();
		}
		override async confirm(confirmation: IConfirmation): Promise<IConfirmationResult> {
			this.asked.push(confirmation);
			return { confirmed: this._answer };
		}
	}

	function services(behaviour: Behaviour, consent: boolean, storage = store.add(new TestStorageService()), setting?: number) {
		const runtime = new FakeOllama(behaviour);
		const dialogs = new ScriptedDialogs(consent);
		const configuration = new TestConfigurationService(setting === undefined ? {} : { [OnyxSettingId.ContextRequestTokens]: setting });
		const allocations = store.add(new OnyxContextAllocationService(storage, runtime, dialogs, configuration));
		const datasheets = store.add(new OnyxDatasheetService(storage, runtime, allocations));
		const profiles = store.add(new OnyxProfileService(storage, datasheets, allocations));
		return { storage, runtime, dialogs, allocations, datasheets, profiles };
	}

	/** One scenario from asking to budgeting, as one value. */
	async function scenario(behaviour: Behaviour, consent: boolean) {
		const { runtime, dialogs, allocations, profiles } = services(behaviour, consent);
		const outcome = await allocations.request({ modelKey: KEY, discovered: MODEL }, CancellationToken.None);
		const record = outcome.kind === 'recorded' ? outcome.record : undefined;
		const profile = profiles.getProfile(KEY, MODEL);
		return {
			asked: dialogs.asked.length,
			// The dialog names what would be created and how to undo it.
			dialogNamesTheAliasAndItsRemoval: dialogs.asked.every(dialog => String(dialog.detail).includes(ALIAS) && String(dialog.detail).includes(`ollama rm ${ALIAS}`)),
			status: record?.status,
			requested: record?.requestedTokens, reported: record?.reportedTokens, verified: record?.verifiedTokens, cutObserved: record?.cutObserved,
			created: runtime.created, removed: runtime.removed,
			budget: { tokens: profile.contextLength, source: profile.context?.source },
			wireModel: allocations.wireModel(KEY, MODEL),
			trace: allocations.numbers(KEY, MODEL),
			promptsSentTo: [...new Set(runtime.requests.map(request => request.model))],
		};
	}

	test('R-61: a runtime that honours the request: the budget is the verified context, requests go to the alias, and the cut past the new allocation was seen', async () => {
		assert.deepStrictEqual(await scenario('honours', true), {
			asked: 1, dialogNamesTheAliasAndItsRemoval: true,
			status: 'verified', requested: 16_384, reported: 16_384, verified: 16_384, cutObserved: true,
			created: [ALIAS], removed: [],
			budget: { tokens: 16_384, source: 'verified' },
			wireModel: ALIAS,
			trace: { requestedTokens: 16_384, reportedTokens: 16_384, verifiedTokens: 16_384, mechanism: 'derived-model' },
			promptsSentTo: [ALIAS],
		});
	});

	test('R-61: a runtime that ignores the request: the server\'s allocation stays in force, the alias is removed again, and the record says the request was not honoured', async () => {
		assert.deepStrictEqual(await scenario('ignores', true), {
			asked: 1, dialogNamesTheAliasAndItsRemoval: true,
			status: 'ignored', requested: 16_384, reported: 4096, verified: null, cutObserved: false,
			created: [ALIAS], removed: [ALIAS],
			budget: { tokens: 4096, source: 'server' },
			wireModel: 'coder:7b',
			trace: { requestedTokens: null, reportedTokens: 4096, verifiedTokens: null, mechanism: null },
			promptsSentTo: [ALIAS],
		});
	});

	test('R-61: a runtime that reports a larger context than it serves: the report is not believed, the budget stays at the server\'s allocation', async () => {
		assert.deepStrictEqual(await scenario('over-reports', true), {
			asked: 1, dialogNamesTheAliasAndItsRemoval: true,
			status: 'over-reported', requested: 16_384, reported: 16_384, verified: null, cutObserved: false,
			created: [ALIAS], removed: [ALIAS],
			budget: { tokens: 4096, source: 'server' },
			wireModel: 'coder:7b',
			trace: { requestedTokens: null, reportedTokens: 4096, verifiedTokens: null, mechanism: null },
			promptsSentTo: [ALIAS],
		});
	});

	test('R-61: consent refused: nothing is created, changed or sent, and the server\'s allocation stays', async () => {
		assert.deepStrictEqual(await scenario('honours', false), {
			asked: 1, dialogNamesTheAliasAndItsRemoval: true,
			status: 'declined', requested: 16_384, reported: null, verified: null, cutObserved: false,
			created: [], removed: [],
			budget: { tokens: 4096, source: 'server' },
			wireModel: 'coder:7b',
			trace: { requestedTokens: null, reportedTokens: 4096, verifiedTokens: null, mechanism: null },
			promptsSentTo: [],
		});
	});

	test('R-61: a verified allocation survives a restart, stops applying when the weights, the runtime or the alias change, and is undone by removing the alias', async () => {
		const first = services('honours', true);
		await first.allocations.request({ modelKey: KEY, discovered: MODEL }, CancellationToken.None);
		const restarted = services('honours', true, first.storage);
		const budget = (from: ReturnType<typeof services>, model: IOnyxDiscoveredModel) => from.profiles.getProfile(KEY, model).contextLength;
		// A discovery that lists the alias, as the runtime would after it was created; then one where it has gone.
		restarted.allocations.noteListed([MODEL, { ...MODEL, id: ALIAS, contextAlias: { base: 'coder:7b', tokens: 16_384 } }]);
		const afterRestart = budget(restarted, MODEL);
		const newWeights = budget(restarted, { ...MODEL, digest: 'sha256:bbbb' });
		const runtimeUpdated = budget(restarted, { ...MODEL, runtimeVersion: '0.34.0' });
		restarted.allocations.noteListed([MODEL]);
		const aliasGone = { budget: budget(restarted, MODEL), wire: restarted.allocations.wireModel(KEY, MODEL) };

		const undone = await first.allocations.undo(KEY, MODEL);
		assert.deepStrictEqual({
			afterRestart, newWeights, runtimeUpdated, aliasGone,
			undo: { error: undone, removed: first.runtime.removed, record: first.allocations.record(KEY), budget: budget(first, MODEL), wire: first.allocations.wireModel(KEY, MODEL) },
		}, {
			afterRestart: 16_384, newWeights: 4096, runtimeUpdated: 4096, aliasGone: { budget: 4096, wire: 'coder:7b' },
			undo: { error: undefined, removed: [ALIAS], record: undefined, budget: 4096, wire: 'coder:7b' },
		});
	});

	test('R-61: nothing is asked of the user or the runtime when there is nothing to ask for: another runtime, a setting of zero, a refusal by the runtime', async () => {
		const lmStudio = services('honours', true);
		const other = await lmStudio.allocations.request({ modelKey: KEY, discovered: { ...MODEL, runtime: 'lmstudio' } }, CancellationToken.None);
		const kept = services('honours', true, undefined, 0);
		const zero = await kept.allocations.request({ modelKey: KEY, discovered: MODEL }, CancellationToken.None);
		const refusing = services('refuses-to-create', true);
		const refused = await refusing.allocations.request({ modelKey: KEY, discovered: MODEL }, CancellationToken.None);
		assert.deepStrictEqual({
			other: { kind: other.kind, asked: lmStudio.dialogs.asked.length, created: lmStudio.runtime.created },
			zero: { kind: zero.kind, asked: kept.dialogs.asked.length, created: kept.runtime.created },
			refused: { status: refused.kind === 'recorded' ? refused.record.status : refused.kind, budget: refusing.profiles.getProfile(KEY, MODEL).contextLength, wire: refusing.allocations.wireModel(KEY, MODEL) },
		}, {
			other: { kind: 'nothing-to-request', asked: 0, created: [] },
			zero: { kind: 'nothing-to-request', asked: 0, created: [] },
			refused: { status: 'ignored', budget: 4096, wire: 'coder:7b' },
		});
	});

	test('the target is the smallest of the trained context, the memory ceiling and the setting, and never more than the trained context', () => {
		const of = (input: Parameters<typeof contextTarget>[0]) => { const target = contextTarget(input); return [target.tokens, target.limitedBy, target.reason]; };
		assert.deepStrictEqual({
			ceiling24: memoryCeilingTokens(24 * GIB, 4.4 * GIB),
			ceiling8: memoryCeilingTokens(8 * GIB, 4.4 * GIB),
			default24: of({ trainedTokens: 32_768, machineMemoryBytes: 24 * GIB, modelBytes: 4.4 * GIB }),
			settingAboveTrained: of({ trainedTokens: 32_768, machineMemoryBytes: 24 * GIB, modelBytes: 4.4 * GIB, settingTokens: 131_072 }),
			smallTrained: of({ trainedTokens: 8192, machineMemoryBytes: 24 * GIB, modelBytes: 1 * GIB }),
			memoryBound: of({ trainedTokens: 131_072, machineMemoryBytes: 16 * GIB, modelBytes: 7.5 * GIB, settingTokens: 65_536 }),
			noRoom: of({ trainedTokens: 32_768, machineMemoryBytes: 8 * GIB, modelBytes: 4.4 * GIB }),
			trainedUnknown: of({ machineMemoryBytes: 24 * GIB }),
			keptBySetting: of({ trainedTokens: 32_768, settingTokens: 0 }),
			alreadyThere: of({ trainedTokens: 32_768, settingTokens: 8192, currentTokens: 8192 }),
		}, {
			ceiling24: 83_012, ceiling8: 0,
			default24: [16_384, 'setting', undefined],
			settingAboveTrained: [32_768, 'trained', undefined],
			smallTrained: [8192, 'trained', undefined],
			memoryBound: [5120, 'memory', undefined],
			noRoom: [undefined, 'memory', 'no-room'],
			trainedUnknown: [undefined, undefined, 'trained-unknown'],
			keptBySetting: [undefined, undefined, 'kept-by-setting'],
			alreadyThere: [undefined, 'setting', 'nothing-to-gain'],
		});
	});

	test('the verdict: verified only when a prompt the runtime counted as longer than the old allocation kept its start; never more than was reported or requested', () => {
		const step = (role: IOnyxCanaryStep['role'], sentTokens: number, promptTokens: number | null, recalled: boolean): IOnyxCanaryStep => ({ role, sentTokens, promptTokens, recalled });
		const good = [step('control', 2048, 1776, true), step('inside', 12_288, 10_650, true), step('past', 24_576, 8192, false)];
		const judge = (reportedTokens: number | undefined, steps: readonly IOnyxCanaryStep[], requestedTokens = 16_384) => { const verdict = judgeAllocation({ requestedTokens, reportedTokens, previousTokens: 4096, steps }); return [verdict.status, verdict.verifiedTokens, verdict.cutObserved]; };
		assert.deepStrictEqual({
			plan: canaryPlan(16_384, 4096),
			planInTheRuntimesTokens: canaryPlan(16_384, 4096, 1776 / 2048).map(step => step.sentTokens),
			verified: judge(16_384, good),
			reportedMoreThanRequested: judge(32_768, good),
			noCutSeen: judge(16_384, [good[0], good[1], step('past', 24_576, 21_300, true)]),
			ignored: judge(4096, [good[0]]),
			overReported: judge(16_384, [good[0], step('inside', 12_288, 2048, false)]),
			modelCannotRecall: judge(16_384, [step('control', 2048, 1776, false)]),
			insideNotPastTheOld: judge(16_384, [good[0], step('inside', 12_288, 4000, true)]),
			nothingReported: judge(undefined, good),
		}, {
			plan: [{ role: 'control', sentTokens: 2048 }, { role: 'inside', sentTokens: 14_746 }, { role: 'past', sentTokens: 20_480 }],
			// The runtime counted 1,776 tokens for 2,048 estimated: the longer prompts grow to land at 14,746 and 20,480 of its tokens.
			planInTheRuntimesTokens: [2048, 17_004, 23_617],
			verified: ['verified', 16_384, true],
			reportedMoreThanRequested: ['verified', 16_384, true],
			noCutSeen: ['verified', 16_384, false],
			ignored: ['ignored', null, false],
			overReported: ['over-reported', null, false],
			modelCannotRecall: ['unverified', null, false],
			insideNotPastTheOld: ['unverified', null, false],
			nothingReported: ['unverified', null, true],
		});
	});

	test('metric: whole tool results that fit in one turn of the eight-tool agent, at the server\'s allocation and at the requested context', () => {
		// The eight-tool set's schemas come to about 1,100 estimated tokens and the instructions to about 300 (B13);
		// a tool result goes back at up to 4,000 characters on the compact profile (L4). Twenty calls are offered.
		const estimate = (message: IChatMessage) => Math.ceil(JSON.stringify(message.content).length / 4);
		const messages: IOnyxBudgetedMessage[] = [
			{ kind: 'system', message: { role: ChatMessageRole.System, content: [{ type: 'text', value: 's'.repeat(1200) }] } },
			{ kind: 'request', message: { role: ChatMessageRole.User, content: [{ type: 'text', value: 'do the thing' }] } },
		];
		for (let index = 0; index < 20; index++) {
			messages.push({ kind: 'turn', message: { role: ChatMessageRole.Assistant, content: [{ type: 'tool_use', name: 'readFile', toolCallId: `c${index}`, parameters: { path: `src/file${index}.ts` } }] } });
			messages.push({ kind: 'turn', message: { role: ChatMessageRole.User, content: [{ type: 'tool_result', toolCallId: `c${index}`, value: [{ type: 'text', value: 'r'.repeat(4000) }] }] } });
		}
		const wholeResults = (contextTokens: number) => {
			const plan = planTurn({ messages, contextTokens, schemaTokens: 1100, estimate });
			return plan.fits && !plan.shrankNewestResults ? 20 - plan.evictedResults : 0;
		};
		assert.deepStrictEqual({ at4096: wholeResults(4096), at16384: wholeResults(16_384), at32768: wholeResults(32_768) }, { at4096: 1, at16384: 9, at32768: 20 });
	});

	test('R-61: a trace header carries requested, reported and verified context, and a header without them fails validation', () => {
		const header = (context: object | undefined) => JSON.stringify({
			kind: 'trace', v: 2, runId: 'r', startedAt: 1, harness: { configurationHash: 'abc', configuration: {} }, model: { identifier: 'ollama:coder:7b', digest: null },
			runtime: { name: 'ollama', version: null, baseUrl: '' }, sampling: { temperature: null, seed: null, maxTokens: null, responseFormat: false }, tools: [],
			...(context ? { context } : {}),
		});
		const errors = (context: object | undefined) => validateTrace(parseTrace(header(context))).errors;
		assert.deepStrictEqual({
			complete: errors({ budgetedTokens: 16_384, source: 'verified', requestedTokens: 16_384, reportedTokens: 16_384, verifiedTokens: 16_384, mechanism: 'derived-model' }),
			unknownsAreNull: errors({ budgetedTokens: 4096, source: 'server', requestedTokens: null, reportedTokens: 4096, verifiedTokens: null, mechanism: null }),
			absent: errors(undefined),
			missingVerified: errors({ budgetedTokens: 4096, source: 'server', requestedTokens: null, reportedTokens: 4096, mechanism: null }),
		}, {
			complete: [], unknownsAreNull: [],
			absent: ['header lacks context'],
			missingVerified: ['header.context lacks verifiedTokens'],
		});
	});

	test('what the configuration view says about a model\'s context never calls an unverified number verified', () => {
		const record = { version: 1 as const, model: 'coder:7b', digest: null, runtime: { name: 'ollama', version: null }, mechanism: 'derived-model' as const, alias: ALIAS, requestedTokens: 16_384, reportedTokens: 16_384, previousTokens: 4096, cutObserved: true, steps: [], decidedAt: '2026-11-21T00:00:00.000Z' };
		const lines = {
			none: describeAllocation(undefined, false, 4096),
			verified: describeAllocation({ ...record, status: 'verified', verifiedTokens: 16_384 }, true, 4096),
			ignored: describeAllocation({ ...record, status: 'ignored', reportedTokens: 4096, verifiedTokens: null, alias: null }, false, 4096),
			overReported: describeAllocation({ ...record, status: 'over-reported', verifiedTokens: null, alias: null }, false, 4096),
			declined: describeAllocation({ ...record, status: 'declined', verifiedTokens: null, alias: null }, false, undefined),
		};
		assert.deepStrictEqual({
			onlyTheVerifiedOneSaysVerified: Object.entries(lines).filter(([, line]) => /\bverified\b/.test(line) && !/could not verify/.test(line)).map(([name]) => name),
			verifiedNamesTheUndo: lines.verified.includes(`ollama rm ${ALIAS}`),
			ignoredSaysNotHonoured: lines.ignored.includes('did not honour'),
			othersNameTheServersAllocation: [lines.none, lines.ignored, lines.overReported].every(line => line.includes('server\'s own allocation of 4096 tokens is in force')),
		}, { onlyTheVerifiedOneSaysVerified: ['verified'], verifiedNamesTheUndo: true, ignoredSaysNotHonoured: true, othersNameTheServersAllocation: true });
	});
});

/**
 * R-61 on LM Studio (B15, probed 2026-11-22): LM Studio reports the context
 * of a model only once it is loaded, loads it on the first request at its own
 * setting, and cuts a longer prompt without an error. The real agent loop,
 * model service and seed profile run in the simulation rig against an LM
 * Studio that loads the model at 8,192 tokens; the model was trained for
 * 32,768.
 */
suite('OnyxContextAllocation, LM Studio', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	function episode(loadsAt: number | undefined): OnyxSimEpisode {
		return {
			name: 'lmstudio-context', seed: 0, persona: 'well-behaved', prompt: 'Run the checks until they pass.', files: SIM_FILES, target: SIM_TARGET_FILE,
			// Five commands, each printing 20,000 bytes: about 25,000 tokens of results, three times what LM Studio loads.
			turns: [...Array.from({ length: 5 }, (): OnyxSimEpisode['turns'][number] => ({ kind: 'toolCall', tool: 'terminal', arguments: { command: 'npm test' } })), { kind: 'text', text: 'Done.' }],
			dialogDefault: 'allow-once', userSteps: [],
			faults: Array.from({ length: 5 }, (_, index) => ({ at: 'afterToolDispatch' as const, occurrence: index + 1, step: { kind: 'outputFlood' as const, bytes: 20_000 } })),
			// A full prompt keeps up to 16,000 characters of each result, so what was run would not fit 8,192 tokens.
			profile: { promptStyle: 'full', maxTools: 8 },
			...(loadsAt !== undefined ? { lmStudioLoadsAt: loadsAt } : {}),
		};
	}

	async function run(script: OnyxSimEpisode) {
		return runWithFakedTimers({ useFakeTimers: true, maxTaskCount: 400_000 }, async () => {
			const rig = new OnyxSimRig(script);
			try {
				return await rig.run();
			} finally {
				await rig.dispose();
			}
		});
	}

	test('R-61, LM Studio: a run on a model that is not loaded yet is budgeted at the context LM Studio loads it at, not at the trained context; nothing is cut without an error, and the trace says what was reported', async () => {
		const result = await run(episode(8192));
		const header = parseTrace(result.journal).header;
		assert.deepStrictEqual({
			status: result.status,
			largestPrompt: Math.max(...result.requests.map(request => request.promptTokens)) <= 8192,
			silentlyCut: result.silentlyCut,
			budgeted: header?.context.budgetedTokens,
			reported: header?.context.reportedTokens,
			source: header?.context.source,
			violations: result.violations,
		}, {
			status: 'completed', largestPrompt: true, silentlyCut: [],
			budgeted: 8192, reported: 8192, source: 'server',
			violations: [],
		});
	});
});
