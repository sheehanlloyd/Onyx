/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * R-44, the bundle half (L4, DEC-10): mutants and the simulation rig are not
 * in the product. The packaged smoke runs the scan over the built app. These
 * cases keep the scan honest without one: it finds the markers where they
 * are known to be, it finds none in the folders the product is built from,
 * and it has a marker for every mutant.
 *
 *   node --test test/onyx/checks/r44-bundle-scan.test.mts
 *
 * Needs `pnpm run transpile-client` first: the first case reads `out/`.
 */

import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { labOnlyMarkers, scanBundle } from './bundle-scan.mts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const markers = labOnlyMarkers(repoRoot);
const mutantIds = fs.readdirSync(path.join(repoRoot, 'test', 'onyx', 'sim', 'mutants')).filter(name => name.endsWith('.json')).map(name => name.slice(0, -'.json'.length));

test('R-44: the scan is not vacuous: in the development output, where the tests are compiled too, it finds every mutant and the rig', () => {
	const simOut = path.join(repoRoot, 'out', 'vs', 'workbench', 'contrib', 'onyx', 'test', 'browser', 'sim');
	assert.equal(fs.existsSync(path.join(simOut, 'onyxSimMutantTable.js')), true, 'run `pnpm run transpile-client` first');
	const found = new Set(scanBundle(simOut, markers).findings.map(finding => finding.marker));
	assert.deepStrictEqual({ mutants: mutantIds.length >= 24, everyMutantHasAMarker: mutantIds.filter(id => !markers.includes(id)), notFoundWhereTheyAre: markers.filter(marker => !found.has(marker)) }, { mutants: true, everyMutantHasAMarker: [], notFoundWhereTheyAre: [] });
});

test('R-44: the compiled product folders name no mutant and nothing of the rig', () => {
	const productRoots = [
		['out', 'vs', 'workbench', 'contrib', 'onyx', 'browser'],
		['out', 'vs', 'workbench', 'contrib', 'onyx', 'common'],
		['out', 'vs', 'workbench', 'contrib', 'onyx', 'electron-browser'],
		['out', 'vs', 'platform', 'onyxRuntime', 'common'],
		['out', 'vs', 'platform', 'onyxRuntime', 'node'],
	].map(segments => path.join(repoRoot, ...segments));
	const scans = productRoots.map(root => scanBundle(root, markers));
	assert.deepStrictEqual({ scannedSomething: scans.every(scan => scan.filesScanned > 0), findings: scans.flatMap(scan => scan.findings) }, { scannedSomething: true, findings: [] });
});

test('R-44: a built tree with a mutant in it is reported, by file and marker; a folder named to be skipped is not read', () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onyx-r44-'));
	try {
		fs.mkdirSync(path.join(root, 'out', 'vs'), { recursive: true });
		fs.mkdirSync(path.join(root, 'out', 'skipped'), { recursive: true });
		fs.writeFileSync(path.join(root, 'out', 'vs', 'workbench.js'), 'const a=1;/* product code */');
		fs.writeFileSync(path.join(root, 'out', 'vs', 'leaked.js'), 'var t=[{id:"B5-unbounded-output",fixedBy:"B5"}];');
		fs.writeFileSync(path.join(root, 'out', 'skipped', 'also.js'), 'import "./onyxSimRig.js";');
		fs.writeFileSync(path.join(root, 'out', 'vs', 'image.png'), 'B5-unbounded-output');
		const whole = scanBundle(root, markers);
		const part = scanBundle(root, markers, ['out/skipped']);
		assert.deepStrictEqual({ whole: whole.findings, wholeFiles: whole.filesScanned, part: part.findings, partFiles: part.filesScanned }, {
			whole: [{ file: 'out/skipped/also.js', marker: 'onyxSimRig' }, { file: 'out/vs/leaked.js', marker: 'B5-unbounded-output' }],
			wholeFiles: 3,
			part: [{ file: 'out/vs/leaked.js', marker: 'B5-unbounded-output' }],
			partFiles: 2,
		});
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
