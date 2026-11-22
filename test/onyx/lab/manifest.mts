/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The experiment manifest (L3): what every campaign, report and chart must
 * carry before a number from it is published. The schema in
 * `manifest.schema.json` is the single source of truth; this module checks a
 * document against it with the subset of JSON Schema the schema uses, so no
 * dependency is needed and the rule is implemented once for `make-charts.mts`,
 * the report builder (L19) and the campaign engine (L9).
 *
 *   node test/onyx/lab/manifest.mts <manifest.json>        validate one manifest
 *   node test/onyx/lab/manifest.mts --results <dir>        check a results directory
 *
 * A results directory `docs/research/results/<date>-<name>/` holds
 * `manifest.json`, `summary.json`, and either `traces/` (raw journals) or
 * `trace-digests.json`; `manifest.regenerate` names the command for each table.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const schemaPath = path.join(repoRoot, 'test', 'onyx', 'lab', 'manifest.schema.json');

type JsonSchema = {
	/** One type, or several when a value may be null. */
	readonly type?: string | readonly string[];
	readonly const?: unknown;
	readonly enum?: readonly unknown[];
	readonly required?: readonly string[];
	readonly properties?: Readonly<Record<string, JsonSchema>>;
	readonly additionalProperties?: boolean;
	readonly items?: JsonSchema;
	readonly minItems?: number;
	readonly minimum?: number;
	readonly minLength?: number;
	readonly pattern?: string;
};

/** The context a model ran with (B15): what was asked of the runtime, what it reported and what a probe verified. Null: not known or not applicable. */
export interface IManifestContext { readonly requestedTokens: number | null; readonly reportedTokens: number | null; readonly verifiedTokens: number | null; readonly mechanism: string | null }
export interface IManifestModel { readonly identifier: string; readonly digest: string; readonly runtime?: { readonly name: string; readonly version?: string }; readonly context: IManifestContext }
export interface IManifest {
	readonly version: 1;
	readonly name: string;
	readonly createdAt: string;
	readonly models: readonly IManifestModel[];
	readonly seeds: readonly number[];
	readonly sampling: { readonly temperature: number; readonly maxTokens?: number; readonly responseFormat?: boolean; readonly logprobs?: boolean };
	readonly harnessConfigurations: readonly { readonly name: string; readonly hash: string; readonly configuration?: Record<string, unknown> }[];
	readonly taskSet: { readonly name: string; readonly hash: string; readonly count?: number };
	readonly repetitions: number;
	readonly machine: { readonly platform: string; readonly arch: string; readonly cpu: string; readonly memoryGiB: number; readonly gpu?: string; readonly osVersion?: string; readonly nodeVersion?: string };
	readonly regenerate: readonly { readonly output: string; readonly command: string }[];
	readonly hypotheses?: readonly string[];
	readonly notes?: string;
}

export interface IValidation { readonly ok: boolean; readonly errors: readonly string[] }

function typeOf(value: unknown): string {
	if (value === null) {
		return 'null';
	}
	if (Array.isArray(value)) {
		return 'array';
	}
	return typeof value;
}

/** Checks `value` against the subset of JSON Schema that `manifest.schema.json` uses. */
function check(schema: JsonSchema, value: unknown, at: string, errors: string[]): void {
	if (schema.const !== undefined && value !== schema.const) {
		errors.push(`${at}: expected ${JSON.stringify(schema.const)}, got ${JSON.stringify(value)}`);
		return;
	}
	if (schema.enum && !schema.enum.includes(value)) {
		errors.push(`${at}: ${JSON.stringify(value)} is not one of ${schema.enum.map(entry => JSON.stringify(entry)).join(', ')}`);
		return;
	}
	if (schema.type) {
		const actual = typeOf(value);
		const allowed = typeof schema.type === 'string' ? [schema.type] : schema.type;
		const matches = allowed.some(type => type === 'integer' ? actual === 'number' && Number.isInteger(value) : actual === type);
		if (!matches) {
			errors.push(`${at}: expected ${allowed.join(' or ')}, got ${actual}`);
			return;
		}
	}
	if (typeof value === 'number') {
		if (schema.minimum !== undefined && value < schema.minimum) {
			errors.push(`${at}: ${value} is below the minimum ${schema.minimum}`);
		}
	}
	if (typeof value === 'string') {
		if (schema.minLength !== undefined && value.length < schema.minLength) {
			errors.push(`${at}: must not be empty`);
		}
		if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) {
			errors.push(`${at}: ${JSON.stringify(value)} does not match ${schema.pattern}`);
		}
	}
	if (Array.isArray(value)) {
		if (schema.minItems !== undefined && value.length < schema.minItems) {
			errors.push(`${at}: needs at least ${schema.minItems} ${schema.minItems === 1 ? 'entry' : 'entries'}`);
		}
		if (schema.items) {
			value.forEach((entry, index) => check(schema.items!, entry, `${at}[${index}]`, errors));
		}
	}
	if (typeOf(value) === 'object') {
		const record = value as Record<string, unknown>;
		for (const key of schema.required ?? []) {
			if (record[key] === undefined) {
				errors.push(`${at}: missing required field "${key}"`);
			}
		}
		for (const [key, entry] of Object.entries(record)) {
			const property = schema.properties?.[key];
			if (property) {
				check(property, entry, `${at}.${key}`, errors);
			} else if (schema.additionalProperties === false) {
				errors.push(`${at}: unknown field "${key}"`);
			}
		}
	}
}

export function loadSchema(): JsonSchema {
	return JSON.parse(fs.readFileSync(schemaPath, 'utf8')) as JsonSchema;
}

/** Validates a parsed manifest against the schema. Fails closed: any error is a refusal. */
export function validateManifest(value: unknown, schema: JsonSchema = loadSchema()): IValidation {
	const errors: string[] = [];
	check(schema, value, 'manifest', errors);
	return { ok: errors.length === 0, errors };
}

/** Reads and validates a manifest file; throws with every error listed when it is invalid. */
export function loadManifest(manifestPath: string): IManifest {
	let parsed: unknown;
	try {
		parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
	} catch (error) {
		throw new Error(`manifest ${manifestPath} is not readable JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
	const validation = validateManifest(parsed);
	if (!validation.ok) {
		throw new Error(`manifest ${manifestPath} is invalid:\n  ${validation.errors.join('\n  ')}`);
	}
	return parsed as IManifest;
}

/** Checks that a results directory carries everything L3 requires next to its manifest. */
export function checkResultsDirectory(directory: string): IValidation {
	const errors: string[] = [];
	const manifestPath = path.join(directory, 'manifest.json');
	if (!fs.existsSync(manifestPath)) {
		return { ok: false, errors: [`${directory}: no manifest.json`] };
	}
	let manifest: IManifest | undefined;
	try {
		manifest = loadManifest(manifestPath);
	} catch (error) {
		errors.push(error instanceof Error ? error.message : String(error));
	}
	if (manifest && path.basename(directory) !== manifest.name) {
		errors.push(`${directory}: directory name differs from manifest.name "${manifest.name}"`);
	}
	if (!fs.existsSync(path.join(directory, 'summary.json'))) {
		errors.push(`${directory}: no summary.json`);
	}
	if (!fs.existsSync(path.join(directory, 'traces')) && !fs.existsSync(path.join(directory, 'trace-digests.json'))) {
		errors.push(`${directory}: neither traces/ nor trace-digests.json`);
	}
	return { ok: errors.length === 0, errors };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const arguments_ = process.argv.slice(2);
	const resultsIndex = arguments_.indexOf('--results');
	const result = resultsIndex >= 0
		? checkResultsDirectory(path.resolve(arguments_[resultsIndex + 1] ?? '.'))
		: (() => {
			const target = arguments_[0];
			if (!target) {
				console.error('usage: node test/onyx/lab/manifest.mts <manifest.json> | --results <dir>');
				process.exit(2);
			}
			try {
				return validateManifest(JSON.parse(fs.readFileSync(path.resolve(target), 'utf8')));
			} catch (error) {
				return { ok: false, errors: [error instanceof Error ? error.message : String(error)] };
			}
		})();
	for (const error of result.errors) {
		console.error(error);
	}
	console.log(result.ok ? 'manifest: valid' : `manifest: ${result.errors.length} problem${result.errors.length === 1 ? '' : 's'}`);
	process.exit(result.ok ? 0 : 1);
}
