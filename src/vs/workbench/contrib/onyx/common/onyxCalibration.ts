/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IOnyxInterval, seededRandom } from './onyxAttribution.js';

/**
 * Calibration of a per-hunk confidence estimate (L16, R-55, H-8): how well a
 * number given to each hunk separates the correct hunks from the others
 * (AUROC), and how far it is from the share that turned out correct
 * (expected calibration error, with the reliability table it comes from).
 * And the decision the study's result leads to: whether a badge is shown.
 */

/**
 * The area under the ROC curve: the chance that a correct item drawn at
 * random has a higher score than an incorrect one, ties counting half.
 * `NaN` when either class is empty: there is nothing to separate.
 */
export function auroc(scores: readonly number[], correct: readonly boolean[]): number {
	const order = scores.map((score, index) => ({ score, correct: correct[index] })).sort((left, right) => left.score - right.score);
	const positives = order.filter(entry => entry.correct).length;
	const negatives = order.length - positives;
	if (positives === 0 || negatives === 0) {
		return Number.NaN;
	}
	// The sum of the ranks of the correct items, with tied scores sharing their mean rank.
	let rankSum = 0;
	for (let start = 0; start < order.length;) {
		let end = start;
		while (end < order.length && order[end].score === order[start].score) {
			end++;
		}
		const meanRank = (start + 1 + end) / 2;
		for (let index = start; index < end; index++) {
			if (order[index].correct) {
				rankSum += meanRank;
			}
		}
		start = end;
	}
	return (rankSum - positives * (positives + 1) / 2) / (positives * negatives);
}

export interface IOnyxReliabilityBin {
	readonly low: number;
	readonly high: number;
	readonly count: number;
	/** The mean of the estimates in the bin, and the share of its items that were correct; null in an empty bin. */
	readonly meanEstimate: number | null;
	readonly correctShare: number | null;
}

export interface IOnyxReliability {
	readonly bins: readonly IOnyxReliabilityBin[];
	/** Expected calibration error: the gap between estimate and correct share in each bin, weighted by the bin's size. */
	readonly ece: number;
}

/** The reliability table of estimates in [0, 1], in equal-width bins, and the ECE. The last bin includes 1. */
export function reliability(estimates: readonly number[], correct: readonly boolean[], binCount = 10): IOnyxReliability {
	const sums = Array.from({ length: binCount }, () => ({ count: 0, estimate: 0, correct: 0 }));
	estimates.forEach((estimate, index) => {
		const bin = sums[Math.min(binCount - 1, Math.max(0, Math.floor(estimate * binCount)))];
		bin.count++;
		bin.estimate += estimate;
		bin.correct += correct[index] ? 1 : 0;
	});
	const bins = sums.map((bin, index) => ({
		low: index / binCount, high: (index + 1) / binCount, count: bin.count,
		meanEstimate: bin.count ? bin.estimate / bin.count : null, correctShare: bin.count ? bin.correct / bin.count : null,
	}));
	const ece = estimates.length === 0 ? Number.NaN : sums.reduce((sum, bin) => sum + (bin.count ? Math.abs(bin.estimate / bin.count - bin.correct / bin.count) * bin.count : 0), 0) / estimates.length;
	return { bins, ece };
}

/**
 * AUROC with a 95% percentile-bootstrap interval. Items are drawn with
 * replacement by cluster (the task a hunk came from, when given), so that
 * hunks of one task stay together. A resample with one class empty is
 * drawn again, up to a bound.
 */
export function aurocInterval(scores: readonly number[], correct: readonly boolean[], options: { readonly clusters?: readonly string[]; readonly resamples?: number; readonly seed?: number } = {}): IOnyxInterval {
	const value = auroc(scores, correct);
	if (Number.isNaN(value)) {
		return { value, low: 0, high: 1 };
	}
	const groups = new Map<string, number[]>();
	scores.forEach((_, index) => {
		const key = options.clusters?.[index] ?? String(index);
		groups.set(key, [...(groups.get(key) ?? []), index]);
	});
	const members = [...groups.values()];
	const random = seededRandom(options.seed ?? 1);
	const samples: number[] = [];
	const resamples = options.resamples ?? 2000;
	for (let attempt = 0; samples.length < resamples && attempt < resamples * 20; attempt++) {
		const drawn = Array.from({ length: members.length }, () => members[Math.floor(random() * members.length)]).flat();
		const sample = auroc(drawn.map(index => scores[index]), drawn.map(index => correct[index]));
		if (!Number.isNaN(sample)) {
			samples.push(sample);
		}
	}
	samples.sort((left, right) => left - right);
	const at = (fraction: number) => samples.length === 0 ? Number.NaN : samples[Math.min(samples.length - 1, Math.max(0, Math.round((samples.length - 1) * fraction)))];
	return { value, low: at(0.025), high: at(0.975) };
}

export type OnyxEstimatorOutcome = 'supported' | 'refuted' | 'inconclusive';

/** The least of each class a hunk-level estimate needs before it is decided at all (PREREGISTRATION.md, Amendment 2). */
export const ONYX_MIN_HUNKS_PER_CLASS = 20;

export interface IOnyxEstimatorDecision {
	readonly outcome: OnyxEstimatorOutcome;
	/** Whether a badge may be shown for this estimator: supported, and calibrated to within 0.10. */
	readonly badge: boolean;
	readonly reason: string;
}

/**
 * H-8 for one estimator, by the registered thresholds. Supported: the lower
 * bound of AUROC is at least 0.65. Refuted: the upper bound is below 0.60.
 * A badge ships only for a supported estimator whose ECE is at most 0.10.
 */
export function decideEstimator(input: { readonly auroc: IOnyxInterval; readonly ece: number; readonly correct: number; readonly incorrect: number }): IOnyxEstimatorDecision {
	if (input.correct < ONYX_MIN_HUNKS_PER_CLASS || input.incorrect < ONYX_MIN_HUNKS_PER_CLASS) {
		return { outcome: 'inconclusive', badge: false, reason: `${input.correct} correct and ${input.incorrect} incorrect hunks: fewer than ${ONYX_MIN_HUNKS_PER_CLASS} of one class` };
	}
	if (input.auroc.low >= 0.65) {
		const calibrated = input.ece <= 0.10;
		return { outcome: 'supported', badge: calibrated, reason: calibrated ? 'the lower bound of AUROC is at least 0.65 and ECE is at most 0.10' : `the lower bound of AUROC is at least 0.65, but ECE is ${input.ece.toFixed(3)}, over 0.10` };
	}
	if (input.auroc.high < 0.60) {
		return { outcome: 'refuted', badge: false, reason: 'the upper bound of AUROC is below 0.60' };
	}
	return { outcome: 'inconclusive', badge: false, reason: 'the interval of AUROC neither reaches 0.65 at its lower bound nor stays below 0.60' };
}

/**
 * What the study decided about a per-hunk badge, as the product carries it.
 * `estimator` is the one a badge may be shown for, or null: then no badge
 * is shown, whatever a hunk's estimate is.
 */
export interface IOnyxHunkConfidenceDecision {
	readonly estimator: 'agreement' | 'token-probability' | null;
	/** Where the decision comes from. */
	readonly source: string;
}

/** The estimate to show beside a hunk, as a whole percentage; `undefined` when the decision allows no badge or there is no estimate. */
export function hunkConfidencePercent(decision: IOnyxHunkConfidenceDecision, estimate: number | undefined): number | undefined {
	if (decision.estimator === null || estimate === undefined || !Number.isFinite(estimate)) {
		return undefined;
	}
	return Math.round(Math.min(1, Math.max(0, estimate)) * 100);
}

/**
 * The decision the product ships with. Set from the committed result of the
 * calibration study (H-8); until an estimator is supported and calibrated
 * there, it names none and no badge is shown.
 */
export const ONYX_HUNK_CONFIDENCE: IOnyxHunkConfidenceDecision = { estimator: null, source: 'H-8 has no supported and calibrated estimator' };
