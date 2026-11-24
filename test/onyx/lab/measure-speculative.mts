/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Speculative decoding on LM Studio, measured so that the result can be
 * believed:
 *
 *   node test/onyx/lab/measure-speculative.mts --base-url http://127.0.0.1:11502/v1 \
 *        --target qwen2.5-coder-7b-instruct --draft qwen2.5-coder-0.5b-instruct [--draft …] \
 *        --rounds 5 --out docs/research/results/<date>-speculative
 *
 * For the target alone and then for each draft, it reloads the target (with
 * the draft attached at load time, which is the only way LM Studio takes
 * one) and sends the same prompts through LM Studio's native endpoint,
 * whose `stats` say how fast the reply was. Whether the draft is attached
 * is read from LM Studio's REST model list, which gives the loaded
 * instance's configuration: a measurement that only compares speeds cannot
 * tell an attached draft that did nothing from one that was never attached.
 * LM Studio 0.4.23 does not report how many drafted tokens were accepted;
 * the fields are kept for a version that does.
 *
 * Prompts: a code task and a prose task, temperature 0, a fixed number of
 * tokens. With a draft the reply has to be the same text as without one:
 * speculative decoding verifies every token with the target, so at
 * temperature 0 a different reply means something other than speculation
 * changed the output. Each prompt runs `--rounds` times after a discarded
 * warm-up; the result keeps every round, the median and the spread. The
 * load average is recorded with each round.
 *
 * It loads and unloads models and nothing else; it changes no setting and
 * downloads nothing. It talks only to a server on this machine (DEC-10).
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function values(flag: string): string[] {
	const found: string[] = [];
	process.argv.forEach((argument, index) => {
		if (argument === flag && process.argv[index + 1]) {
			found.push(process.argv[index + 1]);
		}
	});
	return found;
}

const baseUrl = values('--base-url')[0];
const target = values('--target')[0];
const drafts = values('--draft');
const outDir = values('--out')[0];
const rounds = Number(values('--rounds')[0] ?? 5);
if (!baseUrl || !target || drafts.length === 0 || !outDir) {
	console.error('usage: node test/onyx/lab/measure-speculative.mts --base-url <http://127.0.0.1:port/v1> --target <key> --draft <key> [--draft <key>…] [--rounds 5] --out <results directory>');
	process.exit(2);
}
if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(new URL(baseUrl).hostname)) {
	console.error(`measure-speculative: ${new URL(baseUrl).hostname} is not this machine (DEC-10).`);
	process.exit(2);
}
const root = baseUrl.replace(/\/v1\/?$/, '');
const lms = [path.join(os.homedir(), '.lmstudio', 'bin', 'lms'), 'lms'].find(candidate => { try { execFileSync(candidate, ['version'], { stdio: 'ignore' }); return true; } catch { return false; } });
if (!lms) {
	console.error('measure-speculative: the `lms` command is not installed');
	process.exit(2);
}

const PROMPTS = {
	code: 'Write a TypeScript function that parses an ISO 8601 date string and returns the number of whole days between it and another such date. Explain each step in a comment.',
	prose: 'In about two hundred words, explain to a new programmer why version control matters, using one concrete example.',
} as const;
const MAX_TOKENS = 256;
const CONTEXT = 8192;

interface IStats {
	readonly tokens_per_second?: number;
	readonly time_to_first_token?: number;
	readonly generation_time?: number;
	readonly draft_model?: string;
	readonly total_draft_tokens_count?: number;
	readonly accepted_draft_tokens_count?: number;
	readonly rejected_draft_tokens_count?: number;
	readonly ignored_draft_tokens_count?: number;
}
interface IRound { readonly prompt: keyof typeof PROMPTS; readonly round: number; readonly tokensPerSecond: number | null; readonly firstTokenMs: number | null; readonly completionTokens: number | null; readonly stats: IStats; readonly textDigest: string; readonly load: number }

async function ask(prompt: string): Promise<{ text: string; stats: IStats; completionTokens: number | null }> {
	const response = await fetch(`${root}/api/v0/chat/completions`, {
		method: 'POST', headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ model: target, messages: [{ role: 'user', content: prompt }], temperature: 0, max_tokens: MAX_TOKENS, stream: false }),
	});
	if (!response.ok) {
		throw new Error(`${response.status}: ${(await response.text()).slice(0, 200)}`);
	}
	const body = await response.json() as { choices?: { message?: { content?: string } }[]; stats?: IStats; usage?: { completion_tokens?: number } };
	return { text: body.choices?.[0]?.message?.content ?? '', stats: body.stats ?? {}, completionTokens: body.usage?.completion_tokens ?? null };
}

async function digest(text: string): Promise<string> {
	const { createHash } = await import('node:crypto');
	return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

function load(draft: string | undefined): void {
	execFileSync(lms!, ['unload', '--all'], { stdio: 'ignore', timeout: 60_000 });
	execFileSync(lms!, ['load', target!, '--yes', '--context-length', String(CONTEXT), ...(draft ? ['--speculative-draft-simple', '--speculative-draft-model', draft] : [])], { stdio: 'ignore', timeout: 600_000 });
}

const median = (numbers: readonly number[]) => { const sorted = [...numbers].sort((a, b) => a - b); return sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : null; };
const round1 = (value: number | null) => value === null ? null : Math.round(value * 10) / 10;

interface IArm { readonly draft: string | null; readonly rounds: IRound[]; readonly attachedDraft?: string | null; readonly error?: string }

/** The draft LM Studio's REST list names for the loaded target: null when it says there is none. */
async function attachedDraft(): Promise<string | null | undefined> {
	const listed = await (await fetch(`${root}/api/v1/models`)).json() as { models?: { loaded_instances?: { id?: string; config?: { speculative_draft_simple?: boolean; speculative_draft_model?: string } }[] }[] };
	const instance = listed.models?.flatMap(model => model.loaded_instances ?? []).find(entry => entry.id === target);
	return instance ? (instance.config?.speculative_draft_simple === true && instance.config.speculative_draft_model ? instance.config.speculative_draft_model : null) : undefined;
}
const arms: IArm[] = [];
const startedAt = new Date();
const loadAtStart = os.loadavg()[0];
for (const draft of [undefined, ...drafts]) {
	const arm: IArm = { draft: draft ?? null, rounds: [] };
	arms.push(arm);
	try {
		load(draft);
		await new Promise(resolve => setTimeout(resolve, 3000));
		(arm as { attachedDraft?: string | null }).attachedDraft = await attachedDraft();
		for (const [name, prompt] of Object.entries(PROMPTS) as [keyof typeof PROMPTS, string][]) {
			await ask(prompt); // warm-up, discarded
			for (let round = 0; round < rounds; round++) {
				const reply = await ask(prompt);
				arm.rounds.push({ prompt: name, round, tokensPerSecond: reply.stats.tokens_per_second ?? null, firstTokenMs: reply.stats.time_to_first_token === undefined ? null : reply.stats.time_to_first_token * 1000, completionTokens: reply.completionTokens, stats: reply.stats, textDigest: await digest(reply.text), load: Math.round(os.loadavg()[0] * 100) / 100 });
			}
		}
	} catch (error) {
		(arm as { error?: string }).error = error instanceof Error ? error.message : String(error);
	}
	const describe = (name: keyof typeof PROMPTS) => {
		const own = arm.rounds.filter(entry => entry.prompt === name);
		const speeds = own.map(entry => entry.tokensPerSecond).filter((value): value is number => value !== null);
		const accepted = own.reduce((sum, entry) => sum + (entry.stats.accepted_draft_tokens_count ?? 0), 0);
		const drafted = own.reduce((sum, entry) => sum + (entry.stats.total_draft_tokens_count ?? 0), 0);
		return `${name}: median ${round1(median(speeds))} tok/s (${round1(Math.min(...speeds))} to ${round1(Math.max(...speeds))})${draft && drafted ? `, ${Math.round(accepted / drafted * 100)}% of ${drafted} drafted tokens accepted` : ''}`;
	};
	console.log(`${draft ? `with draft ${draft}` : 'without a draft'} (LM Studio says attached: ${arm.attachedDraft ?? 'none'}): ${arm.error ? `FAILED ${arm.error}` : `${describe('code')}; ${describe('prose')}`}`);
}
execFileSync(lms, ['unload', '--all'], { stdio: 'ignore', timeout: 60_000 });

const baseline = arms[0];
const summarize = (arm: IArm) => Object.fromEntries((Object.keys(PROMPTS) as (keyof typeof PROMPTS)[]).map(name => {
	const own = arm.rounds.filter(entry => entry.prompt === name);
	const speeds = own.map(entry => entry.tokensPerSecond).filter((value): value is number => value !== null);
	const base = baseline.rounds.filter(entry => entry.prompt === name);
	const baseSpeed = median(base.map(entry => entry.tokensPerSecond).filter((value): value is number => value !== null));
	const drafted = own.reduce((sum, entry) => sum + (entry.stats.total_draft_tokens_count ?? 0), 0);
	const accepted = own.reduce((sum, entry) => sum + (entry.stats.accepted_draft_tokens_count ?? 0), 0);
	return [name, {
		medianTokensPerSecond: round1(median(speeds)),
		rangeTokensPerSecond: speeds.length ? [round1(Math.min(...speeds)), round1(Math.max(...speeds))] : null,
		speedupOverNoDraft: arm === baseline || !baseSpeed || median(speeds) === null ? null : Math.round(median(speeds)! / baseSpeed * 100) / 100,
		draftAttached: arm === baseline ? arm.attachedDraft === null : arm.attachedDraft === arm.draft,
		draftedTokens: arm === baseline ? null : drafted,
		acceptanceRate: arm === baseline || !drafted ? null : Math.round(accepted / drafted * 1000) / 1000, // null on 0.4.23: not reported
		sameTextAsWithoutDraft: arm === baseline ? null : own.length > 0 && own.every(entry => base.some(other => other.textDigest === entry.textDigest)),
	}];
}));

fs.mkdirSync(path.join(outDir, 'traces'), { recursive: true });
const summary = {
	what: 'Speculative decoding on LM Studio: the target with no draft and with each draft attached at load time, through the native endpoint, whose stats prove the draft was attached and say how many of its tokens were accepted.',
	runtime: { name: 'lmstudio', version: (() => { try { return JSON.parse(fs.readFileSync(path.join(os.homedir(), '.lmstudio', '.internal', 'historical-version-info.json'), 'utf8')).lastRecordedAppVersion ?? null; } catch { return null; } })() },
	target, drafts, rounds, maxTokens: MAX_TOKENS, contextTokens: CONTEXT, temperature: 0,
	machine: { cpu: os.cpus()[0]?.model ?? 'unknown', memoryGiB: Math.round(os.totalmem() / 2 ** 30), cores: os.cpus().length, loadAverageAtStart: Math.round(loadAtStart * 100) / 100, loadAverageAtEnd: Math.round(os.loadavg()[0] * 100) / 100 },
	arms: arms.map(arm => ({ draft: arm.draft, attachedDraftAsLmStudioReports: arm.attachedDraft ?? null, ...(arm.error ? { error: arm.error } : {}), byPrompt: summarize(arm) })),
};
fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, undefined, '\t') + '\n');
fs.writeFileSync(path.join(outDir, 'traces', 'rounds.jsonl'), arms.flatMap(arm => arm.rounds.map(entry => JSON.stringify({ draft: arm.draft, ...entry }))).join('\n') + '\n');
console.log(`\nwrote ${outDir}/summary.json; started ${startedAt.toISOString()}`);
