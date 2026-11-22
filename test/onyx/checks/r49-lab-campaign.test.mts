/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * R-49 (L9, Section 10), the node layer: a tier S campaign against the mock
 * runtime, through the launcher as a user runs it. A campaign killed
 * mid-run resumes at the next unfinished unit; Ctrl+C cancels within two
 * seconds and the unit in flight leaves no record; a model the runtime
 * cannot serve is counted apart from failed attempts; one model is resident
 * at a time; the repository the tasks come from is left as it was. The
 * pure rules are `onyxLab.test.ts`; the application's half (tier A, the
 * worktree) is `r49-lab-campaign-app.test.mts`.
 *
 *   node --test test/onyx/checks/r49-lab-campaign.test.mts
 *
 * It needs compiled output (`pnpm run transpile-client`).
 */

import { strict as assert } from 'node:assert';
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { git, repoRoot, seedRepository, startMock, writeCampaign } from '../lab/mock-campaign.mts';

const launcher = path.join(repoRoot, 'test', 'onyx', 'lab', 'run-lab.mts');
const lines = (file: string): { unit: string; model: string; outcome: string }[] => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
const treeHash = (dir: string) => crypto.createHash('sha256').update(git(dir, 'status', '--porcelain=v1')).update(fs.readFileSync(path.join(dir, '.git', 'index'))).update(git(dir, 'for-each-ref')).update(git(dir, 'rev-parse', 'HEAD')).digest('hex');
async function until(condition: () => boolean, timeoutMs: number): Promise<boolean> {
	for (const deadline = Date.now() + timeoutMs; Date.now() < deadline;) {
		if (condition()) {
			return true;
		}
		await new Promise(resolve => setTimeout(resolve, 50));
	}
	return condition();
}

test('R-49: a tier S campaign that is killed resumes at the next unfinished unit, counts a model that could not be served apart, keeps one model resident, and leaves the repository as it was', async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onyx-r49-'));
	const mock = await startMock({ ONYX_MOCK_UNSERVABLE: '1', ONYX_MOCK_WORD_DELAY_MS: '60' });
	try {
		const repository = seedRepository(dir, ['Mark the first sum', 'Mark the second sum', 'Mark the third sum', 'Mark the fourth sum']);
		const before = treeHash(repository.dir);
		const manifest = writeCampaign(path.join(dir, 'results'), '2026-11-22-r49-tier-s', { tier: 'S', baseUrl: mock.baseUrl, models: ['mock-coder:7b', 'mock-unservable:1b', 'mock-coder:32b'], tasks: repository.tasks });
		const records = path.join(path.dirname(manifest), 'traces', 'records.jsonl');

		// Killed after its third record, with no chance to clean up.
		const first = spawn(process.execPath, [launcher, manifest, '--repo', repository.dir], { stdio: 'ignore' });
		assert.ok(await until(() => lines(records).length >= 3, 60_000), 'the campaign wrote three records');
		first.kill('SIGKILL');
		await new Promise(resolve => first.once('exit', resolve));
		const afterKill = lines(records).map(record => record.unit);

		const second = spawnSync(process.execPath, [launcher, manifest, '--repo', repository.dir], { encoding: 'utf8' });
		const all = lines(records);
		const results: { unit: string; outcome: string; score: number | null; success: boolean | null }[] = lines(path.join(path.dirname(manifest), 'results.jsonl')) as never;
		const campaign: { complete: boolean; repository: { unchanged: boolean }; sessions: { ended: string; evictions: { left?: string[] }[] }[] } = JSON.parse(fs.readFileSync(path.join(path.dirname(manifest), 'campaign.json'), 'utf8'));
		const resident: { maxResident: number; resident: string[] } = await mock.debug('/debug/resident') as never;
		assert.deepStrictEqual({
			resumedExit: second.status,
			saidHowManyWereDone: new RegExp(`12 units planned, ${afterKill.length} already finished`).test(second.stdout),
			unitsRunOnce: all.length === 12 && new Set(all.map(record => record.unit)).size === 12,
			theKilledRunsRecordsWereKept: afterKill.every((unit, index) => all[index].unit === unit),
			outcomesByModel: Object.fromEntries(['mock-coder:7b', 'mock-unservable:1b', 'mock-coder:32b'].map(model => [model, [...new Set(all.filter(record => record.model === model).map(record => record.outcome))]])),
			scores: [...new Set(results.map(result => `${result.outcome}:${result.score}:${result.success}`))].sort(),
			complete: campaign.complete,
			maxResident: resident.maxResident,
			residentAtTheEnd: resident.resident,
			everyEvictionLeftNothing: campaign.sessions.every(session => session.evictions.every(eviction => (eviction.left ?? []).length === 0)),
			repositoryUnchangedByItsOwnAccount: campaign.repository.unchanged,
			repositoryUnchangedByThisTest: treeHash(repository.dir) === before,
		}, {
			resumedExit: 0,
			saidHowManyWereDone: true,
			unitsRunOnce: true,
			theKilledRunsRecordsWereKept: true,
			outcomesByModel: { 'mock-coder:7b': ['attempted'], 'mock-unservable:1b': ['could-not-serve'], 'mock-coder:32b': ['attempted'] },
			scores: ['attempted:1:true', 'could-not-serve:null:null'],
			complete: true,
			maxResident: 1,
			residentAtTheEnd: [],
			everyEvictionLeftNothing: true,
			repositoryUnchangedByItsOwnAccount: true,
			repositoryUnchangedByThisTest: true,
		});
	} finally {
		mock.stop();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test('R-49: Ctrl+C cancels a tier S campaign within two seconds, and the unit in flight leaves no record', async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onyx-r49-'));
	// Slow enough that a unit is in flight for several seconds.
	const mock = await startMock({ ONYX_MOCK_WORD_DELAY_MS: '700' });
	try {
		const repository = seedRepository(dir, ['Mark the first sum', 'Mark the second sum', 'Mark the third sum']);
		const manifest = writeCampaign(path.join(dir, 'results'), '2026-11-22-r49-cancel', { tier: 'S', baseUrl: mock.baseUrl, models: ['mock-coder:7b'], tasks: repository.tasks });
		const records = path.join(path.dirname(manifest), 'traces', 'records.jsonl');
		const child = spawn(process.execPath, [launcher, manifest, '--repo', repository.dir], { stdio: 'ignore' });
		const exit = new Promise<number | null>(resolve => child.once('exit', code => resolve(code)));
		assert.ok(await until(() => lines(records).length >= 1, 60_000), 'the first unit finished');
		// The second unit is now in flight.
		await new Promise(resolve => setTimeout(resolve, 600));
		const stoppedAt = Date.now();
		child.kill('SIGINT');
		const code = await exit;
		const campaign: { complete: boolean; sessions: { ended: string }[] } = JSON.parse(fs.readFileSync(path.join(path.dirname(manifest), 'campaign.json'), 'utf8'));
		assert.deepStrictEqual({
			exit: code,
			withinTwoSeconds: Date.now() - stoppedAt < 2000,
			records: lines(records).length,
			ended: campaign.sessions[0].ended,
			complete: campaign.complete,
		}, { exit: 130, withinTwoSeconds: true, records: 1, ended: 'cancelled', complete: false });
	} finally {
		mock.stop();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
