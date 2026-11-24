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
const contextArg = values('--context')[0];
const keepAlias = process.argv.includes('--keep-alias');
/**
 * `--digest <model>=<sha256>`, for a runtime that reports no digest (LM Studio): the SHA-256 of the weights file it
 * loads, computed by whoever runs the measurement (`shasum -a 256 <file>`). `--runtime-version` likewise.
 */
const givenDigests = new Map(values('--digest').map(entry => { const at = entry.lastIndexOf('='); return [entry.slice(0, at), entry.slice(at + 1)] as const; }));
const givenRuntimeVersion = values('--runtime-version')[0];
if (!baseUrl || models.length === 0 || !outDir || (contextArg !== undefined && !/^[1-9]\d{3,6}$/.test(contextArg))) {
	console.error('usage: node test/onyx/lab/measure-models.mts --base-url <http://127.0.0.1:port/v1> --model <id> [--model <id>…] --out <results directory> [--context <tokens> [--keep-alias]]');
	console.error('  --context: ask the runtime for this context first (B15). It creates a model alias on the runtime, over the same weights,');
	console.error('             verifies the allocation with the canary probe, measures at the old and the new context, and removes the alias');
	console.error('             again unless --keep-alias is given. Starting the script with this flag is the consent the product asks for in a dialog.');
	process.exit(2);
}
const requestedContext = contextArg === undefined ? undefined : Number(contextArg);
const host = new URL(baseUrl).hostname;
if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(host)) {
	console.error(`measure-models: ${host} is not this machine. A measurement talks only to a runtime on the machine it runs on (DEC-10).`);
	process.exit(2);
}

interface IDiscovered { readonly id: string; readonly baseUrl: string; readonly runtime: string; readonly digest?: string; readonly runtimeVersion?: string; readonly contextLength?: number; readonly serverContextLength?: number; readonly sizeBytes?: number }
interface ILoaded { readonly id: string; readonly contextLength?: number }
interface ITally { readonly successes: number; readonly trials: number }
interface IDatasheet { readonly model: string; readonly digest: string | null; readonly runtime: { readonly name: string; readonly version: string | null }; readonly nativeToolCalls: ITally; readonly context: { readonly serverReportedTokens: number | null; readonly requestedTokens: number | null; readonly verifiedTokens: number | null; readonly mechanism: string | null } }
interface IProbeMessage { readonly role: string; readonly content: string | null }
interface IProbeRequest { readonly messages: readonly IProbeMessage[]; readonly tools?: readonly { readonly function: { readonly name: string } }[]; readonly responseFormat?: { readonly json_schema?: { readonly name?: string } }; readonly temperature?: number; readonly maxTokens?: number; readonly seed?: number; readonly stop?: readonly string[]; readonly logprobs?: boolean }
interface IProbeReply { readonly text: string; readonly firstTokenMs?: number; readonly totalMs: number; readonly completionTokens?: number; readonly ending: string }
interface ICanaryStep { readonly role: string; readonly sentTokens: number; readonly promptTokens: number | null; readonly recalled: boolean }
interface IVerdict { readonly status: string; readonly verifiedTokens: number | null; readonly cutObserved: boolean }
interface IAliasResult { readonly ok: boolean; readonly alias?: string; readonly error?: string }
interface ITransport { send(request: IProbeRequest, token: unknown): Promise<IProbeReply>; readonly log: { request: IProbeRequest; reply: IProbeReply }[] }
/** Memory and speed of one name at one context: what loading it takes, what a run adds, how fast it answers. */
interface IPerformance { readonly wireModel: string; readonly reportedContextTokens: number | null; readonly loadedBytes: number | null; readonly runtimeRssIdleBytes: number | null; readonly runtimeRssPeakBytes: number | null; readonly coldFirstTokenMs: number | null; readonly warmFirstTokenMs: number | null; readonly tokensPerSecond: number | null }

const { NullLogService } = await import(out('vs/platform/log/common/log.js'));
const { OnyxRuntimeService } = await import(out('vs/platform/onyxRuntime/node/onyxRuntimeService.js'));
const { OnyxRuntimeProbeTransport, runDatasheetProbes, runAllocationCanary } = await import(out('vs/workbench/contrib/onyx/common/onyxDatasheetProbes.js'));
const { describeDatasheet } = await import(out('vs/workbench/contrib/onyx/common/onyxDatasheet.js'));
const { judgeAllocation, contextTarget, removeAliasCommand } = await import(out('vs/workbench/contrib/onyx/common/onyxContextAllocation.js'));
const { traceDigest } = await import(out('vs/workbench/contrib/onyx/common/onyxTrace.js'));
const { CancellationToken } = await import(out('vs/base/common/cancellation.js'));

const service = new OnyxRuntimeService(new NullLogService());
const startedAt = new Date();
const datasheets: Record<string, IDatasheet> = {};
const descriptions: Record<string, string[]> = {};
const allocations: Record<string, object> = {};
const performance: Record<string, { readonly serverAllocation: IPerformance; readonly requestedContext?: IPerformance }> = {};
const manifestModels: { identifier: string; digest: string; runtime: { name: string; version?: string }; context: { requestedTokens: number | null; reportedTokens: number | null; verifiedTokens: number | null; mechanism: string | null } }[] = [];
const aliasesLeft: string[] = [];
let requestCount = 0;

const ollamaRoot = baseUrl.replace(/\/v1\/?$/, '');
/** What the runtime's own account of a loaded name says it takes, in bytes. */
async function loadedBytes(name: string): Promise<number | null> {
	try {
		const body = await (await fetch(`${ollamaRoot}/api/ps`)).json() as { models?: { name?: string; size?: number }[] };
		return body.models?.find(entry => entry.name === name)?.size ?? null;
	} catch {
		return null;
	}
}
async function unload(name: string): Promise<void> {
	try {
		await fetch(`${ollamaRoot}/api/generate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: name, keep_alive: 0 }) });
		await new Promise(resolve => setTimeout(resolve, 1500));
	} catch {
		// not an Ollama server: nothing to unload
	}
}
/** Resident memory of every process of the runtime, in bytes: the server and the runners it starts. */
function runtimeRssBytes(): number | null {
	try {
		const lines = execFileSync('ps', ['-axo', 'rss=,comm='], { encoding: 'utf8' }).split('\n').filter(line => /\bollama\b/.test(line));
		return lines.length ? lines.reduce((sum, line) => sum + Number(line.trim().split(/\s+/)[0]) * 1024, 0) : null;
	} catch {
		return null;
	}
}
const PERFORMANCE_PROMPT = 'Write a TypeScript function that parses an ISO 8601 date string and returns the number of whole days between it and another such date. Explain each step in a comment.';
/** One name, from unloaded: a cold request, then a warm one that is timed and sampled for memory while it runs. */
async function measurePerformance(model: IDiscovered, wireModel: string): Promise<IPerformance> {
	await unload(wireModel);
	const transport: ITransport = new OnyxRuntimeProbeTransport(service, { baseUrl: model.baseUrl, model: wireModel }, `perf-${wireModel}`);
	const cold = await transport.send({ messages: [{ role: 'user', content: 'Reply with the single word: ready' }], temperature: 0, maxTokens: 8 }, CancellationToken.None);
	const idle = runtimeRssBytes();
	const bytes = await loadedBytes(wireModel);
	const reported = ((await service.listLoadedModels(baseUrl)) as readonly ILoaded[] | undefined)?.find(entry => entry.id === wireModel)?.contextLength ?? null;
	let peak = idle;
	const sampler = setInterval(() => { const now = runtimeRssBytes(); if (now !== null && (peak === null || now > peak)) { peak = now; } }, 250);
	let warm: IProbeReply;
	try {
		warm = await transport.send({ messages: [{ role: 'user', content: PERFORMANCE_PROMPT }], temperature: 0, maxTokens: 256 }, CancellationToken.None);
	} finally {
		clearInterval(sampler);
	}
	requestCount += 2;
	const generationMs = warm.firstTokenMs !== undefined ? warm.totalMs - warm.firstTokenMs : undefined;
	return {
		wireModel, reportedContextTokens: reported, loadedBytes: bytes, runtimeRssIdleBytes: idle, runtimeRssPeakBytes: peak,
		coldFirstTokenMs: cold.ending !== 'error' && cold.firstTokenMs !== undefined ? cold.firstTokenMs : null,
		warmFirstTokenMs: warm.ending !== 'error' && warm.firstTokenMs !== undefined ? warm.firstTokenMs : null,
		tokensPerSecond: warm.ending !== 'error' && warm.completionTokens && generationMs && generationMs > 0 ? Math.round(warm.completionTokens / (generationMs / 1000) * 10) / 10 : null,
	};
}
const mib = (bytes: number | null) => bytes === null ? 'unknown' : `${Math.round(bytes / 1024 ** 2)} MiB`;
const describePerformance = (label: string, p: IPerformance) => console.log(`  ${label}: context ${p.reportedContextTokens ?? 'unknown'}; loaded ${mib(p.loadedBytes)}; runtime resident ${mib(p.runtimeRssIdleBytes)} idle, ${mib(p.runtimeRssPeakBytes)} peak in a run; first token ${p.coldFirstTokenMs ?? '?'} ms cold, ${p.warmFirstTokenMs ?? '?'} ms warm; ${p.tokensPerSecond ?? '?'} tokens a second`);

try {
	const discovered: readonly IDiscovered[] = await service.listModels(baseUrl);
	fs.mkdirSync(path.join(outDir, 'traces'), { recursive: true });
	for (const id of models) {
		const found = discovered.find(candidate => candidate.id === id);
		const given = givenDigests.get(id);
		if (given !== undefined && !/^[0-9a-f]{64}$/.test(given)) {
			throw new Error(`--digest ${id}=…: a digest is the 64 hex characters of a SHA-256`);
		}
		const model = found && { ...found, digest: found.digest ?? (given ? `sha256:${given}` : undefined), runtimeVersion: found.runtimeVersion ?? givenRuntimeVersion };
		if (!model) {
			throw new Error(`the runtime at ${baseUrl} does not have ${id}. Nothing is downloaded by a measurement; it has: ${discovered.map(candidate => candidate.id).join(', ') || 'no models'}`);
		}
		if (!model.digest) {
			throw new Error(`the runtime reports no digest for ${id}; a published datasheet names the weights it measured`);
		}
		console.log(`\n${id}  ${model.digest.slice(0, 19)}  ${model.runtime} ${model.runtimeVersion ?? '(version unknown)'}`);

		// The model as the server allocates it, before anything is asked.
		const serverAllocation = await measurePerformance(model, id);
		describePerformance('server\'s allocation', serverAllocation);
		const previousTokens = serverAllocation.reportedContextTokens ?? model.serverContextLength;
		await unload(id);

		// B15: ask for the context, read it back, verify it. One model resident at a time.
		let wireModel = id;
		let context = { requestedTokens: null as number | null, reportedTokens: previousTokens ?? null, verifiedTokens: null as number | null, mechanism: null as string | null };
		let requestedPerformance: IPerformance | undefined;
		if (requestedContext !== undefined) {
			const target = contextTarget({ trainedTokens: model.contextLength, machineMemoryBytes: os.totalmem(), modelBytes: model.sizeBytes, settingTokens: requestedContext, currentTokens: previousTokens });
			if (target.tokens === undefined) {
				throw new Error(`nothing can be requested for ${id}: ${target.reason}. Trained context ${model.contextLength ?? 'unknown'}, memory ceiling ${target.memoryCeilingTokens ?? 'unknown'}, server allocation ${previousTokens ?? 'unknown'}`);
			}
			console.log(`  requesting ${target.tokens} tokens (bounded by the ${target.limitedBy}; trained ${model.contextLength}, memory ceiling ${target.memoryCeilingTokens}, asked ${requestedContext})`);
			const created: IAliasResult = await service.createContextAlias(baseUrl, id, target.tokens);
			if (!created.ok || !created.alias) {
				throw new Error(`the runtime did not create the alias: ${created.error}`);
			}
			const alias = created.alias;
			aliasesLeft.push(alias);
			const canaryTransport: ITransport = new OnyxRuntimeProbeTransport(service, { baseUrl: model.baseUrl, model: alias }, `canary-${id}`);
			const probe: { steps: readonly ICanaryStep[]; reportedTokens: number | undefined } = await runAllocationCanary((request: IProbeRequest) => canaryTransport.send(request, CancellationToken.None), {
				requestedTokens: target.tokens, previousTokens,
				readReportedTokens: async () => ((await service.listLoadedModels(baseUrl)) as readonly ILoaded[] | undefined)?.find(entry => entry.id === alias)?.contextLength,
			});
			requestCount += canaryTransport.log.length;
			const verdict: IVerdict = judgeAllocation({ requestedTokens: target.tokens, reportedTokens: probe.reportedTokens, previousTokens, steps: probe.steps });
			for (const step of probe.steps) {
				console.log(`    canary ${step.role}: sent about ${step.sentTokens} tokens, the runtime counted ${step.promptTokens ?? 'nothing'}, code ${step.recalled ? 'recalled' : 'lost'}`);
			}
			console.log(`  allocation: ${verdict.status}; requested ${target.tokens}, reported ${probe.reportedTokens ?? 'nothing'}, verified ${verdict.verifiedTokens ?? 'nothing'}; cut past the new allocation ${verdict.cutObserved ? 'seen' : 'not seen'}`);
			allocations[id] = { status: verdict.status, mechanism: 'derived-model', alias, previousTokens: previousTokens ?? null, requestedTokens: target.tokens, limitedBy: target.limitedBy, memoryCeilingTokens: target.memoryCeilingTokens ?? null, trainedTokens: model.contextLength ?? null, reportedTokens: probe.reportedTokens ?? null, verifiedTokens: verdict.verifiedTokens, cutObserved: verdict.cutObserved, steps: probe.steps, undo: removeAliasCommand(alias) };
			if (verdict.status === 'verified') {
				wireModel = alias;
				context = { requestedTokens: target.tokens, reportedTokens: probe.reportedTokens ?? null, verifiedTokens: verdict.verifiedTokens, mechanism: 'derived-model' };
				requestedPerformance = await measurePerformance(model, alias);
				describePerformance('requested context', requestedPerformance);
				await unload(alias);
			}
		}
		performance[id] = { serverAllocation, ...(requestedPerformance ? { requestedContext: requestedPerformance } : {}) };

		// The datasheet, of the model as requests would now reach it.
		const loaded = async (): Promise<ILoaded | undefined> => ((await service.listLoadedModels(baseUrl)) as readonly ILoaded[] | undefined)?.find(entry => entry.id === wireModel);
		const transport: ITransport = new OnyxRuntimeProbeTransport(service, { baseUrl: model.baseUrl, model: wireModel }, `measure-${id}`);
		const began = Date.now();
		const datasheet: IDatasheet = await runDatasheetProbes(transport, {
			model: model.id, digest: model.digest, runtime: model.runtime, runtimeVersion: model.runtimeVersion,
			serverContextTokens: context.reportedTokens ?? undefined,
			...(context.requestedTokens !== null ? { requestedContextTokens: context.requestedTokens, contextMechanism: 'derived-model' } : {}),
			loadedAtStart: false,
		}, CancellationToken.None, {
			onProgress: (probe: string, done: number, total: number) => console.log(`  ${done}/${total} ${probe}`),
			resolveServerContextTokens: async () => (await loaded())?.contextLength ?? context.reportedTokens ?? undefined,
		});
		console.log(`  measured in ${Math.round((Date.now() - began) / 1000)} s, ${transport.log.length} requests`);
		const lines: string[] = describeDatasheet(datasheet);
		for (const line of lines) {
			console.log(`  ${line}`);
		}
		datasheets[id] = datasheet;
		descriptions[id] = lines;
		// The manifest names the context of the measurement as the datasheet's own probe found it.
		manifestModels.push({
			identifier: `${model.runtime}:${model.id}`, digest: model.digest, runtime: { name: model.runtime, ...(model.runtimeVersion ? { version: model.runtimeVersion } : {}) },
			context: { requestedTokens: datasheet.context.requestedTokens, reportedTokens: datasheet.context.serverReportedTokens, verifiedTokens: datasheet.context.verifiedTokens, mechanism: datasheet.context.mechanism },
		});
		requestCount += transport.log.length;
		await unload(wireModel);

		// Each request in outline (a prompt is fixed text; a long one is given by its length and digest) and each reply as it came.
		const outline = transport.log.map(({ request, reply }) => JSON.stringify({
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
	// What the measurement created on the runtime is taken away again, unless it was asked to stay.
	if (!keepAlias) {
		for (const alias of aliasesLeft.splice(0)) {
			const removed: IAliasResult = await service.removeContextAlias(baseUrl, alias);
			console.log(removed.ok ? `removed the alias ${alias}` : `COULD NOT REMOVE ${alias}: ${removed.error}. Remove it with: ${removeAliasCommand(alias)}`);
		}
	}
	service.dispose();
}
for (const alias of aliasesLeft) {
	console.log(`left on the runtime: ${alias}. Remove it with: ${removeAliasCommand(alias)}`);
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
	taskSet: { name: 'datasheet probe suite, version 2 (the digest is of onyxDatasheetProbes.ts)', hash: traceDigest(suiteSource), count: requestCount },
	repetitions: 1,
	machine: { platform: process.platform, arch: process.arch, cpu, memoryGiB: Math.round(os.totalmem() / 1024 ** 3), osVersion, nodeVersion: process.version.replace(/^v/, '') },
	regenerate: [{
		output: 'summary.json',
		command: `node test/onyx/lab/measure-models.mts --base-url <the runtime's base URL> ${models.map(id => `--model ${id}`).join(' ')}${requestedContext !== undefined ? ` --context ${requestedContext}` : ''} --out docs/research/results/${name}`,
	}],
	notes: 'Model datasheets (L5). Sampling differs by probe and is in each trace line: 0.2 for most, 0 for the context probe, 1 with a seed for the repeatability probe. The probes do not go through the agent loop, so no harness configuration applies. A run talks to a runtime on the machine it runs on and to nothing else.' + (requestedContext !== undefined ? ` Context (B15): ${requestedContext} tokens were asked for through a derived model (an alias over the same weights); summary.json has what was requested, reported and verified for each model, the canary steps, and memory and speed at the server's allocation and at the requested context. The alias was ${keepAlias ? 'left on the runtime' : 'removed after the measurement'}.` : ''),
};
const validation = validateManifest(manifest);
if (!validation.ok) {
	console.error(`measure-models: the manifest it would write is invalid:\n  ${validation.errors.join('\n  ')}`);
	process.exit(1);
}
fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, undefined, '\t') + '\n');
fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify({ datasheets, descriptions, allocations, performance }, undefined, '\t') + '\n');
console.log(`\nwrote ${path.relative(repoRoot, path.resolve(outDir))}: manifest.json, summary.json, traces/ (${models.length} model${models.length === 1 ? '' : 's'}, ${requestCount} requests)`);
