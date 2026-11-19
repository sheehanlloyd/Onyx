/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * R-35 (A7, Section 11): a new failing TypeScript regression while the old
 * compiled output would pass; then the same after a source fix. Each run
 * refreshes `out/`, observes the new failure and then success, and records
 * the source revision and the build's completion.
 *
 * This is a procedure test. It writes a probe test file under the Onyx test
 * tree of THIS checkout, runs the unit-test runner through run-fresh.mts,
 * and removes the probe (source and compiled output) again. Run it from the
 * isolated checkout, never from a checkout with unrelated edits in flight.
 *
 *   node --test test/onyx/checks/r35-fresh-output.test.mts
 */

import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const freshRunner = path.join(repoRoot, 'test', 'onyx', 'run-fresh.mts');
const probeSource = path.join(repoRoot, 'src', 'vs', 'workbench', 'contrib', 'onyx', 'test', 'browser', 'onyxFreshOutputProbe.test.ts');
const probeOutput = path.join(repoRoot, 'out', 'vs', 'workbench', 'contrib', 'onyx', 'test', 'browser', 'onyxFreshOutputProbe.test.js');
const unitTest = [path.join(repoRoot, 'scripts', 'test.sh'), '--grep', 'OnyxFreshOutputProbe'];

function probe(expected: number): string {
	return [
		'/*---------------------------------------------------------------------------------------------',
		' *  Copyright (c) Microsoft Corporation. All rights reserved.',
		' *  Licensed under the MIT License. See License.txt in the project root for license information.',
		' *--------------------------------------------------------------------------------------------*/',
		'',
		'import assert from \'assert\';',
		'import { ensureNoDisposablesAreLeakedInTestSuite } from \'../../../../../base/test/common/utils.js\';',
		'',
		'suite(\'OnyxFreshOutputProbe\', () => {',
		'\tensureNoDisposablesAreLeakedInTestSuite();',
		'\ttest(\'R-35 probe\', () => {',
		`\t\tassert.strictEqual(1 + 1, ${expected});`,
		'\t});',
		'});',
		'',
	].join('\n');
}

function runFresh(jsonOut: string) {
	const result = spawnSync(process.execPath, [freshRunner, '--json-out', jsonOut, '--', ...unitTest], { cwd: repoRoot, encoding: 'utf8', env: process.env });
	const stamp = fs.existsSync(jsonOut) ? JSON.parse(fs.readFileSync(jsonOut, 'utf8')) : undefined;
	return { status: result.status, stamp, tail: (result.stdout + result.stderr).split('\n').slice(-12).join('\n') };
}

function runStale() {
	const result = spawnSync(unitTest[0], unitTest.slice(1), { cwd: repoRoot, encoding: 'utf8', env: process.env });
	return { status: result.status, passing: /(\d+) passing/.exec(result.stdout)?.[1] ?? '0' };
}

function cleanup() {
	fs.rmSync(probeSource, { force: true });
	fs.rmSync(probeOutput, { force: true });
	fs.rmSync(`${probeOutput}.map`, { force: true });
}

test('R-35: a new failing regression is observed only on fresh output, then passes after the source fix', { timeout: 10 * 60_000 }, () => {
	assert.equal(fs.existsSync(probeSource), false, `${probeSource} already exists; refusing to overwrite it`);
	const head = spawnSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
	const scratch = fs.mkdtempSync(path.join(repoRoot, 'out', 'r35-'));
	try {
		// 1. A new failing regression in source, with compiled output that predates it.
		fs.writeFileSync(probeSource, probe(3));
		const stale = runStale();
		const red = runFresh(path.join(scratch, 'red.json'));
		// 2. The source fix, refreshed again.
		fs.writeFileSync(probeSource, probe(2));
		const green = runFresh(path.join(scratch, 'green.json'));
		assert.deepStrictEqual({
			staleOutputWouldPass: { status: stale.status, probeTestsRun: stale.passing },
			red: { status: red.status === 0 ? 'zero' : 'non-zero', buildExit: red.stamp?.build.exitCode, runExit: red.stamp?.run.exitCode === 0 ? 'zero' : 'non-zero', revision: red.stamp?.revision, dirtyEntries: red.stamp?.dirtyEntries, completed: typeof red.stamp?.build.completedAt },
			green: { status: green.status, buildExit: green.stamp?.build.exitCode, runExit: green.stamp?.run.exitCode, revision: green.stamp?.revision, digestChanged: green.stamp?.dirtyDigest !== red.stamp?.dirtyDigest },
		}, {
			staleOutputWouldPass: { status: 0, probeTestsRun: '0' },
			red: { status: 'non-zero', buildExit: 0, runExit: 'non-zero', revision: head, dirtyEntries: 1, completed: 'string' },
			green: { status: 0, buildExit: 0, runExit: 0, revision: head, digestChanged: true },
		}, `red tail:\n${red.tail}\n\ngreen tail:\n${green.tail}`);
	} finally {
		cleanup();
		fs.rmSync(scratch, { recursive: true, force: true });
		// Leave out/ consistent with the tree the probe no longer belongs to.
		spawnSync(process.execPath, [freshRunner, '--stamp-only'], { cwd: repoRoot, stdio: 'ignore', env: process.env });
	}
});
