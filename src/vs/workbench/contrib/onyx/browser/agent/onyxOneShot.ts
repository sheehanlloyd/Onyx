/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { ChatMessageRole, IChatMessage } from '../../../chat/common/languageModels.js';
import { ONYX_AUTO_MODEL_ID, ONYX_VENDOR } from '../../common/onyxTypes.js';
import { IOnyxControlPlaneService, IOnyxRunHandle } from '../controlPlane/onyxControlPlaneService.js';
import { IOnyxModelService } from '../model/onyxLanguageModelProvider.js';

/** Optional control-plane wiring for a one-shot request. */
export interface IOnyxOneShotOptions {
	readonly onDelta?: (text: string) => void;
	/**
	 * When set, the request is journaled like an agent turn: the exact wire
	 * prompt lands on the run as a replayable snapshot, and the Compute view
	 * shows the request as in flight while it streams.
	 */
	readonly run?: IOnyxRunHandle;
	readonly controlPlane?: IOnyxControlPlaneService;
	/** Full model identifier (`onyx:<key>`) to bypass routing — tournament runs race specific models. */
	readonly modelIdentifier?: string;
}

/**
 * A single non-agentic request to a local model, streamed. Used by the small
 * flows that are not conversations — commit messages, reviews — so they still
 * go through routing and still feed the same per-model measurements the chat
 * agent does, rather than opening a private side channel to the runtime.
 */
export async function runOneShot(
	modelService: IOnyxModelService,
	system: string,
	user: string,
	token: CancellationToken,
	options?: IOnyxOneShotOptions,
): Promise<string> {
	const messages: IChatMessage[] = [
		{ role: ChatMessageRole.System, content: [{ type: 'text', value: system }] },
		{ role: ChatMessageRole.User, content: [{ type: 'text', value: user }] },
	];

	const requestedModel = options?.modelIdentifier ?? `${ONYX_VENDOR}:${ONYX_AUTO_MODEL_ID}`;
	// The same turn + snapshot shape the agent loop journals, so the Inspector
	// can replay a review or commit-message run exactly like a chat run.
	options?.run?.activity({ kind: 'turn', label: 'Model turn 1' });
	options?.run?.snapshot({
		turn: 1,
		model: requestedModel,
		tools: [],
		messages: messages.map(message => ({
			role: message.role,
			content: message.content.map(part => part.type === 'text' ? { type: 'text', value: part.value } : { type: part.type }),
		})),
	});
	options?.run?.setTurnCount(1);
	options?.controlPlane?.updateCompute({ inFlight: true });

	try {
		const response = await modelService.sendChatRequest(requestedModel, messages, undefined, {}, token);
		let text = '';
		for await (const part of response.stream) {
			for (const one of Array.isArray(part) ? part : [part]) {
				if (one.type === 'text') {
					text += one.value;
					options?.onDelta?.(one.value);
				}
			}
		}
		await response.result;
		return text;
	} finally {
		options?.controlPlane?.updateCompute({ inFlight: false });
	}
}
