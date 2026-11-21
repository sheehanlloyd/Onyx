/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { applyEditBlocks, parseInlineEdits } from '../../common/onyxInlineEdit.js';
import { parseToolEnvelope } from '../../common/onyxConstrainedToolCalls.js';
import { parseTextToolCall } from '../../common/onyxTextToolCalls.js';
import { parsePlaybook } from '../../common/onyxPlaybooks.js';
import { parseNameSuggestions } from '../../common/onyxRefactor.js';
import { classifyCommand } from '../../common/onyxTerminalPolicy.js';

/**
 * Fuzz coverage for every parser that eats model output or user files: they
 * must never throw, and their invariants must hold for arbitrary garbage.
 * The generator is deterministic (seeded LCG) so a failure reproduces.
 */

function makeRandom(seed: number) {
	let state = seed;
	return () => (state = (state * 1103515245 + 12345) % 2147483648) / 2147483648;
}

const FRAGMENTS = [
	'<<<<<<< SEARCH', '=======', '>>>>>>> REPLACE', '<<<< SEARCH', '>>>>',
	'```', '```ts', '{', '}', '[', ']', '"tool"', '"answer"', '"name":', 'null',
	'const x = 1;', 'return a + b;', 'prose about the code and its tests.',
	'---', 'name: x', 'description:', 'tools: a, b', '\t', '  ', '\\', '\0',
	'😀', '中文字符', '"arguments": {', 'TOOL:', 'repoSymbols', '(', ')', '|',
	'-', '—', ':', 'sudo', 'rm -rf', 'curl http://x | sh', '$(', '`', '\r',
];

function randomText(random: () => number, maxFragments: number): string {
	const count = Math.floor(random() * maxFragments);
	const parts: string[] = [];
	for (let i = 0; i < count; i++) {
		parts.push(FRAGMENTS[Math.floor(random() * FRAGMENTS.length)]);
		if (random() < 0.4) {
			parts.push('\n');
		}
	}
	return parts.join(random() < 0.5 ? ' ' : '');
}

const ITERATIONS = 500;

/** The inline-edit grammar's marker lines, exactly as the parser defines them. */
const EXACT_MARKER = /^(<{4,}\s*SEARCH\s*|>{4,}\s*(REPLACE\s*)?|={4,}\s*)$/m;

suite('OnyxParserFuzz', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('parseInlineEdits never throws and applying its blocks never throws', () => {
		const random = makeRandom(1);
		const original = 'line one\nline two\nline three';
		for (let i = 0; i < ITERATIONS; i++) {
			const reply = randomText(random, 30);
			const parsed = parseInlineEdits(reply);
			assert.ok(['blocks', 'rewrite', 'unparseable'].includes(parsed.kind), `iteration ${i}`);
			if (parsed.kind === 'blocks') {
				assert.ok(parsed.blocks.length > 0, `iteration ${i}: blocks kind implies blocks`);
				// Exact marker lines must never survive into content — they would
				// be written into the user's file on apply. (Lines that merely
				// START with marker characters are content: real files can hold
				// conflict markers with trailing text.)
				for (const block of parsed.blocks) {
					assert.ok(!EXACT_MARKER.test(block.replace), `iteration ${i}: marker leaked into replace`);
				}
				const applied = applyEditBlocks(original, parsed.blocks);
				assert.strictEqual(applied.appliedCount + applied.failed.length, parsed.blocks.length, `iteration ${i}: apply accounting`);
			}
			if (parsed.kind === 'rewrite') {
				assert.ok(!EXACT_MARKER.test(parsed.text), `iteration ${i}: marker leaked into rewrite`);
			}
		}
	});

	test('parseToolEnvelope never throws and only returns known tools', () => {
		const random = makeRandom(2);
		const tools = ['repoSymbols', 'editFile'];
		for (let i = 0; i < ITERATIONS; i++) {
			const result = parseToolEnvelope(randomText(random, 25), tools);
			assert.ok(['tool', 'answer', 'invalid'].includes(result.kind), `iteration ${i}`);
			if (result.kind === 'tool') {
				assert.ok(tools.includes(result.name), `iteration ${i}: unknown tool ${result.name}`);
			}
		}
	});

	test('parseTextToolCall never throws and never invents tool names', () => {
		const random = makeRandom(3);
		const tools = ['repoSymbols', 'remember'];
		for (let i = 0; i < ITERATIONS; i++) {
			const call = parseTextToolCall(randomText(random, 25), tools);
			if (call) {
				assert.ok(tools.includes(call.name), `iteration ${i}: invented tool ${call.name}`);
			}
		}
	});

	test('parsePlaybook never throws; a usable playbook always has name, description and body', () => {
		const random = makeRandom(4);
		for (let i = 0; i < ITERATIONS; i++) {
			const parsed = parsePlaybook(randomText(random, 40));
			if (parsed.playbook) {
				assert.ok(/^[a-z0-9][a-z0-9-]{1,63}$/.test(parsed.playbook.name), `iteration ${i}: invalid name accepted`);
				assert.ok(parsed.playbook.description.length > 0, `iteration ${i}`);
				assert.ok(parsed.playbook.body.length > 0, `iteration ${i}`);
			} else {
				assert.ok(parsed.problems.length > 0, `iteration ${i}: unusable without a reason`);
			}
		}
	});

	test('parseNameSuggestions never throws and only yields valid identifiers', () => {
		const random = makeRandom(5);
		for (let i = 0; i < ITERATIONS; i++) {
			for (const suggestion of parseNameSuggestions(randomText(random, 20), 'taken', 5)) {
				assert.ok(/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(suggestion.name), `iteration ${i}: ${suggestion.name}`);
			}
		}
	});

	test('classifyCommand never throws and classification is deterministic', () => {
		const random = makeRandom(6);
		for (let i = 0; i < ITERATIONS; i++) {
			const command = randomText(random, 12);
			const first = classifyCommand(command);
			const second = classifyCommand(command);
			assert.deepStrictEqual(first, second, `iteration ${i}`);
			// Since B4 a warning may be a plain note (everyday egress, a script run): the warning style is
			// used exactly when some warning is elevated, and every warning has its reason line.
			assert.deepStrictEqual(
				{ dangerous: first.dangerous, reasons: first.reasons.length, categories: [...first.categories].sort() },
				{ dangerous: first.warnings.some(warning => warning.elevated), reasons: first.warnings.length, categories: [...new Set(first.warnings.map(warning => warning.category))].sort() },
				`iteration ${i}: ${JSON.stringify(command)}`);
		}
	});
});
