# Releasing

How a release artifact is made (D2, D4, DEC-08). The owner does the parts that need an Apple account; everything else is the `Onyx release` workflow.

The release is one file: a signed, notarized, stapled disk image for Apple-silicon Macs, with its SHA-256, attached to a GitHub Release. There is no Mac App Store build, and no instruction anywhere tells a user to bypass Gatekeeper. An artifact Gatekeeper does not accept is not uploaded.

## Once: what only the owner can do

1. **Enrol in the Apple Developer Program** (developer.apple.com, paid, yearly). Enrolment can take days for an organisation and is usually quicker for an individual.
2. **Create a Developer ID Application certificate.** In Xcode: Settings, Accounts, Manage Certificates, add "Developer ID Application". Or create it at developer.apple.com under Certificates. It must be *Developer ID Application*: an Apple Development or Mac App Distribution certificate cannot sign a direct download, and the workflow says so if it finds the wrong kind.
3. **Export it as a `.p12`** from Keychain Access (select the certificate together with its private key, Export, set a password).
4. **Create an App Store Connect API key for notarization**: appstoreconnect.apple.com, Users and Access, Integrations, App Store Connect API, a team key with the Developer role. Download the `.p8` (it can be downloaded once) and note the key id and the issuer id.
5. **Store five repository secrets** (repository Settings, Secrets and variables, Actions):

   | Secret | Value |
   |---|---|
   | `APPLE_DEVELOPER_ID_P12_BASE64` | `base64 -i certificate.p12 \| pbcopy` |
   | `APPLE_DEVELOPER_ID_P12_PASSWORD` | the `.p12` password |
   | `APPLE_NOTARY_KEY_P8_BASE64` | `base64 -i AuthKey_XXXXXXXXXX.p8 \| pbcopy` |
   | `APPLE_NOTARY_KEY_ID` | the key id |
   | `APPLE_NOTARY_ISSUER_ID` | the issuer id |

   Delete the local `.p12` and `.p8` afterwards or keep them somewhere that is not a repository.

Until all five exist, the workflow's first job fails and names the missing ones. That is the intended behaviour, not a defect.

## Each release

1. `ONYX_VERSION` in `src/vs/workbench/contrib/onyx/common/onyxUpdateCheck.ts` is the version being released. The workflow refuses a version that differs from it, and refuses one whose tag already exists.
2. All five module gates are recorded as passed for the commit in `docs/progress/STATE.md`.
3. Run the workflow from that commit: Actions, "Onyx release", Run workflow, enter the version without the leading `v`.
4. The workflow builds the app, signs every binary with the hardened runtime and upstream's entitlements, notarizes and staples the app, builds the disk image, signs, notarizes and staples it, records the Gatekeeper evidence, runs the packaged smoke and the extension smoke on the signed application, writes the release notes from `docs/release/NOTES-TEMPLATE.md`, and creates a **draft** release with the disk image, the `.sha256`, `gatekeeper-evidence.json` and both smoke reports attached. It creates no tag.
5. Download the disk image from the draft and carry out `docs/RUNBOOK-clean-install.md` on a fresh macOS user account. Link the recording in the draft's notes where it says the run has not happened yet.
6. Check that the README's download link is the direct link to this version's asset. `/releases/latest` skips pre-releases, so while the version has a pre-release part the link must name the tag.
7. Publish the draft. Publishing creates the tag `v<version>` at the built commit. This is E4, and it is the owner's click.

## What the evidence is (R-39)

`gatekeeper-evidence.json` holds the full output of these, and the job fails unless all pass:

```
codesign --verify --deep --strict --verbose=2 <app>
codesign --display --verbose=4 <app>                                     (hardened runtime flag)
spctl -a -vvv -t exec <app>                                               (source=Notarized Developer ID)
spctl -a -vvv -t open --context context:primary-signature <dmg>           (accepted)
xcrun stapler validate <app>
xcrun stapler validate <dmg>
```

The last clause of R-39, that a fresh user account launching offline sees only the standard confirmation, is a person's observation: step 5.

## Rehearsing without a certificate

```bash
ditto ../VSCode-darwin-arm64/Onyx.app /tmp/rehearsal/Onyx.app
node build/darwin/onyx-release.ts --app /tmp/rehearsal/Onyx.app --out /tmp/rehearsal/out --ad-hoc
```

This signs with the ad-hoc identity, skips notarization, and names the file `…-NOT-NOTARIZED.dmg`. It proves that signing, verification, the disk image and the checksum work. Gatekeeper rejects the result, the evidence file records four of six requirements as not met, and the rehearsed application does not launch: the hardened runtime refuses to load a framework without a Team ID, and an ad-hoc signature has none. Nothing made this way is a release. Run on a copy: signing changes the bundle in place.

## State on 2026-11-22

The rehearsal has been run once on the reference machine (2 of 6 requirements met, as expected: the signature verifies and the hardened runtime flag is set). The real path, with a certificate and notarization, has never been run: no enrolment and no secrets exist yet. R-39 is therefore **not passed**, and the release workflow's signed path is untested until the first dispatch with secrets. Expect to fix something on that first run.
