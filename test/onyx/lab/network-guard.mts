/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * A network guard for lab code (L10, DEC-10, R-50). Loaded before a lab
 * script (`node --import ./test/onyx/lab/network-guard.mts <script>`), it
 * refuses every connection that is not to this machine and writes each
 * attempt to the file `ONYX_NETWORK_GUARD_LOG` names, before anything is
 * sent. A lab script run under it that leaves an empty log made no outbound
 * request from this process. It does not see child processes.
 */

import fs from 'node:fs';
import net from 'node:net';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]', '']);
const logPath = process.env.ONYX_NETWORK_GUARD_LOG;
const original = net.Socket.prototype.connect;

function target(args: unknown[]): { host: string; port: string } | undefined {
	const first = Array.isArray(args[0]) ? args[0][0] : args[0];
	if (typeof first === 'object' && first !== null) {
		const options = first as { host?: string; port?: number | string; path?: string };
		if (options.path !== undefined) {
			return undefined; // a local socket
		}
		return { host: options.host ?? 'localhost', port: String(options.port ?? '') };
	}
	if (typeof first === 'number' || (typeof first === 'string' && /^\d+$/.test(first))) {
		const second = Array.isArray(args[0]) ? args[0][1] : args[1];
		return { host: typeof second === 'string' ? second : 'localhost', port: String(first) };
	}
	return undefined; // a path
}

net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
	const to = target(args);
	if (to && !LOOPBACK.has(to.host)) {
		if (logPath) {
			fs.appendFileSync(logPath, `${to.host}:${to.port}\n`);
		}
		throw new Error(`network guard: a connection to ${to.host}:${to.port} was refused; lab code talks only to this machine`);
	}
	return Reflect.apply(original, this, args);
} as typeof original;
