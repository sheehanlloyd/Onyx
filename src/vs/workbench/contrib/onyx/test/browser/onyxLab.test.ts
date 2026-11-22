/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { classifyLabUnit, describeLabEstimate, estimateLabDuration, IOnyxLabCampaignSpec, IOnyxLabUnitRecord, labAgentInstruction, labTaskSucceeded, ONYX_LAB_SHAPE, parseLabRecords, parseLabWorkOrder, planLabCampaign, remainingLabUnits, scoreLabRecord, summarizeLabResults } from '../../common/onyxLab.js';
import { harnessConfigHash, resolveHarnessConfig, deriveHarnessConfig } from '../../common/onyxHarnessConfig.js';

/**
 * L9, the pure half of R-49: how a campaign is planned, resumed, counted
 * and scored, decided without a model, a window or git.
 */
suite('OnyxLab', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const spec: IOnyxLabCampaignSpec = {
		tier: 'S', models: ['small', 'large'], configurations: ['default', 'no-repair'], seeds: [1, 2], repetitions: 1,
		tasks: [{ id: 't1', commit: 'aaaaaaa1', file: 'src/a.ts' }, { id: 't2', commit: 'bbbbbbb2', file: 'src/b.ts' }],
	};
	const record = (overrides: Partial<IOnyxLabUnitRecord>): IOnyxLabUnitRecord => ({
		unit: 'u', model: 'small', configuration: 'default', task: 't1', seed: 1, repetition: 1, tier: 'S', outcome: 'attempted', reply: null, edits: [], events: [], requests: [], harnessHash: null, deniedCommands: 0, durationMs: 10, ...overrides,
	});

	test('R-49: one model is resident at a time, and a killed campaign resumes at the next unfinished unit', () => {
		const plan = planLabCampaign(spec);
		const modelOrder = plan.map(unit => unit.model);
		// A campaign killed while it wrote its sixth record: five whole lines and half a line.
		const written = plan.slice(0, 5).map(unit => JSON.stringify(record({ unit: unit.id }))).join('\n') + '\n' + JSON.stringify(record({ unit: plan[5].id })).slice(0, 40);
		const finished = new Set(parseLabRecords(written).map(entry => entry.unit));
		const remaining = remainingLabUnits(plan, finished);
		assert.deepStrictEqual({
			units: plan.length,
			changesOfModel: modelOrder.filter((model, index) => index > 0 && model !== modelOrder[index - 1]).length,
			firstFour: plan.slice(0, 4).map(unit => unit.id),
			finished: finished.size,
			resumesAt: remaining[0].id,
			left: remaining.length,
			aCancelledUnitRunsAgain: parseLabRecords(JSON.stringify(record({ outcome: 'cancelled' }))).length,
		}, {
			units: 16,
			changesOfModel: 1,
			firstFour: ['small|default|t1|s1|r1', 'small|default|t1|s2|r1', 'small|no-repair|t1|s1|r1', 'small|no-repair|t1|s2|r1'],
			finished: 5,
			resumesAt: plan[5].id,
			left: 11,
			aCancelledUnitRunsAgain: 0,
		});
	});

	test('R-49: a unit the runtime could not serve is counted apart from a failed attempt, and a task that needed a command is blocked by policy', () => {
		const before = 'export function add(a: number, b: number) {\n\treturn a + b;\n}\n';
		const after = 'export function add(a: number, b: number) {\n\treturn a + b; // sum\n}\n';
		const right = '<<<<<<< SEARCH\n\treturn a + b;\n=======\n\treturn a + b; // sum\n>>>>>>> REPLACE';
		const wrong = '<<<<<<< SEARCH\n\treturn a + b;\n=======\n\treturn a - b;\n>>>>>>> REPLACE';
		const results = [
			scoreLabRecord(record({ unit: '1', reply: right }), before, after),
			scoreLabRecord(record({ unit: '2', reply: wrong }), before, after),
			scoreLabRecord(record({ unit: '3', reply: 'I cannot do that.' }), before, after),
			scoreLabRecord(record({ unit: '4', outcome: 'could-not-serve', error: 'HTTP 500' }), before, after),
			scoreLabRecord(record({ unit: '5', outcome: 'blocked-by-policy', deniedCommands: 2 }), before, after),
			scoreLabRecord(record({ unit: '6', tier: 'A', reply: after }), before, after),
			scoreLabRecord(record({ unit: '7', tier: 'A', reply: null }), before, after),
		];
		assert.deepStrictEqual({
			outcomes: {
				served: classifyLabUnit({ cancelled: false, served: true, deniedCommands: 0, proposedAnEdit: false }),
				notServed: classifyLabUnit({ cancelled: false, served: false, deniedCommands: 0, proposedAnEdit: false }),
				commandOnly: classifyLabUnit({ cancelled: false, served: true, deniedCommands: 1, proposedAnEdit: false }),
				commandAndEdit: classifyLabUnit({ cancelled: false, served: true, deniedCommands: 1, proposedAnEdit: true }),
				stopped: classifyLabUnit({ cancelled: true, served: true, deniedCommands: 0, proposedAnEdit: true }),
			},
			scores: results.map(result => [result.unit, result.outcome, result.score, result.success]),
			summary: summarizeLabResults(results),
		}, {
			outcomes: { served: 'attempted', notServed: 'could-not-serve', commandOnly: 'blocked-by-policy', commandAndEdit: 'attempted', stopped: 'cancelled' },
			scores: [
				['1', 'attempted', 1, true],
				['2', 'attempted', 0.5, false],
				['3', 'attempted', 0, false],
				['4', 'could-not-serve', null, null],
				['5', 'blocked-by-policy', null, null],
				['6', 'attempted', 1, true],
				['7', 'attempted', 0, false],
			],
			summary: [{ model: 'small', configuration: 'default', units: 7, attempted: 5, couldNotServe: 1, blockedByPolicy: 1, succeeded: 2, meanScore: 0.5, deniedCommands: 2 }],
		});
	});

	test('a task succeeded only when the proposal changes exactly the lines the author changed', () => {
		const before = 'a\nb\nc\n';
		assert.deepStrictEqual({
			same: labTaskSucceeded(before, 'a\nB\nc\n', 'a\nB\nc\n'),
			indentationAside: labTaskSucceeded(before, 'a\nB\nc\n', 'a\n  B\nc\n'),
			oneLineMore: labTaskSucceeded(before, 'a\nB\nc\n', 'a\nB\nc\nd\n'),
			aKeptLineRemoved: labTaskSucceeded(before, 'a\nB\nc\n', 'B\nc\n'),
			nothingChanged: labTaskSucceeded(before, before, before),
		}, { same: true, indentationAside: true, oneLineMore: false, aKeptLineRemoved: false, nothingChanged: false });
	});

	test('the estimate comes from measured speeds and names a model that was never measured', () => {
		const plan = planLabCampaign(spec);
		const estimate = estimateLabDuration(plan, { small: { tokensPerSecond: 100 } }, ONYX_LAB_SHAPE.S);
		assert.deepStrictEqual({
			estimate,
			text: describeLabEstimate(estimate),
			none: describeLabEstimate(estimateLabDuration(plan, {}, ONYX_LAB_SHAPE.S)),
			hours: describeLabEstimate(estimateLabDuration(planLabCampaign({ ...spec, tier: 'A', seeds: [1, 2, 3], repetitions: 30 }), { small: { tokensPerSecond: 50 }, large: { tokensPerSecond: 50 } }, ONYX_LAB_SHAPE.A)),
		}, {
			estimate: { seconds: 52, unmeasuredModels: ['large'], units: 16 },
			text: '16 units, about 52 seconds; not counted, never measured: large',
			none: '16 units, no estimate: no model in the plan has a measured speed; not counted, never measured: large, small',
			hours: '720 units, about 11.9 hours',
		});
	});

	test('a work order is run whole or not at all', () => {
		const unit = { id: 'u', manifest: '2026-11-22-x', model: 'm', configuration: { name: 'default', configuration: {} }, task: { id: 't', commit: 'abcdef12', file: 'a.ts' }, seed: 1, repetition: 1, temperature: 0, instruction: labAgentInstruction('a.ts', 'Fix the sum') };
		const order = { worktree: '/w', recordsPath: '/r', statusPath: '/s', cancelPath: '/c', heartbeatPath: '/h', baseUrl: 'http://127.0.0.1:1/v1', unitTimeoutMs: 1000, units: [unit] };
		const parsed = parseLabWorkOrder(JSON.stringify(order));
		assert.deepStrictEqual({
			whole: parsed.ok && parsed.order.units[0].instruction,
			notJson: parseLabWorkOrder('{'),
			unread: parseLabWorkOrder(undefined),
			noWorktree: parseLabWorkOrder(JSON.stringify({ ...order, worktree: '' })),
			aCommitThatIsNotAHash: parseLabWorkOrder(JSON.stringify({ ...order, units: [{ ...unit, task: { ...unit.task, commit: 'not a hash' } }] })),
			aMeasurement: (() => { const result = parseLabWorkOrder(JSON.stringify({ ...order, units: [], measure: { modelIds: ['m'], taskCount: 12 } })); return result.ok && result.order.measure; })(),
			aMeasurementOfNothing: parseLabWorkOrder(JSON.stringify({ ...order, units: [], measure: { modelIds: [] } })),
		}, {
			whole: 'Make this change to the file a.ts:\n\nFix the sum\n\nRead the file first, then propose the change with the editFile tool. Do not ask for more information.',
			notJson: { ok: false, error: 'the work order is not JSON' },
			unread: { ok: false, error: 'the work order could not be read' },
			noWorktree: { ok: false, error: 'the work order has no worktree' },
			aCommitThatIsNotAHash: { ok: false, error: 'the work order has a unit that is not whole' },
			aMeasurement: { modelIds: ['m'], datasheets: true, taskCount: 12 },
			aMeasurementOfNothing: { ok: false, error: 'the work order asks for a measurement that names no models' },
		});
	});

	test('a campaign\'s seed and temperature are taken only beside a lab configuration, and never by a packaged build', () => {
		const base = deriveHarnessConfig({ toolCallQuality: 0.9, contextLength: 16_384, maxTools: 8, temperature: 0.2, promptStyle: 'compact', family: 'test', parameterB: 7, supportsVision: false }, { runtimeEnforcesSchema: true });
		const request = { manifest: '2026-11-22-x', name: 'no-numbers', configuration: { readToolLineNumbering: false } };
		const development = resolveHarnessConfig(base, request, 'development', { seed: 7, temperature: 0 });
		const packaged = resolveHarnessConfig(base, request, 'packaged', { seed: 7, temperature: 0 });
		assert.deepStrictEqual({
			development: { source: development.source, sampling: development.sampling, numbering: development.configuration.readToolLineNumbering },
			packaged: { source: packaged.source, sampling: packaged.sampling, hash: packaged.hash === harnessConfigHash(base), refused: packaged.refused },
			badSeed: resolveHarnessConfig(base, request, 'development', { seed: -1 }).refused,
		}, {
			development: { source: 'lab', sampling: { seed: 7, temperature: 0 }, numbering: false },
			packaged: { source: 'default', sampling: undefined, hash: true, refused: 'a lab configuration is accepted only by a development build; this is a packaged build' },
			badSeed: 'the seed must be a whole number from 0 and the temperature a number from 0 to 2',
		});
	});
});
