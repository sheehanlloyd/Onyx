/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ILanguageModelChatMetadata } from '../../../../chat/common/languageModels.js';
import { IChatAgentRequest } from '../../../../chat/common/participants/chatAgents.js';
import { OnyxAgentLoop, OnyxSelectedTools } from '../../../browser/agent/onyxAgentLoop.js';
import { OnyxResolvedWorkspacePath, OnyxWorkspaceAccessService } from '../../../browser/intelligence/onyxWorkspaceAccess.js';
import { IOnyxExecutionRequest, OnyxTerminalService } from '../../../browser/terminal/onyxTerminalTool.js';
import { buildApprovalRequest, IOnyxCommandInvocation, IOnyxTerminalApprovalRequest, normalizeCommand, OnyxTerminalDecision } from '../../../common/onyxTerminalPolicy.js';
import { IOnyxModelProfile } from '../../../common/onyxTypes.js';
import { IOnyxSimProductClasses } from './onyxSimRig.js';

/**
 * Resurrected defects (L12). Each class here is a product class with one
 * fixed defect put back, for the simulation campaign to find. They exist
 * only under this test folder: no product code imports them, no setting
 * selects them, and the bundle scan (R-44) fails if one ships.
 * `onyxSimMutantTable.ts` describes each and carries its reproducing script.
 */

/** B1: the read path before containment. The model's path is joined onto the folder and used as it is. */
class OnyxMutantNaiveWorkspaceAccess extends OnyxWorkspaceAccessService {
	override async resolve(path: string): Promise<OnyxResolvedWorkspacePath> {
		const folder = this._workspaceService.getWorkspace().folders[0];
		const uri = path.startsWith('/') ? folder.uri.with({ path }) : folder.toResource(path);
		return { ok: true, uri, folder, relativePath: path, qualifiedPath: path };
	}
}

/** B1: tool selection before the slot policy. Whatever is left after the exclusions is cut at the cap. */
class OnyxMutantPriorityTruncatingLoop extends OnyxAgentLoop {
	protected override _selectTools(request: IChatAgentRequest, metadata: ILanguageModelChatMetadata | undefined, profile: IOnyxModelProfile): OnyxSelectedTools {
		const { available } = this._candidateTools(request, metadata);
		const priority = (name: string) => name === 'editFile' || name === 'terminal' ? 0 : 1;
		const tools = [...available].sort((a, b) => priority(a.name) - priority(b.name)).slice(0, profile.maxTools);
		return { kind: 'edit', tools, optional: [], omitted: [] };
	}
}

/** B2: the repository's list as authority. A command that `.onyx/config.json` names runs with no dialog. */
class OnyxMutantRepositoryAllowlistTerminal extends OnyxTerminalService {
	protected override async _authorize(invocation: IOnyxCommandInvocation): Promise<OnyxTerminalDecision> {
		let listed: string[] = [];
		try {
			const folder = this._workspaceService.getWorkspace().folders[0];
			const config = JSON.parse((await this._fileService.readFile(folder.toResource('.onyx/config.json'))).value.toString()) as { terminalAllowlist?: string[] };
			listed = (config.terminalAllowlist ?? []).map(normalizeCommand);
		} catch {
			// no repository configuration: nothing is listed
		}
		return listed.includes(normalizeCommand(invocation.command)) ? 'allow-once' : super._authorize(invocation);
	}
}

/** B2: an approval that outlives its invocation. A command text approved once runs unasked from then on. */
class OnyxMutantReusedApprovalTerminal extends OnyxTerminalService {
	private readonly _approvedTexts = new Set<string>();
	protected override async _authorize(invocation: IOnyxCommandInvocation): Promise<OnyxTerminalDecision> {
		if (this._approvedTexts.has(normalizeCommand(invocation.command))) {
			return 'allow-once';
		}
		const decision = await super._authorize(invocation);
		if (decision === 'allow-once') {
			this._approvedTexts.add(normalizeCommand(invocation.command));
		}
		return decision;
	}
}

/** B2: the dialog shows a tidied copy of the command; the original bytes are what runs. */
class OnyxMutantNormalizedApprovalTerminal extends OnyxTerminalService {
	protected override _approvalRequest(invocation: IOnyxCommandInvocation): IOnyxTerminalApprovalRequest {
		return buildApprovalRequest({ ...invocation, command: normalizeCommand(invocation.command) });
	}
}

/** B2: the repository's check task runs without being asked about. */
class OnyxMutantUnaskedCheckTerminal extends OnyxTerminalService {
	override async confirmExecution(_request: IOnyxExecutionRequest): Promise<boolean> {
		return true;
	}
}

/** Mutant id (as in `SIM_MUTANTS`) to the product classes it replaces. */
export const SIM_MUTANT_CLASSES: Readonly<Record<string, Partial<IOnyxSimProductClasses>>> = {
	'B1-naive-read-path': { WorkspaceAccess: OnyxMutantNaiveWorkspaceAccess },
	'B1-priority-truncation': { AgentLoop: OnyxMutantPriorityTruncatingLoop },
	'B2-repository-allowlist': { TerminalService: OnyxMutantRepositoryAllowlistTerminal },
	'B2-reused-approval': { TerminalService: OnyxMutantReusedApprovalTerminal },
	'B2-normalized-approval': { TerminalService: OnyxMutantNormalizedApprovalTerminal },
	'B2-unasked-check-task': { TerminalService: OnyxMutantUnaskedCheckTerminal },
};

/** The class name each mutant id resolves to, for the table's `resurrects` column. */
export function mutantClassNames(): Record<string, string[]> {
	return Object.fromEntries(Object.entries(SIM_MUTANT_CLASSES).map(([id, classes]) => [id, Object.values(classes).map(candidate => candidate.name)]));
}
