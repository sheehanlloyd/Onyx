/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { OnyxEnvelopeAnswerStream } from '../../common/onyxConstrainedToolCalls.js';
import { OnyxSimEpisode, OnyxSimModelTurn, SIM_FILES, SIM_TARGET_FILE } from './sim/onyxSimEpisode.js';
import { allCheckers } from './sim/onyxSimInvariants.js';
import { runEpisode } from './sim/onyxSimRun.js';

/**
 * C6, the optional part of R-28: a constrained turn is one JSON object, and
 * its answer used to appear only when the whole object had arrived. The
 * answer's text is now read out of the envelope as it streams.
 */

const LONG_ANSWER = [
	'The function adds its two arguments.',
	'It is called from `total`, which folds it over a list:',
	'',
	'```ts',
	'return values.reduce((sum, value) => addNumbers(sum, value), 0);',
	'```',
	'',
	'Nothing else in the repository uses it, so changing the order of the operands is safe: addition commutes, "a + b" and "b + a" agree, and the tests do not depend on the order either.',
].join('\n');

/** Feeds an envelope in chunks of `size`; reports what was released, and how much of it before the last chunk. */
function read(envelope: string, size = 5) {
	const stream = new OnyxEnvelopeAnswerStream();
	let released = '';
	let beforeTheLastChunk = 0;
	for (let offset = 0; offset < envelope.length; offset += size) {
		if (offset + size >= envelope.length) {
			beforeTheLastChunk = released.length;
		}
		released += stream.push(envelope.slice(offset, offset + size));
	}
	return { released, beforeTheLastChunk, shown: stream.shown };
}

function episode(extra: Partial<OnyxSimEpisode>): OnyxSimEpisode {
	return { name: 'constrained', seed: 0, persona: 'well-behaved', prompt: 'What does addNumbers do?', files: SIM_FILES, target: SIM_TARGET_FILE, turns: [], dialogDefault: 'allow-once', userSteps: [], faults: [], constrained: true, ...extra };
}

suite('OnyxConstrainedStreaming', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('R-28 (C6): the answer is read out of the envelope as it arrives, with its escapes decoded; a tool turn releases nothing; an answer that comes before its action waits for it', () => {
		const answer = read(JSON.stringify({ action: 'answer', answer: LONG_ANSWER }));
		const escapes = 'tab\there, a quote " and a backslash \\, é as an escape, and \u{1F600} as two';
		const escaped = read(`{"action":"answer","answer":${JSON.stringify(escapes).replace('é', '\\u00e9').replace('\u{1F600}', '\\ud83d\\ude00')}}`, 3);
		const tool = read(JSON.stringify({ action: 'tool', tool: 'terminal', arguments: { command: 'echo "answer"', answer: 'not the answer' } }));
		const answerFirst = read(JSON.stringify({ answer: 'said before the action', action: 'answer' }), 4);
		const toolWithAnAnswerKey = read(JSON.stringify({ answer: 'never shown', action: 'tool', tool: 'terminal', arguments: {} }), 4);
		assert.deepStrictEqual({
			answer: { whole: answer.released === LONG_ANSWER, shownMatches: answer.shown === LONG_ANSWER, mostOfItBeforeTheEnd: answer.beforeTheLastChunk > LONG_ANSWER.length - 10 },
			escaped: escaped.released,
			tool: tool.released,
			answerFirst: answerFirst.released,
			toolWithAnAnswerKey: toolWithAnAnswerKey.released,
		}, {
			answer: { whole: true, shownMatches: true, mostOfItBeforeTheEnd: true },
			escaped: escapes,
			tool: '',
			answerFirst: 'said before the action',
			toolWithAnAnswerKey: '',
		});
	});

	test('R-28 (C6): in a constrained run the answer reaches the transcript while it streams, once and whole; a constrained tool call still runs', async () => {
		const answerTurn: OnyxSimModelTurn = { kind: 'text', text: LONG_ANSWER, chunks: 8 };
		const result = await runEpisode(episode({ turns: [{ kind: 'toolCall', tool: 'terminal', arguments: { command: 'npm test' } }, answerTurn] }), allCheckers());
		const events = result.trace.split('\n').filter(line => line.trim()).map(line => JSON.parse(line) as { kind: string; size?: number; delta?: string });
		// The second request is the answer turn: what was shown between its first chunk and the end of its stream.
		let requests = 0;
		let shownWhileStreaming = 0;
		let shownInAll = 0;
		let streaming = false;
		for (const event of events) {
			if (event.kind === 'request') {
				requests++;
				streaming = requests === 2;
			} else if (event.kind === 'chunk' && event.delta === 'done') {
				streaming = false;
			} else if (event.kind === 'shown' && requests === 2) {
				shownInAll += event.size ?? 0;
				shownWhileStreaming += streaming ? event.size ?? 0 : 0;
			}
		}
		assert.deepStrictEqual({
			status: result.status,
			constrained: result.requests.length,
			ran: result.commands.map(command => command.command),
			shownWhileStreaming: shownWhileStreaming > LONG_ANSWER.length / 2,
			shownOnceAndWhole: shownInAll === LONG_ANSWER.length,
		}, {
			status: 'completed',
			constrained: 2,
			ran: ['npm test'],
			shownWhileStreaming: true,
			shownOnceAndWhole: true,
		});
	});
});
