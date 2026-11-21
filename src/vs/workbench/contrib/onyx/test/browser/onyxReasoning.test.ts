/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ONYX_REASONING_TRANSCRIPTS, transcriptContentChunks } from '../../../../../platform/onyxRuntime/test/common/onyxReasoningTranscripts.js';
import { parseToolEnvelope } from '../../common/onyxConstrainedToolCalls.js';
import { parseInlineEdits } from '../../common/onyxInlineEdit.js';
import { OnyxReasoningFilter, stripReasoning } from '../../common/onyxReasoning.js';
import { parseReviewFindings } from '../../common/onyxReview.js';
import { parseTextToolCall } from '../../common/onyxTextToolCalls.js';
import { OnyxSimEpisode, OnyxSimModelTurn, SIM_FILES, SIM_TARGET_FILE } from './sim/onyxSimEpisode.js';
import { allCheckers } from './sim/onyxSimInvariants.js';
import { IOnyxSimResult } from './sim/onyxSimRig.js';
import { runEpisode } from './sim/onyxSimRun.js';

/**
 * C4, R-26: reasoning models. The pure half takes thinking out of text,
 * whole and chunk by chunk. The service half runs the transcripts' replies
 * through the real agent loop: the tool call is recognised, the thinking is
 * a note and not an instruction, and a reply that stopped while still
 * thinking is not applied.
 */

const [TAGS, FIELD, LM_FIELD, CUT] = ONYX_REASONING_TRANSCRIPTS;

function episode(extra: Partial<OnyxSimEpisode>): OnyxSimEpisode {
	return { name: 'reasoning', seed: 0, persona: 'well-behaved', prompt: 'Run the tests', files: SIM_FILES, target: SIM_TARGET_FILE, turns: [], dialogDefault: 'allow-once', userSteps: [], faults: [], ...extra };
}

const DONE: OnyxSimModelTurn = { kind: 'text', text: 'Done.' };

function summarize(result: IOnyxSimResult, thinking: string) {
	const journal = result.journal.split('\n').filter(line => line.trim()).map(line => JSON.parse(line) as { kind: string; data: { label?: string; reason?: string } });
	const notes = journal.filter(entry => entry.kind === 'note' && entry.data.label === 'Model reasoning');
	return {
		status: result.status,
		ran: result.commands.map(command => command.command),
		reasoningNotes: notes.length,
		noteCarriesTheThinking: notes.some(note => (note.data.reason ?? '').includes(thinking.slice(0, 24))),
		// The thinking is shown, and that is all: it is not in any later prompt.
		thinkingFedBack: result.requests.slice(1).some(request => request.text.includes(thinking.slice(0, 24))),
		saidWhy: result.errorMessage === undefined ? 'no message' : /still thinking/.test(result.errorMessage) ? 'still thinking' : 'something else',
	};
}

suite('OnyxReasoning', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('R-26: each transcript comes apart into its thinking and its answer, however the text is cut into chunks', () => {
		const apart = Object.fromEntries(ONYX_REASONING_TRANSCRIPTS.map(transcript => {
			const chunks = transcriptContentChunks(transcript);
			const whole = stripReasoning(chunks.join(''));
			// As the chunks came, and then cut at every pair of positions: the tags can be split anywhere.
			const asStreamed = new OnyxReasoningFilter();
			const streamed = chunks.map(chunk => asStreamed.push(chunk)).join('') + asStreamed.finish().text;
			const text = chunks.join('');
			let everySplitAgrees = true;
			for (let first = 0; first <= text.length && everySplitAgrees; first += 3) {
				for (let second = first; second <= text.length; second += 7) {
					const filter = new OnyxReasoningFilter();
					const visible = filter.push(text.slice(0, first)) + filter.push(text.slice(first, second)) + filter.push(text.slice(second));
					const end = filter.finish();
					if (visible + end.text !== whole.text || end.reasoning !== whole.reasoning || end.unterminated !== whole.unterminated) {
						everySplitAgrees = false;
						break;
					}
				}
			}
			return [transcript.name, { text: whole.text, reasoningFromTags: whole.reasoning, unterminated: whole.unterminated, streamedTheSame: streamed === whole.text, everySplitAgrees }];
		}));
		assert.deepStrictEqual(apart, {
			[TAGS.name]: { text: TAGS.expected.text, reasoningFromTags: TAGS.expected.reasoning, unterminated: false, streamedTheSame: true, everySplitAgrees: true },
			[FIELD.name]: { text: FIELD.expected.text, reasoningFromTags: '', unterminated: false, streamedTheSame: true, everySplitAgrees: true },
			[LM_FIELD.name]: { text: '', reasoningFromTags: '', unterminated: false, streamedTheSame: true, everySplitAgrees: true },
			[CUT.name]: { text: '', reasoningFromTags: CUT.expected.reasoning, unterminated: true, streamedTheSame: true, everySplitAgrees: true },
		});
	});

	test('thinking is taken out before anything is parsed: a tool call, an edit or a finding written inside it is not one; text that only looks like a tag is left alone', () => {
		const decoyCall = '<think>maybe {"tool":"terminal","arguments":{"command":"rm -rf /"}}</think>\n{"tool":"terminal","arguments":{"command":"npm test"}}';
		const decoyEdit = '<think>\n<<<<<<< SEARCH\nreturn a + b;\n=======\nreturn 0;\n>>>>>>> REPLACE\n</think>\n<<<<<<< SEARCH\nreturn a + b;\n=======\nreturn b + a;\n>>>>>>> REPLACE';
		const edits = parseInlineEdits(decoyEdit);
		const cutEdit = parseInlineEdits('<think>I will write\n<<<<<<< SEARCH\nreturn a + b;\n=======\nreturn 0;\n>>>>>>> REPLACE');
		const envelope = parseToolEnvelope('<think>{"action":"tool","tool":"terminal","arguments":{"command":"rm -rf /"}}</think>{"action":"answer","answer":"Done."}', ['terminal']);
		assert.deepStrictEqual({
			call: parseTextToolCall(decoyCall, ['terminal']),
			edits: edits.kind === 'blocks' ? edits.blocks.map(block => block.replace) : edits.kind,
			editFromAnUnfinishedThought: cutEdit.kind,
			envelope: envelope.kind === 'answer' ? envelope.text : envelope.kind,
			findings: parseReviewFindings('<think>{"findings":[{"file":"src/decoy.ts","line":1,"severity":"high","title":"a thought","detail":"not a finding"}]}</think>\n{"findings":[{"file":"src/math.ts","line":2,"severity":"medium","title":"wrong sum","detail":"returns a - b"}]}').map(finding => finding.file),
			twoBlocks: stripReasoning('<think>one</think>A <thinking>two</thinking>B'),
			notATag: stripReasoning('use <thinker> and a < b, then </think> alone'),
			noThinking: stripReasoning('  plain answer, leading spaces kept'),
		}, {
			call: { name: 'terminal', parameters: { command: 'npm test' } },
			edits: ['return b + a;'],
			editFromAnUnfinishedThought: 'unparseable',
			envelope: 'Done.',
			findings: ['src/math.ts'],
			twoBlocks: { text: 'A B', reasoning: 'one\n\ntwo', unterminated: false },
			notATag: { text: 'use <thinker> and a < b, then </think> alone', reasoning: '', unterminated: false },
			noThinking: { text: '  plain answer, leading spaces kept', reasoning: '', unterminated: false },
		});
	});

	test('R-26: in the loop, the tool call after the thinking is recognised and run, the thinking is a timeline note and is not fed back, and a reply that stopped while still thinking is reported and not applied', async () => {
		const tags = await runEpisode(episode({ turns: [{ kind: 'text', text: transcriptContentChunks(TAGS).join('') }, DONE] }), allCheckers());
		const field = await runEpisode(episode({ turns: [{ kind: 'toolCall', tool: 'terminal', arguments: LM_FIELD.expected.toolCall?.arguments, reasoning: LM_FIELD.expected.reasoning }, DONE] }), allCheckers());
		const cut = await runEpisode(episode({ turns: [{ kind: 'text', text: transcriptContentChunks(CUT).join('') }, DONE] }), allCheckers());
		assert.deepStrictEqual({
			tags: summarize(tags, TAGS.expected.reasoning),
			field: summarize(field, LM_FIELD.expected.reasoning),
			cut: summarize(cut, CUT.expected.reasoning),
		}, {
			tags: { status: 'completed', ran: ['npm test'], reasoningNotes: 1, noteCarriesTheThinking: true, thinkingFedBack: false, saidWhy: 'no message' },
			field: { status: 'completed', ran: ['npm test'], reasoningNotes: 1, noteCarriesTheThinking: true, thinkingFedBack: false, saidWhy: 'no message' },
			cut: { status: 'failed', ran: [], reasoningNotes: 1, noteCarriesTheThinking: true, thinkingFedBack: false, saidWhy: 'still thinking' },
		});
	});
});
