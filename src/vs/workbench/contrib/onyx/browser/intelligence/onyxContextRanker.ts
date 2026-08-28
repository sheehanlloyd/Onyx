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
import { buildCoChangeIndex, coChangedWith, IOnyxCoChangedFile } from '../../common/onyxCoChange.js';
import { qualifyWorkspacePath, resolveWorkspacePath } from '../../common/onyxWorkspacePaths.js';
import { IOnyxProjectConfigService } from '../config/onyxProjectConfigService.js';
import { IOnyxPinService } from './onyxPinService.js';

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
	/** Files history says change alongside the active file, strongest first. */
	readonly coChangedPaths?: readonly IOnyxCoChangedFile[];
}

const HISTORY_LIMIT = 20;
const GIT_COMMIT_LIMIT = 30;
/** Co-change needs a longer window than recency: coupling shows up over months, not over the last few commits. */
const CO_CHANGE_COMMIT_LIMIT = 150;
const CO_CHANGE_LIMIT = 5;

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
	// Weighted below the editor signals but above bare git recency: a file that
	// keeps changing with the one you are in is a better guess than a file that
	// merely changed lately.
	for (const partner of signals.coChangedPaths ?? []) {
		if (partner.path !== signals.activePath) {
			add(partner.path, 1.6 * partner.strength, `changes with ${signals.activePath ?? 'the active file'}`);
		}
	}

	return [...scores.entries()]
		.map(([path, { score, reasons }]) => ({ path, score, reasons: [...new Set(reasons)] }))
		.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
		.slice(0, limit);
}

/**
 * Applies the user's explicit steering to an automatic ranking: excluded
 * files drop out, pinned files lead with a score above everything ranked —
 * and pins never count against the caller's limit, because "always in the
 * prompt" is the whole promise of a pin.
 */
export function applyContextSteering(ranked: readonly IOnyxRankedFile[], pins: readonly string[], exclusions: readonly string[], limit: number): IOnyxRankedFile[] {
	const excluded = new Set(exclusions);
	const pinnedSet = new Set(pins);
	const kept = ranked.filter(file => !excluded.has(file.path) && !pinnedSet.has(file.path)).slice(0, limit);
	const topScore = ranked[0]?.score ?? 0;
	const pinned = pins.map(path => ({ path, score: topScore + 1, reasons: ['pinned'] }));
	return [...pinned, ...kept];
}

/** Round-robins several recency-ordered lists into one, preserving each list's order. */
function interleave(lists: readonly (readonly string[])[]): string[] {
	const result: string[] = [];
	const longest = Math.max(0, ...lists.map(list => list.length));
	for (let i = 0; i < longest; i++) {
		for (const list of lists) {
			if (i < list.length) {
				result.push(list[i]);
			}
		}
	}
	return result;
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
		@IOnyxPinService private readonly _pinService: IOnyxPinService,
		@IOnyxProjectConfigService private readonly _projectConfigService: IOnyxProjectConfigService,
	) { }

	/**
	 * Ranks workspace files by current relevance. Pass `gitRecency: false` on
	 * latency-sensitive paths (inline autocomplete) to skip the shared-process
	 * git round trip and rank from editor signals alone.
	 */
	async rank(limit: number, options?: { readonly gitRecency?: boolean }): Promise<IOnyxRankedFile[]> {
		const folders = this._workspaceService.getWorkspace().folders;
		if (folders.length === 0) {
			return [];
		}
		const folderRefs = folders.map(f => ({ name: f.name, index: f.index }));

		// Multi-root: paths are qualified with their folder name so every root
		// participates in one ranking and the strings still resolve back.
		const toRelative = (resource: URI | undefined): string | undefined => {
			if (!resource || resource.scheme !== Schemas.file) {
				return undefined;
			}
			for (const folder of folders) {
				if (isEqual(resource, folder.uri)) {
					return undefined;
				}
				const folderPath = folder.uri.fsPath.endsWith('/') ? folder.uri.fsPath : `${folder.uri.fsPath}/`;
				if (resource.fsPath.startsWith(folderPath)) {
					return qualifyWorkspacePath(folderRefs, folder.index, resource.fsPath.slice(folderPath.length));
				}
			}
			return undefined;
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

		const activePath = toRelative(this._editorService.activeEditor?.resource);

		let gitRecentPaths: readonly string[] = [];
		let coChangedPaths: readonly IOnyxCoChangedFile[] = [];
		if (options?.gitRecency !== false) {
			try {
				const perFolder = await Promise.all(folders.map(async folder => {
					const recent = await this._runtimeService.gitRecentFiles(folder.uri.fsPath, GIT_COMMIT_LIMIT);
					return recent.map(path => qualifyWorkspacePath(folderRefs, folder.index, path));
				}));
				// Interleave the roots so one busy repository cannot crowd the
				// others out of the decayed recency scores.
				gitRecentPaths = interleave(perFolder);
				if (activePath) {
					const active = resolveWorkspacePath(folderRefs, activePath);
					const activeFolder = active ? folders.find(f => f.index === active.folderIndex) : undefined;
					if (active && activeFolder) {
						const groups = await this._runtimeService.gitCommitFileGroups(activeFolder.uri.fsPath, CO_CHANGE_COMMIT_LIMIT);
						coChangedPaths = coChangedWith(buildCoChangeIndex(groups), active.relativePath, CO_CHANGE_LIMIT)
							.map(partner => ({ ...partner, path: qualifyWorkspacePath(folderRefs, activeFolder.index, partner.path) }));
					}
				}
			} catch {
				// shared process unavailable: rank from editor signals alone
			}
		}

		const ranked = mergeContextSignals({
			activePath,
			visiblePaths,
			historyPaths,
			gitRecentPaths,
			coChangedPaths,
		}, limit);
		const projectPins = this._projectConfigService.resolved.get().config.contextPins ?? [];
		const pins = [...new Set([...projectPins, ...this._pinService.pins.get()])];
		return applyContextSteering(ranked, pins, this._pinService.exclusions.get(), limit);
	}
}
