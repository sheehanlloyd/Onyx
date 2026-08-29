/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { Schemas } from '../../../../../base/common/network.js';
import { URI } from '../../../../../base/common/uri.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { localize } from '../../../../../nls.js';
import { INotificationService, Severity } from '../../../../../platform/notification/common/notification.js';
import { IProgressService, ProgressLocation } from '../../../../../platform/progress/common/progress.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IOnyxRuntimeService } from '../../../../../platform/onyxRuntime/common/onyxRuntime.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import {
	aggregateBenchResults, buildBenchPrompt, IOnyxBenchResult, IOnyxBenchTask, ONYX_BENCH_SYSTEM_PROMPT, scoreBenchAttempt, selectBenchmarkCommits
} from '../../common/onyxRepoBench.js';
import { ONYX_VENDOR } from '../../common/onyxTypes.js';
import { runOneShot } from '../agent/onyxOneShot.js';
import { IOnyxControlPlaneService } from '../controlPlane/onyxControlPlaneService.js';
import { IOnyxModelService } from '../model/onyxLanguageModelProvider.js';
import { IOnyxProfileService } from '../profiles/onyxProfileService.js';

const MAX_COMMITS_SCANNED = 200;
const DEFAULT_TASK_COUNT = 6;
const MAX_BEFORE_CHARS = 12_000;

/**
 * `Onyx: Benchmark on This Repo` — turns the repository's own history into a
 * benchmark: a real past commit is hidden, each model gets the file as it was
 * plus the commit message, and its attempt is scored against what the author
 * actually wrote. Scores land in the routing profiles, so "the router learns"
 * is measured on this code, not on someone else's benchmark. The results doc
 * shows every task, every score, and the evidence behind it.
 */
export class OnyxRepoBenchmark {

	constructor(
		@IOnyxRuntimeService private readonly _runtimeService: IOnyxRuntimeService,
		@IOnyxModelService private readonly _modelService: IOnyxModelService,
		@IOnyxProfileService private readonly _profileService: IOnyxProfileService,
		@IOnyxControlPlaneService private readonly _controlPlaneService: IOnyxControlPlaneService,
		@IWorkspaceContextService private readonly _workspaceService: IWorkspaceContextService,
		@IQuickInputService private readonly _quickInputService: IQuickInputService,
		@IProgressService private readonly _progressService: IProgressService,
		@INotificationService private readonly _notificationService: INotificationService,
		@IEditorService private readonly _editorService: IEditorService,
	) { }

	async run(): Promise<void> {
		const folder = this._workspaceService.getWorkspace().folders.find(f => f.uri.scheme === Schemas.file);
		if (!folder) {
			this._notificationService.notify({ severity: Severity.Info, message: localize('onyx.bench.noFolder', "Open a local git repository to benchmark on it.") });
			return;
		}
		const candidates = await this._runtimeService.gitCommitCandidates(folder.uri.fsPath, MAX_COMMITS_SCANNED);
		const tasks = selectBenchmarkCommits(candidates, DEFAULT_TASK_COUNT);
		if (tasks.length === 0) {
			this._notificationService.notify({ severity: Severity.Info, message: localize('onyx.bench.noTasks', "No suitable commits found — the benchmark needs small, single-file, non-merge commits in this repository's history.") });
			return;
		}

		const models = this._modelService.getKnownModels();
		if (models.length === 0) {
			this._notificationService.notify({ severity: Severity.Info, message: localize('onyx.bench.noModels', "No local model is available to benchmark.") });
			return;
		}
		const chosen = await this._quickInputService.pick(models.map(model => ({
			label: model.discovered.id,
			description: model.discovered.baseUrl,
			picked: true,
			model,
		})), { canPickMany: true, placeHolder: localize('onyx.bench.pickModels', "Which models should attempt this repository's {0} benchmark tasks?", tasks.length) });
		if (!chosen || chosen.length === 0) {
			return;
		}

		const handle = this._controlPlaneService.beginRun({
			sessionResource: URI.from({ scheme: 'onyx-bench', path: `/${generateUuid()}` }),
			requestId: generateUuid(),
			title: localize('onyx.bench.runTitle', "Repo benchmark: {0} tasks × {1} models", tasks.length, chosen.length),
			task: 'plan',
			modelKey: 'benchmark',
		});

		const results: IOnyxBenchResult[] = [];
		const cancellation = new CancellationTokenSource();
		try {
			await this._progressService.withProgress({
				location: ProgressLocation.Notification,
				title: localize('onyx.bench.progress', "Benchmarking on this repository"),
				cancellable: true,
			}, async progress => {
				let done = 0;
				const total = tasks.length * chosen.length;
				for (const task of tasks) {
					if (cancellation.token.isCancellationRequested) {
						break;
					}
					const materialized = await this._materialize(folder.uri.fsPath, task);
					if (!materialized) {
						handle.activity({ kind: 'note', label: localize('onyx.bench.skipped', "Skipped {0}", task.hash.slice(0, 8)), reason: localize('onyx.bench.skipReason', "file content unavailable or too large at that revision") });
						done += chosen.length;
						continue;
					}
					for (const pick of chosen) {
						if (cancellation.token.isCancellationRequested) {
							break;
						}
						progress.report({ message: `${pick.model.discovered.id} · ${task.subject.slice(0, 40)}`, increment: 100 / total });
						const startedAt = Date.now();
						let reply = '';
						try {
							reply = await runOneShot(this._modelService, ONYX_BENCH_SYSTEM_PROMPT, buildBenchPrompt(task, materialized.before), cancellation.token, {
								modelIdentifier: `${ONYX_VENDOR}:${pick.model.key}`,
							});
						} catch {
							// A failed request scores 0 below, like any unusable reply.
						}
						const score = scoreBenchAttempt(materialized.before, materialized.after, reply);
						const result: IOnyxBenchResult = { modelKey: pick.model.key, task, score, durationMs: Date.now() - startedAt };
						results.push(result);
						this._profileService.reportBenchScore(pick.model.key, task.kind, score.score);
						handle.activity({
							kind: 'note',
							label: localize('onyx.bench.scored', "{0} scored {1} on \"{2}\"", pick.model.discovered.id, score.score.toFixed(2), task.subject.slice(0, 60)),
							reason: score.reason,
							ok: score.score >= 0.5,
							location: { path: task.file, line: 1 },
						});
						done++;
					}
				}
			}, () => cancellation.cancel());
		} finally {
			handle.complete(cancellation.token.isCancellationRequested ? 'cancelled' : 'completed');
			cancellation.dispose();
		}

		if (results.length > 0) {
			await this._openResults(results);
		}
	}

	private async _materialize(repoPath: string, task: IOnyxBenchTask): Promise<{ before: string; after: string } | undefined> {
		const [before, after] = await Promise.all([
			this._runtimeService.gitShowFile(repoPath, `${task.hash}~1`, task.file),
			this._runtimeService.gitShowFile(repoPath, task.hash, task.file),
		]);
		if (before === undefined || after === undefined || before.length > MAX_BEFORE_CHARS) {
			return undefined;
		}
		return { before, after };
	}

	/** The evidence, not just the leaderboard: per-model per-kind means, then every task with its reason. */
	private async _openResults(results: readonly IOnyxBenchResult[]): Promise<void> {
		const aggregates = aggregateBenchResults(results);
		const lines: string[] = [
			localize('onyx.bench.docTitle', "# Onyx repo benchmark — this repository's own commits"),
			'',
			localize('onyx.bench.docIntro', "Each task is a real past commit: the model saw the file before the change and the commit message, and its attempt is scored against what the author actually wrote (F1 over changed lines). Scores feed the router's per-task-kind signal."),
			'',
			'| model | task kind | mean score | tasks |',
			'|---|---|---|---|',
			...aggregates.map(entry => `| ${entry.modelKey} | ${entry.kind} | ${entry.meanScore.toFixed(2)} | ${entry.taskCount} |`),
			'',
			`## ${localize('onyx.bench.evidence', "Evidence")}`,
		];
		for (const result of results) {
			lines.push(
				'',
				`### ${result.modelKey} · ${result.task.kind} · ${result.score.score.toFixed(2)}`,
				localize('onyx.bench.taskLine', "Commit {0} — \"{1}\" ({2})", result.task.hash.slice(0, 8), result.task.subject, result.task.file),
				`${result.score.reason} · ${(result.durationMs / 1000).toFixed(1)}s`,
			);
		}
		await this._editorService.openEditor({ resource: undefined, contents: lines.join('\n'), languageId: 'markdown', options: { pinned: true } });
	}
}
