/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import { Queue } from '../../../base/common/async.js';
import { parse as parseGlob, ParsedPattern } from '../../../base/common/glob.js';
import { dirname, extname, join, sep } from '../../../base/common/path.js';
import { IOnyxBm25Hit, OnyxBm25Index } from '../common/onyxBm25.js';
import { IOnyxIndexLimits, IOnyxIndexOptions, IOnyxIndexStats, ONYX_INDEX_LIMITS } from '../common/onyxRuntime.js';

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

/** No walk reads more directory entries than this; a tree past it is walked in part and says so. */
const MAX_WALK_ENTRIES = 400_000;

/** Folders that hold a project's own code. A file under one, and under no lower-priority folder, is indexed first. */
const SOURCE_DIRECTORIES = new Set(['src', 'lib', 'app', 'apps', 'packages', 'source', 'sources', 'core', 'server', 'client', 'cmd', 'internal', 'pkg', 'crates', 'components', 'modules', 'services']);
/** Folders whose contents are about the code rather than the code: indexed last. */
const SECONDARY_DIRECTORIES = new Set(['test', 'tests', '__tests__', 'spec', 'specs', 'e2e', 'fixtures', '__fixtures__', 'mocks', '__mocks__', 'examples', 'example', 'samples', 'docs', 'doc', 'benchmarks', 'bench', 'stories']);
const SECONDARY_FILE = /\.(test|spec|stories|d)\.[a-z]+$/i;

/** Tests, documentation, examples and fixtures: after everything else. */
const LAST = 2_000_000;
/** Neither source nor secondary: after the source, the files nearest the root first. */
const MIDDLE = 1_000_000;

/**
 * Where a file stands when a cap decides what is indexed; lower is earlier.
 * The project's source comes first, and within it the source folder nearest
 * the root: `src/` before `tools/build/src/` before `extensions/x/src/`,
 * because the folder at the root is the workspace's own and the deeper ones
 * belong to projects inside it. Then everything else. Tests, documentation,
 * examples and fixtures come last, wherever they are.
 */
function priority(relativePath: string): number {
	const segments = relativePath.split('/');
	const file = segments.pop() ?? '';
	if (SECONDARY_FILE.test(file) || segments.some(segment => SECONDARY_DIRECTORIES.has(segment))) {
		return LAST;
	}
	const sourceDepth = segments.findIndex(segment => SOURCE_DIRECTORIES.has(segment));
	return sourceDepth === -1 ? MIDDLE + segments.length : sourceDepth;
}

/**
 * The root `.gitignore` as globs. The plain cases only: a name or a glob
 * matches at any depth, and a leading slash or a slash inside the pattern
 * anchors it to the root. A pattern for folders only (trailing slash) also
 * leaves out a file of that name. A negation (`!pattern`) is not applied, so
 * a file a negation would bring back stays out; nested `.gitignore` files
 * are not read. Each of these errs towards leaving a file out of the index.
 */
function gitignoreGlobs(content: string): string[] {
	const globs: string[] = [];
	for (const raw of content.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line || line.startsWith('#') || line.startsWith('!')) {
			continue;
		}
		const anchored = line.startsWith('/');
		const body = line.replace(/^\/+/, '').replace(/\/+$/, '');
		if (!body) {
			continue;
		}
		globs.push(anchored || body.includes('/') ? body : `**/${body}`);
	}
	return globs;
}

/** A path and every folder above it. An exclusion that names a folder leaves out everything under it, so each is tried. */
function ancestry(relativePath: string): string[] {
	const segments = relativePath.split('/');
	return segments.map((_, index) => segments.slice(0, index + 1).join('/'));
}

/** The format of the persisted file. A file in any other format is not loaded. */
const PERSIST_FORMAT = 3;

/** What a file looked like when it was indexed: modification time and size. */
type FileStamp = readonly [mtimeMs: number, size: number];

/**
 * The first line of the persisted file: the record of where the index came
 * from (B12). Which tree, when, under which caps and exclusions, whether the
 * caps cut it short and how many files were eligible. Without that record an
 * index cannot be told from one for another tree or one that is a week stale.
 */
interface IPersistedHeader {
	readonly format: typeof PERSIST_FORMAT;
	readonly root: string;
	readonly builtAt: number;
	readonly limits: IOnyxIndexLimits;
	/** The exclusion patterns the index was built under: the options' and the root `.gitignore`'s. A different set is a different index. */
	readonly exclusions: readonly string[];
	readonly truncated: boolean;
	readonly eligibleFiles: number;
}

/**
 * Every further line of the persisted file: one indexed file, what it looked
 * like when it was indexed, and its terms. A document to a line, so the file
 * is written and read a batch at a time. Written in one piece, a full-size
 * index held the process for seconds (C7).
 */
type PersistedDocument = readonly [path: string, mtimeMs: number, size: number, length: number, terms: Readonly<Record<string, number>>];

/** How many documents are written or read between two turns of the event loop. */
const PERSIST_BATCH = 64;

/** After a build the index is written soon, so that a restart does not build again. */
const PERSIST_AFTER_BUILD_MS = 5000;
/**
 * After an update it can wait. A loaded index is reconciled with the tree, so
 * an older file costs only the re-reading of what changed since, and writing
 * the whole index after every save would be most of the work the index does.
 */
const PERSIST_AFTER_UPDATE_MS = 60_000;

/** Lets everything else that is waiting on this process run. */
function turn(): Promise<void> {
	return new Promise(resolve => setImmediate(resolve));
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
	private _stats: IOnyxIndexStats = { files: 0, eligibleFiles: 0, buildMs: 0, truncated: false, source: 'built', builtAt: 0 };
	private _stamps = new Map<string, FileStamp>();
	/** Files the rules make eligible that a cap kept out, by path. Empty unless the index is truncated. */
	private _waiting = new Set<string>();
	/** True when the tree has more entries than one walk reads, so part of it was never listed. */
	private _walkCutShort = false;
	private _persistTimer: ReturnType<typeof setTimeout> | undefined;
	private _persistDue = 0;
	/** One write at a time: a second request waits for the first, then writes the newer state. */
	private readonly _writes = new Queue<void>();
	private readonly _limits: IOnyxIndexLimits;
	private readonly _excludeOption: readonly string[];
	/** The exclusion patterns in force and their matchers, read once per build or load. */
	private _exclusions: { readonly patterns: readonly string[]; readonly matchers: readonly ParsedPattern[] } | undefined;

	constructor(
		private readonly _rootPath: string,
		private readonly _persistPath: string,
		options: IOnyxIndexOptions = {},
	) {
		this._limits = { maxFiles: options.maxFiles ?? ONYX_INDEX_LIMITS.maxFiles, maxTotalBytes: options.maxTotalBytes ?? ONYX_INDEX_LIMITS.maxTotalBytes };
		this._excludeOption = [...(options.exclude ?? [])].sort();
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

	/**
	 * Re-reads the given workspace-relative files; missing files leave the
	 * index. The build's rules apply: a change to a file the index leaves out
	 * does not bring it in, and a new file that arrives when the index is at
	 * its cap waits like the rest that did not fit.
	 */
	async update(relativePaths: readonly string[]): Promise<void> {
		if (relativePaths.includes('.gitignore')) {
			// The rules changed under the index. It is dropped, and the next use loads or builds under the new ones.
			try {
				await this._building;
			} catch {
				// a failed build leaves nothing to drop
			}
			this._index = undefined;
			this._exclusions = undefined;
			return;
		}
		await this.ensure();
		const index = this._index;
		if (!index) {
			return;
		}
		const excluded = await this._excluded();
		for (const reported of relativePaths) {
			const relativePath = reported.split(sep).join('/');
			const absolute = join(this._rootPath, relativePath);
			let stamp: FileStamp | undefined;
			try {
				const stat = await fs.promises.stat(absolute);
				if (stat.isFile() && stat.size <= MAX_FILE_BYTES && INDEXED_EXTENSIONS.has(extname(relativePath)) && this._walkable(relativePath) && !ancestry(relativePath).some(path => excluded(path))) {
					stamp = [stat.mtimeMs, stat.size];
				}
			} catch {
				// gone: not eligible
			}
			if (stamp && !this._stamps.has(relativePath) && this._stamps.size >= this._limits.maxFiles) {
				this._waiting.add(relativePath);
				continue;
			}
			let indexed = false;
			if (stamp) {
				try {
					index.addDocument(relativePath, await fs.promises.readFile(absolute, 'utf8'));
					this._stamps.set(relativePath, stamp);
					indexed = true;
				} catch {
					// unreadable: treated as gone
				}
			}
			if (!indexed) {
				index.removeDocument(relativePath);
				this._stamps.delete(relativePath);
			}
			this._waiting.delete(relativePath);
		}
		this._stats = { ...this._stats, files: index.documentCount, eligibleFiles: this._stamps.size + this._waiting.size, truncated: this._walkCutShort || this._waiting.size > 0 };
		this._schedulePersist(PERSIST_AFTER_UPDATE_MS);
	}

	get stats(): IOnyxIndexStats {
		return this._stats;
	}

	/** The workspace-relative paths in the index, sorted: the corpus a search runs over. */
	indexedPaths(): string[] {
		return [...this._stamps.keys()].sort();
	}

	/** The exclusion patterns in force: the options' and the root `.gitignore`'s. */
	private async _readExclusions(): Promise<{ readonly patterns: readonly string[]; readonly matchers: readonly ParsedPattern[] }> {
		let ignored: string[] = [];
		try {
			ignored = gitignoreGlobs(await fs.promises.readFile(join(this._rootPath, '.gitignore'), 'utf8'));
		} catch {
			// no .gitignore at the root
		}
		const patterns = [...new Set([...this._excludeOption, ...ignored])].sort();
		this._exclusions = { patterns, matchers: patterns.map(pattern => parseGlob(pattern)) };
		return this._exclusions;
	}

	private async _excluded(): Promise<(relativePath: string) => boolean> {
		const { matchers } = this._exclusions ?? await this._readExclusions();
		return relativePath => matchers.some(matches => matches(relativePath));
	}

	/** Whether the built-in rules let the walk reach this path: no generated, vendored or hidden folder on the way. */
	private _walkable(relativePath: string): boolean {
		return relativePath.split('/').slice(0, -1).every(segment => !EXCLUDED_DIRECTORIES.has(segment) && !segment.startsWith('.') && !segment.startsWith('out-'));
	}

	/**
	 * The files the index covers, as the tree is now, for a build and for a
	 * check alike. The whole tree is listed first (names only), so that what a
	 * cap keeps is chosen, not met: the project's source before everything
	 * else, tests, documentation and examples last, in path order within each
	 * (C7). Then the chosen files are stat'ed, up to the caps. None is read.
	 */
	private async _scan(): Promise<{ readonly files: IScannedFile[]; readonly waiting: string[]; readonly walkCutShort: boolean }> {
		const excluded = await this._excluded();
		const candidates: { readonly relativePath: string; readonly rank: number }[] = [];
		let entriesRead = 0;
		let walkCutShort = false;

		const pending = [''];
		walk: while (pending.length) {
			const directory = pending.pop()!;
			let entries: fs.Dirent[];
			try {
				entries = await fs.promises.readdir(directory ? join(this._rootPath, directory) : this._rootPath, { withFileTypes: true });
			} catch {
				continue;
			}
			for (const entry of entries) {
				if (++entriesRead > MAX_WALK_ENTRIES) {
					walkCutShort = true;
					break walk;
				}
				const relativePath = directory ? `${directory}/${entry.name}` : entry.name;
				if (entry.isDirectory()) {
					if (!EXCLUDED_DIRECTORIES.has(entry.name) && !entry.name.startsWith('.') && !entry.name.startsWith('out-') && !excluded(relativePath)) {
						pending.push(relativePath);
					}
				} else if (entry.isFile() && INDEXED_EXTENSIONS.has(extname(entry.name)) && !excluded(relativePath)) {
					candidates.push({ relativePath, rank: priority(relativePath) });
				}
			}
		}
		candidates.sort((a, b) => a.rank - b.rank || (a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0));

		const files: IScannedFile[] = [];
		const waiting: string[] = [];
		let totalBytes = 0;
		for (const candidate of candidates) {
			if (files.length >= this._limits.maxFiles || totalBytes >= this._limits.maxTotalBytes) {
				// Past a cap nothing more is stat'ed: the rest are eligible by name, and wait.
				waiting.push(candidate.relativePath);
				continue;
			}
			const absolutePath = join(this._rootPath, candidate.relativePath);
			try {
				const stat = await fs.promises.stat(absolutePath);
				if (stat.size > MAX_FILE_BYTES) {
					continue;
				}
				totalBytes += stat.size;
				files.push({ relativePath: candidate.relativePath, absolutePath, stamp: [stat.mtimeMs, stat.size] });
			} catch {
				// unreadable file: skip
			}
		}
		return { files, waiting, walkCutShort };
	}

	private async _build(): Promise<IOnyxIndexStats> {
		const startedAt = Date.now();
		const index = new OnyxBm25Index();
		const stamps = new Map<string, FileStamp>();
		await this._readExclusions();
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
		this._waiting = new Set(scan.waiting);
		this._walkCutShort = scan.walkCutShort;
		this._stats = { files: index.documentCount, eligibleFiles: stamps.size + scan.waiting.length, buildMs: Date.now() - startedAt, truncated: scan.walkCutShort || scan.waiting.length > 0, source: 'built', builtAt: Date.now() };
		this._schedulePersist(PERSIST_AFTER_BUILD_MS);
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
		let content: string;
		try {
			content = await fs.promises.readFile(this._persistPath, 'utf8');
		} catch {
			return undefined;
		}
		const exclusions = await this._readExclusions();
		const headerEnd = content.indexOf('\n');
		let header: IPersistedHeader;
		try {
			header = JSON.parse(headerEnd === -1 ? content : content.slice(0, headerEnd)) as IPersistedHeader;
		} catch {
			return undefined;
		}
		if (headerEnd === -1 || header?.format !== PERSIST_FORMAT || header.root !== this._rootPath
			|| header.limits?.maxFiles !== this._limits.maxFiles || header.limits?.maxTotalBytes !== this._limits.maxTotalBytes
			// Built under other exclusions, it holds files this one must not, or lacks files it should: not this index.
			|| !Array.isArray(header.exclusions) || header.exclusions.join('\n') !== exclusions.patterns.join('\n')) {
			return undefined;
		}

		const index = new OnyxBm25Index();
		const known = new Map<string, FileStamp>();
		let position = headerEnd + 1;
		let read = 0;
		while (position < content.length) {
			const lineEnd = content.indexOf('\n', position);
			if (lineEnd === -1) {
				// The last line has no end: the write stopped part-way. Not an index.
				return undefined;
			}
			try {
				const [path, mtimeMs, size, length, terms] = JSON.parse(content.slice(position, lineEnd)) as PersistedDocument;
				if (typeof path !== 'string' || typeof length !== 'number' || typeof terms !== 'object' || terms === null) {
					return undefined;
				}
				index.restoreDocument({ path, length, terms });
				known.set(path, [mtimeMs, size]);
			} catch {
				return undefined;
			}
			position = lineEnd + 1;
			if (++read % PERSIST_BATCH === 0) {
				await turn();
			}
		}

		const scan = await this._scan();
		const stamps = new Map<string, FileStamp>();
		const seen = new Set<string>();
		let added = 0;
		let updated = 0;
		for (const file of scan.files) {
			seen.add(file.relativePath);
			const was = known.get(file.relativePath);
			if (was && was[0] === file.stamp[0] && was[1] === file.stamp[1]) {
				stamps.set(file.relativePath, file.stamp);
				continue;
			}
			try {
				index.addDocument(file.relativePath, await fs.promises.readFile(file.absolutePath, 'utf8'));
				stamps.set(file.relativePath, file.stamp);
				if (was) {
					updated++;
				} else {
					added++;
				}
			} catch {
				index.removeDocument(file.relativePath);
			}
		}
		let removed = 0;
		for (const relativePath of known.keys()) {
			if (!seen.has(relativePath)) {
				index.removeDocument(relativePath);
				removed++;
			}
		}

		const changed = added + updated + removed > 0;
		// What the walk found now, not what it found then: a tree that grew past a cap is truncated today.
		const truncated = scan.walkCutShort || scan.waiting.length > 0;
		this._index = index;
		this._stamps = stamps;
		this._waiting = new Set(scan.waiting);
		this._walkCutShort = scan.walkCutShort;
		this._stats = {
			files: index.documentCount,
			eligibleFiles: stamps.size + scan.waiting.length,
			buildMs: Date.now() - startedAt,
			truncated,
			source: changed ? 'reconciled' : 'loaded',
			builtAt: changed ? Date.now() : header.builtAt,
			...(changed ? { reconciled: { added, updated, removed } } : {}),
		};
		if (changed || truncated !== header.truncated) {
			this._schedulePersist(PERSIST_AFTER_BUILD_MS);
		}
		return this._stats;
	}

	/**
	 * Writes the index beside its file and moves it into place, so a file that
	 * can be loaded is always a whole one. Documents go out a batch at a time,
	 * and each write is a turn of the event loop.
	 */
	private async _write(): Promise<void> {
		const index = this._index;
		if (!index) {
			return;
		}
		const stamps = this._stamps;
		const header: IPersistedHeader = {
			format: PERSIST_FORMAT,
			root: this._rootPath,
			builtAt: this._stats.builtAt,
			limits: this._limits,
			exclusions: this._exclusions?.patterns ?? [],
			truncated: this._stats.truncated,
			eligibleFiles: this._stats.eligibleFiles,
		};
		await fs.promises.mkdir(dirname(this._persistPath), { recursive: true });
		const writingPath = `${this._persistPath}.writing`;
		const handle = await fs.promises.open(writingPath, 'w');
		try {
			let batch = `${JSON.stringify(header)}\n`;
			let inBatch = 0;
			for (const document of index.documents()) {
				// A file that left the index while this was being written is left out; one that changed goes out as it is now.
				const stamp = stamps.get(document.path);
				if (!stamp) {
					continue;
				}
				const line: PersistedDocument = [document.path, stamp[0], stamp[1], document.length, document.terms];
				batch += `${JSON.stringify(line)}\n`;
				if (++inBatch >= PERSIST_BATCH) {
					await handle.write(batch);
					batch = '';
					inBatch = 0;
				}
			}
			if (batch) {
				await handle.write(batch);
			}
		} catch (error) {
			await handle.close();
			await fs.promises.rm(writingPath, { force: true });
			throw error;
		}
		await handle.close();
		await fs.promises.rename(writingPath, this._persistPath);
	}

	private _schedulePersist(delayMs: number): void {
		const due = Date.now() + delayMs;
		if (this._persistTimer) {
			if (this._persistDue <= due) {
				// Already due sooner. Later changes do not push the write back.
				return;
			}
			clearTimeout(this._persistTimer);
		}
		this._persistDue = due;
		this._persistTimer = setTimeout(() => {
			this._persistTimer = undefined;
			// Persistence is an optimization; without it the index is rebuilt.
			this.flush().catch(() => { });
		}, delayMs);
	}

	/** Writes the index to its file now instead of on the timer. */
	async flush(): Promise<void> {
		if (this._persistTimer) {
			clearTimeout(this._persistTimer);
			this._persistTimer = undefined;
		}
		await this._writes.queue(() => this._write());
	}

	dispose(): void {
		if (this._persistTimer) {
			clearTimeout(this._persistTimer);
		}
		this._writes.dispose();
	}
}
