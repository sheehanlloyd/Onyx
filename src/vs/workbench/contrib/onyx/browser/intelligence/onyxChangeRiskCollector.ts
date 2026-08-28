/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { URI } from '../../../../../base/common/uri.js';
import { Position } from '../../../../../editor/common/core/position.js';
import { IModelService } from '../../../../../editor/common/services/model.js';
import { ILanguageFeaturesService } from '../../../../../editor/common/services/languageFeatures.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IOnyxRuntimeService } from '../../../../../platform/onyxRuntime/common/onyxRuntime.js';
import { IWorkspaceFolder } from '../../../../../platform/workspace/common/workspace.js';
import { extractDiffSignals, IOnyxChangeRisk, scoreChangeRisk } from '../../common/onyxChangeRisk.js';
import { buildCoChangeIndex, coChangedWith } from '../../common/onyxCoChange.js';
import { splitDiffByFile } from '../../common/onyxCommitMessage.js';

/** History window for churn/coupling; long enough that coupling shows up. */
const COMMIT_WINDOW = 150;
/** Fan-in is measured through language services; cap how many files pay that cost. */
const MAX_REFERENCE_FILES = 5;

/**
 * Gathers the risk signals for a set of changed files — git history through
 * the shared process, test proximity through the file service, call-graph
 * fan-in through the reference provider — and hands them to the pure scorer.
 * Fan-in is only measured on files whose text models are already loaded:
 * risk annotation must never trigger a workspace-wide parse.
 */
export class OnyxChangeRiskCollector {

	constructor(
		@IOnyxRuntimeService private readonly _runtimeService: IOnyxRuntimeService,
		@IFileService private readonly _fileService: IFileService,
		@IModelService private readonly _modelService: IModelService,
		@ILanguageFeaturesService private readonly _languageFeaturesService: ILanguageFeaturesService,
	) { }

	/**
	 * Scores every file in `diffText` (one folder's diff), ordered riskiest
	 * first. Paths in the result are folder-relative, matching the diff.
	 */
	async collect(folder: IWorkspaceFolder, diffText: string): Promise<IOnyxChangeRisk[]> {
		let groups: readonly (readonly string[])[] = [];
		try {
			groups = await this._runtimeService.gitCommitFileGroups(folder.uri.fsPath, COMMIT_WINDOW);
		} catch {
			// no git history: churn and coupling read as zero
		}
		const churn = new Map<string, number>();
		for (const group of groups) {
			for (const path of group) {
				churn.set(path, (churn.get(path) ?? 0) + 1);
			}
		}
		const coChangeIndex = buildCoChangeIndex(groups);

		const risks: IOnyxChangeRisk[] = [];
		let referenceBudget = MAX_REFERENCE_FILES;
		for (const fileDiff of splitDiffByFile(diffText)) {
			const diffSignals = extractDiffSignals(fileDiff);
			if (!diffSignals.path) {
				continue;
			}
			const uri = URI.joinPath(folder.uri, diffSignals.path);
			const referenceCount = referenceBudget > 0 ? await this._referenceCount(uri) : undefined;
			if (referenceCount !== undefined) {
				referenceBudget--;
			}
			risks.push(scoreChangeRisk({
				...diffSignals,
				churnCommits: churn.get(diffSignals.path) ?? 0,
				windowCommits: groups.length,
				coChangePartners: coChangedWith(coChangeIndex, diffSignals.path, 10).length,
				referenceCount,
				hasNearbyTest: await this._hasNearbyTest(uri),
			}));
		}
		return risks.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
	}

	/** A conventional test next to the file, or a test/tests folder beside it. */
	private async _hasNearbyTest(uri: URI): Promise<boolean> {
		const base = uri.path.replace(/\.[^/.]+$/, '');
		const extension = uri.path.slice(base.length);
		const parent = uri.with({ path: uri.path.slice(0, uri.path.lastIndexOf('/')) });
		const candidates = [
			uri.with({ path: `${base}.test${extension}` }),
			uri.with({ path: `${base}.spec${extension}` }),
			URI.joinPath(parent, 'test'),
			URI.joinPath(parent, 'tests'),
			URI.joinPath(parent, '__tests__'),
		];
		for (const candidate of candidates) {
			if (await this._fileService.exists(candidate)) {
				return true;
			}
		}
		return false;
	}

	/**
	 * Call-graph fan-in: reference count at the file's first symbol. Only
	 * files with an already-loaded text model are measured — `undefined`
	 * means "not measured", never "zero".
	 */
	private async _referenceCount(uri: URI): Promise<number | undefined> {
		const model = this._modelService.getModel(uri);
		if (!model) {
			return undefined;
		}
		try {
			const [symbolProvider] = this._languageFeaturesService.documentSymbolProvider.ordered(model);
			const symbols = symbolProvider ? await symbolProvider.provideDocumentSymbols(model, CancellationToken.None) : undefined;
			const first = symbols?.[0];
			if (!first) {
				return undefined;
			}
			const [referenceProvider] = this._languageFeaturesService.referenceProvider.ordered(model);
			if (!referenceProvider) {
				return undefined;
			}
			const references = await referenceProvider.provideReferences(
				model,
				new Position(first.selectionRange.startLineNumber, first.selectionRange.startColumn),
				{ includeDeclaration: false },
				CancellationToken.None);
			return references?.length;
		} catch {
			return undefined;
		}
	}
}
