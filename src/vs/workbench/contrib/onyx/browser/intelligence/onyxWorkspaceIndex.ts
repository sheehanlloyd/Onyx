/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RunOnceScheduler } from '../../../../../base/common/async.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../../base/common/network.js';
import { joinPath } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IOnyxIndexOptions, IOnyxRuntimeService } from '../../../../../platform/onyxRuntime/common/onyxRuntime.js';
import { IWorkspaceContextService, IWorkspaceFolder } from '../../../../../platform/workspace/common/workspace.js';
import { IWorkbenchEnvironmentService } from '../../../../services/environment/common/environmentService.js';
import { OnyxSettingId } from '../../common/onyxConfiguration.js';
import { describeIndexCoverage, OnyxExcludeSetting, workspaceIndexOptions } from '../../common/onyxIndexOptions.js';

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
 * What to tell the reader of a result ranked from the content index when the
 * index does not hold all of a folder (C7): a sentence a folder, with the
 * folder's name when the workspace has more than one.
 */
export async function indexCoverageNotes(runtimeService: IOnyxRuntimeService, environmentService: IWorkbenchEnvironmentService, workspaceService: IWorkspaceContextService): Promise<string[]> {
	const folders = workspaceService.getWorkspace().folders.filter(folder => folder.uri.scheme === Schemas.file);
	const notes: string[] = [];
	for (const folder of folders) {
		try {
			const note = describeIndexCoverage(await runtimeService.ensureWorkspaceIndex(folder.uri.fsPath, bm25PersistPath(environmentService, workspaceService, folder).fsPath));
			if (note) {
				notes.push(folders.length > 1 ? `${folder.name}: ${note}` : note);
			}
		} catch {
			// No index for this folder: there is nothing to say about one.
		}
	}
	return notes;
}

const EXCLUDE_SETTINGS = ['files.exclude', 'search.exclude'];

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
		@IConfigurationService private readonly _configurationService: IConfigurationService,
	) {
		super();

		this._flushScheduler = this._register(new RunOnceScheduler(() => this._flushChanges(), UPDATE_DEBOUNCE_MS));

		// What the index covers is settled before anything can ask it a question: a search that arrives
		// ahead of the delayed build then builds under the workspace's exclusions, not without them.
		this._configureAll();
		const buildTimer = setTimeout(() => this._buildAll(), BUILD_DELAY_MS);
		this._register({ dispose: () => clearTimeout(buildTimer) });
		this._register(this._configurationService.onDidChangeConfiguration(event => {
			if (EXCLUDE_SETTINGS.some(setting => event.affectsConfiguration(setting)) || event.affectsConfiguration(OnyxSettingId.IndexMaxFiles)) {
				// Other exclusions or another cap make another index; the shared process drops the old one.
				this._buildAll();
			}
		}));

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

	/** What the index for a folder covers: the folder's exclude settings and the user's file cap. */
	private _indexOptions(folder: IWorkspaceFolder): IOnyxIndexOptions {
		const [filesExclude, searchExclude] = EXCLUDE_SETTINGS.map(setting => this._configurationService.getValue<OnyxExcludeSetting>(setting, { resource: folder.uri }));
		return workspaceIndexOptions(filesExclude, searchExclude, this._configurationService.getValue(OnyxSettingId.IndexMaxFiles));
	}

	private async _configureAll(): Promise<void> {
		for (const folder of this._workspaceService.getWorkspace().folders) {
			if (folder.uri.scheme !== Schemas.file) {
				continue;
			}
			try {
				await this._runtimeService.configureWorkspaceIndex(folder.uri.fsPath, this._indexOptions(folder));
			} catch (error) {
				this._logService.warn('[onyx] content index could not be configured', error);
			}
		}
	}

	private async _buildAll(): Promise<void> {
		for (const folder of this._workspaceService.getWorkspace().folders) {
			if (folder.uri.scheme !== Schemas.file) {
				continue;
			}
			try {
				await this._runtimeService.configureWorkspaceIndex(folder.uri.fsPath, this._indexOptions(folder));
				const stats = await this._runtimeService.ensureWorkspaceIndex(folder.uri.fsPath, bm25PersistPath(this._environmentService, this._workspaceService, folder).fsPath);
				const origin = stats.source === 'built' ? 'built' : stats.source === 'loaded' ? 'loaded, unchanged' : `loaded and reconciled (${stats.reconciled?.added ?? 0} added, ${stats.reconciled?.updated ?? 0} updated, ${stats.reconciled?.removed ?? 0} removed)`;
				this._logService.info(`[onyx] content index for ${folder.name}: ${stats.files} of ${stats.eligibleFiles} eligible files, ${origin} in ${stats.buildMs}ms${stats.truncated ? ', truncated by caps: part of the workspace is not indexed' : ''}`);
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
