/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import { basename, dirname, extname, join, relative } from '../../../base/common/path.js';
import { OnyxBm25Index } from '../common/onyxBm25.js';
import { extractDocSnippet, extractJsDocSections, jsDocSectionsToIndexText } from '../common/onyxDocsExtract.js';
import { IOnyxDocsHit, IOnyxDocsIndexStats } from '../common/onyxRuntime.js';

/**
 * The documentation corpus: a second BM25 index per workspace root, separate
 * from the source index, holding only documentation that already exists on
 * this machine — the workspace's own markdown, package READMEs under
 * node_modules, and the JSDoc inside type declarations. No network, explicit
 * caps, and a freshness stamp so a stale mirror rebuilds itself.
 */

const MAX_DOC_FILES = 3000;
const MAX_DOC_TOTAL_BYTES = 32 * 1024 * 1024;
const MAX_MD_FILE_BYTES = 512 * 1024;
const MAX_DTS_FILE_BYTES = 1024 * 1024;
/** How many node_modules packages contribute docs before the walk stops. */
const MAX_PACKAGES = 800;
const MAX_JSDOC_SECTIONS_PER_FILE = 400;
/** A mirror older than this rebuilds on next use — dependencies change under it. */
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

const WORKSPACE_EXCLUDED = new Set([
	'node_modules', '.git', 'out', 'dist', 'build', '.build', 'target', 'coverage', 'vendor',
	'__pycache__', '.venv', 'venv', '.next', '.cache', 'DerivedData', 'Pods',
]);

interface IPersistedDocsIndex {
	readonly builtAt: number;
	readonly index: string;
}

export class OnyxDocsIndexer {

	private _index: OnyxBm25Index | undefined;
	private _building: Promise<IOnyxDocsIndexStats> | undefined;
	private _stats: IOnyxDocsIndexStats = { files: 0, buildMs: 0, truncated: false, builtAt: 0 };
	private _persistTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(
		private readonly _rootPath: string,
		private readonly _persistPath: string,
	) { }

	ensure(): Promise<IOnyxDocsIndexStats> {
		if (this._index && Date.now() - this._stats.builtAt < MAX_AGE_MS) {
			return Promise.resolve(this._stats);
		}
		this._building ??= this._load().then(loaded => {
			if (loaded && Date.now() - this._stats.builtAt < MAX_AGE_MS) {
				return this._stats;
			}
			return this._build();
		}).finally(() => { this._building = undefined; });
		return this._building;
	}

	async search(query: string, limit: number): Promise<IOnyxDocsHit[]> {
		await this.ensure();
		const hits = this._index?.search(query, limit) ?? [];
		const results: IOnyxDocsHit[] = [];
		for (const hit of hits) {
			try {
				const content = await fs.promises.readFile(join(this._rootPath, hit.path), 'utf8');
				const snippet = extractDocSnippet(content, query, 24);
				results.push({ path: hit.path, score: hit.score, line: snippet.startLine, snippet: snippet.text });
			} catch {
				results.push({ path: hit.path, score: hit.score, line: 1, snippet: '' });
			}
		}
		return results;
	}

	/** Re-reads changed workspace docs (markdown only — dependency docs rebuild on the age stamp). */
	async update(relativePaths: readonly string[]): Promise<void> {
		if (!this._index) {
			return; // never built: nothing to keep fresh yet
		}
		const index = this._index;
		for (const relativePath of relativePaths) {
			if (extname(relativePath).toLowerCase() !== '.md') {
				continue;
			}
			const absolute = join(this._rootPath, relativePath);
			try {
				const stat = await fs.promises.stat(absolute);
				if (!stat.isFile() || stat.size > MAX_MD_FILE_BYTES) {
					index.removeDocument(relativePath);
					continue;
				}
				index.addDocument(relativePath, await fs.promises.readFile(absolute, 'utf8'));
			} catch {
				index.removeDocument(relativePath);
			}
		}
		this._stats = { ...this._stats, files: index.documentCount };
		this._schedulePersist();
	}

	get stats(): IOnyxDocsIndexStats {
		return this._stats;
	}

	private async _build(): Promise<IOnyxDocsIndexStats> {
		const startedAt = Date.now();
		const index = new OnyxBm25Index();
		let totalBytes = 0;
		let truncated = false;
		const overBudget = () => index.documentCount >= MAX_DOC_FILES || totalBytes >= MAX_DOC_TOTAL_BYTES;

		// 1. The workspace's own markdown.
		const stack = [this._rootPath];
		walk: while (stack.length) {
			const dir = stack.pop()!;
			let entries: fs.Dirent[];
			try {
				entries = await fs.promises.readdir(dir, { withFileTypes: true });
			} catch {
				continue;
			}
			for (const entry of entries) {
				if (entry.isDirectory()) {
					if (!WORKSPACE_EXCLUDED.has(entry.name) && !entry.name.startsWith('.') && !entry.name.startsWith('out-')) {
						stack.push(join(dir, entry.name));
					}
					continue;
				}
				if (!entry.isFile() || extname(entry.name).toLowerCase() !== '.md') {
					continue;
				}
				if (overBudget()) {
					truncated = true;
					break walk;
				}
				totalBytes += await this._addFile(index, join(dir, entry.name), MAX_MD_FILE_BYTES);
			}
		}

		// 2. Dependency docs: each package's README and its type declarations.
		const packageRoots = await this._packageRoots();
		for (const packageRoot of packageRoots) {
			if (overBudget()) {
				truncated = true;
				break;
			}
			for (const readmeName of ['README.md', 'readme.md', 'Readme.md']) {
				const readmePath = join(packageRoot, readmeName);
				if (fs.existsSync(readmePath)) {
					totalBytes += await this._addFile(index, readmePath, MAX_MD_FILE_BYTES);
					break;
				}
			}
			totalBytes += await this._addTypings(index, packageRoot);
		}

		this._index = index;
		this._stats = { files: index.documentCount, buildMs: Date.now() - startedAt, truncated, builtAt: Date.now() };
		this._schedulePersist();
		return this._stats;
	}

	/** Direct dependencies' roots under node_modules (scoped packages included), capped. */
	private async _packageRoots(): Promise<string[]> {
		const nodeModules = join(this._rootPath, 'node_modules');
		const roots: string[] = [];
		let entries: fs.Dirent[];
		try {
			entries = await fs.promises.readdir(nodeModules, { withFileTypes: true });
		} catch {
			return roots;
		}
		for (const entry of entries) {
			if (roots.length >= MAX_PACKAGES) {
				break;
			}
			if (!entry.isDirectory() || entry.name.startsWith('.')) {
				continue;
			}
			if (entry.name.startsWith('@')) {
				try {
					for (const scoped of await fs.promises.readdir(join(nodeModules, entry.name), { withFileTypes: true })) {
						if (scoped.isDirectory() && roots.length < MAX_PACKAGES) {
							roots.push(join(nodeModules, entry.name, scoped.name));
						}
					}
				} catch {
					// unreadable scope: skip
				}
			} else {
				roots.push(join(nodeModules, entry.name));
			}
		}
		return roots;
	}

	/** Indexes the JSDoc content of a package's entry type declarations. */
	private async _addTypings(index: OnyxBm25Index, packageRoot: string): Promise<number> {
		let typesEntry = 'index.d.ts';
		try {
			const manifest = JSON.parse(await fs.promises.readFile(join(packageRoot, 'package.json'), 'utf8'));
			if (typeof manifest.types === 'string') {
				typesEntry = manifest.types;
			} else if (typeof manifest.typings === 'string') {
				typesEntry = manifest.typings;
			}
		} catch {
			// no manifest: try the default entry
		}
		const dtsPath = join(packageRoot, typesEntry.endsWith('.d.ts') ? typesEntry : `${typesEntry.replace(/\.js$/, '')}.d.ts`);
		try {
			const stat = await fs.promises.stat(dtsPath);
			if (!stat.isFile() || stat.size > MAX_DTS_FILE_BYTES) {
				return 0;
			}
			const source = await fs.promises.readFile(dtsPath, 'utf8');
			const sections = extractJsDocSections(source, MAX_JSDOC_SECTIONS_PER_FILE);
			if (sections.length === 0) {
				return 0;
			}
			index.addDocument(relative(this._rootPath, dtsPath), jsDocSectionsToIndexText(sections));
			return stat.size;
		} catch {
			return 0;
		}
	}

	private async _addFile(index: OnyxBm25Index, absolute: string, maxBytes: number): Promise<number> {
		try {
			const stat = await fs.promises.stat(absolute);
			if (!stat.isFile() || stat.size > maxBytes) {
				return 0;
			}
			index.addDocument(relative(this._rootPath, absolute), await fs.promises.readFile(absolute, 'utf8'));
			return stat.size;
		} catch {
			return 0;
		}
	}

	private async _load(): Promise<boolean> {
		try {
			const json = await fs.promises.readFile(this._persistPath, 'utf8');
			const persisted: IPersistedDocsIndex = JSON.parse(json);
			const index = OnyxBm25Index.deserialize(persisted.index);
			if (!index || index.documentCount === 0) {
				return false;
			}
			this._index = index;
			this._stats = { files: index.documentCount, buildMs: 0, truncated: false, builtAt: persisted.builtAt ?? 0 };
			return true;
		} catch {
			return false;
		}
	}

	private _schedulePersist(): void {
		if (this._persistTimer) {
			clearTimeout(this._persistTimer);
		}
		this._persistTimer = setTimeout(() => {
			this._persistTimer = undefined;
			const index = this._index;
			if (!index) {
				return;
			}
			const persisted: IPersistedDocsIndex = { builtAt: this._stats.builtAt, index: index.serialize() };
			fs.promises.mkdir(dirname(this._persistPath), { recursive: true })
				.then(() => fs.promises.writeFile(this._persistPath, JSON.stringify(persisted)))
				.catch(() => { /* persistence is an optimization; the mirror rebuilds */ });
		}, 5000);
	}

	dispose(): void {
		if (this._persistTimer) {
			clearTimeout(this._persistTimer);
		}
	}
}

/** Whether a filename is a README, for corpus rules and tests. */
export function isReadmeName(name: string): boolean {
	return basename(name).toLowerCase() === 'readme.md';
}
