/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { IOnyxModelProfile } from './onyxTypes.js';

/**
 * The model datasheet (L5): what a model on a runtime was measured to do, as
 * opposed to what its size or its runtime's advertisement suggests. A probe
 * suite produces it (`onyxDatasheetProbes.ts`); this file is what a datasheet
 * is, when it still describes the model, and what a profile takes from it.
 *
 * Every probe result is successes over trials. A percentage is never stored
 * and never shown without its counts: five trials is five trials.
 */

/** How a probe's result is always stated. */
export interface IOnyxTally {
	readonly successes: number;
	readonly trials: number;
}

export function tallyOf(outcomes: readonly boolean[]): IOnyxTally {
	return { successes: outcomes.filter(outcome => outcome).length, trials: outcomes.length };
}

export function formatTally(tally: IOnyxTally): string {
	return `${tally.successes} of ${tally.trials}`;
}

/** One step of the context probe: a prompt of this size, and whether the token planted at its start came back. */
export interface IOnyxContextStep {
	/** The prompt's size in tokens: as the runtime counted it when it said, estimated otherwise. */
	readonly promptTokens: number;
	readonly recalled: boolean;
}

export interface IOnyxDatasheet {
	readonly version: 1;
	/** The model's id as requests name it. */
	readonly model: string;
	/** The weights digest the runtime reported when the model was measured; null when it reports none. */
	readonly digest: string | null;
	readonly runtime: { readonly name: string; readonly version: string | null };
	/** When the measurement ended, ISO 8601. */
	readonly measuredAt: string;
	/** A valid call to the offered tool arrived on the runtime's tool-call channel. */
	readonly nativeToolCalls: IOnyxTally;
	/** Of the replies with no native call: the text repair read a call to the offered tool out of the reply. */
	readonly repairableTextCalls: IOnyxTally;
	/** With a JSON schema sent and a prompt that asks for something else, the reply still matched the schema. */
	readonly schemaEnforced: { readonly object: IOnyxTally; readonly enum: IOnyxTally; readonly nested: IOnyxTally };
	readonly context: {
		/** The longest prompt, in tokens, at which the planted token was recalled. Null when none was. */
		readonly recalledUpToTokens: number | null;
		/** The shortest prompt at which it was not. Null when every prompt tried was recalled. */
		readonly failedFromTokens: number | null;
		/** What the server said it allocates, when it said. The probe does not go past it. */
		readonly serverReportedTokens: number | null;
		readonly steps: readonly IOnyxContextStep[];
	};
	/** A reply asked to stay under an output cap did, and ended for that reason. */
	readonly outputCapHonoured: IOnyxTally;
	/** A reply ended at a stop sequence it would otherwise have written past. */
	readonly stopHonoured: IOnyxTally;
	/** Whether replies carry thinking, and how: in tags in the text, or in a field of its own (C4). */
	readonly reasoning: { readonly style: 'none' | 'tags' | 'field'; readonly replies: IOnyxTally };
	/** The same request with the same seed, sampled at a temperature above zero, gave the same reply. */
	readonly seedRepeatable: IOnyxTally;
	/** Token log-probabilities came back when asked for. */
	readonly logprobs: IOnyxTally;
	readonly speed: {
		/** First token of the first request, when the model was not loaded before the suite began. */
		readonly coldFirstTokenMs: number | null;
		/** Median first token of the short requests after it. */
		readonly warmFirstTokenMs: number | null;
		readonly tokensPerSecond: number | null;
	};
	/** Probes that could not be completed, and why. Their tallies have no trials. */
	readonly unmeasured: readonly { readonly probe: string; readonly reason: string }[];
}

/** A tally with fewer trials than this decides nothing. */
export const ONYX_DATASHEET_MIN_TRIALS = 3;

/**
 * Whether a datasheet still describes the model it is asked about. It is of
 * one set of weights on one version of one runtime: a different digest, a
 * different runtime or a different runtime version is a different subject,
 * and the datasheet is not used.
 */
export function datasheetStaleness(datasheet: IOnyxDatasheet, model: { readonly id: string; readonly digest?: string; readonly runtime: string; readonly runtimeVersion?: string }): string | undefined {
	if (datasheet.model !== model.id) {
		return `it is for ${datasheet.model}`;
	}
	if ((datasheet.digest ?? null) !== (model.digest ?? null)) {
		return 'the model\'s weights have changed since it was measured';
	}
	if (datasheet.runtime.name !== model.runtime) {
		return `it was measured on ${datasheet.runtime.name}`;
	}
	if ((datasheet.runtime.version ?? null) !== (model.runtimeVersion ?? null)) {
		return `the runtime was ${datasheet.runtime.version ?? 'an unknown version'} when it was measured and is ${model.runtimeVersion ?? 'an unknown version'} now`;
	}
	return undefined;
}

/** The share of native tool calls that were valid, when enough were tried to say. */
export function measuredToolCallQuality(datasheet: IOnyxDatasheet): number | undefined {
	return datasheet.nativeToolCalls.trials >= ONYX_DATASHEET_MIN_TRIALS ? datasheet.nativeToolCalls.successes / datasheet.nativeToolCalls.trials : undefined;
}

/**
 * Whether the runtime enforces a schema, when that was measured. All three
 * shapes the tool-or-answer envelope uses have to have been tried enough,
 * and enforcement means every trial of every one: a schema that holds most
 * of the time is not enforced.
 */
export function measuredSchemaEnforcement(datasheet: IOnyxDatasheet): boolean | undefined {
	const tallies = [datasheet.schemaEnforced.object, datasheet.schemaEnforced.enum, datasheet.schemaEnforced.nested];
	if (tallies.some(tally => tally.trials < ONYX_DATASHEET_MIN_TRIALS)) {
		return undefined;
	}
	return tallies.every(tally => tally.successes === tally.trials);
}

/**
 * The context the model was measured to have. The longest prompt whose
 * start it still had, when a longer one was tried and had lost it. The probe
 * does not go past what the server said it allocated, so it often finds no
 * limit; then the context is what the server said when the model was
 * measured, provided the probe recalled something inside it. A prompt longer
 * than that is cut by the runtime without an error, which is what the number
 * is for. A probe that recalled nothing measured nothing.
 */
export function measuredContextTokens(datasheet: IOnyxDatasheet): number | undefined {
	const { recalledUpToTokens, failedFromTokens, serverReportedTokens } = datasheet.context;
	if (recalledUpToTokens === null || recalledUpToTokens <= 0) {
		return undefined;
	}
	return failedFromTokens !== null ? recalledUpToTokens : serverReportedTokens ?? undefined;
}

/**
 * A profile with what was measured in place of what was guessed. Three
 * things are taken from a datasheet: how often a native tool call is valid,
 * whether the runtime enforces a schema, and the context. Each is labelled
 * `measured` or `default` in `provenance`, so a reader can tell a number that
 * was observed from one that was assumed. Everything else in the profile is
 * left as it was: a datasheet does not measure it.
 *
 * A measured context only ever lowers the budget. The other numbers known
 * for the model still bound it from above.
 */
export function applyDatasheet(profile: IOnyxModelProfile, datasheet: IOnyxDatasheet | undefined): IOnyxModelProfile {
	const quality = datasheet ? measuredToolCallQuality(datasheet) : undefined;
	const enforcesSchema = datasheet ? measuredSchemaEnforcement(datasheet) : undefined;
	const context = datasheet ? measuredContextTokens(datasheet) : undefined;
	const contextLength = context !== undefined ? Math.min(profile.contextLength, context) : profile.contextLength;
	return {
		...profile,
		toolCallQuality: quality ?? profile.toolCallQuality,
		contextLength,
		...(context !== undefined ? { context: { ...profile.context, measured: context, source: contextLength === context ? 'measured' : profile.context?.source ?? 'default' } } : {}),
		...(enforcesSchema !== undefined ? { runtimeEnforcesSchema: enforcesSchema } : {}),
		provenance: {
			toolCallQuality: quality !== undefined ? 'measured' : 'default',
			contextLength: context !== undefined && contextLength === context ? 'measured' : 'default',
			schemaEnforcement: enforcesSchema !== undefined ? 'measured' : 'default',
		},
	};
}

/**
 * Whether the harness may rely on the runtime to enforce a schema: what was
 * measured when it was, and otherwise what the runtime's kind is assumed to
 * do.
 */
export function runtimeEnforcesSchema(profile: IOnyxModelProfile, assumedForRuntime: boolean | undefined): boolean {
	return profile.runtimeEnforcesSchema ?? assumedForRuntime === true;
}

/** A datasheet in a few lines, counts first, for the model library and the result of a measurement. */
export function describeDatasheet(datasheet: IOnyxDatasheet): string[] {
	const context = datasheet.context;
	const server = context.serverReportedTokens ? localize('onyx.datasheet.context.server', " (the server reports {0})", context.serverReportedTokens) : '';
	const lines = [
		localize('onyx.datasheet.toolCalls', "Tool calls: {0} on the tool channel; {1} of the rest readable as text", formatTally(datasheet.nativeToolCalls), formatTally(datasheet.repairableTextCalls)),
		localize('onyx.datasheet.schema', "Schema enforced: object {0}, enum {1}, nested {2}", formatTally(datasheet.schemaEnforced.object), formatTally(datasheet.schemaEnforced.enum), formatTally(datasheet.schemaEnforced.nested)),
		context.recalledUpToTokens === null
			? localize('onyx.datasheet.context.none', "Context: not measured")
			: context.failedFromTokens === null
				? localize('onyx.datasheet.context.noLimit', "Context: the start of a {0}-token prompt was recalled; no limit found{1}", context.recalledUpToTokens, server)
				: localize('onyx.datasheet.context.limit', "Context: recalled up to {0} tokens, lost from {1}{2}", context.recalledUpToTokens, context.failedFromTokens, server),
		localize('onyx.datasheet.capAndStop', "Output cap honoured {0}; stop honoured {1}", formatTally(datasheet.outputCapHonoured), formatTally(datasheet.stopHonoured)),
		localize('onyx.datasheet.reasoning', "Reasoning: {0} ({1} replies)",
			datasheet.reasoning.style === 'none' ? localize('onyx.datasheet.reasoning.none', "none seen") : datasheet.reasoning.style === 'tags' ? localize('onyx.datasheet.reasoning.tags', "in tags in the text") : localize('onyx.datasheet.reasoning.field', "in a field of its own"),
			formatTally(datasheet.reasoning.replies)),
		localize('onyx.datasheet.seedAndLogprobs', "Same seed, same reply: {0}; log-probabilities returned: {1}", formatTally(datasheet.seedRepeatable), formatTally(datasheet.logprobs)),
		localize('onyx.datasheet.speed', "First token: {0}, {1}; {2}",
			datasheet.speed.coldFirstTokenMs === null ? localize('onyx.datasheet.speed.noCold', "cold not measured") : localize('onyx.datasheet.speed.cold', "{0} ms cold", Math.round(datasheet.speed.coldFirstTokenMs)),
			datasheet.speed.warmFirstTokenMs === null ? localize('onyx.datasheet.speed.noWarm', "warm not measured") : localize('onyx.datasheet.speed.warm', "{0} ms warm", Math.round(datasheet.speed.warmFirstTokenMs)),
			datasheet.speed.tokensPerSecond === null ? localize('onyx.datasheet.speed.noRate', "speed not measured") : localize('onyx.datasheet.speed.rate', "{0} tokens a second", Math.round(datasheet.speed.tokensPerSecond * 10) / 10)),
	];
	for (const entry of datasheet.unmeasured) {
		lines.push(localize('onyx.datasheet.unmeasured', "Not measured: {0} ({1})", entry.probe, entry.reason));
	}
	return lines;
}

/** Which of a profile's numbers were measured for the model and which are defaults, one line each. */
export function describeProvenance(profile: IOnyxModelProfile): string[] {
	const measured = localize('onyx.datasheet.provenance.measured', "measured");
	const byDefault = localize('onyx.datasheet.provenance.default', "default");
	const label = (source: 'measured' | 'default' | undefined) => source === 'measured' ? measured : byDefault;
	return [
		localize('onyx.datasheet.provenance.toolCalls', "Native tool calls valid: {0} ({1})", Math.round(profile.toolCallQuality * 100) / 100, label(profile.provenance?.toolCallQuality)),
		localize('onyx.datasheet.provenance.context', "Context budgeted: {0} tokens ({1})", profile.contextLength, label(profile.provenance?.contextLength)),
		localize('onyx.datasheet.provenance.schema', "Runtime enforces a schema: {0} ({1})",
			profile.runtimeEnforcesSchema === undefined ? localize('onyx.datasheet.provenance.schema.assumed', "as assumed for the runtime's kind") : profile.runtimeEnforcesSchema ? localize('onyx.datasheet.provenance.schema.yes', "yes") : localize('onyx.datasheet.provenance.schema.no', "no"),
			label(profile.provenance?.schemaEnforcement)),
	];
}
