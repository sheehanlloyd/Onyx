/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import { dirname, extname, join, relative } from '../../../base/common/path.js';
import { IOnyxBm25Hit, OnyxBm25Index } from '../common/onyxBm25.js';

/** Directories that hold generated or vendored code — indexing them buries the signal. */
const EXCLUDED_DIRECTORIES = new Set([
	'node_modules', '.git', 'out', 'dist', 'build', '.build', 'target', 'coverage', 'vendor',
	'__pycache__', '.venv', 'venv', '.next', '.cache', 'DerivedData', 'Pods',
]);

/** Source-ish extensions worth indexing. */
const INDEXED_EXTENSIONS = new Set([
	'.ts', '.tsx', '.js', '.jsx', '.mjs', '.mts', '.py', '.go', '.rs', '.java', '.kt', '.c', '.h',
	'.cpp', '.hpp', '.cc', '.cs', '.rb', '.php', '.swift', '.m', '.mm', '.md', '.css', '.scss',
	'.html', '.sh', '.yml', '.yaml', '.toml', '.sql',
]);

const MAX_FILE_BYTES = 256 * 1024;
const MAX_FILES = 5000;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;

export interface IOnyxIndexStats {
	readonly files: number;
	readonly buildMs: number;
	/** True when caps stopped the walk before the workspace was fully covered. */
	readonly truncated: boolean;
}

/**
 * The per-root BM25 index: walks the tree once (respecting the exclusion and
 * size caps), persists to one JSON file next to the rest of the workspace's
 * Onyx state, and applies incremental updates as the renderer reports file
 * changes. Lives in the shared process — the renderer never reads files for
 * retrieval.
 */
export class OnyxWorkspaceIndexer {

	private _index: OnyxBm25Index | undefined;
	private _building: Promise<IOnyxIndexStats> | undefined;
	private _stats: IOnyxIndexStats = { files: 0, buildMs: 0, truncated: false };
	private _persistTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(
		private readonly _rootPath: string,
		private readonly _persistPath: string,
	) { }

	/** Loads the persisted index or builds a fresh one. Concurrent calls share one build. */
	ensure(): Promise<IOnyxIndexStats> {
		if (this._index) {
			return Promise.resolve(this._stats);
		}
		this._building ??= this._load().then(loaded => {
			if (loaded) {
				return this._stats;
			}
			return this._build();
		}).finally(() => { this._building = undefined; });
		return this._building;
	}

	async search(query: string, limit: number): Promise<IOnyxBm25Hit[]> {
		await this.ensure();
		return this._index?.search(query, limit) ?? [];
	}

	/** Re-reads the given workspace-relative files; missing files leave the index. */
	async update(relativePaths: readonly string[]): Promise<void> {
		await this.ensure();
		const index = this._index;
		if (!index) {
			return;
		}
		for (const relativePath of relativePaths) {
			const absolute = join(this._rootPath, relativePath);
			try {
				const stat = await fs.promises.stat(absolute);
				if (!stat.isFile() || stat.size > MAX_FILE_BYTES || !INDEXED_EXTENSIONS.has(extname(relativePath))) {
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

	get stats(): IOnyxIndexStats {
		return this._stats;
	}

	private async _build(): Promise<IOnyxIndexStats> {
		const startedAt = Date.now();
		const index = new OnyxBm25Index();
		let totalBytes = 0;
		let truncated = false;

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
					if (!EXCLUDED_DIRECTORIES.has(entry.name) && !entry.name.startsWith('.') && !entry.name.startsWith('out-')) {
						stack.push(join(dir, entry.name));
					}
					continue;
				}
				if (!entry.isFile() || !INDEXED_EXTENSIONS.has(extname(entry.name))) {
					continue;
				}
				if (index.documentCount >= MAX_FILES || totalBytes >= MAX_TOTAL_BYTES) {
					truncated = true;
					break walk;
				}
				const absolute = join(dir, entry.name);
				try {
					const stat = await fs.promises.stat(absolute);
					if (stat.size > MAX_FILE_BYTES) {
						continue;
					}
					totalBytes += stat.size;
					index.addDocument(relative(this._rootPath, absolute), await fs.promises.readFile(absolute, 'utf8'));
				} catch {
					// unreadable file: skip
				}
			}
		}

		this._index = index;
		this._stats = { files: index.documentCount, buildMs: Date.now() - startedAt, truncated };
		this._schedulePersist();
		return this._stats;
	}

	private async _load(): Promise<boolean> {
		try {
			const json = await fs.promises.readFile(this._persistPath, 'utf8');
			const index = OnyxBm25Index.deserialize(json);
			if (!index || index.documentCount === 0) {
				return false;
			}
			this._index = index;
			this._stats = { files: index.documentCount, buildMs: 0, truncated: false };
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
			fs.promises.mkdir(dirname(this._persistPath), { recursive: true })
				.then(() => fs.promises.writeFile(this._persistPath, index.serialize()))
				.catch(() => { /* persistence is an optimization; the index rebuilds */ });
		}, 5000);
	}

	dispose(): void {
		if (this._persistTimer) {
			clearTimeout(this._persistTimer);
		}
	}
}
