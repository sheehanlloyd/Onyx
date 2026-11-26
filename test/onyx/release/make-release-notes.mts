/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Release notes from the template (D4).
 *
 *   node test/onyx/release/make-release-notes.mts --version <v> --evidence <gatekeeper-evidence.json>
 *        --smoke <packaged-smoke-release.json> --extensions <extension-smoke.json> --out <file>
 *        [--clean-install <url>] [--allow-rehearsal]
 *
 * Fills docs/release/NOTES-TEMPLATE.md from the files the release job wrote
 * and from the repository: the artifact name and SHA-256, the Gatekeeper
 * result, the smoke count, the extension versions, the pinned runtime version
 * from docs/SUPPORT.md, and the findings paragraph from the README's Research
 * section, so that the notes cannot say something the README does not.
 *
 * It refuses to write notes for an artifact Gatekeeper rejected, for a failed
 * smoke, or with a placeholder left unfilled. `--allow-rehearsal` writes them
 * anyway for an ad-hoc rehearsal, with a banner saying what they are.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function argValue(flag: string): string | undefined {
	const index = process.argv.indexOf(flag);
	return index === -1 ? undefined : process.argv[index + 1];
}

function required(flag: string): string {
	const value = argValue(flag);
	if (!value) {
		console.error(`make-release-notes: ${flag} is required`);
		process.exit(2);
	}
	return value;
}

function readJson<T>(file: string): T {
	return JSON.parse(fs.readFileSync(path.resolve(file), 'utf8')) as T;
}

interface IEvidence { adHocRehearsal: boolean; product: string; version: string; commit?: string; artifact: string; sha256: string; passed: boolean; requirements: { requirement: string; met: boolean }[] }
interface ISmoke { checks?: { ok: boolean }[]; passed?: boolean }
interface IExtensions { passed: boolean; results: { what: string; version?: string }[] }

/** The text between a heading and the next heading of the same or a higher level. */
function section(markdown: string, heading: RegExp): string | undefined {
	const lines = markdown.split('\n');
	const start = lines.findIndex(line => heading.test(line));
	if (start === -1) {
		return undefined;
	}
	const level = /^#+/.exec(lines[start])![0].length;
	const rest = lines.slice(start + 1);
	const end = rest.findIndex(line => new RegExp(`^#{1,${level}} `).test(line));
	return (end === -1 ? rest : rest.slice(0, end)).join('\n').trim();
}

const version = required('--version');
const evidence = readJson<IEvidence>(required('--evidence'));
const smoke = readJson<ISmoke>(required('--smoke'));
const extensions = readJson<IExtensions>(required('--extensions'));
const outFile = path.resolve(required('--out'));
const allowRehearsal = process.argv.includes('--allow-rehearsal');

const problems: string[] = [];
if (evidence.version !== version) {
	problems.push(`the evidence is for ${evidence.version}, not ${version}`);
}
if ((evidence.adHocRehearsal || !evidence.passed) && !allowRehearsal) {
	problems.push('Gatekeeper does not accept the artifact (or it is an ad-hoc rehearsal): no release notes for it');
}
const smokeChecks = smoke.checks ?? [];
const smokeFailed = smokeChecks.filter(check => !check.ok).length;
if (smokeChecks.length === 0 || smokeFailed > 0) {
	problems.push(`the packaged smoke did not pass (${smokeChecks.length - smokeFailed} of ${smokeChecks.length})`);
}
if (!extensions.passed) {
	problems.push('the extension smoke did not pass');
}

const product = readJson<{ reportIssueUrl: string }>(path.join(repoRoot, 'product.json'));
const repository = /github\.com\/(?<repository>[^/]+\/[^/]+)\//.exec(product.reportIssueUrl)?.groups?.repository;
const support = fs.readFileSync(path.join(repoRoot, 'docs', 'SUPPORT.md'), 'utf8');
const ollamaVersion = /Pinned runtime: Ollama (?<version>\d+\.\d+\.\d+)/.exec(support)?.groups?.version;
const findings = section(fs.readFileSync(path.join(repoRoot, 'README.md'), 'utf8'), /^## Research\b/);
if (!repository) {
	problems.push('product.json names no repository');
}
if (!ollamaVersion) {
	problems.push('docs/SUPPORT.md has no "Pinned runtime: Ollama <version>" line');
}
if (!findings) {
	problems.push('README.md has no "## Research" section to take the findings from');
}

const met = evidence.requirements.filter(requirement => requirement.met).length;
const cleanInstall = argValue('--clean-install');
const values: Record<string, string> = {
	PRODUCT: evidence.product,
	VERSION: version,
	COMMIT: evidence.commit ?? 'unknown',
	DMG: evidence.artifact,
	SHA256: evidence.sha256,
	REPOSITORY: repository ?? '',
	OLLAMA_VERSION: ollamaVersion ?? '',
	EXTENSIONS: extensions.results.map(result => `${result.what} ${result.version ?? 'not installed'}`).join(', '),
	FINDINGS: findings ?? '',
	GATEKEEPER: `${met} of ${evidence.requirements.length} requirements met${evidence.passed ? '' : ' (NOT ACCEPTED)'}`,
	SMOKE: `${smokeChecks.length - smokeFailed} of ${smokeChecks.length} checks passed`,
	CLEAN_INSTALL: cleanInstall ? `[recording](${cleanInstall})` : 'not yet run for this candidate (docs/RUNBOOK-clean-install.md); the release is not published until it is',
};

let notes = fs.readFileSync(path.join(repoRoot, 'docs', 'release', 'NOTES-TEMPLATE.md'), 'utf8');
notes = notes.replace(/\{\{(?<name>[A-Z0-9_]+)\}\}/g, (whole, name: string) => values[name] ?? whole);
const unfilled = [...new Set(notes.match(/\{\{[A-Z0-9_]+\}\}/g) ?? [])];
if (unfilled.length) {
	problems.push(`placeholders left unfilled: ${unfilled.join(', ')}`);
}
if (problems.length) {
	for (const problem of problems) {
		console.error(`make-release-notes: ${problem}`);
	}
	process.exit(1);
}
if (evidence.adHocRehearsal || !evidence.passed) {
	notes = `> **REHEARSAL, NOT A RELEASE.** The artifact named here is ad-hoc signed and not notarized. These notes exist to test the template.\n\n${notes}`;
}
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, notes);
console.log(`release notes: ${path.relative(process.cwd(), outFile)} (${notes.split('\n').length} lines)`);
