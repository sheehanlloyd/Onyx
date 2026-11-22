/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * R-50 (L10, Section 10), the node layer. Lab code makes no outbound
 * request: a campaign run under the network guard leaves an empty log, the
 * guard is shown to refuse and record a connection that is not to this
 * machine, and the launcher does not take a runtime elsewhere. A user's
 * requests become tasks only with the workspace's opt-in, and only when
 * accepted and committed. A task set from history holds ids and hashes and
 * labels each task's holdout. The pure rules are `onyxLabTasks.test.ts`;
 * the sandbox is `onyxOracle.test.ts`.
 *
 *   node --test test/onyx/checks/r50-lab-tasks.test.mts
 *
 * It needs compiled output (`pnpm run transpile-client`).
 */

import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { git, repoRoot, seedRepository, startMock, writeCampaign } from '../lab/mock-campaign.mts';

const lab = (name: string) => path.join(repoRoot, 'test', 'onyx', 'lab', name);
const guard = pathToFileURL(lab('network-guard.mts')).href;

test('R-50: a campaign under the network guard makes no outbound request; the guard refuses and records one that is not to this machine; a runtime elsewhere is not a campaign', async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onyx-r50-'));
	const mock = await startMock();
	try {
		const repository = seedRepository(dir, ['Mark the first sum', 'Mark the second sum']);
		const manifest = writeCampaign(path.join(dir, 'results'), '2026-11-22-r50-guarded', { tier: 'S', baseUrl: mock.baseUrl, models: ['mock-coder:7b'], tasks: repository.tasks });
		const log = path.join(dir, 'guard.log');
		const run = spawnSync(process.execPath, ['--import', guard, lab('run-lab.mts'), manifest, '--repo', repository.dir], { encoding: 'utf8', env: { ...process.env, ONYX_NETWORK_GUARD_LOG: log } });
		const summary: { finishedUnits: number; rows: { succeeded: number }[] } = JSON.parse(fs.readFileSync(path.join(path.dirname(manifest), 'summary.json'), 'utf8'));
		// Not vacuous: the same guard, and a request to an address reserved for documentation, which is never sent.
		const probeLog = path.join(dir, 'probe.log');
		const probe = spawnSync(process.execPath, ['--import', guard, '-e', 'fetch("http://192.0.2.1:8080/").then(() => process.exit(0), error => { console.log(String(error.cause?.message ?? error.message)); process.exit(7); })'], { encoding: 'utf8', env: { ...process.env, ONYX_NETWORK_GUARD_LOG: probeLog } });
		// A manifest that names a runtime on another machine.
		const elsewhere = writeCampaign(path.join(dir, 'results'), '2026-11-22-r50-elsewhere', { tier: 'S', baseUrl: 'http://192.0.2.1:11434/v1', models: ['mock-coder:7b'], tasks: repository.tasks });
		const refused = spawnSync(process.execPath, ['--import', guard, lab('run-lab.mts'), elsewhere, '--repo', repository.dir], { encoding: 'utf8', env: { ...process.env, ONYX_NETWORK_GUARD_LOG: log } });
		assert.deepStrictEqual({
			campaignExit: run.status,
			campaignRan: [summary.finishedUnits, summary.rows[0].succeeded],
			outboundAttempts: fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '',
			guardRefused: probe.status,
			guardSaid: /network guard: a connection to 192\.0\.2\.1:8080 was refused/.test(probe.stdout),
			guardRecorded: fs.existsSync(probeLog) ? fs.readFileSync(probeLog, 'utf8').trim() : '',
			runtimeElsewhere: [refused.status !== 0, /does not match|only to a runtime on this machine/.test(refused.stderr)],
			nothingWrittenForIt: fs.existsSync(path.join(path.dirname(elsewhere), 'traces', 'records.jsonl')),
		}, {
			campaignExit: 0,
			campaignRan: [2, 2],
			outboundAttempts: '',
			guardRefused: 7,
			guardSaid: true,
			guardRecorded: '192.0.2.1:8080',
			runtimeElsewhere: [true, true],
			nothingWrittenForIt: false,
		});
	} finally {
		mock.stop();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test('R-50: requests become tasks only with the opt-in, and only when accepted and committed; a base that is gone is skipped and counted', async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onyx-r50-'));
	try {
		const repository = seedRepository(dir, ['Mark the first sum', 'Mark the second sum']);
		const base = git(repository.dir, 'rev-list', '--max-parents=0', 'HEAD').trim();
		const { addedLineDigests }: { addedLineDigests(lines: readonly string[]): string[] } = await import(pathToFileURL(path.join(repoRoot, 'out', 'vs', 'workbench', 'contrib', 'onyx', 'common', 'onyxLabTasks.js')).href);
		const journal = path.join(dir, 'journal', 'runs');
		fs.mkdirSync(journal, { recursive: true });
		const run = (name: string, request: string, head: string, file: string, added: string[] | undefined) => fs.writeFileSync(path.join(journal, `${name}.jsonl`), [
			{ t: 0, kind: 'promptSnapshot', data: { messages: [{ role: 0, content: [{ type: 'text', value: 'system' }] }, { role: 1, content: [{ type: 'text', value: request }] }] } },
			{ t: 1, kind: 'promptSnapshot', data: { resumeMeta: { head } } },
			...(added ? [{ t: 9, kind: 'acceptance', data: { kind: 'acceptance', path: file, hunk: 'g1-h0', added: addedLineDigests(added) } }] : []),
		].map(event => JSON.stringify(event)).join('\n') + '\n');
		run('run-1-committed', 'Mark the sum in f0 as edited', base, 'src/f0.ts', ['\treturn a + b + 0; // edited-by-mock']);
		run('run-2-never-committed', 'Rename the function', base, 'src/f1.ts', ['export function renamed(a: number, b: number): number {']);
		run('run-3-not-accepted', 'Explain this file', base, 'src/f1.ts', undefined);
		run('run-4-base-gone', 'Mark the other sum', '0123456789abcdef0123456789abcdef01234567', 'src/f1.ts', ['\treturn a + b + 1; // edited-by-mock']);
		const cli = (...args: string[]) => JSON.parse(spawnSync(process.execPath, [lab('request-tasks.mts'), '--journal', journal, '--repo', repository.dir, ...args], { encoding: 'utf8' }).stdout);
		const outPath = path.join(dir, 'request-tasks.json');
		const optedIn = cli('--opt-in', '--out', outPath);
		const written: { tasks: { commit: string; base: string; file: string; instruction?: string }[] } = JSON.parse(fs.readFileSync(outPath, 'utf8'));
		assert.deepStrictEqual({
			optedIn,
			theTask: written.tasks.map(task => [task.commit === repository.tasks[0].commit, task.base === base, task.file, task.instruction]),
			withoutTheOptIn: cli(),
		}, {
			optedIn: { optedIn: true, requests: 4, tasks: 1, skipped: { 'no-request-text': 0, 'nothing-accepted': 1, 'base-unreachable': 1, 'never-committed': 1 } },
			// The file that is written holds no text of the user's unless asked for.
			theTask: [[true, true, 'src/f0.ts', undefined]],
			withoutTheOptIn: { optedIn: false, requests: 0, tasks: 0, skipped: { 'no-request-text': 0, 'nothing-accepted': 0, 'base-unreachable': 0, 'never-committed': 0 } },
		});
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test('R-50: a task set from history holds ids and hashes, never content, labels each task\'s holdout by the models\' publication, and pairs a commit with the test it changed', () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onyx-r50-'));
	try {
		const repository = seedRepository(dir, ['Too small a change to be a task']);
		// A commit of one source file, and one that changes a source file and its test together.
		fs.writeFileSync(path.join(repository.dir, 'src', 'f0.ts'), 'export function f0(a: number, b: number): number {\n\t// The sum of both,\n\t// and of the number of the file,\n\t// and nothing else.\n\treturn a + b + 0; // edited-by-mock\n}\n');
		git(repository.dir, 'add', '-A');
		git(repository.dir, 'commit', '--quiet', '-m', 'Say what f0 returns');
		fs.mkdirSync(path.join(repository.dir, 'test'), { recursive: true });
		fs.writeFileSync(path.join(repository.dir, 'src', 'f0.ts'), 'export function f0(a: number, b: number): number {\n\tconst sum = a + b;\n\tconst result = sum;\n\treturn result; // edited-by-mock\n}\n');
		fs.writeFileSync(path.join(repository.dir, 'test', 'f0.test.ts'), 'import { f0 } from "../src/f0";\nif (f0(1, 2) !== 3) {\n\tthrow new Error("f0");\n}\n');
		git(repository.dir, 'add', '-A');
		git(repository.dir, 'commit', '--quiet', '-m', 'Compute the sum once, with its test');
		const build = (name: string, ...args: string[]) => {
			const outPath = path.join(dir, name);
			const result = spawnSync(process.execPath, [lab('make-task-set.mts'), '--out', outPath, '--count', '10', '--repo', repository.dir, ...args], { encoding: 'utf8' });
			return { status: result.status, text: fs.existsSync(outPath) ? fs.readFileSync(outPath, 'utf8') : '', set: fs.existsSync(outPath) ? JSON.parse(fs.readFileSync(outPath, 'utf8')) as { hash: string; counts: object; tasks: { commit: string; file: string; holdout: string; source: string; testFile?: string; beforeHash: string }[] } : undefined };
		};
		const dated = build('dated.json', '--model', 'qwen2.5-coder:7b', '--model', 'llama3.2:3b', '--with-tests');
		const undated = build('undated.json', '--model', 'qwen2.5-coder:14b');
		const future = build('future.json', '--published', '2999-01-01');
		assert.deepStrictEqual({
			status: [dated.status, undated.status, future.status],
			// The two commits were made in the same second; the one with a test is listed first here.
			tasks: dated.set?.tasks.map(task => [task.file, task.source, task.holdout, task.testFile ?? null]).sort((left, right) => (right[3] ? 1 : 0) - (left[3] ? 1 : 0)),
			counts: dated.set?.counts,
			noContent: !/edited-by-mock|return a \+ b/.test(dated.text) && dated.set?.tasks.every(task => /^[0-9a-f]{64}$/.test(task.beforeHash)),
			aModelWithNoDate: [...new Set(undated.set?.tasks.map(task => task.holdout))],
			nothingIsLaterThanTheFuture: future.set?.tasks.length,
		}, {
			status: [0, 0, 0],
			tasks: [['src/f0.ts', 'history', 'held-out', 'test/f0.test.ts'], ['src/f0.ts', 'history', 'held-out', null]],
			counts: { total: 2, bySource: { history: 2, request: 0 }, byHoldout: { 'held-out': 2, 'not-held-out': 0, unknown: 0 }, withTests: 1 },
			noContent: true,
			aModelWithNoDate: ['unknown'],
			nothingIsLaterThanTheFuture: 0,
		});
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
