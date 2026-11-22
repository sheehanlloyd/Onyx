/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The Module 4 gate boxes that are about committed evidence and documents,
 * not behaviour.
 *
 *   node --test test/onyx/checks/module4-gate.test.mts
 */

import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkResultsDirectory } from '../lab/manifest.mts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const results = (name: string) => path.join(repoRoot, 'docs', 'research', 'results', name);
const read = <T,>(file: string): T => JSON.parse(fs.readFileSync(file, 'utf8'));
const lines = <T,>(file: string): T[] => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));

interface ICampaignFile { readonly complete: boolean; readonly plannedUnits: number; readonly finishedUnits: number; readonly machineSeconds: number; readonly firstEstimate: { readonly seconds: number | null }; readonly repository: { readonly unchanged: boolean }; readonly sessions: readonly { readonly evictions: readonly { readonly left?: readonly string[] }[]; readonly conditionsAtStart: { readonly loadAverage: readonly number[] } }[] }

/** What every committed campaign has to show: a valid results directory, every planned unit recorded once, the repository unchanged, one model resident, the time it took beside the estimate. */
function campaignFacts(name: string) {
	const directory = results(name);
	const campaign = read<ICampaignFile>(path.join(directory, 'campaign.json'));
	const records = lines<{ unit: string }>(path.join(directory, 'traces', 'records.jsonl'));
	const scored = lines<{ unit: string }>(path.join(directory, 'results.jsonl'));
	return {
		directory: checkResultsDirectory(directory).errors,
		complete: campaign.complete,
		everyUnitOnce: records.length === campaign.plannedUnits && new Set(records.map(record => record.unit)).size === campaign.plannedUnits && scored.length === campaign.plannedUnits,
		repositoryUnchanged: campaign.repository.unchanged,
		everyEvictionLeftNothing: campaign.sessions.every(session => session.evictions.every(eviction => (eviction.left ?? []).length === 0)),
		timeRecorded: campaign.machineSeconds > 0 && campaign.firstEstimate.seconds !== null,
		loadRecorded: campaign.sessions.every(session => session.conditionsAtStart.loadAverage.length === 3),
		noHomeDirectory: !/\/Users\/|\/home\//.test(fs.readFileSync(path.join(directory, 'traces', 'records.jsonl'), 'utf8')),
	};
}
const SOUND = { directory: [], complete: true, everyUnitOnce: true, repositoryUnchanged: true, everyEvictionLeftNothing: true, timeRecorded: true, loadRecorded: true, noHomeDirectory: true };

test('Module 4 gate (L9): one real-model campaign of each tier completed on the reference machine and its results are committed', () => {
	assert.deepStrictEqual({ tierS: campaignFacts('2026-11-22-engine-tier-s'), tierA: campaignFacts('2026-11-22-engine-tier-a') }, { tierS: SOUND, tierA: SOUND });
});

test('Module 4 gate (L10): this repository\'s task set is committed as commit ids and hashes with its manifest, and the executable oracle\'s state is recorded with the probe output', () => {
	const directory = results('2026-11-22-task-set');
	const text = fs.readFileSync(path.join(directory, 'tasks.json'), 'utf8');
	const set = read<{ hash: string; counts: { total: number; byHoldout: Record<string, number>; bySource: Record<string, number> }; tasks: { commit: string; file: string; beforeHash: string; afterHash: string; holdout: string }[] }>(path.join(directory, 'tasks.json'));
	const manifest = read<{ taskSet: { hash: string; count: number } }>(path.join(directory, 'manifest.json'));
	const digest = (revision: string, file: string) => crypto.createHash('sha256').update(execFileSync('git', ['-C', repoRoot, 'show', `${revision}:${file}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })).digest('hex');
	// The whole set is checked by describe-task-set.mts when it is written; three tasks are checked again here, against this checkout.
	const sample = [set.tasks[0], set.tasks[Math.floor(set.tasks.length / 2)], set.tasks.at(-1)!];
	const support = fs.readFileSync(path.join(repoRoot, 'docs', 'SUPPORT.md'), 'utf8');
	assert.deepStrictEqual({
		directory: checkResultsDirectory(directory).errors,
		manifestNamesTheSet: manifest.taskSet.hash === set.hash && manifest.taskSet.count === set.tasks.length,
		enoughTasks: set.tasks.length >= 40,
		everyTaskHeldOut: set.counts.byHoldout['held-out'] === set.tasks.length && set.tasks.every(task => task.holdout === 'held-out'),
		// Keys and hashes only: no line of the file is longer than a path and two digests need.
		idsAndHashesOnly: [...new Set(set.tasks.flatMap(task => Object.keys(task)))].sort(),
		noLongLine: text.split('\n').every(line => line.length < 400),
		sampleMatchesTheRepository: sample.map(task => digest(`${task.commit}~1`, task.file) === task.beforeHash && digest(task.commit, task.file) === task.afterHash),
		oracleState: /^\| L10 executable oracle \| (?<state>included|deferred) \|/m.exec(support)?.groups?.state,
		probeOutputShown: /network-inside-sandbox: exit 1, observed false/.test(support) && /sandbox: established/.test(support),
	}, {
		directory: [],
		manifestNamesTheSet: true,
		enoughTasks: true,
		everyTaskHeldOut: true,
		idsAndHashesOnly: ['afterHash', 'authoredAt', 'beforeChars', 'beforeHash', 'changedLines', 'commit', 'file', 'holdout', 'id', 'kind', 'source', 'testFile'],
		noLongLine: true,
		sampleMatchesTheRepository: [true, true, true],
		oracleState: 'included',
		probeOutputShown: true,
	});
});
