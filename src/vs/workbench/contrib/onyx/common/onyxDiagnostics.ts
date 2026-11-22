/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * What a diagnostics bundle may contain (B11, R-20, I-10).
 *
 * The bundle is built from an allowlist. For every record that goes into it,
 * this module names the fields that are kept and how each is written:
 * numbers and booleans as they are, a short list of identifier fields (a
 * tool name, a status, a model id) when they look like identifiers, URLs
 * without their credentials and query, and everything else as its length.
 * A field this module has not heard of is left out, and so is a journal
 * line that is not an event.
 *
 * The user can opt in to content: prompt text, tool parameters and results,
 * command text and output, paths, and log messages. Two things are removed
 * whatever the user chooses: the stored endpoint API keys, wherever their
 * values appear, and the credentials inside any URL.
 */

export interface IOnyxDiagnosticsOptions {
	/** The user opted in to prompt text, file contents, command text and log messages. */
	readonly includeContent: boolean;
	/** Values that must never appear, whatever the user opted into: the endpoint API keys. */
	readonly secrets: readonly string[];
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A name, not a sentence: letters, digits and the punctuation model ids, tool names and versions are made of. */
const IDENTIFIER = /^[\w.:/@+()-]{1,160}$/;
/** A display name: an identifier that may contain single spaces (`Apple M3 Max`, `LM Studio`). */
const DISPLAY_NAME = /^[\w.:/@+()-]+( [\w.:/@+()-]+){0,7}$/;

/** `scheme://user:password@host` → `scheme://host`. */
const URL_CREDENTIALS = /(?<scheme>\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@"'<>]+@/gi;
const BEARER = /\b(?<scheme>Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{4,}/g;
const SECRET_QUERY = /(?<name>[?&](?:api[_-]?key|access[_-]?token|token|key|secret|password|auth)=)[^&\s"'<>]+/gi;

/** `2026-11-20 10:00:00.000 [info] message`: what a workbench log line starts with. */
const LOG_LINE = /^(?<prefix>\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)? \[[a-z]+\] )(?<message>.*)$/i;

export class OnyxDiagnosticsRedactor {

	private readonly _secrets: readonly string[];

	constructor(protected readonly _options: IOnyxDiagnosticsOptions) {
		// Longest first, so a key that contains another is removed whole.
		this._secrets = [...new Set(_options.secrets.filter(secret => secret.length >= 4))].sort((a, b) => b.length - a.length);
	}

	/** Removes what no bundle may carry: API key values, URL credentials, bearer tokens. Applied to every string that leaves. */
	scrub(text: string): string {
		let scrubbed = text;
		for (const secret of this._secrets) {
			scrubbed = scrubbed.split(secret).join('[secret removed]');
		}
		return scrubbed
			.replace(URL_CREDENTIALS, '$<scheme>')
			.replace(BEARER, '$<scheme> [redacted]')
			.replace(SECRET_QUERY, '$<name>[redacted]');
	}

	/** Content: kept (scrubbed) when the user opted in, otherwise replaced by its length. */
	content(value: unknown): unknown {
		if (value === undefined || value === null) {
			return value;
		}
		const text = typeof value === 'string' ? value : JSON.stringify(value) ?? '';
		if (this._options.includeContent) {
			return typeof value === 'string' ? this.scrub(value) : this._scrubDeep(value);
		}
		return `[redacted ${text.length} chars]`;
	}

	/** A name. Kept when it looks like one; anything else is content. */
	identifier(value: unknown): unknown {
		if (typeof value === 'number' || typeof value === 'boolean' || value === null || value === undefined) {
			return value;
		}
		if (typeof value !== 'string') {
			return this.content(value);
		}
		return this._isName(value, IDENTIFIER) ? value : this.content(value);
	}

	/** Whether a string is a name and nothing else: the shape of one, and nothing in it that `scrub` would remove. */
	private _isName(value: unknown, shape: RegExp): value is string {
		return typeof value === 'string' && shape.test(value) && this.scrub(value) === value;
	}

	/** A URL without its credentials, query or fragment; not a URL, not exported. */
	url(value: unknown): unknown {
		if (typeof value !== 'string') {
			return value === null || value === undefined ? value : '[not a url]';
		}
		try {
			const parsed = new URL(value);
			return this.scrub(`${parsed.protocol}//${parsed.host}${parsed.pathname}`);
		} catch {
			return '[not a url]';
		}
	}

	// --- journal -----------------------------------------------------------

	/** One journal event as the bundle carries it, or undefined for anything that is not an event this module knows. */
	event(event: unknown): JsonObject | undefined {
		if (!isObject(event) || typeof event.kind !== 'string' || typeof event.t !== 'number') {
			return undefined;
		}
		const data = this._eventData(event.kind, event.data);
		return data === undefined ? undefined : { t: event.t, kind: event.kind, data };
	}

	/** A run's journal as JSON lines, and how many of its lines were left out. */
	journal(events: readonly unknown[]): { readonly text: string; readonly omitted: number } {
		const lines: string[] = [];
		let omitted = 0;
		for (const event of events) {
			const redacted = this.event(event);
			if (redacted) {
				lines.push(JSON.stringify(redacted));
			} else {
				omitted++;
			}
		}
		return { text: lines.join('\n'), omitted };
	}

	protected _eventData(kind: string, data: unknown): unknown {
		if (!isObject(data)) {
			return undefined;
		}
		switch (kind) {
			case 'promptSnapshot':
				return this._snapshot(data);
			case 'turn':
			case 'toolCall':
			case 'toolResult':
			case 'note':
			case 'firstToken':
				return {
					at: this._number(data.at),
					kind: this.identifier(data.kind),
					label: this.content(data.label),
					...(data.reason !== undefined ? { reason: this.content(data.reason) } : {}),
					...(data.ok !== undefined ? { ok: this._boolean(data.ok) } : {}),
					...(isObject(data.location) ? { location: { path: this.content(data.location.path), line: this._number(data.location.line) } } : {}),
				};
			case 'trace':
				return this._traceHeader(data);
			case 'traceTurn':
				return {
					kind: 'traceTurn',
					v: this._number(data.v),
					turn: this._number(data.turn),
					requestDigest: this.identifier(data.requestDigest),
					responseText: this.content(data.responseText),
					streamEnd: this.identifier(data.streamEnd),
					toolCalls: Array.isArray(data.toolCalls) ? data.toolCalls.filter(isObject).map(call => ({ name: this.identifier(call.name), argumentsDigest: this.identifier(call.argumentsDigest), resultDigest: this.identifier(call.resultDigest), ok: this._boolean(call.ok) })) : [],
					seed: isObject(data.seed) ? { requested: this._number(data.seed.requested), honoured: typeof data.seed.honoured === 'boolean' ? data.seed.honoured : this.identifier(data.seed.honoured) } : null,
				};
			case 'approval':
				return {
					kind: 'approval',
					command: this.content(data.command),
					cwd: this.content(data.cwd),
					timeoutMs: this._number(data.timeoutMs),
					decision: this.identifier(data.decision),
					source: this.identifier(data.source),
				};
			case 'acceptance':
				return { kind: 'acceptance', path: this.content(data.path), hunk: typeof data.hunk === 'number' ? data.hunk : this.identifier(data.hunk) };
			case 'editCertificate': {
				// Digests, counts and names (L6). The path is content, like any path here.
				const certificate = isObject(data.certificate) ? data.certificate : {};
				const base = isObject(certificate.base) ? certificate.base : {};
				const anchor = isObject(certificate.anchor) ? certificate.anchor : undefined;
				const provenance = isObject(certificate.provenance) ? certificate.provenance : undefined;
				return {
					kind: 'editCertificate',
					certificate: {
						v: this._number(certificate.v), path: this.content(certificate.path), protocol: this.identifier(certificate.protocol),
						turn: this._number(certificate.turn), call: this.identifier(certificate.call), block: this._number(certificate.block),
						base: { contentHash: this.identifier(base.contentHash), versionId: this._number(base.versionId) },
						anchor: anchor ? { digest: this.identifier(anchor.digest), lines: this._number(anchor.lines), matchCount: this._number(anchor.matchCount) } : null,
						grounding: this.identifier(certificate.grounding),
						provenance: provenance ? { segment: this._number(provenance.segment), source: this.identifier(provenance.source), ...(provenance.tool !== undefined ? { tool: this.identifier(provenance.tool) } : {}), holdsEveryLine: this._boolean(provenance.holdsEveryLine) } : null,
					},
					seal: this.identifier(data.seal),
					generation: this._number(data.generation),
					hunks: Array.isArray(data.hunks) ? data.hunks.map(hunk => this.identifier(hunk)) : [],
				};
			}
			case 'editCertificateOutcome':
				return { kind: 'editCertificateOutcome', path: this.content(data.path), generation: this._number(data.generation), appliedContentHash: this.identifier(data.appliedContentHash), verification: this.identifier(data.verification) };
			case 'outcome':
				return { status: this.identifier(data.status) };
			default:
				return undefined;
		}
	}

	private _snapshot(data: JsonObject): JsonObject {
		// A snapshot is either a prompt or the note of the commit a run started from.
		if (isObject(data.resumeMeta)) {
			return { resumeMeta: { head: this.identifier(data.resumeMeta.head) } };
		}
		const messages = Array.isArray(data.messages) ? data.messages.filter(isObject) : [];
		return {
			turn: this._number(data.turn),
			model: this.identifier(data.model),
			tools: Array.isArray(data.tools) ? data.tools.map(tool => this.identifier(tool)) : [],
			messages: messages.map(message => ({
				role: this.identifier(message.role),
				content: (Array.isArray(message.content) ? message.content.filter(isObject) : []).map(part => this._snapshotPart(part)),
			})),
		};
	}

	private _snapshotPart(part: JsonObject): JsonObject {
		const type = this.identifier(part.type);
		const name = part.name !== undefined ? { name: this.identifier(part.name) } : {};
		if (this._options.includeContent) {
			return {
				type, ...name,
				...(part.value !== undefined ? { value: this.content(part.value) } : {}),
				...(part.parameters !== undefined ? { parameters: this.content(part.parameters) } : {}),
				...(part.toolCallId !== undefined ? { toolCallId: this.identifier(part.toolCallId) } : {}),
			};
		}
		// What the part weighed, not what it said.
		const carried = part.value !== undefined ? part.value : part.parameters;
		const chars = carried === undefined ? 0 : (typeof carried === 'string' ? carried : JSON.stringify(carried) ?? '').length;
		return { type, ...name, chars };
	}

	private _traceHeader(data: JsonObject): JsonObject {
		const harness = isObject(data.harness) ? data.harness : {};
		const model = isObject(data.model) ? data.model : {};
		const runtime = isObject(data.runtime) ? data.runtime : {};
		const sampling = isObject(data.sampling) ? data.sampling : {};
		return {
			kind: 'trace',
			v: this._number(data.v),
			runId: this.identifier(data.runId),
			startedAt: this._number(data.startedAt),
			harness: {
				configurationHash: this.identifier(harness.configurationHash),
				configuration: this._switches(harness.configuration),
				source: this.identifier(harness.source),
				// Which manifest entry was asked for is a name; why it was refused repeats what the manifest said, which is content.
				...(harness.requested !== undefined ? { requested: this.identifier(harness.requested) } : {}),
				...(harness.refused !== undefined ? { refused: this.content(harness.refused) } : {}),
			},
			model: { identifier: this.identifier(model.identifier), digest: this.identifier(model.digest) },
			runtime: { name: this.identifier(runtime.name), version: this.identifier(runtime.version), baseUrl: this.url(runtime.baseUrl) },
			sampling: { temperature: this._number(sampling.temperature), seed: this._number(sampling.seed), maxTokens: this._number(sampling.maxTokens), responseFormat: this._boolean(sampling.responseFormat) },
			tools: Array.isArray(data.tools) ? data.tools.filter(isObject).map(tool => ({ name: this.identifier(tool.name), schemaHash: this.identifier(tool.schemaHash) })) : [],
			// Numbers and two names: how much context the run had and where the number came from (B15).
			...(isObject(data.context) ? { context: { budgetedTokens: this._number(data.context.budgetedTokens), source: this.identifier(data.context.source), requestedTokens: this._number(data.context.requestedTokens), reportedTokens: this._number(data.context.reportedTokens), verifiedTokens: this._number(data.context.verifiedTokens), mechanism: this.identifier(data.context.mechanism) } } : {}),
		};
	}

	/** A flat record of switches: numbers, booleans and identifiers. Nested values are left out. */
	private _switches(value: unknown): JsonObject {
		const out: JsonObject = {};
		if (isObject(value)) {
			for (const [key, entry] of Object.entries(value)) {
				if (IDENTIFIER.test(key) && (typeof entry === 'number' || typeof entry === 'boolean' || typeof entry === 'string' || entry === null)) {
					out[key] = this.identifier(entry);
				}
			}
		}
		return out;
	}

	// --- everything that is not a journal ----------------------------------

	/** A run's line in the journal index. The title is the user's request: content. */
	runSummary(summary: unknown): JsonObject | undefined {
		if (!isObject(summary)) {
			return undefined;
		}
		return {
			runId: this.identifier(summary.runId),
			startedAt: this._number(summary.startedAt),
			title: this.content(summary.title),
			task: this.identifier(summary.task),
			modelKey: this.identifier(summary.modelKey),
			status: this.identifier(summary.status),
			turnCount: this._number(summary.turnCount),
			toolCallCount: this._number(summary.toolCallCount),
		};
	}

	/**
	 * A record of measurements and capabilities (a model, a profile, a machine,
	 * a runtime): every number and boolean, the string fields named in
	 * {@link RECORD_STRING_FIELDS}, and nothing else. `apiKey` is not among
	 * them and never will be. The same in both modes: there is no content
	 * here to opt in to.
	 */
	record(value: unknown, depth = 0): unknown {
		if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
			return value;
		}
		if (depth > 8 || value === undefined || typeof value === 'string') {
			return undefined;
		}
		if (Array.isArray(value)) {
			return value.map(entry => this.record(entry, depth + 1)).filter(entry => entry !== undefined);
		}
		if (!isObject(value)) {
			return undefined;
		}
		const out: JsonObject = {};
		for (const [key, entry] of Object.entries(value)) {
			// A key is a field name or a model key (`host:port/model`); anything else is not exported.
			if (!this._isName(key, IDENTIFIER)) {
				continue;
			}
			if (typeof entry === 'string') {
				const kind = RECORD_STRING_FIELDS[key];
				if (kind === 'url') {
					out[key] = this.url(entry);
				} else if ((kind === 'name' && this._isName(entry, IDENTIFIER)) || (kind === 'display' && this._isName(entry, DISPLAY_NAME))) {
					out[key] = entry;
				}
			} else {
				const kept = this.record(entry, depth + 1);
				if (kept !== undefined) {
					out[key] = kept;
				}
			}
		}
		return out;
	}

	/** The `onyx.*` settings: booleans and numbers, the enumerated strings, and the endpoints without their keys. */
	settings(onyxSettings: unknown): JsonObject {
		const out: JsonObject = {};
		const omitted: string[] = [];
		const walk = (value: unknown, path: string): void => {
			if (path === 'onyx.endpoints') {
				out[path] = (Array.isArray(value) ? value.filter(isObject) : []).map(endpoint => ({
					baseUrl: this.url(endpoint.baseUrl),
					// Whether a key is still written in the settings file. Its value is never read here.
					apiKeyInSettings: typeof endpoint.apiKey === 'string' && endpoint.apiKey.length > 0,
					models: Array.isArray(endpoint.models) ? endpoint.models.filter(model => this._isName(model, IDENTIFIER)) : undefined,
					contextWindow: this._number(endpoint.contextWindow),
				}));
			} else if (typeof value === 'boolean' || typeof value === 'number') {
				out[path] = value;
			} else if (typeof value === 'string') {
				const allowed = SETTING_ENUMS[path];
				if (allowed?.includes(value)) {
					out[path] = value;
				} else {
					omitted.push(path);
				}
			} else if (isObject(value) && !SETTING_OPAQUE.has(path)) {
				for (const [key, entry] of Object.entries(value)) {
					if (IDENTIFIER.test(key)) {
						walk(entry, `${path}.${key}`);
					} else {
						omitted.push(`${path}.[key]`);
					}
				}
			} else if (value !== undefined && value !== null) {
				omitted.push(path);
			}
		};
		walk(onyxSettings, 'onyx');
		return { settings: out, setButNotExported: [...new Set(omitted)].sort() };
	}

	/**
	 * A log file. By default each line keeps its timestamp and level and gives
	 * the length of its message; the message itself is content.
	 */
	log(content: string): string {
		if (this._options.includeContent) {
			return this.scrub(content);
		}
		return content.split('\n').map(line => {
			if (!line) {
				return line;
			}
			const match = LOG_LINE.exec(line);
			return match?.groups ? `${match.groups.prefix}[redacted ${match.groups.message.length} chars]` : `[redacted ${line.length} chars]`;
		}).join('\n');
	}

	private _scrubDeep(value: unknown): unknown {
		if (typeof value === 'string') {
			return this.scrub(value);
		}
		if (Array.isArray(value)) {
			return value.map(entry => this._scrubDeep(entry));
		}
		if (isObject(value)) {
			return Object.fromEntries(Object.entries(value).map(([key, entry]) => [this.scrub(key), this._scrubDeep(entry)]));
		}
		return value;
	}

	private _number(value: unknown): number | null | undefined {
		return typeof value === 'number' ? value : value === null ? null : undefined;
	}

	private _boolean(value: unknown): boolean | undefined {
		return typeof value === 'boolean' ? value : undefined;
	}
}

/** The string fields of a measurement record that are exported, and how. Every other string field is left out. */
const RECORD_STRING_FIELDS: Readonly<Record<string, 'name' | 'display' | 'url'>> = {
	id: 'name', key: 'name', runtime: 'name', kind: 'name', family: 'name', quantization: 'name', digest: 'name',
	arch: 'name', platform: 'name', promptStyle: 'name', thermal: 'name', version: 'name', source: 'name',
	// Names the system or the runtime gives itself, which contain spaces: `Apple M3 Max`, `LM Studio`.
	displayName: 'display', cpuModel: 'display',
	baseUrl: 'url',
};

/** String settings whose values are one of a fixed list. A string setting not listed here is free text and is left out. */
const SETTING_ENUMS: Readonly<Record<string, readonly string[]>> = {
	'onyx.routing.mode': ['auto', 'manual'],
	'onyx.energy.policy': ['balanced', 'performance', 'efficiency'],
};

/** Object settings that are not walked: their keys are model names chosen by the user. */
const SETTING_OPAQUE: ReadonlySet<string> = new Set(['onyx.speculative.pairs']);

/** What the bundle's own README says, so that whoever receives one knows how it was made. */
export function describeBundle(options: { readonly includeContent: boolean; readonly journalLinesOmitted: number }): string {
	return [
		'Onyx diagnostics bundle',
		'',
		options.includeContent
			? 'Content: INCLUDED. The person who exported this bundle chose to include prompt text, tool parameters and results, command text and output, file paths and log messages.'
			: 'Content: not included. Prompt text, tool parameters and results, command text and output, file paths, run titles and log messages are replaced by their lengths.',
		'Never included, in either mode: endpoint API keys, the credentials and query of any URL, bearer tokens, settings whose value is free text, and journal lines that are not events this version knows.',
		`Journal lines left out because they could not be read as events: ${options.journalLinesOmitted}.`,
		'',
		'Kept as they are: numbers, booleans, timestamps, digests, and names (tool names, model ids, runtime names, statuses).',
		'This bundle was written to a file the user chose. Onyx uploaded nothing.',
		'',
	].join('\n');
}
