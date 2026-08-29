/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType } from '../../../../platform/accessibility/browser/accessibleView.js';
import { IAccessibleViewImplementation } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { AccessibilityVerbositySettingId } from '../../accessibility/browser/accessibilityConfiguration.js';
import { CONTEXT_ONYX_INLINE_EDIT_ACTIVE } from './editor/onyxInlineEditController.js';
import { IOnyxChangeSetService } from './changes/onyxChangeSetService.js';
import { IOnyxControlPlaneService } from './controlPlane/onyxControlPlaneService.js';

/** Focus context for the control-plane views, so help binds only where it applies. */
const CONTROL_PLANE_FOCUSED = ContextKeyExpr.or(
	ContextKeyExpr.equals('focusedView', 'workbench.view.onyx.activity'),
	ContextKeyExpr.equals('focusedView', 'workbench.view.onyx.changes'),
	ContextKeyExpr.equals('focusedView', 'workbench.view.onyx.contextBudget'),
	ContextKeyExpr.equals('focusedView', 'workbench.view.onyx.compute'),
	ContextKeyExpr.equals('focusedView', 'workbench.view.onyx.inspector'),
)!;

/**
 * Accessibility help for the control plane. The control plane is a dense
 * visual surface — timelines, budgets, diffs — so a screen-reader user needs
 * both a map of what is here and a plain-text rendering of the selected run
 * (the accessible view below).
 */
export class OnyxControlPlaneAccessibilityHelp implements IAccessibleViewImplementation {
	readonly priority = 105;
	readonly name = 'onyx-control-plane';
	readonly type = AccessibleViewType.Help;
	readonly when = CONTROL_PLANE_FOCUSED;

	getProvider(_accessor: ServicesAccessor) {
		const content = [
			localize('onyx.a11y.help.overview', "You are in the Onyx control plane, which shows what the local agent is doing and what it costs."),
			localize('onyx.a11y.help.views', "It has five views: Agent Activity (every step of every run), Onyx Changes (edits the agent proposed, reviewable per file and per hunk — nothing is applied until you accept), Context Budget (what the next prompt will carry, and the files you pinned), Compute (throughput, first-token latency and the compute ledger) and Inspector (past runs, replayable, and a comparison of any two)."),
			localize('onyx.a11y.help.accessibleView', "- Open the accessible view to read the selected run as plain text."),
			localize('onyx.a11y.help.open', "- {0}: open the control plane", '<keybinding:onyx.openControlPlane>'),
			localize('onyx.a11y.help.hub', "- {0}: open the Onyx hub, which fronts every Onyx command with its live state", '<keybinding:onyx.openHub>'),
			localize('onyx.a11y.help.runs', "Runs are announced as they progress. Each timeline row is a step: its kind, what happened, and why. Rows that point at code open that file when activated."),
			localize('onyx.a11y.help.controls', "While a run is live, the run header exposes pause, redirect and stop buttons, reachable with Tab."),
		].join('\n');
		return new AccessibleContentProvider(
			AccessibleViewProviderId.OnyxControlPlane,
			{ type: AccessibleViewType.Help },
			() => content,
			() => { /* focus returns to the view that opened help */ },
			AccessibilityVerbositySettingId.OnyxControlPlane,
		);
	}
}

/** The selected run as plain text: the timeline a screen reader can actually read. */
export class OnyxControlPlaneAccessibleView implements IAccessibleViewImplementation {
	readonly priority = 105;
	readonly name = 'onyx-control-plane';
	readonly type = AccessibleViewType.View;
	readonly when = CONTROL_PLANE_FOCUSED;

	getProvider(accessor: ServicesAccessor) {
		const controlPlaneService = accessor.get(IOnyxControlPlaneService);
		const changeSetService = accessor.get(IOnyxChangeSetService);
		const run = controlPlaneService.selectedRun.get() ?? controlPlaneService.runs.get()[0];
		const staged = changeSetService.files.get();
		if (!run && staged.length === 0) {
			return undefined;
		}
		const entries = run?.activity.get() ?? [];
		const lines = [
			...(run ? [
				localize('onyx.a11y.view.title', "Run: {0}", run.title),
				localize('onyx.a11y.view.meta', "Status {0}, model {1}, {2} step(s).", run.status.get(), run.modelKey, entries.length),
				'',
				...entries.map((entry, index) => `${index + 1}. ${entry.kind}: ${entry.label}${entry.reason ? ` — ${entry.reason}` : ''}${entry.location ? ` (${entry.location.path}:${entry.location.line})` : ''}`),
			] : []),
			...(staged.length > 0 ? [
				'',
				localize('onyx.a11y.view.changes', "Proposed changes awaiting review ({0} file(s)):", staged.length),
				...staged.map(file => {
					const added = file.hunks.reduce((total, hunk) => total + hunk.newLines.length, 0);
					const removed = file.hunks.reduce((total, hunk) => total + hunk.originalLines.length, 0);
					return localize('onyx.a11y.view.changeFile', "{0}: {1} hunk(s), {2} added line(s), {3} removed line(s){4}", file.proposal.path, file.hunks.length, added, removed, file.risk ? `, ${file.risk.level} risk — ${file.risk.reason}` : '');
				}),
			] : []),
		];
		return new AccessibleContentProvider(
			AccessibleViewProviderId.OnyxControlPlane,
			{ type: AccessibleViewType.View },
			() => lines.join('\n'),
			() => { /* focus returns to the view that opened the accessible view */ },
			AccessibilityVerbositySettingId.OnyxControlPlane,
		);
	}
}

/** Help for the inline edit surface, where the whole flow is keyboard-driven. */
export class OnyxInlineEditAccessibilityHelp implements IAccessibleViewImplementation {
	readonly priority = 106;
	readonly name = 'onyx-inline-edit';
	readonly type = AccessibleViewType.Help;
	readonly when = CONTEXT_ONYX_INLINE_EDIT_ACTIVE;

	getProvider(_accessor: ServicesAccessor) {
		const content = [
			localize('onyx.a11y.inlineEdit.overview', "You are in Onyx inline edit. Type an instruction and press Enter; a local model rewrites the selected lines and each changed region becomes a hunk you review."),
			localize('onyx.a11y.inlineEdit.accept', "- {0}: keep the current hunk", '<keybinding:onyx.inlineEdit.acceptHunk>'),
			localize('onyx.a11y.inlineEdit.reject', "- {0}: undo the current hunk and restore the original lines", '<keybinding:onyx.inlineEdit.rejectHunk>'),
			localize('onyx.a11y.inlineEdit.next', "- {0}: go to the next hunk, {1}: the previous one", '<keybinding:onyx.inlineEdit.nextHunk>', '<keybinding:onyx.inlineEdit.previousHunk>'),
			localize('onyx.a11y.inlineEdit.cancel', "- {0}: close inline edit, keeping every hunk you have not undone", '<keybinding:onyx.inlineEdit.cancel>'),
			localize('onyx.a11y.inlineEdit.honest', "If the model's reply cannot be turned into an edit, nothing in the file changes and the status line says so."),
		].join('\n');
		return new AccessibleContentProvider(
			AccessibleViewProviderId.OnyxInlineEdit,
			{ type: AccessibleViewType.Help },
			() => content,
			() => { /* focus returns to the inline edit input */ },
			AccessibilityVerbositySettingId.OnyxInlineEdit,
		);
	}
}
