/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * R-57 (A12): a gate file with a failing check, a missing check, a stale
 * build and a named baseline exception. Non-zero exit for the first three;
 * the exception prints as an expected failure and never as a pass; the
 * results file records the revision and the build evidence.
 *
 * The gate runner is pointed at disposable gate directories with `--gates`
 * and writes its results to a disposable `--out` directory. The stale-build
 * case uses the real stamp of this checkout: the test temporarily rewrites
 * `out/.onyx-fresh.json` to claim a different revision and restores it.
 *
 *   node --test test/onyx/checks/r57-module-gate.test.mts
 */

import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const gateRunner = path.join(repoRoot, 'test', 'onyx', 'run-module-gate.mts');
const stampPath = path.join(repoRoot, 'out', '.onyx-fresh.json');

interface IGateRun {
	readonly status: number | null;
	readonly stdout: string;
	readonly results?: { revision: string; build?: { command: string; exitCode: number; completedAt: string }; passed: boolean; refused?: string; results: { id: string; outcome: string; owner?: string }[] };
}

function runGate(gates: Record<string, unknown>, extraArgs: string[] = []): IGateRun {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onyx-r57-'));
	try {
		const gatesDir = path.join(dir, 'gates');
		const outDir = path.join(dir, 'out');
		fs.mkdirSync(gatesDir);
		for (const [name, content] of Object.entries(gates)) {
			fs.writeFileSync(path.join(gatesDir, name), JSON.stringify(content));
		}
		const result = spawnSync(process.execPath, [gateRunner, '--module', '1', '--gates', gatesDir, '--out', outDir, ...extraArgs], { cwd: repoRoot, encoding: 'utf8' });
		const resultsFile = path.join(outDir, 'gate-module-1.json');
		return { status: result.status, stdout: result.stdout + result.stderr, results: fs.existsSync(resultsFile) ? JSON.parse(fs.readFileSync(resultsFile, 'utf8')) : undefined };
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

const head = spawnSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();

test('R-57: the stamp of this checkout is fresh, so the gate runs (precondition for the cases below)', () => {
	assert.equal(fs.existsSync(stampPath), true, 'run `node test/onyx/run-fresh.mts --stamp-only` first');
	const run = runGate({ 'module-1.json': { module: 1, checks: [{ id: 'true', layer: 'node', command: ['true'] }] } });
	assert.deepStrictEqual({ status: run.status, passed: run.results?.passed, revision: run.results?.revision, buildCommand: run.results?.build?.command }, { status: 0, passed: true, revision: head, buildCommand: 'pnpm run transpile-client' }, run.stdout);
});

test('R-57: a failing check, a missing check and a named exception each report as themselves; only the first two block', () => {
	const run = runGate({
		'module-1.json': {
			module: 1,
			checks: [
				{ id: 'passes', layer: 'node', command: ['true'] },
				{ id: 'fails', layer: 'node', command: ['false'] },
				{ id: 'missing-command', layer: 'node', command: ['onyx-no-such-command-r57'] },
				{ id: 'missing-file', layer: 'procedure', files: ['test/onyx/checks/does-not-exist.test.mts'] },
				{ id: 'baseline-exception', layer: 'packaged', command: ['false'], expect: 'fail', owner: 'B1, B3', reason: 'missing read tools' },
			],
		},
	});
	const outcomes = Object.fromEntries((run.results?.results ?? []).map(result => [result.id, result.outcome]));
	assert.deepStrictEqual({
		status: run.status,
		passed: run.results?.passed,
		outcomes,
		exceptionPrintsAsExpectedFailure: /expected failure\s+baseline-exception/.test(run.stdout),
		exceptionNeverPrintsAsPass: !/ok\s+baseline-exception/.test(run.stdout),
		blockingNamed: ['fails', 'missing-command', 'missing-file'].every(id => run.stdout.includes(`blocking: ${id}`)),
		revision: run.results?.revision,
		buildRecorded: typeof run.results?.build?.completedAt,
	}, {
		status: 1,
		passed: false,
		outcomes: { passes: 'pass', fails: 'fail', 'missing-command': 'missing', 'missing-file': 'missing', 'baseline-exception': 'expected-failure' },
		exceptionPrintsAsExpectedFailure: true,
		exceptionNeverPrintsAsPass: true,
		blockingNamed: true,
		revision: head,
		buildRecorded: 'string',
	}, run.stdout);
});

test('R-57: a unit-test check that ran no test fails: a --grep that matches nothing exits 0 and proves nothing', () => {
	// Stand-ins for scripts/test.sh: the runner recognises a unit-test run by the script's name and `--grep`.
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onyx-r57-grep-'));
	try {
		const standIn = (name: string, output: string, exitCode = 0) => {
			const file = path.join(dir, name, 'test.sh');
			fs.mkdirSync(path.dirname(file));
			fs.writeFileSync(file, `#!/bin/sh\nprintf '%s\\n' ${JSON.stringify(output)}\nexit ${exitCode}\n`, { mode: 0o755 });
			return file;
		};
		const run = runGate({
			'module-1.json': {
				module: 1,
				checks: [
					{ id: 'matched', layer: 'unit', command: [standIn('matched', '  12 passing (3s)'), '--grep', 'OnyxReal'] },
					{ id: 'renamed-suite', layer: 'unit', command: [standIn('renamed', '  0 passing (1ms)'), '--grep', 'OnyxRenamed'] },
					{ id: 'printed-nothing', layer: 'unit', command: [standIn('silent', ''), '--grep', 'OnyxGone'] },
					{ id: 'only-pending', layer: 'unit', command: [standIn('pending', '  0 passing (1ms)\n  2 pending'), '--grep', 'OnyxSkipped'] },
					{ id: 'not-a-unit-run', layer: 'node', command: ['true', '--grep', 'anything'] },
				],
			},
		});
		const outcomes = Object.fromEntries((run.results?.results ?? []).map(result => [result.id, result.outcome]));
		assert.deepStrictEqual({ status: run.status, outcomes, saysWhy: run.stdout.includes('no test matched --grep OnyxRenamed') }, {
			status: 1,
			outcomes: { matched: 'pass', 'renamed-suite': 'fail', 'printed-nothing': 'fail', 'only-pending': 'fail', 'not-a-unit-run': 'pass' },
			saysWhy: true,
		}, run.stdout);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test('R-57: an exception that unexpectedly passes, or has no owner, blocks the gate', () => {
	const run = runGate({
		'module-1.json': {
			module: 1,
			checks: [
				{ id: 'resolved-exception', layer: 'node', command: ['true'], expect: 'fail', owner: 'B1' },
				{ id: 'unowned-exception', layer: 'node', command: ['false'], expect: 'fail' },
			],
		},
	});
	const outcomes = Object.fromEntries((run.results?.results ?? []).map(result => [result.id, result.outcome]));
	assert.deepStrictEqual({ status: run.status, outcomes, unownedNamed: run.stdout.includes('unowned-exception is an expected failure without an owner item') }, {
		status: 1,
		outcomes: { 'resolved-exception': 'unexpected-pass', 'unowned-exception': 'expected-failure' },
		unownedNamed: true,
	}, run.stdout);
});

test('R-57: a required check skipped for an unmet requirement blocks; a declared optional skip does not', () => {
	const run = runGate({
		'module-1.json': {
			module: 1,
			checks: [
				{ id: 'needs-env', layer: 'packaged', command: ['true'], requires: { env: ['ONYX_R57_UNSET_VARIABLE'] } },
				{ id: 'needs-other-platform', layer: 'packaged', command: ['true'], requires: { platform: 'r57-nowhere' }, skipAllowed: true },
			],
		},
	});
	const outcomes = Object.fromEntries((run.results?.results ?? []).map(result => [result.id, result.outcome]));
	assert.deepStrictEqual({ status: run.status, outcomes }, { status: 1, outcomes: { 'needs-env': 'unexpected-skip', 'needs-other-platform': 'skipped' } }, run.stdout);
});

test('R-57: a stale build is refused before any check runs, and the refusal is recorded', () => {
	const original = fs.readFileSync(stampPath, 'utf8');
	try {
		const stamp = JSON.parse(original);
		stamp.revision = '0000000000000000000000000000000000000000';
		fs.writeFileSync(stampPath, JSON.stringify(stamp));
		const run = runGate({ 'module-1.json': { module: 1, checks: [{ id: 'would-pass', layer: 'node', command: ['true'] }] } });
		assert.deepStrictEqual({
			status: run.status,
			refused: typeof run.results?.refused,
			checksRun: run.results?.results.length,
			passed: run.results?.passed,
			says: /refusing to run on stale output/.test(run.stdout),
		}, { status: 3, refused: 'string', checksRun: 0, passed: false, says: true }, run.stdout);
	} finally {
		fs.writeFileSync(stampPath, original);
	}
});

test('R-57: the gate of module n runs the checks of every earlier module too', () => {
	const run = runGate({
		'module-1.json': { module: 1, checks: [{ id: 'earlier', layer: 'node', command: ['true'] }] },
	}, []);
	assert.equal(run.results?.results.some(result => result.id === 'earlier'), true, run.stdout);
});
