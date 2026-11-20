/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * L1: episodes are data shared by the in-process rig and the mock runtime.
 * The JSON scripts under test/onyx/sim/episodes/ must equal the TypeScript
 * scenarios they are exported from, and the mock must replay one over the
 * real SSE path: the scripted tool call on the first request, the scripted
 * answer on the second.
 *
 * Needs a current `pnpm run transpile-client` (the exporter imports from out/).
 *
 *   node --test test/onyx/checks/sim-episodes.test.mts
 */

import { strict as assert } from 'node:assert';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const episodesDir = path.join(repoRoot, 'test', 'onyx', 'sim', 'episodes');

test('L1: the episode JSON files are in sync with onyxSimScenarios.ts', () => {
	const result = spawnSync(process.execPath, [path.join(repoRoot, 'test', 'onyx', 'sim', 'export-episodes.mts'), '--check'], { cwd: repoRoot, encoding: 'utf8' });
	assert.deepStrictEqual({ status: result.status, files: fs.readdirSync(episodesDir).filter(name => name.endsWith('.json')).length >= 5 }, { status: 0, files: true }, result.stdout + result.stderr);
});

interface ISseSummary { readonly status: number; readonly text: string; readonly toolCalls: { name?: string; arguments: string }[]; readonly finishReasons: string[]; readonly done: boolean }

/** Reassembles one streamed completion: the text deltas, the tool calls and how it finished. */
async function sse(port: number, body: unknown): Promise<ISseSummary> {
	const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
	const raw = await response.text();
	const toolCalls = new Map<number, { name?: string; arguments: string }>();
	const finishReasons: string[] = [];
	let text = '';
	let done = false;
	for (const line of raw.split('\n')) {
		if (!line.startsWith('data:')) {
			continue;
		}
		const payload = line.slice(5).trim();
		if (payload === '[DONE]') {
			done = true;
			continue;
		}
		const chunk = JSON.parse(payload) as { choices?: { delta?: { content?: string; tool_calls?: { index: number; function?: { name?: string; arguments?: string } }[] }; finish_reason?: string | null }[] };
		const choice = chunk.choices?.[0];
		if (!choice) {
			continue;
		}
		text += choice.delta?.content ?? '';
		for (const call of choice.delta?.tool_calls ?? []) {
			const entry = toolCalls.get(call.index) ?? { arguments: '' };
			entry.name = call.function?.name ?? entry.name;
			entry.arguments += call.function?.arguments ?? '';
			toolCalls.set(call.index, entry);
		}
		if (choice.finish_reason) {
			finishReasons.push(choice.finish_reason);
		}
	}
	return { status: response.status, text, toolCalls: [...toolCalls.values()], finishReasons, done };
}

test('L1: the mock runtime replays an episode over SSE, turn by turn', { timeout: 60_000 }, async () => {
	const port = 11000 + Math.floor(Math.random() * 500);
	const episode = path.join(episodesDir, 'e2e-termtest.json');
	const mock = spawn(process.execPath, [path.join(repoRoot, 'test', 'onyx', 'mock-ollama.mts')], { cwd: repoRoot, env: { ...process.env, ONYX_MOCK_PORT: String(port), ONYX_MOCK_EPISODE: episode }, stdio: ['ignore', 'pipe', 'pipe'] });
	let stderr = '';
	mock.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
	mock.stdout?.on('data', () => { /* drained so the pipe never fills */ });
	try {
		const deadline = Date.now() + 15_000;
		let up = false;
		while (Date.now() < deadline && !up) {
			try {
				up = (await fetch(`http://127.0.0.1:${port}/v1/models`)).ok;
			} catch {
				await new Promise(resolve => setTimeout(resolve, 150));
			}
		}
		assert.equal(up, true, 'the mock never answered');
		const request = { model: 'mock-coder:7b', messages: [{ role: 'user', content: 'anything: markers are ignored in episode mode' }], tools: [{ type: 'function', function: { name: 'terminal' } }], stream: true };
		const first = await sse(port, request);
		const second = await sse(port, request);
		const status = await (await fetch(`http://127.0.0.1:${port}/debug/episode`)).json() as { name: string; turns: number; served: number };
		assert.deepStrictEqual({
			first: { status: first.status, toolCalls: first.toolCalls, finishReasons: first.finishReasons, done: first.done },
			second: { status: second.status, text: second.text, finishReasons: second.finishReasons, done: second.done },
			status: { name: status.name, turns: status.turns, served: status.served },
		}, {
			first: { status: 200, toolCalls: [{ name: 'terminal', arguments: '{"command":"echo onyx-e2e-terminal-ok"}' }], finishReasons: ['tool_calls'], done: true },
			second: { status: 200, text: 'The command ran and exited with code 0.', finishReasons: ['stop'], done: true },
			status: { name: 'e2e-termtest', turns: 2, served: 2 },
		}, `mock stderr:\n${stderr}`);
	} finally {
		mock.kill('SIGKILL');
	}
});
