/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RunOnceScheduler } from '../../../../../base/common/async.js';
import { Disposable, DisposableMap } from '../../../../../base/common/lifecycle.js';
import { IObservable, ISettableObservable, observableValue } from '../../../../../base/common/observable.js';
import { joinPath } from '../../../../../base/common/resources.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { Extensions as JSONExtensions, IJSONContributionRegistry } from '../../../../../platform/jsonschemas/common/jsonContributionRegistry.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IOnyxProjectConfig, ONYX_PROJECT_CONFIG_PATH, ONYX_PROJECT_CONFIG_SCHEMA, ONYX_PROJECT_CONFIG_SCHEMA_ID, parseProjectConfig } from '../../common/onyxProjectConfig.js';

export const IOnyxProjectConfigService = createDecorator<IOnyxProjectConfigService>('onyxProjectConfigService');

/** The merged project config plus where each part came from, for the effective-values view. */
export interface IOnyxResolvedProjectConfig {
	readonly config: IOnyxProjectConfig;
	/** Folder names that contributed configuration, in precedence order. */
	readonly sources: readonly string[];
	readonly problems: readonly string[];
}

/**
 * Loads and watches `.onyx/config.json` in every workspace root. The file is
 * the repository's voice in Onyx's decisions — model pins, disabled tools,
 * the verification task — and always ranks below the user's own settings.
 * Multi-root: earlier folders win per key, which matches how the workspace
 * file orders roots.
 */
export interface IOnyxProjectConfigService {
	readonly _serviceBrand: undefined;
	readonly resolved: IObservable<IOnyxResolvedProjectConfig>;
}

const EMPTY: IOnyxResolvedProjectConfig = { config: {}, sources: [], problems: [] };

export class OnyxProjectConfigService extends Disposable implements IOnyxProjectConfigService {

	declare readonly _serviceBrand: undefined;

	private readonly _resolved: ISettableObservable<IOnyxResolvedProjectConfig> = observableValue(this, EMPTY);
	private readonly _watchers = this._register(new DisposableMap<string>());
	private readonly _reloadScheduler: RunOnceScheduler;

	constructor(
		@IFileService private readonly _fileService: IFileService,
		@IWorkspaceContextService private readonly _workspaceService: IWorkspaceContextService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();

		const registry = Registry.as<IJSONContributionRegistry>(JSONExtensions.JSONContribution);
		registry.registerSchema(ONYX_PROJECT_CONFIG_SCHEMA_ID, ONYX_PROJECT_CONFIG_SCHEMA);
		this._register(registry.registerSchemaAssociation(ONYX_PROJECT_CONFIG_SCHEMA_ID, `**/${ONYX_PROJECT_CONFIG_PATH}`));

		this._reloadScheduler = this._register(new RunOnceScheduler(() => this._reload(), 300));
		this._register(this._workspaceService.onDidChangeWorkspaceFolders(() => this._watchAll()));
		this._watchAll();
	}

	get resolved(): IObservable<IOnyxResolvedProjectConfig> { return this._resolved; }

	private _watchAll(): void {
		this._watchers.clearAndDisposeAll();
		for (const folder of this._workspaceService.getWorkspace().folders) {
			const configUri = joinPath(folder.uri, ONYX_PROJECT_CONFIG_PATH);
			const watcher = this._fileService.createWatcher(configUri, { recursive: false, excludes: [] });
			const listener = watcher.onDidChange(() => this._reloadScheduler.schedule());
			this._watchers.set(folder.uri.toString(), { dispose: () => { listener.dispose(); watcher.dispose(); } });
		}
		this._reloadScheduler.schedule();
	}

	private async _reload(): Promise<void> {
		const folders = this._workspaceService.getWorkspace().folders;
		const merged: Record<string, unknown> = {};
		const sources: string[] = [];
		const problems: string[] = [];
		for (const folder of folders) {
			const configUri = joinPath(folder.uri, ONYX_PROJECT_CONFIG_PATH);
			let content: string;
			try {
				content = (await this._fileService.readFile(configUri)).value.toString();
			} catch {
				continue; // no config in this root
			}
			const parsed = parseProjectConfig(content);
			problems.push(...parsed.problems.map(problem => `${folder.name}/${ONYX_PROJECT_CONFIG_PATH}: ${problem}`));
			if (Object.keys(parsed.config).length > 0) {
				sources.push(folder.name);
				// Earlier folders win per key.
				for (const [key, value] of Object.entries(parsed.config)) {
					if (merged[key] === undefined) {
						merged[key] = value;
					}
				}
			}
		}
		if (problems.length > 0) {
			this._logService.warn(`[onyx] project config problems: ${problems.join('; ')}`);
		}
		this._resolved.set({ config: merged as IOnyxProjectConfig, sources, problems }, undefined);
	}
}
