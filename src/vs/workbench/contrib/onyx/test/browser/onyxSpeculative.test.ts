/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { candidateDrafts, formatSpeculativeReadout, speculativeSetupHint, speculativeSupport } from '../../common/onyxSpeculative.js';

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
