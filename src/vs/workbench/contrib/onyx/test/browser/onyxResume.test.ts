/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { buildResumeDigest, buildResumePrompt, findResumableRuns, resumeConditionMessages } from '../../common/onyxResume.js';
import { IOnyxRunEvent, IOnyxRunSummary } from '../../common/onyxTypes.js';

function summary(overrides: Partial<IOnyxRunSummary>): IOnyxRunSummary {
	return { runId: 'r', startedAt: 0, title: 't', task: 'chat', modelKey: 'm', status: 'completed', turnCount: 1, toolCallCount: 0, ...overrides };
}

suite('OnyxResume', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('resumable = anything that never completed: crashed (still running), failed, cancelled', () => {
		const runs = [
			summary({ runId: 'a', status: 'running' }),
			summary({ runId: 'b', status: 'completed' }),
			summary({ runId: 'c', status: 'failed' }),
			summary({ runId: 'd', status: 'cancelled' }),
		];
		assert.deepStrictEqual(findResumableRuns(runs, 10).map(run => run.runId), ['a', 'c', 'd']);
		assert.deepStrictEqual(findResumableRuns(runs, 1).map(run => run.runId), ['a']);
	});

	test('the digest keeps the original request and the steps that matter', () => {
		const events: IOnyxRunEvent[] = [
			{ t: 0, kind: 'promptSnapshot', data: { turn: 1, messages: [{ role: 0, content: [{ type: 'text', value: 'system' }] }, { role: 1, content: [{ type: 'text', value: 'Add a subtract function' }] }] } },
			{ t: 1, kind: 'toolCall', data: { label: 'editFile' } },
			{ t: 2, kind: 'note', data: { label: 'Staged 1 edit(s) to src/math.ts' } },
			{ t: 3, kind: 'toolResult', data: { label: 'terminal', ok: false, reason: 'exit code 1' } },
		];
		assert.deepStrictEqual(buildResumeDigest(events), {
			originalRequest: 'Add a subtract function',
			progress: [
				'called tool editFile',
				'Staged 1 edit(s) to src/math.ts',
				'tool terminal failed: exit code 1',
			],
			truncated: false,
		});
	});

	test('every degraded condition gets its own sentence; a clean resume gets none', () => {
		const clean = resumeConditionMessages({ modelAvailable: true, originalModelKey: 'm', headMoved: false, pendingEditFiles: 0 });
		const degraded = resumeConditionMessages({ modelAvailable: false, originalModelKey: 'localhost:11434/q7b', headMoved: true, pendingEditFiles: 2 });
		assert.deepStrictEqual({
			clean,
			count: degraded.length,
			namesModel: degraded[0].includes('localhost:11434/q7b'),
			namesHead: degraded[1].includes('git HEAD moved'),
			namesEdits: degraded[2].includes('2 file(s)'),
		}, { clean: [], count: 3, namesModel: true, namesHead: true, namesEdits: true });
	});

	test('the resume prompt tells the model not to redo finished work', () => {
		const prompt = buildResumePrompt('title', { originalRequest: 'do X', progress: ['called tool a'], truncated: true }, ['The workspace has changed']);
		assert.ok(prompt.includes('do X'));
		assert.ok(prompt.includes('- called tool a'));
		assert.ok(prompt.includes('incomplete'));
		assert.ok(prompt.includes('The workspace has changed'));
		assert.ok(prompt.endsWith('Do not redo work that already succeeded; verify instead.'));
	});
});
