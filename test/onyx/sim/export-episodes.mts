/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Writes the simulation rig's scenario episodes (the end-to-end mock
 * scenarios as scripts, L1) to `test/onyx/sim/episodes/<name>.json`, the
 * data form the mock runtime replays over SSE (`ONYX_MOCK_EPISODE`).
 *
 *   node test/onyx/sim/export-episodes.mts [--check]
 *
 * `--check` writes nothing and exits non-zero when a file differs from the
 * source, so the JSON copies cannot drift from the TypeScript scenarios.
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
process.exit(check && drift ? 1 : 0);
