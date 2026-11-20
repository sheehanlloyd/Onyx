/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Module gate runner (A12, DEC-11, R-57). One command proves a module:
 *
 *   node test/onyx/run-module-gate.mts --module <n> [--gates <dir>] [--out <dir>] [--only <id>[,<id>]]
 *
 * A gate file (`test/onyx/gates/module-<n>.json`) lists checks: an id, the
 * command it runs or the regression ids it covers, its layer, whether it is
 * required or depends on a scope state in `docs/SUPPORT.md`, and the expected
 * outcome. The runner refuses to run on stale output (Section 11: the stamp
 * `out/.onyx-fresh.json` must match the tree), runs module n's checks and
 * those of every earlier module, prints one line per check, writes
 * `docs/progress/gate-module-<n>.json` with the revision, the dirty state, the
 * build evidence and every result, and exits non-zero when any required check
 * failed, is missing, or was skipped without a declared reason. A baseline
 * exception is a check with `"expect": "fail"` and an `owner`; it prints as an
 * expected failure and is never counted as a pass. If it passes, the gate
 * fails too: the exception no longer applies and must be removed.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isFresh, repoRoot, sourceState } from './run-fresh.mts';

type Expectation = 'pass' | 'fail';
type Outcome = 'pass' | 'fail' | 'expected-failure' | 'unexpected-pass' | 'missing' | 'skipped' | 'unexpected-skip';

interface IGateCheck {
	readonly id: string;
	/** What it proves, for the printed line and the results file. */
	readonly title?: string;
	readonly layer: string;
	/** Regression ids this check covers, from Section 10. */
	readonly regressions?: readonly string[];
	/** The command to run from the repository root. Omitted for evidence-only checks that name `files`. */
	readonly command?: readonly string[];
	/** Files that must exist for the check to count as present (a regression test file, an evidence report). */
	readonly files?: readonly string[];
	/** Extra environment for the command. `$VAR` in a command argument is also expanded from the gate's environment. */
	readonly env?: Readonly<Record<string, string>>;
	readonly required?: boolean;
	readonly expect?: Expectation;
	/** For `expect: "fail"`: the item that owns the fix, and why it fails today. */
	readonly owner?: string;
	readonly reason?: string;
	/** Platform and environment variables the check needs; unmet ones skip it, which fails a required check unless `skipAllowed`. */
	readonly requires?: { readonly platform?: string; readonly env?: readonly string[] };
	/** A scope state in docs/SUPPORT.md this check depends on: it runs when the item is `included`, skips (expectedly) when `deferred`. */
	readonly scope?: { readonly item: string; readonly when: 'included' | 'deferred' };
	readonly skipAllowed?: boolean;
	readonly timeoutMs?: number;
}

interface IGateFile {
	readonly module: number;
	readonly title?: string;
	readonly checks: readonly IGateCheck[];
}

interface IGateResult {
	readonly module: number;
	readonly id: string;
	readonly title?: string;
	readonly layer: string;
	readonly regressions: readonly string[];
	readonly required: boolean;
	readonly expect: Expectation;
	readonly outcome: Outcome;
	readonly exitCode?: number;
	readonly durationMs: number;
	readonly detail?: string;
	readonly owner?: string;
	readonly reason?: string;
	readonly command?: string;
}

function argValue(flag: string): string | undefined {
	const index = process.argv.indexOf(flag);
	return index === -1 ? undefined : process.argv[index + 1];
}

const moduleArg = argValue('--module');
if (!moduleArg || !/^[1-5]$/.test(moduleArg)) {
	console.error('usage: node test/onyx/run-module-gate.mts --module <1-5> [--gates <dir>] [--out <dir>] [--only <id>[,<id>]]');
	process.exit(2);
}
const moduleNumber = Number(moduleArg);
const gatesDir = path.resolve(argValue('--gates') ?? path.join(path.dirname(fileURLToPath(import.meta.url)), 'gates'));
const outDir = path.resolve(argValue('--out') ?? path.join(repoRoot, 'docs', 'progress'));
const only = argValue('--only')?.split(',').map(id => id.trim()).filter(Boolean);

/** Scope states recorded in docs/SUPPORT.md as `| C9 | included |`-style rows or `C9: deferred` lines. */
function readScopeStates(): Map<string, string> {
	const states = new Map<string, string>();
	const support = path.join(repoRoot, 'docs', 'SUPPORT.md');
	if (!fs.existsSync(support)) {
		return states;
	}
	for (const line of fs.readFileSync(support, 'utf8').split('\n')) {
		const match = /^\|\s*`?(?<item>[A-Z]\d{1,2}(?: [a-z ]+)?)`?\s*\|\s*\**(?<state>planned|included|deferred)\**/i.exec(line)
			?? /^\s*[-*]?\s*`?(?<item>[A-Z]\d{1,2})`?\s*[:—-]\s*\**(?<state>planned|included|deferred)\**/i.exec(line);
		if (match?.groups) {
			states.set(match.groups.item.trim(), match.groups.state.toLowerCase());
		}
	}
	return states;
}

function expandEnv(argument: string, env: NodeJS.ProcessEnv): string {
	return argument.replace(/\$(?<name>[A-Z_][A-Z0-9_]*)/g, (whole, name: string) => env[name] ?? whole);
}

function loadGate(moduleIndex: number): IGateFile {
	const file = path.join(gatesDir, `module-${moduleIndex}.json`);
	if (!fs.existsSync(file)) {
		throw new Error(`gate file missing: ${path.relative(repoRoot, file)}`);
	}
	const gate = JSON.parse(fs.readFileSync(file, 'utf8')) as IGateFile;
	if (gate.module !== moduleIndex || !Array.isArray(gate.checks)) {
		throw new Error(`${path.relative(repoRoot, file)} does not describe module ${moduleIndex}`);
	}
	return gate;
}

function runCheck(moduleIndex: number, check: IGateCheck, scopeStates: Map<string, string>): IGateResult {
	const required = check.required !== false;
	const expect = check.expect ?? 'pass';
	const base = { module: moduleIndex, id: check.id, title: check.title, layer: check.layer, regressions: check.regressions ?? [], required, expect, owner: check.owner, reason: check.reason, command: check.command?.join(' ') };
	const started = Date.now();
	const done = (outcome: Outcome, extra: Partial<IGateResult> = {}): IGateResult => ({ ...base, outcome, durationMs: Date.now() - started, ...extra });

	if (check.scope) {
		const state = scopeStates.get(check.scope.item);
		if (state !== check.scope.when) {
			const detail = `docs/SUPPORT.md records ${check.scope.item} as ${state ?? 'nothing'}; this check applies when ${check.scope.when}`;
			return done(state === undefined || state === 'planned' ? 'unexpected-skip' : 'skipped', { detail });
		}
	}
	if (check.requires?.platform && check.requires.platform !== process.platform) {
		return done(check.skipAllowed ? 'skipped' : 'unexpected-skip', { detail: `needs ${check.requires.platform}, this is ${process.platform}` });
	}
	const missingEnv = (check.requires?.env ?? []).filter(name => !process.env[name]);
	if (missingEnv.length) {
		return done(check.skipAllowed ? 'skipped' : 'unexpected-skip', { detail: `needs ${missingEnv.join(', ')} in the environment` });
	}
	const missingFiles = (check.files ?? []).filter(file => !fs.existsSync(path.join(repoRoot, file)));
	if (missingFiles.length) {
		return done('missing', { detail: `missing: ${missingFiles.join(', ')}` });
	}
	if (!check.command) {
		return done(expect === 'pass' ? 'pass' : 'unexpected-pass', { detail: 'evidence files present' });
	}
	const env = { ...process.env, ...check.env };
	const argv = check.command.map(argument => expandEnv(argument, env));
	const result = spawnSync(argv[0], argv.slice(1), { cwd: repoRoot, env, encoding: 'utf8', timeout: check.timeoutMs ?? 60 * 60_000, maxBuffer: 256 * 1024 * 1024 });
	if (result.error && (result.error as NodeJS.ErrnoException).code === 'ENOENT') {
		return done('missing', { detail: `command not found: ${argv[0]}` });
	}
	const exitCode = result.status ?? (result.signal ? 128 : 1);
	const tail = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim().split('\n').slice(-6).join(' ⏎ ').slice(-700);
	if (result.error) {
		return done('fail', { exitCode, detail: `${result.error.message}; ${tail}` });
	}
	if (expect === 'fail') {
		return exitCode === 0 ? done('unexpected-pass', { exitCode, detail: tail }) : done('expected-failure', { exitCode, detail: tail });
	}
	return exitCode === 0 ? done('pass', { exitCode, detail: tail }) : done('fail', { exitCode, detail: tail });
}

function label(result: IGateResult): string {
	switch (result.outcome) {
		case 'pass': return 'ok  ';
		case 'fail': return 'FAIL';
		case 'expected-failure': return 'expected failure';
		case 'unexpected-pass': return 'UNEXPECTED PASS';
		case 'missing': return 'MISSING';
		case 'skipped': return 'skip';
		case 'unexpected-skip': return 'UNEXPECTED SKIP';
	}
}

function blocks(result: IGateResult): boolean {
	if (!result.required) {
		return false;
	}
	return result.outcome === 'fail' || result.outcome === 'missing' || result.outcome === 'unexpected-skip' || result.outcome === 'unexpected-pass';
}

/**
 * The package manager the checks will run with, as it answers on PATH. The
 * gate's commands call `pnpm`; the repository pins its version in package.json
 * and refuses any other at install time.
 */
function packageManagerOnPath(): string {
	const result = spawnSync('pnpm', ['--version'], { cwd: repoRoot, encoding: 'utf8' });
	return result.status === 0 ? `pnpm ${result.stdout.trim()}` : 'pnpm is not on PATH (enable it with `corepack enable pnpm`)';
}

function main(): number {
	const freshness = isFresh();
	const state = sourceState();
	const packageManager = packageManagerOnPath();
	console.log(`module gate ${moduleNumber} · ${state.revision.slice(0, 11)}${state.dirtyEntries ? ` with ${state.dirtyEntries} dirty source entries` : ' (clean source tree)'} · node ${process.version} · ${packageManager}`);
	if (!freshness.fresh) {
		console.error(`refusing to run on stale output: ${freshness.reason}`);
		fs.mkdirSync(outDir, { recursive: true });
		fs.writeFileSync(path.join(outDir, `gate-module-${moduleNumber}.json`), JSON.stringify({ module: moduleNumber, revision: state.revision, dirtyDigest: state.dirtyDigest, dirtyEntries: state.dirtyEntries, ranAt: new Date().toISOString(), refused: freshness.reason, build: freshness.stamp?.build, results: [], passed: false }, undefined, '\t'));
		return 3;
	}
	console.log(`fresh output: ${freshness.reason}`);
	const scopeStates = readScopeStates();
	const results: IGateResult[] = [];
	for (let moduleIndex = 1; moduleIndex <= moduleNumber; moduleIndex++) {
		const gate = loadGate(moduleIndex);
		console.log(`\n${gate.title ?? `module ${moduleIndex}`}`);
		for (const check of gate.checks) {
			if (only && !only.includes(check.id)) {
				continue;
			}
			const result = runCheck(moduleIndex, check, scopeStates);
			results.push(result);
			const owner = result.outcome === 'expected-failure' || result.outcome === 'unexpected-pass' ? ` (owner ${result.owner ?? 'UNOWNED'}${result.reason ? `: ${result.reason}` : ''})` : '';
			const detail = result.outcome === 'pass' || result.outcome === 'expected-failure' ? '' : result.detail ? ` — ${result.detail}` : '';
			console.log(`  ${label(result).padEnd(16)} ${result.id.padEnd(22)} ${result.layer.padEnd(10)} ${(result.durationMs / 1000).toFixed(1).padStart(7)}s${result.required ? '' : '  (optional)'}${owner}${detail}`);
		}
	}
	const blocking = results.filter(blocks);
	const exceptions = results.filter(result => result.outcome === 'expected-failure');
	const unowned = exceptions.filter(result => !result.owner);
	const passed = blocking.length === 0 && unowned.length === 0;
	fs.mkdirSync(outDir, { recursive: true });
	const resultsFile = path.join(outDir, `gate-module-${moduleNumber}.json`);
	fs.writeFileSync(resultsFile, JSON.stringify({
		module: moduleNumber,
		revision: state.revision,
		dirtyDigest: state.dirtyDigest,
		dirtyEntries: state.dirtyEntries,
		ranAt: new Date().toISOString(),
		platform: `${process.platform}-${process.arch}`,
		node: process.version,
		packageManager,
		build: freshness.stamp?.build,
		results,
		passed,
	}, undefined, '\t'));
	console.log(`\n${results.length} checks: ${results.filter(result => result.outcome === 'pass').length} passed, ${exceptions.length} expected failure(s), ${results.filter(result => result.outcome === 'skipped').length} skipped, ${blocking.length} blocking`);
	for (const result of blocking) {
		console.log(`  blocking: ${result.id} (${result.outcome})${result.detail ? ` — ${result.detail}` : ''}`);
	}
	for (const result of unowned) {
		console.log(`  blocking: ${result.id} is an expected failure without an owner item`);
	}
	console.log(`results: ${path.relative(repoRoot, resultsFile)}`);
	console.log(passed ? `module ${moduleNumber} gate: PASSED` : `module ${moduleNumber} gate: FAILED`);
	return passed ? 0 : 1;
}

process.exit(main());
