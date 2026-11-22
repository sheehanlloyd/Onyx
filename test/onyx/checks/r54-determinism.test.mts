/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * R-54 (L15, Section 10), the node half: the determinism measure on real
 * campaigns against the mock runtime. A tier A campaign runs each task
 * three times through the agent loop in the application. With the mock as
 * it is, every repetition is the same trajectory as the first. With the
 * mock told to answer differently every time at the third turn, every
 * repetition diverges at turn 3, the divergence is the runtime's, and none
 * is the harness's.
 *
 *   node --test test/onyx/checks/r54-determinism.test.mts
 *
 * It opens a window, and needs a display and a compiled application.
 */

import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { repoRoot, seedRepository, startMock, writeCampaign } from '../lab/mock-campaign.mts';

const launcher = path.join(repoRoot, 'test', 'onyx', 'lab', 'run-lab.mts');
const analysis = path.join(repoRoot, 'test', 'onyx', 'lab', 'analyze-determinism.mts');
const configurations = [{ name: 'default', hash: '00000000', configuration: { toolCallProtocol: 'repaired-text' } }];

interface IDeterminism { units: number; runs: number; multiTurnRuns: number; pooled: { comparisons: number; identical: number }; byModel: { firstDivergingTurn: number[]; bySource: Record<string, number>; unitsAllIdentical: number }[]; harnessDivergences: object[] }

async function campaign(env: Record<string, string>) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onyx-r54-'));
	const mock = await startMock(env);
	try {
		const repository = seedRepository(dir, ['READEDITTEST src/f0.ts', 'READEDITTEST src/f1.ts']);
		const manifest = writeCampaign(path.join(dir, 'results'), '2026-11-22-r54', { tier: 'A', baseUrl: mock.baseUrl, models: ['mock-coder:7b'], tasks: repository.tasks, seeds: [7], repetitions: 3, configurations, unitTimeoutMs: 120_000 });
		const run = spawnSync(process.execPath, [launcher, manifest, '--repo', repository.dir], { encoding: 'utf8', timeout: 15 * 60_000 });
		const analyzed = spawnSync(process.execPath, [analysis, path.dirname(manifest)], { encoding: 'utf8', timeout: 60_000 });
		const file = path.join(path.dirname(manifest), 'determinism.json');
		const measured: IDeterminism | undefined = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : undefined;
		return {
			campaignExit: run.status, analysisExit: analyzed.status, output: `${run.stdout}${run.stderr}${analyzed.stdout}${analyzed.stderr}`,
			units: measured?.units, runs: measured?.runs, multiTurnRuns: measured?.multiTurnRuns, comparisons: measured?.pooled.comparisons, identical: measured?.pooled.identical,
			unitsAllIdentical: measured?.byModel[0]?.unitsAllIdentical, firstDivergingTurn: measured?.byModel[0]?.firstDivergingTurn, bySource: measured?.byModel[0]?.bySource, harnessDivergences: measured?.harnessDivergences.length,
		};
	} finally {
		await mock.stop();
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

test('R-54: with a deterministic runtime every repetition of a tier A unit is the same trajectory; with one that varies at the third turn, every repetition diverges at turn 3 and the divergence is the runtime\'s', async () => {
	const deterministic = await campaign({});
	const varied = await campaign({ ONYX_MOCK_VARY_AFTER_TOOL_RESULTS: '2' });
	const { output: firstOutput, ...first } = deterministic;
	const { output: secondOutput, ...second } = varied;
	assert.deepStrictEqual({ deterministic: first, varied: second }, {
		deterministic: { campaignExit: 0, analysisExit: 0, units: 2, runs: 6, multiTurnRuns: 6, comparisons: 4, identical: 4, unitsAllIdentical: 2, firstDivergingTurn: [], bySource: { runtime: 0, harness: 0, length: 0 }, harnessDivergences: 0 },
		varied: { campaignExit: 0, analysisExit: 0, units: 2, runs: 6, multiTurnRuns: 6, comparisons: 4, identical: 0, unitsAllIdentical: 0, firstDivergingTurn: [0, 0, 4], bySource: { runtime: 4, harness: 0, length: 0 }, harnessDivergences: 0 },
	}, `${firstOutput}\n${secondOutput}`);
});
