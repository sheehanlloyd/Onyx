/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Builds a task set from a repository's history (L9, L10): the commits the
 * product's own rule accepts as tasks (one changed file, a real change that
 * is not a rewrite, no merge or mechanical commit), narrowed to source
 * files that fit a prompt, and written as commit ids and content hashes.
 * Never content: a task's file and its subject are read from the
 * repository when a campaign runs.
 *
 *   node test/onyx/lab/make-task-set.mts --out <tasks.json> --count <n> [--repo <path>] [--scan <commits>]
 *        [--since <date>] [--until <date>] [--max-before-chars <n>] [--name <text>] [--exclude-path <prefix>]…
 *
 * It needs compiled output (`pnpm run transpile-client`): the selection is
 * the product's `selectBenchmarkCommits`.
 */

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const out = (relative: string) => pathToFileURL(path.join(repoRoot, 'out', relative)).href;

function flag(name: string): string | undefined {
	const index = process.argv.indexOf(name);
	return index === -1 ? undefined : process.argv[index + 1];
}
function flags(name: string): string[] {
	return process.argv.flatMap((argument, index) => argument === name && process.argv[index + 1] ? [process.argv[index + 1]] : []);
}

const outPath = flag('--out');
const count = Number(flag('--count') ?? 0);
if (!outPath || !(count > 0)) {
	console.error('usage: node test/onyx/lab/make-task-set.mts --out <tasks.json> --count <n> [--repo <path>] [--scan <commits>] [--since <date>] [--until <date>] [--max-before-chars <n>] [--name <text>] [--exclude-path <prefix>]…');
	process.exit(2);
}
const repo = path.resolve(flag('--repo') ?? repoRoot);
const scan = Number(flag('--scan') ?? 4000);
const maxBeforeChars = Number(flag('--max-before-chars') ?? 12_000);
const since = flag('--since');
const until = flag('--until');
const excluded = flags('--exclude-path');
/** Source a model edits as text. Documents, data, generated and binary files are not tasks. */
const SOURCE = /\.(ts|tsx|mts|js|mjs|cjs|jsx|css|rs|py|rb|go|java|c|h|cc|cpp|sh|swift|kt)$/;

const git = (args: readonly string[]): string => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
const digest = (text: string) => crypto.createHash('sha256').update(text).digest('hex');
const show = (revision: string, file: string): string | undefined => {
	try {
		return git(['show', `${revision}:${file}`]);
	} catch {
		return undefined;
	}
};

interface ICandidate { hash: string; subject: string; files: string[]; insertions: number; deletions: number; authoredAt: string }
const { selectBenchmarkCommits }: { selectBenchmarkCommits(candidates: readonly ICandidate[], count: number): { hash: string; file: string; kind: string }[] } = await import(out('vs/workbench/contrib/onyx/common/onyxRepoBench.js'));

const raw = git(['log', '--no-merges', '--numstat', '--format=@@%H|%aI|%s', '-n', String(scan), ...(since ? [`--since=${since}`] : []), ...(until ? [`--until=${until}`] : [])]);
const candidates: ICandidate[] = [];
for (const line of raw.split('\n')) {
	if (line.startsWith('@@')) {
		const [hash, authoredAt, ...subject] = line.slice(2).split('|');
		candidates.push({ hash, authoredAt, subject: subject.join('|'), files: [], insertions: 0, deletions: 0 });
		continue;
	}
	const match = /^(?<ins>\d+|-)\t(?<del>\d+|-)\t(?<file>.+)$/.exec(line);
	const current = candidates.at(-1);
	if (match?.groups && current) {
		current.files.push(match.groups.file);
		current.insertions += match.groups.ins === '-' ? 0 : Number(match.groups.ins);
		current.deletions += match.groups.del === '-' ? 0 : Number(match.groups.del);
	}
}
const byHash = new Map(candidates.map(candidate => [candidate.hash, candidate]));
const sourceOnly = candidates.filter(candidate => candidate.files.length === 1 && SOURCE.test(candidate.files[0]) && !excluded.some(prefix => candidate.files[0].startsWith(prefix)));
// Everything the product's rule accepts, then the ones whose file exists on both sides and fits a prompt.
const eligible = selectBenchmarkCommits(sourceOnly, sourceOnly.length).flatMap(task => {
	const before = show(`${task.hash}~1`, task.file);
	const after = show(task.hash, task.file);
	if (before === undefined || after === undefined || before.length > maxBeforeChars || before.length === 0) {
		return [];
	}
	const candidate = byHash.get(task.hash)!;
	return [{ id: task.hash.slice(0, 12), commit: task.hash, file: task.file, kind: task.kind, authoredAt: candidate.authoredAt, beforeHash: digest(before), afterHash: digest(after), beforeChars: before.length, changedLines: candidate.insertions + candidate.deletions }];
});
// Spread over the scanned history, deterministically: every k-th eligible commit.
const step = Math.max(1, Math.floor(eligible.length / count));
const tasks = eligible.filter((_, index) => index % step === 0).slice(0, count);
const hash = digest(tasks.map(task => `${task.commit}:${task.file}:${task.beforeHash}:${task.afterHash}`).join('\n')).slice(0, 16);
const document = {
	name: flag('--name') ?? `history tasks of ${path.basename(repo)}`,
	hash,
	builtAt: new Date().toISOString(),
	head: git(['rev-parse', 'HEAD']).trim(),
	selection: { rule: 'selectBenchmarkCommits (one changed file, 3 to 80 changed lines, no merge, revert, bump or wip), source files only', scannedCommits: candidates.length, since: since ?? null, until: until ?? null, maxBeforeChars, excludedPaths: excluded, eligible: eligible.length, taken: tasks.length, spread: `every ${step}${step === 1 ? 'st' : 'th'} eligible commit, newest first` },
	tasks,
};
fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
fs.writeFileSync(path.resolve(outPath), JSON.stringify(document, undefined, '\t') + '\n');
console.log(`${tasks.length} task${tasks.length === 1 ? '' : 's'} of ${eligible.length} eligible (${candidates.length} commits scanned); task-set hash ${hash}; ${path.relative(process.cwd(), path.resolve(outPath))}`);
