/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IOnyxIndexOptions, IOnyxIndexStats, ONYX_INDEX_LIMITS } from '../../../../platform/onyxRuntime/common/onyxRuntime.js';

/** The shape of `files.exclude` and `search.exclude`: a glob set to `true`, to `false`, or to a condition on a sibling file. */
export type OnyxExcludeSetting = Readonly<Record<string, boolean | { readonly when?: string }>> | undefined;

/** The range `onyx.index.maxFiles` accepts. */
export const ONYX_INDEX_MAX_FILES = { default: ONYX_INDEX_LIMITS.maxFiles, minimum: 500, maximum: 100_000 } as const;

/**
 * What the content index is told to cover (C7): the patterns the workbench's
 * explorer and search leave out, and the file cap. A pattern that is switched
 * off is not applied. One that depends on a sibling file (`when`) is not
 * applied either: the index decides by path alone, and leaving the file in is
 * the safe side of that. One that brings files back (`!pattern`) is not an
 * exclusion and is not applied, so what it would bring back stays out. The
 * result is the same for the same settings, since a different result means a
 * different index.
 */
export function workspaceIndexOptions(filesExclude: OnyxExcludeSetting, searchExclude: OnyxExcludeSetting, maxFiles: unknown): IOnyxIndexOptions {
	const exclude = new Set<string>();
	for (const setting of [filesExclude, searchExclude]) {
		for (const [pattern, value] of Object.entries(setting ?? {})) {
			if (value === true && !pattern.startsWith('!')) {
				exclude.add(pattern);
			}
		}
	}
	const cap = typeof maxFiles === 'number' && Number.isFinite(maxFiles)
		? Math.min(ONYX_INDEX_MAX_FILES.maximum, Math.max(ONYX_INDEX_MAX_FILES.minimum, Math.floor(maxFiles)))
		: ONYX_INDEX_MAX_FILES.default;
	return { exclude: [...exclude].sort(), maxFiles: cap };
}

/**
 * One sentence on how much of the workspace an index holds, when it does not
 * hold all of it. It goes into the result of a search that ranks files from
 * the index, so the reader of that result knows a file can be missing from
 * it without being irrelevant.
 */
export function describeIndexCoverage(stats: Pick<IOnyxIndexStats, 'files' | 'eligibleFiles' | 'truncated'>): string | undefined {
	if (!stats.truncated) {
		return undefined;
	}
	if (stats.eligibleFiles > stats.files) {
		const share = Math.round(100 * stats.files / stats.eligibleFiles);
		return `The content index holds ${stats.files} of ${stats.eligibleFiles} eligible files (${share}%): source folders first, tests and documentation last. A file it does not hold cannot be ranked.`;
	}
	return `The content index holds ${stats.files} files and the workspace has more than it could list. A file it does not hold cannot be ranked.`;
}
