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
| `TOOLTEST` | lists the workspace root through `listDirectory`, exercising the agent loop |
| `READEDITTEST <path>` | reads that file through `readFile`, then proposes an edit whose SEARCH text is a line it read back (R-31) |
| `SYMTEST <name>` | calls `repoSymbols` with that query (add `EXPAND` for the call graph) |
| `MEMTEST <text>` | calls the `remember` tool with that note (the tool is optional: on the eight-slot profile it is offered when the user's message says "remember"); the product then asks the user to confirm the note |
| `NETTEST <url>` | opens that URL through `openBrowserPage`, when that tool is offered (the network tools are an opt-in, and each call asks) |
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
pnpm run transpile-client                # the harness imports the real modules from out/
node test/onyx/run-benchmarks.mts        # readable report
node test/onyx/run-benchmarks.mts --json-out /tmp/onyx-bench.json
node test/onyx/make-charts.mts --manifest <manifest.json> /tmp/onyx-bench.json   # → docs/images/chart-*.svg
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
pnpm run compile                   # the runner runs the app, it does not build it
node test/onyx/run-e2e.mts         # add --keep to inspect the throwaway profile
```

It creates a throwaway git workspace and user-data dir, starts two mock
runtimes (Ollama- and LM-Studio-flavored), launches Code OSS with remote
debugging, completes onboarding, and then drives every user-facing flow,
asserting on the run journal and the live DOM (57 checks):

- the tool list a default run advertises on the 7B profile (the six essential
  tools and the two documented optional ones, R-36), Onyx's own `listDirectory`
  and `readFile`, and a read → staged edit (R-31), all with the Copilot
  extension disabled, as `scripts/code.sh` now launches by default
- that upstream's Agent Host never starts (no `agenthost.log` in the profile)
- chat with the tool loop, `repoSymbols` with call-graph expansion, and the
  `remember` tool behind its confirmation (the note and the origin of its text
  on show, R-59), plus the workspace-context and agent-memory sections landing
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
- the terminal tool: the approval dialog (with the exact command, and Run
  Once and Deny as its only choices), execution, the exit landing on the
  timeline, and the same command asking again and not running when denied
- the offline docs mirror finding the workspace's own markdown
- playbooks: the prompt index and the fetched recipe body
- stopping a streaming run and resuming it as a new briefing-run
- the refactor engine: model-suggested names, the rename staged for review
- the repo benchmark journaling a run and opening its evidence document
- speculative decoding measuring a baseline and explaining the runtime's own
  load-time flag — and never putting a draft on the wire
- the architecture map rendering modules, timing and a model summary
- the debug assistant's designed no-session message

It needs `@playwright/cli` (a devDependency), which the runner resolves from
the repository's own dependencies and runs with the same Node; no `npx` or
`pnpm exec` sits in between. CI runs it under Xvfb on every
push and pull request, after the unit tests, and uploads the journals on
failure — see `.github/workflows/onyx-ci.yml`. The harness never clicks at a
coordinate: files open through Quick Open, the editor is focused through the
DOM, code actions are picked with the keyboard, and Onyx views open through
their commands, so the same script drives the workbench on macOS and under a
Linux framebuffer.

On macOS the workbench is launched with `--use-mock-keychain` (the packaged
smoke does the same). The workbench reads its "Safe Storage" key from the
login keychain at startup, synchronously, on the main thread. That key belongs
to whichever Electron binary created it, so after an Electron upgrade macOS
asks for permission, the call waits for an answer, and the debugging endpoint,
which is served from that thread, answers once and then hangs: the driver
reports only a timeout "retrieving websocket url". A mock keychain removes the
prompt and the dependency on one machine's keychain. If the endpoint goes
silent anyway, the runner says so instead of passing the driver's timeout on.

When a run aborts, the runner prints what the failed driver command wrote and
saves a screenshot of the window to `abort.png` in the run directory; pass
`--keep` to keep that directory.

## Fresh output, and the harness's own checks

Unit tests and the benchmarks import compiled modules from `out/`, and an
existing `out/` proves nothing about whether it matches the source. Before a
red or a green run, go through the runner:

```bash
node test/onyx/run-fresh.mts -- ./scripts/test.sh --grep OnyxSomething
node test/onyx/run-fresh.mts --stamp-only        # refresh and stamp, run nothing
```

It records the revision and a digest of the dirty source tree, runs
`pnpm run transpile-client`, writes `out/.onyx-fresh.json`, and only then runs
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
marker leak (R-23), the fresh-output protocol end to end (R-35: a failing
probe regression is written into this checkout, observed to fail only after a
transpile, fixed, observed to pass, and removed again), and the provenance rule
(R-43: the chart builder refuses without a valid manifest, the mock echoes a
requested seed on the wire).

## Trace and experiment provenance

Every agent run journals a version 2 trace
(`src/vs/workbench/contrib/onyx/common/onyxTrace.ts`, pure and importable from
plain Node): one header record with the harness configuration hash, model
identifier and digest, runtime name and version, sampling parameters including
the seed, and the tool list with schema hashes; one record per model turn with
the request digest, the response text, how the stream ended, the tool calls
with argument and result digests, and whether the runtime honoured the seed;
plus one record per terminal approval (with its source) and per accepted hunk.
A value the writer does not know is `null`, never absent: `validateTrace` fails
closed on a missing field. Version 1 journals (run events only) still read.

The seed goes on the wire as `seed` whenever a model's profile sets one, and
`seedHonoured` is true only when the runtime echoed it back (the mock does;
`onyxRuntimeService.test.ts` covers both). Campaigns carry an experiment
manifest, `test/onyx/lab/manifest.schema.json`; `test/onyx/lab/manifest.mts`
validates one or checks a results directory under `docs/research/results/`.
`make-charts.mts --manifest <file>` is the only way to draw a chart.

## Simulation rig

`src/vs/workbench/contrib/onyx/test/browser/sim/` is the deterministic
simulation rig (L1). It instantiates the real agent loop, control plane,
change set service, edit tool and terminal tool against real text models
over an in-memory file system and simulates only the boundaries: the runtime
(a scripted stream and a recording command executor), the dialog service
(scripted decisions), the core model and tool registries, and the clock
(`runWithFakedTimers`, so `Date.now` and every timer are virtual; no real
sleeps). One seed decides what the model persona emits, what the user does
concurrently, which faults the environment injects, and at which boundary.
Traces are canonical: product-minted ids become first-appearance ordinals and
time is virtual, so the same seed gives a byte-identical trace (R-41).

```bash
./scripts/test.sh --grep OnyxSim                                   # R-41, personas, scenarios, shrinking, a 25-episode smoke
ONYX_SIM_EPISODES=2000 ./scripts/test.sh --grep "OnyxSim smoke"     # the smoke campaign (every pull request, the module gate)
ONYX_SIM_EPISODES=50000 ONYX_SIM_SEED=<seed> ./scripts/test.sh --grep "OnyxSim smoke"   # module and full campaigns
node test/onyx/sim/run-campaign.mts --episodes 20000 --seed 1       # every invariant checker over 20,000 seeds, 2,000 a process:
                                                                    # one process runs out of memory near 14,000 episodes
```

The campaign reports episodes per second, the status mix, the persona mix and
the number of activity branches reached in the test's reported title. A
failing episode prints its seed; `shrinkEpisode` reduces its script while the
violation persists and the minimal script is what gets committed, never a
prose description.

Resurrection mutants (L12) live beside the rig: `onyxSimMutants.ts` holds one
test-only subclass per fixed defect, `onyxSimMutantTable.ts` says what each
one puts back and which violation class the campaign must report, and the
exporter writes a descriptor per mutant to `test/onyx/sim/mutants/`.

```bash
./scripts/test.sh --grep "OnyxSim mutants"                                  # each mutant: its script, then up to 1,000 seeded episodes
ONYX_SIM_MUTANT_EPISODES=2000 ./scripts/test.sh --grep "OnyxSim mutants"    # the module gate's size
```

Episodes are data. The end-to-end mock scenarios live as scripts in
`onyxSimScenarios.ts`; `node test/onyx/sim/export-episodes.mts` writes them to
`test/onyx/sim/episodes/*.json` (`--check` fails when the files drift), and
`ONYX_MOCK_EPISODE=test/onyx/sim/episodes/<name>.json node test/onyx/mock-ollama.mts`
replays one over the real SSE path, so the same episode runs at the service
layer in milliseconds and again through the node and end-to-end layers.
