/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Writes a campaign's manifest from what is true when it is written (L9):
 * the weights digest and the runtime's version as the runtime reports them
 * now, the context the committed datasheet verified, the hash of each
 * harness configuration, the task set's hash, the machine with its load
 * average and power source, and the duration the datasheets predict.
 *
 *   node test/onyx/lab/new-manifest.mts --name <date>-<name> --tier S|A --base-url http://127.0.0.1:<port>/v1 \
 *        --model <id> [--model <id>…] --tasks <tasks.json> --configurations <file.json> --datasheets <summary.json> \
 *        [--seed <n>…] [--repetitions <n>] [--temperature <t>] [--max-tokens <n>] [--unit-timeout-ms <n>] \
 *        [--max-before-chars <n>] [--logprobs] [--hypothesis H-<n>…] [--notes <text>] [--out-root <dir>]
 *
 * `--configurations` is a JSON file: an array of `{ "name": …, "configuration": { … } }`. A tier A
 * configuration has to set every field of the harness configuration, so that its hash is known before the
 * campaign and nothing is left to be derived from a profile the application changes as it goes. A tier S
 * campaign does not go through the agent loop: it takes one entry with an empty configuration.
 *
 * The task set is copied beside the manifest. It needs compiled output (`pnpm run transpile-client`).
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateManifest } from './manifest.mts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const out = (relative: string) => pathToFileURL(path.join(repoRoot, 'out', relative)).href;
const flags = (name: string): string[] => process.argv.flatMap((argument, index) => argument === name && process.argv[index + 1] !== undefined ? [process.argv[index + 1]] : []);
const flag = (name: string): string | undefined => flags(name)[0];

const name = flag('--name');
const tier = flag('--tier');
const baseUrl = flag('--base-url');
const models = flags('--model');
const tasksPath = flag('--tasks');
const configurationsPath = flag('--configurations');
const datasheetsPath = flag('--datasheets');
if (!name || (tier !== 'S' && tier !== 'A') || !baseUrl || models.length === 0 || !tasksPath || !configurationsPath || !datasheetsPath) {
	console.error('usage: node test/onyx/lab/new-manifest.mts --name <date>-<name> --tier S|A --base-url <url> --model <id>… --tasks <tasks.json> --configurations <file.json> --datasheets <summary.json> [--seed <n>…] [--repetitions <n>] [--temperature <t>] [--max-tokens <n>] [--unit-timeout-ms <n>] [--max-before-chars <n>] [--logprobs] [--hypothesis H-<n>…] [--notes <text>] [--out-root <dir>]');
	process.exit(2);
}
const outDir = path.resolve(flag('--out-root') ?? path.join(repoRoot, 'docs', 'research', 'results'), name);
const root = baseUrl.replace(/\/v1$/, '');

const FIELDS = ['toolCallProtocol', 'editProtocol', 'promptStyle', 'toolResultChars', 'evictionPolicy', 'contextTokens', 'turnCap', 'verificationFeedback', 'readToolLineNumbering', 'toolSlotPolicy', 'maxTools'];
const { harnessConfigHash }: { harnessConfigHash(configuration: object): string } = await import(out('vs/workbench/contrib/onyx/common/onyxHarnessConfig.js'));
const lab: { planLabCampaign(spec: object): { model: string }[]; estimateLabDuration(plan: object, speeds: object, shape: object): { seconds: number | null }; describeLabEstimate(estimate: object): string; ONYX_LAB_SHAPE: Record<string, object> } = await import(out('vs/workbench/contrib/onyx/common/onyxLab.js'));

const configurations: { name: string; configuration: Record<string, unknown> }[] = JSON.parse(fs.readFileSync(path.resolve(configurationsPath), 'utf8'));
const harnessConfigurations = configurations.map(entry => {
	const missing = FIELDS.filter(field => entry.configuration[field] === undefined);
	if (tier === 'A' && missing.length > 0) {
		throw new Error(`configuration ${entry.name} does not set ${missing.join(', ')}: a tier A configuration names every switch`);
	}
	return { name: entry.name, hash: tier === 'A' ? harnessConfigHash(entry.configuration) : '00000000', configuration: entry.configuration };
});

const tags: { models: { name: string; digest: string }[] } = await (await fetch(`${root}/api/tags`)).json() as never;
const version: { version?: string } = await (await fetch(`${root}/api/version`)).json() as never;
const sheets: { datasheets: Record<string, { digest: string | null; context: { requestedTokens: number | null; serverReportedTokens: number | null; verifiedTokens: number | null; mechanism: string | null } }>; performance?: Record<string, { serverAllocation?: { tokensPerSecond?: number | null } }> } = JSON.parse(fs.readFileSync(path.resolve(datasheetsPath), 'utf8'));
const manifestModels = models.map(id => {
	const listed = tags.models.find(entry => entry.name === id);
	const sheet = sheets.datasheets[id];
	if (!listed) {
		throw new Error(`the runtime at ${baseUrl} does not have ${id}; nothing is downloaded for a campaign`);
	}
	if (!sheet || !sheet.digest || !listed.digest.startsWith(sheet.digest.replace(/^sha256:/, '').slice(0, 12))) {
		throw new Error(`${id}: the datasheet in ${datasheetsPath} is not of the weights the runtime has now (${listed.digest.slice(0, 12)}); measure the model again first`);
	}
	return { identifier: `ollama:${id}`, digest: listed.digest, runtime: { name: 'ollama', ...(version.version ? { version: version.version } : {}) }, context: { requestedTokens: sheet.context.requestedTokens, reportedTokens: sheet.context.serverReportedTokens, verifiedTokens: sheet.context.verifiedTokens, mechanism: sheet.context.mechanism } };
});

fs.mkdirSync(outDir, { recursive: true });
const taskSet: { name: string; hash: string; tasks: object[] } = JSON.parse(fs.readFileSync(path.resolve(tasksPath), 'utf8'));
fs.writeFileSync(path.join(outDir, 'tasks.json'), JSON.stringify(taskSet, undefined, '\t') + '\n');

const seeds = flags('--seed').map(Number);
const repetitions = Number(flag('--repetitions') ?? 1);
let power: string | undefined;
let osVersion = `${os.type()} ${os.release()}`;
try {
	osVersion = `macOS ${execFileSync('sw_vers', ['-productVersion'], { encoding: 'utf8' }).trim()}`;
	const battery = execFileSync('pmset', ['-g', 'batt'], { encoding: 'utf8' });
	const adapter = execFileSync('pmset', ['-g', 'ac'], { encoding: 'utf8' });
	power = `${/'(?<source>[^']+)'/.exec(battery)?.groups?.source ?? 'unknown source'}, ${/(?<percent>\d+)%/.exec(battery)?.groups?.percent ?? '?'}%, adapter ${/Wattage = (?<watts>\d+)W/.exec(adapter)?.groups?.watts ?? 'none'} W`;
} catch {
	// not macOS
}
const plan = lab.planLabCampaign({ tier, models, configurations: harnessConfigurations.map(entry => entry.name), tasks: taskSet.tasks, seeds: seeds.length ? seeds : [1], repetitions });
const speeds = Object.fromEntries(models.map(id => [id, sheets.performance?.[id]?.serverAllocation?.tokensPerSecond ? { tokensPerSecond: sheets.performance[id].serverAllocation!.tokensPerSecond } : undefined]));
const estimate = lab.estimateLabDuration(plan, speeds, lab.ONYX_LAB_SHAPE[tier]);
const relative = (target: string) => path.relative(repoRoot, path.resolve(target)).split(path.sep).join('/');
const manifest = {
	version: 1,
	name,
	createdAt: new Date().toISOString(),
	models: manifestModels,
	seeds: seeds.length ? seeds : [1],
	sampling: { temperature: Number(flag('--temperature') ?? 0), maxTokens: Number(flag('--max-tokens') ?? 4096), ...(process.argv.includes('--logprobs') ? { logprobs: true } : {}), responseFormat: tier === 'A' && harnessConfigurations.some(entry => entry.configuration.toolCallProtocol === 'constrained-envelope') },
	harnessConfigurations,
	taskSet: { name: taskSet.name, hash: taskSet.hash, count: taskSet.tasks.length },
	repetitions,
	machine: { platform: process.platform, arch: process.arch, cpu: os.cpus()[0]?.model ?? 'unknown', memoryGiB: Math.round(os.totalmem() / 1024 ** 3), osVersion, nodeVersion: process.version.replace(/^v/, ''), loadAverage: os.loadavg().map(value => Math.round(value * 100) / 100), ...(power ? { power } : {}) },
	regenerate: [
		{ output: 'traces/records.jsonl, campaign.json', command: `node test/onyx/lab/run-lab.mts docs/research/results/${name}/manifest.json` },
		{ output: 'results.jsonl, summary.json', command: `node test/onyx/lab/run-lab.mts docs/research/results/${name}/manifest.json --rescore` },
	],
	campaign: {
		tier, baseUrl, tasks: 'tasks.json', datasheets: relative(datasheetsPath), estimatedSeconds: estimate.seconds,
		...(flag('--unit-timeout-ms') ? { unitTimeoutMs: Number(flag('--unit-timeout-ms')) } : {}), ...(flag('--max-before-chars') ? { maxBeforeChars: Number(flag('--max-before-chars')) } : {}),
	},
	hypotheses: flags('--hypothesis'),
	notes: flag('--notes') ?? '',
};
const validation = validateManifest(manifest);
if (!validation.ok) {
	console.error(`new-manifest: the manifest it would write is invalid:\n  ${validation.errors.join('\n  ')}`);
	process.exit(1);
}
fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, undefined, '\t') + '\n');
console.log(`${relative(path.join(outDir, 'manifest.json'))}: ${lab.describeLabEstimate(estimate)}; load average ${manifest.machine.loadAverage.join(' ')}${power ? `; ${power}` : ''}`);
