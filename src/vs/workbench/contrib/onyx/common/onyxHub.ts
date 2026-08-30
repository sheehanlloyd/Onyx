/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';

/**
 * The Onyx Hub: one quick pick that fronts every Onyx surface, with live
 * state folded into the descriptions so it reads like a status page you can
 * act on. The builder is pure — the action gathers the state, this file
 * decides what the hub says.
 */

export interface IOnyxHubState {
	readonly modelsReady: number;
	readonly endpointCount: number;
	/** The model the compute panel considers current, if any. */
	readonly currentModelKey: string | undefined;
	readonly inFlight: boolean;
	readonly tokensPerSecond: number | undefined;
	readonly sessionRequests: number;
	readonly runsToday: number;
	readonly memoryFacts: number;
	readonly pinnedFiles: number;
	readonly playbooks: number;
	readonly stagedChangeFiles: number;
	readonly resumableRuns: number;
}

export interface IOnyxHubEntry {
	readonly id: string;
	readonly commandId: string;
	readonly label: string;
	readonly description: string;
	/** Section separator to place before this entry, when a new group starts. */
	readonly group?: string;
}

export function buildHubEntries(state: IOnyxHubState): IOnyxHubEntry[] {
	// Both halves get a real singular: "1 model on 1 runtime(s)" is the sort of
	// seam that makes a product feel unfinished, and two runtimes at once is an
	// ordinary setup here, not an edge case.
	const runtimeSummary = state.endpointCount === 1
		? localize('onyx.hub.oneRuntime', "1 runtime")
		: localize('onyx.hub.runtimeCount', "{0} runtimes", state.endpointCount);
	const modelSummary = state.modelsReady === 0
		? localize('onyx.hub.noModels', "no local models yet")
		: state.modelsReady === 1
			? localize('onyx.hub.oneModel', "1 model on {0}", runtimeSummary)
			: localize('onyx.hub.models', "{0} models on {1}", state.modelsReady, runtimeSummary);

	const liveSummary = state.inFlight
		? localize('onyx.hub.generating', "generating now{0}", state.tokensPerSecond ? ` · ${Math.round(state.tokensPerSecond)} tok/s` : '')
		: state.currentModelKey
			? localize('onyx.hub.lastModel', "last: {0}{1}", state.currentModelKey, state.tokensPerSecond ? ` · ${Math.round(state.tokensPerSecond)} tok/s` : '')
			: localize('onyx.hub.idle', "idle");

	return [
		{
			id: 'chat', group: localize('onyx.hub.group.do', "Do"),
			commandId: 'workbench.action.chat.open',
			label: `$(comment-discussion) ${localize('onyx.hub.chat', "Chat with the Onyx Agent")}`,
			description: modelSummary,
		},
		{
			id: 'review',
			commandId: 'onyx.reviewChanges',
			label: `$(shield) ${localize('onyx.hub.review', "Review My Changes")}`,
			description: localize('onyx.hub.reviewDetail', "adversarial pass over everything uncommitted"),
		},
		{
			id: 'playbook',
			commandId: 'onyx.runPlaybook',
			label: `$(book) ${localize('onyx.hub.playbook', "Run a Playbook")}`,
			description: state.playbooks === 0
				? localize('onyx.hub.noPlaybooks', "none in this repository yet — add .onyx/playbooks/<name>.md")
				: state.playbooks === 1
					? localize('onyx.hub.onePlaybook', "1 checked-in recipe")
					: localize('onyx.hub.playbooks', "{0} checked-in recipes", state.playbooks),
		},
		{
			id: 'changes',
			commandId: 'onyx.openControlPlane',
			label: `$(diff) ${localize('onyx.hub.changes', "Review Proposed Changes")}`,
			description: state.stagedChangeFiles === 0
				? localize('onyx.hub.noStaged', "nothing staged — agent edits land here for review")
				: state.stagedChangeFiles === 1
					? localize('onyx.hub.oneStaged', "1 file awaiting your review")
					: localize('onyx.hub.staged', "{0} files awaiting your review", state.stagedChangeFiles),
		},
		{
			id: 'commit',
			commandId: 'onyx.generateCommitMessage',
			label: `$(sparkle) ${localize('onyx.hub.commit', "Generate Commit Message")}`,
			description: localize('onyx.hub.commitDetail', "from the staged diff"),
		},
		{
			id: 'controlPlane', group: localize('onyx.hub.group.observe', "Observe"),
			commandId: 'onyx.openControlPlane',
			label: `$(pulse) ${localize('onyx.hub.controlPlane', "Open the Control Plane")}`,
			description: state.runsToday === 1
				? localize('onyx.hub.oneRunToday', "1 run today · {0}", liveSummary)
				: localize('onyx.hub.runsToday', "{0} runs today · {1}", state.runsToday, liveSummary),
		},
		{
			id: 'resume',
			commandId: 'onyx.resumeRun',
			label: `$(debug-continue) ${localize('onyx.hub.resume', "Resume an Interrupted Run")}`,
			description: state.resumableRuns === 0
				? localize('onyx.hub.noResumable', "every run completed")
				: state.resumableRuns === 1
					? localize('onyx.hub.oneResumable', "1 run never finished")
					: localize('onyx.hub.resumable', "{0} runs never finished", state.resumableRuns),
		},
		{
			id: 'runtimes',
			commandId: 'onyx.showLocalRuntimes',
			label: `$(server-environment) ${localize('onyx.hub.runtimes', "Show Local Runtimes")}`,
			description: modelSummary,
		},
		{
			id: 'architecture',
			commandId: 'onyx.openArchitecture',
			label: `$(type-hierarchy-sub) ${localize('onyx.hub.architecture', "Open the Architecture Map")}`,
			description: localize('onyx.hub.architectureDetail', "modules, dependencies and hot spots, summarized locally"),
		},
		{
			id: 'models', group: localize('onyx.hub.group.tune', "Tune"),
			commandId: 'onyx.manageModels',
			label: `$(library) ${localize('onyx.hub.models.label', "Manage Models")}`,
			description: localize('onyx.hub.modelsDetail', "sized against this machine's memory"),
		},
		{
			id: 'benchmark',
			commandId: 'onyx.benchmarkModels',
			label: `$(dashboard) ${localize('onyx.hub.benchmark', "Benchmark Local Models")}`,
			description: localize('onyx.hub.benchmarkDetail', "measure tok/s, first token and tool compliance"),
		},
		{
			id: 'repoBenchmark',
			commandId: 'onyx.benchmarkOnRepo',
			label: `$(git-commit) ${localize('onyx.hub.repoBenchmark', "Benchmark on This Repo")}`,
			description: localize('onyx.hub.repoBenchmarkDetail', "score models on this repository's own past commits"),
		},
		{
			id: 'pin',
			commandId: 'onyx.pinActiveFile',
			label: `$(pin) ${localize('onyx.hub.pin', "Pin Active File to Context")}`,
			description: state.pinnedFiles === 0
				? localize('onyx.hub.noPins', "nothing pinned yet")
				: state.pinnedFiles === 1
					? localize('onyx.hub.onePin', "1 file pinned")
					: localize('onyx.hub.pins', "{0} files pinned", state.pinnedFiles),
		},
		{
			id: 'memory',
			commandId: 'onyx.clearMemory',
			label: `$(archive) ${localize('onyx.hub.memory', "Clear Agent Memory")}`,
			description: state.memoryFacts === 1
				? localize('onyx.hub.oneFact', "1 fact remembered in this workspace")
				: localize('onyx.hub.facts', "{0} facts remembered in this workspace", state.memoryFacts),
		},
		{
			id: 'diagnostics',
			commandId: 'onyx.exportDiagnostics',
			label: `$(package) ${localize('onyx.hub.diagnostics', "Export Diagnostics")}`,
			description: localize('onyx.hub.diagnosticsDetail', "a zip of journals and profiles — nothing leaves this machine"),
		},
	];
}
