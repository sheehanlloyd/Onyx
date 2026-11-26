/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { bufferToStream, VSBuffer } from '../../../../../base/common/buffer.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Event } from '../../../../../base/common/event.js';
import { IRequestContext, IRequestOptions } from '../../../../../base/parts/request/common/request.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { TestDialogService } from '../../../../../platform/dialogs/test/common/testDialogService.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { IProductService } from '../../../../../platform/product/common/productService.js';
import { IRequestService } from '../../../../../platform/request/common/request.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { workbenchInstantiationService } from '../../../../test/browser/workbenchTestServices.js';
import { OnyxUpdateCheck } from '../../browser/update/onyxUpdateCheck.js';
import { compareOnyxVersions, evaluateOnyxReleases, IOnyxRawRelease, ONYX_VERSION, onyxReleasesApiUrl, onyxRepositoryFromIssueUrl } from '../../common/onyxUpdateCheck.js';

/**
 * D3: `Onyx: Check for Updates`. The command asks the project's release list
 * once, when invoked, and reports a newer release, no newer release, or that
 * it could not tell. The network is a fake: what is under test is what the
 * product concludes from each answer, and that a failure is never reported as
 * "up to date".
 */
suite('OnyxUpdateCheck', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	const repository = { owner: 'example', name: 'editor' };
	const release = (tag: string, extra: Partial<IOnyxRawRelease> = {}): IOnyxRawRelease => ({
		tag_name: tag,
		html_url: `https://github.com/example/editor/releases/tag/${tag}`,
		draft: false,
		assets: [
			{ name: `Editor-${tag}-darwin-arm64.dmg`, browser_download_url: `https://github.com/example/editor/releases/download/${tag}/Editor-${tag}-darwin-arm64.dmg` },
			{ name: `Editor-${tag}-darwin-arm64.dmg.sha256`, browser_download_url: `https://github.com/example/editor/releases/download/${tag}/Editor-${tag}-darwin-arm64.dmg.sha256` },
		],
		...extra,
	});

	/** A request service that answers with a status and a body, or fails as a network does, and records what it was asked. */
	function createCheck(answer: { status: number; body: string } | Error, platform = 'darwin-arm64') {
		const requests: IRequestOptions[] = [];
		const opened: string[] = [];
		const instantiationService = workbenchInstantiationService(undefined, store);
		instantiationService.stub(IProductService, { _serviceBrand: undefined, reportIssueUrl: 'https://github.com/example/editor/issues/new' } as IProductService);
		instantiationService.stub(IRequestService, {
			_serviceBrand: undefined,
			onDidCompleteRequest: Event.None,
			request: async (options: IRequestOptions): Promise<IRequestContext> => {
				requests.push(options);
				if (answer instanceof Error) {
					throw answer;
				}
				return { res: { headers: {}, statusCode: answer.status }, stream: bufferToStream(VSBuffer.fromString(answer.body)) };
			},
		} as Partial<IRequestService> as IRequestService);
		instantiationService.stub(IDialogService, new TestDialogService());
		instantiationService.stub(IOpenerService, { _serviceBrand: undefined, open: async (target: unknown) => { opened.push(String(target)); return true; } } as Partial<IOpenerService> as IOpenerService);
		return { check: instantiationService.createInstance(OnyxUpdateCheck, platform), requests, opened };
	}

	async function describe(answer: { status: number; body: string } | Error, platform?: string) {
		const { check } = createCheck(answer, platform);
		const message = check.describe(await check.check(CancellationToken.None));
		return { message: message.message, links: message.links.map(link => link.url), mentionsFailure: /not known/.test(message.detail) };
	}

	test('version order follows semantic versioning, pre-releases included, and an unreadable tag has no order', () => {
		assert.deepStrictEqual({
			alphaBeforeNextAlpha: Math.sign(compareOnyxVersions('v0.1.0-alpha.1', '0.1.0-alpha.2')!),
			alphaTenAfterAlphaTwo: Math.sign(compareOnyxVersions('0.1.0-alpha.10', '0.1.0-alpha.2')!),
			alphaBeforeBeta: Math.sign(compareOnyxVersions('0.1.0-alpha.9', '0.1.0-beta.1')!),
			prereleaseBeforeRelease: Math.sign(compareOnyxVersions('0.1.0-alpha.1', '0.1.0')!),
			patchAfterRelease: Math.sign(compareOnyxVersions('0.1.1', 'v0.1.0')!),
			same: compareOnyxVersions('v0.1.0-alpha.1', '0.1.0-alpha.1'),
			shorterPrereleaseFirst: Math.sign(compareOnyxVersions('0.1.0-alpha', '0.1.0-alpha.1')!),
			notAVersion: compareOnyxVersions('nightly', '0.1.0'),
		}, {
			alphaBeforeNextAlpha: -1,
			alphaTenAfterAlphaTwo: 1,
			alphaBeforeBeta: -1,
			prereleaseBeforeRelease: -1,
			patchAfterRelease: 1,
			same: 0,
			shorterPrereleaseFirst: -1,
			notAVersion: undefined,
		});
	});

	test('the repository comes from the product, and only a GitHub issue URL names one', () => {
		assert.deepStrictEqual({
			fromProduct: onyxRepositoryFromIssueUrl('https://github.com/example/editor/issues/new'),
			api: onyxReleasesApiUrl(repository),
			elsewhere: onyxRepositoryFromIssueUrl('https://example.com/example/editor/issues/new'),
			missing: onyxRepositoryFromIssueUrl(undefined),
		}, {
			fromProduct: repository,
			api: 'https://api.github.com/repos/example/editor/releases?per_page=30',
			elsewhere: undefined,
			missing: undefined,
		});
	});

	test('the newest readable published release decides; drafts, unreadable tags and links outside the repository are ignored', () => {
		const evaluate = (releases: IOnyxRawRelease[], platform = 'darwin-arm64') => {
			const result = evaluateOnyxReleases('0.1.0-alpha.1', releases, repository, platform);
			return { state: result.state, latest: result.latestVersion, asset: result.assetUrl, checksum: result.checksumUrl, release: result.releaseUrl };
		};
		assert.deepStrictEqual({
			newer: evaluate([release('v0.1.0-alpha.1'), release('v0.1.0-alpha.3'), release('v0.1.0-alpha.2')]),
			same: evaluate([release('v0.1.0-alpha.1')]),
			older: evaluate([release('v0.0.9')]),
			none: evaluate([]),
			draftAndUnreadable: evaluate([release('v0.2.0', { draft: true }), release('latest'), {}]),
			foreignLinks: evaluate([release('v0.2.0', { html_url: 'https://example.com/phish', assets: [{ name: 'Editor-darwin-arm64.dmg', browser_download_url: 'https://example.com/Editor-darwin-arm64.dmg' }] })]),
			otherPlatform: evaluate([release('v0.2.0')], 'linux-x64'),
		}, {
			newer: { state: 'newer', latest: '0.1.0-alpha.3', asset: 'https://github.com/example/editor/releases/download/v0.1.0-alpha.3/Editor-v0.1.0-alpha.3-darwin-arm64.dmg', checksum: 'https://github.com/example/editor/releases/download/v0.1.0-alpha.3/Editor-v0.1.0-alpha.3-darwin-arm64.dmg.sha256', release: 'https://github.com/example/editor/releases/tag/v0.1.0-alpha.3' },
			same: { state: 'current', latest: '0.1.0-alpha.1', asset: undefined, checksum: undefined, release: undefined },
			older: { state: 'current', latest: '0.0.9', asset: undefined, checksum: undefined, release: undefined },
			none: { state: 'current', latest: undefined, asset: undefined, checksum: undefined, release: undefined },
			draftAndUnreadable: { state: 'current', latest: undefined, asset: undefined, checksum: undefined, release: undefined },
			foreignLinks: { state: 'newer', latest: '0.2.0', asset: undefined, checksum: undefined, release: 'https://github.com/example/editor/releases' },
			otherPlatform: { state: 'newer', latest: '0.2.0', asset: undefined, checksum: undefined, release: 'https://github.com/example/editor/releases/tag/v0.2.0' },
		});
	});

	test('a newer release, no newer release, and every kind of failure each say what they are', async () => {
		assert.deepStrictEqual({
			newer: await describe({ status: 200, body: JSON.stringify([release('v9.0.0')]) }),
			noNewer: await describe({ status: 200, body: JSON.stringify([release(`v${ONYX_VERSION}`)]) }),
			noReleases: await describe({ status: 200, body: '[]' }),
			networkDown: await describe(new Error('net::ERR_INTERNET_DISCONNECTED')),
			rateLimited: await describe({ status: 403, body: '{"message":"API rate limit exceeded"}' }),
			notJson: await describe({ status: 200, body: '<html>captive portal</html>' }),
			notAList: await describe({ status: 200, body: '{"message":"Not Found"}' }),
			otherPlatform: await describe({ status: 200, body: JSON.stringify([release('v9.0.0')]) }, 'darwin-x64'),
		}, {
			newer: { message: 'Onyx 9.0.0 Is Available', links: ['https://github.com/example/editor/releases/download/v9.0.0/Editor-v9.0.0-darwin-arm64.dmg', 'https://github.com/example/editor/releases/download/v9.0.0/Editor-v9.0.0-darwin-arm64.dmg.sha256', 'https://github.com/example/editor/releases/tag/v9.0.0'], mentionsFailure: false },
			noNewer: { message: 'No Newer Release', links: [], mentionsFailure: false },
			noReleases: { message: 'No Newer Release', links: [], mentionsFailure: false },
			networkDown: { message: 'Could Not Check for Updates', links: [], mentionsFailure: true },
			rateLimited: { message: 'Could Not Check for Updates', links: [], mentionsFailure: true },
			notJson: { message: 'Could Not Check for Updates', links: [], mentionsFailure: true },
			notAList: { message: 'Could Not Check for Updates', links: [], mentionsFailure: true },
			otherPlatform: { message: 'Onyx 9.0.0 Is Available', links: ['https://github.com/example/editor/releases/tag/v9.0.0'], mentionsFailure: false },
		});
	});

	test('one anonymous request to the release list, and the chosen link is opened outside the application', async () => {
		const { check, requests, opened } = createCheck({ status: 200, body: JSON.stringify([release('v9.0.0')]) });
		// The test dialog presses the first button: the download.
		await check.run(CancellationToken.None);
		assert.deepStrictEqual({
			requests: requests.map(request => ({ type: request.type, url: request.url, headers: request.headers, callSite: request.callSite })),
			opened,
		}, {
			requests: [{ type: 'GET', url: 'https://api.github.com/repos/example/editor/releases?per_page=30', headers: { 'Accept': 'application/vnd.github+json' }, callSite: 'NO_FETCH_TELEMETRY' }],
			opened: ['https://github.com/example/editor/releases/download/v9.0.0/Editor-v9.0.0-darwin-arm64.dmg'],
		});
	});
});
