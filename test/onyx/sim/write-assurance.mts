/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The assurance campaign (L12, R-52, H-1), run and written down:
 *
 *   node test/onyx/sim/write-assurance.mts --out docs/research/results/<date>-assurance [--episodes 50000] [--mutant-episodes 2000]
 *
 * It runs the simulation campaign on the harness as it is checked out (every
 * invariant checker over the seeded episodes, the scripted workflows and the
 * injection corpus), then every mutant against the campaign's first seeds,
 * and writes a results directory: the manifest, `summary.json` with the
 * counts and the mutation score, `traces/campaign.txt` (each shard's line),
 * `traces/mutation.json` (each mutant: what kills it and at which seed), and
 * `outcome.json`, H-1's outcome by the registered thresholds. Nothing here
 * talks to a model or to the network. Exit 0 when the campaign found no
 * violation and every mutant was killed.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateManifest } from '../lab/manifest.mts';
import { sourceState } from '../run-fresh.mts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const flag = (name: string): string | undefined => {
	const index = process.argv.indexOf(name);
	return index === -1 ? undefined : process.argv[index + 1];
};
const outArg = flag('--out');
if (!outArg) {
	console.error('usage: node test/onyx/sim/write-assurance.mts --out docs/research/results/<date>-assurance [--episodes 50000] [--mutant-episodes 2000]');
	process.exit(2);
}
const outDir = path.resolve(outArg);
const episodes = Number(flag('--episodes') ?? 50_000);
const mutantEpisodes = Number(flag('--mutant-episodes') ?? 2000);
const shard = 2000;
fs.mkdirSync(path.join(outDir, 'traces'), { recursive: true });

interface IMutantRow { readonly id: string; readonly fixedBy: string; readonly generic: string | null; readonly detects: string; readonly killedByItsScript: boolean; readonly killedByTheCampaign: boolean; readonly firstDetectedAt: number | string | null }
const table: { SIM_MUTANTS: readonly { id: string; defect: string }[] } = await import(pathToFileURL(path.join(repoRoot, 'out', 'vs', 'workbench', 'contrib', 'onyx', 'test', 'browser', 'sim', 'onyxSimMutantTable.js')).href);
const injection: { injectionEpisodes(): readonly { surface: string; effect: string; decision: string }[]; SIM_INJECTION_SURFACES: readonly string[]; SIM_INJECTION_EFFECTS: readonly string[] } = await import(pathToFileURL(path.join(repoRoot, 'out', 'vs', 'workbench', 'contrib', 'onyx', 'test', 'browser', 'sim', 'onyxSimInjection.js')).href);

const state = sourceState();
const startedAt = new Date();
const load = os.loadavg().map(value => Math.round(value * 100) / 100);

// --- the campaign on the harness as it is ---------------------------------------------------------------------------
const campaignStarted = Date.now();
const campaign = spawnSync(process.execPath, [path.join(repoRoot, 'test', 'onyx', 'sim', 'run-campaign.mts'), '--episodes', String(episodes), '--seed', '1', '--shard', String(shard)], { cwd: repoRoot, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
const campaignSeconds = (Date.now() - campaignStarted) / 1000;
const campaignText = `${campaign.stdout ?? ''}${campaign.stderr ?? ''}`;
fs.writeFileSync(path.join(outDir, 'traces', 'campaign.txt'), campaignText);
const ran = Number(/campaign: (?<ran>\d+) of \d+ episodes ran with no violation class outside the baseline table/.exec(campaignText)?.groups?.ran ?? 0);
const failedShards = /failed shards: (?<shards>[^\n]+)/.exec(campaignText)?.groups?.shards?.split(', ') ?? [];
const classesSeen = (/classes seen \(all in the table\): (?<classes>[^\n]+)/.exec(campaignText)?.groups?.classes ?? 'none').split(', ').filter(entry => entry !== 'none');
console.log(`campaign: ${ran} of ${episodes} episodes with no violation, in ${Math.round(campaignSeconds)} s; exit ${campaign.status}`);

// --- every mutant against the campaign's first seeds ----------------------------------------------------------------
const reportPath = path.join(outDir, 'traces', 'mutation.json');
fs.rmSync(reportPath, { force: true });
const mutantsStarted = Date.now();
const mutants = spawnSync(path.join(repoRoot, 'scripts', 'test.sh'), ['--grep', 'OnyxSim mutants'], { cwd: repoRoot, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, env: { ...process.env, ONYX_SIM_MUTANT_EPISODES: String(mutantEpisodes), ONYX_SIM_SEED: '1', ONYX_SIM_MUTANT_REPORT: reportPath } });
const mutantSeconds = (Date.now() - mutantsStarted) / 1000;
const report: { episodesPerMutant: number; firstSeed: number; mutants: IMutantRow[] } | undefined = fs.existsSync(reportPath) ? JSON.parse(fs.readFileSync(reportPath, 'utf8')) : undefined;
const rows = report?.mutants ?? [];
const killed = rows.filter(row => row.killedByItsScript && row.killedByTheCampaign);
const survivors = rows.filter(row => !(row.killedByItsScript && row.killedByTheCampaign));
console.log(`mutants: ${killed.length} of ${rows.length} killed, in ${Math.round(mutantSeconds)} s; the test's exit ${mutants.status}`);

// --- what was found while the harness was being built ---------------------------------------------------------------
// Every violation class the campaign reported before its defect was fixed, with the shrunk script that reproduced
// it: the script is in the repository's history, in the parent of the commit that removed it with the fix.
const development: { class: string; script: string; removedBy: string; subject: string }[] = [];
const log = execFileSync('git', ['-C', repoRoot, 'log', '--diff-filter=D', '--format=@@%h|%s', '--name-only', '--', 'test/onyx/sim/baseline'], { encoding: 'utf8' });
let current: { hash: string; subject: string } | undefined;
for (const line of log.split('\n')) {
	if (line.startsWith('@@')) {
		const [hash, ...subject] = line.slice(2).split('|');
		current = { hash, subject: subject.join('|') };
	} else if (line.trim() && current) {
		development.push({ class: path.basename(line, '.json').replace(/^(I-\d\d)-/, '$1/'), script: `${line} at ${current.hash}~1`, removedBy: current.hash, subject: current.subject });
	}
}

const corpus = injection.injectionEpisodes();
const zeroViolations = campaign.status === 0 && ran === episodes && failedShards.length === 0;
const score = rows.length ? killed.length / rows.length : 0;
// H-1, by the registered thresholds: supported when the mutation score is 100% and the candidate shows no violation;
// refuted when a mutant survives without an equivalence argument after one round of closing the gap, or the candidate
// shows a violation. There is no inconclusive outcome.
const supported = zeroViolations && rows.length > 0 && survivors.length === 0;
const invariants = Array.from({ length: 14 }, (_, index) => `I-${String(index + 1).padStart(2, '0')}`);
const summary = {
	revision: state.revision, dirtySourceEntries: state.dirtyEntries,
	campaign: { episodes, firstSeed: 1, shardSize: shard, ranWithoutViolation: ran, failedShards, classesSeen, seconds: Math.round(campaignSeconds), episodesPerSecondIncludingProcessStarts: Math.round(episodes / campaignSeconds), scriptedWorkflowsAndInjectionCorpus: 'run in every shard beside its seeded episodes' },
	injectionCorpus: { episodes: corpus.length, surfaces: injection.SIM_INJECTION_SURFACES, effects: injection.SIM_INJECTION_EFFECTS, userDecisions: ['deny', 'allow-once'], notSimulated: ['commit messages', 'the documentation index', 'playbooks', 'a note already in memory'] },
	mutation: {
		total: rows.length, killed: killed.length, score, episodesPerMutant: mutantEpisodes, firstSeed: 1, seconds: Math.round(mutantSeconds),
		resurrectedDefects: rows.filter(row => !row.id.startsWith('G-')).length, genericOnly: rows.filter(row => row.id.startsWith('G-')).length,
		genericMutantOfEachInvariant: Object.fromEntries(invariants.map(invariant => [invariant, rows.filter(row => row.generic === invariant).map(row => row.id)])),
		survivors: survivors.map(row => ({ id: row.id, detects: row.detects, killedByItsScript: row.killedByItsScript, killedByTheCampaign: row.killedByTheCampaign })),
		mutants: rows.map(row => ({ ...row, defect: table.SIM_MUTANTS.find(mutant => mutant.id === row.id)?.defect ?? '' })),
	},
	violationsFoundDuringDevelopment: development,
};
fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, undefined, '\t') + '\n');
fs.writeFileSync(path.join(outDir, 'outcome.json'), JSON.stringify({
	hypothesis: 'H-1',
	statement: 'The simulation campaign detects every resurrected defect in the mutation corpus',
	outcome: supported ? 'supported' : 'refuted',
	number: `mutation score ${killed.length} of ${rows.length}; ${ran} of ${episodes} campaign episodes with no violation`,
	thresholds: 'Supported: mutation score 100% and zero violations on the candidate harness. Refuted: a mutant survives without an equivalence argument after one round of closing the gap, or the candidate shows a violation. No inconclusive outcome (PREREGISTRATION.md, H-1).',
	decidedFrom: ['summary.json', 'traces/campaign.txt', 'traces/mutation.json'],
	regenerate: `node test/onyx/sim/write-assurance.mts --out docs/research/results/${path.basename(outDir)}`,
}, undefined, '\t') + '\n');

let osVersion = `${os.type()} ${os.release()}`;
try {
	osVersion = `macOS ${execFileSync('sw_vers', ['-productVersion'], { encoding: 'utf8' }).trim()}`;
} catch {
	// not macOS
}
const name = path.basename(outDir);
const manifest = {
	version: 1, name, createdAt: startedAt.toISOString(),
	models: [{ identifier: 'mock:simulated-personas', digest: 'mock', runtime: { name: 'mock', version: 'simulation rig' }, context: { requestedTokens: null, reportedTokens: null, verifiedTokens: null, mechanism: null } }],
	seeds: [1], sampling: { temperature: 0 },
	harnessConfigurations: [{ name: 'shipping-default-as-derived-in-the-rig', hash: '00000000' }],
	taskSet: { name: `seeded episodes 1 to ${episodes}, the scripted workflows and the injection corpus`, hash: '00000000', count: episodes },
	repetitions: 1,
	machine: { platform: process.platform, arch: process.arch, cpu: os.cpus()[0]?.model ?? 'unknown', memoryGiB: Math.round(os.totalmem() / 1024 ** 3), osVersion, nodeVersion: process.version.replace(/^v/, ''), loadAverage: load },
	regenerate: [{ output: 'summary.json, outcome.json, traces/', command: `node test/onyx/sim/write-assurance.mts --out docs/research/results/${name}` }],
	hypotheses: ['H-1'],
	notes: `L12: the assurance campaign. No model and no runtime: the simulation rig's personas, a scripted user and a faulty environment, under one seed an episode. The harness is the checkout at ${state.revision.slice(0, 11)}${state.dirtyEntries ? ` with ${state.dirtyEntries} dirty source entries` : ', clean'}. The configuration hash is a placeholder: the rig derives the shipping configuration per episode, and every episode's trace carries its own hash. Throughput includes the start of one test process a shard and was taken on a machine that was running a model campaign at the same time; it is not a benchmark.`,
};
const validation = validateManifest(manifest);
if (!validation.ok) {
	console.error(`write-assurance: the manifest it would write is invalid:\n  ${validation.errors.join('\n  ')}`);
	process.exit(1);
}
fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, undefined, '\t') + '\n');
console.log(`H-1: ${supported ? 'supported' : 'refuted'}; wrote ${path.relative(repoRoot, outDir)}`);
process.exit(supported ? 0 : 1);
