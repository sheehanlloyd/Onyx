/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Extraction logic for the offline documentation mirror. Everything the docs
 * index stores or returns comes from documentation that already exists on the
 * machine — the workspace's markdown, package READMEs, and the JSDoc blocks
 * inside type declarations. Pure functions so the corpus rules are testable
 * without a filesystem.
 */

import { tokenize } from './onyxBm25.js';

export interface IOnyxJsDocSection {
	/** The doc comment, markers stripped. */
	readonly comment: string;
	/** The first following code line — the signature the comment documents. */
	readonly signature: string;
	/** 0-based line of the comment's first line in the source. */
	readonly line: number;
}

/**
 * Pulls `/** … *​/` blocks (plus the signature line each one documents) out of
 * a `.d.ts` file. Type declarations are mostly type noise; the doc comments
 * are the part worth indexing, and keeping the signature line makes the hit
 * usable without opening the file.
 */
export function extractJsDocSections(source: string, maxSections: number): IOnyxJsDocSection[] {
	const lines = source.split('\n');
	const sections: IOnyxJsDocSection[] = [];
	let commentStart = -1;
	let commentLines: string[] = [];
	for (let i = 0; i < lines.length && sections.length < maxSections; i++) {
		const trimmed = lines[i].trim();
		if (commentStart < 0) {
			if (trimmed.startsWith('/**') && !trimmed.startsWith('/***')) {
				commentStart = i;
				commentLines = [stripCommentDecoration(trimmed)];
				if (trimmed.includes('*/')) {
					// Single-line block: close immediately.
					sections.push({ comment: commentLines.join('\n').trim(), signature: nextCodeLine(lines, i + 1), line: commentStart });
					commentStart = -1;
				}
			}
			continue;
		}
		if (trimmed.includes('*/')) {
			commentLines.push(stripCommentDecoration(trimmed));
			const comment = commentLines.join('\n').trim();
			if (comment.length > 0) {
				sections.push({ comment, signature: nextCodeLine(lines, i + 1), line: commentStart });
			}
			commentStart = -1;
			commentLines = [];
		} else {
			commentLines.push(stripCommentDecoration(trimmed));
		}
	}
	return sections;
}

function stripCommentDecoration(line: string): string {
	return line.replace(/^\/\*\*+/, '').replace(/\*+\/\s*$/, '').replace(/^\*\s?/, '').trimEnd();
}

function nextCodeLine(lines: readonly string[], from: number): string {
	for (let i = from; i < Math.min(lines.length, from + 3); i++) {
		const trimmed = lines[i].trim();
		if (trimmed && !trimmed.startsWith('//') && !trimmed.startsWith('/*')) {
			return trimmed.slice(0, 200);
		}
	}
	return '';
}

/** Turns extracted sections into one indexable text, signature lines included. */
export function jsDocSectionsToIndexText(sections: readonly IOnyxJsDocSection[]): string {
	return sections.map(section => `${section.signature}\n${section.comment}`).join('\n\n');
}

export interface IOnyxDocSnippet {
	/** 1-based line the snippet starts at in the source file. */
	readonly startLine: number;
	readonly text: string;
}

/**
 * The best window of a document for a query: the run of lines with the most
 * query-term hits, expanded to the enclosing markdown section when the file
 * is markdown. Honest about position (the returned line number points into
 * the real file) and bounded in size.
 */
export function extractDocSnippet(content: string, query: string, maxLines: number): IOnyxDocSnippet {
	const lines = content.split('\n');
	const terms = new Set(tokenize(query));
	if (terms.size === 0 || lines.length <= maxLines) {
		return { startLine: 1, text: lines.slice(0, maxLines).join('\n') };
	}

	// Score each line, then slide a window and keep the densest one.
	const lineScores = lines.map(line => {
		const tokens = tokenize(line);
		let score = 0;
		for (const token of tokens) {
			if (terms.has(token)) {
				score++;
			}
		}
		return score;
	});
	let bestStart = 0;
	let bestScore = -1;
	let windowScore = 0;
	for (let i = 0; i < lines.length; i++) {
		windowScore += lineScores[i];
		if (i >= maxLines) {
			windowScore -= lineScores[i - maxLines];
		}
		const start = Math.max(0, i - maxLines + 1);
		if (windowScore > bestScore) {
			bestScore = windowScore;
			bestStart = start;
		}
	}

	// Markdown: snap the window start to the section's own heading. The search
	// starts at the first line that actually matched, and looks only a few
	// lines up — snapping to a distant, unrelated heading would misattribute
	// the snippet.
	let firstHit = bestStart;
	for (let i = bestStart; i < Math.min(lines.length, bestStart + maxLines); i++) {
		if (lineScores[i] > 0) {
			firstHit = i;
			break;
		}
	}
	for (let i = firstHit; i >= Math.max(0, firstHit - 4); i--) {
		if (/^#{1,6}\s/.test(lines[i])) {
			bestStart = i;
			break;
		}
	}
	return { startLine: bestStart + 1, text: lines.slice(bestStart, bestStart + maxLines).join('\n').trimEnd() };
}
