/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Blends the three local retrieval signals — symbol matches (precise, name
 * driven), BM25 content hits (semantic-ish, token driven) and co-change
 * partners (historical coupling) — into one ranked file list. Each signal
 * covers the others' blind spot: symbols miss paraphrased queries, BM25
 * misses renamed concepts, history misses new code.
 */

export interface IOnyxBlendInputs {
	/** Files containing symbol matches, best first. */
	readonly symbolPaths: readonly string[];
	/** BM25 hits with raw scores. */
	readonly contentHits: readonly { readonly path: string; readonly score: number }[];
	/** Historical partners of the best symbol file, strongest first (0..1). */
	readonly coChangePartners: readonly { readonly path: string; readonly strength: number }[];
}

export interface IOnyxBlendedFile {
	readonly path: string;
	readonly score: number;
	readonly reasons: readonly string[];
}

export function blendRetrievalSignals(inputs: IOnyxBlendInputs, limit: number): IOnyxBlendedFile[] {
	const scores = new Map<string, { score: number; reasons: string[] }>();
	const add = (path: string, score: number, reason: string) => {
		let entry = scores.get(path);
		if (!entry) {
			entry = { score: 0, reasons: [] };
			scores.set(path, entry);
		}
		entry.score += score;
		if (!entry.reasons.includes(reason)) {
			entry.reasons.push(reason);
		}
	};

	inputs.symbolPaths.forEach((path, index) => {
		add(path, 3 * Math.pow(0.8, index), 'symbol match');
	});
	const topContent = inputs.contentHits[0]?.score ?? 0;
	for (const hit of inputs.contentHits) {
		// Normalized against the best hit: BM25 magnitudes vary wildly by query.
		add(hit.path, topContent > 0 ? 2 * (hit.score / topContent) : 0, 'content match');
	}
	for (const partner of inputs.coChangePartners) {
		add(partner.path, 1.2 * partner.strength, 'changes together');
	}

	return [...scores.entries()]
		.map(([path, { score, reasons }]) => ({ path, score, reasons }))
		.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
		.slice(0, limit);
}
