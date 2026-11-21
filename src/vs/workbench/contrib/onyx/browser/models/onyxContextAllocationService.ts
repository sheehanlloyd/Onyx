/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { localize } from '../../../../../nls.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { contextAliasName } from '../../../../../platform/onyxRuntime/common/onyxContextAlias.js';
import { IOnyxDiscoveredModel, IOnyxRuntimeService } from '../../../../../platform/onyxRuntime/common/onyxRuntime.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { OnyxSettingId } from '../../common/onyxConfiguration.js';
import { allocationInForce, contextTarget, IOnyxAllocationRecord, IOnyxContextNumbersRecord, IOnyxContextTarget, judgeAllocation, removeAliasCommand } from '../../common/onyxContextAllocation.js';
import { OnyxProbesCancelledError, OnyxRuntimeProbeTransport, runAllocationCanary } from '../../common/onyxDatasheetProbes.js';

export const IOnyxContextAllocationService = createDecorator<IOnyxContextAllocationService>('onyxContextAllocationService');

export interface IOnyxAllocationTarget {
	/** The key profiles are kept under: `<host:port>/<modelId>`. */
	readonly modelKey: string;
	readonly discovered: IOnyxDiscoveredModel;
	readonly apiKey?: string;
}

/** What asking for a context came to. */
export type OnyxAllocationOutcome =
	| { readonly kind: 'recorded'; readonly record: IOnyxAllocationRecord }
	/** Nothing was asked of the runtime or of the user, and why. */
	| { readonly kind: 'nothing-to-request'; readonly reason: string }
	| { readonly kind: 'cancelled' };

/**
 * Context allocation (B15, R-61). Asks a runtime for the context a model can
 * use, with the user's consent, reads back what the runtime says, verifies
 * it with a probe, and keeps the result. The budget is given a context from
 * here only when it was verified; in every other case the server's own
 * allocation stays in force and this service says why.
 */
export interface IOnyxContextAllocationService {
	readonly _serviceBrand: undefined;
	/** Fires with a model's key when what is known about its context changes. */
	readonly onDidChange: Event<string>;
	/** Told what a discovery found, so that a record whose alias has gone is no longer in force. */
	noteListed(models: readonly IOnyxDiscoveredModel[]): void;
	/** Whatever is recorded for the model. */
	record(modelKey: string): IOnyxAllocationRecord | undefined;
	/** The record, when it is verified and still describes the model and the runtime as they are listed. */
	inForce(modelKey: string, discovered: IOnyxDiscoveredModel): (IOnyxAllocationRecord & { readonly alias: string; readonly verifiedTokens: number }) | undefined;
	/** The name requests for the model are sent to: the alias when a record is in force, the model's own id otherwise. */
	wireModel(modelKey: string, discovered: IOnyxDiscoveredModel): string;
	/** Requested, reported and verified, for a trace or a datasheet. All null when nothing is in force. */
	numbers(modelKey: string, discovered: IOnyxDiscoveredModel): IOnyxContextNumbersRecord;
	/** What would be asked for, and what bounds it. */
	target(discovered: IOnyxDiscoveredModel): Promise<IOnyxContextTarget>;
	/**
	 * Asks the user, and on a yes asks the runtime, reads the allocation
	 * back and verifies it. Without a yes nothing is created or changed.
	 */
	request(target: IOnyxAllocationTarget, token: CancellationToken): Promise<OnyxAllocationOutcome>;
	/** Removes the alias a record names and forgets the record. Returns the error when the runtime refused. */
	undo(modelKey: string, discovered: IOnyxDiscoveredModel): Promise<string | undefined>;
	/** Every record, for the diagnostics bundle. */
	exportAll(): Record<string, IOnyxAllocationRecord>;
}

const STORAGE_KEY = 'onyx.contextAllocations';

export class OnyxContextAllocationService extends Disposable implements IOnyxContextAllocationService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<string>());
	readonly onDidChange = this._onDidChange.event;

	private readonly _records: Map<string, IOnyxAllocationRecord>;
	/** The context aliases the last discovery of each runtime listed, by base URL. */
	private readonly _listed = new Map<string, Set<string>>();

	constructor(
		@IStorageService private readonly _storageService: IStorageService,
		@IOnyxRuntimeService private readonly _runtimeService: IOnyxRuntimeService,
		@IDialogService private readonly _dialogService: IDialogService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
	) {
		super();
		this._records = new Map(Object.entries(this._storageService.getObject<Record<string, IOnyxAllocationRecord>>(STORAGE_KEY, StorageScope.APPLICATION, {}))
			.filter(([, record]) => record?.version === 1 && typeof record.model === 'string'));
	}

	noteListed(models: readonly IOnyxDiscoveredModel[]): void {
		const next = new Map<string, Set<string>>();
		for (const model of models) {
			const aliases = next.get(model.baseUrl) ?? new Set<string>();
			if (model.contextAlias) {
				aliases.add(model.id);
			}
			next.set(model.baseUrl, aliases);
		}
		for (const [baseUrl, aliases] of next) {
			this._listed.set(baseUrl, aliases);
		}
	}

	record(modelKey: string): IOnyxAllocationRecord | undefined {
		return this._records.get(modelKey);
	}

	inForce(modelKey: string, discovered: IOnyxDiscoveredModel): (IOnyxAllocationRecord & { readonly alias: string; readonly verifiedTokens: number }) | undefined {
		const record = this._records.get(modelKey);
		return allocationInForce(record, discovered, [...(this._listed.get(discovered.baseUrl) ?? [])]) ? record : undefined;
	}

	wireModel(modelKey: string, discovered: IOnyxDiscoveredModel): string {
		return this.inForce(modelKey, discovered)?.alias ?? discovered.id;
	}

	numbers(modelKey: string, discovered: IOnyxDiscoveredModel): IOnyxContextNumbersRecord {
		const record = this.inForce(modelKey, discovered);
		return record
			? { requestedTokens: record.requestedTokens, reportedTokens: record.reportedTokens, verifiedTokens: record.verifiedTokens, mechanism: record.mechanism }
			: { requestedTokens: null, reportedTokens: discovered.serverContextLength ?? null, verifiedTokens: null, mechanism: null };
	}

	async target(discovered: IOnyxDiscoveredModel): Promise<IOnyxContextTarget> {
		const machine = await this._runtimeService.getMachineProfile();
		const setting = this._configurationService.getValue<number>(OnyxSettingId.ContextRequestTokens);
		return contextTarget({
			trainedTokens: discovered.contextLength,
			machineMemoryBytes: machine.totalMemoryBytes,
			modelBytes: discovered.sizeBytes,
			settingTokens: typeof setting === 'number' ? setting : undefined,
			currentTokens: await this._serverTokens(discovered, discovered.id),
		});
	}

	async request(target: IOnyxAllocationTarget, token: CancellationToken): Promise<OnyxAllocationOutcome> {
		const { discovered, modelKey } = target;
		if (discovered.runtime !== 'ollama') {
			return { kind: 'nothing-to-request', reason: localize('onyx.context.request.unsupported', "Onyx knows no way to ask this runtime for a context. Set the context length where the runtime loads the model (in LM Studio, the model's load settings); Onyx reads what the runtime reports and budgets against that.") };
		}
		if (discovered.contextAlias) {
			return { kind: 'nothing-to-request', reason: localize('onyx.context.request.isAlias', "{0} is itself a context alias.", discovered.id) };
		}
		const wanted = await this.target(discovered);
		if (wanted.tokens === undefined) {
			return { kind: 'nothing-to-request', reason: describeNoTarget(wanted, discovered) };
		}
		const previousTokens = await this._serverTokens(discovered, discovered.id);
		const alias = contextAliasName(discovered.id, wanted.tokens);
		const base = { version: 1 as const, model: discovered.id, digest: discovered.digest ?? null, runtime: { name: discovered.runtime, version: discovered.runtimeVersion ?? null }, previousTokens: previousTokens ?? null };

		// Consent first: the request creates a model on the user's runtime (B15, step 3).
		const consent = await this._dialogService.confirm({
			type: 'question',
			message: localize('onyx.context.consent.message', "Create a Model Alias on Ollama for a Larger Context?"),
			detail: [
				previousTokens !== undefined
					? localize('onyx.context.consent.now', "Ollama gives {0} a context of {1} tokens, and cuts a longer prompt without an error.", discovered.id, previousTokens)
					: localize('onyx.context.consent.nowUnknown', "Ollama gives {0} its default context, and cuts a longer prompt without an error.", discovered.id),
				localize('onyx.context.consent.what', "Onyx can ask Ollama to create a second model name, {0}, over the same weights, with a context of {1} tokens. It adds a few bytes of settings and no second copy of the weights, and it shows up in `ollama list`.", alias, wanted.tokens),
				localize('onyx.context.consent.memory', "A larger context uses more memory while the model is loaded. The number is the smallest of what the model was trained with ({0}), a ceiling from this machine's memory ({1}) and the setting onyx.context.requestTokens.", discovered.contextLength ?? 0, wanted.memoryCeilingTokens ?? 0),
				localize('onyx.context.consent.verify', "Onyx then checks that the larger context really works before it uses it. If it does not, the alias is removed again and nothing else changes."),
				localize('onyx.context.consent.undo', "Undo at any time with the command \"Onyx: Remove Model Context Alias\", or in a terminal: {0}", removeAliasCommand(alias)),
			].join('\n\n'),
			primaryButton: localize('onyx.context.consent.create', "Create Alias"),
			cancelButton: localize('onyx.context.consent.keep', "Keep the Server's Allocation"),
		});
		if (!consent.confirmed) {
			return { kind: 'recorded', record: this._keep(modelKey, { ...base, status: 'declined', mechanism: null, alias: null, requestedTokens: wanted.tokens, reportedTokens: null, verifiedTokens: null, cutObserved: false, steps: [], decidedAt: new Date().toISOString() }) };
		}
		if (token.isCancellationRequested) {
			return { kind: 'cancelled' };
		}

		const created = await this._runtimeService.createContextAlias(discovered.baseUrl, discovered.id, wanted.tokens);
		if (!created.ok) {
			// The runtime refused: the request was not honoured, and nothing of Onyx's is left on it.
			return { kind: 'recorded', record: this._keep(modelKey, { ...base, status: 'ignored', mechanism: 'derived-model', alias: null, requestedTokens: wanted.tokens, reportedTokens: previousTokens ?? null, verifiedTokens: null, cutObserved: false, steps: [], decidedAt: new Date().toISOString() }) };
		}
		this._listedFor(discovered.baseUrl).add(created.alias);

		const transport = new OnyxRuntimeProbeTransport(this._runtimeService, { baseUrl: discovered.baseUrl, apiKey: target.apiKey, model: created.alias }, `onyx-context-${generateUuid()}`);
		let probe: Awaited<ReturnType<typeof runAllocationCanary>>;
		try {
			probe = await runAllocationCanary(async request => {
				const reply = await transport.send(request, token);
				if (token.isCancellationRequested || reply.ending === 'cancelled') {
					throw new OnyxProbesCancelledError();
				}
				return reply;
			}, { requestedTokens: wanted.tokens, previousTokens, readReportedTokens: () => this._serverTokens(discovered, created.alias) });
		} catch (error) {
			// Interrupted before anything was learned: what was created is taken away again.
			await this._discard(discovered.baseUrl, created.alias);
			if (error instanceof OnyxProbesCancelledError) {
				return { kind: 'cancelled' };
			}
			throw error;
		}
		const verdict = judgeAllocation({ requestedTokens: wanted.tokens, reportedTokens: probe.reportedTokens, previousTokens, steps: probe.steps });
		if (verdict.status !== 'verified') {
			// An alias that did not give the model a larger context is of no use to anyone.
			await this._discard(discovered.baseUrl, created.alias);
		}
		return {
			kind: 'recorded',
			record: this._keep(modelKey, {
				...base, status: verdict.status, mechanism: 'derived-model', alias: verdict.status === 'verified' ? created.alias : null,
				requestedTokens: wanted.tokens, reportedTokens: probe.reportedTokens ?? null, verifiedTokens: verdict.verifiedTokens, cutObserved: verdict.cutObserved, steps: probe.steps, decidedAt: new Date().toISOString(),
			}),
		};
	}

	async undo(modelKey: string, discovered: IOnyxDiscoveredModel): Promise<string | undefined> {
		const record = this._records.get(modelKey);
		if (record?.alias) {
			const removed = await this._runtimeService.removeContextAlias(discovered.baseUrl, record.alias);
			// An alias that is already gone is as undone as one that was just removed.
			if (!removed.ok && this._listedFor(discovered.baseUrl).has(record.alias) && !/404|not found/i.test(removed.error)) {
				return removed.error;
			}
			this._listedFor(discovered.baseUrl).delete(record.alias);
		}
		if (record) {
			this._records.delete(modelKey);
			this._persist();
			this._onDidChange.fire(modelKey);
		}
		return undefined;
	}

	exportAll(): Record<string, IOnyxAllocationRecord> {
		return Object.fromEntries(this._records);
	}

	private _listedFor(baseUrl: string): Set<string> {
		let aliases = this._listed.get(baseUrl);
		if (!aliases) {
			aliases = new Set<string>();
			this._listed.set(baseUrl, aliases);
		}
		return aliases;
	}

	private async _discard(baseUrl: string, alias: string): Promise<void> {
		await this._runtimeService.removeContextAlias(baseUrl, alias);
		this._listedFor(baseUrl).delete(alias);
	}

	/** What the server says it allocated for a name: read from the loaded model when it is loaded, from its parameters otherwise. */
	private async _serverTokens(discovered: IOnyxDiscoveredModel, name: string): Promise<number | undefined> {
		try {
			const loaded = (await this._runtimeService.listLoadedModels(discovered.baseUrl))?.find(model => model.id === name)?.contextLength;
			if (loaded !== undefined) {
				return loaded;
			}
		} catch {
			// the runtime did not say
		}
		return name === discovered.id ? discovered.serverContextLength : undefined;
	}

	private _keep(modelKey: string, record: IOnyxAllocationRecord): IOnyxAllocationRecord {
		this._records.set(modelKey, record);
		this._persist();
		this._onDidChange.fire(modelKey);
		return record;
	}

	private _persist(): void {
		this._storageService.store(STORAGE_KEY, JSON.stringify(Object.fromEntries(this._records)), StorageScope.APPLICATION, StorageTarget.MACHINE);
	}
}

function describeNoTarget(target: IOnyxContextTarget, discovered: IOnyxDiscoveredModel): string {
	switch (target.reason) {
		case 'trained-unknown': return localize('onyx.context.noTarget.trained', "The runtime does not say what context {0} was trained with, and Onyx does not ask for more than that.", discovered.id);
		case 'kept-by-setting': return localize('onyx.context.noTarget.setting', "onyx.context.requestTokens is 0: the server's allocation is kept.");
		case 'no-room': return localize('onyx.context.noTarget.room', "This machine's memory leaves no room for a larger context for {0}.", discovered.id);
		default: return localize('onyx.context.noTarget.gain', "The server already gives {0} as much context as Onyx would ask for.", discovered.id);
	}
}
