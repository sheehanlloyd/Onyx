# Onyx — a local-first AI IDE

Onyx is a macOS-first AI code editor forked from [Code - OSS](https://github.com/microsoft/vscode).
Think Cursor, except **all inference runs locally on your machine** — Ollama,
LM Studio, llama.cpp, vLLM, or any OpenAI-compatible endpoint. No cloud, no
telemetry, no remote calls outside endpoints you configure.

The positioning is not "open-source Cursor with Ollama support". It is an IDE
whose **entire agent architecture is designed around local inference**: a 7B
model gets a different harness than a 70B model, the router learns which of
your models is good at what on your hardware, and a visual control plane shows
exactly what the agent is doing, what it costs in compute, and why.

## Product principles

1. **Local-first is architectural, not a provider option.** One
   OpenAI-compatible client covers every runtime; no provider-specific code.
2. **Rebaseable forever.** All Onyx code lives in new directories; upstream
   files carry only one-line registration edits. See [REBASE.md](./REBASE.md).
3. **The harness adapts to the model.** Prompt style, tool count, temperature,
   and context budget derive from a per-model capability profile — seeded from
   model metadata, refined by measurements taken on this machine.
4. **Everything the agent does is observable and steerable.** The control
   plane is a first-class UI, not a log.
5. **Compute is the local cost.** Show tok/s, TTFT, and context usage the way
   cloud tools show dollars.

## Architecture (implemented)

```
┌───────────────────────────── renderer (workbench) ─────────────────────────────┐
│ src/vs/workbench/contrib/onyx/                                                 │
│                                                                                │
│  model/onyxLanguageModelProvider  ← ILanguageModelChatProvider (vendor 'onyx') │
│  model/onyxOpenAITranslator       ← messages/tools ⇄ OpenAI wire, JSON repair  │
│  profiles/onyxProfileService      ← seed ⊕ measured stats ⊕ overrides          │
│  routing/onyxRouterService        ← task classifier + learned model picking    │
│  agent/onyxChatAgent + AgentLoop  ← core default agent, multi-turn tool loop   │
│  agent/onyxPromptBuilder          ← profile-adaptive prompts, token accounting │
│  intelligence/onyxRetrievalTool   ← repoSymbols tool + call-graph expansion    │
│  intelligence/onyxContextRanker   ← open editors ⊕ history ⊕ git recency       │
│  intelligence/onyxMemoryService   ← persistent per-workspace agent memory      │
│  autocomplete/onyxInlineCompletions ← FIM ghost text + cross-file context      │
│  verification/onyxTaskVerification← post-run build/test checks → timeline      │
│  controlPlane/*                   ← live runs, budget, compute views + gates   │
└────────────────────────────────┬───────────────────────────────────────────────┘
                                 │ ProxyChannel 'onyxRuntime' (operationId-correlated)
┌────────────────────────────────▼──────────────────────────────────────────────┐
│ src/vs/platform/onyxRuntime/  (shared process, Node)                          │
│  discovery: probe :11434/:1234/:8080/:8000 + configured URLs,                 │
│             /v1/models + Ollama /api/tags + /api/show, 30s watcher            │
│  inference: streaming SSE POST /v1/chat/completions, AbortController cancel   │
│  repo:      gitRecentFiles via `git log` (renderer cannot spawn processes)    │
└───────────────────────────────────────────────────────────────────────────────┘
```

Integration points consumed (imports only, never patched):
`ILanguageModelsService`, `IChatAgentService.registerDynamicAgent`,
`ILanguageModelToolsService`, view container registry, `IStorageService`.

## Status

### Done (verified end-to-end in the running app)

- [x] Branding: Onyx app name/bundle/data folder; telemetry-free product.json
- [x] Localhost runtime auto-discovery with model metadata (family, params,
      quantization, context length, tool/vision capability)
- [x] Streaming OpenAI-compatible provider; models appear in the chat model
      picker with runtime + size + quant details; synthetic **Auto** model
- [x] Model capability profiles: size-class seeds ⊕ EMA of measured tok/s,
      TTFT, tool-call parse failures, accept rate (machine-local storage)
- [x] Adaptive router: task classification (quick-edit/implement/debug/plan/
      chat) → scored model choice with human-readable reasons
- [x] Onyx default chat agent: multi-turn loop, tool schema translation,
      malformed-tool-call repair, profile-based tool trimming and prompt style
- [x] AI Control Plane (auxiliary bar): Agent Activity timeline (route/turn/
      tool/result entries with reasons), pause / stop / redirect gates,
      Context Budget breakdown, Compute panel (tok/s, TTFT, live state)
- [x] `Onyx: Show Local Runtimes` command; `Open Onyx Control Plane` (⌘⌃O)
- [x] Run journal persisted per workspace (index + JSONL per run, 200-run cap);
      control plane history survives reloads
- [x] Inspector view: replay any past run down to the exact wire prompt each
      turn sent (messages, tool list, routing)
- [x] Accept/reject learning: chat votes and kept/copied code feed per-model
      accept rates, which shift routing
- [x] `Onyx: Benchmark Local Models`: measured tok/s, TTFT and tool-call
      compliance per model, recorded into routing profiles
- [x] Status bar presence with live in-flight tok/s
- [x] Local FIM inline autocomplete (`/v1/completions` with suffix) from the
      smallest discovered model; ghost text items carry an explicit empty
      range at the cursor (the engine's default word-range drops FIM output)
- [x] Verification-lite: after any run that used tools, the workspace error
      markers are compared against the pre-run baseline and the verdict is
      posted to the run's timeline
- [x] FIM latency measured per completion into profile stats (EMA); once a
      model has ≥5 measured completions, measured latency picks the
      autocomplete model instead of the parameter-count guess
- [x] Timeline renders incrementally (append-only fast path) with a
      150-entry DOM cap per run; older steps collapse behind an
      "earlier steps" expander
- [x] Onyx app icon set (canvas-rendered faceted gem, packed via iconutil
      into resources/darwin/code.icns)
- [x] `repoSymbols` language-model tool (ILanguageModelToolsService):
      symbol-aware retrieval over the workspace symbol providers with
      deterministic ranking (exact > prefix > substring, definitions first)
      and per-match source snippets; pinned to survive small-model tool caps
- [x] Context ranking: open editors ⊕ editor history ⊕ git commit recency
      (shared-process `gitRecentFiles`) merged into a deterministic score;
      every agent prompt carries a "files the user is working on" section
      and the budget view shows it as its own slice
- [x] Context compression for small models: history messages and tool
      results elided head-and-tail with explicit markers, budgets derived
      from the profile's prompt style
- [x] Project checks after agent edits (`onyx.verification.task`): the
      workspace's default build/test task (or a named task) runs after any
      tool-using run and its pass/fail verdict + duration land on the
      timeline (not awaited — responses never wait on a build)
- [x] Task-aware autocomplete context: FIM prompts carry short commented
      snippets from the most relevant *other open* files (editor-signal
      ranking only — no disk or git I/O on the completion path)
- [x] Call-graph expansion on `repoSymbols` (`expand: true`): callers and
      callees of the best match via the language's call-hierarchy provider,
      with a plain-references fallback
- [x] Persistent per-workspace agent memory: a pinned `remember` tool
      stores durable facts (deduplicated, capped, machine-local); every
      later prompt in the workspace carries them; `Onyx: Clear Agent
      Memory` wipes them
- [x] Onyx visual identity: `extensions/theme-onyx` ships the Onyx Dark
      theme (near-black chrome, violet/teal accents, full token +
      semantic colors) as the product default, plus the "Get Started with
      Onyx" walkthrough on the Welcome page
- [x] Distribution: `LAUNCH.md` documents the notarized-DMG channel
      (build → Developer ID signing → notarization → DMG) with the
      pre-flight checklist

### Next

- [ ] Co-change mining and embedding-free similarity for context ranking
- [ ] An Onyx Light theme companion

### Roadmap

- **Phase 2 — Repo intelligence (partially shipped, see Done):** call-graph
  context assembly, co-change mining, embedding-free similarity signals.
- **Phase 3 — Model management:** model library with one-click install
  (Ollama pull), Apple-Silicon-aware recommendations (unified memory →
  quantization/context tradeoffs), on-your-repo benchmark suites feeding the
  router, speculative-decoding configuration.
- **Phase 4 — Verification & isolation (first slice shipped, see Done):**
  change risk analysis, git-worktree-per-agent parallel runs, adversarial
  reviewer agent, tournament mode.
- **Phase 5 — Polish & depth:** FIM autocomplete on a dedicated small model
  with agent-task-aware context, persistent repo/developer memory (local),
  offline docs mirror, idle-compute background review, energy/thermal-aware
  scheduling.

## Development

```bash
# Node 24 required (repo hard-fails otherwise)
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
npm i
npm run transpile-client        # ~3s incremental compile
VSCODE_SKIP_PRELAUNCH=1 ./scripts/code.sh <workspace>
# verify
npm run typecheck-client && npm run valid-layers-check
npx eslint src/vs/platform/onyxRuntime src/vs/workbench/contrib/onyx
```

To test without a real model runtime, run a mock server on :11434 implementing
`/v1/models`, `/api/tags`, `/api/show`, and streaming `/v1/chat/completions`
(SSE). A prompt containing `TOOLTEST` should make it emit a tool call to
exercise the agent loop. See `test/onyx/mock-ollama.mjs`.
