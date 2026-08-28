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
import { extractJsonObject, parseReviewFindings } from '../../common/onyxReview.js';
import { couldBeToolEnvelope, OnyxAssistantTextStream, parseTextToolCall } from '../../common/onyxTextToolCalls.js';

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
