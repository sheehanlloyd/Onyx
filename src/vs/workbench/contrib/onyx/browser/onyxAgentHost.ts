/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { AgentHostEnablementService } from '../../../../platform/agentHost/browser/agentHostEnablementService.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IManagedSettingsService } from '../../../../platform/policy/common/copilotManagedSettings.js';

/**
 * Onyx excludes upstream's Agent Host (B3, DEC-03).
 *
 * The Agent Host is a utility process that hosts the Copilot SDK harness.
 * Upstream starts it for every window, registers its session types
 * (`agent-host-copilotcli` and others) and language-model vendors in the
 * workbench, and has it start a closed-source runtime binary whose network
 * behaviour cannot be read from this repository. None of that belongs in a
 * product whose promise is that inference stays on the machine and that
 * every tool is in a reviewed contract.
 *
 * Upstream already has the switch: `IAgentHostEnablementService`, built with
 * "the Agent Host runtime is not available", is how the web workbench runs
 * without one. With it off, the pre-warm that spawns the process does not
 * run, the workbench contribution that registers the session types, the
 * language-model vendors and the harness does not run, and the pickers that
 * list agent-host session types have nothing to list. Registered after
 * upstream's own implementation (the last registration of a service wins),
 * so no upstream file is touched.
 */
export class OnyxAgentHostEnablementService extends AgentHostEnablementService {
	constructor(
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IManagedSettingsService managedSettingsService: IManagedSettingsService,
	) {
		super(false, configurationService, contextKeyService, managedSettingsService);
	}
}
