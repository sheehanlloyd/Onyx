/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Egress audit of the packaged application (D8, R-60).
 *
 *   node test/onyx/run-egress-audit.mts --app <path/to/Onyx.app> --json-out <file> [--idle-minutes 10]
 *
 * Three phases, each on a profile of its own:
 *   workflow   the whole end-to-end suite on the packaged application: first launch, the first-run
 *              dialog, agent tasks, inline edits, a measurement run and the rest (run-e2e.mts)
 *   idle       a fresh first launch, the first-run dialog stepped through, then the window left alone
 *   asked      in that same window: the Extensions view is opened and searched, then
 *              `Onyx: Check for Updates` is run
 *
 * Allowed, and nothing else (the plan's rule): the configured runtime, which in this audit is the
 * mock on this machine; open-vsx.org and its content host openvsx.eclipsecontent.org during `asked`;
 * api.github.com during `asked`. Any other host
 * in any phase, or any host at all in `workflow` or `idle`, fails the audit.
 *
 * Two observers, neither needing privileges or a system-wide change:
 *   proxy   the application is started with `--proxy-server` pointing at a recording proxy in this
 *           process. It logs the host and port of every CONNECT and plain request and passes the
 *           traffic through unread. It sees everything Chromium's network stack sends, which is
 *           where the workbench's and the main process's requests go.
 *   sockets `lsof -nP -i` on every process of the application, about three times a second (a
 *           sample is skipped while the previous one is still being taken; the count is recorded). A connection that
 *           does not go through the proxy shows here with its remote address.
 *
 * What this cannot see, and the summary says so: a direct connection opened and closed between
 * two socket samples; DNS queries (the system resolver makes them, not the application); what is
 * inside a TLS connection (only the host is recorded); and anything the application would do
 * only under conditions the phases do not reach (a second day of use, a crash report, a
 * different locale). It is an observation of these phases, not a proof about the binary.
 */

import { execFile, execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function argValue(flag: string): string | undefined {
	const index = process.argv.indexOf(flag);
	return index === -1 ? undefined : process.argv[index + 1];
}

const appArg = argValue('--app') ?? process.env.ONYX_PACKAGED_APP;
const jsonOut = argValue('--json-out');
const idleMinutes = Number(argValue('--idle-minutes') ?? 10);
if (!appArg || !fs.existsSync(appArg) || !jsonOut) {
	console.error('usage: node test/onyx/run-egress-audit.mts --app <path/to/Onyx.app> --json-out <file> [--idle-minutes 10]');
	process.exit(2);
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const app = fs.realpathSync(path.resolve(appArg));
const cdpPort = Number(process.env.ONYX_CDP_PORT ?? 9333);
const mockPort = Number(process.env.ONYX_MOCK_PORT ?? 11434);
const session = `eg-${process.pid}`;

type Phase = 'workflow' | 'idle' | 'asked';
let phase: Phase = 'workflow';

interface IProxyRecord { readonly phase: Phase; readonly at: string; readonly method: string; readonly host: string; readonly port: number }
interface ISocketRecord { readonly phase: Phase; readonly firstSeen: string; readonly process: string; readonly remote: string; samples: number }

const proxied: IProxyRecord[] = [];
const sockets = new Map<string, ISocketRecord>();
let socketSamples = 0;

function sleep(ms: number) {
	return new Promise(resolve => setTimeout(resolve, ms));
}

function isLoopback(host: string): boolean {
	return host === 'localhost' || host === '::1' || host === '[::1]' || host.startsWith('127.') || host === '*';
}

// --- observer one: the recording proxy -----------------------------------------------------------------------

const proxy = http.createServer((request, response) => {
	// A plain-HTTP request through the proxy carries an absolute URL.
	let target: URL;
	try {
		target = new URL(request.url ?? '');
	} catch {
		response.writeHead(400).end();
		return;
	}
	proxied.push({ phase, at: new Date().toISOString(), method: request.method ?? 'GET', host: target.hostname, port: Number(target.port || 80) });
	const upstream = http.request({ host: target.hostname, port: target.port || 80, path: `${target.pathname}${target.search}`, method: request.method, headers: request.headers }, answer => {
		response.writeHead(answer.statusCode ?? 502, answer.headers);
		answer.pipe(response);
	});
	upstream.on('error', () => response.writeHead(502).end());
	request.pipe(upstream);
});
proxy.on('connect', (request, client, head) => {
	const [host, port = '443'] = (request.url ?? '').split(':');
	proxied.push({ phase, at: new Date().toISOString(), method: 'CONNECT', host, port: Number(port) });
	const upstream = net.connect(Number(port), host, () => {
		client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
		upstream.write(head);
		upstream.pipe(client);
		client.pipe(upstream);
	});
	upstream.on('error', () => client.destroy());
	client.on('error', () => upstream.destroy());
});

// --- observer two: the sockets of the application's processes ----------------------------------------------

/** Runs a command without blocking this process: the proxy lives on the same event loop. */
function output(command: string, args: string[]): Promise<string> {
	return new Promise(resolve => execFile(command, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }, (_error, stdout) => resolve(stdout ?? '')));
}

let sampling = false;

async function sampleSockets(proxyPort: number): Promise<void> {
	if (sampling) {
		return; // the previous sample is still being taken
	}
	sampling = true;
	try {
		const listing = await output('ps', ['-Ao', 'pid=,command=']);
		const pids = listing.split('\n').filter(line => line.includes(`${app}/`)).map(line => line.trim().split(/\s+/)[0]);
		if (pids.length === 0) {
			return;
		}
		socketSamples++;
		const open = await output('lsof', ['-nP', '-i', '-a', '-p', pids.join(',')]);
		for (const line of open.split('\n').slice(1)) {
			const columns = line.trim().split(/\s+/);
			const name = columns.slice(8).join(' ');
			const remote = /->(?<remote>\S+)/.exec(name)?.groups?.remote;
			if (!remote) {
				continue; // a listening socket, or an unconnected datagram socket
			}
			const host = remote.slice(0, remote.lastIndexOf(':'));
			const port = Number(remote.slice(remote.lastIndexOf(':') + 1));
			if (isLoopback(host) && port === proxyPort) {
				continue; // the application talking to the recording proxy: counted there
			}
			const key = `${phase}|${columns[0]}|${remote}`;
			const seen = sockets.get(key);
			if (seen) {
				seen.samples++;
			} else {
				sockets.set(key, { phase, firstSeen: new Date().toISOString(), process: columns[0], remote, samples: 1 });
			}
		}
	} finally {
		sampling = false;
	}
}

// --- driving the application ---------------------------------------------------------------------------------

const playwrightCli = createRequire(import.meta.url).resolve('@playwright/cli/playwright-cli.js');

function pw(...args: string[]) {
	return execFileSync(process.execPath, [playwrightCli, `-s=${session}`, ...args], { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

async function waitForCdp(timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			await (await fetch(`http://127.0.0.1:${cdpPort}/json/version`)).json();
			return true;
		} catch {
			await sleep(1000);
		}
	}
	return false;
}

async function runCommand(label: string) {
	pw('press', 'F1');
	await sleep(800);
	pw('run-code', `async (page) => { await page.fill('.quick-input-box input', ${JSON.stringify('>' + label)}); }`);
	await sleep(1000);
	pw('press', 'Enter');
}

async function main(): Promise<number> {
	await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
	const proxyPort = (proxy.address() as net.AddressInfo).port;
	const proxyArgs = `--proxy-server=http://127.0.0.1:${proxyPort}`;
	const sampler = setInterval(() => void sampleSockets(proxyPort), 300);
	const product = JSON.parse(fs.readFileSync(path.join(app, 'Contents', 'Resources', 'app', 'product.json'), 'utf8')) as { nameShort?: string; commit?: string };
	console.log(`egress audit · ${product.nameShort} ${product.commit?.slice(0, 11)} · recording proxy on 127.0.0.1:${proxyPort}`);
	const phases: Record<Phase, { startedAt: string; endedAt?: string; note: string }> = {
		workflow: { startedAt: new Date().toISOString(), note: 'run-e2e.mts on the packaged application, against the mock runtime' },
		idle: { startedAt: '', note: `a fresh first launch, the first-run dialog stepped through, then ${idleMinutes} minutes untouched` },
		asked: { startedAt: '', note: 'the Extensions view opened and searched, then Onyx: Check for Updates' },
	};

	// Phase one: the whole suite.
	console.log('\nphase workflow: the end-to-end suite on the packaged application');
	// Not spawnSync: the proxy and the socket sampler live in this process and must keep running while the suite does.
	const suite = await new Promise<{ status: number | null; stdout: string }>(resolve => {
		const runner = spawn(process.execPath, [path.join(repoRoot, 'test', 'onyx', 'run-e2e.mts')], { cwd: repoRoot, env: { ...process.env, ONYX_E2E_APP: app, ONYX_E2E_ARGS: proxyArgs }, stdio: ['ignore', 'pipe', 'inherit'] });
		let stdout = '';
		runner.stdout.on('data', (chunk: Buffer) => stdout += chunk.toString());
		runner.on('close', status => resolve({ status, stdout }));
	});
	const suiteLine = suite.stdout.trim().split('\n').filter(line => /checks passed|check\(s\) failed|FAIL/.test(line)).slice(-1)[0] ?? `exit ${suite.status}`;
	console.log(`  suite: ${suiteLine}`);
	phases.workflow.endedAt = new Date().toISOString();

	// Phases two and three: a fresh profile, by hand.
	const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onyx-egress-'));
	const workspace = path.join(runDir, 'ws');
	fs.mkdirSync(workspace, { recursive: true });
	fs.writeFileSync(path.join(workspace, 'notes.md'), '# notes\n');
	const mock = spawn(process.execPath, [path.join(repoRoot, 'test', 'onyx', 'mock-ollama.mts')], { cwd: repoRoot, env: { ...process.env, ONYX_MOCK_PORT: String(mockPort) }, stdio: 'ignore', detached: true });
	const executable = path.join(app, 'Contents', 'MacOS', fs.readdirSync(path.join(app, 'Contents', 'MacOS'))[0]);
	phase = 'idle';
	phases.idle.startedAt = new Date().toISOString();
	const child = spawn(executable, [
		`--user-data-dir=${path.join(runDir, 'user-data')}`,
		`--extensions-dir=${path.join(runDir, 'extensions')}`,
		`--remote-debugging-port=${cdpPort}`,
		'--use-mock-keychain',
		proxyArgs,
		'--disable-workspace-trust',
		workspace,
	], { cwd: runDir, stdio: 'ignore', detached: true });
	let asked: Record<string, unknown> = {};
	try {
		if (!await waitForCdp(120_000)) {
			throw new Error('the application never opened its debugging endpoint');
		}
		pw('attach', `--cdp=http://127.0.0.1:${cdpPort}`);
		await sleep(8000);
		pw('run-code', 'async (page) => { for (let step = 0; step < 6 && await page.locator(".onboarding-a-overlay.visible").count(); step++) { await page.locator("button.onboarding-a-btn-primary").click().catch(() => undefined); await page.waitForTimeout(1200); } }');
		console.log(`\nphase idle: ${idleMinutes} minutes with the window untouched`);
		await sleep(idleMinutes * 60_000);
		phases.idle.endedAt = new Date().toISOString();

		phase = 'asked';
		phases.asked.startedAt = new Date().toISOString();
		console.log('\nphase asked: the Extensions view, a search, the update check');
		pw('run-code', 'async (page) => { await page.keyboard.press("Meta+Shift+X"); await page.waitForTimeout(3000); await page.keyboard.type("prettier"); await page.waitForTimeout(8000); }');
		const galleryRows = pw('run-code', 'async (page) => String(await page.locator(".extensions-list .monaco-list-row").count())');
		await runCommand('Onyx: Check for Updates');
		await sleep(8000);
		const dialog = pw('run-code', 'async (page) => (await page.locator(".monaco-dialog-box .dialog-message-text").first().textContent().catch(() => "")) ?? ""');
		pw('press', 'Escape');
		const value = (output: string) => (/### Result\n(?<value>[\s\S]*?)\n### Ran Playwright code/.exec(output)?.groups?.value ?? '').replace(/^"|"$/g, '');
		asked = { extensionRowsShown: Number(value(galleryRows)), updateDialog: value(dialog) };
		console.log(`  extension rows shown: ${asked.extensionRowsShown}; update dialog: ${JSON.stringify(asked.updateDialog)}`);
		await sleep(3000);
		phases.asked.endedAt = new Date().toISOString();
	} finally {
		try {
			pw('close');
		} catch {
			// never attached
		}
		for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
			for (const pid of [child.pid, mock.pid]) {
				try {
					process.kill(-pid!, signal);
				} catch {
					// already gone
				}
			}
			await sleep(2000);
		}
		clearInterval(sampler);
		proxy.close();
		fs.rmSync(runDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
	}

	// --- the verdict -----------------------------------------------------------------------------------------
	// Open VSX serves extension files and icons from the Eclipse Foundation's content host; seen on
	// 2026-11-24 during the Extensions search and nowhere else. It is part of "Open VSX when asked".
	const allowedWhenAsked = (host: string) => host === 'open-vsx.org' || host.endsWith('.open-vsx.org') || host === 'openvsx.eclipsecontent.org' || host === 'api.github.com';
	const summary = (['workflow', 'idle', 'asked'] as const).map(name => {
		const viaProxy = new Map<string, number>();
		for (const record of proxied.filter(record => record.phase === name)) {
			viaProxy.set(`${record.host}:${record.port}`, (viaProxy.get(`${record.host}:${record.port}`) ?? 0) + 1);
		}
		const direct = [...sockets.values()].filter(record => record.phase === name);
		const directRemote = direct.filter(record => !isLoopback(record.remote.slice(0, record.remote.lastIndexOf(':'))));
		const loopbackPorts = [...new Set(direct.filter(record => isLoopback(record.remote.slice(0, record.remote.lastIndexOf(':')))).map(record => record.remote.slice(record.remote.lastIndexOf(':') + 1)))].sort();
		const proxiedRemote = [...viaProxy.keys()].filter(target => !isLoopback(target.slice(0, target.lastIndexOf(':'))));
		const violations = [
			...proxiedRemote.filter(target => name !== 'asked' || !allowedWhenAsked(target.slice(0, target.lastIndexOf(':')))).map(target => `${target} through the proxy`),
			...directRemote.map(record => `${record.remote} directly, from ${record.process}`),
		];
		return { phase: name, ...phases[name], throughProxy: Object.fromEntries(viaProxy), directNonLoopback: directRemote, loopbackPortsSeen: loopbackPorts, violations };
	});
	const violations = summary.flatMap(entry => entry.violations.map(violation => `${entry.phase}: ${violation}`));
	const askedHosts = Object.keys(summary[2].throughProxy).map(target => target.slice(0, target.lastIndexOf(':')));
	const expectations = {
		suitePassed: suite.status === 0,
		galleryWasAsked: askedHosts.some(host => host === 'open-vsx.org'),
		releaseListWasAsked: askedHosts.includes('api.github.com'),
	};
	const passed = violations.length === 0 && expectations.suitePassed && expectations.galleryWasAsked && expectations.releaseListWasAsked;
	fs.mkdirSync(path.dirname(path.resolve(jsonOut!)), { recursive: true });
	fs.writeFileSync(path.resolve(jsonOut!), JSON.stringify({
		regression: 'R-60',
		ranAt: new Date().toISOString(),
		product: { nameShort: product.nameShort, commit: product.commit },
		method: {
			proxy: 'application started with --proxy-server pointing at a recording proxy; host and port of every CONNECT and plain request, content not read',
			sockets: `lsof -nP -i on the application's processes, at most every 300 ms; ${socketSamples} samples taken`,
			cannotSee: ['a direct connection shorter than the sampling interval', 'DNS queries, made by the system resolver', 'the content of TLS connections', 'behaviour outside these phases'],
			runtime: `the mock runtime on 127.0.0.1:${mockPort} (and the suite's second mock); loopback connections are listed by port only`,
		},
		suite: suiteLine,
		asked,
		expectations,
		phases: summary,
		violations,
		passed,
	}, undefined, '\t'));
	for (const entry of summary) {
		console.log(`\n${entry.phase}: through the proxy ${JSON.stringify(entry.throughProxy)}; direct non-loopback ${entry.directNonLoopback.length}; loopback ports ${entry.loopbackPortsSeen.join(', ') || 'none'}`);
	}
	console.log(`\nexpected requests seen: gallery ${expectations.galleryWasAsked}, release list ${expectations.releaseListWasAsked}; suite passed ${expectations.suitePassed}`);
	console.log(passed ? 'egress audit: PASSED, no connection outside the allowed set' : `egress audit: FAILED${violations.length ? `\n  ${violations.join('\n  ')}` : ''}`);
	return passed ? 0 : 1;
}

main().then(code => process.exit(code), error => {
	console.error(error);
	process.exit(1);
});
