/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Evidence that only the owner can produce (Module 5, Section 12).
 *
 *   node test/onyx/checks/owner-evidence.mts --require <box>
 *
 * Each box of Section 12 that needs a person, an Apple account or a decision
 * has a check here. It looks for the evidence in the repository and exits 1,
 * printing `BLOCKED ON THE OWNER` and the exact thing wanted, when it is not
 * there. The gate lists these as required checks: they are never expected
 * failures, and the gate does not pass while one is open.
 *
 * Evidence for a build must be for this candidate: the commit it names is an
 * ancestor of HEAD and nothing that goes into the application changed since.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const box = process.argv[process.argv.indexOf('--require') + 1];

/** Everything that changes the built application. Documentation and test harnesses do not. */
const PRODUCT_INPUTS = ['src', 'extensions', 'resources', 'build', 'product.json', 'package.json', 'pnpm-lock.yaml', 'remote', 'cli'];

function read<T>(relative: string): T | undefined {
	const file = path.join(repoRoot, relative);
	return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) as T : undefined;
}

function git(...args: string[]) {
	return spawnSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8' });
}

/** Why evidence taken at `commit` does not describe the tree at HEAD, or undefined when it does. */
export function staleReason(commit: string | undefined): string | undefined {
	if (!commit) {
		return 'the evidence names no commit';
	}
	if (git('merge-base', '--is-ancestor', commit, 'HEAD').status !== 0) {
		return `the evidence is for ${commit.slice(0, 11)}, which is not an ancestor of HEAD`;
	}
	const changed = git('diff', '--name-only', commit, 'HEAD', '--', ...PRODUCT_INPUTS).stdout.trim().split('\n').filter(Boolean);
	return changed.length ? `the application's inputs changed since ${commit.slice(0, 11)} (${changed.length} files, for example ${changed[0]})` : undefined;
}

function blocked(ask: string): never {
	console.log(`BLOCKED ON THE OWNER: ${ask}`);
	process.exit(1);
}

function decisions(): Record<string, string | null> {
	return read<Record<string, string | null>>('docs/progress/owner-decisions.json') ?? {};
}

function main() {
	switch (box) {
		case 'gatekeeper': {
			// R-39. Written by the release workflow, downloaded from the draft release and committed by the owner.
			const evidence = read<{ adHocRehearsal: boolean; passed: boolean; commit?: string }>('docs/progress/gatekeeper-evidence.json');
			if (!evidence) {
				blocked('R-39 has no evidence. Enrol in the Apple Developer Program, store the five signing secrets, dispatch "Onyx release", and commit the draft release\'s gatekeeper-evidence.json as docs/progress/gatekeeper-evidence.json (docs/RELEASING.md).');
			}
			if (evidence.adHocRehearsal || !evidence.passed) {
				blocked('docs/progress/gatekeeper-evidence.json is an ad-hoc rehearsal or was not accepted by Gatekeeper; R-39 needs the notarized artifact.');
			}
			const stale = staleReason(evidence.commit);
			if (stale) {
				blocked(`R-39: ${stale}. Dispatch "Onyx release" again for this candidate.`);
			}
			break;
		}
		case 'clean-install': {
			const records = fs.readdirSync(path.join(repoRoot, 'docs', 'progress')).filter(file => /^clean-install-\d{4}-\d{2}-\d{2}\.md$/.test(file));
			if (records.length === 0) {
				blocked('D5: carry out docs/RUNBOOK-clean-install.md on the signed candidate with a fresh macOS user account, and commit the filled record as docs/progress/clean-install-<date>.md with the recording linked.');
			}
			break;
		}
		case 'pilot': {
			const reports = fs.readdirSync(path.join(repoRoot, 'docs', 'pilot')).filter(file => /^\d{4}-\d{2}-\d{2}\.md$/.test(file));
			if (reports.length === 0) {
				blocked('E1: run the pilot (docs/pilot/README.md) and commit its report as docs/pilot/<date>.md with the raw sheets. E2 then closes every P0 and P1 it found.');
			}
			const scorecards = path.join(repoRoot, 'docs', 'scorecards');
			const machines = fs.existsSync(scorecards) ? fs.readdirSync(scorecards, { withFileTypes: true }).filter(entry => entry.isDirectory()).length : 0;
			if (machines < 3) {
				blocked(`Measurement gate: scorecards from at least three different machines under docs/scorecards/<machine>/ (found ${machines}). They come from the pilot's participants.`);
			}
			break;
		}
		case 'identity': {
			const { productName, logoDirection } = decisions();
			if (!productName || !logoDirection) {
				blocked('DEC-01: pick the product name (docs/naming/README.md; "Onyx" is a valid answer and makes D7 not applicable) and the logo direction (docs/brand/README.md), and record both in docs/progress/owner-decisions.json.');
			}
			break;
		}
		case 'claims': {
			const { publicClaimsApprovedOn, pinnedModelRecommendation, repositoryDescriptionAndTopicsSetOn } = decisions();
			const open = [
				publicClaimsApprovedOn ? undefined : 'approve the public claims in README.md, docs/research/REPORT.md and docs/launch/ (publicClaimsApprovedOn)',
				pinnedModelRecommendation ? undefined : 'decide whether the product keeps recommending the two pinned models for agent work (pinnedModelRecommendation)',
				repositoryDescriptionAndTopicsSetOn ? undefined : 'set the repository description and topics (repositoryDescriptionAndTopicsSetOn)',
			].filter(Boolean);
			if (open.length) {
				blocked(`${open.join('; ')}. Record each in docs/progress/owner-decisions.json.`);
			}
			break;
		}
		case 'tag': {
			const version = /export const ONYX_VERSION = '(?<version>[^']+)'/.exec(fs.readFileSync(path.join(repoRoot, 'src', 'vs', 'workbench', 'contrib', 'onyx', 'common', 'onyxUpdateCheck.ts'), 'utf8'))?.groups?.version;
			if (git('rev-parse', '-q', '--verify', `refs/tags/v${version}`).status !== 0) {
				blocked(`E4: the tag v${version} does not exist. It is created by publishing the draft release, and only when every other box of Section 12 is checked.`);
			}
			break;
		}
		default:
			console.error('usage: node test/onyx/checks/owner-evidence.mts --require gatekeeper|clean-install|pilot|identity|claims|tag');
			process.exit(2);
	}
	console.log(`ok: ${box}`);
}

if (import.meta.main) {
	main();
}
