/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ILanguageModelChatRequestOptions, ILanguageModelChatResponse } from '../../../chat/common/languageModels.js';
import { ONYX_ONE_SHOT_MAX_TOKENS, runOneShot } from '../../browser/agent/onyxOneShot.js';
import { ONYX_CONTEXT_BUDGET } from '../../common/onyxContextBudget.js';

/**
 * A one-shot request (a measurement's task, a commit message, a review, an
 * inline edit) has an output cap. Without one, a model that never emits its
 * end token generates until someone stops it: on the reference machine a
 * 3B model wrote 34,000 tokens in answer to one measurement task before the
 * run was cancelled by hand (L11).
 */
suite('OnyxOneShot', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	function fakeModelService(sent: ILanguageModelChatRequestOptions[]) {
		return {
			async sendChatRequest(_model: string, _messages: unknown, _from: unknown, options: ILanguageModelChatRequestOptions): Promise<ILanguageModelChatResponse> {
				sent.push(options);
				return { stream: (async function* () { yield { type: 'text' as const, value: 'done' }; })(), result: Promise.resolve({}) };
			},
		};
	}

	test('R-51: a one-shot request always carries an output cap, the caller\'s when it gives one, and a measurement\'s seed and temperature beside it', async () => {
		const sent: ILanguageModelChatRequestOptions[] = [];
		const service = fakeModelService(sent);
		const replies = [
			await runOneShot(service, 'system', 'user', CancellationToken.None),
			await runOneShot(service, 'system', 'user', CancellationToken.None, { sampling: { temperature: 0, seed: 7 } }),
			await runOneShot(service, 'system', 'user', CancellationToken.None, { maxTokens: 256 }),
		];
		assert.deepStrictEqual({
			replies,
			options: sent.map(options => options.modelOptions),
			theCapIsTheBudgetsCeiling: ONYX_ONE_SHOT_MAX_TOKENS === ONYX_CONTEXT_BUDGET.outputMaxTokens,
		}, {
			replies: ['done', 'done', 'done'],
			options: [{ maxTokens: 4096 }, { maxTokens: 4096, temperature: 0, seed: 7 }, { maxTokens: 256 }],
			theCapIsTheBudgetsCeiling: true,
		});
	});
});
