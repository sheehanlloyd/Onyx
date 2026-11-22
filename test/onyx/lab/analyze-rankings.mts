/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * H-7: do the models rank differently in different repositories? Reads one
 * finished single-turn campaign a repository, each with the same models,
 * and writes `rankings.json` and `outcome-H-7.json` beside the first.
 *
 *   node test/onyx/lab/analyze-rankings.mts docs/research/results/<date>-<a> docs/research/results/<date>-<b> […]
 *
 * A model's score in a repository is its share of tasks solved. A
 * repository in which no model solves a task has no ranking. A pairwise
 * difference is significant when its bootstrap interval over tasks
 * excludes 0. Supported: two repositories whose top-ranked model differs,
 * with that difference significant in each. Refuted: at least three
 * repositories, Kendall's tau of 1 between every two, and no interval that
 * allows a swap. Inconclusive otherwise (PREREGISTRATION.md, H-7 and its
 * amendments). It needs compiled output.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const directories = process.argv.slice(2).map(argument => path.resolve(argument));
if (directories.length < 2) {
	console.error('usage: node test/onyx/lab/analyze-rankings.mts <results directory> <results directory> […]');
	process.exit(2);
}
interface IInterval { readonly value: number; readonly low: number; readonly high: number }
const estimators: { kendallTau(first: readonly number[], second: readonly number[]): number; pairedDifference(first: readonly number[], second: readonly number[], options: { resamples?: number; seed?: number }): IInterval; wilsonInterval(successes: number, trials: number): IInterval } = await import(pathToFileURL(path.join(repoRoot, 'out', 'vs', 'workbench', 'contrib', 'onyx', 'common', 'onyxAttribution.js')).href);

interface IResult { readonly model: string; readonly task: string; readonly outcome: string; readonly success: boolean | null; readonly score: number | null }
const repositories = directories.map(directory => {
	const results: IResult[] = fs.readFileSync(path.join(directory, 'results.jsonl'), 'utf8').split('\n').filter(line => line.trim()).map(line => JSON.parse(line));
	const taskSet: { name: string } = JSON.parse(fs.readFileSync(path.join(directory, 'tasks.json'), 'utf8'));
	const models = [...new Set(results.map(result => result.model))].sort();
	const tasks = [...new Set(results.map(result => result.task))].sort();
	const solved = (model: string) => tasks.map(task => results.find(result => result.model === model && result.task === task)?.success === true ? 1 : 0);
	const scores = models.map(model => {
		const mine = results.filter(result => result.model === model);
		const attempted = mine.filter(result => result.outcome === 'attempted');
		const successes = attempted.filter(result => result.success === true).length;
		const meanScore = attempted.length ? attempted.reduce((sum, result) => sum + (result.score ?? 0), 0) / attempted.length : null;
		return { model, tasks: mine.length, attempted: attempted.length, couldNotServe: mine.length - attempted.length, solved: successes, solvedShare: estimators.wilsonInterval(successes, tasks.length), meanScore };
	});
	const anySolved = scores.some(score => score.solved > 0);
	// Ranked by tasks solved; models that solved the same number share a place, and the order between them is not a ranking.
	const ranking = anySolved ? [...scores].sort((left, right) => right.solved - left.solved).map(score => score.model) : null;
	const top = ranking && scores.filter(score => score.solved === Math.max(...scores.map(entry => entry.solved))).map(score => score.model);
	const pairs: { first: string; second: string; difference: IInterval; significant: boolean }[] = [];
	for (let first = 0; first < models.length; first++) {
		for (let second = first + 1; second < models.length; second++) {
			const difference = estimators.pairedDifference(solved(models[first]), solved(models[second]), { resamples: 2000, seed: 1 });
			pairs.push({ first: models[first], second: models[second], difference, significant: difference.low > 0 || difference.high < 0 });
		}
	}
	return { repository: path.basename(directory), taskSet: taskSet.name, tasks: tasks.length, models, scores, ranking, topRanked: top, pairs };
});

const models = repositories[0].models;
const sameModels = repositories.every(repository => repository.models.join() === models.join());
const ranked = repositories.filter(repository => repository.ranking !== null);
const comparisons: { first: string; second: string; kendallTau: number; topDiffers: boolean; topDifferenceSignificantInEach: boolean }[] = [];
for (let first = 0; first < ranked.length; first++) {
	for (let second = first + 1; second < ranked.length; second++) {
		const [a, b] = [ranked[first], ranked[second]];
		const solvedOf = (repository: typeof a) => models.map(model => repository.scores.find(score => score.model === model)!.solved);
		// The top differs when each repository has one top model and they are not the same model.
		const topDiffers = a.topRanked!.length === 1 && b.topRanked!.length === 1 && a.topRanked![0] !== b.topRanked![0];
		const significant = (repository: typeof a, top: string, other: string) => repository.pairs.some(pair => ((pair.first === top && pair.second === other) || (pair.first === other && pair.second === top)) && pair.significant);
		comparisons.push({
			first: a.repository, second: b.repository, kendallTau: estimators.kendallTau(solvedOf(a), solvedOf(b)), topDiffers,
			topDifferenceSignificantInEach: topDiffers && significant(a, a.topRanked![0], b.topRanked![0]) && significant(b, b.topRanked![0], a.topRanked![0]),
		});
	}
}
const supported = comparisons.some(comparison => comparison.topDifferenceSignificantInEach);
const refuted = !supported && repositories.length >= 3 && ranked.length === repositories.length && comparisons.every(comparison => comparison.kendallTau === 1) && repositories.every(repository => repository.pairs.every(pair => pair.significant));
const outcome = !sameModels ? 'inconclusive' : supported ? 'supported' : refuted ? 'refuted' : 'inconclusive';
const why = !sameModels ? 'the campaigns do not have the same models'
	: supported ? 'two repositories have different top-ranked models, each ahead by a significant difference'
		: refuted ? 'the rankings agree across at least three repositories and no interval allows a swap'
			: ranked.length < 2 ? `${repositories.length - ranked.length} of ${repositories.length} repositories have no ranking: no model solved a task there`
				: repositories.length < 3 ? 'the top-ranked model does not differ significantly, and with two repositories the hypothesis cannot be refuted' : 'neither threshold is met';
fs.writeFileSync(path.join(directories[0], 'rankings.json'), JSON.stringify({ repositories, comparisons, outcome, why }, undefined, '\t') + '\n');
const line = (repository: typeof repositories[number]) => `${repository.repository}: ${repository.scores.map(score => `${score.model} ${score.solved}/${repository.tasks}`).join(', ')}`;
fs.writeFileSync(path.join(directories[0], 'outcome-H-7.json'), JSON.stringify({
	hypothesis: 'H-7',
	statement: 'Model rankings differ between repositories often enough to change which model a user should pick',
	outcome,
	number: `tasks solved: ${repositories.map(line).join('; ')}`,
	why,
	thresholds: 'Supported: at least one pair of repositories whose top-ranked model differs, with the difference significant in each. Refuted: tau = 1 across all repositories and every pairwise interval excludes a swap, which needs at least three repositories. Inconclusive otherwise (PREREGISTRATION.md, H-7, Amendments 2 and 3).',
	decidedFrom: ['rankings.json', ...directories.map(directory => `../${path.basename(directory)}/results.jsonl`)],
	regenerate: `node test/onyx/lab/analyze-rankings.mts ${directories.map(directory => `docs/research/results/${path.basename(directory)}`).join(' ')}`,
}, undefined, '\t') + '\n');
for (const repository of repositories) {
	console.log(line(repository));
}
console.log(`H-7: ${outcome} (${why})`);
