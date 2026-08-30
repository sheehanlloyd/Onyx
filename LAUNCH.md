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

- [ ] `npm run typecheck-client`, `npm run valid-layers-check`,
      `npx eslint src/vs/platform/onyxRuntime src/vs/workbench/contrib/onyx test/onyx`,
      `npm run stylelint`, and `./scripts/test.sh --grep Onyx` all green
- [ ] `node test/onyx/run-e2e.mts` passes against the mock runtimes (45 checks;
      stop a real Ollama/LM Studio on :11434/:1234 first — it refuses otherwise)
- [ ] The full unit suite (`./scripts/test.sh`) is at zero failures
- [ ] Fresh-profile launch: onboarding opens on **Connect a Local Runtime**
      (not a sign-in), Onyx Dark preselected, Onyx icon in the Dock,
      "Get Started with Onyx" featured on the Welcome page
- [ ] Nothing on a fresh profile mentions another vendor's assistant: no
      "Sign In" pill, and **no GitHub Copilot entry under Extensions →
      Built-in** (the packaged build excludes it; a dev launch still shows it)
- [ ] With a local runtime up: models in the picker, streaming chat, control
      plane live, ghost-text autocomplete, ⌘I inline edit applies reviewable
      hunks, `Onyx: Manage Models` shows this machine's memory tier
- [ ] The Onyx Hub (⌘⌃H) opens and every row shows live state
- [ ] Agent edits STAGE into Onyx Changes (nothing touches a buffer until
      accepted), per-hunk accept/reject works, and staged edits survive a
      forced quit
- [ ] The terminal tool asks before every command, names dangerous ones,
      persists "always allow" into `.onyx/config.json`, and
      `Onyx: Kill Running Terminal Command` ends a running one
- [ ] The `docs` tool answers from the offline mirror and the control plane
      names the documents used
- [ ] `Onyx: Run a Playbook` lists `.onyx/playbooks/*.md` and a broken
      playbook shows markers, not a broken picker
- [ ] `Onyx: Resume an Interrupted Run` rebuilds a stopped run with its
      caveats (model gone / HEAD moved / staged edits) spelled out
- [ ] `Onyx: Explain This Failure` sends the visible paused-debugger snapshot;
      with no session it says so instead
- [ ] `Onyx: Rename Symbol` offers model names and stages the
      language-service edit for review; accepting reports the marker verdict
- [ ] `Onyx: Benchmark on This Repo` produces scored tasks from real commits
      and the scores appear in later routing reasons
- [ ] The Architecture Map renders this repository's modules in a few seconds
      with hot spots and local-model summaries
- [ ] With LM Studio running: only its chat models appear (never the embedding
      model), and `Onyx: Measure Speculative Decoding` measures a baseline
      then shows the exact `lms load --speculative-draft-model …` command
- [ ] `Onyx: Run in Parallel` races models in worktrees and leaves none behind
      (`git worktree list` shows only the repository itself afterwards)
- [ ] `Onyx: Export Diagnostics` writes a readable zip and the redaction
      checkbox is unchecked by default
- [ ] With no runtime: the designed "No local model yet" state in chat and the
      control plane, no errors in the console; killing the runtime mid-answer
      shows a plain-language message, never `terminated`
- [ ] All four themes — Onyx Dark, Onyx Light, and both high-contrast variants —
      render the control plane, chat, inline edit and the empty states correctly
- [ ] `REBASE.md` still lists every upstream file touched, and its merge-drill
      section names the last upstream commit tested
