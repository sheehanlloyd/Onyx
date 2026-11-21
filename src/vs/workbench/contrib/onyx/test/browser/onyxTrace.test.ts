/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { classifyStreamEnd, ONYX_TRACE_VERSION, parseTrace, validateTrace } from '../../common/onyxTrace.js';

suite('OnyxTrace', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const header = {
		t: 0, kind: 'trace', data: {
			kind: 'trace', v: ONYX_TRACE_VERSION, runId: 'run-1', startedAt: 1,
			harness: { configurationHash: 'abc', configuration: { promptStyle: 'full' } },
			model: { identifier: 'onyx:localhost:11434/sim', digest: null },
			runtime: { name: 'ollama', version: null, baseUrl: 'http://localhost:11434/v1' },
			sampling: { temperature: 0.2, seed: 7, maxTokens: null, responseFormat: false },
			tools: [{ name: 'editFile', schemaHash: 'ff' }],
			context: { budgetedTokens: 16384, source: 'server', requestedTokens: null, reportedTokens: 16384, verifiedTokens: null, mechanism: null },
		},
	};
	const turn = {
		t: 5, kind: 'traceTurn', data: {
			kind: 'traceTurn', v: ONYX_TRACE_VERSION, turn: 1, requestDigest: '01', responseText: 'ok', streamEnd: 'stop',
			toolCalls: [{ name: 'editFile', argumentsDigest: '02', resultDigest: '03', ok: true }], seed: { requested: 7, honoured: 'unknown' },
		},
	};

	test('R-43: a v2 journal parses and validates; a missing required field fails closed, an unknown seed written as null does not', () => {
		const good = parseTrace([JSON.stringify(header), JSON.stringify({ t: 1, kind: 'turn', data: {} }), JSON.stringify(turn)].join('\n'));
		const withoutSeed = JSON.parse(JSON.stringify(header)) as typeof header;
		delete (withoutSeed.data.sampling as { seed?: number }).seed;
		const noSeed = parseTrace([JSON.stringify(withoutSeed), JSON.stringify(turn)].join('\n'));
		const withoutHeader = parseTrace([JSON.stringify(turn)].join('\n'));
		const nullSeed = parseTrace([JSON.stringify({ ...header, data: { ...header.data, sampling: { ...header.data.sampling, seed: null } } }), JSON.stringify({ ...turn, data: { ...turn.data, seed: { requested: null, honoured: 'unknown' } } })].join('\n'));
		const turnWithoutEnd = JSON.parse(JSON.stringify(turn)) as typeof turn;
		delete (turnWithoutEnd.data as { streamEnd?: string }).streamEnd;
		const noEnd = parseTrace([JSON.stringify(header), JSON.stringify(turnWithoutEnd)].join('\n'));
		assert.deepStrictEqual({
			good: { ...validateTrace(good), turns: good.turns.length, records: good.records.length },
			noSeed: validateTrace(noSeed),
			nullSeed: validateTrace(nullSeed),
			withoutHeader: validateTrace(withoutHeader),
			noEnd: validateTrace(noEnd),
		}, {
			good: { ok: true, version: 2, errors: [], turns: 1, records: 3 },
			noSeed: { ok: false, version: 2, errors: ['header.sampling lacks seed'] },
			nullSeed: { ok: true, version: 2, errors: [] },
			withoutHeader: { ok: false, version: 1, errors: ['turn records without a trace header'] },
			noEnd: { ok: false, version: 2, errors: ['turn 1 lacks streamEnd'] },
		});
	});

	test('a v1 journal (run events only) still reads, as version 1', () => {
		const v1 = parseTrace([JSON.stringify({ t: 0, kind: 'turn', data: { label: 'Model turn 1' } }), 'not json', JSON.stringify({ t: 9, kind: 'outcome', data: { status: 'completed' } })].join('\n'));
		assert.deepStrictEqual({ ...validateTrace(v1), records: v1.records.length, turns: v1.turns.length }, { ok: true, version: 1, errors: [], records: 2, turns: 0 });
	});

	test('stream ends are classified from the finish reason, and no finish reason is truncation', () => {
		assert.deepStrictEqual(
			[['stop', false], ['tool_calls', false], ['length', false], ['cancelled', false], [undefined, false], ['weird', false], ['stop', true]].map(([reason, error]) => classifyStreamEnd(reason as string | undefined, error as boolean)),
			['stop', 'tool_calls', 'length', 'cancelled', 'truncated', 'unknown', 'error'],
		);
	});
});
