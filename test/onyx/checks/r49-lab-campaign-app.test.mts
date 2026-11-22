/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * R-49 (L9, Section 10), the application layer: a tier A campaign against
 * the mock runtime. The launcher starts the application on a linked
 * worktree of a disposable repository, and the engine inside it runs each
 * unit through the real agent loop. Checked here: the run reads and stages
 * an edit and the staged file is what the record holds; a command the model
 * asks for is denied by policy and counted, and the task is blocked, not
 * failed; a model the runtime cannot serve is counted apart; a cancel
 * during a task ends the campaign and leaves no record of that task; the
 * repository's files, index, HEAD and refs are what they were; the
 * worktree is gone.
 *
 *   node --test test/onyx/checks/r49-lab-campaign-app.test.mts
 *
 * It opens a window, and needs a display and a compiled application
 * (`pnpm run compile`, or `transpile-client` over a tree whose built-in
 * extensions are compiled).
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
const read = <T,>(file: string): T[] => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
const treeHash = (dir: string) => crypto.createHash('sha256').update(git(dir, 'status', '--porcelain=v1')).update(fs.readFileSync(path.join(dir, '.git', 'index'))).update(git(dir, 'for-each-ref')).update(git(dir, 'rev-parse', 'HEAD')).digest('hex');
// Every switch a campaign compares is named: a configuration left to be derived follows the model's profile,
// which the application updates as it measures the model, so two units of one campaign could differ.
const configurations = [
	{ name: 'default', hash: '00000000', configuration: { toolCallProtocol: 'repaired-text' } },
	{ name: 'no-line-numbers', hash: '00000000', configuration: { toolCallProtocol: 'repaired-text', readToolLineNumbering: false } },
];

interface IRecord { unit: string; model: string; configuration: string; task: string; outcome: string; reply: string | null; deniedCommands: number; harnessHash: string | null; edits: { ok: boolean; blocks: { search: string }[] }[]; events: { kind: string; data: { source?: string; decision?: string; seed?: { requested: number | null; honoured: boolean | string } } }[] }

test('R-49: a tier A campaign runs the agent loop on a worktree, denies and counts commands, tells an unservable model apart, and leaves the repository as it was', async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onyx-r49-app-'));
	const mock = await startMock({ ONYX_MOCK_UNSERVABLE: '1' });
	try {
		const repository = seedRepository(dir, ['READEDITTEST src/f0.ts', 'TERMTEST echo campaign']);
		const before = treeHash(repository.dir);
		const manifest = writeCampaign(path.join(dir, 'results'), '2026-11-22-r49-tier-a', { tier: 'A', baseUrl: mock.baseUrl, models: ['mock-coder:7b', 'mock-unservable:1b'], tasks: repository.tasks, seeds: [7], configurations, unitTimeoutMs: 120_000 });
		const out = path.dirname(manifest);
		const run = spawnSync(process.execPath, [launcher, manifest, '--repo', repository.dir], { encoding: 'utf8', timeout: 15 * 60_000 });
		const records = read<IRecord>(path.join(out, 'traces', 'records.jsonl'));
		const results = read<{ unit: string; outcome: string; score: number | null; success: boolean | null }>(path.join(out, 'results.jsonl'));
		const campaign: { complete: boolean; repository: { unchanged: boolean }; sessions: { notes: string[]; application?: { root: string } }[] } = JSON.parse(fs.readFileSync(path.join(out, 'campaign.json'), 'utf8'));
		const served = records.filter(record => record.model === 'mock-coder:7b');
		const edit = served.find(record => record.task === 't0' && record.configuration === 'default');
		const command = served.find(record => record.task === 't1' && record.configuration === 'default');
		const resident: { maxResident: number } = await mock.debug('/debug/resident') as never;
		// What the runtime was sent, not what the trace says was sent: the last requests the mock received.
		const wire: { seed?: number; temperature?: number }[] = await mock.debug('/debug/recent-chats') as never;
		assert.deepStrictEqual({
			exit: run.status,
			units: records.length,
			outcomes: Object.fromEntries(records.map(record => [record.unit, record.outcome])),
			theStagedFileIsTheRecord: edit?.reply === fs.readFileSync(path.join(repository.dir, 'src', 'f0.ts'), 'utf8'),
			theEditAsItWasSent: edit?.edits.map(attempt => [attempt.ok, attempt.blocks[0].search]),
			scores: Object.fromEntries(results.map(result => [result.unit, [result.score, result.success]])),
			commandDeniedByPolicy: command?.events.filter(event => event.kind === 'approval').map(event => [event.data.decision, event.data.source]),
			commandsCounted: command?.deniedCommands,
			// The campaign's seed and temperature reached the runtime on every request, and the runtime's echo of the seed is in the trace.
			samplingOnTheWire: [wire.length > 0, [...new Set(wire.map(body => `${body.seed}/${body.temperature}`))]],
			theTraceSaysTheSeedWasHonoured: edit?.events.filter(event => event.kind === 'traceTurn').map(event => [event.data.seed?.requested, event.data.seed?.honoured]),
			twoConfigurationsTwoHashes: new Set(served.map(record => record.harnessHash)).size,
			complete: campaign.complete,
			// Which build the application ran from is on record: the checkout, or a frozen copy when one was asked for.
			applicationOnRecord: campaign.sessions.at(-1)?.application?.root === (process.env.ONYX_LAB_APP_ROOT ? 'a frozen copy of the compiled output' : 'the checkout itself'),
			oneModelResident: resident.maxResident,
			worktreeRemoved: campaign.sessions.at(-1)?.notes.includes('worktree removed: true'),
			noWorktreeLeftInTheRepository: git(repository.dir, 'worktree', 'list', '--porcelain').split('\n').filter(line => line.startsWith('worktree ')).length,
			repositoryUnchangedByItsOwnAccount: campaign.repository.unchanged,
			repositoryUnchangedByThisTest: treeHash(repository.dir) === before,
		}, {
			exit: 0,
			units: 8,
			outcomes: {
				'mock-coder:7b|default|t0|s7|r1': 'attempted', 'mock-coder:7b|no-line-numbers|t0|s7|r1': 'attempted',
				'mock-coder:7b|default|t1|s7|r1': 'blocked-by-policy', 'mock-coder:7b|no-line-numbers|t1|s7|r1': 'blocked-by-policy',
				'mock-unservable:1b|default|t0|s7|r1': 'could-not-serve', 'mock-unservable:1b|no-line-numbers|t0|s7|r1': 'could-not-serve',
				'mock-unservable:1b|default|t1|s7|r1': 'could-not-serve', 'mock-unservable:1b|no-line-numbers|t1|s7|r1': 'could-not-serve',
			},
			theStagedFileIsTheRecord: true,
			theEditAsItWasSent: [[true, '\treturn a + b + 0;']],
			scores: {
				'mock-coder:7b|default|t0|s7|r1': [1, true], 'mock-coder:7b|no-line-numbers|t0|s7|r1': [1, true],
				'mock-coder:7b|default|t1|s7|r1': [null, null], 'mock-coder:7b|no-line-numbers|t1|s7|r1': [null, null],
				'mock-unservable:1b|default|t0|s7|r1': [null, null], 'mock-unservable:1b|no-line-numbers|t0|s7|r1': [null, null],
				'mock-unservable:1b|default|t1|s7|r1': [null, null], 'mock-unservable:1b|no-line-numbers|t1|s7|r1': [null, null],
			},
			commandDeniedByPolicy: [['deny', 'campaign-policy']],
			commandsCounted: 1,
			samplingOnTheWire: [true, ['7/0']],
			// Three turns: the read, the edit, and the answer that ends the run.
			theTraceSaysTheSeedWasHonoured: [[7, true], [7, true], [7, true]],
			twoConfigurationsTwoHashes: 2,
			complete: true,
			applicationOnRecord: true,
			oneModelResident: 1,
			worktreeRemoved: true,
			noWorktreeLeftInTheRepository: 1,
			repositoryUnchangedByItsOwnAccount: true,
			repositoryUnchangedByThisTest: true,
		});
	} finally {
		mock.stop();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test('R-49: a cancel during a tier A task ends the campaign, leaves no record of that task, and a later run resumes with it', async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onyx-r49-app-'));
	const mock = await startMock();
	try {
		// The second task streams for about twelve seconds before it would call a tool.
		const repository = seedRepository(dir, ['READEDITTEST src/f0.ts', 'SLOWTOOLTEST take your time', 'READEDITTEST src/f2.ts']);
		const before = treeHash(repository.dir);
		const manifest = writeCampaign(path.join(dir, 'results'), '2026-11-22-r49-cancel-a', { tier: 'A', baseUrl: mock.baseUrl, models: ['mock-coder:7b'], tasks: repository.tasks, unitTimeoutMs: 120_000 });
		const out = path.dirname(manifest);
		const recordsPath = path.join(out, 'traces', 'records.jsonl');
		const child = spawn(process.execPath, [launcher, manifest, '--repo', repository.dir], { stdio: 'ignore' });
		const exit = new Promise<number | null>(resolve => child.once('exit', code => resolve(code)));
		for (const deadline = Date.now() + 5 * 60_000; Date.now() < deadline && read(recordsPath).length < 1;) {
			await new Promise(resolve => setTimeout(resolve, 200));
		}
		// The slow task is in flight now.
		await new Promise(resolve => setTimeout(resolve, 3000));
		child.kill('SIGINT');
		const code = await exit;
		const afterCancel = read<IRecord>(recordsPath).map(record => record.task);
		const cancelled: { sessions: { ended: string; notes: string[] }[] } = JSON.parse(fs.readFileSync(path.join(out, 'campaign.json'), 'utf8'));
		const resumed = spawnSync(process.execPath, [launcher, manifest, '--repo', repository.dir], { encoding: 'utf8', timeout: 15 * 60_000 });
		assert.deepStrictEqual({
			cancelExit: code,
			recordsAfterCancel: afterCancel,
			ended: cancelled.sessions[0].ended,
			theApplicationStoppedTheRun: cancelled.sessions[0].notes.some(note => /last word was "cancelled"/.test(note)),
			worktreeRemovedAfterCancel: cancelled.sessions[0].notes.includes('worktree removed: true'),
			resumedExit: resumed.status,
			resumedAt: /3 units planned, 1 already finished/.test(resumed.stdout),
			tasksInTheEnd: read<IRecord>(recordsPath).map(record => record.task),
			repositoryUnchanged: treeHash(repository.dir) === before,
		}, {
			cancelExit: 130,
			recordsAfterCancel: ['t0'],
			ended: 'cancelled',
			theApplicationStoppedTheRun: true,
			worktreeRemovedAfterCancel: true,
			resumedExit: 0,
			resumedAt: true,
			tasksInTheEnd: ['t0', 't1', 't2'],
			repositoryUnchanged: true,
		});
	} finally {
		mock.stop();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
