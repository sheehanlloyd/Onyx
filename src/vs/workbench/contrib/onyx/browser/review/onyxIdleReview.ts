/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RunOnceScheduler } from '../../../../../base/common/async.js';
import { autorun } from '../../../../../base/common/observable.js';
import { URI } from '../../../../../base/common/uri.js';
import { CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../../base/common/network.js';
import { joinPath } from '../../../../../base/common/resources.js';
import { localize } from '../../../../../nls.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IMarkerData, IMarkerService, MarkerSeverity } from '../../../../../platform/markers/common/markers.js';
import { IOnyxRuntimeService } from '../../../../../platform/onyxRuntime/common/onyxRuntime.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IActivityService, NumberBadge } from '../../../../services/activity/common/activity.js';
import { IUserActivityService } from '../../../../services/userActivity/common/userActivityService.js';
import { hash } from '../../../../../base/common/hash.js';
import { buildCommitDiffDigest } from '../../common/onyxCommitMessage.js';
import { OnyxSettingId } from '../../common/onyxConfiguration.js';
import { passesSeverityThreshold } from '../../common/onyxProjectConfig.js';
import { ONYX_REVIEW_SYSTEM_PROMPT, parseReviewFindings } from '../../common/onyxReview.js';
import { runOneShot } from '../agent/onyxOneShot.js';
import { IOnyxProjectConfigService } from '../config/onyxProjectConfigService.js';
import { ONYX_CONTROL_PLANE_CONTAINER_ID } from '../controlPlane/onyxControlPlane.contribution.js';
import { IOnyxControlPlaneService } from '../controlPlane/onyxControlPlaneService.js';
import { IOnyxEnergyService } from '../compute/onyxEnergyService.js';
import { IOnyxModelService } from '../model/onyxLanguageModelProvider.js';
import { qualifyWorkspacePath, resolveWorkspacePath } from '../../common/onyxWorkspacePaths.js';

/** How long the user must be idle before spare compute is really spare. */
const IDLE_DELAY_MS = 90_000;
/** The same diff is never reviewed twice, and even new diffs at most this often. */
const MIN_INTERVAL_MS = 10 * 60_000;
const MAX_DIFF_CHARS = 24_000;

/**
 * Idle-compute background review: when the machine is idle, plugged in and
 * thermally comfortable, the adversarial reviewer quietly reads whatever is
 * uncommitted and files its findings in the Problems panel under the "onyx"
 * source, with a count badge on the control plane. Off by default; one
 * setting turns it on; any user activity or foreground request cancels it
 * instantly. It must feel like a colleague who read your diff while you got
 * coffee — never like a process fighting you for the GPU.
 */
export class OnyxIdleReviewContribution extends Disposable {

	static readonly ID = 'workbench.contrib.onyxIdleReview';

	private readonly _idleScheduler: RunOnceScheduler;
	private readonly _badge = this._register(new MutableDisposable());
	private _session: CancellationTokenSource | undefined;
	private _lastDiffHash: number | undefined;
	private _lastRunAt = 0;

	constructor(
		@IUserActivityService private readonly _userActivityService: IUserActivityService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IOnyxEnergyService private readonly _energyService: IOnyxEnergyService,
		@IOnyxControlPlaneService private readonly _controlPlaneService: IOnyxControlPlaneService,
		@IOnyxModelService private readonly _modelService: IOnyxModelService,
		@IOnyxRuntimeService private readonly _runtimeService: IOnyxRuntimeService,
		@IWorkspaceContextService private readonly _workspaceService: IWorkspaceContextService,
		@IOnyxProjectConfigService private readonly _projectConfigService: IOnyxProjectConfigService,
		@IMarkerService private readonly _markerService: IMarkerService,
		@IActivityService private readonly _activityService: IActivityService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();
		this._idleScheduler = this._register(new RunOnceScheduler(() => this._maybeReview(), IDLE_DELAY_MS));
		this._register(this._userActivityService.onDidChangeIsActive(active => {
			if (active) {
				// The user is back: stop instantly and get out of the way.
				this._cancel();
				this._idleScheduler.cancel();
			} else if (this._enabled()) {
				this._idleScheduler.schedule();
			}
		}));
		this._register(this._configurationService.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(OnyxSettingId.BackgroundReview) && !this._enabled()) {
				this._cancel();
				this._clearFindings();
			}
		}));
	}

	private _enabled(): boolean {
		return this._configurationService.getValue<boolean>(OnyxSettingId.BackgroundReview) === true;
	}

	private _cancel(): void {
		this._session?.cancel();
		this._session = undefined;
	}

	private _clearFindings(): void {
		this._markerService.changeAll('onyx', []);
		this._badge.clear();
	}

	private async _maybeReview(): Promise<void> {
		if (!this._enabled() || this._session || this._userActivityService.isActive) {
			return;
		}
		const power = this._energyService.state.get();
		if (power.onBattery || power.thermal === 'serious') {
			return; // spare compute only when it really is spare
		}
		if (this._controlPlaneService.compute.get().inFlight) {
			return; // never compete with a foreground request
		}
		if (Date.now() - this._lastRunAt < MIN_INTERVAL_MS || this._modelService.getKnownModels().length === 0) {
			return;
		}

		const folders = this._workspaceService.getWorkspace().folders.filter(folder => folder.uri.scheme === Schemas.file);
		const folderRefs = folders.map(f => ({ name: f.name, index: f.index }));
		let combined = '';
		const qualifiedFiles: string[] = [];
		for (const folder of folders) {
			try {
				const diff = await this._runtimeService.gitDiff(folder.uri.fsPath, 'head', Math.floor(MAX_DIFF_CHARS / folders.length));
				if (diff.text.trim()) {
					combined += `${folderRefs.length > 1 ? `# Folder: ${folder.name}\n` : ''}${diff.text}\n`;
					qualifiedFiles.push(...diff.files.map(file => qualifyWorkspacePath(folderRefs, folder.index, file)));
				}
			} catch {
				// no git: nothing to review in this root
			}
		}
		if (!combined.trim()) {
			this._clearFindings();
			return;
		}
		const diffHash = hash(combined);
		if (diffHash === this._lastDiffHash) {
			return; // reviewed exactly this state already
		}

		this._lastRunAt = Date.now();
		this._session = new CancellationTokenSource();
		const session = this._session;
		const listeners = new DisposableStore();
		// A foreground request starting mid-review cancels it instantly.
		listeners.add(autorun(reader => {
			if (this._controlPlaneService.compute.read(reader).inFlight) {
				session.cancel();
			}
		}));
		try {
			this._logService.info('[onyx] idle background review starting');
			const raw = await runOneShot(this._modelService, ONYX_REVIEW_SYSTEM_PROMPT, buildCommitDiffDigest(combined, qualifiedFiles, MAX_DIFF_CHARS), session.token);
			if (session.token.isCancellationRequested) {
				return;
			}
			this._lastDiffHash = diffHash;
			const threshold = this._projectConfigService.resolved.get().config.reviewSeverityThreshold;
			const findings = parseReviewFindings(raw).filter(finding => passesSeverityThreshold(finding.severity, threshold));
			this._publish(findings, folderRefs);
			this._logService.info(`[onyx] idle background review: ${findings.length} finding(s)`);
		} catch (error) {
			this._logService.warn('[onyx] idle background review failed', error);
		} finally {
			listeners.dispose();
			if (this._session === session) {
				this._session = undefined;
			}
		}
	}

	private _publish(findings: readonly { file: string; line: number; severity: 'low' | 'medium' | 'high'; title: string; detail: string }[], folderRefs: readonly { name: string; index: number }[]): void {
		const folders = this._workspaceService.getWorkspace().folders;
		const entries: { resource: URI; marker: IMarkerData }[] = [];
		for (const finding of findings) {
			const resolved = resolveWorkspacePath(folderRefs, finding.file);
			const folder = resolved ? folders.find(f => f.index === resolved.folderIndex) : undefined;
			if (!resolved || !folder) {
				continue;
			}
			entries.push({
				resource: joinPath(folder.uri, resolved.relativePath),
				marker: {
					// A background reviewer's opinion is at most a warning — the
					// Problems panel must never turn red because a model mused.
					severity: finding.severity === 'high' ? MarkerSeverity.Warning : MarkerSeverity.Info,
					message: `${finding.title} — ${finding.detail}`,
					startLineNumber: finding.line,
					startColumn: 1,
					endLineNumber: finding.line,
					endColumn: 1,
					source: 'onyx',
				},
			});
		}
		this._markerService.changeAll('onyx', entries);
		this._badge.value = entries.length > 0
			? this._activityService.showViewContainerActivity(ONYX_CONTROL_PLANE_CONTAINER_ID, {
				badge: new NumberBadge(entries.length, count => count === 1
					? localize('onyx.idleReview.badge.one', "1 background review finding")
					: localize('onyx.idleReview.badge', "{0} background review findings", count)),
			})
			: undefined;
	}
}
