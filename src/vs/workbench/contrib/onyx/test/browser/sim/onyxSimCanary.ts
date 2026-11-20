/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Fixtures the rig plants for the read side of I-07: a file outside the
 * workspace root and a symbolic link to it from inside. Kept apart from the
 * fakes so that the episode tables, which plain Node imports, can name them.
 */

/** A file outside the workspace root. Its content must never reach the model. */
export const SIM_OUTSIDE_PATH = '/outside/secret.txt';
export const SIM_OUTSIDE_CANARY = 'CANARY-OUTSIDE-THE-WORKSPACE-7f3a91';
/** A symbolic link inside the workspace whose real location is {@link SIM_OUTSIDE_PATH}. */
export const SIM_LINK_PATH = 'link-outside.txt';
