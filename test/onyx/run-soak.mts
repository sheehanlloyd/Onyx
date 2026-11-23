/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Stability soak of the packaged application (D8).
 *
 *   node test/onyx/run-soak.mts --app <path/to/Onyx.app> --json-out <file> [--minutes 60] [--skip-campaign]
 *
 * For the given time it runs the end-to-end suite against the mock runtime on
 * the packaged application, again and again, each run a fresh application on a
 * fresh profile. Beside it one more instance is started once and left alone
 * for the whole soak. Then the full simulation campaign runs (50,000 episodes
 * and every mutant), unless skipped.
 *
 * It records, and fails on: a suite run that does not pass; a process left
 * behind after a run (anything still running from the run's application or
 * with its working directory in the run's folder: a leaked command, B5); a new
 * crash report; the campaign failing. It records and does not judge: the peak
 * resident memory of the renderer in each run, and the idle instance's
 * renderer memory through the hour. The report states the bound these stayed
 * inside. That bound is an observation on one machine, not a limit the
 * product enforces.
 *
 * What it does not show: a single window used for many hours. Each suite run
 * lasts minutes and starts a new process, so growth across a working day is
 * outside it; the idle instance covers an idle hour only.
 */

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function argValue(flag: string): string | undefined {
	const index = process.argv.indexOf(flag);
	return index === -1 ? undefined : process.argv[index + 1];
}

const appArg = argValue('--app') ?? process.env.ONYX_PACKAGED_APP;
const jsonOut = argValue('--json-out');
const minutes = Number(argValue('--minutes') ?? 60);
const skipCampaign = process.argv.includes('--skip-campaign');
if (!appArg || !fs.existsSync(appArg) || !jsonOut) {
	console.error('usage: node test/onyx/run-soak.mts --app <path/to/Onyx.app> --json-out <file> [--minutes 60] [--skip-campaign]');
	process.exit(2);
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const app = fs.realpathSync(path.resolve(appArg));
const idleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onyx-soak-idle-'));
const crashDir = path.join(os.homedir(), 'Library', 'Logs', 'DiagnosticReports');
const startedAt = Date.now();

interface IProcess { readonly pid: number; readonly rssKb: number; readonly command: string }

function sleep(ms: number) {
	return new Promise(resolve => setTimeout(resolve, ms));
}

function applicationProcesses(): IProcess[] {
	const listing = spawnSync('ps', ['-Ao', 'pid=,rss=,command='], { encoding: 'utf8' }).stdout ?? '';
	return listing.split('\n').filter(line => line.includes(`${app}/`)).map(line => {
		const groups = /^\s*(?<pid>\d+)\s+(?<rss>\d+)\s+(?<command>.*)$/.exec(line)?.groups;
		return { pid: Number(groups?.pid), rssKb: Number(groups?.rss), command: groups?.command ?? '' };
	});
}

function megabytes(kilobytes: number): number {
	return Math.round(kilobytes / 1024);
}

function crashReports(): string[] {
	if (!fs.existsSync(crashDir)) {
		return [];
	}
	const name = path.basename(app, '.app');
	return fs.readdirSync(crashDir).filter(file => file.startsWith(name) && fs.statSync(path.join(crashDir, file)).mtimeMs >= startedAt);
}

/** Processes still alive that belong to a finished suite run: the application's own, or anything whose working directory is the run's folder. */
function leftBehind(): string[] {
	const fromApplication = applicationProcesses().filter(entry => entry.command.includes('onyx-e2e-')).map(entry => `${entry.pid} ${entry.command.slice(0, 120)}`);
	const cwds = spawnSync('lsof', ['-a', '-d', 'cwd', '-Fpn'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).stdout ?? '';
	const withRunCwd: string[] = [];
	let pid = '';
	for (const line of cwds.split('\n')) {
		if (line.startsWith('p')) {
			pid = line.slice(1);
		} else if (line.startsWith('n') && line.includes('onyx-e2e-')) {
			withRunCwd.push(`${pid} cwd ${line.slice(1)}`);
		}
	}
	return [...fromApplication, ...withRunCwd];
}

interface IIteration { readonly index: number; readonly seconds: number; readonly exitCode: number | null; readonly result: string; readonly peakRendererMb: number; readonly peakTotalMb: number; readonly leftBehind: string[] }

async function main(): Promise<number> {
	const product = JSON.parse(fs.readFileSync(path.join(app, 'Contents', 'Resources', 'app', 'product.json'), 'utf8')) as { nameShort?: string; commit?: string };
	console.log(`soak · ${product.nameShort} ${product.commit?.slice(0, 11)} · ${minutes} minutes · load average ${os.loadavg().map(value => value.toFixed(1)).join(' ')}`);

	// The instance that is left alone for the whole soak.
	const executable = path.join(app, 'Contents', 'MacOS', fs.readdirSync(path.join(app, 'Contents', 'MacOS'))[0]);
	fs.mkdirSync(path.join(idleDir, 'ws'));
	const idle = spawn(executable, [`--user-data-dir=${path.join(idleDir, 'user-data')}`, `--extensions-dir=${path.join(idleDir, 'extensions')}`, '--use-mock-keychain', '--disable-workspace-trust', path.join(idleDir, 'ws')], { cwd: idleDir, stdio: 'ignore', detached: true });
	const idleSamples: { minute: number; rendererMb: number; totalMb: number }[] = [];
	const sampleIdle = () => {
		const own = applicationProcesses().filter(entry => entry.command.includes(idleDir) || entry.pid === idle.pid);
		const renderers = own.filter(entry => entry.command.includes('--type=renderer'));
		idleSamples.push({ minute: Math.round((Date.now() - startedAt) / 6000) / 10, rendererMb: megabytes(Math.max(0, ...renderers.map(entry => entry.rssKb))), totalMb: megabytes(own.reduce((sum, entry) => sum + entry.rssKb, 0)) });
	};
	const idleTimer = setInterval(sampleIdle, 60_000);

	const iterations: IIteration[] = [];
	const deadline = startedAt + minutes * 60_000;
	try {
		while (Date.now() < deadline) {
			const began = Date.now();
			let peakRendererKb = 0;
			let peakTotalKb = 0;
			const sampler = setInterval(() => {
				const suite = applicationProcesses().filter(entry => entry.command.includes('onyx-e2e-'));
				peakRendererKb = Math.max(peakRendererKb, ...suite.filter(entry => entry.command.includes('--type=renderer')).map(entry => entry.rssKb));
				peakTotalKb = Math.max(peakTotalKb, suite.reduce((sum, entry) => sum + entry.rssKb, 0));
			}, 5000);
			const run = await new Promise<{ status: number | null; stdout: string }>(resolve => {
				const runner = spawn(process.execPath, [path.join(repoRoot, 'test', 'onyx', 'run-e2e.mts')], { cwd: repoRoot, env: { ...process.env, ONYX_E2E_APP: app }, stdio: ['ignore', 'pipe', 'ignore'] });
				let stdout = '';
				runner.stdout.on('data', (chunk: Buffer) => stdout += chunk.toString());
				runner.on('close', status => resolve({ status, stdout }));
			});
			clearInterval(sampler);
			await sleep(4000);
			const result = run.stdout.trim().split('\n').filter(line => /checks passed|failed|FAIL/.test(line)).slice(-1)[0] ?? `exit ${run.status}`;
			const iteration: IIteration = { index: iterations.length + 1, seconds: Math.round((Date.now() - began) / 1000), exitCode: run.status, result, peakRendererMb: megabytes(peakRendererKb), peakTotalMb: megabytes(peakTotalKb), leftBehind: leftBehind() };
			iterations.push(iteration);
			console.log(`  run ${iteration.index}: ${iteration.result} · ${iteration.seconds}s · renderer peak ${iteration.peakRendererMb} MB · all processes peak ${iteration.peakTotalMb} MB · left behind ${iteration.leftBehind.length}`);
		}
		sampleIdle();
	} finally {
		clearInterval(idleTimer);
		for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
			try {
				process.kill(-idle.pid!, signal);
			} catch {
				// already gone
			}
			await sleep(2000);
		}
		fs.rmSync(idleDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
	}

	let campaign: { ran: boolean; exitCode?: number | null; seconds?: number; tail?: string } = { ran: false };
	if (!skipCampaign) {
		console.log('\nfull simulation campaign (50,000 episodes and every mutant)');
		const began = Date.now();
		const outDir = path.join(repoRoot, '.build', 'soak-assurance', '0000-00-00-soak');
		fs.rmSync(outDir, { recursive: true, force: true });
		const result = spawnSync(process.execPath, [path.join(repoRoot, 'test', 'onyx', 'sim', 'write-assurance.mts'), '--out', outDir], { cwd: repoRoot, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: 60 * 60_000 });
		campaign = { ran: true, exitCode: result.status, seconds: Math.round((Date.now() - began) / 1000), tail: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim().split('\n').slice(-6).join(' ⏎ ') };
		console.log(`  exit ${campaign.exitCode} after ${campaign.seconds}s: ${campaign.tail}`);
	}

	const crashes = crashReports();
	const failedRuns = iterations.filter(iteration => iteration.exitCode !== 0);
	const leaks = iterations.flatMap(iteration => iteration.leftBehind.map(entry => `run ${iteration.index}: ${entry}`));
	const idleSettled = idleSamples.filter(sample => sample.minute >= 2);
	const passed = iterations.length > 0 && failedRuns.length === 0 && leaks.length === 0 && crashes.length === 0 && (skipCampaign || campaign.exitCode === 0);
	const summary = {
		ranAt: new Date(startedAt).toISOString(),
		product: { nameShort: product.nameShort, commit: product.commit },
		machine: { model: spawnSync('sysctl', ['-n', 'hw.model'], { encoding: 'utf8' }).stdout.trim(), memoryGb: Math.round(os.totalmem() / 2 ** 30), loadAverageAtEnd: os.loadavg() },
		minutesRequested: minutes,
		minutesRun: Math.round((Date.now() - startedAt) / 6000) / 10,
		suiteRuns: iterations.length,
		failedRuns: failedRuns.length,
		iterations,
		rendererPeakMb: { min: Math.min(...iterations.map(iteration => iteration.peakRendererMb)), max: Math.max(...iterations.map(iteration => iteration.peakRendererMb)), firstRun: iterations[0]?.peakRendererMb, lastRun: iterations.at(-1)?.peakRendererMb },
		idleInstance: { samples: idleSamples, rendererMbAfterTwoMinutes: idleSettled[0]?.rendererMb, rendererMbAtEnd: idleSettled.at(-1)?.rendererMb, rendererMbMax: Math.max(0, ...idleSettled.map(sample => sample.rendererMb)) },
		leftBehind: leaks,
		crashReports: crashes,
		campaign,
		notShown: 'one window used for many hours: each suite run is a new process that lives for minutes, and the long-lived instance is idle',
		passed,
	};
	fs.writeFileSync(path.resolve(jsonOut!), JSON.stringify(summary, undefined, '\t'));
	console.log(`\n${iterations.length} suite runs in ${summary.minutesRun} minutes, ${failedRuns.length} failed; renderer peak ${summary.rendererPeakMb.min} to ${summary.rendererPeakMb.max} MB; idle renderer ${summary.idleInstance.rendererMbAfterTwoMinutes} → ${summary.idleInstance.rendererMbAtEnd} MB; left behind ${leaks.length}; crash reports ${crashes.length}`);
	console.log(passed ? 'soak: PASSED' : 'soak: FAILED');
	return passed ? 0 : 1;
}

main().then(code => process.exit(code), error => {
	console.error(error);
	process.exit(1);
});
