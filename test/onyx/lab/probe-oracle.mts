/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Probes this machine for the sandbox the executable oracle needs (L10,
 * DEC-10) and prints what it saw: the product's own probe, from compiled
 * output. Exit 0 when the sandbox is established, 1 when it is not.
 *
 *   node test/onyx/lab/probe-oracle.mts
 */

import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const out = (relative: string) => pathToFileURL(path.join(repoRoot, 'out', relative)).href;
const { OnyxCommandRunner } = await import(out('vs/platform/onyxRuntime/node/onyxCommandRunner.js'));
const { probeOracleSandbox } = await import(out('vs/platform/onyxRuntime/node/onyxOracle.js'));

const probe: { available: boolean; reason?: string; steps: { what: string; exitCode: number | undefined; observed: boolean; output: string }[] } = await probeOracleSandbox(new OnyxCommandRunner(), process.platform, os.tmpdir());
console.log(`platform: ${process.platform} ${os.release()}`);
for (const step of probe.steps) {
	console.log(`${step.what}: exit ${step.exitCode ?? 'none'}, observed ${step.observed}${step.output ? `, said "${step.output.split('\n')[0]}"` : ''}`);
}
console.log(probe.available ? 'sandbox: established' : `sandbox: not established (${probe.reason})`);
process.exit(probe.available ? 0 : 1);
