/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The macOS release artifact (D2, DEC-08): sign, notarize, staple, disk image,
 * checksum, and the Gatekeeper evidence R-39 asks for.
 *
 *   node build/darwin/onyx-release.ts --app <path/to/Product.app> --out <dir> [--ad-hoc]
 *
 * With credentials it needs, in the environment:
 *   CODESIGN_IDENTITY     the "Developer ID Application: …" identity, in a keychain on the search list
 *   ONYX_NOTARY_KEY       path to the App Store Connect API key (.p8)
 *   ONYX_NOTARY_KEY_ID    its key id
 *   ONYX_NOTARY_ISSUER    its issuer id
 * and it stops before doing anything, naming what is missing, when one is not there.
 *
 * `--ad-hoc` is the rehearsal: it signs with the ad-hoc identity, skips
 * notarization and stapling, and marks the file name NOT-NOTARIZED. It proves
 * the mechanics on a machine without a certificate. Gatekeeper rejects its
 * output, the evidence file says so, and it is never a release. The rehearsed
 * application does not launch either: the hardened runtime's library
 * validation refuses to load a framework without a Team ID, and an ad-hoc
 * signature has none ("different Team IDs" in the crash report, seen on
 * 2026-11-22). A Developer ID signature gives every binary the same one.
 *
 * The app is signed in place: pass a copy when the original must stay as built.
 * Every binary is signed with the hardened runtime and the entitlements upstream
 * ships in build/azure-pipelines/darwin, chosen per helper exactly as
 * build/darwin/sign.ts chooses them. That script is not called because it
 * requires a build-agent keychain path and writes usage descriptions that name
 * another product.
 */

import { spawnSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { sign, type SignOptions } from '@electron/osx-sign';
import { getElectronVersion } from '../lib/electronVersion.ts';

const root = path.dirname(path.dirname(import.meta.dirname));
const entitlementsDir = path.join(root, 'build', 'azure-pipelines', 'darwin');
const ARCH = 'arm64';

function argValue(flag: string): string | undefined {
	const index = process.argv.indexOf(flag);
	return index === -1 ? undefined : process.argv[index + 1];
}

interface IStep {
	readonly name: string;
	readonly command: string;
	readonly exitCode: number;
	readonly output: string;
	/** What R-39 requires of this step, and whether the output met it. */
	readonly requirement?: string;
	readonly met?: boolean;
}

const steps: IStep[] = [];

function run(name: string, command: string, args: readonly string[], options: { allowFailure?: boolean; requirement?: string; expect?: RegExp; secret?: boolean } = {}): IStep {
	console.log(`\n== ${name}`);
	const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
	const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
	const exitCode = result.status ?? 1;
	console.log(output.split('\n').slice(-40).join('\n'));
	const met = options.requirement === undefined ? undefined : exitCode === 0 && (options.expect ? options.expect.test(output) : true);
	const step: IStep = {
		name,
		// The key path, key id and issuer are not secrets, but nothing is gained by recording them.
		command: options.secret ? `${command} ${args[0]} ${args[1]} …` : [command, ...args].join(' '),
		exitCode,
		output,
		requirement: options.requirement,
		met,
	};
	steps.push(step);
	if (exitCode !== 0 && !options.allowFailure) {
		throw new Error(`${name} failed with exit code ${exitCode}`);
	}
	return step;
}

function entitlementsFor(filePath: string): string {
	if (filePath.includes(' Helper (GPU).app')) {
		return path.join(entitlementsDir, 'helper-gpu-entitlements.plist');
	} else if (filePath.includes(' Helper (Renderer).app')) {
		return path.join(entitlementsDir, 'helper-renderer-entitlements.plist');
	} else if (filePath.includes(' Helper (Plugin).app')) {
		return path.join(entitlementsDir, 'helper-plugin-entitlements.plist');
	} else if (filePath.includes(' Helper.app')) {
		return path.join(entitlementsDir, 'helper-entitlements.plist');
	}
	return path.join(entitlementsDir, 'app-entitlements.plist');
}

/** The release this tree builds, from the one place that names it. */
function sourceVersion(): string {
	const source = fs.readFileSync(path.join(root, 'src', 'vs', 'workbench', 'contrib', 'onyx', 'common', 'onyxUpdateCheck.ts'), 'utf8');
	const version = /export const ONYX_VERSION = '(?<version>[^']+)'/.exec(source)?.groups?.version;
	if (!version) {
		throw new Error('ONYX_VERSION not found in common/onyxUpdateCheck.ts');
	}
	return version;
}

function sha256(file: string): string {
	return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function notarize(what: string, file: string, key: string, keyId: string, issuer: string): void {
	const submission = run(`Notarize the ${what}`, 'xcrun', ['notarytool', 'submit', file, '--key', key, '--key-id', keyId, '--issuer', issuer, '--wait', '--output-format', 'json'], { allowFailure: true, secret: true });
	let status: string | undefined;
	let id: string | undefined;
	try {
		const parsed = JSON.parse(submission.output.slice(submission.output.indexOf('{'))) as { status?: string; id?: string };
		status = parsed.status;
		id = parsed.id;
	} catch {
		// reported below with the raw output
	}
	if (status !== 'Accepted') {
		if (id) {
			run(`Notarization log for the ${what}`, 'xcrun', ['notarytool', 'log', id, '--key', key, '--key-id', keyId, '--issuer', issuer], { allowFailure: true, secret: true });
		}
		throw new Error(`Apple did not accept the ${what}: status ${status ?? 'unknown'}`);
	}
	run(`Staple the ${what}`, 'xcrun', ['stapler', 'staple', file]);
}

async function main(): Promise<void> {
	const appArg = argValue('--app');
	const outArg = argValue('--out');
	const adHoc = process.argv.includes('--ad-hoc');
	if (!appArg || !outArg) {
		throw new Error('usage: node build/darwin/onyx-release.ts --app <path/to/Product.app> --out <dir> [--ad-hoc]');
	}
	if (process.platform !== 'darwin') {
		throw new Error('the release artifact is built on macOS');
	}
	const app = path.resolve(appArg);
	const out = path.resolve(outArg);
	if (!fs.existsSync(path.join(app, 'Contents', 'Info.plist'))) {
		throw new Error(`not an application bundle: ${app}`);
	}

	const identity = adHoc ? '-' : process.env['CODESIGN_IDENTITY'];
	const key = process.env['ONYX_NOTARY_KEY'];
	const keyId = process.env['ONYX_NOTARY_KEY_ID'];
	const issuer = process.env['ONYX_NOTARY_ISSUER'];
	if (!adHoc) {
		const missing = [
			['CODESIGN_IDENTITY', identity],
			['ONYX_NOTARY_KEY', key && fs.existsSync(key) ? key : undefined],
			['ONYX_NOTARY_KEY_ID', keyId],
			['ONYX_NOTARY_ISSUER', issuer],
		].filter(([, value]) => !value).map(([name]) => name);
		if (missing.length) {
			throw new Error(`cannot sign or notarize: ${missing.join(', ')} not set (or the key file does not exist). Nothing was changed. Use --ad-hoc only to rehearse the mechanics; its output is not a release.`);
		}
	}

	const product = JSON.parse(fs.readFileSync(path.join(app, 'Contents', 'Resources', 'app', 'product.json'), 'utf8')) as { nameLong: string; commit?: string };
	const version = sourceVersion();
	const baseName = `${product.nameLong.replace(/\s+/g, '-')}-${version}-darwin-${ARCH}${adHoc ? '-NOT-NOTARIZED' : ''}`;
	fs.mkdirSync(out, { recursive: true });
	const dmg = path.join(out, `${baseName}.dmg`);
	console.log(`${product.nameLong} ${version} (${product.commit ?? 'no commit in product.json'}) → ${path.basename(dmg)}${adHoc ? '  [ad-hoc rehearsal: not a release]' : ''}`);

	// 1. Sign every binary in the bundle, innermost first, hardened runtime on.
	console.log('\n== Sign the application');
	const options: SignOptions = {
		app,
		platform: 'darwin',
		optionsForFile: filePath => ({ entitlements: entitlementsFor(filePath), hardenedRuntime: true }),
		preAutoEntitlements: false,
		preEmbedProvisioningProfile: false,
		version: getElectronVersion(root).electronVersion,
		identity,
		identityValidation: !adHoc,
	};
	await sign(options);

	run('Verify the application signature', 'codesign', ['--verify', '--deep', '--strict', '--verbose=2', app], { requirement: 'codesign --verify --deep --strict passes for the app' });
	run('Signature details', 'codesign', ['--display', '--verbose=4', app], { requirement: 'the hardened runtime flag is set', expect: /flags=0x1[0-9a-f]*\(.*runtime.*\)/ });

	// 2. Notarize and staple the application, so that the first launch needs no network.
	if (!adHoc) {
		const zip = path.join(os.tmpdir(), `${baseName}-${process.pid}.zip`);
		try {
			run('Archive the application for notarization', 'ditto', ['-c', '-k', '--keepParent', app, zip]);
			notarize('application', zip, key!, keyId!, issuer!);
		} finally {
			fs.rmSync(zip, { force: true });
		}
		// `stapler staple` on the archive staples nothing: the ticket goes on the bundle.
		run('Staple the application', 'xcrun', ['stapler', 'staple', app]);
	}

	// 3. The disk image: the stapled application and a link to /Applications.
	const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'onyx-dmg-'));
	try {
		run('Copy the application into the image folder', 'ditto', [app, path.join(staging, path.basename(app))]);
		fs.symlinkSync('/Applications', path.join(staging, 'Applications'));
		fs.rmSync(dmg, { force: true });
		run('Create the disk image', 'hdiutil', ['create', '-volname', product.nameLong, '-srcfolder', staging, '-fs', 'HFS+', '-format', 'UDZO', '-ov', dmg]);
	} finally {
		fs.rmSync(staging, { recursive: true, force: true });
	}
	run('Sign the disk image', 'codesign', ['--force', '--sign', identity!, ...(adHoc ? [] : ['--timestamp']), dmg]);
	if (!adHoc) {
		notarize('disk image', dmg, key!, keyId!, issuer!);
	}

	// 4. Gatekeeper evidence (R-39). In a rehearsal these are expected to be rejected, and are recorded as not met.
	const evidence = [
		run('Gatekeeper: the application', 'spctl', ['-a', '-vvv', '-t', 'exec', app], { allowFailure: true, requirement: 'spctl reports source=Notarized Developer ID for the app', expect: /source=Notarized Developer ID/ }),
		run('Gatekeeper: the disk image', 'spctl', ['-a', '-vvv', '-t', 'open', '--context', 'context:primary-signature', dmg], { allowFailure: true, requirement: 'spctl accepts the disk image', expect: /accepted/ }),
		run('Stapled ticket: the application', 'xcrun', ['stapler', 'validate', app], { allowFailure: true, requirement: 'stapler validate succeeds for the app' }),
		run('Stapled ticket: the disk image', 'xcrun', ['stapler', 'validate', dmg], { allowFailure: true, requirement: 'stapler validate succeeds for the disk image' }),
	];

	// 5. Checksum, in the format `shasum -a 256 -c` reads.
	const digest = sha256(dmg);
	fs.writeFileSync(`${dmg}.sha256`, `${digest}  ${path.basename(dmg)}\n`);
	console.log(`\n${digest}  ${path.basename(dmg)}`);

	const required = steps.filter(step => step.requirement !== undefined);
	const passed = required.every(step => step.met);
	fs.writeFileSync(path.join(out, 'gatekeeper-evidence.json'), JSON.stringify({
		regression: 'R-39',
		ranAt: new Date().toISOString(),
		macOS: spawnSync('sw_vers', ['-productVersion'], { encoding: 'utf8' }).stdout.trim(),
		adHocRehearsal: adHoc,
		product: product.nameLong,
		version,
		commit: product.commit,
		artifact: path.basename(dmg),
		sha256: digest,
		bytes: fs.statSync(dmg).size,
		requirements: required.map(step => ({ requirement: step.requirement, met: step.met, command: step.command, exitCode: step.exitCode, output: step.output })),
		passed,
		// The last clause of R-39 is a person's observation and is not something this script can record.
		notCoveredHere: 'first launch on a fresh macOS user account, offline, showing only the standard downloaded-app confirmation (docs/RUNBOOK-clean-install.md)',
	}, undefined, '\t'));
	console.log(`\nGatekeeper evidence: ${required.filter(step => step.met).length} of ${required.length} requirements met → ${path.join(out, 'gatekeeper-evidence.json')}`);
	for (const step of evidence.filter(step => !step.met)) {
		console.log(`  not met: ${step.requirement}`);
	}
	if (adHoc) {
		console.log('ad-hoc rehearsal finished: the mechanics ran. This file is not notarized, must not be distributed, and will not launch (library validation needs a Team ID)');
		return;
	}
	if (!passed) {
		throw new Error('the artifact was built but Gatekeeper does not accept it; it is not a release');
	}
}

main().then(() => process.exit(0), error => {
	console.error(`\nonyx-release: ${error instanceof Error ? error.message : error}`);
	process.exit(1);
});
