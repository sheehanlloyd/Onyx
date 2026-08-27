/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Event } from '../../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { InMemoryStorageService } from '../../../../../platform/storage/common/storage.js';
import { IOnyxDiscoveredModel } from '../../../../../platform/onyxRuntime/common/onyxRuntime.js';
import { ChatMessageRole, IChatMessage } from '../../../chat/common/languageModels.js';
import { evictOldestHistory } from '../../browser/agent/onyxPromptBuilder.js';
import { IOnyxKnownModel } from '../../browser/model/onyxLanguageModelProvider.js';
import { IOnyxProfileService, OnyxProfileService } from '../../browser/profiles/onyxProfileService.js';
import { OnyxRouterService } from '../../browser/routing/onyxRouterService.js';
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
		this._stats.set(modelKey, { sampleCount: 5, tokensPerSecond: 0, timeToFirstTokenMs: 0, toolCallParseFailureRate: 0, acceptRate: 0.5, acceptSampleCount: 0, fimLatencyMs: 0, fimSampleCount: 0, ...stats });
	}
	getProfile(): IOnyxModelProfile { throw new Error('not used'); }
	getStats(modelKey: string): IOnyxObservedStats | undefined { return this._stats.get(modelKey); }
	reportMeasurement(): void { }
	reportOutcome(): void { }
	reportFimMeasurement(): void { }
	setOverride(): void { }
}

suite('OnyxRoutingAndProfiles', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	suite('router classify', () => {

		test('maps message shapes to task kinds', () => {
			const router = store.add(new OnyxRouterService(new StubProfileService(), new NullLogService()));
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
			const router = store.add(new OnyxRouterService(profiles, new NullLogService()));
			const models = [known('small/7b', 7), known('large/32b', 32)];
			assert.strictEqual(router.pickModel([user('add a null check')], models)?.key, 'small/7b');
			assert.strictEqual(router.pickModel([user('plan the migration of the storage architecture')], models)?.key, 'large/32b');
		});

		test('a strong accept rate can outweigh size fit', () => {
			const profiles = new StubProfileService();
			profiles.setStats('small/7b', { acceptRate: 0.95, acceptSampleCount: 10, tokensPerSecond: 80 });
			profiles.setStats('mid/14b', { acceptRate: 0.1, acceptSampleCount: 10, tokensPerSecond: 40 });
			const router = store.add(new OnyxRouterService(profiles, new NullLogService()));
			const picked = router.pickModel([user('what is a monad?')], [known('small/7b', 7), known('mid/14b', 14)]);
			assert.strictEqual(picked?.key, 'small/7b');
		});

		test('routing decisions carry human-readable reasons', () => {
			const router = store.add(new OnyxRouterService(new StubProfileService(), new NullLogService()));
			let reasons: readonly string[] = [];
			store.add(router.onDidRoute(decision => { reasons = decision.reasons; }));
			router.pickModel([user('hello')], [known('small/7b', 7)]);
			assert.ok(reasons.length > 0 && reasons[0].includes('7B'));
		});
	});

	suite('profile service', () => {

		test('measured tool-call failures harden the harness', () => {
			const storage = store.add(new InMemoryStorageService());
			const service = store.add(new OnyxProfileService(storage));
			const model = discovered('m', 32);
			const before = service.getProfile('k', model);
			for (let i = 0; i < 6; i++) {
				service.reportMeasurement({ modelKey: 'k', requestedModelId: 'm', timeToFirstTokenMs: 100, tokensPerSecond: 50, toolCallCount: 0, toolCallParseFailures: 2, promptTokens: 100, completionTokens: 50, finishReason: 'stop' });
			}
			const after = service.getProfile('k', model);
			assert.ok(after.toolCallQuality < before.toolCallQuality);
			assert.strictEqual(after.promptStyle, 'compact');
			assert.strictEqual(after.maxTools, 3);
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
