/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { timeout } from '../../../../../../base/common/async.js';
import { VSBuffer } from '../../../../../../base/common/buffer.js';
import { CancellationTokenSource } from '../../../../../../base/common/cancellation.js';
import { DisposableStore, IReference } from '../../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../../base/common/uri.js';
import { autorun } from '../../../../../../base/common/observable.js';
import { ITextModel } from '../../../../../../editor/common/model.js';
import { IModelService } from '../../../../../../editor/common/services/model.js';
import { ITextModelService, IResolvedTextEditorModel } from '../../../../../../editor/common/services/resolverService.js';
import { IDialogService } from '../../../../../../platform/dialogs/common/dialogs.js';
import { FileService } from '../../../../../../platform/files/common/fileService.js';
import { IFileService } from '../../../../../../platform/files/common/files.js';
import { InMemoryFileSystemProvider } from '../../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { NullLogService } from '../../../../../../platform/log/common/log.js';
import { IOnyxRuntimeService } from '../../../../../../platform/onyxRuntime/common/onyxRuntime.js';
import { IWorkspaceContextService } from '../../../../../../platform/workspace/common/workspace.js';
import { testWorkspace } from '../../../../../../platform/workspace/test/common/testWorkspace.js';
import { TestContextService } from '../../../../../test/common/workbenchTestServices.js';
import { workbenchInstantiationService } from '../../../../../test/browser/workbenchTestServices.js';
import { ITextFileService, TextFileEditorModelState } from '../../../../../services/textfile/common/textfiles.js';
import { ChatAgentLocation } from '../../../../chat/common/constants.js';
import { ILanguageModelsService } from '../../../../chat/common/languageModels.js';
import { IChatAgentRequest } from '../../../../chat/common/participants/chatAgents.js';
import { IChatProgress } from '../../../../chat/common/chatService/chatService.js';
import { ILanguageModelToolsService } from '../../../../chat/common/tools/languageModelToolsService.js';
import { ITaskService } from '../../../../tasks/common/taskService.js';
import { IOnyxModelProfile } from '../../../common/onyxTypes.js';
import { OnyxAgentLoop } from '../../../browser/agent/onyxAgentLoop.js';
import { IOnyxPromptCacheService, OnyxPromptCacheService } from '../../../browser/agent/onyxPromptCache.js';
import { IOnyxChangeSetService, OnyxChangeSetService } from '../../../browser/changes/onyxChangeSetService.js';
import { OnyxEditToolContribution } from '../../../browser/changes/onyxEditTool.js';
import { IOnyxEnergyService } from '../../../browser/compute/onyxEnergyService.js';
import { IOnyxProjectConfigService } from '../../../browser/config/onyxProjectConfigService.js';
import { IOnyxControlPlaneService, OnyxControlPlaneService } from '../../../browser/controlPlane/onyxControlPlaneService.js';
import { IOnyxMemoryService, OnyxMemoryService } from '../../../browser/intelligence/onyxMemoryService.js';
import { IOnyxPinService } from '../../../browser/intelligence/onyxPinService.js';
import { IOnyxModelService, OnyxModelService } from '../../../browser/model/onyxLanguageModelProvider.js';
import { IOnyxPlaybookService } from '../../../browser/playbooks/onyxPlaybookService.js';
import { IOnyxProfileService } from '../../../browser/profiles/onyxProfileService.js';
import { IOnyxRouterService, OnyxRouterService } from '../../../browser/routing/onyxRouterService.js';
import { IOnyxTerminalService, OnyxTerminalService, OnyxTerminalToolContribution } from '../../../browser/terminal/onyxTerminalTool.js';
import { OnyxSimBoundary, OnyxSimEpisode, OnyxSimFault, OnyxSimUserAction } from './onyxSimEpisode.js';
import { IOnyxSimCommandScript, IOnyxSimScheduler, OnyxSimDialogService, OnyxSimEnergyService, OnyxSimLanguageModelsService, OnyxSimPinService, OnyxSimPlaybookService, OnyxSimProfileService, OnyxSimProjectConfigService, OnyxSimRuntimeService, OnyxSimToolsService, SIM_MODEL_KEY, simTaskService, simWorkspaceUri } from './onyxSimFakes.js';
import { digest, OnyxSimTrace } from './onyxSimTrace.js';

/**
 * The deterministic simulation rig (L1). It instantiates the real agent
 * loop, control plane, change set service, edit tool and terminal tool
 * against real text models over an in-memory file system, and simulates only
 * the boundaries: the runtime (scripted stream, recorded commands), the dialog
 * service (scripted decisions), the core registries, and the clock (the test
 * runs it under `runWithFakedTimers`, so `Date.now` and every timer are
 * virtual). One episode script decides what the model emits, what the user
 * does concurrently and which faults the environment injects, and at which
 * boundary; the scheduler fires them when that boundary is reached.
 */

/** The observable state an invariant checker (L2) reads after every step. */
export interface IOnyxSimState {
	readonly episode: OnyxSimEpisode;
	readonly trace: OnyxSimTrace;
	readonly runtime: OnyxSimRuntimeService;
	readonly dialogs: OnyxSimDialogService;
	readonly tools: OnyxSimToolsService;
	readonly changeSet: IOnyxChangeSetService;
	readonly controlPlane: IOnyxControlPlaneService;
	/** Current buffer content per workspace path, for files that have a live text model. */
	buffer(path: string): string | undefined;
	/** Current content on the in-memory disk. */
	disk(path: string): Promise<string | undefined>;
	/** The buffer content the user sanctioned per path: the start, their own typing, and what they accepted. */
	readonly sanctionedBuffer: ReadonlyMap<string, string>;
	/** The disk content the user sanctioned per path: the start, their saves, and disk changes outside the editor. */
	readonly sanctionedDisk: ReadonlyMap<string, string>;
	/** A second acceptable buffer content per path: the text a clean editor still shows until it reloads a disk change. */
	readonly pendingBuffer: ReadonlyMap<string, string>;
	/** Text the user typed; it must survive every accept and rebase (I-09). */
	readonly typedTexts: readonly string[];
	readonly stopped: boolean;
	readonly acceptedHunks: readonly { readonly path: string; readonly hunk: number | 'all'; readonly newLines: readonly string[] }[];
	/** Staged proposals observed after each tool result: path, hunk count and the proposal's size. */
	readonly stageEvents: readonly { readonly path: string; readonly hunks: number; readonly proposedChars: number; readonly search: string | undefined; readonly baseAtStage: string | undefined; readonly proposedBefore: string | undefined }[];
	readonly profile: IOnyxModelProfile;
}

export type OnyxSimChecker = (state: IOnyxSimState, boundary: OnyxSimBoundary | 'end') => string | undefined;

export interface IOnyxSimResult {
	readonly episode: OnyxSimEpisode;
	readonly trace: string;
	readonly violations: readonly { readonly invariant: string; readonly detail: string; readonly boundary: string }[];
	readonly status: string;
	readonly turns: number;
	readonly boundaries: number;
}

const WATCHDOG_MS = 10 * 60_000;

export class OnyxSimRig implements IOnyxSimScheduler, IOnyxSimState {

	readonly trace: OnyxSimTrace;
	readonly runtime: OnyxSimRuntimeService;
	readonly dialogs: OnyxSimDialogService;
	readonly tools: OnyxSimToolsService;
	readonly changeSet: IOnyxChangeSetService;
	readonly controlPlane: IOnyxControlPlaneService;
	readonly sanctionedBuffer = new Map<string, string>();
	readonly sanctionedDisk = new Map<string, string>();
	readonly pendingBuffer = new Map<string, string>();
	readonly typedTexts: string[] = [];
	readonly acceptedHunks: { path: string; hunk: number | 'all'; newLines: readonly string[] }[] = [];
	readonly stageEvents: { path: string; hunks: number; proposedChars: number; search: string | undefined; baseAtStage: string | undefined; proposedBefore: string | undefined }[] = [];
	private readonly _lastProposed = new Map<string, string>();
	readonly profile: IOnyxModelProfile;
	stopped = false;

	private readonly _disposables = new DisposableStore();
	private readonly _fileService: IFileService;
	private readonly _modelService: IModelService;
	private readonly _textModelService: ITextModelService;
	private readonly _textFileService: ITextFileService;
	private readonly _loop: OnyxAgentLoop;
	private readonly _languageModels: OnyxSimLanguageModelsService;
	private readonly _references = new Map<string, IReference<IResolvedTextEditorModel>>();
	private readonly _occurrences = new Map<OnyxSimBoundary, number>();
	private readonly _takenFaults = new Set<number>();
	private readonly _takenUserSteps = new Set<number>();
	private readonly _violations: { invariant: string; detail: string; boundary: string }[] = [];
	private readonly _checkers: OnyxSimChecker[] = [];
	private readonly _lastDigests = new Map<string, string>();
	private _boundaries = 0;
	private _runId: string | undefined;
	private _cancellation = new CancellationTokenSource();
	private _completed = false;

	constructor(readonly episode: OnyxSimEpisode, checkers: readonly OnyxSimChecker[] = []) {
		this._checkers.push(...checkers);
		this.trace = new OnyxSimTrace(() => Date.now());

		const commandScript = (command: string): IOnyxSimCommandScript => ({ exitCode: 0, output: command.startsWith('cat ') ? (episode.files[command.slice(4).trim()] ?? '') : `ran: ${command}\n` });
		this.runtime = this._disposables.add(new OnyxSimRuntimeService(episode.turns, episode.persona, this, this.trace, commandScript));
		this.dialogs = new OnyxSimDialogService(episode.dialogDefault, this, this.trace);
		this.tools = new OnyxSimToolsService(this, this.trace);

		const fileService = this._disposables.add(new FileService(new NullLogService()));
		this._disposables.add(fileService.registerProvider(simWorkspaceUri().scheme, this._disposables.add(new InMemoryFileSystemProvider())));
		this._fileService = fileService;

		const instantiationService = workbenchInstantiationService({ fileService: () => fileService }, this._disposables);
		instantiationService.stub(IWorkspaceContextService, new TestContextService(testWorkspace(simWorkspaceUri())));
		instantiationService.stub(IOnyxRuntimeService, this.runtime);
		instantiationService.stub(IDialogService, this.dialogs);
		instantiationService.stub(ILanguageModelToolsService, this.tools);
		const profile: IOnyxModelProfile = { toolCallQuality: 0.9, contextLength: 16384, maxTools: 8, temperature: 0.2, promptStyle: 'full', family: 'sim', parameterB: 7, supportsVision: false, ...episode.profile };
		this.profile = profile;
		instantiationService.stub(IOnyxProfileService, new OnyxSimProfileService(profile));
		const projectConfig = new OnyxSimProjectConfigService();
		if (episode.projectConfig) {
			projectConfig.setConfig({ terminalAllowlist: episode.projectConfig.terminalAllowlist ? [...episode.projectConfig.terminalAllowlist] : undefined, disabledTools: episode.projectConfig.disabledTools ? [...episode.projectConfig.disabledTools] : undefined });
		}
		instantiationService.stub(IOnyxProjectConfigService, projectConfig);
		instantiationService.stub(IOnyxEnergyService, new OnyxSimEnergyService());
		instantiationService.stub(IOnyxPinService, new OnyxSimPinService());
		instantiationService.stub(IOnyxPlaybookService, new OnyxSimPlaybookService());
		instantiationService.stub(ITaskService, simTaskService);

		this.controlPlane = this._disposables.add(new OnyxControlPlaneService());
		instantiationService.stub(IOnyxControlPlaneService, this.controlPlane);
		const modelService: IOnyxModelService = this._disposables.add(instantiationService.createInstance(OnyxModelService));
		instantiationService.stub(IOnyxModelService, modelService);
		this._languageModels = new OnyxSimLanguageModelsService(modelService);
		instantiationService.stub(ILanguageModelsService, this._languageModels);
		instantiationService.stub(IOnyxRouterService, this._disposables.add(instantiationService.createInstance(OnyxRouterService)));
		instantiationService.stub(IOnyxPromptCacheService, this._disposables.add(new OnyxPromptCacheService()));
		instantiationService.stub(IOnyxMemoryService, this._disposables.add(instantiationService.createInstance(OnyxMemoryService)));
		this.changeSet = this._disposables.add(instantiationService.createInstance(OnyxChangeSetService));
		instantiationService.stub(IOnyxChangeSetService, this.changeSet);
		instantiationService.stub(IOnyxTerminalService, this._disposables.add(instantiationService.createInstance(OnyxTerminalService)));
		this._disposables.add(instantiationService.createInstance(OnyxEditToolContribution));
		this._disposables.add(instantiationService.createInstance(OnyxTerminalToolContribution));

		this._modelService = instantiationService.get(IModelService);
		this._textModelService = instantiationService.get(ITextModelService);
		this._textFileService = instantiationService.get(ITextFileService);
		this._loop = instantiationService.createInstance(OnyxAgentLoop);

		this._disposables.add(this.controlPlane.onDidRecordEvent(({ runId, event }) => {
			const run = this.trace.canonical('run', runId);
			if (event.kind === 'outcome') {
				this.trace.record({ kind: 'status', run, status: String((event.data as { status: string }).status) });
			} else if (event.kind !== 'promptSnapshot') {
				const data = event.data as { kind?: string; label?: string; ok?: boolean };
				this.trace.record({ kind: 'activity', run, activity: data.kind ?? event.kind, label: data.label ?? '', ok: data.ok });
			}
		}));
		this._disposables.add(this.controlPlane.onDidBeginRun(run => {
			this._runId = run.runId;
			// Status transitions of the live run, not only journaled outcomes: a
			// stop sets "cancelled" directly, and what follows it is what I-03 checks.
			this._disposables.add(autorun(reader => {
				const status = run.status.read(reader);
				if (status !== 'running') {
					this.trace.record({ kind: 'status', run: this.trace.canonical('run', run.runId), status: `live:${status}` });
				}
			}));
		}));
	}

	private _uri(path: string): URI {
		return URI.joinPath(simWorkspaceUri(), path);
	}

	buffer(path: string): string | undefined {
		return this._modelService.getModel(this._uri(path))?.getValue();
	}

	async disk(path: string): Promise<string | undefined> {
		try {
			return (await this._fileService.readFile(this._uri(path))).value.toString();
		} catch {
			return undefined;
		}
	}

	private async _open(path: string): Promise<ITextModel> {
		let reference = this._references.get(path);
		if (!reference) {
			reference = await this._textModelService.createModelReference(this._uri(path));
			this._references.set(path, reference);
		}
		return reference.object.textEditorModel;
	}

	private _close(path: string): void {
		this._references.get(path)?.dispose();
		this._references.delete(path);
	}

	// --- scheduler ---------------------------------------------------------

	async boundary(name: OnyxSimBoundary): Promise<void> {
		this._boundaries++;
		const occurrence = (this._occurrences.get(name) ?? 0) + 1;
		this._occurrences.set(name, occurrence);
		for (let index = 0; index < this.episode.userSteps.length; index++) {
			const scheduled = this.episode.userSteps[index];
			if (scheduled.at === name && scheduled.occurrence === occurrence && !this._takenUserSteps.has(index)) {
				this._takenUserSteps.add(index);
				await this._act(scheduled.step);
			}
		}
		const fault = this.takeFault(name, ['fileChangedOnDisk', 'serviceDispose', 'staleIndex']);
		if (fault) {
			await this._inject(fault);
		}
		await this._observe(name);
		if (this._boundaries > 5000) {
			throw new Error(`episode ${this.episode.name}: more than 5000 boundaries; the loop is not terminating`);
		}
	}

	takeFault(name: OnyxSimBoundary, kinds?: readonly OnyxSimFault['kind'][]): OnyxSimFault | undefined {
		const occurrence = this._occurrences.get(name) ?? 0;
		for (let index = 0; index < this.episode.faults.length; index++) {
			const scheduled = this.episode.faults[index];
			if (scheduled.at === name && scheduled.occurrence <= occurrence && !this._takenFaults.has(index) && (!kinds || kinds.includes(scheduled.step.kind))) {
				this._takenFaults.add(index);
				return scheduled.step;
			}
		}
		return undefined;
	}

	private async _inject(fault: OnyxSimFault): Promise<void> {
		switch (fault.kind) {
			case 'fileChangedOnDisk': {
				this.trace.record({ kind: 'fault', fault: fault.kind, detail: fault.path });
				// A clean buffer follows the disk (the editor reloads it); a dirty one keeps the user's text.
				const dirtyBefore = this._textFileService.isDirty(this._uri(fault.path));
				await this._fileService.writeFile(this._uri(fault.path), VSBuffer.fromString(fault.content));
				this.sanctionedDisk.set(fault.path, fault.content);
				if (!dirtyBefore) {
					const previous = this.sanctionedBuffer.get(fault.path);
					if (previous !== undefined) {
						this.pendingBuffer.set(fault.path, previous);
					}
					this.sanctionedBuffer.set(fault.path, fault.content);
				}
				break;
			}
			case 'serviceDispose':
				this.trace.record({ kind: 'fault', fault: fault.kind });
				this.runtime.simulateDispose();
				break;
			case 'staleIndex':
				this.trace.record({ kind: 'fault', fault: fault.kind, detail: 'no index in Module 1; recorded only' });
				break;
			default:
				// Stream and command faults are consumed by the fakes at their own boundaries.
				break;
		}
	}

	private async _act(action: OnyxSimUserAction): Promise<void> {
		this.trace.record({ kind: 'userAction', action: action.kind, detail: describeAction(action) });
		switch (action.kind) {
			case 'typeInTarget': {
				const model = await this._open(this.episode.target);
				const line = Math.min(action.line, model.getLineCount());
				model.pushStackElement();
				model.pushEditOperations(null, [{ range: { startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: 1 }, text: action.text }], () => null);
				model.pushStackElement();
				this.typedTexts.push(action.text.replace(/\n$/, ''));
				this.sanctionedBuffer.set(this.episode.target, model.getValue());
				break;
			}
			case 'acceptHunk': {
				const staged = this.changeSet.files.get().find(file => file.proposal.path === action.path);
				const hunk = staged?.hunks[action.hunk];
				if (await this.changeSet.acceptHunk(action.path, action.hunk)) {
					this.acceptedHunks.push({ path: action.path, hunk: action.hunk, newLines: hunk?.newLines ?? [] });
					this._sanction(action.path);
				}
				break;
			}
			case 'rejectHunk':
				this.changeSet.rejectHunk(action.path, action.hunk);
				break;
			case 'acceptAll': {
				const staged = this.changeSet.files.get();
				await this.changeSet.acceptAll();
				for (const file of staged) {
					this.acceptedHunks.push({ path: file.proposal.path, hunk: 'all', newLines: file.hunks.flatMap(hunk => hunk.newLines) });
					this._sanction(file.proposal.path);
				}
				break;
			}
			case 'rejectAll':
				this.changeSet.rejectAll();
				break;
			case 'stop':
				this.stopped = true;
				if (this._runId) {
					this.controlPlane.stop(this._runId);
				}
				this._cancellation.cancel();
				break;
			case 'pause':
				if (this._runId) {
					this.controlPlane.pause(this._runId);
				}
				break;
			case 'resume':
				if (this._runId) {
					this.controlPlane.resume(this._runId);
				}
				break;
			case 'steer':
				if (this._runId) {
					this.controlPlane.redirect(this._runId, action.instruction);
				}
				break;
			case 'closeTarget':
				this._close(this.episode.target);
				break;
			case 'reopenTarget':
				await this._open(this.episode.target);
				break;
			case 'switchFile':
				await this._open(action.path);
				break;
			case 'save':
			case 'autosaveTick':
				if (this._references.has(this.episode.target)) {
					// Saving a clean model writes nothing; only a dirty save changes what the user sanctioned on disk.
					const wasDirty = this._textFileService.isDirty(this._uri(this.episode.target));
					await this._textFileService.save(this._uri(this.episode.target));
					const saved = this.buffer(this.episode.target);
					if (wasDirty && saved !== undefined) {
						this.sanctionedDisk.set(this.episode.target, saved);
					}
				}
				break;
			case 'undo': {
				const model = this._modelService.getModel(this._uri(this.episode.target));
				if (model) {
					model.undo();
					this.sanctionedBuffer.set(this.episode.target, model.getValue());
				}
				break;
			}
			case 'dialog':
				this.dialogs.decideNext(action.decision);
				break;
			case 'reload':
				// A window reload drops every live buffer; the disk and the persisted staged set survive.
				for (const path of [...this._references.keys()]) {
					this._close(path);
				}
				break;
		}
	}

	/** After an accept, what the buffer now holds is what the user sanctioned; an accepted create sanctions the disk. */
	private _sanction(path: string): void {
		const buffer = this.buffer(path);
		if (buffer !== undefined) {
			this.sanctionedBuffer.set(path, buffer);
		} else {
			this.disk(path).then(content => { if (content !== undefined) { this.sanctionedDisk.set(path, content); this.sanctionedBuffer.set(path, content); } });
		}
	}

	/** Records new staged proposals since the last look, with the search text of the edit call that produced them. */
	private _observeStaging(): void {
		const files = this.changeSet.files.get();
		const lastEdit = [...this.tools.invocations].reverse().find(invocation => invocation.toolId === 'onyx_editFile');
		const search = typeof (lastEdit?.parameters as { search?: unknown } | undefined)?.search === 'string' ? (lastEdit!.parameters as { search: string }).search : undefined;
		for (const staged of files) {
			const previous = this._lastProposed.get(staged.proposal.path);
			if (previous === staged.proposal.proposed) {
				continue; // unchanged since the last look
			}
			this._lastProposed.set(staged.proposal.path, staged.proposal.proposed);
			if (previous !== undefined && staged.hunks.length <= 0) {
				continue;
			}
			this.stageEvents.push({ path: staged.proposal.path, hunks: staged.hunks.length, proposedChars: staged.proposal.proposed.length, search, baseAtStage: staged.proposal.base, proposedBefore: previous });
			this.trace.record({ kind: 'stage', path: staged.proposal.path, hunks: staged.hunks.length, ok: true });
		}
		for (const path of [...this._lastProposed.keys()]) {
			if (!files.some(staged => staged.proposal.path === path)) {
				this._lastProposed.delete(path);
			}
		}
	}

	/** Records buffer and disk changes since the last boundary and runs the checkers. */
	private async _observe(boundary: OnyxSimBoundary | 'end'): Promise<void> {
		this._observeStaging();
		for (const path of Object.keys(this.episode.files)) {
			const buffer = this.buffer(path);
			if (buffer !== undefined && this.pendingBuffer.has(path) && buffer === this.sanctionedBuffer.get(path)) {
				this.pendingBuffer.delete(path); // the editor reloaded the disk change
			}
			const disk = await this.disk(path);
			const bufferKey = `buffer:${path}`;
			const diskKey = `disk:${path}`;
			const bufferDigest = buffer === undefined ? 'closed' : digest(buffer);
			const diskDigest = disk === undefined ? 'missing' : digest(disk);
			if (this._lastDigests.get(bufferKey) !== bufferDigest) {
				this._lastDigests.set(bufferKey, bufferDigest);
				this.trace.record({ kind: 'buffer', path, digest: bufferDigest, cause: boundary });
			}
			if (this._lastDigests.get(diskKey) !== diskDigest) {
				this._lastDigests.set(diskKey, diskDigest);
				this.trace.record({ kind: 'disk', path, digest: diskDigest, cause: boundary });
			}
		}
		for (const checker of this._checkers) {
			const violation = checker(this, boundary);
			if (violation) {
				const [invariant, ...rest] = violation.split(': ');
				const detail = rest.join(': ');
				if (!this._violations.some(existing => existing.invariant === invariant && existing.detail === detail)) {
					this._violations.push({ invariant, detail, boundary });
					this.trace.record({ kind: 'violation', invariant, detail });
				}
			}
		}
	}

	// --- running -----------------------------------------------------------

	async run(): Promise<IOnyxSimResult> {
		for (const [path, content] of Object.entries(this.episode.files)) {
			await this._fileService.writeFile(this._uri(path), VSBuffer.fromString(content));
			this.sanctionedBuffer.set(path, content);
			this.sanctionedDisk.set(path, content);
		}
		await this._open(this.episode.target);
		this.runtime.announce();
		await this._languageModels.refresh();
		await this._observe('afterRun');

		const request: IChatAgentRequest = {
			sessionResource: URI.parse('onyx-sim://session/1'),
			requestId: 'request-1',
			agentId: 'onyx',
			message: this.episode.prompt,
			variables: { variables: [] },
			location: ChatAgentLocation.Chat,
			userSelectedModelId: `onyx:${SIM_MODEL_KEY}`,
		};
		const progress = (_parts: IChatProgress[]) => { };
		let status = 'unknown';
		const watchdog = timeout(WATCHDOG_MS).then(() => {
			if (!this._completed) {
				this.trace.record({ kind: 'fault', fault: 'watchdog', detail: `no completion within ${WATCHDOG_MS} ms of virtual time` });
				this.stopped = true;
				if (this._runId) {
					this.controlPlane.stop(this._runId);
				}
				this._cancellation.cancel();
			}
		});
		try {
			const result = await this._loop.run(request, progress, [], this._cancellation.token);
			this._completed = true;
			const run = this._runId ? this.controlPlane.getRun(this._runId) : undefined;
			status = run ? run.status.get() : result.errorDetails ? 'failed' : 'completed';
		} catch (error) {
			this._completed = true;
			status = `threw: ${error instanceof Error ? error.message : String(error)}`;
		}
		// Fire-and-forget work after a run (risk badges, verification) settles on virtual time.
		await timeout(1000);
		await watchdog;
		await this._observe('end');
		for (const message of this._languageModels.streamErrors) {
			this.trace.record({ kind: 'fault', fault: 'streamError', detail: message });
		}
		this.trace.record({ kind: 'complete', status, turns: this.runtime.requests.length });
		return {
			episode: this.episode,
			trace: this.trace.render(),
			violations: this._violations,
			status,
			turns: this.runtime.requests.length,
			boundaries: this._boundaries,
		};
	}

	async dispose(): Promise<void> {
		// The text file model manager refuses to drop a dirty model (it parks a
		// listener until the model is saved or reverted) and one mid-save. The
		// rig owns every model it resolved: let a pending save settle, discard
		// unsaved buffer text without touching the disk, release the editors'
		// references, then dispose what the manager still holds.
		for (const model of this._textFileService.files.models) {
			await model.joinState(TextFileEditorModelState.PENDING_SAVE);
			if (model.isDirty()) {
				await model.revert({ soft: true });
			}
		}
		for (const path of [...this._references.keys()]) {
			this._close(path);
		}
		await timeout(0);
		for (const model of this._textFileService.files.models) {
			model.dispose();
		}
		this._cancellation.dispose();
		this._disposables.dispose();
	}
}

/** The part of a user action worth a trace line, without its full text. */
function describeAction(action: OnyxSimUserAction): string | undefined {
	switch (action.kind) {
		case 'typeInTarget': return `${digest(action.text)}@${action.line}`;
		case 'acceptHunk':
		case 'rejectHunk': return `${action.path}#${action.hunk}`;
		case 'switchFile': return action.path;
		case 'steer': return digest(action.instruction);
		case 'dialog': return action.decision;
		default: return undefined;
	}
}
