/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { runWithFakedTimers } from '../../../../../base/test/common/timeTravelScheduler.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IOnyxLabHarnessRequest } from '../../../../../platform/onyxRuntime/common/onyxRuntime.js';
import { anchorEditSchema, buildAnchorOffer, ONYX_ANCHOR_LIMITS, resolveAnchorEdit, shownFiles } from '../../common/onyxAnchorEdit.js';
import { buildToolEnvelopeFormat, parseToolEnvelope } from '../../common/onyxConstrainedToolCalls.js';
import { IOnyxPromptEvidence, IOnyxTraceCertificate } from '../../common/onyxEditCertificate.js';
import { validateToolArguments } from '../../common/onyxToolArguments.js';
import { OnyxSimEpisode, SIM_FILES, SIM_TARGET_FILE } from './sim/onyxSimEpisode.js';
import { IOnyxSimResult, IOnyxSimRigOptions, OnyxSimRig } from './sim/onyxSimRig.js';

/**
 * R-47 (L7): constrained anchors. The pure half is the enumeration and how
 * an anchor pair resolves. The service half runs the real loop in the rig
 * against a runtime that is told a schema and does not enforce it: the
 * scripted model sends whatever it likes, which is the worst a runtime can
 * do, and the harness has to hold on its own.
 */
suite('OnyxAnchorEdit', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const MATH = SIM_FILES['src/math.ts'];
	const READ = ['src/math.ts (lines 1-11 of 12)', ...MATH.split('\n').slice(0, 11).map((line, index) => line === '' ? `${index + 1}|` : `${index + 1}| ${line}`)].join('\n');
	const evidence = (...reads: string[]): IOnyxPromptEvidence => ({ turn: 2, truncated: false, segments: [{ index: 0, source: 'user', text: 'Swap the operands.' }, ...reads.map((text, index) => ({ index: index + 1, source: 'tool-result' as const, tool: 'readFile', text }))] });

	test('R-47: the enumeration is the lines the model was shown this turn: a line by its text, a line shown more than once in its file by its number, blank lines not at all; over the bound there is none', () => {
		const offered = buildAnchorOffer(shownFiles(evidence(READ)));
		const big = ['big.ts (lines 1-500 of 500)', ...Array.from({ length: 500 }, (_, index) => `${index + 1}| const value${index} = ${index};`)].join('\n');
		const tooLarge = buildAnchorOffer(shownFiles(evidence(big)));
		const schema = offered.kind === 'offer' ? anchorEditSchema(offered.offer) : undefined;
		const check = (edit: object) => validateToolArguments(schema, edit).length === 0;
		assert.deepStrictEqual({
			offer: offered.kind === 'offer' ? { paths: offered.offer.paths, anchors: offered.offer.anchors } : offered.kind,
			nothingRead: buildAnchorOffer(shownFiles(evidence())).kind,
			tooLarge: tooLarge.kind === 'too-large' ? { anchors: tooLarge.anchors, overTheBound: tooLarge.anchors > ONYX_ANCHOR_LIMITS.maxAnchors } : tooLarge.kind,
			onTheList: check({ path: 'src/math.ts', startAnchor: '\treturn a + b;', endAnchor: '3| }', replace: 'x' }),
			invented: check({ path: 'src/math.ts', startAnchor: '\treturn a - b;', endAnchor: '3| }', replace: 'x' }),
			duplicatedWithoutItsNumber: check({ path: 'src/math.ts', startAnchor: '}', endAnchor: '}', replace: 'x' }),
			anotherFile: check({ path: 'src/util.ts', startAnchor: '\treturn a + b;', endAnchor: '\treturn a + b;', replace: 'x' }),
			// The envelope a runtime is given carries the enumeration, and an `edit` action reads as a call of the edit tool.
			envelopeOffersEdit: JSON.stringify(buildToolEnvelopeFormat([{ name: 'editFile' }], schema)).includes('"enum":["tool","answer","edit"]'),
			envelopeWithoutAnOffer: JSON.stringify(buildToolEnvelopeFormat([{ name: 'editFile' }])).includes('"edit"'),
			parsed: parseToolEnvelope('{"action":"edit","edit":{"path":"src/math.ts","startAnchor":"3| }","endAnchor":"3| }","replace":"};"}}', ['editFile']),
		}, {
			offer: {
				paths: ['src/math.ts'],
				anchors: [
					'export function addNumbers(a: number, b: number): number {', '\treturn a + b;', '3| }',
					'export function multiply(a: number, b: number): number {', '\treturn a * b;', '7| }',
					'export function total(values: number[]): number {', '\treturn values.reduce((sum, value) => addNumbers(sum, value), 0);', '11| }',
				],
			},
			nothingRead: 'none',
			tooLarge: { anchors: 500, overTheBound: true },
			onTheList: true, invented: false, duplicatedWithoutItsNumber: false, anotherFile: false,
			envelopeOffersEdit: true, envelopeWithoutAnOffer: false,
			parsed: { kind: 'tool', name: 'editFile', parameters: { path: 'src/math.ts', startAnchor: '3| }', endAnchor: '3| }', replace: '};' } },
		});
	});

	test('R-47: an anchor pair resolves only when each anchor is exactly one line of the file as it is, in order: a line that is not there, a duplicated line, reversed anchors and a numbered line that has changed are refused with the reason', () => {
		const outcome = (start: string, end: string, replace = 'NEW') => {
			const resolved = resolveAnchorEdit(MATH, start, end, replace);
			return resolved.ok ? `lines ${resolved.startLine}-${resolved.endLine}` : resolved.reason;
		};
		const replaced = resolveAnchorEdit(MATH, '\treturn a * b;', '7| }', '\treturn b * a;\n} // closed');
		assert.deepStrictEqual({
			oneLine: outcome('\treturn a + b;', '\treturn a + b;'),
			aRange: outcome('export function multiply(a: number, b: number): number {', '7| }'),
			byNumber: outcome('3| }', '3| }'),
			proposed: replaced.ok ? replaced.proposed.split('\n').slice(4, 8) : undefined,
			deletion: (() => { const resolved = resolveAnchorEdit('a\nb\nc', 'b', 'b', ''); return resolved.ok ? resolved.proposed : undefined; })(),
			notThere: outcome('\treturn a - b;', '3| }'),
			duplicated: outcome('}', '}'),
			reversed: outcome('7| }', '\treturn a + b;'),
			numberedButChanged: outcome('3| };', '3| };'),
			pastTheEnd: outcome('99| }', '99| }'),
			indentationIsNotIgnored: outcome('return a + b;', 'return a + b;'),
		}, {
			oneLine: 'lines 2-2',
			aRange: 'lines 5-7',
			byNumber: 'lines 3-3',
			proposed: ['export function multiply(a: number, b: number): number {', '\treturn b * a;', '} // closed', ''],
			deletion: 'a\nc',
			notThere: 'the startAnchor is not a line of the file. Read the file again and choose a line as it is.',
			duplicated: 'the startAnchor is duplicated: that text is on lines 3, 7, 11. Give it with its number, as "3| }".',
			reversed: 'the anchors are reversed: the startAnchor is line 7 and the endAnchor is line 2. The startAnchor is the first line to replace.',
			numberedButChanged: 'the startAnchor names line 3, and line 3 of the file is not that text. Read the file again.',
			pastTheEnd: 'the startAnchor names line 99, and line 99 of the file is not that text. Read the file again.',
			indentationIsNotIgnored: 'the startAnchor is not a line of the file. Read the file again and choose a line as it is.',
		});
	});

	// --- through the real loop ------------------------------------------------

	const ANCHORS: IOnyxLabHarnessRequest = { manifest: '2026-11-21-anchors', name: 'constrained-anchors', configuration: { editProtocol: 'constrained-anchors' } };
	/** A model whose turns are constrained, on a runtime measured to enforce a schema. */
	const MEASURED = { runtimeEnforcesSchema: true, provenance: { toolCallQuality: 'measured', contextLength: 'default', schemaEnforcement: 'measured' } } as const;

	function episode(name: string, edit: Record<string, unknown>, extra: Partial<OnyxSimEpisode> = {}): OnyxSimEpisode {
		return {
			name, seed: 0, persona: 'well-behaved', prompt: 'Swap the operands in addNumbers.', files: SIM_FILES, target: SIM_TARGET_FILE, dialogDefault: 'allow-once', userSteps: [], faults: [], constrained: true, profile: MEASURED,
			turns: [
				{ kind: 'toolCall', tool: 'readFile', arguments: { path: 'src/math.ts' }, id: 'read_1' },
				{ kind: 'toolCall', tool: 'editFile', arguments: edit, id: 'edit_1' },
				{ kind: 'text', text: 'Done.' },
			],
			...extra,
		};
	}

	async function run(script: OnyxSimEpisode, options: IOnyxSimRigOptions = { labHarness: { request: ANCHORS, packaged: false } }): Promise<IOnyxSimResult> {
		return runWithFakedTimers({ useFakeTimers: true, maxTaskCount: 400_000 }, async () => {
			const rig = new OnyxSimRig(script, [], options);
			try {
				return await rig.run();
			} finally {
				await rig.dispose();
			}
		});
	}

	interface IEntry { readonly kind: string; readonly data: { readonly label?: string; readonly reason?: string; readonly ok?: boolean } }
	const entries = (result: IOnyxSimResult): IEntry[] => result.journal.split('\n').filter(line => line.trim()).map(line => JSON.parse(line) as IEntry);
	const notes = (result: IOnyxSimResult) => entries(result).filter(entry => entry.kind === 'note' && /anchor/i.test(entry.data.label ?? '')).map(entry => entry.data.label);
	const editResult = (result: IOnyxSimResult) => result.toolResults.filter(tool => tool.toolId === 'onyx_editFile').map(tool => tool.text.replace(/ The user reviews.*$/, ''));
	/** Whether the request of a turn was to be decoded against a schema that offers the `edit` action. */
	const offersEdit = (result: IOnyxSimResult, turn: number) => JSON.stringify(result.requests[turn - 1]?.responseFormat ?? null).includes('"startAnchor"');
	const summary = (result: IOnyxSimResult) => ({
		offeredOnTurns: result.requests.map((_, index) => offersEdit(result, index + 1)),
		dispatched: result.toolResults.map(tool => tool.toolId.replace('onyx_', '')),
		edit: editResult(result),
		staged: result.stagedPaths.length,
		notes: notes(result),
		violations: result.violations,
	});

	test('R-47: with the protocol on and the runtime measured to enforce a schema, the turn after a read is decoded against the enumeration of the lines read, and an edit that names two of them is staged as those lines, with a certificate that says how', async () => {
		const result = await run(episode('anchors-staged', { path: 'src/math.ts', startAnchor: '\treturn a + b;', endAnchor: '3| }', replace: '\treturn b + a;\n}' }));
		const certificate = result.journal.split('\n').filter(line => line.includes('"editCertificate"')).map(line => (JSON.parse(line) as { data: IOnyxTraceCertificate }).data.certificate)[0];
		assert.deepStrictEqual({ ...summary(result), certificate: { protocol: certificate?.protocol, grounding: certificate?.grounding, lines: certificate?.anchor?.lines, matchCount: certificate?.anchor?.matchCount } }, {
			// Turn 1 has read nothing yet; from turn 2 on the read result is in the prompt.
			offeredOnTurns: [false, true, true],
			dispatched: ['readFile', 'editFile'],
			edit: ['Staged an edit of lines 2 to 3 of src/math.ts (+1 −1).'],
			staged: 1,
			notes: ['Constrained anchors are on (experimental)'],
			violations: [],
			certificate: { protocol: 'constrained-anchors', grounding: 'grounded', lines: 2, matchCount: 1 },
		});
	});

	test('R-47: a model that sends an anchor that is not on the list is answered and the edit tool is never called; a duplicated anchor and reversed anchors are refused with the reason; nothing is staged in any of the three', async () => {
		const invented = await run(episode('anchors-invented', { path: 'src/math.ts', startAnchor: '\treturn a - b;', endAnchor: '3| }', replace: 'x' }));
		// `}` is on three lines of the file and the list holds it only with its number, so the plain form is not on the list either.
		const duplicatedOffList = await run(episode('anchors-duplicated', { path: 'src/math.ts', startAnchor: '}', endAnchor: '}', replace: '};' }));
		// A line that was read once and is twice in the file: only lines 1 to 3 were read, and line 7 is `}` too.
		const duplicatedInFile = await run(episode('anchors-duplicated-in-file', { path: 'src/math.ts', startAnchor: '}', endAnchor: '}', replace: '};' }, {
			turns: [
				{ kind: 'toolCall', tool: 'readFile', arguments: { path: 'src/math.ts', startLine: 1, endLine: 3 }, id: 'read_1' },
				{ kind: 'toolCall', tool: 'editFile', arguments: { path: 'src/math.ts', startAnchor: '}', endAnchor: '}', replace: '};' }, id: 'edit_1' },
				{ kind: 'text', text: 'Done.' },
			],
		}));
		const reversed = await run(episode('anchors-reversed', { path: 'src/math.ts', startAnchor: '7| }', endAnchor: '\treturn a + b;', replace: 'x' }));
		const refusal = (result: IOnyxSimResult) => ({ dispatched: result.toolResults.map(tool => tool.toolId.replace('onyx_', '')), edit: editResult(result), staged: result.stagedPaths.length, violations: result.violations });
		assert.deepStrictEqual({ invented: refusal(invented), duplicatedOffList: refusal(duplicatedOffList), duplicatedInFile: refusal(duplicatedInFile), reversed: refusal(reversed) }, {
			invented: { dispatched: ['readFile'], edit: [], staged: 0, violations: [] },
			duplicatedOffList: { dispatched: ['readFile'], edit: [], staged: 0, violations: [] },
			duplicatedInFile: { dispatched: ['readFile', 'editFile'], edit: ['Error: Edit refused for src/math.ts: the startAnchor is duplicated: that text is on lines 3, 7, 11. Give it with its number, as "3| }". Nothing was staged.'], staged: 0, violations: [] },
			reversed: { dispatched: ['readFile', 'editFile'], edit: ['Error: Edit refused for src/math.ts: the anchors are reversed: the startAnchor is line 7 and the endAnchor is line 2. The startAnchor is the first line to replace. Nothing was staged.'], staged: 0, violations: [] },
		});
	});

	test('R-47: without measured enforcement, or without constrained decoding, the protocol is unavailable and the run says so; when more was read than the enumeration holds, that turn falls back to search and replace and says so; by default nothing of it exists', async () => {
		const edit = { path: 'src/math.ts', startAnchor: '\treturn a + b;', endAnchor: '\treturn a + b;', replace: '\treturn b + a;' };
		const notMeasured = await run(episode('anchors-not-measured', edit, { profile: {} }));
		const notConstrained = await run(episode('anchors-not-constrained', edit, { constrained: false }));
		// Two reads of 150 long lines each: either fits the enumeration, both together do not.
		const big = (name: string) => Array.from({ length: 150 }, (_, index) => `export const ${name}${index} = '${'x'.repeat(70)}';`).join('\n');
		const oversized = await run(episode('anchors-oversized', {}, {
			files: { ...SIM_FILES, 'one.ts': big('one'), 'two.ts': big('two') },
			turns: [
				{ kind: 'toolCall', tool: 'readFile', arguments: { path: 'one.ts' }, id: 'read_1' },
				{ kind: 'toolCall', tool: 'readFile', arguments: { path: 'two.ts' }, id: 'read_2' },
				{ kind: 'toolCall', tool: 'editFile', arguments: { path: 'two.ts', search: `export const two7 = '${'x'.repeat(70)}';`, replace: 'export const two7 = 7;' }, id: 'edit_1' },
				{ kind: 'text', text: 'Done.' },
			],
		}));
		const byDefault = await run(episode('anchors-default', edit), {});
		assert.deepStrictEqual({ notMeasured: summary(notMeasured), notConstrained: summary(notConstrained), oversized: summary(oversized), byDefault: summary(byDefault) }, {
			notMeasured: {
				offeredOnTurns: [false, false, false], dispatched: ['readFile'], edit: [], staged: 0,
				notes: ['Constrained anchors are unavailable; edits use search and replace'], violations: [],
			},
			notConstrained: {
				offeredOnTurns: [false, false, false], dispatched: ['readFile'], edit: [], staged: 0,
				notes: ['Constrained anchors are unavailable; edits use search and replace'], violations: [],
			},
			oversized: {
				// After the first read the enumeration is on offer; after the second there is too much.
				offeredOnTurns: [false, true, false, false], dispatched: ['readFile', 'readFile', 'editFile'], edit: ['Staged 1 edit(s) to two.ts (+1 −1).'], staged: 1,
				notes: ['Constrained anchors are on (experimental)', 'Anchored edits are not on offer this turn; search and replace is used', 'Anchored edits are not on offer this turn; search and replace is used'], violations: [],
			},
			byDefault: { offeredOnTurns: [false, false, false], dispatched: ['readFile'], edit: [], staged: 0, notes: [], violations: [] },
		});
	});
});
