/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * What each harness component is worth (L13): the estimators. A study runs
 * every combination of some components being on or off, on the same tasks,
 * and this module turns the outcomes into main effects, pairwise
 * interactions and Shapley values, each with a bootstrap interval over
 * tasks. Everything is pure and seeded, so that a published number can be
 * computed again and so that the estimators themselves can be checked
 * against outcomes whose true values are known (R-53).
 *
 * A coalition is a bitmask over the components: bit i set means component
 * i is on. `outcomes[task][coalition]` is that task's outcome under that
 * coalition, a number (1 or 0 for success, or a score).
 */

export interface IOnyxFactorialData {
	readonly components: readonly string[];
	/** One row a task, one column a coalition (2 to the power of the number of components). */
	readonly outcomes: readonly (readonly number[])[];
}

export interface IOnyxInterval {
	readonly value: number;
	readonly low: number;
	readonly high: number;
}

/** A small seeded generator (mulberry32): the same seed gives the same resamples on every machine. */
export function seededRandom(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6D2B79F5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** The mean outcome of each coalition over the given tasks. */
export function coalitionValues(outcomes: readonly (readonly number[])[], rows?: readonly number[]): number[] {
	const width = outcomes[0]?.length ?? 0;
	const sums = new Array<number>(width).fill(0);
	const picked = rows ?? outcomes.map((_, index) => index);
	for (const row of picked) {
		const task = outcomes[row];
		for (let coalition = 0; coalition < width; coalition++) {
			sums[coalition] += task[coalition];
		}
	}
	return sums.map(sum => picked.length ? sum / picked.length : 0);
}

function factorial(n: number): number {
	let result = 1;
	for (let i = 2; i <= n; i++) {
		result *= i;
	}
	return result;
}

function bitCount(value: number): number {
	let count = 0;
	for (let rest = value; rest; rest &= rest - 1) {
		count++;
	}
	return count;
}

/**
 * The Shapley value of each component, exactly, from the value of every
 * coalition: a component's marginal contribution, averaged over every
 * order in which the components could be switched on. The values sum to
 * the difference between everything on and everything off.
 */
export function shapleyValues(values: readonly number[], components: number): number[] {
	const result = new Array<number>(components).fill(0);
	const denominator = factorial(components);
	for (let component = 0; component < components; component++) {
		const bit = 1 << component;
		for (let coalition = 0; coalition < values.length; coalition++) {
			if (coalition & bit) {
				continue;
			}
			const size = bitCount(coalition);
			const weight = factorial(size) * factorial(components - size - 1) / denominator;
			result[component] += weight * (values[coalition | bit] - values[coalition]);
		}
	}
	return result;
}

/** A component's main effect: the mean over the coalitions that have it, less the mean over those that do not. */
export function mainEffects(values: readonly number[], components: number): number[] {
	const half = values.length / 2;
	return Array.from({ length: components }, (_, component) => {
		const bit = 1 << component;
		let on = 0;
		let off = 0;
		values.forEach((value, coalition) => {
			if (coalition & bit) {
				on += value;
			} else {
				off += value;
			}
		});
		return on / half - off / half;
	});
}

export interface IOnyxInteraction {
	readonly first: number;
	readonly second: number;
	readonly value: number;
}

/**
 * The interaction of each pair: how much more the two are worth together
 * than apart, averaged over the settings of the others. Zero when the two
 * add up.
 */
export function pairwiseInteractions(values: readonly number[], components: number): IOnyxInteraction[] {
	const result: IOnyxInteraction[] = [];
	const quarter = values.length / 4;
	for (let first = 0; first < components; first++) {
		for (let second = first + 1; second < components; second++) {
			const a = 1 << first;
			const b = 1 << second;
			let sum = 0;
			values.forEach((value, coalition) => {
				const both = (coalition & a ? 1 : 0) + (coalition & b ? 1 : 0);
				sum += both === 1 ? -value : value;
			});
			result.push({ first, second, value: sum / quarter });
		}
	}
	return result;
}

export interface IOnyxAttribution {
	readonly components: readonly string[];
	readonly tasks: number;
	readonly resamples: number;
	readonly seed: number;
	/** The success rate (or mean score) of each coalition, with its interval. */
	readonly coalitions: readonly IOnyxInterval[];
	readonly shapley: readonly IOnyxInterval[];
	readonly mainEffects: readonly IOnyxInterval[];
	readonly interactions: readonly (IOnyxInterval & { readonly first: string; readonly second: string })[];
	/**
	 * For the component named by `of`: its Shapley value less the largest
	 * Shapley value among the others, with an interval. Positive when it is
	 * worth more than the runner-up.
	 */
	readonly margin?: IOnyxInterval & { readonly of: string };
}

function percentile(sorted: readonly number[], fraction: number): number {
	if (sorted.length === 0) {
		return Number.NaN;
	}
	const position = (sorted.length - 1) * fraction;
	const lower = Math.floor(position);
	const upper = Math.ceil(position);
	return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function interval(value: number, samples: number[]): IOnyxInterval {
	const sorted = [...samples].sort((left, right) => left - right);
	return { value, low: percentile(sorted, 0.025), high: percentile(sorted, 0.975) };
}

/**
 * Every estimate with a 95% interval: the percentile bootstrap over tasks,
 * the pre-registered analysis. Tasks are drawn with replacement, whole rows
 * at a time, so that a task's outcomes under the different coalitions stay
 * together: the comparison is paired by task.
 */
export function attribute(data: IOnyxFactorialData, options: { readonly resamples?: number; readonly seed?: number; readonly marginOf?: string } = {}): IOnyxAttribution {
	const n = data.components.length;
	if (data.outcomes.some(row => row.length !== 1 << n)) {
		throw new Error(`every task needs an outcome for each of the ${1 << n} coalitions of ${n} components`);
	}
	const resamples = options.resamples ?? 1000;
	const seed = options.seed ?? 1;
	const random = seededRandom(seed);
	const tasks = data.outcomes.length;
	const marginIndex = options.marginOf === undefined ? -1 : data.components.indexOf(options.marginOf);
	const marginFrom = (shapley: readonly number[]) => shapley[marginIndex] - Math.max(...shapley.filter((_, index) => index !== marginIndex));

	const values = coalitionValues(data.outcomes);
	const point = { shapley: shapleyValues(values, n), main: mainEffects(values, n), interactions: pairwiseInteractions(values, n) };
	const samples = { coalitions: values.map(() => [] as number[]), shapley: point.shapley.map(() => [] as number[]), main: point.main.map(() => [] as number[]), interactions: point.interactions.map(() => [] as number[]), margin: [] as number[] };
	const rows = new Array<number>(tasks);
	for (let resample = 0; resample < resamples; resample++) {
		for (let index = 0; index < tasks; index++) {
			rows[index] = Math.floor(random() * tasks);
		}
		const drawn = coalitionValues(data.outcomes, rows);
		drawn.forEach((value, index) => samples.coalitions[index].push(value));
		const shapley = shapleyValues(drawn, n);
		shapley.forEach((value, index) => samples.shapley[index].push(value));
		mainEffects(drawn, n).forEach((value, index) => samples.main[index].push(value));
		pairwiseInteractions(drawn, n).forEach((entry, index) => samples.interactions[index].push(entry.value));
		if (marginIndex >= 0 && n > 1) {
			samples.margin.push(marginFrom(shapley));
		}
	}
	return {
		components: data.components, tasks, resamples, seed,
		coalitions: values.map((value, index) => interval(value, samples.coalitions[index])),
		shapley: point.shapley.map((value, index) => interval(value, samples.shapley[index])),
		mainEffects: point.main.map((value, index) => interval(value, samples.main[index])),
		interactions: point.interactions.map((entry, index) => ({ ...interval(entry.value, samples.interactions[index]), first: data.components[entry.first], second: data.components[entry.second] })),
		...(marginIndex >= 0 && n > 1 ? { margin: { ...interval(marginFrom(point.shapley), samples.margin), of: data.components[marginIndex] } } : {}),
	};
}

/**
 * How the margin of one component over its runner-up differs between two
 * models measured on the same tasks: the second model's margin less the
 * first's, with a bootstrap interval. The two tables have to list the same
 * tasks in the same order; a resample draws the same tasks for both.
 */
export function marginDifference(first: IOnyxFactorialData, second: IOnyxFactorialData, of: string, options: { readonly resamples?: number; readonly seed?: number } = {}): IOnyxInterval {
	const n = first.components.length;
	const index = first.components.indexOf(of);
	if (index < 0 || second.components.indexOf(of) !== index || first.outcomes.length !== second.outcomes.length) {
		throw new Error('the two tables need the same components and the same tasks');
	}
	const margin = (outcomes: readonly (readonly number[])[], rows?: readonly number[]) => {
		const shapley = shapleyValues(coalitionValues(outcomes, rows), n);
		return shapley[index] - Math.max(...shapley.filter((_, position) => position !== index));
	};
	const tasks = first.outcomes.length;
	const random = seededRandom(options.seed ?? 1);
	const samples: number[] = [];
	const rows = new Array<number>(tasks);
	for (let resample = 0; resample < (options.resamples ?? 1000); resample++) {
		for (let position = 0; position < tasks; position++) {
			rows[position] = Math.floor(random() * tasks);
		}
		samples.push(margin(second.outcomes, rows) - margin(first.outcomes, rows));
	}
	return interval(margin(second.outcomes) - margin(first.outcomes), samples);
}

export type OnyxOutcome = 'supported' | 'refuted' | 'inconclusive';

export interface IOnyxDecision {
	readonly outcome: OnyxOutcome;
	readonly reason: string;
}

const overlaps = (left: IOnyxInterval, right: IOnyxInterval) => left.low <= right.high && right.low <= left.high;

/**
 * H-2's decision, by the registered thresholds as Amendment 1 applies them
 * to the primary game of each model. `smaller` and `larger` are the two
 * pinned models' attributions, each with its margin for the protocol
 * component; `marginDifference` is the larger model's margin less the
 * smaller model's, with its interval.
 *
 * Supported: protocol handling's Shapley value exceeds every other
 * component's with intervals that do not overlap, for both models, and the
 * margin to the runner-up is smaller for the larger model. Refuted: another
 * component's interval lies wholly above protocol handling's for either
 * model, or the margin grows with size with an interval excluding equality.
 * Inconclusive otherwise, and always when no configuration succeeded on
 * any task: a floor is not evidence.
 */
export function decideH2(protocol: string, smaller: IOnyxAttribution, larger: IOnyxAttribution, marginDifference: IOnyxInterval): IOnyxDecision {
	const both = [['the smaller model', smaller], ['the larger model', larger]] as const;
	if (both.every(([, attribution]) => attribution.coalitions.every(coalition => coalition.value === 0))) {
		return { outcome: 'inconclusive', reason: 'no configuration succeeded on any task for either model: every value is zero, which is a floor and not evidence of equal worth' };
	}
	for (const [name, attribution] of both) {
		const index = attribution.components.indexOf(protocol);
		const own = attribution.shapley[index];
		const above = attribution.components.find((_, other) => other !== index && attribution.shapley[other].low > own.high);
		if (above !== undefined) {
			return { outcome: 'refuted', reason: `for ${name}, the interval of ${above} lies wholly above that of ${protocol}` };
		}
	}
	if (marginDifference.low > 0) {
		return { outcome: 'refuted', reason: 'the margin between protocol handling and the runner-up grows with model size, with an interval that excludes equality' };
	}
	const leads = both.every(([, attribution]) => {
		const index = attribution.components.indexOf(protocol);
		const own = attribution.shapley[index];
		return attribution.shapley.every((other, position) => position === index || (own.value > other.value && !overlaps(own, other)));
	});
	if (leads && marginDifference.value < 0) {
		return { outcome: 'supported', reason: 'for both models protocol handling has the largest Shapley value with intervals that do not overlap any other component\'s, and its margin to the runner-up is smaller for the larger model' };
	}
	return { outcome: 'inconclusive', reason: leads ? 'protocol handling leads for both models, and its margin is not smaller for the larger model' : 'protocol handling\'s interval overlaps another component\'s for at least one model' };
}

/** Kendall's tau between two rankings of the same items (tau-a; ties count as neither). */
export function kendallTau(first: readonly number[], second: readonly number[]): number {
	let concordant = 0;
	let discordant = 0;
	for (let i = 0; i < first.length; i++) {
		for (let j = i + 1; j < first.length; j++) {
			const product = Math.sign(first[i] - first[j]) * Math.sign(second[i] - second[j]);
			if (product > 0) {
				concordant++;
			} else if (product < 0) {
				discordant++;
			}
		}
	}
	const pairs = first.length * (first.length - 1) / 2;
	return pairs ? (concordant - discordant) / pairs : 0;
}

/** The difference of two models' mean outcomes on the same tasks, with a bootstrap interval over tasks (paired). */
export function pairedDifference(first: readonly number[], second: readonly number[], options: { readonly resamples?: number; readonly seed?: number } = {}): IOnyxInterval {
	const tasks = Math.min(first.length, second.length);
	const random = seededRandom(options.seed ?? 1);
	const mean = (rows: readonly number[]) => rows.reduce((sum, row) => sum + first[row] - second[row], 0) / (rows.length || 1);
	const all = Array.from({ length: tasks }, (_, index) => index);
	const samples: number[] = [];
	for (let resample = 0; resample < (options.resamples ?? 1000); resample++) {
		samples.push(mean(all.map(() => Math.floor(random() * tasks))));
	}
	return interval(mean(all), samples);
}

/** A Wilson score interval for a proportion, 95%. */
export function wilsonInterval(successes: number, trials: number): IOnyxInterval {
	if (trials === 0) {
		return { value: Number.NaN, low: 0, high: 1 };
	}
	const z = 1.959963984540054;
	const p = successes / trials;
	const denominator = 1 + z * z / trials;
	const centre = (p + z * z / (2 * trials)) / denominator;
	const half = z * Math.sqrt(p * (1 - p) / trials + z * z / (4 * trials * trials)) / denominator;
	return { value: p, low: Math.max(0, centre - half), high: Math.min(1, centre + half) };
}
