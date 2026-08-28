/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, EventType } from '../../../../../base/browser/dom.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import { renderOnyxGem } from '../onyxGem.js';

/** A resting state that explains what to do next, instead of reporting an error. */
export interface IOnyxEmptyState {
	readonly headline: string;
	readonly body: string;
	/** Shell commands the user can copy verbatim. */
	readonly commands?: readonly string[];
	/** Whether to lead with the Onyx mark — reserved for the "nothing is set up yet" state. */
	readonly withMark?: boolean;
}

/**
 * The one shape every Onyx view falls back to when it has nothing to show.
 * One headline leads, the body supports it, and any command the user needs is
 * copyable rather than transcribed by hand.
 */
export function renderOnyxEmptyState(parent: HTMLElement, state: IOnyxEmptyState, clipboardService: IClipboardService, disposables: DisposableStore): HTMLElement {
	const empty = append(parent, $('.onyx-empty'));

	if (state.withMark) {
		const mark = append(empty, $('.onyx-empty-mark'));
		append(mark, renderOnyxGem(40));
	}

	const headline = append(empty, $('.onyx-empty-headline'));
	headline.textContent = state.headline;

	const body = append(empty, $('.onyx-empty-body'));
	body.textContent = state.body;

	for (const command of state.commands ?? []) {
		const row = append(empty, $('.onyx-empty-command'));
		const code = append(row, $('code'));
		code.textContent = command;
		const copy = append(row, $<HTMLButtonElement>('button.onyx-empty-copy.codicon.codicon-copy'));
		copy.type = 'button';
		copy.title = localize('onyx.empty.copy', "Copy");
		copy.setAttribute('aria-label', localize('onyx.empty.copyAria', "Copy the command {0}", command));
		disposables.add(addDisposableListener(copy, EventType.CLICK, async () => {
			await clipboardService.writeText(command);
			copy.classList.replace('codicon-copy', 'codicon-check');
		}));
	}

	return empty;
}

/** The shared "Onyx has no model to talk to" state, used wherever a runtime is required. */
export function onyxNoRuntimeState(): IOnyxEmptyState {
	return {
		withMark: true,
		headline: localize('onyx.empty.noRuntime', "No local model yet"),
		body: localize('onyx.empty.noRuntime.body', "Onyx runs every model on this machine. Install a runtime and pull a coding model — it appears here on its own."),
		commands: ['brew install ollama', 'ollama pull qwen2.5-coder:7b'],
	};
}
