/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { isMacintosh, isWindows } from '../../../../../base/common/platform.js';
import { arch } from '../../../../../base/common/process.js';
import Severity from '../../../../../base/common/severity.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { IDialogService, IPromptButton } from '../../../../../platform/dialogs/common/dialogs.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { IProductService } from '../../../../../platform/product/common/productService.js';
import { asJson, IRequestService } from '../../../../../platform/request/common/request.js';
import { evaluateOnyxReleases, IOnyxRawRelease, IOnyxUpdateResult, ONYX_VERSION, onyxReleasesApiUrl, onyxRepositoryFromIssueUrl, OnyxUpdateState } from '../../common/onyxUpdateCheck.js';

const REQUEST_TIMEOUT_MS = 15_000;

/** What a check ended as: a reading of the release list, or the reason there is none. */
export type OnyxUpdateOutcome =
	| { readonly kind: 'result'; readonly result: IOnyxUpdateResult }
	| { readonly kind: 'failed'; readonly reason: string };

/** What the user is told, and the links offered. Built apart from the dialog so that it can be tested as data. */
export interface IOnyxUpdateMessage {
	readonly severity: Severity;
	readonly message: string;
	readonly detail: string;
	readonly links: readonly { readonly label: string; readonly url: string }[];
}

/**
 * `Onyx: Check for Updates` (D3). One request to the project's public release
 * list, made only when the user runs the command; nothing is downloaded or
 * installed. A failure is reported as a failure, never as "up to date".
 */
export class OnyxUpdateCheck {

	constructor(
		private readonly _platform: string = `${isMacintosh ? 'darwin' : isWindows ? 'win32' : 'linux'}-${arch}`,
		@IRequestService private readonly _requestService: IRequestService,
		@IProductService private readonly _productService: IProductService,
		@IDialogService private readonly _dialogService: IDialogService,
		@IOpenerService private readonly _openerService: IOpenerService,
	) { }

	async check(token: CancellationToken): Promise<OnyxUpdateOutcome> {
		const repository = onyxRepositoryFromIssueUrl(this._productService.reportIssueUrl);
		if (!repository) {
			return { kind: 'failed', reason: localize('onyx.update.noRepository', "This build does not name a project repository to ask.") };
		}
		let releases: IOnyxRawRelease[] | null;
		try {
			const context = await this._requestService.request({
				type: 'GET',
				url: onyxReleasesApiUrl(repository),
				headers: { 'Accept': 'application/vnd.github+json' },
				timeout: REQUEST_TIMEOUT_MS,
				disableCache: true,
				callSite: 'NO_FETCH_TELEMETRY',
			}, token);
			releases = await asJson<IOnyxRawRelease[]>(context);
		} catch (error) {
			return { kind: 'failed', reason: error instanceof Error ? error.message : String(error) };
		}
		if (!Array.isArray(releases)) {
			return { kind: 'failed', reason: localize('onyx.update.unreadable', "The release list could not be read.") };
		}
		return { kind: 'result', result: evaluateOnyxReleases(ONYX_VERSION, releases, repository, this._platform) };
	}

	describe(outcome: OnyxUpdateOutcome): IOnyxUpdateMessage {
		if (outcome.kind === 'failed') {
			return {
				severity: Severity.Warning,
				message: localize('onyx.update.failed', "Could Not Check for Updates"),
				detail: localize('onyx.update.failedDetail', "The release list was not read, so whether a newer release exists is not known. This build is {0}. Reason: {1}", ONYX_VERSION, outcome.reason),
				links: [],
			};
		}
		const result = outcome.result;
		if (result.state === OnyxUpdateState.Current) {
			return {
				severity: Severity.Info,
				message: localize('onyx.update.current', "No Newer Release"),
				detail: result.latestVersion
					? localize('onyx.update.currentDetail', "This build is {0}. The newest published release is {1}.", result.currentVersion, result.latestVersion)
					: localize('onyx.update.noneDetail', "This build is {0}. No release has been published yet.", result.currentVersion),
				links: [],
			};
		}
		const links: { label: string; url: string }[] = [];
		if (result.assetUrl) {
			links.push({ label: localize('onyx.update.download', "Open Download"), url: result.assetUrl });
		}
		if (result.checksumUrl) {
			links.push({ label: localize('onyx.update.checksum', "Open Checksum"), url: result.checksumUrl });
		}
		if (result.releaseUrl) {
			links.push({ label: localize('onyx.update.notes', "Open Release Notes"), url: result.releaseUrl });
		}
		const replace = localize('onyx.update.manual', "Onyx does not update itself. Download the disk image, compare its SHA-256 with the published checksum, quit Onyx and replace the application. Your settings and run journals are kept.");
		return {
			severity: Severity.Info,
			message: localize('onyx.update.newer', "Onyx {0} Is Available", result.latestVersion ?? ''),
			detail: !result.platformSupported
				? localize('onyx.update.unsupportedPlatform', "This build is {0}. The release has no artifact for this platform ({1}); the alpha is built for Apple silicon Macs only.", result.currentVersion, this._platform)
				: result.assetUrl
					? localize('onyx.update.newerDetail', "This build is {0}. {1}", result.currentVersion, replace)
					: localize('onyx.update.newerNoAsset', "This build is {0}. The release page does not list a disk image for this platform yet. {1}", result.currentVersion, replace),
			links,
		};
	}

	async run(token: CancellationToken): Promise<void> {
		const message = this.describe(await this.check(token));
		const buttons: IPromptButton<string>[] = message.links.map(link => ({ label: link.label, run: () => link.url }));
		const { result } = await this._dialogService.prompt<string>({
			type: message.severity,
			message: message.message,
			detail: message.detail,
			buttons,
			cancelButton: localize('onyx.update.close', "Close"),
		});
		if (result) {
			await this._openerService.open(URI.parse(result), { openExternal: true });
		}
	}
}
