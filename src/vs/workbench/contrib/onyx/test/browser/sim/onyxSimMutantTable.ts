/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { OnyxSimEpisode, SIM_FILES, SIM_TARGET_FILE } from './onyxSimEpisode.js';

/**
 * The resurrection mutants (L12): one per defect fixed in Modules 2 and 3.
 * A mutant is a test-context switch: a test-only subclass of one product
 * class (`onyxSimMutants.ts`) that brings the fixed defect back when the rig
 * is built with it. Nothing in the product can select one, and no mutant
 * code is in the product bundle (R-44).
 *
 * Each row names the defect, the item that fixed it, the violation class the
 * campaign must report with the mutant in place, and a short script that
 * reproduces it. `test/onyx/sim/export-episodes.mts` writes each row to
 * `test/onyx/sim/mutants/<id>.json`. The module gate requires every mutant
 * to be detected by its script and by the seeded campaign, and requires the
 * unmutated harness to pass both.
 *
 * This table is pure data so that plain Node can import it.
 */

export interface IOnyxSimMutantInfo {
	readonly id: string;
	/** The item that fixed the defect. */
	readonly fixedBy: string;
	/** The defect, as the audits or the item recorded it. */
	readonly defect: string;
	/** The violation class the campaign reports while the mutant is in place. */
	readonly detects: string;
	/** The test-only class in `onyxSimMutants.ts` that resurrects the defect. */
	readonly resurrects: string;
	readonly script: OnyxSimEpisode;
}

function script(name: string, prompt: string, turns: OnyxSimEpisode['turns'], extra: Partial<OnyxSimEpisode> = {}): OnyxSimEpisode {
	return { name, seed: 0, persona: 'well-behaved', prompt, files: SIM_FILES, target: SIM_TARGET_FILE, turns, dialogDefault: 'allow-once', userSteps: [], faults: [], ...extra };
}

export const SIM_MUTANTS: readonly IOnyxSimMutantInfo[] = [
	{
		id: 'B1-naive-read-path',
		fixedBy: 'B1',
		defect: 'A read tool that joins the model\'s path onto the workspace folder without refusing traversal, absolute paths or a symbolic link that leaves the workspace (R-30, I-07 on the read side)',
		detects: 'I-07/read-escape',
		resurrects: 'OnyxMutantNaiveWorkspaceAccess',
		script: script('B1-naive-read-path', 'Show me the secret file', [
			{ kind: 'toolCall', tool: 'readFile', arguments: { path: 'link-outside.txt' } },
		]),
	},
	{
		id: 'B1-priority-truncation',
		fixedBy: 'B1',
		defect: 'Tools sorted by a priority number and cut at the profile\'s cap, so a small profile or an excluded tool left an editing agent with part of its tool set and no word about it (R-36)',
		detects: 'I-06/partial-edit-set',
		resurrects: 'OnyxMutantPriorityTruncatingLoop',
		script: script('B1-priority-truncation', 'Change addNumbers', [
			{ kind: 'text', text: 'Done.' },
		], { projectConfig: { disabledTools: ['onyx_terminal'] } }),
	},
];
