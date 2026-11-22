/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { seededRandom } from '../../common/onyxAttribution.js';
import { auroc, aurocInterval, decideEstimator, hunkConfidencePercent, reliability } from '../../common/onyxCalibration.js';
import { describeHunkConfidence } from '../../browser/changes/onyxChangesView.js';

/**
 * R-55 (L16): the calibration metrics on predictions whose calibration
 * error and separation are known, and the rule that no badge is shown when
 * the registered threshold is not met.
 */
suite('OnyxCalibration', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const round = (value: number, digits = 6) => Math.round(value * 10 ** digits) / 10 ** digits;

	test('R-55: AUROC and expected calibration error match their known values on synthetic predictions', () => {
		// Ten items at each of 0.05, 0.15, … 0.95. Calibrated: the correct share at each level is the level,
		// shifted by a known amount: every estimate is 0.2 too high or too low.
		const levels = Array.from({ length: 10 }, (_, index) => index / 10 + 0.05);
		const population = (shift: number) => {
			const estimates: number[] = [];
			const correct: boolean[] = [];
			for (const level of levels) {
				const truth = Math.min(1, Math.max(0, level - shift));
				for (let item = 0; item < 20; item++) {
					estimates.push(level);
					correct.push(item < Math.round(truth * 20));
				}
			}
			return { estimates, correct };
		};
		const calibrated = population(0);
		const overconfident = population(0.2);
		// A large sample drawn from a model whose estimate is the true probability.
		const random = seededRandom(7);
		const drawn = Array.from({ length: 20_000 }, () => {
			const estimate = random();
			return { estimate, correct: random() < estimate };
		});
		const table = reliability(overconfident.estimates, overconfident.correct);
		assert.deepStrictEqual({
			perfect: auroc([0.1, 0.2, 0.8, 0.9], [false, false, true, true]),
			inverted: auroc([0.1, 0.2, 0.8, 0.9], [true, true, false, false]),
			allTied: auroc([0.5, 0.5, 0.5, 0.5], [true, false, true, false]),
			// One of four correct-incorrect pairs is in the wrong order.
			threeQuarters: auroc([0.1, 0.6, 0.4, 0.9], [false, false, true, true]),
			oneClass: Number.isNaN(auroc([0.1, 0.9], [true, true])),
			eceCalibrated: round(reliability(calibrated.estimates, calibrated.correct).ece),
			// Levels 0.05 and 0.15 cannot be 0.2 too high (the truth stops at 0): their gaps are 0.05 and 0.15.
			eceOverconfident: round(table.ece),
			secondBin: { count: table.bins[1].count, meanEstimate: round(table.bins[1].meanEstimate!), correctShare: table.bins[1].correctShare },
			lastBin: { count: table.bins[9].count, meanEstimate: round(table.bins[9].meanEstimate!), correctShare: table.bins[9].correctShare },
			// For an estimate that is the true probability, uniform on [0, 1], AUROC is 5/6 and ECE is 0.
			drawnAurocIsNearFiveSixths: Math.abs(auroc(drawn.map(item => item.estimate), drawn.map(item => item.correct)) - 5 / 6) < 0.01,
			drawnEceIsSmall: reliability(drawn.map(item => item.estimate), drawn.map(item => item.correct)).ece < 0.02,
			oneIsInTheLastBin: reliability([1, 1], [true, true]).bins[9].count,
		}, {
			perfect: 1,
			inverted: 0,
			allTied: 0.5,
			threeQuarters: 0.75,
			oneClass: true,
			eceCalibrated: 0,
			eceOverconfident: round((0.05 + 0.15 + 8 * 0.2) / 10),
			secondBin: { count: 20, meanEstimate: 0.15, correctShare: 0 },
			lastBin: { count: 20, meanEstimate: 0.95, correctShare: 0.75 },
			drawnAurocIsNearFiveSixths: true,
			drawnEceIsSmall: true,
			oneIsInTheLastBin: 2,
		});
	});

	test('R-55: the interval of AUROC covers the known value about as often as it says, and resamples by task', () => {
		const random = seededRandom(11);
		let covered = 0;
		const trials = 60;
		for (let trial = 0; trial < trials; trial++) {
			const items = Array.from({ length: 200 }, () => {
				const estimate = random();
				return { estimate, correct: random() < estimate };
			});
			const interval = aurocInterval(items.map(item => item.estimate), items.map(item => item.correct), { resamples: 300, seed: trial + 1 });
			covered += interval.low <= 5 / 6 && 5 / 6 <= interval.high ? 1 : 0;
		}
		// Hunks of one task that all share a label: resampling them one by one would call that 40 observations.
		const scores = Array.from({ length: 40 }, (_, index) => index < 20 ? 0.9 : 0.1);
		const correct = scores.map(score => score > 0.5);
		const byItem = aurocInterval(scores, correct, { resamples: 400, seed: 3 });
		const byTask = aurocInterval([...scores, 0.2, 0.8], [...correct, true, false], { clusters: [...scores.map((_, index) => index < 20 ? 'a' : 'b'), 'c', 'd'], resamples: 400, seed: 3 });
		assert.deepStrictEqual({
			coverageIsNear95: covered >= 52 && covered <= 60,
			separable: [byItem.value, byItem.low, byItem.high],
			aTaskIsDrawnWhole: byTask.high - byTask.low > 0.05,
		}, {
			coverageIsNear95: true,
			separable: [1, 1, 1],
			aTaskIsDrawnWhole: true,
		});
	});

	test('R-55: an estimator below the registered threshold gets no badge, and without a badge decision nothing is rendered for a hunk', () => {
		const decide = (low: number, high: number, ece: number, correct = 100, incorrect = 100) => {
			const decision = decideEstimator({ auroc: { value: (low + high) / 2, low, high }, ece, correct, incorrect });
			return [decision.outcome, decision.badge];
		};
		const none = { estimator: null, source: 'test' } as const;
		const agreement = { estimator: 'agreement', source: 'test' } as const;
		assert.deepStrictEqual({
			supportedAndCalibrated: decide(0.66, 0.8, 0.08),
			supportedButNotCalibrated: decide(0.66, 0.8, 0.11),
			belowTheThreshold: decide(0.6, 0.7, 0.01),
			refuted: decide(0.45, 0.59, 0.01),
			tooFewOfOneClass: decide(0.9, 0.99, 0.01, 19, 400),
			percentWithoutADecision: hunkConfidencePercent(none, 0.93),
			lineWithoutADecision: describeHunkConfidence(none, 0.93),
			percentWithADecision: hunkConfidencePercent(agreement, 0.934),
			lineWithADecision: describeHunkConfidence(agreement, 0.934),
			noEstimate: describeHunkConfidence(agreement, undefined),
		}, {
			supportedAndCalibrated: ['supported', true],
			supportedButNotCalibrated: ['supported', false],
			belowTheThreshold: ['inconclusive', false],
			refuted: ['refuted', false],
			tooFewOfOneClass: ['inconclusive', false],
			percentWithoutADecision: undefined,
			lineWithoutADecision: undefined,
			percentWithADecision: 93,
			lineWithADecision: 'Estimated 93% likely to match what was asked · an estimate, not a check',
			noEstimate: undefined,
		});
	});
});
