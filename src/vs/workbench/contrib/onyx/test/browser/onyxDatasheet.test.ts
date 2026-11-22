/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { applyDatasheet, datasheetStaleness, describeDatasheet, IOnyxDatasheet, IOnyxTally, runtimeEnforcesSchema } from '../../common/onyxDatasheet.js';
import { deriveHarnessConfig } from '../../common/onyxHarnessConfig.js';
import { IOnyxModelProfile } from '../../common/onyxTypes.js';

/**
 * R-45, the pure half (L5): what a profile takes from a datasheet, when a
 * datasheet stops describing its model, and how it is shown.
 */
suite('OnyxDatasheet', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const of = (successes: number, trials: number): IOnyxTally => ({ successes, trials });

	/** A small model that writes its calls as text, on a runtime that enforces schemas and allocates about 4,000 tokens. */
	const sheet = (overrides: Partial<IOnyxDatasheet> = {}): IOnyxDatasheet => ({
		version: 2, model: 'coder:7b', digest: 'sha256:aaaa', runtime: { name: 'ollama', version: '0.33.0' }, measuredAt: '2026-11-21T00:00:00.000Z',
		nativeToolCalls: of(0, 5), repairableTextCalls: of(5, 5),
		schemaEnforced: { object: of(3, 3), enum: of(3, 3), nested: of(3, 3) },
		context: { recalledUpToTokens: 3900, failedFromTokens: 4600, serverReportedTokens: 4096, requestedTokens: null, verifiedTokens: null, cutObserved: false, mechanism: null, steps: [] },
		outputCapHonoured: of(3, 3), stopHonoured: of(3, 3), reasoning: { style: 'none', replies: of(0, 3) }, seedRepeatable: of(3, 3), logprobs: of(0, 3),
		speed: { coldFirstTokenMs: 2100, warmFirstTokenMs: 180.4, tokensPerSecond: 41.26 },
		unmeasured: [],
		...overrides,
	});

	/** What the size class alone says about a 7B model whose architecture allows 32k. */
	const seeded: IOnyxModelProfile = {
		toolCallQuality: 0.6, contextLength: 32_768, context: { architectural: 32_768, source: 'architectural' }, maxTools: 8, temperature: 0.2, promptStyle: 'compact', family: 'coder', parameterB: 7, supportsVision: false,
	};

	const taken = (profile: IOnyxModelProfile) => ({
		toolCallQuality: profile.toolCallQuality, contextLength: profile.contextLength, contextSource: profile.context?.source, runtimeEnforcesSchema: profile.runtimeEnforcesSchema, provenance: profile.provenance,
		// What a datasheet does not measure stays as it was.
		untouched: profile.maxTools === seeded.maxTools && profile.promptStyle === seeded.promptStyle && profile.temperature === seeded.temperature,
	});

	test('R-45: the profile takes what was measured and labels it; what was not measured keeps its default and is labelled so', () => {
		assert.deepStrictEqual({
			measured: taken(applyDatasheet(seeded, sheet())),
			noDatasheet: taken(applyDatasheet(seeded, undefined)),
			// Two trials decide nothing; a probe that found no limit measured no context; a schema probe that never ran says nothing.
			tooFewTrials: taken(applyDatasheet(seeded, sheet({ nativeToolCalls: of(2, 2), schemaEnforced: { object: of(3, 3), enum: of(0, 0), nested: of(3, 3) }, context: { recalledUpToTokens: 16_384, failedFromTokens: null, serverReportedTokens: null, requestedTokens: null, verifiedTokens: null, cutObserved: false, mechanism: null, steps: [] } }))),
			// Enforced means every trial: one reply out of nine that escaped the schema is a schema that is not enforced.
			schemaMostlyHeld: taken(applyDatasheet(seeded, sheet({ schemaEnforced: { object: of(3, 3), enum: of(2, 3), nested: of(3, 3) } }))).runtimeEnforcesSchema,
			// A measurement never raises the budget: another number known for the model is smaller.
			measuredAboveWhatIsKnown: taken(applyDatasheet({ ...seeded, contextLength: 2048, context: { serverConfigured: 2048, architectural: 32_768, source: 'server' } }, sheet())),
			capableModel: taken(applyDatasheet(seeded, sheet({ nativeToolCalls: of(5, 5), repairableTextCalls: of(0, 0) }))).toolCallQuality,
			// The probe stays inside what the server said it allocated, so it can find no limit. What the server
			// said when the model was measured is then the context: a prompt past it would be cut without a word.
			noLimitFoundInsideWhatTheServerAllocated: taken(applyDatasheet(seeded, sheet({ context: { recalledUpToTokens: 3514, failedFromTokens: null, serverReportedTokens: 4096, requestedTokens: null, verifiedTokens: null, cutObserved: false, mechanism: null, steps: [] } }))),
		}, {
			measured: {
				toolCallQuality: 0, contextLength: 3900, contextSource: 'measured', runtimeEnforcesSchema: true,
				provenance: { toolCallQuality: 'measured', contextLength: 'measured', schemaEnforcement: 'measured' }, untouched: true,
			},
			noDatasheet: {
				toolCallQuality: 0.6, contextLength: 32_768, contextSource: 'architectural', runtimeEnforcesSchema: undefined,
				provenance: { toolCallQuality: 'default', contextLength: 'default', schemaEnforcement: 'default' }, untouched: true,
			},
			tooFewTrials: {
				toolCallQuality: 0.6, contextLength: 32_768, contextSource: 'architectural', runtimeEnforcesSchema: undefined,
				provenance: { toolCallQuality: 'default', contextLength: 'default', schemaEnforcement: 'default' }, untouched: true,
			},
			schemaMostlyHeld: false,
			measuredAboveWhatIsKnown: {
				toolCallQuality: 0, contextLength: 2048, contextSource: 'server', runtimeEnforcesSchema: true,
				provenance: { toolCallQuality: 'measured', contextLength: 'default', schemaEnforcement: 'measured' }, untouched: true,
			},
			capableModel: 1,
			noLimitFoundInsideWhatTheServerAllocated: {
				toolCallQuality: 0, contextLength: 4096, contextSource: 'measured', runtimeEnforcesSchema: true,
				provenance: { toolCallQuality: 'measured', contextLength: 'measured', schemaEnforcement: 'measured' }, untouched: true,
			},
		});
	});

	test('R-45: the harness configuration follows the measurement: constrained only where native calls fail and the schema was seen to hold', () => {
		const protocol = (datasheet: IOnyxDatasheet | undefined, assumed: boolean | undefined) => {
			const profile = applyDatasheet(seeded, datasheet);
			return deriveHarnessConfig(profile, { runtimeEnforcesSchema: runtimeEnforcesSchema(profile, assumed) }).toolCallProtocol;
		};
		assert.deepStrictEqual({
			// Unmeasured: the size class says tool calls are unreliable and the runtime's kind is assumed to enforce a schema.
			unmeasuredOnARuntimeAssumedToEnforce: protocol(undefined, true),
			unmeasuredOnAnUnknownRuntime: protocol(undefined, undefined),
			nativeCallsFailSchemaHolds: protocol(sheet(), true),
			// Measured to ignore schemas: constraining would promise what the runtime does not do, whatever its kind is assumed to do.
			nativeCallsFailSchemaIgnored: protocol(sheet({ schemaEnforced: { object: of(0, 3), enum: of(0, 3), nested: of(0, 3) } }), true),
			// Measured to enforce on a runtime nobody assumed anything about.
			schemaHoldsOnAnUnknownRuntime: protocol(sheet(), undefined),
			// A small model that calls tools properly is not constrained because it is small.
			nativeCallsWork: protocol(sheet({ nativeToolCalls: of(5, 5), repairableTextCalls: of(0, 0) }), true),
		}, {
			unmeasuredOnARuntimeAssumedToEnforce: 'constrained-envelope',
			unmeasuredOnAnUnknownRuntime: 'repaired-text',
			nativeCallsFailSchemaHolds: 'constrained-envelope',
			nativeCallsFailSchemaIgnored: 'repaired-text',
			schemaHoldsOnAnUnknownRuntime: 'constrained-envelope',
			nativeCallsWork: 'repaired-text',
		});
	});

	test('R-45: a datasheet is of one set of weights on one version of one runtime; for anything else it is stale and says why', () => {
		const model = { id: 'coder:7b', digest: 'sha256:aaaa', runtime: 'ollama', runtimeVersion: '0.33.0' };
		assert.deepStrictEqual({
			same: datasheetStaleness(sheet(), model),
			otherWeights: datasheetStaleness(sheet(), { ...model, digest: 'sha256:bbbb' }),
			runtimeUpdated: datasheetStaleness(sheet(), { ...model, runtimeVersion: '0.34.0' }),
			otherRuntime: datasheetStaleness(sheet(), { ...model, runtime: 'lmstudio' }),
			otherModel: datasheetStaleness(sheet(), { ...model, id: 'coder:1.5b' }),
			// A runtime that reports no digest and no version, then and now: nothing changed that can be seen.
			nothingReportedEitherTime: datasheetStaleness(sheet({ digest: null, runtime: { name: 'lmstudio', version: null } }), { id: 'coder:7b', runtime: 'lmstudio' }),
			digestAppeared: datasheetStaleness(sheet({ digest: null }), model),
		}, {
			same: undefined,
			otherWeights: 'the model\'s weights have changed since it was measured',
			runtimeUpdated: 'the runtime was 0.33.0 when it was measured and is 0.34.0 now',
			otherRuntime: 'it was measured on ollama',
			otherModel: 'it is for coder:7b',
			nothingReportedEitherTime: undefined,
			digestAppeared: 'the model\'s weights have changed since it was measured',
		});
	});

	test('R-45: a datasheet is described in counts, never in a bare percentage, and says what it did not measure', () => {
		assert.deepStrictEqual({
			full: describeDatasheet(sheet()),
			partial: describeDatasheet(sheet({
				context: { recalledUpToTokens: 16_384, failedFromTokens: null, serverReportedTokens: null, requestedTokens: null, verifiedTokens: null, cutObserved: false, mechanism: null, steps: [] },
				reasoning: { style: 'tags', replies: of(3, 3) },
				speed: { coldFirstTokenMs: null, warmFirstTokenMs: null, tokensPerSecond: null },
				unmeasured: [{ probe: 'cold first token', reason: 'the model was already loaded when the measurement began' }],
			})).slice(2),
			noPercentSign: describeDatasheet(sheet()).some(line => line.includes('%')),
		}, {
			full: [
				'Tool calls: 0 of 5 on the tool channel; 5 of 5 of the rest readable as text',
				'Schema enforced: object 3 of 3, enum 3 of 3, nested 3 of 3',
				'Context: recalled up to 3900 tokens, lost from 4600 (the server reports 4096)',
				'Output cap honoured 3 of 3; stop honoured 3 of 3',
				'Reasoning: none seen (0 of 3 replies)',
				'Same seed, same reply: 3 of 3; log-probabilities returned: 0 of 3',
				'First token: 2100 ms cold, 180 ms warm; 41.3 tokens a second',
			],
			partial: [
				'Context: the start of a 16384-token prompt was recalled; no limit found',
				'Output cap honoured 3 of 3; stop honoured 3 of 3',
				'Reasoning: in tags in the text (3 of 3 replies)',
				'Same seed, same reply: 3 of 3; log-probabilities returned: 0 of 3',
				'First token: cold not measured, warm not measured; speed not measured',
				'Not measured: cold first token (the model was already loaded when the measurement began)',
			],
			noPercentSign: false,
		});
	});
});
