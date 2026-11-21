/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { ONYX_LAB_HARNESS_VARIABLE, ONYX_LAB_MANIFEST_VARIABLE, readLabHarnessRequest } from '../../node/onyxLabManifest.js';

/**
 * L4, the node part of R-44: what the process is asked to run under is read
 * from the manifest its environment names, and a manifest that cannot give
 * an answer is still a request, so that it is refused in sight and not
 * dropped.
 */
suite('OnyxLabManifest', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const MANIFEST = JSON.stringify({
		version: 1,
		name: '2026-11-21-ablation',
		harnessConfigurations: [
			{ name: 'shipping-default', hash: '00000000' },
			{ name: 'no-repair', hash: '11111111', configuration: { toolCallProtocol: 'native', turnCap: 4 } },
		],
	});
	const files: Readonly<Record<string, string>> = { '/lab/manifest.json': MANIFEST, '/lab/broken.json': '{ not json', '/lab/empty.json': '{"name":"2026-11-21-empty","harnessConfigurations":[]}' };
	const readFile = async (path: string) => {
		const content = files[path];
		if (content === undefined) {
			throw new Error('ENOENT');
		}
		return content;
	};
	const read = (manifest: string | undefined, harness?: string) => readLabHarnessRequest({ [ONYX_LAB_MANIFEST_VARIABLE]: manifest, [ONYX_LAB_HARNESS_VARIABLE]: harness, HOME: '/home/someone' }, readFile);

	test('R-44: the request is the named entry of the manifest the environment names; nothing named is nothing asked; a manifest that cannot answer is a request with a problem', async () => {
		assert.deepStrictEqual({
			nothingNamed: await read(undefined),
			named: await read('/lab/manifest.json', 'no-repair'),
			// With no entry named it is the first one, and an entry without a configuration changes nothing.
			firstByDefault: await read('/lab/manifest.json'),
			noSuchEntry: await read('/lab/manifest.json', 'fuzzy-apply'),
			noSuchFile: await read('/lab/missing.json', 'no-repair'),
			notJson: await read('/lab/broken.json'),
			noEntries: await read('/lab/empty.json'),
		}, {
			nothingNamed: undefined,
			named: { manifest: '2026-11-21-ablation', name: 'no-repair', configuration: { toolCallProtocol: 'native', turnCap: 4 } },
			firstByDefault: { manifest: '2026-11-21-ablation', name: 'shipping-default', configuration: {} },
			noSuchEntry: { manifest: '2026-11-21-ablation', name: 'fuzzy-apply', configuration: undefined, problem: 'the manifest has no harness configuration named fuzzy-apply' },
			// The path is not repeated: a manifest's location is the user's, and this record travels.
			noSuchFile: { manifest: 'unread', name: 'no-repair', configuration: undefined, problem: 'the manifest named by ONYX_LAB_MANIFEST could not be read' },
			notJson: { manifest: 'unread', name: 'first', configuration: undefined, problem: 'the manifest named by ONYX_LAB_MANIFEST is not JSON' },
			noEntries: { manifest: '2026-11-21-empty', name: 'first', configuration: undefined, problem: 'the manifest has no harness configuration' },
		});
	});
});
