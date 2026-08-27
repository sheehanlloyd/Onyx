/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../../base/common/codicons.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { ExtensionIdentifier } from '../../../../../platform/extensions/common/extensions.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { ChatAgentLocation, ChatModeKind } from '../../../chat/common/constants.js';
import { IChatAgentData, IChatAgentService } from '../../../chat/common/participants/chatAgents.js';
import { OnyxAgentLoop } from './onyxAgentLoop.js';

export const ONYX_AGENT_ID = 'onyx';

/**
 * Registers the Onyx chat agent — the default local agent that serves chat
 * requests through the Onyx model service and agent loop. Registered from
 * core as a dynamic agent; when a default agent from an extension is active
 * (e.g. Copilot), the chat stack prefers that one, so Onyx cleanly serves the
 * fully-local setup without fighting other providers.
 */
export class OnyxChatAgentContribution extends Disposable {

	static readonly ID = 'workbench.contrib.onyxChatAgent';

	constructor(
		@IChatAgentService chatAgentService: IChatAgentService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();

		const agentData: IChatAgentData = {
			id: ONYX_AGENT_ID,
			name: ONYX_AGENT_ID,
			fullName: localize('onyx.agent.fullName', "Onyx"),
			description: localize('onyx.agent.description', "Local AI agent — all inference runs on this machine"),
			extensionId: new ExtensionIdentifier('vscode.onyx'),
			extensionVersion: undefined,
			extensionPublisherId: 'vscode',
			extensionDisplayName: localize('onyx.agent.extensionDisplayName', "Onyx"),
			isDefault: true,
			isDynamic: true,
			isCore: true,
			metadata: { themeIcon: Codicon.sparkle },
			slashCommands: [],
			locations: [ChatAgentLocation.Chat],
			modes: [ChatModeKind.Agent, ChatModeKind.Ask, ChatModeKind.Edit],
			disambiguation: [],
		};

		this._register(chatAgentService.registerDynamicAgent(agentData, {
			invoke: (request, progress, history, token) => {
				const loop = instantiationService.createInstance(OnyxAgentLoop);
				return loop.run(request, progress, history, token);
			},
		}));
	}
}
