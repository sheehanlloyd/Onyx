/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { attribute, coalitionValues, decideH2, IOnyxAttribution, IOnyxInterval, kendallTau, mainEffects, pairedDifference, pairwiseInteractions, seededRandom, shapleyValues, wilsonInterval } from '../../common/onyxAttribution.js';

/**
 * R-53 (L13): the attribution estimators, on outcomes whose true values are
 * known. They recover known main effects, interactions and Shapley values,
 * and the bootstrap interval covers the true value about as often as it
 * says it does.
 */
suite('OnyxAttribution', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	/** The success probability of a coalition of three components: a base rate, three main terms and one interaction. */
	const truth = (coalition: number): number => {
		const [a, b, c] = [coalition & 1 ? 1 : 0, coalition & 2 ? 1 : 0, coalition & 4 ? 1 : 0];
		return 0.1 + 0.3 * a + 0.1 * b + 0.05 * c + 0.2 * a * b;
	};
	const trueValues = Array.from({ length: 8 }, (_, coalition) => truth(coalition));
	const round = (value: number) => Math.round(value * 1e9) / 1e9;

	test('R-53: known main effects, interactions and Shapley values are recovered exactly from exact coalition values', () => {
		const shapley = shapleyValues(trueValues, 3);
		assert.deepStrictEqual({
			shapley: shapley.map(round),
			// Efficiency: the values share out exactly what switching everything on is worth.
			sumIsEverythingOnLessEverythingOff: round(shapley.reduce((sum, value) => sum + value, 0)) === round(trueValues[7] - trueValues[0]),
			mainEffects: mainEffects(trueValues, 3).map(round),
			interactions: pairwiseInteractions(trueValues, 3).map(entry => [entry.first, entry.second, round(entry.value)]),
			aComponentThatDoesNothing: shapleyValues([0.2, 0.5, 0.2, 0.5], 2).map(round),
			twoThatOnlyWorkTogether: shapleyValues([0, 0, 0, 1], 2).map(round),
			// Where the two differ: three components that are worth something only all together. Each has a third
			// of the whole as its Shapley value, and a quarter as its main effect.
			threeThatOnlyWorkTogether: { shapley: shapleyValues([0, 0, 0, 0, 0, 0, 0, 1], 3).map(round), mainEffects: mainEffects([0, 0, 0, 0, 0, 0, 0, 1], 3).map(round) },
		}, {
			shapley: [0.4, 0.2, 0.05],
			sumIsEverythingOnLessEverythingOff: true,
			mainEffects: [0.4, 0.2, 0.05],
			interactions: [[0, 1, 0.2], [0, 2, 0], [1, 2, 0]],
			aComponentThatDoesNothing: [0.3, 0],
			twoThatOnlyWorkTogether: [0.5, 0.5],
			threeThatOnlyWorkTogether: { shapley: [0.333333333, 0.333333333, 0.333333333], mainEffects: [0.25, 0.25, 0.25] },
		});
	});

	test('R-53: on simulated outcomes the estimates centre on the true values and the 95% interval covers them about 95% of the time', () => {
		const random = seededRandom(20261122);
		const trueShapley = shapleyValues(trueValues, 3);
		const datasets = 300;
		const tasks = 60;
		const covered = [0, 0, 0];
		const sums = [0, 0, 0];
		for (let dataset = 0; dataset < datasets; dataset++) {
			// Tasks differ in difficulty, and a task's eight outcomes share it: the pairing the bootstrap keeps.
			const outcomes = Array.from({ length: tasks }, () => {
				const difficulty = (random() - 0.5) * 0.15;
				return trueValues.map(probability => random() < Math.min(1, Math.max(0, probability + difficulty)) ? 1 : 0);
			});
			const estimate = attribute({ components: ['a', 'b', 'c'], outcomes }, { resamples: 300, seed: dataset + 1 });
			estimate.shapley.forEach((interval, index) => {
				sums[index] += interval.value;
				if (interval.low <= trueShapley[index] && trueShapley[index] <= interval.high) {
					covered[index]++;
				}
			});
		}
		const coverage = covered.map(count => count / datasets);
		const meanError = sums.map((sum, index) => Math.abs(sum / datasets - trueShapley[index]));
		assert.deepStrictEqual({
			coverageIsNear95: coverage.map(share => share >= 0.9 && share <= 0.99),
			estimatesCentreOnTheTruth: meanError.map(error => error < 0.01),
		}, { coverageIsNear95: [true, true, true], estimatesCentreOnTheTruth: [true, true, true] }, `coverage ${coverage.join(', ')}; mean error ${meanError.join(', ')}`);
	});

	test('R-53: the same seed gives the same intervals, rows are resampled whole, and a ragged table is refused', () => {
		const outcomes = Array.from({ length: 20 }, (_, task) => [task % 2, 1, task % 2, 1]);
		const first = attribute({ components: ['a', 'b'], outcomes }, { seed: 7, marginOf: 'a' });
		const second = attribute({ components: ['a', 'b'], outcomes }, { seed: 7, marginOf: 'a' });
		assert.deepStrictEqual({
			same: JSON.stringify(first) === JSON.stringify(second),
			values: coalitionValues(outcomes),
			// Component b does nothing on any task, in any resample: its interval has no width.
			bIsExactlyZero: [first.shapley[1].value, first.shapley[1].low, first.shapley[1].high],
			a: first.shapley[0].value,
			margin: [first.margin?.of, first.margin?.value],
			ragged: (() => { try { attribute({ components: ['a', 'b'], outcomes: [[1, 0, 1]] }); return 'accepted'; } catch (error) { return (error as Error).message; } })(),
		}, {
			same: true,
			values: [0.5, 1, 0.5, 1],
			bIsExactlyZero: [0, 0, 0],
			a: 0.5,
			margin: ['a', 0.5],
			ragged: 'every task needs an outcome for each of the 4 coalitions of 2 components',
		});
	});

	test('H-2 is decided by the registered thresholds, and a floor of zero successes is inconclusive', () => {
		const at = (value: number, half = 0.02): IOnyxInterval => ({ value, low: value - half, high: value + half });
		const attribution = (protocol: IOnyxInterval, elision: IOnyxInterval, numbering: IOnyxInterval, anySuccess = true): IOnyxAttribution => ({
			components: ['protocol', 'elision', 'numbering'], tasks: 40, resamples: 1000, seed: 1,
			coalitions: Array.from({ length: 8 }, () => at(anySuccess ? 0.2 : 0, 0)), shapley: [protocol, elision, numbering], mainEffects: [protocol, elision, numbering], interactions: [],
		});
		assert.deepStrictEqual({
			supported: decideH2('protocol', attribution(at(0.4), at(0.1), at(0.05)), attribution(at(0.3), at(0.1), at(0.05)), at(-0.1)).outcome,
			leadsButTheMarginDoesNotNarrow: decideH2('protocol', attribution(at(0.3), at(0.1), at(0.05)), attribution(at(0.4), at(0.1), at(0.05)), { value: 0.1, low: -0.01, high: 0.2 }).outcome,
			theMarginGrows: decideH2('protocol', attribution(at(0.3), at(0.1), at(0.05)), attribution(at(0.5), at(0.1), at(0.05)), at(0.2)).outcome,
			anotherComponentAbove: decideH2('protocol', attribution(at(0.1), at(0.4), at(0.05)), attribution(at(0.3), at(0.1), at(0.05)), at(-0.1)),
			overlapping: decideH2('protocol', attribution(at(0.2, 0.1), at(0.15, 0.1), at(0.05)), attribution(at(0.3), at(0.1), at(0.05)), at(-0.1)).outcome,
			floor: decideH2('protocol', attribution(at(0, 0), at(0, 0), at(0, 0), false), attribution(at(0, 0), at(0, 0), at(0, 0), false), at(0, 0)),
		}, {
			supported: 'supported',
			leadsButTheMarginDoesNotNarrow: 'inconclusive',
			theMarginGrows: 'refuted',
			anotherComponentAbove: { outcome: 'refuted', reason: 'for the smaller model, the interval of elision lies wholly above that of protocol' },
			overlapping: 'inconclusive',
			floor: { outcome: 'inconclusive', reason: 'no configuration succeeded on any task for either model: every value is zero, which is a floor and not evidence of equal worth' },
		});
	});

	test('rank agreement, a paired difference and a Wilson interval come out at their known values', () => {
		const wilson = wilsonInterval(0, 40);
		const half = wilsonInterval(20, 40);
		const difference = pairedDifference([1, 1, 1, 0, 1, 1, 0, 1], [0, 1, 0, 0, 1, 0, 0, 1], { seed: 3 });
		assert.deepStrictEqual({
			sameOrder: kendallTau([3, 2, 1], [0.9, 0.5, 0.1]),
			reversed: kendallTau([3, 2, 1], [0.1, 0.5, 0.9]),
			oneSwap: Math.round(kendallTau([3, 2, 1], [0.9, 0.1, 0.5]) * 1000) / 1000,
			zeroOfForty: [wilson.value, wilson.low, Math.round(wilson.high * 1000) / 1000],
			twentyOfForty: [half.value, Math.round(half.low * 1000) / 1000, Math.round(half.high * 1000) / 1000],
			difference: [difference.value, difference.low >= 0, difference.high <= 1, difference.low < difference.value && difference.value < difference.high],
		}, {
			sameOrder: 1,
			reversed: -1,
			oneSwap: 0.333,
			zeroOfForty: [0, 0, 0.088],
			twentyOfForty: [0.5, 0.352, 0.648],
			difference: [0.375, true, true, true],
		});
	});
});
