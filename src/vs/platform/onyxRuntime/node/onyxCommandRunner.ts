/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ChildProcess, spawn, SpawnOptions } from 'child_process';
import { StringDecoder } from 'string_decoder';
import { commandEnvironment, ONYX_COMMAND_OUTPUT_LIMITS, OnyxOutputCapture, OnyxOutputStreamBudget } from '../common/onyxCommandExecution.js';
import { IOnyxCommandResult } from '../common/onyxRuntime.js';

/**
 * The platform seam for running a command (B5, DEC-02). Which shell, with
 * which spawn options, and how the process tree is ended are decided here
 * and nowhere else in Onyx: no other Onyx file names a shell path or a
 * signal (R-40 scans for it).
 *
 * POSIX (`darwin`, `linux`): `/bin/sh -c` in its own process group, ended
 * with a synchronous kill of the group, because a dispose and a process exit
 * cannot wait on a helper process.
 *
 * `win32`: an explicit refusal, and nothing is started. Milestone M2 fills
 * this branch with `getWindowsShell()` and `killTree(pid, true)` from
 * `src/vs/base/node/processes.ts`; until it is tested, it does not ship.
 */

export type OnyxCommandShell =
	| { readonly supported: true; readonly executable: string; readonly args: readonly string[] }
	| { readonly supported: false };

/** The shell a command line is handed to on a platform, or that the platform is not supported. */
export function resolveCommandShell(platform: NodeJS.Platform): OnyxCommandShell {
	switch (platform) {
		case 'darwin':
		case 'linux':
			return { supported: true, executable: '/bin/sh', args: ['-c'] };
		default:
			return { supported: false };
	}
}

/** Where the system's sandbox launcher is, on the platform that has one Onyx uses. */
const SANDBOX_LAUNCHER = '/usr/bin/sandbox-exec';

/**
 * The shell, started inside a sandbox with the given profile (L10, DEC-10).
 * Only macOS has a launcher Onyx uses; everywhere else there is no sandboxed
 * shell, and a request for one starts nothing: a command that was to be
 * sandboxed is never run without the sandbox.
 */
export function resolveSandboxedShell(platform: NodeJS.Platform, profile: string): OnyxCommandShell {
	const shell = resolveCommandShell(platform);
	if (platform !== 'darwin' || !shell.supported) {
		return { supported: false };
	}
	return { supported: true, executable: SANDBOX_LAUNCHER, args: ['-p', profile, shell.executable, ...shell.args] };
}

export interface IOnyxCommandRequest {
	readonly cwd: string;
	/** The command line, handed to the shell byte for byte. */
	readonly command: string;
	readonly timeoutMs: number;
	/** Pass the whole environment, including variables whose names look like secrets. */
	readonly passEnvironment: boolean;
	/** Run the command inside a sandbox with this profile. Where no sandbox exists, nothing is started. */
	readonly sandbox?: { readonly profile: string };
	/** Variables set for the command over the environment it would otherwise get. */
	readonly environment?: Readonly<Record<string, string>>;
}

export interface IOnyxCommandProcess {
	readonly result: Promise<IOnyxCommandResult>;
	/** Ends the whole process tree, synchronously. The result then reports `killed`. */
	kill(): void;
}

export type OnyxCommandOutputListener = (stream: 'stdout' | 'stderr', text: string) => void;

type OnyxSpawn = (executable: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

/** How long a killed command's pipes may stay open (a process that left the group can hold them) before the result is reported anyway. */
const KILL_GRACE_MS = 2000;
const MIN_TIMEOUT_MS = 1000;

export class OnyxCommandRunner {

	constructor(
		private readonly _platform: NodeJS.Platform = process.platform,
		private readonly _environment: Readonly<Record<string, string | undefined>> = process.env,
		private readonly _spawn: OnyxSpawn = spawn,
	) { }

	start(request: IOnyxCommandRequest, onOutput: OnyxCommandOutputListener): IOnyxCommandProcess {
		const shell = request.sandbox ? resolveSandboxedShell(this._platform, request.sandbox.profile) : resolveCommandShell(this._platform);
		if (!shell.supported) {
			const refused: IOnyxCommandResult = { exitCode: undefined, timedOut: false, killed: false, durationMs: 0, output: '', outputChars: 0, outputTruncated: false, withheldEnvironment: [], refusal: request.sandbox && resolveCommandShell(this._platform).supported ? 'sandbox-unavailable' : 'unsupported-platform' };
			return { result: Promise.resolve(refused), kill: () => { } };
		}

		const startedAt = Date.now();
		const scrubbed = commandEnvironment(this._environment, request.passEnvironment);
		const withheld = scrubbed.withheld;
		const environment = request.environment ? { ...scrubbed.environment, ...request.environment } : scrubbed.environment;
		// Its own process group (detached), so that ending it reaches the whole
		// tree and not only the shell that started it.
		const child = this._spawn(shell.executable, [...shell.args, request.command], { cwd: request.cwd, env: environment, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });

		const capture = new OnyxOutputCapture(ONYX_COMMAND_OUTPUT_LIMITS.resultChars);
		const budget = new OnyxOutputStreamBudget();
		let done = false;
		let timedOut = false;
		let killed = false;
		let graceTimer: ReturnType<typeof setTimeout> | undefined;
		let finish: (exitCode: number | undefined) => void = () => { };

		const killTree = () => {
			try {
				if (child.pid) {
					process.kill(-child.pid, 'SIGKILL');
				}
			} catch {
				child.kill('SIGKILL');
			}
			// A process that left the group can keep the pipes open; the caller still gets its answer.
			graceTimer ??= setTimeout(() => {
				child.stdout?.destroy();
				child.stderr?.destroy();
				finish(undefined);
			}, KILL_GRACE_MS);
		};

		const timer = setTimeout(() => {
			timedOut = true;
			killTree();
		}, Math.max(MIN_TIMEOUT_MS, request.timeoutMs));

		const result = new Promise<IOnyxCommandResult>(resolve => {
			finish = exitCode => {
				if (done) {
					return;
				}
				done = true;
				clearTimeout(timer);
				clearTimeout(graceTimer);
				resolve({
					exitCode: timedOut || killed ? undefined : exitCode,
					timedOut,
					killed,
					durationMs: Date.now() - startedAt,
					output: capture.text(),
					outputChars: capture.totalChars,
					outputTruncated: capture.truncated,
					withheldEnvironment: withheld,
					refusal: undefined,
				});
			};
		});

		const onData = (stream: 'stdout' | 'stderr') => {
			const decoder = new StringDecoder('utf8');
			return (data: Buffer) => {
				const text = decoder.write(data);
				// Everything is counted; only the start and the end are kept, and only a bounded part is streamed.
				capture.append(text);
				for (const piece of budget.take(text)) {
					onOutput(stream, piece);
				}
			};
		};
		child.stdout?.on('data', onData('stdout'));
		child.stderr?.on('data', onData('stderr'));
		child.on('error', error => {
			capture.append(`\n${error.message}`);
			finish(undefined);
		});
		child.on('close', code => finish(code ?? undefined));

		return {
			result,
			kill: () => {
				if (!done) {
					killed = true;
					killTree();
				}
			},
		};
	}
}
