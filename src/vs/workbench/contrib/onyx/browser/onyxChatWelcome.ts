/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { MarkdownString } from '../../../../base/common/htmlContent.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { ContextKeyExpr, IContextKeyService, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { chatViewsWelcomeRegistry } from '../../chat/browser/viewsWelcome/chatViewsWelcome.js';
import { IOnyxModelService } from './model/onyxLanguageModelProvider.js';

/** True once at least one local model has been discovered on this machine. */
export const OnyxHasLocalRuntimeContext = new RawContextKey<boolean>('onyxHasLocalRuntime', false, localize('onyxHasLocalRuntime', "Whether Onyx has found at least one local inference runtime."));

/** Command that reruns discovery and lists what it found. */
const SHOW_RUNTIMES_COMMAND = 'onyx.showLocalRuntimes';

/**
 * Chat's resting state when there is nothing to talk to. A raw connection
 * error explains a symptom; this explains the product — Onyx needs a model on
 * *this* machine, and here is the one command that puts one there.
 */
export class OnyxChatWelcomeContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.onyxChatWelcome';

	constructor(
		@IContextKeyService contextKeyService: IContextKeyService,
		@IOnyxModelService onyxModelService: IOnyxModelService,
	) {
		super();

		const hasRuntime = OnyxHasLocalRuntimeContext.bindTo(contextKeyService);
		const sync = () => hasRuntime.set(onyxModelService.getKnownModels().length > 0);
		sync();
		this._register(onyxModelService.onDidChangeModels(sync));

		chatViewsWelcomeRegistry.register({
			title: localize('onyx.chatWelcome.title', "No local model yet"),
			content: new MarkdownString([
				localize('onyx.chatWelcome.body', "Onyx runs every model on this machine. Install a runtime, pull a coding model, and it shows up here on its own."),
				'',
				'```',
				'brew install ollama',
				'ollama pull qwen2.5-coder:7b',
				'```',
				'',
				`[${localize('onyx.chatWelcome.check', "Check for local runtimes")}](command:${SHOW_RUNTIMES_COMMAND})`,
				'',
				localize('onyx.chatWelcome.alternatives', "LM Studio, llama.cpp and vLLM work too — Onyx probes their ports as well."),
			].join('\n'), { isTrusted: { enabledCommands: [SHOW_RUNTIMES_COMMAND] } }),
			when: ContextKeyExpr.equals(OnyxHasLocalRuntimeContext.key, false),
		});
	}
}
