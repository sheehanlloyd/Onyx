/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Runs the invariant campaign (R-42) over a range of seeds in several
 * processes:
 *
 *   node test/onyx/sim/run-campaign.mts --episodes 20000 [--seed 1] [--shard 2000]
 *
 * One test process holds every episode's leftovers until it exits, and at
 * about 14,000 episodes it runs out of memory. So a large campaign is cut
 * into shards of consecutive seeds, each its own process. The seeds are the
 * same ones a single run would use, every one exactly once, and the campaign
 * fails if any shard does.
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function numberOf(flag: string, fallback: number): number {
	const index = process.argv.indexOf(flag);
	const value = index === -1 ? fallback : Number(process.argv[index + 1]);
	if (!Number.isInteger(value) || value < 1) {
		console.error(`run-campaign: ${flag} needs a whole number of at least 1`);
		process.exit(2);
	}
	return value;
}

const episodes = numberOf('--episodes', 20_000);
const firstSeed = numberOf('--seed', 1);
const shardSize = numberOf('--shard', 2000);

let ran = 0;
const failed: string[] = [];
const classes = new Set<string>();
for (let seed = firstSeed; seed < firstSeed + episodes; seed += shardSize) {
	const count = Math.min(shardSize, firstSeed + episodes - seed);
	const result = spawnSync(path.join(repoRoot, 'scripts', 'test.sh'), ['--grep', 'OnyxSim R-42'], {
		cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
		env: { ...process.env, ONYX_SIM_EPISODES: String(count), ONYX_SIM_SEED: String(seed) },
	});
	const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
	// The test's title carries what it ran: `{"exceptions":7,"episodes":2000,"classesSeen":[…]}`.
	const summary = /"episodes":(?<episodes>\d+),"classesSeen":\[(?<classes>[^\]]*)\]/.exec(output)?.groups;
	const passed = result.status === 0 && /\b1 passing\b/.test(output) && Number(summary?.episodes) === count;
	for (const cls of (summary?.classes ?? '').split(',').map(entry => entry.replace(/"/g, '')).filter(Boolean)) {
		classes.add(cls);
	}
	console.log(`  ${passed ? 'ok  ' : 'FAIL'} seeds ${seed} to ${seed + count - 1}${passed ? '' : `: exit ${result.status}\n${output.slice(-1500)}`}`);
	if (passed) {
		ran += count;
	} else {
		failed.push(`${seed}-${seed + count - 1}`);
	}
}
console.log(`\ncampaign: ${ran} of ${episodes} episodes ran with no violation class outside the baseline table${failed.length ? `; failed shards: ${failed.join(', ')}` : ''}`);
console.log(`classes seen (all in the table): ${[...classes].sort().join(', ') || 'none'}`);
process.exit(failed.length === 0 && ran === episodes ? 0 : 1);
