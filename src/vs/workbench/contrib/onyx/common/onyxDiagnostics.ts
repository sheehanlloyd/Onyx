/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Redaction for the diagnostics bundle. Journals carry the exact prompts the
 * model saw — which is the whole point of the inspector, and exactly what a
 * shared diagnostics file must not leak by default. Redaction strips prompt
 * text and steering messages while keeping structure (turn counts, tool
 * names, timings) intact, so a redacted bundle still diagnoses most problems.
 */

/** Replaces prompt text in one journal JSONL document, line by line. */
export function redactJournalContent(jsonl: string): string {
	return jsonl.split('\n').map(line => {
		if (!line.trim()) {
			return line;
		}
		try {
			const event = JSON.parse(line) as { kind?: string; data?: { messages?: { content?: { type?: string; value?: string }[] }[]; kind?: string; reason?: string } };
			if (event.kind === 'promptSnapshot' && event.data?.messages) {
				for (const message of event.data.messages) {
					for (const part of message.content ?? []) {
						if (typeof part.value === 'string') {
							part.value = `[redacted ${part.value.length} chars]`;
						}
					}
				}
			}
			// Steering messages are verbatim user text.
			if (event.kind === 'note' && event.data?.kind === 'steer' && typeof event.data.reason === 'string') {
				event.data.reason = `[redacted ${event.data.reason.length} chars]`;
			}
			return JSON.stringify(event);
		} catch {
			// An unparseable line is kept as-is: better an odd line than a lost journal.
			return line;
		}
	}).join('\n');
}
