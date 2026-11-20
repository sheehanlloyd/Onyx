/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ChildProcess, spawn, SpawnOptions } from 'child_process';
import { isWindows } from '../../../../base/common/platform.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { commandEnvironment, ONYX_COMMAND_OUTPUT_LIMITS, OnyxOutputCapture, OnyxOutputStreamBudget } from '../../common/onyxCommandExecution.js';
import { OnyxCommandRunner, resolveCommandShell } from '../../node/onyxCommandRunner.js';

/**
 * R-40 (B5, DEC-02): the runner seam with simulated platforms. `darwin` and
 * `linux` take the POSIX path and really run; `win32` refuses and starts
 * nothing. The other half of R-40, that no Onyx file outside the seam names
 * a shell path or a signal, is the source scan in
 * `test/onyx/checks/r40-runner-seam.test.mts`.
 */
suite('OnyxCommandRunner', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	interface ISpawnCall { readonly executable: string; readonly args: readonly string[]; readonly detached: boolean | undefined; readonly cwd: string | undefined }

	/** The real `spawn`, with every call recorded. */
	function recordingSpawn(): { readonly calls: ISpawnCall[]; readonly spawn: (executable: string, args: readonly string[], options: SpawnOptions) => ChildProcess } {
		const calls: ISpawnCall[] = [];
		return {
			calls,
			spawn: (executable, args, options) => {
				calls.push({ executable, args: [...args], detached: options.detached, cwd: typeof options.cwd === 'string' ? options.cwd : undefined });
				return spawn(executable, args, options);
			},
		};
	}

	(isWindows ? test.skip : test)('R-40: darwin and linux resolve the POSIX shell in its own process group and run; win32 refuses and starts nothing', async () => {
		const outcomes: Record<string, unknown> = {};
		for (const platform of ['darwin', 'linux', 'win32'] as const) {
			const recorder = recordingSpawn();
			const runner = new OnyxCommandRunner(platform, { PATH: process.env['PATH'] }, recorder.spawn);
			const result = await runner.start({ cwd: process.cwd(), command: 'echo  "two  spaces"', timeoutMs: 20_000, passEnvironment: false }, () => { }).result;
			outcomes[platform] = { shell: resolveCommandShell(platform), spawned: recorder.calls, exitCode: result.exitCode, output: result.output, refusal: result.refusal };
		}
		const posix = {
			shell: { supported: true, executable: '/bin/sh', args: ['-c'] },
			// The command line is one argument, byte for byte: the double space inside the quotes survives.
			spawned: [{ executable: '/bin/sh', args: ['-c', 'echo  "two  spaces"'], detached: true, cwd: process.cwd() }],
			exitCode: 0,
			output: 'two  spaces\n',
			refusal: undefined,
		};
		assert.deepStrictEqual(outcomes, {
			darwin: posix,
			linux: posix,
			win32: { shell: { supported: false }, spawned: [], exitCode: undefined, output: '', refusal: 'unsupported-platform' },
		});
	});

	(isWindows ? test.skip : test)('variables whose names look like secrets do not reach the command unless the whole environment is passed', async () => {
		const environment = {
			PATH: process.env['PATH'],
			ONYX_PLAIN: 'plain-value',
			GITHUB_TOKEN: 'sentinel-token',
			AWS_SECRET_ACCESS_KEY: 'sentinel-secret',
			OPENAI_API_KEY: 'sentinel-key',
			DB_PASSWORD: 'sentinel-password',
			GOOGLE_APPLICATION_CREDENTIALS: 'sentinel-credential',
			npm_config_authtoken: 'sentinel-lowercase',
		};
		const run = async (passEnvironment: boolean) => {
			const result = await new OnyxCommandRunner('darwin', environment).start({ cwd: process.cwd(), command: 'env', timeoutMs: 20_000, passEnvironment }, () => { }).result;
			return {
				sentinelsThatReachedTheCommand: (result.output.match(/sentinel-[a-z]+/g) ?? []).sort(),
				plainReached: result.output.includes('ONYX_PLAIN=plain-value'),
				withheld: result.withheldEnvironment,
			};
		};
		assert.deepStrictEqual({ byDefault: await run(false), whenPassed: await run(true) }, {
			byDefault: {
				sentinelsThatReachedTheCommand: [],
				plainReached: true,
				withheld: ['AWS_SECRET_ACCESS_KEY', 'DB_PASSWORD', 'GITHUB_TOKEN', 'GOOGLE_APPLICATION_CREDENTIALS', 'OPENAI_API_KEY', 'npm_config_authtoken'],
			},
			whenPassed: {
				sentinelsThatReachedTheCommand: ['sentinel-credential', 'sentinel-key', 'sentinel-lowercase', 'sentinel-password', 'sentinel-secret', 'sentinel-token'],
				plainReached: true,
				withheld: [],
			},
		});
	});

	(isWindows ? test.skip : test)('a working directory that does not exist is reported as a failed command, not thrown', async () => {
		const result = await new OnyxCommandRunner().start({ cwd: '/onyx-no-such-directory', command: 'echo unreachable', timeoutMs: 20_000, passEnvironment: false }, () => { }).result;
		assert.deepStrictEqual(
			{ exitCode: result.exitCode, ran: result.output.includes('unreachable'), saysWhy: /ENOENT/.test(result.output), killed: result.killed, timedOut: result.timedOut },
			{ exitCode: undefined, ran: false, saysWhy: true, killed: false, timedOut: false });
	});

	test('the capture keeps the start and the end of any output inside its cap, and the stream budget bounds every event and their sum', () => {
		const capture = new OnyxOutputCapture(1000);
		const budget = new OnyxOutputStreamBudget({ eventChars: 64, streamedChars: 200 });
		const events: number[] = [];
		let peakRetained = 0;
		// Pieces of every size from 699 characters down to none, round and round.
		const sizes = Array.from({ length: 2000 }, (_, index) => 699 - (index % 700));
		capture.append('START');
		for (const size of sizes) {
			const piece = 'x'.repeat(size);
			capture.append(piece);
			peakRetained = Math.max(peakRetained, capture.retainedChars);
			events.push(...budget.take(piece).map(event => event.length));
		}
		capture.append('END');
		const text = capture.text();
		const small = new OnyxOutputCapture(1000);
		small.append('all of it');

		assert.deepStrictEqual({
			withinCap: text.length <= 1000 && peakRetained <= 1000,
			start: text.slice(0, 5),
			end: text.slice(-3),
			truncated: capture.truncated,
			saysHowMuchWasLeftOut: /\[… \d+ characters of output left out …\]/.test(text),
			total: capture.totalChars === 'START'.length + 'END'.length + sizes.reduce((sum, size) => sum + size, 0),
			largestEvent: Math.max(...events),
			streamed: events.reduce((sum, size) => sum + size, 0),
			small: { text: small.text(), truncated: small.truncated },
			documented: ONYX_COMMAND_OUTPUT_LIMITS,
		}, {
			withinCap: true,
			start: 'START',
			end: 'END',
			truncated: true,
			saysHowMuchWasLeftOut: true,
			total: true,
			largestEvent: 64,
			streamed: 200,
			small: { text: 'all of it', truncated: false },
			documented: { eventChars: 8192, streamedChars: 262144, resultChars: 200000 },
		});
	});

	test('commandEnvironment withholds by name only, and reports names, never values', () => {
		assert.deepStrictEqual(
			commandEnvironment({ HOME: '/home/u', API_TOKEN: 't', Secret_Sauce: 's', KEYBOARD_LAYOUT: 'us', UNSET: undefined }, false),
			// `KEYBOARD_LAYOUT` is withheld too: the rule is a name pattern, and it errs towards withholding.
			{ environment: { HOME: '/home/u' }, withheld: ['API_TOKEN', 'KEYBOARD_LAYOUT', 'Secret_Sauce'] });
	});
});
