/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Schemas } from '../../../../../base/common/network.js';
import { isEqual } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { IOnyxRuntimeService } from '../../../../../platform/onyxRuntime/common/onyxRuntime.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IHistoryService } from '../../../../services/history/common/history.js';

/** One workspace file with the evidence for why it is currently relevant. */
export interface IOnyxRankedFile {
	/** Workspace-relative path. */
	readonly path: string;
	readonly score: number;
	readonly reasons: readonly string[];
}

/** The raw, per-source relevance signals collected from the workbench. Paths are workspace-relative. */
export interface IOnyxContextSignals {
	readonly activePath: string | undefined;
	readonly visiblePaths: readonly string[];
	/** Most recently opened first. */
	readonly historyPaths: readonly string[];
	/** Most recently committed first. */
	readonly gitRecentPaths: readonly string[];
}

const HISTORY_LIMIT = 20;
const GIT_COMMIT_LIMIT = 30;

/**
 * Merges the signals into one deterministic ranking. Weights express how
 * strongly each source predicts "the user is working here right now": the
 * focused file dominates, visible files beat recently closed ones, and git
 * recency is the weakest but broadest signal. Recency within a source decays
 * geometrically so order matters but never overwhelms the source weight.
 */
export function mergeContextSignals(signals: IOnyxContextSignals, limit: number): IOnyxRankedFile[] {
	const scores = new Map<string, { score: number; reasons: string[] }>();
	const add = (path: string, score: number, reason: string) => {
		let entry = scores.get(path);
		if (!entry) {
			entry = { score: 0, reasons: [] };
			scores.set(path, entry);
		}
		entry.score += score;
		entry.reasons.push(reason);
	};

	if (signals.activePath) {
		add(signals.activePath, 3, 'active editor');
	}
	for (const path of signals.visiblePaths) {
		if (path !== signals.activePath) {
			add(path, 2, 'visible editor');
		}
	}
	signals.historyPaths.forEach((path, index) => {
		add(path, 1.5 * Math.pow(0.85, index), 'recently opened');
	});
	signals.gitRecentPaths.forEach((path, index) => {
		add(path, 1 * Math.pow(0.9, index), 'recently committed');
	});

	return [...scores.entries()]
		.map(([path, { score, reasons }]) => ({ path, score, reasons: [...new Set(reasons)] }))
		.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
		.slice(0, limit);
}

/**
 * Collects "where is the user working" evidence from the live workbench —
 * open editors, editor history, and the git log via the shared process — and
 * turns it into a ranked file list for the prompt builder. Everything is
 * deterministic and local; there is no embedding model in the loop.
 */
export class OnyxContextRanker {

	constructor(
		@IEditorService private readonly _editorService: IEditorService,
		@IHistoryService private readonly _historyService: IHistoryService,
		@IWorkspaceContextService private readonly _workspaceService: IWorkspaceContextService,
		@IOnyxRuntimeService private readonly _runtimeService: IOnyxRuntimeService,
	) { }

	async rank(limit: number): Promise<IOnyxRankedFile[]> {
		const folder = this._workspaceService.getWorkspace().folders[0];
		if (!folder) {
			return [];
		}

		const toRelative = (resource: URI | undefined): string | undefined => {
			if (!resource || resource.scheme !== Schemas.file || isEqual(resource, folder.uri)) {
				return undefined;
			}
			const folderPath = folder.uri.fsPath.endsWith('/') ? folder.uri.fsPath : `${folder.uri.fsPath}/`;
			return resource.fsPath.startsWith(folderPath) ? resource.fsPath.slice(folderPath.length) : undefined;
		};

		const visiblePaths: string[] = [];
		for (const editor of this._editorService.visibleEditors) {
			const path = toRelative(editor.resource);
			if (path) {
				visiblePaths.push(path);
			}
		}
		const historyPaths: string[] = [];
		for (const entry of this._historyService.getHistory().slice(0, HISTORY_LIMIT)) {
			const path = toRelative(entry.resource);
			if (path) {
				historyPaths.push(path);
			}
		}

		let gitRecentPaths: readonly string[] = [];
		try {
			gitRecentPaths = await this._runtimeService.gitRecentFiles(folder.uri.fsPath, GIT_COMMIT_LIMIT);
		} catch {
			// shared process unavailable: rank from editor signals alone
		}

		return mergeContextSignals({
			activePath: toRelative(this._editorService.activeEditor?.resource),
			visiblePaths,
			historyPaths,
			gitRecentPaths,
		}, limit);
	}
}
