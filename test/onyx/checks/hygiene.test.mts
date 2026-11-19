/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * A6: the scoped hygiene check against disposable fixture trees. A clean
 * fixture passes; a deliberately injected NUL byte, an unlisted image and a
 * URL outside the allowlist each fail with the file named.
 *
 *   node --test test/onyx/checks/hygiene.test.mts
 */

import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const hygieneScript = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'run-hygiene.mts');

/** A minimal tree that satisfies every check. */
function cleanFixture(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onyx-hygiene-'));
	const write = (relative: string, content: string | Buffer) => {
		const full = path.join(root, relative);
		fs.mkdirSync(path.dirname(full), { recursive: true });
		fs.writeFileSync(full, content);
	};
	write('src/vs/workbench/contrib/onyx/common/example.ts', 'export const separator = \'\\0\';\n');
	write('product.json', JSON.stringify({ licenseUrl: 'https://github.com/sheehanlloyd/Onyx/blob/main/LICENSE.txt' }));
	write('extensions/theme-onyx/package.json', JSON.stringify({ repository: { url: 'https://github.com/sheehanlloyd/Onyx.git' } }));
	write('.github/SECURITY.md', 'Report at https://github.com/sheehanlloyd/Onyx/security/advisories/new\n');
	write('.github/ISSUE_TEMPLATE/config.yml', 'contact_links:\n  - url: https://github.com/microsoft/vscode/issues\n');
	write('docs/images/shot.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]));
	write('docs/images/MANIFEST.md', '| File | Source | Model | Date | Notes |\n|---|---|---|---|---|\n| `shot.png` | dev | unknown | 2026-01-01 | fixture |\n');
	return root;
}

function runHygiene(root: string) {
	const result = spawnSync(process.execPath, [hygieneScript, '--root', root], { encoding: 'utf8' });
	return { status: result.status, stdout: result.stdout };
}

function lines(stdout: string, pattern: RegExp): string[] {
	return stdout.split('\n').map(line => line.trim()).filter(line => pattern.test(line));
}

test('A6: a clean fixture passes every check', () => {
	const root = cleanFixture();
	try {
		const { status, stdout } = runHygiene(root);
		assert.deepStrictEqual({ status, failed: lines(stdout, /^FAIL/) }, { status: 0, failed: [] });
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test('A6: an injected NUL byte in an Onyx source file fails the nul-bytes check and names the file', () => {
	const root = cleanFixture();
	try {
		fs.writeFileSync(path.join(root, 'src/vs/workbench/contrib/onyx/common/example.ts'), Buffer.from('const s = \'\0\';\n', 'utf8'));
		const { status, stdout } = runHygiene(root);
		assert.deepStrictEqual({
			status,
			failed: lines(stdout, /^FAIL/).map(line => line.split(/\s+/)[1]),
			named: stdout.includes('src/vs/workbench/contrib/onyx/common/example.ts:1 contains a NUL byte'),
		}, { status: 1, failed: ['nul-bytes'], named: true });
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test('A6: an unlisted image, a stale string and a URL outside the allowlist each fail their own check', () => {
	const root = cleanFixture();
	try {
		fs.writeFileSync(path.join(root, 'docs/images/unlisted.png'), Buffer.from([0x89]));
		fs.writeFileSync(path.join(root, 'README.md'), 'Clone https://github.com/sheehanlloyd/cursor2.0 into /Users/someone/src\n');
		fs.writeFileSync(path.join(root, '.github/ISSUE_TEMPLATE/config.yml'), 'contact_links:\n  - url: https://example.com/elsewhere\n');
		const { status, stdout } = runHygiene(root);
		assert.deepStrictEqual({
			status,
			failed: lines(stdout, /^FAIL/).map(line => line.split(/\s+/)[1]),
			problems: lines(stdout, /unlisted\.png|README\.md:1|config\.yml:2/),
		}, {
			status: 1,
			failed: ['stale-strings', 'identity-urls', 'image-manifest'],
			problems: [
				'README.md:1 contains "cursor2.0"',
				'README.md:1 contains "/Users/"',
				'.github/ISSUE_TEMPLATE/config.yml:2 carries a URL outside the allowlist: https://example.com/elsewhere',
				'docs/images/unlisted.png is not listed in docs/images/MANIFEST.md',
			],
		});
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
