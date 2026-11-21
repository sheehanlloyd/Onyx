/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IOnyxLabHarnessRequest } from '../common/onyxRuntime.js';

/** The variable that names a lab manifest for the process to read a harness configuration from. */
export const ONYX_LAB_MANIFEST_VARIABLE = 'ONYX_LAB_MANIFEST';
/** The variable that names which of the manifest's harness configurations to use. Unset: the first. */
export const ONYX_LAB_HARNESS_VARIABLE = 'ONYX_LAB_HARNESS';

/** A manifest is a small file; one larger than this is not parsed. */
const MAX_MANIFEST_CHARS = 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The harness configuration this process was asked to run under (L4), read
 * from the lab manifest its environment names. Undefined when it names none,
 * which is every ordinary start. Reading a manifest decides nothing: whether
 * the configuration is applied is the workbench's decision, and a packaged
 * build refuses it. A manifest that cannot be read, or that has no such
 * entry, is still a request, carrying the problem, so that the refusal is
 * seen and the run does not quietly proceed as if nothing had been asked.
 * Where the manifest is on disk is never part of the answer.
 */
export async function readLabHarnessRequest(environment: Readonly<Record<string, string | undefined>>, readFile: (path: string) => Promise<string>): Promise<IOnyxLabHarnessRequest | undefined> {
	const manifestPath = environment[ONYX_LAB_MANIFEST_VARIABLE];
	if (!manifestPath) {
		return undefined;
	}
	const wanted = environment[ONYX_LAB_HARNESS_VARIABLE] || undefined;
	const problem = (text: string, manifest = 'unread'): IOnyxLabHarnessRequest => ({ manifest, name: wanted ?? 'first', configuration: undefined, problem: text });

	let text: string;
	try {
		text = await readFile(manifestPath);
	} catch {
		return problem(`the manifest named by ${ONYX_LAB_MANIFEST_VARIABLE} could not be read`);
	}
	if (text.length > MAX_MANIFEST_CHARS) {
		return problem(`the manifest named by ${ONYX_LAB_MANIFEST_VARIABLE} is larger than a manifest can be`);
	}
	let manifest: unknown;
	try {
		manifest = JSON.parse(text);
	} catch {
		return problem(`the manifest named by ${ONYX_LAB_MANIFEST_VARIABLE} is not JSON`);
	}
	const name = isRecord(manifest) && typeof manifest.name === 'string' ? manifest.name : 'unnamed';
	const entries = isRecord(manifest) && Array.isArray(manifest.harnessConfigurations) ? manifest.harnessConfigurations.filter(isRecord) : [];
	const entry = wanted === undefined ? entries[0] : entries.find(candidate => candidate.name === wanted);
	if (!entry || typeof entry.name !== 'string') {
		return problem(wanted === undefined ? 'the manifest has no harness configuration' : `the manifest has no harness configuration named ${wanted}`, name);
	}
	// An entry with no `configuration` is the default one by another name: there is nothing to change.
	return { manifest: name, name: entry.name, configuration: entry.configuration ?? {} };
}
