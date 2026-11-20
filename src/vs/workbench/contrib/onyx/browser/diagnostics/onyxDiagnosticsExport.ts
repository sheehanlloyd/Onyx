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
import { describeBundle, IOnyxDiagnosticsOptions, OnyxDiagnosticsRedactor } from '../../common/onyxDiagnostics.js';
import { createStoredZip, IOnyxZipEntry } from '../../common/onyxZip.js';
import { IOnyxOutcomeService } from '../outcomes/onyxOutcomeService.js';
import { IOnyxProfileService } from '../profiles/onyxProfileService.js';
import { IOnyxEndpointSecretService } from '../model/onyxEndpointSecrets.js';
import { IOnyxModelService } from '../model/onyxLanguageModelProvider.js';

/** Log files can be big; the bundle stays mailable. */
const MAX_LOG_FILE_BYTES = 1024 * 1024;
const MAX_TOTAL_LOG_BYTES = 5 * 1024 * 1024;
const MAX_LOG_FILES = 200;

/**
 * `Onyx: Export Diagnostics` — one zip to debug an Onyx problem with: run
 * journals, capability profiles, the machine profile, discovered runtimes,
 * the Onyx settings, and recent logs. Nothing is uploaded anywhere; the file
 * lands where the user says.
 *
 * Every entry is built from an allowlist (`OnyxDiagnosticsRedactor`, B11):
 * by default the bundle holds structure, sizes, timings and names, and no
 * prompt text, tool parameter, tool result, command, output, path or log
 * message. The user can opt in to that content. Endpoint API keys and the
 * credentials of any URL are in neither kind of bundle. The dialog says
 * which is which before anything is written, and so does the bundle's own
 * README.
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
		@IOnyxEndpointSecretService private readonly _endpointSecretService: IOnyxEndpointSecretService,
	) { }

	async run(): Promise<void> {
		const runs = await this._outcomeService.listRuns();
		const confirmation = await this._dialogService.confirm({
			message: localize('onyx.diagnostics.confirm', "Export Onyx diagnostics?"),
			detail: localize('onyx.diagnostics.detail',
				"The bundle contains: {0} run journals, per-model capability profiles, the machine profile, discovered runtimes, Onyx settings, and recent logs. Unless you opt in below, it holds what happened and how long it took, and none of the content: prompt text, tool parameters and results, command text and output, file paths, run titles and log messages are replaced by their lengths. Endpoint API keys and the credentials in URLs are never included. Nothing is uploaded: the zip is saved where you choose.",
				runs.length),
			primaryButton: localize('onyx.diagnostics.export', "Save Diagnostics…"),
			checkbox: {
				label: localize('onyx.diagnostics.includePrompts', "Include prompt text, file contents, command text and output, paths and log messages"),
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
			const zip = createStoredZip(await this.collect(includePrompts));
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

	/** Everything the bundle would contain, as zip entries. Writes nothing. */
	async collect(includeContent: boolean): Promise<IOnyxZipEntry[]> {
		const encoder = new TextEncoder();
		const decoder = new TextDecoder();
		const redactor = this._createRedactor({ includeContent, secrets: [...(await this._endpointSecretService.configuredApiKeys()).values()] });
		// The last thing that happens to every entry: API key values and URL credentials are removed from
		// its text, whatever built it.
		const text = (path: string, content: string): IOnyxZipEntry => ({ path, data: encoder.encode(redactor.scrub(content)) });
		const json = (path: string, value: unknown): IOnyxZipEntry => text(path, JSON.stringify(value, undefined, '\t') ?? 'null');
		const entries: IOnyxZipEntry[] = [];

		const runs = await this._outcomeService.listRuns();
		entries.push(json('journal/index.json', runs.map(run => redactor.runSummary(run)).filter(run => run !== undefined)));
		let journalLinesOmitted = 0;
		for (const summary of runs) {
			if (!/^[\w-]+$/.test(summary.runId)) {
				continue;
			}
			const record = await this._outcomeService.readRun(summary.runId);
			if (!record) {
				continue;
			}
			const journal = redactor.journal(record.events);
			journalLinesOmitted += journal.omitted;
			entries.push(text(`journal/runs/${summary.runId}.jsonl`, journal.text));
		}

		entries.push(json('profiles.json', redactor.record(this._profileService.exportAll())));
		entries.push(json('models.json', this._modelService.getKnownModels().map(model => redactor.record({ key: model.key, discovered: model.discovered, profile: model.profile }))));
		entries.push(json('machine.json', redactor.record(await this._runtimeService.getMachineProfile())));
		try {
			entries.push(json('runtimes.json', redactor.record(await this._runtimeService.discoverRuntimes([]))));
		} catch {
			entries.push(json('runtimes.json', { error: 'discovery unavailable' }));
		}
		entries.push(json('settings.json', redactor.settings(this._configurationService.getValue('onyx'))));

		let logBudget = MAX_TOTAL_LOG_BYTES;
		for (const log of await this._recentLogFiles()) {
			if (logBudget <= 0) {
				break;
			}
			try {
				const content = await this._fileService.readFile(log);
				const clipped = content.value.buffer.slice(-Math.min(MAX_LOG_FILE_BYTES, logBudget));
				logBudget -= clipped.length;
				entries.push(text(`logs/${log.path.split('/').slice(-2).join('/')}`, redactor.log(decoder.decode(clipped))));
			} catch {
				// an unreadable log is not worth failing the bundle
			}
		}

		return [text('README.txt', describeBundle({ includeContent, journalLinesOmitted })), ...entries];
	}

	/** What decides, field by field, what may leave. */
	protected _createRedactor(options: IOnyxDiagnosticsOptions): OnyxDiagnosticsRedactor {
		return new OnyxDiagnosticsRedactor(options);
	}

	private async _recentLogFiles(): Promise<URI[]> {
		const logs: URI[] = [];
		// A resolve lists one level; each window's logs are a folder down, so folders are resolved in turn.
		const folders = [this._environmentService.logsHome];
		while (folders.length && logs.length < MAX_LOG_FILES) {
			const folder = folders.pop()!;
			try {
				for (const child of (await this._fileService.resolve(folder)).children ?? []) {
					if (child.isDirectory) {
						folders.push(child.resource);
					} else if (child.name.endsWith('.log')) {
						logs.push(child.resource);
					}
				}
			} catch {
				// no such folder, or not readable: nothing to include from it
			}
		}
		return logs;
	}
}
