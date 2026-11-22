/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The scorecard of "Measure Models for This Repository" (L11): what was
 * measured, on what, how, and what came of it, as one document a user can
 * keep or share. It carries its own provenance (the commit, the machine,
 * the runtime and its version, each model's weights digest and datasheet,
 * the parameters, every attempt and every skip), so that a number in it is
 * never separated from where it came from. Everything here is pure: the
 * ranking rule, the router's hit rate, and the Markdown and SVG renderings.
 */

import { IOnyxLabResult } from './onyxLab.js';
import { IOnyxTaskCounts, ONYX_MIN_TASKS_TO_RANK } from './onyxLabTasks.js';

export const ONYX_SCORECARD_SCHEMA = 1;

export interface IOnyxScorecardModel {
	/** The model as the runtime names it. */
	readonly id: string;
	readonly digest: string | null;
	readonly runtime: string;
	readonly runtimeVersion: string | null;
	/** The context requests were budgeted against, and where that number came from. */
	readonly contextTokens: number | null;
	readonly contextSource: string | null;
	/** The day the model was published, from the catalog; null when the catalog does not date it. */
	readonly publishedAt: string | null;
	/** The model's datasheet as its own description lines (L5); empty when the model was never measured. */
	readonly datasheet: readonly string[];
	readonly datasheetMeasuredAt: string | null;
}

export interface IOnyxScorecard {
	readonly schema: typeof ONYX_SCORECARD_SCHEMA;
	readonly generatedAt: string;
	/** Cancelled before every planned unit ran: what is here is part of a measurement. */
	readonly partial: boolean;
	readonly plannedUnits: number;
	readonly repository: { readonly commit: string | null; readonly name: string };
	readonly machine: { readonly platform: string; readonly arch: string; readonly cpu: string; readonly memoryGiB: number };
	readonly parameters: { readonly temperature: number; readonly seed: number; readonly metric: string; readonly tier: 'S' | 'A'; readonly maxTaskFileChars: number };
	readonly models: readonly IOnyxScorecardModel[];
	readonly tasks: IOnyxTaskCounts;
	/** The publication day that decided what is held out; null when it is not known for every model. */
	readonly heldOutAfter: string | null;
	/** Every unit that ran, scored. */
	readonly attempts: readonly IOnyxLabResult[];
	/** What was planned and not run, with why. */
	readonly skips: readonly { readonly model: string; readonly task: string; readonly reason: string }[];
	readonly estimateSeconds: number | null;
	readonly tookSeconds: number;
	readonly routing: IOnyxRouterHitRate | null;
}

export interface IOnyxModelStanding {
	readonly model: string;
	readonly attempted: number;
	readonly couldNotServe: number;
	readonly succeeded: number;
	readonly meanScore: number | null;
	readonly removedLinesTheAuthorKept: number;
}

export type OnyxRanking =
	| { readonly ranked: true; readonly order: readonly IOnyxModelStanding[] }
	| { readonly ranked: false; readonly reason: string; readonly standings: readonly IOnyxModelStanding[] };

/** Each model's counts and mean, in the order the models were measured. */
export function modelStandings(attempts: readonly IOnyxLabResult[]): IOnyxModelStanding[] {
	const models = [...new Set(attempts.map(attempt => attempt.model))];
	return models.map(model => {
		const own = attempts.filter(attempt => attempt.model === model);
		const scored = own.filter(attempt => attempt.outcome === 'attempted');
		return {
			model,
			attempted: scored.length,
			couldNotServe: own.filter(attempt => attempt.outcome === 'could-not-serve').length,
			succeeded: scored.filter(attempt => attempt.success === true).length,
			meanScore: scored.length ? Math.round(scored.reduce((sum, attempt) => sum + (attempt.score ?? 0), 0) / scored.length * 1000) / 1000 : null,
			removedLinesTheAuthorKept: scored.reduce((sum, attempt) => sum + attempt.removedLinesTheAuthorKept, 0),
		};
	});
}

/**
 * The ranking, or the reason there is none. Models are ranked only when
 * the measurement is whole and every model was scored on at least the
 * minimum number of tasks: a ranking from three tasks, or from the half of
 * a run that finished, would be read as more than it is.
 */
export function rankModels(attempts: readonly IOnyxLabResult[], partial: boolean, minimum = ONYX_MIN_TASKS_TO_RANK): OnyxRanking {
	const standings = modelStandings(attempts);
	if (partial) {
		return { ranked: false, reason: 'partial', standings };
	}
	if (standings.length < 2) {
		return { ranked: false, reason: 'one-model', standings };
	}
	if (standings.some(standing => standing.attempted < minimum)) {
		return { ranked: false, reason: 'too-few-tasks', standings };
	}
	return { ranked: true, order: [...standings].sort((left, right) => (right.meanScore ?? 0) - (left.meanScore ?? 0) || right.succeeded - left.succeeded || left.model.localeCompare(right.model)) };
}

/** One logged choice of the router, with what the user then did, where that is known. */
export interface IOnyxRouterLogEntry {
	readonly task: string;
	/** The model the router picked. */
	readonly routerPick: string;
	/** The model the user picked as the winner of a tournament on the same kind of task, when there was one. */
	readonly tournamentPick?: string;
	/** Whether the user kept what the router's pick produced, when that is known. */
	readonly accepted?: boolean;
}

export interface IOnyxRouterHitRate {
	/** How often the router's pick was the model the user picked in a tournament. */
	readonly tournament: { readonly matches: number; readonly of: number };
	/** How often the user kept what the router's pick produced. */
	readonly outcomes: { readonly accepted: number; readonly of: number };
}

/**
 * The router's hit rate from its log, each rate with its denominator.
 * These are logged choices: what the router picked and what the user then
 * did. They are not a randomized comparison, and they say nothing about a
 * model the router did not pick.
 */
export function routerHitRate(log: readonly IOnyxRouterLogEntry[]): IOnyxRouterHitRate {
	const withTournament = log.filter(entry => entry.tournamentPick !== undefined);
	const withOutcome = log.filter(entry => entry.accepted !== undefined);
	return {
		tournament: { matches: withTournament.filter(entry => entry.tournamentPick === entry.routerPick).length, of: withTournament.length },
		outcomes: { accepted: withOutcome.filter(entry => entry.accepted === true).length, of: withOutcome.length },
	};
}

/** How often a model reproduced what the user accepted, for "Should I Switch Models?": counts, and no verdict below the minimum. */
export interface IOnyxSwitchAdvice {
	readonly model: string;
	readonly requests: number;
	readonly attempted: number;
	readonly reproduced: number;
	readonly meanScore: number | null;
	readonly enough: boolean;
}

export function switchAdvice(model: string, attempts: readonly IOnyxLabResult[], minimum = ONYX_MIN_TASKS_TO_RANK): IOnyxSwitchAdvice {
	const standing = modelStandings(attempts.filter(attempt => attempt.model === model))[0];
	return { model, requests: attempts.filter(attempt => attempt.model === model).length, attempted: standing?.attempted ?? 0, reproduced: standing?.succeeded ?? 0, meanScore: standing?.meanScore ?? null, enough: (standing?.attempted ?? 0) >= minimum };
}

const fixed = (value: number | null, digits = 2) => value === null ? 'n/a' : value.toFixed(digits);
const cell = (text: string) => text.replace(/\|/g, '\\|').replace(/\n/g, ' ');

function describeRanking(ranking: OnyxRanking, minimum: number): string {
	if (ranking.ranked) {
		return `**Ranking** (by mean score, then by tasks reproduced exactly): ${ranking.order.map((standing, index) => `${index + 1}. ${standing.model}`).join('; ')}.`;
	}
	switch (ranking.reason) {
		case 'partial': return '**Not ranked: this is a partial result.** The measurement was stopped before every planned unit ran. The rows below are what finished.';
		case 'one-model': return '**Not ranked:** one model was measured, and a ranking needs two.';
		default: return `**Not enough tasks to rank.** A ranking needs at least ${minimum} scored tasks for every model; the fewest here is ${Math.min(...ranking.standings.map(standing => standing.attempted))}. The table below is evidence about each model, not an order of them.`;
	}
}

/**
 * The scorecard as Markdown. The text is the scorecard's own, in English:
 * it is a document a user exports and shares, with its numbers and where
 * they came from, not a part of the interface.
 */
export function renderScorecardMarkdown(scorecard: IOnyxScorecard, minimum = ONYX_MIN_TASKS_TO_RANK): string {
	const ranking = rankModels(scorecard.attempts, scorecard.partial, minimum);
	const standings = ranking.ranked ? ranking.order : ranking.standings;
	const tasks = scorecard.tasks;
	const lines: string[] = [
		`# Onyx scorecard${scorecard.partial ? ' (partial)' : ''}`,
		'',
		`Local models measured on this repository's own tasks, on this machine. ${scorecard.attempts.length} of ${scorecard.plannedUnits} planned units ran${scorecard.partial ? '; the measurement was stopped' : ''}.`,
		'',
		describeRanking(ranking, minimum),
		'',
		'| Model | Scored tasks | Reproduced exactly | Mean score | Could not serve | Lines removed that the author kept |',
		'|---|---|---|---|---|---|',
		...standings.map(standing => `| ${cell(standing.model)} | ${standing.attempted} | ${standing.succeeded} of ${standing.attempted} | ${fixed(standing.meanScore)} | ${standing.couldNotServe} | ${standing.removedLinesTheAuthorKept} |`),
		'',
		'The score is the F1 between the lines a model changed and the lines the author changed, capped at 0.5 when the model removed a line the author kept. It measures closeness to the author\'s change, not correctness. A task a model could not be served is not a score of zero and is in no mean.',
		'',
		'## Tasks',
		'',
		`${tasks.total} tasks: ${tasks.bySource.history} from this repository's history, ${tasks.bySource.request} from your own accepted requests.`,
		scorecard.heldOutAfter
			? `Held out in time: ${tasks.byHoldout['held-out']} (authored after ${scorecard.heldOutAfter}, when the latest of these models was published); not held out: ${tasks.byHoldout['not-held-out']}; unknown: ${tasks.byHoldout.unknown}.`
			: `Holdout unknown for ${tasks.byHoldout.unknown} of ${tasks.total}: the publication day of at least one of these models is not known, so a model may have been trained on these commits.`,
		'',
		'## Provenance',
		'',
		`- Generated: ${scorecard.generatedAt}`,
		`- Repository: ${scorecard.repository.name} at ${scorecard.repository.commit ?? 'an unknown commit'}`,
		`- Machine: ${scorecard.machine.cpu}, ${scorecard.machine.memoryGiB} GiB, ${scorecard.machine.platform} ${scorecard.machine.arch}`,
		`- Parameters: tier ${scorecard.parameters.tier}, temperature ${scorecard.parameters.temperature}, seed ${scorecard.parameters.seed}, metric ${scorecard.parameters.metric}, task files up to ${scorecard.parameters.maxTaskFileChars} characters`,
		`- Time: took ${Math.round(scorecard.tookSeconds)} s${scorecard.estimateSeconds === null ? '; no estimate (no model had a measured speed)' : `; estimated ${Math.round(scorecard.estimateSeconds)} s from the datasheets`}`,
		'',
		...scorecard.models.flatMap(model => [
			`### ${model.id}`,
			'',
			`- Weights digest: ${model.digest ?? 'not reported by the runtime'}`,
			`- Runtime: ${model.runtime}${model.runtimeVersion ? ` ${model.runtimeVersion}` : ', version not reported'}`,
			`- Context: ${model.contextTokens ?? 'unknown'} tokens${model.contextSource ? ` (${model.contextSource})` : ''}`,
			`- Published: ${model.publishedAt ?? 'not known to the catalog'}`,
			model.datasheet.length ? `- Datasheet, measured ${model.datasheetMeasuredAt ?? 'at an unrecorded time'}:` : '- Datasheet: this model has not been measured on this machine (run "Onyx: Measure This Model").',
			...model.datasheet.map(line => `  - ${line}`),
			'',
		]),
		...(scorecard.routing ? [
			'## The router\'s picks',
			'',
			`- The router's pick was the model you picked in a tournament in ${scorecard.routing.tournament.matches} of ${scorecard.routing.tournament.of} tournaments.`,
			`- You kept what the router's pick produced in ${scorecard.routing.outcomes.accepted} of ${scorecard.routing.outcomes.of} runs with a recorded outcome.`,
			'- These are logged choices, not a randomized comparison: they say what happened with the model the router picked, and nothing about a model it did not pick.',
			'',
		] : []),
		'## Every attempt',
		'',
		'| Model | Task | Outcome | Score | Exact | Why |',
		'|---|---|---|---|---|---|',
		...scorecard.attempts.map(attempt => `| ${cell(attempt.model)} | ${cell(attempt.task)} | ${attempt.outcome} | ${fixed(attempt.score)} | ${attempt.success === null ? 'n/a' : attempt.success ? 'yes' : 'no'} | ${cell(attempt.reason)} |`),
		'',
		...(scorecard.skips.length ? [
			'## Skipped',
			'',
			'| Model | Task | Why |',
			'|---|---|---|',
			...scorecard.skips.map(skip => `| ${cell(skip.model)} | ${cell(skip.task)} | ${cell(skip.reason)} |`),
			'',
		] : []),
	];
	return lines.join('\n');
}

const escapeXml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * The scorecard as an SVG: one bar a model for its mean score, with the
 * counts beside it, and the provenance in the picture itself, so that the
 * image cannot be passed on without it.
 */
export function renderScorecardSvg(scorecard: IOnyxScorecard, minimum = ONYX_MIN_TASKS_TO_RANK): string {
	const ranking = rankModels(scorecard.attempts, scorecard.partial, minimum);
	const standings = ranking.ranked ? ranking.order : ranking.standings;
	const width = 760;
	const rowHeight = 34;
	const top = 96;
	const barLeft = 250;
	const barWidth = 300;
	const height = top + standings.length * rowHeight + 110;
	const title = `Onyx scorecard${scorecard.partial ? ' (partial)' : ''}`;
	const note = ranking.ranked ? 'Ranked by mean score' : ranking.reason === 'partial' ? 'Not ranked: partial result' : ranking.reason === 'one-model' ? 'Not ranked: one model' : `Not ranked: fewer than ${minimum} scored tasks for a model`;
	const rows = standings.map((standing, index) => {
		const y = top + index * rowHeight;
		const bar = Math.round((standing.meanScore ?? 0) * barWidth);
		return [
			`<text x="24" y="${y + 16}" class="label">${escapeXml(standing.model)}</text>`,
			`<rect x="${barLeft}" y="${y}" width="${barWidth}" height="22" class="track"/>`,
			`<rect x="${barLeft}" y="${y}" width="${bar}" height="22" class="bar"/>`,
			`<text x="${barLeft + barWidth + 12}" y="${y + 16}" class="value">${fixed(standing.meanScore)} mean · ${standing.succeeded} of ${standing.attempted} exact${standing.couldNotServe ? ` · ${standing.couldNotServe} not served` : ''}</text>`,
		].join('');
	}).join('');
	const footerY = top + standings.length * rowHeight + 24;
	const footer = [
		`${scorecard.tasks.total} tasks (${scorecard.tasks.byHoldout['held-out']} held out, ${scorecard.tasks.byHoldout.unknown} holdout unknown) · ${scorecard.attempts.length} of ${scorecard.plannedUnits} units`,
		`${scorecard.repository.name} at ${(scorecard.repository.commit ?? 'unknown').slice(0, 12)} · ${scorecard.machine.cpu}, ${scorecard.machine.memoryGiB} GiB`,
		`${scorecard.models.map(model => `${model.id} ${(model.digest ?? 'no digest').replace(/^sha256:/, '').slice(0, 12)}`).join(' · ')}`,
		`metric ${scorecard.parameters.metric} · temperature ${scorecard.parameters.temperature} · seed ${scorecard.parameters.seed} · ${scorecard.generatedAt}`,
	].map((line, index) => `<text x="24" y="${footerY + index * 18}" class="provenance">${escapeXml(line)}</text>`).join('');
	return [
		`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeXml(title)}">`,
		'<style>.title{font:600 18px sans-serif;fill:#1f2328}.note{font:13px sans-serif;fill:#57606a}.label{font:13px monospace;fill:#1f2328}.value{font:12px sans-serif;fill:#1f2328}.provenance{font:11px monospace;fill:#57606a}.track{fill:#eaeef2}.bar{fill:#3b6fd4}.bg{fill:#ffffff}</style>',
		`<rect class="bg" width="${width}" height="${height}"/>`,
		`<text x="24" y="34" class="title">${escapeXml(title)}</text>`,
		`<text x="24" y="56" class="note">${escapeXml(note)} · mean score, 0 to 1: closeness to the author's change, not correctness</text>`,
		`<text x="${barLeft}" y="${top - 10}" class="note">0</text><text x="${barLeft + barWidth - 8}" y="${top - 10}" class="note">1</text>`,
		rows,
		footer,
		'</svg>',
	].join('\n');
}
