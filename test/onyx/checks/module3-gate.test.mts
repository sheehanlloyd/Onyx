/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The Module 3 gate boxes that are about committed evidence and documents,
 * not behaviour.
 *
 *   node --test test/onyx/checks/module3-gate.test.mts
 */

import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { validateManifest } from '../lab/manifest.mts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PINNED = ['qwen2.5-coder:7b', 'qwen2.5-coder:1.5b'];

interface IContext { readonly requestedTokens: number | null; readonly reportedTokens: number | null; readonly verifiedTokens: number | null; readonly mechanism: string | null }

test('Module 3 gate (B15, R-61): the two pinned models\' datasheets are re-measured at the requested context and committed with a manifest that names requested, reported and verified', () => {
	const directory = path.join(repoRoot, 'docs', 'research', 'results', '2026-11-21-context-allocation');
	const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8')) as { models: { identifier: string; context: IContext }[] };
	const summary = JSON.parse(fs.readFileSync(path.join(directory, 'summary.json'), 'utf8')) as {
		datasheets: Record<string, { version: number; context: IContext & { serverReportedTokens: number | null; cutObserved: boolean } }>;
		allocations: Record<string, { status: string; previousTokens: number | null; verifiedTokens: number | null }>;
		performance: Record<string, { serverAllocation: { tokensPerSecond: number | null; loadedBytes: number | null }; requestedContext?: { tokensPerSecond: number | null; loadedBytes: number | null } }>;
	};
	const validation = validateManifest(manifest);
	assert.deepStrictEqual({
		manifest: validation.errors,
		models: manifest.models.map(model => model.identifier).sort(),
		perModel: PINNED.map(id => {
			const sheet = summary.datasheets[id];
			const inManifest = manifest.models.find(model => model.identifier === `ollama:${id}`)?.context;
			const allocation = summary.allocations[id];
			const speed = summary.performance[id];
			return {
				id,
				datasheetVersion: sheet?.version,
				// Verified at what was requested, above what the server allocated before, with the cut seen.
				verifiedIsRequested: sheet?.context.verifiedTokens !== null && sheet?.context.verifiedTokens === sheet?.context.requestedTokens,
				aboveTheOldAllocation: (allocation?.verifiedTokens ?? 0) > (allocation?.previousTokens ?? Number.MAX_SAFE_INTEGER),
				cutObserved: sheet?.context.cutObserved,
				allocation: allocation?.status,
				manifestAgreesWithDatasheet: !!inManifest && inManifest.requestedTokens === sheet?.context.requestedTokens && inManifest.verifiedTokens === sheet?.context.verifiedTokens && inManifest.reportedTokens === sheet?.context.serverReportedTokens,
				// Memory and speed were recorded at the old and at the new context.
				measuredAtBoth: [speed?.serverAllocation.tokensPerSecond, speed?.serverAllocation.loadedBytes, speed?.requestedContext?.tokensPerSecond, speed?.requestedContext?.loadedBytes].every(number => typeof number === 'number' && number > 0),
			};
		}),
	}, {
		manifest: [],
		models: PINNED.map(id => `ollama:${id}`).sort(),
		perModel: PINNED.map(id => ({ id, datasheetVersion: 2, verifiedIsRequested: true, aboveTheOldAllocation: true, cutObserved: true, allocation: 'verified', manifestAgreesWithDatasheet: true, measuredAtBoth: true })),
	});
});

test('B15, L3: a manifest whose model does not say what context it ran at is refused; unknown values are written as null, not left out', () => {
	const example = JSON.parse(fs.readFileSync(path.join(repoRoot, 'test', 'onyx', 'lab', 'manifest.example.json'), 'utf8')) as { models: { context?: Partial<IContext> }[] };
	const without = structuredClone(example);
	delete without.models[0].context;
	const partial = structuredClone(example);
	delete partial.models[0].context!.verifiedTokens;
	assert.deepStrictEqual({
		asCommitted: validateManifest(example).errors,
		withoutContext: validateManifest(without).errors,
		withoutVerified: validateManifest(partial).errors,
	}, {
		asCommitted: [],
		withoutContext: ['manifest.models[0]: missing required field "context"'],
		withoutVerified: ['manifest.models[0].context: missing required field "verifiedTokens"'],
	});
});

test('Module 3 gate: the baseline exception table is empty, and every defect this module fixed has a mutant descriptor', () => {
	const table = JSON.parse(fs.readFileSync(path.join(repoRoot, 'test', 'onyx', 'sim', 'baseline-exceptions.json'), 'utf8')) as { exceptions: unknown[] };
	const baselineDir = path.join(repoRoot, 'test', 'onyx', 'sim', 'baseline');
	const mutants = fs.readdirSync(path.join(repoRoot, 'test', 'onyx', 'sim', 'mutants')).map(name => name.replace(/\.json$/, ''));
	// The items of this module that fixed a defect the simulation can see, each with at least one mutant.
	const fixedHere = ['B6', 'B7', 'B8', 'B9', 'B10'];
	assert.deepStrictEqual({
		exceptions: table.exceptions.length,
		baselineScriptsLeft: fs.existsSync(baselineDir) ? fs.readdirSync(baselineDir) : [],
		itemsWithoutAMutant: fixedHere.filter(item => !mutants.some(name => name.startsWith(`${item}-`))),
	}, { exceptions: 0, baselineScriptsLeft: [], itemsWithoutAMutant: [] });
});
