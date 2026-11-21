# Onyx fork — upstream merge guide

Onyx is a rebaseable fork of microsoft/vscode. All Onyx code lives in
**new directories**; upstream files carry only tiny, append-only registration
edits. When merging upstream (`git fetch upstream && git merge upstream/main`),
the complete list of files where conflicts can involve Onyx code is below —
everything else that conflicts is pure upstream and should take their side.

## Onyx-owned directories (never conflict)

- `src/vs/platform/onyxRuntime/` — shared-process service: localhost runtime
  discovery (Ollama/LM Studio/llama.cpp/vLLM) + streaming OpenAI-compatible
  chat-completions client. All HTTP happens here (no renderer CORS).
- `src/vs/workbench/contrib/onyx/` — model provider, capability profiles,
  adaptive router, agent loop, prompt builder, control-plane service + views.
- `extensions/theme-onyx/` — the built-in Onyx themes.
- `test/onyx/` — mock runtimes, end-to-end harness, benchmark harness,
  chart generator.
- `NOTICE.md`, `TRADEMARK.md`, `ONYX.md`, `LAUNCH.md`, `docs/BENCHMARKS.md`,
  `docs/images/` — Onyx documentation and generated imagery.

### Community files — two different strategies, on purpose

**`CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`: shadowed, not
overwritten.** Upstream owns `CONTRIBUTING.md` and `SECURITY.md` at the
repository root and both describe contributing to *VS Code*. GitHub resolves
community-health files from `.github/` **before** the repository root, so Onyx's
versions win without upstream's being touched at all:

| Onyx file (new, never conflicts) | Shadows |
|---|---|
| `.github/CONTRIBUTING.md` | root `CONTRIBUTING.md` (upstream, unmodified) |
| `.github/SECURITY.md` | root `SECURITY.md` (upstream, unmodified) |
| `.github/CODE_OF_CONDUCT.md` | nothing — upstream has none |
| `.github/workflows/onyx-ci.yml` | nothing — added alongside upstream's workflows |

**Issue and PR templates: replaced.** These could not be shadowed — GitHub reads
every file in `.github/ISSUE_TEMPLATE/`, so upstream's would have kept appearing
in the chooser, offering a Copilot bug report on a fork that ships no Copilot.
They are listed in the upstream-touched table below and **will conflict** when
upstream edits them. Resolution is always "take the Onyx side"; none of Onyx's
own behaviour depends on them.

## Upstream files touched (re-apply these lines if a merge drops them)

| File | Change |
|---|---|
| `src/vs/workbench/workbench.desktop.main.ts` | `import './contrib/onyx/electron-browser/onyx.contribution.js';` under the Chat imports |
| `src/vs/code/electron-utility/sharedProcess/sharedProcessMain.ts` | 2 imports for `IOnyxRuntimeService`/`OnyxRuntimeService`; `services.set(IOnyxRuntimeService, ...)` next to Local Git; `registerChannel('onyxRuntime', ...)` next to the localGit channel |
| `build/lib/i18n.resources.json` | `vs/workbench/contrib/onyx` entry (alphabetical, after meteredConnection) |
| `resources/darwin/code.icns` | Replaced with the Onyx app icon (binary asset swap; on conflict take the Onyx side, or regenerate — the icon is a canvas-drawn faceted gem on a dark plate) |
| `src/vs/workbench/services/themes/common/workbenchThemeService.ts` | Three value changes in `ThemeSettingDefaults`: `COLOR_THEME_DARK` = `'Onyx Dark'`, `COLOR_THEME_HC_DARK` = `'Onyx Dark High Contrast'`, `COLOR_THEME_HC_LIGHT` = `'Onyx Light High Contrast'` (the themes ship from `extensions/theme-onyx/`; extensions cannot override these APPLICATION-scoped defaults) |
| `README.md` | Replaced with the Onyx product README (docs-only; on conflict take the Onyx side) |
| `.github/ISSUE_TEMPLATE/bug_report.md` | **Deleted** — replaced by `onyx_bug_report.yml`. On a modify/delete conflict, keep it deleted |
| `.github/ISSUE_TEMPLATE/feature_request.md` | **Deleted** — replaced by `onyx_feature_request.yml`. On a modify/delete conflict, keep it deleted |
| `.github/ISSUE_TEMPLATE/copilot_bug_report.md` | **Deleted** — Onyx ships no Copilot. On a modify/delete conflict, keep it deleted |
| `.github/ISSUE_TEMPLATE/config.yml` | Contact links repointed at the Onyx README, the private security advisory form, and upstream for stock VS Code bugs |
| `.github/pull_request_template.md` | Replaced with Onyx's verification and fork-hygiene checklist (docs-only; on conflict take the Onyx side) |
| `.github/ISSUE_TEMPLATE/bug_report.md`, `…/feature_request.md`, `…/copilot_bug_report.md` | **Deleted.** Onyx ships its own form templates as new files (`onyx_bug_report.yml`, `onyx_feature_request.yml`) that never conflict; the upstream `.md` ones would otherwise appear alongside them in the issue picker, one of them titled for another vendor's assistant. A merge that re-adds any of them shows as a delete/modify conflict — keep them deleted. |
| `.github/ISSUE_TEMPLATE/config.yml` | Replaced: `blank_issues_enabled: false` plus three Onyx contact links. GitHub allows only one `ISSUE_TEMPLATE` directory, so this one file cannot be moved out of upstream's way. **On conflict take the Onyx side.** |
| `.github/pull_request_template.md` | Replaced with Onyx's checklist (the gates, plus the fork rules: Onyx-owned paths, a REBASE.md row for any upstream touch, no non-local network calls, DCO sign-off). The uppercase alternative path resolves to the same file on macOS, so this cannot be moved either. **On conflict take the Onyx side.** |

**`CONTRIBUTING.md`, `SECURITY.md` and the code of conduct are deliberately NOT
in this table.** GitHub resolves community health files from `.github/` before
the repository root, so Onyx's versions live at `.github/CONTRIBUTING.md`,
`.github/SECURITY.md` and `.github/CODE_OF_CONDUCT.md` — new files that can
never conflict — and upstream's root copies are left byte-identical. Do not
"tidy" this by overwriting the root files; the duplication is the point.
| `src/vs/workbench/contrib/welcomeOnboarding/browser/media/theme-preview-onyx-dark.svg` | New additive file (never conflicts): tile preview for the onboarding dialog; the tile itself comes from `product.json` `onboardingThemes` (Onyx Dark listed first so the first-run dialog preselects it) |
| `product.json` | Onyx branding (nameShort/nameLong/applicationName `onyx`, dataFolderName `.onyx`, darwinBundleIdentifier `com.onyx.editor`, urlProtocol `onyx`); removed `voiceWsUrl`, `webviewContentExternalBaseUrlTemplate`, `trustedExtensionAuthAccess`, `agentsTelemetryAppName`; `builtInExtensionsEnabledWithAutoUpdates` emptied; `onboardingThemes` lists **Onyx Dark first** and **Onyx Light** before `light-2026`, and the two high-contrast tiles are **Onyx Dark High Contrast** / **Onyx Light High Contrast** instead of the defaults. `defaultChatAgent` is kept because core dereferences it without guards, except its `mcpConnectorsUrl` key (new in 1.147.0, a Copilot connectors endpoint), which is removed: core reads it through an optional chain and reports "not available in this product" without it, and the `identity-urls` hygiene check refuses the URL. `linuxDesktopName` (new in 1.147.0, the `.desktop` file's base name) is `onyx`, the value `applicationName` gave that file before. On conflict: keep upstream's structure, re-apply the Onyx values. After a merge, compare the keys with upstream's `product.json`: a new upstream key merges without a conflict, and the hygiene check is what catches a new URL. |
| `src/vs/workbench/contrib/welcomeOnboarding/common/onboardingTypes.ts` | `OnboardingStepId.LocalRuntime` added (enum member + title + subtitle cases), and `ONBOARDING_STEPS[0]` is `LocalRuntime` instead of `SignIn`. The `SignIn` member and its strings stay, so nothing else in the file changes shape. |
| `src/vs/workbench/contrib/welcomeOnboarding/browser/onboardingVariationA.ts` | 5 small hunks: import `renderOnyxRuntimeOnboardingStep`; import + inject `IClipboardService`; one `case OnboardingStepId.LocalRuntime` in the step switch; the "Continue without Signing In" label is guarded on `this.steps[0] === OnboardingStepId.SignIn`; the footer sign-in nudge is guarded on `this.steps.includes(OnboardingStepId.SignIn)`. Every guard is written so re-adding a sign-in step restores upstream behavior. |
| `src/vs/workbench/contrib/welcomeOnboarding/browser/media/theme-preview-onyx-light.svg` | New additive file (never conflicts): tile preview for the Onyx Light onboarding option. |
| `src/vs/workbench/contrib/welcomeOnboarding/browser/media/theme-preview-onyx-dark-hc.svg`, `…/theme-preview-onyx-light-hc.svg` | New additive files (never conflict): tile previews for the two Onyx high-contrast onboarding options; `product.json` `onboardingThemes` replaces the default HC tiles with them. |
| `src/vs/workbench/contrib/welcomeGettingStarted/common/gettingStartedContent.ts` | The `Setup` walkthrough is retitled ("Set Up Your Editor"), `isFeatured` is `false` (Onyx's own walkthrough is featured via `featuredFor` in `extensions/theme-onyx`), and the four `createCopilotSetupStep(...)` entries plus their now-unused string/button constants are removed. On conflict: take upstream, then re-delete the Copilot setup steps. |
| `src/vs/workbench/contrib/welcomeGettingStarted/browser/gettingStarted.ts` | One string: the Welcome page subtitle is "Every model on your machine". |
| `build/gulpfile.vscode.ts` | Onyx does not ship the built-in Copilot extension: `compileCopilotExtensionBuildTask` is dropped from both `vscode` task series and `prepareCopilotRipgrepShimTask` (plus its call in `packageTasks`) is deleted — that step materialized ripgrep inside the packaged extension and threw when the Copilot SDK was absent, which is why it used to be try/caught. Every tool Onyx's agent exposes (`openBrowserPage`, `readPage`, `usages`, `extensions`) is contributed by core, so the tool set does not regress; verified live with `--disable-extension GitHub.copilot-chat`. Dev launches still load `extensions/copilot` from sources — only the packaged product excludes it. On conflict: take upstream, then re-delete the compile task from the series and the shim task + call. Since 1.147.0 upstream has a single `vscode` task series (always esbuild) instead of two; the compile task is dropped from that one, and the two imports that only it and the shim task used (`compileCopilotExtensionBuildTask`, `prepareBuiltInCopilotRipgrepShim`) go with them. |
| `eslint.config.js` | Two additive edits in the `test/**` block: `'test/**/*.mts'` joins the `files` glob (Onyx's harness scripts are `.mts`, so they were silently unlinted), and a `code-import-patterns` target for `test/onyx/**` restricted to `node:*`, `@playwright/*`, `test/onyx/**` (the harness scripts import each other) and node modules — the harness must never import product code. On conflict: re-add both inside upstream's block. Since 1.147.0 upstream lints with **oxlint**, not ESLint: `oxlint.config.ts` converts this file, so the same rules run under the same names (`pnpm run oxlint <paths>`), the local plugin and the header rule included, and a warning now fails the run. ESLint itself is no longer installed. |
| `build/lib/extensions.ts` | `'copilot'` in `excludedExtensions` so the packaged product does not ship another vendor's assistant. Upstream lists it there itself as of 1.147.0, so the file is identical to upstream's; if a later merge drops the entry, re-add it. |
| `build/gulpfile.extensions.ts` | `compileCopilotExtensionBuildTask` is no longer referenced by the vscode build (the export stays for upstream compatibility). |
| `src/vs/platform/windows/electron-main/windowsMainService.ts` | One constant (`ONYX_EXCLUDES_AGENTS_WINDOW`) above the class and one guard at the top of `openAgentsWindow` (B3): the Agents window is a second workbench built around upstream's Agent Host, which Onyx excludes, and it loads none of Onyx's contributions. Every route to it (the command, `--agents`, a protocol link) ends at the guard: an ordinary empty window when there is none, nothing otherwise. On conflict: take upstream, then re-add the constant and the guard. The packaged smoke fails if the guard is lost (its last check). |
| `scripts/code.sh` | One block before the launch line (B1): `--disable-extension=GitHub.copilot-chat` is passed unless `ONYX_DEV_COPILOT` is set, so a development launch runs the tools the packaged product ships and nothing depends on the Copilot extension's read tools. On conflict: take upstream, then re-add the block and `$DISABLE_COPILOT_EXTENSION` on the `exec` line. `scripts/code.bat` is untouched: Windows is not a supported platform for the alpha (DEC-02). |
| `package.json` | Two `scripts` lines (B1): `compile` is `pnpm run compile-client` (upstream: `compile-client` and `compile-copilot` in parallel), and `compile-with-copilot` holds upstream's line. `compile-copilot` itself is unchanged, for a developer who opts in with `ONYX_DEV_COPILOT=1`. No dependency and no lockfile is touched. On conflict: take upstream, then re-apply the two lines. |
| `src/vs/platform/accessibility/browser/accessibleView.ts` | 2 additive `AccessibleViewProviderId` members: `OnyxControlPlane`, `OnyxInlineEdit`. |
| `src/vs/workbench/contrib/accessibility/browser/accessibilityConfiguration.ts` | 2 additive `AccessibilityVerbositySettingId` members plus their two `...baseVerbosityProperty` registrations (`accessibility.verbosity.onyxControlPlane`, `…onyxInlineEdit`). |
| `build/lib/stylelint/vscode-known-variables.json` | 6 additive entries (`--vscode-onyx-*`) so stylelint accepts the Onyx theme colors. Inserted in place, **not** re-sorted — sorting the file produces a large, rebase-hostile diff. |

## Internal upstream APIs Onyx depends on (check these after merging)

Onyx consumes (imports only, no patches) these chat-stack APIs; they are
internal and may churn:

- `ILanguageModelsService.deltaLanguageModelChatProviderDescriptors` +
  `registerLanguageModelProvider` / `ILanguageModelChatProvider`
  (`chat/common/languageModels.ts`) — note: providers receive the **full**
  identifier `onyx:<key>` in `sendChatRequest`.
- `IChatAgentService.registerDynamicAgent` (`chat/common/participants/chatAgents.ts`) —
  Onyx registers a core default agent; extension default agents win via
  `_preferExtensionAgent`.
- `ILanguageModelToolsService.getTools`/`invokeTool`
  (`chat/common/tools/languageModelToolsService.ts`) — the tools service itself
  renders tool-invocation UI into the chat when given
  `context.sessionResource` + `chatRequestId`.
- `ViewPane` constructor signature (`workbench/browser/parts/views/viewPane.ts`).

## Onyx settings that override upstream defaults

Onyx prefers a settings default over a UI patch wherever the chat stack exposes
one. `src/vs/workbench/contrib/onyx/common/onyxConfiguration.ts` calls
`registerDefaultConfigurations` for:

- `chat.titleBar.signIn.enabled: false` — the title bar's "Sign In" pill has
  nothing to sign into in a local-only product.
- `chat.defaultToCopilotHarness: false` and `chat.editor.preferCopilotHarness: false`
  — a new chat belongs to the local harness, where the Onyx agent is the
  default. Both were `false` upstream at the August 2026 base and are `true` in
  1.147.0. With them on, every new chat is an Agent Host Copilot session
  (`agent-host-copilotcli`): the first message opens a "Sign in to use GitHub
  Copilot" dialog and never reaches Onyx. The unit suite `OnyxChatDefaults`
  resolves the new-chat session type from the shipped defaults and fails if
  either override stops applying.

- `chat.titleBar.openInAgentsWindow.enabled: false` and `chat.agentsWindowBanner.enabled: false`
  (B3): the chrome that invites the user into the Agents window, which this product does not open.

If a merge changes one of those setting ids, the override silently stops
applying; the symptom is Copilot chrome reappearing on a fresh profile.

## Upstream's Agent Host is excluded (B3)

The Agent Host is upstream's utility process for the Copilot SDK harness. With upstream's defaults the
window asks for it at startup (`AgentHostPrewarmContribution`), the workbench registers its session types
(`agent-host-copilotcli`, …), language-model vendors and customization harness (`AgentHostContribution`), and
the host starts a closed-source runtime binary. Onyx turns it off without touching an upstream file:

- `src/vs/workbench/contrib/onyx/browser/onyxAgentHost.ts` is upstream's own `AgentHostEnablementService`
  constructed with "no Agent Host runtime available", the way the web workbench runs without one.
  `onyx.contribution.ts` registers it for `IAgentHostEnablementService`. It replaces upstream's
  registration because Onyx's contribution is imported after
  `platform/agentHost/browser/agentHostEnablementService.js` in `workbench.desktop.main.ts`, and the last
  registration of a service wins. **After a merge, check that import order**: if upstream's file is imported
  later than Onyx's, upstream's implementation wins again.
- The Agents window has its own entry point (`sessions.desktop.main.ts`) and does not load Onyx's
  contribution, so it is stopped in the main process (the `windowsMainService.ts` row above).

What catches a regression: the unit suite `OnyxChatDefaults` (the switch reads off; no agent-host session
type is usable), and the packaged smoke and the end-to-end suite, which fail if an `agenthost.log` appears in
the profile or if "Open Agents Window" opens the sessions workbench. The Agent Host's code and the SDK's
platform package are still built into the application bundle; nothing in an Onyx run starts them.

## Merge of upstream 1.147.0 — 2026-11-20 (DEC-05)

The fork moved from its August 2026 base (`36d38757a15`) to upstream release `1.147.0`
(`8a14f0cc1b0`) with one `git merge`: 7,778 upstream commits. `docs/progress/DEC-05.md` is the
completion report. What the merge needed, in the order it was found:

**Conflicts that A9 predicted (5).** `build/gulpfile.vscode.ts`, `product.json`, `sharedProcessMain.ts`,
`accessibilityConfiguration.ts`, `onboardingVariationA.ts`. Each resolved as its row in the table
above says.

**Conflicts that A9 did not count (14).** Modify/delete conflicts on `CODENOTIFY`, `CODEOWNERS`,
`dependabot.yml` and eleven workflows. A11 deleted those files after A9's trial ran; the A11 table
below already said "take the Onyx side: deleted" for every one.

**What merged without a conflict and was still wrong.** None of these shows up in a conflict list
or in the drill, so look for each after every merge:

| Found by | What | Resolution |
|---|---|---|
| hygiene, `inherited-automation` | Upstream **added** five workflows (`codeql.yml`, `pr-pnpm-store.yml`, `pr-ripple.yml`, `pr-workspace-images.yml`, `rulesets.yml`) and two helper folders | Deleted in the merge commit (A11 table) |
| hygiene, `identity-urls` | `product.json` gained `defaultChatAgent.mcpConnectorsUrl`, a Copilot connectors endpoint | Key removed; core treats it as optional |
| compile | `IDialogService` gained `hasDialog`; the simulation rig's `OnyxSimDialogService` did not implement it | Implemented in the fake (true while a prompt or confirmation is open) |
| lint | Upstream replaced ESLint with oxlint, which also fails on warnings. Four findings in Onyx sources under rules newer than the base: one `fs.existsSync` in `onyxDocsIndexer.ts` (`local/code-no-sync-fs`), three bracket accesses (`local/code-no-bracket-notation-for-identifiers`) | Fixed in the sources; the gate's lint check runs `pnpm run oxlint` |
| end-to-end | The workbench blocked on a macOS keychain prompt, so the debugging endpoint went silent and the driver timed out "retrieving websocket url". The August base makes the same keychain read; the Electron 43 binary is simply not the one that created the "Safe Storage" key | The end-to-end runner and the packaged smoke launch with `--use-mock-keychain` (`test/onyx/README.md`) |
| end-to-end | Upstream turned `chat.defaultToCopilotHarness` and `chat.editor.preferCopilotHarness` on. Every new chat became an Agent Host Copilot session and the first message opened a GitHub sign-in dialog instead of reaching Onyx | Both overridden to `false` in `onyxConfiguration.ts` ("Onyx settings that override upstream defaults", above); unit suite `OnyxChatDefaults` |

**Toolchain.** Upstream moved to pnpm on 2026-11-02; see "Toolchain" below.

**Git LFS.** Upstream now tracks 2 fixtures instead of 98; the merge was pushed with
`GIT_LFS_SKIP_PUSH=1` ("Git LFS fixtures", below).

## Toolchain (since 1.147.0)

| | Value | Where it is pinned |
|---|---|---|
| Node | 24.22.1 or a newer 24.x | `.nvmrc` (upstream's); `build/npm/preinstall.ts` refuses another major or an older 24.x |
| Package manager | pnpm 12.16.0 | `packageManager` in `package.json`; `corepack enable pnpm` provides it, and preinstall refuses npm or another pnpm |
| Lockfiles | `pnpm-lock.yaml`, `build/pnpm-lock.yaml`, `remote/pnpm-lock.yaml` | Upstream's, unmodified by Onyx. There is no `package-lock.json` and `.gitignore` ignores one |
| Linter | oxlint, running the rules of `eslint.config.js` | `pnpm run oxlint <paths>` |

Install with `GIT_LFS_SKIP_SMUDGE=1 pnpm_config_frozen_lockfile=true pnpm install --frozen-lockfile`.
Never run an unfrozen install: it rewrites `pnpm-lock.yaml` in place, every later frozen install
then fails with `ERR_PNPM_LOCKFILE_CONFIG_MISMATCH` until the lockfile is restored, and the
seven-day `minimumReleaseAge` policy in `pnpm-workspace.yaml` refuses the newer versions it tries
to resolve (A9). The root postinstall installs `build/` and `remote/` as separate roots, and pnpm
does not pass `--frozen-lockfile` on to scripts; the `pnpm_config_frozen_lockfile` variable is what
keeps those two frozen. After an install, `git status` must show no lockfile as modified.

The three Onyx workflows install the same way. `onyx-ci.yml` caches pnpm's store, never
`node_modules`, and always runs the install, so postinstall always runs and nothing has to be
regenerated after a cache hit.

## Merge drill — 2026-08-30

Trial merge of `upstream/main` (004a1fbb165, **161 commits ahead**) onto `main`
in a throwaway worktree:

- **One conflict, in `product.json`, for the fourth consecutive drill** — the
  identical hunk every time: upstream re-adds `trustedExtensionAuthAccess`.
  Take the Onyx side.
- The `.github/ISSUE_TEMPLATE/` files Onyx deletes and the `README.md` /
  `pull_request_template.md` it replaces were **not touched** by any of the 161
  commits, so the new Onyx-owned community files added on 2026-08-30 cost the
  fork nothing this cycle. `CONTRIBUTING.md` and `SECURITY.md` are byte-identical
  to upstream by design (Onyx's live in `.github/`), so they cannot conflict at
  all.

## Merge drill — 2026-08-29

Trial merge of `upstream/main` (df814e65a7c, 153 commits ahead) onto `main`
in a throwaway worktree:

- **One conflict, in product.json, for the third consecutive drill**: upstream
  re-adds `trustedExtensionAuthAccess` where Onyx keeps
  `builtInExtensionsEnabledWithAutoUpdates: []`. Take the Onyx side.
- Every other Onyx registration edit survived untouched (checked:
  `workbench.desktop.main.ts`, `sharedProcessMain.ts`, `i18n.resources.json`,
  `workbenchThemeService.ts`, `vscode-known-variables.json`).
- The whole uncommitted Onyx delta (116 KB of diff plus ~40 new paths from the
  ten-feature session) applied cleanly with `git apply` and produced **zero
  onyx-related type errors** on the merged tree.

## Merge drill — 2026-08-28

Trial merge of `upstream/main` (87 commits ahead) onto `main` in a throwaway
worktree:

- **One conflict**, again in `product.json`: upstream keeps re-adding
  `trustedExtensionAuthAccess` (three GitHub/Copilot auth entries), which Onyx
  removes. Resolution is to take the Onyx side of that hunk. This is now the
  second consecutive drill with exactly this conflict and no other — treat it
  as the expected cost of every upstream merge.
- Every other Onyx registration edit survived untouched
  (`workbench.desktop.main.ts`, `sharedProcessMain.ts`, `i18n.resources.json`,
  `workbenchThemeService.ts`, `vscode-known-variables.json`, the two
  `welcomeOnboarding` files, both `welcomeGettingStarted` files).
- The whole uncommitted Onyx delta (215 KB of diff plus 34 new paths) applied
  cleanly onto the merged tree with `git apply`, and no type error on the
  merged tree mentions an Onyx file.

Upstream churn on the files Onyx touches, over those 87 commits:
`vscode-known-variables.json` 2; `product.json`, `sharedProcessMain.ts`,
`i18n.resources.json` and `build/gulpfile.vscode.ts` 1 each; everything else 0
— including all four de-branding files, `build/lib/extensions.ts`,
`eslint.config.js` and both accessibility files. `product.json` remains the
only file to expect trouble in.

After every upstream merge run:

```
pnpm run typecheck-client && pnpm run valid-layers-check && pnpm run oxlint src/vs/platform/onyxRuntime src/vs/workbench/contrib/onyx test/onyx && pnpm run stylelint && pnpm run compile && ./scripts/test.sh --grep Onyx && node test/onyx/run-hygiene.mts && node test/onyx/run-e2e.mts
```

## Rules for new Onyx work

1. New code goes in the two Onyx directories (or new `onyx*` siblings).
2. Upstream files: registration one-liners only, placed at the end of the
   relevant block, mirroring an existing neighbor (Local Git is the template).
3. Never reformat or refactor upstream code.
4. Every new file uses the standard header (ESLint enforces it).

## Upstream baseline (A9, DEC-05)

| Field | Value |
|---|---|
| Fork base | upstream release `1.147.0` = `8a14f0cc1b0` (2026-11-18), merged on 2026-11-20. Before that: `36d38757a15` (microsoft/vscode, August 2026; `package.json` reported 1.136.0) |
| Upstream release at A9's trial | `1.147.0` = `8a14f0cc1b0`, 2026-11-18 |
| Trial | `docs/progress/A9.md`: 5 conflicts (all in the table above), 0 of 849 consumed API symbols missing, typecheck/compile/layers/unit/benchmarks green on the merged tree; upstream now requires pnpm 12.16.0 and Node 24.22.1 |
| Recorded decision | **Confirmed by the owner on 2026-11-20: move to upstream 1.147.0** (DEC-05). Carried out the same day, between Module 1 and Module 2, in its own pull request (sheehanlloyd/Onyx#2, branch `upstream-1.147.0`, merge commit `ed8f992f0cc`). Module 1's gate passed on the merged tree at `881936cd52c` with the same shape as before: 23 checks, 22 passed, 1 expected failure owned by B1 and B3 (`docs/progress/STATE.md`, `docs/progress/DEC-05.md`). A9's recommendation was to do this at the start of Module 2; doing it as a separate step kept upstream churn and new feature code from being debugged together. Elapsed time never makes a failing or known-vulnerable base releasable; every later merge re-runs the activated gates |
| Drill | `node test/onyx/run-upstream-drill.mts --latest-release` (weekly in `.github/workflows/onyx-upstream-drill.yml`); the report names unpredicted conflicts and missing symbols, so this table and the one above stay honest |
## Git LFS fixtures (A10)

Upstream tracks SQLite fixtures under `extensions/copilot/test/simulation/cache/` through Git
LFS (`.gitattributes`: `*.sqlite filter=lfs`): 98 of them at the August 2026 base, 2 as of 1.147.0
(`base.sqlite` and one layer; upstream consolidated the rest). Onyx excludes the Copilot extension from the packaged
product and never runs those tests, so the fixture *contents* are never needed; only the pointer files
are tracked. The decision, recorded here so that it is not re-litigated at every merge:

- **The pointers stay in HEAD.** Removing them would be a change to upstream-owned paths that
  conflicts at every merge, for no product gain. A tracked pointer is a 3-line text file; it is not a
  product defect.
- **Installs never smudge them.** CI sets `GIT_LFS_SKIP_SMUDGE=1` for the install; a local clone made with
  the same variable (or without `git-lfs` installed at all) checks the pointers out as pointers and
  the install completes without touching them. `extensions/copilot/script/postinstall.ts` warns only when
  `test/simulation/cache/base.sqlite` is *absent*; a pointer file satisfies the check, so a clone made
  this way installs without the warning. That was verified in the isolated checkout for Module 1
  (`npm ci`: no fixture warning, `git status` clean afterwards) and in the CI install step, and again
  with the frozen pnpm install after the move to 1.147.0.
- **Pushes never upload them.** A merge that brings new or changed pointers references objects that
  exist only in upstream's LFS store. The `pre-push` hook that `git lfs install` adds would try to
  upload them and fail; push with `GIT_LFS_SKIP_PUSH=1` (the 1.147.0 merge was pushed that way).
- **An owner's checkout whose working tree lacks the files** (the situation A1 inventoried: 98 pointers
  reported as deleted) shows them as deletions until the files are restored with
  `GIT_LFS_SKIP_SMUDGE=1 git checkout -- extensions/copilot/test/simulation/cache`. That restores
  pointers, not fixture contents, and needs no LFS server. A1/DEC-06 forbids running that in the
  owner's checkout without separate authorization; it is documented here for when the owner chooses to.
- On an upstream merge, take upstream's side for every `.sqlite` pointer and for `.gitattributes`.

Removal of the fixtures is therefore **not** a release gate; the documented install strategy handles them
(ActionPlan A10).

## Inherited automation (A11)

Upstream's workflows and bot configurations were "disabled manually" in GitHub's Actions settings only.
A11 deleted them from the tree and added the `inherited-automation` hygiene check so that none can return
through a merge. On an upstream merge, **take the Onyx side: deleted** for every path in this table.
`.github/README.md` explains what remains and what it can run.

| Path | Resolution |
|---|---|
| `.github/workflows/chat-lib-package.yml`, `chat-perf.yml`, `component-fixtures.yml`, `copilot-setup-steps.yml`, `css-order-scan.yml`, `monaco-editor.yml`, `pr-darwin-test.yml`, `pr-linux-cli-test.yml`, `pr-linux-test.yml`, `pr-node-modules.yml`, `pr-win32-test.yml`, `pr.yml`, `require-commit-trailer.yml`, `sessions-e2e.yml`, `telemetry.yml` | take Onyx side: deleted |
| `.github/workflows/node_modules_cache/`, `.github/workflows/check-clean-git-state.sh` | take Onyx side: deleted (helpers of the deleted workflows) |
| `.github/workflows/codeql.yml`, `pr-pnpm-store.yml`, `pr-ripple.yml`, `pr-workspace-images.yml`, `rulesets.yml` | **added upstream** between the August base and 1.147.0; deleted in the 1.147.0 merge. A file upstream adds merges **without a conflict**, so nothing lists it: after every merge run `node test/onyx/run-hygiene.mts`, which fails on any workflow that is not `onyx-*.yml`, and delete what it names |
| `.github/workflows/caches/`, `.github/workflows/workspace_image/` | added upstream as helpers of those workflows; deleted, and listed in the hygiene check |
| `.github/CODEOWNERS` | take Onyx side: deleted (requested reviews from Microsoft staff) |
| `.github/dependabot.yml` | take Onyx side: deleted |
| `.github/CODENOTIFY`, `.github/classifier.json`, `.github/commands.json`, `.github/commands/`, `.github/similarity.yml`, `.github/insiders.yml`, `.github/endgame/` | take Onyx side: deleted (issue-bot configuration) |
| `.github/actions/` | kept; unreferenced composite actions run nothing on their own |
| `.github/rulesets/`, `.github/codeql/`, `.github/sandbox.yml`, `.github/hooks/` | kept (new in 1.147.0): inputs of the deleted workflows and of upstream's hosted agent sandbox; nothing here reads them and they run nothing on their own |
| `.github/README.md` | Onyx-owned, new |
