/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * R-48 (L8), the half that needs no workbench: what is committed under
 * `test/onyx/traces/` is fit to be committed. Every file is a trace of the
 * shape the replay reads; it passes through the product's diagnostics
 * redactor unchanged (B11), so nothing a scrub would remove is in it; it
 * names no home directory; a trace of a real model names the model by its
 * digest; and the CI workflow has the replay as a step of its own. The
 * replay itself is `./scripts/test.sh --grep "OnyxTraceReplay"`.
 *
 *   pnpm run transpile-client && node --test test/onyx/checks/r48-trace-corpus.test.mts
 */

import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const tracesDir = path.join(repoRoot, 'test', 'onyx', 'traces');

interface ITrace { version?: unknown; name?: unknown; source?: unknown; model?: { identifier?: unknown; digest?: unknown } | null; covers?: { persona?: unknown; workflow?: unknown }; reason?: unknown; episode?: { turns?: unknown; files?: unknown; prompt?: unknown }; expected?: unknown; journal?: unknown }

test('R-48: the committed trace corpus is well formed, passes the diagnostics redactor unchanged, names no home directory, and the workflow replays it as a step of its own', async () => {
	const { OnyxDiagnosticsRedactor } = await import(pathToFileURL(path.join(repoRoot, 'out', 'vs', 'workbench', 'contrib', 'onyx', 'common', 'onyxDiagnostics.js')).href) as { OnyxDiagnosticsRedactor: new (options: { includeContent: boolean; secrets: string[] }) => { scrub(text: string): string } };
	const redactor = new OnyxDiagnosticsRedactor({ includeContent: true, secrets: [] });
	const files = fs.readdirSync(tracesDir).filter(name => name.endsWith('.json')).sort();
	const problems: string[] = [];
	let fromAModel = 0;
	for (const file of files) {
		const text = fs.readFileSync(path.join(tracesDir, file), 'utf8');
		const trace = JSON.parse(text) as ITrace;
		const wellFormed = trace.version === 1 && trace.name === file.replace(/\.json$/, '') && (trace.source === 'mock' || trace.source === 'model')
			&& typeof trace.reason === 'string' && trace.reason.trim() !== '' && !trace.reason.includes('\n')
			&& Array.isArray(trace.episode?.turns) && typeof trace.episode?.prompt === 'string' && typeof trace.episode?.files === 'object'
			&& Array.isArray(trace.expected) && trace.expected.length > 0 && Array.isArray(trace.journal)
			&& (typeof trace.covers?.persona === 'string' || typeof trace.covers?.workflow === 'string');
		if (!wellFormed) {
			problems.push(`${file}: not a trace the replay can read`);
		}
		if (trace.source === 'model') {
			fromAModel++;
			if (typeof trace.model?.identifier !== 'string' || typeof trace.model?.digest !== 'string' || !/^[0-9a-f]{64}$/.test(trace.model.digest)) {
				problems.push(`${file}: a trace of a real model does not name the model by its digest`);
			}
		} else if (trace.model !== null) {
			problems.push(`${file}: a mock trace names a model`);
		}
		if (redactor.scrub(text) !== text) {
			problems.push(`${file}: the diagnostics redactor would change it`);
		}
		if (/\/Users\/|\/home\/[a-z]|[A-Z]:\\Users\\/.test(text)) {
			problems.push(`${file}: names a home directory`);
		}
	}
	const workflow = fs.readFileSync(path.join(repoRoot, '.github', 'workflows', 'onyx-ci.yml'), 'utf8');
	assert.deepStrictEqual({
		problems,
		hasTraces: files.length > 0,
		hasTracesOfARealModel: fromAModel > 0,
		replayIsAStepOfItsOwn: /- name: Trace conformance replay[^\n]*\n\s+run: \.\/scripts\/test\.sh --grep "?OnyxTraceReplay"?/.test(workflow),
	}, { problems: [], hasTraces: true, hasTracesOfARealModel: true, replayIsAStepOfItsOwn: true });
});
