/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Checks a tool call's arguments against the schema the tool was advertised
 * with, before the tool is invoked (B12, R-28, I-06). A call that does not
 * match is answered with what is wrong and never reaches the tool.
 *
 * The subset of JSON Schema that tool schemas use: `type` (one or several),
 * `enum`, `required`, `properties`, `additionalProperties: false` and
 * `items`. Anything else in a schema is ignored, which errs towards letting
 * a call through to the tool's own checks. Nothing is coerced: `"30"` is
 * not a number.
 */

const MAX_PROBLEMS = 5;
const MAX_ITEMS_CHECKED = 100;

type Schema = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function typeOf(value: unknown): string {
	if (value === null) {
		return 'null';
	}
	if (Array.isArray(value)) {
		return 'array';
	}
	return typeof value === 'number' && !Number.isFinite(value) ? 'not a finite number' : typeof value;
}

function matchesType(value: unknown, type: string): boolean {
	switch (type) {
		case 'object': return isRecord(value);
		case 'array': return Array.isArray(value);
		case 'string': return typeof value === 'string';
		case 'boolean': return typeof value === 'boolean';
		case 'number': return typeof value === 'number' && Number.isFinite(value);
		case 'integer': return typeof value === 'number' && Number.isInteger(value);
		case 'null': return value === null;
		default: return true; // a type this subset does not know: the tool decides
	}
}

function check(schema: unknown, value: unknown, path: string, problems: string[]): void {
	if (!isRecord(schema) || problems.length >= MAX_PROBLEMS) {
		return;
	}
	const declared: Schema = schema;
	const types = typeof declared.type === 'string' ? [declared.type] : Array.isArray(declared.type) ? declared.type.filter((type): type is string => typeof type === 'string') : isRecord(declared.properties) ? ['object'] : [];
	if (types.length > 0 && !types.some(type => matchesType(value, type))) {
		problems.push(`${path} must be ${types.join(' or ')}, got ${typeOf(value)}`);
		return;
	}
	if (Array.isArray(declared.enum) && !declared.enum.some(allowed => allowed === value || JSON.stringify(allowed) === JSON.stringify(value))) {
		problems.push(`${path} must be one of ${declared.enum.map(allowed => JSON.stringify(allowed)).join(', ')}`);
		return;
	}
	if (isRecord(value)) {
		const properties = isRecord(declared.properties) ? declared.properties : {};
		for (const key of Array.isArray(declared.required) ? declared.required : []) {
			if (typeof key === 'string' && value[key] === undefined) {
				problems.push(`${path}.${key} is required`);
			}
		}
		for (const [key, entry] of Object.entries(value)) {
			if (entry === undefined) {
				continue;
			}
			if (properties[key] !== undefined) {
				check(properties[key], entry, `${path}.${key}`, problems);
			} else if (declared.additionalProperties === false) {
				problems.push(`${path}.${key} is not an argument of this tool`);
			}
		}
	} else if (Array.isArray(value) && declared.items !== undefined) {
		value.slice(0, MAX_ITEMS_CHECKED).forEach((entry, index) => check(declared.items, entry, `${path}[${index}]`, problems));
	}
}

/** What is wrong with `value` as arguments for a tool with this input schema; empty when nothing is. */
export function validateToolArguments(schema: unknown, value: unknown): string[] {
	const problems: string[] = [];
	check(schema, value, 'arguments', problems);
	return problems.slice(0, MAX_PROBLEMS);
}
