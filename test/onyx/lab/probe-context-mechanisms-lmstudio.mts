/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * B15, step 1, for LM Studio: every way a running LM Studio server accepts a
 * context size, established against the server and not from memory. For
 * each way it asks for {@link ASKED} tokens, then reads back what the server
 * says it loaded, from its native model list (`/api/v0/models`,
 * `loaded_context_length`) and its REST list (`/api/v1/models`, the loaded
 * instance's configuration). Between ways every model is unloaded.
 *
 *   node test/onyx/lab/probe-context-mechanisms-lmstudio.mts --base-url http://127.0.0.1:11502/v1 \
 *        --model qwen2.5-coder-1.5b-instruct --out docs/research/results/<date>-<name>/mechanisms.json
 *
 * It loads and unloads the model it is given and nothing else; it changes no
 * setting and downloads nothing. The load-time way goes through the `lms`
 * command LM Studio installs. It talks only to a server on this machine
 * (DEC-10).
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function value(flag: string): string | undefined {
	const index = process.argv.indexOf(flag);
	return index === -1 ? undefined : process.argv[index + 1];
}

const baseUrl = value('--base-url');
const model = value('--model');
const outFile = value('--out');
if (!baseUrl || !model || !outFile) {
	console.error('usage: node test/onyx/lab/probe-context-mechanisms-lmstudio.mts --base-url <http://127.0.0.1:port/v1> --model <key> --out <file.json>');
	process.exit(2);
}
if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(new URL(baseUrl).hostname)) {
	console.error(`probe-context-mechanisms-lmstudio: ${new URL(baseUrl).hostname} is not this machine (DEC-10).`);
	process.exit(2);
}

/**
 * What is asked for. Not 8,192: that is what LM Studio 0.4.23 loads a model at on demand on the reference
 * machine, and a way that asked for the default could not be told from one that did nothing. The first
 * version of this probe asked for 8,192 and reported every way as honoured.
 */
const ASKED = 12_288;
const root = baseUrl.replace(/\/v1\/?$/, '');
const lms = [path.join(os.homedir(), '.lmstudio', 'bin', 'lms'), 'lms'].find(candidate => { try { execFileSync(candidate, ['version'], { stdio: 'ignore' }); return true; } catch { return false; } });
if (!lms) {
	console.error('probe-context-mechanisms-lmstudio: the `lms` command is not installed');
	process.exit(2);
}

interface IReadBack { readonly native: number | null; readonly rest: number | null; readonly instances: number }

async function json(url: string, init?: RequestInit): Promise<{ readonly status: number; readonly body: unknown; readonly text: string }> {
	const response = await fetch(url, init);
	const text = await response.text();
	let body: unknown;
	try {
		body = JSON.parse(text);
	} catch {
		body = undefined;
	}
	return { status: response.status, body, text };
}
const post = (url: string, body: object) => json(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

/** What the server says it has loaded for the model: by its native list and by its REST list. */
async function readBack(): Promise<IReadBack> {
	const native = (await json(`${root}/api/v0/models`)).body as { data?: { id: string; loaded_context_length?: number }[] } | undefined;
	const rest = (await json(`${root}/api/v1/models`)).body as { models?: { key: string; loaded_instances?: { config?: { context_length?: number } }[] }[] } | undefined;
	const instances = rest?.models?.find(entry => entry.key === model)?.loaded_instances ?? [];
	return {
		native: native?.data?.find(entry => entry.id === model)?.loaded_context_length ?? null,
		rest: instances[0]?.config?.context_length ?? null,
		instances: instances.length,
	};
}

function unloadAll(): void {
	execFileSync(lms!, ['unload', '--all'], { stdio: 'ignore' });
}

const chat = (extra: object) => post(`${baseUrl}/chat/completions`, { model, messages: [{ role: 'user', content: 'Reply with the single word: ready' }], max_tokens: 4, temperature: 0, ...extra });

interface IWay { readonly way: string; readonly how: string; readonly status: number | string; readonly readBack: IReadBack; readonly honoured: boolean; readonly note?: string }
const ways: IWay[] = [];
const record = (way: string, how: string, status: number | string, readBack: IReadBack, note?: string) => {
	const honoured = readBack.native === ASKED || readBack.rest === ASKED;
	ways.push({ way, how, status, readBack, honoured, ...(note ? { note } : {}) });
	console.log(`${way.padEnd(34)} status ${String(status).padEnd(5)} native ${String(readBack.native).padEnd(6)} rest ${String(readBack.rest).padEnd(6)} instances ${readBack.instances}  ${honoured ? 'HONOURED' : 'not honoured'}${note ? `  (${note})` : ''}`);
};

unloadAll();
const before = await readBack();

// 1. A plain request loads the model on demand (just-in-time loading), at whatever context the server uses by default.
let reply = await chat({});
let retried: string | undefined;
if (reply.status >= 400) {
	// Seen once, on the first request after the server started: a 400 that did not come back on the next try.
	retried = `the first try answered ${reply.status} (${reply.text.slice(0, 120)}); this is the second, two seconds later`;
	await new Promise(resolve => setTimeout(resolve, 2000));
	reply = await chat({});
}
const defaultContext = await readBack();
record('just-in-time load, no request', 'a plain /v1/chat/completions request for a model that is not loaded', reply.status, defaultContext, retried);

// 2. Per-request fields on the OpenAI-compatible endpoint, for a model that is not loaded and for one that is.
for (const [name, extra] of [['context_length', { context_length: ASKED }], ['num_ctx', { num_ctx: ASKED }], ['options.num_ctx', { options: { num_ctx: ASKED } }]] as const) {
	unloadAll();
	reply = await chat(extra);
	record(`per request (${name}), cold`, `/v1/chat/completions with ${JSON.stringify(extra)}, model not loaded`, reply.status, await readBack());
	reply = await chat(extra);
	record(`per request (${name}), loaded`, `the same request again, model loaded`, reply.status, await readBack());
}

// 3. Load time, through the command LM Studio installs.
unloadAll();
let status: number | string;
try {
	execFileSync(lms, ['load', model, '--context-length', String(ASKED), '--yes'], { stdio: 'ignore', timeout: 120_000 });
	status = 'exit 0';
} catch (error) {
	status = `exit ${(error as { status?: number }).status ?? 'error'}`;
}
record('load time, `lms load --context-length`', `lms load ${model} --context-length ${ASKED} --yes`, status, await readBack());
// What a later plain request does to it: is the loaded instance used, or is another loaded?
reply = await chat({});
record('  then a plain request', 'a plain /v1/chat/completions request while that instance is loaded', reply.status, await readBack(), 'instances counts loaded copies of the model');

// 4. Load time, through the REST API LM Studio 0.4 serves.
unloadAll();
const restLoad = await post(`${root}/api/v1/models/load`, { model, context_length: ASKED });
record('load time, REST /api/v1/models/load', `POST /api/v1/models/load {"model","context_length":${ASKED}}`, restLoad.status, await readBack(), restLoad.status >= 400 ? restLoad.text.slice(0, 160) : undefined);

unloadAll();
const after = await readBack();

const result = {
	what: `B15, step 1, for LM Studio: each way of asking for a context of ${ASKED} tokens, and what the server reports it loaded afterwards.`,
	model,
	asked: ASKED,
	runtime: { name: 'lmstudio', version: (() => { try { return JSON.parse(fs.readFileSync(path.join(os.homedir(), '.lmstudio', '.internal', 'historical-version-info.json'), 'utf8')).lastRecordedAppVersion ?? null; } catch { return null; } })() },
	trainedContext: ((await json(`${root}/api/v0/models`)).body as { data?: { id: string; max_context_length?: number }[] } | undefined)?.data?.find(entry => entry.id === model)?.max_context_length ?? null,
	defaultContext: defaultContext.native,
	ways,
	notTried: [
		{ way: 'per-model default load settings', why: 'they are the owner\'s settings in LM Studio, kept in its own configuration; changing them changes every later load of the model, by any program. Not a way Onyx should use, and not tried' },
	],
	loadedBefore: before.instances,
	loadedAfter: after.instances,
	machine: { cpu: os.cpus()[0]?.model ?? 'unknown', memoryGiB: Math.round(os.totalmem() / 2 ** 30), loadAverage: Math.round(os.loadavg()[0] * 100) / 100 },
};
fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(result, undefined, '\t') + '\n');
console.log(`\nwrote ${outFile}`);
