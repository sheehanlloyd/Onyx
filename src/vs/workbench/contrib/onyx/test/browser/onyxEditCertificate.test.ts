/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { runWithFakedTimers } from '../../../../../base/test/common/timeTravelScheduler.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { describeCertificate } from '../../browser/changes/onyxChangesView.js';
import { certificateForHunk, certifiedEdit, certifyEdit, checkCertificates, groundAnchor, IOnyxEditCertificate, IOnyxPromptEvidence, IOnyxTraceCertificate, sealCertificate } from '../../common/onyxEditCertificate.js';
import { OnyxSimEpisode, SIM_FILES, SIM_TARGET_FILE } from './sim/onyxSimEpisode.js';
import { IOnyxSimResult, OnyxSimRig } from './sim/onyxSimRig.js';

/**
 * R-46 (L6): edit certificates. The pure half is what a certificate says and
 * how it is recomputed. The service half runs the real loop, edit tool and
 * change set in the simulation rig and reads the certificates out of the
 * run's journal, as a researcher would.
 */
suite('OnyxEditCertificate', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const READ = 'src/math.ts (lines 1-3 of 11)\n1| export function addNumbers(a: number, b: number): number {\n2| \treturn a + b;\n3| }';
	const evidence = (segments: IOnyxPromptEvidence['segments'], truncated = false): IOnyxPromptEvidence => ({ turn: 2, segments, truncated });

	test('R-46: an anchor is grounded when the model was sent its lines this turn by anything but itself; evicted, it is not; a prompt on record cut short proves nothing', () => {
		const user = { index: 1, source: 'user' as const, text: 'Swap the operands in addNumbers.' };
		const read = { index: 3, source: 'tool-result' as const, tool: 'readFile', text: READ };
		const ownWords = { index: 4, source: 'assistant' as const, text: 'I will change `\treturn a + b;` now.' };
		assert.deepStrictEqual({
			seenAsRead: groundAnchor('2| \treturn a + b;', evidence([user, read])),
			seenWithoutTheNumber: groundAnchor('\treturn a + b;', evidence([user, read])),
			twoLinesOneSegment: groundAnchor('export function addNumbers(a: number, b: number): number {\n\treturn a + b;', evidence([user, read])),
			// The read result was evicted before this turn; the model's own earlier words still quote the line.
			evicted: groundAnchor('\treturn a + b;', evidence([user, ownWords])),
			oneLineOfTwoInvented: groundAnchor('\treturn a + b;\n\treturn a - b;', evidence([user, read])),
			cutShort: groundAnchor('\treturn a + b;', evidence([user], true)),
			notOnRecord: groundAnchor('\treturn a + b;', undefined),
			nothingToLookFor: groundAnchor('  \n', evidence([user, read])),
		}, {
			seenAsRead: { grounding: 'grounded', provenance: { segment: 3, source: 'tool-result', tool: 'readFile', holdsEveryLine: true } },
			seenWithoutTheNumber: { grounding: 'grounded', provenance: { segment: 3, source: 'tool-result', tool: 'readFile', holdsEveryLine: true } },
			twoLinesOneSegment: { grounding: 'grounded', provenance: { segment: 3, source: 'tool-result', tool: 'readFile', holdsEveryLine: true } },
			evicted: { grounding: 'ungrounded', provenance: null },
			oneLineOfTwoInvented: { grounding: 'ungrounded', provenance: { segment: 3, source: 'tool-result', tool: 'readFile', holdsEveryLine: false } },
			cutShort: { grounding: 'unknown', provenance: null },
			notOnRecord: { grounding: 'unknown', provenance: null },
			nothingToLookFor: { grounding: 'not-applicable', provenance: null },
		});
	});

	test('R-46: a certificate says what was checked and is tied to its hunks; its seal changes with any of it; no line a reviewer reads calls it proof of anything', () => {
		const base = 'export function addNumbers(a: number, b: number): number {\n\treturn a + b;\n}\n';
		const certificate = certifyEdit({ path: 'src/math.ts', protocol: 'search-replace', call: 'edit_1', block: 0, base, baseVersionId: 4, search: '2| \treturn a + b;', matchCount: 1, evidence: evidence([{ index: 3, source: 'tool-result', tool: 'readFile', text: READ }]) });
		const newFile = certifyEdit({ path: 'notes.md', protocol: 'new-file', call: 'edit_2', block: 0, base: '', baseVersionId: null, search: '', matchCount: 0, evidence: undefined });
		const edits = [certifiedEdit(certificate, '\treturn a + b;', '\treturn b + a;')];
		const tampered: IOnyxEditCertificate[] = [
			{ ...certificate, grounding: 'ungrounded' },
			{ ...certificate, anchor: { ...certificate.anchor!, matchCount: 2 } },
			{ ...certificate, base: { ...certificate.base, contentHash: '00000000' } },
			{ ...certificate, path: 'src/other.ts' },
			{ ...certificate, provenance: null },
		];
		const everyLine = (['grounded', 'ungrounded', 'unknown'] as const).map(grounding => describeCertificate({ ...certificate, grounding }))
			.concat((['new-file', 'inline', 'whole-file'] as const).map(protocol => describeCertificate({ ...newFile, protocol })));
		assert.deepStrictEqual({
			certificate,
			newFile: { anchor: newFile.anchor, grounding: newFile.grounding, turn: newFile.turn },
			itsHunk: certificateForHunk(edits, { originalLines: ['\treturn a + b;'], newLines: ['\treturn b + a;'] }) === certificate,
			anotherHunk: certificateForHunk(edits, { originalLines: ['}'], newLines: ['};'] }),
			sealsDiffer: tampered.map(changed => sealCertificate(changed) !== sealCertificate(certificate)),
			lines: everyLine.map(line => line.text),
			readClosely: everyLine.map(line => line.readClosely),
			claimsMoreThanWasChecked: everyLine.filter(line => /proof|proven|prove|correct|safe|guarantee|verified|valid/i.test(line.text)).length,
		}, {
			certificate: {
				v: 1, path: 'src/math.ts', protocol: 'search-replace', turn: 2, call: 'edit_1', block: 0,
				base: { contentHash: '3916439b', versionId: 4 },
				anchor: { digest: '253e6c4f', lines: 1, matchCount: 1 },
				grounding: 'grounded',
				provenance: { segment: 3, source: 'tool-result', tool: 'readFile', holdsEveryLine: true },
			},
			newFile: { anchor: null, grounding: 'not-applicable', turn: null },
			itsHunk: true,
			anotherHunk: undefined,
			sealsDiffer: [true, true, true, true, true],
			lines: [
				'Anchored exactly once · seen this turn',
				'Anchored exactly once · not shown to the model this turn; read closely',
				'Anchored exactly once · what the model was shown is not on record',
				'New file · nothing existing was replaced',
				'From the lines you selected',
				'Whole-file proposal · no quoted text to place',
			],
			readClosely: [false, true, false, false, false, false],
			claimsMoreThanWasChecked: 0,
		});
	});

	function episode(name: string, turns: OnyxSimEpisode['turns'], extra: Partial<OnyxSimEpisode> = {}): OnyxSimEpisode {
		return { name, seed: 0, persona: 'well-behaved', prompt: 'Swap the operands in addNumbers.', files: SIM_FILES, target: SIM_TARGET_FILE, turns, dialogDefault: 'allow-once', userSteps: [], faults: [], ...extra };
	}

	async function run(script: OnyxSimEpisode): Promise<IOnyxSimResult> {
		return runWithFakedTimers({ useFakeTimers: true, maxTaskCount: 400_000 }, async () => {
			const rig = new OnyxSimRig(script);
			try {
				return await rig.run();
			} finally {
				await rig.dispose();
			}
		});
	}

	const certificatesIn = (journal: string): IOnyxTraceCertificate[] => journal.split('\n').filter(line => line.includes('"editCertificate"')).map(line => (JSON.parse(line) as { data: IOnyxTraceCertificate }).data);
	const outcomesIn = (journal: string) => journal.split('\n').filter(line => line.includes('"editCertificateOutcome"')).map(line => (JSON.parse(line) as { data: { verification: string; appliedContentHash: string | null } }).data);

	test('R-46: through the real loop, an edit that quotes a line the model read this run is certified as grounded in that read, the certificate is in the journal with its hunk, and it recomputes from the journal; after acceptance the journal says what became of it', async () => {
		const result = await run(episode('certificate-grounded', [
			{ kind: 'toolCall', tool: 'readFile', arguments: { path: 'src/util.ts' }, id: 'read_1' },
			{ kind: 'toolCall', tool: 'editFile', arguments: { path: 'src/util.ts', search: '2| \treturn Math.min(max, Math.max(min, value));', replace: '\treturn Math.max(min, Math.min(max, value));' }, id: 'edit_1' },
			{ kind: 'text', text: 'Staged one edit.' },
		], { userSteps: [{ at: 'afterRun', occurrence: 2, step: { kind: 'acceptAll' } }] }));
		const [entry] = certificatesIn(result.journal);
		const outcomes = outcomesIn(result.journal);
		assert.deepStrictEqual({
			count: certificatesIn(result.journal).length,
			protocol: entry.certificate.protocol, turn: entry.certificate.turn, call: entry.certificate.call,
			anchor: { lines: entry.certificate.anchor?.lines, matchCount: entry.certificate.anchor?.matchCount },
			grounding: entry.certificate.grounding,
			provenance: { source: entry.certificate.provenance?.source, tool: entry.certificate.provenance?.tool, holdsEveryLine: entry.certificate.provenance?.holdsEveryLine },
			hunks: entry.hunks,
			sealed: entry.seal === sealCertificate(entry.certificate),
			offline: checkCertificates(result.journal).map(check => `${check.verdict}: ${check.detail}`),
			afterAcceptance: { first: outcomes[0]?.verification, contentOnRecord: typeof outcomes[0]?.appliedContentHash === 'string' },
			violations: result.violations,
		}, {
			count: 1,
			protocol: 'search-replace', turn: 2, call: 'edit_1',
			anchor: { lines: 1, matchCount: 1 },
			grounding: 'grounded',
			provenance: { source: 'tool-result', tool: 'readFile', holdsEveryLine: true },
			hunks: ['g1.h1'],
			sealed: true,
			offline: ['matches: anchor, provenance and grounding recomputed from the journal'],
			afterAcceptance: { first: 'running', contentOnRecord: true },
			violations: [],
		});
	});

	test('R-46: an edit whose anchor was read and then evicted before the edit is certified as not grounded, the review says to read it closely, and it is staged all the same; a tampered certificate in the journal fails the offline check', async () => {
		// A small context and four floods of command output after the read: by the time the model edits, the
		// read result is no longer in what it is sent.
		const script = episode('certificate-evicted', [
			{ kind: 'toolCall', tool: 'readFile', arguments: { path: 'src/util.ts' }, id: 'read_1' },
			...Array.from({ length: 4 }, (_, index): OnyxSimEpisode['turns'][number] => ({ kind: 'toolCall', tool: 'terminal', arguments: { command: 'npm test' }, id: `test_${index}` })),
			{ kind: 'toolCall', tool: 'editFile', arguments: { path: 'src/util.ts', search: '\treturn Math.min(max, Math.max(min, value));', replace: '\treturn Math.max(min, Math.min(max, value));' }, id: 'edit_1' },
			{ kind: 'text', text: 'Staged one edit.' },
		], {
			profile: { promptStyle: 'compact', contextLength: 4096, maxTools: 8 },
			faults: Array.from({ length: 4 }, (_, index) => ({ at: 'afterToolDispatch' as const, occurrence: index + 2, step: { kind: 'outputFlood' as const, bytes: 20_000 } })),
		});
		const result = await run(script);
		const [entry] = certificatesIn(result.journal);
		const tampered = result.journal.replace('"grounding":"ungrounded"', '"grounding":"grounded"');
		const resealed = result.journal.split('\n').map(line => {
			if (!line.includes('"editCertificate"')) {
				return line;
			}
			// Someone changes the certificate and seals it again: the seal is its own, and the journal's prompt still contradicts it.
			const event = JSON.parse(line) as { data: IOnyxTraceCertificate };
			const certificate: IOnyxEditCertificate = { ...event.data.certificate, grounding: 'grounded' };
			return JSON.stringify({ ...event, data: { ...event.data, certificate, seal: sealCertificate(certificate) } });
		}).join('\n');
		assert.deepStrictEqual({
			grounding: entry?.certificate.grounding,
			provenance: entry?.certificate.provenance,
			stagedAllTheSame: entry?.hunks,
			line: entry ? describeCertificate(entry.certificate) : undefined,
			offline: checkCertificates(result.journal).map(check => check.verdict),
			tampered: checkCertificates(tampered).map(check => `${check.verdict}: ${check.detail}`),
			resealed: checkCertificates(resealed).map(check => `${check.verdict}: ${check.detail}`),
			violations: result.violations,
		}, {
			grounding: 'ungrounded',
			provenance: null,
			stagedAllTheSame: ['g1.h1'],
			line: { text: 'Anchored exactly once · not shown to the model this turn; read closely', readClosely: true },
			offline: ['matches'],
			tampered: ['differs: the certificate is not the one that was sealed'],
			resealed: ['differs: grounding: the journal shows ungrounded, the certificate says grounded'],
			violations: [],
		});
	});
});
