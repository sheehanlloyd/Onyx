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

## Contents

| | |
|---|---|
| [Product principles](#product-principles) | The five rules everything else follows from |
| [Architecture](#architecture-implemented) | Renderer and shared-process layout, as built |
| [Status](#status) | What ships today, at a glance and in full |
| [Verified against real models](#verified-against-real-models-2026-08-30) | Six models live: what broke, and what that taught |
| [Next](#next) · [Roadmap](#roadmap) | What is left, and how it got here |
| [Development](#development) | Build, run, and the gates CI enforces |

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
│  intelligence/onyxContextRanker   ← editors ⊕ history ⊕ git recency ⊕ co-change│
│  intelligence/onyxMemoryService   ← persistent per-workspace agent memory      │
│  autocomplete/onyxInlineCompletions ← FIM ghost text + cross-file context      │
│  verification/onyxTaskVerification← post-run build/test checks → timeline      │
│  models/onyxModelLibrary          ← catalog + RAM-aware advice + one-click pull│
│  scm/onyxCommitMessage            ← staged diff → local model → SCM input      │
│  review/onyxReviewChanges         ← adversarial review → timeline + file:line  │
│  editor/onyxCodeActions           ← "Fix with Onyx" / "Explain with Onyx"      │
│  editor/onyxInlineEditController  ← ⌘I inline edit + per-hunk accept/reject   │
│  tournament/onyxTournament        ← N models, N git worktrees, pick a winner  │
│  config/onyxProjectConfigService  ← .onyx/config.json, merged under settings  │
│  diagnostics/onyxDiagnosticsExport← redactable zip of journals + profiles     │
│  compute/onyxEnergyService        ← power/thermal state → routing downshift   │
│  agent/onyxPromptCache            ← KV-prefix reuse measurement per session   │
│  compute/onyxLedgerService        ← per-model session ⊕ all-time compute spend │
│  onboarding/onyxRuntimeStep       ← the first-run "connect a runtime" step     │
│  controlPlane/*                   ← live runs, budget, compute views + gates   │
└────────────────────────────────┬───────────────────────────────────────────────┘
                                 │ ProxyChannel 'onyxRuntime' (operationId-correlated)
┌────────────────────────────────▼──────────────────────────────────────────────┐
│ src/vs/platform/onyxRuntime/  (shared process, Node)                          │
│  index:    incremental BM25 over the workspace, persisted per root, capped    │
│  worktree: detached git worktrees for tournament isolation + crash pruning    │
│  power:    pmset power source and thermal pressure (macOS)                    │
│  discovery: probe :11434/:1234/:8080/:8000 + configured URLs, /v1/models     │
│             ⊕ Ollama /api/tags + /api/show ⊕ LM Studio /api/v0/models        │
│             (drops embedding models), 30s watcher                            │
│  inference: streaming SSE POST /v1/chat/completions, AbortController cancel   │
│  repo:      gitRecentFiles / gitCommitFileGroups / gitDiff via `git`          │
│             (the renderer cannot spawn processes), 60s cached                 │
│  machine:   unified memory, CPU, arch — sizes the model recommendations       │
│  models:    `ollama pull` with normalized NDJSON progress                     │
│  exec:      approval-gated shell commands (group kill, hard timeout)          │
│  docs:      BM25 mirror of workspace md + dependency READMEs/JSDoc            │
│  architecture: import-graph scanner (modules, churn, fan-in), cached          │
│  history:   commit candidates + `git show rev:path` for repo benchmarks       │
└───────────────────────────────────────────────────────────────────────────────┘
```

Integration points consumed (imports only, never patched):
`ILanguageModelsService`, `IChatAgentService.registerDynamicAgent`,
`ILanguageModelToolsService`, view container registry, `IStorageService`.

## Status

### Done (verified end-to-end in the running app)

**At a glance**

| Area | What ships |
|---|---|
| **Local inference** | Runtime auto-discovery across Ollama, LM Studio, llama.cpp and vLLM; streaming OpenAI-compatible provider; per-model capability profiles seeded from metadata and sharpened by measurement; an adaptive router with human-readable reasons; a synthetic **Auto** model |
| **Trust and review** | Onyx Changes (every agent edit staged, per-hunk accept/reject, crash-surviving, rebased on drift); the approval-gated terminal with un-allowlistable dangerous commands; change-risk badges; post-run verification against the marker baseline |
| **Repo intelligence** | Embedding-free BM25 retrieval blended with symbol matches and co-change; call-graph expansion; persistent agent memory; the offline docs mirror; the architecture map |
| **The editor** | ⌘I inline edit with per-hunk undo; FIM autocomplete with cross-file context; Fix/Explain code actions; local commit messages; the adversarial reviewer; the multi-file refactor engine; the debug-aware assistant |
| **Observability** | The control plane (timeline, gates, context budget, compute); the run journal and Inspector replay down to the wire prompt; the compute ledger; resumable runs; the Onyx Hub |
| **Measurement** | Model benchmarks, on-your-repo benchmarks feeding the router, prompt-cache measurement, speculative-decoding pairing with an honest readout, energy- and thermal-aware scheduling |
| **Product** | Onyx branding and icon; four Onyx themes including high contrast; de-branded first run with no account step; accessibility help and accessible views; project config in `.onyx/`; playbooks; the diagnostics bundle; tournament mode |

<details>
<summary><b>The full list</b> — every shipped item, each verified in the running app</summary>

<br/>

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
- [x] Run journal persisted per workspace (index + JSONL per run, 200-run cap).
      The Agent Activity view is deliberately *live* — it shows this window's
      runs and starts empty after a reload, saying so and pointing at the
      Inspector, which replays every journaled run including earlier windows'
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
- [x] De-branded first run: onboarding step 1 is **Connect a Local Runtime**
      (live runtime detection, three copyable commands), the title bar's
      "Sign In" pill is off by a registered settings default, the featured
      walkthrough is Onyx's, and the hosted-AI setup steps are gone. A fresh
      install never mentions another vendor's assistant or asks for an account
- [x] Onyx Light: a companion theme in the same violet/teal accent language on
      warm paper tones, with its own onboarding tile and preview
- [x] Designed resting states: a shared "no local model yet" empty state
      (Onyx mark, plain-language body, copyable install commands) in chat and
      across the control plane, replacing raw connection errors
- [x] Model Library (`Onyx: Manage Models`): installed models plus a curated
      catalog, sized against this Mac's unified memory (fit is `comfortable` /
      `tight` / `needs more memory`, with per-tier quantization and context
      advice) and one-click `ollama pull` with live progress
- [x] Local commit messages: an SCM input action that turns the staged diff
      into a commit message with a local model (deterministic prompt, diff
      capped and elided per file, model scaffolding stripped)
- [x] `Onyx: Review My Changes`: the working-tree diff through an adversarial
      reviewer prompt; findings land on the control-plane timeline with
      clickable `file:line` links. Report only — it never edits
- [x] Editor quick actions: **Fix with Onyx** on a diagnostic and **Explain
      with Onyx** on a selection, both routed through the normal chat surface
      with the relevant range attached
- [x] Compute dashboard: per-model requests, tokens, average tok/s and TTFT,
      accept rate and a `B·s` energy proxy (billions of parameters × seconds
      held), for this session and all time
- [x] Co-change mining: per-commit file groups from `git log` become a
      "changes together" index that boosts the active file's historical
      partners in context ranking
- [x] Inline edit (⌘I): select code, state an instruction, and a local model's
      SEARCH/REPLACE edit streams in as reviewable hunks — ⌘⏎ keeps one, ⌘⌫
      restores the original lines, F7 walks them. An unparseable reply changes
      nothing and says so
- [x] Tournament mode (`Onyx: Run in Parallel`): one instruction raced across
      several local models, each in its own detached `git worktree`, compared
      side by side with timings and diffs; the winner is applied with `git
      apply`, the rest discarded, and the pick feeds per-model accept rates
- [x] Grammar-constrained tool calling: runtimes that support OpenAI
      `response_format: json_schema` constrain low-quality models to a
      tool/answer envelope; the Compute view shows malformed-call rate
      free-form vs constrained, and the text-repair path remains the fallback
- [x] KV-cache-aware prompting: a stable system prefix, append-only history and
      volatile context last, with a "prompt cache" readout (reused prefix
      tokens, and first-token latency split by high vs low reuse)
- [x] Model residency: `keep_alive` sized against unified memory, warm-up on
      window focus, a "loading model" state, and cold-start vs warm first-token
      latencies kept as separate measurements
- [x] Energy- and thermal-aware scheduling: on battery or under thermal
      pressure the router caps model size and autocomplete backs off, with one
      plain sentence in the Compute view explaining the downshift
      (`onyx.energy.policy`)
- [x] Embedding-free semantic retrieval: an incremental BM25 index over the
      workspace in the shared process (persisted per root, capped, build output
      excluded), blended with symbol matches and co-change into one ranking —
      9/10 hit@5 on a fixed query set where substring search scores 0/10
- [x] Change-risk analysis: churn, coupling, call-graph fan-in, hunk size, test
      proximity and error-handling edits scored into a calm risk badge with a
      one-line reason, on both review and agent runs
- [x] Idle-compute background review (`onyx.review.background`, off by
      default): when idle, plugged in and cool, the reviewer files findings in
      the Problems panel under the `onyx` source with a control-plane badge;
      any activity or foreground request cancels it instantly
- [x] Context pinning and budget editing: the Context Budget view lists what
      the next prompt will carry, with pin / evict / re-admit and a live token
      estimate; pins persist per workspace
- [x] Run diffing in the Inspector: any two journaled runs compared by routing,
      per-turn model, tool list, new messages, tool activity and outcome, with
      identical turn stretches elided
- [x] Project configuration (`.onyx/config.json`): pinned models per task kind,
      verification task, context pins, review severity threshold and disabled
      tools — JSON-schema-backed, merged **under** user settings, with
      `Onyx: Show Effective Project Configuration`
- [x] Diagnostics bundle (`Onyx: Export Diagnostics`): one zip of journals,
      profiles, machine profile, runtimes, settings and recent logs, written
      where you choose, with prompt text redacted unless you opt in
- [x] The Onyx Hub (⌘⌃H): one quick pick fronting every Onyx surface with live
      state in the descriptions — models ready, runs today, what is resident
- [x] Onyx Dark High Contrast and Onyx Light High Contrast, pinned as the
      product's HC defaults with their own onboarding tiles
- [x] Accessibility: an accessibility help dialog and a plain-text accessible
      view for the control plane, help for inline edit, and polite aria-live
      announcements for every streaming agent step
- [x] Virtualized activity timeline: a 5,000-step run renders 96 DOM nodes in
      5ms instead of 20,001 nodes in 131ms, scrolling at 0.41ms per window
- [x] End-to-end harness: `test/onyx/run-e2e.mts` launches the workbench
      against the mock runtime and asserts on the run journal; `.github/
      workflows/onyx-ci.yml` runs typecheck, layers, ESLint, stylelint and the
      Onyx unit tests on every push
- [x] Onyx Changes: every agent edit is STAGED, never written — a control-plane
      view lists each file with per-hunk accept/reject, accept/reject-all, a
      change-risk badge, crash-surviving persistence and rebase-on-drift; the
      `editFile` tool (SEARCH/REPLACE) is the agent's only write path
- [x] Approval-gated terminal tool: the agent proposes shell commands; a
      designed dialog offers once / session / always / deny, "always" persists
      to `.onyx/config.json`'s `terminalAllowlist`, dangerous-command
      heuristics are named in the prompt, output streams to the timeline, and
      a hard timeout plus `Onyx: Kill Running Terminal Command` end it
- [x] Offline documentation mirror: workspace markdown, dependency READMEs and
      the JSDoc inside type declarations in a second BM25 corpus (capped,
      freshness-stamped); the `docs` tool searches it and the control plane
      notes exactly which documents an answer used
- [x] Speculative decoding: every runtime that supports it configures the draft
      when the model **loads** (verified against LM Studio 0.4.23, which
      rejects a per-request draft outright), so Onyx never puts one on the
      wire. `Onyx: Measure Speculative Decoding` pairs a draft, measures the
      target as it stands, tells you the exact command for your runtime, waits,
      then re-measures — the Compute view reports only what was observed here,
      including "no measured effect"
- [x] On-your-repo benchmarks: real past commits become tasks (file-before +
      commit message → reproduce the change), scored by changed-line F1
      against the author's actual result, per-model per-kind scores feed the
      router with a visible reason, and a results doc shows the evidence
- [x] Agent playbooks: checked-in recipes at `.onyx/playbooks/*.md`
      (frontmatter-validated, Problems-panel markers, frontmatter completion),
      a one-line index in the agent's prompt, a `playbook` tool to fetch them,
      `Onyx: Run a Playbook` + a Hub entry, three built-ins for this repo
- [x] Resumable runs: crashed/stopped/failed runs are found in the journal,
      distilled into a resume briefing (original request, progress, explicit
      caveats — vanished model, moved git HEAD, still-staged edits) and
      continued through the ordinary chat surface; staged edits survive crashes
- [x] Debug-aware assistant: a read-only `debugState` tool (paused stack,
      frames, variables) and `Onyx: Explain This Failure`, which puts the full
      snapshot in the visible chat request — nothing is redacted silently
- [x] Multi-file refactor engine: rename / extract function / move symbol,
      where language services compute every edit and the local model only
      proposes names; results stage into Onyx Changes and an error-marker
      verification pass reports after accept
- [x] Architecture map: a sidebar view of the workspace as modules with
      dependency edges, churn × fan-in hot spots and one-line local-model
      summaries (cached per module) — 13k files analyzed in ~3s, ~1s cached,
      off the startup path

- [x] LM Studio: models are read through its native `/api/v0/models` as well,
      so embedding models are never routed a chat request and Onyx picks up
      the architecture, quantization and context length it reports

- [x] Speculative decoding measured against a real LM Studio 0.4.23 install
      (which drives llama.cpp's `llama-server` underneath). The draft is
      provably attached: a bogus draft is rejected at load time, so a
      successful load means the pairing took effect. Across three
      configurations on this M4 Pro, speculation made generation **slower**,
      never faster:

      | target → draft | prompt | without draft | with draft | Δ |
      |---|---|---|---|---|
      | 1.5B → 0.5B | prose | 90.2 tok/s | 88.3 tok/s | −2% |
      | 7B → 0.5B   | prose | 25.9 tok/s | 23.7 tok/s | −9% |
      | 7B → 0.5B   | code  | 31.2 tok/s | 24.7 tok/s | −21% |

      Best-of-three after a discarded warm-up round; the conclusion survives
      the variance (the baseline's *worst* code run, 26.5 tok/s, still beats
      the draft's *best*, 24.7). Plausible cause: both models contend for the
      same unified-memory GPU, so the draft is not close to free. Results may
      differ on hardware where the draft runs on separate silicon. **This is
      exactly why the readout only reports measurements taken on your
      machine** — the feature is the honesty, not a claimed speedup.
- [x] Reproducible benchmarks (`test/onyx/run-benchmarks.mts`): a deterministic
      half (retrieval, architecture scan, edit parsers, hunk algebra, terminal
      classification) that runs anywhere and in CI, plus a real-model half that
      measures tok/s and TTFT warm and cold, tool-call validity across three
      arms, and every installed model's score reproducing this repository's own
      commits — one model resident at a time, absent runtimes skipped with a
      printed reason rather than a failure. `make-charts.mts` renders the
      README's SVGs from that run's JSON only, so a chart cannot drift from the
      number it claims. [docs/BENCHMARKS.md](./docs/BENCHMARKS.md) documents
      what each measurement means and how to reproduce it.

      Measured against three real Ollama models on a quiesced M4 Pro:

      | model | tok/s | TTFT warm / cold | native tool calls | after Onyx repair | constrained | repo-bench F1 |
      |---|---|---|---|---|---|---|
      | qwen2.5-coder:7b   | 49.0  | 26 ms / 1.00 s | **0%** | 100% | 100% | 0.25 |
      | llama3.2:3b        | 94.9  | 15 ms / 1.36 s | 100%   | 100% | 100% | 0.11 |
      | qwen2.5-coder:1.5b | 151.6 | 11 ms / 0.87 s | **0%** | 100% | 83%  | 0.13 |

      Two of the three emit no usable native `tool_calls` at all; Onyx recovers a
      valid call from prose in 6/6 requests for both. The repo-bench F1 reproduced
      exactly across three independent runs (temperature 0), and on quick edits
      the 1.5B ties the 7B at 0.34 while running 3× faster — the routing signal
      arguing against always reaching for the largest model.

      One measurement-hygiene finding worth recording: running two runtimes at
      once on 24 GB made the same model read 20–49 tok/s and once produced a warm
      TTFT longer than its own cold one. The harness now flags that impossible
      pair as unreliable, counts a task the runtime could not serve separately
      from one the model got wrong, and the published numbers come from a
      single-runtime run on an idle machine.
- [x] Project identity and community files: `NOTICE.md` (who owns what, and why
      Onyx's own files still carry the upstream lint header), `TRADEMARK.md`
      (the name and mark are reserved; the code is not), and Onyx's
      `CONTRIBUTING.md` / `SECURITY.md` / `CODE_OF_CONDUCT.md` placed in
      `.github/`, where GitHub resolves them ahead of the repository root — so
      upstream's copies stay byte-identical and the fork gains no new conflict

</details>

### Verified against real models (2026-08-30)

A full pass over every surface with **six** models live — Ollama serving
qwen2.5-coder 7b/1.5b and llama3.2:3b, LM Studio serving qwen2.5-coder
7b/1.5b/0.5b — found five bugs that the mock runtime structurally could not
show, all now fixed with regression tests:

1. **Two runtimes at once broke the first-run headline.** With Ollama and LM
   Studio both up, onboarding said "Ollama is running — 6 models ready",
   crediting LM Studio's three models to Ollama. Needs two runtimes to see.
2. **Successful constrained turns were scored as failures.** The grammar
   produced a valid `{"action":"tool",…}` envelope; the text-repair path
   recognized `tool` as a tool name and consumed it first; the loop then judged
   the constrained turn on the empty prose that was left, logged "did not match
   the envelope", and counted a constrained failure — in the very metric the
   Compute view publishes. Needs a real model *and* a runtime that honors
   `response_format`.
3. **A failed tool looked exactly like a successful one.** Two `editFile` calls
   failed against a real model and the transcript still read "Staging an edit to
   src/cart.ts" twice, with a reasonless red dot on the timeline. Failures now
   carry the tool's own sentence, in the transcript and on the timeline.
4. **The staged-file row starved the filename.** Every sibling in that flex row
   was fixed-width, so `src/cart.ts` rendered as `src_` while the risk chip kept
   its full width. The path is the row's identity and is now the last thing to
   give.
5. **FIM autocomplete overran the cursor.** qwen2.5-coder:1.5b, asked to fill a
   function body, wrote the body, closed the function the file already closes,
   and started writing the next three functions. The `\n\n\n` stop never fires —
   these models separate declarations with one blank line — so a user accepting
   the ghost text got a stray `}` and half a function they never asked for.

Two more honest observations that are **model** behavior, not product bugs, and
are worth knowing before trusting a small local model:

- **qwen2.5-coder never uses the native tool-call channel.** 0/6 across four
  model/runtime combinations, while llama3.2:3b managed 6/6. Ollama advertises
  `tools` capability for it and the model still writes the call as prose. Onyx's
  text-repair path is the only reason these models can call tools at all — the
  benchmark now reports that as its own number.
- **A model's own tool-free answer poisons the rest of the session.** Asked to
  use the `docs` tool, qwen2.5-coder:7b answered "not explicitly mentioned in
  the documentation" three times without calling it. In a *fresh* chat the same
  model called the tool and answered correctly from README.md. Its own earlier
  answers, sitting in history, taught it that answering from nothing was fine.

One harness bug surfaced the same way: `run-e2e.mts` spawned its two mock
runtimes **without** `detached: true`, so teardown's group kill (`kill(-pid)`)
named a group that never existed, threw into an empty catch, and left a mock
listening on `:11434` — which the next session mistakes for a real Ollama.
Fixed, with a pid fallback behind the group kill.

Also verified live end to end: Auto routing with the reason journaled, staged
edits through per-hunk accept to disk, the terminal approval dialog and a real
`npm test` exit, the offline docs mirror naming the document it used, the
playbook index and fetched recipe reaching the wire prompt, resume after a real
`SIGKILL` mid-run, the debugger snapshot with real frames and variables, the
refactor engine's model-suggested names staging for review, the six-model
tournament in six git worktrees with clean teardown, the model library against
this Mac's memory, a commit message from the staged diff, the adversarial
reviewer, and the architecture map over 13,256 files in 3.1s.

### Next

- [ ] Distribution: notarize the DMG with a Developer ID, then publish.

### Roadmap

- **Phase 2 — Repo intelligence (shipped):** call-graph context assembly,
  co-change mining, and the embedding-free BM25 index blended into one
  retrieval tool.
- **Phase 3 — Model management (shipped):** the model library, Apple-Silicon-
  aware recommendations, residency and warm-up, speculative-decoding pairing
  with honest measurement, and on-your-repo benchmark suites feeding the
  router.
- **Phase 4 — Verification & isolation (shipped):** project checks, the
  adversarial reviewer, change-risk analysis, git-worktree-per-agent parallel
  runs and tournament mode.
- **Phase 5 — Polish & depth (shipped):** FIM autocomplete with task-aware
  context, persistent memory, the compute ledger, idle-compute background
  review, energy/thermal-aware scheduling, and the offline docs mirror.
- **Phase 6 — Trust & scale (shipped):** staged agent edits with per-hunk
  review, the approval-gated terminal, playbooks, resumable runs, the
  debug-aware assistant, the refactor engine and the architecture map.

## Development

```bash
# Node 24 required (repo hard-fails otherwise)
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
npm i
npm run transpile-client        # ~3s incremental compile
VSCODE_SKIP_PRELAUNCH=1 ./scripts/code.sh <workspace>
# verify
npm run typecheck-client && npm run valid-layers-check && npm run stylelint
npx eslint src/vs/platform/onyxRuntime src/vs/workbench/contrib/onyx
```

CI runs those gates plus the Onyx unit tests on every push —
[.github/workflows/onyx-ci.yml](./.github/workflows/onyx-ci.yml).

To test without a real model runtime, use the mock server and the end-to-end
runner — both documented in [test/onyx/README.md](./test/onyx/README.md):

```bash
node test/onyx/mock-ollama.mts     # OpenAI-compatible mock on :11434
./scripts/test.sh --grep Onyx      # unit tests for the pure logic
node test/onyx/run-e2e.mts         # drives the real workbench, asserts on the journal
```
