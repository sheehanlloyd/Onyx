/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The completion reports of a module's items say what Section 13's template
 * asks for (A12). Before this check the gate counted a report as recorded when
 * its file existed.
 *
 *   node test/onyx/checks/item-reports.mts <item> [<item> ...]
 *
 * For each item, `docs/progress/<item>.md` must exist; it must name the item on
 * its `Item:` line and the module on its `Module:` line; it must have every
 * field of the template that says what was done and how it was checked
 * (`Branch / PR`, `What changed`, `Regression tests added`, `Source revision /
 * local diff`, `Fresh output`, `Human action needed`); and the commit its
 * `Source revision` line names must exist in this repository. The content of a
 * field is not judged: that is a reviewer's job. An empty field is.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** The template's fields that every report carries, in its order. */
const requiredFields = ['Branch / PR', 'What changed', 'Regression tests added', 'Source revision / local diff', 'Fresh output', 'Human action needed'] as const;

/** What is wrong with one item's report; empty when nothing is. */
export function reportProblems(item: string, text: string, commitExists: (commit: string) => boolean): string[] {
	const problems: string[] = [];
	const lines = text.split('\n');
	/** A field's text: the rest of its line, and the indented lines that continue it. Undefined when the field is absent. */
	const field = (name: string): string | undefined => {
		const index = lines.findIndex(line => line.trimStart().startsWith(`${name}:`));
		if (index === -1) {
			return undefined;
		}
		const continued: string[] = [];
		for (let next = index + 1; next < lines.length && /^\s+\S/.test(lines[next]) && !/^\s*[A-Z][\w /]*:/.test(lines[next]); next++) {
			continued.push(lines[next].trim());
		}
		return [lines[index].trimStart().slice(name.length + 1).trim(), ...continued].join(' ').trim();
	};
	const itemLine = field('Item');
	if (itemLine === undefined || !new RegExp(`^\\s*${item}\\b`).test(itemLine)) {
		problems.push(`its Item: line does not name ${item}`);
	}
	if (!/^\s*[1-5]\b/.test(field('Module') ?? '')) {
		problems.push('its Module: line names no module');
	}
	for (const name of requiredFields) {
		const value = field(name);
		if (value === undefined) {
			problems.push(`no "${name}:" field`);
		} else if (!value) {
			problems.push(`the "${name}:" field is empty`);
		}
	}
	const revision = field('Source revision / local diff') ?? '';
	const commit = /\b(?<commit>[0-9a-f]{7,40})\b/.exec(revision)?.groups?.commit;
	if (!commit) {
		problems.push('its Source revision names no commit');
	} else if (!commitExists(commit)) {
		problems.push(`its Source revision names ${commit}, which is not a commit of this repository`);
	}
	return problems;
}

function commitExists(commit: string): boolean {
	return spawnSync('git', ['-C', repoRoot, 'cat-file', '-e', `${commit}^{commit}`]).status === 0;
}

function main(): number {
	const items = process.argv.slice(2);
	if (!items.length) {
		console.error('usage: node test/onyx/checks/item-reports.mts <item> [<item> ...]');
		return 2;
	}
	let failed = 0;
	for (const item of items) {
		const file = path.join(repoRoot, 'docs', 'progress', `${item}.md`);
		const problems = fs.existsSync(file) ? reportProblems(item, fs.readFileSync(file, 'utf8'), commitExists) : ['the report does not exist'];
		if (problems.length) {
			failed++;
			console.log(`${item}: ${problems.join('; ')}`);
		}
	}
	console.log(failed ? `${failed} of ${items.length} reports are incomplete` : `all ${items.length} reports have the template's fields and name a commit of this repository`);
	return failed ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	process.exit(main());
}
