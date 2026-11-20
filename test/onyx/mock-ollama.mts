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
 *   TOOLTEST        - list the workspace root through the listDirectory tool
 *                     (the first offered tool when that one is absent)
 *   SYMTEST <name>  - call repoSymbols with that query (add EXPAND for the call graph)
 *   MEMTEST <text>  - call the remember tool with that note
 *   EDITTEST <path> - propose two staged edits to that file via editFile
 *   TERMTEST <cmd>  - propose that shell command via the terminal tool
 *   DOCTEST <query> - search the offline docs mirror via the docs tool
 *   PBTEST <name>   - fetch that repository playbook via the playbook tool
 *   READEDITTEST <path> - read that file via the readFile tool, then propose
 *                     an edit whose SEARCH text is a line it read back (R-31);
 *                     answers "no read tool" when readFile is not offered
 *
 * It also recognizes Onyx's commit-message and review system prompts and
 * answers them in the shape those flows parse.
 *
 * Episode replay (L1): `ONYX_MOCK_EPISODE=<path.json>` makes the mock answer
 * every chat completion with the next model turn of that episode script
 * (`test/onyx/sim/episodes/*.json`, the same data the in-process rig runs),
 * rendered through the real SSE path, markers ignored. `/debug/episode`
 * reports the script and how many turns have been served.
 */

import fs from 'node:fs';
import http from 'node:http';

const PORT = Number(process.env.ONYX_MOCK_PORT ?? 11434);
// ONYX_MOCK_KIND=lmstudio hides the Ollama native API, so discovery detects
// the endpoint as LM Studio (detection is by response, not by port).
const KIND = process.env.ONYX_MOCK_KIND ?? 'ollama';

const MODELS = [
	{ id: 'mock-coder:7b', family: 'mock-coder', parameter_size: '7.6B', quantization_level: 'Q4_K_M', context_length: 16384 },
	{ id: 'mock-coder:32b', family: 'mock-coder', parameter_size: '32.8B', quantization_level: 'Q4_K_M', context_length: 32768 },
];

let lastCompletionRequest: unknown;
let lastChatRequest: unknown;
const recentChatRequests: unknown[] = [];

type EpisodeTurn =
	| { kind: 'text'; text: string; chunks?: number }
	| { kind: 'toolCall'; tool: string; arguments: unknown; id?: string; argumentsText?: string; chunks?: number }
	| { kind: 'toolCalls'; calls: { tool: string; arguments: unknown; id?: string }[] }
	| { kind: 'textToolCall'; tool: string; arguments: unknown }
	| { kind: 'truncated'; text: string }
	| { kind: 'stall' }
	| { kind: 'error'; message: string };
interface IEpisode { name: string; persona: string; turns: EpisodeTurn[] }

const EPISODE_PATH = process.env.ONYX_MOCK_EPISODE;
const episode: IEpisode | undefined = EPISODE_PATH ? JSON.parse(fs.readFileSync(EPISODE_PATH, 'utf8')) : undefined;
let episodeTurnsServed = 0;

/** The next scripted turn: the looping persona repeats its last turn, everyone else falls back to a plain answer. */
function nextEpisodeTurn(): EpisodeTurn {
	if (!episode) {
		throw new Error('no episode loaded');
	}
	if (episodeTurnsServed < episode.turns.length) {
		return episode.turns[episodeTurnsServed++];
	}
	episodeTurnsServed++;
	return episode.persona === 'looping' && episode.turns.length ? episode.turns[episode.turns.length - 1] : { kind: 'text', text: 'Done.' };
}

function splitText(text: string, pieces: number): string[] {
	if (text.length === 0 || pieces <= 1) {
		return [text];
	}
	const size = Math.ceil(text.length / pieces);
	const out: string[] = [];
	for (let index = 0; index < text.length; index += size) {
		out.push(text.slice(index, index + size));
	}
	return out;
}

const server = http.createServer((req, res) => {
	const url = new URL(req.url, 'http://localhost');
	console.log(`${req.method} ${url.pathname}`);

	if (req.method === 'GET' && url.pathname === '/v1/models') {
		return json(res, { object: 'list', data: MODELS.map((m: typeof MODELS[number]) => ({ id: m.id, object: 'model' })) });
	}
	if (req.method === 'GET' && url.pathname === '/api/tags') {
		if (KIND !== 'ollama') {
			res.writeHead(404); return res.end();
		}
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
		return readBody(req).then(body => { lastChatRequest = body; recentChatRequests.push(body); if (recentChatRequests.length > 8) { recentChatRequests.shift(); } streamCompletion(res, body); });
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
	if (req.method === 'GET' && url.pathname === '/debug/recent-chats') {
		return json(res, recentChatRequests);
	}
	if (req.method === 'GET' && url.pathname === '/debug/last-chat') {
		return json(res, lastChatRequest ?? {});
	}
	if (req.method === 'GET' && url.pathname === '/debug/episode') {
		return json(res, episode ? { path: EPISODE_PATH, name: episode.name, persona: episode.persona, turns: episode.turns.length, served: episodeTurnsServed } : {});
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

/**
 * Episode replay: one scripted model turn over SSE, in the same shape the
 * marker paths emit. A truncated turn ends the body without `[DONE]`; a
 * stall never ends it (the client's timeout or cancel does); an error turn
 * closes the connection mid-stream.
 */
async function streamEpisodeTurn(res: http.ServerResponse, body: any, turn: EpisodeTurn) {
	res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
	const send = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
	const chunk = (delta: unknown) => ({ id: 'mock', object: 'chat.completion.chunk', model: body.model, ...seedEcho(body), choices: [{ index: 0, delta, finish_reason: null }] });
	const finish = (reason: string) => send({ id: 'mock', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: {}, finish_reason: reason }] });
	const usage = () => send({ id: 'mock', object: 'chat.completion.chunk', model: body.model, choices: [], usage: { prompt_tokens: 420, completion_tokens: 25 } });
	await sleep(120);
	switch (turn.kind) {
		case 'text':
			for (const piece of splitText(turn.text, turn.chunks ?? 8)) {
				send(chunk({ content: piece }));
				await sleep(Number(process.env.ONYX_MOCK_WORD_DELAY_MS ?? 5));
			}
			finish('stop');
			usage();
			break;
		case 'toolCall':
		case 'toolCalls': {
			const calls = turn.kind === 'toolCall' ? [{ tool: turn.tool, arguments: turn.arguments, id: turn.id, argumentsText: turn.argumentsText }] : turn.calls.map(call => ({ ...call, argumentsText: undefined }));
			calls.forEach((call, index) => {
				send({ ...chunk({ tool_calls: [{ index, id: call.id ?? `call_${index + 1}`, type: 'function', function: { name: call.tool, arguments: '' } }] }) });
				send({ ...chunk({ tool_calls: [{ index, function: { arguments: call.argumentsText ?? JSON.stringify(call.arguments) } }] }) });
			});
			finish('tool_calls');
			usage();
			break;
		}
		case 'textToolCall':
			send(chunk({ content: `I will call the tool now.\n{"tool":"${turn.tool}","arguments":${JSON.stringify(turn.arguments)}}` }));
			finish('stop');
			usage();
			break;
		case 'truncated':
			for (const piece of splitText(turn.text, 3)) {
				send(chunk({ content: piece }));
			}
			res.end(); // no finish_reason, no [DONE]
			return;
		case 'stall':
			return; // the connection stays open; nothing more arrives
		case 'error':
			send(chunk({ content: '' }));
			res.destroy(new Error(turn.message));
			return;
	}
	res.write('data: [DONE]\n\n');
	res.end();
}

async function streamCompletion(res: http.ServerResponse, body: any) {
	if (episode) {
		return streamEpisodeTurn(res, body, nextEpisodeTurn());
	}
	res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
	const send = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
	const chunk = (delta: unknown) => ({ id: 'mock', object: 'chat.completion.chunk', model: body.model, ...seedEcho(body), choices: [{ index: 0, delta, finish_reason: null }] });
	const messages = body.messages ?? [];
	const system = messages.find((m: any) => m.role === 'system')?.content ?? '';
	const lastUser = [...messages].reverse().find((m: any) => m.role === 'user');
	const hasToolResult = messages.some((m: any) => m.role === 'tool');
	const wantsSymbols = body.tools?.length && /SYMTEST\s+(\w+)/.test(lastUser?.content ?? '') && !hasToolResult;
	const wantsMemory = body.tools?.length && /MEMTEST\s+(.+)/.test(lastUser?.content ?? '') && !hasToolResult;
	// EDITTEST <path> emits two editFile calls (a modification, then a second
	// hunk) so the staged-review flow can be driven end to end without a model.
	const wantsEdit = body.tools?.length && /EDITTEST\s+(\S+)/.test(lastUser?.content ?? '') && !hasToolResult;
	// TERMTEST <command...> proposes one shell command through the terminal tool.
	const wantsTerminal = body.tools?.length && /TERMTEST\s+(.+)/.test(lastUser?.content ?? '') && !hasToolResult;
	// DOCTEST <query...> searches the offline docs mirror.
	const wantsDocs = body.tools?.length && /DOCTEST\s+(.+)/.test(lastUser?.content ?? '') && !hasToolResult;
	// PBTEST <name> fetches a repository playbook.
	const wantsPlaybook = body.tools?.length && /PBTEST\s+(\S+)/.test(lastUser?.content ?? '') && !hasToolResult;
	// READEDITTEST <path>: first turn reads the file, second turn edits the
	// line it read. Only the read tool's presence decides whether it can start.
	const readEditPath = /READEDITTEST\s+(\S+)/.exec(lastUser?.content ?? '')?.[1];
	const readTool = body.tools?.find((t: any) => /^readFile$/i.test(t.function.name));
	const wantsReadEdit = !!readEditPath && body.tools?.length && !hasToolResult;
	const wantsEditAfterRead = !!readEditPath && body.tools?.length && hasToolResult && messages.filter((m: any) => m.role === 'tool').length === 1;
	const wantsTool = wantsSymbols || wantsMemory || wantsEdit || wantsTerminal || wantsDocs || wantsPlaybook || (body.tools?.length && /TOOLTEST/.test(lastUser?.content ?? '') && !hasToolResult);

	await sleep(120); // simulated TTFT
	if (wantsReadEdit) {
		if (!readTool) {
			for (const word of 'I have no read tool: readFile was not offered, so I cannot read the file before editing it.'.split(' ')) {
				send(chunk({ content: word + ' ' }));
			}
			send({ id: 'mock', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
			send({ id: 'mock', object: 'chat.completion.chunk', model: body.model, choices: [], usage: { prompt_tokens: 420, completion_tokens: 25 } });
			res.write('data: [DONE]\n\n');
			res.end();
			return;
		}
		send({ ...chunk({ tool_calls: [{ index: 0, id: 'read_1', type: 'function', function: { name: readTool.function.name, arguments: '' } }] }) });
		send({ ...chunk({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ path: readEditPath }) } }] }) });
		send({ id: 'mock', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
		send({ id: 'mock', object: 'chat.completion.chunk', model: body.model, choices: [], usage: { prompt_tokens: 420, completion_tokens: 25 } });
		res.write('data: [DONE]\n\n');
		res.end();
		return;
	}
	if (wantsEditAfterRead) {
		const editTool = body.tools.find((t: any) => /editFile/i.test(t.function.name)) ?? body.tools[0];
		const readResult = String(messages.find((m: any) => m.role === 'tool')?.content ?? '');
		// The line it read back, with a numbered-read prefix ("12| ") removed if the tool adds one.
		const readLine = readResult.split('\n').map(line => line.replace(/^\s*\d+\|\s?/, '')).find(line => /return /.test(line)) ?? 'return a + b;';
		send({ ...chunk({ tool_calls: [{ index: 0, id: 'edit_after_read', type: 'function', function: { name: editTool.function.name, arguments: '' } }] }) });
		send({ ...chunk({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ path: readEditPath, search: readLine, replace: `${readLine} // edited-by-mock` }) } }] }) });
		send({ id: 'mock', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
		send({ id: 'mock', object: 'chat.completion.chunk', model: body.model, choices: [], usage: { prompt_tokens: 420, completion_tokens: 25 } });
		res.write('data: [DONE]\n\n');
		res.end();
		return;
	}
	if (wantsPlaybook) {
		const playbookTool = body.tools.find((t: any) => /playbook/i.test(t.function.name)) ?? body.tools[0];
		const playbookName = /PBTEST\s+(\S+)/.exec(lastUser.content)![1];
		send({ ...chunk({ tool_calls: [{ index: 0, id: 'pb_1', type: 'function', function: { name: playbookTool.function.name, arguments: '' } }] }) });
		send({ ...chunk({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ name: playbookName }) } }] }) });
		send({ id: 'mock', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
		send({ id: 'mock', object: 'chat.completion.chunk', model: body.model, choices: [], usage: { prompt_tokens: 420, completion_tokens: 25 } });
		res.write('data: [DONE]\n\n');
		res.end();
		return;
	}
	if (wantsDocs) {
		const docsTool = body.tools.find((t: any) => /docs/i.test(t.function.name)) ?? body.tools[0];
		const docsQuery = /DOCTEST\s+(.+)/.exec(lastUser.content)![1].trim();
		send({ ...chunk({ tool_calls: [{ index: 0, id: 'docs_1', type: 'function', function: { name: docsTool.function.name, arguments: '' } }] }) });
		send({ ...chunk({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ query: docsQuery }) } }] }) });
		send({ id: 'mock', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
		send({ id: 'mock', object: 'chat.completion.chunk', model: body.model, choices: [], usage: { prompt_tokens: 420, completion_tokens: 25 } });
		res.write('data: [DONE]\n\n');
		res.end();
		return;
	}
	if (wantsTerminal) {
		const terminalTool = body.tools.find((t: any) => /terminal/i.test(t.function.name)) ?? body.tools[0];
		const termCommand = /TERMTEST\s+(.+)/.exec(lastUser.content)![1].trim();
		send({ ...chunk({ tool_calls: [{ index: 0, id: 'term_1', type: 'function', function: { name: terminalTool.function.name, arguments: '' } }] }) });
		send({ ...chunk({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ command: termCommand }) } }] }) });
		send({ id: 'mock', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
		send({ id: 'mock', object: 'chat.completion.chunk', model: body.model, choices: [], usage: { prompt_tokens: 420, completion_tokens: 25 } });
		res.write('data: [DONE]\n\n');
		res.end();
		return;
	}
	if (wantsEdit) {
		const editTool = body.tools.find((t: any) => /editFile/i.test(t.function.name)) ?? body.tools[0];
		const editPath = /EDITTEST\s+(\S+)/.exec(lastUser.content)![1];
		const calls = [
			{ id: 'edit_1', args: JSON.stringify({ path: editPath, search: 'return a + b;', replace: 'return b + a; // edited-by-mock' }) },
			{ id: 'edit_2', args: JSON.stringify({ path: editPath, search: 'return a * b;', replace: 'return b * a; // edited-by-mock' }) },
		];
		calls.forEach((call, index) => {
			send({ ...chunk({ tool_calls: [{ index, id: call.id, type: 'function', function: { name: editTool.function.name, arguments: '' } }] }) });
			send({ ...chunk({ tool_calls: [{ index, function: { arguments: call.args } }] }) });
		});
		send({ id: 'mock', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
		send({ id: 'mock', object: 'chat.completion.chunk', model: body.model, choices: [], usage: { prompt_tokens: 420, completion_tokens: 25 } });
		res.write('data: [DONE]\n\n');
		res.end();
		return;
	}
	if (wantsTool) {
		const tool = wantsSymbols
			? (body.tools.find((t: any) => /repoSymbols/i.test(t.function.name)) ?? body.tools[0])
			: wantsMemory
				? (body.tools.find((t: any) => /remember|memory/i.test(t.function.name)) ?? body.tools[0])
				// TOOLTEST: list the workspace root with Onyx's own tool; any offered tool otherwise.
				: (body.tools.find((t: any) => /^listDirectory$/.test(t.function.name)) ?? body.tools[0]);
		const args = wantsSymbols
			? JSON.stringify({ query: /SYMTEST\s+(\w+)/.exec(lastUser.content)[1], ...(/EXPAND/.test(lastUser.content) ? { expand: true } : {}) })
			: wantsMemory
				? JSON.stringify({ note: /MEMTEST\s+(.+)/.exec(lastUser.content)[1] })
				: tool.function.name === 'listDirectory' ? JSON.stringify({ path: '.' }) : '{}';
		send({ ...chunk({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: tool.function.name, arguments: '' } }] }) });
		send({ ...chunk({ tool_calls: [{ index: 0, function: { arguments: args } }] }) });
		send({ id: 'mock', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
	} else {
		// SLOWTEST answers stream one word every 200ms for ~100 words, giving
		// interruption tests a deterministic 20-second window.
		const slow = /SLOWTEST/.test(lastUser?.content ?? '');
		const text = slow
			? Array.from({ length: 100 }, (_, i) => `slow-word-${i}`).join(' ')
			: answerFor(system, body, hasToolResult);
		// ONYX_MOCK_WORD_DELAY_MS slows the stream so resilience tests have a
		// real mid-stream window to interrupt.
		const wordDelay = slow ? 200 : Number(process.env.ONYX_MOCK_WORD_DELAY_MS ?? 5);
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
	if (/You suggest identifier names/.test(system)) {
		return 'mockSuggestedName — clear and specific\nmockAlternative — shorter\nmockThirdOption — conventional';
	}
	if (/You summarize software modules/.test(system)) {
		return 'Mock summary: holds the core arithmetic helpers this workspace tests against.';
	}
	if (/skeptical senior reviewer/.test(system)) {
		return JSON.stringify({ findings: [{ file: 'src/report.ts', line: 9, severity: 'high', title: 'Unchecked index access', detail: 'lines[0] is read without a length check.' }] });
	}
	return `Hello from ${body.model}! ${hasToolResult ? 'Tool result received; task complete. ' : ''}Streaming ${body.tools?.length ?? 0} tools were offered. All inference is local.`;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/**
 * A request that carries `seed` gets it echoed on every chunk, with a
 * fingerprint, which is how Onyx records that the runtime honoured the seed
 * (L3). Real runtimes that stay silent are recorded as "unknown".
 */
function seedEcho(body: any): { seed?: number; system_fingerprint?: string } {
	return typeof body.seed === 'number' ? { seed: body.seed, system_fingerprint: 'fp_mock' } : {};
}

server.listen(PORT, () => console.log(`mock ollama on :${PORT}${episode ? ` replaying episode ${episode.name} (${episode.turns.length} turns)` : ''}`));
