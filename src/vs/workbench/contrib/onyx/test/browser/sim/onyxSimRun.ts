/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { runWithFakedTimers } from '../../../../../../base/test/common/timeTravelScheduler.js';
import { OnyxSimEpisode } from './onyxSimEpisode.js';
import { IOnyxSimResult, IOnyxSimRigOptions, OnyxSimChecker, OnyxSimRig } from './onyxSimRig.js';

/**
 * Runs one episode in a fresh rig under virtual time and disposes the rig.
 * `options.classes` swaps in a resurrection mutant (L12); the default is the
 * product as it ships.
 */
export async function runEpisode(episode: OnyxSimEpisode, checkers: readonly OnyxSimChecker[] = [], options: IOnyxSimRigOptions = {}): Promise<IOnyxSimResult> {
	return runWithFakedTimers({ useFakeTimers: true, maxTaskCount: 200_000 }, async () => {
		const rig = new OnyxSimRig(episode, checkers, options);
		try {
			return await rig.run();
		} finally {
			await rig.dispose();
		}
	});
}
