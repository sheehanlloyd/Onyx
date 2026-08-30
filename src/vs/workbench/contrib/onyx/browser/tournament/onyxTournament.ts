/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { URI } from '../../../../../base/common/uri.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { localize } from '../../../../../nls.js';
import { INotificationService, Severity } from '../../../../../platform/notification/common/notification.js';
import { IOnyxRuntimeService } from '../../../../../platform/onyxRuntime/common/onyxRuntime.js';
import { IProgressService, ProgressLocation } from '../../../../../platform/progress/common/progress.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { ICodeEditorService } from '../../../../../editor/browser/services/codeEditorService.js';
import { Range } from '../../../../../editor/common/core/range.js';
import { applyEditBlocks, buildInlineEditPrompt, ONYX_INLINE_EDIT_SYSTEM_PROMPT, parseInlineEdits } from '../../common/onyxInlineEdit.js';
import { buildComparisonDocument, decideTournamentConcurrency, IOnyxTournamentCandidate } from '../../common/onyxTournament.js';
import { ONYX_VENDOR } from '../../common/onyxTypes.js';
import { runOneShot } from '../agent/onyxOneShot.js';
import { IOnyxControlPlaneService } from '../controlPlane/onyxControlPlaneService.js';
import { IOnyxKnownModel, IOnyxModelService } from '../model/onyxLanguageModelProvider.js';
import { IOnyxProfileService } from '../profiles/onyxProfileService.js';

/**
 * Tournament mode: one instruction, several local models, each candidate edit
 * applied in its own detached git worktree so nothing collides and nothing
 * touches the real tree until the user picks. The pick applies the winner's
 * diff with `git apply`, discards every worktree — and counts as an
 * accept/reject verdict per model, so tournaments teach the router which of
 * this machine's models actually wins on real work.
 */
export class OnyxTournament {

	constructor(
		@IOnyxModelService private readonly _modelService: IOnyxModelService,
		@IOnyxProfileService private readonly _profileService: IOnyxProfileService,
		@IOnyxControlPlaneService private readonly _controlPlaneService: IOnyxControlPlaneService,
		@IOnyxRuntimeService private readonly _runtimeService: IOnyxRuntimeService,
		@IWorkspaceContextService private readonly _workspaceService: IWorkspaceContextService,
		@ICodeEditorService private readonly _codeEditorService: ICodeEditorService,
		@IEditorService private readonly _editorService: IEditorService,
		@IQuickInputService private readonly _quickInputService: IQuickInputService,
		@IProgressService private readonly _progressService: IProgressService,
		@INotificationService private readonly _notificationService: INotificationService,
	) { }

	async run(): Promise<void> {
		const editor = this._codeEditorService.getFocusedCodeEditor() ?? this._codeEditorService.getActiveCodeEditor();
		const model = editor?.getModel();
		const selection = editor?.getSelection();
		if (!editor || !model || !selection || selection.isEmpty()) {
			this._notificationService.notify({ severity: Severity.Info, message: localize('onyx.tournament.noSelection', "Select the code to edit, then run the tournament.") });
			return;
		}
		const folder = this._workspaceService.getWorkspaceFolder(model.uri);
		if (!folder) {
			this._notificationService.notify({ severity: Severity.Info, message: localize('onyx.tournament.noFolder', "Tournaments need a file inside a git workspace folder.") });
			return;
		}
		const relativePath = model.uri.path.slice(folder.uri.path.length + 1);

		const models = this._modelService.getKnownModels();
		if (models.length < 2) {
			this._notificationService.notify({ severity: Severity.Info, message: localize('onyx.tournament.needTwo', "Tournaments need at least two local models. Pull another one with Onyx: Manage Models.") });
			return;
		}

		const picked = await this._quickInputService.pick(
			models.map(known => ({ label: known.key, description: known.profile.parameterB ? `${known.profile.parameterB}B` : undefined, picked: true, known })),
			{
				canPickMany: true,
				placeHolder: localize('onyx.tournament.pickModels', "Which models should compete?"),
			});
		if (!picked || picked.length < 2) {
			return;
		}
		const instruction = await this._quickInputService.input({
			prompt: localize('onyx.tournament.instruction', "One instruction; every model edits the same selection"),
			placeHolder: localize('onyx.tournament.instructionPlaceholder', "e.g. Handle the empty-array case and add a doc comment"),
		});
		if (!instruction) {
			return;
		}

		const machine = await this._runtimeService.getMachineProfile();
		const memoryGb = machine.totalMemoryBytes / (1024 ** 3);
		const concurrency = decideTournamentConcurrency(memoryGb, picked.map(item => (item.known.profile.parameterB ?? 8) * 0.75));

		// Whole lines, matching the inline edit surface.
		const endLine = selection.endColumn === 1 && selection.endLineNumber > selection.startLineNumber ? selection.endLineNumber - 1 : selection.endLineNumber;
		const lineRange = new Range(selection.startLineNumber, 1, endLine, model.getLineMaxColumn(endLine));
		const original = model.getValueInRange(lineRange);
		const fullOriginal = model.getValue();

		const cancellation = new CancellationTokenSource();
		const candidates = await this._progressService.withProgress({
			location: ProgressLocation.Notification,
			title: localize('onyx.tournament.running', "Tournament: {0} models editing in parallel (≤{1} at once)…", picked.length, concurrency),
			cancellable: true,
		}, () => this._race(picked.map(item => item.known), instruction, relativePath, model.getLanguageId(), original, fullOriginal, lineRange, folder.uri.fsPath, concurrency, cancellation),
			() => cancellation.cancel());
		if (cancellation.token.isCancellationRequested) {
			return;
		}

		await this._judge(instruction, candidates, folder.uri.fsPath);
	}

	private async _race(
		contestants: readonly IOnyxKnownModel[],
		instruction: string,
		relativePath: string,
		languageId: string,
		original: string,
		fullOriginal: string,
		lineRange: Range,
		repoPath: string,
		concurrency: number,
		cancellation: CancellationTokenSource,
	): Promise<IOnyxTournamentCandidate[]> {
		const queue = [...contestants];
		const results: IOnyxTournamentCandidate[] = [];
		const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
			while (queue.length > 0 && !cancellation.token.isCancellationRequested) {
				const contestant = queue.shift()!;
				results.push(await this._runContestant(contestant, instruction, relativePath, languageId, original, fullOriginal, lineRange, repoPath, cancellation));
			}
		});
		await Promise.all(workers);
		return results.sort((a, b) => a.modelKey.localeCompare(b.modelKey));
	}

	private async _runContestant(
		contestant: IOnyxKnownModel,
		instruction: string,
		relativePath: string,
		languageId: string,
		original: string,
		fullOriginal: string,
		lineRange: Range,
		repoPath: string,
		cancellation: CancellationTokenSource,
	): Promise<IOnyxTournamentCandidate> {
		const startedAt = Date.now();
		const run = this._controlPlaneService.beginRun({
			sessionResource: URI.from({ scheme: 'onyx-tournament', path: `/${generateUuid()}` }),
			requestId: generateUuid(),
			title: localize('onyx.tournament.runTitle', "Tournament: {0}", contestant.key),
			task: 'quick-edit',
			modelKey: contestant.key,
		});
		let worktreePath: string | undefined;
		try {
			const reply = await runOneShot(
				this._modelService,
				ONYX_INLINE_EDIT_SYSTEM_PROMPT,
				buildInlineEditPrompt(relativePath, languageId, original, instruction),
				cancellation.token,
				{ run, controlPlane: this._controlPlaneService, modelIdentifier: `${ONYX_VENDOR}:${contestant.key}` });
			const parsed = parseInlineEdits(reply);
			let newSelection: string | undefined;
			if (parsed.kind === 'blocks') {
				const applied = applyEditBlocks(original, parsed.blocks);
				newSelection = applied.appliedCount > 0 ? applied.text : undefined;
			} else if (parsed.kind === 'rewrite') {
				newSelection = parsed.text;
			}
			if (newSelection === undefined || newSelection === original) {
				run.activity({ kind: 'note', label: localize('onyx.tournament.noEdit', "No usable edit"), ok: false });
				run.complete('failed');
				return { modelKey: contestant.key, durationMs: Date.now() - startedAt, tokensPerSecond: undefined, diffText: '', changedFiles: [], failed: localize('onyx.tournament.unusable', "the reply was not a usable edit") };
			}

			// The candidate's whole-file content = original file with the edited selection.
			const lines = fullOriginal.split('\n');
			const newFile = [
				...lines.slice(0, lineRange.startLineNumber - 1),
				...newSelection.split('\n'),
				...lines.slice(lineRange.endLineNumber),
			].join('\n');

			const { worktreePath: created } = await this._runtimeService.worktreeCreate(repoPath, `${Date.now()}-${contestant.key.replace(/[^a-zA-Z0-9]/g, '_').slice(-24)}`);
			worktreePath = created;
			await this._runtimeService.worktreeWriteFile(worktreePath, relativePath, newFile);
			const diff = await this._runtimeService.worktreeDiff(worktreePath);
			const stats = this._profileService.getStats(contestant.key);
			run.activity({
				kind: 'note', ok: true, label: diff.files.length === 1
					? localize('onyx.tournament.candidate.one', "Candidate ready: 1 file changed")
					: localize('onyx.tournament.candidate', "Candidate ready: {0} files changed", diff.files.length),
			});
			run.complete('completed');
			return {
				modelKey: contestant.key,
				durationMs: Date.now() - startedAt,
				tokensPerSecond: stats?.tokensPerSecond,
				diffText: diff.text,
				changedFiles: diff.files,
			};
		} catch (error) {
			run.complete(cancellation.token.isCancellationRequested ? 'cancelled' : 'failed');
			return { modelKey: contestant.key, durationMs: Date.now() - startedAt, tokensPerSecond: undefined, diffText: '', changedFiles: [], failed: error instanceof Error ? error.message : String(error) };
		} finally {
			if (worktreePath) {
				// The diff is captured; the worktree has served its purpose.
				this._runtimeService.worktreeRemove(repoPath, worktreePath).catch(() => { });
			}
		}
	}

	private async _judge(instruction: string, candidates: readonly IOnyxTournamentCandidate[], repoPath: string): Promise<void> {
		const usable = candidates.filter(candidate => !candidate.failed && candidate.diffText.trim());
		await this._editorService.openEditor({
			resource: undefined,
			contents: buildComparisonDocument(instruction, candidates),
			languageId: 'markdown',
			options: { pinned: true },
		});
		if (usable.length === 0) {
			this._notificationService.notify({ severity: Severity.Warning, message: localize('onyx.tournament.allFailed', "No model produced a usable edit. Nothing was changed.") });
			return;
		}

		const winner = await this._quickInputService.pick(
			[
				...usable.map(candidate => ({ label: `$(trophy) ${candidate.modelKey}`, description: `${(candidate.durationMs / 1000).toFixed(1)}s`, candidate })),
				{ label: `$(close) ${localize('onyx.tournament.none', "Keep none")}`, description: localize('onyx.tournament.noneDetail', "Discard every candidate"), candidate: undefined },
			],
			{ placeHolder: localize('onyx.tournament.pickWinner', "Pick the winning edit — its diff is applied to your working tree") });
		if (!winner) {
			return;
		}
		if (!winner.candidate) {
			for (const candidate of usable) {
				this._profileService.reportOutcome(candidate.modelKey, false);
			}
			return;
		}

		try {
			await this._runtimeService.applyDiff(repoPath, winner.candidate.diffText);
			// The pick is an outcome signal: winners get better routing odds.
			for (const candidate of usable) {
				this._profileService.reportOutcome(candidate.modelKey, candidate === winner.candidate);
			}
			this._notificationService.notify({ severity: Severity.Info, message: localize('onyx.tournament.applied', "Applied {0}'s edit to the working tree.", winner.candidate.modelKey) });
		} catch (error) {
			this._notificationService.notify({ severity: Severity.Error, message: localize('onyx.tournament.applyFailed', "The winning diff no longer applies: {0}", error instanceof Error ? error.message : String(error)) });
		}
	}
}
