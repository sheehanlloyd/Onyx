/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { localize } from '../../../../../nls.js';
import { URI } from '../../../../../base/common/uri.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { INotificationService, Severity } from '../../../../../platform/notification/common/notification.js';
import { IOnyxRuntimeService } from '../../../../../platform/onyxRuntime/common/onyxRuntime.js';
import { IProgressService, ProgressLocation } from '../../../../../platform/progress/common/progress.js';
import { ISCMRepository, ISCMService } from '../../../scm/common/scm.js';
import { buildCommitDiffDigest, cleanCommitMessage, ONYX_COMMIT_SYSTEM_PROMPT } from '../../common/onyxCommitMessage.js';
import { runOneShot } from '../agent/onyxOneShot.js';
import { IOnyxControlPlaneService } from '../controlPlane/onyxControlPlaneService.js';
import { IOnyxModelService } from '../model/onyxLanguageModelProvider.js';

/** How much diff a commit message is allowed to cost. Deliberately modest: subjects come from shape, not from every line. */
const MAX_DIFF_CHARS = 12_000;

/**
 * Writes the commit message for the staged change with a local model and
 * streams it straight into the SCM input, where it is still just text the user
 * can edit. Nothing is committed.
 */
export class OnyxCommitMessageGenerator {

	constructor(
		@ISCMService private readonly _scmService: ISCMService,
		@IOnyxRuntimeService private readonly _runtimeService: IOnyxRuntimeService,
		@IOnyxModelService private readonly _modelService: IOnyxModelService,
		@IOnyxControlPlaneService private readonly _controlPlaneService: IOnyxControlPlaneService,
		@IProgressService private readonly _progressService: IProgressService,
		@INotificationService private readonly _notificationService: INotificationService,
	) { }

	async generate(repository: ISCMRepository | undefined): Promise<void> {
		const target = repository ?? firstRepositoryWithRoot(this._scmService);
		const root = target?.provider.rootUri;
		if (!target || !root) {
			this._notificationService.notify({ severity: Severity.Info, message: localize('onyx.commit.noRepo', "Open a git repository to generate a commit message.") });
			return;
		}
		if (this._modelService.getKnownModels().length === 0) {
			this._notificationService.notify({ severity: Severity.Info, message: localize('onyx.commit.noModel', "No local model is available. Start a runtime and pull a model first.") });
			return;
		}

		const diff = await this._runtimeService.gitDiff(root.fsPath, 'staged', MAX_DIFF_CHARS);
		if (!diff.text.trim()) {
			this._notificationService.notify({ severity: Severity.Info, message: localize('onyx.commit.nothingStaged', "Nothing is staged. Stage the changes you want described.") });
			return;
		}

		// A commit message is a run too: it shows as in flight in the Compute
		// view and its exact prompt is replayable from the Inspector.
		const handle = this._controlPlaneService.beginRun({
			sessionResource: URI.from({ scheme: 'onyx-commit', path: `/${generateUuid()}` }),
			requestId: generateUuid(),
			title: diff.files.length === 1
				? localize('onyx.commit.runTitle.one', "Commit message for 1 staged file")
				: localize('onyx.commit.runTitle', "Commit message for {0} staged files", diff.files.length),
			task: 'quick-edit',
			modelKey: 'auto',
		});

		const user = buildCommitDiffDigest(diff.text, diff.files, MAX_DIFF_CHARS);
		const cancellation = new CancellationTokenSource();
		try {
			const raw = await this._progressService.withProgress({
				location: ProgressLocation.Scm,
				title: localize('onyx.commit.working', "Writing a commit message locally…"),
			}, () => runOneShot(this._modelService, ONYX_COMMIT_SYSTEM_PROMPT, user, cancellation.token, { run: handle, controlPlane: this._controlPlaneService }));

			const message = cleanCommitMessage(raw);
			if (!message) {
				handle.activity({ kind: 'note', label: localize('onyx.commit.emptyNote', "The model returned nothing usable"), ok: false });
				handle.complete('failed');
				this._notificationService.notify({ severity: Severity.Warning, message: localize('onyx.commit.empty', "The model returned nothing usable. Try again, or pick a larger model.") });
				return;
			}
			handle.activity({ kind: 'note', label: localize('onyx.commit.doneNote', "Commit message written to the SCM input"), reason: message.split('\n')[0], ok: true });
			handle.complete('completed');
			target.input.setValue(message, false);
			target.input.setFocus();
		} catch (error) {
			handle.activity({ kind: 'note', label: localize('onyx.commit.failedNote', "Commit message generation failed"), reason: error instanceof Error ? error.message : String(error), ok: false });
			handle.complete('failed');
			this._notificationService.notify({ severity: Severity.Error, message: localize('onyx.commit.failed', "Could not generate a commit message: {0}", error instanceof Error ? error.message : String(error)) });
		} finally {
			cancellation.dispose();
		}
	}
}

function firstRepositoryWithRoot(scmService: ISCMService): ISCMRepository | undefined {
	for (const repository of scmService.repositories) {
		if (repository.provider.rootUri) {
			return repository;
		}
	}
	return undefined;
}
