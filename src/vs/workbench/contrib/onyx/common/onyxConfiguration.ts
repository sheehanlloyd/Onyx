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
	SpeculativePairs = 'onyx.speculative.pairs',
	DiscoveryEnabled = 'onyx.discovery.enabled',
	RoutingMode = 'onyx.routing.mode',
	ControlPlaneAnimations = 'onyx.controlPlane.animations',
	AutocompleteEnabled = 'onyx.autocomplete.enabled',
	AutocompleteModel = 'onyx.autocomplete.model',
	AutocompleteContext = 'onyx.autocomplete.context',
	VerificationTask = 'onyx.verification.task',
	EnergyPolicy = 'onyx.energy.policy',
	BackgroundReview = 'onyx.review.background',
	NetworkTools = 'onyx.agent.networkTools',
	TerminalPassEnvironment = 'onyx.terminal.passEnvironment',
}

export interface IOnyxEndpointSetting {
	readonly baseUrl: string;
	/**
	 * Legacy. API keys live in the system's secret storage since B11
	 * (`IOnyxEndpointSecretService`); a key found here is moved there.
	 */
	readonly apiKey?: string;
	/** Explicit model ids to expose; when omitted, models are listed from the endpoint. */
	readonly models?: readonly string[];
	/** Context window override in tokens, applied to every model of this endpoint. */
	readonly contextWindow?: number;
}

export type OnyxRoutingMode = 'auto' | 'manual';

/** `localhost:8000` → `http://localhost:8000/v1`: the form an endpoint's base URL is stored and compared in. */
export function normalizeEndpointBaseUrl(url: string): string {
	let normalized = url.trim().replace(/\/+$/, '');
	if (!/^https?:\/\//.test(normalized)) {
		normalized = `http://${normalized}`;
	}
	if (!normalized.endsWith('/v1')) {
		normalized = `${normalized}/v1`;
	}
	return normalized;
}

export function getOnyxEndpointSettings(configurationService: IConfigurationService): readonly IOnyxEndpointSetting[] {
	const raw = configurationService.getValue<readonly IOnyxEndpointSetting[]>(OnyxSettingId.Endpoints);
	return Array.isArray(raw) ? raw.filter(e => typeof e?.baseUrl === 'string' && e.baseUrl.length > 0) : [];
}

/**
 * Onyx has no account, so the chat stack's account-oriented chrome has nothing
 * to offer here. Overriding the shipped defaults (rather than patching the
 * upstream UI) keeps this a settings decision the user can still reverse.
 */
Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerDefaultConfigurations([{
	overrides: {
		// The title bar's "Sign In" pill: signing in buys nothing in a local-only product.
		'chat.titleBar.signIn.enabled': false,
		// A new chat belongs to the local harness, where the Onyx agent is the
		// default. Upstream turned both of these on after the August 2026 base:
		// with them on, every new chat is an Agent Host Copilot session, whose
		// first message opens a GitHub sign-in dialog and never reaches Onyx.
		'chat.defaultToCopilotHarness': false,
		'chat.editor.preferCopilotHarness': false,
		// The Agents window is a second workbench built around upstream's Agent
		// Host, which Onyx excludes (B3); the product does not open it, so the
		// chrome that invites the user into it stays off.
		'chat.titleBar.openInAgentsWindow.enabled': false,
		'chat.agentsWindowBanner.enabled': false,
	},
}]);

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	...workbenchConfigurationNodeBase,
	properties: {
		[OnyxSettingId.Endpoints]: {
			type: 'array',
			scope: ConfigurationScope.MACHINE,
			default: [],
			markdownDescription: localize('onyx.endpoints', "Additional OpenAI-compatible inference endpoints to use besides the auto-discovered local runtimes. Each entry needs a `baseUrl` (for example `http://localhost:11434/v1`) and may set an explicit `models` list and a `contextWindow` override. An API key is not written here: run **Onyx: Set Endpoint API Key**, which keeps it in the system's secret storage."),
			items: {
				type: 'object',
				required: ['baseUrl'],
				properties: {
					baseUrl: { type: 'string', description: localize('onyx.endpoints.baseUrl', "Base URL of the endpoint, e.g. `http://localhost:11434/v1`.") },
					apiKey: { type: 'string', description: localize('onyx.endpoints.apiKey', "Optional API key sent as a Bearer token."), deprecationMessage: localize('onyx.endpoints.apiKey.deprecated', "API keys are kept in the system's secret storage, not in settings. Run \"Onyx: Set Endpoint API Key\". A key written here is moved there the next time Onyx reads its endpoints, and removed from this file.") },
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
		[OnyxSettingId.SpeculativePairs]: {
			type: 'object',
			scope: ConfigurationScope.APPLICATION,
			default: {},
			additionalProperties: { type: 'string' },
			markdownDescription: localize('onyx.speculative.pairs', "The draft model you configured on your runtime at load time for each target model, as a map from a target model key (`host:port/modelId`) to the draft model id, recorded so that *Onyx: Measure Speculative Decoding* can label its measurement. Onyx never sends a draft model with a request: every runtime that supports speculative decoding configures the draft when the model loads."),
		},
		[OnyxSettingId.VerificationTask]: {
			type: 'string',
			scope: ConfigurationScope.RESOURCE,
			default: '',
			markdownDescription: localize('onyx.verification.task', "Project check to run after an Onyx agent run that used tools, with the pass/fail verdict posted to the run's timeline. Use `build` or `test` for the workspace's default build or test task, any other value for a task with that name, or leave empty to disable."),
		},
		[OnyxSettingId.NetworkTools]: {
			type: 'boolean',
			// Application scope: a repository's settings file cannot opt in on the user's behalf.
			scope: ConfigurationScope.APPLICATION,
			default: false,
			markdownDescription: localize('onyx.agent.networkTools', "Let the Onyx agent use the reviewed network tools: opening a page in the integrated browser, reading a page it opened, and fetching a URL. Off by default, because nothing else in Onyx leaves this machine. When on, every network call still asks first, showing the tool and its arguments, and the tools compete for the same tool slots as everything else. Run **Onyx: Show Agent Tools** to see what is exposed and why."),
		},
		[OnyxSettingId.TerminalPassEnvironment]: {
			type: 'boolean',
			// A user setting: a workspace cannot turn it on for itself.
			scope: ConfigurationScope.APPLICATION,
			default: false,
			markdownDescription: localize('onyx.terminal.passEnvironment', "Pass every environment variable to commands the Onyx agent runs. Off by default: variables whose names contain `TOKEN`, `SECRET`, `KEY`, `PASSWORD` or `CREDENTIAL` are withheld, so a command the agent proposed does not start with your credentials in its environment. This is defense in depth only. It does not touch a secret stored under another name, in a file or in a credential helper, and an approved command can still read anything your account can."),
		},
		[OnyxSettingId.BackgroundReview]: {
			type: 'boolean',
			scope: ConfigurationScope.RESOURCE,
			default: false,
			description: localize('onyx.review.background', "When the machine is idle, plugged in and thermally comfortable, quietly review uncommitted changes with a local model and file findings in the Problems panel under the \"onyx\" source. Any activity cancels the review instantly."),
		},
		[OnyxSettingId.EnergyPolicy]: {
			type: 'string',
			scope: ConfigurationScope.APPLICATION,
			enum: ['balanced', 'performance', 'efficiency'],
			default: 'balanced',
			enumDescriptions: [
				localize('onyx.energy.balanced', "Route to smaller models and complete less often on battery or under thermal pressure."),
				localize('onyx.energy.performance', "Always use the best model for the job, regardless of power source or temperature."),
				localize('onyx.energy.efficiency', "Prefer the smallest capable models everywhere; on battery, inline autocomplete turns off."),
			],
			description: localize('onyx.energy.policy', "How Onyx trades model quality against battery and heat. The Compute view explains any downshift in plain language."),
		},
	},
});
