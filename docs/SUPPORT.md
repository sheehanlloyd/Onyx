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
| Runtime | Ollama, one pinned version (recorded here before the candidate is cut) | LM Studio, llama.cpp server, vLLM, any other OpenAI-compatible server |
| Models | `qwen2.5-coder:7b` for the agent and `qwen2.5-coder:1.5b` for autocomplete, pinned by digest before the candidate | Everything else in the catalog |
| Workflow | Read → propose → review in a diff editor → accept or reject per hunk → verify; inline edit; commit message; review; measure models for this repository | Tournament, architecture map, speculative measurement, idle review, constrained anchors (until L14 decides) |
| Extensions | A named set installed from Open VSX and smoke-tested (D1) | Anything else on Open VSX |

Pinned runtime version and model digests: **not yet recorded** (Module 5, D4).

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
| `editProtocol` | How an edit is proposed | `search-replace` | none yet (constrained anchors, L7) |
| `promptStyle` | How much the prompt carries | `compact` or `full`, from the model's profile | the other one |
| `toolResultChars` | The most of one tool result that goes back to the model | 4,000 with a compact prompt, 16,000 with a full one | 200 to 1,000,000 |
| `evictionPolicy` | What is dropped when a turn does not fit | `oldest-results-first` (B13) | none yet (L17) |
| `contextTokens` | The context a turn is fitted to | the smallest context known for the model (B13) | 512 to 4,000,000 |
| `turnCap` | The most model turns in a run | 8 with a compact prompt, 16 with a full one | 1 to 64 |
| `verificationFeedback` | Whether a run that used a tool ends by comparing the workspace's problems to how it started | on | off |
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
| Context | A code at the start of a prompt, a question about it at the end; the prompt doubles from 1,024 estimated tokens up to what the server says it allocated, then the gap is halved twice | The code comes back | up to 7 |
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
| Output cap honoured; stop honoured | 3 of 3; 3 of 3 | 3 of 3; 3 of 3 |
| Reasoning | none seen in 3 replies | none seen in 3 replies |
| Same seed, same reply | 3 of 3 | 3 of 3 |
| Log-probabilities returned | 3 of 3 | 3 of 3 |
| First token, cold and warm | 1,233 ms and 93 ms | 1,174 ms and 29 ms |
| Tokens a second | 48 | 159 |

What follows for the supported model: both advertise tool support and neither put one call on the tool
channel, so their turns are constrained to the envelope, which the runtime was seen to enforce; and their
context is budgeted at 4,096 tokens, not the 32,768 their architecture allows.

**Limits.**

- **Few trials.** The 1.5B model's text calls were readable 2 of 5 times in one run and 3 of 5 in the next.
- **The context probe stays inside what the server says it allocated**, so on a server that reports its
  allocation it confirms recall up to it and finds no limit of its own. Its sizes are estimates at four
  characters a token; the filler text is denser than that, so the largest prompt was 3,514 tokens, not 4,096.
- **A schema probe cannot tell enforcement from a model that complies anyway.** The prompts ask for what the
  schema forbids to make that unlikely, not impossible.
- **Speed is the machine's at that moment.** A first run with the battery nearly flat gave 15 tokens a second
  for the 7B model; it was discarded. "Cold" means the runtime had not loaded the model; the file may still
  have been in the operating system's cache.
- **Datasheets are not in the diagnostics export**, and reasoning models remain unvalidated against a real
  model (C4): neither pinned model reasons.

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

Every read tool refuses an absolute path, a path containing `..`, a backslash, and a path that resolves outside
the workspace folder through a symbolic link; searches do not follow symbolic links (R-30, I-07 on the read
side). A file name that merely contains two dots (`a..b.ts`) is refused as well until C10 decides otherwise.

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
| C9 bounded line diff | planned | 3 | B7 enforces 1,000 lines per side, 1,000,000 LCS cells, 256 KiB before every quadratic diff; R-38 |
| C10 benign repeated-dot names | planned | 3 | Conservative filename refusal; traversal and symlink refusals stay mandatory |
| D3 Check for Updates command | planned | 5 | Manual replacement, rollback and uninstall instructions always ship |
| L7 constrained anchors as default | planned | 4 (L14 decides) | Opt-in experimental protocol or withdrawn with the negative result |
| L10 executable oracle | planned | 4 | Tier 1 scoring only; this file shows the sandbox probe output |
| L16 confidence badge | planned | 4 | No badge, no claim; result published |
| L17 eviction policy | planned | 4 | Oldest-first eviction stays; result published |
| L18 energy | planned | 4 | "Unavailable on this hardware" with the probe output |

## Decisions recorded here

| Decision | State |
|---|---|
| DEC-05 upstream baseline | Confirmed by the owner on 2026-11-20 and completed the same day: the fork is on upstream 1.147.0 (`docs/progress/DEC-05.md`, `REBASE.md`) |
| DEC-03 tool capability contract | Implemented by B3: contract version 1 above; one supported opt-in (network tools); MCP unavailable in the alpha; upstream's Agent Host excluded |
