/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { ChatMessageRole, IChatMessage } from '../../../chat/common/languageModels.js';
import { ONYX_AUTO_MODEL_ID, ONYX_VENDOR } from '../../common/onyxTypes.js';
import { IOnyxModelService } from '../model/onyxLanguageModelProvider.js';

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
	onDelta?: (text: string) => void,
): Promise<string> {
	const messages: IChatMessage[] = [
		{ role: ChatMessageRole.System, content: [{ type: 'text', value: system }] },
		{ role: ChatMessageRole.User, content: [{ type: 'text', value: user }] },
	];

	const response = await modelService.sendChatRequest(`${ONYX_VENDOR}:${ONYX_AUTO_MODEL_ID}`, messages, undefined, {}, token);
	let text = '';
	for await (const part of response.stream) {
		for (const one of Array.isArray(part) ? part : [part]) {
			if (one.type === 'text') {
				text += one.value;
				onDelta?.(one.value);
			}
		}
	}
	await response.result;
	return text;
}
