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
| `product.json` | Onyx branding (nameShort/nameLong/applicationName `onyx`, dataFolderName `.onyx`, darwinBundleIdentifier `com.onyx.editor`, urlProtocol `onyx`); removed `voiceWsUrl`, `webviewContentExternalBaseUrlTemplate`, `trustedExtensionAuthAccess`, `agentsTelemetryAppName`; `builtInExtensionsEnabledWithAutoUpdates` emptied; `onboardingThemes` lists **Onyx Dark first** and **Onyx Light** before `light-2026`, and the two high-contrast tiles are **Onyx Dark High Contrast** / **Onyx Light High Contrast** instead of the defaults. `defaultChatAgent` is kept because core dereferences it without guards. On conflict: keep upstream's structure, re-apply the Onyx values. |
| `src/vs/workbench/contrib/welcomeOnboarding/common/onboardingTypes.ts` | `OnboardingStepId.LocalRuntime` added (enum member + title + subtitle cases), and `ONBOARDING_STEPS[0]` is `LocalRuntime` instead of `SignIn`. The `SignIn` member and its strings stay, so nothing else in the file changes shape. |
| `src/vs/workbench/contrib/welcomeOnboarding/browser/onboardingVariationA.ts` | 5 small hunks: import `renderOnyxRuntimeOnboardingStep`; import + inject `IClipboardService`; one `case OnboardingStepId.LocalRuntime` in the step switch; the "Continue without Signing In" label is guarded on `this.steps[0] === OnboardingStepId.SignIn`; the footer sign-in nudge is guarded on `this.steps.includes(OnboardingStepId.SignIn)`. Every guard is written so re-adding a sign-in step restores upstream behavior. |
| `src/vs/workbench/contrib/welcomeOnboarding/browser/media/theme-preview-onyx-light.svg` | New additive file (never conflicts): tile preview for the Onyx Light onboarding option. |
| `src/vs/workbench/contrib/welcomeOnboarding/browser/media/theme-preview-onyx-dark-hc.svg`, `…/theme-preview-onyx-light-hc.svg` | New additive files (never conflict): tile previews for the two Onyx high-contrast onboarding options; `product.json` `onboardingThemes` replaces the default HC tiles with them. |
| `src/vs/workbench/contrib/welcomeGettingStarted/common/gettingStartedContent.ts` | The `Setup` walkthrough is retitled ("Set Up Your Editor"), `isFeatured` is `false` (Onyx's own walkthrough is featured via `featuredFor` in `extensions/theme-onyx`), and the four `createCopilotSetupStep(...)` entries plus their now-unused string/button constants are removed. On conflict: take upstream, then re-delete the Copilot setup steps. |
| `src/vs/workbench/contrib/welcomeGettingStarted/browser/gettingStarted.ts` | One string: the Welcome page subtitle is "Every model on your machine". |
| `build/gulpfile.vscode.ts` | Onyx does not ship the built-in Copilot extension: `compileCopilotExtensionBuildTask` is dropped from both `vscode` task series and `prepareCopilotRipgrepShimTask` (plus its call in `packageTasks`) is deleted — that step materialized ripgrep inside the packaged extension and threw when the Copilot SDK was absent, which is why it used to be try/caught. Every tool Onyx's agent exposes (`openBrowserPage`, `readPage`, `usages`, `extensions`) is contributed by core, so the tool set does not regress; verified live with `--disable-extension GitHub.copilot-chat`. Dev launches still load `extensions/copilot` from sources — only the packaged product excludes it. On conflict: take upstream, then re-delete the compile task from the series and the shim task + call. |
| `eslint.config.js` | Two additive edits in the `test/**` block: `'test/**/*.mts'` joins the `files` glob (Onyx's harness scripts are `.mts`, so they were silently unlinted), and a `code-import-patterns` target for `test/onyx/**` restricted to `node:*`, `@playwright/*` and node modules — the harness must never import product code. On conflict: re-add both inside upstream's block. |
| `build/lib/extensions.ts` | `'copilot'` added to `excludedExtensions` so the packaged product does not ship another vendor's assistant. On conflict: take upstream, re-add the one entry. |
| `build/gulpfile.extensions.ts` | `compileCopilotExtensionBuildTask` is no longer referenced by the vscode build (the export stays for upstream compatibility). |
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

If a merge changes one of those setting ids, the override silently stops
applying; the symptom is Copilot chrome reappearing on a fresh profile.

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
npm run typecheck-client && npm run valid-layers-check && npx eslint src/vs/platform/onyxRuntime src/vs/workbench/contrib/onyx test/onyx && npm run stylelint && ./scripts/test.sh --grep Onyx && node test/onyx/run-e2e.mts
```

## Rules for new Onyx work

1. New code goes in the two Onyx directories (or new `onyx*` siblings).
2. Upstream files: registration one-liners only, placed at the end of the
   relevant block, mirroring an existing neighbor (Local Git is the template).
3. Never reformat or refactor upstream code.
4. Every new file uses the standard header (ESLint enforces it).
