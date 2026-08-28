/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** How often two files were committed together, keyed by file. */
export type OnyxCoChangeIndex = ReadonlyMap<string, ReadonlyMap<string, number>>;

/**
 * Commits touching more files than this are ignored. A 200-file commit is a
 * rename, a format pass or a vendored drop — it says nothing about which files
 * belong together, and it would otherwise dominate every count.
 */
const MAX_COMMIT_SIZE = 25;

/**
 * Mines "these change together" from commit history. Coupling that no import
 * graph shows — a handler and its test, a type and the migration that writes
 * it, a parser and its fixture — lives here and nowhere else in the repo.
 */
export function buildCoChangeIndex(commitGroups: readonly (readonly string[])[]): OnyxCoChangeIndex {
	const index = new Map<string, Map<string, number>>();
	for (const group of commitGroups) {
		const files = [...new Set(group)];
		if (files.length < 2 || files.length > MAX_COMMIT_SIZE) {
			continue;
		}
		for (const file of files) {
			let row = index.get(file);
			if (!row) {
				row = new Map<string, number>();
				index.set(file, row);
			}
			for (const other of files) {
				if (other !== file) {
					row.set(other, (row.get(other) ?? 0) + 1);
				}
			}
		}
	}
	return index;
}

/** One file that historically changes alongside another, with how often. */
export interface IOnyxCoChangedFile {
	readonly path: string;
	readonly commits: number;
	/** 0..1 — share of the anchor file's co-change weight this partner accounts for. */
	readonly strength: number;
}

/**
 * The files most often committed together with `path`, strongest first.
 * Strength is normalized against the anchor's strongest partner so a file with
 * a long history does not automatically outrank a young one.
 */
export function coChangedWith(index: OnyxCoChangeIndex, path: string, limit: number, minCommits = 2): IOnyxCoChangedFile[] {
	const row = index.get(path);
	if (!row) {
		return [];
	}
	const entries = [...row.entries()].filter(([, commits]) => commits >= minCommits);
	if (entries.length === 0) {
		return [];
	}
	const strongest = Math.max(...entries.map(([, commits]) => commits));
	return entries
		.map(([partner, commits]) => ({ path: partner, commits, strength: commits / strongest }))
		.sort((a, b) => b.commits - a.commits || a.path.localeCompare(b.path))
		.slice(0, limit);
}
