/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { buildCommitDiffDigest, cleanCommitMessage, splitDiffByFile } from '../../common/onyxCommitMessage.js';
import { buildCoChangeIndex, coChangedWith } from '../../common/onyxCoChange.js';
import { addOutcome, addSample, emptyLedgerEntry, formatCount, mergeLedgers, summarize } from '../../common/onyxLedger.js';
import { fitModel, formatSize, ONYX_MODEL_CATALOG, recommendForMachine, toGigabytes } from '../../common/onyxModelCatalog.js';
import { buildExplainPrompt, buildFixPrompt } from '../../common/onyxQuickActions.js';
import { buildPicks } from '../../browser/models/onyxModelLibrary.js';
import { extractJsonObject, parseReviewFindings } from '../../common/onyxReview.js';
import { diffRuns } from '../../common/onyxRunDiff.js';
import { extractDiffSignals, scoreChangeRisk } from '../../common/onyxChangeRisk.js';
import { buildToolEnvelopeFormat, parseToolEnvelope } from '../../common/onyxConstrainedToolCalls.js';
import { redactJournalContent } from '../../common/onyxDiagnostics.js';
import { buildHubEntries } from '../../common/onyxHub.js';
import { buildComparisonDocument, decideTournamentConcurrency } from '../../common/onyxTournament.js';
import { humanizeRuntimeError } from '../../common/onyxRuntimeErrors.js';
import { crc32, createStoredZip } from '../../common/onyxZip.js';
import { couldBeToolEnvelope, OnyxAssistantTextStream, parseTextToolCall } from '../../common/onyxTextToolCalls.js';
import { shortReason } from '../../browser/agent/onyxAgentLoop.js';

suite('OnyxWorkflows', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('commit messages', () => {

		test('a diff is split per file and every file survives the budget', () => {
			const diff = [
				'diff --git a/src/a.ts b/src/a.ts',
				'@@ -1 +1 @@',
				`-${'a'.repeat(4000)}`,
				'diff --git a/src/b.ts b/src/b.ts',
				'@@ -1 +1 @@',
				'+small change',
			].join('\n');

			assert.strictEqual(splitDiffByFile(diff).length, 2);

			const digest = buildCommitDiffDigest(diff, ['src/a.ts', 'src/b.ts'], 1200);
			assert.deepStrictEqual(
				{
					mentionsBothFiles: digest.includes('src/a.ts') && digest.includes('src/b.ts'),
					keepsSmallFileBody: digest.includes('+small change'),
					elidesLargeFile: digest.includes('… diff truncated …'),
					withinBudget: digest.length <= 1600,
				},
				{ mentionsBothFiles: true, keepsSmallFileBody: true, elidesLargeFile: true, withinBudget: true },
			);
		});

		test('model scaffolding is stripped and the subject is held to 72 characters', () => {
			const raw = '```\nCommit message: "Add a really quite extraordinarily long subject line that keeps going well past the limit."\n\n- did a thing\n```';
			const cleaned = cleanCommitMessage(raw);
			const [subject, blank, body] = cleaned.split('\n');
			assert.deepStrictEqual(
				{ subject, blank, body, subjectLength: subject.length <= 72, noTrailingPeriod: !subject.endsWith('.') },
				{
					subject: 'Add a really quite extraordinarily long subject line that keeps going',
					blank: '',
					body: '- did a thing',
					subjectLength: true,
					noTrailingPeriod: true,
				},
			);
		});
	});

	suite('review findings', () => {

		test('findings survive surrounding prose and sort by severity', () => {
			const raw = [
				'Sure! Here is my review:',
				'```json',
				'{"findings":[',
				'{"file":"b/src/x.ts","line":"12","severity":"low","title":"Nit","detail":"minor"},',
				'{"file":"src/y.ts","line":40,"severity":"high","title":"Unhandled rejection","detail":"throws"},',
				'{"file":"src/z.ts","line":7,"severity":"nonsense","title":"Off by one","detail":""},',
				'{"title":"no file"}',
				']}',
				'```',
			].join('\n');

			assert.deepStrictEqual(parseReviewFindings(raw), [
				{ file: 'src/y.ts', line: 40, severity: 'high', title: 'Unhandled rejection', detail: 'throws' },
				{ file: 'src/z.ts', line: 7, severity: 'medium', title: 'Off by one', detail: '' },
				{ file: 'src/x.ts', line: 1, severity: 'low', title: 'Nit', detail: 'minor' },
			]);
		});

		test('braces inside strings do not terminate the object, and junk yields nothing', () => {
			assert.strictEqual(extractJsonObject('noise {"a":"}{"} tail'), '{"a":"}{"}');
			assert.deepStrictEqual(parseReviewFindings('I could not find any problems.'), []);
		});
	});

	suite('co-change mining', () => {

		test('files committed together are ranked, huge and single-file commits ignored', () => {
			const index = buildCoChangeIndex([
				['src/parser.ts', 'test/parser.test.ts'],
				['src/parser.ts', 'test/parser.test.ts', 'docs/parser.md'],
				['src/parser.ts', 'test/parser.test.ts'],
				['src/parser.ts'],
				Array.from({ length: 40 }, (_, i) => `vendor/file${i}.ts`).concat('src/parser.ts'),
			]);

			assert.deepStrictEqual(coChangedWith(index, 'src/parser.ts', 5), [
				{ path: 'test/parser.test.ts', commits: 3, strength: 1 },
			]);
			assert.deepStrictEqual(coChangedWith(index, 'src/parser.ts', 5, 1), [
				{ path: 'test/parser.test.ts', commits: 3, strength: 1 },
				{ path: 'docs/parser.md', commits: 1, strength: 1 / 3 },
			]);
			assert.deepStrictEqual(coChangedWith(index, 'vendor/file0.ts', 5), []);
		});
	});

	suite('model catalog', () => {

		test('memory tiers pick models the machine can actually hold', () => {
			assert.deepStrictEqual(
				[8, 16, 36, 64].map(gb => recommendForMachine(gb).recommended[0]),
				['qwen2.5-coder:1.5b', 'qwen2.5-coder:7b', 'qwen2.5-coder:14b', 'qwen2.5-coder:32b'],
			);

			const big = ONYX_MODEL_CATALOG.find(m => m.id === 'qwen2.5-coder:32b')!;
			const small = ONYX_MODEL_CATALOG.find(m => m.id === 'qwen2.5-coder:1.5b')!;
			assert.deepStrictEqual(
				{ bigOn8: fitModel(big, 8), bigOn64: fitModel(big, 64), smallOn8: fitModel(small, 8), sizes: [formatSize(0.9), formatSize(4.7), formatSize(20)], gb: toGigabytes(36 * 1024 ** 3) },
				{ bigOn8: 'tooLarge', bigOn64: 'comfortable', smallOn8: 'comfortable', sizes: ['922 MB', '4.7 GB', '20 GB'], gb: 36 },
			);
		});

		test('every recommended id exists in the catalog', () => {
			const ids = new Set(ONYX_MODEL_CATALOG.map(m => m.id));
			const missing = [8, 16, 36, 64].flatMap(gb => recommendForMachine(gb).recommended).filter(id => !ids.has(id));
			assert.deepStrictEqual(missing, []);
		});

		test('installed models outside the catalog still appear in the library', () => {
			const discovered = [
				{ id: 'qwen2.5-coder:7b', baseUrl: 'http://localhost:11434/v1', runtime: 'ollama' as const },
				{ id: 'my-finetune:latest', baseUrl: 'http://localhost:11434/v1', runtime: 'ollama' as const, parameterB: 3, quantization: 'Q4_K_M' },
			];
			const picks = buildPicks(discovered, 24, recommendForMachine(24).recommended);
			const labels = picks.map(pick => (pick as { type?: string }).type === 'separator' ? `— ${pick.label}` : (pick as { label: string }).label);
			assert.deepStrictEqual(
				{
					firstGroup: labels[0],
					installed: labels.slice(1, 3),
					uncataloguedDescription: (picks[2] as { description?: string }).description,
				},
				{
					firstGroup: '— Installed',
					installed: ['$(check) Qwen2.5 Coder 7B', '$(check) my-finetune:latest'],
					uncataloguedDescription: '3B parameters · Q4_K_M',
				});
		});
	});

	suite('runtime errors', () => {

		test('transport failures become sentences a person can act on', () => {
			assert.deepStrictEqual([
				humanizeRuntimeError('terminated', 'qwen:7b').startsWith('The local runtime stopped responding mid-answer (qwen:7b)'),
				humanizeRuntimeError('fetch failed').startsWith('Could not reach the local runtime'),
				humanizeRuntimeError('ETIMEDOUT').startsWith('The local runtime took too long'),
				humanizeRuntimeError('400: this model maximum context length is 8192').startsWith('This request is longer than'),
				humanizeRuntimeError('404 model not found').startsWith('The runtime does not have that model loaded'),
				humanizeRuntimeError('llama runtime: out of memory').startsWith('The runtime ran out of memory'),
				// Anything unrecognized passes through: inventing a cause is worse.
				humanizeRuntimeError('something entirely novel'),
			], [true, true, true, true, true, true, 'something entirely novel']);
		});
	});

	suite('tournament', () => {

		test('concurrency scales with memory and never exceeds the cap', () => {
			assert.deepStrictEqual([
				decideTournamentConcurrency(8, [3, 3]),
				decideTournamentConcurrency(24, [5, 5, 5]),
				decideTournamentConcurrency(128, [5, 5]),
				decideTournamentConcurrency(16, []),
				decideTournamentConcurrency(4, [20]),
			], [1, 2, 4, 1, 1]);
		});

		test('the comparison document carries stats, diffs and failures', () => {
			const document = buildComparisonDocument('add null check', [
				{ modelKey: 'a/7b', durationMs: 2100, tokensPerSecond: 42, diffText: 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@\n-old\n+new\n+more', changedFiles: ['src/x.ts'] },
				{ modelKey: 'b/3b', durationMs: 900, tokensPerSecond: undefined, diffText: '', changedFiles: [], failed: 'the reply was not a usable edit' },
			]);
			assert.deepStrictEqual({
				title: document.startsWith('# Onyx tournament — "add null check"'),
				stats: document.includes('2.1s · 42 tok/s · +2 −1 in src/x.ts'),
				fenced: document.includes('```diff'),
				failure: document.includes('_No usable edit: the reply was not a usable edit_'),
			}, { title: true, stats: true, fenced: true, failure: true });
		});
	});

	suite('constrained tool calls', () => {

		const tools = [{ name: 'repoSymbols' }, { name: 'remember' }];

		test('the schema names every tool and both actions', () => {
			const format = buildToolEnvelopeFormat(tools) as { type: string; json_schema: { schema: { properties: { action: { enum: string[] }; tool: { enum: string[] } } } } };
			assert.deepStrictEqual(
				{ type: format.type, actions: format.json_schema.schema.properties.action.enum, tools: format.json_schema.schema.properties.tool.enum },
				{ type: 'json_schema', actions: ['tool', 'answer'], tools: ['repoSymbols', 'remember'] });
		});

		test('parses tool, answer, prose-wrapped and invalid envelopes', () => {
			const names = tools.map(tool => tool.name);
			assert.deepStrictEqual([
				parseToolEnvelope('{"action":"tool","tool":"repoSymbols","arguments":{"query":"x"}}', names),
				parseToolEnvelope('{"action":"answer","answer":"done"}', names),
				parseToolEnvelope('Sure! {"action":"tool","tool":"remember","arguments":{"note":"a \\"b\\" {c}"}} there', names),
				parseToolEnvelope('{"action":"tool","tool":"madeUp","arguments":{}}', names),
				parseToolEnvelope('no json here', names),
			], [
				{ kind: 'tool', name: 'repoSymbols', parameters: { query: 'x' } },
				{ kind: 'answer', text: 'done' },
				{ kind: 'tool', name: 'remember', parameters: { note: 'a "b" {c}' } },
				{ kind: 'invalid', raw: '{"action":"tool","tool":"madeUp","arguments":{}}' },
				{ kind: 'invalid', raw: 'no json here' },
			]);
		});
	});

	suite('diagnostics', () => {

		test('stored zip has the right structure and checksums', () => {
			const data = new TextEncoder().encode('hello onyx');
			const zip = createStoredZip([{ path: 'a/b.txt', data }]);
			const u32 = (offset: number) => zip[offset] | (zip[offset + 1] << 8) | (zip[offset + 2] << 16) | ((zip[offset + 3] << 24) >>> 0);
			const eocdOffset = zip.length - 22;
			assert.deepStrictEqual(
				{
					localSig: u32(0) >>> 0,
					crc: (u32(14) >>> 0).toString(16),
					nameLength: zip[26],
					eocdSig: u32(eocdOffset) >>> 0,
					entryCount: zip[eocdOffset + 10],
					crcMatches: (crc32(data) >>> 0) === (u32(14) >>> 0),
				},
				{ localSig: 0x04034B50, crc: (crc32(data) >>> 0).toString(16), nameLength: 7, eocdSig: 0x06054B50, entryCount: 1, crcMatches: true });
		});

		test('redaction strips prompt text and steering but keeps structure', () => {
			const journal = [
				JSON.stringify({ t: 0, kind: 'promptSnapshot', data: { turn: 1, model: 'm', tools: ['repoSymbols'], messages: [{ role: 0, content: [{ type: 'text', value: 'secret prompt' }] }] } }),
				JSON.stringify({ t: 1, kind: 'note', data: { kind: 'steer', label: 'User redirected the agent', reason: 'private instruction' } }),
				JSON.stringify({ t: 2, kind: 'toolCall', data: { kind: 'toolCall', label: 'repoSymbols' } }),
				'not json',
			].join('\n');
			const redacted = redactJournalContent(journal).split('\n').map(line => { try { return JSON.parse(line); } catch { return line; } });
			assert.deepStrictEqual([
				(redacted[0] as { data: { messages: { content: { value: string }[] }[] } }).data.messages[0].content[0].value,
				(redacted[0] as { data: { tools: string[] } }).data.tools,
				(redacted[1] as { data: { reason: string } }).data.reason,
				(redacted[2] as { data: { label: string } }).data.label,
				redacted[3],
			], ['[redacted 13 chars]', ['repoSymbols'], '[redacted 19 chars]', 'repoSymbols', 'not json']);
		});
	});

	suite('hub', () => {

		test('live state lands in the descriptions', () => {
			const entries = buildHubEntries({
				modelsReady: 2, endpointCount: 1, currentModelKey: 'localhost:11434/q7b', inFlight: false,
				tokensPerSecond: 42.4, sessionRequests: 9, runsToday: 3, memoryFacts: 2, pinnedFiles: 1, playbooks: 2, stagedChangeFiles: 0, resumableRuns: 0,
			});
			const byId = new Map(entries.map(entry => [entry.id, entry]));
			assert.deepStrictEqual([
				byId.get('chat')?.description,
				byId.get('controlPlane')?.description,
				byId.get('pin')?.description,
				entries.filter(entry => entry.group).map(entry => entry.group),
			], [
				'2 models on 1 runtime',
				'3 runs today · last: localhost:11434/q7b · 42 tok/s',
				'1 file pinned',
				['Do', 'Observe', 'Tune'],
			]);
		});
	});

	suite('change risk', () => {

		const baseSignals = {
			path: 'src/api.ts', changedLines: 5, churnCommits: 0, windowCommits: 100,
			coChangePartners: 0, referenceCount: undefined, hasNearbyTest: true, touchesErrorHandling: false,
		};

		test('signals accumulate into levels with plain reasons', () => {
			assert.deepStrictEqual([
				scoreChangeRisk(baseSignals),
				scoreChangeRisk({ ...baseSignals, changedLines: 120, hasNearbyTest: false }),
				scoreChangeRisk({ ...baseSignals, churnCommits: 30, changedLines: 200, touchesErrorHandling: true, hasNearbyTest: false, referenceCount: 40 }),
			].map(risk => [risk.level, risk.reason]), [
				['low', 'small change in a quiet, tested file'],
				['moderate', 'a large change, no nearby test'],
				['elevated', 'changes often, widely referenced'],
			]);
		});

		test('diff signals: path, size, error handling', () => {
			const diff = [
				'diff --git a/src/api.ts b/src/api.ts',
				'--- a/src/api.ts',
				'+++ b/src/api.ts',
				'@@ -1,3 +1,4 @@',
				'+try {',
				'+\tconnect();',
				'-legacy();',
				'+} catch (err) { report(err); }',
			].join('\n');
			assert.deepStrictEqual(extractDiffSignals(diff), { path: 'src/api.ts', changedLines: 4, touchesErrorHandling: true });
		});

		test('missing tests alone never raise risk', () => {
			const risk = scoreChangeRisk({ ...baseSignals, hasNearbyTest: false });
			assert.deepStrictEqual([risk.level, risk.reason], ['low', 'small change in a quiet, tested file']);
		});
	});

	suite('run diff', () => {

		const record = (runId: string, model: string, events: { kind: string; data: unknown }[]) => ({
			runId, startedAt: 0, title: `req ${runId}`, task: 'implement' as const, modelKey: model,
			status: 'completed' as const, turnCount: 0, toolCallCount: 0,
			events: events.map((event, index) => ({ t: index, kind: event.kind as 'note', data: event.data })),
		});
		const snapshot = (turn: number, model: string, tools: string[], messages: string[]) => ({
			kind: 'promptSnapshot',
			data: { turn, model, tools, messages: messages.map(value => ({ role: 1, content: [{ type: 'text', value }] })) },
		});

		test('aligns by turn, marks changes, elides identical stretches', () => {
			const left = record('a', 'onyx:small', [
				{ kind: 'note', data: { kind: 'route', label: 'small', reason: 'compact' } },
				snapshot(1, 'onyx:small', ['repoSymbols'], ['hi']),
				snapshot(2, 'onyx:small', ['repoSymbols'], ['hi', 'same']),
				snapshot(3, 'onyx:small', ['repoSymbols'], ['hi', 'same', 'same2']),
				{ kind: 'toolCall', data: { label: 'repoSymbols' } },
				{ kind: 'outcome', data: { status: 'completed' } },
			]);
			const right = record('b', 'onyx:big', [
				{ kind: 'note', data: { kind: 'route', label: 'big', reason: 'debug' } },
				snapshot(1, 'onyx:big', ['repoSymbols'], ['hi']),
				snapshot(2, 'onyx:big', ['repoSymbols'], ['hi', 'same']),
				snapshot(3, 'onyx:big', ['repoSymbols'], ['hi', 'same', 'different']),
				{ kind: 'toolCall', data: { label: 'repoSymbols' } },
				{ kind: 'outcome', data: { status: 'failed' } },
			]);
			const sections = diffRuns(left, right);
			assert.deepStrictEqual(sections.map(section => section.kind), ['meta', 'turn', 'turn', 'turn', 'outcome']);
			// Every turn differs on model here, so nothing elides — but message
			// changes only mark the turn where the new message actually differs.
			const turn3 = sections[3];
			assert.ok(turn3.kind === 'turn');
			assert.deepStrictEqual(
				turn3.rows.map(row => [row.label, row.changed]),
				[['model', true], ['tools', false], ['new messages', true], ['tool activity', false]]);
			const outcome = sections[4];
			assert.ok(outcome.kind === 'outcome');
			assert.deepStrictEqual(outcome.rows[0], { label: 'outcome', left: 'completed', right: 'failed', changed: true });
		});

		test('identical turns collapse into one elision marker', () => {
			const events = [
				snapshot(1, 'onyx:m', [], ['a']),
				snapshot(2, 'onyx:m', [], ['a', 'b']),
				snapshot(3, 'onyx:m', [], ['a', 'b', 'c']),
				{ kind: 'outcome', data: { status: 'completed' } },
			];
			const sections = diffRuns(record('a', 'onyx:m', [...events]), record('b', 'onyx:m', [...events]));
			assert.deepStrictEqual(sections.map(section => section.kind === 'elision' ? `elision:${section.turns}` : section.kind), ['meta', 'elision:3', 'outcome']);
		});
	});

	suite('compute ledger', () => {

		test('samples accumulate and derived numbers follow the totals', () => {
			let entry = emptyLedgerEntry('localhost:11434/qwen2.5-coder:7b');
			entry = addSample(entry, { modelKey: 'k', promptTokens: 400, completionTokens: 100, generationMs: 2000, timeToFirstTokenMs: 300, failed: false, parameterB: 7 });
			entry = addSample(entry, { modelKey: 'k', promptTokens: 200, completionTokens: 100, generationMs: 2000, timeToFirstTokenMs: 500, failed: true, parameterB: 7 });
			entry = addOutcome(entry, true);
			entry = addOutcome(entry, false);
			entry = addOutcome(entry, true);

			assert.deepStrictEqual(
				{ ...entry, ...summarize(entry) },
				{
					modelKey: 'localhost:11434/qwen2.5-coder:7b',
					requests: 2,
					failures: 1,
					promptTokens: 600,
					completionTokens: 200,
					generationMs: 4000,
					ttftMsTotal: 800,
					ttftSamples: 2,
					accepted: 2,
					rejected: 1,
					parameterB: 7,
					tokensPerSecond: 50,
					averageTtftMs: 400,
					acceptRate: 2 / 3,
					parameterSeconds: 28,
					totalTokens: 800,
				},
			);
		});

		test('ledgers merge per model, busiest first', () => {
			const stored = [{ ...emptyLedgerEntry('a'), requests: 1, completionTokens: 10 }, { ...emptyLedgerEntry('b'), requests: 5 }];
			const session = [{ ...emptyLedgerEntry('a'), requests: 9, completionTokens: 90 }];
			assert.deepStrictEqual(
				mergeLedgers(stored, session).map(e => [e.modelKey, e.requests, e.completionTokens]),
				[['a', 10, 100], ['b', 5, 0]],
			);
			assert.deepStrictEqual([formatCount(999), formatCount(1500), formatCount(2_500_000)], ['999', '1.5k', '2.5M']);
		});
	});

	suite('tool calls written as text', () => {

		const tools = ['repoSymbols', 'remember'];

		test('the shapes small models actually emit are recognized, prose is not', () => {
			assert.deepStrictEqual(
				[
					parseTextToolCall('{"name":"repoSymbols","parameters":{"query":"computeTotal"}}', tools),
					parseTextToolCall('```json\n{"name":"remember","arguments":{"note":"tabs"}}\n```', tools),
					parseTextToolCall('<tool_call>{"tool":"repoSymbols","args":{"query":"x"}}</tool_call>', tools),
					parseTextToolCall('{"type":"function","function":{"name":"repoSymbols","arguments":"{\\"query\\":\\"y\\"}"}}', tools),
					parseTextToolCall('{"name":"someOtherTool","parameters":{}}', tools),
					parseTextToolCall('Here is some JSON: {"name":"repoSymbols"} in a sentence.', tools),
					parseTextToolCall('The answer is 42.', tools),
				],
				[
					{ name: 'repoSymbols', parameters: { query: 'computeTotal' } },
					{ name: 'remember', parameters: { note: 'tabs' } },
					{ name: 'repoSymbols', parameters: { query: 'x' } },
					{ name: 'repoSymbols', parameters: { query: 'y' } },
					undefined,
					undefined,
					undefined,
				],
			);
		});

		test('only an envelope-shaped opening is withheld from the transcript', () => {
			assert.deepStrictEqual(
				['', '{', '``', '```js', '<tool', 'The ', 'x'.repeat(5000)].map(couldBeToolEnvelope),
				[true, true, true, true, true, false, false],
			);
		});

		test('a failed tool reports a reason short enough for a timeline row', () => {
			// Found live: two editFile calls failed against a real model and the
			// only trace was a red "RESULT editFile" with no reason, while the
			// transcript still read "Staging an edit to src/cart.ts". The
			// tools already answer in plain language — this is what gets shown.
			assert.deepStrictEqual([
				shortReason('Error: none of the search text was found in src/cart.ts'),
				shortReason('first line\nsecond line'),
				shortReason(`Error: ${'x'.repeat(400)}`).length,
			], [
				'none of the search text was found in src/cart.ts',
				'first line',
				160,
			]);
		});

		test('a constrained envelope survives the repair path so the grammar is scored honestly', () => {
			// Found live against qwen2.5-coder:7b: the runtime's grammar produced
			// a perfect envelope, the repair path recognized `tool` as a tool
			// name and consumed it, and the agent loop then judged the
			// constrained turn on the empty prose that was left — logging
			// "did not match the envelope" and counting a constrained failure
			// for a turn that worked. `raw` is what the loop must judge.
			const stream = new OnyxAssistantTextStream(tools, () => { });
			for (const chunk of ['{"action":"tool","tool":"repo', 'Symbols","arguments":{"query":"applyDiscount"}}']) {
				stream.append(chunk);
			}
			const result = stream.finish();
			assert.deepStrictEqual({
				text: result.text,
				raw: result.raw,
				envelope: parseToolEnvelope(result.raw, tools),
				envelopeFromLeftoverProse: parseToolEnvelope(result.text, tools).kind,
			}, {
				text: '',
				raw: '{"action":"tool","tool":"repoSymbols","arguments":{"query":"applyDiscount"}}',
				envelope: { kind: 'tool', name: 'repoSymbols', parameters: { query: 'applyDiscount' } },
				envelopeFromLeftoverProse: 'invalid',
			});
		});

		test('prose streams through; a mis-channelled call never reaches the transcript', () => {
			const prose: string[] = [];
			const proseStream = new OnyxAssistantTextStream(tools, text => prose.push(text));
			for (const chunk of ['The ', 'answer ', 'is 42.']) {
				proseStream.append(chunk);
			}
			const proseResult = proseStream.finish();

			const emitted: string[] = [];
			const callStream = new OnyxAssistantTextStream(tools, text => emitted.push(text));
			for (const chunk of ['{"name":"repo', 'Symbols","parameters":', '{"query":"computeTotal"}}']) {
				callStream.append(chunk);
			}
			const callResult = callStream.finish();

			assert.deepStrictEqual(
				{ prose, proseText: proseResult.text, proseCall: proseResult.toolCall, emitted, callText: callResult.text, call: callResult.toolCall },
				{
					prose: ['The ', 'answer ', 'is 42.'],
					proseText: 'The answer is 42.',
					proseCall: undefined,
					emitted: [],
					callText: '',
					call: { name: 'repoSymbols', parameters: { query: 'computeTotal' } },
				},
			);
		});
	});

	suite('quick actions', () => {

		test('prompts carry the location, the diagnostics and a bounded snippet', () => {
			const fix = buildFixPrompt({ path: 'a.ts', line: 12, diagnostics: ['Type error'], snippet: 'x'.repeat(5000) });
			const explain = buildExplainPrompt({ path: 'a.ts', startLine: 3, endLine: 9, snippet: 'const a = 1;' });
			assert.deepStrictEqual(
				{
					fixHasLocation: fix.includes('a.ts:12'),
					fixHasDiagnostic: fix.includes('- Type error'),
					fixTruncates: fix.includes('… snippet truncated …'),
					explainHasRange: explain.includes('a.ts:3-9'),
					explainHasSnippet: explain.includes('const a = 1;'),
				},
				{ fixHasLocation: true, fixHasDiagnostic: true, fixTruncates: true, explainHasRange: true, explainHasSnippet: true },
			);
		});
	});
});
