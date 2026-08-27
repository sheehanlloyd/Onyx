/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ChatMessageRole, IChatMessage } from '../../../chat/common/languageModels.js';
import { estimateMessageTokens, ToolCallAccumulator, toWireMessages, toWireTools } from '../../browser/model/onyxOpenAITranslator.js';

suite('OnyxOpenAITranslator', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('toWireMessages', () => {

		test('maps roles and concatenates text parts', () => {
			const messages: IChatMessage[] = [
				{ role: ChatMessageRole.System, content: [{ type: 'text', value: 'be brief' }] },
				{ role: ChatMessageRole.User, content: [{ type: 'text', value: 'hello ' }, { type: 'text', value: 'world' }] },
			];
			const wire = toWireMessages(messages);
			assert.deepStrictEqual(wire, [
				{ role: 'system', content: 'be brief' },
				{ role: 'user', content: 'hello world' },
			]);
		});

		test('assistant tool use becomes tool_calls and results become tool messages', () => {
			const messages: IChatMessage[] = [
				{ role: ChatMessageRole.Assistant, content: [{ type: 'tool_use', name: 'read_file', toolCallId: 'call_1', parameters: { path: 'a.ts' } }] },
				{ role: ChatMessageRole.User, content: [{ type: 'tool_result', toolCallId: 'call_1', value: [{ type: 'text', value: 'contents' }] }] },
			];
			const wire = toWireMessages(messages);
			assert.strictEqual(wire.length, 2);
			assert.strictEqual(wire[0].role, 'assistant');
			assert.deepStrictEqual(wire[0].tool_calls, [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } }]);
			assert.deepStrictEqual(wire[1], { role: 'tool', content: 'contents', tool_call_id: 'call_1' });
		});

		test('thinking parts are not sent to the endpoint', () => {
			const messages: IChatMessage[] = [
				{ role: ChatMessageRole.Assistant, content: [{ type: 'thinking', value: 'secret' }, { type: 'text', value: 'answer' }] },
			];
			const wire = toWireMessages(messages);
			assert.deepStrictEqual(wire, [{ role: 'assistant', content: 'answer' }]);
		});
	});

	suite('toWireTools', () => {

		test('maps tool schema and defaults missing input schemas', () => {
			const wire = toWireTools([
				{ name: 'search', description: 'search the workspace', inputSchema: { type: 'object', properties: { q: { type: 'string' } } } },
				{ name: 'noop' },
			]);
			assert.strictEqual(wire[0].function.name, 'search');
			assert.deepStrictEqual(wire[0].function.parameters, { type: 'object', properties: { q: { type: 'string' } } });
			assert.deepStrictEqual(wire[1].function.parameters, { type: 'object', properties: {} });
		});
	});

	suite('ToolCallAccumulator', () => {

		test('accumulates streamed fragments into one call', () => {
			const accumulator = new ToolCallAccumulator();
			accumulator.append(0, 'call_1', 'read_', undefined);
			accumulator.append(0, undefined, 'file', '{"pa');
			accumulator.append(0, undefined, undefined, 'th":"a.ts"}');
			const parts = accumulator.complete();
			assert.strictEqual(parts.length, 1);
			assert.strictEqual(parts[0].name, 'read_file');
			assert.strictEqual(parts[0].toolCallId, 'call_1');
			assert.deepStrictEqual(parts[0].parameters, { path: 'a.ts' });
			assert.strictEqual(accumulator.parseFailures, 0);
		});

		test('does not duplicate the name from the first fragment', () => {
			const accumulator = new ToolCallAccumulator();
			accumulator.append(0, 'call_1', 'todo', undefined);
			accumulator.append(0, undefined, undefined, '{}');
			const parts = accumulator.complete();
			assert.strictEqual(parts[0].name, 'todo');
		});

		test('keeps independent calls by index', () => {
			const accumulator = new ToolCallAccumulator();
			accumulator.append(0, 'a', 'first', '{}');
			accumulator.append(1, 'b', 'second', '{}');
			const parts = accumulator.complete();
			assert.deepStrictEqual(parts.map(p => p.name), ['first', 'second']);
		});

		test('repairs fenced, trailing-comma and truncated JSON', () => {
			const cases: [string, unknown][] = [
				['```json\n{"a":1}\n```', { a: 1 }],
				['{"a":1,}', { a: 1 }],
				['{"a":{"b":2}', { a: { b: 2 } }],
				['', {}],
			];
			for (const [raw, expected] of cases) {
				const accumulator = new ToolCallAccumulator();
				accumulator.append(0, 'id', 'tool', raw);
				const parts = accumulator.complete();
				assert.strictEqual(parts.length, 1, `should repair: ${raw}`);
				assert.deepStrictEqual(parts[0].parameters, expected, `repair of: ${raw}`);
			}
		});

		test('counts unrepairable arguments as parse failures', () => {
			const accumulator = new ToolCallAccumulator();
			accumulator.append(0, 'id', 'tool', 'not json at all {{{');
			const parts = accumulator.complete();
			assert.strictEqual(parts.length, 0);
			assert.strictEqual(accumulator.parseFailures, 1);
		});

		test('a call without a name is a parse failure', () => {
			const accumulator = new ToolCallAccumulator();
			accumulator.append(0, 'id', undefined, '{}');
			const parts = accumulator.complete();
			assert.strictEqual(parts.length, 0);
			assert.strictEqual(accumulator.parseFailures, 1);
		});
	});

	suite('estimateMessageTokens', () => {

		test('counts text, tool use and tool results', () => {
			const message: IChatMessage = {
				role: ChatMessageRole.User,
				content: [
					{ type: 'text', value: 'x'.repeat(400) },
					{ type: 'tool_result', toolCallId: 'c', value: [{ type: 'text', value: 'y'.repeat(40) }] },
				],
			};
			const tokens = estimateMessageTokens(message);
			assert.ok(tokens >= 110 && tokens <= 130, `expected ~114, got ${tokens}`);
		});
	});
});
