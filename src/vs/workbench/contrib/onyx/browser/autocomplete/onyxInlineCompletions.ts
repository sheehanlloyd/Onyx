/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { Schemas } from '../../../../../base/common/network.js';
import { URI } from '../../../../../base/common/uri.js';
import { ITextModel } from '../../../../../editor/common/model.js';
import { InlineCompletions, InlineCompletionsProvider } from '../../../../../editor/common/languages.js';
import { ILanguageConfigurationService } from '../../../../../editor/common/languages/languageConfigurationRegistry.js';
import { Position } from '../../../../../editor/common/core/position.js';
import { Range } from '../../../../../editor/common/core/range.js';
import { ILanguageFeaturesService } from '../../../../../editor/common/services/languageFeatures.js';
import { IModelService } from '../../../../../editor/common/services/model.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IOnyxRuntimeService } from '../../../../../platform/onyxRuntime/common/onyxRuntime.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { OnyxSettingId } from '../../common/onyxConfiguration.js';
import { IOnyxEnergyService } from '../compute/onyxEnergyService.js';
import { IOnyxObservedStats } from '../../common/onyxTypes.js';
import { resolveWorkspacePath } from '../../common/onyxWorkspacePaths.js';
import { OnyxContextRanker } from '../intelligence/onyxContextRanker.js';
import { IOnyxKnownModel, IOnyxModelService } from '../model/onyxLanguageModelProvider.js';
import { IOnyxProfileService } from '../profiles/onyxProfileService.js';

/**
 * Ghost text belongs in documents the user is editing. The provider is
 * registered for every language, so embedded Monaco editors that happen to
 * share a language (the chat input, rename boxes, settings widgets) would
 * otherwise get completions too.
 */
const COMPLETABLE_SCHEMES: readonly string[] = [Schemas.file, Schemas.untitled, Schemas.vscodeRemote, Schemas.vscodeNotebookCell];

const MAX_PREFIX_CHARS = 4000;
const MAX_SUFFIX_CHARS = 1500;
const MAX_COMPLETION_LINES = 6;
const MAX_CONTEXT_FILES = 2;
const MAX_CONTEXT_LINES_PER_FILE = 24;
const MAX_CONTEXT_CHARS = 1200;

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

	/** Base debounce plus whatever the energy policy adds on battery / heat. */
	get debounceDelayMs(): number {
		return 180 + this._energyService.decision.get().autocompleteExtraDebounceMs;
	}

	private readonly _contextRanker: OnyxContextRanker;

	constructor(
		@IOnyxRuntimeService private readonly _runtimeService: IOnyxRuntimeService,
		@IOnyxModelService private readonly _modelService: IOnyxModelService,
		@IOnyxProfileService private readonly _profileService: IOnyxProfileService,
		@IOnyxEnergyService private readonly _energyService: IOnyxEnergyService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IModelService private readonly _textModelService: IModelService,
		@ILanguageConfigurationService private readonly _languageConfigurationService: ILanguageConfigurationService,
		@IWorkspaceContextService private readonly _workspaceService: IWorkspaceContextService,
		@ILogService private readonly _logService: ILogService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();
		this._contextRanker = instantiationService.createInstance(OnyxContextRanker);
	}

	async provideInlineCompletions(model: ITextModel, position: Position, _context: unknown, token: CancellationToken): Promise<InlineCompletions | undefined> {
		if (this._configurationService.getValue<boolean>(OnyxSettingId.AutocompleteEnabled) === false) {
			return undefined;
		}
		if (!this._energyService.decision.get().autocompleteEnabled) {
			// The energy policy switched ghost text off (e.g. efficiency mode on
			// battery); the Compute view carries the explanation.
			return undefined;
		}
		if (!COMPLETABLE_SCHEMES.includes(model.uri.scheme)) {
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

		const contextHeader = await this._contextHeader(model);
		if (token.isCancellationRequested) {
			return undefined;
		}

		const operationId = generateUuid();
		const cancelListener = token.onCancellationRequested(() => this._runtimeService.cancel(operationId));
		const startedAt = Date.now();
		try {
			const text = await this._runtimeService.completeText(operationId, {
				baseUrl: target.discovered.baseUrl,
				apiKey: target.apiKey,
				model: target.discovered.id,
				prompt: contextHeader + prefix,
				suffix,
				maxTokens: 96,
				stop: ['\n\n\n'],
				// The autocomplete model fires constantly; keep it resident.
				keepAlive: target.discovered.runtime === 'ollama' ? '30m' : undefined,
			});
			if (!token.isCancellationRequested && text) {
				// Cancelled requests would skew the number low (they abort early),
				// so only completed round trips feed the latency profile.
				this._profileService.reportFimMeasurement(target.key, Date.now() - startedAt);
			}
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

	/**
	 * Task-aware context for the FIM prompt: the top-ranked *other* open files
	 * (already-loaded text models only — this runs on every completion, so no
	 * disk or git round trips), rendered as line comments the model can read
	 * but is unlikely to echo. Empty when disabled or the language has no
	 * line-comment syntax.
	 */
	private async _contextHeader(model: ITextModel): Promise<string> {
		if (this._configurationService.getValue<boolean>(OnyxSettingId.AutocompleteContext) === false) {
			return '';
		}
		const lineComment = this._languageConfigurationService.getLanguageConfiguration(model.getLanguageId()).comments?.lineCommentToken;
		const folders = this._workspaceService.getWorkspace().folders;
		if (!lineComment || folders.length === 0) {
			return '';
		}
		const folderRefs = folders.map(f => ({ name: f.name, index: f.index }));
		const ranked = await this._contextRanker.rank(MAX_CONTEXT_FILES + 2, { gitRecency: false });
		const sections: { path: string; content: string }[] = [];
		for (const file of ranked) {
			if (sections.length >= MAX_CONTEXT_FILES) {
				break;
			}
			const resolved = resolveWorkspacePath(folderRefs, file.path);
			const resolvedFolder = resolved ? folders.find(f => f.index === resolved.folderIndex) : undefined;
			if (!resolved || !resolvedFolder) {
				continue;
			}
			const uri = URI.joinPath(resolvedFolder.uri, resolved.relativePath);
			if (uri.toString() === model.uri.toString()) {
				continue;
			}
			const other = this._textModelService.getModel(uri);
			if (!other) {
				continue; // only files already open — never load from disk here
			}
			const lineCount = Math.min(other.getLineCount(), MAX_CONTEXT_LINES_PER_FILE);
			const content = other.getValueInRange(new Range(1, 1, lineCount, other.getLineMaxColumn(lineCount)));
			sections.push({ path: file.path, content });
		}
		return buildFimContextHeader(sections, lineComment, MAX_CONTEXT_CHARS);
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
		return pickFimModel(models, key => this._profileService.getStats(key));
	}
}

/**
 * Renders cross-file context as a commented block prepended to the FIM
 * prefix. Every line is commented so the model treats it as background, and
 * the whole block is capped so context can never crowd out the actual prefix.
 */
export function buildFimContextHeader(sections: readonly { readonly path: string; readonly content: string }[], lineComment: string, maxChars: number): string {
	const lines: string[] = [];
	let used = 0;
	for (const section of sections) {
		const header = `${lineComment} Context from ${section.path}:`;
		if (used + header.length > maxChars) {
			break;
		}
		lines.push(header);
		used += header.length;
		for (const raw of section.content.split('\n')) {
			const line = `${lineComment} ${raw}`;
			if (used + line.length > maxChars) {
				break;
			}
			lines.push(line);
			used += line.length;
		}
	}
	return lines.length ? `${lines.join('\n')}\n\n` : '';
}

/** How many completions a model must have served before its measured latency outranks size. */
const FIM_LATENCY_MIN_SAMPLES = 5;

/**
 * Ghost text is latency-bound, so the smallest model is the default guess —
 * but once models have actually served completions on this machine, the
 * measured end-to-end latency is the better signal and wins.
 */
export function pickFimModel(models: readonly IOnyxKnownModel[], statsFor: (modelKey: string) => IOnyxObservedStats | undefined): IOnyxKnownModel | undefined {
	if (models.length === 0) {
		return undefined;
	}
	const measured = models
		.map(model => ({ model, stats: statsFor(model.key) }))
		.filter(entry => !!entry.stats && entry.stats.fimSampleCount >= FIM_LATENCY_MIN_SAMPLES && entry.stats.fimLatencyMs > 0);
	if (measured.length > 0) {
		measured.sort((a, b) => a.stats!.fimLatencyMs - b.stats!.fimLatencyMs);
		return measured[0].model;
	}
	return [...models].sort((a, b) => (a.profile.parameterB ?? 999) - (b.profile.parameterB ?? 999))[0];
}

/** Trim runaway generations: cap the line count and drop trailing partial noise. */
function postprocess(text: string): string {
	const withoutCr = text.replace(/\r\n/g, '\n');
	const lines = withoutCr.split('\n').slice(0, MAX_COMPLETION_LINES);
	return lines.join('\n').trimEnd();
}
