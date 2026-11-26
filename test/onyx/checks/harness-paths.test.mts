/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * A4: the harness must run in a checkout that has no `.claude/` symlink. That
 * link is created by `build/npm/postinstall.ts` and is not tracked, so a
 * checkout that has not been installed lacks it; every script under test/onyx
 * resolves the tracked `.agents/skills/launch/` path and never `.claude/`.
 *
 *   node --test test/onyx/checks/harness-paths.test.mts
 */

import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const harnessDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(harnessDir, '..', '..');

test('A4: no harness script depends on the .claude symlink', () => {
	const offenders: string[] = [];
	for (const name of fs.readdirSync(harnessDir)) {
		if (!name.endsWith('.mts')) {
			continue;
		}
		const lines = fs.readFileSync(path.join(harnessDir, name), 'utf8').split('\n');
		lines.forEach((line, index) => {
			if (line.includes('\'.claude\'') || line.includes('.claude/')) {
				offenders.push(`test/onyx/${name}:${index + 1}`);
			}
		});
	}
	assert.deepStrictEqual(offenders, []);
});

test('A4: the launch scripts the harness drives exist at their tracked path', () => {
	const launch = path.join(repoRoot, '.agents', 'skills', 'launch');
	assert.deepStrictEqual({
		focusScript: fs.existsSync(path.join(launch, 'playwrightScripts', 'focus-chat-input.ts')),
		paste: fs.existsSync(path.join(launch, 'scripts', 'monaco-paste.sh')),
	}, { focusScript: true, paste: true });
});

test('every harness runner that takes --json-out makes the directory it writes the record to', () => {
	// The module 5 gate of 2026-11-26 lost three records, one of them after a 19-minute egress audit, because
	// the runners wrote to `.build/gate-5/` and nothing had made that directory.
	const offenders = fs.readdirSync(harnessDir)
		.filter(name => name.endsWith('.mts'))
		.filter(name => {
			const text = fs.readFileSync(path.join(harnessDir, name), 'utf8');
			return text.includes('\'--json-out\'') && !/mkdirSync\(path\.dirname\(/.test(text);
		});
	assert.deepStrictEqual(offenders, []);
});
