/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The analysis of PREREGISTRATION.md, Amendment 5, A5.3: H-9's three
 * eviction policies on agentic runs with a context small enough that a run
 * which reads a file and goes on has to evict. It says whether H-9's
 * condition, "at equal task success", was tested, and if so whether it held.
 * Written before any record of the campaign was read.
 *
 *   node test/onyx/lab/analyze-forced-eviction.mts docs/research/results/2026-11-26-eviction-forced
 *
 * Writes `forced-eviction.json` and `outcome-H-9-condition.json` beside the
 * manifest. H-9's own outcome is not touched. Needs compiled output.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const out = (relative: string) => pathToFileURL(path.join(repoRoot, 'out', relative)).href;
const directory = process.argv[2] ? path.resolve(process.argv[2]) : undefined;
if (!directory) {
	console.error('usage: node test/onyx/lab/analyze-forced-eviction.mts <results directory>');
	process.exit(2);
}

interface IInterval { readonly value: number; readonly low: number; readonly high: number }
const stats: { wilsonInterval(successes: number, trials: number): IInterval; pairedDifference(first: readonly number[], second: readonly number[], options?: { resamples?: number; seed?: number }): IInterval } = await import(out('vs/workbench/contrib/onyx/common/onyxAttribution.js'));

interface IEvent { readonly kind: string; readonly data: { readonly label?: string } }
interface IRecord { readonly unit: string; readonly model: string; readonly configuration: string; readonly task: string; readonly outcome: string; readonly events?: readonly IEvent[]; readonly edits?: readonly { readonly ok?: boolean }[]; readonly requests?: readonly { readonly promptTokens?: number | null }[] }
const lines = <T,>(file: string): T[] => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(line => line.trim()).map(line => JSON.parse(line)) : [];
const records = lines<IRecord>(path.join(directory, 'traces', 'records.jsonl'));
const scored = new Map(lines<{ unit: string; success: boolean | null }>(path.join(directory, 'results.jsonl')).map(result => [result.unit, result]));

const OLDEST = 'oldest-results-first';
const POLICIES = [OLDEST, 'block-to-low-watermark', 'placeholder-results'];
/** The notes the agent loop writes when a policy drops or replaces earlier results (as `analyze-eviction.mts` reads them). */
const EVICTED = /^(Evicted \d+ earlier tool result|Replaced the text of \d+ earlier tool result)/;
const attempted = (record: IRecord) => record.outcome === 'attempted' || record.outcome === 'blocked-by-policy';
const evicted = (record: IRecord) => (record.events ?? []).some(event => event.kind === 'note' && EVICTED.test(event.data.label ?? ''));
const editOnRecord = (record: IRecord) => (record.edits ?? []).some(edit => edit.ok === true) ? 1 : 0;
const success = (record: IRecord) => scored.get(record.unit)?.success === true ? 1 : 0;

const runs = (policy: string) => records.filter(record => record.configuration === policy && attempted(record));
const policies = POLICIES.map(policy => {
	const mine = runs(policy);
	const prompts = mine.flatMap(record => (record.requests ?? []).map(request => request.promptTokens).filter((tokens): tokens is number => typeof tokens === 'number'));
	return {
		policy,
		runs: mine.length,
		runsThatEvicted: mine.filter(evicted).length,
		editOnRecord: mine.reduce((sum, record) => sum + editOnRecord(record), 0),
		succeeded: mine.reduce((sum, record) => sum + success(record), 0),
		meanPromptTokensPerRequest: prompts.length ? prompts.reduce((sum, tokens) => sum + tokens, 0) / prompts.length : null,
		largestPromptTokens: prompts.length ? Math.max(...prompts) : null,
	};
});

// The condition, among runs that evicted: each cache-aware policy against oldest-first, paired by model and task where both evicted.
const key = (record: IRecord) => `${record.model}|${record.task}`;
const evictedBy = (policy: string) => new Map(runs(policy).filter(evicted).map(record => [key(record), record]));
const oldest = evictedBy(OLDEST);
const tooFew = policies.some(entry => entry.runsThatEvicted < 10);
const anySuccess = policies.some(entry => entry.succeeded > 0);
const conditions = POLICIES.filter(policy => policy !== OLDEST).map(policy => {
	const mine = evictedBy(policy);
	const paired = [...mine.keys()].filter(unit => oldest.has(unit)).sort();
	const successDifference = stats.pairedDifference(paired.map(unit => success(mine.get(unit)!)), paired.map(unit => success(oldest.get(unit)!)), { resamples: 1000, seed: 1 });
	const editDifference = stats.pairedDifference(paired.map(unit => editOnRecord(mine.get(unit)!)), paired.map(unit => editOnRecord(oldest.get(unit)!)), { resamples: 1000, seed: 1 });
	const verdict = tooFew ? 'not tested' : !anySuccess ? 'a floor: no run of any policy succeeded, so the condition holds only vacuously' : successDifference.low >= -0.02 ? 'holds' : 'does not hold';
	return { policy, pairedUnits: paired.length, successDifference, editOnRecordDifference: editDifference, condition: verdict };
});

const result = {
	question: 'H-9\'s condition, "at equal task success", on agentic runs that are certain to evict (PREREGISTRATION.md, Amendment 5, A5.3)',
	records: records.length,
	notAttempted: records.filter(record => !attempted(record)).length,
	policies,
	conditions,
	howItIsCounted: 'A run evicted when its record has an eviction or replacement note. The condition is decided among runs that evicted, paired by model and task where oldest-first evicted too: the success difference (policy minus oldest-first) with a bootstrap interval over the pairs, 1,000 resamples, seed 1. promptTokens is the runtime\'s prompt_tokens, which counts the whole prompt and decides nothing.',
};
fs.writeFileSync(path.join(directory, 'forced-eviction.json'), JSON.stringify(result, undefined, '\t') + '\n');
fs.writeFileSync(path.join(directory, 'outcome-H-9-condition.json'), JSON.stringify({
	question: result.question,
	outcome: conditions.map(entry => `${entry.policy}: ${entry.condition}`).join('; '),
	number: policies.map(entry => `${entry.policy}: ${entry.runsThatEvicted} of ${entry.runs} runs evicted, ${entry.succeeded} succeeded, ${entry.editOnRecord} with an edit on record`).join('; '),
	thresholds: 'Among runs that evicted, the condition holds for a cache-aware policy when its task success is not lower than oldest-first\'s by more than 2 points (lower bound of the paired difference at least -0.02). Fewer than 10 evicting runs of any policy: not tested. No success under any policy: a floor, holding only vacuously (PREREGISTRATION.md, Amendment 5, A5.3). H-9\'s own outcome is unchanged.',
	decidedFrom: ['forced-eviction.json', 'traces/records.jsonl', 'results.jsonl'],
	regenerate: `node test/onyx/lab/analyze-forced-eviction.mts docs/research/results/${path.basename(directory)}`,
}, undefined, '\t') + '\n');
for (const entry of policies) {
	console.log(`${entry.policy}: ${entry.runsThatEvicted} of ${entry.runs} runs evicted; ${entry.succeeded} succeeded; ${entry.editOnRecord} with an edit on record; mean prompt ${entry.meanPromptTokensPerRequest?.toFixed(0)} tokens, largest ${entry.largestPromptTokens}`);
}
for (const entry of conditions) {
	console.log(`  ${entry.policy} vs ${OLDEST} over ${entry.pairedUnits} paired evicting units: success ${entry.successDifference.value.toFixed(3)} [${entry.successDifference.low.toFixed(3)}, ${entry.successDifference.high.toFixed(3)}]; edits on record ${entry.editOnRecordDifference.value.toFixed(3)}: ${entry.condition}`);
}
