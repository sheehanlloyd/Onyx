/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Upstream drill (A9, DEC-05). Measures how far this fork has drifted from an
 * upstream release without touching the working tree:
 *
 *   node test/onyx/run-upstream-drill.mts [--ref <tag> | --latest-release] [--base <rev>]
 *                                         [--upstream <url>] [--out <report.md>] [--json-out <file>]
 *
 * 1. Fetches the upstream tag (into `refs/tags/upstream-drill/<tag>`) and the merge base.
 * 2. `git merge-tree --write-tree` of the base revision and the tag: the conflicted paths, split
 *    into the ones REBASE.md predicts and the ones it does not.
 * 3. Every symbol the Onyx-owned sources import from an upstream module is checked against that
 *    module in the merged tree: a symbol that is no longer exported is a consumed-API break.
 * 4. Build-infrastructure drift that changes how the fork installs: package manager, Node pin,
 *    lockfile.
 *
 * The report is informational: the process exits non-zero only when the drill itself cannot
 * run. Weekly in CI (`onyx-upstream-drill.yml`) and on demand.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function argValue(flag: string): string | undefined {
	const index = process.argv.indexOf(flag);
	return index === -1 ? undefined : process.argv[index + 1];
}

const upstreamUrl = argValue('--upstream') ?? 'https://github.com/microsoft/vscode.git';
const base = argValue('--base') ?? 'HEAD';
const outPath = argValue('--out');
const jsonOut = argValue('--json-out');
const ONYX_DIRS = ['src/vs/platform/onyxRuntime', 'src/vs/workbench/contrib/onyx'];
const ONYX_OWNED = [...ONYX_DIRS, 'extensions/theme-onyx', 'test/onyx', 'docs'];

function git(args: string[], options: { allowFailure?: boolean } = {}): { stdout: string; status: number } {
	const result = spawnSync('git', ['-C', repoRoot, '--no-optional-locks', ...args], { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
	if (result.status !== 0 && !options.allowFailure) {
		throw new Error(`git ${args.join(' ')} failed (${result.status}): ${result.stderr.trim()}`);
	}
	return { stdout: result.stdout, status: result.status ?? 1 };
}

/** The highest `X.Y.Z` tag upstream publishes; releases are tagged that way. */
function latestReleaseTag(): string {
	const lines = execFileSync('git', ['ls-remote', '--tags', '--refs', upstreamUrl], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\n');
	const tags = lines.map(line => /refs\/tags\/(?<tag>\d+\.\d+\.\d+)$/.exec(line)?.groups?.tag).filter((tag): tag is string => !!tag);
	tags.sort((a, b) => {
		const [a1, a2, a3] = a.split('.').map(Number);
		const [b1, b2, b3] = b.split('.').map(Number);
		return a1 - b1 || a2 - b2 || a3 - b3;
	});
	if (!tags.length) {
		throw new Error(`no X.Y.Z tags at ${upstreamUrl}`);
	}
	return tags[tags.length - 1];
}

interface IConsumedImport { readonly file: string; readonly line: number; readonly target: string; readonly symbols: string[] }

/** Named imports in Onyx sources that resolve to files outside the Onyx-owned paths. */
function consumedImports(): IConsumedImport[] {
	const found: IConsumedImport[] = [];
	const files = git(['ls-files', '--', ...ONYX_DIRS]).stdout.split('\n').filter(name => name.endsWith('.ts'));
	for (const file of files) {
		const text = fs.readFileSync(path.join(repoRoot, file), 'utf8');
		const lines = text.split('\n');
		lines.forEach((line, index) => {
			const match = /^import\s+(?:type\s+)?\{(?<names>[^}]+)\}\s+from\s+'(?<spec>\.[^']+)';/.exec(line);
			if (!match?.groups) {
				return;
			}
			const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), match.groups.spec)).replace(/\.js$/, '.ts');
			if (ONYX_OWNED.some(owned => target.startsWith(`${owned}/`))) {
				return;
			}
			const symbols = match.groups.names.split(',').map(name => name.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0]).filter(Boolean);
			found.push({ file, line: index + 1, target, symbols });
		});
	}
	return found;
}

/**
 * The names a module exports in the given tree: declarations, `export { … }`
 * lists, `export import X = Y` aliases, `export default`, and the exports of
 * every `export * from './…'` barrel it re-exports, followed recursively.
 */
function exportsOf(tree: string, file: string, source: string, seen = new Set<string>()): Set<string> {
	const names = new Set<string>();
	seen.add(file);
	for (const match of source.matchAll(/^export\s+(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:const\s+enum|const|let|var|function\*?|class|interface|type|enum|namespace)\s+(?<name>[A-Za-z_$][\w$]*)/gm)) {
		names.add(match.groups!.name);
	}
	for (const match of source.matchAll(/^export\s+import\s+(?<name>[A-Za-z_$][\w$]*)\s*=/gm)) {
		names.add(match.groups!.name);
	}
	if (/^export\s+default\b/m.test(source)) {
		names.add('default');
	}
	for (const match of source.matchAll(/^export\s*(?:type\s*)?\{(?<list>[^}]+)\}/gm)) {
		for (const entry of match.groups!.list.split(',')) {
			const exported = entry.trim().split(/\s+as\s+/).pop()?.replace(/^type\s+/, '').trim();
			if (exported) {
				names.add(exported);
			}
		}
	}
	for (const match of source.matchAll(/^export\s*\*\s*from\s*'(?<spec>\.[^']+)';/gm)) {
		const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), match.groups!.spec)).replace(/\.js$/, '.ts');
		if (seen.has(target)) {
			continue;
		}
		const show = git(['show', `${tree}:${target}`], { allowFailure: true });
		if (show.status === 0) {
			for (const name of exportsOf(tree, target, show.stdout, seen)) {
				names.add(name);
			}
		}
	}
	return names;
}

function main() {
	const ref = process.argv.includes('--latest-release') ? latestReleaseTag() : argValue('--ref');
	if (!ref) {
		console.error('usage: node test/onyx/run-upstream-drill.mts (--ref <tag> | --latest-release) [--base <rev>] [--upstream <url>] [--out <report.md>] [--json-out <file>]');
		process.exit(2);
	}
	const localTag = `upstream-drill/${ref}`;
	console.log(`drill: ${upstreamUrl} ${ref} against ${base}`);
	if (git(['rev-parse', '--verify', '--quiet', `refs/tags/${localTag}`], { allowFailure: true }).status !== 0) {
		git(['fetch', '--no-tags', '--quiet', upstreamUrl, `refs/tags/${ref}:refs/tags/${localTag}`]);
	}
	const upstreamCommit = git(['rev-parse', `refs/tags/${localTag}^{commit}`]).stdout.trim();
	const baseCommit = git(['rev-parse', base]).stdout.trim();
	const mergeBase = git(['merge-base', baseCommit, upstreamCommit]).stdout.trim();
	const upstreamCommits = Number(git(['rev-list', '--count', `${mergeBase}..${upstreamCommit}`]).stdout.trim());
	const forkCommits = Number(git(['rev-list', '--count', `${mergeBase}..${baseCommit}`]).stdout.trim());

	// Conflicts, without a worktree.
	const mergeTree = git(['merge-tree', '--write-tree', '--name-only', baseCommit, upstreamCommit], { allowFailure: true });
	if (mergeTree.status > 1) {
		throw new Error(`git merge-tree failed: ${mergeTree.stdout}`);
	}
	const mergeLines = mergeTree.stdout.split('\n');
	const mergedTree = mergeLines[0].trim();
	const conflicted = mergeTree.status === 1 ? mergeLines.slice(1).map(line => line.trim()).filter(line => line.length && !line.startsWith('CONFLICT') && !line.includes(' ')) : [];
	const rebase = fs.existsSync(path.join(repoRoot, 'REBASE.md')) ? fs.readFileSync(path.join(repoRoot, 'REBASE.md'), 'utf8') : '';
	const predicted = conflicted.filter(file => rebase.includes(`\`${file}\``) || rebase.includes(`\`${path.basename(file)}\``));
	const unpredicted = conflicted.filter(file => !predicted.includes(file));

	// Consumed API symbols, checked against the merged tree (upstream's version wins for unconflicted files).
	const missing: { file: string; line: number; target: string; symbol: string; reason: string }[] = [];
	const cache = new Map<string, Set<string> | undefined>();
	let symbolsChecked = 0;
	for (const entry of consumedImports()) {
		let exported = cache.get(entry.target);
		if (!cache.has(entry.target)) {
			const show = git(['show', `${mergedTree}:${entry.target}`], { allowFailure: true });
			exported = show.status === 0 ? exportsOf(mergedTree, entry.target, show.stdout) : undefined;
			cache.set(entry.target, exported);
		}
		for (const symbol of entry.symbols) {
			symbolsChecked++;
			if (!exported) {
				missing.push({ ...entry, symbol, reason: 'module missing in the merged tree' });
			} else if (!exported.has(symbol)) {
				missing.push({ ...entry, symbol, reason: 'no longer exported' });
			}
		}
	}

	// Build-infrastructure drift.
	const upstreamFile = (file: string) => git(['show', `${upstreamCommit}:${file}`], { allowFailure: true });
	const upstreamPackage = JSON.parse(upstreamFile('package.json').stdout || '{}') as { packageManager?: string };
	const infrastructure = {
		packageManager: upstreamPackage.packageManager ?? 'npm (no packageManager field)',
		upstreamLockfile: ['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock'].filter(file => upstreamFile(file).status === 0),
		forkLockfile: ['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock'].filter(file => fs.existsSync(path.join(repoRoot, file))),
		upstreamNode: upstreamFile('.nvmrc').stdout.trim(),
		forkNode: fs.existsSync(path.join(repoRoot, '.nvmrc')) ? fs.readFileSync(path.join(repoRoot, '.nvmrc'), 'utf8').trim() : '',
	};

	const report = {
		ranAt: new Date().toISOString(),
		upstream: { url: upstreamUrl, ref, commit: upstreamCommit },
		base: { rev: base, commit: baseCommit },
		mergeBase,
		commits: { upstreamSinceBase: upstreamCommits, forkSinceBase: forkCommits },
		conflicts: { total: conflicted.length, predictedByRebaseMd: predicted, unpredicted },
		consumedApi: { symbolsChecked, missing },
		infrastructure,
	};

	const lines = [
		`# Upstream drill: ${ref} against ${base} (${baseCommit.slice(0, 11)})`,
		'',
		`Run at ${report.ranAt}. Upstream ${upstreamUrl} tag \`${ref}\` = \`${upstreamCommit.slice(0, 11)}\`; merge base \`${mergeBase.slice(0, 11)}\`; ${upstreamCommits} upstream commits and ${forkCommits} fork commits since the base.`,
		'',
		`## Conflicts: ${conflicted.length}`,
		'',
		...(conflicted.length ? [
			`Predicted by REBASE.md (${predicted.length}):`,
			...predicted.map(file => `- \`${file}\``),
			'',
			`Not predicted by REBASE.md (${unpredicted.length}):`,
			...(unpredicted.length ? unpredicted.map(file => `- \`${file}\``) : ['- none']),
		] : ['The merge is clean.']),
		'',
		`## Consumed upstream API: ${missing.length} missing of ${symbolsChecked} symbols checked`,
		'',
		...(missing.length ? ['| Importing file | Symbol | From | Why |', '|---|---|---|---|', ...missing.map(entry => `| \`${entry.file}:${entry.line}\` | \`${entry.symbol}\` | \`${entry.target}\` | ${entry.reason} |`)] : ['Every symbol the Onyx sources import from upstream modules is still exported in the merged tree.']),
		'',
		'## Build infrastructure',
		'',
		`| | Upstream \`${ref}\` | This fork |`,
		'|---|---|---|',
		`| Package manager | ${infrastructure.packageManager} | ${fs.existsSync(path.join(repoRoot, 'pnpm-lock.yaml')) ? 'pnpm' : 'npm'} |`,
		`| Lockfile | ${infrastructure.upstreamLockfile.join(', ') || 'none'} | ${infrastructure.forkLockfile.join(', ') || 'none'} |`,
		`| Node (.nvmrc) | ${infrastructure.upstreamNode} | ${infrastructure.forkNode} |`,
		'',
	];
	const markdown = lines.join('\n');
	console.log(markdown);
	if (outPath) {
		fs.mkdirSync(path.dirname(outPath), { recursive: true });
		fs.writeFileSync(outPath, markdown);
	}
	if (jsonOut) {
		fs.mkdirSync(path.dirname(jsonOut), { recursive: true });
		fs.writeFileSync(jsonOut, JSON.stringify(report, undefined, '\t'));
	}
}

main();
