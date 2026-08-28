/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** One thing a reviewer thinks is wrong with the change. */
export interface IOnyxReviewFinding {
	readonly file: string;
	readonly line: number;
	readonly severity: 'high' | 'medium' | 'low';
	readonly title: string;
	readonly detail: string;
}

/**
 * Adversarial on purpose: a reviewer that agrees with the diff is worth
 * nothing, and a local model asked to "review this" will otherwise summarize
 * it. The JSON contract also keeps the output parseable by a 7B model.
 */
export const ONYX_REVIEW_SYSTEM_PROMPT = [
	'You are a skeptical senior reviewer. You are given a unified diff of uncommitted changes.',
	'Look for defects the author would be embarrassed to ship: logic errors, unhandled failures, off-by-one and boundary bugs, resource or listener leaks, races, missed null/undefined cases, security and injection risks, and behavior changes the diff does not account for.',
	'Do not praise the change, do not summarize it, and do not report style preferences or naming opinions.',
	'Only report problems you can point at a specific line for. If the diff looks correct, return an empty list.',
	'Reply with JSON only, in exactly this shape:',
	'{"findings":[{"file":"path/from/repo/root.ts","line":123,"severity":"high|medium|low","title":"one line","detail":"why it is wrong and what would go wrong at runtime"}]}',
].join('\n');

/**
 * Parses whatever the model produced into findings. Small models wrap JSON in
 * prose or fences often enough that a strict `JSON.parse` of the whole reply
 * would throw away good reviews, so the first balanced object wins.
 */
export function parseReviewFindings(raw: string): IOnyxReviewFinding[] {
	const json = extractJsonObject(raw);
	if (!json) {
		return [];
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch {
		return [];
	}
	const list = (parsed as { findings?: unknown })?.findings;
	if (!Array.isArray(list)) {
		return [];
	}
	const findings: IOnyxReviewFinding[] = [];
	for (const entry of list) {
		const candidate = entry as Partial<IOnyxReviewFinding>;
		if (typeof candidate?.file !== 'string' || !candidate.file.trim() || typeof candidate.title !== 'string' || !candidate.title.trim()) {
			continue;
		}
		findings.push({
			file: candidate.file.trim().replace(/^[ab]\//, ''),
			line: Number.isFinite(candidate.line) ? Math.max(1, Math.floor(candidate.line as number)) : 1,
			severity: candidate.severity === 'high' || candidate.severity === 'low' ? candidate.severity : 'medium',
			title: candidate.title.trim(),
			detail: typeof candidate.detail === 'string' ? candidate.detail.trim() : '',
		});
	}
	findings.sort((a, b) => severityRank(a.severity) - severityRank(b.severity));
	return findings;
}

function severityRank(severity: IOnyxReviewFinding['severity']): number {
	return severity === 'high' ? 0 : severity === 'medium' ? 1 : 2;
}

/** Returns the first balanced `{…}` run in the text, ignoring braces inside strings. */
export function extractJsonObject(text: string): string | undefined {
	const start = text.indexOf('{');
	if (start < 0) {
		return undefined;
	}
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = start; i < text.length; i++) {
		const char = text[i];
		if (inString) {
			if (escaped) {
				escaped = false;
			} else if (char === '\\') {
				escaped = true;
			} else if (char === '"') {
				inString = false;
			}
			continue;
		}
		if (char === '"') {
			inString = true;
		} else if (char === '{') {
			depth++;
		} else if (char === '}') {
			depth--;
			if (depth === 0) {
				return text.slice(start, i + 1);
			}
		}
	}
	return undefined;
}
