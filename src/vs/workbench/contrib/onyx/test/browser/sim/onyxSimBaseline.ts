/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { OnyxSimEpisode } from './onyxSimEpisode.js';

/**
 * The baseline exceptions (L2, R-42): every violation class the simulator
 * found on the unmodified harness, the audit finding it corresponds to, the
 * item that owns the fix, and the shrunk script that reproduces it. The
 * exporter writes this table to `test/onyx/sim/baseline-exceptions.json` and
 * each script to `test/onyx/sim/baseline/<class>.json`. A class that is not
 * here fails the campaign: new violations are triaged, never ignored. When an
 * owner item lands, its class comes out of this table and the gate must show
 * zero violations of that invariant (Section 12, Assurance).
 *
 * Generated from the shrunk scripts of the 2026-11-19 baseline campaign
 * (1,000 seeded episodes from seed 1 plus the scripted scenarios), then
 * annotated by hand.
 */

export interface IOnyxSimBaselineException {
	/** `<invariant>/<class>` as the checkers report it. */
	readonly class: string;
	readonly owner: string;
	readonly finding: string;
	/** The shrunk script, or the name of the scripted scenario that reproduces the class. */
	readonly script: OnyxSimEpisode;
}

/**
 * Empty since B10 (Module 3). Every class the 2026-11-19 baseline campaign
 * found, and the one Module 2's 20,000-episode campaign added, was fixed by
 * its owner item and is brought back by a resurrection mutant
 * (`onyxSimMutantTable.ts`). A violation the campaign reports now has no
 * exception to hide behind: it fails the campaign.
 */
export const BASELINE_EXCEPTIONS: readonly IOnyxSimBaselineException[] = [];
