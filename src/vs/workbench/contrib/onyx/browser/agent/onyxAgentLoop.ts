/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { toErrorMessage } from '../../../../../base/common/errorMessage.js';
import { MarkdownString } from '../../../../../base/common/htmlContent.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IMarkerService, MarkerSeverity } from '../../../../../platform/markers/common/markers.js';
import { ChatMessageRole, IChatMessage, IChatMessagePart, IChatResponseToolUsePart, ILanguageModelChatMetadata, ILanguageModelsService } from '../../../chat/common/languageModels.js';
import { IChatProgress } from '../../../chat/common/chatService/chatService.js';
import { IChatAgentHistoryEntry, IChatAgentRequest, IChatAgentResult } from '../../../chat/common/participants/chatAgents.js';
import { ILanguageModelToolsService, IToolData } from '../../../chat/common/tools/languageModelToolsService.js';
import { IOnyxModelProfile, ONYX_AUTO_MODEL_ID, ONYX_VENDOR } from '../../common/onyxTypes.js';
import { IOnyxControlPlaneService } from '../controlPlane/onyxControlPlaneService.js';
import { IOnyxModelService } from '../model/onyxLanguageModelProvider.js';
import { IOnyxRouterService } from '../routing/onyxRouterService.js';
import { estimateTokens, IRequestTool } from '../model/onyxOpenAITranslator.js';
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
		@ILogService private readonly _logService: ILogService,
	) { }

	async run(request: IChatAgentRequest, progress: (parts: IChatProgress[]) => void, history: readonly IChatAgentHistoryEntry[], token: CancellationToken): Promise<IChatAgentResult> {
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
		});
		this._controlPlaneService.updateCompute({ modelKey: modelIdentifier, inFlight: true });

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
		const { tools, toolIdsByName } = this._selectTools(request, metadata, profile);
		run.activity({ kind: 'route', label: modelIdentifier, reason: `${tools.length} tools exposed, ${profile.promptStyle} prompt` });

		const promptBuilder = this._instantiationService.createInstance(OnyxPromptBuilder);
		const built = await promptBuilder.build(request, history, profile, tools.map(t => t.name));
		run.setContextBudget(built.budget);
		const messages: IChatMessage[] = built.messages;

		const errorsBefore = this._countWorkspaceErrors();
		let anyToolRan = false;

		const maxTurns = profile.promptStyle === 'compact' ? 8 : 16;
		for (let turn = 0; turn < maxTurns && !token.isCancellationRequested; turn++) {
			run.setTurnCount(turn + 1);
			run.activity({ kind: 'turn', label: `Model turn ${turn + 1}` });
			run.snapshot(snapshotForJournal(turn + 1, modelIdentifier, messages, tools));

			const response = await this._languageModelsService.sendChatRequest(modelIdentifier, undefined, messages, { tools }, token);
			let assistantText = '';
			const toolUses: IChatResponseToolUsePart[] = [];
			for await (const part of response.stream) {
				for (const item of Array.isArray(part) ? part : [part]) {
					if (item.type === 'text') {
						assistantText += item.value;
						progress([{ kind: 'markdownContent', content: new MarkdownString(item.value) }]);
					} else if (item.type === 'tool_use') {
						toolUses.push(item);
					}
				}
			}
			await response.result;

			const assistantParts: IChatMessagePart[] = [];
			if (assistantText) {
				assistantParts.push({ type: 'text', value: assistantText });
			}
			assistantParts.push(...toolUses);
			if (assistantParts.length) {
				messages.push({ role: ChatMessageRole.Assistant, content: assistantParts });
			}

			if (toolUses.length === 0) {
				this._reportVerification(run, errorsBefore, anyToolRan);
				run.complete('completed');
				return {};
			}

			for (const toolUse of toolUses) {
				if (token.isCancellationRequested) {
					break;
				}
				anyToolRan = true;
				const resultText = await this._invokeTool(request, toolUse, toolIdsByName, run, token);
				messages.push({
					role: ChatMessageRole.User,
					content: [{ type: 'tool_result', toolCallId: toolUse.toolCallId, value: [{ type: 'text', value: resultText }] }],
				});
			}

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
		return token.isCancellationRequested ? {} : { errorDetails: { message: `Stopped after the maximum of ${profile.promptStyle === 'compact' ? 8 : 16} agent turns.`, responseIsIncomplete: true } };
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
	}

	private async _invokeTool(request: IChatAgentRequest, toolUse: IChatResponseToolUsePart, toolIdsByName: ReadonlyMap<string, string>, run: ReturnType<IOnyxControlPlaneService['beginRun']>, token: CancellationToken): Promise<string> {
		const toolId = toolIdsByName.get(toolUse.name);
		if (!toolId) {
			run.activity({ kind: 'toolCall', label: toolUse.name, reason: 'unknown tool requested by the model', ok: false });
			return `Error: unknown tool '${toolUse.name}'. Available tools: ${[...toolIdsByName.keys()].join(', ')}`;
		}
		run.activity({ kind: 'toolCall', label: toolUse.name });
		try {
			const result = await this._toolsService.invokeTool({
				callId: toolUse.toolCallId || generateUuid(),
				toolId,
				parameters: typeof toolUse.parameters === 'object' && toolUse.parameters !== null ? toolUse.parameters : {},
				context: { sessionResource: request.sessionResource },
				chatRequestId: request.requestId,
				userSelectedTools: request.userSelectedTools,
			}, (input, _token) => Promise.resolve(estimateTokens(input)), token);
			const text = result.content.map(part => part.kind === 'text' ? part.value : '').join('') || '(no output)';
			run.activity({ kind: 'toolResult', label: toolUse.name, ok: !result.toolResultError });
			return result.toolResultError ? `Error: ${typeof result.toolResultError === 'string' ? result.toolResultError : text}` : text;
		} catch (err) {
			run.activity({ kind: 'toolResult', label: toolUse.name, ok: false, reason: toErrorMessage(err) });
			return `Error invoking ${toolUse.name}: ${toErrorMessage(err)}`;
		}
	}

	private _selectTools(request: IChatAgentRequest, metadata: ILanguageModelChatMetadata | undefined, profile: IOnyxModelProfile): { tools: IRequestTool[]; toolIdsByName: Map<string, string> } {
		const enabled = request.userSelectedTools;
		const all = [...this._toolsService.getTools(metadata)]
			.filter(tool => !enabled || enabled[tool.id] !== false)
			.filter(tool => !!tool.modelDescription);
		all.sort((a, b) => toolPriority(a) - toolPriority(b));

		const tools: IRequestTool[] = [];
		const toolIdsByName = new Map<string, string>();
		for (const tool of all.slice(0, profile.maxTools)) {
			const name = sanitizeToolName(tool.toolReferenceName ?? tool.id, toolIdsByName);
			toolIdsByName.set(name, tool.id);
			tools.push({
				name,
				description: tool.modelDescription,
				inputSchema: tool.inputSchema,
			});
		}
		return { tools, toolIdsByName };
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

/** Lower is more important; the cap keeps the tools a small model needs most. */
function toolPriority(tool: IToolData): number {
	const id = tool.id.toLowerCase();
	if (/edit|apply|replace/.test(id)) { return 0; }
	if (/read|open/.test(id)) { return 1; }
	if (/search|grep|find|list/.test(id)) { return 2; }
	if (/terminal|run|execute/.test(id)) { return 3; }
	if (/todo|task/.test(id)) { return 4; }
	return 5;
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
