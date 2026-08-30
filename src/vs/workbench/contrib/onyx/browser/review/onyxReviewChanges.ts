/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { INotificationService, Severity } from '../../../../../platform/notification/common/notification.js';
import { IOnyxDiff, IOnyxRuntimeService } from '../../../../../platform/onyxRuntime/common/onyxRuntime.js';
import { IProgressService, ProgressLocation } from '../../../../../platform/progress/common/progress.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { buildCommitDiffDigest } from '../../common/onyxCommitMessage.js';
import { passesSeverityThreshold } from '../../common/onyxProjectConfig.js';
import { IOnyxReviewFinding, ONYX_REVIEW_SYSTEM_PROMPT, parseReviewFindings } from '../../common/onyxReview.js';
import { IOnyxProjectConfigService } from '../config/onyxProjectConfigService.js';
import { qualifyWorkspacePath } from '../../common/onyxWorkspacePaths.js';
import { runOneShot } from '../agent/onyxOneShot.js';
import { IOnyxControlPlaneService } from '../controlPlane/onyxControlPlaneService.js';
import { OnyxChangeRiskCollector } from '../intelligence/onyxChangeRiskCollector.js';
import { IOnyxModelService } from '../model/onyxLanguageModelProvider.js';
import { OnyxRiskLevel } from '../../common/onyxChangeRisk.js';

/** A review can afford a bigger slice of diff than a commit message: it is the whole point of the request. */
const MAX_DIFF_CHARS = 24_000;

/**
 * Runs every uncommitted change — staged and unstaged, across all workspace
 * roots — past an adversarial local reviewer and lands the findings on the
 * control-plane timeline as file:line links. It reports only — a reviewer that
 * edits your code is not a reviewer.
 */
export class OnyxReviewChanges {

	private readonly _riskCollector: OnyxChangeRiskCollector;

	constructor(
		@IOnyxRuntimeService private readonly _runtimeService: IOnyxRuntimeService,
		@IOnyxModelService private readonly _modelService: IOnyxModelService,
		@IOnyxControlPlaneService private readonly _controlPlaneService: IOnyxControlPlaneService,
		@IWorkspaceContextService private readonly _workspaceService: IWorkspaceContextService,
		@IProgressService private readonly _progressService: IProgressService,
		@INotificationService private readonly _notificationService: INotificationService,
		@IOnyxProjectConfigService private readonly _projectConfigService: IOnyxProjectConfigService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		this._riskCollector = instantiationService.createInstance(OnyxChangeRiskCollector);
	}

	async run(): Promise<void> {
		const folders = this._workspaceService.getWorkspace().folders;
		if (folders.length === 0) {
			this._notificationService.notify({ severity: Severity.Info, message: localize('onyx.review.noFolder', "Open a folder to review its changes.") });
			return;
		}
		if (this._modelService.getKnownModels().length === 0) {
			this._notificationService.notify({ severity: Severity.Info, message: localize('onyx.review.noModel', "No local model is available. Start a runtime and pull a model first.") });
			return;
		}

		// Everything uncommitted ('head' = staged ⊕ unstaged), per root. Roots
		// that are not git repositories come back as empty diffs and drop out.
		const folderRefs = folders.map(f => ({ name: f.name, index: f.index }));
		const perFolder: { folderIndex: number; diff: IOnyxDiff }[] = [];
		for (const folder of folders) {
			const budget = Math.floor(MAX_DIFF_CHARS / folders.length);
			const diff = await this._runtimeService.gitDiff(folder.uri.fsPath, 'head', budget);
			if (diff.text.trim()) {
				perFolder.push({ folderIndex: folder.index, diff });
			}
		}
		if (perFolder.length === 0) {
			this._notificationService.notify({ severity: Severity.Info, message: localize('onyx.review.noChanges', "The working tree is clean — nothing to review.") });
			return;
		}

		const qualifiedFiles = perFolder.flatMap(({ folderIndex, diff }) => diff.files.map(file => qualifyWorkspacePath(folderRefs, folderIndex, file)));
		const combinedText = perFolder.map(({ folderIndex, diff }) => {
			// In a multi-root workspace each root's diff is preceded by the same
			// qualifier the findings use, so the model reports paths that resolve.
			const folder = folderRefs.find(f => f.index === folderIndex);
			return folderRefs.length > 1 && folder ? `# Folder: ${folder.name}\n${diff.text}` : diff.text;
		}).join('\n');
		const truncated = perFolder.some(({ diff }) => diff.truncated);

		const handle = this._controlPlaneService.beginRun({
			// A review is not a chat turn, but it is a run: it deserves the same
			// timeline, journal and inspector treatment as anything the agent does.
			sessionResource: URI.from({ scheme: 'onyx-review', path: `/${generateUuid()}` }),
			requestId: generateUuid(),
			title: qualifiedFiles.length === 1
				? localize('onyx.review.title.one', "Review of 1 changed file")
				: localize('onyx.review.title', "Review of {0} changed files", qualifiedFiles.length),
			task: 'review',
			modelKey: 'auto',
		});
		handle.activity({
			kind: 'note',
			label: localize('onyx.review.started', "Reviewing staged and unstaged changes"),
			reason: truncated
				? localize('onyx.review.truncated', "Diff truncated to fit the context window")
				: qualifiedFiles.join(', '),
		});

		// Risk badges land before the model answers: they are deterministic and
		// they frame how carefully the findings below should be read.
		for (const { folderIndex, diff } of perFolder) {
			const folder = folders.find(f => f.index === folderIndex);
			if (!folder) {
				continue;
			}
			const risks = await this._riskCollector.collect(folder, diff.text);
			for (const risk of risks) {
				handle.activity({
					kind: 'note',
					label: localize('onyx.review.risk', "{0} · {1} risk", qualifyWorkspacePath(folderRefs, folderIndex, risk.path), riskLabel(risk.level)),
					reason: risk.reason,
					ok: risk.level === 'low' ? true : undefined,
					location: { path: qualifyWorkspacePath(folderRefs, folderIndex, risk.path), line: 1 },
				});
			}
		}

		const cancellation = new CancellationTokenSource();
		try {
			const raw = await this._progressService.withProgress({
				location: ProgressLocation.Notification,
				title: localize('onyx.review.progress', "Onyx is reviewing your changes locally…"),
				cancellable: true,
			}, () => runOneShot(this._modelService, ONYX_REVIEW_SYSTEM_PROMPT, buildCommitDiffDigest(combinedText, qualifiedFiles, MAX_DIFF_CHARS), cancellation.token, { run: handle, controlPlane: this._controlPlaneService }),
				() => cancellation.cancel());

			const threshold = this._projectConfigService.resolved.get().config.reviewSeverityThreshold;
			const allFindings = parseReviewFindings(raw);
			const findings = allFindings.filter(finding => passesSeverityThreshold(finding.severity, threshold));
			if (allFindings.length > findings.length) {
				const hidden = allFindings.length - findings.length;
				handle.activity({
					kind: 'note', label: hidden === 1
						? localize('onyx.review.filtered.one', "1 finding below the project's severity threshold hidden")
						: localize('onyx.review.filtered', "{0} findings below the project's severity threshold hidden", hidden),
				});
			}
			for (const finding of findings) {
				handle.activity({
					kind: 'note',
					label: `${severityLabel(finding.severity)} ${finding.title}`,
					reason: finding.detail,
					ok: finding.severity === 'low',
					location: { path: finding.file, line: finding.line },
				});
			}
			handle.activity({
				kind: 'note',
				label: findings.length === 0
					? localize('onyx.review.clean', "No problems found")
					: findings.length === 1
						? localize('onyx.review.done.one', "1 finding")
						: localize('onyx.review.done', "{0} findings", findings.length),
				ok: findings.length === 0,
			});
			handle.complete('completed');
			this._controlPlaneService.selectRun(handle.runId);
		} catch (error) {
			handle.activity({ kind: 'note', label: localize('onyx.review.failed', "Review failed"), reason: error instanceof Error ? error.message : String(error), ok: false });
			handle.complete('failed');
		} finally {
			cancellation.dispose();
		}
	}
}

function riskLabel(level: OnyxRiskLevel): string {
	switch (level) {
		case 'elevated': return localize('onyx.review.risk.elevated', "elevated");
		case 'moderate': return localize('onyx.review.risk.moderate', "moderate");
		case 'low': return localize('onyx.review.risk.low', "low");
	}
}

function severityLabel(severity: IOnyxReviewFinding['severity']): string {
	switch (severity) {
		case 'high': return localize('onyx.review.high', "[high]");
		case 'medium': return localize('onyx.review.medium', "[medium]");
		case 'low': return localize('onyx.review.low', "[low]");
	}
}
