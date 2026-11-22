/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IOnyxLabResult } from '../../common/onyxLab.js';
import { IOnyxScorecard, modelStandings, rankModels, renderScorecardMarkdown, renderScorecardSvg, routerHitRate, switchAdvice } from '../../common/onyxScorecard.js';

/**
 * L11, the pure half of R-51: what a scorecard says. It carries its
 * provenance and each model's datasheet, labels a partial result as
 * partial, declines to rank below the minimum sample, and prints the
 * router's hit rate with its denominator.
 */
suite('OnyxScorecard', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const attempt = (model: string, task: string, score: number | null, overrides: Partial<IOnyxLabResult> = {}): IOnyxLabResult => ({
		unit: `${model}|single-turn|${task}|s1|r1`, model, configuration: 'single-turn', task, seed: 1, repetition: 1, outcome: score === null ? 'could-not-serve' : 'attempted', score, success: score === null ? null : score === 1,
		metric: score === null ? null : 'changed-line-f1-preserving/2', reason: score === null ? 'the runtime could not serve this unit: HTTP 500' : 'scored', removedLinesTheAuthorKept: 0, deniedCommands: 0, durationMs: 1000, harnessHash: null, ...overrides,
	});
	const tasks = (count: number) => Array.from({ length: count }, (_, index) => `t${index}`);
	const scorecard = (attempts: readonly IOnyxLabResult[], overrides: Partial<IOnyxScorecard> = {}): IOnyxScorecard => ({
		schema: 1, generatedAt: '2026-11-22T10:00:00.000Z', partial: false, plannedUnits: attempts.length,
		repository: { commit: 'cc0916dc2a19f4397766c1b915de8ad335c30d6a', name: 'onyx' },
		machine: { platform: 'darwin', arch: 'arm64', cpu: 'Apple M4 Pro', memoryGiB: 24 },
		parameters: { temperature: 0, seed: 1, metric: 'changed-line-f1-preserving/2', tier: 'S', maxTaskFileChars: 12_000 },
		models: [
			{ id: 'small:1b', digest: 'sha256:aaaaaaaaaaaaaaaa', runtime: 'ollama', runtimeVersion: '0.33.0', contextTokens: 16_384, contextSource: 'serverConfigured', publishedAt: '2024-09-19', datasheet: ['Tool calls: 0 of 5 on the tool channel; 3 of 5 of the rest readable as text'], datasheetMeasuredAt: '2026-11-22T06:40:00.000Z' },
			{ id: 'large:7b', digest: null, runtime: 'ollama', runtimeVersion: null, contextTokens: null, contextSource: null, publishedAt: null, datasheet: [], datasheetMeasuredAt: null },
		],
		tasks: { total: 12, bySource: { history: 11, request: 1 }, byHoldout: { 'held-out': 11, 'not-held-out': 0, unknown: 1 }, withTests: 0 },
		heldOutAfter: '2024-09-25', attempts, skips: [], estimateSeconds: 90, tookSeconds: 84.2,
		routing: routerHitRate([{ task: 'quick-edit', routerPick: 'large:7b', tournamentPick: 'large:7b' }, { task: 'debug', routerPick: 'large:7b', tournamentPick: 'small:1b' }, { task: 'implement', routerPick: 'small:1b', accepted: true }, { task: 'implement', routerPick: 'small:1b', accepted: false }, { task: 'chat', routerPick: 'small:1b' }]),
		...overrides,
	});
	const twelveEach = [...tasks(12).map((task, index) => attempt('small:1b', task, index < 3 ? 1 : 0.25)), ...tasks(12).map((task, index) => attempt('large:7b', task, index < 6 ? 1 : 0.5, index === 11 ? { removedLinesTheAuthorKept: 2 } : {}))];

	test('R-51: models are ranked only on a whole measurement with the minimum sample for every model; a model that could not be served is in no mean', () => {
		const withFailure = [...twelveEach.slice(0, 12), attempt('small:1b', 't12', null), ...twelveEach.slice(12)];
		const ranked = rankModels(twelveEach, false);
		assert.deepStrictEqual({
			ranked: ranked.ranked && ranked.order.map(standing => [standing.model, standing.attempted, standing.succeeded, standing.meanScore]),
			couldNotServeIsNotAZero: modelStandings(withFailure).map(standing => [standing.model, standing.attempted, standing.couldNotServe, standing.meanScore]),
			partial: rankModels(twelveEach, true).ranked || (rankModels(twelveEach, true) as { reason: string }).reason,
			tooFew: (rankModels(twelveEach.filter(entry => entry.model !== 'small:1b' || ['t0', 't1', 't2', 't3'].includes(entry.task)), false) as { reason: string }).reason,
			oneModel: (rankModels(twelveEach.filter(entry => entry.model === 'small:1b'), false) as { reason: string }).reason,
		}, {
			ranked: [['large:7b', 12, 6, 0.75], ['small:1b', 12, 3, 0.438]],
			couldNotServeIsNotAZero: [['small:1b', 12, 1, 0.438], ['large:7b', 12, 0, 0.75]],
			partial: 'partial',
			tooFew: 'too-few-tasks',
			oneModel: 'one-model',
		});
	});

	test('R-51: the router\'s hit rate is printed with its denominator, and "should I switch" gives counts and no verdict below the minimum', () => {
		const rate = routerHitRate([{ task: 'a', routerPick: 'x', tournamentPick: 'x' }, { task: 'a', routerPick: 'x', tournamentPick: 'y' }, { task: 'a', routerPick: 'x', tournamentPick: 'x' }, { task: 'b', routerPick: 'y', accepted: true }, { task: 'b', routerPick: 'y' }]);
		assert.deepStrictEqual({
			rate,
			nothingLogged: routerHitRate([]),
			enough: switchAdvice('large:7b', twelveEach),
			notEnough: switchAdvice('large:7b', twelveEach.slice(12, 16)),
		}, {
			rate: { tournament: { matches: 2, of: 3 }, outcomes: { accepted: 1, of: 1 } },
			nothingLogged: { tournament: { matches: 0, of: 0 }, outcomes: { accepted: 0, of: 0 } },
			enough: { model: 'large:7b', requests: 12, attempted: 12, reproduced: 6, meanScore: 0.75, enough: true },
			notEnough: { model: 'large:7b', requests: 4, attempted: 4, reproduced: 4, meanScore: 1, enough: false },
		});
	});

	test('R-51: the scorecard carries its provenance, each model\'s datasheet, the counts and every attempt; a partial one says so and is not ranked', () => {
		const whole = renderScorecardMarkdown(scorecard(twelveEach));
		const partial = renderScorecardMarkdown(scorecard(twelveEach.slice(0, 15), { partial: true, plannedUnits: 24, skips: [{ model: 'large:7b', task: 't3', reason: 'the measurement was stopped before this ran' }] }));
		const few = renderScorecardMarkdown(scorecard(twelveEach.filter(entry => ['t0', 't1', 't2'].includes(entry.task))));
		const svg = renderScorecardSvg(scorecard(twelveEach));
		const has = (text: string, ...needles: string[]) => needles.map(needle => text.includes(needle));
		assert.deepStrictEqual({
			ranking: has(whole, '**Ranking** (by mean score, then by tasks reproduced exactly): 1. large:7b; 2. small:1b.', '| large:7b | 12 | 6 of 12 | 0.75 | 0 | 2 |'),
			provenance: has(whole, 'Repository: onyx at cc0916dc2a19f4397766c1b915de8ad335c30d6a', 'Machine: Apple M4 Pro, 24 GiB, darwin arm64', 'temperature 0, seed 1, metric changed-line-f1-preserving/2', 'took 84 s; estimated 90 s from the datasheets', 'Weights digest: sha256:aaaaaaaaaaaaaaaa', 'Runtime: ollama 0.33.0'),
			datasheets: has(whole, 'Datasheet, measured 2026-11-22T06:40:00.000Z:', '  - Tool calls: 0 of 5 on the tool channel; 3 of 5 of the rest readable as text', 'Weights digest: not reported by the runtime', 'this model has not been measured on this machine'),
			counts: has(whole, '12 tasks: 11 from this repository\'s history, 1 from your own accepted requests.', 'Held out in time: 11 (authored after 2024-09-25', 'unknown: 1.'),
			routing: has(whole, 'in 1 of 2 tournaments', 'in 1 of 2 runs with a recorded outcome', 'not a randomized comparison'),
			everyAttempt: whole.split('\n').filter(line => line.startsWith('| small:1b | t') || line.startsWith('| large:7b | t')).length,
			partial: has(partial, '# Onyx scorecard (partial)', '15 of 24 planned units ran; the measurement was stopped', '**Not ranked: this is a partial result.**', '| large:7b | t3 | the measurement was stopped before this ran |'),
			partialIsNotRanked: partial.includes('**Ranking**'),
			tooFew: has(few, '**Not enough tasks to rank.** A ranking needs at least 10 scored tasks for every model; the fewest here is 3.'),
			svg: [svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"'), ...has(svg, 'Ranked by mean score', 'large:7b', '0.75 mean · 6 of 12 exact', 'onyx at cc0916dc2a19', 'small:1b aaaaaaaaaaaa', 'metric changed-line-f1-preserving/2')],
			svgOfAPartialSaysSo: renderScorecardSvg(scorecard(twelveEach.slice(0, 15), { partial: true, plannedUnits: 24 })).includes('Not ranked: partial result'),
		}, {
			ranking: [true, true],
			provenance: [true, true, true, true, true, true],
			datasheets: [true, true, true, true],
			counts: [true, true, true],
			routing: [true, true, true],
			everyAttempt: 24,
			partial: [true, true, true, true],
			partialIsNotRanked: false,
			tooFew: [true],
			svg: [true, true, true, true, true, true, true],
			svgOfAPartialSaysSo: true,
		});
	});
});
