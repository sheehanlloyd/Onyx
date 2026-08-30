/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Renders the benchmark numbers as SVG charts for the README.
 *
 *   node test/onyx/run-benchmarks.mts --json > /tmp/onyx-bench.json
 *   node test/onyx/make-charts.mts /tmp/onyx-bench.json
 *
 * The charts are plain SVG with no external fonts or scripts, and every color
 * is chosen to read on both GitHub themes — a chart nobody can see in dark
 * mode is worse than a table. Values come only from the benchmark JSON, so a
 * chart can never drift from the number it claims to show. Charts whose
 * numbers were not measured in that run (no local runtime, `--skip-models`)
 * are skipped rather than drawn from stale values.
 *
 * More than one report may be passed, and later files win on a name collision:
 *
 *   node test/onyx/make-charts.mts /tmp/speculative.json /tmp/main.json
 *
 * This exists because `--speculative` reloads models and is measured in its own
 * run, and because a run measuring one runtime in isolation produces steadier
 * speed numbers than one cycling six models through a contended machine.
 * Combining runs is legitimate; inventing numbers is not, and every value still
 * comes from a report some run actually produced. Which file each number came
 * from is printed, so the provenance stays visible rather than implied.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const outputDir = path.join(repoRoot, 'docs', 'images');

interface IResult { group: string; name: string; value: number; unit: string; detail?: string; model?: string }
interface IReport { results: IResult[]; skipped?: string[] }

const reportPaths = process.argv.slice(2).filter(argument => !argument.startsWith('--'));
if (!reportPaths.length) {
	reportPaths.push('/tmp/onyx-bench.json');
}

// Later files win, so a targeted run can supersede a general one.
const merged = new Map<string, IResult>();
/** Which report each row came from, so provenance can be printed rather than assumed. */
const provenance = new Map<string, string>();
const skippedAll: string[] = [];
for (const reportPath of reportPaths) {
	const parsed = JSON.parse(fs.readFileSync(reportPath, 'utf8')) as IReport;
	for (const result of parsed.results) {
		merged.set(result.name, result);
		provenance.set(result.name, path.basename(reportPath));
	}
	for (const reason of parsed.skipped ?? []) {
		if (!skippedAll.includes(reason)) {
			skippedAll.push(reason);
		}
	}
}
const report: IReport = { results: [...merged.values()], skipped: skippedAll };
const results: IResult[] = report.results;
const maybe = (name: string): IResult | undefined => results.find(result => result.name === name);
const find = (name: string): IResult => {
	const hit = maybe(name);
	if (!hit) {
		throw new Error(`benchmark result not found: ${name}`);
	}
	return hit;
};

/** Readable on white and on #0d1117 alike. */
const INK = '#8b949e';
const TITLE = '#57606a';
const ACCENT = '#7c5cff';
const ACCENT_SOFT = 'rgba(124, 92, 255, 0.18)';
const MUTED = '#8b949e';
const MUTED_SOFT = 'rgba(139, 148, 158, 0.22)';
const TEAL = '#1f9e91';
const TEAL_SOFT = 'rgba(31, 158, 145, 0.18)';
// Single quotes inside: these land in an SVG attribute delimited by double
// quotes, and a nested double quote would end the attribute early.
/* eslint-disable local/code-no-unexternalized-strings -- SVG font stacks, not UI text */
const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif";
const MONO = "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, monospace";
/* eslint-enable local/code-no-unexternalized-strings */

function escapeText(text: string): string {
	return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

interface IBar { label: string; value: number; caption: string; highlight?: boolean }

/** A horizontal bar chart — the only shape these comparisons need. */
function barChart(options: { title: string; subtitle: string; bars: IBar[]; max?: number; suffix: string; width?: number }): string {
	const width = options.width ?? 720;
	const rowHeight = 42;
	const top = 62;
	const labelWidth = 210;
	const chartWidth = width - labelWidth - 112;
	const max = options.max ?? (Math.max(...options.bars.map(bar => bar.value)) || 1);
	const height = top + options.bars.length * rowHeight + 16;

	const rows = options.bars.map((bar, index) => {
		const y = top + index * rowHeight;
		const barWidth = Math.max(2, (bar.value / max) * chartWidth);
		const fill = bar.highlight ? ACCENT : MUTED;
		const track = bar.highlight ? ACCENT_SOFT : MUTED_SOFT;
		return `  <g>
    <text x="0" y="${y + 15}" font-family="${FONT}" font-size="13" fill="${INK}">${escapeText(bar.label)}</text>
    <text x="0" y="${y + 31}" font-family="${FONT}" font-size="11" fill="${INK}" opacity="0.75">${escapeText(bar.caption)}</text>
    <rect x="${labelWidth}" y="${y + 4}" width="${chartWidth}" height="18" rx="4" fill="${track}"/>
    <rect x="${labelWidth}" y="${y + 4}" width="${barWidth}" height="18" rx="4" fill="${fill}"/>
    <text x="${labelWidth + chartWidth + 10}" y="${y + 18}" font-family="${MONO}" font-size="13" font-weight="600" fill="${fill}">${escapeText(formatValue(bar.value))}${escapeText(options.suffix)}</text>
  </g>`;
	}).join('\n');

	return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeText(options.title)}">
  <title>${escapeText(options.title)}</title>
  <text x="0" y="20" font-family="${FONT}" font-size="15" font-weight="600" fill="${TITLE}">${escapeText(options.title)}</text>
  <text x="0" y="40" font-family="${FONT}" font-size="12" fill="${INK}">${escapeText(options.subtitle)}</text>
${rows}
</svg>
`;
}

/** Trims to a character budget, because SVG has no text metrics to wrap by. */
function ellipsize(text: string, maxChars: number): string {
	return text.length <= maxChars ? text : `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function formatValue(value: number): string {
	if (value >= 10000) {
		return `${Math.round(value / 1000)}k`;
	}
	return String(Math.round(value * 10) / 10);
}

function write(name: string, svg: string) {
	const target = path.join(outputDir, name);
	fs.writeFileSync(target, svg);
	console.log(`wrote ${path.relative(repoRoot, target)} (${Math.round(svg.length / 1024)} KB)`);
}

fs.mkdirSync(outputDir, { recursive: true });

// 1. Retrieval: the claim that BM25 beats what an agent would otherwise do.
write('chart-retrieval.svg', barChart({
	title: 'Finding the right file from a plain-English question',
	subtitle: '10 questions about this repository, asking for the file that actually implements the answer',
	suffix: '%',
	max: 100,
	bars: [
		{ label: 'Onyx BM25 index', value: find('BM25 hit@5').value, caption: `correct file in the top 5 · ${find('median query latency').value} ms per query`, highlight: true },
		{ label: 'Substring search', value: find('substring search hit@5').value, caption: 'what an agent without an index falls back to' },
	],
}));

// 2. Parser resilience: the numbers behind "small models mangle edits".
write('chart-parsers.svg', barChart({
	title: 'Surviving what small local models actually emit',
	subtitle: 'Nine malformed edit shapes observed from qwen2.5-coder and llama3.2, plus 5,000 fuzzed inputs',
	suffix: '',
	max: 100,
	bars: [
		{ label: 'Malformed edits recovered', value: find('malformed edits recovered').value, caption: 'short markers, missing dividers, fences, truncation, CR line endings', highlight: true },
		{ label: 'Files corrupted by a marker', value: find('format markers written into a file').value, caption: 'a marker written into your file is the failure that matters' },
		{ label: 'Fuzz crashes', value: find('fuzz crashes').value, caption: `over ${formatValue(find('fuzz inputs parsed').value)} random inputs` },
	],
}));

// 3. Approval policy: caught vs false alarms.
write('chart-terminal.svg', barChart({
	title: 'The agent never runs a command you did not approve',
	subtitle: 'Classification over a labelled command set — the prompt has to be honest about what it is asking',
	suffix: '%',
	max: 100,
	bars: [
		{ label: 'Dangerous commands flagged', value: find('dangerous commands caught').value, caption: 'rm -rf, curl | sh, sudo, force-push, disk writes, publish', highlight: true },
		{ label: 'Everyday commands flagged', value: find('everyday commands wrongly flagged').value, caption: 'npm test, git status, build, lint — no false alarms' },
		{ label: 'Danger hidden in quotes flagged', value: find('quoted danger still warns (by design)').value, caption: 'deliberate: quoting must not be an escape hatch' },
	],
}));

// 4. Scale: what the analysis actually chews through.
const archFiles = find('files scanned').value;
const archMs = find('full scan time').value;
write('chart-scale.svg', barChart({
	title: 'Built for a repository you have never read',
	subtitle: 'Measured on this repository — a full VS Code fork — on an Apple silicon laptop',
	suffix: '',
	max: Math.max(archFiles, find('Onyx source lines').value),
	bars: [
		{ label: 'Files mapped', value: archFiles, caption: `whole workspace scanned in ${(archMs / 1000).toFixed(1)}s, ~${Math.round(archFiles / (archMs / 1000) / 1000)}k files/second`, highlight: true },
		{ label: 'Files indexed for retrieval', value: find('files indexed').value, caption: 'incremental BM25, persisted per workspace' },
		{ label: 'Lines of Onyx source', value: find('Onyx source lines').value, caption: `${find('Onyx source files').value} files, all additive to upstream` },
	],
}));

// 5. Verification surface.
write('chart-tests.svg', barChart({
	title: 'What is actually verified',
	subtitle: 'Every Onyx behavior claim is backed by a test that runs in CI',
	suffix: '',
	max: Math.max(find('Onyx unit tests').value, find('end-to-end checks').value) * 1.15,
	bars: [
		{ label: 'Unit tests', value: find('Onyx unit tests').value, caption: 'pure logic: parsers, policies, scoring, rebasing — including fuzzing', highlight: true },
		{ label: 'End-to-end checks', value: find('end-to-end checks').value, caption: 'a real workbench driven over CDP, asserted on the run journal' },
	],
}));

interface ISeriesBar { series: string; value: number; caption?: string }
interface IGroup { label: string; caption: string; bars: ISeriesBar[] }

/**
 * Two or three measurements per subject — the shape every real-model
 * comparison here needs. Series colors are the accent for the arm being
 * argued for and the muted grey for the baseline, so the point of the chart
 * survives a black-and-white printout.
 */
function groupedBarChart(options: { title: string; subtitle: string; groups: IGroup[]; series: readonly string[]; max: number; suffix: string; width?: number }): string {
	const width = options.width ?? 720;
	const barHeight = 16;
	const barGap = 5;
	const groupGap = 18;
	const top = 84;
	const labelWidth = 250;
	const chartWidth = width - labelWidth - 116;
	const groupHeight = options.series.length * (barHeight + barGap) + groupGap;
	const height = top + options.groups.length * groupHeight + 8;
	// A ramp, not a rainbow: grey is the baseline, teal the middle step, violet
	// the arm the chart is arguing for. Ordered so the story reads left to right.
	const ramp = [[MUTED, MUTED_SOFT], [TEAL, TEAL_SOFT], [ACCENT, ACCENT_SOFT]];
	const paletteFor = (series: string) => {
		const index = options.series.indexOf(series);
		return ramp[options.series.length <= 2 && index === options.series.length - 1 ? 2 : Math.min(index, ramp.length - 1)];
	};
	const colorFor = (series: string) => paletteFor(series)[0];
	const trackFor = (series: string) => paletteFor(series)[1];

	// Laid out left to right from the margin, spaced by an estimate of the
	// label's rendered width. Starting at the label column instead pushed the
	// last entry off the canvas — there is no text metric available here, so
	// the layout has to leave itself room.
	let legendX = 0;
	const legend = options.series.map(series => {
		const x = legendX;
		legendX += 26 + Math.ceil(series.length * 6.2);
		return `  <rect x="${x}" y="52" width="10" height="10" rx="2" fill="${colorFor(series)}"/>
  <text x="${x + 16}" y="61" font-family="${FONT}" font-size="11" fill="${INK}">${escapeText(series)}</text>`;
	}).join('\n');

	const rows = options.groups.map((group, groupIndex) => {
		const groupY = top + groupIndex * groupHeight;
		const bars = group.bars.map((bar, barIndex) => {
			const y = groupY + barIndex * (barHeight + barGap);
			const barWidth = Math.max(2, (bar.value / options.max) * chartWidth);
			return `    <rect x="${labelWidth}" y="${y}" width="${chartWidth}" height="${barHeight}" rx="3" fill="${trackFor(bar.series)}"/>
    <rect x="${labelWidth}" y="${y}" width="${barWidth}" height="${barHeight}" rx="3" fill="${colorFor(bar.series)}"/>
    <text x="${labelWidth + chartWidth + 10}" y="${y + 12}" font-family="${MONO}" font-size="12" font-weight="600" fill="${colorFor(bar.series)}">${escapeText(formatValue(bar.value))}${escapeText(options.suffix)}</text>`;
		}).join('\n');
		// The caption shares its line with the group's second bar, so it has to
		// stay inside the label column — an untruncated one runs under the bars.
		return `  <g>
    <text x="0" y="${groupY + 12}" font-family="${FONT}" font-size="13" fill="${INK}">${escapeText(group.label)}</text>
    <text x="0" y="${groupY + 28}" font-family="${FONT}" font-size="11" fill="${INK}" opacity="0.75">${escapeText(ellipsize(group.caption, Math.floor((labelWidth - 12) / 5.4)))}</text>
${bars}
  </g>`;
	}).join('\n');

	return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeText(options.title)}">
  <title>${escapeText(options.title)}</title>
  <text x="0" y="20" font-family="${FONT}" font-size="15" font-weight="600" fill="${TITLE}">${escapeText(options.title)}</text>
  <text x="0" y="40" font-family="${FONT}" font-size="12" fill="${INK}">${escapeText(options.subtitle)}</text>
${legend}
${rows}
</svg>
`;
}

/** Short enough to read as an axis label; the runtime stays in the caption. */
function shortModelName(model: string): string {
	return model.replace(' (LM Studio)', '');
}

// ------------------------------------------------- charts from real models
// Every chart below needs numbers that only exist when a local runtime was
// running during the benchmark. On a machine without one, they are skipped
// rather than drawn from stale or invented values.

const modelsOf = (group: string): string[] => [...new Set(results.filter(result => result.group === group && result.model).map(result => result.model!))];

// Fastest first: the chart is read as "what do my models do", and an ordering
// by discovery accident buries the answer.
const speedModels = modelsOf('throughput')
	.sort((a, b) => (maybe(`${b} — tok/s`)?.value ?? 0) - (maybe(`${a} — tok/s`)?.value ?? 0));
if (speedModels.length) {
	write('chart-speed.svg', barChart({
		title: 'What these models actually do on this Mac',
		subtitle: 'Generation speed measured on an M-series laptop, best of several warm rounds — no cloud, no queue',
		suffix: ' tok/s',
		max: Math.max(...speedModels.map(model => maybe(`${model} — tok/s`)?.value ?? 0)) * 1.1,
		bars: speedModels.map(model => {
			const warm = maybe(`${model} — TTFT warm`);
			const cold = maybe(`${model} — TTFT cold`);
			const caption = [
				warm ? `${Math.round(warm.value)} ms to first token warm` : undefined,
				cold ? `${(cold.value / 1000).toFixed(1)}s cold` : undefined,
			].filter(Boolean).join(' · ');
			return {
				label: shortModelName(model),
				value: maybe(`${model} — tok/s`)?.value ?? 0,
				caption,
				highlight: model === speedModels[0],
				// (speedModels[0] is the fastest — see the sort above)
			};
		}),
	}));
}

const toolModels = modelsOf('toolcalls').filter(model => maybe(`${model} — free-form valid`) && maybe(`${model} — constrained valid`));
if (toolModels.length) {
	const series = ['the model\u2019s own tool channel', '+ Onyx\u2019s repair of prose calls', '+ grammar-constrained envelope'];
	write('chart-toolcalls.svg', groupedBarChart({
		title: 'Small models can be made to call tools reliably',
		subtitle: 'Requests that need a tool: how often does one arrive that Onyx can actually execute?',
		series,
		suffix: '%',
		max: 100,
		width: 820,
		groups: toolModels.map(model => ({
			label: shortModelName(model),
			caption: maybe(`${model} — native tool channel`)?.detail ?? '',
			bars: [
				{ series: series[0], value: maybe(`${model} — native tool channel`)?.value ?? 0 },
				{ series: series[1], value: find(`${model} — free-form valid`).value },
				{ series: series[2], value: find(`${model} — constrained valid`).value },
			],
		})),
	}));
}

const benchModels = modelsOf('repobench')
	.sort((a, b) => (maybe(`${b} — overall`)?.value ?? 0) - (maybe(`${a} — overall`)?.value ?? 0));
if (benchModels.length) {
	const kinds = [...new Set(results.filter(result => result.group === 'repobench' && !result.name.endsWith('— overall')).map(result => result.name.split('— ')[1]))];
	write('chart-repobench.svg', groupedBarChart({
		title: 'Which local model is better at what — on your repository',
		subtitle: 'Real past commits replayed — F1 over changed lines against what the author actually wrote, where 1.0 is the author',
		series: kinds,
		suffix: '',
		max: 1,
		groups: benchModels.map(model => ({
			label: shortModelName(model),
			caption: maybe(`${model} — overall`)?.detail ?? '',
			bars: kinds.map(kind => ({ series: kind, value: maybe(`${model} — ${kind}`)?.value ?? 0 })),
		})),
	}));
}

const speculativeTarget = modelsOf('speculative')[0];
if (speculativeTarget) {
	const without = find(`${speculativeTarget} — tok/s without draft`);
	const withDraft = find(`${speculativeTarget} — tok/s with draft`);
	write('chart-speculative.svg', barChart({
		title: 'Speculative decoding, measured instead of assumed',
		subtitle: `${shortModelName(speculativeTarget)} generating the identical prompt, loaded plain and loaded with a draft model`,
		suffix: ' tok/s',
		max: Math.max(without.value, withDraft.value) * 1.15,
		bars: [
			{ label: 'No draft model', value: without.value, caption: 'the target on its own', highlight: without.value >= withDraft.value },
			{ label: 'With a draft model', value: withDraft.value, caption: withDraft.detail ?? '', highlight: withDraft.value > without.value },
		],
	}));
}

if (report.skipped?.length) {
	console.log(`\n${report.skipped.length} measurement${report.skipped.length === 1 ? ' was' : 's were'} skipped in this run; charts for them were not drawn.`);
}
if (reportPaths.length > 1) {
	const counts = new Map<string, number>();
	for (const source of provenance.values()) {
		counts.set(source, (counts.get(source) ?? 0) + 1);
	}
	console.log(`\nMerged ${reportPaths.length} reports (later wins): ${[...counts].map(([file, count]) => `${file} → ${count} rows`).join(', ')}`);
}
console.log('\nCharts regenerate from measured numbers only — never hand-edited.');
