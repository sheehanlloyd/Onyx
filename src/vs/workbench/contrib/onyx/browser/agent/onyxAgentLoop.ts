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
import { IMarkerService, MarkerSeverity } from '../../../../../platform/markers/common/markers.js';
import { IOnyxRuntimeService, OnyxStreamEnding } from '../../../../../platform/onyxRuntime/common/onyxRuntime.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { localize } from '../../../../../nls.js';
import { ChatMessageRole, IChatMessage, IChatMessagePart, IChatResponseToolUsePart, ILanguageModelChatMetadata, ILanguageModelsService } from '../../../chat/common/languageModels.js';
import { IChatProgress } from '../../../chat/common/chatService/chatService.js';
import { IChatAgentHistoryEntry, IChatAgentRequest, IChatAgentResult } from '../../../chat/common/participants/chatAgents.js';
import { ILanguageModelToolsService, IToolData } from '../../../chat/common/tools/languageModelToolsService.js';
import { IOnyxBudgetedMessage, IOnyxTurnPlan, isContextOverflowError, OnyxBudgetedKind, outputCapTokens, planTurn } from '../../common/onyxContextBudget.js';
import { elideMiddle, toolResultBudget } from '../../common/onyxContextCompression.js';
import { buildToolEnvelopeFormat, OnyxEnvelopeAnswerStream, parseToolEnvelope, toolEnvelopeInstruction, unwrapEnvelopeParameters } from '../../common/onyxConstrainedToolCalls.js';
import { OnyxAssistantTextStream } from '../../common/onyxTextToolCalls.js';
import { classifyStreamEnd, digestValue, IOnyxTraceToolCall, ONYX_TRACE_VERSION, traceDigest } from '../../common/onyxTrace.js';
import { IOnyxPlaybookService } from '../playbooks/onyxPlaybookService.js';
import { IOnyxTerminalService } from '../terminal/onyxTerminalTool.js';
import { validateToolArguments } from '../../common/onyxToolArguments.js';
import { admitTool, needsApprovalPerCall, ONYX_NETWORK_TOOLS_SETTING } from '../../common/onyxToolContract.js';
import { IOnyxToolExclusion, ONYX_MIN_EDIT_SLOTS, OnyxToolSlotSelection, requestedOptionalTools, selectToolSlots } from '../../common/onyxToolSlots.js';
import { OnyxTaskVerification } from '../verification/onyxTaskVerification.js';
import { OnyxChangeRiskCollector } from '../intelligence/onyxChangeRiskCollector.js';
import { qualifyWorkspacePath } from '../../common/onyxWorkspacePaths.js';
import { OnyxReasoningFilter } from '../../common/onyxReasoning.js';
import { IOnyxBudgetSlice, IOnyxModelProfile, ONYX_AUTO_MODEL_ID, ONYX_VENDOR } from '../../common/onyxTypes.js';
import { IOnyxControlPlaneService } from '../controlPlane/onyxControlPlaneService.js';
import { IOnyxModelService, IOnyxStreamOutcome, OnyxContextOverflowError } from '../model/onyxLanguageModelProvider.js';
import { IOnyxProjectConfigService } from '../config/onyxProjectConfigService.js';
import { IOnyxProfileService } from '../profiles/onyxProfileService.js';
import { IOnyxRouterService } from '../routing/onyxRouterService.js';
import { estimateMessageTokens, estimateTokens, IRequestTool, toWireTools } from '../model/onyxOpenAITranslator.js';
import { IOnyxPromptCacheService } from './onyxPromptCache.js';
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
		@IMarkerService private readonly _markerService: IMarkerService,
		@IWorkspaceContextService private readonly _workspaceService: IWorkspaceContextService,
		@IOnyxRuntimeService private readonly _runtimeService: IOnyxRuntimeService,
		@IOnyxProfileService private readonly _profileService: IOnyxProfileService,
		@IOnyxPromptCacheService private readonly _promptCacheService: IOnyxPromptCacheService,
		@IOnyxProjectConfigService private readonly _projectConfigService: IOnyxProjectConfigService,
		@IOnyxPlaybookService private readonly _playbookService: IOnyxPlaybookService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IOnyxTerminalService private readonly _terminalService: IOnyxTerminalService,
		@ILogService private readonly _logService: ILogService,
	) { }

	async run(request: IChatAgentRequest, progress: (parts: IChatProgress[]) => void, history: readonly IChatAgentHistoryEntry[], token: CancellationToken): Promise<IChatAgentResult> {
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
		});
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
			run.complete(token.isCancellationRequested ? 'cancelled' : 'failed');
			if (token.isCancellationRequested) {
				return {};
			}
			this._logService.warn('[onyx] agent loop failed', err);
			return { errorDetails: { message: toErrorMessage(err) } };
		} finally {
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
		profile: IOnyxModelProfile,
		run: ReturnType<IOnyxControlPlaneService['beginRun']>,
	): Promise<IChatAgentResult> {
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

		// Grammar-constrained tool calling: when this model keeps mangling the
		// tool_calls channel but its runtime can enforce a JSON schema, every
		// turn is constrained to the tool/answer envelope — a constrained turn
		// can be wrong, but it cannot be malformed.
		const modelKey = modelIdentifier.startsWith(`${ONYX_VENDOR}:`) ? modelIdentifier.slice(ONYX_VENDOR.length + 1) : modelIdentifier;
		const constrained = tools.length > 0
			&& profile.toolCallQuality < 0.75
			&& this._onyxModelService.getKnownModel(modelKey)?.discovered.supportsJsonSchema === true;
		run.activity({ kind: 'route', label: modelIdentifier, reason: `${tools.length} tools exposed, ${profile.promptStyle} prompt${constrained ? ', constrained decoding' : ''}` });

		// Trace v2 header (L3): what this run was configured with, so a result can be repeated.
		const known = this._onyxModelService.getKnownModel(modelKey);
		const maxTurns = profile.promptStyle === 'compact' ? 8 : 16;
		const harnessConfiguration = { promptStyle: profile.promptStyle, maxTools: profile.maxTools, maxTurns, constrained, toolResultBudget: toolResultBudget(profile.promptStyle), contextLength: profile.contextLength, toolCallQuality: profile.toolCallQuality };
		run.record({
			kind: 'trace',
			v: ONYX_TRACE_VERSION,
			runId: run.runId,
			startedAt: Date.now(),
			harness: { configurationHash: digestValue(harnessConfiguration), configuration: harnessConfiguration },
			model: { identifier: modelIdentifier, digest: known?.discovered.digest ?? null },
			runtime: { name: known?.discovered.runtime ?? 'unknown', version: known?.discovered.runtimeVersion ?? null, baseUrl: known?.discovered.baseUrl ?? '' },
			// null, not undefined: JSON drops undefined and the validator fails closed on an absent field.
			sampling: { temperature: profile.temperature ?? null, seed: profile.seed ?? null, maxTokens: outputCapTokens(profile.contextLength), responseFormat: constrained },
			tools: tools.map(tool => ({ name: tool.name, schemaHash: digestValue(tool.inputSchema) })),
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
			const instruction: IChatMessage = { role: ChatMessageRole.System, content: [{ type: 'text', value: toolEnvelopeInstruction() }] };
			messages.splice(1, 0, instruction);
			kinds.set(instruction, 'system');
		}
		// What every request carries besides its messages: the tool schemas as they go on the wire, and the
		// envelope schema when decoding is constrained.
		const schemaTokens = estimateTokens(JSON.stringify(toWireTools(tools))) + (constrained ? estimateTokens(JSON.stringify(buildToolEnvelopeFormat(tools))) : 0);
		// The context to fit in. It starts as the smallest number known for the model and only ever gets
		// smaller during a run: an overflow error teaches what does not fit.
		let contextTokens = profile.contextLength;
		let overflowRetried = false;

		const errorsBefore = this._countWorkspaceErrors();
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
						message: localize('onyx.agent.doesNotFit', "This request does not fit the model's context window: the instructions, the request and the tool schemas come to about {0} tokens, and {1} are available once room for the reply is set aside. Earlier tool results, history and workspace context were already dropped. Use a model or a runtime setting with a larger context, or shorten the request.", plan.messageTokens + plan.schemaTokens, plan.messageBudgetTokens + plan.schemaTokens),
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
			this._promptCacheService.notePrompt(request.sessionResource.toString(), messages);

			const maxTokens = this._outputCap(plan);
			const requestOptions = constrained
				? { tools, modelOptions: { responseFormat: buildToolEnvelopeFormat(tools), maxTokens } }
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
			const textStream = this._createTextStream(
				tools.map(tool => tool.name),
				text => {
					if (!constrained) {
						progress([{ kind: 'markdownContent', content: new MarkdownString(text) }]);
					}
				},
			);
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
				this._reportVerification(run, errorsBefore, anyToolRan);
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
				const { text: resultText, ok } = await this._invokeTool(request, toolUse, toolIdsByName, tools, run, progress, token);
				run.noteToolResult(toolUse.name, resultText);
				traceToolCalls.push({ name: toolUse.name, argumentsDigest: digestValue(toolUse.parameters), resultDigest: traceDigest(resultText), ok });
				// Small models drown in raw tool output; keep head and tail
				// (signatures and errors) and mark the elided middle.
				messages.push({
					role: ChatMessageRole.User,
					content: [{ type: 'tool_result', toolCallId: toolUse.toolCallId, value: [{ type: 'text', value: elideMiddle(resultText, toolResultBudget(profile.promptStyle)) }] }],
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

		run.complete(token.isCancellationRequested ? 'cancelled' : 'completed');
		return token.isCancellationRequested ? {} : { errorDetails: { message: `Stopped after the maximum of ${maxTurns} agent turns.`, responseIsIncomplete: true } };
	}

	private _countWorkspaceErrors(): number {
		return this._markerService.read({ severities: MarkerSeverity.Error }).length;
	}

	/**
	 * Verification-lite: after a run that changed things, compare the
	 * workspace's error markers against the pre-run baseline and put the
	 * verdict on the timeline. Honest and local — no claims beyond what the
	 * language services actually report.
	 */
	private _reportVerification(run: ReturnType<IOnyxControlPlaneService['beginRun']>, errorsBefore: number, anyToolRan: boolean): void {
		if (!anyToolRan) {
			return;
		}
		const errorsAfter = this._countWorkspaceErrors();
		const delta = errorsAfter - errorsBefore;
		run.activity({
			kind: 'note',
			label: delta > 0
				? `Verification: ${delta} new problem${delta === 1 ? '' : 's'} (${errorsAfter} total)`
				: `Verification: no new problems (${errorsAfter} total)`,
			ok: delta <= 0,
		});

		// Project checks (Phase 4 slice): run the workspace's configured
		// build/test task and post the verdict when it finishes. Deliberately
		// not awaited — the chat response must not wait for a build.
		const taskVerification = this._instantiationService.createInstance(OnyxTaskVerification);
		if (taskVerification.enabled) {
			taskVerification.run(run).catch(err => this._logService.warn('[onyx] project checks failed', err));
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

	private async _invokeTool(request: IChatAgentRequest, toolUse: IChatResponseToolUsePart, toolIdsByName: ReadonlyMap<string, string>, tools: readonly IRequestTool[], run: ReturnType<IOnyxControlPlaneService['beginRun']>, progress: (parts: IChatProgress[]) => void, token: CancellationToken): Promise<{ text: string; ok: boolean }> {
		const toolId = toolIdsByName.get(toolUse.name);
		if (!toolId) {
			run.activity({ kind: 'toolCall', label: toolUse.name, reason: 'unknown tool requested by the model', ok: false });
			return { text: `Error: unknown tool '${toolUse.name}'. Available tools: ${[...toolIdsByName.keys()].join(', ')}`, ok: false };
		}
		// The arguments are checked against the schema the model was shown, here, before any tool sees them
		// (B12, I-06): a call that does not match is answered and never dispatched.
		const problems = this._argumentProblems(toolUse, tools.find(tool => tool.name === toolUse.name)?.inputSchema);
		if (problems.length > 0) {
			run.activity({ kind: 'toolCall', label: toolUse.name, reason: `arguments do not match the tool's schema: ${problems[0]}`, ok: false });
			return { text: `Error: the arguments for ${toolUse.name} do not match its schema: ${problems.join('; ')}. Nothing was run. Call the tool again with corrected arguments.`, ok: false };
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
	return {
		turn,
		model: modelIdentifier,
		tools: tools.map(t => t.name),
		messages: messages.map(message => ({
			role: message.role,
			content: message.content.map(part => {
				switch (part.type) {
					case 'text': return { type: 'text', value: clip(part.value) };
					case 'tool_use': return { type: 'tool_use', name: part.name, parameters: part.parameters };
					case 'tool_result': return { type: 'tool_result', toolCallId: part.toolCallId, value: clip(part.value.map(v => v.type === 'text' ? v.value : '').join('')) };
					default: return { type: part.type };
				}
			}),
		})),
	};
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
