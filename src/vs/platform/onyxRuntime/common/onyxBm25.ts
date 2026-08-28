/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * An embedding-free lexical index: BM25 over code-aware tokens. Identifiers
 * are split on camelCase and snake_case so `buildCommitDiffDigest` answers
 * queries like "commit digest", which plain substring search cannot. This is
 * the whole retrieval story on a local-first machine: no embedding model to
 * download, no vector store to sync, and the index rebuilds from source in
 * seconds. Pure logic — the shared-process service owns files and watching.
 */

/** Words too common in code to carry signal. */
const STOP_WORDS = new Set([
	'the', 'a', 'an', 'and', 'or', 'not', 'in', 'of', 'to', 'for', 'is', 'it', 'this', 'that', 'with', 'as', 'on', 'be', 'are',
	'const', 'let', 'var', 'function', 'return', 'import', 'export', 'from', 'class', 'interface', 'type', 'new', 'if', 'else',
	'true', 'false', 'null', 'undefined', 'void', 'string', 'number', 'boolean', 'readonly', 'public', 'private', 'static',
	'async', 'await', 'promise', 'default', 'extends', 'implements', 'super', 'switch', 'case', 'break', 'continue', 'while',
]);

/** Cap distinct terms kept per document so one generated file cannot bloat the index. */
const MAX_TERMS_PER_DOC = 600;

/**
 * Splits source text into search terms: identifiers are broken at camelCase
 * and snake_case boundaries, everything is lowercased, and both the parts and
 * the whole identifier are kept so exact-name queries still rank highest.
 */
export function tokenize(text: string): string[] {
	const terms: string[] = [];
	for (const raw of text.split(/[^A-Za-z0-9_$]+/)) {
		if (raw.length < 2 || /^\d+$/.test(raw)) {
			continue;
		}
		const whole = raw.toLowerCase();
		const parts = raw.split(/(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])|_+/).map(part => part.toLowerCase()).filter(part => part.length >= 2 && !/^\d+$/.test(part));
		if (!STOP_WORDS.has(whole)) {
			terms.push(whole);
		}
		if (parts.length > 1) {
			for (const part of parts) {
				if (!STOP_WORDS.has(part)) {
					terms.push(part);
				}
			}
		}
	}
	return terms;
}

interface IDocEntry {
	/** term → term frequency in this document. */
	readonly termFrequencies: Map<string, number>;
	readonly length: number;
}

export interface IOnyxBm25Hit {
	readonly path: string;
	readonly score: number;
}

interface ISerializedIndex {
	readonly version: 1;
	readonly docs: Record<string, { tf: Record<string, number>; length: number }>;
}

const K1 = 1.2;
const B = 0.75;

/** An incremental BM25 index over documents keyed by workspace-relative path. */
export class OnyxBm25Index {

	private readonly _docs = new Map<string, IDocEntry>();
	/** term → number of documents containing it. */
	private readonly _documentFrequencies = new Map<string, number>();
	private _totalLength = 0;

	get documentCount(): number {
		return this._docs.size;
	}

	addDocument(path: string, text: string): void {
		this.removeDocument(path);
		const terms = tokenize(text);
		const termFrequencies = new Map<string, number>();
		for (const term of terms) {
			termFrequencies.set(term, (termFrequencies.get(term) ?? 0) + 1);
		}
		// Keep only the most frequent terms of oversized documents.
		let kept = termFrequencies;
		if (kept.size > MAX_TERMS_PER_DOC) {
			kept = new Map([...termFrequencies.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_TERMS_PER_DOC));
		}
		for (const term of kept.keys()) {
			this._documentFrequencies.set(term, (this._documentFrequencies.get(term) ?? 0) + 1);
		}
		this._docs.set(path, { termFrequencies: kept, length: terms.length });
		this._totalLength += terms.length;
	}

	removeDocument(path: string): void {
		const existing = this._docs.get(path);
		if (!existing) {
			return;
		}
		for (const term of existing.termFrequencies.keys()) {
			const df = this._documentFrequencies.get(term);
			if (df !== undefined) {
				if (df <= 1) {
					this._documentFrequencies.delete(term);
				} else {
					this._documentFrequencies.set(term, df - 1);
				}
			}
		}
		this._totalLength -= existing.length;
		this._docs.delete(path);
	}

	search(query: string, limit: number): IOnyxBm25Hit[] {
		const queryTerms = [...new Set(tokenize(query))];
		if (queryTerms.length === 0 || this._docs.size === 0) {
			return [];
		}
		const averageLength = this._totalLength / this._docs.size;
		const scores = new Map<string, number>();
		for (const term of queryTerms) {
			const df = this._documentFrequencies.get(term);
			if (!df) {
				continue;
			}
			const idf = Math.log(1 + (this._docs.size - df + 0.5) / (df + 0.5));
			for (const [path, doc] of this._docs) {
				const tf = doc.termFrequencies.get(term);
				if (!tf) {
					continue;
				}
				const norm = tf * (K1 + 1) / (tf + K1 * (1 - B + B * (doc.length / (averageLength || 1))));
				scores.set(path, (scores.get(path) ?? 0) + idf * norm);
			}
		}
		return [...scores.entries()]
			.map(([path, score]) => ({ path, score }))
			.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
			.slice(0, limit);
	}

	serialize(): string {
		const docs: ISerializedIndex['docs'] = {};
		for (const [path, doc] of this._docs) {
			docs[path] = { tf: Object.fromEntries(doc.termFrequencies), length: doc.length };
		}
		return JSON.stringify({ version: 1, docs } satisfies ISerializedIndex);
	}

	static deserialize(json: string): OnyxBm25Index | undefined {
		try {
			const parsed = JSON.parse(json) as ISerializedIndex;
			if (parsed.version !== 1 || typeof parsed.docs !== 'object') {
				return undefined;
			}
			const index = new OnyxBm25Index();
			for (const [path, doc] of Object.entries(parsed.docs)) {
				const termFrequencies = new Map(Object.entries(doc.tf));
				for (const term of termFrequencies.keys()) {
					index._documentFrequencies.set(term, (index._documentFrequencies.get(term) ?? 0) + 1);
				}
				index._docs.set(path, { termFrequencies, length: doc.length });
				index._totalLength += doc.length;
			}
			return index;
		} catch {
			return undefined;
		}
	}
}
