/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Mock Ollama/OpenAI-compatible server for verifying Onyx end-to-end without a
 * real model. Implements `GET /v1/models`, `GET /api/tags`, `POST /api/show`,
 * `POST /api/pull` (NDJSON progress), streaming `POST /v1/chat/completions`,
 * `POST /v1/completions`, and the test-only `/debug/last-completion` and
 * `/debug/last-chat` introspection endpoints.
 *
 * Prompt markers it understands (see test/onyx/README.md):
 *   TOOLTEST        - emit a tool call for the first non-Onyx tool
 *   SYMTEST <name>  - call repoSymbols with that query (add EXPAND for the call graph)
 *   MEMTEST <text>  - call the remember tool with that note
 *
 * It also recognizes Onyx's commit-message and review system prompts and
 * answers them in the shape those flows parse.
 */

import http from 'node:http';

const PORT = Number(process.env.ONYX_MOCK_PORT ?? 11434);

const MODELS = [
	{ id: 'mock-coder:7b', family: 'mock-coder', parameter_size: '7.6B', quantization_level: 'Q4_K_M', context_length: 16384 },
	{ id: 'mock-coder:32b', family: 'mock-coder', parameter_size: '32.8B', quantization_level: 'Q4_K_M', context_length: 32768 },
];

let lastCompletionRequest: unknown;
let lastChatRequest: unknown;

const server = http.createServer((req, res) => {
	const url = new URL(req.url, 'http://localhost');
	console.log(`${req.method} ${url.pathname}`);

	if (req.method === 'GET' && url.pathname === '/v1/models') {
		return json(res, { object: 'list', data: MODELS.map((m: typeof MODELS[number]) => ({ id: m.id, object: 'model' })) });
	}
	if (req.method === 'GET' && url.pathname === '/api/tags') {
		return json(res, { models: MODELS.map((m: typeof MODELS[number]) => ({ name: m.id, details: { family: m.family, parameter_size: m.parameter_size, quantization_level: m.quantization_level } })) });
	}
	if (req.method === 'POST' && url.pathname === '/api/show') {
		return readBody(req).then(body => {
			const m = MODELS.find((m: typeof MODELS[number]) => m.id === body.model) ?? MODELS[0];
			json(res, { capabilities: ['completion', 'tools'], model_info: { 'mock.context_length': m.context_length } });
		});
	}
	if (req.method === 'POST' && url.pathname === '/api/pull') {
		return readBody(req).then(body => streamPull(res, body));
	}
	if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
		return readBody(req).then(body => { lastChatRequest = body; streamCompletion(res, body); });
	}
	if (req.method === 'POST' && url.pathname === '/v1/completions') {
		return readBody(req).then(body => {
			lastCompletionRequest = body;
			setTimeout(() => json(res, {
				choices: [{ text: `_mockCompletion(a, b);` }],
			}), 100);
		});
	}
	// Test-only introspection: the exact body of the most recent request of each kind.
	if (req.method === 'GET' && url.pathname === '/debug/last-completion') {
		return json(res, lastCompletionRequest ?? {});
	}
	if (req.method === 'GET' && url.pathname === '/debug/last-chat') {
		return json(res, lastChatRequest ?? {});
	}
	res.writeHead(404); res.end();
});

function json(res: http.ServerResponse, obj: unknown) {
	res.writeHead(200, { 'Content-Type': 'application/json' });
	res.end(JSON.stringify(obj));
}

function readBody(req: http.IncomingMessage) {
	return new Promise<any>(resolve => {
		let data = '';
		req.on('data', c => data += c);
		req.on('end', () => resolve(JSON.parse(data || '{}')));
	});
}

async function streamPull(res: http.ServerResponse, body: any) {
	res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
	const total = 1024 * 1024;
	for (let completed = 0; completed <= total; completed += total / 4) {
		res.write(`${JSON.stringify({ status: `pulling ${body.model}`, completed, total })}\n`);
		await sleep(50);
	}
	res.write(`${JSON.stringify({ status: 'success' })}\n`);
	res.end();
}

async function streamCompletion(res: http.ServerResponse, body: any) {
	res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
	const send = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
	const chunk = (delta: unknown) => ({ id: 'mock', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta, finish_reason: null }] });
	const messages = body.messages ?? [];
	const system = messages.find((m: any) => m.role === 'system')?.content ?? '';
	const lastUser = [...messages].reverse().find((m: any) => m.role === 'user');
	const hasToolResult = messages.some((m: any) => m.role === 'tool');
	const wantsSymbols = body.tools?.length && /SYMTEST\s+(\w+)/.test(lastUser?.content ?? '') && !hasToolResult;
	const wantsMemory = body.tools?.length && /MEMTEST\s+(.+)/.test(lastUser?.content ?? '') && !hasToolResult;
	const wantsTool = wantsSymbols || wantsMemory || (body.tools?.length && /TOOLTEST/.test(lastUser?.content ?? '') && !hasToolResult);

	await sleep(120); // simulated TTFT
	if (wantsTool) {
		const tool = wantsSymbols
			? (body.tools.find((t: any) => /repoSymbols/i.test(t.function.name)) ?? body.tools[0])
			: wantsMemory
				? (body.tools.find((t: any) => /remember|memory/i.test(t.function.name)) ?? body.tools[0])
				: (body.tools.find((t: any) => /todo|task/i.test(t.function.name)) ?? body.tools[0]);
		const args = wantsSymbols
			? JSON.stringify({ query: /SYMTEST\s+(\w+)/.exec(lastUser.content)[1], ...(/EXPAND/.test(lastUser.content) ? { expand: true } : {}) })
			: wantsMemory
				? JSON.stringify({ note: /MEMTEST\s+(.+)/.exec(lastUser.content)[1] })
				: '{}';
		send({ ...chunk({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: tool.function.name, arguments: '' } }] }) });
		send({ ...chunk({ tool_calls: [{ index: 0, function: { arguments: args } }] }) });
		send({ id: 'mock', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
	} else {
		const text = answerFor(system, body, hasToolResult);
		// ONYX_MOCK_WORD_DELAY_MS slows the stream so resilience tests have a
		// real mid-stream window to interrupt.
		const wordDelay = Number(process.env.ONYX_MOCK_WORD_DELAY_MS ?? 5);
		for (const word of text.split(' ')) {
			send(chunk({ content: word + ' ' }));
			await sleep(wordDelay);
		}
		send({ id: 'mock', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
	}
	send({ id: 'mock', object: 'chat.completion.chunk', model: body.model, choices: [], usage: { prompt_tokens: 420, completion_tokens: 25 } });
	res.write('data: [DONE]\n\n');
	res.end();
}

function answerFor(system: string, body: any, hasToolResult: boolean) {
	if (/You write git commit messages/.test(system)) {
		return 'Add discount helper\n\n- introduces applyDiscount';
	}
	if (/edit blocks in exactly this format/.test(system)) {
		// Inline edit: replace the selection's first non-empty line, so the
		// E2E can assert a deterministic hunk.
		const user = [...(body.messages ?? [])].reverse().find((m: any) => m.role === 'user')?.content ?? '';
		const selection = /Selected code:\n([\s\S]*?)\n\nInstruction:/.exec(user)?.[1] ?? '';
		const firstLine = selection.split('\n').find((line: string) => line.trim().length > 0) ?? '';
		return `<<<<<<< SEARCH\n${firstLine}\n=======\n${firstLine} // edited-by-mock\n>>>>>>> REPLACE`;
	}
	if (/skeptical senior reviewer/.test(system)) {
		return JSON.stringify({ findings: [{ file: 'src/report.ts', line: 9, severity: 'high', title: 'Unchecked index access', detail: 'lines[0] is read without a length check.' }] });
	}
	return `Hello from ${body.model}! ${hasToolResult ? 'Tool result received; task complete. ' : ''}Streaming ${body.tools?.length ?? 0} tools were offered. All inference is local.`;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

server.listen(PORT, () => console.log(`mock ollama on :${PORT}`));
