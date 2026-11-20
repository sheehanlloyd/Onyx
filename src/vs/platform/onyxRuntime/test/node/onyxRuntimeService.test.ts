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

/**
 * R-43 (L3): the seed goes on the wire when a profile sets one, and the
 * `done` event says whether the runtime honoured it: true only when the
 * runtime echoed the seed it was sent, unknown when it stayed silent.
 */
suite('OnyxRuntimeService', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	interface IObservedRequest { readonly seed: unknown; readonly temperature: unknown }

	/** A one-route OpenAI-compatible server that streams two chunks and, when asked, echoes the request's seed on each. */
	async function serve(echo: boolean): Promise<{ readonly baseUrl: string; readonly requests: IObservedRequest[]; close(): Promise<void> }> {
		const requests: IObservedRequest[] = [];
		const { createServer } = await import('http');
		const server = createServer((request: http.IncomingMessage, response: http.ServerResponse) => {
			let raw = '';
			request.on('data', (chunk: Buffer) => { raw += chunk.toString(); });
			request.on('end', () => {
				const body = JSON.parse(raw) as { seed?: number; temperature?: number };
				requests.push({ seed: body.seed, temperature: body.temperature });
				response.writeHead(200, { 'Content-Type': 'text/event-stream' });
				const provenance = echo && body.seed !== undefined ? { seed: body.seed, system_fingerprint: 'fp_test' } : {};
				const chunk = (delta: object, finish: string | null) => `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', ...provenance, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
				response.write(chunk({ content: 'hello' }, null));
				response.write(chunk({}, 'stop'));
				response.write('data: [DONE]\n\n');
				response.end();
			});
		});
		await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
		const { port } = server.address() as AddressInfo;
		return { baseUrl: `http://127.0.0.1:${port}/v1`, requests, close: () => new Promise(resolve => server.close(() => resolve())) };
	}

	async function run(baseUrl: string, seed: number | undefined): Promise<{ readonly text: string; readonly done: { readonly finishReason: string | undefined; readonly seedHonoured: boolean | undefined; readonly fingerprint: string | undefined } | undefined }> {
		const disposables = new DisposableStore();
		const service = disposables.add(new OnyxRuntimeService(new NullLogService()));
		const events: IOnyxStreamEvent[] = [];
		disposables.add(service.onDidStream(event => events.push(event)));
		try {
			await service.startChatCompletion('op', { baseUrl, model: 'm', messages: [{ role: 'user', content: 'hi' }], temperature: 0, seed });
		} finally {
			disposables.dispose();
		}
		const text = events.filter(event => event.kind === 'delta').map(event => event.text).join('');
		const done = events.find(event => event.kind === 'done');
		return { text, done: done && { finishReason: done.finishReason, seedHonoured: done.seedHonoured, fingerprint: done.fingerprint } };
	}

	test('R-43: the seed is sent when set, and honoured only when the runtime echoes it', async () => {
		const echoing = await serve(true);
		const silent = await serve(false);
		store.add({ dispose: () => { echoing.close(); silent.close(); } });
		const withSeed = await run(echoing.baseUrl, 42);
		const withoutSeed = await run(echoing.baseUrl, undefined);
		const silentWithSeed = await run(silent.baseUrl, 42);
		assert.deepStrictEqual({
			onTheWire: { echoing: echoing.requests, silent: silent.requests },
			withSeed,
			withoutSeed,
			silentWithSeed,
		}, {
			onTheWire: { echoing: [{ seed: 42, temperature: 0 }, { seed: undefined, temperature: 0 }], silent: [{ seed: 42, temperature: 0 }] },
			withSeed: { text: 'hello', done: { finishReason: 'stop', seedHonoured: true, fingerprint: 'fp_test' } },
			withoutSeed: { text: 'hello', done: { finishReason: 'stop', seedHonoured: undefined, fingerprint: undefined } },
			silentWithSeed: { text: 'hello', done: { finishReason: 'stop', seedHonoured: undefined, fingerprint: undefined } },
		});
	});
});
