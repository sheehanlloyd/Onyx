# Support: what the alpha promises, and what the current build does

Two different things live in this file, and they are kept apart on purpose:

- **Target alpha contract.** What `v0.1.0-alpha.1` must provide. It is the promise the README and
  the release gates (ActionPlan §12) are measured against.
- **Observed baseline inventory.** What the packaged build actually exposes today, recorded by
  `test/onyx/run-packaged-smoke.mts --mode baseline` against a real `.app`. Where the two differ,
  the gap is named with the item that closes it. A gap is never reported as passed.

## Supported matrix (target)

| Dimension | Supported in the alpha | Best effort, documented as untested |
|---|---|---|
| OS and hardware | macOS 14 or later, Apple silicon, 16 GB or more | Intel Macs, 8 GB |
| Runtime | Ollama 0.33.0 | LM Studio, llama.cpp server, vLLM, any other OpenAI-compatible server |
| Models | `qwen2.5-coder:7b` for the agent and `qwen2.5-coder:1.5b` for autocomplete, at the digests below | Everything else in the catalog |
| Workflow | Read → propose → review in a diff editor → accept or reject per hunk → verify; inline edit; commit message; review; measure models for this repository | Tournament, architecture map, speculative measurement, idle review, constrained anchors (opt-in, by L14's decision) |
| Extensions | A named set installed from Open VSX and smoke-tested (D1) | Anything else on Open VSX |

Pinned runtime: Ollama 0.33.0. Pinned model digests, as the runtime reports them
(`docs/research/results/2026-11-22-datasheets/`):

| Model | Digest |
|---|---|
| `qwen2.5-coder:7b` | `dae161e27b0e90dd1856c8bb3209201fd6736d8eb66298e75ed87571486f4364` |
| `qwen2.5-coder:1.5b` | `d7372fd828518a4d38b1eb196c673c31a85f2ed302b3d1e406c4c2d1b64a0668` |

"Supported" means tested, not recommended without reservation. Module 4 measured both pinned
models on real tasks of this repository under the product's own configuration: neither proposed
an edit in 320 agent runs (`docs/progress/L13.md`). The harness around them is what the alpha's
tests cover. Whether the product should keep recommending these two models for agent work is an
open question for the owner (`docs/progress/STATE.md`).

## Extensions from Open VSX (D1)

The gallery is open-vsx.org. The supported set, installed through the packaged application and
activated on 2026-11-22 (`node test/onyx/run-extension-smoke.mts`, R-32; result in
`docs/progress/extension-smoke.json`, screenshot `docs/images/onyx-extensions.png`):

| Extension | Open VSX id | Version served that day | Installed | Activated |
|---|---|---|---|---|
| Python | `ms-python.python` | 2026.10.0 | yes | yes |
| ESLint | `dbaeumer.vscode-eslint` | 3.0.34 | yes | yes |
| Prettier | `esbenp.prettier-vscode` | 12.4.0 | yes | yes |
| GitLens | `eamodio.gitlens` | 19.6.1 | yes | yes |

Python brings two dependencies with it, `ms-python.debugpy` 2026.6.0 and
`ms-python.vscode-python-envs` 1.44.0. Versions are whatever the gallery serves; nothing is pinned.

Failure recorded: the first attempt failed for all four with "Signature verification was not
executed". Upstream verifies an extension's signature with a module that is licensed for
Microsoft's products and is not in this build. **Onyx therefore does not verify extension
signatures**: `extensions.verifySignature` is off by default and cannot usefully be turned on.
A package is fetched over HTTPS from open-vsx.org and nothing else about it is checked. Install
extensions you would install anyway.

What the gallery is asked, and when: when you open the Extensions view, search, or install. Not
at startup and not on a timer: `extensions.autoCheckUpdates`, `extensions.autoUpdate` and
recommendations are off by default (`docs/progress/production-readiness.md` has the capture). There
is no malicious-extension blocklist: the gallery entry has no control URL, because the only
published one is served from a third host and would be fetched in the background.

Activation only was checked. Whether each extension's features work (a Python debug session, an
ESLint fix, a Prettier format, GitLens blame) was not tested.

## Target alpha contract: tools

The agent's tool set in a supported edit-capable run (B1, B3, DEC-03):

| Slot policy | Rule |
|---|---|
| Essential tools | `readFile`, `listDirectory`, `findFiles`, `grep`, `editFile`, `terminal`. Reserved first; if any is unavailable, an edit-capable run refuses with the missing capability named rather than running with a truncated set |
| Slot cap | The supported 7B profile keeps **eight** slots in total |
| Optional tools | `repoSymbols`, `docs`, `remember`, `playbook`, in that deterministic order, filling the spare slots: on the eight-slot profile, `repoSymbols` then `docs`. A tool the user asks for by name takes the last spare slot in place of a default: the word "playbook" or the name of one of the repository's playbooks, "remember", "docs" or "documentation" (`requestedOptionalTools` in `common/onyxToolSlots.ts`). Nothing is inferred beyond those words |
| Profiles below six slots | Read-only: `readFile`, `grep`, `findFiles`, `listDirectory`, in that order, as many as fit. No `editFile`, no `terminal`; the run says so in the chat and on the timeline. Agent editing is unsupported on such a profile |
| Capability classes | Every exposed tool is classified read / write / execute / network / persist in a reviewed table keyed by tool id (`common/onyxToolContract.ts`, B3). Writes go through Onyx Changes; every shell invocation needs the Onyx approval dialog (B2); a tool that is not in the table is excluded; the network opt-in never bypasses staging, approval or the slot budget |
| Persistent state | A note the model asks to remember is stored only after the user confirms a dialog that shows the note and where its text came from (I-14, R-59). Pins and playbooks have no model-facing writer |

## Tool capability contract (B3, DEC-03)

`Onyx: Show Agent Tools` lists, for the running build and the current settings, every registered tool the
contract admits with its capabilities and gates, and every one it refuses with the reason. The table below is
contract version 1. The module gate checks the packaged build against it (R-05).

**Default inventory.** These can reach a model with default settings; which of them a request carries is the
slot policy above (on the supported eight-slot profile: the six essential tools, `repoSymbols` and `docs`).

| Tool | Can | Gate |
|---|---|---|
| `readFile`, `listDirectory`, `findFiles`, `grep` | read | none needed: contained to the workspace roots |
| `editFile` | write | Onyx Changes: every edit is staged and nothing changes until the user accepts it |
| `terminal` | execute | the Onyx approval dialog, every invocation, Run Once or Deny |
| `repoSymbols`, `docs`, `playbook`, `debugState` | read | none needed. `docs` searches an offline mirror; `playbook` returns repository-authored text that grants nothing |
| `remember` | persist | a confirmation that shows the note and the origin of its text |
| `usages`, `testFailure` (core) | read | none needed: language-service references and the user's last test results |

**Supported opt-in: network tools** (`onyx.agent.networkTools`, off by default, user scope only, so a
repository's settings file cannot turn it on). It admits three reviewed tools and nothing else, leaves the slot
budget unchanged (on eight slots a network tool is offered only when the user names the browser, a web page or
a URL), and changes no other gate.

| Tool | Can | Gate |
|---|---|---|
| `openBrowserPage` | network | the Onyx approval dialog for each call, showing the tool and the URL |
| `vscode_fetchWebPage_internal` | network | the Onyx approval dialog for each call |
| `readPage` | read | none needed: reads a page the agent opened with approval |

**Excluded, whatever the settings.** A tool that cannot meet the gate for something it can do stays out.

| Tools | Why |
|---|---|
| `runInTerminal`, `sendToTerminal`, `killTerminal`, `runTask`, `createAndRunTask`, `runTests` | execute without the Onyx approval dialog |
| `rename`, core's own `editFile` | write without staging in Onyx Changes |
| `runSubagent`, `installExtensions`, `runPlaywrightCode` | start another agent, install code, or run arbitrary script |
| `navigatePage`, `clickElement`, `dragElement`, `hoverElement`, `typeInPage`, `handleDialog`, `extensions` | act on a web page or query a marketplace with no Onyx gate per action |
| `getTerminalOutput`, `terminalSelection`, `terminalLastCommand`, `getTaskOutput` | read terminal or task output, which is outside the workspace files and may hold secrets |
| `screenshotPage`, `list_browser_pages`, `todo`, `askQuestions`, `reviewPlan`, the confirmation tools, `task_complete`, `inline_chat_exit`, the artifact tools | not part of the supported workflow |
| Any tool not in the table: an extension's, a new core tool | unknown tools are excluded, not guessed at |
| MCP tools | unavailable in the alpha. An MCP tool cannot be classified, and one that writes would bypass Onyx Changes (DEC-03: a tool that cannot satisfy the gates remains unavailable). There is no MCP opt-in |

**Upstream's Agent Host is excluded.** The Agent Host is upstream's utility process for the Copilot SDK
harness; with upstream's defaults it starts with every window, registers `agent-host-…` session types and
language-model vendors, and starts a closed-source runtime binary. Onyx registers upstream's own switch for
"no Agent Host runtime" (`browser/onyxAgentHost.ts`), so the process is never started, no agent-host session
type or model is registered, and the Agents window, a second workbench built around it, does not open
(`REBASE.md`). The evidence is checked on every packaged smoke and end-to-end run: no `agenthost.log` in the
profile after several agent runs, and asking for the Agents window opens no second workbench. The Agent Host's
code and the SDK's runtime binary are still inside the application bundle; nothing in Onyx starts them.
Removing them from the bundle is a packaging change left to D8's dependency review.

## Shell approval (B2)

Every shell invocation asks. The dialog shows the command exactly as it will be dispatched, its working
directory and its timeout, says so when the command contains line breaks, tabs or repeated spaces, and
offers **Run Once** or **Deny**. An answer covers that one invocation.

| Question | Answer in the alpha |
|---|---|
| Session or persistent grants | None. The earlier "Run for This Session" and "Always Run This Command" choices are removed |
| `terminalAllowlist` in `.onyx/config.json` | Read as `recommendedCommands`: repository-authored suggestions, shown by `Onyx: Show Effective Project Configuration`. It grants nothing and is never migrated to consent. `Onyx: Clear Legacy Terminal Grants` removes the key from the file and keeps the rest |
| Workspace Trust | Changes nothing about approval (R-02) |
| A check task (`onyx.verification.task`, or `verificationTask` in `.onyx/config.json`) | Asks before each run, naming the task and who configured it. The dialog cannot show the commands a task runs and says so |
| Past decisions | Kept in machine-local workspace storage, at most 200, shown by `Onyx: Show Terminal Approval History`. A record, never a permission. Nothing about approval is written to a tracked file |

## What streams, and what is held back (C5)

A model that does not use the tool channel writes its tool call as text, and Onyx recognises it and runs it
instead of showing JSON. To do that it has to hold a reply back while the reply can still be a call. It
holds back only this:

| The reply opens with | What happens |
|---|---|
| a tool-call wrapper (`<tool_call>`, `<\|tool_call\|>`, `[TOOL_CALLS]`) | withheld to its end, then run |
| a JSON object whose first key names a tool on offer (`"tool"`, `"name"`, …), or is `"function"`, `"arguments"`, `"parameters"` | withheld to its end, then run. Up to 32,000 characters, which is more than one reply can be |
| a fence marked `json`, or not marked, with such an object inside | the same |
| a fence in any other language (` ```ts `, ` ```python `) | shown at once, from the first line |
| JSON that is not a call (`{"name":"my-package", …}`, `{"answer": 42}`, an array) | shown as soon as that is clear, usually within the first key |
| anything nothing has decided | shown after 400 characters |

In a constrained turn (a model whose tool calls are forced into a JSON envelope) the answer is inside the
envelope. It is read out and shown as it arrives, escapes decoded (C6); a tool action shows nothing until it
runs. An answer whose envelope turns out not to match is shown once, not twice.

## Reasoning models (C4)

A model that thinks before it answers sends its thinking in the text, inside `<think>…</think>` (or
`<thinking>…</thinking>`), or in a field of its own (`reasoning` on Ollama's OpenAI-compatible endpoint,
`reasoning_content` on LM Studio, llama.cpp and vLLM). Onyx handles both:

- The thinking is taken out before the reply reaches anything that reads it: the tool-call repair, the
  constrained envelope, edit blocks, review findings. A tool call or an edit written inside the thinking is
  a thought, not a call.
- It is shown as a "Model reasoning" note on the run's timeline, at most 4,000 characters (its start and its
  end), and is not sent back to the model in later turns.
- A reply whose thinking was opened and never closed has no answer. The run ends as failed, the chat says the
  reply ended while the model was still thinking, and nothing from it is run or staged. A reasoning model
  can spend its whole output allowance (see the context section below) on thinking; that is how this
  happens.

| Model | State |
|---|---|
| any reasoning model | **Handled, not validated against a model.** R-26 runs on transcripts constructed from the stream shapes Ollama and LM Studio document (`src/vs/platform/onyxRuntime/test/common/onyxReasoningTranscripts.ts`). No reasoning model was installed where this was developed, so none was recorded live and none is listed as supported |
| `qwen2.5-coder:7b`, `qwen2.5-coder:1.5b` (the pinned models) | not reasoning models; unaffected |

## Where inference happens (B14, DEC-04)

| | Read from | Values |
|---|---|---|
| Transport | the endpoint's address | loopback (this machine); LAN (private and link-local ranges, `100.64.0.0/10`, names without a dot or under `.local`, `.lan`, `.internal`, `.home.arpa`); remote (everything else, and an address that cannot be read) |
| Execution | what the runtime reports | local (the runtime identified itself and reports the model as one it runs); cloud (Ollama reports `remote_host` or `remote_model`, or the name ends in `-cloud` or `:cloud`); unknown (the server did not identify itself) |

| Setting (user scope) | Default | Effect |
|---|---|---|
| `onyx.inference.strictLocal` | on | cloud and unknown execution are refused; a remote address is refused |
| `onyx.inference.allowLan` | off | a LAN address is refused until this is on. Turning strict-local off does not grant it |

A refused model is not in the list any chooser draws from (Auto routing, autocomplete, benchmarks, review),
is not warmed up, and a request that names it fails with the reason. It stays in the picker with a label
("cloud-backed · not used") and a tooltip that gives the reason and both facts. Configured endpoints are
still probed for their model list, which is how they can be shown at all; that probe carries no prompt.
`Onyx: Show Where Inference Happens` opens the full list.

Runtimes are identified by what they answer, not by their port: Ollama by `/api/tags`, LM Studio by
`/api/v0/models`, llama.cpp and vLLM by `owned_by` in `/v1/models`. A server on a well-known port that
answers none of these is shown under that runtime's name and its execution is unknown.

No string in the product says a model is verified to be local.

## Context: what a request is fitted into (B13)

**Three numbers, and the smallest one wins.** For each model Onyx keeps what the architecture allows (as the
runtime reports it), what the server is configured to allocate when it says so (Ollama's `num_ctx` in the
model's parameters, LM Studio's loaded context length), and what was observed to fit (learned from an
overflow error; L5's datasheet measures it). The context a request is budgeted against is the smallest of
those that are known, 8,192 tokens when none is. `models.json` in a diagnostics bundle carries all three and
which one was used.

A runtime that allocates less than the model's architecture and does not say so cannot be detected from its
metadata. Ollama serves a model at its default context unless told otherwise, and cuts a longer prompt
without an error. Until the datasheet has measured the model, Onyx budgets against the architectural number
in that case, and the oldest part of a long prompt may be lost at the runtime.
Once the model is loaded an Ollama server says what it allocated, and that number is used from the next
discovery on. Asking the runtime for a larger context is the next section.

**Every request is planned before it is sent.**

| Set aside first | How much |
|---|---|
| Unused share, to absorb the estimate's error | 15% of the context |
| The reply (`max_tokens` on the wire) | 15% of the context, at least 256 tokens, at most 4,096 |
| Tool schemas, as serialized | whatever they come to: about 1,100 tokens for the eight-tool set |

The messages have to fit in what is left. When they do not, things are dropped whole, in this order: tool
calls with their results, oldest first, keeping the newest; earlier conversation turns, oldest first; the
retrieved workspace context; then the newest tool result is cut further. Each drop is a note on the run's
timeline ("Evicted 2 earlier tool results to fit the context window"). If the instructions, the request and
the schemas still do not fit, nothing is sent and the chat says so with the numbers.

**Tokens are estimated**, at four characters each, not counted by the model's tokenizer. The Context Budget
view is labelled "estimated".

**When the runtime rejects a prompt as too long**, the size of the rejected request becomes the model's
observed context, earlier results are dropped to fit it, and the turn is sent once more. A second rejection
ends the run with the runtime's message. The observed number is kept for the model on this machine and only
ever gets smaller until the model is measured.

**Smallest workable context.** The eight-tool agent's instructions and schemas are about 1,400 estimated
tokens. A 2,048-token context cannot hold them with room for a reply and is refused; 4,096 works, with one
tool result in view at a time. The supported profile is 8,192 or more.

## Context allocation: asking for what the model can use (B15)

A default Ollama install gives each of the supported models a context of 4,096 tokens, whatever the
model was trained with (32,768 for both), and cuts a longer prompt without an error. Onyx can ask for more.
It does so only when you run **Onyx: Request a Larger Model Context**, only after you agree to what that
creates, and it uses the result only after a check has seen it work.

**How a context can be asked of Ollama 0.33.0** (measured on the reference machine with
`test/onyx/lab/probe-context-mechanisms.mts`; `mechanisms.json` in the results directory below):

| Way | Request | Asked | `/api/ps` reports afterwards | Honoured |
|---|---|---|---|---|
| Nothing asked | `POST /v1/chat/completions` | nothing | 4,096 | yes |
| Per-request option, OpenAI-style endpoint | `POST /v1/chat/completions with options.num_ctx` | 8,192 | 4,096 | no |
| Per-request top-level field, OpenAI-style endpoint | `POST /v1/chat/completions with num_ctx` | 8,192 | 4,096 | no |
| Per-request option, native endpoint | `POST /api/chat with options.num_ctx` | 8,192 | 8,192 | yes |
| Load-time context, then an OpenAI-style request | `POST /api/chat with options.num_ctx, then POST /v1/chat/completions` | 8,192 | 4,096 | no |
| Derived model | `POST /api/create {from, parameters: {num_ctx}}, then POST /v1/chat/completions to the new name` | 8,192 | 8,192 | yes |
| Server setting | `a server started with OLLAMA_CONTEXT_LENGTH=8192, then POST /v1/chat/completions` | 8,192 | 8,192 | yes |

Onyx speaks the OpenAI-style endpoint, which ignores a context sent with a request and reloads the model at
the server's own allocation even when it had been loaded with more. Two ways remain that such a request then
gets: a server setting, which is yours to change and applies to every model, and a derived model. Onyx uses
the derived model. The native endpoint's per-request option also works; it is another wire protocol, whose
tool calls, schemas and stream endings L5 did not measure, and any request on the OpenAI-style endpoint
(autocomplete, another tool) would reload the model at the old context. LM Studio was not probed: it was not
running, and starting it was outside what this work was authorised to do. Onyx reads the loaded context
LM Studio reports and asks it for nothing; set the context length in LM Studio's own load settings.

**What is created, and how to undo it.** A model alias: a second model name over the same weights, with
`num_ctx` in its parameters, named `<model>-onyx-ctx<tokens>` (for example `qwen2.5-coder:7b-onyx-ctx16384`). It adds
a parameters layer of a few bytes and no second copy of the weights; it appears in `ollama list`. Undo with
**Onyx: Remove Model Context Alias**, or `ollama rm qwen2.5-coder:7b-onyx-ctx16384`. Onyx removes only names of that form, and
never a model you made.

**The number asked for** is the smallest of three, rounded down to a multiple of 1,024:

| Bound | Value |
|---|---|
| What the model was trained with | as the runtime reports it; never exceeded, and nothing is asked when it is unknown |
| A ceiling from this machine's memory | (half the machine's memory − the size of the model's files) ÷ 96 KiB a token |
| The setting `onyx.context.requestTokens` | 16,384 by default; `0` keeps the server's allocation and asks for nothing |

The memory cost of a token was measured between 4,096 and 16,384 tokens at 69 KiB for the 7B model and
35 KiB for the 1.5B; 96 KiB is the larger rounded up by a third. Half the memory is left for the editor, the
system and everything else. On the reference machine (24 GiB) the ceiling is 83,433 tokens for the 7B
model, so the setting decides. To change the context, change the setting and run the command again.

**Requested, reported, verified.** After the alias is created Onyx sends three prompts with a code at the
start and a question about it at the end: one inside the old allocation, one aimed at nine tenths of the new
allocation in the runtime's own tokens, and one a quarter longer than the new allocation. The context
is **verified** when the code comes back from the first two; the third shows the cut. The budget (B13) uses
the verified number and no other. When the runtime does not raise the context, or reports a context and
loses the start of a prompt inside it, the alias is removed again, the server's own allocation stays in
force, and the configuration view says the request was not honoured. If you decline, nothing is created.
**Onyx: Show Effective Project Configuration** shows each model's budgeted context and where the number
came from; a request that does not fit names both and the command. Every run's trace header, every
datasheet and every experiment manifest carries the three numbers, or an explicit null.

**Measured on the reference machine** (M4 Pro, 24 GiB, Ollama 0.33.0;
`docs/research/results/2026-11-21-context-allocation/`, regenerated by the command in its manifest):

| | 7B at the server's 4,096 | 7B at 16,384 | 1.5B at the server's 4,096 | 1.5B at 16,384 |
|---|---|---|---|---|
| Loaded, as the runtime reports | 4,521 MiB | 5,346 MiB | 1,109 MiB | 1,532 MiB |
| Runtime resident memory, idle | 4,731 MiB | 5,498 MiB | 1,188 MiB | 1,540 MiB |
| Runtime resident memory, peak in a run | 4,736 MiB | 5,499 MiB | 1,188 MiB | 1,541 MiB |
| First token, cold | 2,725 ms | 1,206 ms | 1,112 ms | 594 ms |
| First token, warm | 149 ms | 148 ms | 40 ms | 40 ms |
| Tokens a second | 50 | 49 | 167 | 167 |

Verification, 7B: control: 1,776 tokens by the runtime's count, code recalled; inside: 14,466 tokens by the runtime's count, code recalled; past: 8,194 tokens by the runtime's count, code lost. 1.5B: control: 1,776 tokens by the runtime's count, code recalled; inside: 14,466 tokens by the runtime's count, code recalled; past: 8,194 tokens by the runtime's count, code lost.

The inside prompt came to 88% of the allocation: the aim is set from how the runtime counted the short
prompt, and the count is not exactly proportional. A prompt the runtime cuts is counted at what it kept,
which is why the longest one shows 8,194.

**What it buys.** With the eight-tool set's schemas and instructions set aside, one whole tool result
(4,000 characters) fits in a turn at 4,096 tokens, and nine at 16,384 (the `metric` test in
`onyxContextAllocation.test.ts` computes both with the product's planner).

**Limits.** Verified means recall at about nine tenths of the allocation and loss a quarter past it, with one
prompt each; it is not a measurement of every size, and it says nothing about how well a model uses a long
context. A model too small to recall the code from a short prompt cannot be verified, and stays on the
server's allocation. The alias is another name to the runtime: a datasheet measured under the model's own
name does not describe it, so measure again after requesting a context. Speculative-decoding measurement
still addresses the model's own name.

## Stopping a run (B10)

**Stop means stop.** A run owns one cancellation. The Stop button on the run list, the chat's own stop and
closing the request all cancel it, and everything the run started takes it: the model request in flight,
every tool, an approval dialog that is open, a command that is running (which is killed). After Stop no
further tool is called, no command is started and nothing more is staged, including the tool call a reply
was about to make and a command whose approval you answer afterwards.

| A run ends as | When | Shown as |
|---|---|---|
| `completed` | The model finished | Completed |
| `failed` | The request or the runtime failed, or the reply was cut off | Failed |
| `cancelled` | You stopped it | Stopped |
| `budget-exhausted` | It reached its turn limit, or stayed paused for ten minutes | Ended at its turn or time limit, unfinished |

The first of these a run reaches is its status. Nothing replaces it, and its journal holds one outcome.
Commit messages, reviews, name suggestions, the repository benchmark, tournaments and inline edits are runs
too, and Stop on the run list cancels their model request the same way.

Two limits. An approval dialog that is open when you press Stop stays on screen until you answer it; the
answer is ignored and nothing runs. And a one-shot flow stopped from the run list may still show its own
"failed" notice, because it learns of the stop as a failed request; the run itself is recorded as stopped.

## Proposals: identity, conflicts and size (B6, B7)

**An edit is placed exactly or not at all.** A SEARCH text has to be in the file exactly as quoted, and at
exactly one place. Nothing is trimmed or re-indented and no line is matched on its own; a quote with another
indentation, other line endings or a second occurrence is refused, the file is untouched, and the model is
told which line did not match or how many places there were. A quote may begin in the middle of a line; a
block of several lines may not begin inside a line's indentation.

**Several edits in one call are one proposal or none (C3).** `editFile` takes one edit as `path`, `search`,
`replace`, or up to 50 for the same file as `path` and `edits: [{search, replace}, ...]`; never both shapes
in one call. The edits are placed in order, each exactly and exactly once in the text the earlier ones left.
If any one cannot be placed, nothing of the call is staged and the model is told which edit it was and why.
Line numbers copied from `readFile` are taken off each edit's quote as for a single edit, and they refer to
the file as it was read.

**What you review is what is applied.** Every staging of a file is a *generation*, and each of its hunks
has an id that does not change while that generation lasts. Accepting a hunk names it by that id.

| What happened since you looked | What accepting does |
|---|---|
| Nothing | Applies that hunk; the others stay staged under their own ids |
| You edited the file elsewhere | The hunk is found again by its own lines and up to three unchanged lines on each side, exactly and at one place, and applied there |
| You edited the hunk's own lines or its context, or the same lines are now in the file twice | Nothing is applied. The hunk is shown as a conflict with both texts, and the message is "The review of <file> changed; look again." No other hunk is applied in its place |
| The agent staged the file again | Nothing is applied: the ids you saw belong to the earlier generation |
| Accept the whole file while a conflict is on show | Nothing is applied until the conflict is dismissed |

A proposal for a file that is not open is computed against its content on disk and treated the same way.
Staged proposals survive a restart as a new generation and are checked against the files as they are then.

**Review in a diff editor (C1).** "Open the file" on a staged file in Onyx Changes opens a diff: your file
as it is on the left, the proposal on the right. The proposal is a document of its own
(`onyx-proposal:`), not your file, and no editor can write to it; opening the diff changes nothing. Put the
caret on a changed line of the proposal and run **Onyx: Accept Hunk at Cursor** or **Onyx: Reject Hunk at
Cursor**; a caret on an unchanged line accepts nothing. Each hunk also carries Accept and Reject code lenses,
which appear when `diffEditor.codeLens` is on (the editor's default is off, and Onyx does not change it).
Both name the hunk by the same id the side bar uses, so the rules in the table above apply unchanged. A
proposed new file has nothing to compare with and opens as the proposal alone. During an inline review `⌥D`
opens the same diff.

**Inline edits (`⌘I`) are proposals too (B9).** The model's reply is staged in Onyx Changes and shown under
the lines it would replace, in a read-only zone that is not part of the file. Until a hunk is kept the file,
whether it is unsaved, and what a save or an autosave writes are yours alone. `⌘⏎` keeps the current hunk
as one undoable edit; `⌘⌫` rejects it; `esc` discards what is left. If you type, switch files, close the
file or a formatter changes it while the model is working, nothing is staged and you are asked to try
again; a save that changes nothing does not count. A proposal you have not decided on is still in Onyx
Changes after a reload. Three limits: the file has to be in the workspace; a file that already has changes
waiting is not given a second proposal; and the size bound below applies.

**Size.** A proposal over either of these is refused before it is diffed, with the numbers, and whatever was
already staged for the file stays: 20,000 lines on either side; 1 MiB for the file and the proposed content
together. (Until C9 the bounds were 1,000 lines, a million cells of a diff table and 256 KiB, because the
diff built a table of one cell for every pair of lines.)

**The diff (C9).** Hunks come from a shortest-edit-script search (Myers) over lines, after the lines the two
texts begin and end with are set aside. Its cost grows with the number of lines that differ, so that number
is bounded: up to 2,000 differing lines the hunks are the fewest changed lines possible; past that, the
whole changed region is one hunk. That is still a correct diff and accepting it still gives the proposal,
but it can no longer be accepted piece by piece. On the reference machine (Apple M4 Pro) two 6,000-line
texts with 60 scattered edits take 1.4 ms and about 5 MiB, and two with nothing in common take 9 ms and
about 25 MiB; the diff before C9 took 588 ms and 215 ms and over 300 MiB for the same. The method is in
`test/onyx/checks/r29-diff-performance.test.mts`. This is not a linear-time diff and no such claim is made.

## Edit certificates: what was checked for each hunk (L6)

When an edit is staged, Onyx has decided things on your behalf: that the text the model quoted is in the
file exactly once, and against which content. A certificate is the record of that, with one observation
added: whether the model had been sent the text it is editing in the turn it edited it.

| Under a hunk it says | When |
|---|---|
| Anchored exactly once · seen this turn | Every line the model quoted was in something it was sent this turn: a file it read, a search result, your message, the retrieved context |
| Anchored exactly once · not shown to the model this turn; read closely | At least one quoted line was in nothing it was sent this turn. Typically the file was read earlier and that result has since been dropped to fit the context window, so the model is quoting from memory |
| Anchored exactly once · what the model was shown is not on record | The edit did not come from an agent run |
| New file · nothing existing was replaced | The edit creates the file |
| From the lines you selected | An inline edit: you chose the lines |
| Whole-file proposal · no quoted text to place | A refactor's result |

**A certificate says what was checked. It does not say the edit is right.** "Not shown this turn" blocks
nothing: the edit was placed exactly, or it would have been refused. It is a reason to read that hunk more
carefully, because a quote that happens to match is weaker evidence than a quote of something just read.
The model's own earlier words do not count as having been shown the line.

A certificate holds: the path; how the edit was expressed; the turn and the tool call; a digest of the text
the edit was placed against and that text's version; a digest of the quoted text, its number of lines and
how many times it was found (one, for every edit that was staged); whether it was grounded; and which
message of the prompt delivered it. No text of the file or the prompt.

**In the journal.** Each certificate is written into the run's journal (`editCertificate`) with a seal, the
digest of what it says, and the ids of the hunks it accounts for. After an acceptance the journal also
records the digest of the file's content and where verification (C2) stands (`editCertificateOutcome`).
`checkCertificates` in `common/onyxEditCertificate.ts` recomputes each one from the journal alone: the seal,
the quoted text (from the call's arguments), where it came from and whether it was grounded (from the
prompt of that turn). A certificate changed after the fact fails the seal; one changed and sealed again
contradicts the prompt. Two things are not recomputable from a journal and are not claimed to be: the
digest of the base, and the match count, which need the file as it was. A journal keeps each prompt up to
a fixed size; for a longer prompt the check says "not recomputable" instead of guessing.

Limits. A line counts as shown when it appears in a message with surrounding white space ignored, so a
short line such as `}` is almost always "seen". A hunk is tied to an edit by the lines the edit took out or
put in; a hunk that no single edit accounts for shows no line. Certificates of a proposal are kept across a
reload; what the model was sent is not, so an edit staged after a reload by a new run is certified against
that run's prompt only.

## Constrained anchors: an experimental edit protocol (L7)

**Experimental. Off by default. Not in a packaged build's behaviour:** it is one value of the harness
configuration's `editProtocol`, which only a lab manifest in a development build can set (L4).

Search and replace asks the model to quote the text it wants to change, and refuses the edit when the quote
is not in the file exactly (B6). Constrained anchors ask for less: the first and the last line to replace.
In a constrained turn the schema the reply is decoded against lists the lines the model was shown this
turn, so a runtime that enforces the schema cannot produce an anchor that is not on the list.

| | |
|---|---|
| The shape | `{"action":"edit","edit":{"path","startAnchor","endAnchor","replace"}}` in the constrained envelope. The lines from `startAnchor` to `endAnchor` are replaced |
| What is on the list | The lines of every `readFile` result still in the prompt this turn, after eviction. A line by its text; a line that was shown more than once in its file by B1's numbered form (`12| text`); blank lines not at all |
| What the harness still checks | Everything. Each anchor has to be exactly one line of the file as it is now, and the first may not come after the last. A line that is not there, a line that is there more than once, reversed anchors and a numbered line whose text has changed are each refused with the reason, and nothing is staged. An anchor that is not on the turn's list never reaches the edit tool at all, whatever the runtime let through |
| Available when | The run decodes against a schema (`toolCallProtocol` is `constrained-envelope`) **and** the model's datasheet measured that the runtime enforces one (L5). Otherwise the run says "Constrained anchors are unavailable; edits use search and replace" and why |
| The bound | 400 lines and 24,000 characters on the list. When more than that was read, that turn has no list and its edits are search and replace; the run says so |
| Still there | `editFile` with `search` and `replace`, for new files, for files that were not read this turn, and for a file that already has staged changes (an anchored edit is placed against the file as it was read) |

**Not claimed: that the anchors are the right ones.** The list makes an invented line unrepresentable. It
does not stop the model choosing a real line that is the wrong one, and prior work on constrained copying
reports exactly that as the main error. L14 measures it. Until then this is a protocol to experiment with,
not one to rely on.

**What the list costs** (`docs/research/results/2026-11-21-anchor-enum/`, Ollama 0.33.0, one edit of one
line of a twenty-line file, three trials a size, the prompt the same at every size):

| Lines on the list | `qwen2.5-coder:7b`: first token, whole reply | `qwen2.5-coder:1.5b`: first token, whole reply |
|---|---|---|
| none (the envelope alone; the reply is a shorter tool call) | 24 ms, 0.72 s | 9 ms, 0.17 s |
| 50 | 24 ms, 0.97 s | 10 ms, 0.33 s |
| 100 | 24 ms, 1.00 s | 10 ms, 0.35 s |
| 200 | 24 ms, 1.05 s | 10 ms, 0.41 s |
| 400 (the bound) | 25 ms, 1.15 s | 11 ms, 0.52 s |
| 800 | 27 ms, 1.37 s | 13 ms, 0.72 s |
| 1,600 | 32 ms, 1.82 s | 17 ms, 1.11 s |

Building the grammar does not delay the first token measurably at any size tried. The cost is in the
reply: every token is checked against the list, and the same edit takes about a fifth longer at 400 lines
than at 50 on the 7B model, and nearly twice as long at 1,600. The bound of 400 is set there. In all 36
constrained edits both anchors were on the list and were the line asked for; that is one easy task, and
says nothing about harder ones. (The first trial at 50 lines shows 795 ms and 177 ms to the first token:
that is the changed system prompt being read for the first time, not the grammar.) The load average was 3
to 4 during the run.

Every anchored edit has a certificate (L6) that names the protocol, so a journal says which edits used it.

## Verification: of what you accepted, and only that (C2)

Onyx checks an edit when you accept it, not when the model proposes it. A staged proposal is not in the
file, so nothing a language service says about the file is about the proposal.

| It says | When | What it means |
|---|---|---|
| not applied | A file has staged changes and none was accepted | Nothing was checked. A run that staged edits ends with this line for each file |
| running | You accepted a hunk | Onyx is waiting for the file's diagnostics to be reported again |
| verified | Diagnostics were reported again, and none is a problem that was not there before the acceptance | No new error or warning in that file. Not that the change is correct |
| new problems | Diagnostics were reported again, and some were not there before | The line names how many, and the first with its line |
| timed out | No diagnostics were reported for the file within 15 seconds | Nothing is known about what you accepted |
| stale | The file changed after the acceptance | The result was for content that is no longer there |

Any of the last five ends with "Partial: N hunks are still staged and not part of this" while hunks of the
same proposal are still waiting.

**Problems are compared one by one, not counted.** Two diagnostics are the same problem when the file, the
reporter, the code, the severity and the message are the same. The line is not part of it: accepting an edit
moves what is below it. One error replaced by another is one new problem and one resolved, although the
count is unchanged. Errors and warnings are compared; hints and information are not.

**The project check reads the disk, so it runs on what you saved.** When the repository names a check task
(B2 asks you before it runs), it runs after an acceptance only if the accepted file is saved. If it is not,
Onyx says which file is unsaved and does not save it for you; the check runs when you save it. The result
records the file and a digest of the content it ran on. Onyx never saves another buffer to make a check
possible.

Agent edits, inline edits and refactors are all accepted through the change set, so all three are verified
this way. Limits:

- Only the accepted file's diagnostics are compared. A problem the change causes in another file is not
  reported here; the project check is what finds those.
- A language service that looks at the accepted content and reports exactly what it reported before sends
  no update. Onyx cannot tell that from silence, so a file with no language service, and a file whose
  problems did not change at all, both end as "timed out". It never says "verified" without a fresh report.
- The wait is 15 seconds, and a report is taken as complete after 0.75 seconds of quiet. A slower language
  service is reported as timed out.
- Results are not kept across a reload.

## Streams, tool arguments and the content index (B12)

**How a reply ended is said, not assumed.**

| Ending | What it means | What Onyx does |
|---|---|---|
| complete | the runtime sent a finish reason or `[DONE]` | the reply is used |
| truncated | the response body ended without either | the run ends as failed; the chat says the reply was cut off; nothing from that reply is parsed for a tool call, run or staged |
| stalled | nothing arrived for 10 minutes before the first byte, or for 3 minutes after it | the request is stopped; the run ends as failed; the chat says the model stopped responding |
| cancelled | the user stopped it | as before |
| failed | an HTTP error, or the connection was reset | the run ends as failed with the runtime's message |

The deadlines are enforced where the request is made (the shared process) and again in the window, fifteen
seconds later, in case the first cannot report. They are not settings in this release. Text that streamed
before a cut stays in the chat; the journal's turn record says `truncated` or `stalled`.

**Tool arguments are checked before the tool is called.** A call's arguments are validated against the schema
the tool was advertised with: `type`, `required`, `enum`, nested `properties`, `items`, and
`additionalProperties: false`. A call that does not match is answered with what is wrong (for example
`arguments.timeoutSeconds must be number, got string`) and does not reach the tool. Nothing is coerced:
`"30"` is not a number.

**The content index says where it came from.** The persisted BM25 index records its format, the root it was
built for, when, under which caps, whether the caps cut the walk short, and the modification time and size of
every file in it. On load, a file in another format or for another root is discarded and the index is
rebuilt. Otherwise the tree is walked with a stat per file, and files that changed, appeared or went away
since the index was written are read again or removed. `truncated` survives a restart. What the index covers,
its caps and what they cost are in the next section.

## The content index: what it covers (C7)

The content index ranks files by their words. It feeds the blended ranking of the `repoSymbols` tool and the
suggestions `grep` lists when nothing matches. For each workspace folder:

**What is left out.** Folders of generated or vendored code by name (`node_modules`, `out`, `dist`, `build`,
`target`, `vendor` and the like, and every hidden folder); files that are not source or text by extension;
files over 256 KB; whatever `files.exclude` and `search.exclude` leave out for the folder; whatever the
folder's root `.gitignore` leaves out. The same rules apply when a file changes later, so a change to a file
that is left out does not bring it in. Changing those settings or editing `.gitignore` makes a new index.

**What the exclusion rules do not do.** A setting that depends on a sibling file (`"when"`) is not applied, so
those files are indexed. A pattern that brings files back (`!pattern`, in the settings or in `.gitignore`) is
not applied, so those files stay out. Only the root `.gitignore` is read. A `.gitignore` pattern for folders
only also leaves out a file of that name.

**What is indexed first.** The folder is listed in full before anything is read, so a cap keeps a chosen part
of it and not whatever the walk met first. Source folders come first (`src`, `lib`, `app`, `packages` and the
like), the one nearest the root ahead of those inside nested projects; then everything else; tests,
documentation, examples and fixtures last.

**The caps and what they cost.** 20,000 files and 256 MB of text. `onyx.index.maxFiles` moves the file cap
between 500 and 100,000; it is a user setting, so a workspace cannot raise it. Measured on this repository on
2026-11-20 (Apple M4 Pro, 24 GB, Node 24.22.3), in a process of its own:

| Files indexed | Text read | Memory retained | On disk | Build | One search |
|---|---|---|---|---|---|
| 5,000 (the cap before C7) | 48 MB | 74 MB | 14 MB | 1.9 s | 13 ms |
| 12,000 | 128 MB | 185 MB | 35 MB | 4.6 s | 20 ms |
| 18,212 (every eligible file) | 216 MB | 284 MB | 53 MB | 7.7 s | 26 ms |

Memory is 1.3 to 1.6 times the text indexed, so the text cap bounds it at about 400 MB whatever the file cap
is. The memory is the shared process's. Before C7 the caps were 5,000 files and 64 MB, which held 27% of this
repository's eligible files, taken in walk order.

**Writing and reading it.** The index is stored one document to a line and written and read in batches, to a
file beside the real one that is then moved into place. Before C7 it was written in one piece, which held the
shared process (the process that also relays model output) for 0.65 s at 5,000 files and 3.5 s at 18,210, and
0.27 s and 1.4 s to read back. The longest hold is now 35 ms writing and 16 ms reading at 18,212 files. It is
written 5 seconds after a build and at most once a minute while files change; a file that is older than the
tree is brought up to date when it is loaded.

**What it says about itself.** How many files it holds, how many were eligible, and whether a cap cut it
short: in the log at startup, and in every result ranked from it when it does not hold everything, as a line
such as "The content index holds 5000 of 18210 eligible files (27%)". A file past the cap is counted as
eligible by its path alone, so that number can be high by the few files too large to index.

**Limits.** A file that becomes eligible while the index is at its cap waits until the next load, even when
it would rank ahead of one that is held. The text cap is applied when the index is built and reconciled, not
on each later change. Search is one pass over the held documents in the shared process (26 ms here).

## The harness configuration (L4)

How the agent loop talks to a model is a set of named switches, the harness configuration, and the loop
reads its decisions from nowhere else. A run's configuration and its hash are in the first record of its
trace, so two runs can be told to have been run the same way.

| Switch | What it decides | What the product runs | Other values (lab only) |
|---|---|---|---|
| `toolCallProtocol` | How a tool call is read | `constrained-envelope` when the model's tool calls are well-formed less than 75% of the time and its runtime enforces a JSON schema; otherwise `repaired-text` (the tool channel, and a call written as text is recognised and run) | `native`: the tool channel only |
| `editProtocol` | How an edit is proposed | `search-replace` | `constrained-anchors` (experimental; see "Constrained anchors") |
| `promptStyle` | How much the prompt carries | `compact` or `full`, from the model's profile | the other one |
| `toolResultChars` | The most of one tool result that goes back to the model | 4,000 with a compact prompt, 16,000 with a full one | 200 to 1,000,000 |
| `evictionPolicy` | What is dropped when a turn does not fit | `oldest-results-first` (B13) | none yet (L17) |
| `contextTokens` | The context a turn is fitted to | the smallest context known for the model (B13) | 512 to 4,000,000 |
| `turnCap` | The most model turns in a run | 8 with a compact prompt, 16 with a full one | 1 to 64 |
| `verificationFeedback` | Whether a run that staged edits ends by saying that nothing was verified yet ("not applied"); verification itself runs when a hunk is accepted, whatever this is set to | on | off |
| `readToolLineNumbering` | Whether `readFile` numbers its lines | on | off |
| `toolSlotPolicy` | Which tools are advertised when there are more than places | `essentials-first` (B1) | none yet |
| `maxTools` | How many places there are | from the model's profile | 1 to 64 |

**The default is what Onyx did before the switches existed.** 1,000 seeded simulation episodes and every
scripted scenario produce the same trace, event for event, as they did at the commit before
(`OnyxHarnessConfigRun`).

**Lab values come from a manifest, in a development build only.** Starting Onyx with `ONYX_LAB_MANIFEST`
set to a lab manifest (and optionally `ONYX_LAB_HARNESS` to the name of one of its harness configurations)
asks for that configuration. A build from source applies it over the default and says so on the run's
timeline. A packaged build refuses it whatever it asks for, runs the default configuration, and says so on
the timeline and in the trace; the packaged smoke starts the app that way and checks it. A request with an
unknown switch or a value out of range is refused everywhere, whole. There is no setting for any of this.

**What is not a switch.** Approval, staging, the workspace boundary and the tool contract are not
configurable. Code that is unsafe by design (the resurrected defects the simulation campaign uses) exists
only under test paths; the packaged smoke scans the built app for it and the gate scans the compiled product
folders.

**Limit.** With `readToolLineNumbering` off the tool's description still tells the model its lines are
numbered. An experiment that uses that switch has to account for it.

### Lab campaigns (L9)

A development build started with `ONYX_LAB_CAMPAIGN` set to a work order runs that order's units through the agent loop and writes down what each run did (`test/onyx/README.md`, "Lab campaigns"). A packaged build refuses, as it refuses a lab configuration: it logs that a campaign was requested and runs nothing. What a campaign changes about a run, and nothing else: the harness configuration and the seed and temperature, per unit, in place of what the profile would decide; and every execution the terminal service is asked for is denied without a dialog and counted, with `campaign-policy` as its source in the journal. A campaign accepts nothing: proposals are read and discarded, so no file of the worktree it runs on is changed. It checks out commits only in the worktree its work order names, and only when that is a linked worktree: never a repository's own working tree.

## Model datasheets (L5)

A model's profile used to be a guess from its size. A datasheet is what the model, on its runtime, was
measured to do. `Onyx: Measure This Model` runs a suite of 36 short requests against the model's own runtime
(about a minute), keeps the result on this machine, and shows it. Nothing is measured unless that command is
run, the prompts are fixed text that carries nothing of the user's, and nothing leaves the machine.

| Probe | What is sent | What counts as a success | Trials |
|---|---|---|---|
| Native tool calls | A question that needs the one tool offered | A valid call to that tool on the runtime's tool channel | 5 |
| Readable text calls | The same replies | Of those with no native call: the text repair reads a valid call out of the text | the rest |
| Schema enforced: object, enum, nested | A JSON schema, with a prompt that asks for something the schema does not allow | The reply matches the schema anyway | 3 each |
| Context | A code at the start of a prompt, a question about it at the end; the prompt doubles from 1,024 estimated tokens up to what the server says it allocated, then the gap is halved twice (since B15: doubling towards nine tenths of the server's allocation, one prompt there, one a quarter past it) | The code comes back | up to 7 |
| Output cap | A long count with a cap of 12 tokens | The reply stops at the cap and says that is why | 3 |
| Stop sequence | A count with a stop at "4" | The reply has 3 and not 4 | 3 |
| Reasoning | A sum to think through | Counted, not scored: thinking in tags, in a field of its own, or none | 3 |
| Same seed, same reply | One request twice with a seed, sampled at temperature 1 | The two replies are identical | 3 pairs |
| Log-probabilities | A request that asks for them | They come back | 3 |
| Speed | The first request (cold, when the model was not loaded), the short ones (warm), one 200-token reply | Timed, not scored | 1 |

Every result is successes over trials. The trials are few; a result is what happened in them and no more.

**What a profile takes from a datasheet.** Three things, each labelled `measured` or `default` in the model
library and in the command's report. Nothing else in the profile changes.

| Profile value | From the datasheet | Otherwise (default) |
|---|---|---|
| How often a native tool call is valid | native successes over trials, with three trials or more | a guess from the model's size |
| Whether the runtime enforces a schema | yes only if every trial of all three shapes matched, with three trials or more each | assumed from the runtime's kind |
| Context | the longest prompt whose start was recalled, when a longer one lost it; failing that, what the server said it had allocated when the model was measured. It only ever lowers the budget | the smallest of what the architecture allows, what the server says now and what an overflow taught (B13) |

Those feed the harness configuration (L4): a turn is constrained to the tool-or-answer envelope only when
native calls were not reliable and the schema was seen to hold.

**When a datasheet stops being used.** It is of one set of weights on one version of one runtime. When the
model's digest, the runtime or the runtime's version differs from what was measured, the datasheet is kept
but not used, the profile goes back to defaults, and the model library says why.

**What an Ollama server says about a loaded model.** `/api/ps` reports the context the server allocated when
it loaded the model. Onyx reads it: for a loaded model that number is the server context, ahead of the
model's own parameters. Checked against Ollama 0.33.0, which allocates 4,096 tokens for both pinned models
by default, whatever the 32,768 their architecture allows.

**The two pinned models, measured.** `docs/research/results/2026-11-21-datasheets/` holds the datasheets, the
manifest and every probe's request and reply. Ollama 0.33.0, Apple M4 Pro, 24 GB, on 2026-11-21:

| | `qwen2.5-coder:7b` | `qwen2.5-coder:1.5b` |
|---|---|---|
| Weights | `dae161e27b0e` | `d7372fd82851` |
| Native tool calls valid | 0 of 5 | 0 of 5 |
| Readable as text, of the rest | 5 of 5 | 3 of 5 |
| Schema enforced: object, enum, nested | 3 of 3, 3 of 3, 3 of 3 | 3 of 3, 3 of 3, 3 of 3 |
| Context | start of a 3,514-token prompt recalled; the server allocates 4,096 | the same |
| Context after B15 (re-measured at a requested 16,384) | 16,384 verified: recalled at 14,466 tokens, lost past the allocation | the same |
| Output cap honoured; stop honoured | 3 of 3; 3 of 3 | 3 of 3; 3 of 3 |
| Reasoning | none seen in 3 replies | none seen in 3 replies |
| Same seed, same reply | 3 of 3 | 3 of 3 |
| Log-probabilities returned | 3 of 3 | 3 of 3 |
| First token, cold and warm | 1,233 ms and 93 ms | 1,174 ms and 29 ms |
| Tokens a second | 48 | 159 |

What follows for the supported model: both advertise tool support and neither put one call on the tool
channel, so their turns are constrained to the envelope, which the runtime was seen to enforce; and their
context is budgeted at 4,096 tokens, not the 32,768 their architecture allows, until a larger one is
requested and verified ("Context allocation", above).

**Limits.**

- **Few trials.** The 1.5B model's text calls were readable 2 of 5 times in one run and 3 of 5 in the next.
- **The context probe of 2026-11-21's first datasheets stayed inside what the server said it allocated**, so
  it confirmed recall up to it and found no limit of its own. Since B15 the probe goes to nine tenths of the
  reported allocation and then a quarter past it (datasheet format 2; "Context allocation", above). Its sizes are estimates at four
  characters a token; the filler text is denser than that, so the largest prompt was 3,514 tokens, not 4,096.
- **A schema probe cannot tell enforcement from a model that complies anyway.** The prompts ask for what the
  schema forbids to make that unlikely, not impossible.
- **Speed is the machine's at that moment.** A first run with the battery nearly flat gave 15 tokens a second
  for the 7B model; it was discarded. "Cold" means the runtime had not loaded the model; the file may still
  have been in the operating system's cache.
- **Datasheets are not in the diagnostics export**, and reasoning models remain unvalidated against a real
  model (C4): neither pinned model reasons.

## The private benchmark: tasks from your history and your requests (L10)

A measurement of models on a repository uses that repository's own tasks. Nothing of a task leaves the machine: a task set is commit ids and content hashes, and what a model is shown is read from the repository when the measurement runs (DEC-10).

**Tasks from history, held out in time.** A commit is a task when it changed one source file by 3 to 80 lines and is not a merge, a revert or a mechanical commit. It counts as *held out* for a model only when it was authored after the day the model was published, with the whole of that day anywhere in the world taken as "not after": the model cannot have been trained on it. The catalog carries the publication day and the page that states it, for the models it dates:

| Model | Published | Source |
|---|---|---|
| `qwen2.5-coder:1.5b`, `qwen2.5-coder:7b` | 2024-09-19 | The Qwen2.5 announcement, which names both sizes: `https://qwenlm.github.io/blog/qwen2.5/` |
| `llama3.2:3b` | 2024-09-25 | The model card: `https://huggingface.co/meta-llama/Llama-3.2-3B-Instruct` |
| `gpt-oss:20b` | 2025-08-05 | The announcement: `https://openai.com/index/introducing-gpt-oss/` |

The pages were read on 2026-11-22. The Qwen announcement is dated 2024-09-19 and lists the 1.5B and 7B coder models; it does not say in so many words that their weights were released that day, and no page was found that dates the 14B and 32B sizes, so the catalog leaves those undated. For a model with no date, and for a model the catalog does not know, tasks are labelled **holdout unknown** and reported apart: such a result may be measuring what the model memorised. When several models are measured together, the latest of their days decides, and one undated model makes the whole set unknown.

**A model is not scored on a task it could not read.** A task's file is at most 12,000 characters before the change, and at most two fifths of the model's context at three characters a token.

**Tasks from your own requests** (`onyx.lab.requestTasks`, off by default, decided for one workspace at a time). A request becomes a task when you accepted its proposal and the lines you accepted were later committed. The instruction is what you typed, the base is the commit the workspace was at, and the reference is the file at the first commit that holds the accepted lines. An acceptance records digests of the lines it added, never the lines, so that the commit can be found later. Requests with nothing accepted, with a base commit that is no longer reachable, or whose accepted lines were never committed are skipped and counted. Without the opt-in the journal is not read for this.

**Counts before scores.** A result states how many tasks came from history and how many from requests, and how many are held out, not held out, or unknown. Below 10 scored tasks for a model it says there are not enough tasks to rank, and does not rank.

**Scoring, tier 1: nothing is run.** The preservation-aware score of C8 (`changed-line-f1-preserving/2`), with the lines a reply removed that the author kept counted on their own.

**Scoring, tier 2: your verification command, in a sandbox.** For a task whose commit also changed a test, the command you type is run on the file before the change and on the file a model proposed: the task is passed when it fails before and passes after. This executes code a model wrote, so all of the following hold or the tier is unavailable and scoring is tier 1:

- The command is the one you typed. A dialog shows it byte for byte with the most times it will be run, says that model-written code will be executed, and nothing runs unless you agree. Another command, or one run more, is refused.
- It runs inside the operating system's sandbox, in a disposable worktree: no network operation, and no write outside that worktree. Its temporary folder and home folder are pointed inside the worktree.
- The sandbox was probed first on this machine: a connection to a listener the probe opens on the loopback interface is made once from outside the sandbox, as the control, and must fail from inside; a write outside the stand-in worktree must fail and leave no file; a write inside must succeed.
- Only macOS has a sandbox Onyx uses (`sandbox-exec`, which Apple marks as deprecated and which is present on current macOS). On any other platform the oracle is unavailable, and a command that was to be sandboxed is never run without the sandbox.

The probe on the reference machine, macOS 26.5.1, 2026-11-22 (`node test/onyx/lab/probe-oracle.mts`):

```
platform: darwin 25.5.0
sandboxed-run: exit 0, observed true
network-outside-sandbox: exit 0, observed true, said "1 connection(s) reached the probe's listener"
network-inside-sandbox: exit 1, observed false
write-outside-worktree: exit 1, observed false, said "touch: <scratch>/outside/escaped: Operation not permitted"
write-inside-worktree: exit 0, observed true
sandbox: established
```

What the sandbox is not: it denies the network and writes outside the worktree. It does not hide your files from the command, and it does not limit processor time or memory beyond the command's timeout.

## Measuring models on your repository (L11)

**`Onyx: Measure Models for This Repository`** gives each model you pick this repository's own tasks (above), one request a task, and opens a scorecard. Before anything runs it says how many models and tasks there are and how long it expects to take, from each model's measured speed; a model that was never measured is named, not guessed. One model is loaded at a time: whatever the runtime holds is dropped before a model's first task and after the last. It can be stopped from its progress notification or with Stop in the run list; what finished is then shown as a **partial** scorecard, which lists what did not run and is not ranked.

**The scorecard** is Markdown, with an SVG and a JSON form written beside it when you choose to save it (`.onyx/scorecards/<time>/` in the workspace). It is not uploaded. It carries: the ranking, or why there is none; for each model the scored tasks, the tasks reproduced exactly, the mean score, the tasks it could not be served, and the lines it removed that the author kept; the task counts by source and by holdout; the repository's commit, the machine, the parameters, the estimate and the time taken; for each model the weights digest, the runtime and its version, the context, the publication day, and its datasheet as measured on this machine; every attempt with its reason; and everything that was planned and not run.

**Ranking.** Models are ordered only when the measurement ran whole, at least two models were measured, and every model was scored on at least 10 tasks. Otherwise the scorecard says which of these failed and gives no order.

**The router's picks.** The scorecard reports how often the router's pick was the model you picked in a tournament, and how often you kept what a routed run staged, each as a count out of a count. A routed run counts once it staged an edit, as "not kept" until you accept part of it. These are logged choices in this workspace on this machine. They are not a randomized comparison and say nothing about a model the router did not pick; the word "learns" is not used for them anywhere in the product's documents on the strength of these counts alone.

**`Onyx: Should I Switch Models?`** replays your own accepted requests in this workspace (the setting `onyx.lab.requestTasks` has to be on) against one model and reports how often it reproduced what you accepted, as counts. Below 10 replayable requests it says there are not enough to say. It says how often the model writes what you kept; it does not say that its other answers were wrong.

**Sharing.** `docs/scorecards/` in the repository collects scorecards people chose to submit by pull request. Onyx never sends one.

**What these commands do not do.** They do not run the agent loop: a task is one request with the file and the instruction, answered with edit blocks, so they measure a model's editing on your code, not its use of tools. They do not execute anything: scores are tier 1. They do not use a model you did not pick.

## Command execution and its limits (B5)

An approved command is started by one module, `src/vs/platform/onyxRuntime/node/onyxCommandRunner.ts`, and by
nothing else in Onyx (R-40).

| Question | Answer in the alpha |
|---|---|
| Shell | `/bin/sh -c` on macOS and Linux, in its own process group |
| Windows | Refused: the runner returns `unsupported-platform` and starts nothing. The tool tells the model so (DEC-02; Milestone M2 fills this in) |
| Working directory | The first workspace folder, or the directory inside the workspace that the call names as `cwd`. It goes through the same gate as the read tools: an absolute path, a `..` segment, a path that is not a directory and a symbolic link that leaves the workspace are refused before anyone is asked. The dialog shows the directory |
| Timeout | 60 s by default, 600 s at most, 1 s at least. The whole process group is killed |
| Killed when | the timeout passes; the user stops it (`Onyx: Kill Running Terminal Command`, or Stop on the run); the window closes or reloads; Onyx's runtime service is disposed or its process exits. A window that crashes does not announce itself: the timeout ends the command |
| Not reached by a kill | A process that left the group (`setsid`, a daemon). If such a process holds the output pipes open, the result is reported two seconds after the kill anyway |
| Output, per event | 8,192 characters at most |
| Output, streamed per command | 262,144 characters at most; the rest is counted, not sent |
| Output, in the result | 200,000 characters at most: the start and the end, with the number of characters left out |
| Output, held by the window while the command runs | less than one timeline note: 800 characters. The timeline shows the first 4,800 characters in six notes |
| Output, to the model and the journal | 12,000 characters: the start and the end, with the total stated when it was cut |
| Environment | Variables whose names match `/(TOKEN\|SECRET\|KEY\|PASSWORD\|CREDENTIAL)/i` are withheld. `onyx.terminal.passEnvironment` (user setting, default off) passes everything, and the approval prompt then says so. Defense in depth only; see `.github/SECURITY.md` |

## Diagnostics export (B11)

`Onyx: Export Diagnostics` writes one zip where the user says. Nothing is uploaded. Every entry is built from
an allowlist (`common/onyxDiagnostics.ts`); the bundle's own `README.txt` says which mode produced it.

| In the bundle | Default | With "Include prompt text, file contents, command text and output, paths and log messages" |
|---|---|---|
| Run journals: kinds, timings, turn numbers, digests, tool names, statuses, stream endings, sampling | kept | kept |
| Prompt messages | role, part type, tool name, size in characters | text, parameters and results |
| Activity labels and reasons, including command output | length | text |
| Approved command and its working directory | length | text |
| The model's reply | length | text |
| Accepted paths, activity locations, run titles | length | text |
| Runtime base URL | scheme, host and path | the same |
| Journal lines that are not events this version knows | left out, and counted in `README.txt` | the same |
| Profiles, models, machine, runtimes | every number and boolean; these string fields when they are names: `id`, `key`, `runtime`, `kind`, `family`, `quantization`, `digest`, `arch`, `platform`, `promptStyle`, `thermal`, `version`, `displayName`, `cpuModel`; `baseUrl` as scheme, host and path | the same |
| `onyx.*` settings | booleans, numbers, `onyx.routing.mode`, `onyx.energy.policy`, and each endpoint as base URL (scheme, host, path), model ids, context window and whether a key is still written in the setting. A string setting that is free text is listed by name only | the same |
| Logs (every `.log` under the session's log folder, 1 MB a file, 5 MB in all) | each line's timestamp and level, and the length of its message | the messages |
| Endpoint API keys | never, as a field or as a value anywhere in any entry | never |
| Credentials and query strings inside URLs, bearer tokens | never | never |

An endpoint's API key lives in the system's secret storage (`Onyx: Set Endpoint API Key`). `apiKey` inside
`onyx.endpoints` is deprecated: a key found there is moved to the secret storage and removed from the setting
when Onyx next reads its endpoints. A user with no configured endpoint never causes a read of the secret
storage.

What "kept" means for names: a tool name, a model id or a runtime name is exported as it is. That is a
decision, not an oversight; it is what makes a redacted bundle useful.

## Read-side tools and their limits (B1)

The agent reads the workspace with Onyx's own tools. They go through the workbench's file and search services;
nothing is spawned from Onyx code, and a development launch (`scripts/code.sh`) disables the Copilot extension
by default, so dev and packaged runs use the same four tools.

| Tool | What it returns | Limits and refusals |
|---|---|---|
| `readFile` | Lines numbered `12\| text`, from the live editor buffer when the file is open (unsaved edits included), from disk otherwise. `startLine`/`endLine` are 1-based and inclusive | Refuses a file over 1 MB, a binary file and a directory, and names the limit. 400 lines per call; a longer file says which `startLine` continues it. A line over 1,000 characters is cut with a marker |
| `listDirectory` | One level: `dir  name/` and `file  name  (size)` | 200 entries. An entry is listed when a file search finds it (a file) or finds something inside it (a directory), so `files.exclude`, `search.exclude` and ignore files apply as they do to search; symbolic links are left out; the count of what was left out is stated |
| `findFiles` | Workspace-relative paths matching a glob | 50 by default, 200 at most. The glob is matched against the search's results, so ignored files stay ignored |
| `grep` | `path:line: text` for a literal string or a regular expression | 60 lines in total, 8 per file, 240 characters per line. `include` narrows the files searched and, like "files to include" in the Search view, also reaches a file that an ignore file names. When nothing matches, up to five files from the content index are listed and labelled as suggestions, not matches |

Every read tool refuses an absolute path, a `..` segment, a backslash, and a path that resolves outside the
workspace folder through a symbolic link; searches do not follow symbolic links (R-30, I-07 on the read
side).

**The same rule on the write side (R-30, C10).** `editFile`, inline edits and refactors all stage through
Onyx Changes, and it refuses the same paths. It also asks where the file really is, twice: when a proposal is
staged and again right before it is applied. A file that is a symbolic link out of the workspace is not
edited, and a new file is not created inside a directory that is one; what decides for a file that does not
exist yet is the nearest directory above it that does. Before C10 the write side never asked.

**A file name that contains two dots is a name (C10).** `a..b.ts`, `notes/v1..v2.md` and `..config` are
read, searched, edited and created like any other. What is refused is a path *segment* that is `..`, and
with it a segment made only of dots and spaces (`...`, `.. `), which some file systems read as the parent
directory or as nothing.

An edit's SEARCH text that was copied with the `12| ` prefixes is decoded only when every line carries the
prefix, the numbers run consecutively and each line equals that line of the file character for character; the
exact text is tried first and source that merely looks numbered is never stripped (R-24). Anything else that
looks like a numbered read is refused with the reason.

## Observed inventory

Recorded by `node test/onyx/run-packaged-smoke.mts --app ../VSCode-darwin-arm64/Onyx.app --mode release`
against the packaged build. Since B3 release mode is a required check in the Module 1 gate and in
`.github/workflows/onyx-packaged.yml`; `docs/progress/packaged-smoke-release.json` holds the latest gate run.

| Field | Observed since B3 |
|---|---|
| Tools advertised on the supported 7B profile (8) | `readFile`, `listDirectory`, `findFiles`, `grep`, `editFile`, `terminal`, `repoSymbols`, `docs`: the same list in the development end-to-end run and in the packaged smoke |
| With `onyx.agent.networkTools` on | the same eight; when the request names the browser: `readFile`, `listDirectory`, `findFiles`, `grep`, `editFile`, `terminal`, `openBrowserPage`, `readPage`. A network call asks first and a denied one does not run |
| Agent Host | not started: no `agenthost.log` in the profile; "Open Agents Window" opens no second workbench |

### The baseline before B1 and B3 (history)

Recorded by baseline mode, which proves launch, profile and runtime isolation and records the advertised
tools; it makes no claim that reading or editing works.

| Field | Observed |
|---|---|
| Build | `pnpm run gulp vscode-darwin-arm64-min` from `upstream-1.147.0` at `881936cd52c`: upstream 1.147.0, Electron 43.8.9 (`docs/progress/packaged-smoke-baseline.json` has the product.json commit and date). The inventory below is unchanged from the build A8 recorded on the August base (`3c83cc037d2`, Electron 42.8.1) |
| Launch, CDP, throwaway profile, mock runtime | pass (4 infrastructure checks) |
| Tools advertised to the model (8) | `repoSymbols`, `editFile`, `terminal`, `docs`, `remember`, `openBrowserPage`, `readPage`, `playbook` |
| Essential tools present | `editFile`, `terminal` |
| **Essential tools missing** | **`readFile`, `listDirectory`, `findFiles`, `grep`** — the packaged build excludes the development Copilot extension that supplied read tools in dev, and Onyx has no read-side tools of its own yet. Owner: **B1** (tools) and **B3** (contract becomes a required check) |
| Tools exposed that the contract does not list | `openBrowserPage`, `readPage` (core browser tools reaching the model through core's registry). Owner: **B3** classifies or excludes them |
| Release mode | **fails**, for the missing read-side tools. Recorded in the module 1 gate as the baseline exception owned by B1 and B3 (`test/onyx/gates/module-1.json`, check `packaged-release`) |

## Optional feature states

ActionPlan §3 and §15: each item starts **planned**; the module that owns it ends with it **included**
(the default under DEC-12) or **deferred** for a HUMAN-approved technical blocker with its fallback
tested. The module gate runner reads this table (`| item | state |`).

| Item | State | Owner module | Fallback if deferred (must be tested) |
|---|---|---|---|
| C6 incremental constrained-answer streaming | included | 2 | Not needed: included. A constrained turn's answer is read out of its envelope and shown as it arrives (R-28's streaming case, `OnyxConstrainedStreaming`). The envelope schema is unchanged: per-tool `anyOf` schemas were not adopted, so no runtime subset had to be probed for them; what the pinned runtime enforces of a schema is measured by the datasheet (L5) |
| C7 broader index coverage | included | 2 | Not needed: included. Source folders are indexed first, `files.exclude`, `search.exclude` and the root `.gitignore` are honoured, the cap is 20,000 files and 256 MB after measurement, and coverage is reported (`OnyxWorkspaceIndexer`, `OnyxIndexOptions`; "The content index: what it covers") |
| C9 bounded line diff | included | 3 | Not needed: included. The line diff is a bounded Myers search in `common/onyxInlineEdit.ts` (R-29, measured on the reference machine and in plain Node). A size guard stays, at 20,000 lines a side and 1 MiB, and its test (R-38 as it stands with C9) with it |
| C10 benign repeated-dot names | included | 3 | Not needed: included. A `..` segment is refused and a name that contains two dots is not, on the read side and the write side (R-30, every subcase). Traversal, absolute paths and symbolic links out of the workspace are refused on both sides whatever this row says |
| D3 Check for Updates command | included | 5 | Not needed: included. `Onyx: Check for Updates` reads the project's public release list once, when invoked, and reports a newer release, no newer release, or that it could not tell; it downloads and installs nothing (`OnyxUpdateCheck`: newer, not newer, no releases, network failure, rate limit, unreadable answer, a link outside the repository). No automatic updater: `product.json` has no `updateUrl`. Manual replacement, rollback and uninstall are in `docs/UPDATING.md` and are exercised by `test/onyx/run-replace-check.mts` |
| L7 constrained anchors | included | 3 | Not needed: included as an **experimental** protocol, off by default and reachable only as a lab arm of the harness configuration (R-47). L14 decided, in Module 4, that it stays opt-in ("Decisions recorded here", below); the fallback is what ships: search and replace |
| L10 executable oracle | included | 4 | Not needed: included. The sandbox probe passes on the reference machine ("The private benchmark", below, has its output) and R-50's sandbox cases pass (`OnyxOracle`, `OnyxLabTasks`). Where the probe fails, or without the user's consent, scoring is tier 1 only and the result says so |
| L16 confidence badge | included | 4 | The study is done and its result is that no badge ships: H-8 is inconclusive (`docs/research/results/2026-11-22-confidence/`: 120 labelled hunks, 6 of them correct, where the registration needs 20 of each class). The review pane shows no confidence for a hunk and makes no claim about one. The rule that decides it is in the product (`common/onyxCalibration.ts`, R-55): a line of confidence is rendered only for an estimator the study supported and found calibrated, and none is named |
| L17 eviction policy | included | 4 | The study is done. H-9 is supported on scripted runs (`docs/research/results/2026-11-22-eviction-scripted/`): evicting in blocks down to a low watermark re-processed 0.42 of the prompt tokens that oldest-first did. `block-to-low-watermark` is therefore a value of the harness configuration's eviction switch, for the lab. As the product's default, oldest-results-first stays: in 120 agent runs no policy evicted anything and no run succeeded, so there is no evidence about what block eviction does to task success, and the default is not changed without it |
| L18 energy | included | 4 | The study is done. Power telemetry is readable on the reference laptop without elevated privileges (the battery controller, through `ioreg`; `docs/research/results/2026-11-22-energy/power-probe.json`), so energy was measured, at a resolution of about a minute. H-10 is inconclusive: no model solved a task, so energy per solved task has no value to rank. Energy per attempt is reported and decides nothing. On a machine without this telemetry the probe says so and the outcome there is "unavailable on this hardware"; nothing is derived from the parameter-seconds proxy |

## Decisions recorded here

| Decision | State |
|---|---|
| DEC-05 upstream baseline | Confirmed by the owner on 2026-11-20 and completed the same day: the fork is on upstream 1.147.0 (`docs/progress/DEC-05.md`, `REBASE.md`) |
| DEC-03 tool capability contract | Implemented by B3: contract version 1 above; one supported opt-in (network tools); MCP unavailable in the alpha; upstream's Agent Host excluded |
| L14 decision on constrained anchors (L7) | Opt-in. Constrained anchors stay an experimental protocol, off by default and reachable only as a lab arm of the harness configuration. H-4 is inconclusive (`docs/research/results/2026-11-22-edit-mechanisms/`): in 160 agent runs no task had an edit call in both arms, so there was no pair to compare. Under the product's configuration neither pinned model called the edit tool at all with search and replace; with anchors they did in 55 of 80 runs, and 51 of those proposals changed a line the author had not. That is not a reason to make anchors a default, and not a reason to withdraw them. Search and replace is what ships |
