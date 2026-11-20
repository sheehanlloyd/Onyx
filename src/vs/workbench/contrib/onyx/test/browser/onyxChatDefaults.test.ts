/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import '../../../../../platform/agentHost/common/agentHostEnablementService.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../../platform/configuration/common/configurationRegistry.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { testWorkspace } from '../../../../../platform/workspace/test/common/testWorkspace.js';
import { TestStorageService } from '../../../../test/common/workbenchTestServices.js';
import { localChatSessionType, SessionType } from '../../../chat/common/chatSessionsService.js';
import { ChatConfiguration, getDefaultNewChatSessionTypeAndReasonFromServices } from '../../../chat/common/constants.js';
import '../../common/onyxConfiguration.js';

suite('OnyxChatDefaults', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	/** No extension contributes a session type: the packaged product ships none. */
	const noContributedSessionTypes = { getChatSessionContribution: () => undefined, getAllChatSessionContributions: () => [] };

	function resolveNewChat(settings: Record<string, boolean | undefined>) {
		const disposables = store.add(new DisposableStore());
		const storageService = disposables.add(new TestStorageService());
		return getDefaultNewChatSessionTypeAndReasonFromServices(new TestConfigurationService(settings), noContributedSessionTypes, storageService, testWorkspace(), true /* the Agent Host is available */);
	}

	// Upstream turned both harness settings on between the August 2026 base and
	// 1.147.0. With them on, every new chat is an Agent Host Copilot session:
	// the first message opens a GitHub sign-in dialog and Onyx's own agent,
	// the default of the local harness, is never asked. The shipped defaults
	// are read from the registry, so this fails the moment a merge renames a
	// setting or drops the override in onyxConfiguration.ts.
	test('a new chat goes to the local harness, where the Onyx agent is the default', () => {
		const properties = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).getConfigurationProperties();
		const harnessSettings = [ChatConfiguration.DefaultToCopilotHarness, ChatConfiguration.EditorPreferCopilotHarness, ChatConfiguration.EditorLocalAgentEnabled];
		const shipped = Object.fromEntries(harnessSettings.map(setting => [setting, properties[setting]?.default as boolean | undefined]));

		assert.deepStrictEqual({
			shipped,
			withShippedDefaults: resolveNewChat(shipped),
			// What the override prevents: upstream's own defaults for the two settings.
			withUpstreamDefaults: resolveNewChat({ ...shipped, [ChatConfiguration.DefaultToCopilotHarness]: true, [ChatConfiguration.EditorPreferCopilotHarness]: true }),
		}, {
			shipped: {
				[ChatConfiguration.DefaultToCopilotHarness]: false,
				[ChatConfiguration.EditorPreferCopilotHarness]: false,
				[ChatConfiguration.EditorLocalAgentEnabled]: true,
			},
			withShippedDefaults: { sessionType: localChatSessionType, selectionReason: 'computedDefault' },
			withUpstreamDefaults: { sessionType: SessionType.AgentHostCopilot, selectionReason: 'computedDefault' },
		});
	});
});
