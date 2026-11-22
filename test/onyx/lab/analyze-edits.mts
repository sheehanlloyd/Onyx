/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * L14: evaluating the edit mechanisms, on replies that campaigns saved.
 * Nothing is run against a model here.
 *
 *   node test/onyx/lab/analyze-edits.mts --out docs/research/results/<date>-edit-mechanisms \
 *        --campaign <results dir> [--campaign <results dir>…] [--anchors <results dir of the two-arm campaign>] [--repo <path>]
 *
 * H-3: every SEARCH/REPLACE block of every saved reply is placed by four
 * appliers (the product's exact-unique one and three lab comparators) and
 * each result is compared with the author's change. H-4: the two arms of the
 * anchors campaign, paired by task. H-5: grounded against ungrounded edits
 * of the agent runs. The designs are PREREGISTRATION.md, Amendment 2. It
 * writes `attempts.jsonl` (one line an attempt, digests and verdicts, no
 * source text), `analysis.json`, `ANALYSIS.md` and one `outcome-H-<n>.json`
 * a hypothesis.
 */

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { COMPARATORS, type IEditBlock } from './appliers.mts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const out = (relative: string) => pathToFileURL(path.join(repoRoot, 'out', relative)).href;
const flags = (name: string): string[] => process.argv.flatMap((argument, index) => argument === name && process.argv[index + 1] ? [process.argv[index + 1]] : []);
const outDir = flags('--out')[0] ? path.resolve(flags('--out')[0]) : undefined;
const campaigns = flags('--campaign').map(entry => path.resolve(entry));
const anchorsDir = flags('--anchors')[0] ? path.resolve(flags('--anchors')[0]) : undefined;
const repo = path.resolve(flags('--repo')[0] ?? repoRoot);
if (!outDir || campaigns.length === 0) {
	console.error('usage: node test/onyx/lab/analyze-edits.mts --out <results dir> --campaign <results dir>… [--anchors <results dir>] [--repo <path>]');
	process.exit(2);
}

interface IInterval { readonly value: number; readonly low: number; readonly high: number }
const inline: { parseInlineEdits(reply: string): { kind: string; blocks?: IEditBlock[] }; placeEditBlock(text: string, block: IEditBlock): { ok: boolean; text?: string } } = await import(out('vs/workbench/contrib/onyx/common/onyxInlineEdit.js'));
const readTools: { decodeNumberedSearch(search: string, file: string): { kind: string; text?: string } } = await import(out('vs/workbench/contrib/onyx/common/onyxReadTools.js'));
const estimators: { wilsonInterval(successes: number, trials: number): IInterval; seededRandom(seed: number): () => number } = await import(out('vs/workbench/contrib/onyx/common/onyxAttribution.js'));

const digest = (text: string) => crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
const shown = new Map<string, string | undefined>();
function show(revision: string, file: string): string | undefined {
	const key = `${revision}:${file}`;
	if (!shown.has(key)) {
		try {
			shown.set(key, execFileSync('git', ['-C', repo, 'show', key], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }));
		} catch {
			shown.set(key, undefined);
		}
	}
	return shown.get(key);
}

/** The lines `after` has beyond `before` and the lines `before` has beyond `after`, trimmed, as multisets. */
function changed(before: string, after: string): { added: Map<string, number>; removed: Map<string, number> } {
	const count = (text: string) => {
		const counts = new Map<string, number>();
		for (const line of text.split('\n')) {
			const key = line.trim();
			if (key) {
				counts.set(key, (counts.get(key) ?? 0) + 1);
			}
		}
		return counts;
	};
	const a = count(before);
	const b = count(after);
	const added = new Map<string, number>();
	const removed = new Map<string, number>();
	for (const [line, n] of b) {
		if (n > (a.get(line) ?? 0)) {
			added.set(line, n - (a.get(line) ?? 0));
		}
	}
	for (const [line, n] of a) {
		if (n > (b.get(line) ?? 0)) {
			removed.set(line, n - (b.get(line) ?? 0));
		}
	}
	return { added, removed };
}
const size = (lines: Map<string, number>) => [...lines.values()].reduce((sum, n) => sum + n, 0);
const overlap = (left: Map<string, number>, right: Map<string, number>) => [...left].reduce((sum, [line, n]) => sum + Math.min(n, right.get(line) ?? 0), 0);
/** The F1 between what an edit changed and what the author changed, and how many lines it changed that the author did not. */
function against(before: string, result: string, reference: { added: Map<string, number>; removed: Map<string, number> }): { score: number; outside: number } {
	const own = changed(before, result);
	const mine = size(own.added) + size(own.removed);
	const theirs = size(reference.added) + size(reference.removed);
	const shared = overlap(own.added, reference.added) + overlap(own.removed, reference.removed);
	const precision = mine ? shared / mine : 0;
	const recall = theirs ? shared / theirs : 0;
	return { score: precision + recall > 0 ? 2 * precision * recall / (precision + recall) : 0, outside: mine - shared };
}

interface ITask { readonly id: string; readonly commit: string; readonly file: string }
interface IRecord { readonly unit: string; readonly model: string; readonly configuration: string; readonly task: string; readonly tier: 'S' | 'A'; readonly outcome: string; readonly reply: string | null; readonly durationMs: number; readonly edits: readonly { readonly path: string; readonly protocol: string; readonly blocks: readonly IEditBlock[]; readonly ok: boolean; readonly grounding: readonly string[] }[]; readonly requests?: readonly { readonly firstTokenMs: number | null }[] }
interface IAttempt {
	readonly campaign: string; readonly unit: string; readonly model: string; readonly configuration: string; readonly task: string; readonly tier: 'S' | 'A'; readonly protocol: string;
	readonly searchDigest: string; readonly searchLines: number; readonly exactOccurrences: number; readonly grounding: string | null;
	/** For each applier: whether it placed the block, the score of the result, and whether the placement was silently wrong. */
	readonly appliers: Record<string, { readonly applied: boolean; readonly score: number; readonly outside: number; readonly silentlyWrong: boolean }>;
}

function readCampaign(directory: string): { name: string; tasks: Map<string, ITask>; records: IRecord[] } {
	const tasks: ITask[] = (JSON.parse(fs.readFileSync(path.join(directory, 'tasks.json'), 'utf8')) as { tasks: ITask[] }).tasks;
	const records: IRecord[] = fs.readFileSync(path.join(directory, 'traces', 'records.jsonl'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
	return { name: path.basename(directory), tasks: new Map(tasks.map(task => [task.id, task])), records };
}

/** One block against the file as it was when sent, under every applier. */
function attempt(campaign: string, record: IRecord, protocol: string, base: string, block: IEditBlock, reference: { added: Map<string, number>; removed: Map<string, number> }, grounding: string | null): { attempt: IAttempt; exactResult: string | undefined } {
	// The product decodes a numbered read before it places anything (R-24); every applier is given the same text.
	const decoding = readTools.decodeNumberedSearch(block.search, base);
	const sent: IEditBlock = decoding.kind === 'decoded' && decoding.text !== undefined ? { ...block, search: decoding.text } : block;
	const exactPresent = sent.search !== '' && base.includes(sent.search);
	const occurrences = sent.search === '' ? 0 : base.split(sent.search).length - 1;
	const placed = decoding.kind === 'refused' ? { ok: false as const } : inline.placeEditBlock(base, sent);
	const results: Record<string, string | undefined> = { 'exact-unique': placed.ok ? placed.text : undefined };
	for (const [name, apply] of Object.entries(COMPARATORS)) {
		results[name] = apply(base, sent);
	}
	const appliers: IAttempt['appliers'] = {};
	for (const [name, result] of Object.entries(results)) {
		const measured = result === undefined ? { score: 0, outside: 0 } : against(base, result, reference);
		appliers[name] = { applied: result !== undefined, score: Math.round(measured.score * 1000) / 1000, outside: measured.outside, silentlyWrong: result !== undefined && (!exactPresent || measured.outside > 0) };
	}
	return {
		attempt: { campaign, unit: record.unit, model: record.model, configuration: record.configuration, task: record.task, tier: record.tier, protocol, searchDigest: digest(sent.search), searchLines: sent.search.split('\n').length, exactOccurrences: occurrences, grounding, appliers },
		exactResult: results['exact-unique'],
	};
}

const attempts: IAttempt[] = [];
const sources: Record<string, { records: number; replies: number; attempts: number }> = {};
const missing: string[] = [];
for (const directory of [...campaigns, ...(anchorsDir && !campaigns.includes(anchorsDir) ? [anchorsDir] : [])]) {
	const campaign = readCampaign(directory);
	const counted = { records: campaign.records.length, replies: 0, attempts: 0 };
	for (const record of campaign.records) {
		const task = campaign.tasks.get(record.task);
		const before = task && show(`${task.commit}~1`, task.file);
		const after = task && show(task.commit, task.file);
		if (!task || before === undefined || after === undefined) {
			missing.push(`${campaign.name}/${record.unit}`);
			continue;
		}
		const reference = changed(before, after);
		if (record.tier === 'S') {
			if (record.outcome !== 'attempted' || record.reply === null) {
				continue;
			}
			counted.replies++;
			const parsed = inline.parseInlineEdits(record.reply);
			for (const block of parsed.kind === 'blocks' ? parsed.blocks ?? [] : []) {
				attempts.push(attempt(campaign.name, record, 'search-replace', before, block, reference, null).attempt);
				counted.attempts++;
			}
			continue;
		}
		// An agent run: each edit call, in order, against the file with what the run had staged before it.
		let base = before;
		for (const call of record.edits) {
			counted.replies++;
			if (call.protocol !== 'search-replace' || !call.path.endsWith(task.file)) {
				continue; // an anchored edit names lines, not text to find; an edit of another file has no reference
			}
			let next = base;
			let whole = true;
			call.blocks.forEach((block, index) => {
				const measured = attempt(campaign.name, record, call.protocol, next, block, reference, call.grounding[index] ?? null);
				attempts.push(measured.attempt);
				counted.attempts++;
				if (measured.exactResult === undefined) {
					whole = false;
				} else {
					next = measured.exactResult;
				}
			});
			// The product stages a call's blocks together or not at all.
			base = whole && call.ok ? next : base;
		}
	}
	sources[campaign.name] = counted;
}

const APPLIERS = ['exact-unique', 'whitespace-insensitive', 'unique-first-line', 'fuzzy'];
const RESAMPLES = 1000;
function bootstrapDifference(sample: readonly IAttempt[], left: string, right: string, seed: number): IInterval {
	const value = (rows: readonly IAttempt[]) => rows.length ? rows.reduce((sum, row) => sum + (row.appliers[left].applied ? 1 : 0) - (row.appliers[right].applied ? 1 : 0), 0) / rows.length : 0;
	const random = estimators.seededRandom(seed);
	const draws: number[] = [];
	for (let resample = 0; resample < RESAMPLES; resample++) {
		draws.push(value(sample.map(() => sample[Math.floor(random() * sample.length)])));
	}
	draws.sort((a, b) => a - b);
	return { value: value(sample), low: draws[Math.floor(RESAMPLES * 0.025)] ?? 0, high: draws[Math.floor(RESAMPLES * 0.975)] ?? 0 };
}
const pct = (interval: IInterval) => `${(interval.value * 100).toFixed(1)}% [${(interval.low * 100).toFixed(1)}, ${(interval.high * 100).toFixed(1)}]`;
const points = (interval: IInterval) => `${(interval.value * 100).toFixed(1)} points [${(interval.low * 100).toFixed(1)}, ${(interval.high * 100).toFixed(1)}]`;

// --- H-3 ------------------------------------------------------------------------------------------------------------
const freeForm = attempts.filter(row => row.protocol === 'search-replace');
const models = [...new Set(freeForm.map(row => row.model))].sort();
function applierTable(sample: readonly IAttempt[]) {
	return Object.fromEntries(APPLIERS.map(name => {
		const applied = sample.filter(row => row.appliers[name].applied);
		const wrong = applied.filter(row => row.appliers[name].silentlyWrong);
		return [name, {
			attempts: sample.length, applied: applied.length, applyRate: estimators.wilsonInterval(applied.length, sample.length),
			silentlyWrong: wrong.length, silentlyWrongRate: estimators.wilsonInterval(wrong.length, sample.length),
			appliedThoughNotInTheFile: applied.filter(row => row.exactOccurrences === 0).length,
			meanScore: sample.length ? Math.round(sample.reduce((sum, row) => sum + row.appliers[name].score, 0) / sample.length * 1000) / 1000 : 0,
		}];
	}));
}
const h3 = {
	pooled: { table: applierTable(freeForm), fuzzyLessExact: bootstrapDifference(freeForm, 'fuzzy', 'exact-unique', 1) },
	perModel: Object.fromEntries(models.map(model => {
		const sample = freeForm.filter(row => row.model === model);
		return [model, { table: applierTable(sample), fuzzyLessExact: bootstrapDifference(sample, 'fuzzy', 'exact-unique', 1) }];
	})),
};
const fuzzyWrong = h3.pooled.table.fuzzy.silentlyWrongRate;
const gap = h3.pooled.fuzzyLessExact;
// Supported: exact-unique's apply rate is lower than the fuzzy comparator's by at least 2 points (interval excludes 0),
// and the fuzzy comparator's silently-wrong rate is at least 0.5% with an interval excluding 0. Refuted: the difference's
// interval lies wholly below 2 points, or the silently-wrong rate's upper bound is below 0.5%. Inconclusive otherwise.
const h3Outcome = freeForm.length === 0 ? 'inconclusive'
	: gap.value >= 0.02 && gap.low > 0 && fuzzyWrong.value >= 0.005 && fuzzyWrong.low > 0 ? 'supported'
		: gap.high < 0.02 || fuzzyWrong.high < 0.005 ? 'refuted' : 'inconclusive';

// --- H-5 ------------------------------------------------------------------------------------------------------------
const agentEdits = freeForm.filter(row => row.tier === 'A');
const grounded = agentEdits.filter(row => row.grounding === 'grounded').map(row => row.appliers['exact-unique'].score);
const ungrounded = agentEdits.filter(row => row.grounding === 'ungrounded').map(row => row.appliers['exact-unique'].score);
const mean = (values: readonly number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
function meanDifference(left: readonly number[], right: readonly number[], seed: number): IInterval {
	const random = estimators.seededRandom(seed);
	const draws: number[] = [];
	for (let resample = 0; resample < RESAMPLES && left.length && right.length; resample++) {
		draws.push(mean(left.map(() => left[Math.floor(random() * left.length)])) - mean(right.map(() => right[Math.floor(random() * right.length)])));
	}
	draws.sort((a, b) => a - b);
	return { value: mean(left) - mean(right), low: draws[Math.floor(RESAMPLES * 0.025)] ?? 0, high: draws[Math.floor(RESAMPLES * 0.975)] ?? 0 };
}
/** Cliff's delta: how often a grounded edit scores above an ungrounded one, less how often below. */
function cliffsDelta(left: readonly number[], right: readonly number[]): number {
	let above = 0;
	let below = 0;
	for (const a of left) {
		for (const b of right) {
			above += a > b ? 1 : 0;
			below += a < b ? 1 : 0;
		}
	}
	return left.length && right.length ? (above - below) / (left.length * right.length) : 0;
}
const h5Difference = meanDifference(grounded, ungrounded, 1);
// Supported: grounded mean exceeds ungrounded by at least 0.05 with an interval excluding 0. Refuted: the difference's
// interval lies wholly below 0.05. Inconclusive otherwise, and when a class is empty.
const h5Outcome = grounded.length === 0 || ungrounded.length === 0 ? 'inconclusive'
	: h5Difference.value >= 0.05 && h5Difference.low > 0 ? 'supported' : h5Difference.high < 0.05 ? 'refuted' : 'inconclusive';
const h5 = {
	grounded: { edits: grounded.length, meanScore: Math.round(mean(grounded) * 1000) / 1000 }, ungrounded: { edits: ungrounded.length, meanScore: Math.round(mean(ungrounded) * 1000) / 1000 },
	leftOut: { unknown: agentEdits.filter(row => row.grounding === 'unknown').length, notApplicable: agentEdits.filter(row => row.grounding === 'not-applicable' || row.grounding === null).length },
	difference: h5Difference, cliffsDelta: Math.round(cliffsDelta(grounded, ungrounded) * 1000) / 1000, registeredMinimumPerClass: 300,
};

// --- H-4 ------------------------------------------------------------------------------------------------------------
interface IArm { readonly runs: number; readonly editCalls: number; readonly refused: number; readonly collateral: number; readonly meanScore: number; readonly medianSeconds: number; readonly p90Seconds: number }
let h4: { arms: Record<string, Record<string, IArm>>; pairedTasks: number; refusalDifference: IInterval | null; collateralDifference: IInterval | null; editCalls: number } | undefined;
let h4Outcome = 'inconclusive';
let h4Reason = 'the two-arm campaign was not given to this analysis';
if (anchorsDir) {
	const campaign = readCampaign(anchorsDir);
	const results: { unit: string; score: number | null }[] = fs.readFileSync(path.join(anchorsDir, 'results.jsonl'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
	const scoreOf = new Map(results.map(result => [result.unit, result.score ?? 0]));
	const manifest: { harnessConfigurations: { name: string; configuration?: { editProtocol?: string } }[] } = JSON.parse(fs.readFileSync(path.join(anchorsDir, 'manifest.json'), 'utf8'));
	const armOf = new Map(manifest.harnessConfigurations.map(entry => [entry.name, entry.configuration?.editProtocol === 'constrained-anchors' ? 'constrained-anchors' : 'search-replace']));
	const arms: Record<string, Record<string, IArm>> = {};
	// An edit call of a run is refused when nothing of it was staged; it is collateral when the run's proposal changes a line the author did not.
	const perTask = new Map<string, Record<string, { calls: number; refused: number; collateral: number }>>();
	for (const model of [...new Set(campaign.records.map(record => record.model))]) {
		arms[model] = {};
		for (const arm of ['search-replace', 'constrained-anchors']) {
			const runs = campaign.records.filter(record => record.model === model && armOf.get(record.configuration) === arm);
			let calls = 0;
			let refused = 0;
			let collateral = 0;
			for (const run of runs) {
				const task = campaign.tasks.get(run.task);
				const before = task && show(`${task.commit}~1`, task.file);
				const after = task && show(task.commit, task.file);
				const outside = run.reply !== null && before !== undefined && after !== undefined ? against(before, run.reply, changed(before, after)).outside : 0;
				const key = `${model}\u0000${run.task}`;
				const row = perTask.get(key) ?? {};
				row[arm] = { calls: run.edits.length, refused: run.edits.filter(call => !call.ok).length, collateral: outside > 0 ? 1 : 0 };
				perTask.set(key, row);
				calls += run.edits.length;
				refused += run.edits.filter(call => !call.ok).length;
				collateral += outside > 0 ? 1 : 0;
			}
			const seconds = runs.map(run => run.durationMs / 1000).sort((a, b) => a - b);
			arms[model][arm] = { runs: runs.length, editCalls: calls, refused, collateral, meanScore: Math.round(mean(runs.map(run => scoreOf.get(run.unit) ?? 0)) * 1000) / 1000, medianSeconds: seconds[Math.floor(seconds.length / 2)] ?? 0, p90Seconds: seconds[Math.floor(seconds.length * 0.9)] ?? 0 };
		}
	}
	// Paired by task, over tasks where both arms made at least one edit call: the refusal rate of the anchored arm less the free-form arm's.
	const paired = [...perTask.values()].filter(row => (row['search-replace']?.calls ?? 0) > 0 && (row['constrained-anchors']?.calls ?? 0) > 0);
	const totalCalls = Object.values(arms).flatMap(arm => Object.values(arm)).reduce((sum, arm) => sum + arm.editCalls, 0);
	const pairedDifference = (pick: (cell: { calls: number; refused: number; collateral: number }) => number, seed: number): IInterval | null => {
		if (paired.length === 0) {
			return null;
		}
		const value = (rows: typeof paired) => mean(rows.map(row => pick(row['constrained-anchors']) - pick(row['search-replace'])));
		const random = estimators.seededRandom(seed);
		const draws: number[] = [];
		for (let resample = 0; resample < RESAMPLES; resample++) {
			draws.push(value(paired.map(() => paired[Math.floor(random() * paired.length)])));
		}
		draws.sort((a, b) => a - b);
		return { value: value(paired), low: draws[Math.floor(RESAMPLES * 0.025)], high: draws[Math.floor(RESAMPLES * 0.975)] };
	};
	const refusalDifference = pairedDifference(cell => cell.refused / cell.calls, 1);
	const collateralDifference = pairedDifference(cell => cell.collateral, 1);
	h4 = { arms, pairedTasks: paired.length, refusalDifference, collateralDifference, editCalls: totalCalls };
	// Supported: refusal rate lower by at least 5 points (interval excludes 0) and the collateral rate's difference has an upper bound of at
	// most 1 point. Refuted: the refusal difference's interval includes 0, or the collateral rate rises by more than 1 point with an interval
	// excluding 1. Inconclusive otherwise. With no task on which both arms attempted an edit there is nothing to compare.
	if (!refusalDifference || !collateralDifference) {
		h4Outcome = 'inconclusive';
		h4Reason = `no task had an edit call in both arms (${totalCalls} edit calls in all): there is no pair to compare`;
	} else if (refusalDifference.value <= -0.05 && refusalDifference.high < 0 && collateralDifference.high <= 0.01) {
		h4Outcome = 'supported';
		h4Reason = 'the anchored arm refuses fewer edits by at least 5 points with an interval excluding 0, and the collateral rate does not rise by more than a point';
	} else if ((refusalDifference.low <= 0 && refusalDifference.high >= 0) || (collateralDifference.value > 0.01 && collateralDifference.low > 0.01)) {
		h4Outcome = 'refuted';
		h4Reason = refusalDifference.low <= 0 && refusalDifference.high >= 0 ? 'the interval of the difference in refusal rate includes 0' : 'the collateral-edit rate rises by more than a point';
	} else {
		h4Outcome = 'inconclusive';
		h4Reason = 'the difference in refusal rate is on one side of 0 and smaller than the 5 points that would support the hypothesis';
	}
}

// --- written down ---------------------------------------------------------------------------------------------------
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'attempts.jsonl'), attempts.map(row => JSON.stringify(row)).join('\n') + (attempts.length ? '\n' : ''));
fs.writeFileSync(path.join(outDir, 'analysis.json'), JSON.stringify({ sources, recordsWhoseTaskIsNotInTheRepository: missing.length, resamples: RESAMPLES, seed: 1, registeredMinimumAttemptsPerModel: 500, h3, h4: h4 ?? null, h5 }, undefined, '\t') + '\n');
// The campaigns this analysis reads: each has its own manifest, and this directory has none of its own.
fs.writeFileSync(path.join(outDir, 'sources.json'), JSON.stringify({ campaigns: [...new Set([...campaigns, ...(anchorsDir ? [anchorsDir] : [])].map(directory => path.basename(directory)))] }, undefined, '\t') + '\n');
const name = path.basename(outDir);
const regenerate = `node test/onyx/lab/analyze-edits.mts --out docs/research/results/${name} ${campaigns.map(directory => `--campaign docs/research/results/${path.basename(directory)}`).join(' ')}${anchorsDir ? ` --anchors docs/research/results/${path.basename(anchorsDir)}` : ''}`;
const h3Number = `exact-unique placed ${h3.pooled.table['exact-unique'].applied} of ${freeForm.length} attempts and the fuzzy comparator ${h3.pooled.table.fuzzy.applied}: a difference of ${points(gap)}; ${h3.pooled.table.fuzzy.silentlyWrong} of the fuzzy comparator's placements were silently wrong, ${pct(fuzzyWrong)} of attempts`;
const outcomes = [
	{ hypothesis: 'H-3', statement: 'Exact-or-refuse loses a measurable share of edits relative to fuzzy appliers and prevents a non-zero share of silently wrong edits', outcome: h3Outcome, number: h3Number, reason: freeForm.length === 0 ? 'no attempt was saved' : `decided on the pooled sample of ${freeForm.length} attempts; the registered minimum is 500 for each model and the models have ${models.map(model => `${model}: ${freeForm.filter(row => row.model === model).length}`).join(', ')}` },
	{ hypothesis: 'H-4', statement: 'Constrained anchors lower the refusal rate relative to free-form SEARCH/REPLACE under exact-or-refuse, without raising the collateral-edit rate', outcome: h4Outcome, number: h4 ? `${h4.editCalls} edit calls in the two arms; ${h4.pairedTasks} tasks with an edit call in both${h4.refusalDifference ? `; refusal rate, anchored less free-form: ${points(h4.refusalDifference)}` : ''}` : 'not measured', reason: h4Reason },
	{ hypothesis: 'H-5', statement: 'Edits whose anchor was not in the model\'s context that turn score lower than grounded edits', outcome: h5Outcome, number: `grounded ${h5.grounded.edits} edits, mean score ${h5.grounded.meanScore.toFixed(3)}; ungrounded ${h5.ungrounded.edits} edits, mean score ${h5.ungrounded.meanScore.toFixed(3)}; difference ${h5Difference.value.toFixed(3)} [${h5Difference.low.toFixed(3)}, ${h5Difference.high.toFixed(3)}]`, reason: grounded.length === 0 || ungrounded.length === 0 ? 'one of the two classes has no edit' : `the registered minimum is 300 edits a class; Cliff's delta ${h5.cliffsDelta}` },
];
for (const outcome of outcomes) {
	fs.writeFileSync(path.join(outDir, `outcome-${outcome.hypothesis}.json`), JSON.stringify({ ...outcome, thresholds: `PREREGISTRATION.md, ${outcome.hypothesis}, with the sample of Amendment 2`, decidedFrom: ['attempts.jsonl', 'analysis.json'], regenerate }, undefined, '\t') + '\n');
}

const markdown: string[] = [
	`# The edit mechanisms: ${name}`,
	'',
	`Computed from the saved replies of ${campaigns.length + (anchorsDir && !campaigns.includes(anchorsDir) ? 1 : 0)} campaigns by \`${regenerate}\`. No model was run for this analysis. \`attempts.jsonl\` has one line an attempt, with digests and verdicts and no source text.`,
	'',
	'## Where the attempts come from',
	'',
	'| Campaign | Records | Replies or edit calls | Attempts (blocks) |', '|---|---|---|---|',
	...Object.entries(sources).map(([campaign, counted]) => `| ${campaign} | ${counted.records} | ${counted.replies} | ${counted.attempts} |`),
	'',
	'## H-3: the appliers',
	'',
	`${freeForm.length} attempts, pooled. An attempt is one SEARCH/REPLACE block against the file as it was when the block was sent.`,
	'',
	'| Applier | Placed | Apply rate | Placed though the text is not in the file | Silently wrong | Silently-wrong rate (of attempts) | Mean score |', '|---|---|---|---|---|---|---|',
	...APPLIERS.map(applier => { const row = h3.pooled.table[applier]; return `| ${applier} | ${row.applied} of ${row.attempts} | ${pct(row.applyRate)} | ${row.appliedThoughNotInTheFile} | ${row.silentlyWrong} | ${pct(row.silentlyWrongRate)} | ${row.meanScore.toFixed(3)} |`; }),
	'',
	`Apply rate of the fuzzy comparator less exact-unique: ${points(gap)} (bootstrap over attempts). Rates are with Wilson intervals. "Silently wrong" is a placement of a block whose text is not in the file exactly, or one whose result changes a line the author did not change; exact-unique can only be the second.`,
	'',
	...models.flatMap(model => { const sample = h3.perModel[model]; return [`**${model}**: ${sample.table['exact-unique'].attempts} attempts; exact-unique placed ${sample.table['exact-unique'].applied}, whitespace-insensitive ${sample.table['whitespace-insensitive'].applied}, unique-first-line ${sample.table['unique-first-line'].applied}, fuzzy ${sample.table.fuzzy.applied}; fuzzy less exact ${points(sample.fuzzyLessExact)}; fuzzy silently wrong ${sample.table.fuzzy.silentlyWrong}.`, '']; }),
	`By the registered thresholds: **${h3Outcome}**. ${outcomes[0].reason}.`,
	'',
	'## H-4: constrained anchors against free-form',
	'',
	...(h4 ? [
		'| Model | Arm | Runs | Edit calls | Refused | Runs whose proposal changed a line the author did not | Mean score | Median seconds | 90th percentile seconds |', '|---|---|---|---|---|---|---|---|---|',
		...Object.entries(h4.arms).flatMap(([model, arm]) => Object.entries(arm).map(([protocol, row]) => `| ${model} | ${protocol} | ${row.runs} | ${row.editCalls} | ${row.refused} | ${row.collateral} | ${row.meanScore.toFixed(3)} | ${row.medianSeconds.toFixed(1)} | ${row.p90Seconds.toFixed(1)} |`)),
		'',
		`Tasks with an edit call in both arms: ${h4.pairedTasks}.${h4.refusalDifference ? ` Refusal rate, anchored less free-form: ${points(h4.refusalDifference)}.` : ''}${h4.collateralDifference ? ` Collateral rate, anchored less free-form: ${points(h4.collateralDifference)}.` : ''}`,
		'',
	] : ['Not measured in this analysis.', '']),
	`By the registered thresholds: **${h4Outcome}**. ${h4Reason}.`,
	'',
	'## H-5: grounded against ungrounded edits',
	'',
	`Edits of agent runs whose certificate says where the model had seen the text it quoted. Grounded: ${h5.grounded.edits} edits, mean score ${h5.grounded.meanScore.toFixed(3)}. Ungrounded: ${h5.ungrounded.edits} edits, mean score ${h5.ungrounded.meanScore.toFixed(3)}. Left out: ${h5.leftOut.unknown} unknown, ${h5.leftOut.notApplicable} not applicable. Difference in mean score: ${h5Difference.value.toFixed(3)} [${h5Difference.low.toFixed(3)}, ${h5Difference.high.toFixed(3)}]; Cliff's delta ${h5.cliffsDelta}. The registered minimum is 300 edits a class.`,
	'',
	`By the registered thresholds: **${h5Outcome}**. ${outcomes[2].reason}.`,
	'',
];
fs.writeFileSync(path.join(outDir, 'ANALYSIS.md'), markdown.join('\n'));
console.log(`${attempts.length} attempts from ${Object.keys(sources).length} campaigns; H-3 ${h3Outcome}, H-4 ${h4Outcome}, H-5 ${h5Outcome}`);
