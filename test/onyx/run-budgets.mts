/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Measured budgets of the packaged application on this machine (D8).
 *
 *   node test/onyx/run-budgets.mts --app <path/to/Onyx.app> --runtime http://127.0.0.1:11500 --json-out <file> [--allow-busy]
 *
 * Measurements, not promises, and of one machine:
 *   models      for each pinned model, straight at the runtime: time to the first token cold (the
 *               model not loaded) and warm, and tokens a second, over three warm rounds
 *   cold start  five launches on a fresh profile each: time from starting the process to a workbench
 *               with an editor area in the DOM
 *   idle        one window, first-run dialog stepped through, left for a minute, then two minutes of
 *               samples: CPU and resident memory of all the application's processes
 *   a run       one agent request against the real runtime: peak memory of the application and of
 *               the runtime's model process, and what the run ended as
 *
 * It refuses to measure on battery, or with a one-minute load average above 4 unless `--allow-busy`
 * is given (and then records that it was busy): a number taken on a loaded machine is not the
 * machine's number. It starts no runtime and pulls no model: both must be there.
 */

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function argValue(flag: string): string | undefined {
	const index = process.argv.indexOf(flag);
	return index === -1 ? undefined : process.argv[index + 1];
}

const appArg = argValue('--app') ?? process.env.ONYX_PACKAGED_APP;
const runtime = argValue('--runtime')?.replace(/\/$/, '');
const jsonOut = argValue('--json-out');
const allowBusy = process.argv.includes('--allow-busy');
if (!appArg || !fs.existsSync(appArg) || !runtime || !jsonOut) {
	console.error('usage: node test/onyx/run-budgets.mts --app <path/to/Onyx.app> --runtime http://127.0.0.1:11500 --json-out <file> [--allow-busy]');
	process.exit(2);
}

const MODELS = ['qwen2.5-coder:7b', 'qwen2.5-coder:1.5b'];
const PROMPT = 'Write a TypeScript function that returns the median of an array of numbers. Reply with the code only.';
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const app = fs.realpathSync(path.resolve(appArg));
const executable = path.join(app, 'Contents', 'MacOS', fs.readdirSync(path.join(app, 'Contents', 'MacOS'))[0]);
const cdpPort = Number(process.env.ONYX_CDP_PORT ?? 9336);
const session = `bd-${process.pid}`;
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'onyx-budgets-'));

function sleep(ms: number) {
	return new Promise(resolve => setTimeout(resolve, ms));
}

function median(values: number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
}

function round(value: number, digits = 1): number {
	return Math.round(value * 10 ** digits) / 10 ** digits;
}

// --- the machine's condition ---------------------------------------------------------------------------------

function condition() {
	const battery = spawnSync('pmset', ['-g', 'batt'], { encoding: 'utf8' }).stdout;
	const adapter = spawnSync('pmset', ['-g', 'ac'], { encoding: 'utf8' }).stdout;
	return {
		onMains: /AC Power/.test(battery),
		adapterWatts: Number(/Wattage = (?<watts>\d+)W/.exec(adapter)?.groups?.watts ?? 0),
		batteryPercent: Number(/(?<percent>\d+)%/.exec(battery)?.groups?.percent ?? 0),
		loadAverage: os.loadavg().map(value => round(value, 2)),
		swap: spawnSync('sysctl', ['-n', 'vm.swapusage'], { encoding: 'utf8' }).stdout.trim(),
	};
}

// --- processes ---------------------------------------------------------------------------------------------

interface IProcess { readonly pid: number; readonly cpu: number; readonly rssKb: number; readonly command: string }

function processes(filter: (command: string) => boolean): IProcess[] {
	const listing = spawnSync('ps', ['-Ao', 'pid=,pcpu=,rss=,command='], { encoding: 'utf8' }).stdout ?? '';
	const found: IProcess[] = [];
	for (const line of listing.split('\n')) {
		const groups = /^\s*(?<pid>\d+)\s+(?<cpu>[\d.]+)\s+(?<rss>\d+)\s+(?<command>.*)$/.exec(line)?.groups;
		if (groups && filter(groups.command)) {
			found.push({ pid: Number(groups.pid), cpu: Number(groups.cpu), rssKb: Number(groups.rss), command: groups.command });
		}
	}
	return found;
}

const megabytes = (kilobytes: number) => Math.round(kilobytes / 1024);
const ofApplication = (profile: string) => (command: string) => command.includes(`${app}/`) && command.includes(profile);

// --- the runtime ---------------------------------------------------------------------------------------------

interface IGeneration { readonly firstTokenMs: number; readonly tokensPerSecond: number; readonly tokens: number; readonly loadMs: number }

async function generate(model: string): Promise<IGeneration> {
	const started = performance.now();
	const response = await fetch(`${runtime}/api/generate`, { method: 'POST', body: JSON.stringify({ model, prompt: PROMPT, stream: true, options: { temperature: 0, seed: 1, num_predict: 160 } }) });
	if (!response.ok || !response.body) {
		throw new Error(`${model}: the runtime answered ${response.status}`);
	}
	let firstTokenMs = 0;
	let last: { eval_count?: number; eval_duration?: number; load_duration?: number } = {};
	let buffered = '';
	const decoder = new TextDecoder();
	for await (const chunk of response.body) {
		buffered += decoder.decode(chunk as Uint8Array, { stream: true });
		const lines = buffered.split('\n');
		buffered = lines.pop() ?? '';
		for (const line of lines.filter(Boolean)) {
			const event = JSON.parse(line) as { response?: string; done?: boolean; eval_count?: number; eval_duration?: number; load_duration?: number };
			if (!firstTokenMs && event.response) {
				firstTokenMs = performance.now() - started;
			}
			if (event.done) {
				last = event;
			}
		}
	}
	return { firstTokenMs: Math.round(firstTokenMs), tokens: last.eval_count ?? 0, tokensPerSecond: round((last.eval_count ?? 0) / ((last.eval_duration ?? 1) / 1e9)), loadMs: Math.round((last.load_duration ?? 0) / 1e6) };
}

async function unload(model: string) {
	await fetch(`${runtime}/api/generate`, { method: 'POST', body: JSON.stringify({ model, keep_alive: 0 }) }).then(response => response.text(), () => undefined);
	await sleep(3000);
}

// --- the application ---------------------------------------------------------------------------------------

/** Evaluates an expression in the workbench window over the debugging protocol. `undefined` while there is no window. */
async function evaluate(expression: string): Promise<unknown> {
	let pages: { type: string; url: string; webSocketDebuggerUrl: string }[];
	try {
		pages = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json() as typeof pages;
	} catch {
		return undefined;
	}
	const page = pages.find(entry => entry.type === 'page' && entry.url.includes('workbench'));
	if (!page) {
		return undefined;
	}
	return new Promise(resolve => {
		const socket = new WebSocket(page.webSocketDebuggerUrl);
		const timer = setTimeout(() => { socket.close(); resolve(undefined); }, 3000);
		socket.onopen = () => socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
		socket.onmessage = message => {
			clearTimeout(timer);
			socket.close();
			resolve((JSON.parse(String(message.data)) as { result?: { result?: { value?: unknown } } }).result?.result?.value);
		};
		socket.onerror = () => { clearTimeout(timer); resolve(undefined); };
	});
}

function launch(profile: string, extra: string[] = []) {
	const workspace = path.join(profile, 'ws');
	fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
	fs.mkdirSync(path.join(profile, 'user-data', 'User'), { recursive: true });
	fs.writeFileSync(path.join(workspace, 'src', 'math.ts'), 'export function addNumbers(a: number, b: number): number {\n\treturn a + b;\n}\n');
	// The runtime under measurement is a private one on its own port, so the profile names it.
	fs.writeFileSync(path.join(profile, 'user-data', 'User', 'settings.json'), JSON.stringify({ 'onyx.endpoints': [{ baseUrl: `${runtime}/v1` }] }, undefined, '\t'));
	const child = spawn(executable, [`--user-data-dir=${path.join(profile, 'user-data')}`, `--extensions-dir=${path.join(profile, 'extensions')}`, `--remote-debugging-port=${cdpPort}`, '--use-mock-keychain', '--disable-workspace-trust', '--skip-release-notes', ...extra, workspace, path.join(workspace, 'src', 'math.ts')], { cwd: profile, stdio: 'ignore', detached: true });
	return { child, startedAt: performance.now(), workspace };
}

async function quit(pid: number | undefined) {
	for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
		try {
			process.kill(-pid!, signal);
		} catch {
			// already gone
		}
		await sleep(2500);
	}
}

async function main(): Promise<number> {
	const before = condition();
	const product = JSON.parse(fs.readFileSync(path.join(app, 'Contents', 'Resources', 'app', 'product.json'), 'utf8')) as { nameShort?: string; commit?: string };
	console.log(`budgets · ${product.nameShort} ${product.commit?.slice(0, 11)} · mains ${before.onMains} at ${before.adapterWatts} W · load ${before.loadAverage.join(' ')}`);
	if (!before.onMains) {
		throw new Error('on battery: a laptop on battery runs models slower. Connect the charger.');
	}
	const busy = before.loadAverage[0] > 4;
	if (busy && !allowBusy) {
		throw new Error(`the one-minute load average is ${before.loadAverage[0]}: wait for a quiet machine, or pass --allow-busy and have the result say it was busy`);
	}
	const version = await fetch(`${runtime}/api/version`).then(response => response.json() as Promise<{ version: string }>, () => undefined);
	if (!version) {
		throw new Error(`no runtime answers at ${runtime}. Start one (for example OLLAMA_HOST=127.0.0.1:11500 ollama serve); this script starts none.`);
	}
	const installed = (await (await fetch(`${runtime}/api/tags`)).json() as { models: { name: string; digest: string }[] }).models;

	// 1. The models, at the runtime.
	const models: Record<string, object> = {};
	for (const model of MODELS) {
		const digest = installed.find(entry => entry.name === model)?.digest;
		if (!digest) {
			throw new Error(`${model} is not installed on the runtime; this script pulls nothing`);
		}
		await unload(model);
		const cold = await generate(model);
		const warm = [await generate(model), await generate(model), await generate(model)];
		const residentMb = megabytes(Math.max(0, ...processes(command => /ollama.*(?:runner|llama-server)|ollama_llama_server/.test(command)).map(entry => entry.rssKb)));
		models[model] = {
			digest,
			coldFirstTokenMs: cold.firstTokenMs,
			coldLoadMs: cold.loadMs,
			warmFirstTokenMs: { median: median(warm.map(round => round.firstTokenMs)), best: Math.min(...warm.map(round => round.firstTokenMs)), rounds: warm.map(round => round.firstTokenMs) },
			tokensPerSecond: { median: median(warm.map(round => round.tokensPerSecond)), best: Math.max(...warm.map(round => round.tokensPerSecond)), rounds: warm.map(round => round.tokensPerSecond) },
			tokensGenerated: warm.map(round => round.tokens),
			runtimeModelProcessMb: residentMb,
		};
		console.log(`  ${model}: first token ${cold.firstTokenMs} ms cold, ${median(warm.map(round => round.firstTokenMs))} ms warm; ${median(warm.map(round => round.tokensPerSecond))} tokens a second; model process ${residentMb} MB`);
		await unload(model);
	}

	// 2. Cold start, five times, each on a profile that has never been used.
	const starts: number[] = [];
	for (let index = 0; index < 5; index++) {
		const profile = path.join(scratch, `start-${index}`);
		const { child, startedAt } = launch(profile);
		let usable = 0;
		while (!usable && performance.now() - startedAt < 120_000) {
			if (await evaluate('!!document.querySelector(".monaco-workbench .part.editor")') === true) {
				usable = performance.now() - startedAt;
			} else {
				await sleep(100);
			}
		}
		starts.push(Math.round(usable));
		await quit(child.pid);
		fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
	}
	console.log(`  start to a workbench with an editor area: ${starts.join(', ')} ms (median ${median(starts)})`);

	// 3. Idle, then 4. one agent request, in one window.
	const profile = path.join(scratch, 'window');
	const { child } = launch(profile);
	const mine = ofApplication(profile);
	let idle: object = {};
	let run: object = {};
	try {
		while (await evaluate('!!document.querySelector(".monaco-workbench .part.editor")') !== true) {
			await sleep(500);
		}
		await sleep(8000);
		for (let step = 0; step < 6; step++) {
			await evaluate('document.querySelector(".onboarding-a-overlay.visible button.onboarding-a-btn-primary")?.click()');
			await sleep(1200);
		}
		await sleep(60_000);
		const samples: { cpu: number; totalMb: number; rendererMb: number }[] = [];
		for (let index = 0; index < 24; index++) {
			const own = processes(mine);
			samples.push({ cpu: round(own.reduce((sum, entry) => sum + entry.cpu, 0)), totalMb: megabytes(own.reduce((sum, entry) => sum + entry.rssKb, 0)), rendererMb: megabytes(Math.max(0, ...own.filter(entry => entry.command.includes('--type=renderer')).map(entry => entry.rssKb))) });
			await sleep(5000);
		}
		idle = {
			seconds: 120,
			cpuPercentOfOneCore: { mean: round(samples.reduce((sum, sample) => sum + sample.cpu, 0) / samples.length), max: Math.max(...samples.map(sample => sample.cpu)) },
			allProcessesMb: { median: median(samples.map(sample => sample.totalMb)), max: Math.max(...samples.map(sample => sample.totalMb)) },
			rendererMb: { median: median(samples.map(sample => sample.rendererMb)), max: Math.max(...samples.map(sample => sample.rendererMb)) },
			processes: processes(mine).length,
		};
		console.log(`  idle: ${JSON.stringify(idle)}`);

		// One agent request against the real runtime. What the model does with it is recorded, not required.
		const playwrightCli = createRequire(import.meta.url).resolve('@playwright/cli/playwright-cli.js');
		const pw = (...args: string[]) => execFileSync(process.execPath, [playwrightCli, `-s=${session}`, ...args], { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
		pw('attach', `--cdp=http://127.0.0.1:${cdpPort}`);
		pw('run-code', `--filename=${path.join(repoRoot, '.agents', 'skills', 'launch', 'playwrightScripts', 'focus-chat-input.ts')}`);
		execFileSync(path.join(repoRoot, '.agents', 'skills', 'launch', 'scripts', 'monaco-paste.sh'), ['--session', session, 'Read src/math.ts and add a multiplyNumbers function next to addNumbers.'], { cwd: repoRoot, encoding: 'utf8' });
		pw('press', 'Enter');
		const baselineMb = megabytes(processes(mine).reduce((sum, entry) => sum + entry.rssKb, 0));
		const began = performance.now();
		let peakTotalKb = 0;
		let peakRendererKb = 0;
		let peakModelKb = 0;
		const journalIndex = () => {
			const storage = path.join(profile, 'user-data', 'User', 'workspaceStorage');
			for (const id of fs.existsSync(storage) ? fs.readdirSync(storage) : []) {
				const file = path.join(storage, id, 'onyx', 'journal', 'index.json');
				if (fs.existsSync(file)) {
					return JSON.parse(fs.readFileSync(file, 'utf8')) as { status: string }[] | { runs: { status: string }[] };
				}
			}
			return undefined;
		};
		let status = 'no run journalled';
		while (performance.now() - began < 180_000) {
			const own = processes(mine);
			peakTotalKb = Math.max(peakTotalKb, own.reduce((sum, entry) => sum + entry.rssKb, 0));
			peakRendererKb = Math.max(peakRendererKb, ...own.filter(entry => entry.command.includes('--type=renderer')).map(entry => entry.rssKb));
			peakModelKb = Math.max(peakModelKb, ...processes(command => /ollama.*(?:runner|llama-server)|ollama_llama_server/.test(command)).map(entry => entry.rssKb));
			const index = journalIndex();
			const runs = Array.isArray(index) ? index : index?.runs ?? [];
			if (runs.length) {
				status = runs[runs.length - 1].status;
				if (status !== 'running') {
					break;
				}
			}
			await sleep(1000);
		}
		const staged = await evaluate('document.querySelectorAll(".onyx-change-file-path").length');
		// The model the router chose for the run, from the run's own journal.
		const storage = path.join(profile, 'user-data', 'User', 'workspaceStorage');
		let model = 'unknown';
		for (const id of fs.existsSync(storage) ? fs.readdirSync(storage) : []) {
			const runs = path.join(storage, id, 'onyx', 'journal', 'runs');
			for (const file of fs.existsSync(runs) ? fs.readdirSync(runs) : []) {
				model = /"model(?:Key|Id)?"\s*:\s*"(?<model>[^"]+)"/.exec(fs.readFileSync(path.join(runs, file), 'utf8'))?.groups?.model ?? model;
			}
		}
		run = { prompt: 'Read src/math.ts and add a multiplyNumbers function next to addNumbers.', model, applicationMbBefore: baselineMb, seconds: Math.round((performance.now() - began) / 1000), endedAs: status, filesWithAProposal: staged ?? 'unknown', applicationPeakMb: megabytes(peakTotalKb), rendererPeakMb: megabytes(peakRendererKb), runtimeModelProcessPeakMb: megabytes(peakModelKb) };
		console.log(`  a run: ${JSON.stringify(run)}`);
		try {
			pw('close');
		} catch {
			// nothing to close
		}
	} finally {
		await quit(child.pid);
		for (const model of MODELS) {
			await unload(model);
		}
	}

	const after = condition();
	fs.writeFileSync(path.resolve(jsonOut!), JSON.stringify({
		ranAt: new Date().toISOString(),
		product: { nameShort: product.nameShort, commit: product.commit },
		machine: { model: spawnSync('sysctl', ['-n', 'hw.model'], { encoding: 'utf8' }).stdout.trim(), chip: spawnSync('sysctl', ['-n', 'machdep.cpu.brand_string'], { encoding: 'utf8' }).stdout.trim(), memoryGb: Math.round(os.totalmem() / 2 ** 30), macOS: spawnSync('sw_vers', ['-productVersion'], { encoding: 'utf8' }).stdout.trim() },
		runtime: { address: 'a private Ollama on a loopback port', version: version.version },
		conditions: { before, after, busy, otherApplicationsOpen: 'yes: the owner\'s applications were not closed; the load average above is what they cost' },
		models,
		coldStartMs: { runs: starts, median: median(starts), min: Math.min(...starts), max: Math.max(...starts), note: 'each on a fresh profile; the application\'s files were already in the disk cache, so this is not a start after a reboot' },
		idle,
		agentRun: run,
		passed: !busy,
	}, undefined, '\t'));
	console.log(busy ? 'budgets: measured on a BUSY machine; not a valid budget' : 'budgets: measured');
	return busy ? 1 : 0;
}

main().then(code => {
	fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
	process.exit(code);
}, error => {
	console.error(`budgets: ${error instanceof Error ? error.message : error}`);
	fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
	process.exit(1);
});
