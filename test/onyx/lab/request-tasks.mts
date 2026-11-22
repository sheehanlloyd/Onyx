/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Task source 2 (L10): tasks made of the user's own requests. A journaled
 * request becomes a task when its proposal was accepted and the accepted
 * lines later appear in a commit. This reads a workspace's run journal and
 * its repository, on this machine, and prints what it found; nothing is
 * sent anywhere.
 *
 *   node test/onyx/lab/request-tasks.mts --journal <…/onyx/journal/runs> --repo <path> --opt-in [--out <tasks.json>]
 *
 * `--opt-in` stands for the workspace setting `onyx.lab.requestTasks`:
 * without it nothing is read and there are no tasks. The output holds ids,
 * commits and counts. The instruction, which is the user's own text, is
 * written only with `--with-instructions`, for a file the user keeps.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const out = (relative: string) => pathToFileURL(path.join(repoRoot, 'out', relative)).href;
const flag = (name: string): string | undefined => {
	const index = process.argv.indexOf(name);
	return index === -1 ? undefined : process.argv[index + 1];
};

interface IRequest { readonly runId: string; readonly request: string | undefined; readonly head: string | undefined; readonly accepted: readonly { path: string; addedLineDigests: readonly string[] }[] }
interface ILookup { isReachable(commit: string): boolean; firstCommitContaining(file: string, digests: readonly string[], since: string): { commit: string; authoredAt: string } | undefined }
interface ITasksModule {
	journaledRequest(runId: string, events: readonly { kind: string; data?: unknown }[]): IRequest;
	deriveRequestTasks(optedIn: boolean, requests: readonly IRequest[], lookup: ILookup): { tasks: { id: string; runId: string; instruction: string; base: string; commit: string; file: string; authoredAt: string }[]; requests: number; skipped: Record<string, number> };
	contentHoldsLines(content: string, digests: readonly string[]): boolean;
}

/** What the repository answers about a request: whether its base is still there, and where its accepted lines were first committed. */
export function gitRequestLookup(repo: string, holds: ITasksModule['contentHoldsLines']): ILookup {
	const git = (args: readonly string[]): string | undefined => {
		try {
			return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
		} catch {
			return undefined;
		}
	};
	return {
		isReachable: commit => /^[0-9a-f]{7,40}$/.test(commit) && git(['merge-base', '--is-ancestor', commit, 'HEAD']) !== undefined,
		firstCommitContaining: (file, digests, since) => {
			if (!/^[0-9a-f]{7,40}$/.test(since) || file.startsWith('-')) {
				return undefined;
			}
			const commits = (git(['log', '--reverse', '--format=%H|%aI', `${since}..HEAD`, '--', file]) ?? '').split('\n').filter(Boolean);
			for (const line of commits) {
				const [commit, authoredAt] = line.split('|');
				const content = git(['show', `${commit}:${file}`]);
				if (content !== undefined && holds(content, digests)) {
					return { commit, authoredAt };
				}
			}
			return undefined;
		},
	};
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const journal = flag('--journal');
	const repo = flag('--repo');
	if (!journal || !repo) {
		console.error('usage: node test/onyx/lab/request-tasks.mts --journal <runs directory> --repo <path> --opt-in [--out <tasks.json>] [--with-instructions]');
		process.exit(2);
	}
	const tasks: ITasksModule = await import(out('vs/workbench/contrib/onyx/common/onyxLabTasks.js'));
	const optedIn = process.argv.includes('--opt-in');
	// Without the opt-in the journal is not opened.
	const requests = !optedIn ? [] : fs.readdirSync(journal).filter(name => name.endsWith('.jsonl')).sort().map(name => {
		const events = fs.readFileSync(path.join(journal, name), 'utf8').split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
		return tasks.journaledRequest(name.replace(/\.jsonl$/, ''), events);
	});
	const summary = tasks.deriveRequestTasks(optedIn, requests, gitRequestLookup(path.resolve(repo), tasks.contentHoldsLines));
	const withInstructions = process.argv.includes('--with-instructions');
	const document = {
		source: 'request', optedIn, requests: summary.requests, skipped: summary.skipped,
		tasks: summary.tasks.map(task => ({ id: task.id, commit: task.commit, base: task.base, file: task.file, authoredAt: task.authoredAt, source: 'request', ...(withInstructions ? { instruction: task.instruction } : {}) })),
	};
	const outPath = flag('--out');
	if (outPath) {
		fs.writeFileSync(path.resolve(outPath), JSON.stringify(document, undefined, '\t') + '\n');
	}
	console.log(JSON.stringify({ optedIn, requests: summary.requests, tasks: summary.tasks.length, skipped: summary.skipped }));
}
