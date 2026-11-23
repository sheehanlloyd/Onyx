/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Module 5's documents (D2, D4, D6, D8, L19, E3): the public material says what the plan requires of it and
 * nothing the plan forbids.
 *
 *   node --test test/onyx/checks/module5-docs.test.mts
 */

import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (relative: string) => fs.readFileSync(path.join(repoRoot, relative), 'utf8');
const exists = (relative: string) => fs.existsSync(path.join(repoRoot, relative));

/** The documents a reader outside the project sees. Progress records and raw results are history, not public claims. */
function publicDocuments(): string[] {
	const launch = exists('docs/launch') ? fs.readdirSync(path.join(repoRoot, 'docs', 'launch')).map(name => `docs/launch/${name}`) : [];
	return ['README.md', 'ROADMAP.md', 'docs/SUPPORT.md', 'docs/DESIGN.md', 'docs/UPDATING.md', 'docs/RELEASING.md', 'docs/RUNBOOK-clean-install.md', 'docs/release/NOTES-TEMPLATE.md', 'docs/research/REPORT.md', 'docs/research/REPRODUCE.md', '.github/SECURITY.md', '.github/CONTRIBUTING.md', 'CITATION.cff', ...launch].filter(exists);
}

test('D8: the open-source files and Module 5\'s documents exist', () => {
	const required = [
		'LICENSE.txt', 'NOTICE.md', 'ThirdPartyNotices.txt', 'CITATION.cff', 'ROADMAP.md', 'README.md',
		'.github/CONTRIBUTING.md', '.github/CODE_OF_CONDUCT.md', '.github/SECURITY.md', '.github/pull_request_template.md',
		'.github/ISSUE_TEMPLATE/onyx_bug_report.yml', '.github/ISSUE_TEMPLATE/onyx_feature_request.yml',
		'.github/workflows/onyx-release.yml', 'build/darwin/onyx-release.ts',
		'docs/SUPPORT.md', 'docs/DESIGN.md', 'docs/UPDATING.md', 'docs/RELEASING.md', 'docs/RUNBOOK-clean-install.md', 'docs/release/NOTES-TEMPLATE.md',
		'docs/research/REPORT.md', 'docs/research/RELATED.md', 'docs/research/REPRODUCE.md', 'docs/research/data/numbers.json',
		'docs/pilot/README.md', 'docs/pilot/TASKS.md', 'docs/pilot/REPOSITORIES.md', 'docs/pilot/PROTOCOL.md', 'docs/pilot/RECORDING-SHEET.md',
		'docs/launch/VIDEO-SCRIPT.md', 'docs/launch/THREAD.md', 'docs/launch/SHOW-HN.md',
		'docs/naming/README.md', 'docs/brand/README.md',
		'docs/progress/production-readiness.md', 'docs/progress/egress-audit.json', 'docs/progress/soak.json', 'docs/progress/budgets.json', 'docs/progress/dependency-audit.json', 'docs/progress/secret-scan.json',
	];
	assert.deepStrictEqual(required.filter(file => !exists(file)), []);
});

test('D6: the first screen of the README has the download, the supported matrix, the tool list and the research report within reach', () => {
	const firstScreen = read('README.md').split('\n').slice(0, 45).join('\n');
	assert.deepStrictEqual({
		download: /\(#download\)|releases\/download\//.test(firstScreen),
		support: firstScreen.includes('docs/SUPPORT.md'),
		tools: /SUPPORT\.md#[a-z-]*tool/.test(firstScreen),
		research: firstScreen.includes('docs/research/REPORT.md') || firstScreen.includes('#research'),
		experimental: /experimental/i.test(firstScreen),
		authorshipBoxAtTop: /What I built/.test(firstScreen),
		badgeImage: firstScreen.includes('badges.svg'),
	}, { download: true, support: true, tools: true, research: true, experimental: true, authorshipBoxAtTop: false, badgeImage: false });
});

test('D6: the README no longer uses the words the plan replaced, and the Research section has at most four findings', () => {
	const readme = read('README.md');
	const banned = [/token-exact/i, /exact wire prompt/i, /nothing leaves your machine/i, /\blearns?\b/i, /from scratch/i];
	const research = /^## Research\n(?<body>[\s\S]*?)(?=^## )/m.exec(readme)?.groups?.body ?? '';
	assert.deepStrictEqual({
		banned: banned.filter(pattern => pattern.test(readme)).map(String),
		hasResearch: research.length > 0,
		findingsAtMostFour: research.split('\n').filter(line => /^(?:\d+\.|-) /.test(line)).length <= 4,
	}, { banned: [], hasResearch: true, findingsAtMostFour: true });
});

test('DEC-08: no document tells a user to get around Gatekeeper', () => {
	const offenders: string[] = [];
	for (const file of [...publicDocuments(), 'LAUNCH.md', 'ONYX.md']) {
		read(file).split('\n').forEach((line, index) => {
			// A sentence that says not to do it is the opposite of an instruction to do it.
			const instructs = /xattr\s+-|spctl\s+--master-disable|right-click (?:it )?and choose \*\*Open\*\*|Control-click.*Open/i.test(line) && !/do not|never|no longer|cannot|not use/i.test(line);
			if (instructs) {
				offenders.push(`${file}:${index + 1}`);
			}
		});
	}
	assert.deepStrictEqual(offenders, []);
});

test('DEC-09: no novelty wording in public text until the owner has approved it', () => {
	const approved = (JSON.parse(read('docs/progress/owner-decisions.json')) as { publicClaimsApprovedOn: string | null }).publicClaimsApprovedOn;
	const novelty = /\b(?:novel|unprecedented|never (?:been )?done|state[- ]of[- ]the[- ]art|world'?s first|the first (?:editor|ide|tool|system|harness|study|benchmark|to)\b|first[- ]of[- ]its[- ]kind|groundbreaking|revolutionary)\b/i;
	const offenders: string[] = [];
	for (const file of publicDocuments()) {
		read(file).split('\n').forEach((line, index) => {
			if (novelty.test(line)) {
				offenders.push(`${file}:${index + 1}: ${line.trim().slice(0, 90)}`);
			}
		});
	}
	assert.deepStrictEqual(approved ? [] : offenders, []);
});

test('DEC-12: nothing in docs/SUPPORT.md is left "planned"', () => {
	const planned = read('docs/SUPPORT.md').split('\n').filter(line => /^\|[^|]*\|\s*\**planned\**\s*\|/.test(line));
	assert.deepStrictEqual(planned, []);
});

test('D6: links between the public documents resolve', () => {
	const broken: string[] = [];
	for (const file of publicDocuments().filter(name => name.endsWith('.md') && name !== 'docs/release/NOTES-TEMPLATE.md')) {
		for (const match of read(file).matchAll(/\]\((?<target>[^)\s]+)\)/g)) {
			const target = match.groups!.target;
			if (/^(?:https?:|mailto:|#)/.test(target)) {
				continue;
			}
			const resolved = path.join(repoRoot, path.dirname(file), decodeURIComponent(target.split('#')[0]));
			if (!fs.existsSync(resolved)) {
				broken.push(`${file} → ${target}`);
			}
		}
	}
	assert.deepStrictEqual(broken, []);
});

test('D2: the release script refuses to run without credentials and changes nothing', () => {
	const env = { ...process.env };
	for (const name of ['CODESIGN_IDENTITY', 'ONYX_NOTARY_KEY', 'ONYX_NOTARY_KEY_ID', 'ONYX_NOTARY_ISSUER']) {
		delete env[name];
	}
	// A bundle that is only an Info.plist: enough to get past the argument checks, and it must be untouched afterwards.
	const scratch = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR ?? '/tmp'), 'onyx-release-check-'));
	const app = path.join(scratch, 'Empty.app');
	fs.mkdirSync(path.join(app, 'Contents'), { recursive: true });
	fs.writeFileSync(path.join(app, 'Contents', 'Info.plist'), '<plist/>');
	const result = spawnSync(process.execPath, [path.join(repoRoot, 'build', 'darwin', 'onyx-release.ts'), '--app', app, '--out', path.join(scratch, 'out')], { encoding: 'utf8', env });
	const after = { files: fs.readdirSync(path.join(app, 'Contents')), outCreated: fs.existsSync(path.join(scratch, 'out')) };
	fs.rmSync(scratch, { recursive: true, force: true });
	assert.deepStrictEqual({
		exit: result.status,
		namesWhatIsMissing: ['CODESIGN_IDENTITY', 'ONYX_NOTARY_KEY', 'ONYX_NOTARY_KEY_ID', 'ONYX_NOTARY_ISSUER'].every(name => result.stderr.includes(name)),
		after,
	}, { exit: 1, namesWhatIsMissing: true, after: { files: ['Info.plist'], outCreated: false } });
});

test('D2: the release workflow checks the secrets before building, is dispatched by hand, and only ever drafts', () => {
	const workflow = read('.github/workflows/onyx-release.yml');
	const secrets = ['APPLE_DEVELOPER_ID_P12_BASE64', 'APPLE_DEVELOPER_ID_P12_PASSWORD', 'APPLE_NOTARY_KEY_P8_BASE64', 'APPLE_NOTARY_KEY_ID', 'APPLE_NOTARY_ISSUER_ID'];
	const triggers = /^on:\n(?<body>(?:[ \t]+.*\n|\n)+)/m.exec(workflow)?.groups?.body ?? '';
	assert.deepStrictEqual({
		preflightNamesEverySecret: secrets.every(secret => new RegExp(`missing="\\$missing ${secret}"`).test(workflow)),
		buildNeedsPreflight: /release:\n(?:.*\n){0,3}\s+needs: preflight/.test(workflow),
		onlyManualDispatch: /workflow_dispatch:/.test(triggers) && !/^\s+(?:push|pull_request|schedule|release):/m.test(triggers),
		draftsOnly: /gh release create[^\n]*\\\n\s+--draft/.test(workflow) && !/gh release (?:edit|publish)|--draft=false/.test(workflow),
		createsNoTag: !/git tag|git push[^\n]*--tags/.test(workflow),
	}, { preflightNamesEverySecret: true, buildNeedsPreflight: true, onlyManualDispatch: true, draftsOnly: true, createsNoTag: true });
});

test('D4: release notes are refused for a rehearsal and for a placeholder left unfilled', () => {
	const scratch = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR ?? '/tmp'), 'onyx-notes-check-'));
	const write = (name: string, value: object) => {
		fs.writeFileSync(path.join(scratch, name), JSON.stringify(value));
		return path.join(scratch, name);
	};
	const version = /export const ONYX_VERSION = '(?<version>[^']+)'/.exec(read('src/vs/workbench/contrib/onyx/common/onyxUpdateCheck.ts'))!.groups!.version;
	const evidence = (extra: object) => write('evidence.json', { adHocRehearsal: false, product: 'Onyx', version, commit: 'abc', artifact: 'Onyx.dmg', sha256: 'f'.repeat(64), passed: true, requirements: [{ requirement: 'x', met: true }], ...extra });
	const smoke = write('smoke.json', { checks: [{ ok: true }] });
	const extensions = write('extensions.json', { passed: true, results: [{ what: 'Python', version: '1.0.0' }] });
	const run = (evidenceFile: string) => spawnSync(process.execPath, [path.join(repoRoot, 'test', 'onyx', 'release', 'make-release-notes.mts'), '--version', version, '--evidence', evidenceFile, '--smoke', smoke, '--extensions', extensions, '--out', path.join(scratch, 'notes.md')], { encoding: 'utf8' });
	const accepted = run(evidence({}));
	const notes = accepted.status === 0 ? fs.readFileSync(path.join(scratch, 'notes.md'), 'utf8') : accepted.stderr;
	const rehearsal = run(evidence({ adHocRehearsal: true, passed: false }));
	fs.rmSync(scratch, { recursive: true, force: true });
	assert.deepStrictEqual({
		accepted: accepted.status,
		noPlaceholderLeft: !/\{\{[A-Z_]+\}\}/.test(notes),
		carriesChecksum: notes.includes('f'.repeat(64)),
		rehearsalRefused: rehearsal.status,
	}, { accepted: 0, noPlaceholderLeft: true, carriesChecksum: true, rehearsalRefused: 1 });
});
