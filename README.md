<p align="center">
  <img src="docs/images/onyx-icon.png" width="112" alt="Onyx icon" />
</p>

<h1 align="center">Onyx</h1>

<p align="center"><b>The local-first AI code editor for macOS.</b><br/>
Every model runs on your machine. No cloud. No telemetry. No account.</p>

<p align="center">
  <img src="docs/images/onyx-workbench.png" alt="Onyx workbench: Onyx Dark theme, local agent chat, control plane" width="900" />
</p>

Onyx is a fork of [Code - OSS](https://github.com/microsoft/vscode) whose
**entire agent architecture is designed around local inference**. Think
Cursor — except inference happens on your hardware through any
OpenAI-compatible runtime (Ollama, LM Studio, llama.cpp, vLLM), a 7B model
gets a different harness than a 70B model, and a visual control plane shows
exactly what the agent is doing and why.

## Why Onyx is different

- **Local-first is architectural, not a provider option.** One
  OpenAI-compatible client covers every runtime; discovery finds your
  models automatically and nothing you type leaves the machine.
- **The harness adapts to the model.** Prompt style, tool count,
  temperature, and context budget derive from a per-model capability
  profile — seeded from model metadata, sharpened by measurements taken on
  *your* hardware and by which answers *you* keep.
- **Auto routing that actually learns.** Quick edits go to fast small
  models, implementation and debugging to your strongest tool-callers,
  based on measured tok/s, tool-call reliability, and accept rates.
- **Everything is observable.** The Onyx Control Plane (`⌘⌃O`) streams
  every routing decision, model turn, and tool call live — with pause,
  stop, and redirect — plus a token-exact context budget, compute costs
  (tok/s, TTFT), and an inspector that replays any past run down to the
  exact wire prompt.
- **Repo intelligence, no cloud index.** A symbol-aware retrieval tool
  built on the editor's own language services (with call-graph expansion),
  context ranking from open editors + git recency, and persistent
  per-workspace agent memory.
- **Trust, but verify.** After the agent edits code, Onyx diffs workspace
  problems against the pre-run baseline and can run your project's own
  build/test task, posting the verdict to the timeline.
- **Local autocomplete.** Ghost text from your smallest, fastest model via
  fill-in-the-middle, with cross-file context and latency-aware model
  selection.

## Getting started

```bash
# Requires Node 24 and a local model runtime (e.g. `brew install ollama`)
git clone https://github.com/sheehanlloyd/cursor2.0.git onyx && cd onyx
npm i
npm run compile
./scripts/code.sh
```

Start Ollama (or LM Studio / llama.cpp / vLLM), open chat, and pick
**Auto** — or any discovered model — in the model picker. The **Get Started
with Onyx** walkthrough on the Welcome page tours the rest.

Building a distributable, signed macOS app: see [LAUNCH.md](./LAUNCH.md).

## Architecture

The product plan, full architecture, and status live in
[ONYX.md](./ONYX.md). The fork stays cleanly rebaseable on upstream VS
Code: all Onyx code is additive (new directories, a built-in theme
extension), and the handful of one-line upstream touch points are
documented in [REBASE.md](./REBASE.md).

## License

MIT, like the [Code - OSS](https://github.com/microsoft/vscode) project it
builds on. Copyright (c) Microsoft Corporation and Onyx contributors.
