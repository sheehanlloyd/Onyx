/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The campaign launcher (L9). It runs an experiment manifest as a campaign:
 *
 *   node test/onyx/lab/run-lab.mts docs/research/results/<date>-<name>/manifest.json [--repo <path>] [--rescore]
 *
 * Tier S gives each model one request a task, from plain Node, as
 * `run-benchmarks.mts` does. Tier A starts an isolated instance of the
 * application on a disposable git worktree and lets the engine inside it
 * (`browser/lab/onyxLabCampaign.ts`) run the real agent loop; the work
 * order reaches it through an environment variable.
 *
 * What it writes, beside the manifest:
 *   traces/records.jsonl   one line a finished unit: what the model answered or the run did, unscored
 *   results.jsonl          every record scored against its task (recomputed from the records every time)
 *   summary.json           counts and means by model and configuration
 *   campaign.json          the estimate, the time it took, the machine's load and power, the evictions,
 *                          and the state of the repository before and after
 *
 * Rules it keeps (DEC-10, L9):
 * - it talks only to a runtime on this machine, and downloads nothing;
 * - one model is resident at a time: everything is evicted before a model's first unit;
 * - a unit the runtime could not serve is recorded as that, not as a score of zero;
 * - it resumes: a unit with a record is not run again, and a killed campaign continues at the next one;
 * - Ctrl+C stops it: the unit in flight is cancelled and leaves no record;
 * - the repository it reads tasks from is not touched: its files, index, branches and HEAD are compared
 *   before and after, and tier A works in a linked worktree in the temporary directory, removed at the end.
 *   The comparison cannot tell a campaign's change from anyone else's: to work in a repository while a
 *   campaign reads from it, give the campaign a clone of its own (`git clone --local --bare`, `--repo`).
 *
 * `--rescore` runs nothing: it recomputes results.jsonl and summary.json from the records.
 * Exit codes: 0 complete, 1 failed, 2 usage, 3 stopped before the end, 4 the repository changed, 130 cancelled.
 */

import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadManifest, type IManifest } from './manifest.mts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
/**
 * Where the application of a tier A campaign is started from: this checkout, or a frozen copy of its compiled
 * output (`freeze-app.mts`, `ONYX_LAB_APP_ROOT`), so that a checkout that is edited and rebuilt while a campaign
 * runs does not change the harness between two of its units.
 */
const appRoot = process.env.ONYX_LAB_APP_ROOT ? path.resolve(process.env.ONYX_LAB_APP_ROOT) : repoRoot;
function applicationProvenance(): { readonly root: string; readonly revision: string | null; readonly dirtyEntries: number | null; readonly frozenAt: string | null } {
	try {
		const frozen: { revision: string; dirtyEntries: number; frozenAt: string } = JSON.parse(fs.readFileSync(path.join(appRoot, 'FROZEN.json'), 'utf8'));
		return { root: 'a frozen copy of the compiled output', revision: frozen.revision, dirtyEntries: frozen.dirtyEntries, frozenAt: frozen.frozenAt };
	} catch {
		return { root: 'the checkout itself', revision: null, dirtyEntries: null, frozenAt: null };
	}
}
const out = (relative: string) => pathToFileURL(path.join(repoRoot, 'out', relative)).href;

interface ILabTask { readonly id: string; readonly commit: string; readonly file: string }
interface ILabUnit { readonly id: string; readonly model: string; readonly configuration: string; readonly task: ILabTask; readonly seed: number; readonly repetition: number }
interface ILabRecord { readonly unit: string; readonly model: string; readonly configuration: string; readonly task: string; readonly seed: number; readonly repetition: number; readonly tier: 'S' | 'A'; readonly outcome: string; readonly reply: string | null; readonly edits: readonly unknown[]; readonly events: readonly unknown[]; readonly requests: readonly unknown[]; readonly harnessHash: string | null; readonly deniedCommands: number; readonly durationMs: number; readonly finishReason?: string | null; readonly error?: string }
interface ILabResult { readonly unit: string; readonly outcome: string; readonly score: number | null; readonly success: boolean | null }
interface ICampaign { readonly tier: 'S' | 'A'; readonly baseUrl: string; readonly datasheetsFirst?: boolean; readonly tasks?: string; readonly unitTimeoutMs?: number; readonly maxBeforeChars?: number; readonly datasheets?: string; readonly measure?: { readonly revision: string; readonly taskCount?: number; readonly datasheets?: boolean } }
interface ILabModule {
	planLabCampaign(spec: { tier: 'S' | 'A'; models: readonly string[]; configurations: readonly string[]; tasks: readonly ILabTask[]; seeds: readonly number[]; repetitions: number }): ILabUnit[];
	remainingLabUnits(plan: readonly ILabUnit[], finished: ReadonlySet<string>): ILabUnit[];
	parseLabRecords(text: string): ILabRecord[];
	scoreLabRecord(record: ILabRecord, before: string, after: string): ILabResult;
	summarizeLabResults(results: readonly ILabResult[]): unknown[];
	estimateLabDuration(plan: readonly ILabUnit[], speeds: Record<string, { tokensPerSecond: number } | undefined>, shape: unknown): { seconds: number | null; unmeasuredModels: readonly string[]; units: number };
	describeLabEstimate(estimate: { seconds: number | null; unmeasuredModels: readonly string[]; units: number }): string;
	labAgentInstruction(file: string, subject: string): string;
	ONYX_LAB_SHAPE: Record<'S' | 'A', unknown>;
}
interface IBenchModule { buildBenchPrompt(task: { file: string; subject: string }, before: string): string; ONYX_BENCH_SYSTEM_PROMPT: string }

function flag(name: string): string | undefined {
	const index = process.argv.indexOf(name);
	return index === -1 ? undefined : process.argv[index + 1];
}

const manifestArg = process.argv[2];
if (!manifestArg || manifestArg.startsWith('--')) {
	console.error('usage: node test/onyx/lab/run-lab.mts <manifest.json> [--repo <path>] [--rescore]');
	process.exit(2);
}
const manifestPath = path.resolve(manifestArg);
const outDir = path.dirname(manifestPath);
const repo = path.resolve(flag('--repo') ?? repoRoot);
const rescoreOnly = process.argv.includes('--rescore');

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const sha256 = (data: string | Buffer) => crypto.createHash('sha256').update(data).digest('hex');
function git(cwd: string, args: readonly string[], maxBuffer = 64 * 1024 * 1024): string {
	return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', maxBuffer, env: { ...process.env, GIT_LFS_SKIP_SMUDGE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
}
function gitShow(revision: string, file: string): string | undefined {
	try {
		return git(repo, ['show', `${revision}:${file}`]);
	} catch {
		return undefined;
	}
}

/**
 * The state of the repository a campaign reads from: what `git status` says
 * outside the campaign's own results directory, the index file, HEAD and
 * every ref. A campaign that leaves any of these different has broken its
 * rule, and says so.
 */
function repositoryState(): { readonly status: string; readonly index: string; readonly head: string; readonly refs: string } {
	const relativeOut = path.relative(repo, outDir);
	const inside = relativeOut && !relativeOut.startsWith('..') && !path.isAbsolute(relativeOut);
	// A bare repository has no working tree to have a status: its objects, HEAD and refs are what there is.
	const bare = git(repo, ['rev-parse', '--is-bare-repository']).trim() === 'true';
	const status = bare ? 'bare' : git(repo, ['status', '--porcelain=v1', '-z', '--', '.', ...(inside ? [`:(exclude)${relativeOut}`] : [])]);
	const gitDir = git(repo, ['rev-parse', '--absolute-git-dir']).trim();
	const indexPath = path.join(gitDir, 'index');
	return {
		status: sha256(status),
		index: fs.existsSync(indexPath) ? sha256(fs.readFileSync(indexPath)) : 'absent',
		head: git(repo, ['rev-parse', 'HEAD']).trim(),
		refs: sha256(git(repo, ['for-each-ref'])),
	};
}

/** What the machine says about itself now: a campaign's numbers are read with these beside them. */
function conditions(): { readonly at: string; readonly loadAverage: readonly number[]; readonly power: string | null } {
	let power: string | null = null;
	if (process.platform === 'darwin') {
		try {
			const battery = execFileSync('pmset', ['-g', 'batt'], { encoding: 'utf8' });
			const adapter = execFileSync('pmset', ['-g', 'ac'], { encoding: 'utf8' });
			power = `${/'(?<source>[^']+)'/.exec(battery)?.groups?.source ?? 'unknown source'}, ${/(?<percent>\d+)%/.exec(battery)?.groups?.percent ?? '?'}%, adapter ${/Wattage = (?<watts>\d+)W/.exec(adapter)?.groups?.watts ?? 'none'} W`;
		} catch {
			power = null;
		}
	}
	return { at: new Date().toISOString(), loadAverage: os.loadavg().map(value => Math.round(value * 100) / 100), power };
}

const manifest: IManifest & { campaign?: ICampaign } = loadManifest(manifestPath);
const campaign = manifest.campaign;
if (!campaign) {
	console.error(`run-lab: ${path.relative(process.cwd(), manifestPath)} has no "campaign" section; it describes results, not a campaign to run`);
	process.exit(2);
}
if (path.basename(outDir) !== manifest.name) {
	console.error(`run-lab: the manifest's directory is ${path.basename(outDir)} and its name is ${manifest.name}; they have to be the same`);
	process.exit(2);
}
if (!campaign.measure && !campaign.tasks) {
	console.error('run-lab: the campaign names no task set');
	process.exit(2);
}
if (campaign.measure && (campaign.tier !== 'A' || !/^[0-9a-f]{7,40}$/.test(campaign.measure.revision))) {
	console.error('run-lab: a measurement runs the command in the application (tier A), on a worktree at a commit named by its hash');
	process.exit(2);
}
// A measurement has no task set of its own: the command selects its tasks, by the product's rule, when it runs.
const tasksFile: { readonly tasks: readonly ILabTask[] } = campaign.tasks ? JSON.parse(fs.readFileSync(path.resolve(outDir, campaign.tasks), 'utf8')) : { tasks: [] };
const wireModels = manifest.models.map(model => (model as { wireModel?: string }).wireModel ?? model.identifier.replace(/^[a-z]+:/, ''));
const root = campaign.baseUrl.replace(/\/v1$/, '');

const lab: ILabModule = await import(out('vs/workbench/contrib/onyx/common/onyxLab.js'));
const bench: IBenchModule = await import(out('vs/workbench/contrib/onyx/common/onyxRepoBench.js'));
const tasks: { taskInstruction(message: string): string } = await import(out('vs/workbench/contrib/onyx/common/onyxLabTasks.js'));

const recordsPath = path.join(outDir, 'traces', 'records.jsonl');
const campaignPath = path.join(outDir, 'campaign.json');
fs.mkdirSync(path.dirname(recordsPath), { recursive: true });
const readRecords = (): ILabRecord[] => fs.existsSync(recordsPath) ? lab.parseLabRecords(fs.readFileSync(recordsPath, 'utf8')) : [];
/** A record is one whole line. A line cut off by a kill is ended here, so that the next record starts on its own line. */
function appendRecord(record: ILabRecord): void {
	const existing = fs.existsSync(recordsPath) ? fs.readFileSync(recordsPath, 'utf8') : '';
	fs.appendFileSync(recordsPath, `${existing && !existing.endsWith('\n') ? '\n' : ''}${JSON.stringify(record)}\n`);
}

/** What a measurement's scorecard says was planned and whether it ran whole; set when its results are read. */
let measured: { readonly planned: number; readonly complete: boolean } | undefined;
const plan = lab.planLabCampaign({ tier: campaign.tier, models: wireModels, configurations: manifest.harnessConfigurations.map(entry => entry.name), tasks: tasksFile.tasks, seeds: manifest.seeds, repetitions: manifest.repetitions });
const instructions = new Map<string, string>();
/** A task's instruction: the commit's message without its trailers (L10). Read from the repository, never committed. */
const instructionOf = (task: ILabTask): string => {
	let instruction = instructions.get(task.commit);
	if (instruction === undefined) {
		instruction = tasks.taskInstruction(git(repo, ['log', '-1', '--format=%B', task.commit]));
		instructions.set(task.commit, instruction);
	}
	return instruction;
};

/** Scores every record against its task and writes results.jsonl and summary.json. Everything in them comes from the records and the repository. */
function writeResults(): { readonly results: ILabResult[]; readonly unscorable: number } {
	if (campaign!.measure) {
		// The command scored its own attempts; its scorecard is the record, and these two files are read out of it.
		const cardPath = path.join(outDir, 'scorecard.json');
		const card: { partial: boolean; plannedUnits: number; attempts: ILabResult[]; skips: unknown[]; tasks: object; heldOutAfter: string | null; ranking: object; estimateSeconds: number | null; tookSeconds: number } | undefined = fs.existsSync(cardPath) ? JSON.parse(fs.readFileSync(cardPath, 'utf8')) : undefined;
		const attempts = card?.attempts ?? [];
		fs.writeFileSync(path.join(outDir, 'results.jsonl'), attempts.map(attempt => JSON.stringify(attempt)).join('\n') + (attempts.length ? '\n' : ''));
		fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify({
			campaign: manifest.name, command: 'Onyx: Measure Models for This Repository', plannedUnits: card?.plannedUnits ?? 0, finishedUnits: attempts.length, complete: !!card && !card.partial,
			tasks: card?.tasks ?? null, heldOutAfter: card?.heldOutAfter ?? null, ranking: card?.ranking ?? null, estimateSeconds: card?.estimateSeconds ?? null, tookSeconds: card?.tookSeconds ?? null,
			rows: lab.summarizeLabResults(attempts),
		}, undefined, '\t') + '\n');
		fs.writeFileSync(path.join(outDir, 'trace-digests.json'), JSON.stringify(Object.fromEntries(attempts.map(attempt => [attempt.unit, sha256(JSON.stringify(attempt))])), undefined, '\t') + '\n');
		measured = card ? { planned: card.plannedUnits, complete: !card.partial } : undefined;
		return { results: attempts, unscorable: 0 };
	}
	const results: ILabResult[] = [];
	let unscorable = 0;
	const byId = new Map(tasksFile.tasks.map(task => [task.id, task]));
	for (const record of readRecords()) {
		const task = byId.get(record.task);
		const before = task && gitShow(`${task.commit}~1`, task.file);
		const after = task && gitShow(task.commit, task.file);
		if (before === undefined || after === undefined) {
			unscorable++;
			continue;
		}
		results.push(lab.scoreLabRecord(record, before, after));
	}
	fs.writeFileSync(path.join(outDir, 'results.jsonl'), results.map(result => JSON.stringify(result)).join('\n') + (results.length ? '\n' : ''));
	fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify({
		campaign: manifest.name, tier: campaign!.tier, plannedUnits: plan.length, finishedUnits: results.length, complete: results.length === plan.length,
		recordsWhoseTaskIsNotInTheRepository: unscorable, rows: lab.summarizeLabResults(results),
	}, undefined, '\t') + '\n');
	return { results, unscorable };
}

if (rescoreOnly) {
	const { results } = writeResults();
	console.log(`rescored ${results.length} record${results.length === 1 ? '' : 's'} of ${plan.length} planned units`);
	process.exit(0);
}

if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(campaign.baseUrl).hostname)) {
	console.error('run-lab: a campaign talks only to a runtime on this machine (DEC-10)');
	process.exit(2);
}

// --- one model resident at a time ---------------------------------------------------------------------------------

async function residentModels(): Promise<string[] | undefined> {
	try {
		const body = await (await fetch(`${root}/api/ps`, { signal: AbortSignal.timeout(10_000) })).json() as { models?: { name?: string }[] };
		return (body.models ?? []).map(entry => entry.name ?? '').filter(Boolean);
	} catch {
		return undefined;
	}
}
/** Evicts every model the runtime holds, and says what it held and what was left. Undefined: the runtime has no account of what it holds. */
async function evictAll(): Promise<{ readonly evicted: readonly string[]; readonly left: readonly string[] } | undefined> {
	const held = await residentModels();
	if (held === undefined) {
		return undefined;
	}
	for (const name of held) {
		await fetch(`${root}/api/generate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: name, keep_alive: 0 }), signal: AbortSignal.timeout(60_000) }).catch(() => undefined);
	}
	let left = await residentModels() ?? [];
	for (let waited = 0; left.length > 0 && waited < 20; waited++) {
		await sleep(500);
		left = await residentModels() ?? [];
	}
	return { evicted: held, left };
}

// --- cancellation -------------------------------------------------------------------------------------------------

const abort = new AbortController();
let cancelled = false;
let onCancel: (() => void) | undefined;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
	process.on(signal, () => {
		if (!cancelled) {
			cancelled = true;
			abort.abort();
			onCancel?.();
		}
	});
}

// --- tier S -------------------------------------------------------------------------------------------------------

interface IReply { /** Each token with its log-probability, when the manifest asks for them and the runtime sends them. */ readonly tokens: readonly (readonly [string, number])[] | null; readonly text: string; readonly finishReason: string | null; readonly promptTokens: number | null; readonly completionTokens: number | null; readonly firstTokenMs: number | null; readonly totalMs: number }

async function chatOnce(model: string, messages: readonly { role: string; content: string }[], seed: number, timeoutMs: number): Promise<IReply> {
	const started = performance.now();
	const response = await fetch(`${campaign!.baseUrl}/chat/completions`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ model, messages, temperature: manifest.sampling.temperature, max_tokens: manifest.sampling.maxTokens ?? 4096, seed, stream: true, stream_options: { include_usage: true }, ...(manifest.sampling.logprobs ? { logprobs: true } : {}) }),
		signal: AbortSignal.any([abort.signal, AbortSignal.timeout(timeoutMs)]),
	});
	if (!response.ok || !response.body) {
		throw new Error(`HTTP ${response.status} ${(await response.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 200)}`);
	}
	let text = '';
	const tokens: [string, number][] = [];
	let finishReason: string | null = null;
	let promptTokens: number | null = null;
	let completionTokens: number | null = null;
	let firstTokenMs: number | null = null;
	let buffer = '';
	const decoder = new TextDecoder();
	for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
		buffer += decoder.decode(chunk, { stream: true });
		for (let newline = buffer.indexOf('\n'); newline >= 0; newline = buffer.indexOf('\n')) {
			const line = buffer.slice(0, newline).trim();
			buffer = buffer.slice(newline + 1);
			if (!line.startsWith('data:') || line.slice(5).trim() === '[DONE]') {
				continue;
			}
			let event: { usage?: { prompt_tokens?: number; completion_tokens?: number }; choices?: { finish_reason?: string | null; delta?: { content?: string }; logprobs?: { content?: { token: string; logprob: number }[] | null } | null }[] };
			try {
				event = JSON.parse(line.slice(5));
			} catch {
				continue;
			}
			const choice = event.choices?.[0];
			if (choice?.delta?.content) {
				firstTokenMs ??= performance.now() - started;
				text += choice.delta.content;
			}
			for (const entry of choice?.logprobs?.content ?? []) {
				tokens.push([entry.token, entry.logprob]);
			}
			finishReason = choice?.finish_reason ?? finishReason;
			promptTokens = event.usage?.prompt_tokens ?? promptTokens;
			completionTokens = event.usage?.completion_tokens ?? completionTokens;
		}
	}
	return { tokens: manifest.sampling.logprobs ? tokens : null, text, finishReason, promptTokens, completionTokens, firstTokenMs: firstTokenMs === null ? null : Math.round(firstTokenMs), totalMs: Math.round(performance.now() - started) };
}

async function runTierS(units: readonly ILabUnit[], evictions: object[]): Promise<void> {
	let model: string | undefined;
	for (const unit of units) {
		if (cancelled) {
			return;
		}
		if (unit.model !== model) {
			evictions.push({ before: unit.model, ...(await evictAll() ?? { unknown: 'the runtime does not say what it holds' }) });
			model = unit.model;
		}
		const base = { unit: unit.id, model: unit.model, configuration: unit.configuration, task: unit.task.id, seed: unit.seed, repetition: unit.repetition, tier: 'S' as const, edits: [], events: [], harnessHash: null, deniedCommands: 0 };
		const started = Date.now();
		const before = gitShow(`${unit.task.commit}~1`, unit.task.file);
		if (before === undefined || before.length > (campaign!.maxBeforeChars ?? 12_000)) {
			// A model is not scored on a task it could not read: the file is not there, or does not fit.
			appendRecord({ ...base, outcome: 'could-not-serve', reply: null, requests: [], durationMs: Date.now() - started, error: before === undefined ? 'the file does not exist before the commit' : `the file is ${before.length} characters before the change, over the ${campaign!.maxBeforeChars ?? 12_000} a task may be` });
			continue;
		}
		const messages = [{ role: 'system', content: bench.ONYX_BENCH_SYSTEM_PROMPT }, { role: 'user', content: bench.buildBenchPrompt({ file: unit.task.file, subject: instructionOf(unit.task) }, before) }];
		try {
			let reply: IReply;
			try {
				reply = await chatOnce(unit.model, messages, unit.seed, campaign!.unitTimeoutMs ?? 300_000);
			} catch (error) {
				// One retry, and only for a server error: a model still unloading answers 5xx once.
				if (cancelled || !/HTTP 5\d\d/.test((error as Error).message)) {
					throw error;
				}
				await sleep(5000);
				reply = await chatOnce(unit.model, messages, unit.seed, campaign!.unitTimeoutMs ?? 300_000);
			}
			appendRecord({ ...base, outcome: 'attempted', reply: reply.text, ...(reply.tokens ? { tokens: reply.tokens } : {}), requests: [{ promptTokens: reply.promptTokens, completionTokens: reply.completionTokens, firstTokenMs: reply.firstTokenMs, tokensPerSecond: reply.completionTokens && reply.firstTokenMs !== null && reply.totalMs > reply.firstTokenMs ? Math.round(reply.completionTokens / ((reply.totalMs - reply.firstTokenMs) / 1000) * 10) / 10 : null }], finishReason: reply.finishReason, durationMs: Date.now() - started });
		} catch (error) {
			if (cancelled) {
				return; // the unit in flight leaves no record
			}
			appendRecord({ ...base, outcome: 'could-not-serve', reply: null, requests: [], durationMs: Date.now() - started, error: (error as Error).message });
		}
	}
}

// --- tier A -------------------------------------------------------------------------------------------------------

function killGroup(child: ChildProcess): void {
	for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
		if (!child.pid) {
			return;
		}
		try {
			process.kill(-child.pid, signal);
		} catch {
			try {
				process.kill(child.pid, signal);
			} catch {
				// already gone
			}
		}
		if (signal === 'SIGTERM') {
			execFileSync('sleep', ['2']);
		}
	}
}

/** The end of the newest main-process and window logs of an instance, with the user's home directory taken out. */
function applicationLogTail(userDataDir: string): string | undefined {
	try {
		const logs = path.join(userDataDir, 'logs');
		const newest = fs.readdirSync(logs).sort().at(-1);
		if (!newest) {
			return undefined;
		}
		const files = (fs.readdirSync(path.join(logs, newest), { recursive: true, encoding: 'utf8' }) as string[]).filter(name => /(^|\/)(main|renderer)\.log$/.test(name));
		const text = files.map(name => fs.readFileSync(path.join(logs, newest, name), 'utf8').trim().split('\n').slice(-4).join(' ⏎ ')).join(' ⏎ ');
		return text.split(os.homedir()).join('~').replace(/\/(private\/)?var\/folders\/[^ ]*/g, '<temporary>').slice(-700) || undefined;
	} catch {
		return undefined;
	}
}

/**
 * Starts the application on a worktree with a work order, waits until the engine inside says it is done, has
 * failed, or has stopped answering, and ends the application. One instance, one profile of its own.
 */
async function runApplication(workDir: string, worktree: string, heartbeatPath: string, index: number, order: { readonly unitTimeoutMs: number; readonly units: readonly object[]; readonly measure?: object; readonly datasheetsFirst?: boolean }): Promise<{ readonly state: string; readonly reason: string | undefined; readonly exited: boolean; readonly userDataDir: string }> {
	const statusPath = path.join(workDir, 'status.json');
	const cancelPath = path.join(workDir, 'cancel');
	const orderPath = path.join(workDir, 'order.json');
	fs.rmSync(statusPath, { force: true });
	fs.writeFileSync(orderPath, JSON.stringify({ worktree, recordsPath, statusPath, cancelPath, heartbeatPath, baseUrl: campaign!.baseUrl, ...order }));
	// A profile of its own, with the campaign's endpoint added to the runtimes discovery probes. Discovery
	// stays on: it is what identifies the runtime (its kind, its version, each model's digest). It probes
	// this machine's well-known ports and nothing else, and every unit names its model by this endpoint.
	const userDataDir = path.join(workDir, `user-data-${index}`);
	fs.mkdirSync(path.join(userDataDir, 'User'), { recursive: true });
	fs.writeFileSync(path.join(userDataDir, 'User', 'settings.json'), JSON.stringify({
		'onyx.endpoints': [{ baseUrl: campaign!.baseUrl }], 'onyx.discovery.enabled': true, 'onyx.routing.mode': 'manual', 'onyx.autocomplete.enabled': false,
		'onyx.review.background': false, 'onyx.verification.task': '', 'onyx.energy.policy': 'performance', 'git.enabled': false, 'git.autoRepositoryDetection': false, 'telemetry.telemetryLevel': 'off',
		'extensions.autoUpdate': false, 'extensions.autoCheckUpdates': false, 'update.mode': 'none', 'workbench.enableExperiments': false, 'files.watcherExclude': { '**': true },
	}, undefined, '\t'));
	const child = spawn(path.join(appRoot, 'scripts', 'code.sh'), [
		`--user-data-dir=${userDataDir}`, `--extensions-dir=${path.join(workDir, 'extensions')}`, '--disable-extensions',
		...(process.platform === 'darwin' ? ['--use-mock-keychain'] : []), '--disable-workspace-trust', '--skip-release-notes', worktree,
	], { cwd: appRoot, env: { ...process.env, VSCODE_SKIP_PRELAUNCH: '1', ONYX_LAB_CAMPAIGN: orderPath, GIT_LFS_SKIP_SMUDGE: '1' }, stdio: 'ignore', detached: true });
	fs.writeFileSync(path.join(workDir, 'app.pid'), String(child.pid ?? 0));
	let exited = false;
	child.on('exit', () => { exited = true; });
	onCancel = () => fs.writeFileSync(cancelPath, '');
	let state = 'starting';
	let reason: string | undefined;
	let lastProgress = Date.now();
	let lastDone = -1;
	const startBudgetMs = 180_000;
	try {
		for (; ;) {
			await sleep(500);
			if (fs.existsSync(statusPath)) {
				try {
					const status: { state: string; done?: number; reason?: string } = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
					state = status.state;
					reason = status.reason;
					if ((status.done ?? 0) !== lastDone) {
						lastDone = status.done ?? 0;
						lastProgress = Date.now();
					}
				} catch {
					// read while it was being written
				}
			}
			if (state === 'done' || state === 'cancelled' || state === 'failed' || state === 'refused' || exited) {
				break;
			}
			if (cancelled && Date.now() - lastProgress > 15_000) {
				break;
			}
			if (state === 'starting' && Date.now() - lastProgress > startBudgetMs) {
				reason = `the application did not start the campaign within ${startBudgetMs / 1000} seconds`;
				break;
			}
			if (state === 'running' && Date.now() - lastProgress > order.unitTimeoutMs + 120_000) {
				reason = 'no unit finished within the time one unit may take, and two minutes';
				break;
			}
		}
	} finally {
		killGroup(child);
		onCancel = undefined;
	}
	return { state, reason, exited, userDataDir };
}

async function runTierA(units: readonly ILabUnit[], evictions: object[], notes: string[]): Promise<void> {
	// What a launcher that was killed left behind: its folder, its worktree and perhaps its application.
	for (const entry of fs.readdirSync(os.tmpdir()).filter(name => name.startsWith('onyx-lab-'))) {
		const stale = path.join(os.tmpdir(), entry);
		const pidOf = (file: string) => { try { return Number(fs.readFileSync(path.join(stale, file), 'utf8')); } catch { return 0; } };
		const alive = (pid: number) => { try { return pid > 0 && (process.kill(pid, 0), true); } catch { return false; } };
		if (alive(pidOf('launcher.pid'))) {
			continue; // another campaign is running; real-model campaigns run one at a time, and this is said below
		}
		const app = pidOf('app.pid');
		if (alive(app)) {
			try { process.kill(-app, 'SIGKILL'); } catch { /* gone */ }
		}
		try { git(repo, ['worktree', 'remove', '--force', path.join(stale, 'worktree')]); } catch { /* not this repository's, or gone */ }
		fs.rmSync(stale, { recursive: true, force: true });
		notes.push(`removed what a killed campaign left: ${entry}`);
	}
	try { git(repo, ['worktree', 'prune']); } catch { /* nothing to prune */ }
	const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onyx-lab-'));
	fs.writeFileSync(path.join(workDir, 'launcher.pid'), String(process.pid));
	const worktree = path.join(workDir, 'worktree');
	const heartbeatPath = path.join(workDir, 'heartbeat');
	fs.writeFileSync(heartbeatPath, '');
	const heartbeat = setInterval(() => fs.writeFileSync(heartbeatPath, String(Date.now())), 3000);
	const measure = campaign!.measure;
	try {
		git(repo, ['worktree', 'add', '--quiet', '--detach', worktree, measure ? measure.revision : `${units[0].task.commit}~1`]);
		if (measure) {
			// The measure command itself, in the application, with its prompts answered in advance (L11).
			evictions.push({ before: 'the measurement', ...(await evictAll() ?? { unknown: 'the runtime does not say what it holds' }) });
			const { state, reason, exited, userDataDir } = await runApplication(workDir, worktree, heartbeatPath, 0, {
				unitTimeoutMs: campaign!.unitTimeoutMs ?? 3_600_000, units: [],
				measure: { modelIds: wireModels, datasheets: measure.datasheets !== false, ...(measure.taskCount ? { taskCount: measure.taskCount } : {}) },
			});
			if (cancelled) {
				notes.push(`cancelled; the application's last word was "${state}"`);
				return;
			}
			if (state !== 'done') {
				const tail = applicationLogTail(userDataDir);
				throw new Error(`the measurement did not finish: the application ${exited ? 'exited' : 'was stopped'} in state "${state}"${reason ? ` (${reason})` : ''}${tail ? `; its log ended: ${tail}` : ''}`);
			}
			// What the command saved into the worktree is the result: it is taken out before the worktree goes.
			const saved = path.join(worktree, '.onyx', 'scorecards');
			const newest = fs.existsSync(saved) ? fs.readdirSync(saved).sort().at(-1) : undefined;
			if (!newest) {
				throw new Error('the measurement finished and saved no scorecard');
			}
			for (const name of ['scorecard.md', 'scorecard.svg', 'scorecard.json']) {
				fs.copyFileSync(path.join(saved, newest, name), path.join(outDir, name));
			}
			return;
		}
		const configurations = new Map(manifest.harnessConfigurations.map(entry => [entry.name, entry.configuration ?? {}]));
		const models = [...new Set(units.map(unit => unit.model))];
		for (const model of models) {
			let stalls = 0;
			for (; ;) {
				if (cancelled) {
					return;
				}
				const finished = new Set(readRecords().map(record => record.unit));
				const segment = units.filter(unit => unit.model === model && !finished.has(unit.id));
				if (segment.length === 0) {
					break;
				}
				evictions.push({ before: model, ...(await evictAll() ?? { unknown: 'the runtime does not say what it holds' }) });
				const before = finished.size;
				const { state, reason, exited, userDataDir } = await runApplication(workDir, worktree, heartbeatPath, evictions.length, {
					unitTimeoutMs: campaign!.unitTimeoutMs ?? 600_000,
					units: segment.map(unit => ({
						id: unit.id, manifest: manifest.name, model: unit.model, configuration: { name: unit.configuration, configuration: configurations.get(unit.configuration) ?? {} }, task: unit.task,
						seed: unit.seed, repetition: unit.repetition, temperature: manifest.sampling.temperature, instruction: lab.labAgentInstruction(unit.task.file, instructionOf(unit.task)),
					})),
					...(campaign!.datasheetsFirst ? { datasheetsFirst: true } : {}),
				});
				if (cancelled) {
					notes.push(`cancelled; the application's last word was "${state}"`);
					return;
				}
				if (state === 'failed' || state === 'refused') {
					throw new Error(`the application ${state === 'refused' ? 'refused the campaign' : 'could not go on'}: ${reason ?? 'no reason given'}`);
				}
				const progressed = new Set(readRecords().map(record => record.unit)).size > before;
				if (state !== 'done') {
					// The application went away, or stopped answering, with units left: say so and start it again.
					stalls = progressed ? 0 : stalls + 1;
					notes.push(`${new Date().toISOString()}: the application ${exited ? 'exited' : 'was stopped'} in state "${state}"${reason ? ` (${reason})` : ''} with units of ${model} left; ${stalls >= 3 ? 'giving up' : 'started again'}`);
					// What the application's own log says, so that the next occurrence has more than a count behind it.
					const tail = applicationLogTail(userDataDir);
					if (tail) {
						notes.push(`the application's log ended: ${tail}`);
					}
					console.log(`  ${notes[notes.length - 1]}`);
					if (stalls >= 3) {
						throw new Error(`the application ended three times without finishing a unit of ${model}`);
					}
				}
			}
		}
	} finally {
		clearInterval(heartbeat);
		try {
			git(repo, ['worktree', 'remove', '--force', worktree]);
		} catch {
			// never added, or already gone
		}
		try {
			git(repo, ['worktree', 'prune']);
		} catch {
			// nothing to prune
		}
		fs.rmSync(workDir, { recursive: true, force: true });
		notes.push(`worktree removed: ${!fs.existsSync(worktree) && !git(repo, ['worktree', 'list', '--porcelain']).includes(worktree)}`);
	}
}

// --- the campaign -------------------------------------------------------------------------------------------------

const previous: { machineSeconds?: number; sessions?: object[]; estimate?: object } = fs.existsSync(campaignPath) ? JSON.parse(fs.readFileSync(campaignPath, 'utf8')) : {};
const remaining = lab.remainingLabUnits(plan, new Set(readRecords().map(record => record.unit)));
let speeds: Record<string, { tokensPerSecond: number } | undefined> = {};
if (campaign.datasheets) {
	try {
		const sheets: { performance?: Record<string, { serverAllocation?: { tokensPerSecond?: number | null }; requestedContext?: { tokensPerSecond?: number | null } }> } = JSON.parse(fs.readFileSync(path.resolve(repoRoot, campaign.datasheets), 'utf8'));
		manifest.models.forEach((model, index) => {
			const measured = sheets.performance?.[model.identifier.replace(/^[a-z]+:/, '')];
			const speed = measured?.requestedContext?.tokensPerSecond ?? measured?.serverAllocation?.tokensPerSecond;
			if (speed) {
				speeds[wireModels[index]] = { tokensPerSecond: speed };
			}
		});
	} catch {
		speeds = {};
	}
}
const estimate = lab.estimateLabDuration(remaining, speeds, lab.ONYX_LAB_SHAPE[campaign.tier]);
console.log(`${manifest.name}: tier ${campaign.tier}, ${plan.length} units planned, ${plan.length - remaining.length} already finished`);
console.log(`estimated for what is left: ${lab.describeLabEstimate(estimate)}`);

const stateBefore = repositoryState();
const startConditions = conditions();
const started = Date.now();
const evictions: object[] = [];
const notes: string[] = [];
let failure: string | undefined;
try {
	if (campaign.measure) {
		if (!fs.existsSync(path.join(outDir, 'scorecard.json'))) {
			await runTierA([], evictions, notes);
		}
	} else if (remaining.length > 0) {
		if (campaign.tier === 'S') {
			await runTierS(remaining, evictions);
		} else {
			await runTierA(remaining, evictions, notes);
		}
	}
} catch (error) {
	failure = error instanceof Error ? error.message : String(error);
}
// The last model is evicted too: a campaign leaves the runtime as empty as it needs it.
evictions.push({ after: 'the campaign', ...(await evictAll() ?? { unknown: 'the runtime does not say what it holds' }) });
const stateAfter = repositoryState();
const unchanged = JSON.stringify(stateBefore) === JSON.stringify(stateAfter);
const { results, unscorable } = writeResults();
const seconds = Math.round((Date.now() - started) / 1000);
const complete = campaign.measure ? measured?.complete === true : results.length + unscorable === plan.length;
const planned = campaign.measure ? measured?.planned ?? 0 : plan.length;
const session = { startedAt: startConditions.at, seconds, unitsLeftAtStart: remaining.length, ...(campaign.tier === 'A' ? { application: applicationProvenance() } : {}), estimate, conditionsAtStart: startConditions, conditionsAtEnd: conditions(), ended: failure ? `failed: ${failure}` : cancelled ? 'cancelled' : complete ? 'complete' : 'stopped before the end', evictions, notes };
fs.writeFileSync(campaignPath, JSON.stringify({
	campaign: manifest.name, tier: campaign.tier, plannedUnits: planned, finishedUnits: results.length, complete,
	machineSeconds: (previous.machineSeconds ?? 0) + seconds,
	firstEstimate: previous.estimate ?? estimate,
	repository: { unchanged, before: stateBefore, after: stateAfter },
	sessions: [...(previous.sessions ?? []), session],
}, undefined, '\t') + '\n');

console.log(`${results.length} of ${planned} units have a result; this session took ${seconds} s (${(previous.machineSeconds ?? 0) + seconds} s in all)`);
if (!unchanged) {
	console.error('run-lab: THE REPOSITORY CHANGED DURING THE CAMPAIGN (files, index, HEAD or refs). See campaign.json.');
	process.exit(4);
}
if (failure) {
	console.error(`run-lab: ${failure}`);
	process.exit(1);
}
process.exit(cancelled ? 130 : complete ? 0 : 3);
