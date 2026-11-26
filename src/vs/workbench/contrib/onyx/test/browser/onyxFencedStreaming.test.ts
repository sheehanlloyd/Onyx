/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { findUnexecutedToolCall, OnyxAssistantTextStream, parseTrailingToolCall } from '../../common/onyxTextToolCalls.js';

/**
 * C5, R-27: what is withheld from the transcript while a reply streams. A
 * reply is withheld only while it can still be a tool call the model wrote
 * as text. A code fence that is not JSON is prose and streams at once; so
 * does JSON that is not a call. A call in progress is withheld to its end,
 * however long it is, so that it runs instead of being shown.
 */

const TOOLS = ['repoSymbols', 'editFile', 'terminal'];

/** Feeds `text` in chunks of `size` and reports what had been shown after each chunk, and how it ended. */
function stream(text: string, size = 8) {
	let shown = 0;
	const assistant = new OnyxAssistantTextStream(TOOLS, emitted => { shown += emitted.length; });
	const shownAfter: number[] = [];
	for (let offset = 0; offset < text.length; offset += size) {
		assistant.append(text.slice(offset, offset + size));
		shownAfter.push(shown);
	}
	const shownBeforeTheEnd = shown;
	const result = assistant.finish();
	return {
		// How many characters had arrived when the first one was shown; undefined when nothing was shown before the end.
		firstShownAfter: shownAfter.findIndex(count => count > 0) === -1 ? undefined : (shownAfter.findIndex(count => count > 0) + 1) * size,
		shownBeforeTheEnd,
		everythingShown: result.text === text && shown === text.length,
		call: result.toolCall?.name,
	};
}

suite('OnyxFencedStreaming', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('R-27: a reply that opens with a code fence streams as soon as the fence is seen not to be JSON', () => {
		const typescript = '```ts\nexport function total(values: number[]): number {\n\treturn values.reduce((sum, value) => sum + value, 0);\n}\n```\nThat is the function.';
		const python = '```python\nprint("hello")\n```';
		const noLanguage = '```\nplain text inside a fence, nothing to call\n```';
		const jsonArray = '```json\n[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]\n```';
		// Chunks of eight characters. "```ts\nex" already shows a fence that is not JSON; "```pytho" cannot
		// become "```json"; a JSON fence is decided by the first character after its first line.
		assert.deepStrictEqual({
			typescript: stream(typescript),
			python: stream(python),
			noLanguage: stream(noLanguage),
			jsonThatIsAnArray: stream(jsonArray),
		}, {
			typescript: { firstShownAfter: 8, shownBeforeTheEnd: typescript.length, everythingShown: true, call: undefined },
			python: { firstShownAfter: 8, shownBeforeTheEnd: python.length, everythingShown: true, call: undefined },
			noLanguage: { firstShownAfter: 8, shownBeforeTheEnd: noLanguage.length, everythingShown: true, call: undefined },
			jsonThatIsAnArray: { firstShownAfter: 16, shownBeforeTheEnd: jsonArray.length, everythingShown: true, call: undefined },
		});
	});

	test('a tool call written as text is withheld to its end and run, however long it is; JSON that is not a call streams once that is clear', () => {
		const longReplace = 'x'.repeat(1500);
		const longCall = `{"tool":"editFile","arguments":{"path":"src/math.ts","search":"return a + b;","replace":"${longReplace}"}}`;
		const fencedCall = '```json\n{"name":"repoSymbols","parameters":{"query":"total"}}\n```';
		const packageJson = '{"name":"my-package","version":"1.0.0","description":"not a tool call, a package manifest the model is quoting"}';
		const plainObject = '{"answer": 42, "why": "because the user asked for JSON and this is JSON, not a call"}';
		const undecided = `{${' '.repeat(600)}"tool":"terminal"}`;
		assert.deepStrictEqual({
			longCall: stream(longCall),
			fencedCall: stream(fencedCall),
			wrappedCall: stream('<tool_call>{"name":"terminal","arguments":{"command":"npm test"}}</tool_call>'),
			packageJson: stream(packageJson),
			plainObject: stream(plainObject),
			// Nothing decides it within four hundred characters: it is shown rather than held on a guess.
			undecided: { firstShownAfter: stream(undecided).firstShownAfter, call: stream(undecided).call },
		}, {
			longCall: { firstShownAfter: undefined, shownBeforeTheEnd: 0, everythingShown: false, call: 'editFile' },
			fencedCall: { firstShownAfter: undefined, shownBeforeTheEnd: 0, everythingShown: false, call: 'repoSymbols' },
			wrappedCall: { firstShownAfter: undefined, shownBeforeTheEnd: 0, everythingShown: false, call: 'terminal' },
			// `"name":"my-` is already not the name of any tool on offer.
			packageJson: { firstShownAfter: 16, shownBeforeTheEnd: packageJson.length, everythingShown: true, call: undefined },
			plainObject: { firstShownAfter: 16, shownBeforeTheEnd: plainObject.length, everythingShown: true, call: undefined },
			undecided: { firstShownAfter: 408, call: undefined },
		});
	});
	test('a tool call written as JSON after prose is run and not shown; JSON in an answer that is not a call is shown and not run (2026-11-26)', () => {
		const tools = ['readFile', 'editFile', 'terminal'];
		const run = (text: string, size = 7) => {
			let shown = '';
			const assistant = new OnyxAssistantTextStream(tools, emitted => { shown += emitted; });
			for (let offset = 0; offset < text.length; offset += size) {
				assistant.append(text.slice(offset, offset + size));
			}
			const result = assistant.finish();
			return { shown, call: result.toolCall ? `${result.toolCall.name} ${JSON.stringify(result.toolCall.parameters)}` : undefined };
		};
		const prose = 'Understood! Let\'s read the file and find the correct lines to replace.\n\n';
		assert.deepStrictEqual({
			// What the 7B wrote in the trial: prose, then a call as JSON on a line of its own.
			afterProse: run(`${prose}{"name": "readFile", "arguments": {"path": "src/math.ts"}}`),
			// The same reply arriving in one chunk, as a runtime that buffers sends it.
			inOneChunk: run(`${prose}{"name": "readFile", "arguments": {"path": "src/math.ts"}}`, 10_000),
			fenced: run(`${prose}\`\`\`json\n{"name": "readFile", "arguments": {"path": "src/math.ts"}}\n\`\`\``),
			openAiShape: run(`${prose}{"type": "function", "function": {"name": "readFile", "arguments": "{\\"path\\": \\"src/math.ts\\"}"}}`),
			// Not calls, and shown as they are.
			packageJson: run('The manifest should read:\n\n{"name": "my-app", "version": "1.0.0"}'),
			aToolNotOnOffer: run(`${prose}{"name": "deleteFile", "arguments": {"path": "src/math.ts"}}`),
			extraKeys: run(`${prose}{"name": "readFile", "arguments": {"path": "a"}, "note": "an example"}`),
			notAtTheEnd: run(`${prose}{"name": "readFile", "arguments": {"path": "a"}}\n\nThat is how a call looks.`),
			argumentsNotAnObject: run(`${prose}{"name": "readFile", "arguments": ["a"]}`),
			codeFence: run('Here it is:\n\n\`\`\`ts\nconst x = { a: 1 };\n\`\`\`'),
		}, {
			afterProse: { shown: prose, call: 'readFile {"path":"src/math.ts"}' },
			inOneChunk: { shown: prose, call: 'readFile {"path":"src/math.ts"}' },
			fenced: { shown: prose, call: 'readFile {"path":"src/math.ts"}' },
			openAiShape: { shown: prose, call: 'readFile {"path":"src/math.ts"}' },
			packageJson: { shown: 'The manifest should read:\n\n{"name": "my-app", "version": "1.0.0"}', call: undefined },
			aToolNotOnOffer: { shown: `${prose}{"name": "deleteFile", "arguments": {"path": "src/math.ts"}}`, call: undefined },
			extraKeys: { shown: `${prose}{"name": "readFile", "arguments": {"path": "a"}, "note": "an example"}`, call: undefined },
			notAtTheEnd: { shown: `${prose}{"name": "readFile", "arguments": {"path": "a"}}\n\nThat is how a call looks.`, call: undefined },
			argumentsNotAnObject: { shown: `${prose}{"name": "readFile", "arguments": ["a"]}`, call: undefined },
			codeFence: { shown: 'Here it is:\n\n\`\`\`ts\nconst x = { a: 1 };\n\`\`\`', call: undefined },
		});
		assert.deepStrictEqual({
			trailing: parseTrailingToolCall('Reading it. {"tool": "readFile", "arguments": {"path": "a"}}', tools)?.prose,
			unexecutedNamed: findUnexecutedToolCall('I will call {"name": "readFile", "arguments": {"path": "a"}} and then edit.', tools),
			unexecutedEnvelope: findUnexecutedToolCall('{"action":"tool","tool":"terminal","arguments":{"command":"ls"}}', tools),
			notACall: findUnexecutedToolCall('Use {"name": "my-app"} in package.json.', tools),
			noArguments: findUnexecutedToolCall('The readFile tool: {"name": "readFile"}.', tools),
		}, { trailing: 'Reading it.', unexecutedNamed: 'readFile', unexecutedEnvelope: 'terminal', notACall: undefined, noArguments: undefined });
	});
});
