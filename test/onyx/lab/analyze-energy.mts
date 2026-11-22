/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The energy study's analysis (L18, H-10): reads a tier S campaign and the
 * power log taken beside it (`traces/power.jsonl`, `power-sampler.mts`) and
 * reports energy per solved task and per attempted task for each model,
 * beside its tokens per second, and whether the two rank the models
 * differently.
 *
 *   node test/onyx/lab/analyze-energy.mts docs/research/results/<date>-<name> [--idle-watts <w>]
 *
 * The method and its error. The controller's energy accumulator is read
 * about once a minute. A model's units run one after another as a block;
 * the block's energy is the accumulator's change over it, with the minute
 * at each end split in proportion to the time the block covers of it. The
 * most that split can be wrong by is the whole energy of those two minutes,
 * which is reported as `boundaryJoules`. A task's energy is its share of
 * its block's energy by the time it took: the power within a block is taken
 * as even, which it is not exactly. System power is the whole machine's:
 * display, other applications and the runtime together. `--idle-watts`
 * (measured before the campaign with nothing running) gives a second
 * column with that taken off; it decides nothing.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const out = (relative: string) => pathToFileURL(path.join(repoRoot, 'out', relative)).href;
const directory = process.argv[2] && !process.argv[2].startsWith('--') ? path.resolve(process.argv[2]) : undefined;
if (!directory) {
	console.error('usage: node test/onyx/lab/analyze-energy.mts <results directory> [--idle-watts <w>]');
	process.exit(2);
}
const idleFlag = process.argv.indexOf('--idle-watts');
const idleWatts = idleFlag === -1 ? undefined : Number(process.argv[idleFlag + 1]);
const estimators: { seededRandom(seed: number): () => number } = await import(out('vs/workbench/contrib/onyx/common/onyxAttribution.js'));

interface IRecord { readonly unit: string; readonly model: string; readonly task: string; readonly outcome: string; readonly durationMs: number; readonly finishedAt?: number; readonly requests?: readonly { readonly completionTokens: number | null; readonly tokensPerSecond: number | null }[] }
interface IPower { readonly at: number; readonly count: number; readonly accumulatedLoad: number }
const lines = <T,>(file: string): T[] => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(line => line.trim()).map(line => JSON.parse(line)) : [];
const records = lines<IRecord>(path.join(directory, 'traces', 'records.jsonl')).filter(record => record.outcome === 'attempted' && typeof record.finishedAt === 'number');
const success = new Map(lines<{ unit: string; success: boolean | null }>(path.join(directory, 'results.jsonl')).map(result => [result.unit, result.success === true]));
const power = lines<IPower>(path.join(directory, 'traces', 'power.jsonl')).sort((left, right) => left.at - right.at);
const manifest: { hypotheses?: string[] } = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));

/** Millijoules between two moments, with each refresh interval's energy spread evenly over its wall time; and the energy of the intervals at the two ends. */
function energyBetween(start: number, end: number): { millijoules: number; boundary: number; covered: boolean } {
	let millijoules = 0;
	let boundary = 0;
	let covered = power.length > 1 && power[0].at <= start && power.at(-1)!.at >= end;
	for (let index = 1; index < power.length; index++) {
		const from = power[index - 1].at;
		const to = power[index].at;
		const overlap = Math.min(end, to) - Math.max(start, from);
		if (overlap <= 0 || to <= from) {
			continue;
		}
		const interval = power[index].accumulatedLoad - power[index - 1].accumulatedLoad;
		if (interval < 0) {
			covered = false;
			continue;
		}
		millijoules += interval * overlap / (to - from);
		if (overlap < to - from) {
			boundary += interval;
		}
	}
	return { millijoules, boundary, covered };
}

const models = [...new Set(records.map(record => record.model))];
const perModel = models.map(model => {
	const mine = records.filter(record => record.model === model);
	const start = Math.min(...mine.map(record => record.finishedAt! - record.durationMs));
	const end = Math.max(...mine.map(record => record.finishedAt!));
	const block = energyBetween(start, end);
	const busyMs = mine.reduce((sum, record) => sum + record.durationMs, 0);
	const joules = block.millijoules / 1000;
	const solved = mine.filter(record => success.get(record.unit)).length;
	const tokens = mine.reduce((sum, record) => sum + (record.requests?.[0]?.completionTokens ?? 0), 0);
	const speeds = mine.map(record => record.requests?.[0]?.tokensPerSecond).filter((value): value is number => typeof value === 'number');
	// A task's energy: its share of the block's energy by time.
	const taskJoules = new Map<string, { joules: number; solved: number; attempts: number }>();
	for (const record of mine) {
		const entry = taskJoules.get(record.task) ?? { joules: 0, solved: 0, attempts: 0 };
		entry.joules += joules * record.durationMs / busyMs;
		entry.solved += success.get(record.unit) ? 1 : 0;
		entry.attempts++;
		taskJoules.set(record.task, entry);
	}
	const net = idleWatts === undefined ? null : joules - idleWatts * (end - start) / 1000;
	return {
		model, attempts: mine.length, solved, blockSeconds: Math.round((end - start) / 1000), powerLogCoversTheBlock: block.covered,
		joules: Math.round(joules), boundaryJoules: Math.round(block.boundary / 1000), meanWatts: Math.round(joules / ((end - start) / 1000) * 10) / 10,
		joulesPerAttempt: Math.round(joules / mine.length), joulesPerSolvedTask: solved ? Math.round(joules / solved) : null,
		joulesNetOfIdle: net === null ? null : Math.round(net), joulesNetOfIdlePerSolvedTask: net === null || !solved ? null : Math.round(net / solved),
		completionTokens: tokens, joulesPerThousandTokens: tokens ? Math.round(joules / tokens * 1000) : null,
		tokensPerSecond: speeds.length ? Math.round(speeds.reduce((sum, value) => sum + value, 0) / speeds.length * 10) / 10 : null,
		taskJoules,
	};
});

// Rankings: the best by energy per solved task spends least; the best by speed generates fastest.
const ranked = perModel.filter(entry => entry.joulesPerSolvedTask !== null && entry.tokensPerSecond !== null);
const byEnergy = [...ranked].sort((left, right) => left.joulesPerSolvedTask! - right.joulesPerSolvedTask!).map(entry => entry.model);
const bySpeed = [...ranked].sort((left, right) => right.tokensPerSecond! - left.tokensPerSecond!).map(entry => entry.model);
const swaps: { pair: [string, string]; joulesPerSolvedTaskDifference: { value: number; low: number; high: number } }[] = [];
for (let index = 0; index + 1 < bySpeed.length; index++) {
	const [faster, slower] = [bySpeed[index], bySpeed[index + 1]];
	if (byEnergy.indexOf(faster) < byEnergy.indexOf(slower)) {
		continue;
	}
	// The faster model spends more energy a solved task than the slower one: a swap. Its size, resampling tasks.
	const a = perModel.find(entry => entry.model === faster)!;
	const b = perModel.find(entry => entry.model === slower)!;
	const taskIds = [...new Set([...a.taskJoules.keys(), ...b.taskJoules.keys()])];
	const difference = (ids: readonly string[]) => {
		const total = (entry: typeof a) => ids.reduce((sum, id) => ({ joules: sum.joules + (entry.taskJoules.get(id)?.joules ?? 0), solved: sum.solved + (entry.taskJoules.get(id)?.solved ?? 0) }), { joules: 0, solved: 0 });
		const [ta, tb] = [total(a), total(b)];
		return ta.solved && tb.solved ? ta.joules / ta.solved - tb.joules / tb.solved : Number.NaN;
	};
	const random = estimators.seededRandom(1);
	const samples: number[] = [];
	for (let resample = 0; resample < 2000; resample++) {
		const value = difference(taskIds.map(() => taskIds[Math.floor(random() * taskIds.length)]));
		if (!Number.isNaN(value)) {
			samples.push(value);
		}
	}
	samples.sort((left, right) => left - right);
	const at = (fraction: number) => samples.length ? samples[Math.round((samples.length - 1) * fraction)] : Number.NaN;
	swaps.push({ pair: [faster, slower], joulesPerSolvedTaskDifference: { value: Math.round(difference(taskIds)), low: Math.round(at(0.025)), high: Math.round(at(0.975)) } });
}
const decisive = swaps.filter(swap => swap.joulesPerSolvedTaskDifference.low > 0 || swap.joulesPerSolvedTaskDifference.high < 0);
const outcome = power.length < 2 ? 'unavailable on this hardware' : ranked.length < 2 ? 'inconclusive' : decisive.length > 0 ? 'supported' : swaps.length === 0 ? 'refuted' : 'inconclusive';
const result = {
	records: records.length,
	powerRefreshes: power.length,
	idleWatts: idleWatts ?? null,
	models: perModel.map(({ taskJoules, ...rest }) => ({ ...rest, tasksSolvedAtLeastOnce: [...taskJoules.values()].filter(task => task.solved > 0).length })),
	modelsWithASolvedTask: ranked.length,
	rankingByJoulesPerSolvedTask: byEnergy,
	rankingByTokensPerSecond: bySpeed,
	swaps,
	method: 'See the head of test/onyx/lab/analyze-energy.mts and the probe output beside this file.',
};
fs.writeFileSync(path.join(directory, 'energy.json'), JSON.stringify(result, undefined, '\t') + '\n');
for (const entry of result.models) {
	console.log(`${entry.model}: ${entry.joules} J over ${entry.blockSeconds} s (±${entry.boundaryJoules} J at the ends), ${entry.solved} solved of ${entry.attempts}; ${entry.joulesPerSolvedTask ?? 'no'} J a solved task, ${entry.joulesPerAttempt} J an attempt, ${entry.tokensPerSecond} tokens/s`);
}
if (manifest.hypotheses?.includes('H-10')) {
	fs.writeFileSync(path.join(directory, 'outcome-H-10.json'), JSON.stringify({
		hypothesis: 'H-10',
		statement: 'Energy per solved task ranks models differently from tokens per second',
		outcome,
		number: ranked.length < 2 ? `${ranked.length} of ${perModel.length} models solved a task, so the rankings cannot be compared; energy an attempt: ${result.models.map(entry => `${entry.model} ${entry.joulesPerAttempt} J`).join(', ')}` : `by energy a solved task: ${byEnergy.join(' < ')}; by tokens a second: ${bySpeed.join(' > ')}; ${swaps.length} adjacent swaps, ${decisive.length} with an interval that excludes 0`,
		thresholds: 'Supported: at least one swap whose energy difference\'s interval excludes 0. Refuted: identical rankings. Inconclusive otherwise, and when fewer than two models solved a task. Unavailable on this hardware: no telemetry without elevated privileges (PREREGISTRATION.md, H-10 and its amendments).',
		decidedFrom: ['energy.json', 'traces/power.jsonl', 'traces/records.jsonl', 'results.jsonl'],
		regenerate: `node test/onyx/lab/analyze-energy.mts docs/research/results/${path.basename(directory)}${idleWatts === undefined ? '' : ` --idle-watts ${idleWatts}`}`,
	}, undefined, '\t') + '\n');
	console.log(`H-10: ${outcome}`);
}
