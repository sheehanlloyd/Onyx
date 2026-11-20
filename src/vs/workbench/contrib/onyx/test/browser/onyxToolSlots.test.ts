/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ONYX_ESSENTIAL_TOOLS, ONYX_SUPPORTED_SLOT_CAP, OnyxToolSlotSelection, IOnyxNamedTool, requestedOptionalTools, selectToolSlots } from '../../common/onyxToolSlots.js';
import { OnyxSimEpisode, SIM_FILES, SIM_TARGET_FILE } from './sim/onyxSimEpisode.js';
import { runEpisode } from './sim/onyxSimRun.js';

/**
 * R-36: the tool-slot policy. The pure half covers the default 7B eight-slot
 * profile, a changed optional order, lower caps and excluded essentials. The
 * service half runs the real agent loop in the simulation rig and reads the
 * tool list off the wire.
 */

const OPTIONAL = ['repoSymbols', 'docs', 'remember', 'playbook'];
const EXTRA = ['usages', 'testFailure'];
const ALL = [...EXTRA, 'playbook', 'remember', 'docs', 'repoSymbols', 'terminal', 'editFile', 'grep', 'findFiles', 'listDirectory', 'readFile'].map(name => ({ name }));

function names(selection: OnyxToolSlotSelection<IOnyxNamedTool>): string | string[] {
	return selection.kind === 'refused' ? `refused: ${selection.missing.map(entry => `${entry.name} (${entry.reason})`).join(', ')}` : selection.tools.map(tool => tool.name);
}

function episode(extra: Partial<OnyxSimEpisode>): OnyxSimEpisode {
	return { name: 'slots', seed: 0, persona: 'well-behaved', prompt: 'Change addNumbers', files: SIM_FILES, target: SIM_TARGET_FILE, turns: [{ kind: 'text', text: 'Done.' }], dialogDefault: 'deny', userSteps: [], faults: [], ...extra };
}

suite('OnyxToolSlots', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('R-36: the six essentials are reserved first and the spare slots fill in the documented order, whatever order the registry lists tools in', () => {
		assert.deepStrictEqual({
			supported7B: names(selectToolSlots({ available: ALL, excluded: [], maxTools: ONYX_SUPPORTED_SLOT_CAP })),
			sixSlots: names(selectToolSlots({ available: ALL, excluded: [], maxTools: 6 })),
			sevenSlots: names(selectToolSlots({ available: ALL, excluded: [], maxTools: 7 })),
			twelveSlots: names(selectToolSlots({ available: ALL, excluded: [], maxTools: 12 })),
			// A profile or a lab manifest may change the optional order; the essentials do not move.
			forcedOrder: names(selectToolSlots({ available: ALL, excluded: [], maxTools: 8, optionalOrder: ['playbook', 'remember', 'docs', 'repoSymbols'] })),
			// A tool the user asked for by name takes the last spare slot; the first default stays.
			playbookRequested: names(selectToolSlots({ available: ALL, excluded: [], maxTools: 8, requested: ['playbook'] })),
			rememberRequested: names(selectToolSlots({ available: ALL, excluded: [], maxTools: 8, requested: ['remember'] })),
			bothRequested: names(selectToolSlots({ available: ALL, excluded: [], maxTools: 8, requested: ['remember', 'playbook'] })),
			requestedWithOneSpare: names(selectToolSlots({ available: ALL, excluded: [], maxTools: 7, requested: ['playbook'] })),
			// An optional tool the user turned off simply leaves its slot to the next one.
			docsExcluded: names(selectToolSlots({ available: ALL.filter(tool => tool.name !== 'docs'), excluded: [{ name: 'docs', reason: 'turned off in the chat tool picker' }], maxTools: 8 })),
		}, {
			supported7B: [...ONYX_ESSENTIAL_TOOLS, 'repoSymbols', 'docs'],
			sixSlots: [...ONYX_ESSENTIAL_TOOLS],
			sevenSlots: [...ONYX_ESSENTIAL_TOOLS, 'repoSymbols'],
			twelveSlots: [...ONYX_ESSENTIAL_TOOLS, ...OPTIONAL, ...EXTRA],
			forcedOrder: [...ONYX_ESSENTIAL_TOOLS, 'playbook', 'remember'],
			playbookRequested: [...ONYX_ESSENTIAL_TOOLS, 'repoSymbols', 'playbook'],
			rememberRequested: [...ONYX_ESSENTIAL_TOOLS, 'repoSymbols', 'remember'],
			bothRequested: [...ONYX_ESSENTIAL_TOOLS, 'remember', 'playbook'],
			requestedWithOneSpare: [...ONYX_ESSENTIAL_TOOLS, 'playbook'],
			docsExcluded: [...ONYX_ESSENTIAL_TOOLS, 'repoSymbols', 'remember'],
		});
	});

	test('R-36: an unavailable essential tool refuses an edit-capable run and names it; a profile below six slots is read-only', () => {
		const withoutTerminal = ALL.filter(tool => tool.name !== 'terminal');
		const withoutReads = ALL.filter(tool => tool.name !== 'readFile' && tool.name !== 'grep');
		const tiny = selectToolSlots({ available: ALL, excluded: [], maxTools: 3 });
		assert.deepStrictEqual({
			userExcluded: names(selectToolSlots({ available: withoutTerminal, excluded: [{ name: 'terminal', reason: 'turned off in the chat tool picker' }], maxTools: 8 })),
			notInThisBuild: names(selectToolSlots({ available: withoutReads, excluded: [], maxTools: 8 })),
			// More slots do not paper over a missing essential.
			manySlots: names(selectToolSlots({ available: withoutTerminal, excluded: [{ name: 'terminal', reason: 'disabled by "disabledTools" in .onyx/config.json' }], maxTools: 24 })),
			fiveSlots: names(selectToolSlots({ available: ALL, excluded: [], maxTools: 5 })),
			threeSlots: names(tiny),
			threeSlotsKind: tiny.kind,
			threeSlotsReason: tiny.kind === 'read-only' ? tiny.reason : undefined,
			zeroSlots: names(selectToolSlots({ available: ALL, excluded: [], maxTools: 0 })),
			// A read-only run never refuses for a missing write tool: it has none to miss.
			tinyWithoutTerminal: names(selectToolSlots({ available: withoutTerminal, excluded: [], maxTools: 3 })),
		}, {
			userExcluded: 'refused: terminal (turned off in the chat tool picker)',
			notInThisBuild: 'refused: readFile (not available in this build), grep (not available in this build)',
			manySlots: 'refused: terminal (disabled by "disabledTools" in .onyx/config.json)',
			fiveSlots: ['readFile', 'grep', 'findFiles', 'listDirectory'],
			threeSlots: ['readFile', 'grep', 'findFiles'],
			threeSlotsKind: 'read-only',
			threeSlotsReason: 'this model\'s profile allows 3 tools and agent editing needs 6 (readFile, listDirectory, findFiles, grep, editFile, terminal)',
			zeroSlots: [],
			tinyWithoutTerminal: ['readFile', 'grep', 'findFiles'],
		});
	});

	test('an optional tool is requested by its own word or by a playbook\'s name, and by nothing else', () => {
		assert.deepStrictEqual({
			playbookWord: requestedOptionalTools('Follow the release playbook'),
			playbookName: requestedOptionalTools('PBTEST e2e-recipe', ['e2e-recipe']),
			remember: requestedOptionalTools('Remember that this project indents with tabs'),
			docs: requestedOptionalTools('What does the documentation say about retries?'),
			nothing: requestedOptionalTools('Fix the off-by-one in total()', ['e2e-recipe']),
			substringIsNotAWord: requestedOptionalTools('Rename remembered to cached'),
		}, {
			playbookWord: ['playbook'],
			playbookName: ['playbook'],
			remember: ['remember'],
			docs: ['docs'],
			nothing: [],
			substringIsNotAWord: [],
		});
	});

	test('R-36, through the real loop: what is advertised on the wire for the supported profile, lower caps and excluded essentials', async () => {
		const run = async (extra: Partial<OnyxSimEpisode>) => {
			const result = await runEpisode(episode(extra));
			return { status: result.status, advertised: result.advertised[0] ?? 'no request sent', error: result.errorMessage?.replace(/\. Onyx does not.*$/, '.') };
		};
		assert.deepStrictEqual({
			supported: await run({}),
			sixSlots: await run({ profile: { maxTools: 6 } }),
			fiveSlots: await run({ profile: { maxTools: 5 } }),
			threeSlots: await run({ profile: { maxTools: 3 } }),
			zeroSlots: await run({ profile: { maxTools: 0 } }),
			terminalExcludedById: await run({ projectConfig: { disabledTools: ['onyx_terminal'] } }),
			readExcludedByName: await run({ projectConfig: { disabledTools: ['readFile', 'grep'] } }),
			tinyProfileWithAnExclusion: await run({ profile: { maxTools: 3 }, projectConfig: { disabledTools: ['onyx_terminal'] } }),
		}, {
			supported: { status: 'completed', advertised: [...ONYX_ESSENTIAL_TOOLS], error: undefined },
			sixSlots: { status: 'completed', advertised: [...ONYX_ESSENTIAL_TOOLS], error: undefined },
			fiveSlots: { status: 'completed', advertised: ['readFile', 'grep', 'findFiles', 'listDirectory'], error: undefined },
			threeSlots: { status: 'completed', advertised: ['readFile', 'grep', 'findFiles'], error: undefined },
			zeroSlots: { status: 'completed', advertised: [], error: undefined },
			terminalExcludedById: { status: 'failed', advertised: 'no request sent', error: 'This agent run was not started because it needs terminal (disabled by "disabledTools" in .onyx/config.json).' },
			readExcludedByName: { status: 'failed', advertised: 'no request sent', error: 'This agent run was not started because it needs readFile (disabled by "disabledTools" in .onyx/config.json), grep (disabled by "disabledTools" in .onyx/config.json).' },
			tinyProfileWithAnExclusion: { status: 'completed', advertised: ['readFile', 'grep', 'findFiles'], error: undefined },
		});
	});
});
