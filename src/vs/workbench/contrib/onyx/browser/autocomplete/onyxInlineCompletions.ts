/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { ITextModel } from '../../../../../editor/common/model.js';
import { InlineCompletions, InlineCompletionsProvider } from '../../../../../editor/common/languages.js';
import { Position } from '../../../../../editor/common/core/position.js';
import { Range } from '../../../../../editor/common/core/range.js';
import { ILanguageFeaturesService } from '../../../../../editor/common/services/languageFeatures.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IOnyxRuntimeService } from '../../../../../platform/onyxRuntime/common/onyxRuntime.js';
import { OnyxSettingId } from '../../common/onyxConfiguration.js';
import { IOnyxKnownModel, IOnyxModelService } from '../model/onyxLanguageModelProvider.js';

const MAX_PREFIX_CHARS = 4000;
const MAX_SUFFIX_CHARS = 1500;
const MAX_COMPLETION_LINES = 6;

/**
 * Inline autocomplete from a local fill-in-the-middle model. Routing picks
 * the *smallest* discovered model by default — latency wins over depth for
 * ghost text — while the agent keeps using larger models. This is the
 * "different models for different jobs" principle applied to typing.
 */
export class OnyxInlineCompletionsContribution extends Disposable {

	static readonly ID = 'workbench.contrib.onyxInlineCompletions';

	constructor(
		@ILanguageFeaturesService languageFeaturesService: ILanguageFeaturesService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();
		const provider = this._register(instantiationService.createInstance(OnyxInlineCompletionsProvider));
		this._register(languageFeaturesService.inlineCompletionsProvider.register('*', provider));
	}
}

export class OnyxInlineCompletionsProvider extends Disposable implements InlineCompletionsProvider {

	readonly groupId = 'onyx';
	readonly displayName = 'Onyx';
	readonly debounceDelayMs = 180;

	constructor(
		@IOnyxRuntimeService private readonly _runtimeService: IOnyxRuntimeService,
		@IOnyxModelService private readonly _modelService: IOnyxModelService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();
	}

	async provideInlineCompletions(model: ITextModel, position: Position, _context: unknown, token: CancellationToken): Promise<InlineCompletions | undefined> {
		if (this._configurationService.getValue<boolean>(OnyxSettingId.AutocompleteEnabled) === false) {
			return undefined;
		}
		const target = this._pickModel();
		if (!target) {
			return undefined;
		}

		const prefix = model.getValueInRange(new Range(1, 1, position.lineNumber, position.column)).slice(-MAX_PREFIX_CHARS);
		const lastLine = model.getLineCount();
		const suffix = model.getValueInRange(new Range(position.lineNumber, position.column, lastLine, model.getLineMaxColumn(lastLine))).slice(0, MAX_SUFFIX_CHARS);
		if (!prefix.trim()) {
			return undefined;
		}

		const operationId = generateUuid();
		const cancelListener = token.onCancellationRequested(() => this._runtimeService.cancel(operationId));
		try {
			const text = await this._runtimeService.completeText(operationId, {
				baseUrl: target.discovered.baseUrl,
				apiKey: target.apiKey,
				model: target.discovered.id,
				prompt: prefix,
				suffix,
				maxTokens: 96,
				stop: ['\n\n\n'],
			});
			if (token.isCancellationRequested || !text) {
				this._logService.trace(`[onyx.autocomplete] no completion (cancelled=${token.isCancellationRequested})`);
				return undefined;
			}
			const insertText = postprocess(text);
			this._logService.trace(`[onyx.autocomplete] completion from ${target.discovered.id}: ${JSON.stringify(insertText.slice(0, 80))}`);
			if (!insertText) {
				return undefined;
			}
			// FIM models return only the continuation, so the edit range must be
			// the empty range at the cursor. Without it the engine defaults to
			// the current word's range and expects the completion to repeat the
			// typed word as a prefix, dropping every FIM result as invisible.
			const range = new Range(position.lineNumber, position.column, position.lineNumber, position.column);
			return { items: [{ insertText, range }], enableForwardStability: true };
		} finally {
			cancelListener.dispose();
		}
	}

	disposeInlineCompletions(): void {
		// completions hold no resources
	}

	private _pickModel(): IOnyxKnownModel | undefined {
		const models = this._modelService.getKnownModels();
		if (models.length === 0) {
			return undefined;
		}
		const configured = this._configurationService.getValue<string>(OnyxSettingId.AutocompleteModel);
		if (configured) {
			const match = models.find(m => m.key === configured || m.discovered.id === configured);
			if (match) {
				return match;
			}
		}
		// Smallest model wins: ghost text is latency-bound.
		return [...models].sort((a, b) => (a.profile.parameterB ?? 999) - (b.profile.parameterB ?? 999))[0];
	}
}

/** Trim runaway generations: cap the line count and drop trailing partial noise. */
function postprocess(text: string): string {
	const withoutCr = text.replace(/\r\n/g, '\n');
	const lines = withoutCr.split('\n').slice(0, MAX_COMPLETION_LINES);
	return lines.join('\n').trimEnd();
}
