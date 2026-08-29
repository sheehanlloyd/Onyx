/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Schemas } from '../../../../../base/common/network.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { INotificationService, Severity } from '../../../../../platform/notification/common/notification.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IOnyxRuntimeService } from '../../../../../platform/onyxRuntime/common/onyxRuntime.js';
import { buildResumeDigest, buildResumePrompt, findResumableRuns, resumeConditionMessages } from '../../common/onyxResume.js';
import { ONYX_VENDOR } from '../../common/onyxTypes.js';
import { IOnyxChangeSetService } from '../changes/onyxChangeSetService.js';
import { IOnyxModelService } from '../model/onyxLanguageModelProvider.js';
import { IOnyxOutcomeService } from './onyxOutcomeService.js';

const MAX_RESUMABLE_SHOWN = 12;

/**
 * `Onyx: Resume an Interrupted Run` — lists journaled runs that never
 * completed (a crash leaves them marked `running`), rebuilds a briefing from
 * the run's own journal, states out loud everything that changed since —
 * vanished model, moved HEAD, still-staged edits — and continues the task
 * through the ordinary chat surface. Nothing is silently reconstructed.
 */
registerAction2(class ResumeOnyxRunAction extends Action2 {
	constructor() {
		super({
			id: 'onyx.resumeRun',
			title: localize2('onyx.resumeRun', "Onyx: Resume an Interrupted Run"),
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const outcomeService = accessor.get(IOnyxOutcomeService);
		const modelService = accessor.get(IOnyxModelService);
		const runtimeService = accessor.get(IOnyxRuntimeService);
		const changeSetService = accessor.get(IOnyxChangeSetService);
		const workspaceService = accessor.get(IWorkspaceContextService);
		const quickInputService = accessor.get(IQuickInputService);
		const commandService = accessor.get(ICommandService);
		const notificationService = accessor.get(INotificationService);

		const resumable = findResumableRuns(await outcomeService.listRuns(), MAX_RESUMABLE_SHOWN);
		if (resumable.length === 0) {
			notificationService.notify({ severity: Severity.Info, message: localize('onyx.resume.none', "Every journaled run completed — there is nothing to resume.") });
			return;
		}

		const picked = await quickInputService.pick(resumable.map(summary => ({
			label: summary.title || localize('onyx.resume.untitled', "Untitled run"),
			description: localize('onyx.resume.pickDetail', "{0} · {1} · {2} turn(s)", summary.status, new Date(summary.startedAt).toLocaleString(), summary.turnCount),
			detail: summary.modelKey,
			summary,
		})), { placeHolder: localize('onyx.resume.pick', "Which interrupted run should continue?"), matchOnDescription: true });
		if (!picked) {
			return;
		}

		const record = await outcomeService.readRun(picked.summary.runId);
		if (!record) {
			notificationService.notify({ severity: Severity.Error, message: localize('onyx.resume.missing', "The journal for that run is gone — it cannot be resumed.") });
			return;
		}
		const digest = buildResumeDigest(record.events);

		// What changed since the interruption — each condition becomes a sentence.
		const originalModelKey = picked.summary.modelKey.startsWith(`${ONYX_VENDOR}:`) ? picked.summary.modelKey.slice(ONYX_VENDOR.length + 1) : picked.summary.modelKey;
		const modelAvailable = !!modelService.getKnownModel(originalModelKey) || originalModelKey === 'auto' || originalModelKey === 'benchmark';
		let headMoved: boolean | undefined;
		const recordedHead = record.events
			.map(event => (event.data as { resumeMeta?: { head?: string } } | undefined)?.resumeMeta?.head)
			.find(head => typeof head === 'string');
		const folder = workspaceService.getWorkspace().folders.find(f => f.uri.scheme === Schemas.file);
		if (recordedHead && folder) {
			try {
				const current = (await runtimeService.gitCommitCandidates(folder.uri.fsPath, 1))[0]?.hash;
				headMoved = current !== undefined ? current !== recordedHead : undefined;
			} catch {
				headMoved = undefined;
			}
		}
		const conditions = resumeConditionMessages({
			modelAvailable,
			originalModelKey,
			headMoved,
			pendingEditFiles: changeSetService.files.get().length,
		});

		await commandService.executeCommand('workbench.action.chat.open', {
			query: buildResumePrompt(picked.summary.title, digest, conditions),
		});
	}
});
