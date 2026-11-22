/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The lab's campaign plan (L9). A campaign is a list of units of work: one
 * model answering one task under one harness configuration with one seed.
 * Everything here is pure, so that the launcher (plain Node) and the engine
 * inside the application plan, resume and count the same way, and so that
 * the rules can be tested without a model, a window or git:
 *
 * - one model is resident at a time: the plan is ordered by model, and the
 *   engine evicts at every change of model;
 * - a campaign resumes at the first unit that has no result;
 * - a unit the runtime could not serve is not a failed attempt, and a task
 *   that asked for a command is blocked by policy, not failed by the model
 *   (DEC-10: a campaign never runs a model-authored command).
 */

import { applyEditBlocks, parseInlineEdits } from './onyxInlineEdit.js';
import { ONYX_BENCH_METRIC, scoreBenchAttempt, scoreBenchProposal } from './onyxRepoBench.js';

/** Tier S: one request, one reply, from plain Node. Tier A: the agent loop inside the application. */
export type OnyxLabTier = 'S' | 'A';

/** A task as a campaign names it: where it is in history, never its content. */
export interface IOnyxLabTask {
	readonly id: string;
	/** The commit whose change the model is asked to reproduce. The task runs on its parent. */
	readonly commit: string;
	/** The one file the commit changed, relative to the repository. */
	readonly file: string;
}

export interface IOnyxLabCampaignSpec {
	readonly tier: OnyxLabTier;
	/** Model ids as the runtime names them. */
	readonly models: readonly string[];
	/** Names of the manifest's harness configurations. */
	readonly configurations: readonly string[];
	readonly tasks: readonly IOnyxLabTask[];
	readonly seeds: readonly number[];
	readonly repetitions: number;
}

export interface IOnyxLabUnit {
	/** Stable for the same model, configuration, task, seed and repetition, whatever else the campaign holds. */
	readonly id: string;
	readonly model: string;
	readonly configuration: string;
	readonly task: IOnyxLabTask;
	readonly seed: number;
	readonly repetition: number;
}

export function labUnitId(model: string, configuration: string, task: string, seed: number, repetition: number): string {
	return `${model}|${configuration}|${task}|s${seed}|r${repetition}`;
}

/**
 * Every unit of a campaign, in the order it runs: all of one model's units
 * before the next model's, so that one model is resident at a time. Within
 * a model the order is task, then configuration, seed and repetition: a
 * task's units run together, so the worktree is checked out once a task.
 */
export function planLabCampaign(spec: IOnyxLabCampaignSpec): IOnyxLabUnit[] {
	const units: IOnyxLabUnit[] = [];
	for (const model of spec.models) {
		for (const task of spec.tasks) {
			for (const configuration of spec.configurations) {
				for (const seed of spec.seeds) {
					for (let repetition = 1; repetition <= spec.repetitions; repetition++) {
						units.push({ id: labUnitId(model, configuration, task.id, seed, repetition), model, configuration, task, seed, repetition });
					}
				}
			}
		}
	}
	return units;
}

/** What is left of a plan, in order, given the units that have a result. */
export function remainingLabUnits(plan: readonly IOnyxLabUnit[], finished: ReadonlySet<string>): IOnyxLabUnit[] {
	return plan.filter(unit => !finished.has(unit.id));
}

/**
 * How a unit ended.
 * - `attempted`: the model answered and its answer was scored, whatever the score.
 * - `could-not-serve`: the runtime gave no answer (the model did not load, the request was refused). Not a score.
 * - `blocked-by-policy`: the run asked for a command, which a campaign never runs, and proposed no edit.
 * - `cancelled`: the campaign was stopped while the unit ran.
 */
export type OnyxLabOutcome = 'attempted' | 'could-not-serve' | 'blocked-by-policy' | 'cancelled';

export interface IOnyxLabUnitFacts {
	readonly cancelled: boolean;
	/** Whether the runtime produced any reply for the unit. */
	readonly served: boolean;
	/** Commands the model asked for, each denied by the campaign. */
	readonly deniedCommands: number;
	/** Whether the run left a proposed edit. */
	readonly proposedAnEdit: boolean;
}

export function classifyLabUnit(facts: IOnyxLabUnitFacts): OnyxLabOutcome {
	if (facts.cancelled) {
		return 'cancelled';
	}
	if (!facts.served) {
		return 'could-not-serve';
	}
	if (facts.deniedCommands > 0 && !facts.proposedAnEdit) {
		return 'blocked-by-policy';
	}
	return 'attempted';
}

/** One edit a run asked to stage, as it was sent, and what became of it. */
export interface IOnyxLabEditAttempt {
	readonly path: string;
	readonly protocol: 'search-replace' | 'constrained-anchors';
	readonly blocks: readonly { readonly search: string; readonly replace: string }[];
	readonly anchors?: { readonly start: string; readonly end: string };
	readonly ok: boolean;
	readonly error?: string;
	/** For each block: `grounded`, `ungrounded`, `unknown` or `not-applicable` (L6). */
	readonly grounding: readonly string[];
}

/** What the runtime counted for one request of a unit, where it did. */
export interface IOnyxLabRequestCount {
	readonly promptTokens: number | null;
	readonly completionTokens: number | null;
	readonly firstTokenMs: number | null;
	readonly tokensPerSecond: number | null;
}

/**
 * One line of a campaign's records file: what a unit did, unscored. The
 * score is computed from it (`scoreLabRecord`), so that every published
 * number can be computed again from what is committed.
 */
export interface IOnyxLabUnitRecord {
	readonly unit: string;
	readonly model: string;
	readonly configuration: string;
	readonly task: string;
	readonly seed: number;
	readonly repetition: number;
	readonly tier: OnyxLabTier;
	readonly outcome: OnyxLabOutcome;
	/** Tier S: the model's reply. Tier A: the task's file as the run proposed it. Null when there is neither. */
	readonly reply: string | null;
	/** Tier A: every edit the run asked to stage. */
	readonly edits: readonly IOnyxLabEditAttempt[];
	/** Tier A: the run's journal without its prompt snapshots: each model turn's reply, the tool calls, the approvals. */
	readonly events: readonly { readonly t: number; readonly kind: string; readonly data: unknown }[];
	readonly requests: readonly IOnyxLabRequestCount[];
	/** The hash of the harness configuration the unit ran under, from its trace; null where no run began. */
	readonly harnessHash: string | null;
	readonly deniedCommands: number;
	readonly durationMs: number;
	/** The unit was ended by the campaign's time limit for one unit. */
	readonly timedOut?: boolean;
	readonly finishReason?: string | null;
	readonly error?: string;
}

/**
 * Reads a records file: one JSON object a line. A campaign that was killed
 * may have left half a line at the end; that line is dropped and its unit
 * runs again. A cancelled unit is not finished either.
 */
export function parseLabRecords(text: string): IOnyxLabUnitRecord[] {
	const records: IOnyxLabUnitRecord[] = [];
	for (const line of text.split('\n')) {
		if (!line.trim()) {
			continue;
		}
		try {
			const parsed: IOnyxLabUnitRecord = JSON.parse(line);
			if (typeof parsed.unit === 'string' && typeof parsed.outcome === 'string' && parsed.outcome !== 'cancelled') {
				records.push(parsed);
			}
		} catch {
			// half a line: the unit it belonged to is not finished
		}
	}
	return records;
}

/** A unit with its score. */
export interface IOnyxLabResult {
	readonly unit: string;
	readonly model: string;
	readonly configuration: string;
	readonly task: string;
	readonly seed: number;
	readonly repetition: number;
	readonly outcome: OnyxLabOutcome;
	/** 0..1 under `metric`; null unless the unit was attempted. */
	readonly score: number | null;
	/** Whether the proposal's changed lines are exactly the author's; null unless attempted. */
	readonly success: boolean | null;
	readonly metric: string | null;
	readonly reason: string;
	readonly removedLinesTheAuthorKept: number;
	readonly deniedCommands: number;
	readonly durationMs: number;
	readonly harnessHash: string | null;
}

/**
 * Scores a record against the task: the file before the commit and the file
 * as the author left it. Only an attempted unit has a score; one the
 * runtime could not serve, or that policy blocked, has none and is in no
 * mean.
 */
export function scoreLabRecord(record: IOnyxLabUnitRecord, before: string, authorAfter: string): IOnyxLabResult {
	const base = { unit: record.unit, model: record.model, configuration: record.configuration, task: record.task, seed: record.seed, repetition: record.repetition, outcome: record.outcome, deniedCommands: record.deniedCommands, durationMs: record.durationMs, harnessHash: record.harnessHash };
	if (record.outcome !== 'attempted') {
		const reason = record.outcome === 'could-not-serve' ? `the runtime could not serve this unit${record.error ? `: ${record.error}` : ''}` : record.outcome === 'blocked-by-policy' ? 'the run asked for a command, which a campaign does not run, and proposed no edit' : 'the campaign was stopped';
		return { ...base, score: null, success: null, metric: null, reason, removedLinesTheAuthorKept: 0 };
	}
	if (record.reply === null) {
		return { ...base, score: 0, success: false, metric: ONYX_BENCH_METRIC, reason: record.timedOut ? 'the unit ran out of time and proposed no edit' : 'the run proposed no edit to the file', removedLinesTheAuthorKept: 0 };
	}
	const scored = record.tier === 'S' ? scoreBenchAttempt(before, authorAfter, record.reply) : scoreBenchProposal(before, authorAfter, record.reply);
	let proposed: string | undefined = record.reply;
	if (record.tier === 'S') {
		const parsed = parseInlineEdits(record.reply);
		const applied = parsed.kind === 'blocks' ? applyEditBlocks(before, parsed.blocks) : undefined;
		proposed = parsed.kind === 'rewrite' ? parsed.text : applied && applied.appliedCount > 0 ? applied.text : undefined;
	}
	return {
		...base, score: scored.score, success: proposed !== undefined && labTaskSucceeded(before, authorAfter, proposed), metric: scored.metric ?? ONYX_BENCH_METRIC,
		reason: scored.reason, removedLinesTheAuthorKept: scored.preservation?.removedLinesTheAuthorKept ?? 0,
	};
}

/** One unit of a work order: what the engine inside the application needs to run it. */
export interface IOnyxLabOrderUnit {
	readonly id: string;
	/** The campaign manifest's name, for the trace. */
	readonly manifest: string;
	readonly model: string;
	readonly configuration: { readonly name: string; readonly configuration: unknown };
	readonly task: IOnyxLabTask;
	readonly seed: number;
	readonly repetition: number;
	readonly temperature: number;
	/** What the model is asked to do. Built by the launcher from the commit; never committed. */
	readonly instruction: string;
}

/** What the launcher hands the application (tier A): where to work, where to write, and the units to run. */
export interface IOnyxLabWorkOrder {
	readonly worktree: string;
	readonly recordsPath: string;
	readonly statusPath: string;
	/** The launcher asks the engine to stop by creating this file. */
	readonly cancelPath: string;
	/** The launcher rewrites this file every few seconds. When it goes stale the launcher is gone, and the engine stops. */
	readonly heartbeatPath: string;
	readonly baseUrl: string;
	readonly unitTimeoutMs: number;
	readonly units: readonly IOnyxLabOrderUnit[];
	/**
	 * In place of units: run the product's own command, "Measure Models for
	 * This Repository" (L11), on these models, with its prompts answered in
	 * advance, and save its scorecard into the worktree.
	 */
	readonly measure?: { readonly modelIds: readonly string[]; readonly datasheets: boolean; readonly taskCount?: number };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Checks a work order field by field. One that is not whole is not run at all. */
export function parseLabWorkOrder(text: string | undefined): { readonly ok: true; readonly order: IOnyxLabWorkOrder } | { readonly ok: false; readonly error: string } {
	if (text === undefined) {
		return { ok: false, error: 'the work order could not be read' };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return { ok: false, error: 'the work order is not JSON' };
	}
	if (!isRecord(parsed)) {
		return { ok: false, error: 'the work order is not an object' };
	}
	for (const field of ['worktree', 'recordsPath', 'statusPath', 'cancelPath', 'heartbeatPath', 'baseUrl']) {
		if (typeof parsed[field] !== 'string' || !parsed[field]) {
			return { ok: false, error: `the work order has no ${field}` };
		}
	}
	if (typeof parsed.unitTimeoutMs !== 'number' || !(parsed.unitTimeoutMs > 0) || !Array.isArray(parsed.units)) {
		return { ok: false, error: 'the work order has no unit time limit or no units' };
	}
	const units: IOnyxLabOrderUnit[] = [];
	for (const unit of parsed.units) {
		const task = isRecord(unit) ? unit.task : undefined;
		const configuration = isRecord(unit) ? unit.configuration : undefined;
		if (!isRecord(unit) || !isRecord(task) || !isRecord(configuration)
			|| typeof unit.id !== 'string' || typeof unit.manifest !== 'string' || typeof unit.model !== 'string' || typeof unit.instruction !== 'string'
			|| typeof unit.seed !== 'number' || typeof unit.repetition !== 'number' || typeof unit.temperature !== 'number'
			|| typeof configuration.name !== 'string'
			|| typeof task.id !== 'string' || typeof task.commit !== 'string' || !/^[0-9a-f]{7,40}$/.test(task.commit) || typeof task.file !== 'string') {
			return { ok: false, error: 'the work order has a unit that is not whole' };
		}
		units.push({
			id: unit.id, manifest: unit.manifest, model: unit.model, instruction: unit.instruction, seed: unit.seed, repetition: unit.repetition, temperature: unit.temperature,
			configuration: { name: configuration.name, configuration: configuration.configuration ?? {} }, task: { id: task.id, commit: task.commit, file: task.file },
		});
	}
	let measure: IOnyxLabWorkOrder['measure'];
	if (parsed.measure !== undefined) {
		const asked = parsed.measure;
		if (!isRecord(asked) || !Array.isArray(asked.modelIds) || asked.modelIds.length === 0 || !asked.modelIds.every(id => typeof id === 'string' && id.length > 0) || (asked.taskCount !== undefined && !(typeof asked.taskCount === 'number' && Number.isInteger(asked.taskCount) && asked.taskCount > 0))) {
			return { ok: false, error: 'the work order asks for a measurement that names no models' };
		}
		measure = { modelIds: asked.modelIds.map(String), datasheets: asked.datasheets !== false, ...(typeof asked.taskCount === 'number' ? { taskCount: asked.taskCount } : {}) };
	}
	return { ok: true, order: { worktree: String(parsed.worktree), recordsPath: String(parsed.recordsPath), statusPath: String(parsed.statusPath), cancelPath: String(parsed.cancelPath), heartbeatPath: String(parsed.heartbeatPath), baseUrl: String(parsed.baseUrl), unitTimeoutMs: parsed.unitTimeoutMs, units, ...(measure ? { measure } : {}) } };
}

/**
 * What a tier A unit asks the agent to do: the task's instruction, the file
 * it is about, and what is expected back. The last sentence is there
 * because without it the pinned models answered in prose, or asked the
 * user for the text to change (L9's first campaign): a campaign has no
 * user to answer, so a task says that an edit is what is wanted.
 */
export function labAgentInstruction(file: string, instruction: string): string {
	return `Make this change to the file ${file}:\n\n${instruction}\n\nRead the file first, then propose the change with the editFile tool. Do not ask for more information.`;
}

export interface IOnyxLabSummaryRow {
	readonly model: string;
	readonly configuration: string;
	readonly units: number;
	readonly attempted: number;
	readonly couldNotServe: number;
	readonly blockedByPolicy: number;
	readonly succeeded: number;
	/** Mean score over the attempted units; null when none was attempted. */
	readonly meanScore: number | null;
	readonly deniedCommands: number;
}

/** Counts by model and configuration. A unit that could not be served is in no mean. */
export function summarizeLabResults(results: readonly IOnyxLabResult[]): IOnyxLabSummaryRow[] {
	const groups = new Map<string, IOnyxLabResult[]>();
	for (const result of results) {
		const key = `${result.model}\u0000${result.configuration}`;
		const group = groups.get(key);
		if (group) {
			group.push(result);
		} else {
			groups.set(key, [result]);
		}
	}
	return [...groups.values()].map(group => {
		const attempted = group.filter(result => result.outcome === 'attempted');
		const total = attempted.reduce((sum, result) => sum + (result.score ?? 0), 0);
		return {
			model: group[0].model,
			configuration: group[0].configuration,
			units: group.length,
			attempted: attempted.length,
			couldNotServe: group.filter(result => result.outcome === 'could-not-serve').length,
			blockedByPolicy: group.filter(result => result.outcome === 'blocked-by-policy').length,
			succeeded: attempted.filter(result => result.success === true).length,
			meanScore: attempted.length ? Math.round(total / attempted.length * 1000) / 1000 : null,
			deniedCommands: group.reduce((sum, result) => sum + result.deniedCommands, 0),
		};
	}).sort((a, b) => a.model.localeCompare(b.model) || a.configuration.localeCompare(b.configuration));
}

/** What a model was measured to do, as far as an estimate needs it (its datasheet, L5). */
export interface IOnyxLabSpeed {
	readonly tokensPerSecond: number;
}

/** The size of one unit the estimate assumes. */
export interface IOnyxLabUnitShape {
	/** Model turns a unit takes. One for tier S. */
	readonly turns: number;
	/** Tokens generated a turn. */
	readonly outputTokens: number;
	/** Prompt tokens a turn, read at `promptSpeedFactor` times the generation speed. */
	readonly promptTokens: number;
	readonly promptSpeedFactor: number;
	/** Seconds a unit takes besides the model: checkout, index, tools. */
	readonly overheadSeconds: number;
}

export const ONYX_LAB_SHAPE: Readonly<Record<OnyxLabTier, IOnyxLabUnitShape>> = {
	S: { turns: 1, outputTokens: 350, promptTokens: 2500, promptSpeedFactor: 10, overheadSeconds: 0.5 },
	A: { turns: 4, outputTokens: 220, promptTokens: 4500, promptSpeedFactor: 10, overheadSeconds: 6 },
};

export interface IOnyxLabEstimate {
	/** Null when no model of the plan has a measured speed. */
	readonly seconds: number | null;
	/** Models of the plan with no measured speed: their units are not in `seconds`. */
	readonly unmeasuredModels: readonly string[];
	readonly units: number;
}

/**
 * How long a plan will take, from each model's measured generation speed.
 * It is an estimate from a datasheet, shown before a campaign starts and
 * recorded beside what the campaign then took; a model that was never
 * measured is named instead of guessed.
 */
export function estimateLabDuration(plan: readonly IOnyxLabUnit[], speeds: Readonly<Record<string, IOnyxLabSpeed | undefined>>, shape: IOnyxLabUnitShape): IOnyxLabEstimate {
	let seconds = 0;
	let measured = 0;
	const unmeasured = new Set<string>();
	for (const unit of plan) {
		const speed = speeds[unit.model]?.tokensPerSecond;
		if (!speed || speed <= 0) {
			unmeasured.add(unit.model);
			continue;
		}
		measured++;
		seconds += shape.overheadSeconds + shape.turns * (shape.outputTokens / speed + shape.promptTokens / (speed * shape.promptSpeedFactor));
	}
	return { seconds: measured ? Math.round(seconds) : null, unmeasuredModels: [...unmeasured].sort(), units: plan.length };
}

export function describeLabEstimate(estimate: IOnyxLabEstimate): string {
	const time = estimate.seconds === null ? 'no estimate: no model in the plan has a measured speed'
		: estimate.seconds < 90 ? `about ${estimate.seconds} seconds`
			: estimate.seconds < 5400 ? `about ${Math.round(estimate.seconds / 60)} minutes`
				: `about ${(estimate.seconds / 3600).toFixed(1)} hours`;
	const missing = estimate.unmeasuredModels.length ? `; not counted, never measured: ${estimate.unmeasuredModels.join(', ')}` : '';
	return `${estimate.units} units, ${time}${missing}`;
}

/**
 * Whether a proposed file changes exactly the lines the author changed, and
 * no others: the pre-registered meaning of a task that succeeded, for a
 * task of one file with no tests of its own. Lines are compared as the
 * score compares them (C8): trimmed, as a multiset, empty lines ignored.
 */
export function labTaskSucceeded(before: string, authorAfter: string, proposedAfter: string): boolean {
	const count = (content: string): Map<string, number> => {
		const counts = new Map<string, number>();
		for (const line of content.split('\n')) {
			const key = line.trim();
			if (key) {
				counts.set(key, (counts.get(key) ?? 0) + 1);
			}
		}
		return counts;
	};
	const author = count(authorAfter);
	const proposed = count(proposedAfter);
	if (author.size !== proposed.size) {
		return false;
	}
	for (const [line, occurrences] of author) {
		if (proposed.get(line) !== occurrences) {
			return false;
		}
	}
	// The same lines as the author's file, and the file did change.
	const original = count(before);
	return [...author].some(([line, occurrences]) => original.get(line) !== occurrences) || original.size !== author.size;
}
