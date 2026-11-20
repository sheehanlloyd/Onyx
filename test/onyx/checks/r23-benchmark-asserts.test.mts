/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * R-23 (A7): `run-benchmarks.mts` with an injected marker leak exits non-zero.
 *
 * The injection is a defect in the product module under test, not a switch in
 * the benchmark: a copy of the compiled `out/` tree (an overlay of symlinks)
 * in which `parseInlineEdits` passes the model's reply through untouched, so
 * every SEARCH/REPLACE marker leaks into the "parsed" edit. The benchmark is
 * pointed at that tree with `--module-root` and must fail the process and
 * name the violated invariant. The unmodified tree must still exit zero.
 *
 * Needs a current `pnpm run transpile-client`.
 *
 *   node --test test/onyx/checks/r23-benchmark-asserts.test.mts
 */

import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const benchmarks = path.join(repoRoot, 'test', 'onyx', 'run-benchmarks.mts');
const outDir = path.join(repoRoot, 'out');
const parserModule = 'vs/workbench/contrib/onyx/common/onyxInlineEdit.js';

/**
 * Builds a tree that resolves every module to the real `out/` through
 * symlinks, except the one file on `relative`, which is written transformed.
 * Node resolves symlinks to real paths, so shared modules keep one identity.
 */
function overlay(relative: string, transform: (source: string) => string): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onyx-r23-'));
	const segments = relative.split('/');
	let realDir = outDir;
	let overlayDir = root;
	for (let depth = 0; depth < segments.length; depth++) {
		const segment = segments[depth];
		for (const entry of fs.readdirSync(realDir)) {
			if (entry !== segment) {
				fs.symlinkSync(path.join(realDir, entry), path.join(overlayDir, entry));
			}
		}
		if (depth === segments.length - 1) {
			fs.writeFileSync(path.join(overlayDir, segment), transform(fs.readFileSync(path.join(realDir, segment), 'utf8')));
		} else {
			fs.mkdirSync(path.join(overlayDir, segment));
			realDir = path.join(realDir, segment);
			overlayDir = path.join(overlayDir, segment);
		}
	}
	return root;
}

function runBenchmarks(moduleRoot: string) {
	const result = spawnSync(process.execPath, [benchmarks, '--skip-models', '--module-root', moduleRoot], { cwd: repoRoot, encoding: 'utf8' });
	return { status: result.status, output: result.stdout + result.stderr };
}

test('R-23: the unmodified tree passes every invariant and exits zero', { timeout: 120_000 }, () => {
	assert.equal(fs.existsSync(path.join(outDir, parserModule)), true, 'run `pnpm run transpile-client` first');
	const { status, output } = runBenchmarks(outDir);
	assert.deepStrictEqual({ status, violated: /invariant\(s\) violated/.test(output), byConstructionRow: /by construction/.test(output) }, { status: 0, violated: false, byConstructionRow: false }, output.slice(-600));
});

test('R-23: an injected marker leak in the parser fails the process and names the invariant', { timeout: 120_000 }, () => {
	const leaking = overlay(parserModule, source => {
		const declaration = 'function parseInlineEdits(reply) {';
		assert.equal(source.includes(declaration), true, `${parserModule} no longer declares ${declaration}`);
		// The defect: the "parser" returns the reply verbatim as a rewrite, so
		// every marker in the model's text reaches the edit.
		return source.replace(declaration, 'function parseInlineEditsLeaking(reply) {')
			+ '\nfunction parseInlineEdits(reply) { return { kind: \'rewrite\', text: reply }; }\n';
	});
	try {
		const { status, output } = runBenchmarks(leaking);
		assert.deepStrictEqual({
			status: status === 0 ? 'zero' : 'non-zero',
			namesTheLeak: /fuzz marker leaks = \d+ leaks, must be 0/.test(output),
			namesTheMarkerWrite: /format markers written into a file = \d+ cases, must be 0/.test(output),
		}, { status: 'non-zero', namesTheLeak: true, namesTheMarkerWrite: true }, output.slice(-900));
	} finally {
		fs.rmSync(leaking, { recursive: true, force: true });
	}
});
