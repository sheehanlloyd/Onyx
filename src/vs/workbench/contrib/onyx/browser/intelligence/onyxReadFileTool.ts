/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { toErrorMessage } from '../../../../../base/common/errorMessage.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { IModelService } from '../../../../../editor/common/services/model.js';
import { localize } from '../../../../../nls.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { ILanguageModelToolsService, IToolData, IToolImpl, IToolInvocation, IToolResult, ToolDataSource } from '../../../chat/common/tools/languageModelToolsService.js';
import { formatNumberedLines, formatSize, ONYX_READ_FILE_MAX_BYTES, ONYX_READ_FILE_MAX_LINES, resolveLineRange, splitLines } from '../../common/onyxReadTools.js';
import { IOnyxWorkspaceAccessService } from './onyxWorkspaceAccess.js';

export const ONYX_READ_FILE_TOOL_ID = 'onyx_readFile';

/**
 * The agent's file read (B1). It returns numbered lines (`12| text`), reads
 * the live text model when the file is open so the model sees unsaved edits,
 * and refuses anything outside the workspace or above the size cap with a
 * message that names the limit.
 */
export class OnyxReadFileToolContribution extends Disposable {

	static readonly ID = 'workbench.contrib.onyxReadFileTool';

	constructor(
		@ILanguageModelToolsService toolsService: ILanguageModelToolsService,
		@IOnyxWorkspaceAccessService private readonly _accessService: IOnyxWorkspaceAccessService,
		@IFileService private readonly _fileService: IFileService,
		@IModelService private readonly _modelService: IModelService,
	) {
		super();

		const toolData: IToolData = {
			id: ONYX_READ_FILE_TOOL_ID,
			toolReferenceName: 'readFile',
			displayName: localize('onyx.readFile.displayName', "Read File"),
			modelDescription: `Reads a workspace file and returns its lines numbered as "12| text". Pass the workspace-relative path. Use "startLine" and "endLine" (1-based, inclusive) to read part of a large file; one call returns at most ${ONYX_READ_FILE_MAX_LINES} lines. The "N| " prefix is not part of the file: leave it out when you quote lines for an edit.`,
			userDescription: localize('onyx.readFile.userDescription', "Read a file in the workspace"),
			source: ToolDataSource.Internal,
			canBeReferencedInPrompt: true,
			runsInWorkspace: true,
			inputSchema: {
				type: 'object',
				properties: {
					path: { type: 'string', description: 'Workspace-relative path of the file, e.g. "src/app.ts".' },
					startLine: { type: 'number', description: 'First line to return, 1-based. Defaults to 1.' },
					endLine: { type: 'number', description: 'Last line to return, inclusive. Defaults to the end of the file.' },
				},
				required: ['path'],
			},
		};

		const impl: IToolImpl = {
			prepareToolInvocation: async (context) => ({
				invocationMessage: localize('onyx.readFile.invoking', "Reading {0}", String((context.parameters as { path?: unknown }).path ?? '')),
			}),
			invoke: (invocation, _countTokens, _progress, token) => this._invoke(invocation, token),
		};

		this._register(toolsService.registerToolData(toolData));
		this._register(toolsService.registerToolImplementation(ONYX_READ_FILE_TOOL_ID, impl));
	}

	private async _invoke(invocation: IToolInvocation, token: CancellationToken): Promise<IToolResult> {
		const parameters = invocation.parameters as { path?: unknown; startLine?: unknown; endLine?: unknown };
		const path = typeof parameters.path === 'string' ? parameters.path.trim() : '';
		if (!path) {
			return errorResult('a non-empty "path" string is required.');
		}
		for (const name of ['startLine', 'endLine'] as const) {
			if (parameters[name] !== undefined && typeof parameters[name] !== 'number') {
				return errorResult(`"${name}" must be a number.`);
			}
		}
		const resolved = await this._accessService.resolve(path);
		if (!resolved.ok) {
			return errorResult(resolved.error);
		}
		if (token.isCancellationRequested) {
			return errorResult('cancelled.');
		}

		let text: string;
		const liveModel = this._modelService.getModel(resolved.uri);
		if (liveModel) {
			if (liveModel.getValueLength() > ONYX_READ_FILE_MAX_BYTES) {
				return errorResult(`${resolved.qualifiedPath} is ${formatSize(liveModel.getValueLength())}; readFile reads files up to ${formatSize(ONYX_READ_FILE_MAX_BYTES)}. Use grep to find the part you need.`);
			}
			text = liveModel.getValue();
		} else {
			try {
				const stat = await this._fileService.stat(resolved.uri);
				if (stat.isDirectory) {
					return errorResult(`${resolved.qualifiedPath || '.'} is a directory. Use listDirectory.`);
				}
				if (stat.size > ONYX_READ_FILE_MAX_BYTES) {
					return errorResult(`${resolved.qualifiedPath} is ${formatSize(stat.size)}; readFile reads files up to ${formatSize(ONYX_READ_FILE_MAX_BYTES)}. Use grep to find the part you need.`);
				}
				const content = await this._fileService.readFile(resolved.uri, { limits: { size: ONYX_READ_FILE_MAX_BYTES } });
				const bytes = content.value.buffer;
				if (bytes.subarray(0, 8192).includes(0)) {
					return errorResult(`${resolved.qualifiedPath} is a binary file; readFile reads text.`);
				}
				text = content.value.toString();
			} catch (error) {
				return errorResult(`${resolved.qualifiedPath} could not be read: ${toErrorMessage(error)}`);
			}
		}

		const lines = splitLines(text);
		const totalLines = text.length === 0 ? 0 : lines.length;
		const range = resolveLineRange(totalLines, parameters.startLine as number | undefined, parameters.endLine as number | undefined);
		if (!range.ok) {
			return errorResult(range.error);
		}
		if (totalLines === 0) {
			return { content: [{ kind: 'text', value: `${resolved.qualifiedPath} is empty (0 lines).` }], toolResultDetails: [resolved.uri] };
		}
		const body = formatNumberedLines(lines.slice(range.startLine - 1, range.endLine), range.startLine);
		const header = `${resolved.qualifiedPath} (lines ${range.startLine}-${range.endLine} of ${totalLines}${liveModel ? ', as open in the editor' : ''})`;
		const footer = range.clipped
			? `\n[one call returns at most ${ONYX_READ_FILE_MAX_LINES} lines; call readFile again with "startLine": ${range.endLine + 1} for more]`
			: '';
		return { content: [{ kind: 'text', value: `${header}\n${body}${footer}` }], toolResultDetails: [resolved.uri] };
	}
}

function errorResult(message: string): IToolResult {
	return { content: [{ kind: 'text', value: `Error: ${message}` }], toolResultError: true };
}
