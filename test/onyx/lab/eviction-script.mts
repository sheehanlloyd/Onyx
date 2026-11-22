/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The scripted 16-turn runs of the eviction study (L17, H-9).
 *
 *   node test/onyx/lab/eviction-script.mts --probe --base-url http://127.0.0.1:<port> --model <id>…
 *   node test/onyx/lab/eviction-script.mts --out <results directory> --base-url http://127.0.0.1:<port> --model <id>… [--repetitions 3]
 *
 * The transcript is fixed: a system message, a request, and fifteen tool
 * calls each answered by a result of 4,000 characters, then a last turn.
 * Before each turn the product's own `planTurn` decides what is sent, under
 * one of the three eviction policies, for a context of 8,192 tokens. What
 * the model answers is cut short and thrown away: the next turn is the
 * script's. What is kept is what the runtime says the turn cost: the prompt
 * tokens it evaluated, how long that took, and the time to the first token.
 *
 * `--probe` sends one prompt twice and prints the runtime's counts, which
 * says whether `prompt_eval_count` is the tokens evaluated or the whole
 * prompt (PREREGISTRATION.md, Amendment 3). The runtime is Ollama's native
 * API: the OpenAI-compatible one does not carry these counts.
 *
 * It writes `traces/turns.jsonl`, one line a turn, and resumes: a run whose
 * sixteen turns are there is not sent again. It needs compiled output.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const out = (relative: string) => pathToFileURL(path.join(repoRoot, 'out', relative)).href;
const flags = (name: string): string[] => process.argv.flatMap((argument, index) => argument === name && process.argv[index + 1] !== undefined ? [process.argv[index + 1]] : []);
const baseUrl = flags('--base-url')[0];
const models = flags('--model');
const outDir = flags('--out')[0] ? path.resolve(flags('--out')[0]) : undefined;
const probe = process.argv.includes('--probe');
if (!baseUrl || models.length === 0 || (!probe && !outDir)) {
	console.error('usage: node test/onyx/lab/eviction-script.mts (--probe | --out <dir>) --base-url <url> --model <id>… [--repetitions <n>]');
	process.exit(2);
}
if (!/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\/?$/.test(baseUrl)) {
	console.error('eviction-script: the runtime has to be on this machine');
	process.exit(2);
}
const repetitions = Number(flags('--repetitions')[0] ?? 3);

type Part = { type: 'text'; value: string } | { type: 'tool_use'; name: string; toolCallId: string; parameters: object } | { type: 'tool_result'; toolCallId: string; value: { type: 'text'; value: string }[] };
interface IMessage { readonly role: number; readonly content: Part[] }
interface IBudgeted { readonly message: IMessage; readonly kind: 'system' | 'request' | 'turn' }
const budget: {
	ONYX_EVICTION_POLICIES: readonly string[];
	planTurn(input: { messages: readonly IBudgeted[]; contextTokens: number; schemaTokens: number; estimate: (message: IMessage) => number; policy: string }): { messages: readonly IBudgeted[]; fits: boolean; evictedCalls: number; evictedResults: number; replacedResults: number; messageTokens: number; messageBudgetTokens: number; maxTokens: number };
} = await import(out('vs/workbench/contrib/onyx/common/onyxContextBudget.js'));
const { ChatMessageRole }: { ChatMessageRole: { System: number; User: number; Assistant: number } } = await import(out('vs/workbench/contrib/chat/common/languageModels.js'));

const CONTEXT_TOKENS = 8192;
const TURNS = 16;
const estimate = (message: IMessage) => Math.ceil(JSON.stringify(message.content).length / 4);

/** A result of 4,000 characters that is different for every call and is not one token repeated. */
function resultText(call: number): string {
	const lines: string[] = [];
	for (let line = 0; lines.join('\n').length < 4000; line++) {
		lines.push(`${String(line + 1).padStart(3, ' ')}| export function part${call}_${line}(value: number): number { return value * ${call + 2} + ${line * 7 + call}; }`);
	}
	return lines.join('\n').slice(0, 4000);
}
const SYSTEM: IBudgeted = { kind: 'system', message: { role: ChatMessageRole.System, content: [{ type: 'text', value: 'You are a coding assistant working in a repository. Read files with the readFile tool before you answer. Answer briefly.' }] } };
const REQUEST: IBudgeted = { kind: 'request', message: { role: ChatMessageRole.User, content: [{ type: 'text', value: 'Read the fifteen part files one by one, then say which of them defines the function with the largest multiplier.' }] } };
const call = (index: number): IBudgeted => ({ kind: 'turn', message: { role: ChatMessageRole.Assistant, content: [{ type: 'tool_use', name: 'readFile', toolCallId: `call_${index}`, parameters: { path: `src/part${index}.ts` } }] } });
const result = (index: number): IBudgeted => ({ kind: 'turn', message: { role: ChatMessageRole.User, content: [{ type: 'tool_result', toolCallId: `call_${index}`, value: [{ type: 'text', value: resultText(index) }] }] } });

/** The messages as Ollama's native chat API takes them. */
function wire(messages: readonly IBudgeted[]): object[] {
	return messages.map(({ message }) => {
		const part = message.content[0];
		if (part.type === 'tool_use') {
			return { role: 'assistant', content: '', tool_calls: [{ function: { name: part.name, arguments: part.parameters } }] };
		}
		if (part.type === 'tool_result') {
			return { role: 'tool', content: part.value.map(value => value.value).join('') };
		}
		return { role: message.role === ChatMessageRole.System ? 'system' : message.role === ChatMessageRole.Assistant ? 'assistant' : 'user', content: part.value };
	});
}

interface ICounts { readonly promptEvalCount: number | null; readonly promptEvalMs: number | null; readonly evalCount: number | null; readonly loadMs: number | null; readonly firstTokenMs: number | null; readonly totalMs: number }
async function send(model: string, messages: object[]): Promise<ICounts> {
	const started = performance.now();
	const response = await fetch(`${baseUrl.replace(/\/$/, '')}/api/chat`, {
		method: 'POST', headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ model, messages, stream: true, options: { temperature: 0, seed: 1, num_predict: 8 } }),
		signal: AbortSignal.timeout(600_000),
	});
	if (!response.ok || !response.body) {
		throw new Error(`HTTP ${response.status} ${(await response.text().catch(() => '')).slice(0, 200)}`);
	}
	let firstTokenMs: number | null = null;
	let last: { prompt_eval_count?: number; prompt_eval_duration?: number; eval_count?: number; load_duration?: number } = {};
	let buffer = '';
	const decoder = new TextDecoder();
	for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
		buffer += decoder.decode(chunk, { stream: true });
		for (let newline = buffer.indexOf('\n'); newline >= 0; newline = buffer.indexOf('\n')) {
			const line = buffer.slice(0, newline).trim();
			buffer = buffer.slice(newline + 1);
			if (!line) {
				continue;
			}
			const event = JSON.parse(line);
			if (firstTokenMs === null && (event.message?.content || event.message?.tool_calls)) {
				firstTokenMs = Math.round(performance.now() - started);
			}
			if (event.done) {
				last = event;
			}
		}
	}
	return {
		promptEvalCount: last.prompt_eval_count ?? null, promptEvalMs: last.prompt_eval_duration === undefined ? null : Math.round(last.prompt_eval_duration / 1e6),
		evalCount: last.eval_count ?? null, loadMs: last.load_duration === undefined ? null : Math.round(last.load_duration / 1e6), firstTokenMs, totalMs: Math.round(performance.now() - started),
	};
}
const unload = async (model: string) => { await fetch(`${baseUrl.replace(/\/$/, '')}/api/generate`, { method: 'POST', body: JSON.stringify({ model, keep_alive: 0 }) }).then(response => response.text(), () => undefined); };

if (probe) {
	for (const model of models) {
		const messages = wire([SYSTEM, REQUEST, call(1), result(1), call(2), result(2)]);
		const first = await send(model, messages);
		const second = await send(model, messages);
		const longer = await send(model, wire([SYSTEM, REQUEST, call(1), result(1), call(2), result(2), call(3), result(3)]));
		console.log(JSON.stringify({ model, firstTime: first, sameAgain: second, oneCallMore: longer }));
		await unload(model);
	}
	process.exit(0);
}

fs.mkdirSync(path.join(outDir!, 'traces'), { recursive: true });
const turnsPath = path.join(outDir!, 'traces', 'turns.jsonl');
const done = new Map<string, number>();
for (const line of fs.existsSync(turnsPath) ? fs.readFileSync(turnsPath, 'utf8').split('\n').filter(Boolean) : []) {
	const turn: { run: string } = JSON.parse(line);
	done.set(turn.run, (done.get(turn.run) ?? 0) + 1);
}
const started = Date.now();
for (const model of models) {
	for (let repetition = 1; repetition <= repetitions; repetition++) {
		for (const policy of budget.ONYX_EVICTION_POLICIES) {
			const run = `${model}|${policy}|r${repetition}`;
			if (done.get(run) === TURNS) {
				continue;
			}
			if (done.has(run)) {
				// A run that was cut short starts again from its first turn: its turns depend on each other.
				const kept = fs.readFileSync(turnsPath, 'utf8').split('\n').filter(line => line && (JSON.parse(line) as { run: string }).run !== run);
				fs.writeFileSync(turnsPath, kept.length ? kept.join('\n') + '\n' : '');
			}
			// Nothing of the run before it is left in the runtime: every run starts cold.
			await unload(model);
			let messages: IBudgeted[] = [SYSTEM, REQUEST];
			for (let turn = 1; turn <= TURNS; turn++) {
				const plan = budget.planTurn({ messages, contextTokens: CONTEXT_TOKENS, schemaTokens: 0, estimate, policy });
				if (!plan.fits) {
					throw new Error(`${run}: turn ${turn} does not fit`);
				}
				messages = [...plan.messages];
				const counts = await send(model, wire(messages));
				fs.appendFileSync(turnsPath, JSON.stringify({ run, model, policy, repetition, turn, estimatedPromptTokens: plan.messageTokens, budgetTokens: plan.messageBudgetTokens, evictedCalls: plan.evictedCalls, replacedResults: plan.replacedResults, ...counts }) + '\n');
				// The script's next step, whatever the model said.
				if (turn < TURNS) {
					messages = [...messages, call(turn), result(turn)];
				}
			}
			console.log(`${run}: done`);
		}
	}
	await unload(model);
}
console.log(`eviction-script: finished in ${Math.round((Date.now() - started) / 1000)} s`);
