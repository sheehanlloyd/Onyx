/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IOnyxCheckOutcome } from '../../common/onyxVerification.js';
import { toErrorMessage } from '../../../../../base/common/errorMessage.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { ITaskService } from '../../../tasks/common/taskService.js';
import { Task, TaskGroup } from '../../../tasks/common/tasks.js';
import { localize } from '../../../../../nls.js';
import { OnyxSettingId } from '../../common/onyxConfiguration.js';
import { ONYX_PROJECT_CONFIG_PATH } from '../../common/onyxProjectConfig.js';
import { IOnyxProjectConfigService } from '../config/onyxProjectConfigService.js';
import { IOnyxTerminalService } from '../terminal/onyxTerminalTool.js';

/**
 * The Phase-4 slice of verification: after an agent run that changed things,
 * run the project's own checks — the workspace's default build/test task or a
 * named task — after an acceptance, on the accepted files as saved (C2), and
 * post the verdict to the run's timeline. This is stronger
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
	 * Runs the configured check after an acceptance (C2) and says what it
	 * came to. It is a task that reads the disk, so the caller runs it only
	 * on accepted files that are saved, and names them: the outcome records
	 * what the check ran on. A build can take minutes; callers do not hold
	 * a response for it.
	 */
	async run(runId: string, note: (label: string, ok: boolean | undefined) => void, savedFiles: readonly { readonly path: string; readonly contentHash: string }[]): Promise<IOnyxCheckOutcome> {
		const configured = this._configuredTask();
		const task = configured ? await this._findTask(configured) : undefined;
		if (!task) {
			if (configured) {
				note(`Checks skipped: no task matching "${configured}"`, undefined);
			}
			return { kind: 'not run', reason: 'no task' };
		}

		const label = task._label ?? configured;
		// A task runs whatever the workspace's task configuration says, and the
		// repository can name the task. Neither is the user's consent to this
		// run, so it asks like any other execution (B2): once, for this run.
		const approved = await this._terminalService.confirmExecution({
			kind: 'task',
			subject: `Task: ${label}`,
			configuredBy: this._configuredBy(),
			runId,
		});
		if (!approved) {
			note(`Checks not run: ${label} was not approved`, undefined);
			return { kind: 'not run', reason: 'not approved' };
		}
		note(`Running checks: ${label} on the accepted, saved ${savedFiles.map(file => file.path).join(', ')}`, undefined);
		const startedAt = Date.now();
		try {
			const summary = await this._taskService.run(task);
			const seconds = Math.round((Date.now() - startedAt) / 100) / 10;
			const passed = summary?.exitCode === 0;
			note(passed
				? `Checks passed: ${label} (${seconds.toFixed(1)}s)`
				: `Checks failed: ${label} exited with ${summary?.exitCode ?? 'no exit code'} (${seconds.toFixed(1)}s)`, passed);
			return { kind: 'ran', task: label, passed, exitCode: summary?.exitCode ?? null, seconds, savedFiles };
		} catch (err) {
			this._logService.warn('[onyx] verification task failed to run', err);
			note(`Checks could not run: ${toErrorMessage(err)}`, false);
			return { kind: 'ran', task: label, passed: false, exitCode: null, seconds: Math.round((Date.now() - startedAt) / 100) / 10, savedFiles };
		}
	}

	/** Who named the task. A workspace settings file is repository content just as `.onyx/config.json` is. */
	private _configuredBy(): string {
		const inspected = this._configurationService.inspect<string>(OnyxSettingId.VerificationTask);
		if (inspected.workspaceFolderValue || inspected.workspaceValue) {
			return localize('onyx.verification.configuredByWorkspace', "the setting onyx.verification.task in this workspace's settings file (repository-authored)");
		}
		if (this._configurationService.getValue<string>(OnyxSettingId.VerificationTask)) {
			return localize('onyx.verification.configuredByUser', "your own setting onyx.verification.task");
		}
		return localize('onyx.verification.configuredByRepository', "{0} (repository-authored)", ONYX_PROJECT_CONFIG_PATH);
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
