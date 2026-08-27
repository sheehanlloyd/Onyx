/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { raceTimeout } from '../../../../../base/common/async.js';
import { localize } from '../../../../../nls.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { INotificationService, Severity } from '../../../../../platform/notification/common/notification.js';
import { IProgressService, ProgressLocation } from '../../../../../platform/progress/common/progress.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { ChatMessageRole } from '../../../chat/common/languageModels.js';
import { ONYX_VENDOR } from '../../common/onyxTypes.js';
import { IOnyxKnownModel, IOnyxModelService, IOnyxRequestMeasurement } from '../model/onyxLanguageModelProvider.js';

const REQUEST_TIMEOUT_MS = 60_000;

interface IBenchmarkResult {
	readonly model: IOnyxKnownModel;
	readonly tokensPerSecond: number | undefined;
	readonly timeToFirstTokenMs: number | undefined;
	readonly toolCallOk: boolean | undefined;
	readonly error?: string;
}

/**
 * Benchmarks every discovered local model **on this machine**: measured
 * throughput, time to first token, and whether the model emits a well-formed
 * tool call when asked to. Results flow into the profile stats the router
 * uses, so `Auto` routing improves from real evidence rather than model-card
 * claims.
 */
export class OnyxBenchmark {

	constructor(
		@IOnyxModelService private readonly _modelService: IOnyxModelService,
		@IProgressService private readonly _progressService: IProgressService,
		@IQuickInputService private readonly _quickInputService: IQuickInputService,
		@INotificationService private readonly _notificationService: INotificationService,
		@ILogService private readonly _logService: ILogService,
	) { }

	async run(): Promise<void> {
		await this._modelService.refresh();
		const models = this._modelService.getKnownModels();
		if (models.length === 0) {
			this._notificationService.notify({ severity: Severity.Info, message: localize('onyx.benchmark.noModels', "No local models to benchmark. Start a local runtime first.") });
			return;
		}

		const results: IBenchmarkResult[] = [];
		await this._progressService.withProgress(
			{ location: ProgressLocation.Notification, title: localize('onyx.benchmark.title', "Onyx: benchmarking local models"), cancellable: true },
			async progress => {
				for (let i = 0; i < models.length; i++) {
					const model = models[i];
					progress.report({ message: localize('onyx.benchmark.progress', "{0} ({1}/{2})", model.discovered.id, i + 1, models.length) });
					results.push(await this._benchmarkModel(model));
				}
			});

		await this._showResults(results);
	}

	private async _benchmarkModel(model: IOnyxKnownModel): Promise<IBenchmarkResult> {
		let generation: IOnyxRequestMeasurement | undefined;
		let toolCallOk: boolean | undefined;
		try {
			generation = await this._request(model, 'Reply with a single short sentence describing what a hash map is.', false);
			const toolMeasurement = await this._request(model, 'TOOLTEST: call the report_answer tool with answer set to "ok". Use the tool, do not reply with text.', true);
			toolCallOk = toolMeasurement.toolCallCount > 0 && toolMeasurement.toolCallParseFailures === 0;
		} catch (err) {
			this._logService.warn(`[onyx] benchmark failed for ${model.key}`, err);
			return { model, tokensPerSecond: generation?.tokensPerSecond, timeToFirstTokenMs: generation?.timeToFirstTokenMs, toolCallOk, error: err instanceof Error ? err.message : String(err) };
		}
		return { model, tokensPerSecond: generation.tokensPerSecond, timeToFirstTokenMs: generation.timeToFirstTokenMs, toolCallOk };
	}

	/** Sends one request directly through the provider and returns its measurement. */
	private async _request(model: IOnyxKnownModel, prompt: string, withTool: boolean): Promise<IOnyxRequestMeasurement> {
		const cts = new CancellationTokenSource();
		const measured = new Promise<IOnyxRequestMeasurement>(resolve => {
			const listener = this._modelService.onDidMeasureRequest(measurement => {
				if (measurement.modelKey === model.key) {
					listener.dispose();
					resolve(measurement);
				}
			});
		});

		try {
			const response = await this._modelService.sendChatRequest(
				`${ONYX_VENDOR}:${model.key}`,
				[{ role: ChatMessageRole.User, content: [{ type: 'text', value: prompt }] }],
				undefined,
				withTool ? {
					tools: [{
						name: 'report_answer',
						description: 'Report the final answer.',
						inputSchema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] },
					}],
				} : {},
				cts.token);
			// Drain the stream; measurements fire on completion. Cancel models
			// that run away past the benchmark timeout.
			const drained = (async () => {
				for await (const _part of response.stream) { /* drain */ }
				await response.result;
			})();
			await raceTimeout(drained, REQUEST_TIMEOUT_MS, () => cts.cancel());
		} finally {
			cts.dispose(true);
		}

		const measurement = await raceTimeout(measured, 5000);
		if (!measurement) {
			throw new Error('No measurement was recorded for the benchmark request.');
		}
		return measurement;
	}

	private async _showResults(results: IBenchmarkResult[]): Promise<void> {
		await this._quickInputService.pick(results.map(result => ({
			label: result.model.discovered.id,
			description: result.error
				? localize('onyx.benchmark.failed', "failed: {0}", result.error)
				: `${result.tokensPerSecond !== undefined ? `${Math.round(result.tokensPerSecond)} tok/s` : '—'} · ${result.timeToFirstTokenMs !== undefined ? `${(result.timeToFirstTokenMs / 1000).toFixed(2)}s TTFT` : '—'} · ${toolLabel(result.toolCallOk)}`,
			detail: `${result.model.discovered.baseUrl} · ${result.model.profile.parameterB ? `${result.model.profile.parameterB}B` : ''} ${result.model.discovered.quantization ?? ''}`,
		})), { placeHolder: localize('onyx.benchmark.results', "Benchmark results (recorded into routing profiles)") });
	}
}

function toolLabel(ok: boolean | undefined): string {
	if (ok === undefined) {
		return localize('onyx.benchmark.toolUnknown', "tools untested");
	}
	return ok ? localize('onyx.benchmark.toolOk', "tool calls ✓") : localize('onyx.benchmark.toolBad', "tool calls ✗");
}
