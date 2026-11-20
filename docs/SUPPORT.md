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
| Capability classes | Every exposed tool is classified read / write / execute / network from a reviewed table keyed by tool id (B3). Writes go through Onyx Changes; every shell invocation needs the Onyx approval dialog (B2); unknown tools are excluded; browser and MCP opt-ins never bypass staging or per-invocation approval |
| Persistent state | A model-initiated memory, pin or playbook write cannot influence a later prompt before the user confirms it with its origin shown (I-14, R-59) |

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

## Observed baseline inventory

Recorded by `node test/onyx/run-packaged-smoke.mts --app ../VSCode-darwin-arm64/Onyx.app --mode baseline`
on the build named below. Baseline mode proves launch, profile and runtime isolation and records the
advertised tools; it makes no claim that reading or editing works.

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
| DEC-05 upstream baseline | Trial report in `docs/progress/A9.md`; the recommendation is recorded in `REBASE.md` and waits on HUMAN confirmation |
