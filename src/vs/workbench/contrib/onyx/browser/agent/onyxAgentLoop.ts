/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { toErrorMessage } from '../../../../../base/common/errorMessage.js';
import { MarkdownString } from '../../../../../base/common/htmlContent.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IOnyxRuntimeService, OnyxStreamEnding } from '../../../../../platform/onyxRuntime/common/onyxRuntime.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { localize } from '../../../../../nls.js';
import { ChatMessageRole, IChatMessage, IChatMessagePart, IChatResponseToolUsePart, ILanguageModelChatMetadata, ILanguageModelsService } from '../../../chat/common/languageModels.js';
import { IChatProgress } from '../../../chat/common/chatService/chatService.js';
import { IChatAgentHistoryEntry, IChatAgentRequest, IChatAgentResult } from '../../../chat/common/participants/chatAgents.js';
import { ILanguageModelToolsService, IToolData } from '../../../chat/common/tools/languageModelToolsService.js';
import { IOnyxBudgetedMessage, IOnyxTurnPlan, isContextOverflowError, OnyxBudgetedKind, outputCapTokens, planTurn } from '../../common/onyxContextBudget.js';
import { elideMiddle } from '../../common/onyxContextCompression.js';
import { runtimeEnforcesSchema } from '../../common/onyxDatasheet.js';
import { IOnyxResolvedHarness } from '../../common/onyxHarnessConfig.js';
import { buildToolEnvelopeFormat, OnyxEnvelopeAnswerStream, parseToolEnvelope, toolEnvelopeInstruction, unwrapEnvelopeParameters, ONYX_ANCHORED_EDIT_TOOL } from '../../common/onyxConstrainedToolCalls.js';
import { IOnyxAssistantTextStream, OnyxAssistantTextStream, OnyxPlainTextStream } from '../../common/onyxTextToolCalls.js';
import { classifyStreamEnd, digestValue, IOnyxTraceHeader, IOnyxTraceToolCall, ONYX_TRACE_VERSION, traceDigest } from '../../common/onyxTrace.js';
import { IOnyxPlaybookService } from '../playbooks/onyxPlaybookService.js';
import { IOnyxTerminalService } from '../terminal/onyxTerminalTool.js';
import { validateToolArguments } from '../../common/onyxToolArguments.js';
import { admitTool, needsApprovalPerCall, ONYX_NETWORK_TOOLS_SETTING } from '../../common/onyxToolContract.js';
import { IOnyxToolExclusion, ONYX_MIN_EDIT_SLOTS, OnyxToolSlotSelection, requestedOptionalTools, selectToolSlots } from '../../common/onyxToolSlots.js';
import { IOnyxVerificationService } from '../verification/onyxVerificationService.js';
import { IOnyxChangeSetService } from '../changes/onyxChangeSetService.js';
import { anchorEditInstruction, anchorEditSchema, buildAnchorOffer, isAnchoredCall, ONYX_ANCHOR_LIMITS, shownFiles } from '../../common/onyxAnchorEdit.js';
import { readPromptMessages } from '../../common/onyxEditCertificate.js';
import { describeVerification } from '../../common/onyxVerification.js';
import { OnyxChangeRiskCollector } from '../intelligence/onyxChangeRiskCollector.js';
import { qualifyWorkspacePath } from '../../common/onyxWorkspacePaths.js';
import { OnyxReasoningFilter } from '../../common/onyxReasoning.js';
import { IOnyxBudgetSlice, IOnyxModelProfile, ONYX_AUTO_MODEL_ID, ONYX_VENDOR } from '../../common/onyxTypes.js';
import { IOnyxControlPlaneService, IOnyxRunHandle } from '../controlPlane/onyxControlPlaneService.js';
import { IOnyxModelService, IOnyxStreamOutcome, OnyxContextOverflowError } from '../model/onyxLanguageModelProvider.js';
import { IOnyxProjectConfigService } from '../config/onyxProjectConfigService.js';
import { IOnyxProfileService } from '../profiles/onyxProfileService.js';
import { IOnyxRouterService } from '../routing/onyxRouterService.js';
import { estimateMessageTokens, estimateTokens, IRequestTool, toWireTools } from '../model/onyxOpenAITranslator.js';
import { IOnyxHarnessConfigService } from './onyxHarnessConfigService.js';
import { IOnyxPromptCacheService } from './onyxPromptCache.js';
import { describeContextSource } from '../../common/onyxRuntimeErrors.js';
import { OnyxPromptBuilder } from './onyxPromptBuilder.js';

/** Fallback profile when the request targets a non-Onyx model, whose harness we don't manage. */
const DEFAULT_PROFILE: IOnyxModelProfile = {
	toolCallQuality: 0.9,
	contextLength: 128_000,
	maxTools: 24,
	temperature: 0.2,
	promptStyle: 'full',
	family: 'unknown',
	parameterB: undefined,
	supportsVision: false,
};

/**
 * The Onyx agent loop: prompt → model → tool calls → tool results → repeat.
 * One instance handles one chat request. Between iterations it honors the
 * control plane's gates (pause, stop, injected steering messages) and reports
 * every step so the control plane can show what is happening and why.
 */
export class OnyxAgentLoop {

	constructor(
		@ILanguageModelsService private readonly _languageModelsService: ILanguageModelsService,
		@ILanguageModelToolsService private readonly _toolsService: ILanguageModelToolsService,
		@IOnyxModelService private readonly _onyxModelService: IOnyxModelService,
		@IOnyxRouterService private readonly _routerService: IOnyxRouterService,
		@IOnyxControlPlaneService private readonly _controlPlaneService: IOnyxControlPlaneService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@IWorkspaceContextService private readonly _workspaceService: IWorkspaceContextService,
		@IOnyxRuntimeService private readonly _runtimeService: IOnyxRuntimeService,
		@IOnyxProfileService private readonly _profileService: IOnyxProfileService,
		@IOnyxPromptCacheService private readonly _promptCacheService: IOnyxPromptCacheService,
		@IOnyxProjectConfigService private readonly _projectConfigService: IOnyxProjectConfigService,
		@IOnyxPlaybookService private readonly _playbookService: IOnyxPlaybookService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IOnyxTerminalService private readonly _terminalService: IOnyxTerminalService,
		@ILogService private readonly _logService: ILogService,
		@IOnyxHarnessConfigService private readonly _harnessConfigService: IOnyxHarnessConfigService,
		@IOnyxVerificationService private readonly _verificationService: IOnyxVerificationService,
		@IOnyxChangeSetService private readonly _changeSetService: IOnyxChangeSetService,
	) { }

	async run(request: IChatAgentRequest, progress: (parts: IChatProgress[]) => void, history: readonly IChatAgentHistoryEntry[], requestToken: CancellationToken): Promise<IChatAgentResult> {
		// The chat stack only caches a vendor's models once something has asked
		// for them — usually the model picker. On a cold window nothing has, and
		// the request would fail with "provider is not registered" before any
		// inference happened. Resolving here makes the first chat of a fresh
		// install behave like every one after it.
		await this._languageModelsService.selectLanguageModels({ vendor: ONYX_VENDOR });

		const modelIdentifier = this._resolveModelIdentifier(request);
		if (!modelIdentifier) {
			return { errorDetails: { message: 'No local model available. Start a local runtime (Ollama, LM Studio, llama.cpp, vLLM) or configure onyx.endpoints, then try again.' } };
		}
		const metadata = this._languageModelsService.lookupLanguageModel(modelIdentifier);
		const profile = this._profileFor(modelIdentifier);

		const task = this._routerService.classify([{ role: ChatMessageRole.User, content: [{ type: 'text', value: request.message }] }]);
		const run = this._controlPlaneService.beginRun({
			sessionResource: request.sessionResource,
			requestId: request.requestId,
			title: request.message.slice(0, 80),
			task,
			modelKey: modelIdentifier,
			request: request.message,
			token: requestToken,
		});
		// From here on the run's own token is the one everything takes (B10): it is cancelled by the request's
		// token and by Stop alike, so inference, tools, dialogs and commands all end with the run.
		const token = run.token;
		this._controlPlaneService.updateCompute({ modelKey: modelIdentifier, inFlight: true });

		// Journal the git HEAD so a later resume can tell whether the workspace
		// moved underneath the interrupted run. Not awaited: metadata only.
		const firstFolder = this._workspaceService.getWorkspace().folders[0];
		if (firstFolder) {
			this._runtimeService.gitCommitCandidates(firstFolder.uri.fsPath, 1)
				.then(commits => { if (commits[0]) { run.snapshot({ resumeMeta: { head: commits[0].hash } }); } })
				.catch(() => { /* no git, no head to record */ });
		}

		try {
			return await this._runLoop(request, progress, history, token, modelIdentifier, metadata, profile, run);
		} catch (err) {
			// Asked before the run is ended: ending it any way but completing cancels its token.
			const stopped = token.isCancellationRequested;
			run.complete(stopped ? 'cancelled' : 'failed');
			if (stopped) {
				return {};
			}
			this._logService.warn('[onyx] agent loop failed', err);
			return { errorDetails: { message: toErrorMessage(err) } };
		} finally {
			this._changeSetService.setPromptEvidence(run.runId, undefined);
			this._controlPlaneService.updateCompute({ inFlight: false });
		}
	}

	private async _runLoop(
		request: IChatAgentRequest,
		progress: (parts: IChatProgress[]) => void,
		history: readonly IChatAgentHistoryEntry[],
		token: CancellationToken,
		modelIdentifier: string,
		metadata: ILanguageModelChatMetadata | undefined,
		modelProfile: IOnyxModelProfile,
		run: ReturnType<IOnyxControlPlaneService['beginRun']>,
	): Promise<IChatAgentResult> {
		// The harness configuration (L4): every decision below about how this run talks to the model is read
		// from it. The profile and the runtime's facts produce it; a lab manifest may change it, in a
		// development build only.
		const modelKey = modelIdentifier.startsWith(`${ONYX_VENDOR}:`) ? modelIdentifier.slice(ONYX_VENDOR.length + 1) : modelIdentifier;
		// Whether the runtime enforces a schema: what the model's datasheet measured when there is one (L5),
		// and otherwise what a runtime of its kind is assumed to do.
		const harness = await this._harnessConfigService.resolve(modelProfile, { runtimeEnforcesSchema: runtimeEnforcesSchema(modelProfile, this._onyxModelService.getKnownModel(modelKey)?.discovered.supportsJsonSchema) });
		const configuration = harness.configuration;
		if (harness.requested) {
			run.activity(harness.refused
				? { kind: 'note', label: 'A lab harness configuration was requested and not applied', reason: `${harness.requested.name} (${harness.requested.manifest}): ${harness.refused}. This run uses the default configuration.`, ok: false }
				: { kind: 'note', label: 'This run uses a lab harness configuration', reason: `${harness.requested.name} (${harness.requested.manifest}), hash ${harness.hash}` });
		}
		// What the prompt builder and the slot policy are given: the model's profile, with the fields the
		// configuration decides taken from the configuration.
		const profile: IOnyxModelProfile = { ...modelProfile, promptStyle: configuration.promptStyle, contextLength: configuration.contextTokens, maxTools: configuration.maxTools };
		const running = this._harnessConfigService.begin(request.requestId, configuration);
		try {
			return await this._runConfigured(request, progress, history, token, modelIdentifier, modelKey, metadata, profile, harness, run);
		} finally {
			running.dispose();
		}
	}

	private async _runConfigured(
		request: IChatAgentRequest,
		progress: (parts: IChatProgress[]) => void,
		history: readonly IChatAgentHistoryEntry[],
		token: CancellationToken,
		modelIdentifier: string,
		modelKey: string,
		metadata: ILanguageModelChatMetadata | undefined,
		profile: IOnyxModelProfile,
		harness: IOnyxResolvedHarness,
		run: ReturnType<IOnyxControlPlaneService['beginRun']>,
	): Promise<IChatAgentResult> {
		const configuration = harness.configuration;
		const selection = this._selectTools(request, metadata, profile);
		if (selection.kind === 'refused') {
			// An editing agent with part of its tool set looks usable and is not
			// (R-36): say which capability is missing and why, and run nothing.
			run.activity({ kind: 'note', label: 'Agent run refused: an essential tool is unavailable', reason: selection.message, ok: false });
			run.complete('failed');
			return {
				errorDetails: {
					message: localize('onyx.agent.missingEssentialTools', "This agent run was not started because it needs {0}. Onyx does not run an editing agent with part of its tool set; enable what is missing and try again.",
						selection.missing.map(entry => localize('onyx.agent.missingEssentialTool', "{0} ({1})", entry.name, entry.reason)).join(', ')),
				},
			};
		}
		const tools: IRequestTool[] = selection.tools.map(tool => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }));
		const toolIdsByName = new Map(selection.tools.map(tool => [tool.name, tool.id]));
		if (selection.kind === 'read-only') {
			run.activity({ kind: 'note', label: 'Read-only run', reason: selection.reason });
			progress([{ kind: 'markdownContent', content: new MarkdownString(localize('onyx.agent.readOnlyRun', "This model's profile has room for {0} tools and agent editing needs {1}, so this run can read the workspace but cannot propose edits or run commands.\n\n", selection.tools.length, ONYX_MIN_EDIT_SLOTS)) }]);
		}

		// Grammar-constrained tool calling: when the configuration says so (a model that keeps mangling the
		// tool_calls channel, on a runtime that can enforce a JSON schema), every turn is constrained to the
		// tool/answer envelope. A constrained turn can be wrong, but it cannot be malformed. A run with no
		// tools has no call to constrain.
		const constrained = tools.length > 0 && configuration.toolCallProtocol === 'constrained-envelope';
		// Whether a call the model wrote as text is recognised and run. Only the bare native protocol does not.
		const repairsText = configuration.toolCallProtocol !== 'native';
		// Constrained anchors (L7, experimental, a lab arm): the anchors of an edit are chosen from an
		// enumeration, which means something only where a schema is decoded against and the runtime was
		// measured to enforce it. Without either the protocol is unavailable, and the run says so.
		const anchorsUnavailable = configuration.editProtocol !== 'constrained-anchors' ? undefined
			: !constrained ? 'this run does not decode against a schema (its tool-call protocol is not constrained-envelope)'
				: !(profile.runtimeEnforcesSchema === true && profile.provenance?.schemaEnforcement === 'measured') ? 'the model\'s datasheet does not show that the runtime enforces an enumeration; measure the model first'
					: !tools.some(tool => tool.name === ONYX_ANCHORED_EDIT_TOOL) ? 'the edit tool is not part of this run' : undefined;
		const anchors = configuration.editProtocol === 'constrained-anchors' && anchorsUnavailable === undefined;
		if (configuration.editProtocol === 'constrained-anchors') {
			run.activity(anchors
				? { kind: 'note', label: 'Constrained anchors are on (experimental)', reason: `an edit may name its first and last line from the lines read this turn, up to ${ONYX_ANCHOR_LIMITS.maxAnchors} of them` }
				: { kind: 'note', label: 'Constrained anchors are unavailable; edits use search and replace', reason: anchorsUnavailable, ok: false });
		}
		run.activity({ kind: 'route', label: modelIdentifier, reason: `${tools.length} tools exposed, ${configuration.promptStyle} prompt${constrained ? ', constrained decoding' : ''}` });

		// Trace v2 header (L3): what this run was configured with, so a result can be repeated.
		const known = this._onyxModelService.getKnownModel(modelKey);
		const maxTurns = configuration.turnCap;
		run.record({
			kind: 'trace',
			v: ONYX_TRACE_VERSION,
			runId: run.runId,
			startedAt: Date.now(),
			harness: this._harnessRecord(harness),
			model: { identifier: modelIdentifier, digest: known?.discovered.digest ?? null },
			runtime: { name: known?.discovered.runtime ?? 'unknown', version: known?.discovered.runtimeVersion ?? null, baseUrl: known?.discovered.baseUrl ?? '' },
			// null, not undefined: JSON drops undefined and the validator fails closed on an absent field.
			sampling: { temperature: profile.temperature ?? null, seed: profile.seed ?? null, maxTokens: outputCapTokens(configuration.contextTokens), responseFormat: constrained },
			tools: tools.map(tool => ({ name: tool.name, schemaHash: digestValue(tool.inputSchema) })),
			// The context the run is budgeted against, and what was asked, reported and verified for it (B15).
			context: {
				budgetedTokens: configuration.contextTokens, source: profile.context?.source ?? 'default',
				requestedTokens: known?.contextNumbers?.requestedTokens ?? null, reportedTokens: known?.contextNumbers?.reportedTokens ?? known?.discovered.serverContextLength ?? null,
				verifiedTokens: known?.contextNumbers?.verifiedTokens ?? null, mechanism: known?.contextNumbers?.mechanism ?? null,
			},
		});

		const promptBuilder = this._instantiationService.createInstance(OnyxPromptBuilder);
		const built = await promptBuilder.build(request, history, profile, tools.map(t => t.name));
		run.setContextBudget(built.budget);
		const messages: IChatMessage[] = built.messages;
		// What each message is to the context budget (B13). The builder returns the system prompt first and the
		// request last, with earlier turns and the retrieved workspace context between; whatever the run adds
		// later is a turn.
		const kinds = new Map<IChatMessage, OnyxBudgetedKind>();
		messages.forEach((message, index) => kinds.set(message, index === 0 ? 'system' : index === messages.length - 1 ? 'request' : isWorkspaceContext(message) ? 'workspace' : 'history'));
		if (constrained) {
			// After the main system prompt, before any history: the envelope
			// instruction must match the schema the runtime will enforce.
			const instruction: IChatMessage = { role: ChatMessageRole.System, content: [{ type: 'text', value: anchors ? `${toolEnvelopeInstruction()} ${anchorEditInstruction()}` : toolEnvelopeInstruction() }] };
			messages.splice(1, 0, instruction);
			kinds.set(instruction, 'system');
		}
		// What every request carries besides its messages: the tool schemas as they go on the wire, and the
		// envelope schema when decoding is constrained.
		const schemaTokens = estimateTokens(JSON.stringify(toWireTools(tools))) + (constrained ? estimateTokens(JSON.stringify(buildToolEnvelopeFormat(tools))) : 0);
		// The context to fit in. It starts as the smallest number known for the model and only ever gets
		// smaller during a run: an overflow error teaches what does not fit.
		let contextTokens = configuration.contextTokens;
		let overflowRetried = false;

		let anyToolRan = false;

		for (let turn = 0; turn < maxTurns && !token.isCancellationRequested; turn++) {
			run.setTurnCount(turn + 1);
			run.activity({ kind: 'turn', label: `Model turn ${turn + 1}` });

			// Fit the turn before it is sent (B13, I-04): the schemas and the output cap are set aside, and
			// what is left decides how much of the conversation goes.
			const plan = this._planTurn(messages.map(message => ({ message, kind: kinds.get(message) ?? 'turn' })), schemaTokens, contextTokens);
			if (!plan.fits) {
				run.activity({ kind: 'note', label: 'The request does not fit the model\'s context', reason: `about ${plan.messageTokens + plan.schemaTokens} tokens of prompt and tool schemas against a context of ${contextTokens}, with nothing left to drop`, ok: false });
				run.complete('failed');
				return {
					errorDetails: {
						message: localize('onyx.agent.doesNotFit', "This request does not fit the model's context window: the instructions, the request and the tool schemas come to about {0} tokens, and {1} are available once room for the reply is set aside. Earlier tool results, history and workspace context were already dropped. The context is {2} tokens ({3}). Run \"Onyx: Request a Larger Model Context\" to ask the runtime for more, or shorten the request.", plan.messageTokens + plan.schemaTokens, plan.messageBudgetTokens + plan.schemaTokens, contextTokens, describeContextSource(profile.context?.source ?? 'default')),
						responseIsIncomplete: true,
					},
				};
			}
			if (plan.messages.length !== messages.length || plan.shrankNewestResults) {
				messages.splice(0, messages.length, ...plan.messages.map(entry => entry.message));
			}
			if (plan.evictedResults > 0) {
				run.activity({ kind: 'note', label: `Evicted ${plan.evictedResults} earlier tool result${plan.evictedResults === 1 ? '' : 's'} to fit the context window`, reason: `${plan.evictedCalls} call${plan.evictedCalls === 1 ? '' : 's'}, oldest first; about ${plan.messageTokens} of ${plan.messageBudgetTokens} tokens for messages are in use` });
			}
			if (plan.evictedHistory > 0 || plan.droppedWorkspaceContext) {
				run.activity({ kind: 'note', label: `Dropped ${plan.evictedHistory} earlier conversation message${plan.evictedHistory === 1 ? '' : 's'}${plan.droppedWorkspaceContext ? ' and the retrieved workspace context' : ''} to fit the context window` });
			}
			if (plan.shrankNewestResults) {
				run.activity({ kind: 'note', label: 'Cut the newest tool result further to fit the context window' });
			}
			run.setContextBudget(budgetSlices(built.budget, plan, kinds, schemaTokens));

			run.snapshot(snapshotForJournal(turn + 1, modelIdentifier, messages, tools));
			// What the model is sent this turn, uncut: the edits it stages now are certified against it (L6).
			const evidence = readPromptMessages(turn + 1, messagesForJournal(messages, value => value)).evidence;
			this._changeSetService.setPromptEvidence(run.runId, evidence);
			// The anchors on offer this turn (L7): the lines of the files the model is being shown, when they
			// fit the enumeration. When they do not, this turn's edits are free-form.
			let anchorSchema: object | undefined;
			if (anchors) {
				const offered = buildAnchorOffer(shownFiles(evidence));
				if (offered.kind === 'offer') {
					anchorSchema = anchorEditSchema(offered.offer);
				} else if (offered.kind === 'too-large') {
					run.activity({ kind: 'note', label: 'Anchored edits are not on offer this turn; search and replace is used', reason: `${offered.anchors} lines (${offered.chars} characters) were read, and the enumeration holds ${ONYX_ANCHOR_LIMITS.maxAnchors} lines and ${ONYX_ANCHOR_LIMITS.maxChars} characters` });
				}
			}
			this._promptCacheService.notePrompt(request.sessionResource.toString(), messages);

			const maxTokens = this._outputCap(plan);
			const requestOptions = constrained
				? { tools, modelOptions: { responseFormat: buildToolEnvelopeFormat(tools, anchorSchema), maxTokens } }
				: { tools, modelOptions: { maxTokens } };
			const requestDigest = digestValue(messages);
			const traceToolCalls: IOnyxTraceToolCall[] = [];
			const recordTurn = (responseText: string, finishReason: string | undefined, error: boolean, seedHonoured: boolean | undefined, ending?: OnyxStreamEnding) => run.record({
				kind: 'traceTurn',
				v: ONYX_TRACE_VERSION,
				turn: turn + 1,
				requestDigest,
				responseText: responseText.length > MAX_SNAPSHOT_CHARS ? `${responseText.slice(0, MAX_SNAPSHOT_CHARS)}… [truncated]` : responseText,
				streamEnd: classifyStreamEnd(finishReason, error, ending),
				toolCalls: traceToolCalls,
				seed: { requested: profile.seed ?? null, honoured: profile.seed === undefined ? 'unknown' : seedHonoured ?? 'unknown' },
			});
			const response = await this._languageModelsService.sendChatRequest(modelIdentifier, undefined, messages, requestOptions, token);
			const toolUses: IChatResponseToolUsePart[] = [];
			// Text streams through here rather than straight to the transcript so
			// a tool call the model wrote as prose can be recognized and executed
			// instead of shown to the user as raw JSON. Constrained turns stream
			// nothing: the whole turn is one envelope, parsed when complete.
			const showText = (text: string) => {
				if (!constrained) {
					progress([{ kind: 'markdownContent', content: new MarkdownString(text) }]);
				}
			};
			const textStream: IOnyxAssistantTextStream = repairsText ? this._createTextStream(tools.map(tool => tool.name), showText) : new OnyxPlainTextStream(showText);
			// A reasoning model's thinking is taken out before the text reaches anything that reads it (C4):
			// from `<think>` tags in the text, or from the part of its own a runtime sends it in.
			const reasoning = this._createReasoningFilter();
			// A constrained turn is one JSON object. Its answer is read out and shown as it arrives (C6); a
			// tool action shows nothing until it runs.
			const envelopeAnswer = constrained ? this._createEnvelopeAnswerStream() : undefined;
			const showAnswer = (text: string) => {
				const shown = envelopeAnswer?.push(text);
				if (shown) {
					progress([{ kind: 'markdownContent', content: new MarkdownString(shown) }]);
				}
			};
			let streamOutcome: Partial<IOnyxStreamOutcome> | undefined;
			try {
				for await (const part of response.stream) {
					for (const item of Array.isArray(part) ? part : [part]) {
						if (item.type === 'text') {
							const answer = reasoning.push(item.value);
							if (answer) {
								textStream.append(answer);
								showAnswer(answer);
							}
						} else if (item.type === 'thinking') {
							reasoning.addReasoning(Array.isArray(item.value) ? item.value.join('') : item.value);
						} else if (item.type === 'tool_use') {
							toolUses.push(item);
						}
					}
				}
				streamOutcome = await response.result as Partial<IOnyxStreamOutcome> | undefined;
			} catch (err) {
				recordTurn(textStream.finish().raw, undefined, true, undefined);
				if (!overflowRetried && !token.isCancellationRequested && (err instanceof OnyxContextOverflowError || (err instanceof Error && isContextOverflowError(err.message)))) {
					// The runtime allocated less than the numbers said. What was just sent is now known not to
					// fit: budget against that, which drops earlier results, and send this turn once more.
					overflowRetried = true;
					const rejectedTokens = plan.messageTokens + plan.schemaTokens;
					contextTokens = Math.max(1, Math.min(contextTokens - 1, rejectedTokens));
					this._profileService.reportContextOverflow(modelKey, contextTokens);
					run.activity({ kind: 'note', label: 'The runtime rejected the prompt as too long', reason: `it was about ${rejectedTokens} tokens; budgeting this model at ${contextTokens} tokens from now on and retrying once`, ok: false });
					turn--;
					continue;
				}
				throw err;
			}

			// Stop during the stream (B10, R-15): whatever the reply held, a tool call included, is not acted on.
			if (token.isCancellationRequested) {
				recordTurn(textStream.finish().raw, 'cancelled', false, undefined, 'cancelled');
				run.complete('cancelled');
				return {};
			}

			// A reply that was cut off or went silent is not a reply (B12, I-11). Whatever arrived of it stays
			// visible as it streamed; none of it is parsed for a tool call, run, staged or called complete.
			const thought = reasoning.finish();
			if (thought.text) {
				textStream.append(thought.text);
				showAnswer(thought.text);
			}
			if (thought.reasoning) {
				// Shown, and that is all: it is not parsed, not run and not sent back to the model.
				run.activity({ kind: 'note', label: 'Model reasoning', reason: elideMiddle(thought.reasoning, MAX_REASONING_NOTE_CHARS) });
			}
			// Thinking that was opened and never closed means the reply stopped before its answer, whatever
			// the stream said about how it ended: the output cap can cut a model off mid-thought.
			const incomplete = this._incompleteEnding(streamOutcome) ?? (thought.unterminated ? 'thinking' : undefined);
			if (incomplete) {
				recordTurn(textStream.finish().raw, streamOutcome?.finishReason, false, streamOutcome?.seedHonoured, incomplete === 'thinking' ? 'truncated' : incomplete);
				run.activity({
					kind: 'note',
					label: incomplete === 'stalled' ? 'The model stopped responding' : incomplete === 'thinking' ? 'The model\'s reply ended while it was still thinking' : 'The model\'s reply was cut off before it finished',
					reason: incomplete === 'stalled'
						? 'nothing arrived within the deadline and the request was stopped; nothing from this reply was run or staged'
						: incomplete === 'thinking'
							? 'its reasoning was never closed, so there is no answer; nothing from this reply was run or staged'
							: 'the stream ended without a finish signal; nothing from this reply was run or staged',
					ok: false,
				});
				run.complete('failed');
				return {
					errorDetails: {
						message: incomplete === 'stalled'
							? localize('onyx.agent.replyStalled', "The model stopped sending anything, so the request was stopped. Nothing from that reply was run or staged. Check that the runtime is still running, then send the request again.")
							: incomplete === 'thinking'
								? localize('onyx.agent.replyStillThinking', "The model's reply ended while it was still thinking, before it gave an answer. Nothing from that reply was run or staged. A reasoning model can use its whole output allowance on thinking; send the request again, or use a model with a larger context.")
								: localize('onyx.agent.replyTruncated', "The model's reply ended before it was finished: the connection closed without a finish signal. Nothing from that reply was run or staged. You can send the request again."),
						responseIsIncomplete: true,
					},
				};
			}

			let { text: assistantText, toolCall: textToolCall, raw: rawTurnText } = textStream.finish();
			if (constrained && toolUses.length === 0) {
				// Against the RAW turn, not the prose left over after the
				// text-repair path recognized the envelope as a tool call:
				// `{"action":"tool","tool":…}` satisfies both parsers, so
				// reading `assistantText` here scored every successful
				// constrained turn as a malformed one — on the timeline and in
				// the model's constrained-failure rate.
				const envelope = parseToolEnvelope(rawTurnText, tools.map(tool => tool.name));
				this._profileService.reportConstrainedOutcome(modelKey, envelope.kind !== 'invalid');
				if (envelope.kind === 'tool') {
					assistantText = '';
					textToolCall = undefined;
					toolUses.push({ type: 'tool_use', name: envelope.name, toolCallId: `onyx_constrained_${turn}`, parameters: envelope.parameters });
				} else if (envelope.kind === 'answer') {
					assistantText = envelope.text;
					textToolCall = undefined;
					// Most of the answer was shown as it streamed; what is left is whatever was not.
					const shown = envelopeAnswer?.shown ?? '';
					const rest = assistantText.startsWith(shown) ? assistantText.slice(shown.length) : shown ? '' : assistantText;
					if (rest) {
						progress([{ kind: 'markdownContent', content: new MarkdownString(rest) }]);
					}
				} else {
					// Degrade honestly: show what the model said instead of guessing. If an answer was already
					// streaming, it has been shown and is not repeated as raw JSON.
					run.activity({ kind: 'note', label: 'Constrained turn did not match the envelope', ok: false });
					if (assistantText && !envelopeAnswer?.shown) {
						progress([{ kind: 'markdownContent', content: new MarkdownString(assistantText) }]);
					}
				}
			}
			if (textToolCall && toolUses.length === 0) {
				run.activity({ kind: 'note', label: `Repaired a tool call the model wrote as text`, reason: textToolCall.name });
				toolUses.push({ type: 'tool_use', name: textToolCall.name, toolCallId: `onyx_text_call_${turn}`, parameters: textToolCall.parameters });
			}

			const assistantParts: IChatMessagePart[] = [];
			if (assistantText) {
				assistantParts.push({ type: 'text', value: assistantText });
			}
			assistantParts.push(...toolUses);
			if (assistantParts.length) {
				messages.push({ role: ChatMessageRole.Assistant, content: assistantParts });
			}

			if (toolUses.length === 0) {
				recordTurn(assistantText, streamOutcome?.finishReason, false, streamOutcome?.seedHonoured);
				if (configuration.verificationFeedback) {
					this._reportVerification(run, anyToolRan);
				}
				run.complete('completed');
				return {};
			}

			for (const rawToolUse of toolUses) {
				if (token.isCancellationRequested) {
					break;
				}
				anyToolRan = true;
				// Some models wrap the constrained envelope inside a native tool
				// call; the intent is unambiguous, so it is unwrapped, not failed.
				const unwrapped = unwrapEnvelopeParameters(rawToolUse.name, rawToolUse.parameters, tools.map(t => t.name));
				const toolUse: IChatResponseToolUsePart = unwrapped.name === rawToolUse.name && unwrapped.parameters === rawToolUse.parameters
					? rawToolUse
					: { ...rawToolUse, name: unwrapped.name, parameters: unwrapped.parameters };
				const { text: resultText, ok } = await this._invokeTool(request, toolUse, toolIdsByName, tools, run, progress, token, anchors ? { schema: anchorSchema } : undefined);
				run.noteToolResult(toolUse.name, resultText);
				traceToolCalls.push({ name: toolUse.name, argumentsDigest: digestValue(toolUse.parameters), resultDigest: traceDigest(resultText), ok });
				// Small models drown in raw tool output; keep head and tail
				// (signatures and errors) and mark the elided middle.
				messages.push({
					role: ChatMessageRole.User,
					content: [{ type: 'tool_result', toolCallId: toolUse.toolCallId, value: [{ type: 'text', value: elideMiddle(resultText, configuration.toolResultChars) }] }],
				});
			}
			recordTurn(assistantText, streamOutcome?.finishReason, false, streamOutcome?.seedHonoured);

			const gate = await run.gate();
			if (!gate) { // stopped via the control plane
				run.complete('cancelled');
				return {};
			}
			for (const steer of gate.steerMessages) {
				run.activity({ kind: 'steer', label: 'User redirected the agent', reason: steer });
				messages.push({ role: ChatMessageRole.User, content: [{ type: 'text', value: `[Steering instruction from the user] ${steer}` }] });
			}
		}

		// Out of turns is its own ending: the run did not finish, and nobody stopped it (B10).
		const stopped = token.isCancellationRequested;
		run.complete(stopped ? 'cancelled' : 'budget-exhausted');
		return stopped ? {} : { errorDetails: { message: `Stopped after the maximum of ${maxTurns} agent turns.`, responseIsIncomplete: true } };
	}

	/**
	 * Verification-lite: after a run that changed things, compare the
	 * workspace's error markers against the pre-run baseline and put the
	 * verdict on the timeline. Honest and local — no claims beyond what the
	 * language services actually report.
	 */
	/**
	 * What the end of a tool-using run can say about verification (C2): only
	 * that nothing was verified, when its edits are staged and not accepted.
	 * The file does not hold them yet, so the diagnostics on record are not
	 * about them. Verification runs when a hunk is accepted, on the content
	 * that was accepted (`OnyxVerificationService`).
	 */
	protected _reportVerification(run: IOnyxRunHandle, anyToolRan: boolean): void {
		if (!anyToolRan) {
			return;
		}
		for (const result of this._verificationService.results.get()) {
			if (result.state === 'not applied' && this._changeSetService.files.get().some(file => file.proposal.path === result.path && file.runId === run.runId)) {
				run.activity({ kind: 'note', label: describeVerification(result), ok: undefined, location: { path: result.path, line: 1 } });
			}
		}

		// Risk badges for whatever the run left uncommitted, so the user knows
		// how carefully to read the diff before accepting it. Not awaited: the
		// response must not wait on git or the language services.
		this._reportChangeRisk(run).catch(err => this._logService.warn('[onyx] change-risk annotation failed', err));
	}

	private async _reportChangeRisk(run: ReturnType<IOnyxControlPlaneService['beginRun']>): Promise<void> {
		const folders = this._workspaceService.getWorkspace().folders;
		const folderRefs = folders.map(f => ({ name: f.name, index: f.index }));
		const collector = this._instantiationService.createInstance(OnyxChangeRiskCollector);
		const badges: { path: string; level: string; reason: string; score: number }[] = [];
		for (const folder of folders) {
			const diff = await this._runtimeService.gitDiff(folder.uri.fsPath, 'head', 200_000);
			if (!diff.text.trim()) {
				continue;
			}
			for (const risk of await collector.collect(folder, diff.text)) {
				badges.push({ ...risk, path: qualifyWorkspacePath(folderRefs, folder.index, risk.path) });
			}
		}
		// A calm cap: the riskiest few files, never a wall of badges.
		for (const badge of badges.sort((a, b) => b.score - a.score).slice(0, 5)) {
			run.activity({
				kind: 'note',
				label: `${badge.path} · ${badge.level} risk`,
				reason: badge.reason,
				ok: badge.level === 'low' ? true : undefined,
				location: { path: badge.path, line: 1 },
			});
		}
	}

	/** What the trace says the run was configured with: the configuration itself, its hash, and where it came from (L4). */
	protected _harnessRecord(harness: IOnyxResolvedHarness): IOnyxTraceHeader['harness'] {
		return {
			configurationHash: harness.hash,
			configuration: { ...harness.configuration },
			source: harness.source,
			...(harness.requested ? { requested: `${harness.requested.manifest}/${harness.requested.name}` } : {}),
			...(harness.refused ? { refused: harness.refused } : {}),
		};
	}

	/** What decides, as a reply streams, how much of it is withheld in case it is a tool call written as text. */
	protected _createTextStream(offeredToolNames: readonly string[], emit: (text: string) => void): OnyxAssistantTextStream {
		return new OnyxAssistantTextStream(offeredToolNames, emit);
	}

	/** What reads a constrained turn's answer out of its envelope while the envelope is still arriving. */
	protected _createEnvelopeAnswerStream(): OnyxEnvelopeAnswerStream {
		return new OnyxEnvelopeAnswerStream();
	}

	/** What separates a reasoning model's thinking from its answer as the reply streams. */
	protected _createReasoningFilter(): OnyxReasoningFilter {
		return new OnyxReasoningFilter();
	}

	/** What may be sent this turn, and what had to go to make it fit. */
	protected _planTurn(messages: readonly IOnyxBudgetedMessage[], schemaTokens: number, contextTokens: number): IOnyxTurnPlan {
		return planTurn({ messages, contextTokens, schemaTokens, estimate: estimateMessageTokens });
	}

	/** The output cap sent with the request: the room the plan set aside for the reply. */
	protected _outputCap(plan: IOnyxTurnPlan): number | undefined {
		return plan.maxTokens;
	}

	/** `truncated` or `stalled` when the stream's own account says the reply is incomplete; undefined otherwise. */
	protected _incompleteEnding(outcome: Partial<IOnyxStreamOutcome> | undefined): 'truncated' | 'stalled' | undefined {
		return outcome?.ending === 'truncated' || outcome?.ending === 'stalled' ? outcome.ending : undefined;
	}

	/** What is wrong with a call's arguments, against the schema the tool was advertised with. Nothing is coerced. */
	protected _argumentProblems(toolUse: IChatResponseToolUsePart, schema: object | undefined): string[] {
		return validateToolArguments(schema, toolUse.parameters);
	}

	private async _invokeTool(request: IChatAgentRequest, toolUse: IChatResponseToolUsePart, toolIdsByName: ReadonlyMap<string, string>, tools: readonly IRequestTool[], run: ReturnType<IOnyxControlPlaneService['beginRun']>, progress: (parts: IChatProgress[]) => void, token: CancellationToken, anchorOffer?: { readonly schema: object | undefined }): Promise<{ text: string; ok: boolean }> {
		const toolId = toolIdsByName.get(toolUse.name);
		if (!toolId) {
			run.activity({ kind: 'toolCall', label: toolUse.name, reason: 'unknown tool requested by the model', ok: false });
			return { text: `Error: unknown tool '${toolUse.name}'. Available tools: ${[...toolIdsByName.keys()].join(', ')}`, ok: false };
		}
		// The arguments are checked against the schema the model was shown, here, before any tool sees them
		// (B12, I-06): a call that does not match is answered and never dispatched.
		// An anchored edit (L7) is checked against this turn's enumeration: an anchor that is not on it never
		// reaches the tool, whatever the runtime let through.
		const anchored = toolUse.name === ONYX_ANCHORED_EDIT_TOOL && isAnchoredCall(toolUse.parameters);
		if (anchored && !anchorOffer?.schema) {
			run.activity({ kind: 'toolCall', label: toolUse.name, reason: 'an anchored edit was sent and none is on offer this turn', ok: false });
			return { text: `Error: an anchored edit is not available ${anchorOffer ? 'this turn: no file read this turn can be anchored on, or too much was read' : 'in this run'}. Nothing was staged. Use ${toolUse.name} with "path", "search" and "replace".`, ok: false };
		}
		const problems = this._argumentProblems(toolUse, anchored ? anchorOffer?.schema : tools.find(tool => tool.name === toolUse.name)?.inputSchema);
		if (problems.length > 0) {
			run.activity({ kind: 'toolCall', label: toolUse.name, reason: `arguments do not match the tool's schema: ${problems[0]}`, ok: false });
			return { text: `Error: the arguments for ${toolUse.name} do not match its schema: ${problems.join('; ')}. Nothing was run. Call the tool again with corrected arguments.`, ok: false };
		}
		if (token.isCancellationRequested) {
			// Stopped (B10, I-05): the call is answered, never dispatched.
			return { text: 'The run was stopped by the user before this was done. Nothing was run or changed.', ok: false };
		}
		run.activity({ kind: 'toolCall', label: toolUse.name });
		const parameters = typeof toolUse.parameters === 'object' && toolUse.parameters !== null ? toolUse.parameters : {};
		if (this._needsApprovalPerCall(toolId)) {
			// A network tool is not Onyx's to implement, so the gate stands here: one approval for this call,
			// showing the tool and the arguments it will be called with (DEC-03).
			const approved = await this._terminalService.confirmExecution({
				kind: 'network',
				subject: `Tool: ${toolUse.name} ${JSON.stringify(parameters)}`,
				configuredBy: localize('onyx.agent.networkToolsSetting', "your setting {0}", ONYX_NETWORK_TOOLS_SETTING),
				runId: run.runId,
			});
			if (token.isCancellationRequested) {
				// Stop while the dialog was open: whatever it was then answered, the call is not dispatched (B10).
				run.activity({ kind: 'toolResult', label: toolUse.name, ok: false, reason: 'the run was stopped' });
				return { text: 'The run was stopped by the user before this was done. Nothing was run or changed.', ok: false };
			}
			if (!approved) {
				run.activity({ kind: 'toolResult', label: toolUse.name, ok: false, reason: 'denied by the user' });
				return { text: `Error: the user denied this ${toolUse.name} call. Do not retry it; continue without it or ask the user.`, ok: false };
			}
		}
		try {
			const result = await this._toolsService.invokeTool({
				callId: toolUse.toolCallId || generateUuid(),
				toolId,
				parameters,
				context: { sessionResource: request.sessionResource },
				chatRequestId: request.requestId,
				userSelectedTools: request.userSelectedTools,
			}, (input, _token) => Promise.resolve(estimateTokens(input)), token);
			const text = result.content.map(part => part.kind === 'text' ? part.value : '').join('') || '(no output)';
			const failure = result.toolResultError
				? (typeof result.toolResultError === 'string' ? result.toolResultError : text)
				: undefined;
			// A failed tool is the most useful thing on the timeline, and a red
			// "editFile" with no reason is not far off saying nothing. Onyx's
			// own tools answer with a plain sentence — carry it through.
			run.activity({ kind: 'toolResult', label: toolUse.name, ok: !failure, reason: failure ? shortReason(failure) : undefined });
			if (failure) {
				this._reportToolFailure(progress, toolUse.name, failure);
			}
			return { text: failure ? `Error: ${failure}` : text, ok: !failure };
		} catch (err) {
			if (token.isCancellationRequested) {
				// The run was stopped while the tool was starting or running: that is not a failure of the tool.
				run.activity({ kind: 'toolResult', label: toolUse.name, ok: false, reason: 'the run was stopped' });
				return { text: 'The run was stopped by the user before this was done. Nothing was run or changed.', ok: false };
			}
			run.activity({ kind: 'toolResult', label: toolUse.name, ok: false, reason: shortReason(toErrorMessage(err)) });
			this._reportToolFailure(progress, toolUse.name, toErrorMessage(err));
			return { text: `Error invoking ${toolUse.name}: ${toErrorMessage(err)}`, ok: false };
		}
	}

	/**
	 * Says in the transcript that a tool did not do what its running message
	 * announced. The chat's tool UI shows only "Staging an edit to x.ts" and
	 * keeps showing it after the call fails, so without this line a run where
	 * every edit was rejected reads exactly like a run where every edit landed.
	 */
	private _reportToolFailure(progress: (parts: IChatProgress[]) => void, toolName: string, failure: string): void {
		progress([{
			kind: 'markdownContent',
			content: new MarkdownString(localize('onyx.agent.toolFailed', "`{0}` did not complete: {1}", toolName, shortReason(failure))),
		}]);
	}

	/**
	 * The tools this run advertises. Capability gating and the user's and the
	 * project's exclusions come first (`_candidateTools`); the slot policy
	 * (`selectToolSlots`) then reserves the six essential tools, fills the
	 * spare slots in the documented order, and refuses when an essential tool
	 * is unavailable.
	 */
	protected _selectTools(request: IChatAgentRequest, metadata: ILanguageModelChatMetadata | undefined, profile: IOnyxModelProfile): OnyxSelectedTools {
		return selectToolSlots({
			...this._candidateTools(request, metadata),
			maxTools: profile.maxTools,
			requested: requestedOptionalTools(request.message, this._playbookService.playbooks.get().map(entry => entry.playbook.name)),
		});
	}

	/** Every tool the core registry offers this model, before any Onyx rule is applied. */
	protected _registeredTools(metadata: ILanguageModelChatMetadata | undefined): IToolData[] {
		return [...this._toolsService.getTools(metadata)];
	}

	/** Whether one call to this tool needs its own approval, asked here because the tool is not Onyx's. */
	protected _needsApprovalPerCall(toolId: string): boolean {
		return needsApprovalPerCall(toolId);
	}

	/** Every tool the registry offers this model, split into what may be advertised and what was excluded, with the reason. */
	protected _candidateTools(request: IChatAgentRequest, metadata: ILanguageModelChatMetadata | undefined): { available: IOnyxSelectableTool[]; excluded: IOnyxToolExclusion[] } {
		const enabled = request.userSelectedTools;
		const disabledByProject = new Set(this._projectConfigService.resolved.get().config.disabledTools ?? []);
		// The capability contract comes first (B3, DEC-03): a tool that is not in the reviewed table, or whose
		// gate is not met, never becomes a candidate, whatever registered it and whatever the settings say.
		const contractOptions = { networkTools: this._configurationService.getValue<boolean>(ONYX_NETWORK_TOOLS_SETTING) === true };
		const candidates = this._registeredTools(metadata)
			.filter(tool => !!tool.modelDescription)
			.filter(tool => admitTool({ id: tool.id, name: tool.toolReferenceName ?? tool.id, source: tool.source.type === 'internal' || tool.source.type === 'extension' || tool.source.type === 'mcp' ? tool.source.type : 'other' }, contractOptions).admitted)
			// Onyx's own tools claim their names first.
			.sort((a, b) => Number(b.id.startsWith('onyx_')) - Number(a.id.startsWith('onyx_')));

		const available: IOnyxSelectableTool[] = [];
		const excluded: IOnyxToolExclusion[] = [];
		const namesTaken = new Map<string, string>();
		for (const tool of candidates) {
			const name = sanitizeToolName(tool.toolReferenceName ?? tool.id, namesTaken);
			namesTaken.set(name, tool.id);
			if (enabled && enabled[tool.id] === false) {
				excluded.push({ name, reason: 'turned off in the chat tool picker' });
			} else if (disabledByProject.has(tool.id) || disabledByProject.has(tool.toolReferenceName ?? '')) {
				excluded.push({ name, reason: 'disabled by "disabledTools" in .onyx/config.json' });
			} else {
				available.push({ id: tool.id, name, description: tool.modelDescription, inputSchema: tool.inputSchema });
			}
		}
		return { available, excluded };
	}

	private _resolveModelIdentifier(request: IChatAgentRequest): string | undefined {
		const selected = request.userSelectedModelId;
		if (selected && this._languageModelsService.lookupLanguageModel(selected)) {
			if (selected === `${ONYX_VENDOR}:${ONYX_AUTO_MODEL_ID}`) {
				const picked = this._routerService.pickModel(
					[{ role: ChatMessageRole.User, content: [{ type: 'text', value: request.message }] }],
					this._onyxModelService.getKnownModels());
				return picked ? `${ONYX_VENDOR}:${picked.key}` : undefined;
			}
			return selected;
		}
		// No explicit selection: route across the known local models.
		const picked = this._routerService.pickModel(
			[{ role: ChatMessageRole.User, content: [{ type: 'text', value: request.message }] }],
			this._onyxModelService.getKnownModels());
		return picked ? `${ONYX_VENDOR}:${picked.key}` : undefined;
	}

	private _profileFor(modelIdentifier: string): IOnyxModelProfile {
		if (modelIdentifier.startsWith(`${ONYX_VENDOR}:`)) {
			const key = modelIdentifier.slice(ONYX_VENDOR.length + 1);
			const known = this._onyxModelService.getKnownModel(key);
			if (known) {
				return known.profile;
			}
		}
		return DEFAULT_PROFILE;
	}
}

/** The message the prompt builder adds for retrieved workspace context: background, and the first thing to go when room is short. */
function isWorkspaceContext(message: IChatMessage): boolean {
	const first = message.content[0];
	return first?.type === 'text' && first.value.startsWith('[Workspace context');
}

/** The context budget as the Control Plane shows it: the builder's breakdown, with what this turn actually carries. */
function budgetSlices(built: readonly IOnyxBudgetSlice[], plan: IOnyxTurnPlan, kinds: ReadonlyMap<IChatMessage, OnyxBudgetedKind>, schemaTokens: number): IOnyxBudgetSlice[] {
	const tokensOf = (kind: OnyxBudgetedKind) => plan.messages.filter(entry => (kinds.get(entry.message) ?? 'turn') === kind).reduce((sum, entry) => sum + estimateMessageTokens(entry.message), 0);
	return built.map(slice => {
		switch (slice.category) {
			case 'toolSchemas': return { ...slice, tokens: schemaTokens };
			case 'toolResults': return { ...slice, tokens: tokensOf('turn') };
			case 'history': return { ...slice, tokens: tokensOf('history') };
			case 'workspace': return { ...slice, tokens: tokensOf('workspace') };
			default: return slice;
		}
	});
}

/** How much of a model's thinking one timeline note carries: its start and its end. */
const MAX_REASONING_NOTE_CHARS = 4000;

const MAX_SNAPSHOT_CHARS = 64 * 1024;

/**
 * A journal-ready view of exactly what a turn sent to the model: the resolved
 * identifier, every message (tool results included), and the exposed tool
 * names. Oversized message content is truncated so a runaway turn can't bloat
 * the journal.
 */
function snapshotForJournal(turn: number, modelIdentifier: string, messages: readonly IChatMessage[], tools: readonly IRequestTool[]): unknown {
	let remaining = MAX_SNAPSHOT_CHARS;
	const clip = (value: string): string => {
		const clipped = value.length > remaining ? `${value.slice(0, Math.max(0, remaining))}… [truncated]` : value;
		remaining = Math.max(0, remaining - clipped.length);
		return clipped;
	};
	return { turn, model: modelIdentifier, tools: tools.map(t => t.name), messages: messagesForJournal(messages, clip) };
}

/** A prompt's messages in the shape a journal holds them. `clip` bounds each text; the identity keeps it whole. */
function messagesForJournal(messages: readonly IChatMessage[], clip: (value: string) => string): unknown[] {
	return messages.map(message => ({
		role: message.role,
		content: message.content.map(part => {
			switch (part.type) {
				case 'text': return { type: 'text', value: clip(part.value) };
				// The call's id ties a certificate to the edit it certifies (L6).
				case 'tool_use': return { type: 'tool_use', name: part.name, toolCallId: part.toolCallId, parameters: part.parameters };
				case 'tool_result': return { type: 'tool_result', toolCallId: part.toolCallId, value: clip(part.value.map(v => v.type === 'text' ? v.value : '').join('')) };
				default: return { type: part.type };
			}
		}),
	}));
}

/** A tool that passed gating and exclusions, under the unique name the model will see. */
export interface IOnyxSelectableTool {
	readonly id: string;
	readonly name: string;
	readonly description: string;
	readonly inputSchema: IRequestTool['inputSchema'];
}

export type OnyxSelectedTools = OnyxToolSlotSelection<IOnyxSelectableTool>;

/**
 * A tool's error, trimmed to something a timeline row and one chat line can
 * hold: the first line, without the `Error:` the tools already prefix.
 */
export function shortReason(failure: string): string {
	const firstLine = failure.split('\n').find(line => line.trim().length > 0)?.trim() ?? failure.trim();
	const withoutPrefix = firstLine.replace(/^Error:\s*/i, '');
	return withoutPrefix.length > 160 ? `${withoutPrefix.slice(0, 159)}…` : withoutPrefix;
}

/** OpenAI function names must match `[a-zA-Z0-9_-]{1,64}` and be unique per request. */
function sanitizeToolName(raw: string, taken: ReadonlyMap<string, string>): string {
	let name = raw.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60) || 'tool';
	let suffix = 1;
	while (taken.has(name)) {
		name = `${name.slice(0, 56)}_${suffix++}`;
	}
	return name;
}
