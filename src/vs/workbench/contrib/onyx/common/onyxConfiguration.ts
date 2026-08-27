/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { workbenchConfigurationNodeBase } from '../../../common/configuration.js';

export const enum OnyxSettingId {
	Endpoints = 'onyx.endpoints',
	DiscoveryEnabled = 'onyx.discovery.enabled',
	RoutingMode = 'onyx.routing.mode',
	ControlPlaneAnimations = 'onyx.controlPlane.animations',
	AutocompleteEnabled = 'onyx.autocomplete.enabled',
	AutocompleteModel = 'onyx.autocomplete.model',
	AutocompleteContext = 'onyx.autocomplete.context',
	VerificationTask = 'onyx.verification.task',
}

export interface IOnyxEndpointSetting {
	readonly baseUrl: string;
	readonly apiKey?: string;
	/** Explicit model ids to expose; when omitted, models are listed from the endpoint. */
	readonly models?: readonly string[];
	/** Context window override in tokens, applied to every model of this endpoint. */
	readonly contextWindow?: number;
}

export type OnyxRoutingMode = 'auto' | 'manual';

export function getOnyxEndpointSettings(configurationService: IConfigurationService): readonly IOnyxEndpointSetting[] {
	const raw = configurationService.getValue<readonly IOnyxEndpointSetting[]>(OnyxSettingId.Endpoints);
	return Array.isArray(raw) ? raw.filter(e => typeof e?.baseUrl === 'string' && e.baseUrl.length > 0) : [];
}

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	...workbenchConfigurationNodeBase,
	properties: {
		[OnyxSettingId.Endpoints]: {
			type: 'array',
			scope: ConfigurationScope.MACHINE,
			default: [],
			markdownDescription: localize('onyx.endpoints', "Additional OpenAI-compatible inference endpoints to use besides the auto-discovered local runtimes. Each entry needs a `baseUrl` (for example `http://localhost:11434/v1`) and may set an `apiKey`, an explicit `models` list, and a `contextWindow` override."),
			items: {
				type: 'object',
				required: ['baseUrl'],
				properties: {
					baseUrl: { type: 'string', description: localize('onyx.endpoints.baseUrl', "Base URL of the endpoint, e.g. `http://localhost:11434/v1`.") },
					apiKey: { type: 'string', description: localize('onyx.endpoints.apiKey', "Optional API key sent as a Bearer token.") },
					models: { type: 'array', items: { type: 'string' }, description: localize('onyx.endpoints.models', "Model ids to expose. When omitted, the endpoint's model list is used.") },
					contextWindow: { type: 'number', description: localize('onyx.endpoints.contextWindow', "Context window size in tokens for models of this endpoint.") },
				},
			},
		},
		[OnyxSettingId.DiscoveryEnabled]: {
			type: 'boolean',
			scope: ConfigurationScope.MACHINE,
			default: true,
			description: localize('onyx.discovery.enabled', "Automatically discover local inference runtimes (Ollama, LM Studio, llama.cpp, vLLM) on their well-known localhost ports."),
		},
		[OnyxSettingId.RoutingMode]: {
			type: 'string',
			scope: ConfigurationScope.APPLICATION,
			enum: ['auto', 'manual'],
			enumDescriptions: [
				localize('onyx.routing.mode.auto', "The Onyx router picks the best local model per request, using measured per-model performance on this machine."),
				localize('onyx.routing.mode.manual', "Always use the exact model selected in the model picker."),
			],
			default: 'auto',
			description: localize('onyx.routing.mode', "How Onyx chooses which local model serves a request."),
		},
		[OnyxSettingId.ControlPlaneAnimations]: {
			type: 'boolean',
			scope: ConfigurationScope.APPLICATION,
			default: true,
			description: localize('onyx.controlPlane.animations', "Enable animations in the Onyx control plane views."),
		},
		[OnyxSettingId.AutocompleteEnabled]: {
			type: 'boolean',
			scope: ConfigurationScope.APPLICATION,
			default: true,
			description: localize('onyx.autocomplete.enabled', "Enable Onyx inline autocomplete from a local fill-in-the-middle model."),
		},
		[OnyxSettingId.AutocompleteModel]: {
			type: 'string',
			scope: ConfigurationScope.MACHINE,
			default: '',
			markdownDescription: localize('onyx.autocomplete.model', "Model to use for inline autocomplete, as `host:port/modelId` (see *Onyx: Show Local Runtimes*). When empty, the smallest discovered model is used."),
		},
		[OnyxSettingId.AutocompleteContext]: {
			type: 'boolean',
			scope: ConfigurationScope.APPLICATION,
			default: true,
			description: localize('onyx.autocomplete.context', "Include short commented snippets from the most relevant other open files in inline autocomplete prompts."),
		},
		[OnyxSettingId.VerificationTask]: {
			type: 'string',
			scope: ConfigurationScope.RESOURCE,
			default: '',
			markdownDescription: localize('onyx.verification.task', "Project check to run after an Onyx agent run that used tools, with the pass/fail verdict posted to the run's timeline. Use `build` or `test` for the workspace's default build or test task, any other value for a task with that name, or leave empty to disable."),
		},
	},
});
