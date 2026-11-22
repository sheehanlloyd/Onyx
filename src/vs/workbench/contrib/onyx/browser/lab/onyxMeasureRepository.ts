/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken, CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { Schemas } from '../../../../../base/common/network.js';
import { joinPath } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { localize } from '../../../../../nls.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { INotificationService, Severity } from '../../../../../platform/notification/common/notification.js';
import { IOnyxRuntimeService } from '../../../../../platform/onyxRuntime/common/onyxRuntime.js';
import { IProgressService, ProgressLocation } from '../../../../../platform/progress/common/progress.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { IWorkspaceContextService, IWorkspaceFolder } from '../../../../../platform/workspace/common/workspace.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { OnyxSettingId } from '../../common/onyxConfiguration.js';
import { describeDatasheet } from '../../common/onyxDatasheet.js';
import { describeLabEstimate, estimateLabDuration, IOnyxLabResult, IOnyxLabTask, IOnyxLabUnitRecord, ONYX_LAB_SHAPE, planLabCampaign, scoreLabRecord } from '../../common/onyxLab.js';
import { contentHoldsLines, countTasks, deriveRequestTasks, IOnyxRequestTask, IOnyxTaskSetEntry, journaledRequest, latestPublication, maxTaskFileChars, ONYX_MIN_TASKS_TO_RANK, taskInstruction } from '../../common/onyxLabTasks.js';
import { modelPublishedAt } from '../../common/onyxModelCatalog.js';
import { buildBenchPrompt, ONYX_BENCH_METRIC, ONYX_BENCH_SYSTEM_PROMPT, selectBenchmarkCommits } from '../../common/onyxRepoBench.js';
import { IOnyxScorecard, IOnyxScorecardModel, ONYX_SCORECARD_SCHEMA, rankModels, renderScorecardMarkdown, renderScorecardSvg, routerHitRate, switchAdvice } from '../../common/onyxScorecard.js';
import { ONYX_VENDOR } from '../../common/onyxTypes.js';
import { runOneShot } from '../agent/onyxOneShot.js';
import { IOnyxControlPlaneService } from '../controlPlane/onyxControlPlaneService.js';
import { IOnyxKnownModel, IOnyxModelService } from '../model/onyxLanguageModelProvider.js';
import { IOnyxDatasheetService } from '../models/onyxDatasheetService.js';
import { IOnyxOutcomeService } from '../outcomes/onyxOutcomeService.js';
import { IOnyxRouterLogService } from '../routing/onyxRouterLog.js';

const MAX_COMMITS_SCANNED = 500;
const DEFAULT_TASK_COUNT = 24;
/** How many of the workspace's journaled runs are looked at for tasks from requests. */
const MAX_REQUESTS_READ = 200;

/** What a caller that is not a person at the keyboard decides in advance (the lab's campaign engine, a test). */
export interface IOnyxMeasureOptions {
	/** Model ids to measure, as the runtime names them. Without it the user picks. */
	readonly modelIds?: readonly string[];
	/** Start without the confirmation that shows the estimate. Starting the caller was the user's decision. */
	readonly confirmed?: boolean;
	/** Write the scorecard into the workspace's `.onyx/scorecards/` without asking. */
	readonly save?: boolean;
	readonly taskCount?: number;
}

interface IMeasureTask extends IOnyxLabTask {
	readonly entry: IOnyxTaskSetEntry;
	readonly instruction: string;
	readonly before: string;
	readonly after: string;
}

/**
 * `Onyx: Measure Models for This Repository` and `Onyx: Should I Switch
 * Models?` (L11). Both give each model the repository's own tasks (L10),
 * one request a task, one model resident at a time (L9), and say what came
 * of it with the evidence: a scorecard that carries its provenance and each
 * model's datasheet. The first builds its tasks from history, held out in
 * time, and from the user's own accepted requests where the workspace opted
 * in; the second uses only those requests, against one model, and reports
 * how often the model reproduces what the user accepted.
 *
 * Nothing leaves the machine. A scorecard becomes a file only when the user
 * says so.
 */
export class OnyxMeasureRepository {

	constructor(
		@IOnyxRuntimeService private readonly _runtimeService: IOnyxRuntimeService,
		@IOnyxModelService private readonly _modelService: IOnyxModelService,
		@IOnyxDatasheetService private readonly _datasheetService: IOnyxDatasheetService,
		@IOnyxControlPlaneService private readonly _controlPlaneService: IOnyxControlPlaneService,
		@IOnyxOutcomeService private readonly _outcomeService: IOnyxOutcomeService,
		@IOnyxRouterLogService private readonly _routerLog: IOnyxRouterLogService,
		@IWorkspaceContextService private readonly _workspaceService: IWorkspaceContextService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IQuickInputService private readonly _quickInputService: IQuickInputService,
		@IDialogService private readonly _dialogService: IDialogService,
		@IProgressService private readonly _progressService: IProgressService,
		@INotificationService private readonly _notificationService: INotificationService,
		@IEditorService private readonly _editorService: IEditorService,
		@IFileService private readonly _fileService: IFileService,
	) { }

	/** Measures the chosen models on this repository's tasks and opens the scorecard. Resolves with it, or undefined when nothing ran. */
	async run(options: IOnyxMeasureOptions = {}): Promise<IOnyxScorecard | undefined> {
		const folder = this._folder();
		if (!folder) {
			return undefined;
		}
		const models = await this._pickModels(options.modelIds, true);
		if (!models) {
			return undefined;
		}
		// Temporal holdout (L10): the latest publication day among the models decides, and one undated model makes it unknown.
		const publishedAt = latestPublication(models.map(model => modelPublishedAt(model.discovered.id)));
		const fileCap = Math.min(...models.map(model => maxTaskFileChars(model.profile.contextLength)));
		const history = await this._historyTasks(folder, publishedAt, fileCap, options.taskCount ?? DEFAULT_TASK_COUNT);
		const requests = await this._requestTasks(folder, fileCap);
		const tasks = [...history, ...requests.tasks];
		if (tasks.length === 0) {
			this._notificationService.notify({
				severity: Severity.Info, message: publishedAt
					? localize('onyx.measure.noHeldOutTasks', "No tasks to measure on: no small single-file commit in this repository was authored after {0}, when the latest of these models was published, and fits their context.", publishedAt)
					: localize('onyx.measure.noTasks', "No tasks to measure on: the measurement needs small, single-file, non-merge commits in this repository's history that fit the models' context."),
			});
			return undefined;
		}
		return this._measure(folder, models, tasks, publishedAt, fileCap, options, true);
	}

	/** Replays the user's own accepted requests against one model and reports how often it reproduces what was accepted. */
	async shouldISwitch(options: IOnyxMeasureOptions = {}): Promise<IOnyxScorecard | undefined> {
		const folder = this._folder();
		if (!folder) {
			return undefined;
		}
		if (this._configurationService.getValue<boolean>(OnyxSettingId.LabRequestTasks, { resource: folder.uri }) !== true) {
			this._notificationService.notify({ severity: Severity.Info, message: localize('onyx.switch.optIn', "This uses your own requests in this workspace as the test. Turn on the setting {0} for this workspace first; nothing is read without it.", OnyxSettingId.LabRequestTasks) });
			return undefined;
		}
		const models = await this._pickModels(options.modelIds, false);
		if (!models) {
			return undefined;
		}
		const fileCap = Math.min(...models.map(model => maxTaskFileChars(model.profile.contextLength)));
		const requests = await this._requestTasks(folder, fileCap);
		if (requests.tasks.length === 0) {
			this._notificationService.notify({ severity: Severity.Info, message: localize('onyx.switch.noRequests', "None of your requests in this workspace can be replayed yet. A request counts when you accepted its proposal and the lines you accepted were later committed: {0} requests were looked at, {1} had nothing accepted, {2} were never committed, and {3} started from a commit that is no longer there.", requests.requests, requests.skipped['nothing-accepted'], requests.skipped['never-committed'], requests.skipped['base-unreachable']) });
			return undefined;
		}
		return this._measure(folder, models, requests.tasks, undefined, fileCap, options, false);
	}

	private _folder(): IWorkspaceFolder | undefined {
		const folder = this._workspaceService.getWorkspace().folders.find(candidate => candidate.uri.scheme === Schemas.file);
		if (!folder) {
			this._notificationService.notify({ severity: Severity.Info, message: localize('onyx.measure.noFolder', "Open a local git repository to measure models on it.") });
		}
		return folder;
	}

	private async _pickModels(modelIds: readonly string[] | undefined, many: boolean): Promise<readonly IOnyxKnownModel[] | undefined> {
		const known = this._modelService.getKnownModels();
		if (known.length === 0) {
			this._notificationService.notify({ severity: Severity.Info, message: localize('onyx.measure.noModels', "No local model is available to measure.") });
			return undefined;
		}
		if (modelIds) {
			const chosen = known.filter(model => modelIds.includes(model.discovered.id));
			return chosen.length ? chosen : undefined;
		}
		const items = known.map(model => ({ label: model.discovered.id, description: model.discovered.baseUrl, picked: many, model }));
		if (many) {
			const picked = await this._quickInputService.pick(items, { canPickMany: true, placeHolder: localize('onyx.measure.pickModels', "Which models should be measured on this repository?") });
			return picked && picked.length ? picked.map(item => item.model) : undefined;
		}
		const picked = await this._quickInputService.pick(items, { placeHolder: localize('onyx.switch.pickModel', "Which model should your own accepted requests be replayed against?") });
		return picked ? [picked.model] : undefined;
	}

	private async _historyTasks(folder: IWorkspaceFolder, publishedAt: string | undefined, fileCap: number, count: number): Promise<IMeasureTask[]> {
		const candidates = await this._runtimeService.gitCommitCandidates(folder.uri.fsPath, MAX_COMMITS_SCANNED);
		// More than are wanted are selected, because a task whose file does not fit is not one.
		const selected = selectBenchmarkCommits(candidates, count * 3, { publishedAt });
		const tasks: IMeasureTask[] = [];
		for (const task of selected) {
			if (tasks.length >= count) {
				break;
			}
			const [before, after, message] = await Promise.all([
				this._runtimeService.gitShowFile(folder.uri.fsPath, `${task.hash}~1`, task.file),
				this._runtimeService.gitShowFile(folder.uri.fsPath, task.hash, task.file),
				this._runtimeService.gitCommitMessage(folder.uri.fsPath, task.hash),
			]);
			if (before === undefined || after === undefined || before.length > fileCap) {
				continue;
			}
			const id = task.hash.slice(0, 12);
			tasks.push({ id, commit: task.hash, file: task.file, before, after, instruction: taskInstruction(message ?? task.subject), entry: { id, commit: task.hash, file: task.file, source: 'history', holdout: task.holdout ?? 'unknown', authoredAt: task.authoredAt, beforeChars: before.length } });
		}
		return tasks;
	}

	/** Tasks made of the user's own requests (L10, source 2): only with the workspace's opt-in, and only accepted and committed ones. */
	private async _requestTasks(folder: IWorkspaceFolder, fileCap: number): Promise<{ readonly tasks: IMeasureTask[]; readonly requests: number; readonly skipped: Readonly<Record<string, number>> }> {
		const optedIn = this._configurationService.getValue<boolean>(OnyxSettingId.LabRequestTasks, { resource: folder.uri }) === true;
		if (!optedIn) {
			// Without the opt-in the journal is not read.
			const nothing = deriveRequestTasks(false, [], { isReachable: () => false, firstCommitContaining: () => undefined });
			return { tasks: [], requests: nothing.requests, skipped: nothing.skipped };
		}
		const repo = folder.uri.fsPath;
		const summaries = (await this._outcomeService.listRuns()).slice(0, MAX_REQUESTS_READ);
		const journaled = [];
		for (const summary of summaries) {
			const record = await this._outcomeService.readRun(summary.runId);
			if (record) {
				journaled.push(journaledRequest(summary.runId, record.events));
			}
		}
		// The repository is asked first, for every accepted file, so that the pure rule can then be applied without waiting.
		const reachable = new Map<string, boolean>();
		const found = new Map<string, { readonly commit: string; readonly authoredAt: string } | undefined>();
		for (const request of journaled) {
			if (!request.head) {
				continue;
			}
			for (const accepted of request.accepted) {
				const key = `${request.head}\u0000${accepted.path}\u0000${accepted.addedLineDigests.join(',')}`;
				if (found.has(key)) {
					continue;
				}
				const relative = this._relative(folder, accepted.path);
				const commits = await this._runtimeService.gitCommitsTouching(repo, relative, request.head, 200);
				reachable.set(request.head, commits !== undefined);
				let first: { readonly commit: string; readonly authoredAt: string } | undefined;
				for (const commit of commits ?? []) {
					const content = await this._runtimeService.gitShowFile(repo, commit.hash, relative);
					if (content !== undefined && contentHoldsLines(content, accepted.addedLineDigests)) {
						first = { commit: commit.hash, authoredAt: commit.authoredAt };
						break;
					}
				}
				found.set(key, first);
			}
		}
		const summary = deriveRequestTasks(true, journaled, {
			isReachable: commit => reachable.get(commit) === true,
			firstCommitContaining: (path, digests, since) => found.get(`${since}\u0000${path}\u0000${digests.join(',')}`),
		});
		const tasks: IMeasureTask[] = [];
		for (const task of summary.tasks) {
			const materialized = await this._materializeRequest(folder, task, fileCap);
			if (materialized) {
				tasks.push(materialized);
			}
		}
		return { tasks, requests: summary.requests, skipped: summary.skipped };
	}

	private async _materializeRequest(folder: IWorkspaceFolder, task: IOnyxRequestTask, fileCap: number): Promise<IMeasureTask | undefined> {
		const relative = this._relative(folder, task.file);
		const [before, after] = await Promise.all([
			this._runtimeService.gitShowFile(folder.uri.fsPath, task.base, relative),
			this._runtimeService.gitShowFile(folder.uri.fsPath, task.commit, relative),
		]);
		if (before === undefined || after === undefined || before.length > fileCap) {
			return undefined;
		}
		return { id: task.id, commit: task.commit, file: relative, before, after, instruction: task.instruction, entry: { id: task.id, commit: task.commit, file: relative, source: 'request', holdout: 'unknown', authoredAt: task.authoredAt, beforeChars: before.length } };
	}

	/** A change-set path is workspace-qualified (`folder/path`) where there are several folders; git wants the path inside the folder. */
	private _relative(folder: IWorkspaceFolder, path: string): string {
		return path.startsWith(`${folder.name}/`) && this._workspaceService.getWorkspace().folders.length > 1 ? path.slice(folder.name.length + 1) : path;
	}

	private async _measure(folder: IWorkspaceFolder, models: readonly IOnyxKnownModel[], tasks: readonly IMeasureTask[], publishedAt: string | undefined, fileCap: number, options: IOnyxMeasureOptions, ranking: boolean): Promise<IOnyxScorecard | undefined> {
		// A model is named by its id, and by its endpoint as well when two endpoints serve a model of the same
		// name: they are two models to measure, and their rows must not run together.
		const nameOf = (model: IOnyxKnownModel) => models.filter(other => other.discovered.id === model.discovered.id).length > 1 ? model.key : model.discovered.id;
		const byName = new Map(models.map(model => [nameOf(model), model]));
		const plan = planLabCampaign({ tier: 'S', models: models.map(nameOf), configurations: ['single-turn'], tasks, seeds: [1], repetitions: 1 });
		const speeds = Object.fromEntries(models.map(model => {
			const speed = this._datasheetService.current(model.key, model.discovered)?.speed.tokensPerSecond;
			return [nameOf(model), speed ? { tokensPerSecond: speed } : undefined];
		}));
		const estimate = estimateLabDuration(plan, speeds, ONYX_LAB_SHAPE.S);
		if (!options.confirmed) {
			// The estimate is shown before anything starts (L9), with what will be done.
			const confirmation = await this._dialogService.confirm({
				message: localize('onyx.measure.confirm', "Measure {0} model(s) on {1} task(s) of this repository?", models.length, tasks.length),
				detail: localize('onyx.measure.confirmDetail', "{0}. One model is loaded at a time, and nothing leaves this machine. You can stop it from the progress notification or with Stop in the Onyx run list.", describeLabEstimate(estimate)),
				primaryButton: localize('onyx.measure.start', "Measure"),
			});
			if (!confirmation.confirmed) {
				return undefined;
			}
		}

		// The run is begun with this token, so Stop in the control plane and a cancel here are one cancellation (B10).
		const cancellation = new CancellationTokenSource();
		const handle = this._controlPlaneService.beginRun({
			sessionResource: URI.from({ scheme: 'onyx-measure', path: `/${generateUuid()}` }),
			requestId: generateUuid(),
			title: localize('onyx.measure.runTitle', "Measure models: {0} tasks × {1} models", tasks.length, models.length),
			task: 'plan',
			modelKey: 'measurement',
			token: cancellation.token,
		});
		const token = handle.token;
		const taskById = new Map(tasks.map(task => [task.id, task]));
		const attempts: IOnyxLabResult[] = [];
		const startedAt = Date.now();
		try {
			await this._progressService.withProgress({ location: ProgressLocation.Notification, title: localize('onyx.measure.progress', "Measuring models on this repository"), cancellable: true }, async progress => {
				let resident: string | undefined;
				for (const unit of plan) {
					if (token.isCancellationRequested) {
						break;
					}
					const model = byName.get(unit.model)!;
					const task = taskById.get(unit.task.id)!;
					if (resident !== unit.model) {
						// One model resident at a time (L9): whatever the runtime holds is dropped before this model's first task.
						await this._runtimeService.evictLoadedModels(model.discovered.baseUrl).catch(() => undefined);
						resident = unit.model;
					}
					progress.report({ message: `${unit.model} · ${task.file}`, increment: 100 / plan.length });
					const record = await this._attempt(unit.id, unit.model, model, task, token);
					if (record.outcome === 'cancelled') {
						break; // the unit in flight is not part of the result
					}
					const result = scoreLabRecord(record, task.before, task.after);
					attempts.push(result);
					handle.activity({ kind: 'note', label: result.outcome === 'attempted' ? localize('onyx.measure.scored', "{0} scored {1} on {2}", unit.model, (result.score ?? 0).toFixed(2), task.file) : localize('onyx.measure.notServed', "{0} could not be served {1}", unit.model, task.file), reason: result.reason, ok: result.success === true });
				}
			}, () => cancellation.cancel());
		} finally {
			handle.complete(token.isCancellationRequested ? 'cancelled' : 'completed');
			cancellation.dispose();
			// Nothing is left loaded on the runtime by a measurement.
			for (const baseUrl of new Set(models.map(model => model.discovered.baseUrl))) {
				await this._runtimeService.evictLoadedModels(baseUrl).catch(() => undefined);
			}
		}
		if (attempts.length === 0) {
			return undefined;
		}

		const [machine, head] = await Promise.all([this._runtimeService.getMachineProfile(), this._runtimeService.gitCommitCandidates(folder.uri.fsPath, 1).then(commits => commits[0]?.hash ?? null, () => null)]);
		const ran = new Set(attempts.map(attempt => `${attempt.model}\u0000${attempt.task}`));
		const scorecard: IOnyxScorecard = {
			schema: ONYX_SCORECARD_SCHEMA,
			generatedAt: new Date().toISOString(),
			partial: attempts.length < plan.length,
			plannedUnits: plan.length,
			repository: { commit: head, name: folder.name },
			machine: { platform: machine.platform, arch: machine.arch, cpu: machine.cpuModel, memoryGiB: Math.round(machine.totalMemoryBytes / 1024 ** 3) },
			parameters: { temperature: 0, seed: 1, metric: ONYX_BENCH_METRIC, tier: 'S', maxTaskFileChars: fileCap },
			models: models.map(model => this._describeModel(nameOf(model), model)),
			tasks: countTasks(tasks.map(task => task.entry)),
			heldOutAfter: publishedAt ?? null,
			attempts,
			skips: plan.filter(unit => !ran.has(`${unit.model}\u0000${unit.task.id}`)).map(unit => ({ model: unit.model, task: unit.task.id, reason: 'the measurement was stopped before this ran' })),
			estimateSeconds: estimate.seconds,
			tookSeconds: (Date.now() - startedAt) / 1000,
			routing: ranking ? routerHitRate(this._routerLog.entries()) : null,
		};
		await this._present(folder, scorecard, options, ranking);
		return scorecard;
	}

	private async _attempt(unitId: string, name: string, model: IOnyxKnownModel, task: IMeasureTask, token: CancellationToken): Promise<IOnyxLabUnitRecord> {
		const startedAt = Date.now();
		const base = { unit: unitId, model: name, configuration: 'single-turn', task: task.id, seed: 1, repetition: 1, tier: 'S' as const, edits: [], events: [], requests: [], harnessHash: null, deniedCommands: 0 };
		try {
			const reply = await runOneShot(this._modelService, ONYX_BENCH_SYSTEM_PROMPT, buildBenchPrompt({ hash: task.commit, subject: task.instruction, file: task.file, kind: 'quick-edit' }, task.before), token, { modelIdentifier: `${ONYX_VENDOR}:${model.key}`, sampling: { temperature: 0, seed: 1 } });
			return { ...base, outcome: token.isCancellationRequested ? 'cancelled' : 'attempted', reply, durationMs: Date.now() - startedAt };
		} catch (error) {
			// The runtime gave no answer. That is not a score of zero, and is counted apart (L9).
			return { ...base, outcome: token.isCancellationRequested ? 'cancelled' : 'could-not-serve', reply: null, durationMs: Date.now() - startedAt, error: error instanceof Error ? error.message : String(error) };
		}
	}

	private _describeModel(name: string, model: IOnyxKnownModel): IOnyxScorecardModel {
		const datasheet = this._datasheetService.current(model.key, model.discovered);
		return {
			id: name,
			digest: model.discovered.digest ?? null,
			runtime: model.discovered.runtime,
			runtimeVersion: model.discovered.runtimeVersion ?? null,
			contextTokens: model.profile.contextLength ?? null,
			contextSource: model.profile.context?.source ?? null,
			publishedAt: modelPublishedAt(model.discovered.id) ?? null,
			datasheet: datasheet ? describeDatasheet(datasheet) : [],
			datasheetMeasuredAt: datasheet?.measuredAt ?? null,
		};
	}

	/** Opens the scorecard, and writes it into the workspace when the user says so. */
	private async _present(folder: IWorkspaceFolder, scorecard: IOnyxScorecard, options: IOnyxMeasureOptions, ranking: boolean): Promise<void> {
		let markdown = renderScorecardMarkdown(scorecard);
		if (!ranking) {
			const model = scorecard.models[0]?.id ?? '';
			const advice = switchAdvice(model, scorecard.attempts);
			markdown = [
				`# Should I switch to ${model}?`,
				'',
				advice.enough
					? `${model} reproduced what you accepted, exactly, in ${advice.reproduced} of ${advice.attempted} of your own requests in this workspace (mean score ${(advice.meanScore ?? 0).toFixed(2)}).`
					: `Not enough of your requests to say: ${advice.attempted} could be replayed and a verdict needs at least ${ONYX_MIN_TASKS_TO_RANK}. ${model} reproduced ${advice.reproduced} of them exactly.`,
				'',
				'A request is replayed when you accepted its proposal and the lines you accepted were later committed. The model sees the file as it was and your request, and is compared with the file at that commit. This says how often the model writes what you kept; it does not say the other answers were wrong.',
				'',
				markdown,
			].join('\n');
		}
		await this._editorService.openEditor({ resource: undefined, contents: markdown, languageId: 'markdown', options: { pinned: true } });
		let save = options.save;
		if (save === undefined) {
			const choice = await this._quickInputService.pick([
				{ label: localize('onyx.measure.save', "Save the scorecard to .onyx/scorecards/ in this workspace"), save: true },
				{ label: localize('onyx.measure.dontSave', "Do not save it"), save: false },
			], { placeHolder: localize('onyx.measure.savePlaceholder', "The scorecard is open. Save it as Markdown, SVG and JSON?") });
			save = choice?.save === true;
		}
		if (!save) {
			return;
		}
		const stamp = scorecard.generatedAt.replace(/[:.]/g, '-');
		const directory = joinPath(folder.uri, '.onyx', 'scorecards', stamp);
		await this._fileService.writeFile(joinPath(directory, 'scorecard.md'), VSBuffer.fromString(markdown));
		await this._fileService.writeFile(joinPath(directory, 'scorecard.svg'), VSBuffer.fromString(renderScorecardSvg(scorecard)));
		await this._fileService.writeFile(joinPath(directory, 'scorecard.json'), VSBuffer.fromString(JSON.stringify({ ...scorecard, ranking: rankModels(scorecard.attempts, scorecard.partial) }, undefined, '\t')));
		this._notificationService.notify({ severity: Severity.Info, message: localize('onyx.measure.saved', "The scorecard was saved to {0}. Nothing was uploaded.", `.onyx/scorecards/${stamp}`) });
	}
}
