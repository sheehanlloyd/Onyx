# Onyx test harness

Onyx's own checks come in two layers.

## Unit tests

Pure logic (the OpenAI wire translator, routing and profile math, context
ranking, co-change mining, compression, the model catalog, the commit-message
and review parsers, the compute ledger) is covered by the normal suite:

```bash
./scripts/test.sh --grep Onyx
```

## Mock runtime

`mock-ollama.mts` is an OpenAI-compatible server that behaves like Ollama
without needing a model. Start it on the port Onyx probes:

```bash
node test/onyx/mock-ollama.mts          # :11434, or set ONYX_MOCK_PORT
```

It implements `/v1/models`, `/api/tags`, `/api/show`, `/api/pull` (NDJSON
progress), streaming `/v1/chat/completions`, and `/v1/completions`, plus two
test-only endpoints — `/debug/last-completion` and `/debug/last-chat` — that
return the exact body of the most recent request.

Prompt markers steer it:

| Marker | Effect |
|---|---|
| `TOOLTEST` | emits a tool call, exercising the agent loop |
| `SYMTEST <name>` | calls `repoSymbols` with that query (add `EXPAND` for the call graph) |
| `MEMTEST <text>` | calls the `remember` tool with that note |

`ONYX_MOCK_WORD_DELAY_MS` slows the streamed answer (default 5ms per word) so
resilience tests have a real mid-stream window to interrupt.

It also recognizes Onyx's commit-message and review system prompts and answers
in the shape those flows parse, so both features can be driven without a model.

> Restart the mock after editing it — a stale process on the port keeps serving
> the old behavior, which looks exactly like a product bug.

## End-to-end

`run-e2e.mts` drives the real workbench against the mock and asserts on the run
journal Onyx writes per workspace:

```bash
npm run compile                    # the runner runs the app, it does not build it
node test/onyx/run-e2e.mts         # add --keep to inspect the throwaway profile
```

It creates a throwaway git workspace and user-data dir, launches Code OSS with
remote debugging, completes onboarding, and then drives every user-facing flow,
asserting on the run journal (24 checks):

- chat with the tool loop, `repoSymbols` with call-graph expansion, and the
  `remember` tool, plus the workspace-context and agent-memory sections landing
  in later prompts and post-run verification reporting a verdict
- inline (FIM) autocomplete, including the cross-file context header
- **Fix with Onyx** and **Explain with Onyx** routing into chat runs
- the model library quick pick, including installed models outside the catalog
- commit-message generation from a staged diff
- **⌘I inline edit**: the widget, an applied hunk, and undoing that hunk
  restoring the original line verbatim
- `Onyx: Review My Changes`, its replayable prompt snapshot and a `file:line`
  finding

It needs `@playwright/cli` (a devDependency). CI runs it under Xvfb after the
unit tests and uploads the journals on failure — see
`.github/workflows/onyx-ci.yml`.
