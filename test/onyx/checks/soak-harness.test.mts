/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Self-checks of the soak harness (D8). On 2026-11-24 a soak's second suite
 * run stood still for 62 minutes and the soak recorded only "1 of 0 checks
 * failed", with the run's output thrown away. The soak now kills a run that
 * does not finish, counts it as failed, and keeps every run's output; these
 * checks hold it to that with stand-in suites, so they need no application.
 */

import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

interface ISoakSummary {
	readonly suiteRuns: number;
	readonly failedRuns: number;
	readonly passed: boolean;
	readonly iterations: { readonly exitCode: number | null; readonly result: string; readonly failures: string[]; readonly log: string }[];
}

/** Runs the soak for a few seconds against a stand-in application and the given stand-in suite. */
function soakWith(suiteSource: string, extraArgs: string[]): { summary: ISoakSummary; logs: string[]; seconds: number } {
	const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'onyx-soak-check-'));
	try {
		// A bundle whose executable only waits: it is the soak's idle instance.
		const app = path.join(scratch, 'Stand-in.app');
		fs.mkdirSync(path.join(app, 'Contents', 'MacOS'), { recursive: true });
		fs.mkdirSync(path.join(app, 'Contents', 'Resources', 'app'), { recursive: true });
		fs.writeFileSync(path.join(app, 'Contents', 'MacOS', 'stand-in'), '#!/bin/sh\nexec sleep 120\n', { mode: 0o755 });
		fs.writeFileSync(path.join(app, 'Contents', 'Resources', 'app', 'product.json'), JSON.stringify({ nameShort: 'Stand-in', commit: '0000000000000000' }));
		const suite = path.join(scratch, 'suite.mjs');
		fs.writeFileSync(suite, suiteSource);
		const logDir = path.join(scratch, 'logs');
		const jsonOut = path.join(scratch, 'soak.json');
		const began = Date.now();
		spawnSync(process.execPath, [path.join(repoRoot, 'test', 'onyx', 'run-soak.mts'), '--app', app, '--json-out', jsonOut, '--skip-campaign', '--log-dir', logDir, '--suite', suite, ...extraArgs], { cwd: repoRoot, encoding: 'utf8', timeout: 120_000 });
		const summary = JSON.parse(fs.readFileSync(jsonOut, 'utf8')) as ISoakSummary;
		const logs = fs.readdirSync(logDir).sort().map(name => fs.readFileSync(path.join(logDir, name), 'utf8'));
		return { summary, logs, seconds: (Date.now() - began) / 1000 };
	} finally {
		fs.rmSync(scratch, { recursive: true, force: true });
	}
}

test('D8: a suite run that never finishes is stopped, counted as failed and its output kept, and the soak still ends', () => {
	const { summary, logs, seconds } = soakWith(
		'console.log("run dir: stand-in"); console.error("stuck at the second driver command"); setInterval(() => { }, 1000);\n',
		['--minutes', '0.05', '--run-timeout', '0.05'],
	);
	assert.deepStrictEqual({
		suiteRuns: summary.suiteRuns,
		failedRuns: summary.failedRuns,
		passed: summary.passed,
		exitCode: summary.iterations[0].exitCode,
		result: summary.iterations[0].result,
		logKept: logs[0],
		endedWithinAMinute: seconds < 60,
	}, {
		suiteRuns: 1,
		failedRuns: 1,
		passed: false,
		exitCode: null,
		result: 'did not finish in 0.05 minutes',
		logKept: 'run dir: stand-in\nstuck at the second driver command\n',
		endedWithinAMinute: true,
	});
});

test('D8: the failing checks of a suite run are named in the soak\'s record', () => {
	const { summary } = soakWith(
		'console.log("  ✔ four runs were journaled"); console.log("  ✖ R-59: storing a note asked first"); console.log("1 of 2 checks failed"); process.exit(1);\n',
		['--minutes', '0.02'],
	);
	assert.deepStrictEqual({
		passed: summary.passed,
		result: summary.iterations[0].result,
		failures: summary.iterations[0].failures,
	}, {
		passed: false,
		result: '1 of 2 checks failed',
		failures: ['✖ R-59: storing a note asked first'],
	});
});
