/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { timeout } from '../../../../../base/common/async.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../../base/common/network.js';
import { URI } from '../../../../../base/common/uri.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IOnyxRuntimeService } from '../../../../../platform/onyxRuntime/common/onyxRuntime.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IWorkbenchContribution } from '../../../../common/contributions.js';
import { IWorkbenchEnvironmentService } from '../../../../services/environment/common/environmentService.js';
import { ILifecycleService } from '../../../../services/lifecycle/common/lifecycle.js';
import { IChatService } from '../../../chat/common/chatService/chatService.js';
import { ChatAgentLocation } from '../../../chat/common/constants.js';
import { ILanguageModelsService } from '../../../chat/common/languageModels.js';
import { classifyLabUnit, IOnyxLabOrderUnit, IOnyxLabUnitRecord, parseLabWorkOrder } from '../../common/onyxLab.js';
import { IOnyxRunEvent, ONYX_VENDOR } from '../../common/onyxTypes.js';
import { IOnyxHarnessConfigService } from '../agent/onyxHarnessConfigService.js';
import { IOnyxChangeSetService, IOnyxStageAttempt } from '../changes/onyxChangeSetService.js';
import { IOnyxControlPlaneService } from '../controlPlane/onyxControlPlaneService.js';
import { bm25PersistPath } from '../intelligence/onyxWorkspaceIndex.js';
import { IOnyxModelService, IOnyxRequestMeasurement } from '../model/onyxLanguageModelProvider.js';
import { IOnyxTerminalService } from '../terminal/onyxTerminalTool.js';

/** How often the engine looks for the launcher's request to stop. */
const CANCEL_POLL_MS = 250;
/** A launcher that has not rewritten its heartbeat for this long is gone: the engine stops and closes the window. */
const HEARTBEAT_STALE_MS = 30_000;
/** How long the engine waits for the runtime's models to be discovered before it says a model cannot be served. */
const DISCOVERY_WAIT_MS = 60_000;

/**
 * The campaign engine inside the application (L9, tier A). When the process
 * was started with a work order, in a build from source, it runs the
 * order's units one after another through the real agent loop: a chat
 * request in a session of its own, with the tools, the staging and the
 * journal a user's request has. For each unit it checks the campaign's
 * worktree out at the task's parent commit, waits for the index to have
 * caught up, sets the unit's harness configuration and seed, sends the
 * instruction, and writes down what the run did: every model turn, every
 * edit the model asked for, the file as the run proposed it. Then it
 * discards the proposal. Nothing is accepted, so the worktree's files are
 * never changed by a campaign.
 *
 * A campaign never runs a command a model wrote (DEC-10): the terminal tool
 * stays in the tool list and every invocation is denied and counted.
 *
 * It scores nothing. The launcher scores the records, so that a score can
 * be recomputed from what is committed.
 */
export class OnyxLabCampaignContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.onyxLabCampaign';

	constructor(
		@IOnyxRuntimeService private readonly _runtimeService: IOnyxRuntimeService,
		@IWorkbenchEnvironmentService private readonly _environmentService: IWorkbenchEnvironmentService,
		@IWorkspaceContextService private readonly _workspaceService: IWorkspaceContextService,
		@IChatService private readonly _chatService: IChatService,
		@ILanguageModelsService private readonly _languageModelsService: ILanguageModelsService,
		@IOnyxModelService private readonly _modelService: IOnyxModelService,
		@IOnyxHarnessConfigService private readonly _harnessConfigService: IOnyxHarnessConfigService,
		@IOnyxChangeSetService private readonly _changeSetService: IOnyxChangeSetService,
		@IOnyxControlPlaneService private readonly _controlPlaneService: IOnyxControlPlaneService,
		@IOnyxTerminalService private readonly _terminalService: IOnyxTerminalService,
		@IFileService private readonly _fileService: IFileService,
		@ILifecycleService private readonly _lifecycleService: ILifecycleService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();
		this._start().catch(error => this._logService.error('[onyx] lab campaign failed', error));
	}

	private async _start(): Promise<void> {
		const request = await this._runtimeService.labCampaignRequest();
		if (!request) {
			return;
		}
		if (this._environmentService.isBuilt) {
			// The same rule as a lab harness configuration (L4, R-44): a packaged build runs no campaign.
			this._logService.warn('[onyx] a lab campaign was requested and not run: a campaign is run only by a development build');
			return;
		}
		const status = (state: string, detail: Record<string, unknown> = {}) => this._runtimeService.labWrite('status', JSON.stringify({ state, at: new Date().toISOString(), ...detail }));
		const order = parseLabWorkOrder(request.order);
		if (!order.ok) {
			await status('refused', { reason: request.problem ?? order.error });
			return;
		}
		const folder = this._workspaceService.getWorkspace().folders.find(candidate => candidate.uri.scheme === Schemas.file);
		if (!folder || folder.uri.fsPath !== order.order.worktree) {
			await status('refused', { reason: 'the window was not opened on the campaign\'s worktree' });
			return;
		}
		this._terminalService.setCampaignPolicy(true);
		await status('running', { units: order.order.units.length });
		const cancelUri = URI.file(order.order.cancelPath);
		const heartbeatUri = URI.file(order.order.heartbeatPath);
		const shouldStop = async (): Promise<boolean> => {
			if (await this._fileService.exists(cancelUri)) {
				return true;
			}
			try {
				return Date.now() - (await this._fileService.stat(heartbeatUri)).mtime > HEARTBEAT_STALE_MS;
			} catch {
				return true; // no heartbeat at all: nobody is running this campaign
			}
		};
		let checkedOut: string | undefined;
		let done = 0;
		for (const unit of order.order.units) {
			if (await shouldStop()) {
				await status('cancelled', { done });
				this._lifecycleService.shutdown().catch(() => undefined);
				return;
			}
			const revision = `${unit.task.commit}~1`;
			if (checkedOut !== revision) {
				const checkout = await this._runtimeService.labCheckout(revision);
				if (!checkout.ok) {
					await status('failed', { done, reason: `checkout of ${revision}: ${checkout.error}` });
					return;
				}
				checkedOut = revision;
				// The index has caught up with the checkout when this resolves (B12): it reconciles against the tree first.
				await this._runtimeService.ensureWorkspaceIndex(folder.uri.fsPath, bm25PersistPath(this._environmentService, this._workspaceService, folder).fsPath).catch(() => undefined);
			}
			const record = await this._runUnit(unit, order.order.baseUrl, order.order.unitTimeoutMs, shouldStop);
			if (record.outcome === 'cancelled') {
				// An unfinished unit leaves no record: a resumed campaign runs it again.
				await status('cancelled', { done });
				this._lifecycleService.shutdown().catch(() => undefined);
				return;
			}
			await this._runtimeService.labWrite('record', JSON.stringify(record));
			done++;
			await status('running', { units: order.order.units.length, done });
		}
		await status('done', { done });
	}

	private async _modelIdentifier(model: string, baseUrl: string): Promise<string | undefined> {
		const wanted = baseUrl.replace(/\/+$/, '');
		const deadline = Date.now() + DISCOVERY_WAIT_MS;
		for (; ;) {
			await this._languageModelsService.selectLanguageModels({ vendor: ONYX_VENDOR });
			const known = this._modelService.getKnownModels().find(candidate => candidate.discovered.id === model && candidate.discovered.baseUrl.replace(/\/+$/, '') === wanted);
			if (known) {
				return `${ONYX_VENDOR}:${known.key}`;
			}
			if (Date.now() > deadline) {
				return undefined;
			}
			await this._modelService.refresh().catch(() => undefined);
			await timeout(1000);
		}
	}

	private async _runUnit(unit: IOnyxLabOrderUnit, baseUrl: string, unitTimeoutMs: number, shouldStop: () => Promise<boolean>): Promise<IOnyxLabUnitRecord> {
		const startedAt = Date.now();
		const base: Pick<IOnyxLabUnitRecord, 'unit' | 'model' | 'configuration' | 'task' | 'seed' | 'repetition' | 'tier'> = { unit: unit.id, model: unit.model, configuration: unit.configuration.name, task: unit.task.id, seed: unit.seed, repetition: unit.repetition, tier: 'A' };
		const empty = { reply: null, edits: [], events: [], requests: [], harnessHash: null, deniedCommands: 0 };
		const modelIdentifier = await this._modelIdentifier(unit.model, baseUrl);
		if (!modelIdentifier) {
			return { ...base, ...empty, outcome: 'could-not-serve', durationMs: Date.now() - startedAt, error: `the runtime at the campaign's address does not list ${unit.model}` };
		}
		this._changeSetService.rejectAll();
		this._harnessConfigService.setLabOverride({ request: { manifest: unit.manifest, name: unit.configuration.name, configuration: unit.configuration.configuration }, sampling: { seed: unit.seed, temperature: unit.temperature } });
		const store = new DisposableStore();
		const session = this._chatService.startNewLocalSession(ChatAgentLocation.Chat);
		store.add(session);
		const sessionResource = session.object.sessionResource;
		let runId: string | undefined;
		const events: IOnyxRunEvent[] = [];
		const edits: IOnyxStageAttempt[] = [];
		const requests: IOnyxRequestMeasurement[] = [];
		store.add(this._controlPlaneService.onDidBeginRun(run => {
			if (run.sessionResource.toString() === sessionResource.toString()) {
				runId = run.runId;
			}
		}));
		store.add(this._controlPlaneService.onDidRecordEvent(recorded => {
			if (recorded.runId === runId && recorded.event.kind !== 'promptSnapshot') {
				events.push(recorded.event);
			}
		}));
		store.add(this._changeSetService.onDidAttemptStage(attempt => {
			if (attempt.runId === runId) {
				edits.push(attempt);
			}
		}));
		const modelKey = modelIdentifier.slice(ONYX_VENDOR.length + 1);
		store.add(this._modelService.onDidMeasureRequest(measurement => {
			if (measurement.modelKey === modelKey) {
				requests.push(measurement);
			}
		}));
		const deniedBefore = this._terminalService.campaignDenials;
		let cancelled = false;
		let timedOut = false;
		let error: string | undefined;
		try {
			const sent = await this._chatService.sendRequest(sessionResource, unit.instruction, { userSelectedModelId: modelIdentifier });
			if (sent.kind !== 'sent') {
				error = sent.kind === 'rejected' ? `the request was rejected: ${sent.reason}` : 'the request was queued, not sent';
			} else {
				let finished = false;
				const completion = sent.data.responseCompletePromise.then(() => { finished = true; }, reason => { finished = true; error = String(reason); });
				// Stop goes through the run's own cancellation (B10): the launcher asks by writing a file, and
				// this is where the file is seen while a unit runs.
				while (!finished) {
					await Promise.race([completion, timeout(CANCEL_POLL_MS)]);
					if (finished) {
						break;
					}
					const overdue = Date.now() - startedAt > unitTimeoutMs;
					if (overdue || await shouldStop()) {
						cancelled = !overdue;
						timedOut = overdue;
						if (runId) {
							this._controlPlaneService.stop(runId);
						}
						await this._chatService.cancelCurrentRequestForSession(sessionResource, 'onyx-lab');
						await Promise.race([completion, timeout(5000)]);
						break;
					}
				}
			}
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
		}
		const proposed = this._changeSetService.files.get().find(file => file.proposal.path === unit.task.file || file.proposal.path.endsWith(`/${unit.task.file}`));
		const header = events.find(event => event.kind === 'trace')?.data as { harness?: { configurationHash?: string } } | undefined;
		const turns = events.filter(event => event.kind === 'traceTurn').map(event => event.data as { streamEnd?: string; responseText?: string; toolCalls?: readonly unknown[] });
		// The runtime served the unit when some turn brought something back: text, or a tool call.
		const served = turns.some(turn => (turn.responseText ?? '').length > 0 || (turn.toolCalls ?? []).length > 0);
		const deniedCommands = this._terminalService.campaignDenials - deniedBefore;
		const outcome = classifyLabUnit({ cancelled, served, deniedCommands, proposedAnEdit: proposed !== undefined });
		const reply = proposed?.proposal.proposed ?? null;
		this._changeSetService.rejectAll();
		this._harnessConfigService.setLabOverride(undefined);
		store.dispose();
		return {
			...base, outcome, reply, edits, events, requests: requests.map(request => ({ promptTokens: request.promptTokens ?? null, completionTokens: request.completionTokens ?? null, firstTokenMs: request.timeToFirstTokenMs ?? null, tokensPerSecond: request.tokensPerSecond ?? null })),
			harnessHash: header?.harness?.configurationHash ?? null, deniedCommands, durationMs: Date.now() - startedAt,
			...(timedOut ? { timedOut: true } : {}), ...(error ? { error } : {}),
		};
	}
}
