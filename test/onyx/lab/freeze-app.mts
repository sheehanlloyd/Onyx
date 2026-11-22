/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Freezes the application a campaign runs (L9): a copy of the compiled
 * output and of what the launch script reads, under `.build/campaign-root`.
 * A tier A campaign started with `ONYX_LAB_APP_ROOT` set to that folder runs
 * the application from the copy, so that every unit of a long campaign runs
 * the same harness code while the checkout is being edited and rebuilt.
 *
 *   node test/onyx/lab/freeze-app.mts [--out <dir>]
 *
 * The copy is made with the file system's copy-on-write clone where there
 * is one (`cp -c` on macOS), so it takes no time and no space until a file
 * changes. `FROZEN.json` in the copy says which revision was frozen and
 * whether the source tree was clean. It needs compiled output.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { repoRoot, sourceState } from '../run-fresh.mts';

const outFlag = process.argv.indexOf('--out');
const target = path.resolve(outFlag === -1 ? path.join(repoRoot, '.build', 'campaign-root') : process.argv[outFlag + 1]);
if (!target.startsWith(path.join(repoRoot, '.build') + path.sep)) {
	console.error('freeze-app: the copy goes under .build/ of this checkout');
	process.exit(2);
}
if (!fs.existsSync(path.join(repoRoot, 'out', 'main.js'))) {
	console.error('freeze-app: there is no compiled output to freeze (pnpm run compile)');
	process.exit(1);
}
fs.rmSync(target, { recursive: true, force: true });
fs.mkdirSync(path.join(target, '.build'), { recursive: true });
const clone = process.platform === 'darwin' ? ['-Rc'] : ['-R'];
for (const entry of ['out', 'scripts', 'resources', 'extensions', 'package.json', 'product.json']) {
	execFileSync('cp', [...clone, path.join(repoRoot, entry), path.join(target, entry)]);
}
// The Electron the checkout downloaded, and its dependencies, are used in place: neither changes with the sources.
fs.symlinkSync(path.join('..', '..', 'electron'), path.join(target, '.build', 'electron'));
fs.symlinkSync(path.join('..', '..', 'node_modules'), path.join(target, 'node_modules'));
const state = sourceState();
fs.writeFileSync(path.join(target, 'FROZEN.json'), JSON.stringify({ revision: state.revision, dirtyEntries: state.dirtyEntries, dirtyDigest: state.dirtyDigest, frozenAt: new Date().toISOString() }, undefined, '\t') + '\n');
console.log(`frozen ${state.revision.slice(0, 11)}${state.dirtyEntries ? ` with ${state.dirtyEntries} dirty source entries` : ' (clean source tree)'} into ${path.relative(repoRoot, target)}`);

if (process.argv[1] && path.resolve(process.argv[1]) !== fileURLToPath(import.meta.url)) {
	throw new Error('freeze-app.mts is a command, not a module');
}
