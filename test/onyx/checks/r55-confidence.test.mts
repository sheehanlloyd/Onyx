/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * R-55 (L16), the path the calibration study takes, against the mock: a
 * tier S campaign with three seeds that asks for token log-probabilities,
 * then the analysis. The launcher keeps each token with its
 * log-probability; every hunk of the first seed's reply is labelled, has
 * the agreement of the three samples and the least token probability of
 * its block; and with one class of hunk only, nothing is decided and no
 * badge ships.
 *
 *   node --test test/onyx/checks/r55-confidence.test.mts
 */

import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { repoRoot, seedRepository, startMock, writeCampaign } from '../lab/mock-campaign.mts';

test('R-55: a campaign that asks for log-probabilities keeps them, every hunk gets both estimates, and one class of hunk decides nothing and ships no badge', async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onyx-r55-'));
	const mock = await startMock();
	try {
		const repository = seedRepository(dir, ['Mark the first sum', 'Mark the second sum']);
		const manifest = writeCampaign(path.join(dir, 'results'), '2026-11-22-r55', { tier: 'S', baseUrl: mock.baseUrl, models: ['mock-coder:7b'], tasks: repository.tasks, seeds: [1, 2, 3], logprobs: true });
		const file = JSON.parse(fs.readFileSync(manifest, 'utf8'));
		fs.writeFileSync(manifest, JSON.stringify({ ...file, hypotheses: ['H-8'] }, undefined, '\t'));
		const out = path.dirname(manifest);
		const run = spawnSync(process.execPath, [path.join(repoRoot, 'test', 'onyx', 'lab', 'run-lab.mts'), manifest, '--repo', repository.dir], { encoding: 'utf8', timeout: 5 * 60_000 });
		const analyzed = spawnSync(process.execPath, [path.join(repoRoot, 'test', 'onyx', 'lab', 'analyze-confidence.mts'), out, '--repo', repository.dir], { encoding: 'utf8', timeout: 60_000 });
		const records: { reply: string; tokens?: [string, number][] }[] = fs.readFileSync(path.join(out, 'traces', 'records.jsonl'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
		const confidence: { labelledHunks: number; correctHunks: number; hunksWithoutATokenProbability: number; hunks: { agreement: number; samples: number; tokenProbability: number }[]; pooled: { estimator: string; decision: { outcome: string; badge: boolean } }[] } | undefined = fs.existsSync(path.join(out, 'confidence.json')) ? JSON.parse(fs.readFileSync(path.join(out, 'confidence.json'), 'utf8')) : undefined;
		const outcome: { outcome: string; badge: string } | undefined = fs.existsSync(path.join(out, 'outcome-H-8.json')) ? JSON.parse(fs.readFileSync(path.join(out, 'outcome-H-8.json'), 'utf8')) : undefined;
		// The mock gives a piece of n characters the log-probability -((n mod 5) + 1) / 10: the least possible is -0.5.
		const least = Math.min(...records[0].tokens!.map(token => token[1]));
		assert.deepStrictEqual({
			exits: [run.status, analyzed.status],
			records: records.length,
			everyRecordKeepsItsTokens: records.every(record => Array.isArray(record.tokens) && record.tokens.map(token => token[0]).join('') === record.reply),
			labelledHunks: confidence?.labelledHunks,
			correctHunks: confidence?.correctHunks,
			withoutATokenProbability: confidence?.hunksWithoutATokenProbability,
			agreement: confidence?.hunks.map(hunk => [hunk.agreement, hunk.samples]),
			tokenProbabilityIsTheLeastOfTheBlock: confidence?.hunks.every(hunk => hunk.tokenProbability > 0 && hunk.tokenProbability <= Math.exp(-0.1) && hunk.tokenProbability >= Math.exp(least) - 1e-12),
			decisions: confidence?.pooled.map(entry => [entry.estimator, entry.decision.outcome, entry.decision.badge]),
			outcome: [outcome?.outcome, outcome?.badge],
		}, {
			exits: [0, 0],
			records: 6,
			everyRecordKeepsItsTokens: true,
			labelledHunks: 2,
			correctHunks: 2,
			withoutATokenProbability: 0,
			agreement: [[1, 3], [1, 3]],
			tokenProbabilityIsTheLeastOfTheBlock: true,
			decisions: [['agreement', 'inconclusive', false], ['token-probability', 'inconclusive', false]],
			outcome: ['inconclusive', 'no badge ships'],
		}, `${run.stdout}${run.stderr}${analyzed.stdout}${analyzed.stderr}`);
	} finally {
		await mock.stop();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
