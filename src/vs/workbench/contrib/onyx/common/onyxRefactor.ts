/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The refactor engine's pure half. The division of labor is strict: the
 * editor's language services compute every edit (rename sites, extraction),
 * because they are correct; the local model only proposes and names, because
 * that is judgment. This module turns language-service workspace edits into
 * stageable file proposals and parses the model's naming suggestions — the
 * model is never allowed to invent an edit the language service can do.
 */

/** One text edit inside a file, 1-based positions, as language services emit. */
export interface IOnyxTextEdit {
	readonly startLineNumber: number;
	readonly startColumn: number;
	readonly endLineNumber: number;
	readonly endColumn: number;
	readonly text: string;
}

/**
 * Applies language-service edits to a file's content, producing the proposed
 * content for the review surface. Edits are applied back-to-front so earlier
 * offsets stay valid; overlapping edits are a provider bug and are rejected
 * rather than guessed at.
 */
export type OnyxApplyTextEditsResult =
	| { readonly kind: 'applied'; readonly content: string }
	| { readonly kind: 'error'; readonly error: string };

export function applyTextEdits(content: string, edits: readonly IOnyxTextEdit[]): OnyxApplyTextEditsResult {
	const lines = content.split('\n');
	const toOffset = (line: number, column: number): number => {
		let offset = 0;
		for (let i = 0; i < Math.min(line - 1, lines.length); i++) {
			offset += lines[i].length + 1;
		}
		return offset + column - 1;
	};
	const resolved = edits
		.map(edit => ({ start: toOffset(edit.startLineNumber, edit.startColumn), end: toOffset(edit.endLineNumber, edit.endColumn), text: edit.text }))
		.sort((a, b) => b.start - a.start || b.end - a.end);
	let previousStart = Infinity;
	let result = content;
	for (const edit of resolved) {
		if (edit.end > previousStart) {
			return { kind: 'error', error: 'the language service produced overlapping edits' };
		}
		if (edit.start > edit.end || edit.end > content.length) {
			return { kind: 'error', error: 'the language service produced an out-of-range edit' };
		}
		previousStart = edit.start;
		result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
	}
	return { kind: 'applied', content: result };
}

export interface IOnyxNameSuggestion {
	readonly name: string;
	readonly reason: string;
}

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * Parses the model's naming suggestions: `name — reason` lines (bullets,
 * numbering and backticks tolerated). Anything that is not a valid
 * identifier is dropped — a broken name must never reach the rename
 * provider. Deduplicated, capped, order preserved.
 */
export function parseNameSuggestions(reply: string, exclude: string, cap: number): IOnyxNameSuggestion[] {
	const suggestions: IOnyxNameSuggestion[] = [];
	const seen = new Set<string>([exclude]);
	for (const rawLine of reply.split('\n')) {
		const line = rawLine.replace(/^[\s\-*\d.)]+/, '').trim();
		if (!line) {
			continue;
		}
		// A plain hyphen only separates when spaced ("name - reason"); adjacent
		// it is part of an (invalid) kebab-case name and must fail the line.
		const match = line.match(/^`?(?<name>[A-Za-z_$][A-Za-z0-9_$]*)`?\s*(?:(?:[—:–]|\s-)\s*(?<reason>.+))?$/);
		if (!match?.groups) {
			continue;
		}
		const name = match.groups.name;
		if (!IDENTIFIER.test(name) || seen.has(name)) {
			continue;
		}
		seen.add(name);
		suggestions.push({ name, reason: match.groups.reason?.trim() ?? '' });
		if (suggestions.length >= cap) {
			break;
		}
	}
	return suggestions;
}

/** The one-shot prompt asking the model to NAME, not to edit. */
export function buildNameSuggestionPrompt(kind: 'rename' | 'extract', currentName: string, languageId: string, snippet: string): string {
	const intro = kind === 'rename'
		? `Suggest 3 better names for the ${languageId} symbol "${currentName}".`
		: `Suggest 3 names for a new ${languageId} function extracted from this code.`;
	return [
		intro,
		'Reply with one suggestion per line, in the form: name — short reason.',
		'Names must be valid identifiers in the language. No other text.',
		'',
		'Code:',
		snippet,
	].join('\n');
}

/**
 * Renames the placeholder identifier a code-action extraction produced (TS
 * uses `newFunction`/`newMethod`) inside proposed content, word-bounded.
 * Applied to staged text only — the buffer never sees the placeholder.
 */
export function renamePlaceholder(content: string, placeholder: string, newName: string): string {
	if (!IDENTIFIER.test(newName)) {
		return content;
	}
	return content.replace(new RegExp(`\\b${placeholder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g'), newName);
}
