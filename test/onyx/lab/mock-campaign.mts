/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * What a campaign against the mock runtime needs (L9, R-49): a disposable
 * repository with a history of small commits, a mock on a port of its own,
 * and a manifest. The commits make the change the mock makes, so a unit the
 * mock answers scores 1 and one it does not answer is told apart.
 */

import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

export function git(cwd: string, ...args: string[]): string {
	return execFileSync('git', ['-C', cwd, '-c', 'user.email=onyx-lab@localhost', '-c', 'user.name=onyx-lab', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' });
}

export interface ISeededRepository { readonly dir: string; readonly tasks: { readonly id: string; readonly commit: string; readonly file: string }[] }

/**
 * A repository whose history is one base commit and then one commit a
 * task. `subjects[i]` is the i-th task's commit subject; its change is the
 * mock's: the first line of `src/f<i>.ts` that returns something gets
 * ` // edited-by-mock` at its end.
 */
export function seedRepository(parent: string, subjects: readonly string[]): ISeededRepository {
	const dir = path.join(parent, 'repository');
	fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
	git(dir, 'init', '--quiet', '--initial-branch=main');
	subjects.forEach((_, index) => fs.writeFileSync(path.join(dir, 'src', `f${index}.ts`), `export function f${index}(a: number, b: number): number {\n\treturn a + b + ${index};\n}\n`));
	git(dir, 'add', '-A');
	git(dir, 'commit', '--quiet', '-m', 'Base: one function a file');
	const tasks = subjects.map((subject, index) => {
		const file = `src/f${index}.ts`;
		fs.writeFileSync(path.join(dir, file), `export function f${index}(a: number, b: number): number {\n\treturn a + b + ${index}; // edited-by-mock\n}\n`);
		git(dir, 'add', '-A');
		git(dir, 'commit', '--quiet', '-m', subject);
		return { id: `t${index}`, commit: git(dir, 'rev-parse', 'HEAD').trim(), file };
	});
	return { dir, tasks };
}

export async function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = net.createServer();
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const address = server.address();
			const port = typeof address === 'object' && address ? address.port : 0;
			server.close(() => resolve(port));
		});
	});
}

export async function startMock(environment: Record<string, string> = {}): Promise<{ readonly port: number; readonly baseUrl: string; stop(): void; debug(pathname: string): Promise<unknown> }> {
	const port = await freePort();
	const child: ChildProcess = spawn(process.execPath, [path.join(repoRoot, 'test', 'onyx', 'mock-ollama.mts')], { env: { ...process.env, ONYX_MOCK_PORT: String(port), ...environment }, stdio: 'ignore' });
	const root = `http://127.0.0.1:${port}`;
	for (let waited = 0; waited < 100; waited++) {
		try {
			if ((await fetch(`${root}/v1/models`)).ok) {
				break;
			}
		} catch {
			await new Promise(resolve => setTimeout(resolve, 100));
		}
	}
	return { port, baseUrl: `${root}/v1`, stop: () => { child.kill('SIGKILL'); }, debug: async pathname => (await fetch(`${root}${pathname}`)).json() };
}

/** Writes a campaign's manifest and task set into `<parent>/<name>/` and returns the manifest's path. */
export function writeCampaign(parent: string, name: string, options: { readonly tier: 'S' | 'A'; readonly baseUrl: string; readonly models: readonly string[]; readonly tasks: readonly object[]; readonly seeds?: readonly number[]; readonly configurations?: readonly { name: string; hash: string; configuration?: object }[]; readonly unitTimeoutMs?: number }): string {
	const dir = path.join(parent, name);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, 'tasks.json'), JSON.stringify({ name: 'mock tasks', tasks: options.tasks }, undefined, '\t'));
	fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
		version: 1, name, createdAt: new Date().toISOString(),
		models: options.models.map(id => ({ identifier: `mock:${id}`, digest: 'mock', runtime: { name: 'mock', version: 'test' }, context: { requestedTokens: null, reportedTokens: 16384, verifiedTokens: null, mechanism: null } })),
		seeds: options.seeds ?? [1], sampling: { temperature: 0, maxTokens: 512 },
		harnessConfigurations: options.configurations ?? [{ name: 'default', hash: '00000000' }],
		taskSet: { name: 'mock tasks', hash: '00000000', count: options.tasks.length }, repetitions: 1,
		machine: { platform: process.platform, arch: process.arch, cpu: os.cpus()[0]?.model ?? 'unknown', memoryGiB: Math.round(os.totalmem() / 1024 ** 3) },
		regenerate: [{ output: 'results.jsonl, summary.json', command: `node test/onyx/lab/run-lab.mts <this manifest> --rescore` }],
		campaign: { tier: options.tier, baseUrl: options.baseUrl, tasks: 'tasks.json', ...(options.unitTimeoutMs ? { unitTimeoutMs: options.unitTimeoutMs } : {}) },
		notes: 'A campaign against the mock runtime, written by a test.',
	}, undefined, '\t'));
	return path.join(dir, 'manifest.json');
}
