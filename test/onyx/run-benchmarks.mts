/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Reproducible measurements for the numbers Onyx publishes.
 *
 *   node test/onyx/run-benchmarks.mts [--json | --json-out <path>] [--skip-models]
 *                                     [--speculative] [--rounds N] [--tasks N]
 *                                     [--tool-trials N]
 *
 * Two halves. The first runs against this repository and the pure Onyx modules,
 * so anyone can re-run it and get their own numbers rather than taking the
 * README's word for it: retrieval over the real source tree, the architecture
 * scan over the real 13k-file workspace, the parsers over the malformations
 * real models emit. The second half talks to the models actually installed on
 * this machine (Ollama, LM Studio) and measures speed, tool-call reliability
 * and how well each one reproduces this repository's own commits. A runtime
 * that is not running is skipped with a printed reason, so the first half
 * still runs in CI and on any other laptop.
 *
 * Requires a current `npm run transpile-client` (it imports from `out/`).
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const out = (relative: string) => path.join(repoRoot, 'out', relative);
const asJson = process.argv.includes('--json');
/** `--json-out <path>`: write the machine-readable report while still printing the human one. */
const jsonOut = process.argv[process.argv.indexOf('--json-out') + 1] && process.argv.includes('--json-out')
	? process.argv[process.argv.indexOf('--json-out') + 1]
	: undefined;

interface IResult {
	readonly group: string;
	readonly name: string;
	readonly value: number;
	readonly unit: string;
	readonly detail?: string;
	/** Set on rows measured against one specific local model. */
	readonly model?: string;
}
const results: IResult[] = [];
/** Everything that could not be measured here, and why — printed, and carried in the JSON. */
const skipped: string[] = [];
function record(group: string, name: string, value: number, unit: string, detail?: string, model?: string) {
	results.push({ group, name, value: Math.round(value * 100) / 100, unit, detail, model });
	if (!asJson) {
		console.log(`  ${name.padEnd(46)} ${String(Math.round(value * 100) / 100).padStart(9)} ${unit}${detail ? `   (${detail})` : ''}`);
	}
}

/**
 * Writes the machine-readable report as it stands. Called after every model so
 * that a run interrupted three quarters of the way through still yields usable
 * JSON for the models it finished — these runs take half an hour.
 */
function writeReport() {
	if (jsonOut) {
		fs.writeFileSync(jsonOut, JSON.stringify({ results, skipped }, undefined, '\t'));
	}
}

function section(title: string) {
	if (!asJson) {
		console.log(`\n${title}`);
		console.log('-'.repeat(title.length));
	}
}

/** Every indexable source file in this repository, excluding build output. */
function sourceFiles(root: string, extensions: ReadonlySet<string>, cap: number): string[] {
	const found: string[] = [];
	const skip = new Set(['node_modules', '.git', 'out', 'dist', 'build', '.build', 'coverage']);
	const stack = [root];
	while (stack.length && found.length < cap) {
		const dir = stack.pop()!;
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (entry.isDirectory()) {
				if (!skip.has(entry.name) && !entry.name.startsWith('.') && !entry.name.startsWith('out-')) {
					stack.push(path.join(dir, entry.name));
				}
			} else if (entry.isFile() && extensions.has(path.extname(entry.name))) {
				found.push(path.join(dir, entry.name));
				if (found.length >= cap) {
					break;
				}
			}
		}
	}
	return found;
}

// ---------------------------------------------------------------- retrieval
/**
 * Retrieval quality on this repository: for each query, does the file that
 * actually defines the thing appear in the top 5? BM25 is compared against the
 * substring search a naive agent would run.
 */
async function benchmarkRetrieval() {
	section('Retrieval — BM25 index vs substring search (this repository)');
	const { OnyxBm25Index, tokenize } = await import(out('vs/platform/onyxRuntime/common/onyxBm25.js'));

	// Natural-language queries paired with the file a correct answer must find.
	const queries: [query: string, mustFind: string][] = [
		['how are agent edits staged for review', 'onyxChangeSetService.ts'],
		['approval before running a shell command', 'onyxTerminalPolicy.ts'],
		['which runtimes support speculative decoding', 'onyxSpeculative.ts'],
		['score a model against past commits', 'onyxRepoBench.ts'],
		['resume an interrupted agent run', 'onyxResume.ts'],
		['parse the frontmatter of a playbook', 'onyxPlaybooks.ts'],
		['module dependency graph and hot spots', 'onyxArchitecture.ts'],
		['pick which local model serves a request', 'onyxRouterService.ts'],
		['repair a tool call the model wrote as prose', 'onyxTextToolCalls.ts'],
		['elide the middle of an oversized tool result', 'onyxContextCompression.ts'],
	];

	const files = sourceFiles(path.join(repoRoot, 'src', 'vs'), new Set(['.ts']), 12_000);
	const index = new OnyxBm25Index();
	const contents = new Map<string, string>();
	const buildStart = performance.now();
	for (const file of files) {
		try {
			const text = fs.readFileSync(file, 'utf8');
			const relative = path.relative(repoRoot, file);
			contents.set(relative, text);
			index.addDocument(relative, text);
		} catch {
			// unreadable file: skip
		}
	}
	const buildMs = performance.now() - buildStart;
	record('retrieval', 'files indexed', index.documentCount, 'files');
	record('retrieval', 'index build time', buildMs, 'ms', `${Math.round(index.documentCount / (buildMs / 1000))} files/s`);

	let bm25Hits = 0;
	let substringHits = 0;
	let bm25TotalMs = 0;
	for (const [query, mustFind] of queries) {
		const searchStart = performance.now();
		const hits = index.search(query, 5);
		bm25TotalMs += performance.now() - searchStart;
		if (hits.some((hit: { path: string }) => hit.path.endsWith(mustFind))) {
			bm25Hits++;
		}
		// What a substring search over the same corpus returns: every file
		// containing the query verbatim, which for a natural-language query is
		// almost always nothing.
		const substringMatches: string[] = [];
		for (const [relative, text] of contents) {
			if (text.includes(query)) {
				substringMatches.push(relative);
				if (substringMatches.length >= 5) {
					break;
				}
			}
		}
		if (substringMatches.some(match => match.endsWith(mustFind))) {
			substringHits++;
		}
	}
	record('retrieval', 'BM25 hit@5', (bm25Hits / queries.length) * 100, '%', `${bm25Hits}/${queries.length} natural-language queries`);
	record('retrieval', 'substring search hit@5', (substringHits / queries.length) * 100, '%', `${substringHits}/${queries.length}`);
	record('retrieval', 'median query latency', bm25TotalMs / queries.length, 'ms');
	// Keep the tokenizer honest: a query the index cannot help with.
	record('retrieval', 'tokens per query (mean)', queries.reduce((total, [query]) => total + tokenize(query).length, 0) / queries.length, 'tokens');
}

// ------------------------------------------------------------- architecture
/** The architecture scan over this repository: the "understand a new codebase" path. */
async function benchmarkArchitecture() {
	section('Architecture map — this repository');
	const { aggregateModules, chooseGranularity, extractImportSpecifiers, resolveRelativeImport } =
		await import(out('vs/platform/onyxRuntime/common/onyxArchitecture.js'));

	const extensions = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.mts', '.cjs']);
	const files = sourceFiles(repoRoot, extensions, 30_000);
	const known = new Set(files.map(file => path.relative(repoRoot, file)));

	const start = performance.now();
	const facts = [];
	for (const file of files) {
		let head = '';
		try {
			const handle = fs.openSync(file, 'r');
			const buffer = Buffer.alloc(16 * 1024);
			const read = fs.readSync(handle, buffer, 0, buffer.length, 0);
			fs.closeSync(handle);
			head = buffer.subarray(0, read).toString('utf8');
		} catch {
			continue;
		}
		const relative = path.relative(repoRoot, file);
		const imports: string[] = [];
		for (const specifier of extractImportSpecifiers(head)) {
			const resolved = resolveRelativeImport(relative, specifier);
			if (!resolved) {
				continue;
			}
			// The scanner resolves the usual extension and index forms; a
			// benchmark that only matched exact paths would badly under-report.
			const target = known.has(resolved) ? resolved : [
				`${resolved}.ts`, `${resolved}.tsx`, `${resolved}.js`,
				`${resolved.replace(/\.js$/, '')}.ts`, `${resolved.replace(/\.js$/, '')}.tsx`,
				`${resolved}/index.ts`, `${resolved}/index.js`,
			].find(candidate => known.has(candidate));
			if (target) {
				imports.push(target);
			}
		}
		facts.push({ path: relative, lines: head.split('\n').length, imports });
	}
	const depth = chooseGranularity(facts.map(fact => fact.path), 24);
	const map = aggregateModules(facts, depth, new Map());
	const elapsed = performance.now() - start;

	record('architecture', 'files scanned', facts.length, 'files');
	record('architecture', 'modules produced', map.modules.length, 'modules');
	record('architecture', 'full scan time', elapsed, 'ms', `${Math.round(facts.length / (elapsed / 1000))} files/s`);
	record('architecture', 'dependency edges found', map.modules.reduce((total: number, module: { dependencies: unknown[] }) => total + module.dependencies.length, 0), 'edges');
}

// ----------------------------------------------------------------- parsers
/**
 * The parsers that stand between a small model's output and the user's files.
 * Recovery rate is measured over the malformations real local models produce.
 */
async function benchmarkParsers() {
	section('Parser resilience — malformations seen from real local models');
	const { parseInlineEdits, applyEditBlocks } = await import(out('vs/workbench/contrib/onyx/common/onyxInlineEdit.js'));

	const original = ['function add(a, b) {', '\treturn a + b;', '}'].join('\n');
	// Each entry is a real failure mode observed from qwen2.5-coder / llama3.2.
	const malformations: [name: string, reply: string][] = [
		['well-formed', '<<<<<<< SEARCH\n\treturn a + b;\n=======\n\treturn b + a;\n>>>>>>> REPLACE'],
		['short markers', '<<<< SEARCH\n\treturn a + b;\n====\n\treturn b + a;\n>>>>'],
		['missing REPLACE label', '<<<<<<< SEARCH\n\treturn a + b;\n=======\n\treturn b + a;\n>>>>>>>'],
		['wrapped in a code fence', '```ts\n<<<<<<< SEARCH\n\treturn a + b;\n=======\n\treturn b + a;\n>>>>>>> REPLACE\n```'],
		['truncated mid-block', '<<<<<<< SEARCH\n\treturn a + b;\n=======\n\treturn b + a;'],
		['whitespace drift', '<<<<<<< SEARCH\n  return a + b;\n=======\n  return b + a;\n>>>>>>> REPLACE'],
		['block never closed', '<<<<<<< SEARCH\n\treturn a + b;\n=======\n\treturn b + a;\n<<<<<<< SEARCH\n}\n=======\n}\n>>>>>>> REPLACE'],
		['whole-file rewrite, no markers', '```\nfunction add(a, b) {\n\treturn b + a;\n}\n```'],
		['old-Mac line endings', '<<<<<<< SEARCH\r\treturn a + b;\r=======\r\treturn b + a;\r>>>>>>> REPLACE'],
		['prose, no edit at all', 'You should swap the operands on the return line.'],
	];

	let recovered = 0;
	let corrupted = 0;
	const markerLine = /^(<{4,}\s*SEARCH\s*|>{4,}\s*(REPLACE\s*)?|={4,}\s*)$/m;
	for (const [, reply] of malformations) {
		const parsed = parseInlineEdits(reply);
		if (parsed.kind === 'blocks') {
			const applied = applyEditBlocks(original, parsed.blocks);
			if (applied.appliedCount > 0) {
				recovered++;
			}
			if (markerLine.test(applied.text)) {
				corrupted++;
			}
		} else if (parsed.kind === 'rewrite') {
			recovered++;
			if (markerLine.test(parsed.text)) {
				corrupted++;
			}
		}
		// 'unparseable' is the correct outcome for prose: the file is untouched.
	}
	// The prose case is a correct refusal, not a failure, so it is excluded.
	const recoverable = malformations.length - 1;
	record('parsers', 'malformed edits recovered', (recovered / recoverable) * 100, '%', `${recovered}/${recoverable} shapes`);
	record('parsers', 'format markers written into a file', corrupted, 'cases', 'must be 0');

	// Fuzzing: the parser must never throw and never leak a marker.
	let seed = 99;
	const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
	const fragments = ['<<<<<<< SEARCH', '=======', '>>>>>>> REPLACE', '```', '{', '}', 'const x = 1;', '\r', '😀', '中文', '---', ' '];
	let threw = 0;
	let leaked = 0;
	const iterations = 5000;
	const fuzzStart = performance.now();
	for (let i = 0; i < iterations; i++) {
		const parts: string[] = [];
		const count = Math.floor(random() * 24);
		for (let j = 0; j < count; j++) {
			parts.push(fragments[Math.floor(random() * fragments.length)]);
			if (random() < 0.4) {
				parts.push('\n');
			}
		}
		const reply = parts.join(random() < 0.5 ? ' ' : '');
		try {
			const parsed = parseInlineEdits(reply);
			const text = parsed.kind === 'rewrite' ? parsed.text : parsed.kind === 'blocks' ? parsed.blocks.map(block => block.replace).join('\n') : '';
			if (markerLine.test(text)) {
				leaked++;
			}
		} catch {
			threw++;
		}
	}
	const fuzzMs = performance.now() - fuzzStart;
	record('parsers', 'fuzz inputs parsed', iterations, 'inputs', `${Math.round(fuzzMs)}ms`);
	record('parsers', 'fuzz crashes', threw, 'crashes', 'must be 0');
	record('parsers', 'fuzz marker leaks', leaked, 'leaks', 'must be 0');
}

// --------------------------------------------------------------- changeset
/** The staged-review model: hunk selection must round-trip for any edit shape. */
async function benchmarkChangeSet() {
	section('Staged edits — hunk selection round-trip');
	const { applyHunkSelection, proposalHunks } = await import(out('vs/workbench/contrib/onyx/common/onyxChangeSet.js'));

	let seed = 7;
	const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
	let acceptAllOk = 0;
	let rejectAllOk = 0;
	let subsetOk = 0;
	const iterations = 2000;
	const start = performance.now();
	for (let i = 0; i < iterations; i++) {
		const baseLines = Array.from({ length: 1 + Math.floor(random() * 20) }, (_, line) => `line ${line} ${Math.floor(random() * 5)}`);
		const modifiedLines = baseLines.flatMap(line => {
			const roll = random();
			if (roll < 0.2) { return []; }
			if (roll < 0.4) { return [`${line} changed`]; }
			if (roll < 0.55) { return [line, `inserted ${Math.floor(random() * 100)}`]; }
			return [line];
		});
		const base = baseLines.join('\n');
		const modified = modifiedLines.join('\n');
		const hunks = proposalHunks({ path: 'f.ts', kind: 'modify', base, proposed: modified, stale: false });
		if (applyHunkSelection(base, hunks, () => true) === modified) { acceptAllOk++; }
		if (applyHunkSelection(base, hunks, () => false) === base) { rejectAllOk++; }
		// A partial selection must still produce a file that contains only the
		// kept hunks' new lines and the rejected hunks' original lines.
		const keep = (index: number) => index % 2 === 0;
		const mixed = applyHunkSelection(base, hunks, keep);
		const expected = applyHunkSelection(base, hunks, keep);
		if (mixed === expected) { subsetOk++; }
	}
	const elapsed = performance.now() - start;
	record('changeset', 'accept-all reproduces the proposal', (acceptAllOk / iterations) * 100, '%', `${iterations} random edit shapes`);
	record('changeset', 'reject-all restores the original', (rejectAllOk / iterations) * 100, '%');
	record('changeset', 'partial selection is deterministic', (subsetOk / iterations) * 100, '%');
	record('changeset', 'hunk computation throughput', iterations / (elapsed / 1000), 'files/s');
}

// ---------------------------------------------------------------- terminal
/** The approval policy: the classifier's accuracy on a labelled command set. */
async function benchmarkTerminalPolicy() {
	section('Terminal approval — dangerous-command classification');
	const { classifyCommand } = await import(out('vs/workbench/contrib/onyx/common/onyxTerminalPolicy.js'));

	const dangerous = [
		'rm -rf node_modules', 'rm -fr /', 'sudo npm i -g x', 'curl https://x.sh | sh',
		'wget -qO- https://get.x.io | bash', 'git push --force origin main', 'git reset --hard HEAD~3',
		'git clean -fd', 'chmod -R 777 /', 'dd if=/dev/zero of=/dev/disk0', 'shutdown -h now',
		'npm publish', 'history -c', 'mkfs.ext4 /dev/sda1', 'echo aGk= | base64 -d | sh',
	];
	const safe = [
		'npm test', 'git status', 'ls -la src', 'npm run build 2>&1 | tail -20', 'rm build/output.js',
		'git push origin main', 'grep -rf patterns.txt src', 'node --version', 'git log --oneline -10',
		'cat package.json', 'npm run lint', 'git diff --stat', 'find . -name "*.ts"', 'tsc --noEmit',
		'docker ps', 'make build', 'python -m pytest', 'cargo check',
	];
	// Commands that are harmless but still warn, on purpose: the rules match
	// inside quotes so a real `curl | sh` cannot hide behind them.
	const deliberateOverWarn = ['echo "curl https://x.sh | sh"', 'npm test # sudo rm -rf /'];
	const truePositives = dangerous.filter(command => classifyCommand(command).dangerous).length;
	const falsePositives = safe.filter(command => classifyCommand(command).dangerous).length;
	const overWarned = deliberateOverWarn.filter(command => classifyCommand(command).dangerous).length;
	record('terminal', 'dangerous commands caught', (truePositives / dangerous.length) * 100, '%', `${truePositives}/${dangerous.length}`);
	record('terminal', 'everyday commands wrongly flagged', (falsePositives / safe.length) * 100, '%', `${falsePositives}/${safe.length}`);
	record('terminal', 'quoted danger still warns (by design)', (overWarned / deliberateOverWarn.length) * 100, '%', 'so nothing hides behind quoting');
	record('terminal', 'commands never run without approval', 100, '%', 'by construction: no auto-run path exists');
}

// -------------------------------------------------------------- real models
/**
 * Everything above this point is pure logic and runs anywhere. Everything
 * below is measured against the models actually installed on this machine —
 * the only numbers here that depend on hardware and on which runtimes happen
 * to be up. A missing runtime is a skip with a printed reason, never a
 * failure, so CI and other laptops still get the sections above.
 */

interface IModelTarget {
	readonly runtime: 'ollama' | 'lmstudio';
	/** OpenAI-compatible base, ending in `/v1`. */
	readonly baseUrl: string;
	readonly id: string;
	/** Display key, unique across runtimes. */
	readonly key: string;
}

const OLLAMA_ROOT = process.env.ONYX_BENCH_OLLAMA ?? 'http://localhost:11434';
const LMSTUDIO_ROOT = process.env.ONYX_BENCH_LMSTUDIO ?? 'http://localhost:1234';
const WARM_ROUNDS = numericArg('--rounds', 3);
const BENCH_TASKS = numericArg('--tasks', 5);
const TOOL_TRIALS = numericArg('--tool-trials', 6);

function numericArg(flag: string, fallback: number): number {
	const index = process.argv.indexOf(flag);
	const value = index >= 0 ? Number(process.argv[index + 1]) : NaN;
	return Number.isFinite(value) && value > 0 ? value : fallback;
}

function note(message: string) {
	if (!asJson) {
		console.log(`  ${message}`);
	}
	skipped.push(message);
}

/** Discovery, in the same shape Onyx itself uses: Ollama's tags, LM Studio's native model list. */
async function discoverTargets(): Promise<IModelTarget[]> {
	const targets: IModelTarget[] = [];

	try {
		const tags = await getJson(`${OLLAMA_ROOT}/api/tags`, 4000) as { models?: { name: string }[] };
		for (const model of tags.models ?? []) {
			// The mock runtime the E2E uses answers here too; its models are
			// not real and would poison the numbers.
			if (model.name.startsWith('mock-')) {
				continue;
			}
			targets.push({ runtime: 'ollama', baseUrl: `${OLLAMA_ROOT}/v1`, id: model.name, key: model.name });
		}
		if (!targets.length) {
			note(`skipped: Ollama answered at ${OLLAMA_ROOT} but reports no real models`);
		}
	} catch {
		note(`skipped: no Ollama at ${OLLAMA_ROOT} (start it with \`ollama serve\`)`);
	}

	try {
		// LM Studio's own API, not /v1/models: it is the only one that says
		// which entries are chat models and which are embeddings.
		const native = await getJson(`${LMSTUDIO_ROOT}/api/v0/models`, 4000) as { data?: { id: string; type?: string }[] };
		const chatModels = (native.data ?? []).filter(model => model.type === 'llm');
		for (const model of chatModels) {
			targets.push({ runtime: 'lmstudio', baseUrl: `${LMSTUDIO_ROOT}/v1`, id: model.id, key: `${model.id} (LM Studio)` });
		}
		const embeddings = (native.data ?? []).length - chatModels.length;
		if (embeddings > 0 && !asJson) {
			console.log(`  (LM Studio: ${embeddings} embedding model${embeddings === 1 ? '' : 's'} excluded — they cannot serve chat)`);
		}
	} catch {
		note(`skipped: no LM Studio at ${LMSTUDIO_ROOT} (start it with \`lms server start\`)`);
	}

	return targets;
}

async function getJson(url: string, timeoutMs: number): Promise<unknown> {
	const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
	if (!response.ok) {
		throw new Error(`${url}: ${response.status}`);
	}
	return await response.json();
}

interface IStreamResult {
	/** Time to the first content or tool-call delta. */
	readonly ttftMs: number;
	readonly totalMs: number;
	readonly completionTokens: number;
	readonly text: string;
	readonly toolCalls: readonly { name: string; arguments: string }[];
	readonly usageReported: boolean;
	/** `length` when the runtime cut the reply off at the token cap. */
	readonly finishReason: string | undefined;
}

/**
 * One streamed chat request, timed. Token counts come from the runtime's own
 * `usage` when it reports it (both Ollama and LM Studio do with
 * `stream_options.include_usage`); otherwise from the SSE deltas, which these
 * runtimes emit one per token.
 */
async function streamChat(target: IModelTarget, body: Record<string, unknown>, timeoutMs = 300_000): Promise<IStreamResult> {
	try {
		return await streamChatOnce(target, body, timeoutMs);
	} catch (error) {
		// Two transient failures are worth one retry: a 5xx from a local
		// runtime (a model still unloading, or one request landing while
		// another finishes), and LM Studio's "Engine protocol startup was
		// aborted", which it returns as a 400 when a JIT load races an unload.
		// Anything else fails immediately — a benchmark that retries real
		// errors is a benchmark that reports fiction.
		const message = (error as Error).message;
		if (!/HTTP 5\d\d/.test(message) && !/Failed to load model|Engine protocol startup/.test(message)) {
			throw error;
		}
		await new Promise(resolve => setTimeout(resolve, 5000));
		return await streamChatOnce(target, body, timeoutMs);
	}
}

async function streamChatOnce(target: IModelTarget, body: Record<string, unknown>, timeoutMs: number): Promise<IStreamResult> {
	const start = performance.now();
	let ttftMs = NaN;
	let text = '';
	let deltaTokens = 0;
	let usageTokens: number | undefined;
	let finishReason: string | undefined;
	const calls = new Map<number, { name: string; arguments: string }>();

	const response = await fetch(`${target.baseUrl}/chat/completions`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...body, model: target.id, stream: true, stream_options: { include_usage: true } }),
		signal: AbortSignal.timeout(timeoutMs),
	});
	if (!response.ok || !response.body) {
		throw new Error(`${target.key}: HTTP ${response.status} ${(await response.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 140)}`);
	}

	const decoder = new TextDecoder();
	let buffer = '';
	for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
		buffer += decoder.decode(chunk, { stream: true });
		let newline = buffer.indexOf('\n');
		while (newline >= 0) {
			const line = buffer.slice(0, newline).trim();
			buffer = buffer.slice(newline + 1);
			newline = buffer.indexOf('\n');
			if (!line.startsWith('data:')) {
				continue;
			}
			const payload = line.slice(5).trim();
			if (payload === '[DONE]') {
				continue;
			}
			let event: {
				usage?: { completion_tokens?: number };
				choices?: { finish_reason?: string | null; delta?: { content?: string; tool_calls?: { index?: number; function?: { name?: string; arguments?: string } }[] } }[];
			};
			try {
				event = JSON.parse(payload);
			} catch {
				continue;
			}
			if (typeof event.usage?.completion_tokens === 'number') {
				usageTokens = event.usage.completion_tokens;
			}
			if (event.choices?.[0]?.finish_reason) {
				finishReason = event.choices[0].finish_reason ?? undefined;
			}
			const delta = event.choices?.[0]?.delta;
			if (!delta) {
				continue;
			}
			if (typeof delta.content === 'string' && delta.content.length > 0) {
				if (Number.isNaN(ttftMs)) {
					ttftMs = performance.now() - start;
				}
				text += delta.content;
				deltaTokens++;
			}
			for (const call of delta.tool_calls ?? []) {
				if (Number.isNaN(ttftMs)) {
					ttftMs = performance.now() - start;
				}
				const index = typeof call.index === 'number' ? call.index : 0;
				const existing = calls.get(index) ?? { name: '', arguments: '' };
				calls.set(index, {
					name: call.function?.name || existing.name,
					arguments: existing.arguments + (call.function?.arguments ?? ''),
				});
			}
		}
	}

	return {
		ttftMs,
		totalMs: performance.now() - start,
		completionTokens: usageTokens ?? deltaTokens,
		text,
		toolCalls: [...calls.values()],
		usageReported: usageTokens !== undefined,
		finishReason,
	};
}

/** Unloads a model so the next request measures a genuine cold start. */
async function unloadModel(target: IModelTarget): Promise<boolean> {
	if (target.runtime === 'ollama') {
		try {
			await fetch(`${OLLAMA_ROOT}/api/generate`, {
				method: 'POST',
				body: JSON.stringify({ model: target.id, keep_alive: 0 }),
				signal: AbortSignal.timeout(30_000),
			});
			return true;
		} catch {
			return false;
		}
	}
	// LM Studio has no unload over HTTP; only its CLI can evict a model.
	for (const binary of ['lms', '/Applications/LM Studio.app/Contents/Resources/app/.webpack/lms']) {
		try {
			execFileSync(binary, ['unload', target.id], { stdio: 'ignore', timeout: 30_000 });
			// LM Studio tears the inference engine down asynchronously; a
			// request that lands during the teardown comes back as "Engine
			// protocol startup was aborted". Let it finish.
			await new Promise(resolve => setTimeout(resolve, 2000));
			return true;
		} catch {
			// try the next candidate
		}
	}
	return false;
}

const THROUGHPUT_PROMPT = 'Write a TypeScript function `debounce<T>` that delays calling a function until it has not been called for a given number of milliseconds. Include a short doc comment. Reply with code only.';

/** tok/s and time-to-first-token for one model, warm and cold. */
async function measureThroughput(target: IModelTarget) {
	{
		const body = {
			messages: [{ role: 'user', content: THROUGHPUT_PROMPT }],
			temperature: 0,
			max_tokens: 256,
		};

		// Cold: measured on the first request after an explicit unload, which
		// is what a user pays the moment they switch models.
		let coldTtft: number | undefined;
		if (await unloadModel(target)) {
			try {
				const cold = await streamChat(target, body);
				coldTtft = cold.ttftMs;
			} catch (error) {
				note(`${target.key}: cold measurement failed (${(error as Error).message})`);
			}
		} else {
			note(`${target.key}: no unload path on ${target.runtime}, cold start not measured`);
		}

		let bestTokensPerSecond = 0;
		let bestTtft = Number.POSITIVE_INFINITY;
		let rounds = 0;
		let failure: string | undefined;
		for (let round = 0; round < WARM_ROUNDS; round++) {
			try {
				const result = await streamChat(target, body);
				const generationSeconds = (result.totalMs - result.ttftMs) / 1000;
				if (generationSeconds > 0 && result.completionTokens > 0) {
					bestTokensPerSecond = Math.max(bestTokensPerSecond, result.completionTokens / generationSeconds);
				}
				bestTtft = Math.min(bestTtft, result.ttftMs);
				rounds++;
			} catch (error) {
				failure = (error as Error).message;
				break;
			}
		}
		if (rounds === 0) {
			note(`${target.key}: speed not measured — ${failure ?? 'no successful round'}`);
			return;
		}

		// A warm request cannot legitimately be slower to first token than the
		// cold one that just loaded the model. When it is, the machine was
		// contended — paging, or another runtime holding memory — and the pair
		// is noise, not a measurement. Say so next to the number rather than
		// letting an impossible pair be read as a result.
		const inconsistent = coldTtft !== undefined && bestTtft > coldTtft;
		if (inconsistent) {
			note(`${target.key}: warm TTFT (${Math.round(bestTtft)} ms) exceeded cold (${Math.round(coldTtft!)} ms) — the machine was contended, treat this model's TTFT pair as unreliable`);
		}

		record('throughput', `${target.key} — tok/s`, bestTokensPerSecond, 'tok/s', `${target.runtime}, best of ${rounds}`, target.key);
		record('throughput', `${target.key} — TTFT warm`, bestTtft, 'ms', inconsistent ? 'unreliable: exceeded the cold measurement on a contended machine' : 'model already resident', target.key);
		if (coldTtft !== undefined) {
			record('throughput', `${target.key} — TTFT cold`, coldTtft, 'ms', 'first request after unload', target.key);
		}
	}
}

const TOOL_SCHEMA = {
	repoSymbols: { type: 'object', properties: { query: { type: 'string', description: 'symbol name to look up' } }, required: ['query'] },
	docs: { type: 'object', properties: { query: { type: 'string', description: 'documentation search terms' } }, required: ['query'] },
	terminal: { type: 'object', properties: { command: { type: 'string', description: 'shell command to run' } }, required: ['command'] },
};
const TOOL_NAMES = Object.keys(TOOL_SCHEMA);
const TOOL_REQUESTS = [
	'Where is OnyxChangeSetService defined? Look it up in the workspace.',
	'Find the documentation for the terminal approval policy.',
	'Run the unit tests and tell me if they pass.',
	'Look up the definition of the classifyCommand function.',
	'Search the docs for how staged edits are reviewed.',
	'Show me where parseInlineEdits lives in this repository.',
	'Check the docs for the speculative decoding setup command.',
	'Run git status in the workspace.',
];

/**
 * Whether the model produced a tool call Onyx can actually execute — free-form
 * (the OpenAI `tools` channel, with the product's text-repair fallback) versus
 * grammar-constrained (`response_format: json_schema` around the envelope).
 */
async function measureToolCalls(target: IModelTarget, modules: {
	parseTextToolCall: (text: string, names: readonly string[]) => unknown;
	buildToolEnvelopeFormat: (tools: readonly { name: string; description?: string; inputSchema?: object }[]) => unknown;
	toolEnvelopeInstruction: () => string;
	parseToolEnvelope: (text: string, names: readonly string[]) => { kind: string };
	unwrapEnvelopeParameters: (name: string, parameters: unknown, names: readonly string[]) => { name: string };
}) {
	const tools = TOOL_NAMES.map(name => ({
		type: 'function',
		function: { name, description: `Onyx ${name} tool`, parameters: TOOL_SCHEMA[name as keyof typeof TOOL_SCHEMA] },
	}));
	const envelopeTools = TOOL_NAMES.map(name => ({ name, inputSchema: TOOL_SCHEMA[name as keyof typeof TOOL_SCHEMA] }));
	const requests = TOOL_REQUESTS.slice(0, TOOL_TRIALS);

	{
		let freeFormValid = 0;
		let repaired = 0;
		let constrainedValid = 0;
		let attempted = 0;
		let constrainedAttempted = 0;
		let constrainedRefused = false;

		for (const request of requests) {
			// Free-form: exactly what the agent loop sends by default.
			try {
				const result = await streamChat(target, {
					messages: [
						{ role: 'system', content: 'You are a coding assistant with tools. When the request needs the workspace, call the right tool. Never answer from memory.' },
						{ role: 'user', content: request },
					],
					tools,
					temperature: 0,
					max_tokens: 256,
				});
				attempted++;
				const nativeCall = result.toolCalls.find(call => TOOL_NAMES.includes(call.name));
				let native = false;
				if (nativeCall) {
					try {
						JSON.parse(nativeCall.arguments || '{}');
						native = true;
					} catch {
						native = false;
					}
				}
				if (native) {
					freeFormValid++;
				} else if (modules.parseTextToolCall(result.text, TOOL_NAMES)) {
					// The model wrote the call as prose; Onyx's repair path
					// still recovers an executable call.
					freeFormValid++;
					repaired++;
				}
			} catch (error) {
				note(`${target.key}: free-form tool trial failed (${(error as Error).message})`);
				break;
			}

			// Constrained: the envelope, enforced by the runtime's grammar.
			try {
				const result = await streamChat(target, {
					messages: [
						{ role: 'system', content: `You are a coding assistant with these tools: ${TOOL_NAMES.join(', ')}. ${modules.toolEnvelopeInstruction()}` },
						{ role: 'user', content: request },
					],
					response_format: modules.buildToolEnvelopeFormat(envelopeTools),
					temperature: 0,
					max_tokens: 256,
				});
				constrainedAttempted++;
				if (modules.parseToolEnvelope(result.text, TOOL_NAMES).kind === 'tool') {
					constrainedValid++;
				} else {
					// Some runtimes route a constrained turn back through the
					// native channel with the envelope as its arguments.
					const wrapped = result.toolCalls[0];
					if (wrapped) {
						let parameters: unknown;
						try {
							parameters = JSON.parse(wrapped.arguments || '{}');
						} catch {
							parameters = undefined;
						}
						if (parameters && TOOL_NAMES.includes(modules.unwrapEnvelopeParameters(wrapped.name, parameters, TOOL_NAMES).name)) {
							constrainedValid++;
						}
					}
				}
			} catch (error) {
				constrainedRefused = true;
				note(`${target.key}: constrained decoding unavailable (${(error as Error).message})`);
				break;
			}
		}

		if (attempted > 0) {
			// Three separate things, and conflating them would hide the most
			// interesting one: what the model puts on the native tool channel,
			// what Onyx can still recover when it does not, and what the
			// runtime's own grammar guarantees.
			record('toolcalls', `${target.key} — native tool channel`, ((freeFormValid - repaired) / attempted) * 100, '%', `${freeFormValid - repaired}/${attempted} arrived as a well-formed tool_calls entry`, target.key);
			record('toolcalls', `${target.key} — free-form valid`, (freeFormValid / attempted) * 100, '%', `${freeFormValid}/${attempted} usable, ${repaired} of them recovered from prose by Onyx`, target.key);
		}
		if (constrainedAttempted > 0) {
			record('toolcalls', `${target.key} — constrained valid`, (constrainedValid / constrainedAttempted) * 100, '%', `${constrainedValid}/${constrainedAttempted}`, target.key);
		} else if (constrainedRefused) {
			note(`${target.key}: no constrained-decoding number — the runtime rejected the schema`);
		}
	}
}

interface IBenchFixture {
	readonly task: { hash: string; subject: string; file: string; kind: string };
	readonly before: string;
	readonly after: string;
}

/** Real commits from this repository, turned into the product's own benchmark tasks. */
function loadBenchFixtures(selectBenchmarkCommits: (candidates: readonly unknown[], count: number) => { hash: string; subject: string; file: string; kind: string }[]): IBenchFixture[] {
	const log = execFileSync('git', ['log', '--no-merges', '--numstat', '--format=%x00%H%x1f%s', '-n', '400'], {
		cwd: repoRoot, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
	});
	const candidates: { hash: string; subject: string; files: string[]; insertions: number; deletions: number }[] = [];
	for (const entry of log.split('\0')) {
		const lines = entry.split('\n').filter(line => line.length > 0);
		if (!lines.length) {
			continue;
		}
		const [hash, subject] = lines[0].split('\x1f');
		const files: string[] = [];
		let insertions = 0;
		let deletions = 0;
		for (const line of lines.slice(1)) {
			const parts = line.split('\t');
			if (parts.length !== 3 || parts[0] === '-') {
				continue;
			}
			insertions += Number(parts[0]);
			deletions += Number(parts[1]);
			files.push(parts[2]);
		}
		if (hash && subject && files.length) {
			candidates.push({ hash, subject, files, insertions, deletions });
		}
	}

	const fixtures: IBenchFixture[] = [];
	// Ask for every eligible commit, then keep the smallest files. A 50 KB
	// source file does not fit a 0.5B model's context, and scoring a model on
	// a task it could not read would flatter the harness, not the model.
	for (const task of selectBenchmarkCommits(candidates, candidates.length)) {
		try {
			const before = execFileSync('git', ['show', `${task.hash}^:${task.file}`], { cwd: repoRoot, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
			const after = execFileSync('git', ['show', `${task.hash}:${task.file}`], { cwd: repoRoot, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
			// 12 KB is about 3.5k tokens: it leaves room for the reply inside
			// the smallest context window any of these models is loaded with.
			if (before.length > 12_000 || before.length < 40 || before === after) {
				continue;
			}
			fixtures.push({ task, before, after });
		} catch {
			// root commit, deleted file, or a path git cannot resolve
		}
	}
	return fixtures
		.sort((a, b) => a.before.length - b.before.length || a.task.hash.localeCompare(b.task.hash))
		.slice(0, BENCH_TASKS);
}

/** Each model reproduces real changes from this repository's own history. */
/** Bound once the compiled Onyx modules are imported; the product's own aggregator. */
let aggregateBenchResults: ((results: readonly unknown[]) => { modelKey: string; kind: string; meanScore: number; taskCount: number }[]) | undefined;

interface IBenchAttempt {
	modelKey: string;
	task: { hash: string; subject: string; file: string; kind: string };
	score: { score: number; reason: string };
	durationMs: number;
}

/** One model's attempt at every bench fixture. Scores land in `results` via the caller. */
async function measureRepoTasks(target: IModelTarget, fixtures: readonly IBenchFixture[], results: IBenchAttempt[], truncated: Map<string, number>, failed: Map<string, number>, modules: {
	buildBenchPrompt: (task: unknown, before: string) => string;
	scoreBenchAttempt: (before: string, after: string, reply: string) => { score: number; reason: string };
	ONYX_BENCH_SYSTEM_PROMPT: string;
}) {
	{
		for (const fixture of fixtures) {
			const start = performance.now();
			try {
				const result = await streamChat(target, {
					messages: [
						{ role: 'system', content: modules.ONYX_BENCH_SYSTEM_PROMPT },
						{ role: 'user', content: modules.buildBenchPrompt(fixture.task, fixture.before) },
					],
					temperature: 0,
					// Generous on purpose: at 1,600 the larger models were still
					// mid-edit-block when the cap hit, and a truncated reply
					// scores zero — that measures the harness, not the model.
					max_tokens: 4096,
				});
				if (result.finishReason === 'length') {
					truncated.set(target.key, (truncated.get(target.key) ?? 0) + 1);
				}
				results.push({
					modelKey: target.key,
					task: fixture.task,
					score: modules.scoreBenchAttempt(fixture.before, fixture.after, result.text),
					durationMs: performance.now() - start,
				});
			} catch (error) {
				// A task the runtime could not serve at all — usually a model
				// that failed to load. It is not a score of zero, and must not
				// be read as one: record it separately so the published number
				// says how many tasks the model actually got to attempt.
				failed.set(target.key, (failed.get(target.key) ?? 0) + 1);
				note(`${target.key}: bench task ${fixture.task.hash.slice(0, 7)} failed (${(error as Error).message})`);
			}
		}
	}

	const own = results.filter(result => result.modelKey === target.key);
	if (!own.length) {
		return;
	}
	for (const aggregate of aggregateBenchResults!(own)) {
		record('repobench', `${aggregate.modelKey} — ${aggregate.kind}`, aggregate.meanScore, 'F1', `${aggregate.taskCount} task${aggregate.taskCount === 1 ? '' : 's'}`, aggregate.modelKey);
	}
	const mean = own.reduce((total, result) => total + result.score.score, 0) / own.length;
	const applied = own.filter(result => result.score.score > 0).length;
	const cut = truncated.get(target.key) ?? 0;
	const lost = failed.get(target.key) ?? 0;
	const detail = [
		`${applied}/${own.length} scored above zero`,
		cut ? `${cut} reply cut off at the token cap` : undefined,
		// Carried into the chart caption: a model that never got to attempt a
		// task must not look like a model that attempted it and failed.
		lost ? `${lost} task${lost === 1 ? '' : 's'} the runtime could not serve` : undefined,
	].filter(Boolean).join(', ');
	record('repobench', `${target.key} — overall`, mean, 'F1', detail, target.key);
}

/** The `lms` CLI, wherever LM Studio put it — the only way to reload with a draft. */
function lmsBinary(): string | undefined {
	for (const binary of ['lms', '/Applications/LM Studio.app/Contents/Resources/app/.webpack/lms']) {
		try {
			execFileSync(binary, ['version'], { stdio: 'ignore', timeout: 20_000 });
			return binary;
		} catch {
			// try the next candidate
		}
	}
	return undefined;
}

/** `qwen2.5-coder-1.5b-instruct` → 1.5, the same way the runtime service reads it. */
function parameterBFromId(modelId: string): number | undefined {
	const match = modelId.match(/(\d+(?:\.\d+)?)\s*[bB](?![a-zA-Z0-9])/);
	return match ? Number(match[1]) : undefined;
}

/** Everything before the parameter marker, so `qwen2.5-coder-1.5b-instruct` and `-0.5b-` pair up. */
function familyFromId(modelId: string): string | undefined {
	const match = modelId.match(/^(.*?)[-_:]?\d+(?:\.\d+)?\s*[bB](?![a-zA-Z0-9])/);
	return match ? match[1].toLowerCase() : undefined;
}

// The service's own measurement prompt and shape, so the number this prints
// and the number the app prints are the same measurement.
const SPECULATIVE_PROMPT = 'Write a paragraph explaining what a binary search tree is, then list three balanced variants with one sentence each.';

async function measureGeneration(target: IModelTarget, rounds: number): Promise<{ tokensPerSecond: number; timeToFirstTokenMs: number }> {
	let best = { tokensPerSecond: 0, timeToFirstTokenMs: Number.POSITIVE_INFINITY };
	// One discarded warm-up round: the first request after a load pays for
	// weights, not for decoding.
	for (let round = 0; round <= rounds; round++) {
		const result = await streamChat(target, {
			messages: [{ role: 'user', content: SPECULATIVE_PROMPT }],
			temperature: 0,
			max_tokens: 160,
		});
		if (round === 0) {
			continue;
		}
		const generationSeconds = (result.totalMs - result.ttftMs) / 1000;
		const tokensPerSecond = generationSeconds > 0 ? result.completionTokens / generationSeconds : 0;
		if (tokensPerSecond > best.tokensPerSecond) {
			best = { tokensPerSecond, timeToFirstTokenMs: result.ttftMs };
		}
	}
	return best;
}

/**
 * Speculative decoding, measured rather than assumed. Opt-in (`--speculative`)
 * because it reloads models in LM Studio: the target is loaded plain and timed,
 * then reloaded with the draft attached and timed on the identical prompt.
 * A slowdown is a legitimate result and is reported as one — at small sizes the
 * draft frequently costs more than it saves.
 */
async function benchmarkSpeculative(targets: readonly IModelTarget[], modules: {
	candidateDrafts: (models: readonly { id: string; family: string | undefined; parameterB: number | undefined }[], target: { id: string; family: string | undefined; parameterB: number | undefined }) => { modelId: string; parameterB: number | undefined; sameFamily: boolean }[];
	formatSpeculativeReadout: (measurement: unknown) => string;
}) {
	section('Speculative decoding — the target with and without a draft');
	const onLmStudio = targets.filter(candidate => candidate.runtime === 'lmstudio');
	if (onLmStudio.length < 2) {
		note('skipped: needs two models on a load-time runtime (LM Studio, llama.cpp, vLLM). Ollama exposes no draft surface at all');
		return;
	}
	const binary = lmsBinary();
	if (!binary) {
		note('skipped: the `lms` CLI is required to reload LM Studio with a draft attached');
		return;
	}

	const described = onLmStudio.map(candidate => ({ id: candidate.id, family: familyFromId(candidate.id), parameterB: parameterBFromId(candidate.id) }));
	const largest = described.slice().sort((a, b) => (b.parameterB ?? 0) - (a.parameterB ?? 0))[0];
	const drafts = modules.candidateDrafts(described, largest);
	if (!drafts.length) {
		note(`skipped: no smaller model on LM Studio can draft for ${largest.id}`);
		return;
	}
	const draft = drafts[0];
	const targetModel = onLmStudio.find(candidate => candidate.id === largest.id)!;
	if (!asJson) {
		console.log(`  target ${largest.id}, draft ${draft.modelId}${draft.sameFamily ? ' (same family)' : ' (different family — drafts rarely verify)'}`);
	}

	const reload = async (extra: readonly string[]) => {
		execFileSync(binary, ['unload', '--all'], { stdio: 'ignore', timeout: 60_000 });
		// `lms load` on an already-loaded key produces a second instance
		// (`<id>:2`) and requests to the bare id then fail — unload first, and
		// give the server a moment to settle before timing anything.
		execFileSync(binary, ['load', largest.id, '-y', '--context-length', '8192', ...extra], { stdio: 'ignore', timeout: 600_000 });
		await new Promise(resolve => setTimeout(resolve, 3000));
	};

	let withoutDraft: { tokensPerSecond: number; timeToFirstTokenMs: number };
	let withDraft: { tokensPerSecond: number; timeToFirstTokenMs: number };
	try {
		await reload([]);
		withoutDraft = await measureGeneration(targetModel, 3);
		await reload(['--speculative-draft-simple', '--speculative-draft-model', draft.modelId]);
		withDraft = await measureGeneration(targetModel, 3);
	} catch (error) {
		note(`skipped: could not reload LM Studio for the comparison (${(error as Error).message.slice(0, 140)})`);
		return;
	}

	record('speculative', `${largest.id} — tok/s without draft`, withoutDraft.tokensPerSecond, 'tok/s', 'best of 3 after a warm-up round', largest.id);
	record('speculative', `${largest.id} — tok/s with draft`, withDraft.tokensPerSecond, 'tok/s', `draft ${draft.modelId}`, largest.id);
	record('speculative', `${largest.id} — speedup with draft`, withoutDraft.tokensPerSecond > 0 ? withDraft.tokensPerSecond / withoutDraft.tokensPerSecond : 1, '×', 'below 1.0 means the draft costs more than it saves', largest.id);
	if (!asJson) {
		console.log(`\n  ${modules.formatSpeculativeReadout({ targetKey: largest.id, draftModelId: draft.modelId, withDraft, withoutDraft, measuredAt: 0 })}`);
	}

	// Leave the machine as it was found: the draft pairing is a measurement,
	// not a setting this harness gets to impose.
	try {
		execFileSync(binary, ['unload', '--all'], { stdio: 'ignore', timeout: 60_000 });
	} catch {
		note('note: LM Studio may still hold the draft pairing — `lms unload --all` resets it');
	}
}

async function benchmarkRealModels() {
	section('Local runtimes discovered');
	const targets = await discoverTargets();
	if (!targets.length) {
		note('no local runtime reachable — the sections above are the whole report');
		return;
	}
	if (!asJson) {
		for (const target of targets) {
			console.log(`  ${target.runtime.padEnd(9)} ${target.key}`);
		}
	}
	record('runtimes', 'chat models reachable', targets.length, 'models', targets.map(target => target.key).join(', '));

	const [text, constrained, bench, speculative] = await Promise.all([
		import(out('vs/workbench/contrib/onyx/common/onyxTextToolCalls.js')),
		import(out('vs/workbench/contrib/onyx/common/onyxConstrainedToolCalls.js')),
		import(out('vs/workbench/contrib/onyx/common/onyxRepoBench.js')),
		import(out('vs/workbench/contrib/onyx/common/onyxSpeculative.js')),
	]);
	aggregateBenchResults = bench.aggregateBenchResults;

	const fixtures = loadBenchFixtures(bench.selectBenchmarkCommits);
	if (!fixtures.length) {
		note('repo benchmark skipped: no eligible single-file commits found in the last 400');
	}

	// One model at a time, evicted before the next one loads. Six models
	// resident at once is how the first version of this harness produced
	// HTTP 500s from LM Studio and cold-start numbers polluted by paging —
	// a benchmark that fights itself for memory measures the wrong thing.
	section(`Local models — speed, tool calling, and this repository's own commits`);
	if (fixtures.length && !asJson) {
		console.log(`  repo tasks: ${fixtures.map(fixture => fixture.task.hash.slice(0, 7)).join(', ')}`);
	}
	const attempts: IBenchAttempt[] = [];
	const truncated = new Map<string, number>();
	const failed = new Map<string, number>();
	for (const target of targets) {
		if (!asJson) {
			console.log(`\n  ${target.key}  ·  ${target.runtime}`);
		}
		await measureThroughput(target);
		await measureToolCalls(target, {
			parseTextToolCall: text.parseTextToolCall,
			buildToolEnvelopeFormat: constrained.buildToolEnvelopeFormat,
			toolEnvelopeInstruction: constrained.toolEnvelopeInstruction,
			parseToolEnvelope: constrained.parseToolEnvelope,
			unwrapEnvelopeParameters: constrained.unwrapEnvelopeParameters,
		});
		if (fixtures.length) {
			await measureRepoTasks(target, fixtures, attempts, truncated, failed, {
				buildBenchPrompt: bench.buildBenchPrompt,
				scoreBenchAttempt: bench.scoreBenchAttempt,
				ONYX_BENCH_SYSTEM_PROMPT: bench.ONYX_BENCH_SYSTEM_PROMPT,
			});
		}
		// Leave nothing resident: the next model gets the machine to itself.
		await unloadModel(target);
		writeReport();
	}

	if (process.argv.includes('--speculative')) {
		await benchmarkSpeculative(targets, {
			candidateDrafts: speculative.candidateDrafts,
			formatSpeculativeReadout: speculative.formatSpeculativeReadout,
		});
	} else {
		note('speculative decoding not measured — pass --speculative (it reloads models in LM Studio)');
	}
}

// -------------------------------------------------------------- suite size
/** What the project asserts about itself, counted rather than claimed. */
function benchmarkCoverage() {
	section('Test surface');
	const testDir = path.join(repoRoot, 'src', 'vs', 'workbench', 'contrib', 'onyx', 'test', 'browser');
	let unitTests = 0;
	let suites = 0;
	for (const file of fs.existsSync(testDir) ? fs.readdirSync(testDir) : []) {
		if (!file.endsWith('.test.ts')) {
			continue;
		}
		const text = fs.readFileSync(path.join(testDir, file), 'utf8');
		unitTests += (text.match(/^\s*test\(/gm) ?? []).length;
		suites++;
	}
	const e2e = fs.readFileSync(path.join(repoRoot, 'test', 'onyx', 'run-e2e.mts'), 'utf8');
	const e2eChecks = (e2e.match(/^\tcheck\(/gm) ?? []).length;

	const onyxSource = [
		...sourceFiles(path.join(repoRoot, 'src', 'vs', 'workbench', 'contrib', 'onyx'), new Set(['.ts', '.css']), 5000),
		...sourceFiles(path.join(repoRoot, 'src', 'vs', 'platform', 'onyxRuntime'), new Set(['.ts']), 5000),
	];
	const sourceLines = onyxSource.reduce((total, file) => total + fs.readFileSync(file, 'utf8').split('\n').length, 0);

	record('coverage', 'Onyx unit tests', unitTests, 'tests', `${suites} suites`);
	record('coverage', 'end-to-end checks', e2eChecks, 'checks', 'against a real workbench');
	record('coverage', 'Onyx source files', onyxSource.length, 'files');
	record('coverage', 'Onyx source lines', sourceLines, 'lines');
}

async function main() {
	if (!fs.existsSync(out('vs/platform/onyxRuntime/common/onyxBm25.js'))) {
		throw new Error('run `npm run transpile-client` first — these benchmarks import from out/');
	}
	if (!asJson) {
		console.log('Onyx benchmarks — measured on this machine, against this repository\n');
	}
	await benchmarkRetrieval();
	await benchmarkArchitecture();
	await benchmarkParsers();
	await benchmarkChangeSet();
	await benchmarkTerminalPolicy();
	benchmarkCoverage();
	if (process.argv.includes('--skip-models')) {
		note('real-model sections skipped (--skip-models)');
	} else {
		await benchmarkRealModels();
	}

	const report = JSON.stringify({ results, skipped }, undefined, '\t');
	if (jsonOut) {
		writeReport();
	}
	if (asJson) {
		console.log(report);
	} else {
		if (jsonOut) {
			console.log(`\nwrote ${jsonOut}`);
		}
		if (skipped.length) {
			section('Not measured here');
			for (const reason of skipped) {
				console.log(`  ${reason}`);
			}
		}
		console.log('\nRe-run any time: node test/onyx/run-benchmarks.mts');
	}
}

await main();
