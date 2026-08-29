/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RunOnceScheduler } from '../../../../../base/common/async.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../../base/common/network.js';
import { joinPath } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IOnyxRuntimeService } from '../../../../../platform/onyxRuntime/common/onyxRuntime.js';
import { IWorkspaceContextService, IWorkspaceFolder } from '../../../../../platform/workspace/common/workspace.js';
import { IWorkbenchEnvironmentService } from '../../../../services/environment/common/environmentService.js';

/** Startup must never wait on indexing; the walk starts once the workbench is settled. */
const BUILD_DELAY_MS = 8000;
const UPDATE_DEBOUNCE_MS = 5000;

/** Where a folder's BM25 index persists: next to the run journal, per workspace. */
export function bm25PersistPath(environmentService: IWorkbenchEnvironmentService, workspaceService: IWorkspaceContextService, folder: IWorkspaceFolder): URI {
	return joinPath(environmentService.workspaceStorageHome, workspaceService.getWorkspace().id, 'onyx', `bm25-${folder.index}.json`);
}

/** Where a folder's documentation-mirror index persists, alongside the source index. */
export function docsPersistPath(environmentService: IWorkbenchEnvironmentService, workspaceService: IWorkspaceContextService, folder: IWorkspaceFolder): URI {
	return joinPath(environmentService.workspaceStorageHome, workspaceService.getWorkspace().id, 'onyx', `docs-${folder.index}.json`);
}

/**
 * Owns the lifetime of the embedding-free content index: builds it shortly
 * after startup (off the critical path), and feeds file changes to the shared
 * process so retrieval stays current as the user edits. The index itself
 * lives and persists in the shared process; this side only schedules.
 */
export class OnyxWorkspaceIndexContribution extends Disposable {

	static readonly ID = 'workbench.contrib.onyxWorkspaceIndex';

	private readonly _pendingChanges = new Map<number, Set<string>>();
	private readonly _flushScheduler: RunOnceScheduler;

	constructor(
		@IOnyxRuntimeService private readonly _runtimeService: IOnyxRuntimeService,
		@IWorkspaceContextService private readonly _workspaceService: IWorkspaceContextService,
		@IWorkbenchEnvironmentService private readonly _environmentService: IWorkbenchEnvironmentService,
		@IFileService fileService: IFileService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();

		this._flushScheduler = this._register(new RunOnceScheduler(() => this._flushChanges(), UPDATE_DEBOUNCE_MS));

		const buildTimer = setTimeout(() => this._buildAll(), BUILD_DELAY_MS);
		this._register({ dispose: () => clearTimeout(buildTimer) });

		this._register(fileService.onDidFilesChange(event => {
			for (const folder of this._workspaceService.getWorkspace().folders) {
				if (folder.uri.scheme !== Schemas.file) {
					continue;
				}
				const folderPath = folder.uri.fsPath.endsWith('/') ? folder.uri.fsPath : `${folder.uri.fsPath}/`;
				for (const change of [...event.rawAdded, ...event.rawUpdated, ...event.rawDeleted]) {
					if (change.scheme === Schemas.file && change.fsPath.startsWith(folderPath)) {
						let pending = this._pendingChanges.get(folder.index);
						if (!pending) {
							pending = new Set();
							this._pendingChanges.set(folder.index, pending);
						}
						pending.add(change.fsPath.slice(folderPath.length));
					}
				}
			}
			if (this._pendingChanges.size > 0) {
				this._flushScheduler.schedule();
			}
		}));
	}

	private async _buildAll(): Promise<void> {
		for (const folder of this._workspaceService.getWorkspace().folders) {
			if (folder.uri.scheme !== Schemas.file) {
				continue;
			}
			try {
				const stats = await this._runtimeService.ensureWorkspaceIndex(folder.uri.fsPath, bm25PersistPath(this._environmentService, this._workspaceService, folder).fsPath);
				this._logService.info(`[onyx] content index for ${folder.name}: ${stats.files} files${stats.buildMs ? ` in ${stats.buildMs}ms` : ' (persisted)'}${stats.truncated ? ', truncated by caps' : ''}`);
			} catch (error) {
				this._logService.warn('[onyx] content index build failed', error);
			}
		}
	}

	private _flushChanges(): void {
		for (const [folderIndex, paths] of this._pendingChanges) {
			const folder = this._workspaceService.getWorkspace().folders.find(f => f.index === folderIndex);
			if (!folder) {
				continue;
			}
			this._runtimeService.updateWorkspaceIndex(folder.uri.fsPath, bm25PersistPath(this._environmentService, this._workspaceService, folder).fsPath, [...paths])
				.catch(error => this._logService.warn('[onyx] content index update failed', error));
			// Markdown changes also refresh the documentation mirror; the shared
			// process ignores everything else in the list.
			const markdown = [...paths].filter(path => path.toLowerCase().endsWith('.md'));
			if (markdown.length > 0) {
				this._runtimeService.updateDocsIndex(folder.uri.fsPath, docsPersistPath(this._environmentService, this._workspaceService, folder).fsPath, markdown)
					.catch(error => this._logService.warn('[onyx] docs mirror update failed', error));
			}
		}
		this._pendingChanges.clear();
	}
}
