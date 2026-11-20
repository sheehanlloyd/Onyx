/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { toErrorMessage } from '../../../../../base/common/errorMessage.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { ITaskService } from '../../../tasks/common/taskService.js';
import { Task, TaskGroup } from '../../../tasks/common/tasks.js';
import { localize } from '../../../../../nls.js';
import { OnyxSettingId } from '../../common/onyxConfiguration.js';
import { ONYX_PROJECT_CONFIG_PATH } from '../../common/onyxProjectConfig.js';
import { IOnyxProjectConfigService } from '../config/onyxProjectConfigService.js';
import { IOnyxRunHandle } from '../controlPlane/onyxControlPlaneService.js';
import { IOnyxTerminalService } from '../terminal/onyxTerminalTool.js';

/**
 * The Phase-4 slice of verification: after an agent run that changed things,
 * run the project's own checks — the workspace's default build/test task or a
 * named task — and post the verdict to the run's timeline. This is stronger
 * evidence than the marker diff: it is the same command the user would run to
 * trust the change.
 */
export class OnyxTaskVerification {

	constructor(
		@ITaskService private readonly _taskService: ITaskService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IOnyxProjectConfigService private readonly _projectConfigService: IOnyxProjectConfigService,
		@IOnyxTerminalService private readonly _terminalService: IOnyxTerminalService,
		@ILogService private readonly _logService: ILogService,
	) { }

	/** Whether a check task is configured for the active workspace (user setting, else .onyx/config.json). */
	get enabled(): boolean {
		return !!this._configuredTask();
	}

	private _configuredTask(): string {
		// The user's setting outranks the repository's default.
		return this._configurationService.getValue<string>(OnyxSettingId.VerificationTask)
			|| this._projectConfigService.resolved.get().config.verificationTask
			|| '';
	}

	/**
	 * Runs the configured check and reports to the timeline. Callers should
	 * not await this in the response path — a build can take minutes; the
	 * verdict lands on the (already completed) run when the task finishes.
	 */
	async run(handle: IOnyxRunHandle): Promise<void> {
		const configured = this._configuredTask();
		if (!configured) {
			return;
		}
		const task = await this._findTask(configured);
		if (!task) {
			handle.activity({ kind: 'note', label: `Checks skipped: no task matching "${configured}"`, ok: undefined });
			return;
		}

		const label = task._label ?? configured;
		// A task runs whatever the workspace's task configuration says, and the
		// repository can name the task. Neither is the user's consent to this
		// run, so it asks like any other execution (B2): once, for this run.
		const approved = await this._terminalService.confirmExecution({
			subject: `Task: ${label}`,
			configuredBy: this._configurationService.getValue<string>(OnyxSettingId.VerificationTask)
				? localize('onyx.verification.configuredByUser', "your setting onyx.verification.task")
				: localize('onyx.verification.configuredByRepository', "{0} (repository-authored)", ONYX_PROJECT_CONFIG_PATH),
			runId: handle.runId,
		});
		if (!approved) {
			handle.activity({ kind: 'note', label: `Checks not run: ${label} was not approved`, ok: undefined });
			return;
		}
		handle.activity({ kind: 'note', label: `Running checks: ${label}` });
		const startedAt = Date.now();
		try {
			const summary = await this._taskService.run(task);
			const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
			const passed = summary?.exitCode === 0;
			handle.activity({
				kind: 'note',
				label: passed
					? `Checks passed: ${label} (${seconds}s)`
					: `Checks failed: ${label} exited with ${summary?.exitCode ?? 'no exit code'} (${seconds}s)`,
				ok: passed,
			});
		} catch (err) {
			this._logService.warn('[onyx] verification task failed to run', err);
			handle.activity({ kind: 'note', label: `Checks could not run: ${toErrorMessage(err)}`, ok: false });
		}
	}

	private async _findTask(configured: string): Promise<Task | undefined> {
		const tasks = await this._taskService.tasks();
		if (configured === 'build' || configured === 'test') {
			const groupId = configured === 'build' ? TaskGroup.Build._id : TaskGroup.Test._id;
			const inGroup = tasks.filter(task => {
				const group = task.configurationProperties.group;
				return typeof group === 'string' ? group === groupId : group?._id === groupId;
			});
			return inGroup.find(task => typeof task.configurationProperties.group === 'object' && task.configurationProperties.group?.isDefault) ?? inGroup[0];
		}
		return tasks.find(task => task._label === configured || task.configurationProperties.identifier === configured);
	}
}
