/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';

/**
 * Where inference happens, as far as Onyx can say (B14, DEC-04, R-17).
 *
 * Two different things are kept apart. **Transport** is where the request
 * is sent: this machine, the local network, or the internet. It is read off
 * the URL. **Execution** is where the model runs, and a URL cannot tell:
 * a runtime on this machine can forward a model to a cloud service. Onyx
 * knows only what the runtime reports about itself, so execution is
 * `local` (the runtime says it runs the model itself), `cloud` (the runtime
 * says the model is served from elsewhere) or `unknown` (the server does not
 * say). Nothing here is verified, and no label says it is.
 */

export type OnyxTransport = 'loopback' | 'lan' | 'remote';
export type OnyxExecution = 'local' | 'cloud' | 'unknown';

export interface IOnyxInferenceLocation {
	readonly transport: OnyxTransport;
	readonly execution: OnyxExecution;
	/** Where the runtime says a cloud-backed model is served from, when it says. */
	readonly remoteHost?: string;
}

/** The user's choices (`onyx.inference.strictLocal`, `onyx.inference.allowLan`). */
export interface IOnyxInferencePolicy {
	/** Refuse a model whose execution is cloud or unknown, and any endpoint on the internet. On by default. */
	readonly strictLocal: boolean;
	/** Use endpoints on the local network. Off by default, and a choice of its own: configuring a LAN endpoint is not it. */
	readonly allowLan: boolean;
}

export const ONYX_DEFAULT_INFERENCE_POLICY: IOnyxInferencePolicy = { strictLocal: true, allowLan: false };

export type OnyxLocationRefusal = 'lan-not-enabled' | 'remote-transport' | 'cloud-execution' | 'unknown-execution';

function ipv4(host: string): number[] | undefined {
	const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
	const parts = match?.slice(1).map(Number);
	return parts && parts.every(part => part <= 255) ? parts : undefined;
}

/** Where a request to this base URL goes. A URL that cannot be read is treated as the internet. */
export function classifyTransport(baseUrl: string): OnyxTransport {
	let host: string;
	try {
		host = new URL(baseUrl).hostname.toLowerCase().replace(/^\[|\]$/g, '');
	} catch {
		return 'remote';
	}
	if (host === 'localhost' || host.endsWith('.localhost') || host === '::1' || host === '0:0:0:0:0:0:0:1') {
		return 'loopback';
	}
	const v4 = ipv4(host);
	if (v4) {
		const [a, b] = v4;
		if (a === 127) {
			return 'loopback';
		}
		// Private ranges, link-local, and the shared range overlay networks hand out (100.64.0.0/10).
		if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127)) {
			return 'lan';
		}
		return 'remote';
	}
	if (host.includes(':')) {
		// IPv6: unique local (fc00::/7) and link-local (fe80::/10) are the local network.
		return /^f[cd][0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host) ? 'lan' : 'remote';
	}
	// A name with no dot, or one under .local, .lan, .home.arpa or .internal, is resolved on the local network.
	if (!host.includes('.') || /\.(local|lan|internal|home\.arpa)$/.test(host)) {
		return 'lan';
	}
	return 'remote';
}

/** Whether a model at this location may be used under the user's policy, and if not, why. */
export function decideInferenceUse(location: IOnyxInferenceLocation, policy: IOnyxInferencePolicy): { readonly allowed: true } | { readonly allowed: false; readonly refusal: OnyxLocationRefusal } {
	if (location.transport === 'lan' && !policy.allowLan) {
		return { allowed: false, refusal: 'lan-not-enabled' };
	}
	if (policy.strictLocal) {
		if (location.transport === 'remote') {
			return { allowed: false, refusal: 'remote-transport' };
		}
		if (location.execution === 'cloud') {
			return { allowed: false, refusal: 'cloud-execution' };
		}
		if (location.execution === 'unknown') {
			return { allowed: false, refusal: 'unknown-execution' };
		}
	}
	return { allowed: true };
}

/** A short badge for a picker row, or nothing for the ordinary case (this machine, run by the runtime itself). */
export function locationBadge(location: IOnyxInferenceLocation): string | undefined {
	if (location.execution === 'cloud') {
		return localize('onyx.location.badge.cloud', "cloud-backed");
	}
	if (location.transport === 'remote') {
		return localize('onyx.location.badge.remote', "remote");
	}
	if (location.execution === 'unknown') {
		return localize('onyx.location.badge.unknown', "location unknown");
	}
	return location.transport === 'lan' ? localize('onyx.location.badge.lan', "LAN") : undefined;
}

/** Where the request is sent. Read off the URL; says nothing about where the model runs. */
export function describeTransport(transport: OnyxTransport): string {
	switch (transport) {
		case 'loopback': return localize('onyx.location.transport.loopback', "Requests are sent to this machine (a loopback address).");
		case 'lan': return localize('onyx.location.transport.lan', "Requests are sent to another machine on your network.");
		case 'remote': return localize('onyx.location.transport.remote', "Requests are sent over the internet.");
	}
}

/** Where the model runs, in the runtime's own words. A report, not a finding. */
export function describeExecution(location: IOnyxInferenceLocation, runtimeName: string): string {
	switch (location.execution) {
		case 'local': return localize('onyx.location.execution.local', "{0} reports that it runs this model itself. Onyx cannot establish what a runtime does beyond what it reports.", runtimeName);
		case 'cloud': return location.remoteHost
			? localize('onyx.location.execution.cloudHost', "{0} reports that this model is served from {1}: prompts leave the machine the runtime is on.", runtimeName, location.remoteHost)
			: localize('onyx.location.execution.cloud', "{0} reports that this model is served from elsewhere: prompts leave the machine the runtime is on.", runtimeName);
		case 'unknown': return localize('onyx.location.execution.unknown', "This server does not say where the model runs. It may run it itself or forward it anywhere.");
	}
}

/** Why a model is not used, and the setting that would change that. */
export function describeRefusal(refusal: OnyxLocationRefusal): string {
	switch (refusal) {
		case 'lan-not-enabled': return localize('onyx.location.refusal.lan', "Not used: it is on your network, not on this machine, and using network endpoints is a choice of its own. Turn on the setting onyx.inference.allowLan to use it.");
		case 'remote-transport': return localize('onyx.location.refusal.remote', "Not used: it is reached over the internet. Onyx uses local inference only unless you turn off the setting onyx.inference.strictLocal.");
		case 'cloud-execution': return localize('onyx.location.refusal.cloud', "Not used: the runtime reports this model as cloud-backed, so prompts would leave the machine even though the runtime is local. Turn off the setting onyx.inference.strictLocal to use it anyway.");
		case 'unknown-execution': return localize('onyx.location.refusal.unknown', "Not used: this server does not say where the model runs. Turn off the setting onyx.inference.strictLocal to use it anyway.");
	}
}
