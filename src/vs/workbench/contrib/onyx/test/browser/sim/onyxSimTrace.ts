/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The simulation trace: every boundary event the rig observes, in order, with
 * virtual time. Traces are canonical (L1): identifiers that the product mints
 * (operation ids, run ids, tool-call ids) are replaced by first-appearance
 * ordinals, times are the virtual clock's, and the JSON encoding is stable, so
 * the same seed gives a byte-identical trace and a different seed does not.
 */

export type OnyxSimTraceEvent =
	| { readonly kind: 'request'; readonly turn: number; readonly model: string; readonly tools: readonly string[]; readonly messageCount: number; readonly roles: readonly string[]; readonly lastUserDigest: string; readonly promptChars: number; readonly temperature: number | undefined; readonly maxTokens: number | undefined }
	| { readonly kind: 'chunk'; readonly op: string; readonly delta: 'text' | 'toolCall' | 'usage' | 'done' | 'error'; readonly size: number; readonly finishReason?: string }
	| { readonly kind: 'toolDispatch'; readonly call: string; readonly tool: string; readonly argumentsDigest: string }
	| { readonly kind: 'toolResult'; readonly call: string; readonly tool: string; readonly ok: boolean; readonly resultDigest: string }
	| { readonly kind: 'commandDispatch'; readonly op: string; readonly command: string; readonly cwd: string }
	| { readonly kind: 'commandResult'; readonly op: string; readonly exitCode: number | undefined; readonly timedOut: boolean; readonly killed: boolean }
	| { readonly kind: 'dialog'; readonly message: string; readonly decision: string }
	| { readonly kind: 'userAction'; readonly action: string; readonly detail?: string }
	| { readonly kind: 'fault'; readonly fault: string; readonly detail?: string }
	| { readonly kind: 'stage'; readonly path: string; readonly hunks: number; readonly ok: boolean; readonly reason?: string }
	| { readonly kind: 'buffer'; readonly path: string; readonly digest: string; readonly cause: string }
	| { readonly kind: 'disk'; readonly path: string; readonly digest: string; readonly cause: string }
	| { readonly kind: 'status'; readonly run: string; readonly status: string }
	| { readonly kind: 'activity'; readonly run: string; readonly activity: string; readonly label: string; readonly ok?: boolean }
	| { readonly kind: 'complete'; readonly status: string; readonly turns: number }
	| { readonly kind: 'violation'; readonly invariant: string; readonly detail: string };

export interface OnyxSimTraceEntry {
	readonly t: number;
	readonly event: OnyxSimTraceEvent;
}

/** FNV-1a over UTF-16 code units, hex; enough to tell content apart in a trace. */
export function digest(text: string): string {
	let hash = 2166136261;
	for (let i = 0; i < text.length; i++) {
		hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
	}
	return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Collects events with the virtual clock and renders them canonically: ids
 * the product minted become `op#1`, `run#1`, `call#1` in order of first
 * appearance, and the output is one JSON line per event.
 */
export class OnyxSimTrace {

	private readonly _entries: OnyxSimTraceEntry[] = [];
	private readonly _ordinals = new Map<string, string>();
	private readonly _counters = new Map<string, number>();

	constructor(private readonly _now: () => number) { }

	get entries(): readonly OnyxSimTraceEntry[] {
		return this._entries;
	}

	/** The canonical name for a product-minted identifier, assigned on first sight. */
	canonical(kind: 'op' | 'run' | 'call', id: string): string {
		const key = `${kind}:${id}`;
		let name = this._ordinals.get(key);
		if (!name) {
			const next = (this._counters.get(kind) ?? 0) + 1;
			this._counters.set(kind, next);
			name = `${kind}#${next}`;
			this._ordinals.set(key, name);
		}
		return name;
	}

	record(event: OnyxSimTraceEvent): void {
		this._entries.push({ t: this._now(), event });
	}

	count(kind: OnyxSimTraceEvent['kind']): number {
		return this._entries.filter(entry => entry.event.kind === kind).length;
	}

	/** Stable text: one event per line, keys in declaration order, no whitespace variance. */
	render(): string {
		return this._entries.map(entry => JSON.stringify({ t: entry.t, ...entry.event })).join('\n') + '\n';
	}
}
