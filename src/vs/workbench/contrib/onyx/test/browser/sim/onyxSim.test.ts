/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { generateEpisode, OnyxSimEpisode, OnyxSimPersonaKind, serializeEpisode } from './onyxSimEpisode.js';
import { BASELINE_EXCEPTIONS } from './onyxSimBaseline.js';
import { allCheckers, INVARIANTS, UNOBSERVABLE_IN_RIG } from './onyxSimInvariants.js';
import { parseTrace, validateTrace } from '../../../common/onyxTrace.js';
import { IOnyxSimResult } from './onyxSimRig.js';
import { runEpisode } from './onyxSimRun.js';
import { SIM_MUTANTS } from './onyxSimMutantTable.js';
import { mutantClassNames, SIM_MUTANT_CLASSES } from './onyxSimMutants.js';
import { SIM_SCENARIOS } from './onyxSimScenarios.js';
import { episodeSize, shrinkEpisode } from './onyxSimShrinker.js';

/**
 * OnyxSim (L1): the deterministic simulation rig against the real agent
 * loop. R-41: the same seed twice gives byte-identical canonical traces and a
 * different seed a different one, with no real timers. The smoke campaign
 * runs `ONYX_SIM_EPISODES` episodes (2,000 in the module gate and CI, a
 * handful otherwise) and reports throughput and reached branches.
 */

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
			// The persona's own turns, on the default model: no user steps, no faults, and not the cloud-backed
			// model, which the product refuses before any request (B14).
			const episode: OnyxSimEpisode = { ...generateEpisode(seed), userSteps: [], faults: [], selectedModel: undefined };
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
			'audit-n2-type-above-then-accept-hunk-0': { status: 'completed', turns: 2, dispatched: ['editFile', 'editFile'], staged: 2, dialogs: [] },
			'audit-n2-edit-hunk-0-then-accept-hunk-0': { status: 'completed', turns: 2, dispatched: ['editFile', 'editFile'], staged: 2, dialogs: [] },
			'b8-delete-lines-then-accept-all': { status: 'completed', turns: 2, dispatched: ['editFile'], staged: 1, dialogs: [] },
			'b9-inline-edit-stages-then-save': { status: 'completed', turns: 1, dispatched: [], staged: 0, dialogs: [] },
			'audit-h4-duplicates-shift-then-accept': { status: 'completed', turns: 2, dispatched: ['editFile'], staged: 1, dialogs: [] },
			// Eight tool turns, then the turn cap (compact profile): "completed" with an incomplete result.
			'audit-h6-context-budget': { status: 'completed', turns: 8, dispatched: Array.from({ length: 8 }, () => 'terminal'), staged: 0, dialogs: Array.from({ length: 8 }, () => 'allow-once') },
			'e2e-readedittest': { status: 'completed', turns: 3, dispatched: ['readFile', 'editFile'], staged: 1, dialogs: [] },
			'b1-numbered-search-is-decoded': { status: 'completed', turns: 3, dispatched: ['readFile', 'editFile'], staged: 1, dialogs: [] },
			'b1-read-escape-attempts': { status: 'completed', turns: 7, dispatched: ['readFile', 'readFile', 'readFile', 'listDirectory', 'grep', 'findFiles'], staged: 0, dialogs: [] },
			// An excluded essential tool: refused before any request (R-36).
			'b1-essential-tool-excluded': { status: 'failed', turns: 0, dispatched: [], staged: 0, dialogs: [] },
			// Three slots: the read tools only. The edit the model then asks for is an unknown tool, not a dispatch.
			'b1-read-only-profile': { status: 'completed', turns: 3, dispatched: ['readFile'], staged: 0, dialogs: [] },
		});
	});

	test('the scripted user steps are carried out, and leave the buffer as the audits require (R-11, R-12, R-25\'s accept-all): no scenario passes because its user never acted', async () => {
		const outcomes: Record<string, { steps: string; buffer: Record<string, boolean>; violations: string[] }> = {};
		const marks = { typedAbove: '// user typed above hunk 0', typedInHunk0: '/* mine */', pastedAbove: 'export function extra(): number {', hunk0: '// hunk 0', hunk1: '// hunk 1', mock: '// edited-by-mock', h4: '} // multiply' };
		for (const name of ['e2e-edittest', 'audit-n2-type-above-then-accept-hunk-0', 'audit-n2-edit-hunk-0-then-accept-hunk-0', 'audit-h4-duplicates-shift-then-accept']) {
			const scenario = SIM_SCENARIOS.find(candidate => candidate.name === name)!;
			const result = await runEpisode(scenario, allCheckers());
			const buffer = result.targetBuffer ?? '';
			outcomes[name] = {
				steps: `${result.userStepsTaken} of ${scenario.userSteps.length}`,
				buffer: Object.fromEntries(Object.entries(marks).filter(([, mark]) => buffer.includes(mark)).map(([key]) => [key, true])),
				violations: result.violations.map(violation => violation.invariant),
			};
		}
		assert.deepStrictEqual(outcomes, {
			// Accept all: both edits are in the buffer.
			'e2e-edittest': { steps: '1 of 1', buffer: { mock: true }, violations: [] },
			// Typed above hunk 0, accepted hunk 0: the typing stays, hunk 0 is applied at its new place, hunk 1 is not.
			'audit-n2-type-above-then-accept-hunk-0': { steps: '2 of 2', buffer: { typedAbove: true, hunk0: true }, violations: [] },
			// Typed into hunk 0's own line, accepted what was shown as hunk 0: refused, and hunk 1 is not applied in its place.
			'audit-n2-edit-hunk-0-then-accept-hunk-0': { steps: '2 of 2', buffer: { typedInHunk0: true }, violations: [] },
			// A function pasted above, so that the hunk's line is no longer the first of its kind: the hunk follows its own place.
			'audit-h4-duplicates-shift-then-accept': { steps: '2 of 2', buffer: { pastedAbove: true, h4: true }, violations: [] },
		});
	});

	test('R-43: every run journals a schema-valid v2 trace: one header, one turn record per request, the seed on record', async () => {
		const outcomes: Record<string, { ok: boolean; errors: readonly string[]; turns: number; requests: number; seed: unknown; streamEnds: string[] }> = {};
		for (const scenario of SIM_SCENARIOS.slice(0, 4)) {
			const result = await runEpisode({ ...scenario, profile: { ...scenario.profile, seed: 42 } });
			const trace = parseTrace(result.journal);
			const validation = validateTrace(trace);
			outcomes[scenario.name] = { ok: validation.ok, errors: validation.errors, turns: trace.turns.length, requests: result.turns, seed: trace.header?.sampling.seed, streamEnds: trace.turns.map(turn => turn.streamEnd) };
		}
		assert.deepStrictEqual(outcomes, {
			'e2e-tooltest': { ok: true, errors: [], turns: 2, requests: 2, seed: 42, streamEnds: ['tool_calls', 'stop'] },
			'e2e-edittest': { ok: true, errors: [], turns: 2, requests: 2, seed: 42, streamEnds: ['tool_calls', 'stop'] },
			'e2e-termtest': { ok: true, errors: [], turns: 2, requests: 2, seed: 42, streamEnds: ['tool_calls', 'stop'] },
			'e2e-termtest-denied': { ok: true, errors: [], turns: 2, requests: 2, seed: 42, streamEnds: ['tool_calls', 'stop'] },
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

	test('R-42: every baseline exception has an owner and its shrunk script still reproduces its class; the campaign finds no class outside the table', async function () {
		const episodes = Number(env('ONYX_SIM_EPISODES') ?? 25);
		const seedBase = Number(env('ONYX_SIM_SEED') ?? 1000);
		this.timeout(Math.max(120_000, episodes * 500));
		const checkers = allCheckers();
		const known = new Set(BASELINE_EXCEPTIONS.map(exception => exception.class));
		const reproduced: Record<string, boolean> = {};
		for (const exception of BASELINE_EXCEPTIONS) {
			const result = await runEpisode(exception.script, checkers);
			reproduced[exception.class] = result.violations.some(violation => violation.invariant === exception.class);
		}
		const outside = new Map<string, number>();
		const seen = new Set<string>();
		const run = async (episode: OnyxSimEpisode) => {
			const result = await runEpisode(episode, checkers);
			for (const violation of result.violations) {
				seen.add(violation.invariant);
				if (!known.has(violation.invariant)) {
					outside.set(`${violation.invariant} (seed ${episode.seed}: ${violation.detail.slice(0, 80)})`, (outside.get(violation.invariant) ?? 0) + 1);
				}
			}
		};
		for (let index = 0; index < episodes; index++) {
			await run(generateEpisode(seedBase + index));
		}
		for (const scenario of SIM_SCENARIOS) {
			await run(scenario);
		}
		const invariantIds = new Set(INVARIANTS.map(invariant => invariant.id));
		assert.deepStrictEqual({
			unowned: BASELINE_EXCEPTIONS.filter(exception => !exception.owner.trim()).map(exception => exception.class),
			notReproduced: Object.entries(reproduced).filter(([, ok]) => !ok).map(([cls]) => cls),
			outsideTheTable: [...outside.keys()],
			everyInvariantHasACheckerOrAReason: [...new Set([...Array.from({ length: 14 }, (_, i) => `I-${String(i + 1).padStart(2, '0')}`)])].filter(id => !invariantIds.has(id) && !UNOBSERVABLE_IN_RIG.some(entry => entry.id === id)),
		}, { unowned: [], notReproduced: [], outsideTheTable: [], everyInvariantHasACheckerOrAReason: [] });
		if (this.test) {
			this.test.title = `${this.test.title} — ${JSON.stringify({ exceptions: BASELINE_EXCEPTIONS.length, episodes, classesSeen: [...seen].sort() })}`;
		}
	});

	test('mutants: every resurrected defect is detected by its script and by the seeded campaign, and the unmutated harness is not', async function () {
		// Up to this many seeded episodes per mutant; the search stops at the first detection, so the cost is
		// paid only by a mutant that is rare to trigger or not detected at all.
		const episodes = Number(env('ONYX_SIM_MUTANT_EPISODES') ?? 1000);
		const seedBase = Number(env('ONYX_SIM_SEED') ?? 1000);
		this.timeout(Math.max(120_000, SIM_MUTANTS.length * episodes * 500));
		const checkers = allCheckers();
		const classNames = mutantClassNames();
		const outcomes: Record<string, { hasClass: boolean; cleanWithoutMutant: boolean; scriptDetects: boolean; campaignDetects: boolean }> = {};
		const firstSeeds: Record<string, number | string> = {};
		for (const mutant of SIM_MUTANTS) {
			const classes = SIM_MUTANT_CLASSES[mutant.id];
			const detected = (result: IOnyxSimResult) => result.violations.some(violation => violation.invariant === mutant.detects);
			const clean = await runEpisode(mutant.script, checkers);
			const withMutant = await runEpisode(mutant.script, checkers, { classes });
			let campaignDetects = false;
			for (let index = 0; index < episodes && !campaignDetects; index++) {
				if (detected(await runEpisode(generateEpisode(seedBase + index), checkers, { classes }))) {
					campaignDetects = true;
					firstSeeds[mutant.id] = seedBase + index;
				}
			}
			for (const scenario of SIM_SCENARIOS) {
				if (!campaignDetects && detected(await runEpisode(scenario, checkers, { classes }))) {
					campaignDetects = true;
					firstSeeds[mutant.id] = scenario.name;
				}
			}
			outcomes[mutant.id] = { hasClass: !!classes && (classNames[mutant.id] ?? []).includes(mutant.resurrects), cleanWithoutMutant: !detected(clean), scriptDetects: detected(withMutant), campaignDetects };
		}
		assert.deepStrictEqual({
			outcomes,
			classesWithoutARow: Object.keys(SIM_MUTANT_CLASSES).filter(id => !SIM_MUTANTS.some(mutant => mutant.id === id)),
		}, {
			outcomes: Object.fromEntries(SIM_MUTANTS.map(mutant => [mutant.id, { hasClass: true, cleanWithoutMutant: true, scriptDetects: true, campaignDetects: true }])),
			classesWithoutARow: [],
		});
		if (this.test) {
			this.test.title = `${this.test.title} — ${JSON.stringify({ mutants: SIM_MUTANTS.length, episodesPerMutant: episodes, firstDetectedAt: firstSeeds })}`;
		}
	});

	test('baseline campaign: every violation class the unmodified harness produces, with a seed and a shrunk script', async function () {
		const episodes = Number(env('ONYX_SIM_BASELINE_EPISODES') ?? 0);
		if (!episodes) {
			this.skip();
		}
		const seedBase = Number(env('ONYX_SIM_SEED') ?? 1000);
		this.timeout(Math.max(300_000, episodes * 800));
		const checkers = allCheckers();
		const classes = new Map<string, { count: number; firstSeed: number; detail: string }>();
		for (let index = 0; index < episodes; index++) {
			const episode = generateEpisode(seedBase + index);
			const result = await runEpisode(episode, checkers);
			for (const violation of result.violations) {
				const existing = classes.get(violation.invariant);
				if (existing) {
					existing.count++;
				} else {
					classes.set(violation.invariant, { count: 1, firstSeed: episode.seed, detail: violation.detail });
				}
			}
		}
		// The scripted scenarios count too: some audited defects need a sequence a random episode rarely produces.
		for (const scenario of SIM_SCENARIOS) {
			const result = await runEpisode(scenario, checkers);
			for (const violation of result.violations) {
				const existing = classes.get(violation.invariant);
				if (existing) {
					existing.count++;
				} else {
					classes.set(violation.invariant, { count: 1, firstSeed: 0, detail: `${scenario.name}: ${violation.detail}` });
				}
			}
		}
		const writeDir = env('ONYX_SIM_WRITE_BASELINE');
		const written: string[] = [];
		if (writeDir) {
			// The renderer runs with node integration; browser-layer code cannot import fs, so the writer is looked up at run time.
			const nodeRequire = (globalThis as { require?: (id: string) => { writeFileSync(path: string, text: string): void; mkdirSync(path: string, options: { recursive: boolean }): void } }).require;
			const fs = nodeRequire?.('fs');
			for (const [cls, info] of classes) {
				const stillViolates = async (candidate: OnyxSimEpisode) => (await runEpisode(candidate, checkers)).violations.some(violation => violation.invariant === cls);
				const shrunk = await shrinkEpisode({ ...generateEpisode(info.firstSeed), name: cls.replace('/', '-') }, stillViolates, 120);
				fs?.mkdirSync(writeDir, { recursive: true });
				fs?.writeFileSync(`${writeDir}/${cls.replace('/', '-')}.json`, serializeEpisode({ ...shrunk.episode, name: cls.replace('/', '-') }));
				written.push(`${cls} (${shrunk.before}→${shrunk.after} chars, ${shrunk.runs} runs)`);
			}
		}
		if (this.test) {
			this.test.title = `${this.test.title} — ${JSON.stringify({ episodes, classes: Object.fromEntries([...classes].map(([cls, info]) => [cls, { count: info.count, firstSeed: info.firstSeed, detail: info.detail.slice(0, 90) }])), written })}`;
		}
	});

	test('trace dump for one seed (ONYX_SIM_TRACE_SEED), with the invariant checkers', async function () {
		const seed = Number(env('ONYX_SIM_TRACE_SEED') ?? 0);
		if (!seed) {
			this.skip();
		}
		const episode = generateEpisode(seed);
		const result = await runEpisode(episode, allCheckers());
		if (this.test) {
			this.test.title = `${this.test.title} — persona ${episode.persona}; steps ${JSON.stringify(episode.userSteps)}; faults ${JSON.stringify(episode.faults)}; violations ${JSON.stringify(result.violations)}\n${result.trace.slice(0, 6000)}`;
		}
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
