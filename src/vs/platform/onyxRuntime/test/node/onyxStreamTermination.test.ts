/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import type * as http from 'http';
import { AddressInfo } from 'net';
import { DeferredPromise, timeout } from '../../../../base/common/async.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { NullLogService } from '../../../log/common/log.js';
import { IOnyxStreamEvent } from '../../common/onyxRuntime.js';
import { OnyxRuntimeService } from '../../node/onyxRuntimeService.js';

/**
 * R-19, the stream half (B12): how a chat stream ended is said, not assumed.
 * A real HTTP server plays each ending against the real runtime service:
 * a finish reason, a `[DONE]`, a body that just ends, silence after the
 * first token, silence before any header, a cancel, a reset connection and
 * an HTTP error.
 */

type Script = 'finish-and-done' | 'done-only' | 'finish-only' | 'eof' | 'silent-after-first' | 'silent' | 'reset' | 'http-500';

const chunk = (delta: object, finish: string | null) => `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;

suite('OnyxStreamTermination', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	async function serve(script: Script): Promise<{ readonly baseUrl: string; close(): Promise<void> }> {
		const { createServer } = await import('http');
		const server = createServer((request: http.IncomingMessage, response: http.ServerResponse) => {
			request.resume();
			request.on('end', () => {
				if (script === 'silent') {
					return; // no header, no body, ever
				}
				if (script === 'http-500') {
					response.writeHead(500, { 'Content-Type': 'text/plain' });
					response.end('the model could not be loaded');
					return;
				}
				response.writeHead(200, { 'Content-Type': 'text/event-stream' });
				response.write(chunk({ content: 'partial answer' }, null));
				switch (script) {
					case 'finish-and-done':
						response.write(chunk({}, 'stop'));
						response.end('data: [DONE]\n\n');
						break;
					case 'done-only':
						response.end('data: [DONE]\n\n');
						break;
					case 'finish-only':
						response.end(chunk({}, 'stop'));
						break;
					case 'eof':
						response.end();
						break;
					case 'reset':
						// Give the first chunk time to leave, then drop the connection without ending the body.
						setTimeout(() => response.destroy(), 50);
						break;
					case 'silent-after-first':
						break; // the connection stays open and says nothing more
				}
			});
		});
		await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
		const { port } = server.address() as AddressInfo;
		return {
			baseUrl: `http://127.0.0.1:${port}/v1`,
			close: () => new Promise(resolve => {
				server.closeAllConnections();
				server.close(() => resolve());
			}),
		};
	}

	/** Runs one request and says how it ended: the `done` event's ending, `error`, or nothing within three seconds. */
	async function ending(script: Script, options: { readonly cancelAfterFirstToken?: boolean } = {}): Promise<{ readonly text: string; readonly end: string; readonly withinMs: boolean }> {
		const server = await serve(script);
		const disposables = new DisposableStore();
		const service = disposables.add(new OnyxRuntimeService(new NullLogService()));
		const events: IOnyxStreamEvent[] = [];
		const ended = new DeferredPromise<void>();
		disposables.add(service.onDidStream(event => {
			events.push(event);
			if (event.kind === 'delta' && options.cancelAfterFirstToken) {
				service.cancel('op');
			}
			if (event.kind === 'done' || event.kind === 'error') {
				ended.complete();
			}
		}));
		const startedAt = Date.now();
		const deadline = timeout(3000);
		try {
			// The deadlines are the product's, shortened: nobody waits ten minutes in a test.
			const request = service.startChatCompletion('op', { baseUrl: server.baseUrl, model: 'm', messages: [{ role: 'user', content: 'hi' }], firstByteTimeoutMs: 300, idleTimeoutMs: 300 });
			await Promise.race([ended.p, deadline.then(() => undefined, () => undefined)]);
			const last = events.find(event => event.kind === 'done' || event.kind === 'error');
			const end = !last ? 'nothing within 3 s' : last.kind === 'error' ? 'error' : last.kind === 'done' ? String(last.ending) : 'nothing within 3 s';
			if (!last) {
				await service.cancel('op');
			}
			await request;
			return { text: events.filter(event => event.kind === 'delta').map(event => event.text).join(''), end, withinMs: Date.now() - startedAt < 3000 };
		} finally {
			deadline.cancel();
			disposables.dispose();
			await server.close();
		}
	}

	test('R-19: a stream is complete only with a finish reason or [DONE]; a body that just ends is truncated; silence is stalled; a cancel is cancelled; a reset or an HTTP error is an error', async function () {
		this.timeout(60_000);
		assert.deepStrictEqual({
			finishAndDone: await ending('finish-and-done'),
			doneOnly: await ending('done-only'),
			finishOnly: await ending('finish-only'),
			bodyJustEnds: await ending('eof'),
			silentAfterFirstToken: await ending('silent-after-first'),
			silentBeforeAnyHeader: await ending('silent'),
			cancelled: await ending('silent-after-first', { cancelAfterFirstToken: true }),
			connectionReset: await ending('reset'),
			http500: await ending('http-500'),
		}, {
			finishAndDone: { text: 'partial answer', end: 'complete', withinMs: true },
			doneOnly: { text: 'partial answer', end: 'complete', withinMs: true },
			finishOnly: { text: 'partial answer', end: 'complete', withinMs: true },
			bodyJustEnds: { text: 'partial answer', end: 'truncated', withinMs: true },
			silentAfterFirstToken: { text: 'partial answer', end: 'stalled', withinMs: true },
			silentBeforeAnyHeader: { text: '', end: 'stalled', withinMs: true },
			cancelled: { text: 'partial answer', end: 'cancelled', withinMs: true },
			connectionReset: { text: 'partial answer', end: 'error', withinMs: true },
			http500: { text: '', end: 'error', withinMs: true },
		});
	});
});
