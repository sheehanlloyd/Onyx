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
| C6 incremental constrained-answer streaming | planned | 2 | Explicit buffering status; no streaming claim; R-28 argument validation stays mandatory |
| C7 broader index coverage | planned | 2 | Document the cap and partial coverage; freshness metadata stays mandatory |
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
