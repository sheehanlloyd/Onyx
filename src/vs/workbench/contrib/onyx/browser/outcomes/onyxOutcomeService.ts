/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Sequencer } from '../../../../../base/common/async.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { joinPath } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IWorkbenchEnvironmentService } from '../../../../services/environment/common/environmentService.js';
import { IOnyxRequestRecord, IOnyxRunEvent, IOnyxRunSummary } from '../../common/onyxTypes.js';
import { IOnyxControlPlaneService } from '../controlPlane/onyxControlPlaneService.js';

export const IOnyxOutcomeService = createDecorator<IOnyxOutcomeService>('onyxOutcomeService');

/**
 * Persists every agent run to a local, per-workspace journal so the control
 * plane's history survives window reloads and past runs can be replayed in
 * the inspector. Layout (all under the workspace storage home, never synced):
 *
 *     onyx/journal/index.json      — array of IOnyxRunSummary, newest first
 *     onyx/journal/runs/<id>.jsonl — one event per line
 */
export interface IOnyxOutcomeService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeRuns: Event<void>;
	listRuns(): Promise<readonly IOnyxRunSummary[]>;
	readRun(runId: string): Promise<IOnyxRequestRecord | undefined>;
}

const MAX_PERSISTED_RUNS = 200;

export class OnyxOutcomeService extends Disposable implements IOnyxOutcomeService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeRuns = this._register(new Emitter<void>());
	readonly onDidChangeRuns = this._onDidChangeRuns.event;

	private readonly _writeSequencer = new Sequencer();
	private _index: IOnyxRunSummary[] | undefined;

	constructor(
		@IOnyxControlPlaneService private readonly _controlPlaneService: IOnyxControlPlaneService,
		@IFileService private readonly _fileService: IFileService,
		@IWorkbenchEnvironmentService private readonly _environmentService: IWorkbenchEnvironmentService,
		@IWorkspaceContextService private readonly _workspaceService: IWorkspaceContextService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();

		this._register(this._controlPlaneService.onDidBeginRun(run => {
			this._enqueue(async () => {
				const index = await this._loadIndex();
				index.unshift({
					runId: run.runId,
					startedAt: run.startedAt,
					title: run.title,
					task: run.task,
					modelKey: run.modelKey,
					status: 'running',
					turnCount: 0,
					toolCallCount: 0,
				});
				await this._pruneAndSaveIndex(index);
			});
		}));

		this._register(this._controlPlaneService.onDidRecordEvent(({ runId, event }) => {
			this._enqueue(async () => {
				await this._appendEvent(runId, event);
				const index = await this._loadIndex();
				const summary = index.find(s => s.runId === runId);
				if (summary) {
					const mutable = summary as { status: string; turnCount: number; toolCallCount: number };
					if (event.kind === 'turn') {
						mutable.turnCount++;
					} else if (event.kind === 'toolCall') {
						mutable.toolCallCount++;
					} else if (event.kind === 'outcome') {
						mutable.status = (event.data as { status?: string })?.status ?? 'completed';
					}
					await this._saveIndex(index);
				}
			});
		}));
	}

	async listRuns(): Promise<readonly IOnyxRunSummary[]> {
		return [...await this._loadIndex()];
	}

	async readRun(runId: string): Promise<IOnyxRequestRecord | undefined> {
		if (!/^[\w-]+$/.test(runId)) {
			return undefined;
		}
		const index = await this._loadIndex();
		const summary = index.find(s => s.runId === runId);
		if (!summary) {
			return undefined;
		}
		const events: IOnyxRunEvent[] = [];
		try {
			const content = await this._fileService.readFile(this._runFile(runId));
			for (const line of content.value.toString().split('\n')) {
				if (line.trim()) {
					try {
						events.push(JSON.parse(line));
					} catch {
						// skip a torn line (e.g. crash mid-write)
					}
				}
			}
		} catch {
			// journal file missing — return the summary alone
		}
		return { ...summary, events };
	}

	private _journalRoot(): URI {
		return joinPath(this._environmentService.workspaceStorageHome, this._workspaceService.getWorkspace().id, 'onyx', 'journal');
	}

	private _runFile(runId: string): URI {
		return joinPath(this._journalRoot(), 'runs', `${runId}.jsonl`);
	}

	private _enqueue(task: () => Promise<void>): void {
		this._writeSequencer.queue(async () => {
			try {
				await task();
			} catch (err) {
				this._logService.warn('[onyx] journal write failed', err);
			}
		});
	}

	private async _loadIndex(): Promise<IOnyxRunSummary[]> {
		if (this._index) {
			return this._index;
		}
		try {
			const content = await this._fileService.readFile(joinPath(this._journalRoot(), 'index.json'));
			this._index = JSON.parse(content.value.toString());
		} catch {
			this._index = [];
		}
		return this._index!;
	}

	private async _pruneAndSaveIndex(index: IOnyxRunSummary[]): Promise<void> {
		while (index.length > MAX_PERSISTED_RUNS) {
			const removed = index.pop()!;
			try {
				await this._fileService.del(this._runFile(removed.runId));
			} catch {
				// already gone
			}
		}
		await this._saveIndex(index);
	}

	private async _saveIndex(index: IOnyxRunSummary[]): Promise<void> {
		this._index = index;
		await this._fileService.writeFile(joinPath(this._journalRoot(), 'index.json'), VSBuffer.fromString(JSON.stringify(index)));
		this._onDidChangeRuns.fire();
	}

	private async _appendEvent(runId: string, event: IOnyxRunEvent): Promise<void> {
		const line = VSBuffer.fromString(JSON.stringify(event) + '\n');
		const file = this._runFile(runId);
		try {
			await this._fileService.writeFile(file, line, { append: true });
		} catch {
			// first write to a new file on some providers requires create
			await this._fileService.createFile(file, line, { overwrite: true });
		}
	}
}
