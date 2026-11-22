/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IOnyxLabHarnessRequest } from '../../../../platform/onyxRuntime/common/onyxRuntime.js';
import { ONYX_EVICTION_POLICIES, OnyxEvictionPolicy } from './onyxContextBudget.js';
import { toolResultBudget } from './onyxContextCompression.js';
import { traceDigest } from './onyxTrace.js';
import { IOnyxModelProfile, OnyxPromptStyle } from './onyxTypes.js';

/**
 * The harness configuration (L4). Everything the agent loop decides about
 * how it talks to a model is a field here: one field a component, each a
 * named value that is recorded with the run. The profile (and the model's
 * datasheet, L5) produce the configuration; the loop reads the configuration
 * and nothing else. Its hash is in every trace, so two runs can be told to
 * have been run the same way.
 *
 * Two kinds of value. The ones `deriveHarnessConfig` produces are what the
 * product runs. Any other is a lab value: it exists so that a component can
 * be switched off or changed and the difference measured (L13, L14). A lab
 * value is taken only from a manifest, and only where the product is not a
 * packaged build (`resolveHarnessConfig`). Nothing here is unsafe to run:
 * code that is unsafe by design is not a configuration value and does not
 * exist outside the tests (DEC-10).
 *
 * The configuration is flat on purpose: a field is a switch, a manifest
 * names switches, and a diagnostics export carries switches and nothing
 * nested.
 */
export interface IOnyxHarnessConfig {
	/**
	 * How the model's tool calls are read. `native`: only the runtime's
	 * tool-call channel. `repaired-text`: that channel, and a call the model
	 * wrote as text is recognised and run. `constrained-envelope`: every turn
	 * is decoded against the tool-or-answer schema, with the text repair
	 * behind it.
	 */
	readonly toolCallProtocol: OnyxToolCallProtocol;
	/**
	 * How the model proposes an edit. `search-replace`: quoted text and its replacement. `constrained-anchors`
	 * (L7, experimental, a lab arm only): in a constrained turn the model may also name the first and last
	 * line to replace, chosen from an enumeration of the lines it was shown this turn.
	 */
	readonly editProtocol: OnyxEditProtocol;
	/** How much the prompt says, and how much history and workspace context it carries. */
	readonly promptStyle: OnyxPromptStyle;
	/** The most characters of one tool result that go back to the model; past it the middle is elided. */
	readonly toolResultChars: number;
	/** What is dropped, in what order, when a turn does not fit (B13). */
	readonly evictionPolicy: OnyxEvictionPolicy;
	/** The context a turn is fitted to, in tokens. */
	readonly contextTokens: number;
	/** The most model turns in one run. */
	readonly turnCap: number;
	/** Whether a run that used a tool ends with the workspace's problems compared to how it started. */
	readonly verificationFeedback: boolean;
	/** Whether the read tool numbers the lines it returns. */
	readonly readToolLineNumbering: boolean;
	/** Which tools get a place in the request when there are more than there are places (B1). */
	readonly toolSlotPolicy: OnyxToolSlotPolicy;
	/** How many places there are. */
	readonly maxTools: number;
}

export type OnyxToolCallProtocol = 'native' | 'repaired-text' | 'constrained-envelope';
export type OnyxEditProtocol = 'search-replace' | 'constrained-anchors';
export type { OnyxEvictionPolicy };
export type OnyxToolSlotPolicy = 'essentials-first';

/** Below this share of well-formed tool calls a model's turns are constrained, when its runtime can enforce a schema. */
export const ONYX_CONSTRAIN_BELOW_TOOL_CALL_QUALITY = 0.75;

/** What the configuration is derived from besides the profile. */
export interface IOnyxHarnessFacts {
	/** Whether the model's runtime enforces a JSON schema on a reply. */
	readonly runtimeEnforcesSchema: boolean;
}

/**
 * The configuration the product runs for a model: the decisions the loop
 * used to take inline, unchanged. A model whose tool calls are often
 * malformed is constrained when its runtime can enforce a schema; a compact
 * prompt goes with a shorter run and smaller tool results.
 */
export function deriveHarnessConfig(profile: IOnyxModelProfile, facts: IOnyxHarnessFacts): IOnyxHarnessConfig {
	return {
		toolCallProtocol: profile.toolCallQuality < ONYX_CONSTRAIN_BELOW_TOOL_CALL_QUALITY && facts.runtimeEnforcesSchema ? 'constrained-envelope' : 'repaired-text',
		editProtocol: 'search-replace',
		promptStyle: profile.promptStyle,
		toolResultChars: toolResultBudget(profile.promptStyle),
		evictionPolicy: 'oldest-results-first',
		contextTokens: profile.contextLength,
		turnCap: profile.promptStyle === 'compact' ? 8 : 16,
		verificationFeedback: true,
		readToolLineNumbering: true,
		toolSlotPolicy: 'essentials-first',
		maxTools: profile.maxTools,
	};
}

/** Where the product is running. Only a build from source, which is also what the tests run, takes a lab configuration. */
export type OnyxHarnessContext = 'packaged' | 'development';

export interface IOnyxResolvedHarness {
	readonly configuration: IOnyxHarnessConfig;
	/** The hash the trace carries: of the configuration that ran, whatever was asked for. */
	readonly hash: string;
	/** `default`: derived for the model. `lab`: a manifest's entry was applied over it. */
	readonly source: 'default' | 'lab';
	/** The manifest entry that was asked for, when one was. */
	readonly requested?: { readonly manifest: string; readonly name: string };
	/** Why what was asked for was not applied. The configuration is then the default one. */
	readonly refused?: string;
	/** The seed and temperature a campaign set for the run (L9). Present only beside an applied lab configuration. */
	readonly sampling?: IOnyxLabSampling;
}

/** What a campaign fixes about sampling for one run (L9): what a profile would otherwise decide. */
export interface IOnyxLabSampling {
	readonly seed?: number;
	readonly temperature?: number;
}

const PROTOCOLS: readonly OnyxToolCallProtocol[] = ['native', 'repaired-text', 'constrained-envelope'];
const PROMPT_STYLES: readonly OnyxPromptStyle[] = ['compact', 'full'];

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function integerIn(value: unknown, minimum: number, maximum: number): value is number {
	return typeof value === 'number' && Number.isInteger(value) && value >= minimum && value <= maximum;
}

/**
 * Applies a requested configuration over a default one, field by field.
 * Every field is checked: an unknown field, a value of the wrong type or one
 * outside its range is a problem, and a request with any problem is not
 * applied at all.
 */
function applyRequest(base: IOnyxHarnessConfig, requested: unknown): { readonly configuration: IOnyxHarnessConfig; readonly problems: readonly string[] } {
	if (!isRecord(requested)) {
		return { configuration: base, problems: ['the configuration is not an object'] };
	}
	const problems: string[] = [];
	let configuration = base;
	for (const [key, value] of Object.entries(requested)) {
		switch (key) {
			case 'toolCallProtocol': {
				const protocol = PROTOCOLS.find(candidate => candidate === value);
				if (protocol) {
					configuration = { ...configuration, toolCallProtocol: protocol };
				} else {
					problems.push(`toolCallProtocol must be one of ${PROTOCOLS.join(', ')}`);
				}
				break;
			}
			case 'editProtocol':
				if (value === 'search-replace' || value === 'constrained-anchors') {
					configuration = { ...configuration, editProtocol: value };
				} else {
					problems.push('editProtocol must be one of search-replace, constrained-anchors');
				}
				break;
			case 'promptStyle': {
				const style = PROMPT_STYLES.find(candidate => candidate === value);
				if (style) {
					configuration = { ...configuration, promptStyle: style };
				} else {
					problems.push(`promptStyle must be one of ${PROMPT_STYLES.join(', ')}`);
				}
				break;
			}
			case 'toolResultChars':
				if (integerIn(value, 200, 1_000_000)) {
					configuration = { ...configuration, toolResultChars: value };
				} else {
					problems.push('toolResultChars must be a whole number from 200 to 1000000');
				}
				break;
			case 'evictionPolicy':
				if (typeof value === 'string' && (ONYX_EVICTION_POLICIES as readonly string[]).includes(value)) {
					configuration = { ...configuration, evictionPolicy: value as OnyxEvictionPolicy };
				} else {
					problems.push(`evictionPolicy must be one of ${ONYX_EVICTION_POLICIES.join(', ')}`);
				}
				break;
			case 'contextTokens':
				if (integerIn(value, 512, 4_000_000)) {
					configuration = { ...configuration, contextTokens: value };
				} else {
					problems.push('contextTokens must be a whole number from 512 to 4000000');
				}
				break;
			case 'turnCap':
				if (integerIn(value, 1, 64)) {
					configuration = { ...configuration, turnCap: value };
				} else {
					problems.push('turnCap must be a whole number from 1 to 64');
				}
				break;
			case 'verificationFeedback':
			case 'readToolLineNumbering':
				if (typeof value === 'boolean') {
					configuration = { ...configuration, [key]: value };
				} else {
					problems.push(`${key} must be true or false`);
				}
				break;
			case 'toolSlotPolicy':
				if (value !== 'essentials-first') {
					problems.push('toolSlotPolicy must be essentials-first: no other slot policy exists yet');
				}
				break;
			case 'maxTools':
				if (integerIn(value, 1, 64)) {
					configuration = { ...configuration, maxTools: value };
				} else {
					problems.push('maxTools must be a whole number from 1 to 64');
				}
				break;
			default:
				problems.push(`${key} is not a field of the harness configuration`);
		}
	}
	return { configuration, problems };
}

/**
 * The hash of a configuration: the same for the same values whatever order
 * they were written in, and different for any other.
 */
export function harnessConfigHash(configuration: IOnyxHarnessConfig): string {
	const ordered = Object.fromEntries(Object.entries(configuration).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
	return traceDigest(JSON.stringify(ordered));
}

/**
 * The configuration a run uses. With nothing requested it is the default.
 * A request is applied over the default only in a development build; a
 * packaged build refuses it, whatever it asks for, and says so. A request
 * that is malformed is refused everywhere. A refused request never changes
 * the run: the default configuration is used and the refusal is recorded
 * beside it.
 */
export function resolveHarnessConfig(base: IOnyxHarnessConfig, request: IOnyxLabHarnessRequest | undefined, context: OnyxHarnessContext, sampling?: IOnyxLabSampling): IOnyxResolvedHarness {
	if (!request) {
		return { configuration: base, hash: harnessConfigHash(base), source: 'default' };
	}
	const requested = { manifest: request.manifest, name: request.name };
	const refuse = (refused: string): IOnyxResolvedHarness => ({ configuration: base, hash: harnessConfigHash(base), source: 'default', requested, refused });
	if (context === 'packaged') {
		return refuse('a lab configuration is accepted only by a development build; this is a packaged build');
	}
	if (request.problem) {
		return refuse(request.problem);
	}
	const applied = applyRequest(base, request.configuration);
	if (applied.problems.length > 0) {
		return refuse(applied.problems.join('; '));
	}
	const validSampling = sampling && (sampling.seed === undefined || (Number.isInteger(sampling.seed) && sampling.seed >= 0)) && (sampling.temperature === undefined || (typeof sampling.temperature === 'number' && sampling.temperature >= 0 && sampling.temperature <= 2));
	if (sampling && !validSampling) {
		return refuse('the seed must be a whole number from 0 and the temperature a number from 0 to 2');
	}
	return { configuration: applied.configuration, hash: harnessConfigHash(applied.configuration), source: 'lab', requested, ...(sampling ? { sampling } : {}) };
}
