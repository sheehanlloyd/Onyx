/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { INotificationService, Severity } from '../../../../../platform/notification/common/notification.js';
import { IOnyxRuntimeService } from '../../../../../platform/onyxRuntime/common/onyxRuntime.js';
import { IProgressService, ProgressLocation } from '../../../../../platform/progress/common/progress.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { buildCommitDiffDigest } from '../../common/onyxCommitMessage.js';
import { IOnyxReviewFinding, ONYX_REVIEW_SYSTEM_PROMPT, parseReviewFindings } from '../../common/onyxReview.js';
import { runOneShot } from '../agent/onyxOneShot.js';
import { IOnyxControlPlaneService } from '../controlPlane/onyxControlPlaneService.js';
import { IOnyxModelService } from '../model/onyxLanguageModelProvider.js';

/** A review can afford a bigger slice of diff than a commit message: it is the whole point of the request. */
const MAX_DIFF_CHARS = 24_000;

/**
 * Runs the working-tree diff past an adversarial local reviewer and lands the
 * findings on the control-plane timeline as file:line links. It reports only —
 * a reviewer that edits your code is not a reviewer.
 */
export class OnyxReviewChanges {

	constructor(
		@IOnyxRuntimeService private readonly _runtimeService: IOnyxRuntimeService,
		@IOnyxModelService private readonly _modelService: IOnyxModelService,
		@IOnyxControlPlaneService private readonly _controlPlaneService: IOnyxControlPlaneService,
		@IWorkspaceContextService private readonly _workspaceService: IWorkspaceContextService,
		@IProgressService private readonly _progressService: IProgressService,
		@INotificationService private readonly _notificationService: INotificationService,
	) { }

	async run(): Promise<void> {
		const folder = this._workspaceService.getWorkspace().folders[0];
		if (!folder) {
			this._notificationService.notify({ severity: Severity.Info, message: localize('onyx.review.noFolder', "Open a folder to review its changes.") });
			return;
		}
		if (this._modelService.getKnownModels().length === 0) {
			this._notificationService.notify({ severity: Severity.Info, message: localize('onyx.review.noModel', "No local model is available. Start a runtime and pull a model first.") });
			return;
		}

		const diff = await this._runtimeService.gitDiff(folder.uri.fsPath, false, MAX_DIFF_CHARS);
		if (!diff.text.trim()) {
			this._notificationService.notify({ severity: Severity.Info, message: localize('onyx.review.noChanges', "The working tree is clean — nothing to review.") });
			return;
		}

		const handle = this._controlPlaneService.beginRun({
			// A review is not a chat turn, but it is a run: it deserves the same
			// timeline, journal and inspector treatment as anything the agent does.
			sessionResource: URI.from({ scheme: 'onyx-review', path: `/${generateUuid()}` }),
			requestId: generateUuid(),
			title: diff.files.length === 1
				? localize('onyx.review.title.one', "Review of 1 changed file")
				: localize('onyx.review.title', "Review of {0} changed files", diff.files.length),
			task: 'review',
			modelKey: 'auto',
		});
		handle.activity({
			kind: 'note',
			label: localize('onyx.review.started', "Reviewing the working tree"),
			reason: diff.truncated
				? localize('onyx.review.truncated', "Diff truncated to fit the context window")
				: diff.files.join(', '),
		});

		const cancellation = new CancellationTokenSource();
		try {
			const raw = await this._progressService.withProgress({
				location: ProgressLocation.Notification,
				title: localize('onyx.review.progress', "Onyx is reviewing your changes locally…"),
				cancellable: true,
			}, () => runOneShot(this._modelService, ONYX_REVIEW_SYSTEM_PROMPT, buildCommitDiffDigest(diff.text, diff.files, MAX_DIFF_CHARS), cancellation.token),
				() => cancellation.cancel());

			const findings = parseReviewFindings(raw);
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

function severityLabel(severity: IOnyxReviewFinding['severity']): string {
	switch (severity) {
		case 'high': return localize('onyx.review.high', "[high]");
		case 'medium': return localize('onyx.review.medium', "[medium]");
		case 'low': return localize('onyx.review.low', "[low]");
	}
}
