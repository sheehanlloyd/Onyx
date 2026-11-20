/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IChatResponseToolUsePart, ILanguageModelChatMetadata } from '../../../../chat/common/languageModels.js';
import { IChatAgentRequest } from '../../../../chat/common/participants/chatAgents.js';
import { IOnyxSelectableTool, OnyxAgentLoop, OnyxSelectedTools } from '../../../browser/agent/onyxAgentLoop.js';
import { IOnyxToolExclusion } from '../../../common/onyxToolSlots.js';
import { OnyxMemoryToolContribution } from '../../../browser/intelligence/onyxMemoryTool.js';
import { IOnyxStreamOutcome, OnyxModelService } from '../../../browser/model/onyxLanguageModelProvider.js';
import { OnyxResolvedWorkspacePath, OnyxWorkspaceAccessService } from '../../../browser/intelligence/onyxWorkspaceAccess.js';
import { IOnyxExecutionRequest, OnyxTerminalService, OnyxWorkingDirectory } from '../../../browser/terminal/onyxTerminalTool.js';
import { IOnyxBudgetedMessage, IOnyxTurnPlan } from '../../../common/onyxContextBudget.js';
import { OnyxEnvelopeAnswerStream } from '../../../common/onyxConstrainedToolCalls.js';
import { OnyxDiagnosticsRedactor } from '../../../common/onyxDiagnostics.js';
import { IOnyxReasoningSplit, OnyxReasoningFilter } from '../../../common/onyxReasoning.js';
import { OnyxAssistantTextStream } from '../../../common/onyxTextToolCalls.js';
import { decideInferenceUse, IOnyxInferenceLocation, IOnyxInferencePolicy } from '../../../common/onyxInferenceLocation.js';
import { OnyxTimelineOutput } from '../../../common/onyxTerminalOutput.js';
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

/**
 * B4: the regex classifier. A handful of patterns for deletes, privilege and `curl | sh`, with no notion
 * of egress, persistence or an interpreter one-liner, so those commands reach the prompt with no warning.
 */
class OnyxMutantRegexWarningsTerminal extends OnyxTerminalService {
	protected override _approvalRequest(invocation: IOnyxCommandInvocation): IOnyxTerminalApprovalRequest {
		const current = buildApprovalRequest(invocation);
		const regexRules = [/\brm\s+(-[a-z]*[rf][a-z]*\s+)+/i, /\b(curl|wget)\b[^|;&]*\|\s*(sudo\s+)?(ba|z|da|fi)?sh\b/i, /\bsudo\b/, /\bgit\s+push\b.*(--force\b|-f\b)/, /\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f)/];
		const flagged = regexRules.some(rule => rule.test(normalizeCommand(invocation.command)));
		const detail = current.detail.split('\n').filter(line => flagged || !line.includes('looks like:')).join('\n');
		return { ...current, detail, dangerous: flagged };
	}
}

/** B3: tool selection before the capability contract. Whatever the registry holds, short of the names core's own terminal and edit tools use, is offered. */
class OnyxMutantUncontractedToolsLoop extends OnyxAgentLoop {
	protected override _candidateTools(request: IChatAgentRequest, metadata: ILanguageModelChatMetadata | undefined): { available: IOnyxSelectableTool[]; excluded: IOnyxToolExclusion[] } {
		const contracted = super._candidateTools(request, metadata);
		const taken = new Set(contracted.available.map(tool => tool.name));
		const extra: IOnyxSelectableTool[] = [];
		for (const tool of this._registeredTools(metadata)) {
			const name = tool.toolReferenceName ?? tool.id;
			if (!taken.has(name) && !/^(runInTerminal|sendToTerminal|shell)$|editFile|applyPatch/i.test(name) && tool.modelDescription) {
				taken.add(name);
				extra.push({ id: tool.id, name, description: tool.modelDescription, inputSchema: tool.inputSchema });
			}
		}
		return { available: [...contracted.available, ...extra], excluded: contracted.excluded };
	}
	protected override _needsApprovalPerCall(_toolId: string): boolean {
		return false; // and core's tools are called as core registered them, with no Onyx gate
	}
}

/** B3: a memory tool that stores whatever the model hands it, with no confirmation. */
class OnyxMutantUnconfirmedMemoryTool extends OnyxMemoryToolContribution {
	protected override async _confirm(): Promise<boolean> {
		return true;
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

/** B5: the output buffer before its cap. What a command prints is kept, all of it, for as long as the command runs. */
class OnyxMutantUnboundedTimelineOutput extends OnyxTimelineOutput {
	private _held = '';
	override push(text: string): string[] {
		this._held += text;
		return super.push(text);
	}
	override get retainedChars(): number {
		return this._held.length;
	}
}

class OnyxMutantUnboundedOutputTerminal extends OnyxTerminalService {
	protected override _createTimelineOutput(): OnyxTimelineOutput {
		return new OnyxMutantUnboundedTimelineOutput();
	}
}

/** B5: the command inherits the whole environment, whatever the user's setting says. */
class OnyxMutantFullEnvironmentTerminal extends OnyxTerminalService {
	protected override _passEnvironment(): boolean {
		return true;
	}
}

/** B5: the directory a call names is ignored, valid or not; every command runs in the workspace root. */
class OnyxMutantCwdIgnoredTerminal extends OnyxTerminalService {
	protected override async _resolveWorkingDirectory(): Promise<OnyxWorkingDirectory> {
		return { ok: true, path: this._workspaceService.getWorkspace().folders[0].uri.fsPath };
	}
}

/** B5: a closing window stops nothing; the command it started runs on. */
class OnyxMutantOutlivingCommandTerminal extends OnyxTerminalService {
	protected override async _killRunningForShutdown(): Promise<void> { }
}

/**
 * B11: the redaction before the allowlist. An event is kept whole; only the `value` of a prompt message
 * part and the text of a steering note are replaced. Tool parameters, labels, reasons, commands, output,
 * paths and the model's reply all stay.
 */
class OnyxMutantValueOnlyRedactor extends OnyxDiagnosticsRedactor {
	override event(event: unknown): Record<string, unknown> | undefined {
		if (typeof event !== 'object' || event === null) {
			return undefined;
		}
		const copy = JSON.parse(JSON.stringify(event)) as { kind?: string; data?: { kind?: string; reason?: unknown; messages?: { content?: { value?: unknown }[] }[] } };
		if (copy.kind === 'promptSnapshot') {
			for (const message of copy.data?.messages ?? []) {
				for (const part of message.content ?? []) {
					if (typeof part.value === 'string') {
						part.value = `[redacted ${part.value.length} chars]`;
					}
				}
			}
		}
		if (copy.kind === 'note' && copy.data?.kind === 'steer' && typeof copy.data.reason === 'string') {
			copy.data.reason = `[redacted ${copy.data.reason.length} chars]`;
		}
		return copy;
	}
}

/** B12: a stream that ends without a finish reason is a reply like any other, and the run completes. */
class OnyxMutantTruncatedIsCompleteLoop extends OnyxAgentLoop {
	protected override _incompleteEnding(_outcome: Partial<IOnyxStreamOutcome> | undefined): 'truncated' | 'stalled' | undefined {
		return undefined;
	}
}

/** B12: a call's arguments go to the tool as the model wrote them, whatever the schema says. */
class OnyxMutantUnvalidatedArgumentsLoop extends OnyxAgentLoop {
	protected override _argumentProblems(_toolUse: IChatResponseToolUsePart, _schema: object | undefined): string[] {
		return [];
	}
}

/** B12: no deadline. A request that says nothing is waited on for ever. */
class OnyxMutantNoDeadlineModelService extends OnyxModelService {
	protected override _streamDeadlines(): { readonly firstByteMs: number; readonly idleMs: number } {
		return { firstByteMs: Number.POSITIVE_INFINITY, idleMs: Number.POSITIVE_INFINITY };
	}
}

/** B13: no output cap. The request carries no `max_tokens`, so nothing bounds what the reply takes of the window. */
class OnyxMutantNoOutputCapLoop extends OnyxAgentLoop {
	protected override _outputCap(_plan: IOnyxTurnPlan): number | undefined {
		return undefined;
	}
}

/** B13: nothing is dropped. Tool results pile up turn after turn and the prompt outgrows the window. */
class OnyxMutantNoEvictionLoop extends OnyxAgentLoop {
	protected override _planTurn(messages: readonly IOnyxBudgetedMessage[], schemaTokens: number, contextTokens: number): IOnyxTurnPlan {
		const plan = super._planTurn(messages, schemaTokens, contextTokens);
		return { ...plan, messages, evictedCalls: 0, evictedResults: 0, evictedHistory: 0, droppedWorkspaceContext: false, shrankNewestResults: false, fits: true };
	}
}

/** B14: the address is taken for the location. Whatever is reached through loopback is used as local. */
class OnyxMutantAddressIsLocalityModelService extends OnyxModelService {
	protected override _decideUse(location: IOnyxInferenceLocation, policy: IOnyxInferencePolicy): ReturnType<typeof decideInferenceUse> {
		return location.transport === 'loopback' ? { allowed: true } : super._decideUse(location, policy);
	}
}

/** C4: thinking is not told apart from the answer. Whatever the model writes is its reply. */
class OnyxMutantPassThroughReasoningFilter extends OnyxReasoningFilter {
	override push(chunk: string): string {
		return chunk;
	}
	override finish(): IOnyxReasoningSplit {
		return { text: '', reasoning: '', unterminated: false };
	}
}

class OnyxMutantThinkingIsAnswerLoop extends OnyxAgentLoop {
	protected override _createReasoningFilter(): OnyxReasoningFilter {
		return new OnyxMutantPassThroughReasoningFilter();
	}
}

/** C5: anything that opens with a fence or a brace is withheld until it is 4,000 characters long or over. */
class OnyxMutantHoldEveryFenceTextStream extends OnyxAssistantTextStream {
	protected override _withhold(soFar: string): boolean {
		const trimmed = soFar.trimStart();
		return trimmed.length <= 4000 && (trimmed.length === 0 || trimmed.startsWith('{') || '```'.startsWith(trimmed) || trimmed.startsWith('```'));
	}
}

class OnyxMutantHoldEveryFenceLoop extends OnyxAgentLoop {
	protected override _createTextStream(offeredToolNames: readonly string[], emit: (text: string) => void): OnyxAssistantTextStream {
		return new OnyxMutantHoldEveryFenceTextStream(offeredToolNames, emit);
	}
}

/** C6: nothing of a constrained turn is shown until the whole envelope has arrived. */
class OnyxMutantSilentEnvelopeAnswerStream extends OnyxEnvelopeAnswerStream {
	override get shown(): string {
		return '';
	}
	override push(_chunk: string): string {
		return '';
	}
}

class OnyxMutantConstrainedAnswerWithheldLoop extends OnyxAgentLoop {
	protected override _createEnvelopeAnswerStream(): OnyxEnvelopeAnswerStream {
		return new OnyxMutantSilentEnvelopeAnswerStream();
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
	'B4-regex-warnings': { TerminalService: OnyxMutantRegexWarningsTerminal },
	'B5-unbounded-output': { TerminalService: OnyxMutantUnboundedOutputTerminal },
	'B5-full-environment': { TerminalService: OnyxMutantFullEnvironmentTerminal },
	'B5-cwd-ignored': { TerminalService: OnyxMutantCwdIgnoredTerminal },
	'B5-command-outlives-window': { TerminalService: OnyxMutantOutlivingCommandTerminal },
	'B11-value-only-redaction': { DiagnosticsRedactor: OnyxMutantValueOnlyRedactor },
	'B12-truncated-is-complete': { AgentLoop: OnyxMutantTruncatedIsCompleteLoop },
	'B12-unvalidated-arguments': { AgentLoop: OnyxMutantUnvalidatedArgumentsLoop },
	'B12-no-stream-deadline': { ModelService: OnyxMutantNoDeadlineModelService },
	'B13-no-output-cap': { AgentLoop: OnyxMutantNoOutputCapLoop },
	'B13-no-eviction': { AgentLoop: OnyxMutantNoEvictionLoop },
	'B14-address-is-locality': { ModelService: OnyxMutantAddressIsLocalityModelService },
	'C4-thinking-is-answer': { AgentLoop: OnyxMutantThinkingIsAnswerLoop },
	'C5-fence-withheld': { AgentLoop: OnyxMutantHoldEveryFenceLoop },
	'C6-constrained-answer-withheld': { AgentLoop: OnyxMutantConstrainedAnswerWithheldLoop },
	'B3-uncontracted-tools': { AgentLoop: OnyxMutantUncontractedToolsLoop },
	'B3-unconfirmed-memory': { MemoryTool: OnyxMutantUnconfirmedMemoryTool },
};

/** The class name each mutant id resolves to, for the table's `resurrects` column. */
export function mutantClassNames(): Record<string, string[]> {
	return Object.fromEntries(Object.entries(SIM_MUTANT_CLASSES).map(([id, classes]) => [id, Object.values(classes).map(candidate => candidate.name)]));
}
