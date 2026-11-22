/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * `Onyx: Check for Updates` (D3), the part that decides. There is no automatic
 * updater: `product.json` has no `updateUrl`, and this code runs only when the
 * user invokes the command. It reads the project's public release list and
 * says whether a newer release exists for this platform. It downloads nothing
 * and installs nothing; the user replaces the application by hand
 * (docs/UPDATING.md).
 *
 * Everything here is pure so that the newer, not-newer and failure cases are
 * tested without a network.
 */

/** The release this source tree builds. The release workflow refuses a tag that does not match it. */
export const ONYX_VERSION = '0.1.0-alpha.1';

/** The one platform the alpha has an artifact for (DEC-02). */
export const ONYX_SUPPORTED_PLATFORM = 'darwin-arm64';

/** The fields of the release list this code reads. Everything is optional: the response is not trusted to have a shape. */
export interface IOnyxRawReleaseAsset {
	readonly name?: string;
	readonly browser_download_url?: string;
}

export interface IOnyxRawRelease {
	readonly tag_name?: string;
	readonly html_url?: string;
	readonly draft?: boolean;
	readonly assets?: readonly IOnyxRawReleaseAsset[];
}

export interface IOnyxRepository {
	readonly owner: string;
	readonly name: string;
}

export const enum OnyxUpdateState {
	/** A release newer than this build exists. */
	Newer = 'newer',
	/** No release is newer than this build. */
	Current = 'current',
}

export interface IOnyxUpdateResult {
	readonly state: OnyxUpdateState;
	readonly currentVersion: string;
	/** The newest release found, when there is one at all. */
	readonly latestVersion: string | undefined;
	/** The page of the newer release. */
	readonly releaseUrl: string | undefined;
	/** The disk image for this platform in the newer release, when it has one. */
	readonly assetUrl: string | undefined;
	/** The checksum file published beside that disk image. */
	readonly checksumUrl: string | undefined;
	/** False when this build runs on a platform the release has no artifact for. */
	readonly platformSupported: boolean;
}

interface IParsedVersion {
	readonly numbers: readonly [number, number, number];
	readonly prerelease: readonly string[];
}

const VERSION_PATTERN = /^v?(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)(?:-(?<prerelease>[0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

function parseVersion(text: string): IParsedVersion | undefined {
	const groups = VERSION_PATTERN.exec(text.trim())?.groups;
	if (!groups) {
		return undefined;
	}
	return {
		numbers: [Number(groups.major), Number(groups.minor), Number(groups.patch)],
		prerelease: groups.prerelease ? groups.prerelease.split('.') : [],
	};
}

function comparePrereleaseField(a: string, b: string): number {
	const aNumeric = /^\d+$/.test(a);
	const bNumeric = /^\d+$/.test(b);
	if (aNumeric && bNumeric) {
		return Number(a) - Number(b);
	}
	if (aNumeric !== bNumeric) {
		// A numeric field sorts before an alphanumeric one.
		return aNumeric ? -1 : 1;
	}
	return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Semantic-version order, pre-release fields included: `0.1.0-alpha.1` is
 * before `0.1.0-alpha.2`, which is before `0.1.0`. Returns `undefined` when
 * either side is not a version, so that a tag this code cannot read is never
 * offered as an update.
 */
export function compareOnyxVersions(a: string, b: string): number | undefined {
	const left = parseVersion(a);
	const right = parseVersion(b);
	if (!left || !right) {
		return undefined;
	}
	for (let i = 0; i < 3; i++) {
		if (left.numbers[i] !== right.numbers[i]) {
			return left.numbers[i] - right.numbers[i];
		}
	}
	if (left.prerelease.length === 0 || right.prerelease.length === 0) {
		// A release sorts after any of its pre-releases.
		return right.prerelease.length - left.prerelease.length;
	}
	for (let i = 0; i < Math.max(left.prerelease.length, right.prerelease.length); i++) {
		if (i >= left.prerelease.length) {
			return -1;
		}
		if (i >= right.prerelease.length) {
			return 1;
		}
		const order = comparePrereleaseField(left.prerelease[i], right.prerelease[i]);
		if (order !== 0) {
			return order;
		}
	}
	return 0;
}

/**
 * The project's repository, read from the product's issue URL
 * (`https://github.com/<owner>/<name>/issues/new`), so that a renamed
 * repository needs no change here.
 */
export function onyxRepositoryFromIssueUrl(reportIssueUrl: string | undefined): IOnyxRepository | undefined {
	const groups = /^https:\/\/github\.com\/(?<owner>[A-Za-z0-9-]+)\/(?<name>[A-Za-z0-9._-]+)\/issues(?:\/|$)/.exec(reportIssueUrl ?? '')?.groups;
	return groups ? { owner: groups.owner, name: groups.name } : undefined;
}

/** The public release list. Pre-releases are in it; drafts are not shown to an anonymous reader. */
export function onyxReleasesApiUrl(repository: IOnyxRepository): string {
	return `https://api.github.com/repos/${repository.owner}/${repository.name}/releases?per_page=30`;
}

/** A link is shown only when it points into this repository's releases. */
function ownReleaseUrl(repository: IOnyxRepository, url: string | undefined): string | undefined {
	const prefix = `https://github.com/${repository.owner}/${repository.name}/releases/`.toLowerCase();
	return typeof url === 'string' && url.toLowerCase().startsWith(prefix) ? url : undefined;
}

/**
 * Decides what the release list means for this build. The newest readable,
 * published release wins. Its disk image is the asset whose name contains the
 * platform and ends in `.dmg`; the checksum is that name followed by `.sha256`.
 */
export function evaluateOnyxReleases(currentVersion: string, releases: readonly IOnyxRawRelease[], repository: IOnyxRepository, platform: string): IOnyxUpdateResult {
	let latest: IOnyxRawRelease | undefined;
	let latestVersion: string | undefined;
	for (const release of releases) {
		if (!release || release.draft === true || typeof release.tag_name !== 'string') {
			continue;
		}
		if (compareOnyxVersions(release.tag_name, currentVersion) === undefined) {
			continue;
		}
		if (latestVersion === undefined || (compareOnyxVersions(release.tag_name, latestVersion) ?? 0) > 0) {
			latest = release;
			latestVersion = release.tag_name;
		}
	}
	const platformSupported = platform === ONYX_SUPPORTED_PLATFORM;
	const base = { currentVersion, latestVersion: latestVersion?.replace(/^v/, ''), platformSupported };
	if (!latest || latestVersion === undefined || (compareOnyxVersions(latestVersion, currentVersion) ?? 0) <= 0) {
		return { ...base, state: OnyxUpdateState.Current, releaseUrl: undefined, assetUrl: undefined, checksumUrl: undefined };
	}
	const assets = Array.isArray(latest.assets) ? latest.assets : [];
	const image = platformSupported
		? assets.find(asset => typeof asset?.name === 'string' && asset.name.includes(ONYX_SUPPORTED_PLATFORM) && asset.name.endsWith('.dmg'))
		: undefined;
	const checksum = image ? assets.find(asset => asset?.name === `${image.name}.sha256`) : undefined;
	return {
		...base,
		state: OnyxUpdateState.Newer,
		releaseUrl: ownReleaseUrl(repository, latest.html_url) ?? `https://github.com/${repository.owner}/${repository.name}/releases`,
		assetUrl: ownReleaseUrl(repository, image?.browser_download_url),
		checksumUrl: ownReleaseUrl(repository, checksum?.browser_download_url),
	};
}
