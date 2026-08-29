---
name: new-control-plane-view
description: Add a new view to the Onyx control plane correctly
when-to-use: When adding any new Onyx view or panel to the workbench
tools: editFile, repoSymbols
---

1. Pure logic goes in `src/vs/workbench/contrib/onyx/common/` with unit tests in `test/browser/` — prefer one snapshot-style `assert.deepStrictEqual` per test.
2. The view class extends `ViewPane` in a new folder under `browser/`; register it in `browser/controlPlane/onyxControlPlane.contribution.ts` with a `SyncDescriptor`.
3. Services are injected in the constructor only, never resolved later; disposables register immediately (`this._register`).
4. CSS uses design tokens only: the spacing ramp, `cornerRadius` tiers, `fontSize` roles, `--vscode-*` color vars (register new colors in `onyxColors.ts`, then add them to `build/lib/stylelint/vscode-known-variables.json`).
5. Accessibility is not optional: add the view id to `CONTROL_PLANE_FOCUSED` in `onyxAccessibility.ts`, extend the help text, and announce streaming state politely via `aria.status`.
6. Every user-visible string goes through `nls.localize`, with title-style capitalization on commands and buttons.
