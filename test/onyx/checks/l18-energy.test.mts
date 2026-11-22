/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * L18: the energy analysis on a campaign whose power is known. Two models
 * run one after the other for ten minutes each, the first at 30 W and the
 * second at 60 W; the first is slower and solves more. The analysis has to
 * find the energy of each block from an accumulator read once a minute,
 * energy per solved task, and the swap between the two rankings.
 *
 *   node --test test/onyx/checks/l18-energy.test.mts
 */

import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

test('L18: energy per solved task from a once-a-minute accumulator, and a swap against tokens per second', () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onyx-l18-'));
	try {
		fs.mkdirSync(path.join(dir, 'traces'));
		const t0 = 1_800_000_000_000;
		// The accumulator, read every 60 s from two minutes before to two minutes after: 10 W idle, 30 W, 60 W, 10 W.
		const watts = (second: number) => second < 120 ? 10 : second < 720 ? 30 : second < 1320 ? 60 : 10;
		let accumulated = 0;
		const power = [{ at: t0, count: 0, accumulatedLoad: 0 }];
		for (let second = 1; second <= 1440; second++) {
			accumulated += watts(second - 1) * 1000;
			if (second % 60 === 0) {
				power.push({ at: t0 + second * 1000, count: second, accumulatedLoad: accumulated });
			}
		}
		const records: object[] = [];
		const results: object[] = [];
		const block = (model: string, startSecond: number, speed: number, solved: number) => {
			for (let task = 0; task < 10; task++) {
				const unit = `${model}|t${task}`;
				records.push({ unit, model, configuration: 'default', task: `t${task}`, seed: 1, repetition: 1, tier: 'S', outcome: 'attempted', reply: '', durationMs: 60_000, finishedAt: t0 + (startSecond + (task + 1) * 60) * 1000, requests: [{ completionTokens: speed * 60, tokensPerSecond: speed }] });
				results.push({ unit, success: task < solved });
			}
		};
		block('slow', 120, 10, 5);
		block('fast', 720, 40, 2);
		fs.writeFileSync(path.join(dir, 'traces', 'records.jsonl'), records.map(record => JSON.stringify(record)).join('\n') + '\n');
		fs.writeFileSync(path.join(dir, 'results.jsonl'), results.map(result => JSON.stringify(result)).join('\n') + '\n');
		fs.writeFileSync(path.join(dir, 'traces', 'power.jsonl'), power.map(reading => JSON.stringify(reading)).join('\n') + '\n');
		fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ hypotheses: ['H-10'] }));
		const run = spawnSync(process.execPath, [path.join(repoRoot, 'test', 'onyx', 'lab', 'analyze-energy.mts'), dir, '--idle-watts', '10'], { encoding: 'utf8' });
		const energy: { models: { model: string; joules: number; boundaryJoules: number; meanWatts: number; joulesPerSolvedTask: number; joulesPerAttempt: number; joulesNetOfIdle: number; tokensPerSecond: number }[]; rankingByJoulesPerSolvedTask: string[]; rankingByTokensPerSecond: string[]; swaps: { pair: string[]; joulesPerSolvedTaskDifference: { value: number; low: number; high: number } }[] } = JSON.parse(fs.readFileSync(path.join(dir, 'energy.json'), 'utf8'));
		const outcome: { outcome: string } = JSON.parse(fs.readFileSync(path.join(dir, 'outcome-H-10.json'), 'utf8'));
		const swap = energy.swaps[0];
		assert.deepStrictEqual({
			exit: run.status,
			// 600 s at 30 W and 600 s at 60 W; each block starts and ends on a reading, so nothing is split.
			models: energy.models.map(entry => [entry.model, entry.joules, entry.boundaryJoules, entry.meanWatts, entry.joulesPerSolvedTask, entry.joulesPerAttempt, entry.joulesNetOfIdle, entry.tokensPerSecond]),
			byEnergy: energy.rankingByJoulesPerSolvedTask,
			bySpeed: energy.rankingByTokensPerSecond,
			swap: [swap?.pair, swap?.joulesPerSolvedTaskDifference.value, swap?.joulesPerSolvedTaskDifference.low > 0],
			outcome: outcome.outcome,
		}, {
			exit: 0,
			models: [['slow', 18_000, 0, 30, 3600, 1800, 12_000, 10], ['fast', 36_000, 0, 60, 18_000, 3600, 30_000, 40]],
			byEnergy: ['slow', 'fast'],
			bySpeed: ['fast', 'slow'],
			swap: [['fast', 'slow'], 14_400, true],
			outcome: 'supported',
		}, `${run.stdout}${run.stderr}`);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
