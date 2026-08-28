/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../../../base/common/buffer.js';
import { joinPath } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IDialogService, IFileDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { INotificationService, Severity } from '../../../../../platform/notification/common/notification.js';
import { IOnyxRuntimeService } from '../../../../../platform/onyxRuntime/common/onyxRuntime.js';
import { IWorkbenchEnvironmentService } from '../../../../services/environment/common/environmentService.js';
import { redactJournalContent } from '../../common/onyxDiagnostics.js';
import { createStoredZip, IOnyxZipEntry } from '../../common/onyxZip.js';
import { IOnyxOutcomeService } from '../outcomes/onyxOutcomeService.js';
import { IOnyxProfileService } from '../profiles/onyxProfileService.js';
import { IOnyxModelService } from '../model/onyxLanguageModelProvider.js';

/** Log files can be big; the bundle stays mailable. */
const MAX_LOG_FILE_BYTES = 1024 * 1024;
const MAX_TOTAL_LOG_BYTES = 5 * 1024 * 1024;

/**
 * `Onyx: Export Diagnostics` — one zip with everything needed to debug an
 * Onyx problem: run journals, capability profiles, the machine profile,
 * discovered runtimes, the Onyx settings, and recent logs. Nothing is
 * uploaded anywhere; the file lands where the user says. Prompt text is
 * redacted unless the user explicitly opts in, and the confirmation dialog
 * says exactly what goes into the archive before anything is written.
 */
export class OnyxDiagnosticsExport {

	constructor(
		@IOnyxOutcomeService private readonly _outcomeService: IOnyxOutcomeService,
		@IOnyxProfileService private readonly _profileService: IOnyxProfileService,
		@IOnyxModelService private readonly _modelService: IOnyxModelService,
		@IOnyxRuntimeService private readonly _runtimeService: IOnyxRuntimeService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IWorkbenchEnvironmentService private readonly _environmentService: IWorkbenchEnvironmentService,
		@IFileService private readonly _fileService: IFileService,
		@IDialogService private readonly _dialogService: IDialogService,
		@IFileDialogService private readonly _fileDialogService: IFileDialogService,
		@INotificationService private readonly _notificationService: INotificationService,
	) { }

	async run(): Promise<void> {
		const runs = await this._outcomeService.listRuns();
		const confirmation = await this._dialogService.confirm({
			message: localize('onyx.diagnostics.confirm', "Export Onyx diagnostics?"),
			detail: localize('onyx.diagnostics.detail',
				"The bundle contains: {0} run journals, per-model capability profiles, the machine profile, discovered runtimes, Onyx settings, and recent logs. Prompt text and file contents are redacted unless you opt in below. Nothing is uploaded — the zip is saved where you choose.",
				runs.length),
			primaryButton: localize('onyx.diagnostics.export', "Save Diagnostics…"),
			checkbox: {
				label: localize('onyx.diagnostics.includePrompts', "Include prompt text and file contents (unredacted)"),
				checked: false,
			},
		});
		if (!confirmation.confirmed) {
			return;
		}
		const includePrompts = !!confirmation.checkboxChecked;

		const target = await this._fileDialogService.showSaveDialog({
			title: localize('onyx.diagnostics.saveTitle', "Save Onyx Diagnostics"),
			defaultUri: joinPath(await this._fileDialogService.defaultFilePath(), `onyx-diagnostics-${new Date().toISOString().slice(0, 10)}.zip`),
			filters: [{ name: 'Zip', extensions: ['zip'] }],
		});
		if (!target) {
			return;
		}

		try {
			const zip = createStoredZip(await this._collect(includePrompts));
			await this._fileService.writeFile(target, VSBuffer.wrap(zip));
			this._notificationService.notify({
				severity: Severity.Info,
				message: localize('onyx.diagnostics.done', "Diagnostics saved to {0}. Nothing was uploaded.", target.fsPath),
			});
		} catch (error) {
			this._notificationService.notify({
				severity: Severity.Error,
				message: localize('onyx.diagnostics.failed', "Could not export diagnostics: {0}", error instanceof Error ? error.message : String(error)),
			});
		}
	}

	private async _collect(includePrompts: boolean): Promise<IOnyxZipEntry[]> {
		const encoder = new TextEncoder();
		const text = (path: string, content: string): IOnyxZipEntry => ({ path, data: encoder.encode(content) });
		const entries: IOnyxZipEntry[] = [];

		const runs = await this._outcomeService.listRuns();
		entries.push(text('journal/index.json', JSON.stringify(runs, undefined, '\t')));
		for (const summary of runs) {
			const record = await this._outcomeService.readRun(summary.runId);
			if (!record) {
				continue;
			}
			const jsonl = record.events.map(event => JSON.stringify(event)).join('\n');
			entries.push(text(`journal/runs/${summary.runId}.jsonl`, includePrompts ? jsonl : redactJournalContent(jsonl)));
		}

		entries.push(text('profiles.json', JSON.stringify(this._profileService.exportAll(), undefined, '\t')));
		entries.push(text('models.json', JSON.stringify(this._modelService.getKnownModels().map(model => ({ key: model.key, discovered: model.discovered, profile: model.profile })), undefined, '\t')));
		entries.push(text('machine.json', JSON.stringify(await this._runtimeService.getMachineProfile(), undefined, '\t')));
		try {
			entries.push(text('runtimes.json', JSON.stringify(await this._runtimeService.discoverRuntimes([]), undefined, '\t')));
		} catch {
			entries.push(text('runtimes.json', JSON.stringify({ error: 'discovery unavailable' })));
		}
		entries.push(text('settings.json', JSON.stringify(this._configurationService.getValue('onyx') ?? {}, undefined, '\t')));

		let logBudget = MAX_TOTAL_LOG_BYTES;
		for (const log of await this._recentLogFiles()) {
			if (logBudget <= 0) {
				break;
			}
			try {
				const content = await this._fileService.readFile(log);
				const clipped = content.value.buffer.slice(-Math.min(MAX_LOG_FILE_BYTES, logBudget));
				logBudget -= clipped.length;
				entries.push({ path: `logs/${log.path.split('/').slice(-2).join('/')}`, data: clipped });
			} catch {
				// an unreadable log is not worth failing the bundle
			}
		}

		return entries;
	}

	private async _recentLogFiles(): Promise<URI[]> {
		const logs: URI[] = [];
		try {
			const root = await this._fileService.resolve(this._environmentService.logsHome);
			const stack = [root];
			while (stack.length) {
				const current = stack.pop()!;
				for (const child of current.children ?? []) {
					if (child.isDirectory) {
						stack.push(child);
					} else if (child.name.endsWith('.log')) {
						logs.push(child.resource);
					}
				}
			}
		} catch {
			// no logs directory: nothing to include
		}
		return logs;
	}
}
