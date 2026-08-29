/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { candidateDrafts, formatSpeculativeReadout, speculativeSupport } from '../../common/onyxSpeculative.js';

suite('OnyxSpeculative', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('support is per runtime, with measurement as the ground truth elsewhere', () => {
		assert.deepStrictEqual({
			lmstudio: speculativeSupport('lmstudio'),
			llamacpp: speculativeSupport('llamacpp'),
			ollama: speculativeSupport('ollama'),
			vllm: speculativeSupport('vllm'),
			generic: speculativeSupport('generic'),
		}, {
			lmstudio: 'per-request',
			llamacpp: 'server-configured',
			ollama: 'unsupported',
			vllm: 'server-configured',
			generic: 'unsupported',
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

	test('the readout claims a speedup only when one was measured', () => {
		const base = { targetKey: 'localhost:11434/qwen:32b', draftModelId: 'qwen:0.5b', measuredAt: 0 };
		const faster = formatSpeculativeReadout({ ...base, withDraft: { tokensPerSecond: 40, timeToFirstTokenMs: 300 }, withoutDraft: { tokensPerSecond: 25, timeToFirstTokenMs: 300 } });
		const flat = formatSpeculativeReadout({ ...base, withDraft: { tokensPerSecond: 25.5, timeToFirstTokenMs: 300 }, withoutDraft: { tokensPerSecond: 25, timeToFirstTokenMs: 300 } });
		const slower = formatSpeculativeReadout({ ...base, withDraft: { tokensPerSecond: 15, timeToFirstTokenMs: 300 }, withoutDraft: { tokensPerSecond: 25, timeToFirstTokenMs: 300 } });
		assert.deepStrictEqual({
			fasterSaysFaster: faster.includes('% faster') && faster.includes('measured on this machine'),
			flatSaysNoEffect: flat.includes('no measured effect'),
			slowerSaysSlower: slower.includes('slower'),
		}, { fasterSaysFaster: true, flatSaysNoEffect: true, slowerSaysSlower: true });
	});
});
