# DEC-05. Move to upstream 1.147.0

```
Item: DEC-05 — Upstream baseline: move the fork from its August 2026 base to upstream release 1.147.0
  (decision confirmed by the owner on 2026-11-20; A9 recorded the trial and the recommendation)
Module: none. Its own step between Module 1 and Module 2, so that Module 1's gate is the acceptance test
  for the move and upstream churn is never debugged together with new feature code. No Module 2 item is started.
Branch / PR: upstream-1.147.0 → main (sheehanlloyd/Onyx#2). Module 1 (sheehanlloyd/Onyx#1) was merged into
  main first, with a merge commit (a7d60ac2856).
What changed:
  merge commit ed8f992f0cc — upstream tag 1.147.0 (8a14f0cc1b0), 7,778 commits, `git merge`, no rewritten
    history. `.nvmrc` (24.22.1), `packageManager` (pnpm@12.16.0) and the three pnpm lockfiles arrive
    with it, unmodified. Conflicts and resolutions are in "The merge" below
  src/vs/workbench/contrib/onyx/common/onyxConfiguration.ts — two more default overrides:
    `chat.defaultToCopilotHarness` and `chat.editor.preferCopilotHarness` are `false`
  src/vs/workbench/contrib/onyx/test/browser/onyxChatDefaults.test.ts — new: the regression for that
  src/vs/workbench/contrib/onyx/test/browser/sim/onyxSimFakes.ts — the fake dialog service implements
    the `hasDialog` member upstream added to IDialogService
  src/vs/platform/onyxRuntime/node/onyxDocsIndexer.ts, onyx/browser/model/onyxLanguageModelProvider.ts,
    onyx/common/onyxTextToolCalls.ts — four lint findings under upstream's newer rules
  product.json — Onyx values re-applied; `linuxDesktopName` is `onyx`; `mcpConnectorsUrl` removed
  build/gulpfile.vscode.ts — the Copilot compile step dropped again from upstream's restructured series
  .github/workflows/onyx-ci.yml, onyx-packaged.yml — corepack pnpm, frozen install, pnpm store cache,
    oxlint; the regeneration step after a cache hit is gone because the install always runs
  test/onyx/run-e2e.mts, run-packaged-smoke.mts — launch with a mock keychain; resolve @playwright/cli
    directly; bounded endpoint probe; an abort prints the failed command's output and saves a screenshot
  test/onyx/run-fresh.mts, run-module-gate.mts, gates/module-1.json, checks/*.test.mts — pnpm and oxlint
    commands; the gate prints and records the Node and pnpm versions
  test/onyx/run-hygiene.mts, .github/README.md — the helper folders of the workflows upstream added
  README.md, ONYX.md, LAUNCH.md, .github/CONTRIBUTING.md, .github/pull_request_template.md,
    .onyx/playbooks/*, docs/BENCHMARKS.md, docs/SUPPORT.md, test/onyx/README.md — build and gate commands
  REBASE.md — the merge record, a toolchain section, the two setting overrides, the decision row
  docs/progress/STATE.md, gate-module-1.json, packaged-smoke-baseline.json, packaged-smoke-release.json
Regression tests added: no Section 10 id applies. `OnyxChatDefaults` ("a new chat goes to the local
  harness, where the Onyx agent is the default"): on refreshed output it failed on the merged tree before
  the override (shipped defaults `true`, session type `agent-host-copilotcli`) and passes at cdc54c47aeb.
  The end-to-end suite is the second witness: it aborted at its first chat message before that commit.
Source revision / local diff: 881936cd52c, clean tree. The commit that adds this file follows it and
  changes only documents, one workflow comment (the suite's check count, 45 → 47) and the gate's result
  files.
Fresh output: frozen install with pnpm 12.16.0 (lockfiles byte-identical afterwards); `pnpm run compile`
  exit 0; `pnpm run gulp vscode-darwin-arm64-min` exit 0 at 881936cd52c; `node test/onyx/run-fresh.mts
  --stamp-only` ("pnpm run transpile-client exit 0", 2026-11-20T05:37:56Z), then the gate
Activated checks / optional scope: the Module 1 gate, all 23 checks, none added, removed or loosened.
  A8's release-mode failure stays the one named baseline exception (owner B1, B3)
Gate output (verbatim, trimmed to the summary lines):
  module gate 1 · 881936cd52c (clean source tree) · node v24.22.3 · pnpm 12.16.0
  typecheck: ok   layers: ok   eslint: ok ("oxlint: checked 153 files")   stylelint: ok   hygiene: ok
  unit: ok   benchmarks: ok   e2e: ok ("all 47 checks passed")
  packaged-baseline: ok   packaged-release: expected failure ("release mode: 5 of 15 checks failed",
    owner B1, B3)
  R-37, A4-paths, A6-fixtures, R-23, R-35, R-57, evidence-A1-A11, R-41, sim-smoke, sim-episodes,
    sim-tables-sync, R-43, R-43-unit: ok
  "23 checks: 22 passed, 1 expected failure(s), 0 skipped, 0 blocking" · "module 1 gate: PASSED" · exit 0
  The gate prints "ok" for the unit suite, not a count. The Section 11 run that followed it on the same
  output printed "181 passing, 2 pending", benchmarks exit 0 and "all 47 checks passed".
Metric before → after: upstream base 36d38757a15 (August 2026, 7,778 commits behind) → 1.147.0;
  Electron 42.8.1 → 43.8.9; Chromium 148 → 150; package manager npm → pnpm 12.16.0; Node pin 24.18.0 →
  24.22.1; end-to-end on the merged tree "could not run" (A9) → 47 of 47; gate shape unchanged
Evidence links: docs/progress/STATE.md; docs/progress/gate-module-1.json; REBASE.md ("Merge of upstream
  1.147.0"); CI runs 44682021132 (Onyx CI), 44682021232 (packaged smoke), 44682086587 (upstream drill),
  all on 881936cd52c
Scope notes: below, "Found and deliberately not changed"
Invariants touched / mutant added: none; `test/onyx/sim/baseline-exceptions.json` is unchanged and the
  2,000-episode campaign reports the same 28,888 boundaries and status mix as before the move
Human action needed: none for the plan. Two choices made here are the owner's to reverse: removing
  `mcpConnectorsUrl` instead of allowlisting it, and keeping upstream's Agent Host enabled (below).
```

## The merge

| What | Count | Resolution |
|---|---|---|
| Content conflicts A9 predicted | 5 | `build/gulpfile.vscode.ts`, `product.json`, `sharedProcessMain.ts`, `accessibilityConfiguration.ts`, `onboardingVariationA.ts`, each as its `REBASE.md` row says |
| Modify/delete conflicts A9 did not count | 14 | `CODENOTIFY`, `CODEOWNERS`, `dependabot.yml` and eleven workflows. A11 deleted them after A9's trial ran; they stay deleted |
| Upstream files added that must not exist here | 5 workflows, 2 helper folders | Merged without a conflict; deleted in the merge commit. The hygiene check is what names them |

After the merge the tree differs from upstream 1.147.0 only in Onyx-owned paths, the files `REBASE.md`
lists, and those deletions. `build/lib/extensions.ts` and `build/gulpfile.extensions.ts` are now identical
to upstream's: upstream excludes the Copilot extension from the generic extension scan itself.

## The end-to-end break A9 recorded

A9 could not run the suite on the merged tree: the workbench launched and answered on the debugging
port, and `@playwright/cli` then timed out "retrieving websocket url". It named two leads, the newer
playwright-core and Electron 43's handshake. Neither is the cause.

**Root cause.** At startup the workbench asks secret storage for a key. That calls
`EncryptionMainService.isEncryptionAvailable()`, which is Electron `safeStorage`, which reads the
"Onyx Safe Storage" key from the macOS login keychain, synchronously, on the main thread. The key
belongs to the Electron binary that created it. Electron 43.8.9 is a different executable from the
Electron 42 that did, so macOS asks the user for permission and the read waits for the answer. The
debugging endpoint is served from that thread.

| Evidence | Observation |
|---|---|
| Endpoint | `/json/version` answers 2 s after launch; from then on every request to the port times out |
| `sample` of the main process | every sample in `SecItemCopyMatching` → `SecKeychainItemCopyContent` → `mach_msg` |
| Screen | a `SecurityAgent` window (the keychain permission prompt) |
| Same build, `--use-mock-keychain` | endpoint stays responsive; the driver attaches (playwright-core 1.64.0-alpha, Electron 43.8.9, Chrome 150) |
| `--log=trace` on the August base and on 1.147.0 | identical startup calls: one secret read, one `isEncryptionAvailable`. The code path is not new |

It cannot appear on CI: Linux has no macOS keychain and a hosted macOS runner has a fresh one. It
appears on any developer machine whose keychain key was created by an earlier Electron, which is every
machine after this move, for the packaged app too.

**Fix.** The end-to-end runner (on macOS) and the packaged smoke launch with `--use-mock-keychain`.
No check changed. A signed build has a stable identity and does not prompt on update; that is D2's
work and is not addressed here.

## The break behind it

With the driver attached, the suite aborted at its first chat message. This one is a product
regression and would have failed on Linux CI as well.

**Root cause.** Upstream turned `chat.defaultToCopilotHarness` and `chat.editor.preferCopilotHarness`
on between the August base and 1.147.0. With both on, a new chat in the panel is an Agent Host
Copilot session (`agent-host-copilotcli`). The first message opens "Sign in to use GitHub Copilot";
Onyx's agent, the default of the local harness, is never asked; the dialog then holds focus and the
next step fails with "Chat input did not retain focus". A fresh profile also showed "Chat with
Copilot" and a sign-in banner.

**Fix.** Both settings default to `false` in `onyxConfiguration.ts`, beside the existing override of
`chat.titleBar.signIn.enabled`. On a fresh profile the chat panel now reads "Local" and "Describe
what to build", with no sign-in banner.

## Toolchain

| | Before | After |
|---|---|---|
| Node | 24.18.0 pinned; 24.20.0 used | 24.22.1 pinned. CI ran 24.22.1. The gate machine ran 24.22.3 from Homebrew `node@24`, a newer 24.x, which the preinstall check accepts |
| Package manager | npm, `package-lock.json` | pnpm 12.16.0 through corepack, `pnpm-lock.yaml` plus one each for `build/` and `remote/` |
| Install | `npm ci` | `GIT_LFS_SKIP_SMUDGE=1 pnpm_config_frozen_lockfile=true pnpm install --frozen-lockfile`. Only frozen installs were run; the three lockfiles are byte-identical before and after |
| CI cache | `node_modules` directories; install skipped on a hit; a step regenerated what postinstall writes | pnpm's store; the install always runs, so nothing needs regenerating. Cold install on the Linux runner: 150 s |
| Lint | `npx eslint` (a warning passed) | `pnpm run oxlint` (a warning fails). Verified with injected violations: a missing header, a product import from the harness, a layering break and an `any` each fail it |
| End-to-end driver | `npx @playwright/cli` | the installed `@playwright/cli`, resolved and run with the same Node |

## Found and deliberately not changed

- **Upstream's Agent Host still starts with the product.** It is the Copilot SDK harness that the two
  settings above made the default. Only the default moved back; its session types remain selectable
  in the chat panel, and choosing one leads to GitHub sign-in. Whether a local-only product should
  exclude it is a capability decision (DEC-03), which B3 owns.
- **`defaultChatAgent.mcpConnectorsUrl` was removed, not allowlisted.** Core treats it as optional and
  says "Copilot connectors are not available in this product" without it. Allowlisting it instead is a
  one-line change in `test/onyx/run-hygiene.mts` and `product.json`.
- **Four inert upstream inputs are kept** (`.github/rulesets/`, `.github/codeql/`, `.github/sandbox.yml`,
  `.github/hooks/`): nothing in this repository reads them once the workflows that did are deleted.
- **The upstream drill counts conflicts, not additions.** It reported five conflicts for this merge; the
  real merge had nineteen, and five added workflows on top that no conflict list can show. Running the
  hygiene check against the drill's merged tree would close that gap. Not done here: it is a change to
  A9's tool, outside this step.
- **The gate records the last 700 characters of a check's output.** For the unit and simulation checks
  on this base that tail is Electron's deprecation warnings on stderr, so `gate-module-1.json` shows
  that they passed but not their counts. The counts in `STATE.md` come from the Section 11 run.
- **The unsigned app prompts for the keychain after every Electron change.** Expected for an unsigned
  build; D2 (signing) is the fix. The harness no longer depends on it.
