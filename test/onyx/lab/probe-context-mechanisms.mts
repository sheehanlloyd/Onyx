/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * B15, step 1: every way a running Ollama server accepts a context size,
 * established against the server and not from memory. For each way it sends
 * the request, then reads `/api/ps` and records what the server says it
 * allocated.
 *
 *   node test/onyx/lab/probe-context-mechanisms.mts --base-url http://127.0.0.1:11500/v1 \
 *        --model qwen2.5-coder:1.5b --out docs/research/results/<date>-<name>/mechanisms.json \
 *        [--configured-server http://127.0.0.1:11501/v1 --configured-tokens 8192]
 *
 * `--configured-server` names a second server that was started with
 * `OLLAMA_CONTEXT_LENGTH=<configured-tokens>`; the script starts nothing.
 * It creates one model alias (a second name over the same weights) to try
 * the derived-model way and removes it again. It downloads nothing and talks
 * only to servers on this machine (DEC-10).
 */

import fs from 'node:fs';
import path from 'node:path';

function value(flag: string): string | undefined {
	const index = process.argv.indexOf(flag);
	return index === -1 ? undefined : process.argv[index + 1];
}

const baseUrl = value('--base-url');
const model = value('--model');
const outFile = value('--out');
const configuredServer = value('--configured-server');
const configuredTokens = Number(value('--configured-tokens') ?? '8192');
if (!baseUrl || !model || !outFile) {
	console.error('usage: node test/onyx/lab/probe-context-mechanisms.mts --base-url <http://127.0.0.1:port/v1> --model <id> --out <file.json> [--configured-server <url> --configured-tokens <n>]');
	process.exit(2);
}
for (const url of [baseUrl, configuredServer]) {
	if (url && !['127.0.0.1', 'localhost', '[::1]', '::1'].includes(new URL(url).hostname)) {
		console.error(`probe-context-mechanisms: ${new URL(url).hostname} is not this machine (DEC-10).`);
		process.exit(2);
	}
}

const ASKED = 8192;
const rootOf = (url: string) => url.replace(/\/v1\/?$/, '');
const root = rootOf(baseUrl);

async function post(url: string, body: object, method = 'POST'): Promise<{ readonly status: number; readonly text: string }> {
	const response = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
	return { status: response.status, text: await response.text() };
}
async function loadedContext(server: string, name: string): Promise<number | null> {
	const body = await (await fetch(`${server}/api/ps`)).json() as { models?: { name?: string; context_length?: number; size?: number }[] };
	return body.models?.find(entry => entry.name === name)?.context_length ?? null;
}
async function unload(server: string, name: string): Promise<void> {
	await post(`${server}/api/generate`, { model: name, keep_alive: 0 });
	await new Promise(resolve => setTimeout(resolve, 1200));
}
const chat = (name: string, extra: object = {}) => ({ model: name, messages: [{ role: 'user', content: 'hi' }], max_tokens: 4, ...extra });

interface IFinding { readonly mechanism: string; readonly request: string; readonly asked: number | null; readonly reportedAfter: number | null; readonly honoured: boolean; readonly note: string }
const findings: IFinding[] = [];
const record = (finding: IFinding) => {
	findings.push(finding);
	console.log(`${finding.honoured ? 'honoured' : 'not honoured'}  ${finding.mechanism}: asked ${finding.asked ?? 'nothing'}, /api/ps reports ${finding.reportedAfter ?? 'nothing'}. ${finding.note}`);
};

const version = (await (await fetch(`${root}/api/version`)).json() as { version?: string }).version ?? null;
const show = await (await fetch(`${root}/api/show`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model }) })).json() as { parameters?: string; model_info?: Record<string, unknown> };
const trained = Object.entries(show.model_info ?? {}).find(([key]) => key.endsWith('.context_length'))?.[1] ?? null;

await unload(root, model);
await post(`${baseUrl}/chat/completions`, chat(model));
const defaultContext = await loadedContext(root, model);
record({ mechanism: 'nothing asked', request: 'POST /v1/chat/completions', asked: null, reportedAfter: defaultContext, honoured: true, note: 'The server\'s own allocation for this model on this machine.' });

await unload(root, model);
await post(`${baseUrl}/chat/completions`, chat(model, { options: { num_ctx: ASKED } }));
let reported = await loadedContext(root, model);
record({ mechanism: 'per-request option, OpenAI-style endpoint', request: 'POST /v1/chat/completions with options.num_ctx', asked: ASKED, reportedAfter: reported, honoured: reported === ASKED, note: 'The endpoint Onyx uses.' });

await unload(root, model);
await post(`${baseUrl}/chat/completions`, chat(model, { num_ctx: ASKED }));
reported = await loadedContext(root, model);
record({ mechanism: 'per-request top-level field, OpenAI-style endpoint', request: 'POST /v1/chat/completions with num_ctx', asked: ASKED, reportedAfter: reported, honoured: reported === ASKED, note: '' });

await unload(root, model);
await post(`${root}/api/chat`, { model, messages: [{ role: 'user', content: 'hi' }], stream: false, options: { num_ctx: ASKED, num_predict: 4 } });
reported = await loadedContext(root, model);
record({ mechanism: 'per-request option, native endpoint', request: 'POST /api/chat with options.num_ctx', asked: ASKED, reportedAfter: reported, honoured: reported === ASKED, note: 'A different wire protocol from the one Onyx speaks and L5 measured.' });
await post(`${baseUrl}/chat/completions`, chat(model));
const afterOpenAi = await loadedContext(root, model);
record({ mechanism: 'load-time context, then an OpenAI-style request', request: 'POST /api/chat with options.num_ctx, then POST /v1/chat/completions', asked: ASKED, reportedAfter: afterOpenAi, honoured: afterOpenAi === ASKED, note: 'Whether a context given when the model is loaded survives the next request on the endpoint Onyx uses.' });

await unload(root, model);
const alias = `${model.includes(':') ? model : `${model}:latest`}-onyx-ctx${ASKED}`;
const tagsBefore = await (await fetch(`${root}/api/tags`)).json() as { models?: { name: string; size?: number }[] };
const created = await post(`${root}/api/create`, { model: alias, from: model, parameters: { num_ctx: ASKED }, stream: false });
const tagsAfter = await (await fetch(`${root}/api/tags`)).json() as { models?: { name: string; size?: number; details?: { parent_model?: string } }[] };
await post(`${baseUrl}/chat/completions`, chat(alias));
reported = await loadedContext(root, alias);
const baseSize = tagsAfter.models?.find(entry => entry.name === model)?.size ?? null;
const aliasSize = tagsAfter.models?.find(entry => entry.name === alias)?.size ?? null;
await unload(root, alias);
const deleted = await post(`${root}/api/delete`, { model: alias }, 'DELETE');
const tagsEnd = await (await fetch(`${root}/api/tags`)).json() as { models?: { name: string }[] };
record({
	mechanism: 'derived model', request: 'POST /api/create {from, parameters: {num_ctx}}, then POST /v1/chat/completions to the new name', asked: ASKED, reportedAfter: reported, honoured: created.status === 200 && reported === ASKED,
	note: `Creates a second model name. The server lists it at ${aliasSize} bytes beside the original's ${baseSize}: the same weights file is referenced, not copied (the difference is the parameters layer). Removed again with DELETE /api/delete: status ${deleted.status}; models listed before ${tagsBefore.models?.length}, with the alias ${tagsAfter.models?.length}, after removal ${tagsEnd.models?.length}.`,
});

if (configuredServer) {
	const second = rootOf(configuredServer);
	await unload(second, model);
	await post(`${configuredServer}/chat/completions`, chat(model));
	reported = await loadedContext(second, model);
	await unload(second, model);
	record({ mechanism: 'server setting', request: `a server started with OLLAMA_CONTEXT_LENGTH=${configuredTokens}, then POST /v1/chat/completions`, asked: configuredTokens, reportedAfter: reported, honoured: reported === configuredTokens, note: 'Applies to every model the server loads, needs the server restarted, and is the user\'s to change.' });
}

fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify({ probedAt: new Date().toISOString(), runtime: { name: 'ollama', version }, model, trainedContextTokens: trained, defaultContextTokens: defaultContext, findings, lmStudio: 'not probed: this script speaks to an Ollama server only' }, undefined, '\t') + '\n');
console.log(`wrote ${outFile}`);
