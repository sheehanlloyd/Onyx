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
import { ChatConfiguration, getDefaultNewChatSessionTypeAndReasonFromServices, isNewChatSessionTypeUsable } from '../../../chat/common/constants.js';
import '../../common/onyxConfiguration.js';
import { AgentHostEnablementService } from '../../../../../platform/agentHost/browser/agentHostEnablementService.js';
import { MockContextKeyService } from '../../../../../platform/keybinding/test/common/mockKeybindingService.js';
import { NullManagedSettingsService } from '../../../../../platform/policy/common/copilotManagedSettings.js';
import { OnyxAgentHostEnablementService } from '../../browser/onyxAgentHost.js';

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

	// B3: upstream's Agent Host (the Copilot SDK harness) is excluded. The switch upstream built for a workbench
	// without an Agent Host runtime is what Onyx registers; with it off, no agent-host session type can start a
	// chat, even if a user turns upstream's two harness defaults back on.
	test('the Agent Host is off in Onyx: the switch reads disabled whatever the settings say, and no agent-host session type is usable', () => {
		const disposables = store.add(new DisposableStore());
		const storageService = disposables.add(new TestStorageService());
		const configuration = new TestConfigurationService({ 'chat.disableAIFeatures': false, [ChatConfiguration.DefaultToCopilotHarness]: true, [ChatConfiguration.EditorPreferCopilotHarness]: true, [ChatConfiguration.EditorLocalAgentEnabled]: true });
		const upstream = disposables.add(new AgentHostEnablementService(true, configuration, new MockContextKeyService(), new NullManagedSettingsService()));
		const onyx = disposables.add(new OnyxAgentHostEnablementService(configuration, new MockContextKeyService(), new NullManagedSettingsService()));
		const usable = (sessionType: string, agentHostEnabled: boolean) => isNewChatSessionTypeUsable(sessionType, configuration, noContributedSessionTypes, testWorkspace(), agentHostEnabled);
		assert.deepStrictEqual({
			upstreamOnDesktop: upstream.enabled.get(),
			onyx: onyx.enabled.get(),
			copilotSessionWithUpstreamSwitch: usable(SessionType.AgentHostCopilot, upstream.enabled.get()),
			copilotSessionInOnyx: usable(SessionType.AgentHostCopilot, onyx.enabled.get()),
			localSessionInOnyx: usable(localChatSessionType, onyx.enabled.get()),
			newChatInOnyxWithUpstreamHarnessDefaults: getDefaultNewChatSessionTypeAndReasonFromServices(configuration, noContributedSessionTypes, storageService, testWorkspace(), onyx.enabled.get()).sessionType,
		}, {
			upstreamOnDesktop: true,
			onyx: false,
			copilotSessionWithUpstreamSwitch: true,
			copilotSessionInOnyx: false,
			localSessionInOnyx: true,
			newChatInOnyxWithUpstreamHarnessDefaults: localChatSessionType,
		});
	});
});
