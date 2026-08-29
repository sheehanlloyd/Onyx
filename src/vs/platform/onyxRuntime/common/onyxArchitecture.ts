/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The architecture map's pure half: raw per-file facts (path, size, imports)
 * become modules, dependency edges, and hot spots. A "module" is a directory
 * at a bounded depth — the granularity people actually draw on whiteboards —
 * and every number the map shows (fan-in, churn, size) is computed here,
 * where it can be tested against a synthetic repository.
 */

export interface IOnyxFileFacts {
	/** Workspace-relative path, `/`-separated. */
	readonly path: string;
	readonly lines: number;
	/** Workspace-relative paths this file imports (already resolved). */
	readonly imports: readonly string[];
}

export interface IOnyxModuleNode {
	/** Module id: the directory path at the chosen granularity ('' never occurs; root files land in '.'). */
	readonly id: string;
	readonly fileCount: number;
	readonly lines: number;
	/** Modules this one imports from, with reference counts. */
	readonly dependencies: readonly { readonly to: string; readonly count: number }[];
	/** How many other modules import this one. */
	readonly fanIn: number;
	/** Commits that touched this module in the sampled window. */
	readonly churnCommits: number;
	/** 0..1 — how hot this module is relative to the repository. */
	readonly heat: number;
}

export interface IOnyxArchitectureMap {
	readonly modules: readonly IOnyxModuleNode[];
	readonly totalFiles: number;
	readonly analysisMs: number;
	readonly truncated: boolean;
}

/**
 * Assigns a file to its module: the first `depth` directory segments. Files
 * at the root belong to the module `.`.
 */
export function moduleOf(path: string, depth: number): string {
	const segments = path.split('/');
	if (segments.length <= 1) {
		return '.';
	}
	return segments.slice(0, Math.min(depth, segments.length - 1)).join('/');
}

/**
 * Picks the granularity that keeps the map readable: start at depth 2 and
 * deepen while the module count stays small, so a flat repository gets fine
 * modules and a deep monorepo is not one giant blob.
 */
export function chooseGranularity(paths: readonly string[], targetModules: number): number {
	let best = 1;
	for (let depth = 1; depth <= 4; depth++) {
		const modules = new Set(paths.map(path => moduleOf(path, depth)));
		best = depth;
		if (modules.size >= targetModules) {
			break;
		}
	}
	return best;
}

/** Aggregates file facts into the module graph. `churnByFile` maps path → commits touching it. */
export function aggregateModules(
	files: readonly IOnyxFileFacts[],
	depth: number,
	churnByFile: ReadonlyMap<string, number>,
	options?: { readonly maxModules?: number },
): Omit<IOnyxArchitectureMap, 'analysisMs' | 'truncated'> {
	const maxModules = options?.maxModules ?? 60;
	interface IMutableModule { fileCount: number; lines: number; deps: Map<string, number>; churn: number }
	const modules = new Map<string, IMutableModule>();
	const moduleFor = (path: string): string => moduleOf(path, depth);

	for (const file of files) {
		const id = moduleFor(file.path);
		const entry = modules.get(id) ?? { fileCount: 0, lines: 0, deps: new Map(), churn: 0 };
		entry.fileCount++;
		entry.lines += file.lines;
		entry.churn += churnByFile.get(file.path) ?? 0;
		for (const target of file.imports) {
			const targetModule = moduleFor(target);
			if (targetModule !== id) {
				entry.deps.set(targetModule, (entry.deps.get(targetModule) ?? 0) + 1);
			}
		}
		modules.set(id, entry);
	}

	// Keep the biggest modules; fold the tail into their parent segment or drop.
	const kept = [...modules.entries()]
		.sort((a, b) => b[1].lines - a[1].lines)
		.slice(0, maxModules);
	const keptIds = new Set(kept.map(([id]) => id));

	const fanIn = new Map<string, number>();
	for (const [id, entry] of kept) {
		for (const to of entry.deps.keys()) {
			if (keptIds.has(to) && to !== id) {
				fanIn.set(to, (fanIn.get(to) ?? 0) + 1);
			}
		}
	}

	const maxChurn = Math.max(1, ...kept.map(([, entry]) => entry.churn));
	const maxFanIn = Math.max(1, ...[...fanIn.values()]);
	const nodes: IOnyxModuleNode[] = kept.map(([id, entry]) => ({
		id,
		fileCount: entry.fileCount,
		lines: entry.lines,
		dependencies: [...entry.deps.entries()]
			.filter(([to]) => keptIds.has(to))
			.map(([to, count]) => ({ to, count }))
			.sort((a, b) => b.count - a.count),
		fanIn: fanIn.get(id) ?? 0,
		churnCommits: entry.churn,
		// Heat blends how often a module changes with how many depend on it —
		// the two ingredients of "touch this carefully".
		heat: Math.round(((entry.churn / maxChurn) * 0.6 + ((fanIn.get(id) ?? 0) / maxFanIn) * 0.4) * 100) / 100,
	})).sort((a, b) => b.heat - a.heat || b.lines - a.lines);

	return { modules: nodes, totalFiles: files.length };
}

/**
 * Resolves a relative import specifier against the importing file's path,
 * normalized to a workspace-relative path without extension games: the
 * caller matches the result against known file paths. Returns undefined for
 * bare (package) imports — those are external by definition.
 */
export function resolveRelativeImport(importerPath: string, specifier: string): string | undefined {
	if (!specifier.startsWith('.')) {
		return undefined;
	}
	const importerDir = importerPath.split('/').slice(0, -1);
	const parts = specifier.split('/');
	const stack = [...importerDir];
	for (const part of parts) {
		if (part === '.' || part === '') {
			continue;
		}
		if (part === '..') {
			if (stack.length === 0) {
				return undefined; // escapes the workspace
			}
			stack.pop();
		} else {
			stack.push(part);
		}
	}
	return stack.join('/');
}

/** Import specifiers found in a source file's head, cheap and language-tolerant. */
export function extractImportSpecifiers(source: string): string[] {
	const specifiers: string[] = [];
	const patterns = [
		/\bimport\s+[^'"]*?from\s+['"](?<spec>[^'"]+)['"]/g,
		/\bimport\s*\(\s*['"](?<spec>[^'"]+)['"]\s*\)/g,
		/\bimport\s+['"](?<spec>[^'"]+)['"]/g,
		/\brequire\s*\(\s*['"](?<spec>[^'"]+)['"]\s*\)/g,
		/\bfrom\s+(?<spec>[.\w/]+)\s+import\b/g, // python
	];
	for (const pattern of patterns) {
		for (const match of source.matchAll(pattern)) {
			if (match.groups?.spec) {
				specifiers.push(match.groups.spec);
			}
		}
	}
	return [...new Set(specifiers)];
}
