/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as net from 'net';
import { join } from '../../../base/common/path.js';
import { interpretOracleProbe, IOnyxOracleProbe, IOnyxOracleProbeStep, oracleSandboxProfile, oracleUnsupportedProbe } from '../common/onyxOracle.js';
import { IOnyxCommandResult } from '../common/onyxRuntime.js';
import { OnyxCommandRunner } from './onyxCommandRunner.js';

/**
 * The executable oracle's two operations on the machine (L10, DEC-10): the
 * probe that shows the sandbox denies what it must, and a run of the
 * user's verification command inside it. Both start their commands through
 * the command runner, the one place a process is started (R-40), and a
 * sandboxed request that cannot be sandboxed starts nothing.
 */

const PROBE_TIMEOUT_MS = 15_000;

/**
 * Probes the sandbox in a scratch folder: a plain command, a connection to
 * a listener this function opens on the loopback interface (made once from
 * outside the sandbox, as the control, and once from inside), a write
 * outside the stand-in worktree and a write inside it. Nothing leaves the
 * machine, and the scratch folder is removed.
 */
export async function probeOracleSandbox(runner: OnyxCommandRunner, platform: NodeJS.Platform, scratchParent: string): Promise<IOnyxOracleProbe> {
	if (platform !== 'darwin') {
		return oracleUnsupportedProbe(platform);
	}
	const scratch = await fs.promises.realpath(await fs.promises.mkdtemp(join(scratchParent, 'onyx-oracle-probe-')));
	const worktree = join(scratch, 'worktree');
	const outside = join(scratch, 'outside');
	await fs.promises.mkdir(worktree);
	await fs.promises.mkdir(outside);
	let connections = 0;
	const server = net.createServer(socket => {
		connections++;
		socket.destroy();
	});
	try {
		const port = await new Promise<number>((resolve, reject) => {
			server.once('error', reject);
			server.listen(0, '127.0.0.1', () => {
				const address = server.address();
				resolve(typeof address === 'object' && address ? address.port : 0);
			});
		});
		const profile = oracleSandboxProfile(worktree);
		const sandboxed = async (command: string): Promise<IOnyxCommandResult> => runner.start({ cwd: worktree, command, timeoutMs: PROBE_TIMEOUT_MS, passEnvironment: false, sandbox: { profile } }, () => { }).result;
		const exists = async (path: string) => fs.promises.access(path).then(() => true, () => false);
		const steps: IOnyxOracleProbeStep[] = [];

		const plain = await sandboxed('true');
		steps.push({ what: 'sandboxed-run', exitCode: plain.exitCode, observed: plain.exitCode === 0, output: plain.output.trim() });

		// The control: the listener can be reached when nothing is in the way.
		const reached = await new Promise<boolean>(resolve => {
			const socket = net.connect({ host: '127.0.0.1', port });
			socket.once('connect', () => { socket.destroy(); resolve(true); });
			socket.once('error', () => resolve(false));
		});
		await new Promise(resolve => setTimeout(resolve, 50));
		steps.push({ what: 'network-outside-sandbox', exitCode: reached ? 0 : 1, observed: reached && connections > 0, output: `${connections} connection(s) reached the probe's listener` });

		const before = connections;
		const network = await sandboxed(`/usr/bin/nc -z -w 2 127.0.0.1 ${port}`);
		await new Promise(resolve => setTimeout(resolve, 50));
		steps.push({ what: 'network-inside-sandbox', exitCode: network.exitCode, observed: connections > before, output: network.output.trim() });

		const escaped = join(outside, 'escaped');
		const writeOutside = await sandboxed(`/usr/bin/touch "${escaped}"`);
		steps.push({ what: 'write-outside-worktree', exitCode: writeOutside.exitCode, observed: await exists(escaped), output: writeOutside.output.trim().split(scratch).join('<scratch>') });

		const kept = join(worktree, 'inside');
		const writeInside = await sandboxed(`/usr/bin/touch "${kept}"`);
		steps.push({ what: 'write-inside-worktree', exitCode: writeInside.exitCode, observed: await exists(kept), output: writeInside.output.trim().split(scratch).join('<scratch>') });

		return interpretOracleProbe(steps);
	} finally {
		server.close();
		await fs.promises.rm(scratch, { recursive: true, force: true });
	}
}

/**
 * Runs a verification command inside the sandbox, in a worktree. Temporary
 * files and the home directory are pointed inside the worktree: the
 * command can write nowhere else. Where the sandbox cannot be started the
 * result is a refusal and nothing ran.
 */
export async function runOracleCommand(runner: OnyxCommandRunner, worktree: string, command: string, timeoutMs: number): Promise<IOnyxCommandResult> {
	const real = await fs.promises.realpath(worktree);
	const scratch = join(real, '.onyx-oracle');
	await fs.promises.mkdir(join(scratch, 'tmp'), { recursive: true });
	await fs.promises.mkdir(join(scratch, 'home'), { recursive: true });
	return runner.start({
		cwd: real, command, timeoutMs, passEnvironment: false, sandbox: { profile: oracleSandboxProfile(real) },
		environment: { TMPDIR: join(scratch, 'tmp'), HOME: join(scratch, 'home') },
	}, () => { }).result;
}
