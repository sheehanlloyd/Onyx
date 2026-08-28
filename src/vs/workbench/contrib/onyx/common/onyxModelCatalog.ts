/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';

/** What a model is *for* in the Onyx harness — routing already treats these differently. */
export type OnyxModelRole = 'autocomplete' | 'agent' | 'chat';

/** A model Onyx knows how to recommend, with the numbers needed to size it against a machine. */
export interface IOnyxCatalogModel {
	/** Runtime model id, e.g. `qwen2.5-coder:7b` — the exact string `ollama pull` takes. */
	readonly id: string;
	readonly label: string;
	readonly role: OnyxModelRole;
	/** Parameter count in billions. */
	readonly parameterB: number;
	/** Approximate on-disk size of the default quantization, in GB. */
	readonly downloadGb: number;
	readonly quantization: string;
	readonly note: string;
}

/**
 * A deliberately short, opinionated list. Onyx is not an app store: it should
 * name the few models that make the product good on a Mac and get out of the
 * way. Sizes are the runtime's default quantization.
 */
export const ONYX_MODEL_CATALOG: readonly IOnyxCatalogModel[] = [
	{
		id: 'qwen2.5-coder:1.5b',
		label: 'Qwen2.5 Coder 1.5B',
		role: 'autocomplete',
		parameterB: 1.5,
		downloadGb: 1.0,
		quantization: 'Q4_K_M',
		note: localize('onyx.catalog.qwen15', "Fill-in-the-middle model for inline autocomplete. Small enough to answer between keystrokes."),
	},
	{
		id: 'llama3.2:3b',
		label: 'Llama 3.2 3B',
		role: 'chat',
		parameterB: 3,
		downloadGb: 2.0,
		quantization: 'Q4_K_M',
		note: localize('onyx.catalog.llama32', "General chat and quick explanations when you do not need a coding specialist."),
	},
	{
		id: 'qwen2.5-coder:7b',
		label: 'Qwen2.5 Coder 7B',
		role: 'agent',
		parameterB: 7,
		downloadGb: 4.7,
		quantization: 'Q4_K_M',
		note: localize('onyx.catalog.qwen7', "The everyday agent model: reliable tool calls at a latency you can work with."),
	},
	{
		id: 'qwen2.5-coder:14b',
		label: 'Qwen2.5 Coder 14B',
		role: 'agent',
		parameterB: 14,
		downloadGb: 9.0,
		quantization: 'Q4_K_M',
		note: localize('onyx.catalog.qwen14', "Noticeably better at multi-file edits and debugging, still comfortable on 32 GB."),
	},
	{
		id: 'qwen2.5-coder:32b',
		label: 'Qwen2.5 Coder 32B',
		role: 'agent',
		parameterB: 32,
		downloadGb: 20,
		quantization: 'Q4_K_M',
		note: localize('onyx.catalog.qwen32', "The strongest coding model that still runs well on a high-memory Mac."),
	},
	{
		id: 'gpt-oss:20b',
		label: 'GPT-OSS 20B',
		role: 'agent',
		parameterB: 20,
		downloadGb: 13,
		quantization: 'MXFP4',
		note: localize('onyx.catalog.gptoss', "Reasoning-heavy alternative for planning and review passes."),
	},
];

/** How well a model fits the machine it would run on. */
export type OnyxModelFit = 'comfortable' | 'tight' | 'tooLarge';

/** The memory a model needs beyond its weights: KV cache, activations, runtime overhead. */
const WEIGHT_OVERHEAD = 1.3;

/**
 * Memory the OS and the editor keep hold of. Proportional rather than fixed:
 * a flat 6 GB reserve would declare a 1 GB model a tight fit on an 8 GB Mac,
 * which is not what that machine actually feels like.
 */
function systemReserveGb(totalMemoryGb: number): number {
	return Math.max(4, totalMemoryGb * 0.25);
}

/**
 * Whether a model fits in unified memory. Apple Silicon shares one pool
 * between CPU and GPU, so "will this run" is a memory question, not a VRAM
 * question — but the same reserve logic holds on discrete-GPU machines too.
 */
export function fitModel(model: IOnyxCatalogModel, totalMemoryGb: number): OnyxModelFit {
	const usable = totalMemoryGb - systemReserveGb(totalMemoryGb);
	const needed = model.downloadGb * WEIGHT_OVERHEAD;
	if (needed > usable) {
		return 'tooLarge';
	}
	return needed > usable * 0.6 ? 'tight' : 'comfortable';
}

/** The advice Onyx gives for one machine: which models to run, and how to configure them. */
export interface IOnyxMemoryTier {
	readonly label: string;
	readonly guidance: string;
	/** Catalog ids worth installing on this machine, best first. */
	readonly recommended: readonly string[];
}

/**
 * Turns unified memory into concrete advice. The tiers are the real decision
 * points on Apple Silicon: 8/16 GB machines want a small FIM model and a 7B
 * agent; 32 GB opens up 14B; 64 GB and up runs 32B without swapping.
 */
export function recommendForMachine(totalMemoryGb: number): IOnyxMemoryTier {
	if (totalMemoryGb < 12) {
		return {
			label: localize('onyx.tier.8', "under 12 GB"),
			guidance: localize('onyx.tier.8.guidance', "Stay at 3B and below, keep the context window at 8K, and let autocomplete do most of the work. Larger models will swap."),
			recommended: ['qwen2.5-coder:1.5b', 'llama3.2:3b'],
		};
	}
	if (totalMemoryGb < 24) {
		return {
			label: localize('onyx.tier.16', "12–24 GB"),
			guidance: localize('onyx.tier.16.guidance', "A 7B agent at Q4_K_M with a 16K context is the sweet spot. Pair it with the 1.5B model for inline completions."),
			recommended: ['qwen2.5-coder:7b', 'qwen2.5-coder:1.5b'],
		};
	}
	if (totalMemoryGb < 48) {
		return {
			label: localize('onyx.tier.32', "24–48 GB"),
			guidance: localize('onyx.tier.32.guidance', "14B at Q4_K_M with a 32K context is the target here; at the low end of the range keep other memory-hungry apps closed."),
			recommended: ['qwen2.5-coder:14b', 'qwen2.5-coder:1.5b', 'gpt-oss:20b'],
		};
	}
	return {
		label: localize('onyx.tier.64', "48 GB and above"),
		guidance: localize('onyx.tier.64.guidance', "32B at Q4_K_M with a 32K context is within reach, with room to keep a second model loaded for routing to compare against."),
		recommended: ['qwen2.5-coder:32b', 'qwen2.5-coder:14b', 'qwen2.5-coder:1.5b'],
	};
}

/** Bytes → GB, rounded the way a spec sheet would print it. */
export function toGigabytes(bytes: number): number {
	return Math.round(bytes / (1024 ** 3));
}

/** `4.7` → `4.7 GB`; `0.9` → `900 MB`. */
export function formatSize(gigabytes: number): string {
	return gigabytes < 1 ? `${Math.round(gigabytes * 1024)} MB` : `${gigabytes.toFixed(1).replace(/\.0$/, '')} GB`;
}
