/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Trace schema v2 (L3). Pure and importable from plain Node: the benchmark,
 * the chart builder and the lab scripts read journals through this module.
 *
 * A run's journal is one JSON object per line. Version 1 journals hold only
 * `IOnyxRunEvent`s. Version 2 adds, as events of their own kind, one header
 * record per run (harness configuration hash, model identifier and digest,
 * runtime name and version, sampling parameters including the seed, the
 * tool list with schema hashes) and one record per model turn (request
 * digest, response text, how the stream ended, tool calls with argument and
 * result digests, approvals and acceptances). Readers accept both versions;
 * a v2 header that lacks a required field fails validation closed. A value
 * the writer does not know is written as `null`, never omitted: JSON drops
 * `undefined`, and an absent field is a schema violation, not an unknown.
 */

export const ONYX_TRACE_VERSION = 2;

export type OnyxStreamEnd = 'stop' | 'tool_calls' | 'length' | 'cancelled' | 'truncated' | 'stalled' | 'error' | 'unknown';

export interface IOnyxTraceTool {
	readonly name: string;
	readonly schemaHash: string;
}

export interface IOnyxTraceHeader {
	readonly kind: 'trace';
	readonly v: typeof ONYX_TRACE_VERSION;
	readonly runId: string;
	readonly startedAt: number;
	/**
	 * The harness configuration the run used and its hash (L4). `source` says
	 * whether it is the one derived for the model or a lab manifest's;
	 * `requested` names the manifest entry that was asked for, and `refused`
	 * says why it was not applied when it was not.
	 */
	readonly harness: { readonly configurationHash: string; readonly configuration: Readonly<Record<string, unknown>>; readonly source?: 'default' | 'lab'; readonly requested?: string; readonly refused?: string };
	readonly model: { readonly identifier: string; readonly digest: string | null };
	readonly runtime: { readonly name: string; readonly version: string | null; readonly baseUrl: string };
	readonly sampling: { readonly temperature: number | null; readonly seed: number | null; readonly maxTokens: number | null; readonly responseFormat: boolean };
	readonly tools: readonly IOnyxTraceTool[];
	/**
	 * The context the run was budgeted against and where the number came
	 * from (B15): what Onyx asked the runtime for, what the runtime reported
	 * and what a probe verified, each null when unknown or not applicable.
	 * No number in a trace is at an unknown context.
	 */
	readonly context: IOnyxTraceContext;
}

export interface IOnyxTraceContext {
	readonly budgetedTokens: number;
	readonly source: string;
	readonly requestedTokens: number | null;
	readonly reportedTokens: number | null;
	readonly verifiedTokens: number | null;
	readonly mechanism: string | null;
}

export interface IOnyxTraceToolCall {
	readonly name: string;
	readonly argumentsDigest: string;
	readonly resultDigest: string;
	readonly ok: boolean;
}

export interface IOnyxTraceTurn {
	readonly kind: 'traceTurn';
	readonly v: typeof ONYX_TRACE_VERSION;
	readonly turn: number;
	readonly requestDigest: string;
	readonly responseText: string;
	readonly streamEnd: OnyxStreamEnd;
	readonly toolCalls: readonly IOnyxTraceToolCall[];
	readonly seed: { readonly requested: number | null; readonly honoured: boolean | 'unknown' };
}

export interface IOnyxTraceApproval {
	readonly kind: 'approval';
	/** The exact command text the user was shown, or the subject of a non-terminal execution (`Task: …`). */
	readonly command: string;
	/** The working directory and timeout the approval covers; null for an execution that has neither. Absent in journals written before B2. */
	readonly cwd?: string | null;
	readonly timeoutMs?: number | null;
	readonly decision: string;
	/**
	 * Where the authority came from. Since B2 it is the dialog: every
	 * invocation asks. `workspace-allowlist` and `session` appear only in
	 * journals written before B2, when a repository allowlist or a session
	 * grant could run a command without one. `campaign-policy` is a denial,
	 * never an approval: a lab campaign denies every command without asking
	 * (L9, DEC-10).
	 */
	readonly source: 'dialog' | 'workspace-allowlist' | 'session' | 'campaign-policy';
}

export interface IOnyxTraceAcceptance {
	readonly kind: 'acceptance';
	readonly path: string;
	/** The id of the hunk as it was shown (B7), or `all` for a whole file. Journals written before B7 hold the hunk's index, a number. */
	readonly hunk: string | number;
}

/** FNV-1a over UTF-16 code units, hex. Stable across platforms; not a security digest. */
export function traceDigest(text: string): string {
	let hash = 2166136261;
	for (let i = 0; i < text.length; i++) {
		hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
	}
	return (hash >>> 0).toString(16).padStart(8, '0');
}

/** A digest of any JSON-serializable value, key order as given. */
export function digestValue(value: unknown): string {
	return traceDigest(JSON.stringify(value) ?? 'undefined');
}

/**
 * How a stream ended, for the trace. The runtime's own account of the ending
 * comes first (B12): a stream that was cut off or went silent is `truncated`
 * or `stalled` whatever else is known about it.
 */
export function classifyStreamEnd(finishReason: string | undefined, error: boolean, ending?: 'complete' | 'truncated' | 'stalled' | 'cancelled'): OnyxStreamEnd {
	if (error) {
		return 'error';
	}
	if (ending === 'truncated' || ending === 'stalled' || ending === 'cancelled') {
		return ending;
	}
	switch (finishReason) {
		case 'stop': return 'stop';
		case 'tool_calls': return 'tool_calls';
		case 'length': return 'length';
		case 'cancelled': return 'cancelled';
		case undefined: return ending === 'complete' ? 'unknown' : 'truncated';
		default: return 'unknown';
	}
}

export interface IOnyxParsedTrace {
	readonly version: 1 | 2;
	readonly header: IOnyxTraceHeader | undefined;
	readonly turns: readonly IOnyxTraceTurn[];
	readonly approvals: readonly IOnyxTraceApproval[];
	readonly acceptances: readonly IOnyxTraceAcceptance[];
	/** Every record, in file order, including the v1 run events. */
	readonly records: readonly Record<string, unknown>[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Parses a journal (one JSON object per line). Malformed lines are skipped, as the product's own reader does. */
export function parseTrace(text: string): IOnyxParsedTrace {
	const records: Record<string, unknown>[] = [];
	for (const line of text.split('\n')) {
		if (!line.trim()) {
			continue;
		}
		try {
			const parsed: unknown = JSON.parse(line);
			if (isRecord(parsed)) {
				records.push(parsed);
			}
		} catch {
			// a torn line; the reader is as forgiving as the product's
		}
	}
	const unwrap = (record: Record<string, unknown>): Record<string, unknown> => {
		// The journal wraps trace records as run events: { t, kind, data }. Accept both the wrapped and the bare form.
		const data = record.data;
		return isRecord(data) && typeof data.kind === 'string' && (data.kind === 'trace' || data.kind === 'traceTurn' || data.kind === 'approval' || data.kind === 'acceptance') ? data : record;
	};
	const unwrapped = records.map(unwrap);
	const header = unwrapped.find(record => record.kind === 'trace');
	return {
		version: header ? 2 : 1,
		header: header as IOnyxTraceHeader | undefined,
		turns: unwrapped.filter(record => record.kind === 'traceTurn') as unknown as IOnyxTraceTurn[],
		approvals: unwrapped.filter(record => record.kind === 'approval') as unknown as IOnyxTraceApproval[],
		acceptances: unwrapped.filter(record => record.kind === 'acceptance') as unknown as IOnyxTraceAcceptance[],
		records,
	};
}

const HEADER_REQUIRED: readonly string[] = ['runId', 'startedAt', 'harness', 'model', 'runtime', 'sampling', 'tools', 'context'];
const CONTEXT_REQUIRED: readonly string[] = ['budgetedTokens', 'source', 'requestedTokens', 'reportedTokens', 'verifiedTokens', 'mechanism'];
const TURN_REQUIRED: readonly string[] = ['turn', 'requestDigest', 'responseText', 'streamEnd', 'toolCalls', 'seed'];

/**
 * Validates a v2 trace and fails closed: a missing field, a wrong version
 * or a turn without its header is an error, never a warning. A v1 trace is
 * valid as v1 and reported as such.
 */
export function validateTrace(trace: IOnyxParsedTrace): { readonly ok: boolean; readonly version: 1 | 2; readonly errors: readonly string[] } {
	const errors: string[] = [];
	if (!trace.header) {
		if (trace.turns.length) {
			errors.push('turn records without a trace header');
		}
		return { ok: errors.length === 0, version: 1, errors };
	}
	const header = trace.header as unknown as Record<string, unknown>;
	if (header.v !== ONYX_TRACE_VERSION) {
		errors.push(`header version ${String(header.v)}, expected ${ONYX_TRACE_VERSION}`);
	}
	for (const field of HEADER_REQUIRED) {
		if (header[field] === undefined) {
			errors.push(`header lacks ${field}`);
		}
	}
	const harness = header.harness;
	if (isRecord(harness) && typeof harness.configurationHash !== 'string') {
		errors.push('header.harness lacks configurationHash');
	}
	const model = header.model;
	if (isRecord(model) && typeof model.identifier !== 'string') {
		errors.push('header.model lacks identifier');
	}
	const runtime = header.runtime;
	if (isRecord(runtime) && typeof runtime.name !== 'string') {
		errors.push('header.runtime lacks name');
	}
	const sampling = header.sampling;
	if (isRecord(sampling) && !Object.hasOwn(sampling, 'seed')) {
		errors.push('header.sampling lacks seed');
	}
	const context = header.context;
	if (isRecord(context)) {
		for (const field of CONTEXT_REQUIRED) {
			if (!Object.hasOwn(context, field)) {
				errors.push(`header.context lacks ${field}`);
			}
		}
	}
	if (Array.isArray(header.tools)) {
		for (const tool of header.tools) {
			if (!isRecord(tool) || typeof tool.name !== 'string' || typeof tool.schemaHash !== 'string') {
				errors.push('header.tools entry lacks name or schemaHash');
				break;
			}
		}
	}
	trace.turns.forEach((turn, index) => {
		const record = turn as unknown as Record<string, unknown>;
		for (const field of TURN_REQUIRED) {
			if (record[field] === undefined) {
				errors.push(`turn ${index + 1} lacks ${field}`);
			}
		}
		if (isRecord(record.seed) && !(Object.hasOwn(record.seed, 'requested') && Object.hasOwn(record.seed, 'honoured'))) {
			errors.push(`turn ${index + 1} seed lacks requested or honoured`);
		}
	});
	return { ok: errors.length === 0, version: 2, errors };
}
