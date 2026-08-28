/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The instruction is fixed and boring on purpose: a commit message the user
 * has to re-edit every time is worse than none, so the model gets one shape to
 * produce and no room to improvise a preamble.
 */
export const ONYX_COMMIT_SYSTEM_PROMPT = [
	'You write git commit messages. Output only the commit message — no preamble, no code fences, no quotes.',
	'Line 1 is an imperative subject under 72 characters, capitalized, with no trailing period.',
	'If the change needs explanation, add one blank line and then a short body of at most three bullet points starting with "- ".',
	'Describe what changed and why. Never invent changes that are not in the diff.',
].join('\n');

/**
 * Compresses a diff to fit a prompt without losing its shape: every file
 * header survives, and the per-file bodies are trimmed evenly so one huge file
 * cannot crowd the rest out.
 */
export function buildCommitDiffDigest(diffText: string, files: readonly string[], maxChars: number): string {
	const header = files.length
		? `Files changed (${files.length}):\n${files.map(file => `- ${file}`).join('\n')}\n\n`
		: '';
	const budget = Math.max(0, maxChars - header.length);
	const sections = splitDiffByFile(diffText);
	if (sections.length === 0) {
		return header + elide(diffText, budget);
	}
	const perSection = Math.max(200, Math.floor(budget / sections.length));
	return header + sections.map(section => elide(section, perSection)).join('\n');
}

/** Splits a unified diff into one chunk per `diff --git` header. */
export function splitDiffByFile(diffText: string): string[] {
	const sections: string[] = [];
	let current: string[] = [];
	for (const line of diffText.split('\n')) {
		if (line.startsWith('diff --git ') && current.length) {
			sections.push(current.join('\n'));
			current = [];
		}
		current.push(line);
	}
	if (current.length && current.some(line => line.trim())) {
		sections.push(current.join('\n'));
	}
	return sections;
}

function elide(text: string, maxChars: number): string {
	if (text.length <= maxChars) {
		return text;
	}
	const marker = '\n… diff truncated …\n';
	const keep = Math.max(0, maxChars - marker.length);
	const head = Math.ceil(keep * 0.7);
	return text.slice(0, head) + marker + text.slice(text.length - (keep - head));
}

/**
 * Local models like to answer a question that was not asked. Strip the
 * scaffolding they add — fences, "Commit message:" labels, surrounding quotes —
 * and hold the subject to the 72-character convention.
 */
export function cleanCommitMessage(raw: string): string {
	let text = raw.trim();

	const fence = /^```[a-zA-Z]*\n([\s\S]*?)\n?```$/.exec(text);
	if (fence) {
		text = fence[1].trim();
	}
	text = text.replace(/^(commit\s*message|subject)\s*:\s*/i, '').trim();
	text = unquote(text);

	const lines = text.split('\n');
	// Models often quote only the subject and leave the body bare, so the
	// subject is unquoted again on its own rather than as part of the whole.
	let subject = unquote((lines[0] ?? '').trim()).replace(/\.$/, '');
	if (subject.length > 72) {
		const cut = subject.lastIndexOf(' ', 72);
		subject = subject.slice(0, cut > 30 ? cut : 72).trim();
	}

	const body = lines.slice(1).join('\n').trim();
	return body ? `${subject}\n\n${body}` : subject;
}

function unquote(text: string): string {
	if (text.length > 1 && ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith('\'') && text.endsWith('\'')))) {
		return text.slice(1, -1).trim();
	}
	return text;
}
