/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { pickFimModel } from '../../browser/autocomplete/onyxInlineCompletions.js';
import { IOnyxObservedStats } from '../../common/onyxTypes.js';
import { IOnyxKnownModel } from '../../browser/model/onyxLanguageModelProvider.js';

function model(key: string, parameterB: number | undefined): IOnyxKnownModel {
	return {
		key,
		discovered: { id: key, baseUrl: 'http://localhost:11434/v1', runtime: 'ollama' },
		profile: { toolCallQuality: 0.8, contextLength: 8192, maxTools: 8, temperature: 0.2, promptStyle: 'compact', family: 'test', parameterB, supportsVision: false },
	};
}

function stats(fimLatencyMs: number, fimSampleCount: number): IOnyxObservedStats {
	return { sampleCount: 0, tokensPerSecond: 0, timeToFirstTokenMs: 0, toolCallParseFailureRate: 0, acceptRate: 0.5, acceptSampleCount: 0, fimLatencyMs, fimSampleCount, ttftColdMs: 0, ttftColdSamples: 0, ttftWarmMs: 0, ttftWarmSamples: 0, constrainedTurns: 0, constrainedFailures: 0, benchScores: {}, benchSamples: {} };
}

suite('OnyxAutocomplete', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('pickFimModel', () => {

		test('returns undefined without candidates', () => {
			assert.strictEqual(pickFimModel([], () => undefined), undefined);
		});

		test('smallest model wins when nothing is measured', () => {
			const picked = pickFimModel([model('a/big', 32), model('b/small', 3), model('c/mid', 7)], () => undefined);
			assert.strictEqual(picked?.key, 'b/small');
		});

		test('models without a known size sort last', () => {
			const picked = pickFimModel([model('a/unknown', undefined), model('b/known', 14)], () => undefined);
			assert.strictEqual(picked?.key, 'b/known');
		});

		test('measured latency outranks size once enough samples exist', () => {
			const byKey = new Map<string, IOnyxObservedStats>([
				['a/big', stats(80, 6)],
				['b/small', stats(220, 6)],
			]);
			const picked = pickFimModel([model('a/big', 32), model('b/small', 3)], key => byKey.get(key));
			assert.strictEqual(picked?.key, 'a/big');
		});

		test('too few samples fall back to size', () => {
			const byKey = new Map<string, IOnyxObservedStats>([['a/big', stats(80, 2)]]);
			const picked = pickFimModel([model('a/big', 32), model('b/small', 3)], key => byKey.get(key));
			assert.strictEqual(picked?.key, 'b/small');
		});
	});
});
