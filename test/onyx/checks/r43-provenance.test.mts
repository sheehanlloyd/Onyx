/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * R-43 (L3, Section 10): trace and experiment provenance at the harness
 * layer. The chart builder refuses to draw without a valid manifest and
 * stamps the manifest on every chart it draws; the mock runtime echoes a
 * requested seed on the wire, which is what the product reads to record
 * `seedHonoured`; the example manifest validates and a results directory
 * without its files is refused. The product-side halves of R-43 are
 * `onyxTrace.test.ts` (schema), `onyxRuntimeService.test.ts` (the seed on
 * the wire and honoured) and the simulator's R-43 (every run journals a
 * valid v2 trace); the end-to-end suite checks the journal of a real run.
 *
 *   node --test test/onyx/checks/r43-provenance.test.mts
 */

import { strict as assert } from 'node:assert';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const makeCharts = path.join(repoRoot, 'test', 'onyx', 'make-charts.mts');
const manifestTool = path.join(repoRoot, 'test', 'onyx', 'lab', 'manifest.mts');
const exampleManifest = path.join(repoRoot, 'test', 'onyx', 'lab', 'manifest.example.json');

/** The rows the always-drawn charts read; values are arbitrary, this is a provenance test, not a number test. */
function syntheticReport(): string {
	const names = ['BM25 hit@5', 'mean query latency', 'substring search hit@5', 'malformed edits recovered', 'format markers written into a file', 'fuzz crashes', 'fuzz inputs parsed', 'dangerous commands caught', 'everyday commands wrongly flagged', 'quoted danger still warns (by design)', 'files scanned', 'full scan time', 'files indexed', 'Onyx source lines', 'Onyx source files', 'Onyx unit tests', 'end-to-end checks'];
	return JSON.stringify({ provenance: syntheticProvenance(), results: names.map((name, index) => ({ group: 'synthetic', name, value: index + 1, unit: '' })), attempts: [], skipped: [] });
}

/** A report's provenance block as `run-benchmarks.mts` writes it (C8), for a run that measured no model. */
function syntheticProvenance() {
	return { schema: 1, generatedAt: '2026-11-21T00:00:00.000Z', commit: 'a'.repeat(40), dirty: false, command: ['--skip-models'], machine: { platform: 'test' }, runtimes: [], models: [], parameters: { skipModels: true } };
}

function charts(args: readonly string[], cwd: string) {
	const result = spawnSync(process.execPath, [makeCharts, ...args], { cwd, encoding: 'utf8' });
	return { status: result.status, stderr: result.stderr.split('\n')[0] };
}

test('R-43, C8: make-charts refuses without a manifest, with an invalid one, and from a report without its provenance block; it stamps the manifest and each report\'s commit on every chart it draws', () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onyx-r43-'));
	try {
		const report = path.join(dir, 'bench.json');
		fs.writeFileSync(report, syntheticReport());
		const invalid = path.join(dir, 'invalid.json');
		const manifest = JSON.parse(fs.readFileSync(exampleManifest, 'utf8')) as { models: { digest?: string }[] };
		delete manifest.models[0].digest;
		fs.writeFileSync(invalid, JSON.stringify(manifest));
		const outDir = path.join(dir, 'charts');
		// C8: a report with numbers and no word on where they came from, and one whose block lacks the commit.
		const bare = path.join(dir, 'bare.json');
		const parsed = JSON.parse(syntheticReport()) as { provenance?: { commit?: string }; attempts?: unknown };
		fs.writeFileSync(bare, JSON.stringify({ ...parsed, provenance: undefined }));
		const partial = path.join(dir, 'partial.json');
		fs.writeFileSync(partial, JSON.stringify({ ...parsed, provenance: { ...parsed.provenance, commit: undefined }, attempts: undefined }));
		const outcomes = {
			reportWithoutProvenance: charts(['--manifest', exampleManifest, '--out-dir', outDir, bare], dir),
			reportWithPartialProvenance: charts(['--manifest', exampleManifest, '--out-dir', outDir, partial], dir),
			nothingDrawnFromThem: !fs.existsSync(outDir),
			noManifest: charts([report], dir),
			invalidManifest: charts(['--manifest', invalid, report], dir),
			valid: charts(['--manifest', exampleManifest, '--out-dir', outDir, report], dir),
		};
		const drawn = fs.existsSync(outDir) ? fs.readdirSync(outDir).filter(name => name.endsWith('.svg')).sort() : [];
		const stamped = drawn.every(name => fs.readFileSync(path.join(outDir, name), 'utf8').startsWith('<!-- provenance: manifest 2026-11-19-example; models mock:mock-coder:7b@mock; reports bench.json@aaaaaaaaaaa -->\n<svg'));
		assert.deepStrictEqual({ ...outcomes, drawn, stamped }, {
			reportWithoutProvenance: { status: 2, stderr: 'make-charts: refusing to draw from bare.json: no "provenance" block (C8: a chart is drawn only from a report that says where it came from; produce one with run-benchmarks.mts --json-out)' },
			reportWithPartialProvenance: { status: 2, stderr: 'make-charts: refusing to draw from partial.json: provenance.commit is not a commit hash; "attempts" (every repository-benchmark attempt) is not a list (C8: a chart is drawn only from a report that says where it came from; produce one with run-benchmarks.mts --json-out)' },
			nothingDrawnFromThem: true,
			noManifest: { status: 2, stderr: 'make-charts: refusing to draw without --manifest <manifest.json> (L3: every published number carries its provenance)' },
			invalidManifest: { status: 2, stderr: `make-charts: refusing to draw: manifest ${invalid} is invalid:` },
			valid: { status: 0, stderr: '' },
			drawn: ['chart-parsers.svg', 'chart-retrieval.svg', 'chart-scale.svg', 'chart-terminal.svg', 'chart-tests.svg'],
			stamped: true,
		});
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test('R-43: the example manifest validates; a results directory without its files is refused', () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onyx-r43-results-'));
	try {
		const results = path.join(dir, '2026-11-19-example');
		fs.mkdirSync(results);
		fs.copyFileSync(exampleManifest, path.join(results, 'manifest.json'));
		const validate = (args: readonly string[]) => {
			const result = spawnSync(process.execPath, [manifestTool, ...args], { cwd: repoRoot, encoding: 'utf8' });
			return { status: result.status, errors: result.stderr.trim().split('\n').filter(Boolean).map(line => line.replace(results, '<dir>')) };
		};
		assert.deepStrictEqual({ example: validate([exampleManifest]), results: validate(['--results', results]) }, {
			example: { status: 0, errors: [] },
			results: { status: 1, errors: ['<dir>: no summary.json', '<dir>: neither traces/ nor trace-digests.json'] },
		});
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

/** The seed and fingerprint each streamed chunk carried, and whether the stream finished. */
async function seedsOnTheWire(port: number, body: unknown): Promise<{ readonly seeds: unknown[]; readonly fingerprints: unknown[]; readonly done: boolean }> {
	const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
	const raw = await response.text();
	const seeds: unknown[] = [];
	const fingerprints: unknown[] = [];
	let done = false;
	for (const line of raw.split('\n')) {
		if (!line.startsWith('data:')) {
			continue;
		}
		const payload = line.slice(5).trim();
		if (payload === '[DONE]') {
			done = true;
			continue;
		}
		const chunk = JSON.parse(payload) as { seed?: number; system_fingerprint?: string; choices?: { delta?: { content?: string } }[] };
		if (chunk.choices?.[0]?.delta?.content !== undefined) {
			seeds.push(chunk.seed);
			fingerprints.push(chunk.system_fingerprint);
		}
	}
	return { seeds: [...new Set(seeds)], fingerprints: [...new Set(fingerprints)], done };
}

test('R-43: the mock runtime echoes a requested seed on every text chunk, and nothing when none was sent', { timeout: 60_000 }, async () => {
	const port = 11500 + Math.floor(Math.random() * 500);
	const mock = spawn(process.execPath, [path.join(repoRoot, 'test', 'onyx', 'mock-ollama.mts')], { cwd: repoRoot, env: { ...process.env, ONYX_MOCK_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
	let stderr = '';
	mock.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
	mock.stdout?.on('data', () => { /* drained so the pipe never fills */ });
	try {
		const deadline = Date.now() + 15_000;
		let up = false;
		while (Date.now() < deadline && !up) {
			try {
				up = (await fetch(`http://127.0.0.1:${port}/api/tags`)).ok;
			} catch {
				await new Promise(resolve => setTimeout(resolve, 200));
			}
		}
		assert.ok(up, `mock did not start: ${stderr}`);
		const request = (seed?: number) => ({ model: 'mock-coder:7b', stream: true, messages: [{ role: 'user', content: 'say hello' }], ...(seed !== undefined ? { seed } : {}) });
		assert.deepStrictEqual({ seeded: await seedsOnTheWire(port, request(42)), unseeded: await seedsOnTheWire(port, request()) }, {
			seeded: { seeds: [42], fingerprints: ['fp_mock'], done: true },
			unseeded: { seeds: [undefined], fingerprints: [undefined], done: true },
		});
	} finally {
		mock.kill();
	}
});
