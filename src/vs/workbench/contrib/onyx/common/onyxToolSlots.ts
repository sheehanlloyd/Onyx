/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The tool-slot policy (B1, R-36). A small model is given few tools, so which
 * ones it gets is decided here, by name, and never by a priority tie-break:
 *
 * 1. The six essential tools are reserved first. An edit-capable run that is
 *    missing one refuses and names it; it never runs with a set that looks
 *    usable and is not.
 * 2. Spare slots go to the optional tools in a documented order. A tool the
 *    user asked for by name moves into the last spare slot.
 * 3. A profile with fewer than six slots cannot hold the essentials. It gets
 *    the read tools only and the run says it is read-only.
 *
 * Capability gating and the user's and the project's exclusions happen before
 * this function: it is told what is available and what was excluded and why.
 */

/** Tool reference names, as the model sees them. */
export const ONYX_ESSENTIAL_TOOLS: readonly string[] = ['readFile', 'listDirectory', 'findFiles', 'grep', 'editFile', 'terminal'];

/** The default order in which optional tools fill spare slots. */
export const ONYX_OPTIONAL_TOOL_ORDER: readonly string[] = ['repoSymbols', 'docs', 'remember', 'playbook'];

/** The order in which a profile too small for the essentials receives the read tools. */
export const ONYX_READ_ONLY_TOOL_ORDER: readonly string[] = ['readFile', 'grep', 'findFiles', 'listDirectory'];

/** Slots an edit-capable run needs: one per essential tool. */
export const ONYX_MIN_EDIT_SLOTS = ONYX_ESSENTIAL_TOOLS.length;

/** The slot cap of the supported 7B profile: the six essentials and two spare slots. */
export const ONYX_SUPPORTED_SLOT_CAP = 8;

export interface IOnyxNamedTool {
	/** The reference name advertised to the model. */
	readonly name: string;
}

export interface IOnyxToolExclusion {
	readonly name: string;
	/** Why the tool is not available, in words a user can act on. */
	readonly reason: string;
}

export interface IOnyxToolSlotRequest<T extends IOnyxNamedTool> {
	/** Tools that passed capability gating and every exclusion, in registry order. */
	readonly available: readonly T[];
	/** Tools that were excluded before selection, with the reason. */
	readonly excluded: readonly IOnyxToolExclusion[];
	/** The profile's slot cap. */
	readonly maxTools: number;
	/** Overrides the default optional order (a profile or a lab manifest may change it). */
	readonly optionalOrder?: readonly string[];
	/** Optional tools the user asked for by name in this request. */
	readonly requested?: readonly string[];
}

export type OnyxToolSlotSelection<T extends IOnyxNamedTool> =
	| {
		readonly kind: 'edit';
		readonly tools: readonly T[];
		/** The optional tools that received a slot, in order. */
		readonly optional: readonly string[];
		/** Available tools that did not fit. */
		readonly omitted: readonly string[];
	}
	| {
		readonly kind: 'read-only';
		readonly tools: readonly T[];
		readonly reason: string;
		readonly omitted: readonly string[];
	}
	| {
		readonly kind: 'refused';
		readonly missing: readonly IOnyxToolExclusion[];
		readonly message: string;
	};

/**
 * The optional order after a by-name request: each requested tool takes the
 * last spare slot that is not already held by a requested tool, so a request
 * replaces a default and the first default survives when there is room.
 */
export function orderOptionalTools(order: readonly string[], requested: readonly string[], spare: number): string[] {
	// A tool the user names need not be in the default order: a reviewed network tool, once opted in to, is one.
	const base = [...order, ...requested].filter((name, index, all) => all.indexOf(name) === index);
	const wanted = requested.filter((name, index) => requested.indexOf(name) === index);
	if (wanted.length === 0 || spare <= 0) {
		return base;
	}
	const kept = base.filter(name => !wanted.includes(name));
	const promoted = wanted.slice(0, spare);
	const head = kept.slice(0, Math.max(0, spare - promoted.length));
	const tail = kept.slice(head.length);
	return [...head, ...promoted, ...wanted.slice(promoted.length), ...tail];
}

export function selectToolSlots<T extends IOnyxNamedTool>(request: IOnyxToolSlotRequest<T>): OnyxToolSlotSelection<T> {
	const byName = new Map<string, T>();
	for (const tool of request.available) {
		if (!byName.has(tool.name)) {
			byName.set(tool.name, tool);
		}
	}
	const maxTools = Math.max(0, Math.floor(request.maxTools));

	if (maxTools < ONYX_MIN_EDIT_SLOTS) {
		const tools = ONYX_READ_ONLY_TOOL_ORDER.map(name => byName.get(name)).filter((tool): tool is T => !!tool).slice(0, maxTools);
		const taken = new Set(tools.map(tool => tool.name));
		return {
			kind: 'read-only',
			tools,
			reason: `this model's profile allows ${maxTools} tool${maxTools === 1 ? '' : 's'} and agent editing needs ${ONYX_MIN_EDIT_SLOTS} (${ONYX_ESSENTIAL_TOOLS.join(', ')})`,
			omitted: [...byName.keys()].filter(name => !taken.has(name)),
		};
	}

	const missing: IOnyxToolExclusion[] = [];
	for (const name of ONYX_ESSENTIAL_TOOLS) {
		if (!byName.has(name)) {
			missing.push({ name, reason: request.excluded.find(entry => entry.name === name)?.reason ?? 'not available in this build' });
		}
	}
	if (missing.length) {
		return {
			kind: 'refused',
			missing,
			message: `This agent run needs ${missing.map(entry => `${entry.name} (${entry.reason})`).join(' and ')}. Onyx does not run an editing agent with part of its tool set: enable ${missing.length === 1 ? 'that tool' : 'those tools'} and try again.`,
		};
	}

	const tools: T[] = ONYX_ESSENTIAL_TOOLS.map(name => byName.get(name)!);
	const spare = maxTools - tools.length;
	const optionalOrder = orderOptionalTools(request.optionalOrder ?? ONYX_OPTIONAL_TOOL_ORDER, request.requested ?? [], spare);
	const optional: string[] = [];
	for (const name of optionalOrder) {
		const tool = byName.get(name);
		if (tool && tools.length < maxTools && !ONYX_ESSENTIAL_TOOLS.includes(name)) {
			tools.push(tool);
			optional.push(name);
		}
	}
	// Whatever else the contract admits follows, in registry order, while slots remain.
	for (const tool of byName.values()) {
		if (tools.length >= maxTools) {
			break;
		}
		if (!tools.includes(tool)) {
			tools.push(tool);
		}
	}
	const taken = new Set(tools.map(tool => tool.name));
	return { kind: 'edit', tools, optional, omitted: [...byName.keys()].filter(name => !taken.has(name)) };
}

const REQUEST_WORDS: Readonly<Record<string, RegExp>> = {
	playbook: /\bplaybooks?\b/i,
	remember: /\bremember\b/i,
	docs: /\b(docs|documentation)\b/i,
	repoSymbols: /\b(repoSymbols|symbols?)\b/i,
};

/** Words that ask for the network tools. They matter only when the user has opted in to them (B3). */
const NETWORK_REQUEST_WORDS = /\b(browser|web ?pages?|websites?|https?:\/\/\S+)/i;
const NETWORK_TOOLS_BY_REQUEST: readonly string[] = ['openBrowserPage', 'readPage'];

/**
 * Which optional tools the user asked for by name: the tool's own word in the
 * message, or the name of one of the repository's playbooks. Deliberately
 * literal; a request is something the user typed, not something inferred.
 */
export function requestedOptionalTools(message: string, playbookNames: readonly string[] = []): string[] {
	const requested: string[] = [];
	for (const name of ONYX_OPTIONAL_TOOL_ORDER) {
		if (REQUEST_WORDS[name]?.test(message)) {
			requested.push(name);
		}
	}
	if (!requested.includes('playbook') && playbookNames.some(name => name.length > 2 && message.includes(name))) {
		requested.push('playbook');
	}
	if (NETWORK_REQUEST_WORDS.test(message)) {
		// Named here whether or not they are available: the capability contract decides that, before the slots.
		requested.unshift(...NETWORK_TOOLS_BY_REQUEST);
	}
	return requested;
}
