/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * R-40 (B5, DEC-02), the source-scan half: no Onyx product file outside the
 * runner seam names a shell path or a signal, starts a process through a
 * shell, or spawns one itself.
 *
 * The seam is `src/vs/platform/onyxRuntime/node/onyxCommandRunner.ts`. It is
 * the one module that decides which shell runs a command, with which spawn
 * options, and how the process tree is ended; Milestone M2 fills in its
 * `win32` branch, and nothing else has to change for that.
 *
 * Scope: the product sources Onyx owns, `src/vs/platform/onyxRuntime/` and
 * `src/vs/workbench/contrib/onyx/`, without their `test/` folders. A test has
 * to name a signal to prove a process group is gone, and the harness scripts
 * under `test/onyx/` manage their own child processes; neither ships.
 *
 * The other half of R-40, the seam under simulated platforms, is the
 * `OnyxCommandRunner` unit suite.
 *
 *   node --test test/onyx/checks/r40-runner-seam.test.mts
 */

import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SEAM = 'src/vs/platform/onyxRuntime/node/onyxCommandRunner.ts';
const PRODUCT_ROOTS = ['src/vs/platform/onyxRuntime', 'src/vs/workbench/contrib/onyx'];

/** What only the seam may contain. Each is a way of choosing a shell or of ending a process. */
const SEAM_ONLY: readonly { readonly what: string; readonly pattern: RegExp }[] = [
	{ what: 'a POSIX shell path', pattern: /(?:\/usr)?\/bin\/(?:ba|z|da|k|c|tc|fi)?sh\b/ },
	{ what: 'a Windows shell executable', pattern: /\b(?:cmd|powershell|pwsh)\.exe\b/i },
	{ what: 'a signal name', pattern: /\bSIG(?:KILL|TERM|INT|HUP|QUIT|STOP|ABRT|USR1|USR2)\b/ },
	{ what: 'a spawn through a shell', pattern: /\bshell\s*:\s*(?:true|['"`])/ },
	{ what: 'a process started through a shell (`exec`, `execSync`)', pattern: /\bexec(?:Sync)?\s*\(\s*['"`]/ },
	{ what: 'a spawned process', pattern: /\bspawn(?:Sync)?\s*\(/ },
	{ what: 'a process kill', pattern: /\bprocess\.kill\s*\(/ },
];

function productSources(): string[] {
	const files: string[] = [];
	const walk = (directory: string) => {
		for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
			const absolute = path.join(directory, entry.name);
			if (entry.isDirectory()) {
				if (entry.name !== 'test') {
					walk(absolute);
				}
			} else if (entry.name.endsWith('.ts')) {
				files.push(path.relative(repoRoot, absolute).split(path.sep).join('/'));
			}
		}
	};
	for (const root of PRODUCT_ROOTS) {
		walk(path.join(repoRoot, root));
	}
	return files.sort();
}

/** Source lines with comments removed, so prose about a shell is not mistaken for one. */
function codeLines(file: string): { readonly line: number; readonly text: string }[] {
	const source = fs.readFileSync(path.join(repoRoot, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, comment => comment.replace(/[^\n]/g, ' '));
	return source.split('\n').map((text, index) => ({ line: index + 1, text: text.replace(/(^|\s)\/\/.*$/, '') }));
}

function findings(file: string): string[] {
	const found: string[] = [];
	for (const { line, text } of codeLines(file)) {
		for (const { what, pattern } of SEAM_ONLY) {
			if (pattern.test(text)) {
				found.push(`${file}:${line}: ${what}`);
			}
		}
	}
	return found;
}

test('R-40: no Onyx product file outside the runner seam names a shell path or a signal, or starts a process itself', () => {
	const files = productSources();
	assert.ok(files.length > 100, `expected the Onyx product sources, found ${files.length} files`);
	assert.ok(files.includes(SEAM), `${SEAM} is missing: there is no seam`);
	const outside = files.filter(file => file !== SEAM).flatMap(findings);
	assert.deepEqual(outside, [], `shell and signal handling belongs in ${SEAM} only:\n${outside.join('\n')}`);
});

test('R-40: the scan is not vacuous: the seam itself is where the shell path, the spawn and the signal are', () => {
	const kinds = new Set(findings(SEAM).map(finding => finding.split(': ')[1]));
	assert.deepEqual([...kinds].sort(), ['a POSIX shell path', 'a process kill', 'a signal name']);
	// The seam takes `spawn` as a parameter (so tests can simulate a platform) and calls it through that
	// parameter; the import is the only place the real one is named.
	assert.match(fs.readFileSync(path.join(repoRoot, SEAM), 'utf8'), /import \{[^}]*\bspawn\b[^}]*\} from 'child_process';/);
});

test('R-40: the runtime service starts commands through the seam and no other way', () => {
	const service = fs.readFileSync(path.join(repoRoot, 'src/vs/platform/onyxRuntime/node/onyxRuntimeService.ts'), 'utf8');
	assert.match(service, /this\._commandRunner\.start\(/);
	assert.doesNotMatch(service, /import \{[^}]*\bspawn\b[^}]*\} from 'child_process';/);
});
