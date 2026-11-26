/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Evidence a session produced for the candidate and committed (D8).
 *
 *   node test/onyx/checks/candidate-evidence.mts --require soak|egress|budgets
 *
 * The one-hour soak and the measured budgets are not repeated inside the
 * module gate: an hour of soak and a quiet machine are not things a gate run
 * can assume. The gate instead requires their committed results to say they
 * passed and to be for this candidate: taken at a commit that is an ancestor
 * of HEAD with no input of the application changed since. A change to the
 * product makes them stale and this check fail, which is the point.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { staleReason } from './owner-evidence.mts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const what = process.argv[process.argv.indexOf('--require') + 1];

interface IEvidence { readonly passed?: boolean; readonly product?: { readonly commit?: string }; readonly minutesRun?: number; readonly campaign?: { readonly exitCode?: number | null } }

const files: Record<string, string> = { soak: 'docs/progress/soak.json', egress: 'docs/progress/egress-audit.json', budgets: 'docs/progress/budgets.json' };
const relative = files[what];
if (!relative) {
	console.error('usage: node test/onyx/checks/candidate-evidence.mts --require soak|egress|budgets');
	process.exit(2);
}
const file = path.join(repoRoot, relative);
if (!fs.existsSync(file)) {
	console.log(`missing: ${relative}`);
	process.exit(1);
}
const evidence = JSON.parse(fs.readFileSync(file, 'utf8')) as IEvidence;
const problems = [
	evidence.passed === true ? undefined : `${relative} does not say it passed`,
	staleReason(evidence.product?.commit),
	what === 'soak' && (evidence.minutesRun ?? 0) < 60 ? `the soak ran ${evidence.minutesRun} minutes, not sixty` : undefined,
	what === 'soak' && evidence.campaign?.exitCode !== 0 ? 'the soak\'s simulation campaign did not pass' : undefined,
].filter(Boolean);
if (problems.length) {
	console.log(`${what}: ${problems.join('; ')}`);
	process.exit(1);
}
console.log(`ok: ${relative} passed at ${evidence.product?.commit?.slice(0, 11)}, and the application's inputs have not changed since`);
