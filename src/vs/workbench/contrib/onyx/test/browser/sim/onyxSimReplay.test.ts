/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { IOnyxChatParams } from '../../../../../../platform/onyxRuntime/common/onyxRuntime.js';
import { OnyxDiagnosticsRedactor } from '../../../common/onyxDiagnostics.js';
import { generateEpisode, OnyxSimEpisode, OnyxSimModelTurn, OnyxSimPersonaKind, SIM_FILES, SIM_TARGET_FILE } from './onyxSimEpisode.js';
import { SIM_MUTANT_CLASSES } from './onyxSimMutants.js';
import { IOnyxRecordedTrace, recordTrace, replayTrace, runEpisode, runFromCutPoint, serializeTrace, updateExpected } from './onyxSimReplay.js';
import { SIM_SCENARIOS } from './onyxSimScenarios.js';

/**
 * R-48 (L8): trace conformance replay. The corpus is `test/onyx/traces/`:
 * one recorded run a file. Every one is replayed through the harness as it
 * is now, in the rig, and has to produce the events it recorded.
 *
 * When a replay fails, the change is a regression or it is intended. If it
 * is intended, record the new expected traces with the reason:
 *
 *   ONYX_TRACE_REASON="<one line: why the harness now behaves differently>" ONYX_TRACE_WRITE=1 ./scripts/test.sh --grep "OnyxTraceReplay"
 *
 * Traces of a real model are recorded against a runtime on this machine
 * (the rig and the model take turns: see the test):
 *
 *   ONYX_TRACE_REASON="…" ONYX_TRACE_RECORD_URL=http://127.0.0.1:11500/v1 ONYX_TRACE_RECORD_MODEL=qwen2.5-coder:7b ./scripts/test.sh --grep "OnyxTraceReplay record"
 */

interface INodeFs {
	readFileSync(path: string, encoding: 'utf8'): string;
	writeFileSync(path: string, text: string): void;
	readdirSync(path: string): string[];
	existsSync(path: string): boolean;
	mkdirSync(path: string, options: { recursive: boolean }): void;
}
interface INodeGlobals { readonly process?: { readonly env?: Record<string, string | undefined>; cwd(): string }; readonly require?: (id: string) => INodeFs }

// The renderer runs with node integration; browser-layer code cannot import fs, so it is looked up at run time.
const node: INodeGlobals = globalThis;
const env = (name: string): string | undefined => node.process?.env?.[name] || undefined;
const fs = (): INodeFs => {
	const found = node.require?.('fs');
	if (!found) {
		throw new Error('the trace corpus is read from disk, and this renderer has no fs');
	}
	return found;
};
const corpusDir = (): string => `${node.process?.cwd() ?? '.'}/test/onyx/traces`;

/** Every simulated persona, each with the first seeded episode that has it. */
const PERSONAS: readonly OnyxSimPersonaKind[] = ['well-behaved', 'malformed', 'truncating', 'looping', 'obedient', 'anchor-liar', 'flooder', 'squatter', 'staller', 'schema-violator'];

function personaEpisode(persona: OnyxSimPersonaKind): OnyxSimEpisode {
	for (let seed = 1; seed < 5000; seed++) {
		const episode = generateEpisode(seed);
		if (episode.persona === persona) {
			return episode;
		}
	}
	throw new Error(`no seeded episode has the persona ${persona}`);
}

/** What the mock half of the corpus has to hold: every persona, and every scripted workflow. */
function wantedMockTraces(): { readonly name: string; readonly covers: IOnyxRecordedTrace['covers']; readonly episode: OnyxSimEpisode }[] {
	return [
		...PERSONAS.map(persona => ({ name: `persona-${persona}`, covers: { persona }, episode: personaEpisode(persona) })),
		...SIM_SCENARIOS.map(scenario => ({ name: `workflow-${scenario.name}`, covers: { workflow: scenario.name, persona: scenario.persona }, episode: scenario })),
	];
}

function readCorpus(): IOnyxRecordedTrace[] {
	const directory = corpusDir();
	return fs().readdirSync(directory).filter(name => name.endsWith('.json')).sort().map(name => JSON.parse(fs().readFileSync(`${directory}/${name}`, 'utf8')) as IOnyxRecordedTrace);
}

/** A trace as it is committed: through the diagnostics redactor's scrub (B11), which leaves a clean one as it is. */
function writeTrace(trace: IOnyxRecordedTrace): void {
	const scrubbed = new OnyxDiagnosticsRedactor({ includeContent: true, secrets: [] }).scrub(serializeTrace(trace));
	fs().mkdirSync(corpusDir(), { recursive: true });
	fs().writeFileSync(`${corpusDir()}/${trace.name}.json`, scrubbed);
}

suite('OnyxTraceReplay', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('R-48: every trace of the committed corpus replays through the harness as it is now with the events it recorded; the corpus holds every persona and every scripted workflow, and each trace says why it is the expected one', async function () {
		this.timeout(600_000);
		const wanted = wantedMockTraces();
		const reason = env('ONYX_TRACE_REASON');
		if (env('ONYX_TRACE_WRITE')) {
			// Recording: each wanted trace is run and written. One that exists and still holds is left alone;
			// one whose events changed is replaced, and that needs the reason.
			const existing = new Map((fs().existsSync(corpusDir()) ? readCorpus() : []).map(trace => [trace.name, trace]));
			for (const entry of wanted) {
				const result = await runEpisode(entry.episode);
				const before = existing.get(entry.name);
				if (!before) {
					assert.ok(reason, 'ONYX_TRACE_REASON: a new trace needs one line saying why it is the expected one');
					writeTrace(recordTrace({ name: entry.name, source: 'mock', model: null, covers: entry.covers, reason }, result));
				} else if ((await replayTrace(before)).identical === false) {
					const updated = updateExpected({ ...before, episode: { ...entry.episode, name: entry.name }, covers: entry.covers }, result, reason ?? '');
					assert.ok(updated.ok, updated.ok ? '' : `${entry.name}: ${updated.error}`);
					writeTrace(updated.trace);
				}
			}
		}
		const corpus = readCorpus();
		const reports: string[] = [];
		for (const trace of corpus) {
			const outcome = await replayTrace(trace);
			if (!outcome.identical) {
				reports.push(outcome.report);
			}
		}
		assert.deepStrictEqual({
			divergences: reports,
			missing: wanted.map(entry => entry.name).filter(name => !corpus.some(trace => trace.name === name)),
			// A scripted workflow or a persona's episode that changed has to be recorded again: the trace is of the old one.
			scriptsThatMoved: wanted.filter(entry => { const trace = corpus.find(candidate => candidate.name === entry.name); return trace !== undefined && JSON.stringify(trace.episode) !== JSON.stringify({ ...entry.episode, name: entry.name }); }).map(entry => entry.name),
			personasCovered: PERSONAS.filter(persona => corpus.some(trace => trace.covers.persona === persona)).length,
			withoutAReason: corpus.filter(trace => trace.reason.trim() === '' || trace.reason.includes('\n')).map(trace => trace.name),
			fromARealModel: corpus.filter(trace => trace.source === 'model').every(trace => trace.model !== null && trace.model.digest.length > 0),
		}, { divergences: [], missing: [], scriptsThatMoved: [], personasCovered: PERSONAS.length, withoutAReason: [], fromARealModel: true });
		if (this.test) {
			this.test.title = `${this.test.title} — ${JSON.stringify({ traces: corpus.length, mock: corpus.filter(trace => trace.source === 'mock').length, model: corpus.filter(trace => trace.source === 'model').length })}`;
		}
	});

	test('R-48: a deliberate change of the harness\'s behaviour fails the replay with a report of the first divergence, and keeps failing until the expected trace is replaced together with a reason', async () => {
		const trace = readCorpus().find(candidate => candidate.name === 'workflow-e2e-edittest')!;
		// The change: a loop that reports a verification verdict when the run ends, as it did before C2.
		const changed = { classes: SIM_MUTANT_CLASSES['C2-verdict-before-acceptance'] };
		const outcome = await replayTrace(trace, changed);
		assert.ok(outcome.identical === false);
		const withoutReason = updateExpected(trace, outcome.result, '  ');
		const sameReason = updateExpected(trace, outcome.result, trace.reason);
		const withReason = updateExpected(trace, outcome.result, 'The run ends with a verification verdict again (a deliberate change, for this test).');
		assert.ok(withReason.ok);
		const report = outcome.report.split('\n');
		assert.deepStrictEqual({
			unchangedHarness: (await replayTrace(trace)).identical,
			firstLine: report[0].replace(/event \d+ of \d+/, 'event N of M'),
			namesBothSides: report.some(line => line.startsWith('  expected  ')) && report.some(line => line.startsWith('    actual  ')),
			showsTheTurn: report.some(line => /the first turn that differs is turn \d+:|the outcome differs:/.test(line)),
			lastLine: report[report.length - 1],
			withoutReason: withoutReason.ok ? 'accepted' : withoutReason.error,
			sameReason: sameReason.ok ? 'accepted' : sameReason.error,
			// With the new expected trace the changed harness passes, and the unchanged one is now what fails.
			afterTheUpdate: { changedHarness: (await replayTrace(withReason.trace, changed)).identical, unchangedHarness: (await replayTrace(withReason.trace)).identical, reason: withReason.trace.reason },
		}, {
			unchangedHarness: true,
			firstLine: 'trace workflow-e2e-edittest: the harness no longer does what this trace records. First divergence at event N of M.',
			namesBothSides: true,
			showsTheTurn: true,
			lastLine: '  Fix the regression, or, if the change is intended, record the new expected trace with one line saying why (test/onyx/README.md, "Trace conformance replay").',
			withoutReason: 'a new expected trace needs a reason: one line saying why the harness now behaves differently',
			sameReason: 'the reason is the one the trace already had: say why the behaviour changed this time',
			afterTheUpdate: { changedHarness: true, unchangedHarness: false, reason: 'The run ends with a verification verdict again (a deliberate change, for this test).' },
		});
	});

	test('R-48, cut-point mode: two harness configurations are served the same recorded responses up to a turn and then continue on their own; the result is labelled an executed counterfactual', async () => {
		const trace = readCorpus().find(candidate => candidate.name === 'workflow-e2e-readedittest')!;
		// After the recorded read, the model edits a line and stops. One arm is the default harness; the other
		// returns a tool result to the model cut to 200 characters.
		const continuation: OnyxSimModelTurn[] = [
			{ kind: 'toolCall', tool: 'editFile', arguments: { path: 'src/math.ts', search: '\treturn a * b;', replace: '\treturn b * a;' }, id: 'edit_after_cut' },
			{ kind: 'text', text: 'Staged one edit.' },
		];
		const base = await runFromCutPoint(trace, 1, continuation);
		const arm = await runFromCutPoint(trace, 1, continuation, { labHarness: { request: { manifest: '2026-11-21-cut', name: 'short-results', configuration: { toolResultChars: 200 } }, packaged: false } });
		const live = await runFromCutPoint(trace, 1, async () => ({ kind: 'text', text: 'Nothing more to do.' }));
		const promptOfTurn = (run: typeof base, turn: number) => run.result.requests[turn - 1]?.text.length;
		assert.deepStrictEqual({
			labels: [base.label, arm.label, live.label],
			prefixTurns: [base.prefixTurns, arm.prefixTurns, live.prefixTurns],
			continuation: [base.continuation, arm.continuation, live.continuation],
			// Both arms were served the recorded read first, and the same continuation after it.
			sameResponses: JSON.stringify(base.result.servedTurns) === JSON.stringify(arm.result.servedTurns) && JSON.stringify(base.result.servedTurns[0]) === JSON.stringify(trace.episode.turns[0]),
			// The first request is the same under both; the second differs by what the arm changes: how much of the read came back.
			firstRequestTheSame: promptOfTurn(base, 1) === promptOfTurn(arm, 1),
			secondRequestShorterUnderTheArm: (promptOfTurn(arm, 2) ?? 0) < (promptOfTurn(base, 2) ?? 0),
			liveServed: live.result.servedTurns.map(turn => turn.kind),
			statuses: [base.result.status, arm.result.status, live.result.status],
		}, {
			labels: ['executed counterfactual', 'executed counterfactual', 'executed counterfactual'],
			prefixTurns: [1, 1, 1],
			continuation: ['mock', 'mock', 'live'],
			sameResponses: true,
			firstRequestTheSame: true,
			secondRequestShorterUnderTheArm: true,
			liveServed: ['toolCall', 'text'],
			statuses: ['completed', 'completed', 'completed'],
		});
	});

	// --- recording from a real model -----------------------------------------

	/** One turn from a real model on this machine, in the shape the rig serves. */
	function liveModel(url: string, model: string): (params: IOnyxChatParams) => Promise<OnyxSimModelTurn> {
		return async params => {
			const response = await fetch(`${url}/chat/completions`, {
				method: 'POST', headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ model, messages: params.messages, tools: params.tools, temperature: 0, seed: 1, max_tokens: params.maxTokens ?? 1024, stream: false, ...(params.responseFormat !== undefined ? { response_format: params.responseFormat } : {}) }),
			});
			const body = await response.json() as { choices?: { message?: { content?: string | null; tool_calls?: { id?: string; function: { name: string; arguments: string } }[] } }[] };
			const message = body.choices?.[0]?.message;
			if (message?.tool_calls?.length) {
				return { kind: 'toolCalls', calls: message.tool_calls.map((call, index) => ({ tool: call.function.name, arguments: JSON.parse(call.function.arguments || '{}') as unknown, id: call.id ?? `call_${index + 1}` })) };
			}
			return { kind: 'text', text: message?.content ?? '' };
		};
	}

	const MODEL_WORKFLOWS: readonly { readonly workflow: string; readonly prompt: string }[] = [
		{ workflow: 'read-then-edit', prompt: 'Read src/math.ts with the readFile tool. Then use editFile to change addNumbers so that it returns b + a.' },
		{ workflow: 'answer-from-a-read', prompt: 'Read src/util.ts with the readFile tool and say in one sentence what clamp does.' },
	];

	test('record: traces of a real model on this machine (runs only when ONYX_TRACE_RECORD_URL and ONYX_TRACE_RECORD_MODEL are set)', async function () {
		const url = env('ONYX_TRACE_RECORD_URL');
		const model = env('ONYX_TRACE_RECORD_MODEL');
		if (!url || !model) {
			this.skip();
		}
		this.timeout(1_800_000);
		const reason = env('ONYX_TRACE_REASON');
		assert.ok(reason, 'ONYX_TRACE_REASON: a recorded trace needs one line saying why it is the expected one');
		assert.ok(/^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+\/v1$/.test(url), 'a trace is recorded from a runtime on this machine and from nowhere else (DEC-10)');
		const root = url.replace(/\/v1$/, '');
		const tags = await (await fetch(`${root}/api/tags`)).json() as { models?: { name: string; digest?: string }[] };
		const digest = tags.models?.find(entry => entry.name === model)?.digest;
		assert.ok(digest, `the runtime at ${root} has no model named ${model}`);
		const version = (await (await fetch(`${root}/api/version`)).json() as { version?: string }).version ?? 'unknown';
		const recorded: string[] = [];
		for (const { workflow, prompt } of MODEL_WORKFLOWS) {
			const name = `model-${model.replace(/[^a-z0-9.]+/gi, '-')}-${workflow}`;
			const episode: OnyxSimEpisode = { name, seed: 0, persona: 'well-behaved', prompt, files: SIM_FILES, target: SIM_TARGET_FILE, turns: [], dialogDefault: 'deny', userSteps: [], faults: [] };
			// The rig runs under virtual time and a model does not, so the two take turns. The episode is run
			// with the turns recorded so far; the first request past them is caught and the run is let end;
			// the model answers that request in real time; and the episode is run again with one turn more.
			// The rig is deterministic, so the request of a turn is the same every time round.
			const ask = liveModel(url, model);
			const turns: OnyxSimModelTurn[] = [];
			let result = undefined;
			for (let round = 0; round < 12 && !result; round++) {
				let pending: IOnyxChatParams | undefined;
				const attempt = await runEpisode({ ...episode, turns: [...turns] }, { liveTurn: async params => { pending ??= params; return { kind: 'text', text: '(recording)' }; } });
				if (pending) {
					turns.push(await ask(pending));
				} else {
					result = attempt;
				}
			}
			assert.ok(result, `${name}: the model was still calling tools after 12 turns`);
			const trace = recordTrace({ name, source: 'model', model: { identifier: `ollama:${model}`, digest, runtime: `ollama ${version}` }, covers: { workflow }, reason }, result);
			// What was recorded in real time has to replay under virtual time before it is worth keeping.
			const replayed = await replayTrace(trace);
			assert.ok(replayed.identical, replayed.identical ? '' : replayed.report);
			writeTrace(trace);
			recorded.push(`${name}: ${result.servedTurns.length} turns, ${result.status}`);
		}
		if (this.test) {
			this.test.title = `${this.test.title} — ${recorded.join('; ')}`;
		}
	});
});
