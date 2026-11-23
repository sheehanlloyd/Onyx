/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { workbenchConfigurationNodeBase } from '../../../common/configuration.js';
import { ONYX_INDEX_MAX_FILES } from './onyxIndexOptions.js';

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
	InferenceStrictLocal = 'onyx.inference.strictLocal',
	InferenceAllowLan = 'onyx.inference.allowLan',
	IndexMaxFiles = 'onyx.index.maxFiles',
	ContextRequestTokens = 'onyx.context.requestTokens',
	LabRequestTasks = 'onyx.lab.requestTasks',
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
		// The gallery is Open VSX (D1). It is asked when the user opens the
		// Extensions view, searches or installs; it is not asked in the
		// background. Upstream checks for and installs extension updates on a
		// timer, and fetches recommendations at startup: both are outbound
		// requests the user did not make (D8's egress rule), so both start off.
		'extensions.autoCheckUpdates': false,
		'extensions.autoUpdate': false,
		'extensions.ignoreRecommendations': true,
		// What the Settings editor shows matches what the installer does: this
		// build cannot verify an extension's signature (see the note in
		// extensionManagementService.ts). docs/SUPPORT.md says so to the user.
		'extensions.verifySignature': false,
		'workbench.enableExperiments': false,
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
		[OnyxSettingId.InferenceStrictLocal]: {
			type: 'boolean',
			// User settings: a workspace cannot loosen where prompts may go.
			scope: ConfigurationScope.APPLICATION,
			default: true,
			markdownDescription: localize('onyx.inference.strictLocal', "Use a model only when its runtime identifies itself and reports that it runs the model itself, on this machine. With this on, Onyx does not use a model the runtime reports as cloud-backed (even through a runtime on this machine), a server that does not say what it is, or an endpoint on the internet. This rests on what the runtime reports: Onyx cannot establish what a runtime does beyond that. Run **Onyx: Show Where Inference Happens** to see each model and why it is or is not used."),
		},
		[OnyxSettingId.InferenceAllowLan]: {
			type: 'boolean',
			scope: ConfigurationScope.APPLICATION,
			default: false,
			markdownDescription: localize('onyx.inference.allowLan', "Use inference endpoints on your local network. Off by default: adding a network address to `onyx.endpoints` lists its models and does not send them anything. With this on, prompts and code are sent to that machine, and whatever else can reach it can use it too."),
		},
		[OnyxSettingId.IndexMaxFiles]: {
			type: 'integer',
			// A user setting: a workspace cannot raise the memory Onyx uses for it.
			scope: ConfigurationScope.APPLICATION,
			default: ONYX_INDEX_MAX_FILES.default,
			minimum: ONYX_INDEX_MAX_FILES.minimum,
			maximum: ONYX_INDEX_MAX_FILES.maximum,
			markdownDescription: localize('onyx.index.maxFiles', "The most files of one workspace folder that Onyx's content index holds. Files that `files.exclude`, `search.exclude` or the folder's `.gitignore` leave out are not indexed. When a folder has more files than this, source folders are indexed first and tests, documentation and examples last, and search results from the index say how much of the folder it holds. The index keeps roughly one and a half times the size of the indexed text in memory, and stops at 256 MB of text whatever this number is."),
		},
		[OnyxSettingId.LabRequestTasks]: {
			type: 'boolean',
			// Decided for one workspace at a time: it is that workspace's journal the tasks are made from.
			scope: ConfigurationScope.RESOURCE,
			default: false,
			markdownDescription: localize('onyx.lab.requestTasks', "Let Onyx make benchmark tasks for this workspace out of your own requests. A request becomes a task when you accepted its proposal and the lines you accepted were later committed: the instruction is what you asked for, and the reference is the file at that commit. Off by default. The tasks are read from this workspace's run journal when a measurement runs, are used on this machine only, and nothing is uploaded."),
		},
		[OnyxSettingId.ContextRequestTokens]: {
			type: 'integer',
			// A user setting: a workspace cannot raise the memory a model takes on this machine.
			scope: ConfigurationScope.APPLICATION,
			default: 16384,
			minimum: 0,
			maximum: 1048576,
			markdownDescription: localize('onyx.context.requestTokens', "The context, in tokens, that Onyx asks a runtime to give a model when you run **Onyx: Request a Larger Model Context**. Onyx asks for the smallest of this number, the context the model was trained with, and a ceiling from this machine's memory (half the memory, less the model's size, at 96 KiB a token). `0` keeps the server's own allocation and asks for nothing. Nothing is created or changed on the runtime until you agree in the dialog, and the larger context is used only after a check has seen it work."),
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
