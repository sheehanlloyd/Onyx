/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IJSONSchema } from '../../../../base/common/jsonSchema.js';
import { OnyxTaskKind } from './onyxTypes.js';

/**
 * The checked-in team configuration: `.onyx/config.json` at a workspace root.
 * Everything in it is a *default the repository ships* — per-user settings
 * always win, and nothing here can reach outside the workspace (no URLs, no
 * commands beyond a task name). Parsing is tolerant and reports problems
 * instead of throwing: a broken config should degrade to "ignored with a
 * message", never to a broken product.
 */

export interface IOnyxProjectConfig {
	/** Pinned model per task kind, as a model key (`host:port/model`) or bare model id. */
	readonly models?: Partial<Record<OnyxTaskKind, string>>;
	/** The project check to run after tool-using agent runs (same semantics as `onyx.verification.task`). */
	readonly verificationTask?: string;
	/** Files every prompt should carry, workspace-relative. */
	readonly contextPins?: readonly string[];
	/** Review findings below this severity are not shown. */
	readonly reviewSeverityThreshold?: 'low' | 'medium' | 'high';
	/** Tool ids or reference names the agent must not use in this repository. */
	readonly disabledTools?: readonly string[];
}

export const ONYX_PROJECT_CONFIG_PATH = '.onyx/config.json';
export const ONYX_PROJECT_CONFIG_SCHEMA_ID = 'vscode://schemas/onyx-config';

const TASK_KINDS: readonly OnyxTaskKind[] = ['quick-edit', 'implement', 'debug', 'plan', 'chat', 'review'];
const SEVERITIES = ['low', 'medium', 'high'];

export interface IOnyxProjectConfigParse {
	readonly config: IOnyxProjectConfig;
	/** Human-readable problems; offending fields are dropped, the rest is kept. */
	readonly problems: readonly string[];
}

export function parseProjectConfig(json: string): IOnyxProjectConfigParse {
	const problems: string[] = [];
	let raw: unknown;
	try {
		raw = JSON.parse(json);
	} catch (error) {
		return { config: {}, problems: [`not valid JSON: ${error instanceof Error ? error.message : String(error)}`] };
	}
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
		return { config: {}, problems: ['the config must be a JSON object'] };
	}
	const value = raw as Record<string, unknown>;
	const config: {
		models?: Partial<Record<OnyxTaskKind, string>>;
		verificationTask?: string;
		contextPins?: string[];
		reviewSeverityThreshold?: 'low' | 'medium' | 'high';
		disabledTools?: string[];
	} = {};

	if (value.models !== undefined) {
		if (typeof value.models === 'object' && value.models !== null && !Array.isArray(value.models)) {
			const models: Partial<Record<OnyxTaskKind, string>> = {};
			for (const [task, model] of Object.entries(value.models as Record<string, unknown>)) {
				if (!TASK_KINDS.includes(task as OnyxTaskKind)) {
					problems.push(`models: unknown task kind "${task}" (expected one of ${TASK_KINDS.join(', ')})`);
				} else if (typeof model !== 'string' || !model) {
					problems.push(`models.${task}: expected a model id string`);
				} else {
					models[task as OnyxTaskKind] = model;
				}
			}
			if (Object.keys(models).length > 0) {
				config.models = models;
			}
		} else {
			problems.push('models: expected an object mapping task kinds to model ids');
		}
	}

	if (value.verificationTask !== undefined) {
		if (typeof value.verificationTask === 'string') {
			config.verificationTask = value.verificationTask;
		} else {
			problems.push('verificationTask: expected a string');
		}
	}

	if (value.contextPins !== undefined) {
		if (Array.isArray(value.contextPins) && value.contextPins.every(pin => typeof pin === 'string')) {
			config.contextPins = value.contextPins as string[];
		} else {
			problems.push('contextPins: expected an array of workspace-relative paths');
		}
	}

	if (value.reviewSeverityThreshold !== undefined) {
		if (typeof value.reviewSeverityThreshold === 'string' && SEVERITIES.includes(value.reviewSeverityThreshold)) {
			config.reviewSeverityThreshold = value.reviewSeverityThreshold as 'low' | 'medium' | 'high';
		} else {
			problems.push(`reviewSeverityThreshold: expected one of ${SEVERITIES.join(', ')}`);
		}
	}

	if (value.disabledTools !== undefined) {
		if (Array.isArray(value.disabledTools) && value.disabledTools.every(tool => typeof tool === 'string')) {
			config.disabledTools = value.disabledTools as string[];
		} else {
			problems.push('disabledTools: expected an array of tool names');
		}
	}

	for (const key of Object.keys(value)) {
		if (!['models', 'verificationTask', 'contextPins', 'reviewSeverityThreshold', 'disabledTools', '$schema'].includes(key)) {
			problems.push(`unknown field "${key}"`);
		}
	}

	return { config, problems };
}

/** Whether a review finding of `severity` passes the configured threshold. */
export function passesSeverityThreshold(severity: 'low' | 'medium' | 'high', threshold: 'low' | 'medium' | 'high' | undefined): boolean {
	if (!threshold) {
		return true;
	}
	return SEVERITIES.indexOf(severity) >= SEVERITIES.indexOf(threshold);
}

/** The schema contributed to the JSON language service so the file autocompletes. */
export const ONYX_PROJECT_CONFIG_SCHEMA: IJSONSchema = {
	type: 'object',
	allowComments: false,
	allowTrailingCommas: false,
	additionalProperties: false,
	properties: {
		$schema: { type: 'string' },
		models: {
			type: 'object',
			description: 'Pin a model per task kind. Values are model ids (e.g. "qwen2.5-coder:14b") or full Onyx model keys ("localhost:11434/qwen2.5-coder:14b").',
			additionalProperties: false,
			properties: Object.fromEntries(TASK_KINDS.map(task => [task, { type: 'string', description: `Model to use for ${task} requests.` }])),
		},
		verificationTask: {
			type: 'string',
			description: 'Project check to run after tool-using agent runs: "build", "test", or a task name. Per-user onyx.verification.task wins over this.',
		},
		contextPins: {
			type: 'array',
			items: { type: 'string' },
			description: 'Workspace-relative files every agent prompt should carry.',
		},
		reviewSeverityThreshold: {
			type: 'string',
			enum: ['low', 'medium', 'high'],
			description: 'Onyx: Review My Changes hides findings below this severity.',
		},
		disabledTools: {
			type: 'array',
			items: { type: 'string' },
			description: 'Tool ids or reference names the agent must not use in this repository.',
		},
	},
};
