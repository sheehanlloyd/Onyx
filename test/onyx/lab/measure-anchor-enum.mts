/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Constrained anchors (L7): what an enumeration costs a runtime.
 *
 *   pnpm run transpile-client
 *   node test/onyx/lab/measure-anchor-enum.mts --base-url http://127.0.0.1:11500/v1 --model qwen2.5-coder:7b --out docs/research/results/<date>-anchor-enum
 *
 * A constrained turn is decoded against a schema; with constrained anchors
 * that schema enumerates the lines the model was shown. A runtime turns the
 * schema into a grammar before it produces the first token, so a larger
 * enumeration may take longer to start. This measures how much.
 *
 * For each size, the same short prompt (twenty numbered lines of a file and
 * a request to change one of them) is sent with the envelope schema the
 * product builds (`buildToolEnvelopeFormat` and `anchorEditSchema`, imported
 * from `out/`), the enumeration padded with distinct lines to that size.
 * Size 0 is the envelope without the `edit` action: the baseline. The prompt
 * does not grow with the enumeration, so what changes between sizes is the
 * grammar and nothing else.
 *
 * Recorded for every trial: the time to the first token, the whole time,
 * whether the reply was an `edit` action, whether both anchors were on the
 * list, and whether they were the line that was asked for. The first trial
 * of a size is the one that has to build the grammar; a runtime may reuse it
 * afterwards, so trials are reported one by one and not averaged away.
 *
 * It talks to a runtime on this machine and to nothing else (DEC-10).
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const argument = (name: string): string | undefined => {
	const index = process.argv.indexOf(`--${name}`);
	return index >= 0 ? process.argv[index + 1] : undefined;
};
const baseUrl = argument('base-url');
const model = argument('model');
const outDir = argument('out');
const sizes = (argument('sizes') ?? '0,50,100,200,400,800,1600').split(',').map(Number);
const trials = Number(argument('trials') ?? 3);
if (!baseUrl || !model || !outDir) {
	console.error('usage: node test/onyx/lab/measure-anchor-enum.mts --base-url <http://127.0.0.1:port/v1> --model <name> --out <results directory> [--sizes 0,50,…] [--trials 3]');
	process.exit(2);
}
const host = new URL(baseUrl).hostname;
if (host !== '127.0.0.1' && host !== 'localhost' && host !== '[::1]') {
	console.error(`measure-anchor-enum: ${host} is not this machine. A measurement talks only to a runtime on the machine it runs on (DEC-10).`);
	process.exit(2);
}

const out = (relative: string) => pathToFileURL(path.join(repoRoot, 'out', relative)).href;
const { buildToolEnvelopeFormat, toolEnvelopeInstruction, parseToolEnvelope } = await import(out('vs/workbench/contrib/onyx/common/onyxConstrainedToolCalls.js'));
const { anchorEditSchema, anchorEditInstruction, ONYX_ANCHOR_LIMITS } = await import(out('vs/workbench/contrib/onyx/common/onyxAnchorEdit.js'));

const root = baseUrl.replace(/\/v1\/?$/, '');
const tags = await (await fetch(`${root}/api/tags`)).json() as { models?: { name: string; digest?: string }[] };
const digest = tags.models?.find(entry => entry.name === model)?.digest;
if (!digest) {
	console.error(`measure-anchor-enum: the runtime at ${root} has no model named ${model}`);
	process.exit(2);
}
const runtimeVersion = (await (await fetch(`${root}/api/version`)).json() as { version?: string }).version ?? null;

/** The twenty lines the model is shown, and the one it is asked to change. */
const shown = Array.from({ length: 20 }, (_, index) => `const value${index} = ${index};`);
const TARGET = 'const value7 = 7;';
const read = ['src/values.ts (lines 1-20 of 20)', ...shown.map((line, index) => `${index + 1}| ${line}`)].join('\n');
const tools = [{ name: 'editFile' }, { name: 'readFile' }];

/** An enumeration of `size` distinct lines: the twenty that were shown, and lines of the same shape after them. */
function enumeration(size: number): string[] {
	return Array.from({ length: size }, (_, index) => index < shown.length ? shown[index] : `const value${index} = ${index};`);
}

interface ITrial { readonly size: number; readonly trial: number; readonly enumChars: number; readonly firstTokenMs: number | null; readonly totalMs: number; readonly reply: string; readonly action: 'edit' | 'tool' | 'answer' | 'invalid'; readonly anchorsOnTheList: boolean | null; readonly anchorsAreTheLineAsked: boolean | null; readonly error?: string }

async function send(size: number, trial: number): Promise<ITrial> {
	const anchors = enumeration(size);
	const schema = size > 0 ? anchorEditSchema({ paths: ['src/values.ts'], anchors, chars: 0 }) : undefined;
	const body = {
		model,
		stream: true,
		temperature: 0,
		max_tokens: 200,
		messages: [
			{ role: 'system', content: size > 0 ? `${toolEnvelopeInstruction()} ${anchorEditInstruction()}` : toolEnvelopeInstruction() },
			{ role: 'user', content: `You read this file:\n${read}\n\nReplace the line \`${TARGET}\` with \`const value7 = 70;\`.` },
		],
		response_format: buildToolEnvelopeFormat(tools, schema),
	};
	const started = performance.now();
	let firstTokenMs: number | null = null;
	let reply = '';
	try {
		const response = await fetch(`${baseUrl}/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(600_000) });
		if (!response.ok || !response.body) {
			return { size, trial, enumChars: anchors.join('').length, firstTokenMs: null, totalMs: performance.now() - started, reply: '', action: 'invalid', anchorsOnTheList: null, anchorsAreTheLineAsked: null, error: `HTTP ${response.status}: ${(await response.text()).slice(0, 300)}` };
		}
		const decoder = new TextDecoder();
		let pending = '';
		for await (const chunk of response.body) {
			pending += decoder.decode(chunk, { stream: true });
			const lines = pending.split('\n');
			pending = lines.pop() ?? '';
			for (const line of lines) {
				if (!line.startsWith('data: ') || line === 'data: [DONE]') {
					continue;
				}
				const delta = (JSON.parse(line.slice(6)) as { choices?: { delta?: { content?: string } }[] }).choices?.[0]?.delta?.content;
				if (delta) {
					firstTokenMs ??= performance.now() - started;
					reply += delta;
				}
			}
		}
	} catch (error) {
		return { size, trial, enumChars: anchors.join('').length, firstTokenMs, totalMs: performance.now() - started, reply, action: 'invalid', anchorsOnTheList: null, anchorsAreTheLineAsked: null, error: error instanceof Error ? error.message : String(error) };
	}
	const totalMs = performance.now() - started;
	let parsed: { action?: string; edit?: { startAnchor?: string; endAnchor?: string } } = {};
	try {
		parsed = JSON.parse(reply);
	} catch {
		// not JSON: the envelope parser below says what it is
	}
	const envelope = parseToolEnvelope(reply, tools.map(tool => tool.name));
	const action = parsed.action === 'edit' ? 'edit' : envelope.kind === 'tool' ? 'tool' : envelope.kind === 'answer' ? 'answer' : 'invalid';
	const start = parsed.edit?.startAnchor;
	const end = parsed.edit?.endAnchor;
	return {
		size, trial, enumChars: anchors.join('').length, firstTokenMs, totalMs, reply, action,
		anchorsOnTheList: action === 'edit' ? typeof start === 'string' && typeof end === 'string' && anchors.includes(start) && anchors.includes(end) : null,
		anchorsAreTheLineAsked: action === 'edit' ? start === TARGET && end === TARGET : null,
	};
}

const loadAtStart = os.loadavg()[0];
const startedAt = new Date();
// One request first, unmeasured, so that the model is loaded and no size pays for that.
await send(0, -1);
const results: ITrial[] = [];
for (const size of sizes) {
	for (let trial = 0; trial < trials; trial++) {
		const result = await send(size, trial);
		results.push(result);
		console.log(`size ${String(size).padStart(5)}  trial ${trial}  first token ${result.firstTokenMs === null ? '   n/a' : result.firstTokenMs.toFixed(0).padStart(6)} ms  total ${result.totalMs.toFixed(0).padStart(6)} ms  ${result.action}${result.anchorsOnTheList === null ? '' : result.anchorsOnTheList ? ', anchors on the list' : ', ANCHOR NOT ON THE LIST'}${result.anchorsAreTheLineAsked ? ', the line asked for' : ''}${result.error ? `  ${result.error}` : ''}`);
	}
}

const round = (value: number | null) => value === null ? null : Math.round(value);
const bySize = sizes.map(size => {
	const own = results.filter(result => result.size === size);
	const first = own.map(result => result.firstTokenMs).filter((value): value is number => value !== null);
	return {
		size,
		enumChars: own[0]?.enumChars ?? 0,
		firstTokenMs: own.map(result => round(result.firstTokenMs)),
		firstTrialFirstTokenMs: round(own[0]?.firstTokenMs ?? null),
		bestFirstTokenMs: first.length ? Math.round(Math.min(...first)) : null,
		totalMs: own.map(result => round(result.totalMs)),
		actions: own.map(result => result.action),
		editsWithAnchorsOnTheList: `${own.filter(result => result.anchorsOnTheList === true).length}/${own.filter(result => result.action === 'edit').length}`,
		editsOfTheLineAsked: `${own.filter(result => result.anchorsAreTheLineAsked === true).length}/${own.filter(result => result.action === 'edit').length}`,
		errors: own.filter(result => result.error).map(result => result.error),
	};
});

const directory = path.resolve(outDir);
fs.mkdirSync(path.join(directory, 'traces'), { recursive: true });
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
const summary = {
	what: 'Constrained anchors (L7): time to the first token of a constrained turn against the size of the enumeration in its schema. The prompt is the same at every size.',
	commit,
	model: { identifier: `ollama:${model}`, digest },
	runtime: { name: 'ollama', version: runtimeVersion },
	product: { maxAnchors: ONYX_ANCHOR_LIMITS.maxAnchors, maxChars: ONYX_ANCHOR_LIMITS.maxChars },
	machine: { cpu: os.cpus()[0]?.model ?? 'unknown', memoryGiB: Math.round(os.totalmem() / 2 ** 30), cores: os.cpus().length, loadAverageAtStart: Math.round(loadAtStart * 100) / 100, loadAverageAtEnd: Math.round(os.loadavg()[0] * 100) / 100 },
	trials,
	bySize,
};
fs.writeFileSync(path.join(directory, 'summary.json'), JSON.stringify(summary, undefined, '\t') + '\n');
// The replies are of a synthetic file: nothing of a user's is in them.
fs.writeFileSync(path.join(directory, 'traces', `${model.replace(/[^a-z0-9.]+/gi, '-')}.jsonl`), results.map(result => JSON.stringify(result)).join('\n') + '\n');
fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify({
	version: 1,
	name: path.basename(directory),
	createdAt: startedAt.toISOString(),
	models: [{ identifier: `ollama:${model}`, digest, runtime: { name: 'ollama', ...(runtimeVersion ? { version: runtimeVersion } : {}) }, context: { requestedTokens: null, reportedTokens: null, verifiedTokens: null, mechanism: null } }],
	seeds: [0],
	sampling: { temperature: 0, maxTokens: 200, responseFormat: true },
	harnessConfigurations: [{ name: 'none-the-measurement-talks-to-the-runtime-directly', hash: '00000000' }],
	taskSet: { name: 'one edit of one line of a twenty-line synthetic file, at each enumeration size', hash: '00000000', count: sizes.length },
	repetitions: trials,
	machine: { platform: process.platform, arch: process.arch, cpu: os.cpus()[0]?.model ?? 'unknown', memoryGiB: Math.round(os.totalmem() / 2 ** 30), nodeVersion: process.version.replace(/^v/, '') },
	regenerate: [{ output: 'summary.json', command: `node test/onyx/lab/measure-anchor-enum.mts --base-url <the runtime's base URL> --model ${model} --out docs/research/results/${path.basename(directory)}` }],
	hypotheses: [],
	notes: 'Constrained anchors (L7). No seed is sent; the seed listed is a placeholder the manifest requires. Temperature 0. The context is the runtime\'s own allocation: the prompt is about 300 tokens at every size. The enumeration at each size is the twenty lines shown and distinct lines of the same shape after them. The first trial of a size is the one that has to build the grammar. summary.json carries the load average at the start and the end.',
}, undefined, '\t') + '\n');
console.log(`\nwrote ${path.relative(repoRoot, directory)}/summary.json`);
