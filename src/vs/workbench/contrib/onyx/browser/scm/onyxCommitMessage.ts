/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { localize } from '../../../../../nls.js';
import { INotificationService, Severity } from '../../../../../platform/notification/common/notification.js';
import { IOnyxRuntimeService } from '../../../../../platform/onyxRuntime/common/onyxRuntime.js';
import { IProgressService, ProgressLocation } from '../../../../../platform/progress/common/progress.js';
import { ISCMRepository, ISCMService } from '../../../scm/common/scm.js';
import { buildCommitDiffDigest, cleanCommitMessage, ONYX_COMMIT_SYSTEM_PROMPT } from '../../common/onyxCommitMessage.js';
import { runOneShot } from '../agent/onyxOneShot.js';
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

		const diff = await this._runtimeService.gitDiff(root.fsPath, true, MAX_DIFF_CHARS);
		if (!diff.text.trim()) {
			this._notificationService.notify({ severity: Severity.Info, message: localize('onyx.commit.nothingStaged', "Nothing is staged. Stage the changes you want described.") });
			return;
		}

		const user = buildCommitDiffDigest(diff.text, diff.files, MAX_DIFF_CHARS);
		const cancellation = new CancellationTokenSource();
		try {
			const raw = await this._progressService.withProgress({
				location: ProgressLocation.Scm,
				title: localize('onyx.commit.working', "Writing a commit message locally…"),
			}, () => runOneShot(this._modelService, ONYX_COMMIT_SYSTEM_PROMPT, user, cancellation.token));

			const message = cleanCommitMessage(raw);
			if (!message) {
				this._notificationService.notify({ severity: Severity.Warning, message: localize('onyx.commit.empty', "The model returned nothing usable. Try again, or pick a larger model.") });
				return;
			}
			target.input.setValue(message, false);
			target.input.setFocus();
		} catch (error) {
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
