// Mock Ollama/OpenAI-compatible server for verifying Onyx end-to-end without a real model.
// Implements: GET /v1/models, GET /api/tags, POST /api/show, POST /v1/chat/completions (SSE).
import http from 'node:http';

const MODELS = [
	{ id: 'mock-coder:7b', family: 'mock-coder', parameter_size: '7.6B', quantization_level: 'Q4_K_M', context_length: 16384 },
	{ id: 'mock-coder:32b', family: 'mock-coder', parameter_size: '32.8B', quantization_level: 'Q4_K_M', context_length: 32768 },
];

const server = http.createServer((req, res) => {
	const url = new URL(req.url, 'http://localhost');
	console.log(`${req.method} ${url.pathname}`);

	if (req.method === 'GET' && url.pathname === '/v1/models') {
		return json(res, { object: 'list', data: MODELS.map(m => ({ id: m.id, object: 'model' })) });
	}
	if (req.method === 'GET' && url.pathname === '/api/tags') {
		return json(res, { models: MODELS.map(m => ({ name: m.id, details: { family: m.family, parameter_size: m.parameter_size, quantization_level: m.quantization_level } })) });
	}
	if (req.method === 'POST' && url.pathname === '/api/show') {
		return readBody(req).then(body => {
			const m = MODELS.find(m => m.id === body.model) ?? MODELS[0];
			json(res, { capabilities: ['completion', 'tools'], model_info: { 'mock.context_length': m.context_length } });
		});
	}
	if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
		return readBody(req).then(body => streamCompletion(res, body));
	}
	if (req.method === 'POST' && url.pathname === '/v1/completions') {
		return readBody(req).then(body => {
			setTimeout(() => json(res, {
				choices: [{ text: `_mockCompletion(a, b);` }],
			}), 100);
		});
	}
	res.writeHead(404); res.end();
});

function json(res, obj) {
	res.writeHead(200, { 'Content-Type': 'application/json' });
	res.end(JSON.stringify(obj));
}

function readBody(req) {
	return new Promise(resolve => {
		let data = '';
		req.on('data', c => data += c);
		req.on('end', () => resolve(JSON.parse(data || '{}')));
	});
}

async function streamCompletion(res, body) {
	res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
	const send = obj => res.write(`data: ${JSON.stringify(obj)}\n\n`);
	const chunk = delta => ({ id: 'mock', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta, finish_reason: null }] });
	const lastUser = [...(body.messages ?? [])].reverse().find(m => m.role === 'user');
	const hasToolResult = (body.messages ?? []).some(m => m.role === 'tool');
	const wantsSymbols = body.tools?.length && /SYMTEST\s+(\w+)/.test(lastUser?.content ?? '') && !hasToolResult;
	const wantsTool = wantsSymbols || (body.tools?.length && /TOOLTEST/.test(lastUser?.content ?? '') && !hasToolResult);

	await sleep(120); // simulated TTFT
	if (wantsTool) {
		const tool = wantsSymbols
			? (body.tools.find(t => /repoSymbols/i.test(t.function.name)) ?? body.tools[0])
			: (body.tools.find(t => /todo|task/i.test(t.function.name)) ?? body.tools[0]);
		const args = wantsSymbols ? JSON.stringify({ query: /SYMTEST\s+(\w+)/.exec(lastUser.content)[1] }) : '{}';
		send({ ...chunk({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: tool.function.name, arguments: '' } }] }) });
		send({ ...chunk({ tool_calls: [{ index: 0, function: { arguments: args } }] }) });
		send({ id: 'mock', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
	} else {
		const text = `Hello from ${body.model}! ${hasToolResult ? 'Tool result received; task complete. ' : ''}Streaming ${body.tools?.length ?? 0} tools were offered. All inference is local.`;
		for (const word of text.split(' ')) {
			send(chunk({ content: word + ' ' }));
			await sleep(15);
		}
		send({ id: 'mock', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
	}
	send({ id: 'mock', object: 'chat.completion.chunk', model: body.model, choices: [], usage: { prompt_tokens: 420, completion_tokens: 25 } });
	res.write('data: [DONE]\n\n');
	res.end();
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

server.listen(11434, () => console.log('mock ollama on :11434'));
