/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * L13: what each harness component is worth. Reads a finished factorial
 * campaign (`results.jsonl` beside its manifest) and writes `analysis.json`,
 * `ANALYSIS.md` and `outcome.json`: for each model and each of the two games
 * of Amendment 1, the success rate of every configuration, each component's
 * main effect, the pairwise interactions and the Shapley values, with
 * bootstrap intervals over tasks, and H-2's outcome by the registered
 * thresholds. Nothing is run: every number comes from the committed
 * results.
 *
 *   node test/onyx/lab/analyze-attribution.mts docs/research/results/<date>-attribution
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadManifest } from './manifest.mts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const directory = process.argv[2] ? path.resolve(process.argv[2]) : undefined;
if (!directory) {
	console.error('usage: node test/onyx/lab/analyze-attribution.mts <results directory>');
	process.exit(2);
}

interface IInterval { readonly value: number; readonly low: number; readonly high: number }
interface IAttribution { readonly components: readonly string[]; readonly tasks: number; readonly resamples: number; readonly seed: number; readonly coalitions: readonly IInterval[]; readonly shapley: readonly IInterval[]; readonly mainEffects: readonly IInterval[]; readonly interactions: readonly (IInterval & { first: string; second: string })[]; readonly margin?: IInterval & { of: string } }
interface IData { readonly components: readonly string[]; readonly outcomes: readonly (readonly number[])[] }
interface IEstimators {
	attribute(data: IData, options: { resamples?: number; seed?: number; marginOf?: string }): IAttribution;
	marginDifference(first: IData, second: IData, of: string, options: { resamples?: number; seed?: number }): IInterval;
	decideH2(protocol: string, smaller: IAttribution, larger: IAttribution, difference: IInterval): { outcome: string; reason: string };
	wilsonInterval(successes: number, trials: number): IInterval;
}
const estimators: IEstimators = await import(pathToFileURL(path.join(repoRoot, 'out', 'vs', 'workbench', 'contrib', 'onyx', 'common', 'onyxAttribution.js')).href);

interface IResult { readonly unit: string; readonly model: string; readonly configuration: string; readonly task: string; readonly outcome: string; readonly score: number | null; readonly success: boolean | null; readonly durationMs: number }
const manifest = loadManifest(path.join(directory, 'manifest.json'));
const results: IResult[] = fs.readFileSync(path.join(directory, 'results.jsonl'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
const taskIds: string[] = (JSON.parse(fs.readFileSync(path.join(directory, 'tasks.json'), 'utf8')) as { tasks: { id: string }[] }).tasks.map(task => task.id);
const configurations = new Map(manifest.harnessConfigurations.map(entry => [entry.name, entry.configuration ?? {}]));
const models = manifest.models.map(model => model.identifier.replace(/^[a-z]+:/, ''));

// The three components, in the order of Amendment 1. Bit 0: protocol handling on; bit 1: elision on; bit 2: line numbering on.
const COMPONENTS = ['protocol handling', 'tool-result elision', 'read-tool line numbering'];
const GAMES = [
	{ id: 'primary', title: 'Primary: native against the product\'s value, constrained-envelope', on: 'constrained-envelope' },
	{ id: 'secondary', title: 'Secondary: native against repaired-text', on: 'repaired-text' },
] as const;
const ELISION_ON = 4000;

function configurationOf(protocol: string, elision: boolean, numbering: boolean): string {
	for (const [name, configuration] of configurations) {
		if (configuration.toolCallProtocol === protocol && (configuration.toolResultChars === ELISION_ON) === elision && configuration.readToolLineNumbering === numbering) {
			return name;
		}
	}
	throw new Error(`the manifest has no configuration with protocol ${protocol}, elision ${elision}, numbering ${numbering}`);
}

const byKey = new Map(results.map(result => [`${result.model}\u0000${result.configuration}\u0000${result.task}`, result]));

/** The outcomes table of one model and one game: a row a task, a column a coalition. A task with a unit the runtime could not serve is left out, and counted. */
function table(model: string, protocolOn: string, measure: 'success' | 'score'): { readonly data: IData; readonly tasks: string[]; readonly dropped: string[] } {
	const outcomes: number[][] = [];
	const kept: string[] = [];
	const dropped: string[] = [];
	for (const task of taskIds) {
		const row: number[] = [];
		let whole = true;
		for (let coalition = 0; coalition < 8; coalition++) {
			const result = byKey.get(`${model}\u0000${configurationOf(coalition & 1 ? protocolOn : 'native', !!(coalition & 2), !!(coalition & 4))}\u0000${task}`);
			if (!result || result.outcome !== 'attempted') {
				whole = false;
				break;
			}
			row.push(measure === 'success' ? (result.success ? 1 : 0) : result.score ?? 0);
		}
		if (whole) {
			outcomes.push(row);
			kept.push(task);
		} else {
			dropped.push(task);
		}
	}
	return { data: { components: COMPONENTS, outcomes }, tasks: kept, dropped };
}

const RESAMPLES = 1000;
const SEED = 1;
const round = (value: number) => Math.round(value * 1000) / 1000;
const show = (interval: IInterval) => `${round(interval.value).toFixed(3)} [${round(interval.low).toFixed(3)}, ${round(interval.high).toFixed(3)}]`;

// The size comparison: the smaller pinned model first, the larger second, by the manifest's order of parameters.
const sizeOf = (model: string) => Number(/:(?<size>[\d.]+)b/.exec(model)?.groups?.size ?? 0);
const [smaller, larger] = [...models].sort((left, right) => sizeOf(left) - sizeOf(right));

const analysis: Record<string, unknown> = { campaign: manifest.name, resamples: RESAMPLES, seed: SEED, components: COMPONENTS, smallerModel: smaller, largerModel: larger };
const markdown: string[] = [
	`# What each harness component is worth: ${manifest.name}`,
	'',
	`Every number here is computed from \`results.jsonl\` in this directory by \`node test/onyx/lab/analyze-attribution.mts docs/research/results/${manifest.name}\`. Intervals are 95% percentile bootstrap intervals over tasks, ${RESAMPLES} resamples, seed ${SEED}; a task's outcomes under the eight configurations of a game are resampled together. The design and the decision rule are \`docs/research/PREREGISTRATION.md\`, H-2 and Amendment 1.`,
	'',
];

// Every configuration, before any game: what ran and what came of it.
markdown.push('## Every configuration', '', '| Model | Configuration | Units | Attempted | Proposed an edit, by score above 0 | Reproduced the author\'s change | Success rate | Mean score | Median seconds a unit |', '|---|---|---|---|---|---|---|---|---|');
const perConfiguration: Record<string, unknown>[] = [];
for (const model of models) {
	for (const name of configurations.keys()) {
		const own = results.filter(result => result.model === model && result.configuration === name);
		const attempted = own.filter(result => result.outcome === 'attempted');
		const succeeded = attempted.filter(result => result.success === true).length;
		const rate = estimators.wilsonInterval(succeeded, attempted.length);
		const meanScore = attempted.length ? attempted.reduce((sum, result) => sum + (result.score ?? 0), 0) / attempted.length : 0;
		const seconds = own.map(result => result.durationMs / 1000).sort((left, right) => left - right);
		const median = seconds.length ? seconds[Math.floor(seconds.length / 2)] : 0;
		const scored = attempted.filter(result => (result.score ?? 0) > 0).length;
		perConfiguration.push({ model, configuration: name, units: own.length, attempted: attempted.length, scoredAboveZero: scored, succeeded, successRate: rate, meanScore: round(meanScore), medianSeconds: round(median) });
		markdown.push(`| ${model} | ${name} | ${own.length} | ${attempted.length} | ${scored} | ${succeeded} | ${attempted.length ? show(rate) : 'n/a'} | ${meanScore.toFixed(3)} | ${median.toFixed(1)} |`);
	}
}
analysis.configurations = perConfiguration;
markdown.push('', 'Success-rate intervals in this table are Wilson intervals on the count. "Could not serve" and "blocked by policy" units are not attempts and are in no rate.', '');

const games: Record<string, unknown> = {};
let decision: { outcome: string; reason: string } | undefined;
for (const game of GAMES) {
	for (const measure of ['success', 'score'] as const) {
		const tables = Object.fromEntries(models.map(model => [model, table(model, game.on, measure)]));
		const attributions = Object.fromEntries(models.map(model => [model, estimators.attribute(tables[model].data, { resamples: RESAMPLES, seed: SEED, marginOf: COMPONENTS[0] })]));
		// The margin comparison needs the same tasks for both models.
		const common = tables[smaller].tasks.filter(task => tables[larger].tasks.includes(task));
		const restrict = (model: string): IData => ({ components: COMPONENTS, outcomes: common.map(task => tables[model].data.outcomes[tables[model].tasks.indexOf(task)]) });
		const difference = common.length ? estimators.marginDifference(restrict(smaller), restrict(larger), COMPONENTS[0], { resamples: RESAMPLES, seed: SEED }) : { value: 0, low: 0, high: 0 };
		const decided = measure === 'success' ? estimators.decideH2(COMPONENTS[0], attributions[smaller], attributions[larger], difference) : undefined;
		if (game.id === 'primary' && measure === 'success') {
			decision = decided;
		}
		games[`${game.id}/${measure}`] = { game: game.id, protocolOn: game.on, measure, perModel: Object.fromEntries(models.map(model => [model, { tasks: tables[model].tasks.length, droppedTasks: tables[model].dropped, attribution: attributions[model] }])), marginOfTheLargerLessTheSmaller: { tasks: common.length, ...difference }, ...(decided ? { byTheRegisteredThresholds: decided } : {}) };

		markdown.push(`## ${game.title}: ${measure === 'success' ? 'task success (the registered metric)' : 'mean score (secondary measure, decides nothing)'}`, '');
		for (const model of models) {
			const attribution = attributions[model];
			markdown.push(`**${model}**, ${tables[model].tasks.length} tasks${tables[model].dropped.length ? ` (${tables[model].dropped.length} left out: a unit of theirs was not an attempt)` : ''}.`, '',
				'| Component | Shapley value | Main effect |', '|---|---|---|',
				...COMPONENTS.map((component, index) => `| ${component} | ${show(attribution.shapley[index])} | ${show(attribution.mainEffects[index])} |`), '',
				`Pairwise interactions: ${attribution.interactions.map(entry => `${entry.first} × ${entry.second} ${show(entry)}`).join('; ')}.`,
				`Margin of protocol handling over the runner-up: ${attribution.margin ? show(attribution.margin) : 'n/a'}.`, '');
		}
		markdown.push(`Margin of the larger model (${larger}) less that of the smaller (${smaller}), on the ${common.length} tasks both have whole: ${show(difference)}.`, '');
		if (decided) {
			markdown.push(`By the registered thresholds, on this game: **${decided.outcome}**. ${decided.reason}.`, '');
		}
	}
}
analysis.games = games;

if (!decision) {
	throw new Error('the primary game was not analysed');
}
const primary = games['primary/success'] as { perModel: Record<string, { attribution: IAttribution }> };
const number = models.map(model => `${model}: protocol handling's Shapley value of task success ${show(primary.perModel[model].attribution.shapley[0])}`).join('; ');
markdown.push('## H-2', '', `**${decision.outcome}** (decided on the primary game, as Amendment 1 says). ${decision.reason}.`, '', `The number behind it: ${number}.`, '');
fs.writeFileSync(path.join(directory, 'analysis.json'), JSON.stringify(analysis, undefined, '\t') + '\n');
fs.writeFileSync(path.join(directory, 'ANALYSIS.md'), markdown.join('\n'));
fs.writeFileSync(path.join(directory, 'outcome.json'), JSON.stringify({
	hypothesis: 'H-2',
	statement: 'For models at or below 7B, tool-call protocol handling contributes more to task success than any other harness component, and the gap narrows with model size',
	outcome: decision.outcome,
	reason: decision.reason,
	number,
	thresholds: 'PREREGISTRATION.md, H-2, as Amendment 1 applies them to the primary game of each model',
	decidedFrom: ['results.jsonl', 'analysis.json'],
	regenerate: `node test/onyx/lab/analyze-attribution.mts docs/research/results/${manifest.name}`,
}, undefined, '\t') + '\n');
console.log(`H-2: ${decision.outcome}. ${decision.reason}`);
