/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The determinism study's analysis (L15, H-6): reads a tier A campaign that
 * ran every unit several times and says how many repetitions are the same
 * trajectory as their unit's first, where the others first differ, and
 * whether that was the runtime or the harness.
 *
 *   node test/onyx/lab/analyze-determinism.mts docs/research/results/<date>-<name> [--editing-units]
 *
 * `--editing-units` (PREREGISTRATION.md, Amendment 5, A5.2): the decision is on the units whose first
 * repetition made an edit call, and is written as `outcome-H-6-editing.json`; H-6's own outcome file is
 * not written, because H-6 is decided by its own campaign. Fewer than 10 such units is inconclusive.
 *
 * It writes `determinism.json` beside the manifest and, when the manifest
 * names H-6, `outcome-H-6.json` by the registered thresholds. The measure
 * is `common/onyxDeterminism.ts`; it needs compiled output. Exit 1 when a
 * divergence is the harness's doing: the registration says that invalidates
 * the study until it is fixed.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const out = (relative: string) => pathToFileURL(path.join(repoRoot, 'out', relative)).href;
const directory = process.argv[2] && !process.argv[2].startsWith('--') ? path.resolve(process.argv[2]) : undefined;
const editingUnitsOnly = process.argv.includes('--editing-units');
if (!directory) {
	console.error('usage: node test/onyx/lab/analyze-determinism.mts <results directory>');
	process.exit(2);
}

interface IInterval { readonly value: number; readonly low: number; readonly high: number }
interface ITurn { readonly requestDigest: string; readonly responseText: string; readonly toolCalls: readonly { name: string; argumentsDigest: string; resultDigest?: string; ok?: boolean }[] }
interface ITrajectory { readonly turns: readonly ITurn[]; readonly outcome: string; readonly seedHonoured: boolean | 'unknown' }
interface IGroup { readonly group: string; readonly units: number; readonly comparisons: number; readonly identical: number; readonly unitsAllIdentical: number; readonly firstDivergingTurn: readonly number[]; readonly bySource: Record<string, number>; readonly divergedWithADifferentOutcome: number; readonly seedNotKnownHonoured: number; readonly harnessDivergences: readonly object[] }
const measure: { measureDeterminism(units: readonly { key: string; group: string; repetitions: readonly ITrajectory[] }[]): IGroup[]; decideH6(share: IInterval): string } = await import(out('vs/workbench/contrib/onyx/common/onyxDeterminism.js'));
const estimators: { wilsonInterval(successes: number, trials: number): IInterval } = await import(out('vs/workbench/contrib/onyx/common/onyxAttribution.js'));

interface IEvent { readonly kind: string; readonly data: ITurn & { readonly seed?: { readonly honoured: boolean | 'unknown' } } }
interface IRecord { readonly unit: string; readonly model: string; readonly configuration: string; readonly task: string; readonly seed: number; readonly repetition: number; readonly outcome: string; readonly events?: readonly IEvent[]; readonly edits?: readonly unknown[] }
const lines = <T,>(file: string): T[] => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(line => line.trim()).map(line => JSON.parse(line)) : [];
const records = lines<IRecord>(path.join(directory, 'traces', 'records.jsonl'));
const scored = new Map(lines<{ unit: string; outcome: string; score: number | null; success: boolean | null }>(path.join(directory, 'results.jsonl')).map(result => [result.unit, result]));
const manifest: { hypotheses?: string[] } = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));

const units = new Map<string, { key: string; group: string; repetitions: { repetition: number; trajectory: ITrajectory }[] }>();
/** Units whose first repetition made an edit call: an entry in `edits`, or an editFile call in a turn (Amendment 5, A5.2). */
const editingUnits = new Set<string>();
let notServed = 0;
for (const record of records) {
	if (record.outcome === 'could-not-serve') {
		notServed++;
		continue;
	}
	const turns = (record.events ?? []).filter(event => event.kind === 'traceTurn').map(event => event.data);
	const honoured = turns.map(turn => turn.seed?.honoured ?? 'unknown');
	const result = scored.get(record.unit);
	const key = [record.model, record.configuration, record.task, `s${record.seed}`].join('|');
	if (record.repetition === 1 && ((record.edits?.length ?? 0) > 0 || turns.some(turn => turn.toolCalls.some(call => call.name === 'editFile')))) {
		editingUnits.add(key);
	}
	const unit = units.get(key) ?? { key, group: record.model, repetitions: [] };
	units.set(key, unit);
	unit.repetitions.push({
		repetition: record.repetition,
		trajectory: {
			turns: turns.map(turn => ({ requestDigest: turn.requestDigest, responseText: turn.responseText, toolCalls: turn.toolCalls })),
			outcome: `${record.outcome}|${result?.success ?? null}|${result?.score ?? null}`,
			seedHonoured: honoured.length > 0 && honoured.every(value => value === true) ? true : honoured.some(value => value === false) ? false : 'unknown',
		},
	});
}
const ordered = [...units.values()].map(unit => ({ key: unit.key, group: unit.group, repetitions: unit.repetitions.sort((a, b) => a.repetition - b.repetition).map(entry => entry.trajectory) }));
const groups = measure.measureDeterminism(ordered);
const pooled = { comparisons: groups.reduce((sum, group) => sum + group.comparisons, 0), identical: groups.reduce((sum, group) => sum + group.identical, 0) };
const share = estimators.wilsonInterval(pooled.identical, pooled.comparisons);
const harness = groups.flatMap(group => group.harnessDivergences);
const turnsPerRun = ordered.flatMap(unit => unit.repetitions.map(repetition => repetition.turns.length));
const result = {
	records: records.length,
	recordsTheRuntimeCouldNotServe: notServed,
	units: ordered.length,
	multiTurnRuns: turnsPerRun.filter(count => count > 1).length,
	runs: turnsPerRun.length,
	pooled: { ...pooled, identicalShare: share },
	byModel: groups.map(group => ({ ...group, identicalShare: estimators.wilsonInterval(group.identical, group.comparisons) })),
	harnessDivergences: harness,
	howItIsCounted: 'A comparison is one repetition after the first against the first repetition of the same model, configuration, task and seed. The intervals are Wilson intervals on the comparisons, which are not independent within a task: unitsAllIdentical is the count that does not depend on that.',
};
fs.writeFileSync(path.join(directory, 'determinism.json'), JSON.stringify(result, undefined, '\t') + '\n');
const percent = (value: number) => `${(value * 100).toFixed(1)}%`;
console.log(`${pooled.identical} of ${pooled.comparisons} repetitions are the same trajectory as their unit's first (${percent(share.value)}, ${percent(share.low)} to ${percent(share.high)}); ${harness.length} divergences are the harness's`);
for (const group of groups) {
	console.log(`  ${group.group}: ${group.identical} of ${group.comparisons}; first diverging turn ${JSON.stringify(group.firstDivergingTurn)}; ${JSON.stringify(group.bySource)}; outcome changed in ${group.divergedWithADifferentOutcome}`);
}
if (editingUnitsOnly) {
	const editing = measure.measureDeterminism(ordered.filter(unit => editingUnits.has(unit.key)));
	const counts = { units: editingUnits.size, comparisons: editing.reduce((sum, group) => sum + group.comparisons, 0), identical: editing.reduce((sum, group) => sum + group.identical, 0) };
	const editingShare = estimators.wilsonInterval(counts.identical, counts.comparisons);
	const editingHarness = editing.flatMap(group => group.harnessDivergences);
	const outcome = harness.length > 0 ? 'inconclusive' : counts.units < 10 || counts.comparisons === 0 ? 'inconclusive' : measure.decideH6(editingShare);
	const document = {
		question: 'H-6 on trajectories that edit (PREREGISTRATION.md, Amendment 5, A5.2)',
		outcome,
		number: `${counts.identical} of ${counts.comparisons} repetitions of the ${counts.units} editing units identical to the first (${percent(editingShare.value)}, 95% interval ${percent(editingShare.low)} to ${percent(editingShare.high)}); over all ${pooled.comparisons} comparisons ${pooled.identical} (${percent(share.value)}), which decides nothing`,
		editingUnits: counts,
		editingShare,
		byModel: editing.map(group => ({ group: group.group, units: group.units, comparisons: group.comparisons, identical: group.identical, unitsAllIdentical: group.unitsAllIdentical, firstDivergingTurn: group.firstDivergingTurn, bySource: group.bySource, divergedWithADifferentOutcome: group.divergedWithADifferentOutcome })),
		allComparisons: { ...pooled, identicalShare: share },
		thresholds: 'H-6\'s registered thresholds on the comparisons of the editing units (units whose first repetition made an edit call): supported at an identical share of at least 90% with a Wilson lower bound of at least 80%; refuted when the upper bound is below 90%; inconclusive otherwise, and with fewer than 10 editing units. A divergence that is the harness\'s invalidates it (PREREGISTRATION.md, Amendments 3 and 5).',
		...(harness.length > 0 ? { invalidatedBy: `${harness.length} divergences that are the harness's doing (${editingHarness.length} in editing units)` } : {}),
		decidedFrom: ['determinism.json', 'traces/records.jsonl', 'results.jsonl'],
		regenerate: `node test/onyx/lab/analyze-determinism.mts docs/research/results/${path.basename(directory)} --editing-units`,
	};
	fs.writeFileSync(path.join(directory, 'outcome-H-6-editing.json'), JSON.stringify(document, undefined, '\t') + '\n');
	console.log(`H-6 on editing trajectories (Amendment 5): ${outcome}; ${document.number}`);
} else if (manifest.hypotheses?.includes('H-6')) {
	const outcome = harness.length > 0 ? 'inconclusive' : pooled.comparisons === 0 ? 'inconclusive' : measure.decideH6(share);
	fs.writeFileSync(path.join(directory, 'outcome-H-6.json'), JSON.stringify({
		hypothesis: 'H-6',
		statement: 'At temperature 0 with a fixed seed on one machine, at least 90% of multi-turn trajectories repeat exactly',
		outcome,
		number: `${pooled.identical} of ${pooled.comparisons} repetitions identical to the first (${percent(share.value)}, 95% interval ${percent(share.low)} to ${percent(share.high)})`,
		thresholds: 'Supported: identical share at least 90% with a lower bound of at least 80%. Refuted: upper bound below 90%. Inconclusive otherwise (PREREGISTRATION.md, H-6 and its amendments).',
		...(harness.length > 0 ? { invalidatedBy: `${harness.length} divergences that are the harness's doing` } : {}),
		decidedFrom: ['determinism.json', 'traces/records.jsonl', 'results.jsonl'],
		regenerate: `node test/onyx/lab/analyze-determinism.mts docs/research/results/${path.basename(directory)}`,
	}, undefined, '\t') + '\n');
	console.log(`H-6: ${outcome}`);
}
process.exit(harness.length > 0 ? 1 : 0);
