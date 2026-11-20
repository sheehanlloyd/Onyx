/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import { dirname, extname, join, relative } from '../../../base/common/path.js';
import { IOnyxBm25Hit, OnyxBm25Index } from '../common/onyxBm25.js';
import { IOnyxIndexStats } from '../common/onyxRuntime.js';

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

/** How much of a tree one index may cover. Past either cap the walk stops and the index says it is truncated. */
export interface IOnyxIndexLimits {
	readonly maxFiles: number;
	readonly maxTotalBytes: number;
}

export const ONYX_INDEX_LIMITS: IOnyxIndexLimits = { maxFiles: 5000, maxTotalBytes: 64 * 1024 * 1024 };

/** The format of the persisted file. A file in any other format is not loaded. */
const PERSIST_FORMAT = 2;

/** What a file looked like when it was indexed: modification time and size. */
type FileStamp = readonly [mtimeMs: number, size: number];

/**
 * The persisted index and the record of where it came from (B12): which
 * tree, when, under which caps, whether the caps cut the walk short, and
 * what each indexed file looked like. Without that record an index cannot
 * be told from one for another tree or one that is a week stale.
 */
interface IPersistedIndex {
	readonly format: typeof PERSIST_FORMAT;
	readonly root: string;
	readonly builtAt: number;
	readonly limits: IOnyxIndexLimits;
	readonly truncated: boolean;
	readonly files: Readonly<Record<string, FileStamp>>;
	/** The BM25 index, in its own serialization. */
	readonly index: string;
}

interface IScannedFile {
	readonly relativePath: string;
	readonly absolutePath: string;
	readonly stamp: FileStamp;
}

/**
 * The per-root BM25 index: walks the tree once (respecting the exclusion and
 * size caps), persists to one JSON file next to the rest of the workspace's
 * Onyx state, and applies incremental updates as the renderer reports file
 * changes. Lives in the shared process — the renderer never reads files for
 * retrieval.
 *
 * A persisted index is checked before it is used. It must be in this
 * format and for this root; then a stat pass over the tree finds the files
 * that changed, appeared or went away since it was written, and only those
 * are read again. Anything else is rebuilt.
 */
export class OnyxWorkspaceIndexer {

	private _index: OnyxBm25Index | undefined;
	private _building: Promise<IOnyxIndexStats> | undefined;
	private _stats: IOnyxIndexStats = { files: 0, buildMs: 0, truncated: false, source: 'built', builtAt: 0 };
	private _stamps = new Map<string, FileStamp>();
	private _persistTimer: ReturnType<typeof setTimeout> | undefined;
	private readonly _limits: IOnyxIndexLimits;

	constructor(
		private readonly _rootPath: string,
		private readonly _persistPath: string,
		limits: Partial<IOnyxIndexLimits> = {},
	) {
		this._limits = { ...ONYX_INDEX_LIMITS, ...limits };
	}

	/** Loads the persisted index, brought up to date with the tree, or builds a fresh one. Concurrent calls share one build. */
	ensure(): Promise<IOnyxIndexStats> {
		if (this._index) {
			return Promise.resolve(this._stats);
		}
		this._building ??= this._load().then(loaded => loaded ?? this._build()).finally(() => { this._building = undefined; });
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
					this._stamps.delete(relativePath);
					continue;
				}
				index.addDocument(relativePath, await fs.promises.readFile(absolute, 'utf8'));
				this._stamps.set(relativePath, [stat.mtimeMs, stat.size]);
			} catch {
				index.removeDocument(relativePath);
				this._stamps.delete(relativePath);
			}
		}
		this._stats = { ...this._stats, files: index.documentCount };
		this._schedulePersist();
	}

	get stats(): IOnyxIndexStats {
		return this._stats;
	}

	/**
	 * The files the index covers, as the tree is now: the same walk, the same
	 * exclusions and the same caps whether the index is being built or
	 * checked. Stats each file and reads none.
	 */
	private async _scan(): Promise<{ readonly files: IScannedFile[]; readonly truncated: boolean }> {
		const files: IScannedFile[] = [];
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
			// A stable order, so that what the caps keep does not depend on the file system's.
			entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
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
				if (files.length >= this._limits.maxFiles || totalBytes >= this._limits.maxTotalBytes) {
					truncated = true;
					break walk;
				}
				const absolutePath = join(dir, entry.name);
				try {
					const stat = await fs.promises.stat(absolutePath);
					if (stat.size > MAX_FILE_BYTES) {
						continue;
					}
					totalBytes += stat.size;
					files.push({ relativePath: relative(this._rootPath, absolutePath), absolutePath, stamp: [stat.mtimeMs, stat.size] });
				} catch {
					// unreadable file: skip
				}
			}
		}
		return { files, truncated };
	}

	private async _build(): Promise<IOnyxIndexStats> {
		const startedAt = Date.now();
		const index = new OnyxBm25Index();
		const stamps = new Map<string, FileStamp>();
		const scan = await this._scan();
		for (const file of scan.files) {
			try {
				index.addDocument(file.relativePath, await fs.promises.readFile(file.absolutePath, 'utf8'));
				stamps.set(file.relativePath, file.stamp);
			} catch {
				// unreadable file: skip
			}
		}

		this._index = index;
		this._stamps = stamps;
		this._stats = { files: index.documentCount, buildMs: Date.now() - startedAt, truncated: scan.truncated, source: 'built', builtAt: Date.now() };
		this._schedulePersist();
		return this._stats;
	}

	/**
	 * Loads the persisted index if it is this tree's, and brings it up to date:
	 * a file whose modification time or size differs is read again, a new one
	 * is added, one that is gone is removed. Resolves undefined when there is
	 * nothing to load or it cannot be trusted; the caller then builds.
	 */
	private async _load(): Promise<IOnyxIndexStats | undefined> {
		const startedAt = Date.now();
		let persisted: IPersistedIndex;
		try {
			persisted = JSON.parse(await fs.promises.readFile(this._persistPath, 'utf8')) as IPersistedIndex;
		} catch {
			return undefined;
		}
		if (persisted?.format !== PERSIST_FORMAT || persisted.root !== this._rootPath || typeof persisted.index !== 'string' || typeof persisted.files !== 'object' || persisted.files === null
			|| persisted.limits?.maxFiles !== this._limits.maxFiles || persisted.limits?.maxTotalBytes !== this._limits.maxTotalBytes) {
			return undefined;
		}
		const index = OnyxBm25Index.deserialize(persisted.index);
		if (!index) {
			return undefined;
		}

		const scan = await this._scan();
		const stamps = new Map<string, FileStamp>();
		const seen = new Set<string>();
		let added = 0;
		let updated = 0;
		for (const file of scan.files) {
			seen.add(file.relativePath);
			const known = persisted.files[file.relativePath];
			if (known && known[0] === file.stamp[0] && known[1] === file.stamp[1]) {
				stamps.set(file.relativePath, file.stamp);
				continue;
			}
			try {
				index.addDocument(file.relativePath, await fs.promises.readFile(file.absolutePath, 'utf8'));
				stamps.set(file.relativePath, file.stamp);
				if (known) {
					updated++;
				} else {
					added++;
				}
			} catch {
				index.removeDocument(file.relativePath);
			}
		}
		let removed = 0;
		for (const relativePath of Object.keys(persisted.files)) {
			if (!seen.has(relativePath)) {
				index.removeDocument(relativePath);
				removed++;
			}
		}

		const changed = added + updated + removed > 0;
		this._index = index;
		this._stamps = stamps;
		this._stats = {
			files: index.documentCount,
			buildMs: Date.now() - startedAt,
			// What the walk found now, not what it found then: a tree that grew past a cap is truncated today.
			truncated: scan.truncated,
			source: changed ? 'reconciled' : 'loaded',
			builtAt: changed ? Date.now() : persisted.builtAt,
			...(changed ? { reconciled: { added, updated, removed } } : {}),
		};
		if (changed || scan.truncated !== persisted.truncated) {
			this._schedulePersist();
		}
		return this._stats;
	}

	private _serialize(index: OnyxBm25Index): string {
		const persisted: IPersistedIndex = {
			format: PERSIST_FORMAT,
			root: this._rootPath,
			builtAt: this._stats.builtAt,
			limits: this._limits,
			truncated: this._stats.truncated,
			files: Object.fromEntries(this._stamps),
			index: index.serialize(),
		};
		return JSON.stringify(persisted);
	}

	private _schedulePersist(): void {
		if (this._persistTimer) {
			clearTimeout(this._persistTimer);
		}
		this._persistTimer = setTimeout(() => {
			this._persistTimer = undefined;
			// Persistence is an optimization; without it the index is rebuilt.
			this.flush().catch(() => { });
		}, 5000);
	}

	/** Writes the index to its file now instead of on the timer. */
	async flush(): Promise<void> {
		if (this._persistTimer) {
			clearTimeout(this._persistTimer);
			this._persistTimer = undefined;
		}
		const index = this._index;
		if (index) {
			await fs.promises.mkdir(dirname(this._persistPath), { recursive: true });
			await fs.promises.writeFile(this._persistPath, this._serialize(index));
		}
	}

	dispose(): void {
		if (this._persistTimer) {
			clearTimeout(this._persistTimer);
		}
	}
}
