/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Screenshots for the README from the packaged build, with a real runtime and the pinned models (D6).
 *
 *   node test/onyx/run-captures.mts --app <path/to/Onyx.app> --runtime http://127.0.0.1:11500 --out <dir> [--gif]
 *
 * A small demo repository is created, the application is started on a fresh profile that names the
 * runtime, and these are captured, each only if what it shows actually happened:
 *   onyx-onboarding.png      the first-run dialog, with the runtime it found
 *   onyx-workbench.png       the window after the first run: editor, agent chat, the Experimental Alpha label
 *   onyx-model-library.png   Onyx: Manage Models
 *   onyx-inline-edit.png     Cmd+I on a function with the 7B model: the proposal shown as hunks, the file untouched
 *   onyx-commit-message.png  Onyx: Generate Commit Message on a staged change
 *   onyx-agent-attempt.png   one agent request with the 7B model, whatever it did, with the control plane open
 *   onyx-demo.gif            (--gif) one frame a second through the inline edit, real time
 *
 * It writes `captures.json` beside them: for each file, whether it was taken, the model, the runtime
 * version, the date and, where the model was asked something, what it did. A capture whose subject
 * did not happen is not taken, and the record says so. The mock runtime is never used here.
 */

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function argValue(flag: string): string | undefined {
	const index = process.argv.indexOf(flag);
	return index === -1 ? undefined : process.argv[index + 1];
}

const appArg = argValue('--app') ?? process.env.ONYX_PACKAGED_APP;
const runtime = argValue('--runtime')?.replace(/\/$/, '');
const outDir = argValue('--out');
const gif = process.argv.includes('--gif');
if (!appArg || !fs.existsSync(appArg) || !runtime || !outDir) {
	console.error('usage: node test/onyx/run-captures.mts --app <path/to/Onyx.app> --runtime http://127.0.0.1:11500 --out <dir> [--gif]');
	process.exit(2);
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const app = fs.realpathSync(path.resolve(appArg));
const out = path.resolve(outDir);
const cdpPort = Number(process.env.ONYX_CDP_PORT ?? 9337);
const session = `cap-${process.pid}`;
const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onyx-captures-'));
const workspace = path.join(runDir, 'invoice-demo');
const mod = 'Meta';
const MODEL = 'qwen2.5-coder:7b';

interface ICapture { file: string; taken: boolean; note: string; model?: string }
const captures: ICapture[] = [];

function sleep(ms: number) {
	return new Promise(resolve => setTimeout(resolve, ms));
}

const playwrightCli = createRequire(import.meta.url).resolve('@playwright/cli/playwright-cli.js');

function pw(...args: string[]) {
	return execFileSync(process.execPath, [playwrightCli, `-s=${session}`, ...args], { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function value(output: string): string {
	const raw = /### Result\n(?<value>[\s\S]*?)\n### Ran Playwright code/.exec(output)?.groups?.value ?? output;
	try {
		const parsed: unknown = JSON.parse(raw);
		return typeof parsed === 'string' ? parsed : raw;
	} catch {
		return raw;
	}
}

function shoot(file: string, note: string, model?: string) {
	pw('screenshot', `--filename=${path.join(out, file)}`);
	captures.push({ file, taken: true, note, model });
	console.log(`  captured ${file}: ${note}`);
}

function skip(file: string, note: string) {
	captures.push({ file, taken: false, note });
	console.log(`  NOT captured ${file}: ${note}`);
}

async function command(label: string) {
	pw('press', 'F1');
	await sleep(800);
	pw('run-code', `async (page) => { await page.fill('.quick-input-box input', ${JSON.stringify('>' + label)}); }`);
	await sleep(1200);
	pw('press', 'Enter');
}

function git(...args: string[]) {
	execFileSync('git', ['-C', workspace, '-c', 'user.name=Demo', '-c', 'user.email=demo@example.invalid', ...args], { stdio: 'ignore' });
}

function seed() {
	fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
	fs.writeFileSync(path.join(workspace, 'package.json'), JSON.stringify({ name: 'invoice-demo', private: true, type: 'module', scripts: { test: 'node --test' } }, undefined, '\t'));
	fs.writeFileSync(path.join(workspace, 'src', 'invoice.js'), [
		'/** Sums the line items of an invoice. */',
		'export function invoiceTotal(items) {',
		'\tlet total = 0;',
		'\tfor (const item of items) {',
		'\t\ttotal += item.price * item.quantity;',
		'\t}',
		'\treturn total;',
		'}',
		'',
		'/** Formats an amount in cents as dollars. */',
		'export function formatCents(cents) {',
		'\treturn `$${(cents / 100).toFixed(2)}`;',
		'}',
		'',
	].join('\n'));
	fs.writeFileSync(path.join(workspace, 'src', 'invoice.test.js'), 'import { test } from \'node:test\';\nimport assert from \'node:assert\';\nimport { invoiceTotal } from \'./invoice.js\';\n\ntest(\'sums line items\', () => {\n\tassert.strictEqual(invoiceTotal([{ price: 250, quantity: 2 }]), 500);\n});\n');
	fs.writeFileSync(path.join(workspace, 'README.md'), '# invoice-demo\n\nA tiny repository for screenshots.\n');
	git('init', '-q');
	git('add', '-A');
	git('commit', '-q', '-m', 'Add invoice totals');
	const profile = path.join(runDir, 'user-data', 'User');
	fs.mkdirSync(profile, { recursive: true });
	fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ 'onyx.endpoints': [{ baseUrl: `${runtime}/v1` }], 'window.dialogStyle': 'custom' }, undefined, '\t'));
}

async function main(): Promise<number> {
	const version = await fetch(`${runtime}/api/version`).then(response => response.json() as Promise<{ version: string }>, () => undefined);
	if (!version) {
		throw new Error(`no runtime answers at ${runtime}; this script starts none and never uses the mock`);
	}
	fs.mkdirSync(out, { recursive: true });
	seed();
	const product = JSON.parse(fs.readFileSync(path.join(app, 'Contents', 'Resources', 'app', 'product.json'), 'utf8')) as { nameShort?: string; commit?: string };
	console.log(`captures · ${product.nameShort} ${product.commit?.slice(0, 11)} · Ollama ${version.version} at ${runtime}`);
	const executable = path.join(app, 'Contents', 'MacOS', fs.readdirSync(path.join(app, 'Contents', 'MacOS'))[0]);
	const child = spawn(executable, [`--user-data-dir=${path.join(runDir, 'user-data')}`, `--extensions-dir=${path.join(runDir, 'extensions')}`, `--remote-debugging-port=${cdpPort}`, '--use-mock-keychain', '--disable-workspace-trust', '--skip-release-notes', workspace, path.join(workspace, 'src', 'invoice.js')], { cwd: runDir, stdio: 'ignore', detached: true });
	let gifFrames: NodeJS.Timeout | undefined;
	try {
		for (let attempt = 0; attempt < 120; attempt++) {
			try {
				await (await fetch(`http://127.0.0.1:${cdpPort}/json/version`)).json();
				break;
			} catch {
				await sleep(1000);
			}
		}
		pw('attach', `--cdp=http://127.0.0.1:${cdpPort}`);
		pw('resize', '1440', '900');
		await sleep(10_000);

		const onboarding = value(pw('run-code', 'async (page) => String(await page.locator(".onboarding-a-overlay.visible").count())'));
		if (onboarding !== '0') {
			shoot('onyx-onboarding.png', 'first-run dialog on a fresh profile, with the private runtime named in settings');
			for (let step = 0; step < 6 && value(pw('run-code', 'async (page) => String(await page.locator(".onboarding-a-overlay.visible").count())')) !== '0'; step++) {
				pw('run-code', 'async (page) => { await page.locator("button.onboarding-a-btn-primary").click().catch(() => undefined); }');
				await sleep(1500);
			}
		} else {
			skip('onyx-onboarding.png', 'the first-run dialog did not appear');
		}
		await sleep(3000);
		shoot('onyx-workbench.png', 'the window after the first run, with the demo repository open', MODEL);

		await command('Onyx: Manage Models');
		await sleep(4000);
		shoot('onyx-model-library.png', 'Onyx: Manage Models on this Mac');
		pw('press', 'Escape');
		await sleep(800);

		// Inline edit with the real 7B model.
		pw('run-code', 'async (page) => { await page.locator(".editor-instance .view-lines").first().click(); }');
		pw('press', `${mod}+ArrowUp`);
		for (let line = 0; line < 8; line++) {
			pw('press', 'Shift+ArrowDown');
		}
		const frames = path.join(runDir, 'frames');
		if (gif) {
			fs.mkdirSync(frames);
			let frame = 0;
			gifFrames = setInterval(() => {
				try {
					pw('screenshot', `--filename=${path.join(frames, `${String(frame++).padStart(4, '0')}.png`)}`);
				} catch {
					// a frame missed is a frame missed
				}
			}, 1000);
		}
		pw('press', `${mod}+i`);
		await sleep(1500);
		pw('run-code', 'async (page) => { const input = await page.$(".onyx-inline-edit-input"); if (input) { await input.fill("Skip items whose quantity is not a positive number"); } }');
		pw('press', 'Enter');
		let proposed = false;
		const began = Date.now();
		while (Date.now() - began < 120_000 && !proposed) {
			await sleep(2000);
			proposed = value(pw('run-code', 'async (page) => String(!!document.querySelector(".onyx-inline-hunk"))')) === 'true';
		}
		const seconds = Math.round((Date.now() - began) / 1000);
		if (proposed) {
			await sleep(1500);
			shoot('onyx-inline-edit.png', `Cmd+I with ${MODEL}: the proposal shown as hunks under the lines it would replace; the file unchanged. ${seconds} s to the proposal`, MODEL);
		} else {
			skip('onyx-inline-edit.png', `${MODEL} produced no applicable proposal within 120 s`);
		}
		await sleep(4000);
		if (gifFrames) {
			clearInterval(gifFrames);
			gifFrames = undefined;
		}
		pw('press', 'Escape');
		if (gif) {
			const count = fs.readdirSync(frames).length;
			const made = count > 3 && spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', '2', '-i', path.join(frames, '%04d.png'), '-vf', 'scale=900:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse', path.join(out, 'onyx-demo.gif')]).status === 0;
			if (made) {
				captures.push({ file: 'onyx-demo.gif', taken: true, note: `inline edit with ${MODEL}, one frame a second of real time played at two frames a second (labelled as sped up twice); ${count} frames`, model: MODEL });
			} else {
				skip('onyx-demo.gif', 'too few frames');
			}
		}

		// Commit message from a staged change.
		fs.appendFileSync(path.join(workspace, 'src', 'invoice.js'), '\n/** Applies a percentage discount to an amount in cents. */\nexport function discount(cents, percent) {\n\treturn Math.round(cents * (1 - percent / 100));\n}\n');
		git('add', '-A');
		await command('Onyx: Generate Commit Message');
		await sleep(2000);
		pw('press', `${mod}+Shift+g`);
		let message = '';
		const commitBegan = Date.now();
		while (Date.now() - commitBegan < 90_000 && !message) {
			await sleep(2000);
			message = value(pw('run-code', 'async (page) => page.evaluate(() => (document.querySelector(".scm-editor .view-lines")?.textContent || "").trim())'));
		}
		if (message) {
			shoot('onyx-commit-message.png', `a commit message written by ${MODEL} from the staged diff`, MODEL);
		} else {
			skip('onyx-commit-message.png', 'no message appeared in the commit input within 90 s');
		}

		// One agent request, whatever happens.
		pw('run-code', `--filename=${path.join(repoRoot, '.agents', 'skills', 'launch', 'playwrightScripts', 'focus-chat-input.ts')}`);
		execFileSync(path.join(repoRoot, '.agents', 'skills', 'launch', 'scripts', 'monaco-paste.sh'), ['--session', session, 'In src/invoice.js, make invoiceTotal ignore items whose quantity is not a positive number, and add a test for it.'], { cwd: repoRoot, encoding: 'utf8' });
		pw('press', 'Enter');
		await sleep(2000);
		await command('Open Onyx Control Plane');
		let staged = 0;
		const agentBegan = Date.now();
		while (Date.now() - agentBegan < 240_000) {
			await sleep(5000);
			staged = Number(value(pw('run-code', 'async (page) => String(document.querySelectorAll(".onyx-change-file-path").length)')));
			const busy = value(pw('run-code', 'async (page) => String(!!document.querySelector(".chat-response-loading, .interactive-item-container.loading"))'));
			if (staged > 0 || busy === 'false') {
				break;
			}
		}
		await sleep(3000);
		shoot('onyx-agent-attempt.png', staged > 0 ? `an agent request to ${MODEL}: ${staged} file(s) with a proposal waiting for review` : `an agent request to ${MODEL}: it ended without proposing an edit, as the project's measurements say is usual`, MODEL);
		captures[captures.length - 1].note += ` (${Math.round((Date.now() - agentBegan) / 1000)} s)`;
		try {
			pw('close');
		} catch {
			// nothing to close
		}
	} finally {
		if (gifFrames) {
			clearInterval(gifFrames);
		}
		for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
			try {
				process.kill(-child.pid!, signal);
			} catch {
				// already gone
			}
			await sleep(2500);
		}
		fs.rmSync(runDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
	}
	fs.writeFileSync(path.join(out, 'captures.json'), JSON.stringify({ ranAt: new Date().toISOString(), product: { nameShort: product.nameShort, commit: product.commit }, runtime: `Ollama ${version.version}`, model: MODEL, captures }, undefined, '\t'));
	console.log(`${captures.filter(capture => capture.taken).length} of ${captures.length} captured`);
	return 0;
}

main().then(code => process.exit(code), error => {
	console.error(`captures: ${error instanceof Error ? error.message : error}`);
	process.exit(1);
});
