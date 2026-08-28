/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Event } from '../../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { InMemoryStorageService } from '../../../../../platform/storage/common/storage.js';
import { IOnyxDiscoveredModel, IOnyxPowerState } from '../../../../../platform/onyxRuntime/common/onyxRuntime.js';
import { ChatMessageRole, IChatMessage } from '../../../chat/common/languageModels.js';
import { evictOldestHistory } from '../../browser/agent/onyxPromptBuilder.js';
import { elideMiddle } from '../../common/onyxContextCompression.js';
import { commonPrefixTokens } from '../../browser/agent/onyxPromptCache.js';
import { IOnyxKnownModel } from '../../browser/model/onyxLanguageModelProvider.js';
import { IOnyxProfileService, OnyxProfileService } from '../../browser/profiles/onyxProfileService.js';
import { OnyxRouterService } from '../../browser/routing/onyxRouterService.js';
import { IObservable, observableValue } from '../../../../../base/common/observable.js';
import { IOnyxEnergyService } from '../../browser/compute/onyxEnergyService.js';
import { capCandidatesByParameter, decideEnergyPolicy, IOnyxEnergyDecision } from '../../common/onyxEnergyPolicy.js';
import { IOnyxProjectConfigService, IOnyxResolvedProjectConfig } from '../../browser/config/onyxProjectConfigService.js';
import { IOnyxProjectConfig, parseProjectConfig, passesSeverityThreshold } from '../../common/onyxProjectConfig.js';
import { IOnyxModelProfile, IOnyxObservedStats } from '../../common/onyxTypes.js';

function discovered(id: string, parameterB: number): IOnyxDiscoveredModel {
	return { id, baseUrl: 'http://localhost:11434/v1', runtime: 'ollama', parameterB, supportsTools: true };
}

function known(key: string, parameterB: number, profile?: Partial<IOnyxModelProfile>): IOnyxKnownModel {
	return {
		key,
		discovered: discovered(key, parameterB),
		profile: { toolCallQuality: 0.85, contextLength: 16384, maxTools: 8, temperature: 0.2, promptStyle: 'full', family: 'test', parameterB, supportsVision: false, ...profile },
	};
}

function user(text: string): IChatMessage {
	return { role: ChatMessageRole.User, content: [{ type: 'text', value: text }] };
}

/** A no-learning profile service: seeds only, stats injected per test. */
class StubProfileService implements IOnyxProfileService {
	declare readonly _serviceBrand: undefined;
	readonly onDidChangeProfiles = Event.None;
	private readonly _stats = new Map<string, IOnyxObservedStats>();
	setStats(modelKey: string, stats: Partial<IOnyxObservedStats>): void {
		this._stats.set(modelKey, { sampleCount: 5, tokensPerSecond: 0, timeToFirstTokenMs: 0, toolCallParseFailureRate: 0, acceptRate: 0.5, acceptSampleCount: 0, fimLatencyMs: 0, fimSampleCount: 0, ttftColdMs: 0, ttftColdSamples: 0, ttftWarmMs: 0, ttftWarmSamples: 0, constrainedTurns: 0, constrainedFailures: 0, ...stats });
	}
	getProfile(): IOnyxModelProfile { throw new Error('not used'); }
	getStats(modelKey: string): IOnyxObservedStats | undefined { return this._stats.get(modelKey); }
	reportMeasurement(): void { }
	reportOutcome(): void { }
	reportFimMeasurement(): void { }
	reportConstrainedOutcome(): void { }
	setOverride(): void { }
	exportAll(): { stats: Record<string, IOnyxObservedStats>; overrides: Record<string, Partial<IOnyxModelProfile>> } { return { stats: {}, overrides: {} }; }
}

/** A project-config service with no config unless a test sets one. */
class StubProjectConfigService implements IOnyxProjectConfigService {
	declare readonly _serviceBrand: undefined;
	private readonly _resolved = observableValue<IOnyxResolvedProjectConfig>(this, { config: {}, sources: [], problems: [] });
	get resolved(): IObservable<IOnyxResolvedProjectConfig> { return this._resolved; }
	setConfig(config: IOnyxProjectConfig): void { this._resolved.set({ config, sources: ['test'], problems: [] }, undefined); }
}

/** An energy service that never downshifts unless a test sets a decision. */
class StubEnergyService implements IOnyxEnergyService {
	declare readonly _serviceBrand: undefined;
	private readonly _decision = observableValue<IOnyxEnergyDecision>(this, { maxParameterB: undefined, autocompleteEnabled: true, autocompleteExtraDebounceMs: 0, downshifted: false, reason: '' });
	readonly state = observableValue<IOnyxPowerState>(this, { onBattery: false, thermal: 'unknown', cpuSpeedLimit: undefined });
	get decision(): IObservable<IOnyxEnergyDecision> { return this._decision; }
	setDecision(decision: IOnyxEnergyDecision): void { this._decision.set(decision, undefined); }
}

suite('OnyxRoutingAndProfiles', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	suite('router classify', () => {

		test('maps message shapes to task kinds', () => {
			const router = store.add(new OnyxRouterService(new StubProfileService(), new StubEnergyService(), new StubProjectConfigService(), new NullLogService()));
			assert.deepStrictEqual(
				[
					router.classify([user('TypeError: cannot read foo at main.ts:10:3, please fix')]),
					router.classify([user('How should we design the plugin architecture?')]),
					router.classify([user('implement a REST endpoint for user sessions with auth')]),
					router.classify([user('add a semicolon here')]),
					router.classify([user('what does this file do?')]),
				],
				['debug', 'plan', 'implement', 'quick-edit', 'chat']);
		});
	});

	suite('router pickModel', () => {

		test('quick edits prefer small models, hard tasks prefer large ones', () => {
			const profiles = new StubProfileService();
			const router = store.add(new OnyxRouterService(profiles, new StubEnergyService(), new StubProjectConfigService(), new NullLogService()));
			const models = [known('small/7b', 7), known('large/32b', 32)];
			assert.strictEqual(router.pickModel([user('add a null check')], models)?.key, 'small/7b');
			assert.strictEqual(router.pickModel([user('plan the migration of the storage architecture')], models)?.key, 'large/32b');
		});

		test('a strong accept rate can outweigh size fit', () => {
			const profiles = new StubProfileService();
			profiles.setStats('small/7b', { acceptRate: 0.95, acceptSampleCount: 10, tokensPerSecond: 80 });
			profiles.setStats('mid/14b', { acceptRate: 0.1, acceptSampleCount: 10, tokensPerSecond: 40 });
			const router = store.add(new OnyxRouterService(profiles, new StubEnergyService(), new StubProjectConfigService(), new NullLogService()));
			const picked = router.pickModel([user('what is a monad?')], [known('small/7b', 7), known('mid/14b', 14)]);
			assert.strictEqual(picked?.key, 'small/7b');
		});

		test('routing decisions carry human-readable reasons', () => {
			const router = store.add(new OnyxRouterService(new StubProfileService(), new StubEnergyService(), new StubProjectConfigService(), new NullLogService()));
			let reasons: readonly string[] = [];
			store.add(router.onDidRoute(decision => { reasons = decision.reasons; }));
			router.pickModel([user('hello')], [known('small/7b', 7)]);
			assert.ok(reasons.length > 0 && reasons[0].includes('7B'));
		});

		test('an energy downshift shrinks the pool and explains itself', () => {
			const energy = new StubEnergyService();
			energy.setDecision({ maxParameterB: 8, autocompleteEnabled: true, autocompleteExtraDebounceMs: 300, downshifted: true, reason: 'On battery.' });
			const router = store.add(new OnyxRouterService(new StubProfileService(), energy, new StubProjectConfigService(), new NullLogService()));
			let reasons: readonly string[] = [];
			store.add(router.onDidRoute(decision => { reasons = decision.reasons; }));
			const picked = router.pickModel([user('plan the migration of the storage architecture')], [known('small/7b', 7), known('large/32b', 32)]);
			assert.deepStrictEqual([picked?.key, reasons[reasons.length - 1]], ['small/7b', 'On battery.']);
		});
	});

	suite('project config', () => {

		test('a pinned model wins routing outright, with the reason', () => {
			const projectConfig = new StubProjectConfigService();
			projectConfig.setConfig({ models: { plan: 'large/32b' } });
			const router = store.add(new OnyxRouterService(new StubProfileService(), new StubEnergyService(), projectConfig, new NullLogService()));
			let reasons: readonly string[] = [];
			store.add(router.onDidRoute(decision => { reasons = decision.reasons; }));
			const picked = router.pickModel([user('plan the migration of the storage architecture')], [known('small/7b', 7), known('large/32b', 32)]);
			assert.deepStrictEqual([picked?.key, reasons], ['large/32b', ['pinned for plan in .onyx/config.json']]);
		});

		test('parsing keeps the valid parts and reports the broken ones', () => {
			const parsed = parseProjectConfig(JSON.stringify({
				models: { implement: 'qwen2.5-coder:14b', nonsense: 'x' },
				verificationTask: 'test',
				contextPins: ['docs/spec.md'],
				reviewSeverityThreshold: 'urgent',
				disabledTools: ['openBrowserPage'],
				surprise: true,
			}));
			assert.deepStrictEqual(parsed, {
				config: {
					models: { implement: 'qwen2.5-coder:14b' },
					verificationTask: 'test',
					contextPins: ['docs/spec.md'],
					disabledTools: ['openBrowserPage'],
				},
				problems: [
					'models: unknown task kind "nonsense" (expected one of quick-edit, implement, debug, plan, chat, review)',
					'reviewSeverityThreshold: expected one of low, medium, high',
					'unknown field "surprise"',
				],
			});
			assert.deepStrictEqual(parseProjectConfig('{oops').problems.length, 1);
		});

		test('the severity threshold gates findings', () => {
			assert.deepStrictEqual([
				passesSeverityThreshold('low', undefined),
				passesSeverityThreshold('low', 'medium'),
				passesSeverityThreshold('medium', 'medium'),
				passesSeverityThreshold('high', 'medium'),
			], [true, false, true, true]);
		});
	});

	suite('energy policy', () => {

		test('the full decision table', () => {
			const state = (onBattery: boolean, thermal: 'nominal' | 'serious' | 'unknown'): IOnyxPowerState => ({ onBattery, thermal, cpuSpeedLimit: undefined });
			const compact = (decision: IOnyxEnergyDecision) => [decision.maxParameterB, decision.autocompleteEnabled, decision.autocompleteExtraDebounceMs, decision.downshifted];
			assert.deepStrictEqual({
				performanceHotBattery: compact(decideEnergyPolicy(state(true, 'serious'), 'performance')),
				balancedAc: compact(decideEnergyPolicy(state(false, 'nominal'), 'balanced')),
				balancedAcUnknownThermal: compact(decideEnergyPolicy(state(false, 'unknown'), 'balanced')),
				balancedBattery: compact(decideEnergyPolicy(state(true, 'nominal'), 'balanced')),
				balancedHot: compact(decideEnergyPolicy(state(false, 'serious'), 'balanced')),
				balancedHotBattery: compact(decideEnergyPolicy(state(true, 'serious'), 'balanced')),
				efficiencyAc: compact(decideEnergyPolicy(state(false, 'nominal'), 'efficiency')),
				efficiencyBattery: compact(decideEnergyPolicy(state(true, 'nominal'), 'efficiency')),
				efficiencyHot: compact(decideEnergyPolicy(state(false, 'serious'), 'efficiency')),
				efficiencyHotBattery: compact(decideEnergyPolicy(state(true, 'serious'), 'efficiency')),
			}, {
				performanceHotBattery: [undefined, true, 0, false],
				balancedAc: [undefined, true, 0, false],
				balancedAcUnknownThermal: [undefined, true, 0, false],
				balancedBattery: [8, true, 300, true],
				balancedHot: [8, true, 500, true],
				balancedHotBattery: [4, true, 700, true],
				efficiencyAc: [8, true, 200, true],
				efficiencyBattery: [4, false, 0, true],
				efficiencyHot: [4, true, 500, true],
				efficiencyHotBattery: [4, false, 0, true],
			});
		});

		test('every downshift carries a sentence, full speed carries none', () => {
			const decisions = (['balanced', 'performance', 'efficiency'] as const).flatMap(setting =>
				[true, false].flatMap(onBattery =>
					(['nominal', 'serious', 'unknown'] as const).map(thermal =>
						decideEnergyPolicy({ onBattery, thermal, cpuSpeedLimit: undefined }, setting))));
			assert.deepStrictEqual(decisions.filter(d => d.downshifted && !d.reason), []);
			assert.deepStrictEqual(decisions.filter(d => !d.downshifted && d.reason !== ''), []);
		});

		test('the cap keeps the smallest model when everything is above it', () => {
			assert.deepStrictEqual(
				capCandidatesByParameter([{ parameterB: 14 }, { parameterB: 32 }], 8),
				[{ parameterB: 14 }]);
			assert.deepStrictEqual(
				capCandidatesByParameter([{ parameterB: 3 }, { parameterB: 32 }], 8),
				[{ parameterB: 3 }]);
			assert.deepStrictEqual(
				capCandidatesByParameter([{ parameterB: 3 }, { parameterB: 32 }], undefined),
				[{ parameterB: 3 }, { parameterB: 32 }]);
		});
	});

	suite('profile service', () => {

		test('measured tool-call failures harden the harness', () => {
			const storage = store.add(new InMemoryStorageService());
			const service = store.add(new OnyxProfileService(storage));
			const model = discovered('m', 32);
			const before = service.getProfile('k', model);
			for (let i = 0; i < 6; i++) {
				service.reportMeasurement({ modelKey: 'k', requestedModelId: 'm', timeToFirstTokenMs: 100, tokensPerSecond: 50, generationMs: 1000, toolCallCount: 0, toolCallParseFailures: 2, promptTokens: 100, completionTokens: 50, finishReason: 'stop', wasCold: false });
			}
			const after = service.getProfile('k', model);
			assert.ok(after.toolCallQuality < before.toolCallQuality);
			assert.strictEqual(after.promptStyle, 'compact');
			assert.strictEqual(after.maxTools, 3);
		});

		test('cold and warm first tokens keep separate EMAs', () => {
			const storage = store.add(new InMemoryStorageService());
			const service = store.add(new OnyxProfileService(storage));
			const measure = (ttft: number, wasCold: boolean) => service.reportMeasurement({ modelKey: 'k', requestedModelId: 'm', timeToFirstTokenMs: ttft, tokensPerSecond: 50, generationMs: 1000, toolCallCount: 0, toolCallParseFailures: 0, promptTokens: 10, completionTokens: 10, finishReason: 'stop', wasCold });
			measure(4000, true);
			measure(150, false);
			measure(200, false);
			const stats = service.getStats('k')!;
			assert.deepStrictEqual(
				{ coldSamples: stats.ttftColdSamples, warmSamples: stats.ttftWarmSamples, coldIsSlower: stats.ttftColdMs > 1000, warmIsFast: stats.ttftWarmMs < 300 },
				{ coldSamples: 1, warmSamples: 2, coldIsSlower: true, warmIsFast: true });
		});

		test('fim latency is an EMA and overrides win over everything', () => {
			const storage = store.add(new InMemoryStorageService());
			const service = store.add(new OnyxProfileService(storage));
			service.reportFimMeasurement('k', 100);
			service.reportFimMeasurement('k', 200);
			const stats = service.getStats('k')!;
			assert.strictEqual(stats.fimSampleCount, 2);
			assert.ok(stats.fimLatencyMs > 100 && stats.fimLatencyMs < 200);

			service.setOverride('k', { temperature: 0.9 });
			assert.strictEqual(service.getProfile('k', discovered('m', 7)).temperature, 0.9);
		});
	});

	suite('prompt cache', () => {

		const message = (role: ChatMessageRole, value: string): IChatMessage => ({ role, content: [{ type: 'text', value }] });

		test('common prefix counts whole messages plus a partial tail', () => {
			const system = message(ChatMessageRole.System, 'S'.repeat(400));
			const previous = [system, message(ChatMessageRole.User, 'first question')];
			assert.deepStrictEqual({
				appendOnly: commonPrefixTokens(previous, [...previous, message(ChatMessageRole.Assistant, 'answer'), message(ChatMessageRole.User, 'second')]) >= 100,
				changedSystem: commonPrefixTokens(previous, [message(ChatMessageRole.System, 'different'), message(ChatMessageRole.User, 'first question')]) < 5,
				identical: commonPrefixTokens(previous, previous.map(m => ({ ...m }))) >= 100,
			}, { appendOnly: true, changedSystem: true, identical: true });
		});

		test('the builder keeps volatile context out of the stable prefix', async () => {
			// The layout contract 2.4 relies on: system first and deterministic,
			// volatile workspace context adjacent to the newest user message.
			// (Verified live via the journal; here we pin the pure prefix math.)
			const stablePrefix = [message(ChatMessageRole.System, 'stable system prompt'), message(ChatMessageRole.User, 'turn one')];
			const nextTurn = [...stablePrefix, message(ChatMessageRole.User, '[Workspace context — background, not a request]\nchanged files'), message(ChatMessageRole.User, 'turn two')];
			const reused = commonPrefixTokens(stablePrefix, nextTurn);
			const total = nextTurn.reduce((sum, m) => sum + Math.ceil(JSON.stringify(m).length / 4), 0);
			assert.ok(reused > 0 && reused < total);
		});
	});

	suite('oversized requests', () => {

		test('one giant message is elided rather than sent past the window', () => {
			// The regression this guards: history eviction cannot help when the
			// newest message alone exceeds the window.
			const huge = 'overflow '.repeat(20000);
			const budgetChars = (Math.floor(16384 * 0.85) - 200 - 512) * 4;
			const elided = elideMiddle(huge, budgetChars);
			assert.deepStrictEqual({
				shrank: elided.length < huge.length,
				withinBudget: elided.length <= budgetChars + 64,
				marked: elided.includes('…'),
				keepsHead: elided.startsWith('overflow'),
			}, { shrank: true, withinBudget: true, marked: true, keepsHead: true });
		});
	});

	suite('prompt history eviction', () => {

		test('keeps the newest messages that fit and drops oldest-first', () => {
			const messages = [user('a'.repeat(400)), user('b'.repeat(400)), user('c'.repeat(400))];
			const { kept, historyTokens } = evictOldestHistory(messages, 250);
			assert.deepStrictEqual(kept.map(m => (m.content[0] as { value: string }).value[0]), ['b', 'c']);
			assert.ok(historyTokens > 0 && historyTokens <= 250);
		});

		test('zero budget keeps nothing, ample budget keeps everything', () => {
			const messages = [user('one'), user('two')];
			assert.strictEqual(evictOldestHistory(messages, 0).kept.length, 0);
			assert.strictEqual(evictOldestHistory(messages, 10_000).kept.length, 2);
		});
	});
});
