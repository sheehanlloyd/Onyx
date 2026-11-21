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
import { OnyxRuntimeService } from '../../node/onyxRuntimeService.js';

/**
 * What a runtime has in memory, and what it allocated for it (L5, and the
 * part of B13 that needed a live answer). An Ollama server says both on
 * `/api/ps`. The context it allocated when it loaded a model is the number a
 * prompt has to fit, whatever the model's own parameters say; a runtime that
 * has no such endpoint has said nothing, which is not "nothing is loaded".
 */
suite('OnyxLoadedModels', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	async function serve(routes: Readonly<Record<string, object>>): Promise<{ readonly baseUrl: string; close(): Promise<void> }> {
		const { createServer } = await import('http');
		const server = createServer((request: http.IncomingMessage, response: http.ServerResponse) => {
			let raw = '';
			request.setEncoding('utf8');
			request.on('data', chunk => { raw += chunk; });
			request.on('end', () => {
				// `/api/show` answers per model: the route is keyed by the model the body names.
				const model = request.url === '/api/show' ? (JSON.parse(raw || '{}') as { model?: string }).model : undefined;
				const route = routes[model ? `${request.url} ${model}` : request.url ?? ''];
				if (!route) {
					response.writeHead(404, { 'Content-Type': 'text/plain' });
					response.end('404 page not found');
					return;
				}
				response.writeHead(200, { 'Content-Type': 'application/json' });
				response.end(JSON.stringify(route));
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

	const OLLAMA: Readonly<Record<string, object>> = {
		'/v1/models': { data: [{ id: 'coder:7b' }, { id: 'coder:1.5b' }, { id: 'pinned:7b' }] },
		'/api/tags': { models: [{ name: 'coder:7b', digest: 'aaaa' }, { name: 'coder:1.5b', digest: 'bbbb' }, { name: 'pinned:7b', digest: 'cccc' }] },
		'/api/version': { version: '0.33.0' },
		'/api/show coder:7b': { capabilities: ['completion', 'tools'], model_info: { 'qwen2.context_length': 32768 } },
		'/api/show coder:1.5b': { capabilities: ['completion'], model_info: { 'qwen2.context_length': 32768 } },
		// A model whose parameters name a context of their own.
		'/api/show pinned:7b': { capabilities: ['completion'], model_info: { 'qwen2.context_length': 32768 }, parameters: 'num_ctx 8192\ntemperature 0.2' },
		// Two of the three are in memory. The server loaded the pinned one with less than its parameters ask for.
		'/api/ps': { models: [{ name: 'coder:7b', model: 'coder:7b', context_length: 4096 }, { name: 'pinned:7b', model: 'pinned:7b', context_length: 6000 }] },
	};

	test('L5: an Ollama server says which models are loaded and what it allocated for each; that number is the server context of a loaded model', async () => {
		const server = await serve(OLLAMA);
		const disposables = store.add(new DisposableStore());
		try {
			const service = disposables.add(new OnyxRuntimeService(new NullLogService()));
			const loaded = await service.listLoadedModels(server.baseUrl);
			const models = await service.listModels(server.baseUrl);
			assert.deepStrictEqual({
				loaded,
				contexts: models.map(model => ({ id: model.id, architecture: model.contextLength, server: model.serverContextLength })),
			}, {
				loaded: [{ id: 'coder:7b', contextLength: 4096 }, { id: 'pinned:7b', contextLength: 6000 }],
				contexts: [
					// Loaded: what the server allocated.
					{ id: 'coder:7b', architecture: 32768, server: 4096 },
					// Not loaded, and its parameters name nothing: the server has not said.
					{ id: 'coder:1.5b', architecture: 32768, server: undefined },
					// Loaded with less than its parameters name: what was allocated is what a prompt has to fit.
					{ id: 'pinned:7b', architecture: 32768, server: 6000 },
				],
			});
		} finally {
			disposables.dispose();
			await server.close();
		}
	});

	test('L5: a runtime with no such endpoint has not said what is loaded; one that has it and lists nothing has none loaded', async () => {
		const silent = await serve({ '/v1/models': { data: [{ id: 'coder:7b' }] } });
		const idle = await serve({ ...OLLAMA, '/api/ps': { models: [] } });
		const disposables = store.add(new DisposableStore());
		try {
			const service = disposables.add(new OnyxRuntimeService(new NullLogService()));
			assert.deepStrictEqual({
				noEndpoint: await service.listLoadedModels(silent.baseUrl),
				nothingLoaded: await service.listLoadedModels(idle.baseUrl),
				// With nothing loaded, a model's parameters are what there is to go on.
				pinnedWhenIdle: (await service.listModels(idle.baseUrl)).find(model => model.id === 'pinned:7b')?.serverContextLength,
			}, { noEndpoint: undefined, nothingLoaded: [], pinnedWhenIdle: 8192 });
		} finally {
			disposables.dispose();
			await silent.close();
			await idle.close();
		}
	});
});
