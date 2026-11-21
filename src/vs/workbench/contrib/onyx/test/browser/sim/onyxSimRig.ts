/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { timeout } from '../../../../../../base/common/async.js';
import { VSBuffer } from '../../../../../../base/common/buffer.js';
import { CancellationToken, CancellationTokenSource } from '../../../../../../base/common/cancellation.js';
import { Event } from '../../../../../../base/common/event.js';
import { DisposableStore, IReference } from '../../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../../base/common/uri.js';
import { autorun } from '../../../../../../base/common/observable.js';
import { ITextModel } from '../../../../../../editor/common/model.js';
import { IModelService } from '../../../../../../editor/common/services/model.js';
import { ITextModelService, IResolvedTextEditorModel } from '../../../../../../editor/common/services/resolverService.js';
import { IConfigurationService } from '../../../../../../platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../../../../platform/configuration/test/common/testConfigurationService.js';
import { IDialogService } from '../../../../../../platform/dialogs/common/dialogs.js';
import { ExtensionIdentifier } from '../../../../../../platform/extensions/common/extensions.js';
import { FileService } from '../../../../../../platform/files/common/fileService.js';
import { IFileService } from '../../../../../../platform/files/common/files.js';
import { NullLogService } from '../../../../../../platform/log/common/log.js';
import { IEnvironmentService } from '../../../../../../platform/environment/common/environment.js';
import { IOnyxLabHarnessRequest, IOnyxRuntimeService } from '../../../../../../platform/onyxRuntime/common/onyxRuntime.js';
import { IWorkspaceContextService } from '../../../../../../platform/workspace/common/workspace.js';
import { IWorkspaceTrustManagementService } from '../../../../../../platform/workspace/common/workspaceTrust.js';
import { testWorkspace } from '../../../../../../platform/workspace/test/common/testWorkspace.js';
import { TestContextService, TestLifecycleService, TestWorkspaceTrustManagementService, TestStorageService } from '../../../../../test/common/workbenchTestServices.js';
import { ILifecycleService } from '../../../../../services/lifecycle/common/lifecycle.js';
import { workbenchInstantiationService } from '../../../../../test/browser/workbenchTestServices.js';
import { ITextFileService, TextFileEditorModelState } from '../../../../../services/textfile/common/textfiles.js';
import { ChatAgentLocation } from '../../../../chat/common/constants.js';
import { ILanguageModelsService } from '../../../../chat/common/languageModels.js';
import { IChatAgentRequest } from '../../../../chat/common/participants/chatAgents.js';
import { IChatProgress } from '../../../../chat/common/chatService/chatService.js';
import { ILanguageModelToolsService, ToolDataSource } from '../../../../chat/common/tools/languageModelToolsService.js';
import { ITaskService } from '../../../../tasks/common/taskService.js';
import { ISearchService } from '../../../../../services/search/common/search.js';
import { OnyxDiagnosticsRedactor } from '../../../common/onyxDiagnostics.js';
import { IOnyxModelProfile } from '../../../common/onyxTypes.js';
import { OnyxAgentLoop } from '../../../browser/agent/onyxAgentLoop.js';
import { IOnyxPromptCacheService, OnyxPromptCacheService } from '../../../browser/agent/onyxPromptCache.js';
import { IOnyxChangeSetService, OnyxChangeSetService } from '../../../browser/changes/onyxChangeSetService.js';
import { OnyxEditToolContribution } from '../../../browser/changes/onyxEditTool.js';
import { IOnyxEnergyService } from '../../../browser/compute/onyxEnergyService.js';
import { IOnyxProjectConfigService, OnyxProjectConfigService } from '../../../browser/config/onyxProjectConfigService.js';
import { IOnyxControlPlaneService, OnyxControlPlaneService } from '../../../browser/controlPlane/onyxControlPlaneService.js';
import { OnyxFindFilesToolContribution } from '../../../browser/intelligence/onyxFindFilesTool.js';
import { OnyxGrepToolContribution } from '../../../browser/intelligence/onyxGrepTool.js';
import { OnyxListDirectoryToolContribution } from '../../../browser/intelligence/onyxListDirectoryTool.js';
import { IOnyxMemoryService, OnyxMemoryService } from '../../../browser/intelligence/onyxMemoryService.js';
import { OnyxMemoryToolContribution } from '../../../browser/intelligence/onyxMemoryTool.js';
import { OnyxReadFileToolContribution } from '../../../browser/intelligence/onyxReadFileTool.js';
import { IOnyxWorkspaceAccessService, OnyxWorkspaceAccessService } from '../../../browser/intelligence/onyxWorkspaceAccess.js';
import { IOnyxPinService } from '../../../browser/intelligence/onyxPinService.js';
import { IOnyxEndpointSecretService } from '../../../browser/model/onyxEndpointSecrets.js';
import { IOnyxModelService, OnyxModelService } from '../../../browser/model/onyxLanguageModelProvider.js';
import { IOnyxPlaybookService } from '../../../browser/playbooks/onyxPlaybookService.js';
import { IOnyxHarnessConfigService, OnyxHarnessConfigService } from '../../../browser/agent/onyxHarnessConfigService.js';
import { IOnyxContextAllocationService, OnyxContextAllocationService } from '../../../browser/models/onyxContextAllocationService.js';
import { IInstantiationService } from '../../../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, WillSaveStateReason } from '../../../../../../platform/storage/common/storage.js';
import { OnyxProposalDocuments } from '../../../browser/changes/onyxProposalDiff.js';
import { OnyxInlineEditSession } from '../../../browser/editor/onyxInlineEditSession.js';
import { Range } from '../../../../../../editor/common/core/range.js';
import { IOnyxProfileService } from '../../../browser/profiles/onyxProfileService.js';
import { IOnyxRouterService, OnyxRouterService } from '../../../browser/routing/onyxRouterService.js';
import { IOnyxTerminalService, OnyxTerminalService, OnyxTerminalToolContribution } from '../../../browser/terminal/onyxTerminalTool.js';
import { OnyxSimBoundary, OnyxSimEpisode, OnyxSimFault, OnyxSimUserAction } from './onyxSimEpisode.js';
import { IOnyxSimCommandScript, IOnyxSimScheduler, OnyxSimDialogService, OnyxSimEnergyService, OnyxSimFileSystemProvider, OnyxSimLanguageModelsService, OnyxSimPinService, OnyxSimPlaybookService, OnyxSimProfileService, OnyxSimRuntimeService, OnyxSimSearchService, OnyxSimTaskService, OnyxSimToolsService, SIM_CLOUD_MODEL_KEY, SIM_CORE_TOOLS, SIM_MODEL_KEY, simWorkspaceUri } from './onyxSimFakes.js';
import { SIM_LINK_PATH, SIM_OUTSIDE_CANARY, SIM_OUTSIDE_PATH } from './onyxSimCanary.js';
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
	readonly search: OnyxSimSearchService;
	/** The workspace's agent memory: what later prompts will carry. */
	readonly memory: IOnyxMemoryService;
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
	/** Files whose buffer, after the whole proposal was accepted against its own base, is not the proposal. */
	readonly acceptedBufferMismatches: readonly string[];
	/** Staged proposals observed after each tool result: path, hunk count and the proposal's size. */
	readonly stageEvents: readonly { readonly path: string; readonly hunks: number; readonly proposedChars: number; readonly search: string | undefined; readonly baseAtStage: string | undefined; readonly proposedBefore: string | undefined }[];
	readonly profile: IOnyxModelProfile;
	/** The most command output the terminal service held at once, in characters, over the whole episode. */
	readonly peakRetainedOutputChars: number | undefined;
	/** Commands that were still running, not killed, after the window announced it was closing. */
	readonly commandsOutlivingWindow: readonly string[];
	/** This run's journal as a default diagnostics export would carry it; set once the run has ended. */
	readonly defaultExport: string | undefined;
	/** Every journal event the control plane recorded so far, one JSON line each. */
	readonly journalLines: readonly string[];
}

export type OnyxSimChecker = (state: IOnyxSimState, boundary: OnyxSimBoundary | 'end') => string | undefined;

/**
 * The product classes the rig instantiates. A resurrection mutant (L12)
 * replaces one of them with a test-only subclass that brings a fixed defect
 * back; nothing in the product can select one.
 */
export interface IOnyxSimProductClasses {
	readonly AgentLoop: typeof OnyxAgentLoop;
	readonly TerminalService: typeof OnyxTerminalService;
	readonly WorkspaceAccess: typeof OnyxWorkspaceAccessService;
	readonly MemoryTool: typeof OnyxMemoryToolContribution;
	readonly DiagnosticsRedactor: typeof OnyxDiagnosticsRedactor;
	readonly ModelService: typeof OnyxModelService;
	readonly ChangeSetService: typeof OnyxChangeSetService;
	readonly InlineEditSession: typeof OnyxInlineEditSession;
	readonly ControlPlaneService: typeof OnyxControlPlaneService;
}

export interface IOnyxSimRigOptions {
	readonly classes?: Partial<IOnyxSimProductClasses>;
	/** Whether the workspace is trusted (Workspace Trust). Default true; trust must change nothing about approval (R-02). */
	readonly workspaceTrusted?: boolean;
	/** A harness configuration asked for through a lab manifest (L4), and whether the product is a packaged build. */
	readonly labHarness?: { readonly request: IOnyxLabHarnessRequest; readonly packaged: boolean };
}

export interface IOnyxSimResult {
	readonly episode: OnyxSimEpisode;
	readonly trace: string;
	/** The run's journal as the outcome service would persist it. */
	readonly journal: string;
	readonly violations: readonly { readonly invariant: string; readonly detail: string; readonly boundary: string }[];
	readonly status: string;
	/** The target file's buffer when the episode ended, and how many user steps were carried out. */
	readonly targetBuffer: string | undefined;
	readonly userStepsTaken: number;
	readonly turns: number;
	readonly boundaries: number;
	/** The text of every tool result, in dispatch order. */
	readonly toolResults: readonly { readonly toolId: string; readonly text: string; readonly ok: boolean }[];
	/** The tool names each request advertised, in request order. */
	readonly advertised: readonly (readonly string[])[];
	/** What the agent loop returned to the chat: an error message when the run was refused or failed. */
	readonly errorMessage: string | undefined;
	/** Every dialog the user was shown: what it said, which buttons it offered and what the user decided. */
	readonly dialogs: readonly { readonly message: string; readonly detail: string; readonly buttons: readonly string[]; readonly decision: string }[];
	/** Every command the runtime was asked to execute, as dispatched. */
	readonly commands: readonly { readonly cwd: string; readonly command: string; readonly timeoutMs: number; readonly passEnvironment: boolean }[];
	/** The most command output the terminal service held at once, in characters. */
	readonly peakRetainedOutputChars: number | undefined;
	/** Every request as it went on the wire: estimated tokens of messages and tool schemas, and the output cap. */
	readonly requests: readonly { readonly promptTokens: number; readonly maxTokens: number | undefined; readonly text: string }[];
	/** What the loop told the profile service fits, after an overflow. */
	readonly observedContexts: readonly number[];
	/** Tasks the task service was asked to run. */
	readonly tasksRan: readonly string[];
	/** The repository configuration file as it is on disk at the end. */
	readonly projectConfigOnDisk: string | undefined;
	/** The agent memory at the end: what every later prompt in this workspace will carry. */
	readonly memoryNotes: readonly string[];
	/** Everything the first request of the follow-up run sent, when the episode has one. */
	readonly followUpPromptText: string | undefined;
}

/**
 * How long a run may take, in virtual time, before the rig calls it one that never ends on its own. Longer
 * than the longest the product itself waits for a silent request (`ONYX_STREAM_DEADLINES.firstByteMs` and
 * the window's grace, B12): a run that the product ends at its own deadline has ended on its own.
 */
const WATCHDOG_MS = 15 * 60_000;

export class OnyxSimRig implements IOnyxSimScheduler, IOnyxSimState {

	readonly trace: OnyxSimTrace;
	readonly runtime: OnyxSimRuntimeService;
	readonly dialogs: OnyxSimDialogService;
	readonly tools: OnyxSimToolsService;
	readonly changeSet: IOnyxChangeSetService;
	readonly controlPlane: IOnyxControlPlaneService;
	readonly search: OnyxSimSearchService;
	readonly tasks: OnyxSimTaskService;
	readonly memory: IOnyxMemoryService;
	private readonly _createLoop: () => OnyxAgentLoop;
	private _followUpFirstRequest: number | undefined;
	private readonly _provider: OnyxSimFileSystemProvider;
	private readonly _terminal: OnyxTerminalService;
	private readonly _lifecycle: TestLifecycleService;
	private readonly _profiles: OnyxSimProfileService;
	readonly commandsOutlivingWindow: string[] = [];
	defaultExport: string | undefined;
	private readonly _redactorClass: typeof OnyxDiagnosticsRedactor;
	readonly sanctionedBuffer = new Map<string, string>();
	readonly sanctionedDisk = new Map<string, string>();
	readonly pendingBuffer = new Map<string, string>();
	readonly typedTexts: string[] = [];
	readonly acceptedHunks: { path: string; hunk: number | 'all'; newLines: readonly string[] }[] = [];
	readonly acceptedBufferMismatches: string[] = [];
	readonly stageEvents: { path: string; hunks: number; proposedChars: number; search: string | undefined; baseAtStage: string | undefined; proposedBefore: string | undefined }[] = [];
	private readonly _lastProposed = new Map<string, string>();
	/** The generation of each file's staging at the last look: a new one is a new staging, the same one is a review that moved. */
	private readonly _lastGeneration = new Map<string, number>();
	readonly profile: IOnyxModelProfile;
	/** Every journal event the control plane recorded, as the outcome service would write it (one JSON line each). */
	readonly journalLines: string[] = [];
	stopped = false;

	private readonly _disposables = new DisposableStore();
	private readonly _fileService: IFileService;
	private readonly _modelService: IModelService;
	private readonly _textModelService: ITextModelService;
	private readonly _textFileService: ITextFileService;
	private readonly _instantiationService: IInstantiationService;
	private readonly _storageService: TestStorageService;
	private readonly _changeSetClass: typeof OnyxChangeSetService;
	private readonly _inlineEditSessionClass: typeof OnyxInlineEditSession;
	/** The product's own path service, for callers that turn a file's address into the path the tools use. */
	readonly workspaceAccess: IOnyxWorkspaceAccessService;
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
	private _prepared = false;

	constructor(readonly episode: OnyxSimEpisode, checkers: readonly OnyxSimChecker[] = [], options: IOnyxSimRigOptions = {}) {
		const classes: IOnyxSimProductClasses = { AgentLoop: OnyxAgentLoop, TerminalService: OnyxTerminalService, WorkspaceAccess: OnyxWorkspaceAccessService, MemoryTool: OnyxMemoryToolContribution, DiagnosticsRedactor: OnyxDiagnosticsRedactor, ModelService: OnyxModelService, ChangeSetService: OnyxChangeSetService, InlineEditSession: OnyxInlineEditSession, ControlPlaneService: OnyxControlPlaneService, ...options.classes };
		this._redactorClass = classes.DiagnosticsRedactor;
		this._checkers.push(...checkers);
		this.trace = new OnyxSimTrace(() => Date.now());

		const commandScript = (command: string): IOnyxSimCommandScript => {
			// A command that prints: `head -c <n> /dev/zero` gives n characters, up to four megabytes.
			const printed = /^head -c (?<chars>\d+) \/dev\/zero$/.exec(command)?.groups?.chars;
			if (printed !== undefined) {
				return { exitCode: 0, output: 'x'.repeat(Math.min(Number(printed), 4_000_000)) };
			}
			return { exitCode: 0, output: command.startsWith('cat ') ? (episode.files[command.slice(4).trim()] ?? '') : `ran: ${command}\n` };
		};
		this.runtime = this._disposables.add(new OnyxSimRuntimeService(episode.turns, episode.persona, this, this.trace, commandScript, episode.commandRefusal, episode.runtimeContextTokens, episode.constrained === true));
		this.dialogs = new OnyxSimDialogService(episode.dialogDefault, this, this.trace);
		this.tools = new OnyxSimToolsService(this, this.trace);

		const fileService = this._disposables.add(new FileService(new NullLogService()));
		this._provider = this._disposables.add(new OnyxSimFileSystemProvider());
		this._disposables.add(fileService.registerProvider(simWorkspaceUri().scheme, this._provider));
		this._fileService = fileService;
		this.search = this._disposables.add(new OnyxSimSearchService(fileService));

		const instantiationService = workbenchInstantiationService({ fileService: () => fileService }, this._disposables);
		instantiationService.stub(IWorkspaceContextService, new TestContextService(testWorkspace(simWorkspaceUri())));
		instantiationService.stub(IOnyxRuntimeService, this.runtime);
		this.runtime.labHarness = options.labHarness?.request;
		if (options.labHarness?.packaged) {
			// A packaged build: the same environment, except that it says it is built.
			const environment: IEnvironmentService = Object.create(instantiationService.get(IEnvironmentService), { isBuilt: { value: true } });
			instantiationService.stub(IEnvironmentService, environment);
		}
		instantiationService.stub(IOnyxHarnessConfigService, instantiationService.createInstance(OnyxHarnessConfigService));
		instantiationService.stub(IDialogService, this.dialogs);
		instantiationService.stub(ILanguageModelToolsService, this.tools);
		// A constrained episode is a model whose tool calls are unreliable enough to be forced into the envelope.
		const profile: IOnyxModelProfile = { toolCallQuality: episode.constrained ? 0.5 : 0.9, contextLength: 16384, maxTools: 8, temperature: 0.2, promptStyle: 'full', family: 'sim', parameterB: 7, supportsVision: false, ...episode.profile };
		this.profile = profile;
		this._profiles = new OnyxSimProfileService(profile);
		instantiationService.stub(IOnyxProfileService, this._profiles);
		// The real project config service: the episode's repository configuration is a `.onyx/config.json`
		// on the in-memory disk, read the way the product reads it.
		instantiationService.stub(IOnyxProjectConfigService, this._disposables.add(instantiationService.createInstance(OnyxProjectConfigService)));
		instantiationService.stub(IWorkspaceTrustManagementService, this._disposables.add(new TestWorkspaceTrustManagementService(options.workspaceTrusted ?? true)));
		instantiationService.stub(IOnyxEnergyService, new OnyxSimEnergyService());
		instantiationService.stub(IOnyxPinService, new OnyxSimPinService());
		instantiationService.stub(IOnyxPlaybookService, new OnyxSimPlaybookService());
		this.tasks = new OnyxSimTaskService(this.trace);
		instantiationService.stub(ITaskService, this.tasks);
		// The product's own search defaults: ignore files are honoured and symbolic links are followed. The
		// read tools must stay inside the workspace under exactly these settings.
		const configuration = instantiationService.get(IConfigurationService) as TestConfigurationService;
		configuration.setUserConfiguration('search', { useIgnoreFiles: true, followSymlinks: true, exclude: { '**/node_modules': true } });
		configuration.setUserConfiguration('files', { exclude: { '**/.git': true } });
		configuration.setUserConfiguration('editor', { wordSeparators: '`~!@#$%^&*()-=+[{]}\\|;:\'",.<>/?' });
		configuration.setUserConfiguration('onyx', { agent: { networkTools: episode.networkTools === true }, terminal: { passEnvironment: episode.passEnvironment === true } });
		this._lifecycle = instantiationService.get(ILifecycleService) as TestLifecycleService;
		instantiationService.stub(ISearchService, this.search);
		this.workspaceAccess = instantiationService.createInstance(classes.WorkspaceAccess);
		instantiationService.stub(IOnyxWorkspaceAccessService, this.workspaceAccess);
		this._instantiationService = instantiationService;
		this._storageService = instantiationService.get(IStorageService) as TestStorageService;
		this._changeSetClass = classes.ChangeSetService;
		this._inlineEditSessionClass = classes.InlineEditSession;

		this.controlPlane = this._disposables.add(new classes.ControlPlaneService());
		instantiationService.stub(IOnyxControlPlaneService, this.controlPlane);
		// No endpoint is configured in the rig, so there is no key to store or read.
		instantiationService.stub(IOnyxEndpointSecretService, { _serviceBrand: undefined, onDidChange: Event.None, setApiKey: async () => { }, configuredApiKeys: async () => new Map<string, string>() });
		// The real allocation service over the simulated runtime (B15): nothing was asked of that runtime, so
		// every model is requested under its own name at the server's allocation.
		instantiationService.stub(IOnyxContextAllocationService, this._disposables.add(instantiationService.createInstance(OnyxContextAllocationService)));
		const modelService: IOnyxModelService = this._disposables.add(instantiationService.createInstance(classes.ModelService));
		instantiationService.stub(IOnyxModelService, modelService);
		this._languageModels = new OnyxSimLanguageModelsService(modelService);
		instantiationService.stub(ILanguageModelsService, this._languageModels);
		instantiationService.stub(IOnyxRouterService, this._disposables.add(instantiationService.createInstance(OnyxRouterService)));
		instantiationService.stub(IOnyxPromptCacheService, this._disposables.add(new OnyxPromptCacheService()));
		this.memory = this._disposables.add(instantiationService.createInstance(OnyxMemoryService));
		instantiationService.stub(IOnyxMemoryService, this.memory);
		this.changeSet = this._disposables.add(instantiationService.createInstance(classes.ChangeSetService));
		instantiationService.stub(IOnyxChangeSetService, this.changeSet);
		this._terminal = this._disposables.add(instantiationService.createInstance(classes.TerminalService));
		instantiationService.stub(IOnyxTerminalService, this._terminal);
		this._disposables.add(instantiationService.createInstance(OnyxReadFileToolContribution));
		this._disposables.add(instantiationService.createInstance(OnyxListDirectoryToolContribution));
		this._disposables.add(instantiationService.createInstance(OnyxFindFilesToolContribution));
		this._disposables.add(instantiationService.createInstance(OnyxGrepToolContribution));
		this._disposables.add(instantiationService.createInstance(OnyxEditToolContribution));
		this._disposables.add(instantiationService.createInstance(OnyxTerminalToolContribution));
		this._disposables.add(instantiationService.createInstance(classes.MemoryTool));
		// What else the core registry holds: reviewed tools, network tools, excluded tools and unknown ones.
		for (const tool of SIM_CORE_TOOLS) {
			const source: ToolDataSource = tool.source === 'internal'
				? ToolDataSource.Internal
				: tool.source === 'mcp'
					? { type: 'mcp', label: 'sim', serverLabel: 'sim', instructions: undefined, collectionId: 'sim', definitionId: 'sim' }
					: { type: 'extension', label: 'sim', extensionId: new ExtensionIdentifier('sim.tools') };
			this._disposables.add(this.tools.registerTool(
				{ id: tool.id, toolReferenceName: tool.name, displayName: tool.name, modelDescription: `Simulated ${tool.name}.`, source, canBeReferencedInPrompt: true, inputSchema: { type: 'object', properties: {} } },
				{ invoke: async () => ({ content: [{ kind: 'text', value: `ran ${tool.id}` }] }) }));
		}
		this._createLoop = () => instantiationService.createInstance(classes.AgentLoop);

		this._modelService = instantiationService.get(IModelService);
		this._textModelService = instantiationService.get(ITextModelService);
		this._textFileService = instantiationService.get(ITextFileService);
		this._loop = instantiationService.createInstance(classes.AgentLoop);

		this._disposables.add(this.controlPlane.onDidRecordEvent(({ runId, event }) => {
			this.journalLines.push(JSON.stringify(event));
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

	/** The live text model of a workspace file, when it has one. */
	textModel(path: string): ITextModel | undefined {
		return this._modelService.getModel(this._uri(path)) ?? undefined;
	}

	/** Closes a file the rig had open: its text model is disposed, as when the last editor on it closes. */
	closeModel(path: string): void {
		this._close(path);
		this._modelService.getModel(this._uri(path))?.dispose();
	}

	/** The product's proposal documents (C1), over this rig's change set and text models. */
	proposalDocuments(): OnyxProposalDocuments {
		return this._disposables.add(this._instantiationService.createInstance(OnyxProposalDocuments));
	}

	/** Whether the file has unsaved changes, as the editor would show it. */
	isDirty(path: string): boolean {
		return this._textFileService.isDirty(this._uri(path));
	}

	/** Saves the file through the editor's own save, as Save or an autosave would. */
	async save(path: string): Promise<void> {
		await this._textFileService.save(this._uri(path));
	}

	/**
	 * What a window reload does to the change set: the storage is asked to
	 * save its state, and a new service is built from what was stored.
	 */
	reloadChangeSet(): IOnyxChangeSetService {
		this._storageService.testEmitWillSaveState(WillSaveStateReason.SHUTDOWN);
		return this._disposables.add(this._instantiationService.createInstance(this._changeSetClass));
	}

	/** Changes a file on the in-memory disk, as another program would. */
	async writeDisk(path: string, content: string): Promise<void> {
		await this._fileService.writeFile(this._uri(path), VSBuffer.fromString(content));
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

	get peakRetainedOutputChars(): number | undefined {
		return this._terminal.outputRetention?.peakChars;
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
					// What a clean editor still shows until it reloads. A second change on disk before it has
					// reloaded the first does not change what it shows: it is still the text from before both.
					if (previous !== undefined && !this.pendingBuffer.has(fault.path)) {
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
				// The user accepts the hunk that is on show at that place, by the id it is shown with (B7).
				const hunk = staged?.hunks[action.hunk];
				if (hunk && (await this.changeSet.acceptHunk(action.path, hunk.id)).applied) {
					this.acceptedHunks.push({ path: action.path, hunk: action.hunk, newLines: hunk?.newLines ?? [] });
					this._sanction(action.path);
				}
				break;
			}
			case 'rejectHunk': {
				const hunk = this.changeSet.files.get().find(file => file.proposal.path === action.path)?.hunks[action.hunk];
				if (hunk) {
					this.changeSet.rejectHunk(action.path, hunk.id);
				}
				break;
			}
			case 'acceptAll': {
				// File by file, as the product's accept-all does, so that what each accept came to is known.
				for (const file of [...this.changeSet.files.get()]) {
					const before = this.buffer(file.proposal.path)?.replace(/\r\n/g, '\n');
					if (!(await this.changeSet.acceptFile(file.proposal.path)).applied) {
						continue;
					}
					this.acceptedHunks.push({ path: file.proposal.path, hunk: 'all', newLines: file.hunks.flatMap(hunk => hunk.newLines) });
					// The whole proposal was accepted against the very text it was computed from: the buffer is
					// then the proposal, byte for byte (I-09, B8).
					const after = this.buffer(file.proposal.path)?.replace(/\r\n/g, '\n');
					if (before !== undefined && before === file.proposal.base && file.conflicts.length === 0 && after !== file.proposal.proposed) {
						this.acceptedBufferMismatches.push(file.proposal.path);
					}
					this._sanction(file.proposal.path);
				}
				break;
			}
			case 'rejectAll':
				this.changeSet.rejectAll();
				break;
			case 'stop':
				this.stopped = true;
				// The Stop button on the run list, and nothing else: the chat request's own token is not cancelled
				// here. That one press has to end everything the run owns (B10, R-15). Before a run exists there is
				// only the request to cancel.
				if (this._runId) {
					this.controlPlane.stop(this._runId);
				} else {
					this._cancellation.cancel();
				}
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
			case 'inlineEdit': {
				// The product's own session, from request to staged reply; the reply is the simulated model's.
				const model = await this._open(this.episode.target);
				const session = new this._inlineEditSessionClass(model, new Range(action.startLine, 1, action.endLine, model.getLineMaxColumn(action.endLine)), this.changeSet, this.workspaceAccess);
				await session.stageReply(action.reply);
				break;
			}
			case 'undo': {
				const model = this._modelService.getModel(this._uri(this.episode.target));
				if (model) {
					model.undo();
					const after = model.getValue();
					// An undo that leaves a clean buffer showing what it showed before a disk change it has not
					// reloaded yet changes nothing the user sanctioned: the disk's text is still what it will show.
					if (this.pendingBuffer.get(this.episode.target) !== after) {
						this.sanctionedBuffer.set(this.episode.target, after);
						this.pendingBuffer.delete(this.episode.target);
						// What the user undid, the user took back: a hunk they accepted earlier in this file is no
						// longer something the buffer has to hold (I-09 is about what an accept does, not an undo).
						for (let index = this.acceptedHunks.length - 1; index >= 0; index--) {
							if (this.acceptedHunks[index].path === this.episode.target) {
								this.acceptedHunks.splice(index, 1);
							}
						}
					}
				}
				break;
			}
			case 'dialog':
				this.dialogs.decideNext(action.decision);
				break;
			case 'clearLegacyGrants':
				await this.clearLegacyGrants();
				break;
			case 'closeWindow': {
				// The workbench announces the shutdown and waits for whoever joined it. A command the agent
				// started and nobody killed by then outlives its window.
				const running = this.runtime.runningCommands();
				this._lifecycle.fireShutdown();
				await Promise.allSettled(this._lifecycle.shutdownJoiners);
				for (const operationId of running) {
					if (!this.runtime.wasKilled(operationId)) {
						this.commandsOutlivingWindow.push(this.trace.canonical('op', operationId));
					}
				}
				break;
			}
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
			const sameGeneration = this._lastGeneration.get(staged.proposal.path) === staged.generation;
			this._lastProposed.set(staged.proposal.path, staged.proposal.proposed);
			this._lastGeneration.set(staged.proposal.path, staged.generation);
			if (sameGeneration) {
				// The same staging, carried onto a changed buffer or partly accepted: the review moved, nothing new was staged.
				continue;
			}
			if (previous !== undefined && staged.hunks.length <= 0) {
				continue;
			}
			this.stageEvents.push({ path: staged.proposal.path, hunks: staged.hunks.length, proposedChars: staged.proposal.proposed.length, search, baseAtStage: staged.proposal.base, proposedBefore: previous });
			this.trace.record({ kind: 'stage', path: staged.proposal.path, hunks: staged.hunks.length, ok: true });
		}
		for (const path of [...this._lastProposed.keys()]) {
			if (!files.some(staged => staged.proposal.path === path)) {
				this._lastProposed.delete(path);
				this._lastGeneration.delete(path);
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

	/** Writes the episode's files, plants the canary and opens the target: the state every run starts from. */
	async prepare(): Promise<void> {
		if (this._prepared) {
			return;
		}
		this._prepared = true;
		for (const [path, content] of Object.entries(this.episode.files)) {
			await this._fileService.writeFile(this._uri(path), VSBuffer.fromString(content));
			this.sanctionedBuffer.set(path, content);
			this.sanctionedDisk.set(path, content);
		}
		if (this.episode.projectConfig) {
			await this._fileService.writeFile(this._uri('.onyx/config.json'), VSBuffer.fromString(JSON.stringify(this.episode.projectConfig, undefined, '\t') + '\n'));
		}
		// The project config service reads the file on a short timer after it starts; let that pass.
		await timeout(400);
		// Outside the workspace root, and a symbolic link to it from inside:
		// neither may ever be read on the model's behalf (I-07, read side).
		await this._fileService.writeFile(URI.file(SIM_OUTSIDE_PATH), VSBuffer.fromString(`${SIM_OUTSIDE_CANARY}\n`));
		await this._fileService.writeFile(this._uri(SIM_LINK_PATH), VSBuffer.fromString(`${SIM_OUTSIDE_CANARY}\n`));
		this._provider.addLink(this._uri(SIM_LINK_PATH).path, SIM_OUTSIDE_PATH);
		await this._open(this.episode.target);
		this.runtime.announce();
		await this._languageModels.refresh();
	}

	/** Calls one registered tool by its reference name, outside any run: for tests of a tool's own limits and refusals. */
	async invokeTool(referenceName: string, parameters: unknown, token: CancellationToken = CancellationToken.None): Promise<{ readonly text: string; readonly ok: boolean }> {
		await this.prepare();
		const tool = this.tools.getToolByName(referenceName);
		if (!tool) {
			throw new Error(`no tool named ${referenceName} is registered in the rig`);
		}
		const result = await this.tools.invokeTool({ callId: `direct-${this.tools.invocations.length + 1}`, toolId: tool.id, parameters: parameters as Record<string, unknown>, context: undefined }, async () => 0, token);
		return { text: result.content.map(part => part.kind === 'text' ? part.value : '').join(''), ok: !result.toolResultError };
	}

	/** The user's "Clear Legacy Terminal Grants" command (B2), then time for the configuration to be read again. */
	async clearLegacyGrants(): Promise<number> {
		const cleared = await this._terminal.clearLegacyGrants();
		await timeout(400);
		return cleared;
	}

	/** Makes `path` in the workspace a symbolic link to the directory `target` outside it. */
	async linkDirectory(path: string, target: string): Promise<void> {
		await this._fileService.createFolder(URI.file(target));
		await this._fileService.createFolder(this._uri(path));
		this._provider.addLink(this._uri(path).path, target);
	}

	/** The repository's `.onyx/config.json` as it is on the in-memory disk now. */
	async projectConfigOnDisk(): Promise<string | undefined> {
		return this.disk('.onyx/config.json');
	}

	/** Types into a workspace file through its live text model, leaving it unsaved. */
	async typeInto(path: string, line: number, text: string): Promise<void> {
		await this.prepare();
		const model = await this._open(path);
		model.pushEditOperations(null, [{ range: { startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: 1 }, text }], () => null);
	}

	async run(): Promise<IOnyxSimResult> {
		await this.prepare();
		// The first `afterRun` boundary is the state before anything ran; the ones after the loop has
		// returned follow below. Until B7 this was an observation only, and no `afterRun` boundary was ever
		// raised: a user step scheduled there (accept, type, save) never happened, in the random episodes
		// and in the scripted audit scenarios alike.
		await this.boundary('afterRun');

		const request: IChatAgentRequest = {
			sessionResource: URI.parse('onyx-sim://session/1'),
			requestId: 'request-1',
			agentId: 'onyx',
			message: this.episode.prompt,
			variables: { variables: [] },
			location: ChatAgentLocation.Chat,
			userSelectedModelId: `onyx:${this.episode.selectedModel === 'cloud' ? SIM_CLOUD_MODEL_KEY : SIM_MODEL_KEY}`,
		};
		// What reaches the transcript, and when in the stream it does (C5).
		const progress = (parts: IChatProgress[]) => {
			const size = parts.reduce((total, part) => total + (part.kind === 'markdownContent' ? part.content.value.length : 0), 0);
			if (size > 0) {
				this.trace.record({ kind: 'shown', size });
			}
		};
		let status = 'unknown';
		let errorMessage: string | undefined;
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
			errorMessage = result.errorDetails?.message;
			const run = this._runId ? this.controlPlane.getRun(this._runId) : undefined;
			status = run ? run.status.get() : result.errorDetails ? 'failed' : 'completed';
		} catch (error) {
			this._completed = true;
			status = `threw: ${error instanceof Error ? error.message : String(error)}`;
		}
		// Fire-and-forget work after a run (risk badges, verification) settles on virtual time.
		await timeout(1000);
		// The user acts on what the run left: every step scheduled after the run, in the order of its occurrence.
		for (let round = 0; round < 12; round++) {
			await this.boundary('afterRun');
			await timeout(50);
			const reached = this._occurrences.get('afterRun') ?? 0;
			if (!this.episode.userSteps.some((scheduled, index) => scheduled.at === 'afterRun' && scheduled.occurrence > reached && !this._takenUserSteps.has(index))) {
				break;
			}
		}
		if (this.episode.followUpPrompt !== undefined && !this.stopped) {
			// A later request in the same workspace: its prompt is built from whatever persistent state the first run left.
			this._followUpFirstRequest = this.runtime.requests.length;
			try {
				await this._createLoop().run({ ...request, requestId: 'request-2', message: this.episode.followUpPrompt }, progress, [], this._cancellation.token);
			} catch (error) {
				this.trace.record({ kind: 'fault', fault: 'followUp', detail: error instanceof Error ? error.message : String(error) });
			}
			await timeout(1000);
		}
		await watchdog;
		// What a default diagnostics export would say about this run: the journal, through the product's redactor.
		this.defaultExport = new this._redactorClass({ includeContent: false, secrets: [] }).journal(this.journalLines.map(line => JSON.parse(line) as unknown)).text;
		await this._observe('end');
		for (const message of this._languageModels.streamErrors) {
			this.trace.record({ kind: 'fault', fault: 'streamError', detail: message });
		}
		this.trace.record({ kind: 'complete', status, turns: this.runtime.requests.length });
		return {
			episode: this.episode,
			trace: this.trace.render(),
			journal: this.journalLines.join('\n') + '\n',
			violations: this._violations,
			status,
			targetBuffer: this.buffer(this.episode.target),
			userStepsTaken: this._takenUserSteps.size,
			turns: this.runtime.requests.length,
			boundaries: this._boundaries,
			toolResults: [...this.tools.results],
			advertised: this.runtime.requests.map(request => (request.tools ?? []).map(tool => tool.function.name)),
			errorMessage,
			dialogs: [...this.dialogs.prompts],
			commands: this.runtime.commands.map(command => ({ cwd: command.cwd, command: command.command, timeoutMs: command.timeoutMs, passEnvironment: command.passEnvironment })),
			peakRetainedOutputChars: this.peakRetainedOutputChars,
			requests: this.runtime.requests.map(request => {
				const text = request.messages.map(message => String(message.content ?? '') + (message.tool_calls ?? []).map(call => call.function.name + call.function.arguments).join('')).join('\n');
				const promptChars = request.messages.reduce((total, message) => total + String(message.content ?? '').length + (message.tool_calls ?? []).reduce((sum, call) => sum + call.function.name.length + call.function.arguments.length, 0), 0);
				return { promptTokens: Math.ceil((promptChars + (request.tools?.length ? JSON.stringify(request.tools).length : 0)) / 4), maxTokens: request.maxTokens, text };
			}),
			observedContexts: [...this._profiles.observedContexts],
			tasksRan: [...this.tasks.ran],
			projectConfigOnDisk: await this.projectConfigOnDisk(),
			memoryNotes: this.memory.getNotes().map(note => note.text),
			followUpPromptText: this._followUpFirstRequest === undefined ? undefined : (this.runtime.requests[this._followUpFirstRequest]?.messages ?? []).map(message => String(message.content ?? '')).join('\n'),
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
