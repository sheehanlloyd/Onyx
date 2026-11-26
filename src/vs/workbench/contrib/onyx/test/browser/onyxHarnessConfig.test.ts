/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { deriveHarnessConfig, harnessConfigHash, IOnyxHarnessConfig, IOnyxResolvedHarness, resolveHarnessConfig } from '../../common/onyxHarnessConfig.js';
import { IOnyxModelProfile } from '../../common/onyxTypes.js';

/**
 * L4, the pure half of R-44: the configuration the product derives for a
 * model is the set of decisions the loop used to take inline, and a
 * configuration asked for from outside is applied only where that is
 * allowed.
 */
suite('OnyxHarnessConfig', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const profile = (overrides: Partial<IOnyxModelProfile>): IOnyxModelProfile => ({
		toolCallQuality: 0.9, contextLength: 32_768, maxTools: 24, temperature: 0.2, promptStyle: 'full', family: 'test', parameterB: 14, supportsVision: false, ...overrides,
	});
	const small = profile({ toolCallQuality: 0.5, contextLength: 8192, maxTools: 8, promptStyle: 'compact', parameterB: 7 });

	test('R-44: the default configuration is what the loop decided before there was one', () => {
		assert.deepStrictEqual({
			largeModel: deriveHarnessConfig(profile({}), { runtimeEnforcesSchema: true }),
			smallModelOnARuntimeThatEnforcesSchemas: deriveHarnessConfig(small, { runtimeEnforcesSchema: true }),
			smallModelOnOneThatDoesNot: deriveHarnessConfig(small, { runtimeEnforcesSchema: false }).toolCallProtocol,
			justAtTheThreshold: deriveHarnessConfig(profile({ toolCallQuality: 0.75 }), { runtimeEnforcesSchema: true }).toolCallProtocol,
		}, {
			largeModel: {
				toolCallProtocol: 'repaired-text',
				editProtocol: 'search-replace',
				promptStyle: 'full',
				toolResultChars: 16_000,
				evictionPolicy: 'oldest-results-first',
				contextTokens: 32_768,
				turnCap: 16,
				verificationFeedback: true,
				readToolLineNumbering: true,
				toolSlotPolicy: 'essentials-first',
				maxTools: 24,
			},
			smallModelOnARuntimeThatEnforcesSchemas: {
				toolCallProtocol: 'constrained-envelope',
				editProtocol: 'search-replace',
				promptStyle: 'compact',
				toolResultChars: 4000,
				evictionPolicy: 'oldest-results-first',
				contextTokens: 8192,
				turnCap: 8,
				verificationFeedback: true,
				readToolLineNumbering: true,
				toolSlotPolicy: 'essentials-first',
				maxTools: 8,
			},
			smallModelOnOneThatDoesNot: 'repaired-text',
			justAtTheThreshold: 'repaired-text',
		});
	});

	test('R-44: a requested configuration is applied over the default in a development build, refused whole in a packaged build, and refused everywhere when any part of it is wrong', () => {
		const base = deriveHarnessConfig(small, { runtimeEnforcesSchema: true });
		const request = (configuration: unknown, problem?: string) => ({ manifest: '2026-11-21-ablation', name: 'no-repair', configuration, problem });
		const lab = { toolCallProtocol: 'native', turnCap: 3, verificationFeedback: false, maxTools: 6 };
		const summary = (resolved: IOnyxResolvedHarness) => ({
			source: resolved.source,
			requested: resolved.requested?.name,
			refused: resolved.refused,
			changed: Object.fromEntries(Object.entries(resolved.configuration).filter(([key, value]) => value !== base[key as keyof IOnyxHarnessConfig])),
			hashIsOfWhatRan: resolved.hash === harnessConfigHash(resolved.configuration),
		});
		const PACKAGED = 'a lab configuration is accepted only by a development build; this is a packaged build';
		assert.deepStrictEqual({
			nothingRequested: summary(resolveHarnessConfig(base, undefined, 'packaged')),
			development: summary(resolveHarnessConfig(base, request(lab), 'development')),
			packaged: summary(resolveHarnessConfig(base, request(lab), 'packaged')),
			// Even a request for exactly the default is not taken from a manifest by a packaged build.
			packagedAskingForTheDefault: summary(resolveHarnessConfig(base, request({}), 'packaged')).refused,
			wrongValues: summary(resolveHarnessConfig(base, request({ turnCap: 0, toolCallProtocol: 'fuzzy', maxTools: 6 }), 'development')),
			unknownField: summary(resolveHarnessConfig(base, request({ approvalBypass: true }), 'development')).refused,
			notAnObject: summary(resolveHarnessConfig(base, request('native'), 'development')).refused,
			anEditProtocolThatDoesNotExist: summary(resolveHarnessConfig(base, request({ editProtocol: 'fuzzy-apply' }), 'development')).refused,
			// L7: constrained anchors is a protocol a lab arm may ask for, and never the default.
			constrainedAnchors: [resolveHarnessConfig(base, request({ editProtocol: 'constrained-anchors' }), 'development').configuration.editProtocol, base.editProtocol],
			aManifestThatCouldNotBeRead: summary(resolveHarnessConfig(base, request(undefined, 'the manifest named by ONYX_LAB_MANIFEST could not be read'), 'development')).refused,
		}, {
			nothingRequested: { source: 'default', requested: undefined, refused: undefined, changed: {}, hashIsOfWhatRan: true },
			development: { source: 'lab', requested: 'no-repair', refused: undefined, changed: { toolCallProtocol: 'native', turnCap: 3, verificationFeedback: false, maxTools: 6 }, hashIsOfWhatRan: true },
			packaged: { source: 'default', requested: 'no-repair', refused: PACKAGED, changed: {}, hashIsOfWhatRan: true },
			packagedAskingForTheDefault: PACKAGED,
			// One wrong field refuses the whole request: the field that was right is not applied either.
			wrongValues: { source: 'default', requested: 'no-repair', refused: 'turnCap must be a whole number from 1 to 64; toolCallProtocol must be one of native, repaired-text, constrained-envelope, constrained-edit-first', changed: {}, hashIsOfWhatRan: true },
			unknownField: 'approvalBypass is not a field of the harness configuration',
			notAnObject: 'the configuration is not an object',
			anEditProtocolThatDoesNotExist: 'editProtocol must be one of search-replace, constrained-anchors',
			constrainedAnchors: ['constrained-anchors', 'search-replace'],
			aManifestThatCouldNotBeRead: 'the manifest named by ONYX_LAB_MANIFEST could not be read',
		});
	});

	test('R-44: the hash is the same for the same configuration however it was written down, and different for any other', () => {
		const base = deriveHarnessConfig(small, { runtimeEnforcesSchema: true });
		// The same fields and values with the keys in the opposite order.
		const reordered: IOnyxHarnessConfig = { ...Object.fromEntries(Object.entries(base).reverse()), ...base };
		const others: IOnyxHarnessConfig[] = [
			{ ...base, turnCap: 9 },
			{ ...base, toolCallProtocol: 'repaired-text' },
			{ ...base, contextTokens: 8191 },
			{ ...base, readToolLineNumbering: false },
		];
		assert.deepStrictEqual({
			keysAreInAnotherOrder: Object.keys(reordered)[0] !== Object.keys(base)[0],
			sameValuesWrittenInAnotherOrder: harnessConfigHash(reordered) === harnessConfigHash(base),
			shape: /^[0-9a-f]{8,64}$/.test(harnessConfigHash(base)),
			oneFieldDiffers: others.map(other => harnessConfigHash(other) !== harnessConfigHash(base)),
		}, { keysAreInAnotherOrder: true, sameValuesWrittenInAnotherOrder: true, shape: true, oneFieldDiffers: [true, true, true, true] });
	});
});
