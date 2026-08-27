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
│  controlPlane/*                   ← live runs, budget, compute views + gates   │
└────────────────────────────────┬───────────────────────────────────────────────┘
                                 │ ProxyChannel 'onyxRuntime' (operationId-correlated)
┌────────────────────────────────▼──────────────────────────────────────────────┐
│ src/vs/platform/onyxRuntime/  (shared process, Node)                          │
│  discovery: probe :11434/:1234/:8080/:8000 + configured URLs,                 │
│             /v1/models + Ollama /api/tags + /api/show, 30s watcher            │
│  inference: streaming SSE POST /v1/chat/completions, AbortController cancel   │
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

### Next (Phase 1 polish)

- [ ] Record FIM latency into profiles; task-aware autocomplete context
- [ ] Timeline virtualization for very long runs (currently full re-render)
- [ ] App icon set (resources/darwin/*.icns still stock)

### Roadmap

- **Phase 2 — Repo intelligence:** Tree-sitter/LSP-backed retrieval (symbol
  units, not line ranges), call-graph context assembly, learned context
  ranking (embedding similarity + open tabs + git recency + co-change),
  context compression for small models.
- **Phase 3 — Model management:** model library with one-click install
  (Ollama pull), Apple-Silicon-aware recommendations (unified memory →
  quantization/context tradeoffs), on-your-repo benchmark suites feeding the
  router, speculative-decoding configuration.
- **Phase 4 — Verification & isolation:** automatic compile/lint/test after
  agent edits with verdict UI, change risk analysis, git-worktree-per-agent
  parallel runs, adversarial reviewer agent, tournament mode.
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
