/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { runtimesFoundHeadline } from '../../browser/onboarding/onyxRuntimeStep.js';

suite('OnyxOnboarding', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('the headline names every runtime that answered, not just the first', () => {
		const ollama = { displayName: 'Ollama', host: 'localhost:11434', modelCount: 3 };
		const lmStudio = { displayName: 'LM Studio', host: 'localhost:1234', modelCount: 3 };
		const llamacpp = { displayName: 'llama.cpp', host: 'localhost:8080', modelCount: 1 };
		// Found live: with Ollama and LM Studio both up, the step said
		// "Ollama is running — 6 models ready", crediting LM Studio's three
		// models to Ollama.
		assert.deepStrictEqual({
			one: runtimesFoundHeadline([ollama]),
			oneModel: runtimesFoundHeadline([{ ...ollama, modelCount: 1 }]),
			two: runtimesFoundHeadline([ollama, lmStudio]),
			three: runtimesFoundHeadline([ollama, lmStudio, llamacpp]),
		}, {
			one: 'Ollama is running — 3 models ready',
			oneModel: 'Ollama is running — 1 model ready',
			two: 'Ollama and LM Studio are running — 6 models ready',
			three: '3 local runtimes are running — 7 models ready',
		});
	});
});
