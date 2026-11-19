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
| Optional tools | `repoSymbols`, `docs`, `remember`, `playbook`, in that deterministic order, filling at most the two spare slots (default `repoSymbols` then `docs`; an explicit playbook request may replace a spare) |
| Capability classes | Every exposed tool is classified read / write / execute / network from a reviewed table keyed by tool id (B3). Writes go through Onyx Changes; every shell invocation needs the Onyx approval dialog (B2); unknown tools are excluded; browser and MCP opt-ins never bypass staging or per-invocation approval |
| Persistent state | A model-initiated memory, pin or playbook write cannot influence a later prompt before the user confirms it with its origin shown (I-14, R-59) |

## Observed baseline inventory

Recorded by `node test/onyx/run-packaged-smoke.mts --app ../VSCode-darwin-arm64/Onyx.app --mode baseline`
on the build named below. Baseline mode proves launch, profile and runtime isolation and records the
advertised tools; it makes no claim that reading or editing works.

| Field | Observed |
|---|---|
| Build | `npm run gulp vscode-darwin-arm64-min` from module-1 at `3c83cc037d2` (see `docs/progress/A8.md` for the exact product.json commit and date) |
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
