/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { ChatMessageRole, IChatMessage } from '../../../chat/common/languageModels.js';
import { OnyxTaskKind } from '../../common/onyxTypes.js';
import { IOnyxKnownModel } from '../model/onyxLanguageModelProvider.js';
import { IOnyxProfileService } from '../profiles/onyxProfileService.js';

export const IOnyxRouterService = createDecorator<IOnyxRouterService>('onyxRouterService');

export interface IOnyxRoutingDecision {
	readonly task: OnyxTaskKind;
	readonly modelKey: string;
	/** Human-readable reasons, surfaced in the control plane. */
	readonly reasons: readonly string[];
}

export interface IOnyxRouterService {
	readonly _serviceBrand: undefined;
	/** Fires for every routing decision, so the control plane can show why a model was picked. */
	readonly onDidRoute: Event<IOnyxRoutingDecision>;
	classify(messages: readonly IChatMessage[]): OnyxTaskKind;
	pickModel(messages: readonly IChatMessage[], candidates: readonly IOnyxKnownModel[]): IOnyxKnownModel | undefined;
}

/**
 * Routes "Auto" requests to a concrete local model. Scoring blends the static
 * size heuristics with what has actually been measured on this machine —
 * throughput, tool-call reliability and how often the user kept the result —
 * so the routing genuinely adapts to the user's hardware and models.
 */
export class OnyxRouterService extends Disposable implements IOnyxRouterService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidRoute = this._register(new Emitter<IOnyxRoutingDecision>());
	readonly onDidRoute = this._onDidRoute.event;

	constructor(
		@IOnyxProfileService private readonly _profileService: IOnyxProfileService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();
	}

	classify(messages: readonly IChatMessage[]): OnyxTaskKind {
		const lastUserText = lastUserMessageText(messages);
		if (!lastUserText) {
			return 'chat';
		}
		const text = lastUserText.toLowerCase();
		if (/\b(error|exception|traceback|stack trace|crash|fail(s|ing|ed)?|bug|broken|not work)/.test(text) || /at .+:\d+:\d+/.test(lastUserText)) {
			return 'debug';
		}
		if (/\b(plan|architecture|design|approach|refactor|migrate|strategy|how should)/.test(text)) {
			return 'plan';
		}
		if (/\b(implement|add|create|build|write|generate|make)\b/.test(text)) {
			// Short imperative asks over a small scope are quick edits; anything larger is implementation work.
			return lastUserText.length < 120 && !/\b(feature|endpoint|service|component|module|class)\b/.test(text) ? 'quick-edit' : 'implement';
		}
		if (/\b(rename|fix typo|reword|tweak|change .{0,30} to)\b/.test(text)) {
			return 'quick-edit';
		}
		return 'chat';
	}

	pickModel(messages: readonly IChatMessage[], candidates: readonly IOnyxKnownModel[]): IOnyxKnownModel | undefined {
		if (candidates.length === 0) {
			return undefined;
		}
		const task = this.classify(messages);
		const scored = candidates.map(model => this._score(task, model));
		scored.sort((a, b) => b.score - a.score);
		const winner = scored[0];
		this._logService.debug(`[onyx] routed ${task} -> ${winner.model.key} (${winner.reasons.join('; ')})`);
		this._onDidRoute.fire({ task, modelKey: winner.model.key, reasons: winner.reasons });
		return winner.model;
	}

	private _score(task: OnyxTaskKind, model: IOnyxKnownModel): { model: IOnyxKnownModel; score: number; reasons: string[] } {
		const reasons: string[] = [];
		const paramB = model.profile.parameterB ?? 10;
		const stats = this._profileService.getStats(model.key);

		// Capability score: how much raw model quality the task wants.
		const wantedSize = task === 'quick-edit' ? 7 : task === 'chat' ? 10 : task === 'implement' ? 20 : 32;
		const sizeFit = 1 - Math.min(1, Math.abs(Math.log2(paramB / wantedSize)) / 3);
		reasons.push(`${paramB}B vs ~${wantedSize}B wanted for ${task}`);

		// Speed matters most for small tasks; quality for hard ones.
		const speedWeight = task === 'quick-edit' || task === 'chat' ? 0.4 : 0.15;
		const speed = stats && stats.tokensPerSecond > 0 ? Math.min(1, stats.tokensPerSecond / 60) : 0.5;
		if (stats && stats.tokensPerSecond > 0) {
			reasons.push(`${Math.round(stats.tokensPerSecond)} tok/s measured`);
		}

		// Agent tasks need reliable tool calling.
		const toolWeight = task === 'implement' || task === 'debug' ? 0.3 : 0.1;
		if (model.profile.toolCallQuality < 0.99) {
			reasons.push(`tool-call quality ${model.profile.toolCallQuality.toFixed(2)}`);
		}

		const acceptance = stats && stats.acceptSampleCount >= 3 ? stats.acceptRate : 0.5;
		if (stats && stats.acceptSampleCount >= 3) {
			reasons.push(`${Math.round(acceptance * 100)}% accept rate`);
		}

		const score =
			sizeFit * 0.35 +
			speed * speedWeight +
			model.profile.toolCallQuality * toolWeight +
			acceptance * 0.25;
		return { model, score, reasons };
	}
}

function lastUserMessageText(messages: readonly IChatMessage[]): string | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].role === ChatMessageRole.User) {
			const text = messages[i].content.filter(p => p.type === 'text').map(p => p.type === 'text' ? p.value : '').join('');
			if (text.trim()) {
				return text;
			}
		}
	}
	return undefined;
}
