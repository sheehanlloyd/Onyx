/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { buildExplainFailurePrompt, formatDebugSnapshot, IOnyxDebugSnapshot } from '../../common/onyxDebugContext.js';

function snapshot(overrides: Partial<IOnyxDebugSnapshot>): IOnyxDebugSnapshot {
	return {
		sessionName: 'Launch app',
		threadName: 'main',
		stoppedReason: 'exception',
		frames: [
			{ name: 'divide', path: 'src/math.ts', line: 12 },
			{ name: 'main', path: 'src/index.ts', line: 3 },
		],
		variables: [
			{ scope: 'Local', name: 'a', value: '10' },
			{ scope: 'Local', name: 'b', value: '0' },
			{ scope: 'Closure', name: 'config', value: '{retries: 3}' },
		],
		...overrides,
	};
}

suite('OnyxDebugContext', () => {

	test('runtime-internal frames collapse so the user\u2019s own frames are what the model reads', () => {
		// Measured against a real paused Node process: two frames of the user's
		// code sat under eight `<node_internals>` module-loader frames, which is
		// most of the frame budget spent on the runtime rather than the bug.
		assert.strictEqual(formatDebugSnapshot(snapshot({
			frames: [
				{ name: 'subtotal', path: '/tmp/ws/run.js', line: 4 },
				{ name: '<anonymous>', path: '/tmp/ws/run.js', line: 19 },
				{ name: '<anonymous>', path: '<node_internals>/internal/modules/cjs/loader', line: 1929 },
				{ name: '<anonymous>', path: '<node_internals>/internal/modules/cjs/loader', line: 2060 },
				{ name: 'executeUserEntryPoint', path: '<node_internals>/internal/modules/run_main', line: 154 },
			],
			variables: [],
		})), [
			'Debug session "Launch app", thread "main" is paused (reason: exception).',
			'',
			'Call stack (innermost first):',
			'\u2192 subtotal \u2014 /tmp/ws/run.js:4',
			'  <anonymous> \u2014 /tmp/ws/run.js:19',
			'  [\u2026 3 runtime-internal frames \u2026]',
		].join('\n'));
	});


	ensureNoDisposablesAreLeakedInTestSuite();

	test('the snapshot renders stack, reason, and variables grouped by scope', () => {
		assert.strictEqual(formatDebugSnapshot(snapshot({})), [
			'Debug session "Launch app", thread "main" is paused (reason: exception).',
			'',
			'Call stack (innermost first):',
			'→ divide — src/math.ts:12',
			'  main — src/index.ts:3',
			'',
			'Variables in the paused frame:',
			'  [Local]',
			'  a = 10',
			'  b = 0',
			'  [Closure]',
			'  config = {retries: 3}',
		].join('\n'));
	});

	test('deep stacks and long values are truncated with explicit markers, never silently', () => {
		const many = snapshot({
			frames: Array.from({ length: 30 }, (_, i) => ({ name: `f${i}`, path: 'a.ts', line: i + 1 })),
			variables: [{ scope: 'Local', name: 'blob', value: 'x'.repeat(500) }],
		});
		const text = formatDebugSnapshot(many);
		assert.ok(text.includes('[… 10 deeper frame(s) omitted …]'));
		assert.ok(text.includes('… [truncated]'));
	});

	test('the explain prompt is the snapshot itself, with one instruction on top', () => {
		const prompt = buildExplainFailurePrompt(snapshot({}));
		assert.ok(prompt.startsWith('The debugger is paused. Explain what went wrong'));
		assert.ok(prompt.includes(formatDebugSnapshot(snapshot({}))));
	});
});
