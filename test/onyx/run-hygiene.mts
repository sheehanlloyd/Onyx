/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Scoped hygiene check (A2, A3, A6). Catches shipped mistakes, not test fixtures.
 *
 *   node test/onyx/run-hygiene.mts [--root <dir>] [--only <check>[,<check>]] [--json-out <file>]
 *
 * Checks, each printed as one line and all run before the exit code is decided:
 *   nul-bytes        no NUL byte in a text file under the Onyx paths (byte check, so a
 *                    NUL-containing source file is not skipped as "binary")
 *   stale-strings    `cursor2.0` nowhere in the tree, and `/Users/` nowhere in the Onyx
 *                    scope, outside docs/*Audit*.md, docs/ActionPlan.md and test fixtures
 *   identity-urls    product.json, extensions/theme-onyx/package.json, .github/SECURITY.md
 *                    and .github/ISSUE_TEMPLATE/config.yml carry only allowlisted URLs
 *   image-manifest   every file under docs/images/ has a row in docs/images/MANIFEST.md
 *                    with a source (packaged or dev), a model and a date
 *   inherited-automation  only Onyx-owned workflows (onyx-*.yml) exist under .github/workflows,
 *                    and upstream's CODEOWNERS, dependabot and issue-bot configurations are
 *                    absent, so nothing inherited can execute or request reviews (A11)
 *
 * Exit code 1 when any check fails. Widen an allowlist here rather than deleting a fixture.
 */

import fs from 'node:fs';
import path from 'node:path';

function argValue(flag: string): string | undefined {
	const index = process.argv.indexOf(flag);
	return index === -1 ? undefined : process.argv[index + 1];
}

const root = path.resolve(argValue('--root') ?? path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..'));
const only = argValue('--only')?.split(',').map(check => check.trim()).filter(Boolean);
const jsonOut = argValue('--json-out');

/** Paths Onyx owns (Section 0, Rule 5) plus the identity and documentation files it ships. */
const ONYX_SCOPE = [
	'src/vs/platform/onyxRuntime',
	'src/vs/workbench/contrib/onyx',
	'extensions/theme-onyx',
	'test/onyx',
	'docs',
	'.github/workflows',
	'.github/SECURITY.md',
	'.github/CONTRIBUTING.md',
	'.github/CODE_OF_CONDUCT.md',
	'.github/ISSUE_TEMPLATE',
	'.github/pull_request_template.md',
	'.github/README.md',
	'README.md',
	'ONYX.md',
	'LAUNCH.md',
	'REBASE.md',
	'NOTICE.md',
	'TRADEMARK.md',
	'product.json',
];

const TEXT_EXTENSIONS = new Set(['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs', '.json', '.md', '.css', '.yml', '.yaml', '.html', '.svg', '.txt', '.sh', '.ps1', '.tmLanguage', '.plist']);

/** Files that may quote the old identity or a developer path: the audits, the plan and test fixtures. */
const STALE_STRING_EXEMPT = [
	/^docs\/[^/]*Audit[^/]*\.md$/,
	/^docs\/ActionPlan\.md$/,
	/^test\/onyx\/checks\/fixtures\//,
	/(^|\/)test\/.*\/fixtures\//,
	// The checker and its test name the strings they look for.
	/^test\/onyx\/run-hygiene\.mts$/,
	/^test\/onyx\/checks\/hygiene\.test\.mts$/,
];

const IDENTITY_FILES = ['product.json', 'extensions/theme-onyx/package.json', '.github/SECURITY.md', '.github/ISSUE_TEMPLATE/config.yml'];

/** Every URL an identity file may carry. Add here, with a reason, rather than loosening the check. */
const URL_ALLOWLIST: readonly string[] = [
	'https://github.com/sheehanlloyd/Onyx/', // the project (A3; D7 updates it if DEC-01 renames)
	'https://github.com/sheehanlloyd/Onyx.git', // the theme extension's repository field
	'https://github.com/microsoft/vscode/issues', // stock VS Code bugs go upstream (config.yml)
	'https://github.com/microsoft/vscode-js-debug', // built-in debugger, from upstream product.json
	'https://github.com/microsoft/vscode-js-debug-companion',
	'https://github.com/microsoft/vscode-js-profile-visualizer',
	'https://msrc.microsoft.com/create-report', // upstream security contact (SECURITY.md)
	// `defaultChatAgent` is kept in product.json because core dereferences it without guards (REBASE.md).
	'https://aka.ms/github-copilot-manage-plan',
	'https://aka.ms/github-copilot-match-public-code',
	'https://aka.ms/github-copilot-overview',
	'https://aka.ms/github-copilot-plans',
	'https://aka.ms/github-copilot-privacy-statement',
	'https://aka.ms/github-copilot-terms-statement',
	'https://aka.ms/github-copilot-upgrade-plan',
	'https://aka.ms/github-sign-up',
	'https://aka.ms/token-usage-tips',
	'https://api.github.com/copilot/mcp_registry',
	'https://api.github.com/copilot_internal/',
];

const SKIP_DIRECTORIES = new Set(['node_modules', '.git', 'out', '.build', 'dist', 'coverage']);

interface ICheckResult {
	readonly check: string;
	readonly ok: boolean;
	readonly scanned: number;
	readonly problems: string[];
}

function* walk(directory: string): Generator<string> {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(directory, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		const full = path.join(directory, entry.name);
		if (entry.isDirectory()) {
			if (!SKIP_DIRECTORIES.has(entry.name)) {
				yield* walk(full);
			}
		} else if (entry.isFile()) {
			yield full;
		}
	}
}

function* scopeFiles(scope: readonly string[]): Generator<string> {
	for (const relative of scope) {
		const full = path.join(root, relative);
		if (!fs.existsSync(full)) {
			continue;
		}
		if (fs.statSync(full).isDirectory()) {
			yield* walk(full);
		} else {
			yield full;
		}
	}
}

function relative(file: string): string {
	return path.relative(root, file).split(path.sep).join('/');
}

function isTextFile(file: string): boolean {
	return TEXT_EXTENSIONS.has(path.extname(file));
}

function checkNulBytes(): ICheckResult {
	const problems: string[] = [];
	let scanned = 0;
	for (const file of scopeFiles(ONYX_SCOPE)) {
		if (!isTextFile(file)) {
			continue;
		}
		scanned++;
		const bytes = fs.readFileSync(file);
		const offset = bytes.indexOf(0);
		if (offset !== -1) {
			const line = bytes.subarray(0, offset).toString('utf8').split('\n').length;
			problems.push(`${relative(file)}:${line} contains a NUL byte at offset ${offset}`);
		}
	}
	return { check: 'nul-bytes', ok: problems.length === 0, scanned, problems };
}

function isStaleStringExempt(file: string): boolean {
	const name = relative(file);
	return STALE_STRING_EXEMPT.some(pattern => pattern.test(name));
}

function checkStaleStrings(): ICheckResult {
	const problems: string[] = [];
	let scanned = 0;
	const report = (file: string, needle: string, text: string) => {
		let index = text.indexOf(needle);
		while (index !== -1) {
			const line = text.slice(0, index).split('\n').length;
			problems.push(`${relative(file)}:${line} contains "${needle}"`);
			index = text.indexOf(needle, index + needle.length);
		}
	};
	// The old identity may appear nowhere in the tree (A3's done-when is a whole-tree grep).
	for (const file of walk(root)) {
		if (!isTextFile(file) || isStaleStringExempt(file)) {
			continue;
		}
		scanned++;
		const text = fs.readFileSync(file, 'utf8');
		report(file, 'cursor2.0', text);
	}
	// A developer's home directory may not leak into anything Onyx ships.
	for (const file of scopeFiles(ONYX_SCOPE)) {
		if (!isTextFile(file) || isStaleStringExempt(file)) {
			continue;
		}
		report(file, '/Users/', fs.readFileSync(file, 'utf8'));
	}
	return { check: 'stale-strings', ok: problems.length === 0, scanned, problems };
}

function checkIdentityUrls(): ICheckResult {
	const problems: string[] = [];
	let scanned = 0;
	for (const name of IDENTITY_FILES) {
		const file = path.join(root, name);
		if (!fs.existsSync(file)) {
			problems.push(`${name} is missing`);
			continue;
		}
		scanned++;
		const text = fs.readFileSync(file, 'utf8');
		for (const match of text.matchAll(/https?:\/\/[^\s"'<>)\]]+/g)) {
			const url = match[0].replace(/[.,;:]+$/, '');
			if (!URL_ALLOWLIST.some(allowed => url === allowed || url.startsWith(allowed) || `${url}/` === allowed)) {
				const line = text.slice(0, match.index).split('\n').length;
				problems.push(`${name}:${line} carries a URL outside the allowlist: ${url}`);
			}
		}
	}
	return { check: 'identity-urls', ok: problems.length === 0, scanned, problems };
}

function checkImageManifest(): ICheckResult {
	const problems: string[] = [];
	const imagesDir = path.join(root, 'docs', 'images');
	const manifestPath = path.join(imagesDir, 'MANIFEST.md');
	if (!fs.existsSync(imagesDir)) {
		return { check: 'image-manifest', ok: true, scanned: 0, problems };
	}
	const images = fs.existsSync(imagesDir) ? fs.readdirSync(imagesDir).filter(name => name !== 'MANIFEST.md' && fs.statSync(path.join(imagesDir, name)).isFile()) : [];
	if (!fs.existsSync(manifestPath)) {
		problems.push('docs/images/MANIFEST.md is missing');
		return { check: 'image-manifest', ok: false, scanned: images.length, problems };
	}
	const rows = new Map<string, { source: string; model: string; date: string }>();
	for (const line of fs.readFileSync(manifestPath, 'utf8').split('\n')) {
		const match = /^\|\s*`(?<file>[^`]+)`\s*\|\s*(?<source>[^|]*)\|\s*(?<model>[^|]*)\|\s*(?<date>[^|]*)\|/.exec(line);
		if (match?.groups) {
			rows.set(match.groups.file.trim(), { source: match.groups.source.trim(), model: match.groups.model.trim(), date: match.groups.date.trim() });
		}
	}
	for (const image of images) {
		const row = rows.get(image);
		if (!row) {
			problems.push(`docs/images/${image} is not listed in docs/images/MANIFEST.md`);
			continue;
		}
		if (!/^(packaged|dev)\b/.test(row.source)) {
			problems.push(`docs/images/${image}: source must be "packaged" or "dev", found "${row.source}"`);
		}
		if (!row.model) {
			problems.push(`docs/images/${image}: model is empty`);
		}
		if (!/^(\d{4}-\d{2}-\d{2}|unknown)$/.test(row.date)) {
			problems.push(`docs/images/${image}: date must be YYYY-MM-DD or "unknown", found "${row.date}"`);
		}
	}
	for (const listed of rows.keys()) {
		if (!images.includes(listed)) {
			problems.push(`docs/images/MANIFEST.md lists ${listed}, which does not exist`);
		}
	}
	return { check: 'image-manifest', ok: problems.length === 0, scanned: images.length, problems };
}

/** Upstream automation that A11 removed; its return would re-enable bots or reviewers. */
const INHERITED_AUTOMATION = [
	'.github/CODEOWNERS',
	'.github/CODENOTIFY',
	'.github/dependabot.yml',
	'.github/classifier.json',
	'.github/commands.json',
	'.github/commands',
	'.github/similarity.yml',
	'.github/insiders.yml',
	'.github/endgame',
	'.github/workflows/node_modules_cache',
	// Helpers of the workflows upstream added by 1.147.0 (DEC-05); the workflows themselves are caught by name below.
	'.github/workflows/caches',
	'.github/workflows/workspace_image',
];

function checkInheritedAutomation(): ICheckResult {
	const problems: string[] = [];
	let scanned = 0;
	const workflows = path.join(root, '.github', 'workflows');
	if (fs.existsSync(workflows)) {
		for (const entry of fs.readdirSync(workflows, { withFileTypes: true })) {
			scanned++;
			if (entry.isFile() && /\.ya?ml$/.test(entry.name) && !entry.name.startsWith('onyx-')) {
				problems.push(`.github/workflows/${entry.name} is an inherited workflow; only onyx-*.yml may exist (delete it, A11)`);
			}
		}
	}
	for (const relative of INHERITED_AUTOMATION) {
		scanned++;
		if (fs.existsSync(path.join(root, relative))) {
			problems.push(`${relative} is inherited automation configuration and must stay deleted (A11)`);
		}
	}
	if (!fs.existsSync(path.join(root, '.github', 'README.md'))) {
		problems.push('.github/README.md is missing: it explains what is inherited and inert');
	}
	return { check: 'inherited-automation', ok: problems.length === 0, scanned, problems };
}

const CHECKS: Record<string, () => ICheckResult> = {
	'nul-bytes': checkNulBytes,
	'stale-strings': checkStaleStrings,
	'identity-urls': checkIdentityUrls,
	'image-manifest': checkImageManifest,
	'inherited-automation': checkInheritedAutomation,
};

const selected = only ?? Object.keys(CHECKS);
const unknown = selected.filter(check => !(check in CHECKS));
if (unknown.length) {
	console.error(`unknown check(s): ${unknown.join(', ')}; known: ${Object.keys(CHECKS).join(', ')}`);
	process.exit(2);
}

const results = selected.map(check => CHECKS[check]());
for (const result of results) {
	console.log(`  ${result.ok ? 'ok  ' : 'FAIL'} ${result.check.padEnd(20)} ${result.scanned} ${result.check === 'image-manifest' ? 'images' : result.check === 'inherited-automation' ? 'entries' : 'files'}`);
	for (const problem of result.problems) {
		console.log(`         ${problem}`);
	}
}
if (jsonOut) {
	fs.mkdirSync(path.dirname(jsonOut), { recursive: true });
	fs.writeFileSync(jsonOut, JSON.stringify({ root, results }, undefined, '\t'));
}
const failed = results.filter(result => !result.ok);
console.log(failed.length ? `\nhygiene: ${failed.length} check(s) failed` : '\nhygiene: all checks passed');
process.exit(failed.length ? 1 : 0);
