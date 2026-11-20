/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Writes the simulation rig's scenario episodes (the end-to-end mock
 * scenarios as scripts, L1) to `test/onyx/sim/episodes/<name>.json`, the
 * data form the mock runtime replays over SSE (`ONYX_MOCK_EPISODE`), and the
 * baseline exceptions (L2) to `test/onyx/sim/baseline-exceptions.json` with
 * one shrunk script per violation class under `test/onyx/sim/baseline/`.
 *
 *   node test/onyx/sim/export-episodes.mts [--check]
 *
 * `--check` writes nothing and exits non-zero when a file differs from the
 * source, so the JSON copies cannot drift from the TypeScript tables.
 * Needs a current `npm run transpile-client` (it imports from `out/`).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const episodesDir = path.join(repoRoot, 'test', 'onyx', 'sim', 'episodes');
const check = process.argv.includes('--check');

interface IScenario { readonly name: string }

const scenarios = await import(path.join(repoRoot, 'out', 'vs', 'workbench', 'contrib', 'onyx', 'test', 'browser', 'sim', 'onyxSimScenarios.js')) as { SIM_SCENARIOS: readonly IScenario[] };
const serialize = (await import(path.join(repoRoot, 'out', 'vs', 'workbench', 'contrib', 'onyx', 'test', 'browser', 'sim', 'onyxSimEpisode.js')) as { serializeEpisode(episode: IScenario): string }).serializeEpisode;

fs.mkdirSync(episodesDir, { recursive: true });
let drift = 0;
const expected = new Set<string>();
for (const scenario of scenarios.SIM_SCENARIOS) {
	const file = path.join(episodesDir, `${scenario.name}.json`);
	expected.add(path.basename(file));
	const content = serialize(scenario);
	const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined;
	if (existing === content) {
		continue;
	}
	drift++;
	if (check) {
		console.log(`  drift: ${path.relative(repoRoot, file)} ${existing === undefined ? 'is missing' : 'differs from onyxSimScenarios.ts'}`);
	} else {
		fs.writeFileSync(file, content);
		console.log(`  wrote ${path.relative(repoRoot, file)}`);
	}
}
for (const name of fs.readdirSync(episodesDir)) {
	if (name.endsWith('.json') && !expected.has(name)) {
		drift++;
		console.log(`  ${check ? 'drift' : 'stale'}: ${path.relative(repoRoot, path.join(episodesDir, name))} has no scenario in onyxSimScenarios.ts`);
	}
}
console.log(check
	? (drift ? `episodes: ${drift} file(s) out of sync with onyxSimScenarios.ts` : `episodes: ${expected.size} files in sync`)
	: `episodes: ${expected.size} scenario(s), ${drift} file(s) written`);

// --- baseline exceptions (L2) ---------------------------------------------
interface IBaselineException { readonly class: string; readonly owner: string; readonly finding: string; readonly script: IScenario }
const baseline = await import(path.join(repoRoot, 'out', 'vs', 'workbench', 'contrib', 'onyx', 'test', 'browser', 'sim', 'onyxSimBaseline.js')) as { BASELINE_EXCEPTIONS: readonly IBaselineException[] };
const baselineDir = path.join(repoRoot, 'test', 'onyx', 'sim', 'baseline');
fs.mkdirSync(baselineDir, { recursive: true });
let baselineDrift = 0;
const expectedBaseline = new Set<string>();
const sync = (file: string, content: string, what: string) => {
	const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined;
	if (existing === content) {
		return;
	}
	baselineDrift++;
	if (check) {
		console.log(`  drift: ${path.relative(repoRoot, file)} ${existing === undefined ? 'is missing' : `differs from ${what}`}`);
	} else {
		fs.writeFileSync(file, content);
		console.log(`  wrote ${path.relative(repoRoot, file)}`);
	}
};
for (const exception of baseline.BASELINE_EXCEPTIONS) {
	const fileName = `${exception.class.replace('/', '-')}.json`;
	expectedBaseline.add(fileName);
	sync(path.join(baselineDir, fileName), serialize(exception.script), 'onyxSimBaseline.ts');
}
for (const name of fs.readdirSync(baselineDir)) {
	if (name.endsWith('.json') && !expectedBaseline.has(name)) {
		baselineDrift++;
		console.log(`  ${check ? 'drift' : 'stale'}: ${path.relative(repoRoot, path.join(baselineDir, name))} has no class in onyxSimBaseline.ts`);
	}
}
const table = baseline.BASELINE_EXCEPTIONS.map(exception => ({ class: exception.class, owner: exception.owner, finding: exception.finding, script: `test/onyx/sim/baseline/${exception.class.replace('/', '-')}.json` }));
sync(path.join(repoRoot, 'test', 'onyx', 'sim', 'baseline-exceptions.json'), JSON.stringify({ recordedAt: '2026-11-19', campaign: '1,000 seeded episodes from seed 1 plus the scripted scenarios, unmodified harness', exceptions: table }, undefined, '\t') + '\n', 'onyxSimBaseline.ts');
console.log(check
	? (baselineDrift ? `baseline: ${baselineDrift} file(s) out of sync with onyxSimBaseline.ts` : `baseline: ${table.length} exceptions in sync`)
	: `baseline: ${table.length} exception(s), ${baselineDrift} file(s) written`);
process.exit(check && (drift || baselineDrift) ? 1 : 0);
