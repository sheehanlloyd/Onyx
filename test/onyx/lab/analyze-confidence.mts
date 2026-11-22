/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The calibration study's analysis (L16, H-8): reads a tier S campaign that
 * asked each model each task with several seeds, labels the hunks of the
 * first seed's exactly applied reply as correct or not, gives each hunk two
 * estimates, and says how well each estimate separates the two classes and
 * how well calibrated it is.
 *
 *   node test/onyx/lab/analyze-confidence.mts docs/research/results/<date>-<name> [--repo <path>]
 *
 * A labelled hunk: a hunk between the file as it was and the first seed's
 * reply applied exactly. It is correct when every line it adds is a line
 * the author's change added and every line it removes is a line the
 * author's change removed (lines compared trimmed, blank lines left out; a
 * hunk of blank lines only is not labelled).
 * Agreement: the share of the samples whose applied result has the same hunk.
 * Token probability: the least probability of any token of the edit block
 * the hunk came from, from the log-probabilities the runtime returned.
 *
 * It writes `confidence.json` and, when the manifest names H-8,
 * `outcome-H-8.json`. The metrics are `common/onyxCalibration.ts`; it needs
 * compiled output.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const out = (relative: string) => pathToFileURL(path.join(repoRoot, 'out', relative)).href;
const directory = process.argv[2] && !process.argv[2].startsWith('--') ? path.resolve(process.argv[2]) : undefined;
if (!directory) {
	console.error('usage: node test/onyx/lab/analyze-confidence.mts <results directory> [--repo <path>]');
	process.exit(2);
}
const repoFlag = process.argv.indexOf('--repo');
const repo = repoFlag === -1 ? repoRoot : path.resolve(process.argv[repoFlag + 1]);

interface IInterval { readonly value: number; readonly low: number; readonly high: number }
interface IBlock { readonly search: string; readonly replace: string }
interface IHunk { readonly originalStart: number; readonly originalLines: readonly string[]; readonly newLines: readonly string[] }
type Parse = { kind: 'blocks'; blocks: readonly IBlock[] } | { kind: 'rewrite'; text: string } | { kind: 'unparseable' };
const edit: { parseInlineEdits(reply: string): Parse; applyEditBlocks(original: string, blocks: readonly IBlock[]): { text: string; appliedCount: number }; computeLineHunks(original: string, modified: string): IHunk[] } = await import(out('vs/workbench/contrib/onyx/common/onyxInlineEdit.js'));
const calibration: {
	auroc(scores: readonly number[], correct: readonly boolean[]): number;
	aurocInterval(scores: readonly number[], correct: readonly boolean[], options: { clusters?: readonly string[]; resamples?: number; seed?: number }): IInterval;
	reliability(estimates: readonly number[], correct: readonly boolean[]): { bins: object[]; ece: number };
	decideEstimator(input: { auroc: IInterval; ece: number; correct: number; incorrect: number }): { outcome: string; badge: boolean; reason: string };
} = await import(out('vs/workbench/contrib/onyx/common/onyxCalibration.js'));

interface ITask { readonly id: string; readonly commit: string; readonly file: string }
interface IRecord { readonly model: string; readonly task: string; readonly seed: number; readonly outcome: string; readonly reply: string | null; readonly tokens?: readonly (readonly [string, number])[] }
const tasks = new Map((JSON.parse(fs.readFileSync(path.join(directory, 'tasks.json'), 'utf8')) as { tasks: ITask[] }).tasks.map(task => [task.id, task]));
const records: IRecord[] = fs.readFileSync(path.join(directory, 'traces', 'records.jsonl'), 'utf8').split('\n').filter(line => line.trim()).map(line => JSON.parse(line));
const manifest: { hypotheses?: string[]; seeds: number[] } = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));

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

const counted = (lines: readonly string[]) => {
	const counts = new Map<string, number>();
	for (const line of lines) {
		const key = line.trim();
		if (key) {
			counts.set(key, (counts.get(key) ?? 0) + 1);
		}
	}
	return counts;
};
/** What the author's change added and removed, as multisets of trimmed lines. */
function reference(before: string, after: string): { added: Map<string, number>; removed: Map<string, number> } {
	const hunks = edit.computeLineHunks(before, after);
	return { added: counted(hunks.flatMap(hunk => hunk.newLines)), removed: counted(hunks.flatMap(hunk => hunk.originalLines)) };
}
const within = (lines: Map<string, number>, of: Map<string, number>) => [...lines].every(([line, count]) => count <= (of.get(line) ?? 0));

/** A reply applied exactly, and the block each part of it came from. */
function applied(before: string, reply: string | null): { result: string; blocks: readonly IBlock[]; whole: boolean } | undefined {
	if (reply === null) {
		return undefined;
	}
	const parsed = edit.parseInlineEdits(reply);
	if (parsed.kind === 'rewrite') {
		return { result: parsed.text, blocks: [], whole: true };
	}
	if (parsed.kind !== 'blocks') {
		return undefined;
	}
	const result = edit.applyEditBlocks(before, parsed.blocks);
	return result.appliedCount > 0 ? { result: result.text, blocks: parsed.blocks, whole: false } : undefined;
}
const hunkKey = (hunk: IHunk) => JSON.stringify([hunk.originalStart, hunk.originalLines, hunk.newLines]);

/** The least token probability over the part of the reply that is the block a hunk came from; undefined when it cannot be placed. */
function tokenProbability(reply: string, tokens: readonly (readonly [string, number])[] | undefined, hunk: IHunk, blocks: readonly IBlock[], whole: boolean): number | undefined {
	if (!tokens || tokens.length === 0 || tokens.map(token => token[0]).join('') !== reply) {
		return undefined;
	}
	let start = 0;
	let end = reply.length;
	if (!whole) {
		const added = hunk.newLines.filter(line => line.trim());
		const removed = hunk.originalLines.filter(line => line.trim());
		const block = blocks.find(candidate => {
			const replace = new Set(candidate.replace.split('\n'));
			const search = new Set(candidate.search.split('\n'));
			return added.every(line => replace.has(line)) && removed.every(line => search.has(line));
		});
		const at = block ? reply.indexOf(block.search) : -1;
		if (!block || at === -1) {
			return undefined;
		}
		start = at;
		const close = reply.indexOf('>>>>', at + block.search.length);
		end = close === -1 ? reply.length : close;
	}
	let least = Infinity;
	let offset = 0;
	for (const [token, logprob] of tokens) {
		if (offset + token.length > start && offset < end) {
			least = Math.min(least, Math.exp(logprob));
		}
		offset += token.length;
	}
	return Number.isFinite(least) ? Math.min(1, least) : undefined;
}

interface ILabelled { readonly model: string; readonly task: string; readonly correct: boolean; readonly agreement: number; readonly samples: number; readonly tokenProbability: number | undefined }
const labelled: ILabelled[] = [];
const counts = { units: 0, unitsWithoutAnAppliedFirstReply: 0, unitsWithoutEverySample: 0, hunksOfBlankLinesOnly: 0, hunksWithoutATokenProbability: 0, tasksNotInTheRepository: 0 };
const groups = new Map<string, IRecord[]>();
for (const record of records) {
	const key = `${record.model}\u0000${record.task}`;
	groups.set(key, [...(groups.get(key) ?? []), record]);
}
for (const group of groups.values()) {
	const task = tasks.get(group[0].task);
	const before = task ? show(`${task.commit}~1`, task.file) : undefined;
	const after = task ? show(task.commit, task.file) : undefined;
	if (!task || before === undefined || after === undefined) {
		counts.tasksNotInTheRepository++;
		continue;
	}
	counts.units++;
	const samples = [...group].sort((left, right) => left.seed - right.seed).filter(record => record.outcome === 'attempted');
	if (samples.length < manifest.seeds.length) {
		counts.unitsWithoutEverySample++;
	}
	const first = samples[0];
	const firstApplied = first ? applied(before, first.reply) : undefined;
	if (!first || !firstApplied) {
		counts.unitsWithoutAnAppliedFirstReply++;
		continue;
	}
	const author = reference(before, after);
	const others = samples.map(sample => new Set((applied(before, sample.reply) ? edit.computeLineHunks(before, applied(before, sample.reply)!.result) : []).map(hunkKey)));
	for (const hunk of edit.computeLineHunks(before, firstApplied.result)) {
		const adds = counted(hunk.newLines);
		const removes = counted(hunk.originalLines);
		if (adds.size === 0 && removes.size === 0) {
			counts.hunksOfBlankLinesOnly++;
			continue;
		}
		const probability = tokenProbability(first.reply!, first.tokens, hunk, firstApplied.blocks, firstApplied.whole);
		if (probability === undefined) {
			counts.hunksWithoutATokenProbability++;
		}
		labelled.push({
			model: first.model, task: first.task, correct: within(adds, author.added) && within(removes, author.removed),
			agreement: others.filter(hunks => hunks.has(hunkKey(hunk))).length / samples.length, samples: samples.length, tokenProbability: probability,
		});
	}
}

function estimator(name: string, sample: readonly ILabelled[], pick: (hunk: ILabelled) => number | undefined) {
	const usable = sample.filter(hunk => pick(hunk) !== undefined);
	const scores = usable.map(hunk => pick(hunk)!);
	const correct = usable.map(hunk => hunk.correct);
	const interval = calibration.aurocInterval(scores, correct, { clusters: usable.map(hunk => `${hunk.model}|${hunk.task}`), resamples: 2000, seed: 1 });
	const table = calibration.reliability(scores, correct);
	const counted = { correct: correct.filter(Boolean).length, incorrect: correct.filter(value => !value).length };
	return { estimator: name, hunks: usable.length, ...counted, auroc: interval, ece: table.ece, reliability: table.bins, decision: calibration.decideEstimator({ auroc: interval, ece: table.ece, ...counted }) };
}
const both = (sample: readonly ILabelled[]) => [estimator('agreement', sample, hunk => hunk.agreement), estimator('token-probability', sample, hunk => hunk.tokenProbability)];
const pooled = both(labelled);
const models = [...new Set(labelled.map(hunk => hunk.model))];
const result = {
	records: records.length,
	...counts,
	labelledHunks: labelled.length,
	correctHunks: labelled.filter(hunk => hunk.correct).length,
	registeredMinimumOfLabelledHunks: 500,
	pooled,
	byModel: models.map(model => ({ model, estimators: both(labelled.filter(hunk => hunk.model === model)) })),
	hunks: labelled,
};
fs.writeFileSync(path.join(directory, 'confidence.json'), JSON.stringify(result, undefined, '\t') + '\n');
console.log(`${labelled.length} labelled hunks, ${result.correctHunks} correct`);
for (const entry of pooled) {
	console.log(`  ${entry.estimator}: ${entry.hunks} hunks, AUROC ${entry.auroc.value.toFixed(3)} [${entry.auroc.low.toFixed(3)}, ${entry.auroc.high.toFixed(3)}], ECE ${entry.ece.toFixed(3)}: ${entry.decision.outcome}${entry.decision.badge ? ', badge' : ', no badge'} (${entry.decision.reason})`);
}
if (manifest.hypotheses?.includes('H-8')) {
	const outcomes = pooled.map(entry => entry.decision.outcome);
	const outcome = outcomes.includes('supported') ? 'supported' : outcomes.every(value => value === 'refuted') ? 'refuted' : 'inconclusive';
	const badge = pooled.find(entry => entry.decision.badge)?.estimator ?? null;
	fs.writeFileSync(path.join(directory, 'outcome-H-8.json'), JSON.stringify({
		hypothesis: 'H-8',
		statement: 'Sample agreement or token probability predicts hunk correctness better than chance by a pre-registered margin',
		outcome,
		number: pooled.map(entry => `${entry.estimator}: AUROC ${Number.isNaN(entry.auroc.value) ? 'undefined' : entry.auroc.value.toFixed(3)} on ${entry.hunks} hunks (${entry.correct} correct), ${entry.decision.outcome}`).join('; '),
		badge: badge === null ? 'no badge ships' : `a badge may ship for ${badge}`,
		byEstimator: pooled.map(entry => ({ estimator: entry.estimator, outcome: entry.decision.outcome, badge: entry.decision.badge, reason: entry.decision.reason })),
		thresholds: 'Supported for an estimator: AUROC lower bound at least 0.65. Refuted: upper bound below 0.60. Inconclusive otherwise, and when fewer than 20 labelled hunks are correct or fewer than 20 incorrect. A badge ships only for a supported estimator whose ECE is at most 0.10 (PREREGISTRATION.md, H-8 and Amendment 2).',
		decidedFrom: ['confidence.json', 'traces/records.jsonl'],
		regenerate: `node test/onyx/lab/analyze-confidence.mts docs/research/results/${path.basename(directory)}`,
	}, undefined, '\t') + '\n');
	console.log(`H-8: ${outcome}; ${badge === null ? 'no badge ships' : `badge: ${badge}`}`);
}
