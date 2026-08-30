/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Formatting for the debug-aware assistant: the paused stack, its frames and
 * the visible variables, rendered as bounded plain text. What the model sees
 * is exactly this text — it goes into the chat request the user can read, so
 * nothing is redacted silently and every truncation is marked in place.
 */

export interface IOnyxDebugFrame {
	readonly name: string;
	/** Workspace-relative or display path of the frame's source. */
	readonly path: string;
	readonly line: number;
}

export interface IOnyxDebugVariable {
	readonly scope: string;
	readonly name: string;
	readonly value: string;
}

export interface IOnyxDebugSnapshot {
	readonly sessionName: string;
	readonly threadName: string;
	/** Why the debugger stopped, when the adapter said (e.g. "exception"). */
	readonly stoppedReason: string | undefined;
	readonly frames: readonly IOnyxDebugFrame[];
	/** Variables of the top frame's scopes, already flattened. */
	readonly variables: readonly IOnyxDebugVariable[];
}

/**
 * Frames the language runtime owns rather than the user: Node's internals,
 * V8's, and the wrappers a bundler leaves behind. They are still counted and
 * reported, just not spelled out one per line.
 */
function isRuntimeInternal(path: string): boolean {
	return /^<[^>]+>|^node:|[\\/]node_modules[\\/]|^internal[\\/]/.test(path);
}

const MAX_FRAMES = 20;
const MAX_VARIABLES = 40;
const MAX_VALUE_CHARS = 160;

/** One bounded, truncation-marked text block for the whole paused state. */
export function formatDebugSnapshot(snapshot: IOnyxDebugSnapshot): string {
	const lines: string[] = [
		`Debug session "${snapshot.sessionName}", thread "${snapshot.threadName}" is paused${snapshot.stoppedReason ? ` (reason: ${snapshot.stoppedReason})` : ''}.`,
		'',
		'Call stack (innermost first):',
	];
	const frames = snapshot.frames.slice(0, MAX_FRAMES);
	// Runs of runtime-internal frames collapse to one line. A paused Node
	// process reports eight `<node_internals>` module-loader frames under two
	// frames of the user's own code, and a small model reading twenty lines of
	// `cjs/loader` is a small model not reading the two that matter.
	let collapsing = 0;
	frames.forEach((frame, index) => {
		if (isRuntimeInternal(frame.path)) {
			collapsing++;
			return;
		}
		if (collapsing > 0) {
			lines.push(`  [… ${collapsing} runtime-internal frame${collapsing === 1 ? '' : 's'} …]`);
			collapsing = 0;
		}
		lines.push(`${index === 0 ? '→' : ' '} ${frame.name} — ${frame.path}:${frame.line}`);
	});
	if (collapsing > 0) {
		lines.push(`  [… ${collapsing} runtime-internal frame${collapsing === 1 ? '' : 's'} …]`);
	}
	if (snapshot.frames.length > MAX_FRAMES) {
		lines.push(`  [… ${snapshot.frames.length - MAX_FRAMES} deeper frame(s) omitted …]`);
	}

	if (snapshot.variables.length > 0) {
		lines.push('', 'Variables in the paused frame:');
		let currentScope = '';
		for (const variable of snapshot.variables.slice(0, MAX_VARIABLES)) {
			if (variable.scope !== currentScope) {
				currentScope = variable.scope;
				lines.push(`  [${currentScope}]`);
			}
			lines.push(`  ${variable.name} = ${clipValue(variable.value)}`);
		}
		if (snapshot.variables.length > MAX_VARIABLES) {
			lines.push(`  [… ${snapshot.variables.length - MAX_VARIABLES} more variable(s) omitted …]`);
		}
	}
	return lines.join('\n');
}

function clipValue(value: string): string {
	const flat = value.replace(/\s+/g, ' ');
	return flat.length > MAX_VALUE_CHARS ? `${flat.slice(0, MAX_VALUE_CHARS)}… [truncated]` : flat;
}

/** The chat request behind "Explain This Failure" — the visible text IS what the model gets. */
export function buildExplainFailurePrompt(snapshot: IOnyxDebugSnapshot): string {
	return [
		'The debugger is paused. Explain what went wrong and suggest the most likely fix.',
		'',
		formatDebugSnapshot(snapshot),
	].join('\n');
}
