/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../../base/common/uri.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { IUriIdentityService } from '../../../../../platform/uriIdentity/common/uriIdentity.js';
import { IWorkspaceContextService, IWorkspaceFolder } from '../../../../../platform/workspace/common/workspace.js';
import { normalizeWorkspaceRelativePath, qualifyWorkspacePath, resolveWorkspacePath, workspacePathProblem } from '../../common/onyxWorkspacePaths.js';

export const IOnyxWorkspaceAccessService = createDecorator<IOnyxWorkspaceAccessService>('onyxWorkspaceAccessService');

export type OnyxResolvedWorkspacePath =
	| { readonly ok: true; readonly uri: URI; readonly folder: IWorkspaceFolder; readonly relativePath: string; readonly qualifiedPath: string }
	| { readonly ok: false; readonly error: string };

/**
 * The one place a path that a model supplied becomes a URI the read tools may
 * touch (B1, I-07 on the read side, R-30). It refuses an absolute path, a
 * parent-directory segment and a backslash before resolving anything, and
 * after resolving it refuses a path whose real location is outside the
 * workspace folder, which is how a symbolic link escapes.
 */
export interface IOnyxWorkspaceAccessService {
	readonly _serviceBrand: undefined;
	/** Resolves a workspace-relative (multi-root: folder-qualified) path. The empty path and `.` are the first folder's root. */
	resolve(path: string): Promise<OnyxResolvedWorkspacePath>;
	/** The path a model is shown for a URI inside the workspace, or `undefined` for one outside it. */
	qualify(uri: URI): string | undefined;
	/** Whether a URI that a search returned really lies inside the workspace, following symbolic links. */
	isContained(uri: URI): Promise<boolean>;
}

export class OnyxWorkspaceAccessService implements IOnyxWorkspaceAccessService {

	declare readonly _serviceBrand: undefined;

	constructor(
		@IWorkspaceContextService protected readonly _workspaceService: IWorkspaceContextService,
		@IFileService private readonly _fileService: IFileService,
		@IUriIdentityService private readonly _uriIdentityService: IUriIdentityService,
	) { }

	async resolve(path: string): Promise<OnyxResolvedWorkspacePath> {
		const problem = workspacePathProblem(path);
		if (problem) {
			return { ok: false, error: `"${path}" was refused: ${problem}.` };
		}
		const folders = this._workspaceService.getWorkspace().folders;
		if (folders.length === 0) {
			return { ok: false, error: 'No workspace folder is open.' };
		}
		const normalized = normalizeWorkspaceRelativePath(path);
		const folderRefs = folders.map(folder => ({ name: folder.name, index: folder.index }));
		const resolved = resolveWorkspacePath(folderRefs, normalized);
		const folder = resolved ? folders.find(candidate => candidate.index === resolved.folderIndex) : undefined;
		if (!resolved || !folder) {
			return { ok: false, error: `"${path}" is not inside the workspace.` };
		}
		// In a multi-root workspace a bare folder name is that folder's root.
		const relativePath = folders.length > 1 && resolved.relativePath === folder.name && normalized === folder.name ? '' : resolved.relativePath;
		const uri = relativePath ? folder.toResource(relativePath) : folder.uri;
		if (!this._uriIdentityService.extUri.isEqualOrParent(uri, folder.uri)) {
			return { ok: false, error: `"${path}" is not inside the workspace.` };
		}
		if (!await this._realLocationIsInside(uri, folder)) {
			return { ok: false, error: `"${path}" was refused: it resolves to a location outside the workspace through a symbolic link.` };
		}
		return { ok: true, uri, folder, relativePath, qualifiedPath: qualifyWorkspacePath(folderRefs, folder.index, relativePath) };
	}

	qualify(uri: URI): string | undefined {
		const folder = this._workspaceService.getWorkspaceFolder(uri);
		if (!folder) {
			return undefined;
		}
		const relative = this._uriIdentityService.extUri.relativePath(folder.uri, uri);
		if (relative === undefined) {
			return undefined;
		}
		const folders = this._workspaceService.getWorkspace().folders;
		return qualifyWorkspacePath(folders.map(candidate => ({ name: candidate.name, index: candidate.index })), folder.index, relative);
	}

	async isContained(uri: URI): Promise<boolean> {
		const folder = this._workspaceService.getWorkspaceFolder(uri);
		return !!folder && this._realLocationIsInside(uri, folder);
	}

	/**
	 * A provider without real-path support has no symbolic links to follow; a
	 * target that does not exist yet has no real location either, and the
	 * caller's own read reports it as missing.
	 */
	private async _realLocationIsInside(uri: URI, folder: IWorkspaceFolder): Promise<boolean> {
		let real: URI | undefined;
		try {
			real = await this._fileService.realpath(uri);
		} catch {
			return true;
		}
		if (!real) {
			return true;
		}
		let realFolder: URI | undefined;
		try {
			realFolder = await this._fileService.realpath(folder.uri);
		} catch {
			realFolder = undefined;
		}
		return this._uriIdentityService.extUri.isEqualOrParent(real, realFolder ?? folder.uri);
	}
}
