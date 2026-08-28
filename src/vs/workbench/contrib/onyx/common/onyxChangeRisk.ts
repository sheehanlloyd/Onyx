/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Change-risk scoring: before edits are accepted, each changed file gets a
 * calm, one-line answer to "how careful should I be here?". The signals are
 * all local and historical — churn, coupling, fan-in, change size, test
 * proximity, whether error handling is touched — and the output is a small
 * badge with a reason, never a wall of red. Pure logic; collectors in the
 * browser layer gather the signals.
 */

export interface IOnyxChangeRiskSignals {
	readonly path: string;
	/** Added plus removed lines in this file's hunks. */
	readonly changedLines: number;
	/** Commits touching this file within the sampled window. */
	readonly churnCommits: number;
	/** Total commits in the sampled window (0 when history is unavailable). */
	readonly windowCommits: number;
	/** Files that historically change together with this one. */
	readonly coChangePartners: number;
	/** References to the file's primary symbol — call-graph fan-in — when measured. */
	readonly referenceCount: number | undefined;
	readonly hasNearbyTest: boolean;
	readonly touchesErrorHandling: boolean;
}

export type OnyxRiskLevel = 'low' | 'moderate' | 'elevated';

export interface IOnyxChangeRisk {
	readonly path: string;
	/** 0..1; the level is the user-facing value, the score orders files. */
	readonly score: number;
	readonly level: OnyxRiskLevel;
	/** One plain sentence naming the strongest factors. */
	readonly reason: string;
}

/** Signals readable from the diff text itself, one file's section at a time. */
export function extractDiffSignals(fileDiff: string): { path: string; changedLines: number; touchesErrorHandling: boolean } {
	const pathMatch = fileDiff.match(/^diff --git a\/(?<path>\S+)/m) ?? fileDiff.match(/^\+\+\+ b\/(?<path>\S+)/m);
	let changedLines = 0;
	let touchesErrorHandling = false;
	for (const line of fileDiff.split('\n')) {
		const isChange = (line.startsWith('+') && !line.startsWith('+++')) || (line.startsWith('-') && !line.startsWith('---'));
		if (!isChange) {
			continue;
		}
		changedLines++;
		if (/\b(catch|throw|raise|rescue|panic|errno|err(or)?s?)\b/i.test(line)) {
			touchesErrorHandling = true;
		}
	}
	return { path: pathMatch?.groups?.path ?? '', changedLines, touchesErrorHandling };
}

interface IFactor {
	readonly weight: number;
	readonly phrase: string;
}

/**
 * Scores one file. Weights express how strongly each signal predicts a
 * regression: history (churn, coupling) and blast radius (fan-in) matter more
 * than raw size, and missing tests amplify everything else rather than being
 * dangerous on their own.
 */
export function scoreChangeRisk(signals: IOnyxChangeRiskSignals): IOnyxChangeRisk {
	const factors: IFactor[] = [];

	const churnRatio = signals.windowCommits > 0 ? signals.churnCommits / signals.windowCommits : 0;
	if (churnRatio > 0.15) {
		factors.push({ weight: Math.min(0.3, churnRatio), phrase: 'changes often' });
	}
	if (signals.coChangePartners >= 3) {
		factors.push({ weight: Math.min(0.2, signals.coChangePartners * 0.04), phrase: 'usually changes with other files' });
	}
	if (signals.referenceCount !== undefined && signals.referenceCount >= 5) {
		factors.push({ weight: Math.min(0.25, Math.log10(signals.referenceCount) * 0.15), phrase: 'widely referenced' });
	}
	if (signals.changedLines >= 40) {
		factors.push({ weight: Math.min(0.25, Math.log10(signals.changedLines) * 0.1), phrase: 'a large change' });
	}
	if (signals.touchesErrorHandling) {
		factors.push({ weight: 0.15, phrase: 'touches error handling' });
	}
	if (!signals.hasNearbyTest && factors.length > 0) {
		// Missing tests only matter when something else is already risky.
		factors.push({ weight: 0.15, phrase: 'no nearby test' });
	}

	const score = Math.min(1, factors.reduce((total, factor) => total + factor.weight, 0));
	const level: OnyxRiskLevel = score >= 0.55 ? 'elevated' : score >= 0.3 ? 'moderate' : 'low';

	const strongest = [...factors].sort((a, b) => b.weight - a.weight).slice(0, 2).map(factor => factor.phrase);
	const reason = strongest.length === 0
		? 'small change in a quiet, tested file'
		: strongest.join(', ');

	return { path: signals.path, score, level, reason };
}
