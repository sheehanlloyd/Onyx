/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IOnyxLabHarnessRequest } from '../../../../../platform/onyxRuntime/common/onyxRuntime.js';
import { harnessConfigHash, IOnyxHarnessConfig } from '../../common/onyxHarnessConfig.js';
import { ONYX_SIM_BEHAVIOUR_BEFORE_L4 } from './sim/onyxSimBehaviourBaseline.js';
import { generateEpisode, OnyxSimEpisode, OnyxSimModelTurn, SIM_FILES, SIM_TARGET_FILE } from './sim/onyxSimEpisode.js';
import { IOnyxSimResult, IOnyxSimRigOptions } from './sim/onyxSimRig.js';
import { runEpisode } from './sim/onyxSimRun.js';
import { SIM_SCENARIOS } from './sim/onyxSimScenarios.js';
import { digest } from './sim/onyxSimTrace.js';

function env(name: string): string | undefined {
	return (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[name];
}

const READ: OnyxSimModelTurn = { kind: 'toolCall', tool: 'readFile', arguments: { path: 'src/math.ts' } };
const DONE: OnyxSimModelTurn = { kind: 'text', text: 'Done.' };

function episode(turns: readonly OnyxSimModelTurn[]): OnyxSimEpisode {
	return {
		name: 'harness', seed: 0, persona: 'well-behaved', prompt: 'Look at src/math.ts.', files: SIM_FILES, target: SIM_TARGET_FILE,
		turns, dialogDefault: 'allow-once', userSteps: [], faults: [], profile: { promptStyle: 'compact', contextLength: 16_384, maxTools: 8 },
	};
}

/** A manifest's entry asking for these fields, in a development build or a packaged one. */
function asked(configuration: unknown, packaged = false): IOnyxSimRigOptions {
	const request: IOnyxLabHarnessRequest = { manifest: '2026-11-21-ablation', name: 'arm', configuration };
	return { labHarness: { request, packaged } };
}

interface IJournalEntry {
	readonly kind: string;
	readonly data: { readonly label?: string; readonly harness?: { readonly configurationHash: string; readonly configuration: IOnyxHarnessConfig; readonly source?: string; readonly requested?: string; readonly refused?: string } };
}

function journal(result: IOnyxSimResult): IJournalEntry[] {
	return result.journal.split('\n').filter(line => line.trim()).map(line => JSON.parse(line) as IJournalEntry);
}

/** The harness part of the run's trace header. */
function header(result: IOnyxSimResult): IJournalEntry['data']['harness'] {
	return journal(result).find(entry => entry.kind === 'trace')?.data.harness;
}

function notes(result: IOnyxSimResult, pattern: RegExp): number {
	return journal(result).filter(entry => entry.kind === 'note' && pattern.test(entry.data.label ?? '')).length;
}

/** How many characters of reply text reached the transcript. */
function shown(result: IOnyxSimResult): number {
	return result.trace.split('\n').filter(line => line.trim()).map(line => JSON.parse(line) as { kind: string; size?: number }).filter(event => event.kind === 'shown').reduce((total, event) => total + (event.size ?? 0), 0);
}

/**
 * L4, the service half of R-44: the real agent loop in the simulation rig.
 * With nothing requested it does what it did before the configuration
 * existed; with a lab configuration it does what the configuration says, in
 * a development build only.
 */
suite('OnyxHarnessConfigRun', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('R-44: with nothing requested, every seeded episode and every scripted scenario runs as it did before there was a configuration', async function () {
		this.timeout(300_000);
		const seedDigests: string[] = [];
		for (let seed = 1; seed <= ONYX_SIM_BEHAVIOUR_BEFORE_L4.seeds; seed++) {
			seedDigests.push(digest((await runEpisode(generateEpisode(seed))).trace));
		}
		const scenarioDigests: Record<string, string> = {};
		for (const scenario of SIM_SCENARIOS) {
			scenarioDigests[scenario.name] = digest((await runEpisode(scenario)).trace);
		}

		const writePath = env('ONYX_SIM_WRITE_BEHAVIOUR');
		if (writePath) {
			// The renderer runs with node integration; browser-layer code cannot import fs, so it is looked up at run time.
			const nodeRequire = (globalThis as { require?: (id: string) => { readFileSync(path: string, encoding: 'utf8'): string; writeFileSync(path: string, text: string): void } }).require;
			const fs = nodeRequire?.('fs');
			const source = fs?.readFileSync(writePath, 'utf8') ?? '';
			const revision = env('ONYX_SIM_BEHAVIOUR_REVISION') ?? 'unknown';
			const scenarioLines = Object.entries(scenarioDigests).map(([name, value]) => `\t\t'${name}': '${value}',`).join('\n');
			fs?.writeFileSync(writePath, source
				.replace(/revision: '[^']*'/, `revision: '${revision}'`)
				.replace(/seedDigests: '[0-9a-f]*'/, `seedDigests: '${seedDigests.join('')}'`)
				.replace(/scenarioDigests: \{[^}]*\},/, `scenarioDigests: {\n${scenarioLines}\n\t},`));
			return;
		}

		const expected = ONYX_SIM_BEHAVIOUR_BEFORE_L4.seedDigests.match(/.{8}/g) ?? [];
		const differingSeeds = seedDigests.map((value, index) => value === expected[index] ? 0 : index + 1).filter(seed => seed > 0);
		const differingScenarios = SIM_SCENARIOS.map(scenario => scenario.name).filter(name => scenarioDigests[name] !== ONYX_SIM_BEHAVIOUR_BEFORE_L4.scenarioDigests[name]);
		assert.deepStrictEqual(
			{ seeds: seedDigests.length, differingSeeds: differingSeeds.length, firstDifferingSeeds: differingSeeds.slice(0, 10), scenarios: SIM_SCENARIOS.length, differingScenarios },
			{ seeds: 1000, differingSeeds: 0, firstDifferingSeeds: [], scenarios: SIM_SCENARIOS.length, differingScenarios: [] });
	});
	test('R-44: the loop does what the configuration says: the turn cap, the tool-call protocol, the size of a tool result, the verification step and the read tool\'s numbering each follow a requested value', async function () {
		this.timeout(60_000);
		const fiveReads = episode([READ, READ, READ, READ, READ, DONE]);
		// A reply that is a tool call written as text, from its first character: the shape the text repair recognises.
		const textCall = episode([{ kind: 'text', text: '{"tool":"readFile","arguments":{"path":"src/math.ts"}}' }, DONE]);
		const bigResult = episode([{ kind: 'toolCall', tool: 'terminal', arguments: { command: 'head -c 6000 /dev/zero' } }, DONE]);
		const oneRead = episode([READ, DONE]);

		const capped = await runEpisode(fiveReads, [], asked({ turnCap: 2 }));
		const smallResults = await runEpisode(bigResult, [], asked({ toolResultChars: 300 }));
		const numbered = await runEpisode(oneRead);
		const unnumbered = await runEpisode(oneRead, [], asked({ readToolLineNumbering: false }));
		const native = await runEpisode(textCall, [], asked({ toolCallProtocol: 'native' }));

		assert.deepStrictEqual({
			turnCap: { default: (await runEpisode(fiveReads)).requests.length, asked: capped.requests.length, askedEndsWith: capped.errorMessage },
			// A call written as text: run when the text is repaired, and shown as the text it is when it is not.
			toolCallProtocol: { default: (await runEpisode(textCall)).toolResults.length, native: native.toolResults.length, nativeRequests: native.requests.length, nativeShowsIt: shown(native) > 0 },
			// The request after a 6,000-character result: smaller by more than 800 tokens when 300 characters go back instead of 4,000.
			toolResultChars: (await runEpisode(bigResult)).requests[1].promptTokens - smallResults.requests[1].promptTokens > 800,
			verificationFeedback: { default: notes(numbered, /^Verification:/), off: notes(await runEpisode(oneRead, [], asked({ verificationFeedback: false })), /^Verification:/) },
			readToolLineNumbering: { default: /^1\| export function/m.test(numbered.toolResults[0].text), off: /^1\| /m.test(unnumbered.toolResults[0].text), offStillHasTheText: /^export function addNumbers/m.test(unnumbered.toolResults[0].text) },
			saidOnTheTimeline: notes(capped, /^This run uses a lab harness configuration$/),
		}, {
			turnCap: { default: 6, asked: 2, askedEndsWith: 'Stopped after the maximum of 2 agent turns.' },
			toolCallProtocol: { default: 1, native: 0, nativeRequests: 1, nativeShowsIt: true },
			toolResultChars: true,
			verificationFeedback: { default: 1, off: 0 },
			readToolLineNumbering: { default: true, off: false, offStillHasTheText: true },
			saidOnTheTimeline: 1,
		});
	});

	test('R-44: every trace carries the hash of the configuration that ran; a packaged build refuses a requested configuration, runs the default one and says so', async function () {
		this.timeout(60_000);
		const fiveReads = episode([READ, READ, READ, READ, READ, DONE]);
		const plain = await runEpisode(fiveReads);
		const development = await runEpisode(fiveReads, [], asked({ turnCap: 2 }));
		const packaged = await runEpisode(fiveReads, [], asked({ turnCap: 2 }, true));
		const malformed = await runEpisode(fiveReads, [], asked({ turnCap: 2, approvalBypass: true }));
		const summary = (result: IOnyxSimResult) => {
			const harness = header(result);
			return {
				requests: result.requests.length,
				source: harness?.source,
				requested: harness?.requested,
				refused: harness?.refused,
				turnCap: harness?.configuration.turnCap,
				hashIsOfTheConfigurationInTheHeader: harness !== undefined && harness.configurationHash === harnessConfigHash(harness.configuration),
				sameHashAsTheDefaultRun: harness?.configurationHash === header(plain)?.configurationHash,
				refusalOnTheTimeline: notes(result, /^A lab harness configuration was requested and not applied$/),
			};
		};
		assert.deepStrictEqual({
			defaultConfiguration: header(plain)?.configuration,
			plain: summary(plain),
			development: summary(development),
			packaged: summary(packaged),
			malformed: summary(malformed),
		}, {
			defaultConfiguration: {
				toolCallProtocol: 'repaired-text', editProtocol: 'search-replace', promptStyle: 'compact', toolResultChars: 4000, evictionPolicy: 'oldest-results-first',
				contextTokens: 16_384, turnCap: 8, verificationFeedback: true, readToolLineNumbering: true, toolSlotPolicy: 'essentials-first', maxTools: 8,
			},
			plain: { requests: 6, source: 'default', requested: undefined, refused: undefined, turnCap: 8, hashIsOfTheConfigurationInTheHeader: true, sameHashAsTheDefaultRun: true, refusalOnTheTimeline: 0 },
			development: { requests: 2, source: 'lab', requested: '2026-11-21-ablation/arm', refused: undefined, turnCap: 2, hashIsOfTheConfigurationInTheHeader: true, sameHashAsTheDefaultRun: false, refusalOnTheTimeline: 0 },
			packaged: {
				requests: 6, source: 'default', requested: '2026-11-21-ablation/arm', refused: 'a lab configuration is accepted only by a development build; this is a packaged build',
				turnCap: 8, hashIsOfTheConfigurationInTheHeader: true, sameHashAsTheDefaultRun: true, refusalOnTheTimeline: 1,
			},
			malformed: {
				requests: 6, source: 'default', requested: '2026-11-21-ablation/arm', refused: 'approvalBypass is not a field of the harness configuration',
				turnCap: 8, hashIsOfTheConfigurationInTheHeader: true, sameHashAsTheDefaultRun: true, refusalOnTheTimeline: 1,
			},
		});
	});
});
