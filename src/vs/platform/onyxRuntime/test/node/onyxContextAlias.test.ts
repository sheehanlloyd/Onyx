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
import { contextAliasName, parseContextAlias } from '../../common/onyxContextAlias.js';
import { OnyxRuntimeService } from '../../node/onyxRuntimeService.js';

/**
 * R-61, the node half (B15): how a context is asked of an Ollama server. The
 * server here keeps models the way the live one was seen to: `/api/create`
 * with `from` and `parameters` adds a name, `/api/show` returns its
 * parameters as text, `/api/delete` removes it.
 */
suite('OnyxContextAlias', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	interface IServed { readonly params?: string; readonly size: number }

	async function serve(behaviour: 'honours' | 'drops-the-parameter' | 'refuses'): Promise<{ readonly baseUrl: string; readonly bodies: { readonly url: string; readonly method: string; readonly body: unknown }[]; close(): Promise<void> }> {
		const { createServer } = await import('http');
		const models = new Map<string, IServed>([['coder:7b', { size: 4_683_087_561 }], ['hand-made-ctx:8k', { params: 'num_ctx 8192', size: 4_683_087_561 }]]);
		const bodies: { url: string; method: string; body: unknown }[] = [];
		const server = createServer((request: http.IncomingMessage, response: http.ServerResponse) => {
			let raw = '';
			request.setEncoding('utf8');
			request.on('data', chunk => { raw += chunk; });
			request.on('end', () => {
				const body = raw ? JSON.parse(raw) as { model?: string; from?: string; parameters?: { num_ctx?: number } } : {};
				const reply = (status: number, value: object | string) => {
					response.writeHead(status, { 'Content-Type': typeof value === 'string' ? 'text/plain' : 'application/json' });
					response.end(typeof value === 'string' ? value : JSON.stringify(value));
				};
				if (request.url !== '/v1/models' && request.url !== '/api/tags' && request.url !== '/api/version' && request.url !== '/api/ps' && request.url !== '/api/show') {
					bodies.push({ url: request.url ?? '', method: request.method ?? '', body });
				}
				switch (request.url) {
					case '/v1/models': return reply(200, { data: [...models.keys()].map(id => ({ id, owned_by: 'library' })) });
					case '/api/tags': return reply(200, { models: [...models.entries()].map(([name, served]) => ({ name, digest: `digest-of-${name}`, size: served.size })) });
					case '/api/version': return reply(200, { version: '0.33.0' });
					case '/api/ps': return reply(200, { models: [] });
					case '/api/show': {
						const served = models.get(body.model ?? '');
						return served ? reply(200, { capabilities: ['completion'], model_info: { 'qwen2.context_length': 32768 }, ...(served.params ? { parameters: served.params } : {}) }) : reply(404, { error: 'model not found' });
					}
					case '/api/create': {
						if (behaviour === 'refuses' || !models.has(body.from ?? '')) {
							return reply(400, { error: 'invalid model name' });
						}
						models.set(body.model ?? '', { size: models.get(body.from ?? '')!.size, ...(behaviour === 'honours' && body.parameters?.num_ctx ? { params: `num_ctx                        ${body.parameters.num_ctx}` } : {}) });
						return reply(200, { status: 'success' });
					}
					case '/api/delete':
						return models.delete(body.model ?? '') ? reply(200, '') : reply(404, { error: 'model not found' });
					default: return reply(404, '404 page not found');
				}
			});
		});
		await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
		const { port } = server.address() as AddressInfo;
		return {
			baseUrl: `http://127.0.0.1:${port}/v1`, bodies,
			close: () => new Promise(resolve => {
				server.closeAllConnections();
				server.close(() => resolve());
			}),
		};
	}

	test('alias names: one per model and context, recognised again, and nothing else is', () => {
		assert.deepStrictEqual({
			tagged: contextAliasName('qwen2.5-coder:7b', 16_384),
			untagged: contextAliasName('llama3', 8192),
			ofAnAlias: contextAliasName('qwen2.5-coder:7b-onyx-ctx16384', 32_768),
			parsed: parseContextAlias('qwen2.5-coder:7b-onyx-ctx16384'),
			notOnes: ['qwen2.5-coder:7b', 'my-ctx:8k', 'x:7b-onyx-ctx12', 'x:7b-onyx-ctx0999', 'x:7b-onyx-ctx16384-more'].map(name => parseContextAlias(name)),
		}, {
			tagged: 'qwen2.5-coder:7b-onyx-ctx16384',
			untagged: 'llama3:latest-onyx-ctx8192',
			ofAnAlias: 'qwen2.5-coder:7b-onyx-ctx32768',
			parsed: { base: 'qwen2.5-coder:7b', tokens: 16_384 },
			notOnes: [undefined, undefined, undefined, undefined, undefined],
		});
	});

	test('R-61: creating an alias asks the server for a name over the same weights with the context in its parameters, reads it back, and the listing then marks it as an alias of its model', async () => {
		const server = await serve('honours');
		const disposables = store.add(new DisposableStore());
		try {
			const service = disposables.add(new OnyxRuntimeService(new NullLogService()));
			const created = await service.createContextAlias(server.baseUrl, 'coder:7b', 16_384);
			const listed = await service.listModels(server.baseUrl);
			const removedOther = await service.removeContextAlias(server.baseUrl, 'hand-made-ctx:8k');
			const removed = await service.removeContextAlias(server.baseUrl, 'coder:7b-onyx-ctx16384');
			const after = await service.listModels(server.baseUrl);
			assert.deepStrictEqual({
				created,
				listed: listed.map(model => ({ id: model.id, server: model.serverContextLength, sizeBytes: model.sizeBytes, alias: model.contextAlias })),
				// A model the user made is not Onyx's to remove, whatever it is asked.
				removedOther: removedOther.ok,
				removed,
				after: after.map(model => model.id),
				sent: server.bodies,
			}, {
				created: { ok: true, alias: 'coder:7b-onyx-ctx16384' },
				listed: [
					{ id: 'coder:7b', server: undefined, sizeBytes: 4_683_087_561, alias: undefined },
					{ id: 'hand-made-ctx:8k', server: 8192, sizeBytes: 4_683_087_561, alias: undefined },
					{ id: 'coder:7b-onyx-ctx16384', server: 16_384, sizeBytes: 4_683_087_561, alias: { base: 'coder:7b', tokens: 16_384 } },
				],
				removedOther: false,
				removed: { ok: true, alias: 'coder:7b-onyx-ctx16384' },
				after: ['coder:7b', 'hand-made-ctx:8k'],
				sent: [
					{ url: '/api/create', method: 'POST', body: { model: 'coder:7b-onyx-ctx16384', from: 'coder:7b', parameters: { num_ctx: 16_384 }, stream: false } },
					{ url: '/api/delete', method: 'DELETE', body: { model: 'coder:7b-onyx-ctx16384' } },
				],
			});
		} finally {
			disposables.dispose();
			await server.close();
		}
	});

	test('R-61: a server that refuses, or accepts and drops the context, is reported as not having honoured the request; out-of-range contexts and aliases of aliases are never sent', async () => {
		const refusing = await serve('refuses');
		const dropping = await serve('drops-the-parameter');
		const disposables = store.add(new DisposableStore());
		try {
			const service = disposables.add(new OnyxRuntimeService(new NullLogService()));
			const refused = await service.createContextAlias(refusing.baseUrl, 'coder:7b', 16_384);
			const dropped = await service.createContextAlias(dropping.baseUrl, 'coder:7b', 16_384);
			const tooSmall = await service.createContextAlias(dropping.baseUrl, 'coder:7b', 512);
			const ofAlias = await service.createContextAlias(dropping.baseUrl, 'coder:7b-onyx-ctx16384', 32_768);
			assert.deepStrictEqual({
				refused: refused.ok, refusedSays: refused.ok ? '' : refused.error.slice(0, 15),
				dropped: dropped.ok, droppedSays: dropped.ok ? '' : dropped.error,
				tooSmall: tooSmall.ok, ofAlias: ofAlias.ok,
				creates: dropping.bodies.filter(entry => entry.url === '/api/create').length,
			}, {
				refused: false, refusedSays: '400 Bad Request',
				dropped: false, droppedSays: 'the runtime accepted the request, but coder:7b-onyx-ctx16384 does not carry a context of 16384 tokens',
				tooSmall: false, ofAlias: false,
				creates: 1,
			});
		} finally {
			disposables.dispose();
			await refusing.close();
			await dropping.close();
		}
	});
});
