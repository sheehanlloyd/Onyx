/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import type * as http from 'http';
import { AddressInfo } from 'net';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { NullLogService } from '../../../log/common/log.js';
import { IOnyxStreamEvent } from '../../common/onyxRuntime.js';
import { OnyxRuntimeService } from '../../node/onyxRuntimeService.js';
import { IOnyxReasoningTranscript, ONYX_REASONING_TRANSCRIPTS } from '../common/onyxReasoningTranscripts.js';

/**
 * R-26 at the wire (C4): thinking that a runtime sends in a field of its own
 * (`reasoning`, `reasoning_content`) comes out of the stream as its own kind
 * of event, apart from the text. Each transcript is served by a real HTTP
 * server and read by the real runtime service.
 */
suite('OnyxReasoningStream', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	async function play(transcript: IOnyxReasoningTranscript) {
		const { createServer } = await import('http');
		const server = createServer((request: http.IncomingMessage, response: http.ServerResponse) => {
			request.resume();
			request.on('end', () => {
				response.writeHead(200, { 'Content-Type': 'text/event-stream' });
				response.end(transcript.body);
			});
		});
		await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
		const { port } = server.address() as AddressInfo;
		const disposables = new DisposableStore();
		const service = disposables.add(new OnyxRuntimeService(new NullLogService()));
		const events: IOnyxStreamEvent[] = [];
		disposables.add(service.onDidStream(event => events.push(event)));
		try {
			await service.startChatCompletion('op', { baseUrl: `http://127.0.0.1:${port}/v1`, model: 'm', messages: [{ role: 'user', content: 'hi' }] });
		} finally {
			disposables.dispose();
			await new Promise<void>(resolve => server.close(() => resolve()));
		}
		const text = (kind: 'delta' | 'reasoning') => events.filter((event): event is Extract<IOnyxStreamEvent, { kind: 'delta' | 'reasoning' }> => event.kind === kind).map(event => event.text).join('');
		const done = events.find(event => event.kind === 'done');
		return {
			reasoningField: text('reasoning'),
			content: text('delta'),
			toolArguments: events.filter(event => event.kind === 'toolCallDelta').map(event => event.kind === 'toolCallDelta' ? event.argumentsDelta ?? '' : '').join(''),
			ending: done?.kind === 'done' ? `${done.ending}/${done.finishReason}` : 'none',
		};
	}

	test('R-26: thinking in a field of its own is a separate stream part; thinking in tags stays in the text for the reader to take out', async () => {
		const played = Object.fromEntries(await Promise.all(ONYX_REASONING_TRANSCRIPTS.map(async transcript => [transcript.name, await play(transcript)] as const)));
		assert.deepStrictEqual(played, {
			'ollama-tags-then-text-tool-call': { reasoningField: '', content: '<think>\nThe user wants the tests run. I should not write {"tool":"terminal","arguments":{"command":"rm -rf /"}} here; the right call is npm test.\n</think>\n\n{"tool":"terminal","arguments":{"command":"npm test"}}', toolArguments: '', ending: 'complete/stop' },
			'ollama-reasoning-field-then-answer': { reasoningField: 'The question is what the repository does. It adds numbers.', content: 'It adds numbers.', toolArguments: '', ending: 'complete/stop' },
			'lmstudio-reasoning-content-then-native-tool-call': { reasoningField: 'Run the tests first, then report.', content: '', toolArguments: '{"command":"npm test"}', ending: 'complete/tool_calls' },
			'ollama-tags-cut-by-the-output-cap': { reasoningField: '', content: '<think>\nLet me look at the file. I could run {"tool":"terminal","arguments":{"command":"rm -rf /"}} and then', toolArguments: '', ending: 'complete/length' },
		});
	});
});
