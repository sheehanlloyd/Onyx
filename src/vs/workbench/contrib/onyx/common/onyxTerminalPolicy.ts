/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The approval policy behind the agent's terminal tool. Everything here is a
 * pure decision, reviewed by tests and never made ad hoc at the call site.
 *
 * The alpha contract (B2): every shell invocation asks. There is no session
 * grant, no persistent grant and no allowlist; repository content confers no
 * authority. An approval covers one invocation: these exact command bytes, in
 * this working directory, with this timeout. The classifier does not decide
 * whether a command may run. It exists to make the approval prompt honest
 * about what the command looks like, and it is not a sandbox.
 */

import { classifyShellCommand, IOnyxCommandWarning, OnyxCommandCategory } from './onyxCommandClassifier.js';

/** What the user can decide about one invocation. */
export type OnyxTerminalDecision =
	/** Run this one invocation. */
	| 'allow-once'
	| 'deny';

/** One shell invocation as the user approves it and as it is dispatched. */
export interface IOnyxCommandInvocation {
	/** The exact command text. Never trimmed, collapsed or otherwise rewritten between approval and dispatch. */
	readonly command: string;
	readonly cwd: string;
	readonly timeoutMs: number;
	/**
	 * Whether the whole environment is passed, including variables whose
	 * names look like secrets (`onyx.terminal.passEnvironment`). Off unless set.
	 */
	readonly passEnvironment?: boolean;
}

export interface IOnyxCommandClassification {
	/** Whitespace-normalized command, for one-line labels only. Never what is approved or dispatched. */
	readonly normalized: string;
	/** Whether the prompt uses its warning style: at least one warning is elevated. */
	readonly dangerous: boolean;
	/** What the command looks like, one line per warning, in the order found. */
	readonly reasons: readonly string[];
	/** The categories the warnings fall into. */
	readonly categories: readonly OnyxCommandCategory[];
	readonly warnings: readonly IOnyxCommandWarning[];
}

/** Collapses whitespace for one-line labels. Never used for what is approved or dispatched. */
export function normalizeCommand(command: string): string {
	return command.trim().replace(/\s+/g, ' ');
}

/**
 * What a command looks like (B4): a tokenizing pass over the whole pipeline
 * (`onyxCommandClassifier.ts`), not a regular expression over the string. It
 * informs the approval prompt. It does not decide anything, and a command it
 * says nothing about has not been shown to be harmless.
 */
export function classifyCommand(command: string): IOnyxCommandClassification {
	const warnings = classifyShellCommand(command);
	return {
		normalized: normalizeCommand(command),
		dangerous: warnings.some(warning => warning.elevated),
		reasons: warnings.map(warning => warning.reason),
		categories: [...new Set(warnings.map(warning => warning.category))],
		warnings,
	};
}

export interface IOnyxTerminalApprovalRequest {
	/** What the approval dialog asks, ready to render. */
	readonly message: string;
	/** The exact command, where it would run and for how long, and what it looks like. */
	readonly detail: string;
	readonly dangerous: boolean;
	/** The decisions the dialog offers. In the alpha: run this invocation once, or deny it. */
	readonly offeredDecisions: readonly OnyxTerminalDecision[];
}

/** Whitespace in a command that a dialog can render invisibly; the prompt says so when it is there. */
function whitespaceNotes(command: string): string[] {
	const notes: string[] = [];
	const lineBreaks = (command.match(/\n/g) ?? []).length;
	if (lineBreaks > 0) {
		notes.push(`contains ${lineBreaks} line break${lineBreaks === 1 ? '' : 's'}`);
	}
	if (command.includes('\t')) {
		notes.push('contains tab characters');
	}
	if (/ {2,}/.test(command)) {
		notes.push('contains repeated spaces');
	}
	if (command !== command.trim()) {
		notes.push('begins or ends with whitespace');
	}
	return notes;
}

/**
 * What to ask for one invocation. Every invocation asks, whatever it is and
 * wherever its text came from. The detail shows the command exactly as it
 * will be dispatched: the same string, not a normalized copy.
 */
export function buildApprovalRequest(invocation: IOnyxCommandInvocation): IOnyxTerminalApprovalRequest {
	const classification = classifyCommand(invocation.command);
	const seconds = Math.round(invocation.timeoutMs / 1000);
	const detailLines = [
		invocation.command,
		'',
		`Working directory: ${invocation.cwd}`,
		`Stops after: ${seconds} s`,
	];
	if (invocation.passEnvironment) {
		detailLines.push('Environment: every variable is passed to this command, including ones named like secrets (onyx.terminal.passEnvironment is on).');
	}
	const notes = whitespaceNotes(invocation.command);
	if (notes.length) {
		detailLines.push(`Shown exactly as it will run: the command ${notes.join(', ')}.`);
	}
	if (classification.warnings.length) {
		// Every warning is shown, elevated or not: egress and persistence are always named (B4).
		detailLines.push('', ...classification.warnings.map(warning => `${warning.elevated ? '⚠' : '•'} looks like: ${warning.reason}`));
	}
	return {
		message: classification.dangerous
			? 'The agent wants to run a command that looks dangerous'
			: 'The agent wants to run a terminal command',
		detail: detailLines.join('\n'),
		dangerous: classification.dangerous,
		offeredDecisions: ['allow-once', 'deny'],
	};
}

/** Output shown to the model is bounded; keep head and tail, mark the elision. */
export function clampCommandOutput(output: string, maxChars: number): string {
	if (output.length <= maxChars) {
		return output;
	}
	const head = output.slice(0, Math.floor(maxChars * 0.6));
	const tail = output.slice(-Math.floor(maxChars * 0.3));
	return `${head}\n[… ${output.length - head.length - tail.length} characters elided …]\n${tail}`;
}
