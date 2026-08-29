/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import { dirname, extname, join, relative } from '../../../base/common/path.js';
import {
	aggregateModules, chooseGranularity, extractImportSpecifiers, IOnyxArchitectureMap, IOnyxFileFacts, resolveRelativeImport
} from '../common/onyxArchitecture.js';

/**
 * Walks a workspace once and produces the architecture map: per-file import
 * facts aggregated into modules with dependency edges and churn. Designed to
 * stay fast on large repositories — bounded reads (imports live in a file's
 * head), a hard file cap, and a persisted cache keyed by a cheap signature so
 * repeat opens cost a stat-walk, not a re-read.
 */

const EXCLUDED_DIRECTORIES = new Set([
	'node_modules', '.git', 'out', 'dist', 'build', '.build', 'target', 'coverage', 'vendor',
	'__pycache__', '.venv', 'venv', '.next', '.cache', 'DerivedData', 'Pods',
]);

const SOURCE_EXTENSIONS = new Set([
	'.ts', '.tsx', '.js', '.jsx', '.mjs', '.mts', '.cjs', '.py', '.go', '.rs', '.java', '.kt',
	'.c', '.h', '.cpp', '.hpp', '.cc', '.cs', '.rb', '.php', '.swift', '.m', '.mm',
]);

const MAX_FILES = 30_000;
/** Imports live at the top; reading heads keeps 18k files under a few seconds. */
const HEAD_BYTES = 16 * 1024;
const TARGET_MODULES = 24;

interface IPersistedArchitecture {
	readonly signature: string;
	readonly map: IOnyxArchitectureMap;
}

export class OnyxArchitectureScanner {

	private _cached: IPersistedArchitecture | undefined;

	constructor(
		private readonly _rootPath: string,
		private readonly _persistPath: string,
		private readonly _gitFileGroups: () => Promise<readonly (readonly string[])[]>,
	) { }

	/**
	 * Returns the map, rebuilding only when the workspace's cheap signature
	 * (file count + newest source mtime) moved. `force` rebuilds regardless.
	 */
	async analyze(force: boolean): Promise<IOnyxArchitectureMap> {
		const startedAt = Date.now();
		const listing = await this._walk();
		const signature = `${listing.entries.length}:${listing.newestMtime}`;

		if (!force) {
			const cached = this._cached ?? await this._load();
			if (cached && cached.signature === signature) {
				this._cached = cached;
				return { ...cached.map, analysisMs: Date.now() - startedAt };
			}
		}

		const knownPaths = new Set(listing.entries.map(entry => entry.relativePath));
		const facts: IOnyxFileFacts[] = [];
		for (const entry of listing.entries) {
			try {
				const head = await readHead(entry.absolutePath, HEAD_BYTES);
				const imports: string[] = [];
				for (const specifier of extractImportSpecifiers(head)) {
					const resolved = resolveRelativeImport(entry.relativePath, specifier);
					if (!resolved) {
						continue;
					}
					const target = matchKnownPath(resolved, knownPaths);
					if (target) {
						imports.push(target);
					}
				}
				facts.push({ path: entry.relativePath, lines: countNewlines(head, entry.size), imports });
			} catch {
				// unreadable file: skip
			}
		}

		const churnByFile = new Map<string, number>();
		try {
			for (const group of await this._gitFileGroups()) {
				for (const path of group) {
					churnByFile.set(path, (churnByFile.get(path) ?? 0) + 1);
				}
			}
		} catch {
			// no git: churn stays zero everywhere
		}

		const depth = chooseGranularity(facts.map(fact => fact.path), TARGET_MODULES);
		const aggregated = aggregateModules(facts, depth, churnByFile);
		const map: IOnyxArchitectureMap = {
			...aggregated,
			analysisMs: Date.now() - startedAt,
			truncated: listing.truncated,
		};
		this._cached = { signature, map };
		fs.promises.mkdir(dirname(this._persistPath), { recursive: true })
			.then(() => fs.promises.writeFile(this._persistPath, JSON.stringify(this._cached)))
			.catch(() => { /* cache is an optimization */ });
		return map;
	}

	private async _walk(): Promise<{ entries: { relativePath: string; absolutePath: string; size: number }[]; newestMtime: number; truncated: boolean }> {
		const entries: { relativePath: string; absolutePath: string; size: number }[] = [];
		let newestMtime = 0;
		let truncated = false;
		const stack = [this._rootPath];
		walk: while (stack.length) {
			const dir = stack.pop()!;
			let dirents: fs.Dirent[];
			try {
				dirents = await fs.promises.readdir(dir, { withFileTypes: true });
			} catch {
				continue;
			}
			for (const dirent of dirents) {
				if (dirent.isDirectory()) {
					if (!EXCLUDED_DIRECTORIES.has(dirent.name) && !dirent.name.startsWith('.') && !dirent.name.startsWith('out-')) {
						stack.push(join(dir, dirent.name));
					}
					continue;
				}
				if (!dirent.isFile() || !SOURCE_EXTENSIONS.has(extname(dirent.name))) {
					continue;
				}
				if (entries.length >= MAX_FILES) {
					truncated = true;
					break walk;
				}
				const absolutePath = join(dir, dirent.name);
				try {
					const stat = await fs.promises.stat(absolutePath);
					newestMtime = Math.max(newestMtime, Math.floor(stat.mtimeMs));
					entries.push({ relativePath: relative(this._rootPath, absolutePath).replaceAll('\\', '/'), absolutePath, size: stat.size });
				} catch {
					// vanished mid-walk
				}
			}
		}
		return { entries, newestMtime, truncated };
	}

	private async _load(): Promise<IPersistedArchitecture | undefined> {
		try {
			const parsed: IPersistedArchitecture = JSON.parse(await fs.promises.readFile(this._persistPath, 'utf8'));
			return parsed && typeof parsed.signature === 'string' && parsed.map ? parsed : undefined;
		} catch {
			return undefined;
		}
	}
}

async function readHead(absolutePath: string, maxBytes: number): Promise<string> {
	const handle = await fs.promises.open(absolutePath, 'r');
	try {
		const buffer = Buffer.alloc(maxBytes);
		const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
		return buffer.subarray(0, bytesRead).toString('utf8');
	} finally {
		await handle.close();
	}
}

/** Estimates a file's line count from its head sample and true size. */
function countNewlines(head: string, totalBytes: number): number {
	let newlines = 0;
	for (let i = 0; i < head.length; i++) {
		if (head.charCodeAt(i) === 10) {
			newlines++;
		}
	}
	if (totalBytes <= HEAD_BYTES || head.length === 0) {
		return newlines;
	}
	return Math.round(newlines * (totalBytes / head.length));
}

/** Matches a resolved import against known files, trying the usual extension and index forms. */
function matchKnownPath(resolved: string, known: ReadonlySet<string>): string | undefined {
	if (known.has(resolved)) {
		return resolved;
	}
	const withoutJs = resolved.replace(/\.js$/, '');
	const candidates = [
		`${resolved}.ts`, `${resolved}.tsx`, `${resolved}.js`, `${resolved}.jsx`, `${resolved}.py`,
		`${withoutJs}.ts`, `${withoutJs}.tsx`,
		`${resolved}/index.ts`, `${resolved}/index.js`, `${resolved}/__init__.py`,
	];
	for (const candidate of candidates) {
		if (known.has(candidate)) {
			return candidate;
		}
	}
	return undefined;
}
