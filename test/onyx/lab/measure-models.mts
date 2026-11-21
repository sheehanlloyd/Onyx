/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Measures models on a runtime that is already running and writes their
 * datasheets as a results directory (L5, L3):
 *
 *   node test/onyx/lab/measure-models.mts --base-url http://127.0.0.1:11500/v1 \
 *        --model qwen2.5-coder:7b --model qwen2.5-coder:1.5b \
 *        --out docs/research/results/2026-11-21-datasheets
 *
 * It runs the same probe suite the product runs for "Onyx: Measure This
 * Model", through the same runtime service, from compiled output (`pnpm run
 * transpile-client` first). It starts nothing and downloads nothing: a model
 * the runtime does not already have is an error. It talks only to the base
 * URL it is given, which has to be on this machine (DEC-10).
 *
 * The directory gets `manifest.json`, `summary.json` (the datasheets and
 * their descriptions), and `traces/<model>.jsonl` (every probe request in
 * outline and every reply).
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateManifest } from './manifest.mts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const out = (relative: string) => pathToFileURL(path.join(repoRoot, 'out', relative)).href;

function values(flag: string): string[] {
	const found: string[] = [];
	process.argv.forEach((argument, index) => {
		if (argument === flag && process.argv[index + 1]) {
			found.push(process.argv[index + 1]);
		}
	});
	return found;
}

const baseUrl = values('--base-url')[0];
const models = values('--model');
const outDir = values('--out')[0];
if (!baseUrl || models.length === 0 || !outDir) {
	console.error('usage: node test/onyx/lab/measure-models.mts --base-url <http://127.0.0.1:port/v1> --model <id> [--model <id>…] --out <results directory>');
	process.exit(2);
}
const host = new URL(baseUrl).hostname;
if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(host)) {
	console.error(`measure-models: ${host} is not this machine. A measurement talks only to a runtime on the machine it runs on (DEC-10).`);
	process.exit(2);
}

interface IDiscovered { readonly id: string; readonly baseUrl: string; readonly runtime: string; readonly digest?: string; readonly runtimeVersion?: string; readonly contextLength?: number; readonly serverContextLength?: number }
interface ILoaded { readonly id: string; readonly contextLength?: number }
interface ITally { readonly successes: number; readonly trials: number }
interface IDatasheet { readonly model: string; readonly digest: string | null; readonly runtime: { readonly name: string; readonly version: string | null }; readonly nativeToolCalls: ITally }
interface IProbeMessage { readonly role: string; readonly content: string | null }
interface IProbeRequest { readonly messages: readonly IProbeMessage[]; readonly tools?: readonly { readonly function: { readonly name: string } }[]; readonly responseFormat?: { readonly json_schema?: { readonly name?: string } }; readonly temperature?: number; readonly maxTokens?: number; readonly seed?: number; readonly stop?: readonly string[]; readonly logprobs?: boolean }
interface IProbeReply { readonly text: string }

const { NullLogService } = await import(out('vs/platform/log/common/log.js'));
const { OnyxRuntimeService } = await import(out('vs/platform/onyxRuntime/node/onyxRuntimeService.js'));
const { OnyxRuntimeProbeTransport, runDatasheetProbes } = await import(out('vs/workbench/contrib/onyx/common/onyxDatasheetProbes.js'));
const { describeDatasheet } = await import(out('vs/workbench/contrib/onyx/common/onyxDatasheet.js'));
const { traceDigest } = await import(out('vs/workbench/contrib/onyx/common/onyxTrace.js'));
const { CancellationToken } = await import(out('vs/base/common/cancellation.js'));

const service = new OnyxRuntimeService(new NullLogService());
const startedAt = new Date();
const datasheets: Record<string, IDatasheet> = {};
const descriptions: Record<string, string[]> = {};
const manifestModels: { identifier: string; digest: string; runtime: { name: string; version?: string } }[] = [];
let requestCount = 0;

try {
	const discovered: readonly IDiscovered[] = await service.listModels(baseUrl);
	fs.mkdirSync(path.join(outDir, 'traces'), { recursive: true });
	for (const id of models) {
		const model = discovered.find(candidate => candidate.id === id);
		if (!model) {
			throw new Error(`the runtime at ${baseUrl} does not have ${id}. Nothing is downloaded by a measurement; it has: ${discovered.map(candidate => candidate.id).join(', ') || 'no models'}`);
		}
		if (!model.digest) {
			throw new Error(`the runtime reports no digest for ${id}; a published datasheet names the weights it measured`);
		}
		const loaded = async (): Promise<ILoaded | undefined> => ((await service.listLoadedModels(baseUrl)) as readonly ILoaded[] | undefined)?.find(entry => entry.id === id);
		const loadedBefore: readonly ILoaded[] | undefined = await service.listLoadedModels(baseUrl);
		console.log(`\n${id}  ${model.digest.slice(0, 19)}  ${model.runtime} ${model.runtimeVersion ?? '(version unknown)'}  loaded before: ${loadedBefore ? loadedBefore.some(entry => entry.id === id) : 'unknown'}`);
		const transport = new OnyxRuntimeProbeTransport(service, { baseUrl: model.baseUrl, model: model.id }, `measure-${id}`);
		const began = Date.now();
		const datasheet: IDatasheet = await runDatasheetProbes(transport, {
			model: model.id, digest: model.digest, runtime: model.runtime, runtimeVersion: model.runtimeVersion,
			serverContextTokens: model.serverContextLength,
			loadedAtStart: loadedBefore ? loadedBefore.some(entry => entry.id === id) : undefined,
		}, CancellationToken.None, {
			onProgress: (probe: string, done: number, total: number) => console.log(`  ${done}/${total} ${probe}`),
			resolveServerContextTokens: async () => (await loaded())?.contextLength ?? model.serverContextLength,
		});
		console.log(`  measured in ${Math.round((Date.now() - began) / 1000)} s, ${transport.log.length} requests`);
		const lines: string[] = describeDatasheet(datasheet);
		for (const line of lines) {
			console.log(`  ${line}`);
		}
		datasheets[id] = datasheet;
		descriptions[id] = lines;
		manifestModels.push({ identifier: `${model.runtime}:${model.id}`, digest: model.digest, runtime: { name: model.runtime, ...(model.runtimeVersion ? { version: model.runtimeVersion } : {}) } });
		requestCount += transport.log.length;

		// Each request in outline (a prompt is fixed text; a long one is given by its length and digest) and each reply as it came.
		const outline = (transport.log as { request: IProbeRequest; reply: IProbeReply }[]).map(({ request, reply }) => JSON.stringify({
			request: {
				messages: request.messages.map(message => (message.content ?? '').length > 400
					? { role: message.role, chars: (message.content ?? '').length, digest: traceDigest(message.content ?? ''), start: (message.content ?? '').slice(0, 80) }
					: { role: message.role, content: message.content }),
				...(request.tools ? { tools: request.tools.map(tool => tool.function.name) } : {}),
				...(request.responseFormat ? { schema: request.responseFormat.json_schema?.name } : {}),
				temperature: request.temperature, maxTokens: request.maxTokens, seed: request.seed, stop: request.stop, logprobs: request.logprobs,
			},
			reply: { ...reply, text: reply.text.length > 2000 ? `${reply.text.slice(0, 2000)}… [${reply.text.length} characters]` : reply.text },
		}));
		fs.writeFileSync(path.join(outDir, 'traces', `${id.replace(/[^A-Za-z0-9._-]/g, '_')}.jsonl`), outline.join('\n') + '\n');
	}
} finally {
	service.dispose();
}

const cpu = os.cpus()[0]?.model ?? 'unknown';
let osVersion = `${os.type()} ${os.release()}`;
try {
	osVersion = `macOS ${execFileSync('sw_vers', ['-productVersion'], { encoding: 'utf8' }).trim()}`;
} catch {
	// not macOS: the kernel's name and release stand
}
const suiteSource = fs.readFileSync(path.join(repoRoot, 'src', 'vs', 'workbench', 'contrib', 'onyx', 'common', 'onyxDatasheetProbes.ts'), 'utf8');
const name = path.basename(path.resolve(outDir));
const manifest = {
	version: 1,
	name,
	createdAt: startedAt.toISOString(),
	models: manifestModels,
	// The seeds the repeatability probe sends; no other probe sends one.
	seeds: [1000, 1001, 1002],
	sampling: { temperature: 0.2, maxTokens: 200, responseFormat: false },
	harnessConfigurations: [{ name: 'none-probes-talk-to-the-runtime-directly', hash: '00000000' }],
	taskSet: { name: 'datasheet probe suite, version 1 (the digest is of onyxDatasheetProbes.ts)', hash: traceDigest(suiteSource), count: requestCount },
	repetitions: 1,
	machine: { platform: process.platform, arch: process.arch, cpu, memoryGiB: Math.round(os.totalmem() / 1024 ** 3), osVersion, nodeVersion: process.version.replace(/^v/, '') },
	regenerate: [{
		output: 'summary.json',
		command: `node test/onyx/lab/measure-models.mts --base-url <the runtime's base URL> ${models.map(id => `--model ${id}`).join(' ')} --out docs/research/results/${name}`,
	}],
	notes: 'Model datasheets (L5). Sampling differs by probe and is in each trace line: 0.2 for most, 0 for the context probe, 1 with a seed for the repeatability probe. The probes do not go through the agent loop, so no harness configuration applies. A run talks to a runtime on the machine it runs on and to nothing else.',
};
const validation = validateManifest(manifest);
if (!validation.ok) {
	console.error(`measure-models: the manifest it would write is invalid:\n  ${validation.errors.join('\n  ')}`);
	process.exit(1);
}
fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, undefined, '\t') + '\n');
fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify({ datasheets, descriptions }, undefined, '\t') + '\n');
console.log(`\nwrote ${path.relative(repoRoot, path.resolve(outDir))}: manifest.json, summary.json, traces/ (${models.length} model${models.length === 1 ? '' : 's'}, ${requestCount} requests)`);
