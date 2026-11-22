/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The executable oracle (L10, DEC-10): scoring a model's edit by running
 * the user's own verification command on it. Model-written code is run, so
 * every condition here has to hold or the oracle is unavailable:
 *
 * - the command is one the user typed, shown with its exact bytes and the
 *   most times it will be run, and the user agreed to a dialog that says
 *   model-written code will be executed;
 * - it runs inside an operating-system sandbox that denies the network and
 *   every write outside the campaign's worktree;
 * - the sandbox was probed first, on this machine, and the probe saw both
 *   denials happen.
 *
 * Nothing is ever run outside the sandbox in its place. Everything here is
 * pure: the profile, the reading of a probe, the gate and the verdict.
 */

/** What the probe ran and what came of it, in order. */
export interface IOnyxOracleProbeStep {
	readonly what: 'sandboxed-run' | 'network-outside-sandbox' | 'network-inside-sandbox' | 'write-outside-worktree' | 'write-inside-worktree';
	/** The command's exit code; undefined when nothing could be started. */
	readonly exitCode: number | undefined;
	/** What the probe saw besides the exit code: whether the listener was reached, whether the file exists. */
	readonly observed: boolean;
	readonly output: string;
}

export interface IOnyxOracleProbe {
	readonly available: boolean;
	/** Why not, when it is not: one sentence the user is shown. */
	readonly reason: string | undefined;
	readonly steps: readonly IOnyxOracleProbeStep[];
}

/**
 * The sandbox profile for one worktree (macOS seatbelt): everything a
 * process may ordinarily do, except any network operation and any write
 * that is not inside the worktree or to the null device and the terminal.
 * The path has to be the real path: the sandbox compares resolved paths.
 */
export function oracleSandboxProfile(worktreeRealPath: string): string {
	const quoted = worktreeRealPath.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
	return [
		'(version 1)',
		'(allow default)',
		'(deny network*)',
		'(deny file-write*)',
		`(allow file-write* (subpath "${quoted}") (literal "/dev/null") (literal "/dev/zero") (literal "/dev/dtracehelper") (literal "/dev/tty") (regex #"^/dev/fd/") (regex #"^/dev/ttys[0-9]+$"))`,
	].join('\n');
}

/**
 * Reads a probe. The sandbox counts as established only when every step
 * came out as it must: a plain command runs in it; the network attempt
 * reaches the probe's own listener outside it and does not inside it; a
 * write outside the worktree fails and leaves no file; a write inside
 * succeeds. The control step matters: without it a dead listener would
 * look like a working sandbox.
 */
export function interpretOracleProbe(steps: readonly IOnyxOracleProbeStep[]): IOnyxOracleProbe {
	const step = (what: IOnyxOracleProbeStep['what']) => steps.find(candidate => candidate.what === what);
	const unavailable = (reason: string): IOnyxOracleProbe => ({ available: false, reason, steps });
	const run = step('sandboxed-run');
	if (!run || run.exitCode !== 0) {
		return unavailable('a command could not be started inside the sandbox');
	}
	const control = step('network-outside-sandbox');
	if (!control || !control.observed) {
		return unavailable('the probe could not reach its own listener outside the sandbox, so it cannot show that the sandbox is what blocks the network');
	}
	const network = step('network-inside-sandbox');
	if (!network || network.observed || network.exitCode === 0) {
		return unavailable('a network connection was made from inside the sandbox');
	}
	const outside = step('write-outside-worktree');
	if (!outside || outside.observed || outside.exitCode === 0) {
		return unavailable('a file was written outside the worktree from inside the sandbox');
	}
	const inside = step('write-inside-worktree');
	if (!inside || !inside.observed || inside.exitCode !== 0) {
		return unavailable('a file could not be written inside the worktree from inside the sandbox');
	}
	return { available: true, reason: undefined, steps };
}

/** A probe result for a platform that has no sandbox Onyx can establish. Nothing was run. */
export function oracleUnsupportedProbe(platform: string): IOnyxOracleProbe {
	return { available: false, reason: `no sandbox is available on ${platform}: the executable oracle needs one that denies the network and writes outside the worktree`, steps: [] };
}

export interface IOnyxOracleConsent {
	/** The verification command, exactly as the user typed it. */
	readonly command: string;
	/** The most times it will be run. */
	readonly maxRuns: number;
}

/** What the consent dialog says. It names the bytes that will run and that model-written code is executed. */
export function oracleConsentLines(consent: IOnyxOracleConsent): string[] {
	return [
		consent.command,
		`${new TextEncoder().encode(consent.command).length} bytes; it will be run at most ${consent.maxRuns} time${consent.maxRuns === 1 ? '' : 's'}.`,
		'This runs your command on code a model wrote. It runs inside a sandbox that denies network access and every write outside a disposable copy of the repository. Nothing is run if you do not agree.',
	];
}

export type OnyxOracleGate = { readonly allowed: true } | { readonly allowed: false; readonly reason: string };

/**
 * Whether one more run is allowed: a probe that passed, the user's consent
 * to this exact command, and runs left. Anything missing means the oracle
 * is unavailable, and the score falls back to the tier that runs nothing.
 */
export function oracleGate(probe: IOnyxOracleProbe | undefined, consent: IOnyxOracleConsent | undefined, command: string, runsSoFar: number): OnyxOracleGate {
	if (!probe) {
		return { allowed: false, reason: 'the sandbox has not been probed' };
	}
	if (!probe.available) {
		return { allowed: false, reason: probe.reason ?? 'the sandbox could not be established' };
	}
	if (!consent) {
		return { allowed: false, reason: 'the user has not agreed to run a verification command on model-written code' };
	}
	if (consent.command !== command) {
		return { allowed: false, reason: 'the command is not, byte for byte, the one the user agreed to' };
	}
	if (runsSoFar >= consent.maxRuns) {
		return { allowed: false, reason: `the command has been run ${runsSoFar} times, the most the user agreed to` };
	}
	return { allowed: true };
}

/**
 * - `fail-to-pass`: the command fails on the file as it was and passes on the proposed file.
 * - `fails-after`: it still fails on the proposed file.
 * - `passes-before`: it already passed before the change, so it cannot tell a right edit from none.
 * - `not-run`: one of the two runs did not finish (timed out, killed, refused).
 */
export type OnyxOracleVerdict = 'fail-to-pass' | 'fails-after' | 'passes-before' | 'not-run';

export function failToPassVerdict(beforeExitCode: number | undefined, afterExitCode: number | undefined): OnyxOracleVerdict {
	if (beforeExitCode === undefined || afterExitCode === undefined) {
		return 'not-run';
	}
	if (beforeExitCode === 0) {
		return 'passes-before';
	}
	return afterExitCode === 0 ? 'fail-to-pass' : 'fails-after';
}
