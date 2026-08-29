/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The approval policy behind the agent's terminal tool. Everything here is a
 * pure decision — what a command is allowed to do is decided by these
 * functions and reviewed by these tests, never ad hoc at the call site. The
 * heuristics do not try to be a sandbox (a shell command can hide anything);
 * they exist to make the approval prompt honest about what the user is being
 * asked to approve.
 */

/** How a command may proceed, in increasing order of persistence. */
export type OnyxTerminalDecision =
	/** Run this one invocation. */
	| 'allow-once'
	/** Run, and stop asking for this exact command until the window closes. */
	| 'allow-session'
	/** Run, and persist this exact command to the workspace allowlist. */
	| 'allow-always'
	| 'deny';

export interface IOnyxCommandClassification {
	/** Whitespace-normalized command — the identity used for allowlists. */
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

/** Collapses whitespace so cosmetic differences cannot dodge an allowlist or a heuristic. */
export function normalizeCommand(command: string): string {
	return command.trim().replace(/\s+/g, ' ');
}

export function classifyCommand(command: string): IOnyxCommandClassification {
	const normalized = normalizeCommand(command);
	const reasons = DANGER_RULES.filter(rule => rule.pattern.test(normalized)).map(rule => rule.reason);
	return { normalized, dangerous: reasons.length > 0, reasons };
}

/**
 * Whether a command is covered by an allowlist. Matching is exact on the
 * normalized text: "always allow this exact command" must never quietly grow
 * into "always allow anything that starts the same way".
 */
export function matchesAllowlist(command: string, allowlist: readonly string[]): boolean {
	const normalized = normalizeCommand(command);
	return allowlist.some(entry => normalizeCommand(entry) === normalized);
}

export interface IOnyxTerminalApprovalRequest {
	/** What the approval dialog asks, ready to render. */
	readonly message: string;
	readonly detail: string;
	readonly dangerous: boolean;
	/** Which decisions the dialog may offer (dangerous commands cannot be persisted). */
	readonly offeredDecisions: readonly OnyxTerminalDecision[];
}

/**
 * Decides whether a command may run without asking, and if not, exactly what
 * to ask. A dangerous command is never covered by any allowlist and cannot be
 * persisted — the "always" option simply is not offered for it.
 */
export function evaluateCommand(command: string, workspaceAllowlist: readonly string[], sessionAllowlist: readonly string[]): { readonly autoAllowed: boolean; readonly approval?: IOnyxTerminalApprovalRequest } {
	const classification = classifyCommand(command);
	if (!classification.dangerous && (matchesAllowlist(command, workspaceAllowlist) || matchesAllowlist(command, sessionAllowlist))) {
		return { autoAllowed: true };
	}
	const detailLines = [classification.normalized];
	if (classification.dangerous) {
		detailLines.push('', ...classification.reasons.map(reason => `⚠ ${reason}`));
	}
	return {
		autoAllowed: false,
		approval: {
			message: classification.dangerous
				? 'The agent wants to run a command that looks dangerous'
				: 'The agent wants to run a terminal command',
			detail: detailLines.join('\n'),
			dangerous: classification.dangerous,
			offeredDecisions: classification.dangerous
				? ['allow-once', 'deny']
				: ['allow-once', 'allow-session', 'allow-always', 'deny'],
		},
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
