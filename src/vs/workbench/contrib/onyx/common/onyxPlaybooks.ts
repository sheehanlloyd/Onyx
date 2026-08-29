/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Agent playbooks: checked-in prompt recipes at `.onyx/playbooks/*.md`. Each
 * file is markdown with a small frontmatter block naming the playbook, when
 * to use it, which tools it needs and an optional model hint; the body is
 * the recipe itself. Parsing is tolerant and reports problems instead of
 * throwing — a broken playbook degrades to "listed with its problems", never
 * to a broken agent.
 */

export interface IOnyxPlaybook {
	/** Machine name from frontmatter `name:`; also the invocation key. */
	readonly name: string;
	readonly description: string;
	/** One line telling the agent (and the user) when this recipe applies. */
	readonly whenToUse: string;
	/** Tool reference names the recipe expects; advisory, shown in the UI. */
	readonly tools: readonly string[];
	/** Optional model id or key the author suggests. */
	readonly modelHint: string | undefined;
	/** The recipe body, markdown after the frontmatter. */
	readonly body: string;
}

export interface IOnyxPlaybookParse {
	readonly playbook: IOnyxPlaybook | undefined;
	readonly problems: readonly string[];
}

/** Frontmatter keys the schema knows; anything else is reported. */
export const ONYX_PLAYBOOK_KEYS = ['name', 'description', 'when-to-use', 'tools', 'model'] as const;

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/;

/**
 * Parses one playbook file. The frontmatter dialect is deliberately tiny —
 * `key: value` lines with comma-separated lists — because these files are
 * written by hand and reviewed in PRs; every accepted construct must be
 * explainable in one sentence.
 */
export function parsePlaybook(source: string): IOnyxPlaybookParse {
	const problems: string[] = [];
	const lines = source.split('\n');
	if (lines[0]?.trim() !== '---') {
		return { playbook: undefined, problems: ['missing frontmatter: the file must start with `---`'] };
	}
	const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
	if (end < 0) {
		return { playbook: undefined, problems: ['unterminated frontmatter: no closing `---`'] };
	}

	const fields = new Map<string, string>();
	for (const line of lines.slice(1, end)) {
		if (!line.trim()) {
			continue;
		}
		const match = line.match(/^(?<key>[a-zA-Z-]+):\s*(?<value>.*)$/);
		if (!match?.groups) {
			problems.push(`unreadable frontmatter line: "${line.trim()}"`);
			continue;
		}
		const key = match.groups.key.toLowerCase();
		if (!(ONYX_PLAYBOOK_KEYS as readonly string[]).includes(key)) {
			problems.push(`unknown frontmatter key "${key}" (expected one of ${ONYX_PLAYBOOK_KEYS.join(', ')})`);
			continue;
		}
		if (fields.has(key)) {
			problems.push(`duplicate frontmatter key "${key}"`);
			continue;
		}
		fields.set(key, match.groups.value.trim());
	}

	const name = fields.get('name') ?? '';
	if (!NAME_PATTERN.test(name)) {
		problems.push('name: required, lowercase letters, digits and dashes (2–64 characters)');
	}
	const description = fields.get('description') ?? '';
	if (!description) {
		problems.push('description: required');
	}
	const whenToUse = fields.get('when-to-use') ?? '';
	const tools = (fields.get('tools') ?? '').split(',').map(tool => tool.trim()).filter(Boolean);
	const body = lines.slice(end + 1).join('\n').trim();
	if (!body) {
		problems.push('the recipe body after the frontmatter is empty');
	}

	if (!NAME_PATTERN.test(name) || !description || !body) {
		return { playbook: undefined, problems };
	}
	return {
		playbook: { name, description, whenToUse, tools, modelHint: fields.get('model') || undefined, body },
		problems,
	};
}

/**
 * The prompt sent when a playbook is invoked: the recipe, clearly framed as
 * repository-authored instructions, plus whatever the caller appended.
 */
export function renderPlaybookInvocation(playbook: IOnyxPlaybook, extraInstructions: string | undefined): string {
	const parts = [
		`Follow this repository playbook ("${playbook.name}"):`,
		'',
		playbook.body,
	];
	if (extraInstructions?.trim()) {
		parts.push('', `Additional instructions for this run: ${extraInstructions.trim()}`);
	}
	return parts.join('\n');
}

/** The one-line-per-playbook section the agent's prompt carries so it can discover recipes. */
export function renderPlaybookIndex(playbooks: readonly IOnyxPlaybook[]): string | undefined {
	if (playbooks.length === 0) {
		return undefined;
	}
	return [
		'This repository ships playbooks — named recipes you can run with the playbook tool:',
		...playbooks.map(playbook => `- ${playbook.name}: ${playbook.whenToUse || playbook.description}`),
	].join('\n');
}
