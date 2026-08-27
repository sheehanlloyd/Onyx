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
| `product.json` | Onyx branding (nameShort/nameLong/applicationName `onyx`, dataFolderName `.onyx`, darwinBundleIdentifier `com.onyx.editor`, urlProtocol `onyx`); removed `voiceWsUrl`, `webviewContentExternalBaseUrlTemplate`, `trustedExtensionAuthAccess`, `agentsTelemetryAppName`; `builtInExtensionsEnabledWithAutoUpdates` emptied. `defaultChatAgent` is kept because core dereferences it without guards. On conflict: keep upstream's structure, re-apply the Onyx values. |

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

After every upstream merge run:

```
npm run typecheck-client && npm run valid-layers-check && npx eslint src/vs/platform/onyxRuntime src/vs/workbench/contrib/onyx
```

## Rules for new Onyx work

1. New code goes in the two Onyx directories (or new `onyx*` siblings).
2. Upstream files: registration one-liners only, placed at the end of the
   relevant block, mirroring an existing neighbor (Local Git is the template).
3. Never reformat or refactor upstream code.
4. Every new file uses the standard header (ESLint enforces it).
