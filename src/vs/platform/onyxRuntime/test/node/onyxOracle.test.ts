/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ChildProcess, spawn, SpawnOptions } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import { tmpdir } from 'os';
import { join } from '../../../../base/common/path.js';
import { isMacintosh } from '../../../../base/common/platform.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { failToPassVerdict } from '../../common/onyxOracle.js';
import { OnyxCommandRunner } from '../../node/onyxCommandRunner.js';
import { probeOracleSandbox, runOracleCommand } from '../../node/onyxOracle.js';

/**
 * L10, the node half of R-50 (DEC-10): the executable oracle's sandbox on
 * this machine. A script that tries the network and a write outside the
 * worktree is stopped at both; where no sandbox exists nothing is started
 * at all. The sandboxed tests need macOS, the one platform whose sandbox
 * Onyx uses; the refusal test runs everywhere.
 */
suite('OnyxOracle', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	(isMacintosh ? test : test.skip)('R-50: the probe sees the sandbox deny the network and a write outside the worktree, allow a write inside it, and reach its listener from outside', async () => {
		const probe = await probeOracleSandbox(new OnyxCommandRunner(), process.platform, tmpdir());
		assert.deepStrictEqual({
			available: probe.available,
			reason: probe.reason,
			steps: probe.steps.map(step => [step.what, step.exitCode === 0, step.observed]),
		}, {
			available: true,
			reason: undefined,
			steps: [
				['sandboxed-run', true, true],
				['network-outside-sandbox', true, true],
				['network-inside-sandbox', false, false],
				['write-outside-worktree', false, false],
				['write-inside-worktree', true, true],
			],
		});
	});

	(isMacintosh ? test : test.skip)('R-50: a verification script that tries the network and an out-of-tree write is blocked at both, and a fail-to-pass check still runs', async () => {
		const scratch = await fs.promises.realpath(await fs.promises.mkdtemp(join(tmpdir(), 'onyx-oracle-test-')));
		const worktree = join(scratch, 'worktree');
		const outside = join(scratch, 'outside.txt');
		await fs.promises.mkdir(worktree);
		let connections = 0;
		const server = net.createServer(socket => { connections++; socket.destroy(); });
		try {
			const port = await new Promise<number>(resolve => server.listen(0, '127.0.0.1', () => { const address = server.address(); resolve(typeof address === 'object' && address ? address.port : 0); }));
			// What model-written code could try: phone out, and write where it should not. Then the check itself.
			await fs.promises.writeFile(join(worktree, 'verify.sh'), [
				`/usr/bin/nc -z -w 2 127.0.0.1 ${port} && echo NETWORK-REACHED`,
				`echo leaked > "${outside}" 2>/dev/null && echo WROTE-OUTSIDE`,
				'echo scratch > "$TMPDIR/scratch.txt" && echo WROTE-TEMPORARY-FILE-INSIDE',
				'grep -q "return a + b" sum.js',
			].join('\n'));
			const runner = new OnyxCommandRunner();
			await fs.promises.writeFile(join(worktree, 'sum.js'), 'function sum(a, b) {\n\treturn a - b;\n}\n');
			const before = await runOracleCommand(runner, worktree, 'sh verify.sh', 20_000);
			await fs.promises.writeFile(join(worktree, 'sum.js'), 'function sum(a, b) {\n\treturn a + b;\n}\n');
			const after = await runOracleCommand(runner, worktree, 'sh verify.sh', 20_000);
			assert.deepStrictEqual({
				networkReached: /NETWORK-REACHED/.test(before.output + after.output),
				connectionsSeenByTheListener: connections,
				wroteOutside: /WROTE-OUTSIDE/.test(before.output + after.output),
				outsideFileExists: fs.existsSync(outside),
				wroteItsTemporaryFileInside: /WROTE-TEMPORARY-FILE-INSIDE/.test(after.output) && fs.existsSync(join(worktree, '.onyx-oracle', 'tmp', 'scratch.txt')),
				exitCodes: [before.exitCode, after.exitCode],
				verdict: failToPassVerdict(before.exitCode, after.exitCode),
				refusals: [before.refusal, after.refusal],
			}, {
				networkReached: false,
				connectionsSeenByTheListener: 0,
				wroteOutside: false,
				outsideFileExists: false,
				wroteItsTemporaryFileInside: true,
				exitCodes: [1, 0],
				verdict: 'fail-to-pass',
				refusals: [undefined, undefined],
			});
		} finally {
			server.close();
			await fs.promises.rm(scratch, { recursive: true, force: true });
		}
	});

	test('R-50: where no sandbox can be started the oracle is unavailable and nothing is run, sandboxed or not', async () => {
		const calls: string[] = [];
		const recording = (executable: string, args: readonly string[], options: SpawnOptions): ChildProcess => {
			calls.push(executable);
			return spawn(executable, args, options);
		};
		const scratch = await fs.promises.mkdtemp(join(tmpdir(), 'onyx-oracle-test-'));
		try {
			const outcomes: Record<string, unknown> = {};
			for (const platform of ['linux', 'win32'] as const) {
				const runner = new OnyxCommandRunner(platform, process.env, recording);
				const probe = await probeOracleSandbox(runner, platform, scratch);
				const run = await runOracleCommand(runner, scratch, 'echo should-not-run', 5000);
				outcomes[platform] = { available: probe.available, steps: probe.steps.length, refusal: run.refusal, output: run.output };
			}
			assert.deepStrictEqual({ outcomes, processesStarted: calls }, {
				outcomes: {
					linux: { available: false, steps: 0, refusal: 'sandbox-unavailable', output: '' },
					win32: { available: false, steps: 0, refusal: 'unsupported-platform', output: '' },
				},
				processesStarted: [],
			});
		} finally {
			await fs.promises.rm(scratch, { recursive: true, force: true });
		}
	});
});
