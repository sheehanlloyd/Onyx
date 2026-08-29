/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RunOnceScheduler } from '../../../../../base/common/async.js';
import { Disposable, DisposableMap } from '../../../../../base/common/lifecycle.js';
import { IObservable, ISettableObservable, observableValue } from '../../../../../base/common/observable.js';
import { joinPath } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { IMarkerService, MarkerSeverity } from '../../../../../platform/markers/common/markers.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IOnyxPlaybook, parsePlaybook } from '../../common/onyxPlaybooks.js';

export const IOnyxPlaybookService = createDecorator<IOnyxPlaybookService>('onyxPlaybookService');

export const ONYX_PLAYBOOKS_DIR = '.onyx/playbooks';
const RELOAD_DELAY_MS = 300;
const MAX_PLAYBOOK_BYTES = 64 * 1024;
const MARKER_OWNER = 'onyx-playbooks';

export interface IOnyxDiscoveredPlaybook {
	readonly playbook: IOnyxPlaybook;
	readonly uri: URI;
}

/**
 * Discovers and watches the repository's playbooks. Files with problems are
 * surfaced twice: as Problems-panel markers on the file itself, and by being
 * absent from the usable list — a half-parsed recipe is never handed to the
 * agent.
 */
export interface IOnyxPlaybookService {
	readonly _serviceBrand: undefined;
	readonly playbooks: IObservable<readonly IOnyxDiscoveredPlaybook[]>;
	getPlaybook(name: string): IOnyxDiscoveredPlaybook | undefined;
}

export class OnyxPlaybookService extends Disposable implements IOnyxPlaybookService {

	declare readonly _serviceBrand: undefined;

	private readonly _playbooksObs: ISettableObservable<readonly IOnyxDiscoveredPlaybook[]> = observableValue(this, []);
	readonly playbooks: IObservable<readonly IOnyxDiscoveredPlaybook[]> = this._playbooksObs;

	private readonly _watchers = this._register(new DisposableMap<string>());
	private readonly _reloadScheduler: RunOnceScheduler;

	constructor(
		@IWorkspaceContextService private readonly _workspaceService: IWorkspaceContextService,
		@IFileService private readonly _fileService: IFileService,
		@IMarkerService private readonly _markerService: IMarkerService,
	) {
		super();
		this._reloadScheduler = this._register(new RunOnceScheduler(() => this._reload(), RELOAD_DELAY_MS));
		this._register(this._workspaceService.onDidChangeWorkspaceFolders(() => this._watchAll()));
		this._watchAll();
	}

	getPlaybook(name: string): IOnyxDiscoveredPlaybook | undefined {
		return this._playbooksObs.get().find(entry => entry.playbook.name === name);
	}

	private _watchAll(): void {
		this._watchers.clearAndDisposeAll();
		for (const folder of this._workspaceService.getWorkspace().folders) {
			const dirUri = joinPath(folder.uri, ONYX_PLAYBOOKS_DIR);
			const watcher = this._fileService.createWatcher(dirUri, { recursive: false, excludes: [] });
			const listener = watcher.onDidChange(() => this._reloadScheduler.schedule());
			this._watchers.set(folder.uri.toString(), { dispose: () => { listener.dispose(); watcher.dispose(); } });
		}
		this._reloadScheduler.schedule();
	}

	private async _reload(): Promise<void> {
		const discovered: IOnyxDiscoveredPlaybook[] = [];
		const seenNames = new Set<string>();
		this._markerService.changeAll(MARKER_OWNER, []);
		for (const folder of this._workspaceService.getWorkspace().folders) {
			const dirUri = joinPath(folder.uri, ONYX_PLAYBOOKS_DIR);
			let entries;
			try {
				entries = (await this._fileService.resolve(dirUri)).children ?? [];
			} catch {
				continue; // no playbooks directory in this root
			}
			for (const entry of entries) {
				if (entry.isDirectory || !entry.name.endsWith('.md')) {
					continue;
				}
				try {
					const content = await this._fileService.readFile(entry.resource, { limits: { size: MAX_PLAYBOOK_BYTES } });
					const parsed = parsePlaybook(content.value.toString());
					if (parsed.problems.length > 0) {
						this._markerService.changeOne(MARKER_OWNER, entry.resource, parsed.problems.map(problem => ({
							severity: parsed.playbook ? MarkerSeverity.Warning : MarkerSeverity.Error,
							message: localize('onyx.playbook.problem', "Onyx playbook: {0}", problem),
							startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 4,
						})));
					}
					if (parsed.playbook) {
						if (seenNames.has(parsed.playbook.name)) {
							this._markerService.changeOne(MARKER_OWNER, entry.resource, [{
								severity: MarkerSeverity.Error,
								message: localize('onyx.playbook.duplicate', "Onyx playbook: a playbook named \"{0}\" already exists", parsed.playbook.name),
								startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 4,
							}]);
							continue;
						}
						seenNames.add(parsed.playbook.name);
						discovered.push({ playbook: parsed.playbook, uri: entry.resource });
					}
				} catch {
					// unreadable file: skip; the watcher will retry on the next change
				}
			}
		}
		discovered.sort((a, b) => a.playbook.name.localeCompare(b.playbook.name));
		this._playbooksObs.set(discovered, undefined);
	}
}
