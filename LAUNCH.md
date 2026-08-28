# Shipping Onyx on macOS

How to go from this repo to a distributable, signed macOS app.

## Channel

Onyx ships as a **notarized DMG outside the Mac App Store**. The Mac App
Store requires App Sandbox entitlements that VS Code-derived Electron apps
cannot satisfy (spawning language servers, ptys, JIT, arbitrary workspace
file access) — upstream VS Code is not on MAS for the same reason. Direct
distribution with Developer ID signing + notarization gives the same
Gatekeeper-clean install experience.

## 1. Build the app

```bash
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
npm ci
npm run gulp vscode-darwin-arm64-min      # minified production build
# → emits ../VSCode-darwin-arm64/Onyx.app (name comes from product.json)
```

For Intel Macs use `vscode-darwin-x64-min`; universal builds combine both
with `vscode-darwin-universal`.

What makes the build Onyx (all checked in):

- `product.json` — nameShort/nameLong `Onyx`, bundle id `com.onyx.editor`,
  `.onyx` data folder, `onyx` URL protocol, telemetry removed
- `resources/darwin/code.icns` — the Onyx app icon (faceted gem)
- `extensions/theme-onyx/` — Onyx Dark and Onyx Light themes + the featured
  Get Started walkthrough; the default dark theme is pinned in
  `workbenchThemeService.ts`
- everything under `src/vs/platform/onyxRuntime/` and
  `src/vs/workbench/contrib/onyx/`

## 2. Sign (requires your Developer ID certificate)

```bash
export APP=../VSCode-darwin-arm64/Onyx.app
codesign --force --deep --options runtime \
  --entitlements build/azure-pipelines/darwin/app-entitlements.plist \
  --sign "Developer ID Application: YOUR NAME (TEAMID)" "$APP"
codesign --verify --deep --strict "$APP"
```

The hardened-runtime entitlements VS Code uses (JIT, unsigned executable
memory, library validation disable — required by Electron/Node) are in
`build/azure-pipelines/darwin/`.

## 3. Notarize

```bash
ditto -c -k --keepParent "$APP" Onyx.zip
xcrun notarytool submit Onyx.zip --apple-id you@example.com \
  --team-id TEAMID --password <app-specific-password> --wait
xcrun stapler staple "$APP"
```

## 4. Package the DMG

```bash
mkdir -p dmg-root && cp -R "$APP" dmg-root/ && ln -s /Applications dmg-root/Applications
hdiutil create -volname "Onyx" -srcfolder dmg-root -ov -format UDZO Onyx.dmg
```

## Pre-flight checklist

- [ ] `npm run typecheck-client`, `npm run valid-layers-check`, eslint on
      the two Onyx directories, `npm run stylelint`, and
      `./scripts/test.sh --grep Onyx` all green
- [ ] `node test/onyx/run-e2e.mts` passes against the mock runtime
- [ ] Fresh-profile launch: onboarding opens on **Connect a Local Runtime**
      (not a sign-in), Onyx Dark preselected, Onyx icon in the Dock,
      "Get Started with Onyx" featured on the Welcome page
- [ ] Nothing on a fresh profile mentions another vendor's assistant, and
      no "Sign In" pill appears in the title bar
- [ ] With a local runtime up: models in the picker, streaming chat,
      control plane live, ghost-text autocomplete, `Onyx: Manage Models`
      shows this machine's memory tier
- [ ] With no runtime: the designed "No local model yet" state in chat and
      the control plane, no errors in the console
- [ ] Both themes: Onyx Dark and Onyx Light render the control plane, chat
      and the empty states correctly
- [ ] `REBASE.md` still lists every upstream file touched
