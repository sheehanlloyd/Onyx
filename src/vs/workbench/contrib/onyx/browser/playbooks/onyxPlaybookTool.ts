/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { INotificationService, Severity } from '../../../../../platform/notification/common/notification.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { ILanguageModelToolsService, IToolData, IToolImpl, IToolInvocation, IToolResult, ToolDataSource } from '../../../chat/common/tools/languageModelToolsService.js';
import { Range } from '../../../../../editor/common/core/range.js';
import { CompletionItemInsertTextRule, CompletionItemKind } from '../../../../../editor/common/languages.js';
import { ILanguageFeaturesService } from '../../../../../editor/common/services/languageFeatures.js';
import { ONYX_PLAYBOOK_KEYS, renderPlaybookInvocation } from '../../common/onyxPlaybooks.js';
import { IOnyxPlaybookService } from './onyxPlaybookService.js';

export const ONYX_PLAYBOOK_TOOL_ID = 'onyx_playbook';

/**
 * The playbook tool: hands the agent the full text of one repository-authored
 * recipe. The prompt already carries a one-line index of available playbooks,
 * so the model knows what exists; this tool is how it pulls a recipe in when
 * one applies.
 */
export class OnyxPlaybookToolContribution extends Disposable {

	static readonly ID = 'workbench.contrib.onyxPlaybookTool';

	constructor(
		@ILanguageModelToolsService toolsService: ILanguageModelToolsService,
		@IOnyxPlaybookService private readonly _playbookService: IOnyxPlaybookService,
		@ILanguageFeaturesService private readonly _languageFeaturesService: ILanguageFeaturesService,
	) {
		super();

		const toolData: IToolData = {
			id: ONYX_PLAYBOOK_TOOL_ID,
			toolReferenceName: 'playbook',
			displayName: localize('onyx.playbook.displayName', "Run a Repository Playbook"),
			modelDescription: 'Fetches a repository playbook by name — a checked-in recipe describing how a recurring task is done in this repository. The available playbooks and when to use them are listed in your context. Follow the fetched recipe\'s steps.',
			userDescription: localize('onyx.playbook.userDescription', "Let the agent use the repository's checked-in playbooks"),
			source: ToolDataSource.Internal,
			canBeReferencedInPrompt: true,
			runsInWorkspace: true,
			inputSchema: {
				type: 'object',
				properties: {
					name: { type: 'string', description: 'The playbook\'s name, exactly as listed.' },
				},
				required: ['name'],
			},
		};

		const impl: IToolImpl = {
			prepareToolInvocation: async (context) => ({
				invocationMessage: localize('onyx.playbook.invoking', "Fetching playbook \"{0}\"", String((context.parameters as { name?: unknown }).name ?? '')),
			}),
			invoke: (invocation, _countTokens, _progress, token) => this._invoke(invocation, token),
		};

		this._register(toolsService.registerToolData(toolData));
		this._register(toolsService.registerToolImplementation(ONYX_PLAYBOOK_TOOL_ID, impl));

		// Frontmatter autocompletion inside .onyx/playbooks/*.md: the known keys,
		// and a whole-file scaffold when the file is still empty.
		this._register(this._languageFeaturesService.completionProvider.register({ language: 'markdown', pattern: '**/.onyx/playbooks/*.md', scheme: '*', hasAccessToAllModels: true }, {
			_debugDisplayName: 'onyxPlaybookFrontmatter',
			provideCompletionItems: (model, position) => {
				const wordRange = new Range(position.lineNumber, 1, position.lineNumber, position.column);
				if (model.getValue().trim() === '' || (position.lineNumber === 1 && model.getLineCount() === 1)) {
					return {
						suggestions: [{
							label: 'playbook',
							kind: CompletionItemKind.Snippet,
							detail: localize('onyx.playbook.scaffold', "Onyx playbook scaffold"),
							insertText: '---\nname: ${1:my-playbook}\ndescription: ${2:What this recipe achieves}\nwhen-to-use: ${3:When the agent should reach for it}\ntools: ${4:editFile, terminal}\n---\n\n${5:1. First step…}\n',
							insertTextRules: CompletionItemInsertTextRule.InsertAsSnippet,
							range: wordRange,
						}],
					};
				}
				// Inside the frontmatter block: offer the schema's keys.
				const closing = findSecondDivider(model.getValue());
				if (model.getLineContent(1).trim() !== '---' || (closing >= 0 && position.lineNumber > closing + 1)) {
					return { suggestions: [] };
				}
				return {
					suggestions: ONYX_PLAYBOOK_KEYS.map(key => ({
						label: `${key}:`,
						kind: CompletionItemKind.Property,
						insertText: `${key}: `,
						range: wordRange,
					})),
				};
			},
		}));
	}

	private async _invoke(invocation: IToolInvocation, _token: CancellationToken): Promise<IToolResult> {
		const parameters = invocation.parameters as { name?: unknown };
		const name = typeof parameters.name === 'string' ? parameters.name.trim() : '';
		const discovered = this._playbookService.getPlaybook(name);
		if (!discovered) {
			const available = this._playbookService.playbooks.get().map(entry => entry.playbook.name);
			return {
				content: [{ kind: 'text', value: available.length ? `No playbook named "${name}". Available playbooks: ${available.join(', ')}.` : 'This repository has no playbooks (.onyx/playbooks/*.md).' }],
				toolResultError: true,
			};
		}
		return { content: [{ kind: 'text', value: renderPlaybookInvocation(discovered.playbook, undefined) }] };
	}
}

/** 0-based line of the frontmatter's closing `---`, or -1. */
function findSecondDivider(content: string): number {
	const lines = content.split('\n');
	for (let i = 1; i < lines.length; i++) {
		if (lines[i].trim() === '---') {
			return i;
		}
	}
	return -1;
}

registerAction2(class RunOnyxPlaybookAction extends Action2 {
	constructor() {
		super({
			id: 'onyx.runPlaybook',
			title: localize2('onyx.runPlaybook', "Onyx: Run a Playbook"),
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const playbookService = accessor.get(IOnyxPlaybookService);
		const quickInputService = accessor.get(IQuickInputService);
		const commandService = accessor.get(ICommandService);
		const notificationService = accessor.get(INotificationService);

		const playbooks = playbookService.playbooks.get();
		if (playbooks.length === 0) {
			notificationService.notify({ severity: Severity.Info, message: localize('onyx.playbook.none', "This repository has no playbooks yet. Add one at .onyx/playbooks/<name>.md with name and description frontmatter.") });
			return;
		}
		const picked = await quickInputService.pick(playbooks.map(entry => ({
			label: entry.playbook.name,
			description: entry.playbook.description,
			detail: [
				entry.playbook.whenToUse || undefined,
				entry.playbook.tools.length ? localize('onyx.playbook.tools', "tools: {0}", entry.playbook.tools.join(', ')) : undefined,
				entry.playbook.modelHint ? localize('onyx.playbook.model', "suggested model: {0}", entry.playbook.modelHint) : undefined,
			].filter(Boolean).join(' · '),
			entry,
		})), { placeHolder: localize('onyx.playbook.pick', "Which playbook should the agent run?"), matchOnDescription: true, matchOnDetail: true });
		if (!picked) {
			return;
		}
		const extra = await quickInputService.input({
			placeHolder: localize('onyx.playbook.extra', "Anything specific for this run? (optional)"),
			prompt: localize('onyx.playbook.extraPrompt', "Appended to the playbook as additional instructions"),
		});
		if (extra === undefined) {
			return;
		}
		await commandService.executeCommand('workbench.action.chat.open', {
			query: renderPlaybookInvocation(picked.entry.playbook, extra),
		});
	}
});
