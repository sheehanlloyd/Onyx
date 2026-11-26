/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The analysis of PREREGISTRATION.md, Amendment 5, A5.1: three tool-call
 * protocols, everything else the product's configuration, both pinned
 * models, H-2's 40 tasks. Primary outcome: whether a run ends with an edit
 * on record (an entry of the record's `edits` with `ok: true`). Written
 * before any record of the campaign was read.
 *
 *   node test/onyx/lab/analyze-protocol.mts docs/research/results/2026-11-26-protocol
 *
 * Writes `protocol.json` and `outcome-protocol.json` beside the manifest.
 * Needs compiled output (the bootstrap and the Wilson interval are
 * `common/onyxAttribution.ts`).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const out = (relative: string) => pathToFileURL(path.join(repoRoot, 'out', relative)).href;
const directory = process.argv[2] ? path.resolve(process.argv[2]) : undefined;
if (!directory) {
	console.error('usage: node test/onyx/lab/analyze-protocol.mts <results directory>');
	process.exit(2);
}

interface IInterval { readonly value: number; readonly low: number; readonly high: number }
const stats: { wilsonInterval(successes: number, trials: number): IInterval; pairedDifference(first: readonly number[], second: readonly number[], options?: { resamples?: number; seed?: number }): IInterval } = await import(out('vs/workbench/contrib/onyx/common/onyxAttribution.js'));

interface IRecord { readonly unit: string; readonly model: string; readonly configuration: string; readonly task: string; readonly outcome: string; readonly edits?: readonly { readonly ok?: boolean }[]; readonly requests?: readonly unknown[] }
const lines = <T,>(file: string): T[] => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(line => line.trim()).map(line => JSON.parse(line)) : [];
const records = lines<IRecord>(path.join(directory, 'traces', 'records.jsonl'));
const scored = new Map(lines<{ unit: string; success: boolean | null }>(path.join(directory, 'results.jsonl')).map(result => [result.unit, result]));

const PRODUCT = 'constrained-envelope';
const ARMS = ['constrained-envelope', 'repaired-text', 'constrained-edit-first'];
const PAIRS: readonly (readonly [string, string])[] = [['repaired-text', PRODUCT], ['constrained-edit-first', PRODUCT], ['constrained-edit-first', 'repaired-text']];
const models = [...new Set(records.map(record => record.model))].sort();

interface IRun { readonly editOnRecord: number; readonly editCall: number; readonly success: number; readonly requests: number }
const runOf = (record: IRecord): IRun => ({
	editOnRecord: (record.edits ?? []).some(edit => edit.ok === true) ? 1 : 0,
	editCall: (record.edits ?? []).length > 0 ? 1 : 0,
	success: scored.get(record.unit)?.success === true ? 1 : 0,
	requests: (record.requests ?? []).length,
});
const attempted = (record: IRecord) => record.outcome === 'attempted' || record.outcome === 'blocked-by-policy';

const perModel = models.map(model => {
	const byArm = new Map(ARMS.map(arm => [arm, new Map(records.filter(record => record.model === model && record.configuration === arm && attempted(record)).map(record => [record.task, runOf(record)]))]));
	const arms = ARMS.map(arm => {
		const runs = [...(byArm.get(arm)?.values() ?? [])];
		const sum = (field: keyof IRun) => runs.reduce((total, run) => total + run[field], 0);
		return {
			arm, runs: runs.length,
			editOnRecord: { count: sum('editOnRecord'), share: stats.wilsonInterval(sum('editOnRecord'), runs.length) },
			editCall: { count: sum('editCall'), share: stats.wilsonInterval(sum('editCall'), runs.length) },
			success: { count: sum('success'), share: stats.wilsonInterval(sum('success'), runs.length) },
			meanRequests: runs.length ? sum('requests') / runs.length : null,
		};
	});
	const pairs = PAIRS.map(([first, second]) => {
		const tasks = [...(byArm.get(first)?.keys() ?? [])].filter(task => byArm.get(second)?.has(task)).sort();
		const column = (arm: string, field: keyof IRun) => tasks.map(task => byArm.get(arm)!.get(task)![field]);
		const edits = stats.pairedDifference(column(first, 'editOnRecord'), column(second, 'editOnRecord'), { resamples: 1000, seed: 1 });
		const success = stats.pairedDifference(column(first, 'success'), column(second, 'success'), { resamples: 1000, seed: 1 });
		return {
			first, second, pairedTasks: tasks.length,
			editOnRecordDifference: edits,
			successDifference: success,
			// A5.1's decision: an arm leads to more edits on record than another when the interval excludes 0.
			moreEditsOnRecord: edits.low > 0 ? first : edits.high < 0 ? second : 'neither',
		};
	});
	const floor = arms.every(arm => arm.editOnRecord.count === 0);
	return { model, arms, pairs, floor };
});

// What is written for the owner (A5.1): an arm that leads the product's protocol for both models without losing more than 5 points of success.
const qualifying = ARMS.filter(arm => arm !== PRODUCT).filter(arm => perModel.length > 0 && perModel.every(entry => {
	const pair = entry.pairs.find(candidate => candidate.first === arm && candidate.second === PRODUCT);
	return !entry.floor && pair !== undefined && pair.moreEditsOnRecord === arm && pair.successDifference.low >= -0.05;
}));
const recommendation = perModel.some(entry => entry.floor)
	? `a floor: ${perModel.filter(entry => entry.floor).map(entry => entry.model).join(' and ')} had no edit on record in any arm; nothing is recommended`
	: qualifying.length === 0
		? 'keep the default: no arm led to more edits on record than constrained-envelope for both models without losing more than 5 points of task success'
		: `recommended to the owner as the default: ${qualifying.join(' or ')} (for both models more edits on record than constrained-envelope, interval excluding 0, and task success not lower by more than 5 points)`;

const percent = (value: number) => Number.isNaN(value) ? 'n/a' : `${(value * 100).toFixed(1)}%`;
const result = {
	question: 'Which tool-call protocol leads to an edit on record, with the campaign engine fixed (PREREGISTRATION.md, Amendment 5, A5.1)',
	records: records.length,
	notAttempted: records.filter(record => !attempted(record)).length,
	perModel,
	recommendation,
	howItIsCounted: 'An edit on record: an entry of the record\'s edits with ok true. An edit call: any entry of edits. Success: labTaskSucceeded, from results.jsonl. Differences are paired by task, bootstrap over tasks, 1,000 resamples, seed 1; shares have Wilson intervals.',
};
fs.writeFileSync(path.join(directory, 'protocol.json'), JSON.stringify(result, undefined, '\t') + '\n');
fs.writeFileSync(path.join(directory, 'outcome-protocol.json'), JSON.stringify({
	question: result.question,
	outcome: recommendation,
	number: perModel.map(entry => `${entry.model}: ${entry.arms.map(arm => `${arm.arm} ${arm.editOnRecord.count} of ${arm.runs} with an edit on record (${percent(arm.editOnRecord.share.value)}), ${arm.success.count} succeeded`).join('; ')}`).join(' | '),
	thresholds: 'Per model and pair, an arm leads to more edits on record when the paired bootstrap interval of the difference excludes 0. An arm is recommended as the default when, for both models, it leads constrained-envelope and its task success is not lower by more than 5 points (lower bound of the difference at least -0.05). A model with no edit on record in any arm is a floor (PREREGISTRATION.md, Amendment 5, A5.1).',
	decidedFrom: ['protocol.json', 'traces/records.jsonl', 'results.jsonl'],
	regenerate: `node test/onyx/lab/analyze-protocol.mts docs/research/results/${path.basename(directory)}`,
}, undefined, '\t') + '\n');
for (const entry of perModel) {
	console.log(`${entry.model}`);
	for (const arm of entry.arms) {
		console.log(`  ${arm.arm}: ${arm.editOnRecord.count} of ${arm.runs} with an edit on record (${percent(arm.editOnRecord.share.value)}, ${percent(arm.editOnRecord.share.low)} to ${percent(arm.editOnRecord.share.high)}); edit calls ${arm.editCall.count}; succeeded ${arm.success.count}; mean requests ${arm.meanRequests?.toFixed(2)}`);
	}
	for (const pair of entry.pairs) {
		console.log(`  ${pair.first} - ${pair.second}: edits on record ${pair.editOnRecordDifference.value.toFixed(3)} [${pair.editOnRecordDifference.low.toFixed(3)}, ${pair.editOnRecordDifference.high.toFixed(3)}], more: ${pair.moreEditsOnRecord}; success ${pair.successDifference.value.toFixed(3)} [${pair.successDifference.low.toFixed(3)}, ${pair.successDifference.high.toFixed(3)}]`);
	}
}
console.log(`A5.1: ${recommendation}`);
