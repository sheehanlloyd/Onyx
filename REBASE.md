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

## Upstream files touched (re-apply these lines if a merge drops them)

| File | Change |
|---|---|
| `src/vs/workbench/workbench.desktop.main.ts` | `import './contrib/onyx/electron-browser/onyx.contribution.js';` under the Chat imports |
| `src/vs/code/electron-utility/sharedProcess/sharedProcessMain.ts` | 2 imports for `IOnyxRuntimeService`/`OnyxRuntimeService`; `services.set(IOnyxRuntimeService, ...)` next to Local Git; `registerChannel('onyxRuntime', ...)` next to the localGit channel |
| `build/lib/i18n.resources.json` | `vs/workbench/contrib/onyx` entry (alphabetical, after meteredConnection) |
| `resources/darwin/code.icns` | Replaced with the Onyx app icon (binary asset swap; on conflict take the Onyx side, or regenerate — the icon is a canvas-drawn faceted gem on a dark plate) |
| `src/vs/workbench/services/themes/common/workbenchThemeService.ts` | One value change: `ThemeSettingDefaults.COLOR_THEME_DARK` = `'Onyx Dark'` (the default dark theme ships from `extensions/theme-onyx/`; extensions cannot override this APPLICATION-scoped default) |
| `README.md` | Replaced with the Onyx product README (docs-only; on conflict take the Onyx side) |
| `src/vs/workbench/contrib/welcomeOnboarding/browser/media/theme-preview-onyx-dark.svg` | New additive file (never conflicts): tile preview for the onboarding dialog; the tile itself comes from `product.json` `onboardingThemes` (Onyx Dark listed first so the first-run dialog preselects it) |
| `product.json` | Onyx branding (nameShort/nameLong/applicationName `onyx`, dataFolderName `.onyx`, darwinBundleIdentifier `com.onyx.editor`, urlProtocol `onyx`); removed `voiceWsUrl`, `webviewContentExternalBaseUrlTemplate`, `trustedExtensionAuthAccess`, `agentsTelemetryAppName`; `builtInExtensionsEnabledWithAutoUpdates` emptied; `onboardingThemes` lists **Onyx Dark first** and **Onyx Light** before `light-2026`. `defaultChatAgent` is kept because core dereferences it without guards. On conflict: keep upstream's structure, re-apply the Onyx values. |
| `src/vs/workbench/contrib/welcomeOnboarding/common/onboardingTypes.ts` | `OnboardingStepId.LocalRuntime` added (enum member + title + subtitle cases), and `ONBOARDING_STEPS[0]` is `LocalRuntime` instead of `SignIn`. The `SignIn` member and its strings stay, so nothing else in the file changes shape. |
| `src/vs/workbench/contrib/welcomeOnboarding/browser/onboardingVariationA.ts` | 5 small hunks: import `renderOnyxRuntimeOnboardingStep`; import + inject `IClipboardService`; one `case OnboardingStepId.LocalRuntime` in the step switch; the "Continue without Signing In" label is guarded on `this.steps[0] === OnboardingStepId.SignIn`; the footer sign-in nudge is guarded on `this.steps.includes(OnboardingStepId.SignIn)`. Every guard is written so re-adding a sign-in step restores upstream behavior. |
| `src/vs/workbench/contrib/welcomeOnboarding/browser/media/theme-preview-onyx-light.svg` | New additive file (never conflicts): tile preview for the Onyx Light onboarding option. |
| `src/vs/workbench/contrib/welcomeGettingStarted/common/gettingStartedContent.ts` | The `Setup` walkthrough is retitled ("Set Up Your Editor"), `isFeatured` is `false` (Onyx's own walkthrough is featured via `featuredFor` in `extensions/theme-onyx`), and the four `createCopilotSetupStep(...)` entries plus their now-unused string/button constants are removed. On conflict: take upstream, then re-delete the Copilot setup steps. |
| `src/vs/workbench/contrib/welcomeGettingStarted/browser/gettingStarted.ts` | One string: the Welcome page subtitle is "Every model on your machine". |
| `build/gulpfile.vscode.ts` | The `prepareBuiltInCopilotRipgrepShim` call is wrapped in try/catch and downgraded to a warning. Onyx does not ship or use the Copilot CLI SDK, and a cold build can fail that step outright — a missing shim is a degraded built-in extension here, not a broken product build. |
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

## Merge drill — 2026-08-27

Trial merge of `upstream/main` (60 commits ahead) onto `main` in a throwaway
worktree:

- **One conflict**, in `product.json`: upstream re-added
  `trustedExtensionAuthAccess`, which Onyx removes. Resolution is to take the
  Onyx side of that hunk.
- Every other Onyx registration edit survived untouched
  (`workbench.desktop.main.ts`, `sharedProcessMain.ts`, `i18n.resources.json`,
  `workbenchThemeService.ts`).
- The whole uncommitted Onyx delta applied cleanly onto the merged tree
  (`git apply --check`), so the de-branding edits in `welcomeOnboarding` and
  `welcomeGettingStarted` did not collide either.

Upstream churn on the files Onyx touches, over those 60 commits: `product.json`
1, `sharedProcessMain.ts` 1, `i18n.resources.json` 1,
`vscode-known-variables.json` 2, everything else 0. `product.json` is the file
to expect trouble in; the rest are quiet.

After every upstream merge run:

```
npm run typecheck-client && npm run valid-layers-check && npx eslint src/vs/platform/onyxRuntime src/vs/workbench/contrib/onyx && npm run stylelint && ./scripts/test.sh --grep Onyx
```

## Rules for new Onyx work

1. New code goes in the two Onyx directories (or new `onyx*` siblings).
2. Upstream files: registration one-liners only, placed at the end of the
   relevant block, mirroring an existing neighbor (Local Git is the template).
3. Never reformat or refactor upstream code.
4. Every new file uses the standard header (ESLint enforces it).
