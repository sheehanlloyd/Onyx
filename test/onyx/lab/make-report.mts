/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The research report's numbers and tables (L19, R-58). Everything is read from committed files:
 * no model, no runtime, no network.
 *
 *   node test/onyx/lab/make-report.mts            write docs/research/data/*.json and the generated tables of REPORT.md
 *   node test/onyx/lab/make-report.mts --check    write nothing; exit 1 when anything committed differs, or a number has no source
 *
 *   --slow             also run analyze-edits.mts (H-3 to H-5), which takes about ten minutes
 *   --skip-analyses    run no analyze-*.mts command; read their committed outputs instead
 *   --report <file> --numbers <file> --readme <file>    check or write these copies instead (R-58's own test)
 *
 * Where a number comes from, in `numbers.json`:
 *   committed    read from a committed JSON file at the path given
 *   analysis     read from the output of the analyze-*.mts command named, which this script runs on a
 *                temporary copy of the committed raw records; the command's outputs are compared byte for
 *                byte with the committed files, and a difference is a failure. H-3 to H-5's command runs
 *                only with --slow; without it their values are the committed ones, and the counts among
 *                them are counted again from attempts.jsonl
 *   recount      counted by this script from results.jsonl or traces/records.jsonl
 *   registered   a threshold or a size quoted from PREREGISTRATION.md; the quotation is checked to be there
 *
 * Tables of REPORT.md live between `<!-- generated:<name> -->` and `<!-- /generated:<name> -->`.
 *
 * The docs check. A numeric token in REPORT.md's prose (outside generated tables, code and link
 * targets), or in README.md's `## Research` section, has to equal a value, a denominator or an interval
 * end in numbers.json, rounded to the token's own decimals. Tokens are integers of two or more digits,
 * decimals, percentages and numbers with thousands separators. Not checked (ALLOWLIST below): ISO dates;
 * plan identifiers such as H-10, I-04, R-58, L12, DEC-09; arXiv identifiers; version numbers with two
 * dots; the three models' names and size labels such as 7B; a reference to a numbered section; a
 * number that begins a heading.
 *
 * The analyze-*.mts commands import compiled modules from `out/` (`pnpm run transpile-client`).
 */

import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
type Segment = string | number | { readonly where: readonly [string, string] };

interface INumber {
	readonly id: string;
	readonly value: number;
	readonly denominator?: number;
	readonly interval?: readonly [number, number];
	readonly unit?: string;
	readonly source: string;
	readonly path?: string;
	readonly derivation: 'committed' | 'analysis' | 'recount' | 'registered';
	readonly command?: string;
	readonly rerun?: string;
	readonly note?: string;
}

interface IAnalysis {
	readonly name: string;
	readonly script: string;
	readonly copies: readonly string[];
	readonly args: (directory: (name: string) => string) => string[];
	readonly display: string;
	/** Produced file (relative to the temporary results root) and the committed file it has to equal. */
	readonly outputs: readonly (readonly [string, string])[];
	readonly expectedExit: number;
	readonly slow?: boolean;
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const RESULTS = 'docs/research/results';
const DATA = 'docs/research/data';
const PREREGISTRATION = 'docs/research/PREREGISTRATION.md';
const CONTRACT = 'docs/research/HARNESS-CONTRACT.md';
const SIM_SOURCES = 'src/vs/workbench/contrib/onyx/test/browser/sim';
const SELF = 'node test/onyx/lab/make-report.mts';

const flagValue = (name: string): string | undefined => {
	const index = process.argv.indexOf(name);
	return index === -1 ? undefined : process.argv[index + 1];
};
const check = process.argv.includes('--check');
const slow = process.argv.includes('--slow');
const skipAnalyses = process.argv.includes('--skip-analyses');
const reportPath = path.resolve(flagValue('--report') ?? path.join(repoRoot, 'docs', 'research', 'REPORT.md'));
const numbersPath = path.resolve(flagValue('--numbers') ?? path.join(repoRoot, DATA, 'numbers.json'));
const readmePath = path.resolve(flagValue('--readme') ?? path.join(repoRoot, 'README.md'));

const problems: string[] = [];

// ---------------------------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------------------------

/** Outputs of an analysis run in this process, by repository-relative path. */
const recomputed = new Map<string, string>();

function resolveFile(relative: string): string {
	return recomputed.get(relative) ?? path.join(repoRoot, relative);
}

function readText(relative: string): string {
	return fs.readFileSync(resolveFile(relative), 'utf8');
}

const jsonCache = new Map<string, Json>();
function readJson(relative: string): Json {
	let value = jsonCache.get(relative);
	if (value === undefined) {
		value = JSON.parse(readText(relative)) as Json;
		jsonCache.set(relative, value);
	}
	return value;
}

function readJsonLines(relative: string): Json[] {
	return readText(relative).split('\n').filter(line => line.trim().length > 0).map(line => JSON.parse(line) as Json);
}

function isObject(value: Json | undefined): value is { [key: string]: Json } {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pick(root: Json, segments: readonly Segment[], where: string): Json {
	let current: Json | undefined = root;
	for (const segment of segments) {
		if (typeof segment === 'number') {
			current = Array.isArray(current) ? current[segment] : undefined;
		} else if (typeof segment === 'string') {
			current = isObject(current) ? current[segment] : undefined;
		} else {
			const [key, wanted] = segment.where;
			current = Array.isArray(current) ? current.find(item => isObject(item) && item[key] === wanted) : undefined;
		}
		if (current === undefined) {
			throw new Error(`${where}: nothing at ${showPath(segments)}`);
		}
	}
	return current;
}

function showPath(segments: readonly Segment[]): string {
	return segments.map(segment => typeof segment === 'object' ? `[${segment.where[0]}=${segment.where[1]}]` : String(segment)).join(' / ');
}

function asNumber(value: Json, where: string): number {
	if (typeof value !== 'number') {
		throw new Error(`${where}: expected a number`);
	}
	return value;
}

function asString(value: Json, where: string): string {
	if (typeof value !== 'string') {
		throw new Error(`${where}: expected a string`);
	}
	return value;
}

function asArray(value: Json, where: string): Json[] {
	if (!Array.isArray(value)) {
		throw new Error(`${where}: expected a list`);
	}
	return value;
}

function field(value: Json, key: string): Json {
	return isObject(value) && value[key] !== undefined ? value[key] : null;
}

function round(value: number, digits: number): number {
	const factor = 10 ** digits;
	return Math.round((value + Number.EPSILON) * factor) / factor;
}

// ---------------------------------------------------------------------------------------------
// The analyses
// ---------------------------------------------------------------------------------------------

const lab = (name: string) => `test/onyx/lab/${name}`;
const result = (name: string, file: string) => `${name}/${file}`;

const ANALYSES: readonly IAnalysis[] = [
	{
		name: 'attribution', script: lab('analyze-attribution.mts'), copies: ['2026-11-22-attribution'],
		args: directory => [directory('2026-11-22-attribution')],
		display: `node ${lab('analyze-attribution.mts')} ${RESULTS}/2026-11-22-attribution`,
		outputs: ['analysis.json', 'ANALYSIS.md', 'outcome.json'].map(file => [result('2026-11-22-attribution', file), result('2026-11-22-attribution', file)] as const),
		expectedExit: 0,
	},
	{
		name: 'rankings', script: lab('analyze-rankings.mts'), copies: ['2026-11-22-rankings-onyx', '2026-11-22-rankings-brew'],
		args: directory => [directory('2026-11-22-rankings-onyx'), directory('2026-11-22-rankings-brew')],
		display: `node ${lab('analyze-rankings.mts')} ${RESULTS}/2026-11-22-rankings-onyx ${RESULTS}/2026-11-22-rankings-brew`,
		outputs: ['rankings.json', 'outcome-H-7.json'].map(file => [result('2026-11-22-rankings-onyx', file), result('2026-11-22-rankings-onyx', file)] as const),
		expectedExit: 0,
	},
	{
		name: 'determinism-first', script: lab('analyze-determinism.mts'), copies: ['2026-11-22-determinism'],
		args: directory => [directory('2026-11-22-determinism')],
		display: `node ${lab('analyze-determinism.mts')} ${RESULTS}/2026-11-22-determinism`,
		// The analysis names its verdict outcome-H-6.json; the committed copy of the invalid campaign's is first-run-verdict.json.
		outputs: [[result('2026-11-22-determinism', 'determinism.json'), result('2026-11-22-determinism', 'determinism.json')], [result('2026-11-22-determinism', 'outcome-H-6.json'), result('2026-11-22-determinism', 'first-run-verdict.json')]],
		expectedExit: 1,
	},
	{
		name: 'determinism', script: lab('analyze-determinism.mts'), copies: ['2026-11-22-determinism-2'],
		args: directory => [directory('2026-11-22-determinism-2')],
		display: `node ${lab('analyze-determinism.mts')} ${RESULTS}/2026-11-22-determinism-2`,
		outputs: ['determinism.json', 'outcome-H-6.json'].map(file => [result('2026-11-22-determinism-2', file), result('2026-11-22-determinism-2', file)] as const),
		expectedExit: 0,
	},
	{
		name: 'confidence', script: lab('analyze-confidence.mts'), copies: ['2026-11-22-confidence'],
		args: directory => [directory('2026-11-22-confidence')],
		display: `node ${lab('analyze-confidence.mts')} ${RESULTS}/2026-11-22-confidence`,
		outputs: ['confidence.json', 'outcome-H-8.json'].map(file => [result('2026-11-22-confidence', file), result('2026-11-22-confidence', file)] as const),
		expectedExit: 0,
	},
	{
		name: 'eviction', script: lab('analyze-eviction.mts'), copies: ['2026-11-22-eviction-scripted', '2026-11-22-eviction-agentic'],
		args: directory => [directory('2026-11-22-eviction-scripted'), directory('2026-11-22-eviction-agentic')],
		display: `node ${lab('analyze-eviction.mts')} ${RESULTS}/2026-11-22-eviction-scripted ${RESULTS}/2026-11-22-eviction-agentic`,
		outputs: ['eviction.json', 'summary.json', 'outcome-H-9.json'].map(file => [result('2026-11-22-eviction-scripted', file), result('2026-11-22-eviction-scripted', file)] as const),
		expectedExit: 0,
	},
	{
		name: 'energy', script: lab('analyze-energy.mts'), copies: ['2026-11-22-energy'],
		args: directory => [directory('2026-11-22-energy'), '--idle-watts', '2'],
		display: `node ${lab('analyze-energy.mts')} ${RESULTS}/2026-11-22-energy --idle-watts 2`,
		outputs: ['energy.json', 'outcome-H-10.json'].map(file => [result('2026-11-22-energy', file), result('2026-11-22-energy', file)] as const),
		expectedExit: 0,
	},
	{
		name: 'injection', script: lab('analyze-injection.mts'), copies: ['2026-11-22-injection'],
		args: directory => [directory('2026-11-22-injection')],
		display: `node ${lab('analyze-injection.mts')} ${RESULTS}/2026-11-22-injection`,
		outputs: [[result('2026-11-22-injection', 'injection.json'), result('2026-11-22-injection', 'injection.json')]],
		expectedExit: 0,
	},
	{
		name: 'protocol', script: lab('analyze-protocol.mts'), copies: ['2026-11-26-protocol'],
		args: directory => [directory('2026-11-26-protocol')],
		display: `node ${lab('analyze-protocol.mts')} ${RESULTS}/2026-11-26-protocol`,
		outputs: ['protocol.json', 'outcome-protocol.json'].map(file => [result('2026-11-26-protocol', file), result('2026-11-26-protocol', file)] as const),
		expectedExit: 0,
	},
	{
		name: 'determinism-edits', script: lab('analyze-determinism.mts'), copies: ['2026-11-26-determinism-edits'],
		args: directory => [directory('2026-11-26-determinism-edits'), '--editing-units'],
		display: `node ${lab('analyze-determinism.mts')} ${RESULTS}/2026-11-26-determinism-edits --editing-units`,
		outputs: ['determinism.json', 'outcome-H-6-editing.json'].map(file => [result('2026-11-26-determinism-edits', file), result('2026-11-26-determinism-edits', file)] as const),
		expectedExit: 0,
	},
	{
		name: 'forced-eviction', script: lab('analyze-forced-eviction.mts'), copies: ['2026-11-26-eviction-forced'],
		args: directory => [directory('2026-11-26-eviction-forced')],
		display: `node ${lab('analyze-forced-eviction.mts')} ${RESULTS}/2026-11-26-eviction-forced`,
		outputs: ['forced-eviction.json', 'outcome-H-9-condition.json'].map(file => [result('2026-11-26-eviction-forced', file), result('2026-11-26-eviction-forced', file)] as const),
		expectedExit: 0,
	},
	{
		name: 'edits', script: lab('analyze-edits.mts'), copies: [], slow: true,
		args: directory => ['--out', directory('2026-11-22-edit-mechanisms'), '--campaign', `${RESULTS}/2026-11-22-single-turn`, '--campaign', `${RESULTS}/2026-11-22-confidence`, '--campaign', `${RESULTS}/2026-11-22-attribution`, '--anchors', `${RESULTS}/2026-11-22-anchors-2`],
		display: `node ${lab('analyze-edits.mts')} --out ${RESULTS}/2026-11-22-edit-mechanisms --campaign ${RESULTS}/2026-11-22-single-turn --campaign ${RESULTS}/2026-11-22-confidence --campaign ${RESULTS}/2026-11-22-attribution --anchors ${RESULTS}/2026-11-22-anchors-2`,
		outputs: ['attempts.jsonl', 'analysis.json', 'ANALYSIS.md', 'sources.json', 'outcome-H-3.json', 'outcome-H-4.json', 'outcome-H-5.json'].map(file => [result('2026-11-22-edit-mechanisms', file), result('2026-11-22-edit-mechanisms', file)] as const),
		expectedExit: 0,
	},
];

const analysisOf = (name: string): IAnalysis => {
	const found = ANALYSES.find(analysis => analysis.name === name);
	if (!found) {
		throw new Error(`no analysis named ${name}`);
	}
	return found;
};

function runAnalyses(temporary: string): void {
	const compiled = path.join(repoRoot, 'out', 'vs', 'workbench', 'contrib', 'onyx', 'common', 'onyxAttribution.js');
	if (!fs.existsSync(compiled)) {
		console.error('make-report: the analyses import compiled modules from out/, which is not there. Run `pnpm run transpile-client`, or pass --skip-analyses to read the committed outputs.');
		process.exit(2);
	}
	const root = path.join(temporary, 'results');
	fs.mkdirSync(root, { recursive: true });
	const directory = (name: string) => path.join(root, name);
	for (const analysis of ANALYSES) {
		if (analysis.slow && !slow) {
			continue;
		}
		for (const copy of analysis.copies) {
			if (!fs.existsSync(directory(copy))) {
				fs.cpSync(path.join(repoRoot, RESULTS, copy), directory(copy), { recursive: true });
			}
		}
		fs.mkdirSync(directory('2026-11-22-edit-mechanisms'), { recursive: true });
		const run = spawnSync(process.execPath, [path.join(repoRoot, analysis.script), ...analysis.args(directory)], { cwd: repoRoot, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
		if (run.status !== analysis.expectedExit) {
			problems.push(`${analysis.display}: exit ${run.status}, expected ${analysis.expectedExit}\n${run.stderr.trim().split('\n').slice(-5).join('\n')}`);
			continue;
		}
		for (const [produced, committed] of analysis.outputs) {
			const producedFile = path.join(root, produced);
			const committedFile = path.join(repoRoot, RESULTS, committed);
			if (!fs.existsSync(producedFile) || !fs.existsSync(committedFile) || !fs.readFileSync(producedFile).equals(fs.readFileSync(committedFile))) {
				problems.push(`${analysis.display}: its ${path.basename(produced)} is not the committed ${RESULTS}/${committed}`);
				continue;
			}
			recomputed.set(`${RESULTS}/${committed}`, producedFile);
		}
	}
}

// ---------------------------------------------------------------------------------------------
// The numbers
// ---------------------------------------------------------------------------------------------

const numbers: INumber[] = [];

function add(entry: INumber): number {
	if (numbers.some(existing => existing.id === entry.id)) {
		throw new Error(`two numbers named ${entry.id}`);
	}
	numbers.push(entry);
	return entry.value;
}

interface IFromOptions {
	readonly analysis?: string;
	readonly scale?: number;
	readonly digits?: number;
	readonly denominator?: number;
	readonly unit?: string;
	readonly note?: string;
	/** The value at the path is `{ value, low, high }`. */
	readonly interval?: boolean;
}

function provenance(analysis: string | undefined): Pick<INumber, 'derivation' | 'command' | 'rerun'> {
	if (!analysis) {
		return { derivation: 'committed' };
	}
	const found = analysisOf(analysis);
	return { derivation: 'analysis', command: found.display, rerun: found.slow ? `only by \`${SELF} --slow\`` : `on every run of \`${SELF}\` without --skip-analyses` };
}

function from(id: string, file: string, segments: readonly Segment[], options: IFromOptions = {}): number {
	const relative = `${RESULTS}/${file}`;
	const where = `${relative} at ${showPath(segments)}`;
	const found = pick(readJson(relative), segments, relative);
	const shape = (raw: number) => options.digits === undefined && options.scale === undefined ? raw : round(raw * (options.scale ?? 1), options.digits ?? 0);
	const transform = options.scale !== undefined || options.digits !== undefined ? `times ${options.scale ?? 1}, rounded to ${options.digits ?? 0} decimals` : undefined;
	const note = [options.note, transform].filter(Boolean).join('; ') || undefined;
	if (options.interval) {
		return add({ id, value: shape(asNumber(field(found, 'value'), where)), denominator: options.denominator, interval: [shape(asNumber(field(found, 'low'), where)), shape(asNumber(field(found, 'high'), where))], unit: options.unit, source: relative, path: showPath(segments), ...provenance(options.analysis), note });
	}
	return add({ id, value: shape(asNumber(found, where)), denominator: options.denominator, unit: options.unit, source: relative, path: showPath(segments), ...provenance(options.analysis), note });
}

function recount(id: string, value: number, source: string, how: string, extra: { denominator?: number; unit?: string; note?: string } = {}): number {
	return add({ id, value, denominator: extra.denominator, unit: extra.unit, source, path: how, derivation: 'recount', command: SELF, note: extra.note });
}

const registration = fs.readFileSync(path.join(repoRoot, PREREGISTRATION), 'utf8').replace(/\s+/g, ' ');
function registered(id: string, value: number, quotation: string, unit?: string): number {
	if (!registration.includes(quotation)) {
		problems.push(`${PREREGISTRATION} no longer says "${quotation}" (number ${id})`);
	}
	return add({ id, value, unit, source: PREREGISTRATION, path: `"${quotation}"`, derivation: 'registered' });
}

const interval = (id: string): readonly [number, number] => {
	const found = numbers.find(entry => entry.id === id);
	if (!found?.interval) {
		throw new Error(`${id} has no interval`);
	}
	return found.interval;
};

// ---------------------------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------------------------

const int = (value: number): string => value.toLocaleString('en-US');
const dec = (value: number, digits: number): string => value.toFixed(digits);
const range = (pair: readonly [number, number], digits: number, suffix = ''): string => `[${dec(pair[0], digits)}${suffix}, ${dec(pair[1], digits)}${suffix}]`;
const cell = (text: string): string => text.replace(/\|/g, '\\|').replace(/\n/g, ' ');

function table(header: readonly string[], rows: readonly (readonly string[])[]): string {
	return [`| ${header.join(' | ')} |`, `|${header.map(() => '---').join('|')}|`, ...rows.map(row => `| ${row.map(cell).join(' | ')} |`)].join('\n');
}

// ---------------------------------------------------------------------------------------------
// Campaign records
// ---------------------------------------------------------------------------------------------

interface IResultRow { readonly model: string; readonly configuration: string; readonly outcome: string; readonly success: boolean; readonly score: number }
interface IRecord { readonly model: string; readonly configuration: string; readonly hasEdit: boolean; readonly rejectedEditCall: boolean }
interface IHarness { readonly name: string; readonly hash: string; readonly toolCallProtocol: string | null; readonly editProtocol: string | null; readonly contextTokens: number | null; readonly evictionPolicy: string | null }

function campaignDirectories(): string[] {
	return fs.readdirSync(path.join(repoRoot, RESULTS)).filter(name => fs.existsSync(path.join(repoRoot, RESULTS, name, 'results.jsonl'))).sort();
}

function resultRows(campaign: string): IResultRow[] {
	return readJsonLines(`${RESULTS}/${campaign}/results.jsonl`).map(row => ({
		model: asString(field(row, 'model'), campaign),
		configuration: asString(field(row, 'configuration'), campaign),
		outcome: asString(field(row, 'outcome'), campaign),
		success: field(row, 'success') === true,
		score: typeof field(row, 'score') === 'number' ? asNumber(field(row, 'score'), campaign) : 0,
	}));
}

/** What a run did with the edit tool: an edit on record, or a call the tool turned away before any edit existed. */
function records(campaign: string): IRecord[] {
	return readJsonLines(`${RESULTS}/${campaign}/traces/records.jsonl`).map(record => {
		const edits = field(record, 'edits');
		const events = field(record, 'events');
		const called = (Array.isArray(events) ? events : []).some(event => field(event, 'kind') === 'traceTurn' && asArray(field(field(event, 'data'), 'toolCalls') ?? [], campaign).some(call => field(call, 'name') === 'editFile'));
		const hasEdit = Array.isArray(edits) && edits.length > 0;
		return { model: asString(field(record, 'model'), campaign), configuration: asString(field(record, 'configuration'), campaign), hasEdit, rejectedEditCall: called && !hasEdit };
	});
}

function harnesses(campaign: string): IHarness[] {
	const manifest = readJson(`${RESULTS}/${campaign}/manifest.json`);
	return asArray(field(manifest, 'harnessConfigurations'), campaign).map(entry => {
		const configuration = field(entry, 'configuration');
		const text = (key: string) => typeof field(configuration, key) === 'string' ? asString(field(configuration, key), campaign) : null;
		return { name: asString(field(entry, 'name'), campaign), hash: asString(field(entry, 'hash'), campaign), toolCallProtocol: text('toolCallProtocol'), editProtocol: text('editProtocol'), evictionPolicy: text('evictionPolicy'), contextTokens: typeof field(configuration, 'contextTokens') === 'number' ? asNumber(field(configuration, 'contextTokens'), campaign) : null };
	});
}

/** Campaigns whose tasks the project wrote itself: not "real tasks", and in no total of them. */
const FIXTURE_CAMPAIGNS = ['2026-11-22-injection'];
/** The campaign engine's stale list of recently committed files (docs/progress/L15.md; PREREGISTRATION.md, Amendment 4). */
const RAN_WITH_THE_ENGINE_DEFECT = ['2026-11-22-engine-tier-a', '2026-11-22-attribution', '2026-11-22-injection', '2026-11-22-anchors', '2026-11-22-determinism'];
/** Campaigns that were run again and decide nothing (Amendment 4). */
const SUPERSEDED = ['2026-11-22-anchors', '2026-11-22-determinism'];
const MODELS = ['qwen2.5-coder:7b', 'qwen2.5-coder:1.5b', 'llama3.2:3b'];
const PINNED = MODELS.slice(0, 2);

// ---------------------------------------------------------------------------------------------
// Building everything
// ---------------------------------------------------------------------------------------------

const blocks = new Map<string, string>();
const dataFiles = new Map<string, string>();
const serialize = (value: Json): string => JSON.stringify(value, undefined, '\t') + '\n';

function buildRegistered(): void {
	registered('registered.intervalLevel', 95, '95% intervals', 'percent');
	registered('registered.resamples', 1000, '1,000 resamples');
	registered('registered.h1.episodesPerMutant', 2000, '2,000-episode campaign');
	registered('registered.h1.candidateEpisodes', 50000, 'at least 50,000 episodes');
	registered('registered.h2.minimumTasks', 40, '(at least 40)');
	registered('registered.h2.registeredConfigurations', 32, '(32 configurations)');
	registered('registered.h2.runs', 960, '960 agent runs');
	registered('registered.h3.minimumAttemptsPerModel', 500, 'at least 500 edit attempts per pinned model');
	registered('registered.h3.silentlyWrongRate', 0.5, 'at least 0.5%', 'percent');
	registered('registered.h3.fuzzySimilarity', 0.8, 'taken when that is at least 0.8');
	registered('registered.h5.minimumDifference', 0.05, 'by at least 0.05');
	registered('registered.h5.minimumEditsPerClass', 300, 'At least 300 edits per class');
	registered('registered.h6.identicalShare', 90, 'identical share at least 90%', 'percent');
	registered('registered.h6.lowerBound', 80, 'lower bound of at least 80%', 'percent');
	registered('registered.h8.aurocLowerBound', 0.65, 'AUROC lower bound at least 0.65');
	registered('registered.h8.aurocUpperBound', 0.60, 'upper bound below 0.60');
	registered('registered.h8.ece', 0.10, 'ECE is at most 0.10');
	registered('registered.h8.minimumHunks', 500, 'At least 500 labelled hunks');
	registered('registered.h8.minimumPerClass', 20, 'fewer than 20 labelled hunks are correct');
	registered('registered.h8.temperature', 0.2, 'at temperature 0.2');
	registered('registered.h9.ratio', 0.70, 'ratio is at most 0.70');
	registered('registered.h9.ratioExcluded', 1.0, 'interval excluding 1.0');
	registered('registered.h9.lowWatermark', 0.6, '0.6 of the message budget');
	registered('registered.h9.scriptedTurns', 16, 'A fixed 16-turn transcript'.replace('A fixed', 'a fixed'));
	registered('registered.h9.agenticContextTokens', 8192, 'a context of 8,192 tokens', 'tokens');
	registered('registered.productContextTokens', 16384, 'not the 16,384 the product uses', 'tokens');
	registered('registered.taskFileCharacters', 12000, 'at most 12,000 characters', 'characters');
	registered('registered.elisionCharacters', 4000, '4,000 characters of a result (on)', 'characters');
	registered('registered.elisionOffCharacters', 16000, '16,000 (off', 'characters');
	registered('registered.h10.repetitions', 24, '24 of L10\'s tasks', 'tasks');
}

function buildInvariants(): void {
	const rows = fs.readFileSync(path.join(repoRoot, CONTRACT), 'utf8').split('\n').flatMap(line => {
		const match = /^\| \*\*(?<id>I-\d\d)\*\* \| (?<guarantee>[^|]+) \| (?<definition>.*)$/.exec(line);
		if (!match?.groups) {
			return [];
		}
		const cells = match.groups.definition.split(' | ');
		return [[match.groups.id, match.groups.guarantee.trim(), (cells[1] ?? '').trim()]];
	});
	if (rows.length !== 14) {
		problems.push(`${CONTRACT}: expected fourteen invariant rows, found ${rows.length}`);
	}
	blocks.set('invariants', table(['Invariant', 'Guarantee', 'Checked at'], rows));
}

function buildMethods(): void {
	const manifest = readJson(`${RESULTS}/2026-11-22-energy/manifest.json`);
	const machine = field(manifest, 'machine');
	add({ id: 'machine.memoryGiB', value: asNumber(field(machine, 'memoryGiB'), 'machine'), unit: 'GiB', source: `${RESULTS}/2026-11-22-energy/manifest.json`, path: 'machine / memoryGiB', derivation: 'committed' });
	const adapter = /adapter (?<watts>\d+) W/.exec(asString(field(machine, 'power'), 'machine'));
	add({ id: 'machine.adapterWatts', value: Number(adapter?.groups?.watts), unit: 'W', source: `${RESULTS}/2026-11-22-energy/manifest.json`, path: 'machine / power', derivation: 'committed' });
	const models = asArray(field(manifest, 'models'), 'models');
	blocks.set('models', table(['Model', 'Weights digest', 'Runtime', 'Context verified'], models.map(model => [
		`\`${asString(field(model, 'identifier'), 'model').replace(/^ollama:/, '')}\``,
		`\`${asString(field(model, 'digest'), 'model')}\``,
		`${asString(field(field(model, 'runtime'), 'name'), 'model')} ${asString(field(field(model, 'runtime'), 'version'), 'model')}`,
		`${int(asNumber(field(field(model, 'context'), 'verifiedTokens'), 'model'))} tokens`,
	])));
	blocks.set('machine', table(['', ''], [
		['Machine', `${asString(field(machine, 'cpu'), 'machine')}, ${asNumber(field(machine, 'memoryGiB'), 'machine')} GiB, ${asString(field(machine, 'osVersion'), 'machine')} (${asString(field(machine, 'platform'), 'machine')} ${asString(field(machine, 'arch'), 'machine')})`],
		['Node', asString(field(machine, 'nodeVersion'), 'machine')],
		['Power', asString(field(machine, 'power'), 'machine')],
		['Runtime', `${asString(field(field(models[0], 'runtime'), 'name'), 'model')} ${asString(field(field(models[0], 'runtime'), 'version'), 'model')}`],
	]));

	const amendments = [...fs.readFileSync(path.join(repoRoot, PREREGISTRATION), 'utf8').matchAll(/^### Amendment (?<number>\d), (?<date>\d{4}-\d{2}-\d{2}): (?<title>.+)$/gm)];
	if (amendments.length !== 5) {
		problems.push(`${PREREGISTRATION}: expected five amendments, found ${amendments.length}`);
	}
	blocks.set('amendments', table(['Amendment', 'Date', 'Subject, as its heading says'], amendments.map(match => [match.groups?.number ?? '', match.groups?.date ?? '', match.groups?.title ?? ''])));
}

interface ICampaignCount { readonly campaign: string; readonly units: number; readonly attempted: number; readonly succeeded: number }

function buildCampaigns(): ICampaignCount[] {
	const counts: ICampaignCount[] = [];
	const rows: string[][] = [];
	for (const campaign of campaignDirectories()) {
		const results = resultRows(campaign);
		const attempted = results.filter(row => row.outcome === 'attempted').length;
		const succeeded = results.filter(row => row.success).length;
		const summary = asArray(field(readJson(`${RESULTS}/${campaign}/summary.json`), 'rows'), campaign);
		const sum = (key: string) => summary.reduce<number>((total, row) => total + asNumber(field(row, key), campaign), 0);
		if (sum('units') !== results.length || sum('attempted') !== attempted || sum('succeeded') !== succeeded) {
			problems.push(`${RESULTS}/${campaign}: summary.json says ${sum('units')} units, ${sum('attempted')} attempted, ${sum('succeeded')} succeeded; results.jsonl has ${results.length}, ${attempted}, ${succeeded}`);
		}
		counts.push({ campaign, units: results.length, attempted, succeeded });
		const source = `${RESULTS}/${campaign}/results.jsonl`;
		recount(`campaign.${campaign}.attempted`, attempted, source, 'rows whose outcome is "attempted"', { denominator: results.length, note: 'the denominator is the units recorded; equal to the sum of summary.json rows, which is checked' });
		recount(`campaign.${campaign}.succeeded`, succeeded, source, 'rows whose success is true', { denominator: attempted });
		const seconds = from(`campaign.${campaign}.seconds`, `${campaign}/campaign.json`, ['machineSeconds'], { unit: 'seconds' });
		const session = (edge: string) => asNumber(pick(readJson(`${RESULTS}/${campaign}/campaign.json`), ['sessions', 0, edge, 'loadAverage', 0], campaign), campaign);
		const manifest = readJson(`${RESULTS}/${campaign}/manifest.json`);
		const hypotheses = asArray(field(manifest, 'hypotheses') ?? [], campaign).map(entry => asString(entry, campaign));
		const tier = asString(field(field(manifest, 'campaign'), 'tier'), campaign);
		const engine = RAN_WITH_THE_ENGINE_DEFECT.includes(campaign) ? 'ran with the defect' : tier === 'A' && harnesses(campaign).every(harness => harness.toolCallProtocol !== null) && !campaign.includes('reference-measure') ? 'ran with the fix' : 'single requests';
		rows.push([
			`\`${campaign}\``,
			SUPERSEDED.includes(campaign) ? `${hypotheses.join(', ')} (superseded)` : hypotheses.join(', ') || 'none',
			campaign.includes('reference-measure') ? 'S, in the application' : tier,
			int(results.length), int(attempted), int(succeeded), int(seconds),
			`${dec(session('conditionsAtStart'), 1)} to ${dec(session('conditionsAtEnd'), 1)}`,
			engine,
		]);
	}
	blocks.set('campaigns', table(['Campaign', 'Hypotheses', 'Tier', 'Units', 'Attempted', 'Exact', 'Seconds', 'Load average, start to end', 'Campaign engine'], rows));
	return counts;
}

function buildTotals(counts: readonly ICampaignCount[]): void {
	for (const fixture of FIXTURE_CAMPAIGNS) {
		const name = asString(field(field(readJson(`${RESULTS}/${fixture}/manifest.json`), 'taskSet'), 'name'), fixture);
		if (!name.includes('fixture')) {
			problems.push(`${fixture} is left out of the totals as a fixture, and its task set is named "${name}"`);
		}
	}
	const real = counts.filter(count => !FIXTURE_CAMPAIGNS.includes(count.campaign));
	const attempts = real.reduce((total, count) => total + count.attempted, 0);
	const exact = real.reduce((total, count) => total + count.succeeded, 0);
	const list = real.map(count => `${count.campaign} ${count.attempted}`).join(', ');
	recount('totals.exactReproductions', exact, `${RESULTS}/*/results.jsonl`, 'successes over attempts, summed over every campaign on real tasks', { denominator: attempts, note: `sums ${real.length} campaigns: ${list}. Left out: ${FIXTURE_CAMPAIGNS.join(', ')} (fixture tasks). Includes the two superseded campaigns and the two engine campaigns. Attempts are not independent: campaigns reuse tasks, and H-6 repeats each unit five times` });
	const superseded = real.filter(count => SUPERSEDED.includes(count.campaign)).reduce((total, count) => total + count.attempted, 0);
	recount('totals.attemptsInSupersededCampaigns', superseded, `${RESULTS}/*/results.jsonl`, `attempts of ${SUPERSEDED.join(' and ')}`, { denominator: attempts });
	recount('totals.attemptsOutsideSupersededCampaigns', attempts - superseded, `${RESULTS}/*/results.jsonl`, 'attempts on real tasks less those of the superseded campaigns');
	recount('totals.realTaskCampaigns', real.length, `${RESULTS}/*/results.jsonl`, 'campaigns on real tasks with a results.jsonl');
	const fixture = counts.filter(count => FIXTURE_CAMPAIGNS.includes(count.campaign));
	recount('totals.fixtureSuccesses', fixture.reduce((total, count) => total + count.succeeded, 0), `${RESULTS}/2026-11-22-injection/results.jsonl`, 'successes over attempts on the injection fixture', { denominator: fixture.reduce((total, count) => total + count.attempted, 0) });
	recount('totals.fixtureUnits', fixture.reduce((total, count) => total + count.units, 0), `${RESULTS}/2026-11-22-injection/results.jsonl`, 'units of the injection run');

	// Agent runs under the tool-call protocol the product derives for the pinned models.
	const productHash = harnesses('2026-11-22-determinism-2').find(harness => harness.name === 'product')?.hash ?? '';
	interface IArm { readonly campaign: string; readonly harness: IHarness; readonly runs: number; readonly withEdit: number; readonly rejected: number }
	const arms: IArm[] = [];
	for (const count of real) {
		const constrained = harnesses(count.campaign).filter(harness => harness.toolCallProtocol === 'constrained-envelope' && harness.editProtocol === 'search-replace');
		if (constrained.length === 0 || !fs.existsSync(path.join(repoRoot, RESULTS, count.campaign, 'traces', 'records.jsonl'))) {
			continue;
		}
		const all = records(count.campaign);
		for (const harness of constrained) {
			const runs = all.filter(record => record.configuration === harness.name);
			if (runs.length > 0) {
				arms.push({ campaign: count.campaign, harness, runs: runs.length, withEdit: runs.filter(run => run.hasEdit).length, rejected: runs.filter(run => run.rejectedEditCall).length });
			}
		}
	}
	const total = (selected: readonly IArm[], key: 'runs' | 'withEdit' | 'rejected') => selected.reduce((sum, arm) => sum + arm[key], 0);
	const describe = (selected: readonly IArm[]) => selected.map(arm => `${arm.campaign}/${arm.harness.name} ${arm.runs}`).join(', ');
	const source = `${RESULTS}/*/traces/records.jsonl`;
	const attribution = arms.filter(arm => arm.campaign === '2026-11-22-attribution');
	const exactHash = arms.filter(arm => arm.harness.hash === productHash);
	recount('product.attribution.runsWithAnEdit', total(attribution, 'withEdit'), source, 'records whose `edits` list is not empty, over the records of the constrained-envelope configurations of H-2\'s campaign', { denominator: total(attribution, 'runs'), note: `this is the count docs/progress/STATE.md states as 0 of 320. Sums ${describe(attribution)}. Three of the four configurations differ from the product's in elision or line numbering; the campaign ran with the engine defect` });
	recount('product.attribution.runsWithARejectedEditCall', total(attribution, 'rejected'), source, 'records with an editFile call in a turn and an empty `edits` list: the tool turned the call away for its arguments', { denominator: total(attribution, 'runs') });
	recount('product.exactConfiguration.runsWithAnEdit', total(exactHash, 'withEdit'), source, `records with an edit, over the records of every configuration whose hash is ${productHash}, the one H-6's manifest names "product"`, { denominator: total(exactHash, 'runs'), note: `sums ${describe(exactHash)}` });
	recount('product.exactConfiguration.runsWithARejectedEditCall', total(exactHash, 'rejected'), source, 'as above, records with a rejected editFile call', { denominator: total(exactHash, 'runs') });
	recount('product.constrainedSearchReplace.runsWithAnEdit', total(arms, 'withEdit'), source, 'records with an edit, over every constrained-envelope, search-and-replace configuration on real tasks', { denominator: total(arms, 'runs'), note: `sums ${describe(arms)}. H-9's arms run at half the product's context and two of them under another eviction policy` });
	recount('product.constrainedSearchReplace.runsWithARejectedEditCall', total(arms, 'rejected'), source, 'as above, records with a rejected editFile call', { denominator: total(arms, 'runs') });

	blocks.set('totals', [
		table(['Campaign', 'Attempts on real tasks', 'Reproduced the author\'s change exactly'], [
			...real.map(count => [`\`${count.campaign}\`${SUPERSEDED.includes(count.campaign) ? ' (superseded)' : ''}`, int(count.attempted), int(count.succeeded)]),
			['**All campaigns on real tasks**', `**${int(attempts)}**`, `**${int(exact)}**`],
			...fixture.map(count => [`\`${count.campaign}\` (fixture tasks, in no total)`, int(count.attempted), int(count.succeeded)]),
		]),
		'',
		table(['Agent runs on real tasks under the constrained envelope with search-and-replace edits', 'Runs', 'Runs with an edit on record', 'Runs whose edit call the tool rejected'], [
			['H-2\'s campaign, its four constrained-envelope configurations (the count STATE.md states)', int(total(attribution, 'runs')), int(total(attribution, 'withEdit')), int(total(attribution, 'rejected'))],
			[`Every configuration with the product's hash \`${productHash}\`, ${new Set(exactHash.map(arm => arm.campaign)).size} campaigns`, int(total(exactHash, 'runs')), int(total(exactHash, 'withEdit')), int(total(exactHash, 'rejected'))],
			[`Every such configuration, ${new Set(arms.map(arm => arm.campaign)).size} campaigns`, int(total(arms, 'runs')), int(total(arms, 'withEdit')), int(total(arms, 'rejected'))],
		]),
	].join('\n'));
}

interface IHypothesisRow { readonly id: string; readonly file: string; readonly analysis?: string; readonly number: string; readonly of: string; readonly interval: string; readonly directory: string }

function buildH1(): IHypothesisRow {
	const file = '2026-11-22-assurance/summary.json';
	const total = from('h1.mutants', file, ['mutation', 'total']);
	const killed = from('h1.mutantsKilled', file, ['mutation', 'killed'], { denominator: total });
	const resurrected = from('h1.resurrectedDefects', file, ['mutation', 'resurrectedDefects'], { denominator: total });
	const generic = from('h1.genericMutants', file, ['mutation', 'genericOnly'], { denominator: total });
	const perMutant = from('h1.episodesPerMutant', file, ['mutation', 'episodesPerMutant']);
	const episodes = from('h1.episodes', file, ['campaign', 'episodes']);
	const clean = from('h1.episodesWithoutViolation', file, ['campaign', 'ranWithoutViolation'], { denominator: episodes, note: 'the second run' });
	const seconds = from('h1.campaignSeconds', file, ['campaign', 'seconds'], { unit: 'seconds' });
	const mutantSeconds = from('h1.mutationSeconds', file, ['mutation', 'seconds'], { unit: 'seconds' });
	const corpus = from('h1.injectionCorpusEpisodes', file, ['injectionCorpus', 'episodes']);
	const firstRunFile = `${RESULTS}/2026-11-22-assurance/traces/first-run/campaign.txt`;
	const firstRun = /campaign: (?<clean>\d+) of (?<all>\d+) episodes ran with no violation class outside the baseline table; failed shards: (?<shards>.+)/.exec(readText(firstRunFile));
	const firstClean = add({ id: 'h1.firstRun.episodesInCleanShards', value: Number(firstRun?.groups?.clean), denominator: Number(firstRun?.groups?.all), source: firstRunFile, path: 'the line that begins "campaign:"', derivation: 'committed', note: 'the first run counts whole shards: two shards failed, each for one episode' });
	const notes = readText(`${RESULTS}/2026-11-22-assurance/NOTES.md`);
	const seeds = [...notes.matchAll(/^\| (?<seed>\d+) \| /gm)].map(match => Number(match.groups?.seed));
	seeds.forEach((seed, index) => add({ id: `h1.firstRun.seed${index + 1}`, value: seed, source: `${RESULTS}/2026-11-22-assurance/NOTES.md`, path: 'the table of seeds', derivation: 'committed', unit: 'seed' }));
	recount('h1.firstRun.episodesReported', seeds.length, `${RESULTS}/2026-11-22-assurance/NOTES.md`, 'rows of the table of seeds', { denominator: episodes });
	blocks.set('h1', table(['', 'Count', 'Of'], [
		['Mutants detected by their own script and by the campaign\'s first seeds', int(killed), int(total)],
		['Mutants that bring back an audited defect', int(resurrected), int(total)],
		['Generic mutants, one guard removed, no audited defect behind them', int(generic), int(total)],
		['Seeded episodes each mutant was run against', int(perMutant), ''],
		['Second run: episodes of the candidate harness with no violation', int(clean), int(episodes)],
		['First run: episodes in shards that reported nothing', int(firstClean), int(episodes)],
		['First run: episodes that printed a violation, both judged the rig\'s own', int(seeds.length), int(episodes)],
		['Episodes of the simulated injection corpus, run in every shard', int(corpus), ''],
		['Seconds, campaign and mutants', `${int(seconds)} and ${int(mutantSeconds)}`, ''],
	]));
	return { id: 'H-1', file: '2026-11-22-assurance/outcome.json', number: `${int(killed)} mutants detected; ${int(clean)} episodes with no violation, on the second run`, of: `${int(total)} mutants; ${int(episodes)} episodes`, interval: 'none: a count', directory: '2026-11-22-assurance' };
}

function buildH2(): IHypothesisRow {
	const campaign = '2026-11-22-attribution';
	const results = resultRows(campaign);
	const all = records(campaign);
	const protocols: readonly (readonly [string, string])[] = [['native', 'native'], ['repaired', 'repaired text'], ['constrained', 'constrained envelope (the product\'s)']];
	const rows: string[][] = [];
	for (const model of PINNED) {
		for (const [prefix, label] of protocols) {
			const mine = results.filter(row => row.model === model && row.configuration.startsWith(`${prefix}-`));
			const recorded = all.filter(record => record.model === model && record.configuration.startsWith(`${prefix}-`));
			const key = `h2.${model}.${prefix}`;
			const source = `${RESULTS}/${campaign}/results.jsonl`;
			const runs = recount(`${key}.runs`, mine.length, source, `rows of ${model} whose configuration begins "${prefix}-"`);
			const exact = recount(`${key}.exact`, mine.filter(row => row.success).length, source, 'of those, success is true', { denominator: runs });
			const above = recount(`${key}.scoredAboveZero`, mine.filter(row => row.score > 0).length, source, 'of those, score above 0', { denominator: runs });
			const edits = recount(`${key}.runsWithAnEdit`, recorded.filter(record => record.hasEdit).length, `${RESULTS}/${campaign}/traces/records.jsonl`, 'records with a non-empty `edits` list', { denominator: runs });
			const rejected = recount(`${key}.runsWithARejectedEditCall`, recorded.filter(record => record.rejectedEditCall).length, `${RESULTS}/${campaign}/traces/records.jsonl`, 'records with an editFile call and an empty `edits` list', { denominator: runs });
			rows.push([`\`${model}\``, label, int(runs), int(exact), int(above), int(edits), int(rejected)]);
		}
	}
	const runs = recount('h2.runs', results.length, `${RESULTS}/${campaign}/results.jsonl`, 'rows');
	const exact = recount('h2.exact', results.filter(row => row.success).length, `${RESULTS}/${campaign}/results.jsonl`, 'rows whose success is true', { denominator: runs });
	const configurations = recount('h2.configurations', new Set(results.map(row => row.configuration)).size, `${RESULTS}/${campaign}/results.jsonl`, 'distinct configurations');
	const shapleyOf = (id: string, game: string, model: string, note: string) => from(id, `${campaign}/analysis.json`, ['games', game, 'perModel', model, 'attribution', 'shapley', 0], { analysis: 'attribution', interval: true, digits: 3, note });
	const components = asArray(pick(readJson(`${RESULTS}/${campaign}/analysis.json`), ['games', 'primary/success', 'perModel', PINNED[0], 'attribution', 'components'], campaign), campaign);
	if (components[0] !== 'protocol handling') {
		problems.push(`${RESULTS}/${campaign}/analysis.json: the first component is not protocol handling`);
	}
	const primary = PINNED.map(model => shapleyOf(`h2.primary.successShapley.${model}`, 'primary/success', model, 'protocol handling, the registered metric in the primary game'));
	shapleyOf('h2.secondary.meanScoreShapley.7b', 'secondary/score', PINNED[0], 'protocol handling; a secondary measure in a secondary game: it decides nothing by registration');
	from('h2.successRateUpperBound', `${campaign}/analysis.json`, ['configurations', 0, 'successRate', 'high'], { analysis: 'attribution', scale: 100, digits: 1, unit: 'percent', note: 'the Wilson upper bound of 0 of 40, the same for every configuration' });
	const shapley = PINNED.map((model, index) => `\`${model}\` ${dec(primary[index], 3)} ${range(interval(`h2.primary.successShapley.${model}`), 3)}`).join('; ');
	blocks.set('h2', `${table(['Model', 'Tool-call protocol', 'Runs', 'Reproduced the author\'s change', 'Runs scoring above 0', 'Runs with an edit on record', 'Runs whose edit call the tool rejected'], rows)}\n\nProtocol handling's Shapley value of task success in the primary game: ${shapley}. Every other Shapley value, main effect and interaction of task success is the same zero (\`${RESULTS}/${campaign}/ANALYSIS.md\`).`);
	return { id: 'H-2', file: `${campaign}/outcome.json`, analysis: 'attribution', number: `${int(exact)} runs reproduced a task: a floor`, of: `${int(runs)} agent runs, ${int(configurations)} configurations`, interval: 'none: every value is 0 with a zero-width interval', directory: campaign };
}

const APPLIERS: readonly (readonly [string, string])[] = [['exact-unique', 'exact-unique (the product)'], ['whitespace-insensitive', 'whitespace-insensitive'], ['unique-first-line', 'unique-first-line'], ['fuzzy', 'fuzzy']];

function buildEdits(): IHypothesisRow[] {
	const directory = '2026-11-22-edit-mechanisms';
	const file = `${directory}/analysis.json`;
	const options = { analysis: 'edits' } as const;
	const attemptRows = readJsonLines(`${RESULTS}/${directory}/attempts.jsonl`).filter(row => isObject(field(row, 'appliers')));
	const rows: string[][] = [];
	let attempts = 0;
	for (const [applier, label] of APPLIERS) {
		const base = ['h3', 'pooled', 'table', applier] as const;
		attempts = applier === 'exact-unique' ? from('h3.attempts', file, [...base, 'attempts'], options) : attempts;
		const applied = from(`h3.${applier}.placed`, file, [...base, 'applied'], { ...options, denominator: attempts });
		const rate = from(`h3.${applier}.placedShare`, file, [...base, 'applyRate'], { ...options, interval: true, scale: 100, digits: 1, unit: 'percent' });
		const notInFile = from(`h3.${applier}.placedThoughNotInTheFile`, file, [...base, 'appliedThoughNotInTheFile'], { ...options, denominator: attempts });
		const wrong = from(`h3.${applier}.silentlyWrong`, file, [...base, 'silentlyWrong'], { ...options, denominator: attempts });
		const wrongRate = from(`h3.${applier}.silentlyWrongShare`, file, [...base, 'silentlyWrongRate'], { ...options, interval: true, scale: 100, digits: 1, unit: 'percent' });
		const score = from(`h3.${applier}.meanScore`, file, [...base, 'meanScore'], options);
		rows.push([label, `${int(applied)} (${dec(rate, 1)}%)`, int(notInFile), `${int(wrong)} (${dec(wrongRate, 1)}% ${range(interval(`h3.${applier}.silentlyWrongShare`), 1, '%')})`, dec(score, 3)]);
		// The counts, counted again from the per-attempt rows, whether or not the analysis was run.
		const verdicts = attemptRows.map(row => field(field(row, 'appliers'), applier));
		const again = { applied: verdicts.filter(verdict => field(verdict, 'applied') === true).length, wrong: verdicts.filter(verdict => field(verdict, 'silentlyWrong') === true).length };
		if (attemptRows.length !== attempts || again.applied !== applied || again.wrong !== wrong) {
			problems.push(`${RESULTS}/${directory}: analysis.json says ${applier} placed ${applied} of ${attempts} with ${wrong} silently wrong; attempts.jsonl has ${again.applied} of ${attemptRows.length} with ${again.wrong}`);
		}
	}
	const difference = from('h3.fuzzyLessExact', file, ['h3', 'pooled', 'fuzzyLessExact'], { ...options, interval: true, scale: 100, digits: 1, unit: 'percentage points' });
	const perModel = PINNED.map(model => from(`h3.attempts.${model}`, file, ['h3', 'perModel', model, 'table', 'exact-unique', 'attempts'], options));
	for (const source of ['2026-11-22-single-turn', '2026-11-22-confidence', '2026-11-22-attribution']) {
		from(`h3.attemptsFrom.${source}`, file, ['sources', source, 'attempts'], options);
	}
	const exactWrong = numbers.find(entry => entry.id === 'h3.exact-unique.silentlyWrong')?.value ?? 0;
	const exactPlaced = numbers.find(entry => entry.id === 'h3.exact-unique.placed')?.value ?? 0;
	recount('h3.exact-unique.silentlyWrongOfPlaced', exactWrong, `${RESULTS}/${directory}/attempts.jsonl`, 'exact-unique verdicts that are silently wrong, over those that were placed', { denominator: exactPlaced });
	blocks.set('h3', `${table(['Applier', 'Placed', 'Placed though its text is not in the file', 'Silently wrong, of all attempts', 'Mean score'], rows)}\n\n${int(attempts)} SEARCH/REPLACE blocks: ${PINNED.map((model, index) => `${int(perModel[index])} from \`${model}\``).join(', ')}. The fuzzy comparator placed ${dec(difference, 1)} points more than exact-unique ${range(interval('h3.fuzzyLessExact'), 1)}.`);

	const h4Rows: string[][] = [];
	for (const model of PINNED) {
		for (const [arm, label] of [['search-replace', 'search and replace'], ['constrained-anchors', 'constrained anchors']] as const) {
			const base = ['h4', 'arms', model, arm] as const;
			const runs = from(`h4.${model}.${arm}.runs`, file, [...base, 'runs'], options);
			const calls = from(`h4.${model}.${arm}.editCalls`, file, [...base, 'editCalls'], { ...options, denominator: runs });
			const refused = from(`h4.${model}.${arm}.refused`, file, [...base, 'refused'], { ...options, denominator: calls });
			const collateral = from(`h4.${model}.${arm}.collateral`, file, [...base, 'collateral'], { ...options, denominator: calls });
			const p90 = from(`h4.${model}.${arm}.p90Seconds`, file, [...base, 'p90Seconds'], { ...options, digits: 1, unit: 'seconds' });
			h4Rows.push([`\`${model}\``, label, int(runs), int(calls), int(refused), int(collateral), dec(p90, 1)]);
		}
	}
	const paired = from('h4.pairedTasks', file, ['h4', 'pairedTasks'], { ...options, denominator: 40 });
	const editCalls = from('h4.editCalls', file, ['h4', 'editCalls'], options);
	blocks.set('h4', table(['Model', 'Arm', 'Runs', 'Edit calls on record', 'Refused', 'Proposals that changed a line the author did not', 'Seconds a run, 90th percentile'], h4Rows));

	const grounded = from('h5.grounded.edits', file, ['h5', 'grounded', 'edits'], options);
	const groundedScore = from('h5.grounded.meanScore', file, ['h5', 'grounded', 'meanScore'], options);
	const ungrounded = from('h5.ungrounded.edits', file, ['h5', 'ungrounded', 'edits'], options);
	const ungroundedScore = from('h5.ungrounded.meanScore', file, ['h5', 'ungrounded', 'meanScore'], options);
	const leftOut = from('h5.leftOut.notApplicable', file, ['h5', 'leftOut', 'notApplicable'], options);
	const h5 = from('h5.difference', file, ['h5', 'difference'], { ...options, interval: true, digits: 3 });
	const delta = from('h5.cliffsDelta', file, ['h5', 'cliffsDelta'], options);
	blocks.set('h5', table(['Class', 'Edits', 'Mean score'], [
		['Grounded: the anchor was in the model\'s context that turn', int(grounded), dec(groundedScore, 3)],
		['Ungrounded', int(ungrounded), dec(ungroundedScore, 3)],
		['Left out: grounding not applicable', int(leftOut), ''],
		['Difference, grounded less ungrounded', '', `${dec(h5, 3)} ${range(interval('h5.difference'), 3)}`],
		['Cliff\'s delta', '', dec(delta, 2)],
	]));
	return [
		{ id: 'H-3', file: `${directory}/outcome-H-3.json`, analysis: 'edits', number: `the fuzzy comparator places ${dec(difference, 1)} points more blocks than exact-or-refuse; ${dec(numbers.find(entry => entry.id === 'h3.fuzzy.silentlyWrongShare')?.value ?? 0, 1)}% of attempts end silently wrong under it`, of: `${int(attempts)} attempts`, interval: `${range(interval('h3.fuzzyLessExact'), 1)} points; ${range(interval('h3.fuzzy.silentlyWrongShare'), 1, '%')}`, directory },
		{ id: 'H-4', file: `${directory}/outcome-H-4.json`, analysis: 'edits', number: `${int(paired)} tasks with an edit call in both arms`, of: `40 tasks; ${int(editCalls)} edit calls in all`, interval: 'none: there is no pair to compare', directory },
		{ id: 'H-5', file: `${directory}/outcome-H-5.json`, analysis: 'edits', number: `grounded edits score ${dec(h5, 3)} higher, under the registered 0.05`, of: `${int(grounded)} grounded and ${int(ungrounded)} ungrounded edits`, interval: range(interval('h5.difference'), 3), directory },
	];
}

function buildH6(): IHypothesisRow {
	const rows: string[][] = [];
	const summary: { identical: number; comparisons: number }[] = [];
	for (const [key, campaign, analysis, label] of [['first', '2026-11-22-determinism', 'determinism-first', 'first, invalid'], ['second', '2026-11-22-determinism-2', 'determinism', 'second, with the fix: decides H-6']] as const) {
		const file = `${campaign}/determinism.json`;
		const comparisons = from(`h6.${key}.comparisons`, file, ['pooled', 'comparisons'], { analysis });
		const identical = from(`h6.${key}.identical`, file, ['pooled', 'identical'], { analysis, denominator: comparisons });
		const share = from(`h6.${key}.identicalShare`, file, ['pooled', 'identicalShare'], { analysis, interval: true, scale: 100, digits: 1, unit: 'percent' });
		const units = from(`h6.${key}.units`, file, ['units'], { analysis });
		const runs = from(`h6.${key}.runs`, file, ['runs'], { analysis });
		from(`h6.${key}.multiTurnRuns`, file, ['multiTurnRuns'], { analysis, denominator: runs });
		const byModel = asArray(field(readJson(`${RESULTS}/${file}`), 'byModel'), file);
		const sum = (pickFrom: (model: Json) => Json) => byModel.reduce<number>((total, model) => total + asNumber(pickFrom(model), file), 0);
		const allSame = add({ id: `h6.${key}.unitsAllIdentical`, value: sum(model => field(model, 'unitsAllIdentical')), denominator: units, source: `${RESULTS}/${file}`, path: 'byModel / unitsAllIdentical, summed', ...provenance(analysis) });
		const harness = add({ id: `h6.${key}.harnessDivergences`, value: sum(model => field(field(model, 'bySource'), 'harness')), denominator: comparisons, source: `${RESULTS}/${file}`, path: 'byModel / bySource / harness, summed', ...provenance(analysis) });
		const runtime = add({ id: `h6.${key}.runtimeDivergences`, value: sum(model => field(field(model, 'bySource'), 'runtime')), denominator: comparisons, source: `${RESULTS}/${file}`, path: 'byModel / bySource / runtime, summed', ...provenance(analysis) });
		recount(`h6.${key}.unitsWithADivergence`, units - allSame, `${RESULTS}/${file}`, 'units less unitsAllIdentical', { denominator: units });
		rows.push([`\`${campaign}\` (${label})`, `${int(identical)} of ${int(comparisons)}`, `${dec(share, 1)}% ${range(interval(`h6.${key}.identicalShare`), 1, '%')}`, `${int(allSame)} of ${int(units)}`, int(runtime), int(harness)]);
		summary.push({ identical, comparisons });
	}
	recount('h6.comparisonsWithoutARuntimeDivergence', summary[0].comparisons + summary[1].comparisons, `${RESULTS}/2026-11-22-determinism/determinism.json, ${RESULTS}/2026-11-22-determinism-2/determinism.json`, 'comparisons of both campaigns; the runtime diverged in none');
	blocks.set('h6', table(['Campaign', 'Repetitions identical to the unit\'s first', 'Share, Wilson interval', 'Units with all five identical', 'Divergences: the runtime\'s', 'Divergences: the harness\'s'], rows));
	return { id: 'H-6', file: '2026-11-22-determinism-2/outcome-H-6.json', analysis: 'determinism', number: `${int(summary[1].identical)} repetitions identical, on the second campaign; the first, ${int(summary[0].identical)} of ${int(summary[0].comparisons)}, was invalidated by a harness defect it found`, of: `${int(summary[1].comparisons)} comparisons`, interval: range(interval('h6.second.identicalShare'), 1, '%'), directory: '2026-11-22-determinism-2' };
}

function buildH7(): IHypothesisRow {
	const file = '2026-11-22-rankings-onyx/rankings.json';
	const rows: string[][] = [];
	let tasks = 0;
	for (const [repository, label] of [['2026-11-22-rankings-onyx', 'this repository'], ['2026-11-22-rankings-brew', 'Homebrew/brew']] as const) {
		for (const model of MODELS) {
			const base = ['repositories', { where: ['repository', repository] }, 'scores', { where: ['model', model] }] as const;
			tasks = from(`h7.${repository}.${model}.tasks`, file, [...base, 'tasks'], { analysis: 'rankings' });
			const solved = from(`h7.${repository}.${model}.solved`, file, [...base, 'solved'], { analysis: 'rankings', denominator: tasks });
			const score = from(`h7.${repository}.${model}.meanScore`, file, [...base, 'meanScore'], { analysis: 'rankings', digits: 3 });
			rows.push([label, `\`${model}\``, `${int(solved)} of ${int(tasks)}`, dec(score, 3)]);
		}
	}
	blocks.set('h7', table(['Repository', 'Model', 'Tasks solved', 'Mean score (not the registered metric)'], rows));
	return { id: 'H-7', file: '2026-11-22-rankings-onyx/outcome-H-7.json', analysis: 'rankings', number: '0 tasks solved by any of three models in either of two repositories: a floor', of: `${int(tasks)} tasks a repository`, interval: 'none: no repository has a ranking', directory: '2026-11-22-rankings-onyx' };
}

function buildH8(): IHypothesisRow {
	const file = '2026-11-22-confidence/confidence.json';
	const options = { analysis: 'confidence' } as const;
	const records_ = from('h8.runs', file, ['records'], options);
	const units = from('h8.units', file, ['units'], options);
	const withoutHunk = from('h8.unitsWithoutAnAppliedFirstReply', file, ['unitsWithoutAnAppliedFirstReply'], { ...options, denominator: units });
	const labelled = from('h8.labelledHunks', file, ['labelledHunks'], options);
	const correct = from('h8.correctHunks', file, ['correctHunks'], { ...options, denominator: labelled });
	const hunks = asArray(field(readJson(`${RESULTS}/${file}`), 'hunks'), file);
	const floor = add({ id: 'h8.hunksAtTheAgreementFloor', value: hunks.filter(hunk => field(hunk, 'agreement') === 0.2).length, denominator: labelled, source: `${RESULTS}/${file}`, path: 'hunks whose agreement is 0.2', ...provenance('confidence') });
	const rows: string[][] = [];
	for (const [estimator, label] of [['agreement', 'agreement of five samples'], ['token-probability', 'least token probability of the block']] as const) {
		const base = ['pooled', { where: ['estimator', estimator] }] as const;
		const count = from(`h8.${estimator}.hunks`, file, [...base, 'hunks'], options);
		const right = from(`h8.${estimator}.correct`, file, [...base, 'correct'], { ...options, denominator: count });
		const auroc = from(`h8.${estimator}.auroc`, file, [...base, 'auroc'], { ...options, interval: true, digits: 3 });
		const ece = from(`h8.${estimator}.ece`, file, [...base, 'ece'], { ...options, digits: 3 });
		rows.push([label, int(count), int(right), `${dec(auroc, 3)} ${range(interval(`h8.${estimator}.auroc`), 3)}`, dec(ece, 3), asString(pick(readJson(`${RESULTS}/${file}`), [...base, 'decision', 'outcome'], file), file)]);
	}
	blocks.set('h8', `${table(['Estimator', 'Labelled hunks', 'Correct', 'AUROC, interval', 'ECE', 'By the registered thresholds'], rows)}\n\n${int(records_)} runs, ${int(units)} units (a model and a task). ${int(withoutHunk)} units had no hunk to label because their first reply placed no edit. For ${int(floor)} of ${int(labelled)} hunks the first sample's hunk appeared in no other sample.`);
	return { id: 'H-8', file: '2026-11-22-confidence/outcome-H-8.json', analysis: 'confidence', number: `${int(correct)} correct hunks; 20 of each class were needed`, of: `${int(labelled)} labelled hunks`, interval: `AUROC ${range(interval('h8.agreement.auroc'), 3)} and ${range(interval('h8.token-probability.auroc'), 3)}: both include 0.5`, directory: '2026-11-22-confidence' };
}

function buildH9(): IHypothesisRow {
	const file = '2026-11-22-eviction-scripted/eviction.json';
	const options = { analysis: 'eviction' } as const;
	const runs = from('h9.scriptedRuns', file, ['scripted', 'runs'], options);
	const rows: string[][] = [];
	const agentic: string[][] = [];
	let turns = 0;
	for (const policy of ['oldest-results-first', 'block-to-low-watermark', 'placeholder-results']) {
		const base = ['scripted', 'policies', { where: ['policy', policy] }] as const;
		turns = from(`h9.${policy}.turns`, file, [...base, 'turns'], options);
		const tokens = from(`h9.${policy}.reprocessedTokens`, file, [...base, 'reprocessedTokens'], { ...options, unit: 'tokens, estimated from prompt-evaluation time' });
		const first = from(`h9.${policy}.meanFirstTokenMs`, file, [...base, 'meanFirstTokenMs'], { ...options, unit: 'ms' });
		let ratio = '';
		if (policy !== 'oldest-results-first') {
			const value = from(`h9.${policy}.ratio`, file, [...base, 'ratioToOldestFirst'], { ...options, interval: true, digits: 2, note: 'an estimate from prompt-evaluation time: the runtime does not report evaluated tokens' });
			ratio = `${dec(value, 2)} ${range(interval(`h9.${policy}.ratio`), 2)}`;
		}
		rows.push([`\`${policy}\`${policy === 'oldest-results-first' ? ' (the product)' : ''}`, int(tokens), ratio, int(first)]);
		const agent = ['agentic', 'policies', { where: ['policy', policy] }] as const;
		const attempted = from(`h9.${policy}.agentic.attempted`, file, [...agent, 'attempted'], options);
		const succeeded = from(`h9.${policy}.agentic.succeeded`, file, [...agent, 'succeeded'], { ...options, denominator: attempted });
		const evicted = from(`h9.${policy}.agentic.runsThatEvicted`, file, [...agent, 'runsThatEvicted'], { ...options, denominator: attempted });
		agentic.push([`\`${policy}\``, `${int(succeeded)} of ${int(attempted)}`, `${int(evicted)} of ${int(attempted)}`]);
	}
	const probe = readJsonLines(`${RESULTS}/2026-11-22-eviction-scripted/probe.jsonl`)[0];
	const probeFile = `${RESULTS}/2026-11-22-eviction-scripted/probe.jsonl`;
	const probed = (id: string, segments: readonly string[], unit: string) => add({ id, value: asNumber(pick(probe, segments, probeFile), probeFile), unit, source: probeFile, path: `line 1 / ${segments.join(' / ')}`, derivation: 'committed' });
	const count = probed('h9.probe.promptEvalCount', ['firstTime', 'promptEvalCount'], 'tokens');
	const firstMs = probed('h9.probe.firstMs', ['firstTime', 'promptEvalMs'], 'ms');
	const againMs = probed('h9.probe.againMs', ['sameAgain', 'promptEvalMs'], 'ms');
	if (pick(probe, ['sameAgain', 'promptEvalCount'], probeFile) !== count) {
		problems.push(`${probeFile}: the second request's promptEvalCount is not the first's, so the report's account of the probe is wrong`);
	}
	blocks.set('h9', [
		table(['Policy, scripted runs', 'Re-processed tokens, turns 2 to 16, estimated', 'Ratio to oldest-first, interval', 'Mean time to first token, ms'], rows),
		'',
		`${int(runs)} scripted runs, ${int(turns)} paired turns a policy. The probe: the same prompt twice to \`${PINNED[0]}\`; the runtime reported ${int(count)} prompt tokens evaluated both times, in ${int(firstMs)} ms and then ${int(againMs)} ms.`,
		'',
		table(['Policy, agentic runs', 'Succeeded', 'Runs in which anything was evicted'], agentic),
	].join('\n'));
	const ratio = numbers.find(entry => entry.id === 'h9.block-to-low-watermark.ratio')?.value ?? 0;
	return { id: 'H-9', file: '2026-11-22-eviction-scripted/outcome-H-9.json', analysis: 'eviction', number: `block eviction re-processes ${dec(ratio, 2)} of oldest-first's prompt tokens, by an estimate from prompt-evaluation time; the success condition was met with no eviction occurring and no run succeeding`, of: `${int(turns)} paired turns; 40 agentic runs a policy`, interval: range(interval('h9.block-to-low-watermark.ratio'), 2), directory: '2026-11-22-eviction-scripted' };
}

function buildH10(): IHypothesisRow {
	const file = '2026-11-22-energy/energy.json';
	const options = { analysis: 'energy' } as const;
	from('h10.runs', file, ['records'], options);
	from('h10.powerRefreshes', file, ['powerRefreshes'], options);
	const solvedModels = from('h10.modelsWithASolvedTask', file, ['modelsWithASolvedTask'], { ...options, denominator: MODELS.length });
	const rows: string[][] = [];
	for (const model of MODELS) {
		const base = ['models', { where: ['model', model] }] as const;
		const value = (key: string, unit?: string, extra: IFromOptions = {}) => from(`h10.${model}.${key}`, file, [...base, key], { ...options, unit, ...extra });
		const attempts = value('attempts');
		const solved = value('solved', undefined, { denominator: attempts });
		const seconds = value('blockSeconds', 'seconds');
		const joules = value('joules', 'J');
		const boundary = value('boundaryJoules', 'J');
		const perAttempt = value('joulesPerAttempt', 'J');
		const perThousand = value('joulesPerThousandTokens', 'J');
		const speed = value('tokensPerSecond', 'tokens a second');
		value('completionTokens', 'tokens');
		const share = recount(`h10.${model}.boundaryShare`, round(100 * boundary / joules, 0), `${RESULTS}/${file}`, 'boundaryJoules over joules, times 100, rounded', { unit: 'percent' });
		rows.push([`\`${model}\``, int(seconds), int(joules), `${int(boundary)} (${int(share)}%)`, `${int(solved)} of ${int(attempts)}`, int(perAttempt), int(perThousand), dec(speed, 1)]);
	}
	blocks.set('h10', table(['Model', 'Block, s', 'Energy, J', 'Bound on the block\'s ends, J', 'Solved', 'Energy an attempt, J', 'Energy a thousand tokens, J', 'Tokens a second'], rows));
	const each = MODELS.map(model => `${int(numbers.find(entry => entry.id === `h10.${model}.joulesPerAttempt`)?.value ?? 0)} J`).join(', ');
	return { id: 'H-10', file: '2026-11-22-energy/outcome-H-10.json', analysis: 'energy', number: `${int(solvedModels)} models solved a task; energy an attempt ${each}, which decides nothing`, of: `${MODELS.length} models, 72 attempts each`, interval: 'none: no energy per solved task exists', directory: '2026-11-22-energy' };
}

/** A fixture task that carries a planted instruction; the control tasks name the effect "none". */
const isPlanted = (task: Json): boolean => typeof field(task, 'effect') === 'string' && field(task, 'effect') !== 'none';

function buildInjection(): void {
	const file = '2026-11-22-injection/injection.json';
	const options = { analysis: 'injection' } as const;
	const planted = from('injection.plantedRuns', file, ['plantedRuns'], options);
	from('injection.reachedForThePlantedEffect', file, ['reachedForThePlantedEffect'], { ...options, denominator: planted });
	from('injection.plantedEffectHappened', file, ['plantedEffectHappened'], { ...options, denominator: planted });
	const control = from('injection.controlRuns', file, ['controlRuns'], options);
	from('injection.controlRunsThatReached', file, ['controlRunsThatReachedForAnyEffect'], { ...options, denominator: control });
	const tasks = asArray(field(readJson(`${RESULTS}/2026-11-22-injection/tasks.json`), 'tasks'), 'injection tasks');
	recount('injection.fixtureTasks', tasks.length, `${RESULTS}/2026-11-22-injection/tasks.json`, 'tasks');
	recount('injection.fixtureTasksWithAPlantedInstruction', tasks.filter(task => isPlanted(task)).length, `${RESULTS}/2026-11-22-injection/tasks.json`, 'tasks whose effect is not "none"', { denominator: tasks.length });
}

function buildTaskSet(): void {
	const file = '2026-11-22-task-set/summary.json';
	const tasks = from('tasks.total', file, ['tasks']);
	from('tasks.scannedCommits', file, ['selection', 'scannedCommits']);
	from('tasks.eligibleCommits', file, ['selection', 'eligible']);
	from('tasks.withATestChange', file, ['counts', 'withTests'], { denominator: tasks });
	from('tasks.fromRequests', file, ['counts', 'bySource', 'request'], { denominator: tasks });
	from('tasks.hashesMatch', file, ['checkedAgainstTheRepository', 'tasksWhoseHashesMatch'], { denominator: tasks });
	from('tasks.excludedCommits', file, ['selection', 'excludedCommits']);
	for (const [id, campaign] of [['tasks.subset.h2', '2026-11-22-attribution'], ['tasks.subset.h6', '2026-11-22-determinism-2'], ['tasks.subset.h8', '2026-11-22-confidence'], ['tasks.subset.h10', '2026-11-22-energy'], ['tasks.subset.brew', '2026-11-22-rankings-brew'], ['tasks.subset.referenceMeasure', '2026-11-22-reference-measure']] as const) {
		const count = new Set(readJsonLines(`${RESULTS}/${campaign}/results.jsonl`).map(row => field(row, 'task'))).size;
		recount(id, count, `${RESULTS}/${campaign}/results.jsonl`, 'distinct tasks', { denominator: campaign.includes('brew') ? undefined : tasks });
	}
}

function buildHypotheses(rows: readonly IHypothesisRow[]): void {
	const outcomes = { supported: 0, refuted: 0, inconclusive: 0 };
	const body = rows.map(row => {
		const outcome = readJson(`${RESULTS}/${row.file}`);
		const verdict = asString(field(outcome, 'outcome'), row.file);
		if (verdict === 'supported' || verdict === 'refuted' || verdict === 'inconclusive') {
			outcomes[verdict]++;
		} else {
			problems.push(`${row.file}: outcome "${verdict}"`);
		}
		return [row.id, asString(field(outcome, 'statement'), row.file), `**${verdict}**`, row.number, row.of, row.interval, `[\`${row.directory}\`](results/${row.directory}/)`];
	});
	recount('outcomes.supported', outcomes.supported, `${RESULTS}/*/outcome*.json`, 'outcome files that say "supported"', { denominator: rows.length });
	recount('outcomes.refuted', outcomes.refuted, `${RESULTS}/*/outcome*.json`, 'outcome files that say "refuted"', { denominator: rows.length });
	recount('outcomes.inconclusive', outcomes.inconclusive, `${RESULTS}/*/outcome*.json`, 'outcome files that say "inconclusive"', { denominator: rows.length });
	blocks.set('hypotheses', table(['', 'Statement, as registered', 'Outcome', 'The number', 'Of', '95% interval', 'Results'], body));
}

// ---------------------------------------------------------------------------------------------
// The reproduction package's indexes
// ---------------------------------------------------------------------------------------------

function sha256(relative: string): string {
	return crypto.createHash('sha256').update(fs.readFileSync(path.join(repoRoot, relative))).digest('hex');
}

function gitShow(revision: string, file: string): string {
	try {
		return execFileSync('git', ['-C', repoRoot, '--no-optional-locks', 'show', `${revision}:${file}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
	} catch {
		throw new Error(`make-report: ${file} at ${revision} is not in this clone's history. The index of shrunk counterexamples reads their seeds from history: fetch it (git fetch --unshallow).`);
	}
}

function buildData(): void {
	const mutantsDirectory = 'test/onyx/sim/mutants';
	const mutation = asArray(field(readJson(`${RESULTS}/2026-11-22-assurance/traces/mutation.json`), 'mutants'), 'mutation.json');
	const mutants = fs.readdirSync(path.join(repoRoot, mutantsDirectory)).filter(name => name.endsWith('.json')).sort().map(name => {
		const descriptor = JSON.parse(fs.readFileSync(path.join(repoRoot, mutantsDirectory, name), 'utf8')) as Json;
		const run = mutation.find(entry => field(entry, 'id') === field(descriptor, 'id')) ?? null;
		return {
			id: field(descriptor, 'id'), descriptor: `${mutantsDirectory}/${name}`, defectItResurrects: field(descriptor, 'defect'), fixedBy: field(descriptor, 'fixedBy'),
			violationTheCampaignMustReport: field(descriptor, 'detects'), resurrectedBy: field(descriptor, 'resurrects'), scriptPersona: field(field(descriptor, 'script'), 'persona'),
			inTheCommittedRun: run ? { killedByItsScript: field(run, 'killedByItsScript'), killedByTheCampaign: field(run, 'killedByTheCampaign'), firstDetectedAtSeed: field(run, 'firstDetectedAt') } : null,
		};
	});
	// The corpus grows after a dated campaign (a later fix adds its mutant); H-1 is about the campaign's
	// own set. A mutant the campaign ran must still exist, and a later one is listed as not in it: the
	// nightly workflow and the module gate run every current mutant.
	const inCampaign = mutants.filter(mutant => mutant.inTheCommittedRun !== null).length;
	const addedLater = mutants.filter(mutant => mutant.inTheCommittedRun === null).map(mutant => mutant.id);
	dataFiles.set('mutants.json', serialize({ generatedBy: SELF, from: [`${mutantsDirectory}/*.json`, `${RESULTS}/2026-11-22-assurance/traces/mutation.json`], count: mutants.length, inTheCommittedCampaign: inCampaign, addedAfterTheCampaign: addedLater, mutants }));
	const declared = numbers.find(entry => entry.id === 'h1.mutants')?.value;
	const vanished = mutation.map(entry => field(entry, 'id')).filter(id => !mutants.some(mutant => mutant.id === id));
	if (inCampaign !== declared || vanished.length) {
		problems.push(`the committed assurance run has ${declared} mutants; ${inCampaign} of the descriptors in ${mutantsDirectory} are in it${vanished.length ? `, and these it ran no longer exist: ${vanished.join(', ')}` : ''}`);
	}

	const violations = asArray(field(readJson(`${RESULTS}/2026-11-22-assurance/summary.json`), 'violationsFoundDuringDevelopment'), 'summary.json');
	const shrunk = violations.map(violation => {
		const match = /^(?<file>\S+) at (?<revision>\S+)$/.exec(asString(field(violation, 'script'), 'script'));
		const file = match?.groups?.file ?? '';
		const revision = match?.groups?.revision ?? '';
		const script = JSON.parse(gitShow(revision, file)) as Json;
		return { seed: field(script, 'seed'), violationClass: field(violation, 'class'), script: file, atRevision: revision, show: `git show ${revision}:${file}`, persona: field(script, 'persona'), removedBy: field(violation, 'removedBy'), fixedIn: field(violation, 'subject') };
	}).sort((first, second) => Number(first.seed) - Number(second.seed) || String(first.violationClass).localeCompare(String(second.violationClass)));
	const notesFile = `${RESULTS}/2026-11-22-assurance/NOTES.md`;
	const notes = readText(notesFile);
	const rigSeeds = [
		...[...notes.matchAll(/^\| (?<seed>\d+) \| /gm)].map(match => ({ seed: Number(match.groups?.seed), campaign: 'the first run of the 50,000-episode campaign', account: notesFile, trace: `${RESULTS}/2026-11-22-assurance/traces/first-run/campaign.txt` })),
		...(/in seeds (?<list>[\d, and]+) \(/.exec(notes)?.groups?.list.match(/\d+/g) ?? []).map(seed => ({ seed: Number(seed), campaign: 'Module 3\'s gate, 20,000 episodes', account: 'docs/progress/module-3-gate.md', trace: null })),
	].sort((first, second) => first.seed - second.seed);
	dataFiles.set('counterexamples.json', serialize({
		generatedBy: SELF,
		from: [`${RESULTS}/2026-11-22-assurance/summary.json (violationsFoundDuringDevelopment)`, 'the scripts themselves, read from history for their seeds', notesFile],
		note: 'Nothing is copied here. A shrunk script of a violation the unmodified harness committed was removed from test/onyx/sim/baseline/ by the commit that fixed its class, so each is named at the revision before that commit. The second list is seeds at which a campaign printed a violation that was judged an error of the rig\'s own bookkeeping: no shrunk script was committed for those, and the documents named say how to reproduce the trace.',
		shrunkScriptsOfHarnessViolations: shrunk,
		seedsAtWhichTheRigWasWrong: rigSeeds,
	}));

	const rig: readonly (readonly [string, string])[] = [
		['onyxSimRig.ts', 'the rig: the real agent loop, control plane, change sets and tools against a simulated stream, user, file system and clock'],
		['onyxSimRun.ts', 'one seeded episode, start to end'],
		['onyxSimEpisode.ts', 'the shape of an episode script: persona, turns, user steps, faults'],
		['onyxSimRandom.ts', 'the seeded generator every choice is drawn from'],
		['onyxSimFakes.ts', 'the simulated model stream, dialogs, file system and clock'],
		['onyxSimInvariants.ts', 'the checkers of I-01 to I-14'],
		['onyxSimTrace.ts', 'the canonical trace the checkers read'],
		['onyxSimShrinker.ts', 'shrinks a failing episode to a short script'],
		['onyxSimScenarios.ts', 'the scripted workflows'],
		['onyxSimInjection.ts', 'the injection corpus: surfaces, effects and the obedient persona'],
		['onyxSimMutants.ts', 'the resurrection mutants: test-only subclasses that put a fixed defect back'],
		['onyxSimMutantTable.ts', 'each mutant\'s defect, fixing item, expected violation and script'],
		['onyxSimBaseline.ts', 'the table of baseline exceptions and the campaign that lists classes'],
		['onyxSimBehaviourBaseline.ts', 'the behaviour snapshot of seeded traces'],
		['onyxSimCanary.ts', 'a planted violation that shows the checkers are awake'],
		['onyxSimReplay.ts', 'trace conformance replay'],
		['onyxSim.test.ts', 'the suite `./scripts/test.sh --grep OnyxSim` runs'],
		['onyxSimReplay.test.ts', 'the replay suite'],
	];
	const present = fs.readdirSync(path.join(repoRoot, SIM_SOURCES)).filter(name => name.endsWith('.ts')).sort();
	const listed = rig.map(([name]) => name).sort();
	if (present.join() !== listed.join()) {
		problems.push(`${SIM_SOURCES} holds ${present.join(', ')}; the index in make-report.mts describes ${listed.join(', ')}`);
	}
	const episodes = 'test/onyx/sim/episodes';
	dataFiles.set('simulation-index.json', serialize({
		generatedBy: SELF,
		rig: rig.map(([name, what]) => ({ path: `${SIM_SOURCES}/${name}`, what })),
		runners: [
			{ path: 'test/onyx/sim/run-campaign.mts', what: 'a seeded campaign in shards of 2,000 episodes' },
			{ path: 'test/onyx/sim/write-assurance.mts', what: 'the assurance campaign and the mutation run, written as a results directory' },
			{ path: 'test/onyx/sim/export-episodes.mts', what: 'writes the JSON tables under test/onyx/sim/ from their TypeScript sources, and checks them' },
			{ path: 'test/onyx/sim/baseline-exceptions.json', what: 'the baseline exceptions still open' },
		],
		scriptedWorkflows: fs.readdirSync(path.join(repoRoot, episodes)).filter(name => name.endsWith('.json')).sort().map(name => {
			const script = JSON.parse(fs.readFileSync(path.join(repoRoot, episodes, name), 'utf8')) as Json;
			return { path: `${episodes}/${name}`, persona: field(script, 'persona') };
		}),
	}));

	const corpus = field(readJson(`${RESULTS}/2026-11-22-assurance/summary.json`), 'injectionCorpus');
	const fixture = readJson(`${RESULTS}/2026-11-22-injection/tasks.json`);
	const fixtureTasks = asArray(field(fixture, 'tasks'), 'tasks');
	dataFiles.set('injection-corpus.json', serialize({
		generatedBy: SELF,
		simulated: { path: `${SIM_SOURCES}/onyxSimInjection.ts`, episodes: field(corpus, 'episodes'), surfaces: field(corpus, 'surfaces'), effects: field(corpus, 'effects'), userDecisions: field(corpus, 'userDecisions'), notSimulated: field(corpus, 'notSimulated'), countFrom: `${RESULTS}/2026-11-22-assurance/summary.json` },
		realModelFixture: { generator: 'test/onyx/lab/make-injection-fixture.mts', tasks: `${RESULTS}/2026-11-22-injection/tasks.json`, taskSetHash: field(fixture, 'hash'), count: fixtureTasks.length, withAPlantedInstruction: fixtureTasks.filter(task => isPlanted(task)).length, withNothingPlanted: fixtureTasks.filter(task => !isPlanted(task)).length, analysis: analysisOf('injection').display },
	}));

	const taskSet = '2026-11-22-task-set';
	const setSummary = readJson(`${RESULTS}/${taskSet}/summary.json`);
	dataFiles.set('task-sets.json', serialize({
		generatedBy: SELF,
		taskSet: { directory: `${RESULTS}/${taskSet}`, name: field(setSummary, 'taskSet'), hash: field(setSummary, 'hash'), tasks: field(setSummary, 'tasks'), readBackFrom: field(setSummary, 'readBackFrom'), tasksFileSha256: sha256(`${RESULTS}/${taskSet}/tasks.json`), perTaskHashes: `${RESULTS}/${taskSet}/trace-digests.json`, check: `node test/onyx/lab/describe-task-set.mts ${RESULTS}/${taskSet}` },
		subsetsUsedByCampaigns: fs.readdirSync(path.join(repoRoot, RESULTS)).filter(name => fs.existsSync(path.join(repoRoot, RESULTS, name, 'tasks.json')) && name !== taskSet).sort().map(name => {
			const declared = field(readJson(`${RESULTS}/${name}/manifest.json`), 'taskSet');
			return { campaign: name, name: field(declared, 'name'), hash: field(declared, 'hash'), count: field(declared, 'count'), tasksFileSha256: sha256(`${RESULTS}/${name}/tasks.json`) };
		}),
	}));
}

// ---------------------------------------------------------------------------------------------
// The docs check
// ---------------------------------------------------------------------------------------------

/** What the docs check does not treat as a number. Each is removed from a line before its tokens are read. */
const ALLOWLIST: readonly { readonly what: string; readonly pattern: RegExp }[] = [
	{ what: 'ISO dates and times', pattern: /\b\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z)?/g },
	{ what: 'arXiv identifiers', pattern: /\barXiv[: ]\d{4}\.\d{4,5}/g },
	{ what: 'version numbers with two dots', pattern: /\b\d+\.\d+\.\d+\b/g },
	{ what: 'plan identifiers: hypotheses, invariants, regressions, items, decisions', pattern: /\b(?:H|I|R|L|A|B|C|D|E|DEC)-?\d+(?:\.\d+)?\b/g },
	{ what: 'the three models\' names', pattern: /\b(?:qwen2\.5-coder:(?:7b|1\.5b)|llama3\.2:3b)\b/g },
	{ what: 'model size labels such as 7B', pattern: /\b\d+(?:\.\d+)?B\b/g },
	{ what: 'references to a numbered section, such as section 5.3', pattern: /\b[Ss]ections? \d+(?:\.\d+)?/g },
];

interface IToken { readonly text: string; readonly value: number; readonly digits: number }

function tokensOf(line: string): IToken[] {
	let text = line.replace(/`[^`]*`/g, ' ').replace(/\]\([^)]*\)/g, '] ').replace(/<!--.*?-->/g, ' ').replace(/^(#+\s+)\d+(?:\.\d+)?\s/, '$1');
	for (const allowed of ALLOWLIST) {
		text = text.replace(allowed.pattern, ' ');
	}
	const found: IToken[] = [];
	for (const match of text.matchAll(/(?<![\w.])(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?%?(?![\w])/g)) {
		const raw = match[0];
		const plain = raw.replace(/[,%]/g, '');
		const digits = plain.includes('.') ? plain.length - plain.indexOf('.') - 1 : 0;
		if (raw.includes(',') || raw.includes('%') || digits > 0 || plain.length >= 2) {
			found.push({ text: raw, value: Number(plain), digits });
		}
	}
	return found;
}

function unsourced(label: string, lines: readonly string[], first: number, known: readonly number[]): string[] {
	const out: string[] = [];
	let generated = false;
	let fenced = false;
	lines.forEach((line, index) => {
		if (/^<!-- generated:/.test(line)) {
			generated = true;
		} else if (/^<!-- \/generated:/.test(line)) {
			generated = false;
		} else if (/^```/.test(line)) {
			fenced = !fenced;
		} else if (!generated && !fenced) {
			for (const token of tokensOf(line)) {
				if (!known.some(value => Math.abs(round(value, token.digits) - token.value) < 1e-9)) {
					out.push(`${label}:${first + index}: ${token.text} has no source in numbers.json`);
				}
			}
		}
	});
	return out;
}

function fillBlocks(report: string): string {
	let filled = report;
	for (const [name, body] of blocks) {
		const open = `<!-- generated:${name} -->`;
		const close = `<!-- /generated:${name} -->`;
		const start = filled.indexOf(open);
		const end = filled.indexOf(close);
		if (start === -1 || end === -1 || end < start) {
			problems.push(`${path.basename(reportPath)} has no ${open} … ${close} for the table "${name}"`);
			continue;
		}
		filled = `${filled.slice(0, start + open.length)}\n${body}\n${filled.slice(end)}`;
	}
	for (const match of filled.matchAll(/<!-- generated:(?<name>[\w-]+) -->/g)) {
		if (!blocks.has(match.groups?.name ?? '')) {
			problems.push(`${path.basename(reportPath)} has a generated block "${match.groups?.name}" that make-report.mts does not write`);
		}
	}
	return filled;
}

// ---------------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------------

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'onyx-report-'));
let exitCode = 0;
/**
 * The numbers of REPORT.md's "Limits of these verdicts" (9.1), counted from the
 * per-attempt and per-run rows. Added after an audit on 2026-11-26; no
 * registered verdict depends on them.
 */
function buildLimits(): void {
	const edits = `${RESULTS}/2026-11-22-edit-mechanisms/attempts.jsonl`;
	const rows = readJsonLines(edits);
	const placed = (row: Json, applier: string) => field(field(field(row, 'appliers'), applier), 'applied') === true;
	recount('limits.h3.placedByBoth', rows.filter(row => placed(row, 'exact-unique') && placed(row, 'fuzzy')).length, edits, 'attempts placed by both exact-unique and fuzzy', { denominator: rows.length });
	recount('limits.h3.placedByFuzzyOnly', rows.filter(row => !placed(row, 'exact-unique') && placed(row, 'fuzzy')).length, edits, 'attempts placed by fuzzy and not by exact-unique', { denominator: rows.length });
	recount('limits.h3.placedByExactOnly', rows.filter(row => placed(row, 'exact-unique') && !placed(row, 'fuzzy')).length, edits, 'attempts placed by exact-unique and not by fuzzy', { denominator: rows.length });
	const scored = (grounding: string) => rows.filter(row => field(row, 'grounding') === grounding).map(row => Number(field(field(field(row, 'appliers'), 'exact-unique'), 'score') ?? 0));
	const grounded = scored('grounded');
	const ungrounded = scored('ungrounded');
	recount('limits.h5.groundedScoringZero', grounded.filter(score => score === 0).length, edits, 'grounded edits whose exact-unique score is 0', { denominator: grounded.length });
	recount('limits.h5.groundedHighestScore', Math.max(...grounded), edits, 'the highest exact-unique score of a grounded edit');
	recount('limits.h5.ungroundedScoringZero', ungrounded.filter(score => score === 0).length, edits, 'ungrounded edits whose exact-unique score is 0', { denominator: ungrounded.length });
	const determinism = `${RESULTS}/2026-11-22-determinism-2/traces/records.jsonl`;
	const runs = readJsonLines(determinism);
	const requests = (record: Json) => { const list = field(record, 'requests'); return Array.isArray(list) ? list.length : 0; };
	recount('limits.h6.runsWithTwoTurns', runs.filter(record => requests(record) === 2).length, determinism, 'records with two requests', { denominator: runs.length });
	recount('limits.h6.runsWithThreeTurns', runs.filter(record => requests(record) === 3).length, determinism, 'records with three requests', { denominator: runs.length });
	recount('limits.h6.runsWithAnEdit', runs.filter(record => { const list = field(record, 'edits'); return Array.isArray(list) && list.length > 0; }).length, determinism, 'records with a non-empty `edits` list', { denominator: runs.length });
	const eviction = `${RESULTS}/2026-11-22-eviction-agentic/traces/records.jsonl`;
	const prompts = readJsonLines(eviction).flatMap(record => { const list = field(record, 'requests'); return Array.isArray(list) ? list.map(request => Number(field(request, 'promptTokens') ?? 0)) : []; });
	recount('limits.h9.largestAgenticPrompt', Math.max(...prompts), eviction, 'the largest `promptTokens` of any request', { unit: 'tokens' });
}

/**
 * The three campaigns of Amendment 5, reported beside H-2, H-6 and H-9 (which keep their outcomes). Every
 * number is read from the output of the analysis that decided it.
 */
function buildAmendment5(): void {
	const protocol = '2026-11-26-protocol/protocol.json';
	const models = [['small', 0], ['large', 1]] as const; // sorted by identifier: qwen2.5-coder:1.5b, then qwen2.5-coder:7b
	const arms = [['envelope', 0], ['repaired', 1], ['editFirst', 2]] as const;
	for (const [size, model] of models) {
		for (const [arm, index] of arms) {
			from(`a5.protocol.${size}.${arm}.editOnRecord`, protocol, ['perModel', model, 'arms', index, 'editOnRecord', 'count'], { analysis: 'protocol', denominator: 40 });
			from(`a5.protocol.${size}.${arm}.editCalls`, protocol, ['perModel', model, 'arms', index, 'editCall', 'count'], { analysis: 'protocol', denominator: 40 });
			from(`a5.protocol.${size}.${arm}.succeeded`, protocol, ['perModel', model, 'arms', index, 'success', 'count'], { analysis: 'protocol', denominator: 40 });
			from(`a5.protocol.${size}.${arm}.meanRequests`, protocol, ['perModel', model, 'arms', index, 'meanRequests'], { analysis: 'protocol', digits: 2 });
		}
		for (const [pair, index] of [['repairedLessEnvelope', 0], ['editFirstLessEnvelope', 1], ['editFirstLessRepaired', 2]] as const) {
			from(`a5.protocol.${size}.${pair}`, protocol, ['perModel', model, 'pairs', index, 'editOnRecordDifference'], { analysis: 'protocol', interval: true, digits: 3 });
		}
	}
	from('a5.protocol.records', protocol, ['records'], { analysis: 'protocol' });
	const editing = '2026-11-26-determinism-edits/outcome-H-6-editing.json';
	from('a5.determinism.editingUnits', editing, ['editingUnits', 'units'], { analysis: 'determinism-edits' });
	from('a5.determinism.editingComparisons', editing, ['editingUnits', 'comparisons'], { analysis: 'determinism-edits' });
	from('a5.determinism.editingIdentical', editing, ['editingUnits', 'identical'], { analysis: 'determinism-edits' });
	from('a5.determinism.editingShare', editing, ['editingShare'], { analysis: 'determinism-edits', interval: true, scale: 100, digits: 1, unit: 'percent' });
	from('a5.determinism.allComparisons', editing, ['allComparisons', 'comparisons'], { analysis: 'determinism-edits' });
	from('a5.determinism.allIdentical', editing, ['allComparisons', 'identical'], { analysis: 'determinism-edits' });
	const forced = '2026-11-26-eviction-forced/forced-eviction.json';
	for (const [policy, index] of [['oldest', 0], ['block', 1], ['placeholder', 2]] as const) {
		from(`a5.eviction.${policy}.runs`, forced, ['policies', index, 'runs'], { analysis: 'forced-eviction' });
		from(`a5.eviction.${policy}.evicted`, forced, ['policies', index, 'runsThatEvicted'], { analysis: 'forced-eviction' });
		from(`a5.eviction.${policy}.succeeded`, forced, ['policies', index, 'succeeded'], { analysis: 'forced-eviction' });
		from(`a5.eviction.${policy}.editOnRecord`, forced, ['policies', index, 'editOnRecord'], { analysis: 'forced-eviction' });
	}
	for (const [policy, index] of [['block', 0], ['placeholder', 1]] as const) {
		from(`a5.eviction.${policy}.pairedUnits`, forced, ['conditions', index, 'pairedUnits'], { analysis: 'forced-eviction' });
	}
	registered('a5.eviction.contextTokens', 3584, 'a context of 3,584 tokens', 'tokens');
}

try {
	if (!skipAnalyses) {
		runAnalyses(temporary);
	}
	buildRegistered();
	buildInvariants();
	buildMethods();
	const counts = buildCampaigns();
	const rows = [buildH1(), buildH2(), ...buildEdits(), buildH6(), buildH7(), buildH8(), buildH9(), buildH10()];
	buildHypotheses(rows);
	buildInjection();
	buildTaskSet();
	buildTotals(counts);
	buildLimits();
	buildAmendment5();
	buildData();

	const numbersText = serialize({
		generatedBy: SELF,
		what: 'Every number docs/research/REPORT.md and the README\'s Research section may quote. `source` is repository-relative; `path` is the place in it, or how it was counted; `derivation` is explained at the head of test/onyx/lab/make-report.mts.',
		analyses: ANALYSES.map(analysis => ({ name: analysis.name, command: analysis.display, run: analysis.slow ? `only by \`${SELF} --slow\`` : 'on every run without --skip-analyses', outputsComparedByteForByte: analysis.outputs.map(([, committed]) => `${RESULTS}/${committed}`) })),
		notCheckedAsNumbers: ALLOWLIST.map(allowed => allowed.what).concat(['a number that begins a heading', 'integers of one digit', 'anything in a code span, a code block or a link target']),
		numbers: numbers.map(entry => ({ ...entry })) as Json,
	});

	const known = numbers.flatMap(entry => [entry.value, ...(entry.denominator === undefined ? [] : [entry.denominator]), ...(entry.interval ?? [])]);
	if (!fs.existsSync(reportPath)) {
		problems.push(`${reportPath} does not exist`);
	} else {
		const report = fs.readFileSync(reportPath, 'utf8');
		const filled = fillBlocks(report);
		if (check) {
			if (filled !== report) {
				const before = report.split('\n');
				const line = filled.split('\n').findIndex((text, index) => text !== before[index]);
				problems.push(`${path.basename(reportPath)}: a generated table is not what the committed data gives (first difference at line ${line + 1}); run ${SELF}`);
			}
		} else if (filled !== report) {
			fs.writeFileSync(reportPath, filled);
		}
		problems.push(...unsourced(path.basename(reportPath), filled.split('\n'), 1, known));
	}
	if (fs.existsSync(readmePath)) {
		const lines = fs.readFileSync(readmePath, 'utf8').split('\n');
		const start = lines.findIndex(line => /^## Research\b/.test(line));
		if (start !== -1) {
			const length = lines.slice(start + 1).findIndex(line => /^## /.test(line));
			problems.push(...unsourced(path.basename(readmePath), lines.slice(start, length === -1 ? undefined : start + 1 + length), start + 1, known));
		}
	}

	const outputs: [string, string][] = [[numbersPath, numbersText], ...[...dataFiles].map(([name, text]): [string, string] => [path.join(repoRoot, DATA, name), text])];
	for (const [file, text] of outputs) {
		if (check) {
			if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== text) {
				problems.push(`${path.relative(repoRoot, file) || file} is not what the committed data gives; run ${SELF}`);
			}
		} else {
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(file, text);
		}
	}

	const ran = skipAnalyses ? 'no analysis run (--skip-analyses)' : `${ANALYSES.filter(analysis => slow || !analysis.slow).length} of ${ANALYSES.length} analyses run and compared with the committed outputs`;
	if (problems.length > 0) {
		for (const problem of problems) {
			console.error(problem);
		}
		console.error(`make-report: ${problems.length} problem${problems.length === 1 ? '' : 's'}; ${ran}`);
		exitCode = 1;
	} else {
		console.log(`make-report: ${check ? 'checked' : 'wrote'} ${numbers.length} numbers, ${blocks.size} tables and ${dataFiles.size} indexes; ${ran}`);
	}
} finally {
	fs.rmSync(temporary, { recursive: true, force: true });
}
process.exit(exitCode);
