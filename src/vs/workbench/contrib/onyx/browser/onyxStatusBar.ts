/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { autorun } from '../../../../base/common/observable.js';
import { localize } from '../../../../nls.js';
import { IStatusbarEntry, IStatusbarEntryAccessor, IStatusbarService, StatusbarAlignment } from '../../../services/statusbar/browser/statusbar.js';
import { IOnyxControlPlaneService } from './controlPlane/onyxControlPlaneService.js';
import { IOnyxModelService } from './model/onyxLanguageModelProvider.js';

/**
 * Always-visible Onyx presence in the status bar: how many local models are
 * available, and live generation throughput while a request is in flight.
 * Clicking opens the control plane.
 */
export class OnyxStatusBarContribution extends Disposable {

	static readonly ID = 'workbench.contrib.onyxStatusBar';

	private readonly _entry: IStatusbarEntryAccessor;

	constructor(
		@IStatusbarService statusbarService: IStatusbarService,
		@IOnyxControlPlaneService private readonly _controlPlaneService: IOnyxControlPlaneService,
		@IOnyxModelService private readonly _modelService: IOnyxModelService,
	) {
		super();
		this._entry = this._register(statusbarService.addEntry(this._props(), 'onyx.status', StatusbarAlignment.RIGHT, 100));
		this._register(autorun(reader => {
			this._controlPlaneService.compute.read(reader);
			this._entry.update(this._props());
		}));
		this._register(this._modelService.onDidChangeModels(() => this._entry.update(this._props())));
	}

	private _props(): IStatusbarEntry {
		const compute = this._controlPlaneService.compute.get();
		const modelCount = this._modelService.getKnownModels().length;
		const text = compute.inFlight
			? `$(pulse) ${compute.tokensPerSecond !== undefined ? `${Math.round(compute.tokensPerSecond)} tok/s` : localize('onyx.status.generating', "generating…")}`
			: `$(pulse) Onyx`;
		const tooltip = modelCount === 0
			? localize('onyx.status.noModels', "Onyx — no local models found. Start Ollama, LM Studio, llama.cpp or vLLM.")
			: localize('onyx.status.models', "Onyx — {0} local models ready. Click to open the control plane.", modelCount);
		return {
			name: localize('onyx.status.name', "Onyx"),
			text,
			ariaLabel: tooltip,
			tooltip,
			command: 'onyx.openControlPlane',
		};
	}
}
