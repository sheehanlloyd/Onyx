/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../media/onyxOnboarding.css';
import { $, addDisposableListener, append, clearNode, EventType } from '../../../../../base/browser/dom.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import { CommandsRegistry, ICommandService } from '../../../../../platform/commands/common/commands.js';
import { renderOnyxGem } from '../onyxGem.js';

/** Command Onyx registers to report reachable local runtimes to onboarding. */
export const ONYX_DETECT_RUNTIMES_COMMAND_ID = 'onyx.detectRuntimes';

/** One reachable local inference runtime, as reported by {@link ONYX_DETECT_RUNTIMES_COMMAND_ID}. */
export interface IOnyxDetectedRuntime {
	readonly displayName: string;
	readonly host: string;
	readonly modelCount: number;
}

interface IOnboardingCommand {
	readonly ordinal: string;
	readonly title: string;
	readonly command?: string;
	readonly detail?: string;
}

/**
 * Onboarding's first step. Onyx has no account to sign into — the one thing a
 * new user must do is point it at a model running on their own machine — so
 * this step teaches that in three commands and confirms it live.
 */
export function renderOnyxRuntimeOnboardingStep(
	container: HTMLElement,
	commandService: ICommandService,
	clipboardService: IClipboardService,
	disposables: DisposableStore,
): void {
	const wrapper = append(container, $('.onyx-onboarding'));

	const hero = append(wrapper, $('.onyx-onboarding-hero'));
	append(hero, renderOnyxGem(56));

	const status = append(hero, $('.onyx-onboarding-status'));
	renderStatus(status, 'probing', []);

	const steps: IOnboardingCommand[] = [
		{
			ordinal: '1',
			title: localize('onyx.onboarding.install', "Install a local runtime"),
			command: 'brew install ollama',
			detail: localize('onyx.onboarding.install.detail', "Ollama is the quickest way in. LM Studio, llama.cpp and vLLM work too."),
		},
		{
			ordinal: '2',
			title: localize('onyx.onboarding.serve', "Start it"),
			command: 'ollama serve',
		},
		{
			ordinal: '3',
			title: localize('onyx.onboarding.pull', "Pull a coding model"),
			command: 'ollama pull qwen2.5-coder:7b',
			detail: localize('onyx.onboarding.pull.detail', "Onyx picks the right model per request and measures how each one performs on this Mac."),
		},
	];

	const list = append(wrapper, $('ol.onyx-onboarding-steps'));
	for (const step of steps) {
		renderStep(list, step, clipboardService, disposables);
	}

	const note = append(wrapper, $('p.onyx-onboarding-note'));
	note.textContent = localize('onyx.onboarding.note', "Nothing you type leaves this machine. Onyx has no account and makes no network calls beyond the endpoints you point it at.");

	// Live confirmation: the step is only really done when a runtime answers.
	if (CommandsRegistry.getCommand(ONYX_DETECT_RUNTIMES_COMMAND_ID)) {
		detect(status, commandService, disposables);
	} else {
		renderStatus(status, 'none', []);
	}
}

function detect(status: HTMLElement, commandService: ICommandService, disposables: DisposableStore): void {
	let disposed = false;
	disposables.add({ dispose: () => { disposed = true; } });

	const probe = async () => {
		let runtimes: readonly IOnyxDetectedRuntime[] = [];
		try {
			runtimes = await commandService.executeCommand<readonly IOnyxDetectedRuntime[]>(ONYX_DETECT_RUNTIMES_COMMAND_ID) ?? [];
		} catch {
			runtimes = [];
		}
		if (disposed) {
			return;
		}
		renderStatus(status, runtimes.length ? 'found' : 'none', runtimes);
	};
	probe();
}

/**
 * The "we found something" headline. More than one runtime can answer at once —
 * Ollama on :11434 and LM Studio on :1234 is an ordinary setup — and naming
 * only the first while summing every runtime's models credits LM Studio's
 * models to Ollama. Pure so it can be tested without a DOM.
 */
export function runtimesFoundHeadline(runtimes: readonly IOnyxDetectedRuntime[]): string {
	const models = runtimes.reduce((sum, runtime) => sum + runtime.modelCount, 0);
	if (runtimes.length === 1) {
		return models === 1
			? localize('onyx.onboarding.found.one', "{0} is running — 1 model ready", runtimes[0].displayName)
			: localize('onyx.onboarding.found', "{0} is running — {1} models ready", runtimes[0].displayName, models);
	}
	if (runtimes.length === 2) {
		return localize('onyx.onboarding.found.two', "{0} and {1} are running — {2} models ready", runtimes[0].displayName, runtimes[1].displayName, models);
	}
	return localize('onyx.onboarding.found.many', "{0} local runtimes are running — {1} models ready", runtimes.length, models);
}

function renderStatus(status: HTMLElement, state: 'probing' | 'found' | 'none', runtimes: readonly IOnyxDetectedRuntime[]): void {
	clearNode(status);
	status.classList.toggle('found', state === 'found');

	const headline = append(status, $('.onyx-onboarding-status-headline'));
	const dot = append(headline, $('span.onyx-onboarding-dot'));
	dot.classList.add(state);
	const text = append(headline, $('span'));

	const detail = append(status, $('.onyx-onboarding-status-detail'));
	switch (state) {
		case 'probing':
			text.textContent = localize('onyx.onboarding.probing', "Looking for a local runtime…");
			detail.textContent = localize('onyx.onboarding.probing.detail', "Onyx checks the ports Ollama, LM Studio, llama.cpp and vLLM listen on.");
			break;
		case 'found':
			text.textContent = runtimesFoundHeadline(runtimes);
			detail.textContent = runtimes.map(runtime => runtime.host).join(' · ');
			break;
		case 'none':
			text.textContent = localize('onyx.onboarding.none', "No local runtime yet");
			detail.textContent = localize('onyx.onboarding.none.detail', "Run the three commands below, then reopen Onyx — models appear on their own.");
			break;
	}
}

function renderStep(list: HTMLElement, step: IOnboardingCommand, clipboardService: IClipboardService, disposables: DisposableStore): void {
	const item = append(list, $('li.onyx-onboarding-step'));
	const ordinal = append(item, $('span.onyx-onboarding-ordinal'));
	ordinal.textContent = step.ordinal;

	const body = append(item, $('.onyx-onboarding-step-body'));
	const title = append(body, $('.onyx-onboarding-step-title'));
	title.textContent = step.title;

	if (step.command) {
		const row = append(body, $('.onyx-onboarding-command'));
		const code = append(row, $('code'));
		code.textContent = step.command;

		const copy = append(row, $<HTMLButtonElement>('button.onyx-onboarding-copy'));
		copy.type = 'button';
		const setLabel = (copied: boolean) => {
			clearNode(copy);
			append(copy, renderIcon(copied ? Codicon.check : Codicon.copy));
			const label = append(copy, $('span'));
			label.textContent = copied ? localize('onyx.onboarding.copied', "Copied") : localize('onyx.onboarding.copy', "Copy");
			copy.setAttribute('aria-label', localize('onyx.onboarding.copyAria', "Copy the command {0}", step.command!));
		};
		setLabel(false);
		disposables.add(addDisposableListener(copy, EventType.CLICK, async () => {
			await clipboardService.writeText(step.command!);
			setLabel(true);
		}));
	}

	if (step.detail) {
		const detail = append(body, $('.onyx-onboarding-step-detail'));
		detail.textContent = step.detail;
	}
}
