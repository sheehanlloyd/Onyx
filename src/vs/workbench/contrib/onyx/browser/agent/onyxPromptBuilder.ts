/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { isMacintosh, isWindows } from '../../../../../base/common/platform.js';
import { basename } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { ChatMessageRole, IChatMessage } from '../../../chat/common/languageModels.js';
import { IChatAgentHistoryEntry, IChatAgentRequest } from '../../../chat/common/participants/chatAgents.js';
import { IChatMarkdownContent } from '../../../chat/common/chatService/chatService.js';
import { IOnyxBudgetSlice, IOnyxModelProfile } from '../../common/onyxTypes.js';
import { estimateMessageTokens, estimateTokens } from '../model/onyxOpenAITranslator.js';

const MAX_ATTACHMENT_BYTES = 24 * 1024;
const MAX_ATTACHMENTS = 6;

export interface IBuiltPrompt {
	readonly messages: IChatMessage[];
	readonly budget: readonly IOnyxBudgetSlice[];
}

/**
 * Assembles the conversation for one agent turn, adapted to the target model's
 * profile: compact instructions for small models, a fuller harness for large
 * ones. Every category's token cost is measured so the control plane can show
 * exactly where the context window goes, and history is evicted oldest-first
 * when the total exceeds 85% of the model's context length.
 */
export class OnyxPromptBuilder {

	constructor(
		@IWorkspaceContextService private readonly _workspaceService: IWorkspaceContextService,
		@IFileService private readonly _fileService: IFileService,
	) { }

	async build(request: IChatAgentRequest, history: readonly IChatAgentHistoryEntry[], profile: IOnyxModelProfile, toolNames: readonly string[]): Promise<IBuiltPrompt> {
		const system: IChatMessage = {
			role: ChatMessageRole.System,
			content: [{ type: 'text', value: this._systemPrompt(profile, toolNames) }],
		};

		const historyMessages = this._historyMessages(history);
		const attachmentText = await this._attachmentText(request);
		const userMessage: IChatMessage = {
			role: ChatMessageRole.User,
			content: [{ type: 'text', value: attachmentText ? `${attachmentText}\n\n${request.message}` : request.message }],
		};

		const systemTokens = estimateMessageTokens(system);
		const attachmentTokens = estimateTokens(attachmentText);
		const userTokens = estimateMessageTokens(userMessage) - attachmentTokens;

		// Evict oldest history first until everything fits in 85% of the window,
		// leaving the rest for tool results and the response.
		const available = Math.floor(profile.contextLength * 0.85) - systemTokens - attachmentTokens - userTokens;
		const kept: IChatMessage[] = [];
		let historyTokens = 0;
		for (let i = historyMessages.length - 1; i >= 0; i--) {
			const tokens = estimateMessageTokens(historyMessages[i]);
			if (historyTokens + tokens > available) {
				break;
			}
			historyTokens += tokens;
			kept.unshift(historyMessages[i]);
		}

		return {
			messages: [system, ...kept, userMessage],
			budget: [
				{ category: 'system', tokens: systemTokens },
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

	private _historyMessages(history: readonly IChatAgentHistoryEntry[]): IChatMessage[] {
		const messages: IChatMessage[] = [];
		for (const entry of history) {
			if (entry.request.message) {
				messages.push({ role: ChatMessageRole.User, content: [{ type: 'text', value: entry.request.message }] });
			}
			const responseText = entry.response
				.filter((part): part is IChatMarkdownContent => part.kind === 'markdownContent')
				.map(part => part.content.value)
				.join('');
			if (responseText) {
				messages.push({ role: ChatMessageRole.Assistant, content: [{ type: 'text', value: responseText }] });
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
