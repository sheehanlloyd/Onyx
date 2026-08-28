/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { isMacintosh, isWindows } from '../../../../../base/common/platform.js';
import { basename } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { ChatMessageRole, IChatMessage } from '../../../chat/common/languageModels.js';
import { IChatAgentHistoryEntry, IChatAgentRequest } from '../../../chat/common/participants/chatAgents.js';
import { IChatMarkdownContent } from '../../../chat/common/chatService/chatService.js';
import { elideMiddle, historyMessageBudget } from '../../common/onyxContextCompression.js';
import { IOnyxBudgetSlice, IOnyxModelProfile } from '../../common/onyxTypes.js';
import { IOnyxRankedFile, OnyxContextRanker } from '../intelligence/onyxContextRanker.js';
import { IOnyxMemoryService } from '../intelligence/onyxMemoryService.js';
import { estimateMessageTokens, estimateTokens } from '../model/onyxOpenAITranslator.js';

/** Rough characters per token for the estimator Onyx uses everywhere. */
const CHARS_PER_TOKEN = 4;
/** Room always left for the model's own answer, in tokens. */
const RESPONSE_HEADROOM_TOKENS = 512;
/** However tight the window, the user's own words get at least this much. */
const MIN_USER_MESSAGE_TOKENS = 256;

const MAX_ATTACHMENT_BYTES = 24 * 1024;
const MAX_ATTACHMENTS = 6;

export interface IBuiltPrompt {
	readonly messages: IChatMessage[];
	readonly budget: readonly IOnyxBudgetSlice[];
}

/**
 * Keeps the newest history messages that fit the available token budget,
 * dropping oldest-first. Newest turns carry the most relevant state; the
 * system prompt and current request are never eviction candidates.
 */
export function evictOldestHistory(historyMessages: readonly IChatMessage[], availableTokens: number): { kept: IChatMessage[]; historyTokens: number } {
	const kept: IChatMessage[] = [];
	let historyTokens = 0;
	for (let i = historyMessages.length - 1; i >= 0; i--) {
		const tokens = estimateMessageTokens(historyMessages[i]);
		if (historyTokens + tokens > availableTokens) {
			break;
		}
		historyTokens += tokens;
		kept.unshift(historyMessages[i]);
	}
	return { kept, historyTokens };
}

/**
 * Assembles the conversation for one agent turn, adapted to the target model's
 * profile: compact instructions for small models, a fuller harness for large
 * ones. Every category's token cost is measured so the control plane can show
 * exactly where the context window goes, and history is evicted oldest-first
 * when the total exceeds 85% of the model's context length.
 */
export class OnyxPromptBuilder {

	private readonly _contextRanker: OnyxContextRanker;

	constructor(
		@IWorkspaceContextService private readonly _workspaceService: IWorkspaceContextService,
		@IFileService private readonly _fileService: IFileService,
		@IOnyxMemoryService private readonly _memoryService: IOnyxMemoryService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		this._contextRanker = instantiationService.createInstance(OnyxContextRanker);
	}

	async build(request: IChatAgentRequest, history: readonly IChatAgentHistoryEntry[], profile: IOnyxModelProfile, toolNames: readonly string[]): Promise<IBuiltPrompt> {
		const rankedFiles = await this._rankedFiles(profile);
		const workspaceContext = this._workspaceContextSection(rankedFiles, profile);
		// KV-cache-aware layout: the system prompt is deterministic for a given
		// (profile, tool set), history is append-only, and everything volatile —
		// ranked files, remembered facts, attachments — rides at the tail with
		// the newest user message. A local runtime can then reuse the cached
		// prefix across turns instead of re-processing the whole prompt.
		const system: IChatMessage = {
			role: ChatMessageRole.System,
			content: [{ type: 'text', value: this._systemPrompt(profile, toolNames) }],
		};

		const historyMessages = this._historyMessages(history, profile);
		const attachmentText = await this._attachmentText(request);
		const contextMessage: IChatMessage | undefined = workspaceContext ? {
			role: ChatMessageRole.User,
			content: [{ type: 'text', value: `[Workspace context — background, not a request]\n${workspaceContext}` }],
		} : undefined;
		const systemTokens = estimateMessageTokens(system);
		const workspaceTokens = contextMessage ? estimateMessageTokens(contextMessage) : 0;
		// One oversized request (a pasted file, a giant stack trace) must not
		// blow past the window on its own: history eviction cannot help when the
		// newest message is the problem, so it is elided head-and-tail with an
		// explicit marker rather than sent whole and rejected by the runtime.
		const userBudget = Math.max(MIN_USER_MESSAGE_TOKENS, Math.floor(profile.contextLength * 0.85) - systemTokens - workspaceTokens - RESPONSE_HEADROOM_TOKENS);
		const rawUserText = attachmentText ? `${attachmentText}\n\n${request.message}` : request.message;
		const userText = elideMiddle(rawUserText, userBudget * CHARS_PER_TOKEN);
		const userMessage: IChatMessage = {
			role: ChatMessageRole.User,
			content: [{ type: 'text', value: userText }],
		};

		const attachmentTokens = Math.min(estimateTokens(attachmentText), estimateMessageTokens(userMessage));
		const userTokens = estimateMessageTokens(userMessage) - attachmentTokens;

		// Evict oldest history first until everything fits in 85% of the window,
		// leaving the rest for tool results and the response.
		const available = Math.floor(profile.contextLength * 0.85) - systemTokens - workspaceTokens - attachmentTokens - userTokens;
		const { kept, historyTokens } = evictOldestHistory(historyMessages, available);

		return {
			messages: contextMessage ? [system, ...kept, contextMessage, userMessage] : [system, ...kept, userMessage],
			budget: [
				{ category: 'system', tokens: systemTokens },
				{ category: 'workspace', tokens: workspaceTokens },
				{ category: 'history', tokens: historyTokens },
				{ category: 'attachments', tokens: attachmentTokens },
				{ category: 'toolSchemas', tokens: toolNames.length * 60 },
				{ category: 'toolResults', tokens: 0 },
			],
		};
	}

	private _systemPrompt(profile: IOnyxModelProfile, toolNames: readonly string[]): string {
		const folders = this._workspaceService.getWorkspace().folders.map(f => f.uri.fsPath);
		const os = isMacintosh ? 'macOS' : isWindows ? 'Windows' : 'Linux';
		const environment = `Workspace: ${folders.join(', ') || '(no folder open)'}. OS: ${os}.`;

		if (profile.promptStyle === 'compact') {
			// Small models do better with short, imperative, structured instructions.
			return [
				'You are Onyx, a coding agent running locally. Be direct and concise.',
				environment,
				toolNames.length
					? `Use tools to inspect and change code. Available tools: ${toolNames.join(', ')}. Call one tool at a time. After tool results, continue until the task is done, then answer.`
					: 'Answer directly.',
				'When editing, make the smallest correct change. Never invent file contents you have not read.',
			].join('\n');
		}

		return [
			'You are Onyx, an AI software engineering agent. All inference runs locally on the user\'s machine; work efficiently and keep responses focused.',
			environment,
			toolNames.length
				? `You can call tools to read, search, edit and run code (${toolNames.join(', ')}). Prefer inspecting the workspace over guessing. Plan multi-step work briefly before acting, act step by step, and verify the result of your edits when a suitable tool is available.`
				: 'You have no tools for this request; answer from the provided context.',
			'Follow the existing code style of the workspace. Make minimal, correct changes and explain what you did at the end.',
		].join('\n');
	}

	private async _rankedFiles(profile: IOnyxModelProfile): Promise<IOnyxRankedFile[]> {
		try {
			return await this._contextRanker.rank(profile.promptStyle === 'compact' ? 5 : 10);
		} catch {
			return [];
		}
	}

	/**
	 * A compact "where the user is working" section: the top-ranked workspace
	 * files with why they rank. Grounds the model's first tool calls in the
	 * right part of the repo for a handful of tokens.
	 */
	private _workspaceContextSection(rankedFiles: readonly IOnyxRankedFile[], profile: IOnyxModelProfile): string {
		const sections: string[] = [];
		if (rankedFiles.length > 0) {
			if (profile.promptStyle === 'compact') {
				sections.push(`Files the user is working on (most relevant first): ${rankedFiles.map(f => f.path).join(', ')}`);
			} else {
				const lines = rankedFiles.map(f => `- ${f.path} (${f.reasons.join(', ')})`);
				sections.push(`Files the user is likely working on, most relevant first:\n${lines.join('\n')}`);
			}
		}
		// Newest last so the freshest facts sit closest to the request.
		const notes = this._memoryService.getNotes();
		if (notes.length > 0) {
			const kept = notes.slice(profile.promptStyle === 'compact' ? -5 : -15);
			sections.push(`Facts remembered from earlier sessions in this workspace:\n${kept.map(note => `- ${note.text}`).join('\n')}`);
		}
		return sections.join('\n');
	}

	private _historyMessages(history: readonly IChatAgentHistoryEntry[], profile: IOnyxModelProfile): IChatMessage[] {
		const budget = historyMessageBudget(profile.promptStyle);
		const messages: IChatMessage[] = [];
		for (const entry of history) {
			if (entry.request.message) {
				messages.push({ role: ChatMessageRole.User, content: [{ type: 'text', value: elideMiddle(entry.request.message, budget) }] });
			}
			const responseText = entry.response
				.filter((part): part is IChatMarkdownContent => part.kind === 'markdownContent')
				.map(part => part.content.value)
				.join('');
			if (responseText) {
				messages.push({ role: ChatMessageRole.Assistant, content: [{ type: 'text', value: elideMiddle(responseText, budget) }] });
			}
		}
		return messages;
	}

	private async _attachmentText(request: IChatAgentRequest): Promise<string> {
		const sections: string[] = [];
		for (const variable of request.variables.variables.slice(0, MAX_ATTACHMENTS)) {
			const value = variable.value;
			if (typeof value === 'string') {
				sections.push(`<attachment name="${variable.name}">\n${value}\n</attachment>`);
			} else if (URI.isUri(value)) {
				const text = await this._readCapped(value);
				if (text !== undefined) {
					sections.push(`<attachment file="${basename(value)}">\n${text}\n</attachment>`);
				}
			}
		}
		return sections.join('\n');
	}

	private async _readCapped(resource: URI): Promise<string | undefined> {
		try {
			const content = await this._fileService.readFile(resource, { length: MAX_ATTACHMENT_BYTES });
			return content.value.toString();
		} catch {
			return undefined;
		}
	}
}
