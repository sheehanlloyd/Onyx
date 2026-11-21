/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { spawnSync } from 'child_process';
import { timeout } from '../../../../base/common/async.js';
import { isWindows } from '../../../../base/common/platform.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { NullLogService } from '../../../log/common/log.js';
import { IOnyxCommandOutputEvent, IOnyxCommandResult } from '../../common/onyxRuntime.js';
import { OnyxRuntimeService } from '../../node/onyxRuntimeService.js';

/**
 * R-18, at the process boundary (B5): a real shell command that prints
 * fifty megabytes, one that outlives its timeout, one that is cancelled and
 * one that is running when the service is disposed. What reaches the caller
 * stays under the documented caps, and in every case the whole process
 * group is gone afterwards, not only the shell that started it.
 *
 * The caps are written out here on purpose: they are the documented limits
 * (`ONYX_COMMAND_OUTPUT_LIMITS`), and a change to them should fail this test
 * until the documentation changes with it.
 */
const DOCUMENTED_EVENT_CHARS = 8 * 1024;
const DOCUMENTED_STREAMED_CHARS = 256 * 1024;
const DOCUMENTED_RESULT_CHARS = 200_000;

const FLOOD_BYTES = 50 * 1024 * 1024;

/** A shell that starts a second process in its group, prints both process ids, and waits for longer than any test. */
const TWO_PROCESSES = 'sleep 300 & echo "child:$!"; echo "shell:$$"; wait';

/**
 * Whether a process is still running. A killed process can linger in the
 * process table until its new parent collects it; that is not running.
 */
function isRunning(pid: number): boolean {
	const state = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim();
	return state !== '' && !state.startsWith('Z');
}

/**
 * Both processes write to the command's output pipe, so the command's result
 * (which waits for that pipe to close) arrives only once neither is running.
 * No waiting is needed after it; a result that does not arrive means the
 * group was not killed.
 */
async function groupGone(pids: readonly number[], result: Promise<IOnyxCommandResult>): Promise<boolean> {
	const deadline = timeout(10_000);
	try {
		const ended = await Promise.race([result.then(() => true), deadline.then(() => false, () => false)]);
		return ended && pids.every(pid => !isRunning(pid));
	} finally {
		deadline.cancel();
	}
}

function parsePids(text: string): number[] {
	return [...text.matchAll(/(?:child|shell):(?<pid>\d+)/g)].map(match => Number(match.groups?.pid));
}

suite('OnyxCommandExecution', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	/** Starts the two-process command and resolves once both process ids have been printed. */
	async function startTwoProcesses(service: OnyxRuntimeService, operationId: string, timeoutMs: number): Promise<{ readonly pids: number[]; readonly result: Promise<IOnyxCommandResult> }> {
		let seen = '';
		const printed = new Promise<void>(resolve => {
			store.add(service.onDidCommandOutput(event => {
				seen += event.text;
				if (parsePids(seen).length === 2) {
					resolve();
				}
			}));
		});
		const result = service.execCommand(operationId, process.cwd(), TWO_PROCESSES, timeoutMs);
		await Promise.race([printed, result]);
		return { pids: parsePids(seen), result };
	}

	(isWindows ? test.skip : test)('R-18: a command that prints fifty megabytes reaches the caller as bounded events, a bounded stream and a bounded result that says it was cut', async function () {
		this.timeout(60_000);
		const service = store.add(new OnyxRuntimeService(new NullLogService()));
		const events: IOnyxCommandOutputEvent[] = [];
		store.add(service.onDidCommandOutput(event => events.push(event)));

		const result = await service.execCommand('flood', process.cwd(), `head -c ${FLOOD_BYTES} /dev/zero | tr '\\0' 'x'; echo; echo the-last-line`, 60_000);

		assert.deepStrictEqual({
			exitCode: result.exitCode,
			largestEventWithinCap: Math.max(...events.map(event => event.text.length)) <= DOCUMENTED_EVENT_CHARS,
			streamedWithinCap: events.reduce((sum, event) => sum + event.text.length, 0) <= DOCUMENTED_STREAMED_CHARS,
			resultWithinCap: result.output.length <= DOCUMENTED_RESULT_CHARS,
			printed: result.outputChars,
			saysItWasCut: result.outputTruncated,
			keepsTheEnd: result.output.trimEnd().endsWith('the-last-line'),
			keepsTheStart: result.output.startsWith('xxxx'),
		}, {
			exitCode: 0,
			largestEventWithinCap: true,
			streamedWithinCap: true,
			resultWithinCap: true,
			printed: FLOOD_BYTES + '\nthe-last-line\n'.length,
			saysItWasCut: true,
			keepsTheEnd: true,
			keepsTheStart: true,
		});
	});

	(isWindows ? test.skip : test)('R-18: a timeout, a cancel and a service dispose each kill the whole process group', async function () {
		this.timeout(60_000);

		const timedOutService = store.add(new OnyxRuntimeService(new NullLogService()));
		const timedOut = await startTwoProcesses(timedOutService, 'timeout', 1000);
		const timedOutResult = await timedOut.result;

		const cancelledService = store.add(new OnyxRuntimeService(new NullLogService()));
		const cancelled = await startTwoProcesses(cancelledService, 'cancel', 120_000);
		await cancelledService.killCommand('cancel');
		const cancelledResult = await cancelled.result;

		const disposedService = store.add(new OnyxRuntimeService(new NullLogService()));
		const disposed = await startTwoProcesses(disposedService, 'dispose', 120_000);
		const runningBeforeDispose = disposed.pids.every(isRunning);
		disposedService.dispose();
		const goneAfterDispose = await groupGone(disposed.pids, disposed.result);
		// Whatever the assertion below says, leave nothing running behind this test.
		for (const pid of disposed.pids) {
			try {
				process.kill(pid, 'SIGKILL');
			} catch {
				// already gone
			}
		}

		assert.deepStrictEqual({
			timeout: { processes: timedOut.pids.length, timedOut: timedOutResult.timedOut, exitCode: timedOutResult.exitCode, groupGone: await groupGone(timedOut.pids, timedOut.result) },
			cancel: { processes: cancelled.pids.length, killed: cancelledResult.killed, exitCode: cancelledResult.exitCode, groupGone: await groupGone(cancelled.pids, cancelled.result) },
			dispose: { processes: disposed.pids.length, runningBeforeDispose, groupGone: goneAfterDispose },
		}, {
			timeout: { processes: 2, timedOut: true, exitCode: undefined, groupGone: true },
			cancel: { processes: 2, killed: true, exitCode: undefined, groupGone: true },
			dispose: { processes: 2, runningBeforeDispose: true, groupGone: true },
		});
	});
});
