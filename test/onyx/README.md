# Onyx test harness

Onyx's own checks come in two layers.

## Unit tests

Pure logic (the OpenAI wire translator, routing and profile math, context
ranking, co-change mining, compression, the model catalog, the commit-message
and review parsers, the compute ledger, the FIM trimmer, the debug snapshot) is
covered by the normal suite — 168 tests:

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
| `EDITTEST <path>` | proposes two staged edits to that file via `editFile` |
| `TERMTEST <cmd>` | proposes that shell command via the terminal tool |
| `DOCTEST <query>` | searches the offline docs mirror via the `docs` tool |
| `PBTEST <name>` | fetches that repository playbook via the `playbook` tool |
| `SLOWTEST` | streams a ~20s answer, giving interruption tests a window |

`ONYX_MOCK_KIND=lmstudio` hides the Ollama native API so discovery detects the
endpoint as LM Studio — the speculative-decoding flow only offers runtimes that
support a draft model, and every one of them configures it when the model
loads, so the measurement records the pairing and never sends a draft on the
wire. `/debug/recent-chats` returns the last 8 chat request bodies (the
with-draft arm of a measurement is not the last one).

`ONYX_MOCK_WORD_DELAY_MS` slows the streamed answer (default 5ms per word) so
resilience tests have a real mid-stream window to interrupt.

It also recognizes Onyx's commit-message and review system prompts and answers
in the shape those flows parse, so both features can be driven without a model.

> Restart the mock after editing it — a stale process on the port keeps serving
> the old behavior, which looks exactly like a product bug.

## Benchmarks

`run-benchmarks.mts` produces every number the README and
[docs/BENCHMARKS.md](../../docs/BENCHMARKS.md) publish, and the SVG charts are
generated from its JSON — never hand-written.

```bash
npm run transpile-client                 # the harness imports the real modules from out/
node test/onyx/run-benchmarks.mts        # readable report
node test/onyx/run-benchmarks.mts --json-out /tmp/onyx-bench.json
node test/onyx/make-charts.mts /tmp/onyx-bench.json   # → docs/images/chart-*.svg
```

It has two halves. The **pure-logic** half (retrieval, architecture scan, edit
parsers, staged-hunk algebra, terminal classification, test surface) is
deterministic and needs no model — that is what CI runs, via `--skip-models`.
Every safety invariant in it (no parser marker leak, no fuzz crash, every hunk
selection round-trips, every labelled command classified) is recorded as a row
and asserted: a violation prints with the row and exits non-zero. There is no
"commands never run without approval" row; that is measured by the
authorization regressions at the dispatch boundary (B2), not asserted here.
The **real-model** half talks to whatever is installed on the machine: Ollama
at `:11434` and LM Studio at `:1234` by default (`ONYX_BENCH_OLLAMA` /
`ONYX_BENCH_LMSTUDIO` override them), measuring tok/s and TTFT warm and cold,
tool-call validity across three arms, and each model's score reproducing this
repository's own commits with the product's `scoreBenchAttempt`.

A runtime that is not running is **skipped with a printed reason** that also
lands in the JSON under `skipped`, so a report can never look complete when it
is not. `--speculative` adds the with/without-draft comparison; it is opt-in
because it reloads models through the `lms` CLI.

> The real-model half will happily benchmark `mock-ollama.mts` if you leave it
> running — models named `mock-*` are filtered out for exactly that reason, but
> stop the mock anyway before publishing numbers.

## End-to-end

`run-e2e.mts` drives the real workbench against the mock and asserts on the run
journal Onyx writes per workspace:

```bash
npm run compile                    # the runner runs the app, it does not build it
node test/onyx/run-e2e.mts         # add --keep to inspect the throwaway profile
```

It creates a throwaway git workspace and user-data dir, starts two mock
runtimes (Ollama- and LM-Studio-flavored), launches Code OSS with remote
debugging, completes onboarding, and then drives every user-facing flow,
asserting on the run journal and the live DOM (45 checks):

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
- staged agent edits: `editFile` stages instead of writing, the file appears in
  Onyx Changes, and accepting applies and clears the set
- the terminal tool: the approval dialog (with the exact command), execution,
  and the exit landing on the timeline
- the offline docs mirror finding the workspace's own markdown
- playbooks: the prompt index and the fetched recipe body
- stopping a streaming run and resuming it as a new briefing-run
- the refactor engine: model-suggested names, the rename staged for review
- the repo benchmark journaling a run and opening its evidence document
- speculative decoding measuring a baseline and explaining the runtime's own
  load-time flag — and never putting a draft on the wire
- the architecture map rendering modules, timing and a model summary
- the debug assistant's designed no-session message

It needs `@playwright/cli` (a devDependency). CI runs it under Xvfb on every
push and pull request, after the unit tests, and uploads the journals on
failure — see `.github/workflows/onyx-ci.yml`. The harness never clicks at a
coordinate: files open through Quick Open, the editor is focused through the
DOM, code actions are picked with the keyboard, and Onyx views open through
their commands, so the same script drives the workbench on macOS and under a
Linux framebuffer.

## Fresh output, and the harness's own checks

Unit tests and the benchmarks import compiled modules from `out/`, and an
existing `out/` proves nothing about whether it matches the source. Before a
red or a green run, go through the runner:

```bash
node test/onyx/run-fresh.mts -- ./scripts/test.sh --grep OnyxSomething
node test/onyx/run-fresh.mts --stamp-only        # refresh and stamp, run nothing
```

It records the revision and a digest of the dirty source tree, runs
`npm run transpile-client`, writes `out/.onyx-fresh.json`, and only then runs
the command. The module gate refuses to run when that stamp does not match the
tree.

The checks under `test/onyx/checks/` test the harness itself with Node's own
test runner and need no build of their own:

```bash
node --test --test-concurrency=1 "test/onyx/checks/*.test.mts"
```

One file at a time, because R-35 rewrites `out/` while it runs and R-23 reads it.

They cover the A1 inventory in disposable repositories (R-37), the hygiene
check against fixture trees with injected defects, the launch-script path
(A4), the benchmark's assertions against a compiled tree with an injected
marker leak (R-23), and the fresh-output protocol end to end (R-35: a failing
probe regression is written into this checkout, observed to fail only after a
transpile, fixed, observed to pass, and removed again).
