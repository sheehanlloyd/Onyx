/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * R-29 (C9): the line diff at 6,000 lines, on the reference hardware, in
 * plain Node.
 *
 * Method. Each case runs in a process of its own, which imports the compiled
 * `common/onyxInlineEdit.js` from `out/` (so the import chain is proved to
 * load in plain Node on every run), builds its two texts, and then diffs
 * them five times, once, or not at all. The time is the best of the five.
 * The memory is the difference between the peak resident size of the
 * process that diffed once and of the one that did not: what one diff
 * needed at its worst, typed arrays included, which a heap figure would
 * miss.
 *
 * Targets (C9), for 6,000 lines a side:
 *   - 60 scattered edits:        at most 40 ms and 16 MiB
 *   - nothing in common at all:  at most 150 ms and 48 MiB
 * The table-based diff this replaces measured, by this same method, 588 ms
 * and 312 MiB with scattered edits and 215 ms and 313 MiB with nothing in
 * common (2026-11-21; the audit's probe had 218 ms and 206 MB). The second case is the worst there is: the search runs to its bound
 * (`ONYX_DIFF_MAX_DIFFERING_LINES`) and then answers with one hunk. Myers'
 * O(ND) is not a linear bound and none is claimed.
 *
 * The times are of this machine class (Apple M4 Pro). On another machine
 * the memory target still means something and the time target may not; set
 * ONYX_R29_SKIP_TIME=1 to check everything but the time there.
 *
 *   node --test test/onyx/checks/r29-diff-performance.test.mts
 */

import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const moduleUrl = pathToFileURL(path.join(repoRoot, 'out', 'vs', 'workbench', 'contrib', 'onyx', 'common', 'onyxInlineEdit.js')).href;

const LINES = 6000;

/** The script one case runs. Prints one JSON line. */
function caseScript(kind: 'scattered' | 'dissimilar', rounds: number): string {
	return `
		const { computeLineHunks } = await import(${JSON.stringify(moduleUrl)});
		const base = Array.from({ length: ${LINES} }, (_, index) => 'const value' + index + ' = compute(' + (index * 7919 % 1000) + ');');
		const other = ${kind === 'scattered'
		? `base.map((line, index) => index % 100 === 50 ? line + ' // changed' : line)`
		: `Array.from({ length: ${LINES} }, (_, index) => 'let other' + index + ' = another(' + index + ');')`};
		const a = base.join('\\n');
		const b = other.join('\\n');
		let best = Infinity;
		let hunks = -1;
		let reproduces = null;
		{
			for (let round = 0; round < ${rounds}; round++) {
				const started = performance.now();
				const result = computeLineHunks(a, b);
				best = Math.min(best, performance.now() - started);
				hunks = result.length;
				if (round === 0) {
					// Hunk correctness: the base with every hunk applied is the other text.
					const lines = base.slice();
					for (const hunk of result.slice().reverse()) {
						lines.splice(hunk.originalStart, hunk.originalLength, ...hunk.newLines);
					}
					reproduces = lines.join('\\n') === b;
				}
			}
		}
		console.log(JSON.stringify({ ms: best, hunks, reproduces, maxRssKiB: process.resourceUsage().maxRSS }));
	`;
}

function run(kind: 'scattered' | 'dissimilar', rounds: number): { ms: number; hunks: number; reproduces: boolean | null; maxRssKiB: number } {
	const result = spawnSync(process.execPath, ['--input-type=module', '-e', caseScript(kind, rounds)], { encoding: 'utf8', timeout: 120_000 });
	if (result.status !== 0) {
		throw new Error(`the ${kind} case did not complete: ${result.stderr.split('\n').slice(0, 3).join(' ')}`);
	}
	return JSON.parse(result.stdout.trim().split('\n').pop()!);
}

function measure(kind: 'scattered' | 'dissimilar') {
	const baseline = run(kind, 0);
	const once = run(kind, 1);
	const measured = run(kind, 5);
	// Node reports the peak resident size in kibibytes on every platform.
	return { ms: measured.ms, hunks: measured.hunks, reproduces: measured.reproduces, peakMiB: Math.max(0, (once.maxRssKiB - baseline.maxRssKiB) / 1024) };
}

test('R-29: 6,000 lines a side, with scattered edits and with nothing in common, within the time and memory C9 sets; the hunks reproduce the text; the module loads in plain Node', () => {
	assert.ok(fs.existsSync(fileURLToPath(moduleUrl)), 'run `pnpm run transpile-client` first: this check imports from out/');
	const skipTime = process.env.ONYX_R29_SKIP_TIME === '1';
	const scattered = measure('scattered');
	const dissimilar = measure('dissimilar');
	console.log(`R-29 measured: scattered ${scattered.ms.toFixed(1)} ms, ${scattered.peakMiB.toFixed(1)} MiB over the baseline, ${scattered.hunks} hunks; dissimilar ${dissimilar.ms.toFixed(1)} ms, ${dissimilar.peakMiB.toFixed(1)} MiB, ${dissimilar.hunks} hunk(s)`);
	assert.deepStrictEqual({
		scattered: { hunks: scattered.hunks, reproduces: scattered.reproduces, timeWithin40ms: skipTime || scattered.ms <= 40, memoryWithin16MiB: scattered.peakMiB <= 16 },
		dissimilar: { hunks: dissimilar.hunks, reproduces: dissimilar.reproduces, timeWithin150ms: skipTime || dissimilar.ms <= 150, memoryWithin48MiB: dissimilar.peakMiB <= 48 },
	}, {
		scattered: { hunks: 60, reproduces: true, timeWithin40ms: true, memoryWithin16MiB: true },
		dissimilar: { hunks: 1, reproduces: true, timeWithin150ms: true, memoryWithin48MiB: true },
	});
});
