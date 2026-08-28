/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Path qualification for multi-root workspaces. Onyx passes workspace files
 * around as strings — through prompts, run journals and activity entries — so
 * a path must stay meaningful without a URI attached. In a single-root
 * workspace that is the folder-relative path; in a multi-root workspace the
 * path is prefixed with the folder name (`server/src/app.ts`), which is what
 * the rest of the workbench (breadcrumbs, search results) shows users too.
 */

/** The slice of a workspace folder these helpers need; index is the folder's position in the workspace. */
export interface IOnyxFolderRef {
	readonly name: string;
	readonly index: number;
}

/**
 * Qualifies a folder-relative path for display and journaling: unchanged for a
 * single-root workspace, `folderName/relativePath` when several roots exist.
 */
export function qualifyWorkspacePath(folders: readonly IOnyxFolderRef[], folderIndex: number, relativePath: string): string {
	if (folders.length <= 1) {
		return relativePath;
	}
	const folder = folders.find(f => f.index === folderIndex);
	return folder ? `${folder.name}/${relativePath}` : relativePath;
}

/**
 * Resolves a possibly-qualified workspace path back to a folder + relative
 * path. The inverse of {@link qualifyWorkspacePath}: in a multi-root workspace
 * the first path segment is matched against folder names, with a fallback to
 * the first folder so single-root journals stay readable after a workspace
 * grows more roots.
 */
export function resolveWorkspacePath(folders: readonly IOnyxFolderRef[], path: string): { folderIndex: number; relativePath: string } | undefined {
	if (folders.length === 0) {
		return undefined;
	}
	if (folders.length === 1) {
		return { folderIndex: folders[0].index, relativePath: path };
	}
	const slash = path.indexOf('/');
	if (slash > 0) {
		const head = path.slice(0, slash);
		const folder = folders.find(f => f.name === head);
		if (folder) {
			return { folderIndex: folder.index, relativePath: path.slice(slash + 1) };
		}
	}
	return { folderIndex: folders[0].index, relativePath: path };
}
