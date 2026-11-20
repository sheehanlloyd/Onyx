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
 * this working directory, with this timeout. The classifier below does not
 * decide whether a command may run. It exists to make the approval prompt
 * honest about what the command looks like, and it is not a sandbox.
 */

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
}

export interface IOnyxCommandClassification {
	/** Whitespace-normalized command, used for matching the heuristics and for one-line labels only. */
	readonly normalized: string;
	readonly dangerous: boolean;
	/** Human-readable reasons, one per matched heuristic. */
	readonly reasons: readonly string[];
}

interface IDangerRule {
	readonly pattern: RegExp;
	readonly reason: string;
}

/**
 * Each rule names one recognizable way a shell command destroys state,
 * escalates privilege, or executes unreviewed remote content. Matching is on
 * the normalized command text, case-insensitive only where the tool is
 * case-insensitive.
 *
 * These rules match inside quotes too, which over-warns on things like
 * `echo "curl | sh"`. That is deliberate and not a bug to fix: correctly
 * parsing shell quoting is hard, and any gap becomes a way to smuggle a real
 * `curl | sh` past the prompt. The cost of over-warning is one extra look;
 * the cost of under-warning is an unreviewed command running on your machine.
 */
const DANGER_RULES: readonly IDangerRule[] = [
	{ pattern: /\brm\s+(-[a-z]*[rf][a-z]*\s+)+/i, reason: 'recursive or forced delete (rm -r/-f)' },
	{ pattern: /\brm\s+.*(\/\s*$|\s+\/(\s|$)|~\/?(\s|$))/, reason: 'delete targets the home directory or filesystem root' },
	{ pattern: /\b(curl|wget)\b[^|;&]*\|\s*(sudo\s+)?(ba|z|da|fi)?sh\b/i, reason: 'pipes downloaded content straight into a shell' },
	{ pattern: /\bbase64\b[^|]*\|\s*(ba|z)?sh\b/i, reason: 'decodes hidden content into a shell' },
	{ pattern: /\bsudo\b/, reason: 'requests root privileges (sudo)' },
	{ pattern: /\bgit\s+push\b.*(--force\b|-f\b|\+\S+:)/, reason: 'force-pushes over remote history' },
	{ pattern: /\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f)/, reason: 'discards uncommitted work (git reset --hard / clean -f)' },
	{ pattern: /\bchmod\s+(-[a-z]+\s+)*0?777\b/i, reason: 'makes files world-writable (chmod 777)' },
	{ pattern: /\bdd\b.*\bof=\/dev\//i, reason: 'writes raw bytes to a device' },
	{ pattern: /\bmkfs\b|\bdiskutil\s+(erase|partition)/i, reason: 'formats a disk' },
	{ pattern: /:\s*\(\s*\)\s*{\s*:\s*\|\s*:\s*&\s*}\s*;\s*:/, reason: 'fork bomb' },
	{ pattern: /\b(shutdown|reboot|halt)\b/i, reason: 'shuts down or restarts the machine' },
	{ pattern: /\bkill\s+(-9\s+)?-1\b/, reason: 'kills every process' },
	{ pattern: />\s*\/dev\/(sd|disk|nvme)/i, reason: 'overwrites a raw disk device' },
	{ pattern: /\b(npm|pnpm|yarn)\s+publish\b/, reason: 'publishes a package to a registry' },
	{ pattern: /\blaunchctl\s+(load|unload|bootstrap)|\bsystemctl\s+(enable|disable|mask)/i, reason: 'changes system services' },
	{ pattern: /\b(defaults\s+write|scutil|nvram)\b/i, reason: 'changes system settings' },
	{ pattern: /\bhistory\s+-c\b|\bunset\s+HISTFILE\b/, reason: 'covers its tracks by clearing shell history' },
];

/** Collapses whitespace for matching and for one-line labels. Never used for what is approved or dispatched. */
export function normalizeCommand(command: string): string {
	return command.trim().replace(/\s+/g, ' ');
}

export function classifyCommand(command: string): IOnyxCommandClassification {
	const normalized = normalizeCommand(command);
	const reasons = DANGER_RULES.filter(rule => rule.pattern.test(normalized)).map(rule => rule.reason);
	return { normalized, dangerous: reasons.length > 0, reasons };
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
	const notes = whitespaceNotes(invocation.command);
	if (notes.length) {
		detailLines.push(`Shown exactly as it will run: the command ${notes.join(', ')}.`);
	}
	if (classification.dangerous) {
		detailLines.push('', ...classification.reasons.map(reason => `⚠ looks like: ${reason}`));
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
