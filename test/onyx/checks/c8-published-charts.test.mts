/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * C8: every published chart has its raw report in the repository. Each
 * `docs/images/chart-*.svg` starts with the comment `make-charts.mts` writes,
 * the report it names is committed under `docs/benchmarks/<date>/` at the
 * commit the comment gives, that report carries its provenance block and its
 * attempts, the README shows no chart that is not one of these, and it links
 * a raw report.
 *
 *   node --test test/onyx/checks/c8-published-charts.test.mts
 */

import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const imagesDir = path.join(repoRoot, 'docs', 'images');
const benchmarksDir = path.join(repoRoot, 'docs', 'benchmarks');

interface IReport { provenance?: { commit?: string; machine?: object; runtimes?: unknown[]; models?: unknown[]; parameters?: object }; attempts?: unknown[]; skipped?: unknown[] }

test('C8: every chart names a committed report with its provenance, and the README shows only such charts and links a raw report', () => {
	const reports = fs.readdirSync(benchmarksDir, { withFileTypes: true })
		.filter(entry => entry.isDirectory() && fs.existsSync(path.join(benchmarksDir, entry.name, 'report.json')))
		.map(entry => ({ date: entry.name, report: JSON.parse(fs.readFileSync(path.join(benchmarksDir, entry.name, 'report.json'), 'utf8')) as IReport }));
	const charts = fs.readdirSync(imagesDir).filter(name => /^chart-.*\.svg$/.test(name)).sort();
	const problems: string[] = [];
	for (const chart of charts) {
		const firstLine = fs.readFileSync(path.join(imagesDir, chart), 'utf8').split('\n')[0];
		const stamp = /^<!-- provenance: manifest (?<manifest>\S+); models .*; reports (?<reports>.+) -->$/.exec(firstLine);
		if (!stamp?.groups) {
			problems.push(`${chart}: no provenance comment`);
			continue;
		}
		for (const named of stamp.groups.reports.split(', ')) {
			const commit = named.split('@')[1] ?? '';
			const found = reports.find(candidate => commit.length === 11 && candidate.report.provenance?.commit?.startsWith(commit));
			if (!found) {
				problems.push(`${chart}: its report ${named} is not under docs/benchmarks`);
				continue;
			}
			const { provenance, attempts, skipped } = found.report;
			if (!provenance?.machine || !Array.isArray(provenance.runtimes) || !Array.isArray(provenance.models) || !provenance.parameters || !Array.isArray(attempts) || !Array.isArray(skipped)) {
				problems.push(`${chart}: docs/benchmarks/${found.date}/report.json lacks part of its provenance`);
			}
			if (!fs.existsSync(path.join(benchmarksDir, found.date, 'manifest.json'))) {
				problems.push(`${chart}: docs/benchmarks/${found.date}/ has no manifest.json`);
			}
		}
	}
	const readme = fs.readFileSync(path.join(repoRoot, 'README.md'), 'utf8');
	const shown = [...readme.matchAll(/docs\/images\/(?<chart>chart-[a-z]+\.svg)/g)].map(match => match.groups!.chart);
	assert.deepStrictEqual({
		problems,
		chartsDrawn: charts.length > 0,
		shownButNotDrawn: shown.filter(chart => !charts.includes(chart)),
		readmeLinksARawReport: /docs\/benchmarks\/\d{4}-\d{2}-\d{2}\/report\.json/.test(readme),
	}, { problems: [], chartsDrawn: true, shownButNotDrawn: [], readmeLinksARawReport: true });
});
