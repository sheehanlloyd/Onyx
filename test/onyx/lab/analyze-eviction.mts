/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The eviction study's analysis (L17, H-9).
 *
 *   node test/onyx/lab/analyze-eviction.mts docs/research/results/<date>-eviction-scripted docs/research/results/<date>-eviction-agentic
 *
 * The scripted runs (`traces/turns.jsonl`, `eviction-script.mts`) decide the
 * ratio of re-processed prompt tokens against oldest-first. The runtime
 * reports the whole prompt as evaluated whether it was cached or not (the
 * probe beside the results shows it), so re-processed tokens are estimated
 * as registered for that case: the prompt-evaluation time of a turn divided
 * by the time a token took in the same run's first turn, where nothing was
 * cached, and never more than the prompt's own tokens. The agentic campaign
 * supplies the success-rate condition and says how often a policy evicted.
 * It writes `eviction.json` and `outcome-H-9.json` beside the scripted
 * results. It needs compiled output for the seeded generator.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const [scripted, agentic] = process.argv.slice(2).map(argument => path.resolve(argument));
if (!scripted || !agentic) {
	console.error('usage: node test/onyx/lab/analyze-eviction.mts <scripted results directory> <agentic results directory>');
	process.exit(2);
}
const estimators: { seededRandom(seed: number): () => number } = await import(pathToFileURL(path.join(repoRoot, 'out', 'vs', 'workbench', 'contrib', 'onyx', 'common', 'onyxAttribution.js')).href);
const lines = <T,>(file: string): T[] => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(line => line.trim()).map(line => JSON.parse(line)) : [];
const OLDEST = 'oldest-results-first';

interface ITurn { readonly run: string; readonly model: string; readonly policy: string; readonly repetition: number; readonly turn: number; readonly promptEvalCount: number | null; readonly promptEvalMs: number | null; readonly firstTokenMs: number | null; readonly evictedCalls: number; readonly replacedResults: number; readonly estimatedPromptTokens: number }
const turns = lines<ITurn>(path.join(scripted, 'traces', 'turns.jsonl'));
const byRun = new Map<string, ITurn[]>();
for (const turn of turns) {
	byRun.set(turn.run, [...(byRun.get(turn.run) ?? []), turn]);
}
/** Re-processed tokens of each turn after the first, keyed by model, repetition and turn so that policies can be paired. */
const reprocessed = new Map<string, Map<string, number>>();
const firstToken = new Map<string, number[]>();
const evictions = new Map<string, { evictedCalls: number; replacedResults: number }>();
const unusable: string[] = [];
for (const [run, list] of byRun) {
	const ordered = [...list].sort((left, right) => left.turn - right.turn);
	const first = ordered[0];
	if (ordered.length !== 16 || !first.promptEvalCount || !first.promptEvalMs || ordered.some(turn => turn.promptEvalMs === null || turn.promptEvalCount === null)) {
		unusable.push(run);
		continue;
	}
	const msPerToken = first.promptEvalMs / first.promptEvalCount;
	const policy = first.policy;
	const table = reprocessed.get(policy) ?? new Map<string, number>();
	reprocessed.set(policy, table);
	const counted = evictions.get(policy) ?? { evictedCalls: 0, replacedResults: 0 };
	evictions.set(policy, counted);
	for (const turn of ordered.slice(1)) {
		table.set(`${turn.model}|r${turn.repetition}|t${turn.turn}`, Math.min(turn.promptEvalCount!, turn.promptEvalMs! / msPerToken));
		if (turn.firstTokenMs !== null) {
			firstToken.set(policy, [...(firstToken.get(policy) ?? []), turn.firstTokenMs]);
		}
		counted.evictedCalls += turn.evictedCalls;
		counted.replacedResults += turn.replacedResults;
	}
}
const policies = [...reprocessed.keys()];
const baseline = reprocessed.get(OLDEST);
const keys = baseline ? [...baseline.keys()].filter(key => policies.every(policy => reprocessed.get(policy)!.has(key))) : [];
const sum = (policy: string, sample: readonly string[]) => sample.reduce((total, key) => total + reprocessed.get(policy)!.get(key)!, 0);
function ratio(policy: string): { value: number; low: number; high: number } {
	const value = sum(policy, keys) / sum(OLDEST, keys);
	const random = estimators.seededRandom(1);
	const samples: number[] = [];
	for (let resample = 0; resample < 2000; resample++) {
		const drawn = keys.map(() => keys[Math.floor(random() * keys.length)]);
		samples.push(sum(policy, drawn) / sum(OLDEST, drawn));
	}
	samples.sort((left, right) => left - right);
	return { value, low: samples[Math.round((samples.length - 1) * 0.025)], high: samples[Math.round((samples.length - 1) * 0.975)] };
}
const mean = (values: readonly number[]) => values.length ? values.reduce((total, value) => total + value, 0) / values.length : null;

// --- the agentic campaign: success, and how often a policy had to evict at all ------------------------------------
interface IResult { readonly unit: string; readonly model: string; readonly configuration: string; readonly task: string; readonly outcome: string; readonly success: boolean | null }
interface IRecord { readonly unit: string; readonly configuration: string; readonly events?: readonly { readonly kind: string; readonly data: { readonly label?: string } }[] }
const results = lines<IResult>(path.join(agentic, 'results.jsonl'));
const records = lines<IRecord>(path.join(agentic, 'traces', 'records.jsonl'));
const agenticPolicies = [...new Set(results.map(result => result.configuration))];
const successOf = (policy: string) => new Map(results.filter(result => result.configuration === policy && result.outcome === 'attempted').map(result => [`${result.model}|${result.task}`, result.success === true ? 1 : 0]));
function successDifference(policy: string): { value: number; low: number; high: number; pairs: number } {
	const [mine, theirs] = [successOf(policy), successOf(OLDEST)];
	const pairs = [...mine.keys()].filter(key => theirs.has(key));
	const difference = (sample: readonly string[]) => sample.length ? sample.reduce((total, key) => total + mine.get(key)! - theirs.get(key)!, 0) / sample.length : 0;
	const random = estimators.seededRandom(1);
	const samples: number[] = [];
	for (let resample = 0; resample < 2000; resample++) {
		samples.push(difference(pairs.map(() => pairs[Math.floor(random() * pairs.length)])));
	}
	samples.sort((left, right) => left - right);
	return { value: difference(pairs), low: samples[Math.round((samples.length - 1) * 0.025)] ?? 0, high: samples[Math.round((samples.length - 1) * 0.975)] ?? 0, pairs: pairs.length };
}
const agenticRows = agenticPolicies.map(policy => {
	const mine = results.filter(result => result.configuration === policy);
	const attempted = mine.filter(result => result.outcome === 'attempted');
	const runsThatEvicted = records.filter(record => record.configuration === policy && (record.events ?? []).some(event => event.kind === 'note' && /^(Evicted \d+ earlier tool result|Replaced the text of \d+ earlier tool result)/.test(event.data.label ?? ''))).length;
	return { policy, units: mine.length, attempted: attempted.length, succeeded: attempted.filter(result => result.success === true).length, runsThatEvicted, successLessOldestFirst: policy === OLDEST ? null : successDifference(policy) };
});

const scriptedRows = policies.map(policy => ({
	policy, turns: keys.length, reprocessedTokens: Math.round(sum(policy, keys)), ratioToOldestFirst: policy === OLDEST ? null : ratio(policy),
	meanFirstTokenMs: mean(firstToken.get(policy) ?? []) === null ? null : Math.round(mean(firstToken.get(policy) ?? [])!), ...evictions.get(policy)!,
}));
const cacheAware = scriptedRows.filter(row => row.ratioToOldestFirst !== null).sort((left, right) => left.ratioToOldestFirst!.value - right.ratioToOldestFirst!.value);
const best = cacheAware[0];
const bestSuccess = best ? agenticRows.find(row => row.policy === best.policy)?.successLessOldestFirst : undefined;
const outcome = !baseline || keys.length === 0 || !best ? 'inconclusive'
	: best.ratioToOldestFirst!.value <= 0.70 && best.ratioToOldestFirst!.high < 1 && !!bestSuccess && bestSuccess.low >= -0.02 ? 'supported'
		: cacheAware.every(row => row.ratioToOldestFirst!.high >= 1) ? 'refuted' : 'inconclusive';
const adopted = outcome === 'supported' ? best.policy : null;
const result = {
	scripted: { runs: byRun.size, unusableRuns: unusable, pairedTurns: keys.length, policies: scriptedRows, estimate: 'prompt-evaluation milliseconds of the turn over the milliseconds a token took in the same run\'s first turn, never more than the prompt\'s own tokens (the fallback of PREREGISTRATION.md, Amendment 3)' },
	agentic: { policies: agenticRows },
	bestCacheAwarePolicy: best?.policy ?? null,
	outcome,
	adoptedAsAnOption: adopted,
};
fs.writeFileSync(path.join(scripted, 'eviction.json'), JSON.stringify(result, undefined, '\t') + '\n');
const show = (row: typeof scriptedRows[number]) => `${row.policy}: ${row.reprocessedTokens} tokens${row.ratioToOldestFirst ? `, ratio ${row.ratioToOldestFirst.value.toFixed(2)} [${row.ratioToOldestFirst.low.toFixed(2)}, ${row.ratioToOldestFirst.high.toFixed(2)}]` : ''}, first token ${row.meanFirstTokenMs} ms`;
for (const row of scriptedRows) {
	console.log(show(row));
}
for (const row of agenticRows) {
	console.log(`agentic ${row.policy}: ${row.succeeded} of ${row.attempted} succeeded; ${row.runsThatEvicted} runs evicted`);
}
fs.writeFileSync(path.join(scripted, 'outcome-H-9.json'), JSON.stringify({
	hypothesis: 'H-9',
	statement: 'A cache-aware eviction policy re-processes fewer prompt tokens per turn than oldest-first at equal task success',
	outcome,
	number: scriptedRows.filter(row => row.ratioToOldestFirst).map(row => `${row.policy}: ${row.ratioToOldestFirst!.value.toFixed(2)} of oldest-first's re-processed tokens [${row.ratioToOldestFirst!.low.toFixed(2)}, ${row.ratioToOldestFirst!.high.toFixed(2)}]`).join('; ') + `; agentic success ${agenticRows.map(row => `${row.policy} ${row.succeeded}/${row.attempted}`).join(', ')}`,
	adopted: adopted === null ? 'no policy is adopted; the product keeps oldest-results-first' : `${adopted} stays available as a harness option; the product's default is unchanged`,
	thresholds: 'Supported: the best cache-aware policy\'s ratio is at most 0.70 with an interval excluding 1.0, and its success rate is not lower by more than 2 points (interval). Refuted: every cache-aware policy\'s ratio interval includes or exceeds 1.0. Inconclusive otherwise (PREREGISTRATION.md, H-9, Amendments 2 and 3).',
	decidedFrom: ['eviction.json', 'traces/turns.jsonl', `../${path.basename(agentic)}/results.jsonl`, `../${path.basename(agentic)}/traces/records.jsonl`],
	regenerate: `node test/onyx/lab/analyze-eviction.mts docs/research/results/${path.basename(scripted)} docs/research/results/${path.basename(agentic)}`,
}, undefined, '\t') + '\n');
console.log(`H-9: ${outcome}`);
