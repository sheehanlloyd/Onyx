/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { runWithFakedTimers } from '../../../../../../base/test/common/timeTravelScheduler.js';
import { generateEpisode, OnyxSimEpisode, OnyxSimPersonaKind } from './onyxSimEpisode.js';
import { IOnyxSimResult, OnyxSimChecker, OnyxSimRig } from './onyxSimRig.js';
import { SIM_SCENARIOS } from './onyxSimScenarios.js';
import { episodeSize, shrinkEpisode } from './onyxSimShrinker.js';

/**
 * OnyxSim (L1): the deterministic simulation rig against the real agent
 * loop. R-41: the same seed twice gives byte-identical canonical traces and a
 * different seed a different one, with no real timers. The smoke campaign
 * runs `ONYX_SIM_EPISODES` episodes (2,000 in the module gate and CI, a
 * handful otherwise) and reports throughput and reached branches.
 */

export async function runEpisode(episode: OnyxSimEpisode, checkers: readonly OnyxSimChecker[] = []): Promise<IOnyxSimResult> {
	return runWithFakedTimers({ useFakeTimers: true, maxTaskCount: 200_000 }, async () => {
		const rig = new OnyxSimRig(episode, checkers);
		try {
			return await rig.run();
		} finally {
			await rig.dispose();
		}
	});
}

function env(name: string): string | undefined {
	const candidate = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[name];
	return candidate;
}

suite('OnyxSim', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('R-41: the same seed gives a byte-identical trace, a different seed does not, and no real time passes', async () => {
		const wallBefore = globalThis.performance.now();
		const first = await runEpisode(generateEpisode(7));
		const second = await runEpisode(generateEpisode(7));
		const other = await runEpisode(generateEpisode(8));
		const wallMs = globalThis.performance.now() - wallBefore;
		assert.deepStrictEqual({
			identical: first.trace === second.trace,
			differs: first.trace !== other.trace,
			sameStatus: first.status === second.status,
			eventsRecorded: first.trace.split('\n').filter(Boolean).length > 5,
			underAMinuteOfWallTime: wallMs < 60_000,
		}, {
			identical: true,
			differs: true,
			sameStatus: true,
			eventsRecorded: true,
			underAMinuteOfWallTime: true,
		}, `first:\n${first.trace.slice(0, 2000)}\n\nsecond:\n${second.trace.slice(0, 2000)}`);
	});

	test('every persona runs to a terminal status and the trace carries the request, the turn and the completion', async () => {
		const personas: OnyxSimPersonaKind[] = ['well-behaved', 'malformed', 'truncating', 'looping', 'obedient', 'anchor-liar', 'flooder', 'squatter', 'staller', 'schema-violator'];
		const outcomes: Record<string, { status: string; turns: number; requests: number }> = {};
		for (const persona of personas) {
			// Find a seed whose persona is the one under test, so every persona is exercised by name.
			let seed = 1;
			while (generateEpisode(seed).persona !== persona) {
				seed++;
			}
			const episode: OnyxSimEpisode = { ...generateEpisode(seed), userSteps: [], faults: [] };
			const result = await runEpisode(episode);
			outcomes[persona] = { status: result.status, turns: result.turns, requests: result.trace.split('\n').filter(line => line.includes('"kind":"request"')).length };
		}
		assert.deepStrictEqual(Object.fromEntries(Object.entries(outcomes).map(([persona, outcome]) => [persona, { terminal: ['completed', 'failed', 'cancelled'].includes(outcome.status), requested: outcome.requests >= 1, requestsMatchTurns: outcome.requests === outcome.turns }])),
			Object.fromEntries(personas.map(persona => [persona, { terminal: true, requested: true, requestsMatchTurns: true }])),
			JSON.stringify(outcomes, undefined, 2));
	});

	test('the end-to-end mock scenarios are expressible as scripts and run at the service layer', async () => {
		const outcomes: Record<string, { status: string; turns: number; dispatched: string[]; staged: number; dialogs: string[] }> = {};
		for (const scenario of SIM_SCENARIOS) {
			const result = await runEpisode(scenario);
			const lines = result.trace.split('\n');
			outcomes[scenario.name] = {
				status: result.status,
				turns: result.turns,
				dispatched: lines.map(line => /"kind":"toolDispatch","call":"[^"]+","tool":"(?<tool>[^"]+)"/.exec(line)?.groups?.tool).filter((tool): tool is string => !!tool),
				staged: lines.filter(line => line.includes('"kind":"activity"') && line.includes('"activity":"toolResult"') && line.includes('"label":"editFile"') && line.includes('"ok":true')).length,
				dialogs: lines.map(line => /"kind":"dialog","message":"[^"]*","decision":"(?<decision>[^"]+)"/.exec(line)?.groups?.decision).filter((decision): decision is string => !!decision),
			};
		}
		assert.deepStrictEqual(outcomes, {
			'e2e-tooltest': { status: 'completed', turns: 2, dispatched: ['terminal'], staged: 0, dialogs: ['allow-once'] },
			'e2e-edittest': { status: 'completed', turns: 2, dispatched: ['editFile', 'editFile'], staged: 2, dialogs: [] },
			'e2e-termtest': { status: 'completed', turns: 2, dispatched: ['terminal'], staged: 0, dialogs: ['allow-once'] },
			'e2e-termtest-denied': { status: 'completed', turns: 2, dispatched: ['terminal'], staged: 0, dialogs: ['deny'] },
			// Today a stop during a tool-less turn ends as "completed": the loop
			// overwrites the cancelled status when the stream ends (Codex N5; B10
			// owns the fix, I-03/I-05 flag it). The script expresses the scenario;
			// the expectation records the baseline and changes when B10 lands.
			'e2e-slowtest-stop': { status: 'completed', turns: 1, dispatched: [], staged: 0, dialogs: [] },
			'e2e-readedittest-no-read-tool': { status: 'completed', turns: 1, dispatched: [], staged: 0, dialogs: [] },
		});
	});

	test('shrinking keeps the violation and makes the script smaller', async () => {
		// A stand-in violation: any command dispatched at all. The looping persona's
		// long turn list and random user steps are the noise the shrinker removes.
		const stillViolates = async (candidate: OnyxSimEpisode) => (await runEpisode(candidate)).trace.includes('"kind":"commandDispatch"');
		const episode: OnyxSimEpisode = {
			...generateEpisode(3),
			persona: 'well-behaved',
			turns: [
				{ kind: 'toolCall', tool: 'terminal', arguments: { command: 'npm test' } },
				{ kind: 'text', text: 'All done, the tests passed, and here is a long explanation of what they covered.' },
				{ kind: 'text', text: 'Nothing else to add.' },
			],
			dialogDefault: 'allow-once',
			userSteps: [{ at: 'afterRun', occurrence: 9, step: { kind: 'save' } }],
			faults: [{ at: 'afterRun', occurrence: 9, step: { kind: 'staleIndex' } }],
		};
		assert.strictEqual(await stillViolates(episode), true, 'the seed episode must violate before shrinking');
		const shrunk = await shrinkEpisode(episode, stillViolates, 80);
		assert.deepStrictEqual({
			stillViolates: await stillViolates(shrunk.episode),
			smaller: shrunk.after < shrunk.before,
			noUserSteps: shrunk.episode.userSteps.length,
			noFaults: shrunk.episode.faults.length,
			turns: shrunk.episode.turns.length,
			runsBounded: shrunk.runs <= 80,
			sizeBefore: episodeSize(episode) === shrunk.before,
		}, { stillViolates: true, smaller: true, noUserSteps: 0, noFaults: 0, turns: 1, runsBounded: true, sizeBefore: true });
	});

	test('smoke campaign: seeded episodes run deterministically and report throughput', async function () {
		const episodes = Number(env('ONYX_SIM_EPISODES') ?? 25);
		const seedBase = Number(env('ONYX_SIM_SEED') ?? 1000);
		this.timeout(Math.max(120_000, episodes * 500));
		const started = globalThis.performance.now();
		const statuses = new Map<string, number>();
		const personas = new Map<string, number>();
		const activities = new Set<string>();
		let boundaries = 0;
		let violations = 0;
		let firstFailure: string | undefined;
		for (let index = 0; index < episodes; index++) {
			const episode = generateEpisode(seedBase + index);
			const result = await runEpisode(episode);
			statuses.set(result.status, (statuses.get(result.status) ?? 0) + 1);
			personas.set(episode.persona, (personas.get(episode.persona) ?? 0) + 1);
			boundaries += result.boundaries;
			violations += result.violations.length;
			for (const line of result.trace.split('\n')) {
				const match = /"kind":"activity","run":"[^"]+","activity":"(?<activity>[^"]+)","label":"(?<label>[^"]{0,40})/.exec(line);
				if (match?.groups) {
					activities.add(`${match.groups.activity}:${match.groups.label.split(' ').slice(0, 3).join(' ')}`);
				}
			}
			if (result.status.startsWith('threw') && !firstFailure) {
				firstFailure = `seed ${episode.seed}: ${result.status}`;
			}
		}
		const elapsedMs = globalThis.performance.now() - started;
		const report = {
			episodes,
			elapsedMs: Math.round(elapsedMs),
			episodesPerSecond: Math.round((episodes / (elapsedMs / 1000)) * 10) / 10,
			boundaries,
			statuses: Object.fromEntries(statuses),
			personas: Object.fromEntries(personas),
			reachedActivityBranches: activities.size,
			violations,
		};
		// The runner forbids console output in tests, so the measured throughput
		// rides on the test's reported title, where the module gate and STATE.md
		// can quote it.
		if (this.test) {
			this.test.title = `${this.test.title} — ${JSON.stringify(report)}`;
		}
		assert.strictEqual(firstFailure, undefined, firstFailure);
	});
});
