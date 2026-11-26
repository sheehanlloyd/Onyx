# Comparison sources: Cline, Zed, VS Code (BYOK / local models), Void, Continue

All sources accessed 2026-11-22. Every cell is a paraphrase of a primary source (product docs, repo README, GitHub repo/release metadata, or the vendor's own site). Source keys in square brackets refer to the URL list at the end.

Reading method (matters for confidence):
- **raw** = fetched as raw Markdown/JSON and read directly (Cline docs `.md`, Zed docs `.md`, GitHub raw READMEs, GitHub REST API).
- **summarised** = HTML page opened through a fetch tool that returns a model-written summary of the page (VS Code docs, Continue docs, continue.dev, voideditor.com, GitHub HTML pages). Wording in these cells is one step further from the source; re-open before quoting anything verbatim.

Rule applied throughout: where docs are silent, the cell says "not stated in the docs read". Nothing here asserts that a product lacks a capability.

---

## 1. Status findings that needed a primary source

### Void: archived and deprecated (confirmed, primary)
- GitHub archive banner on the repo page: archived by the owner on **Jun 2, 2026**, read-only. [V1, summarised]
- GitHub REST API agrees: `archived: true`, last push `2026-06-02T22:03:55Z`. [V2, raw]
- README top section (raw): headed "Void is now deprecated."; says it no longer accepts contributions, stays open source, points to a list of forks and to Releases for old versions. The README notice itself carries no date. [V3, raw]
- Inconsistency worth knowing: the product website still offers a "Download Beta" link and shows no deprecation notice (footer copyright 2026). [V6, summarised]
- Last releases: main repo's newest tag is `v1.3.4`, published 2025-04-15, marked pre-release (the API has no "latest" non-prerelease). [V4, raw] The separate binaries repo's latest release is `1.99.30044`, published 2025-06-23; that repo is not flagged archived. [V5, raw]

### Continue: acquisition stated on the vendor's own homepage, but with no date and no standalone announcement found
- continue.dev homepage states Continue was acquired by Cursor (links to cursor.com), and that the open-source codebase "remains freely available as a foundation for others." The page shows **no date**. Three FAQ headings were present (open source availability, data, subscription) but their answers did not come through in the fetched text. [C1, summarised]
- **No primary dated announcement found.** blog.continue.dev lists no acquisition/shutdown post; its newest post is dated Mar 6, 2026. [C2, summarised] I did not find or open a Cursor-side announcement.
- Repo README (raw): a note says the repository "is no longer actively maintained and is read-only for all users"; a "Final 2.0.0 Release" section says the VS Code extension, CLI and JetBrains plugin got a final 2.0.0 that removed anonymous telemetry and authentication. README does not mention the acquisition or Cursor. [C3, raw]
- GitHub REST API: `archived: false` (so no GitHub archive banner, despite the README's read-only note); latest release `v2.0.0-vscode` published `2026-06-19T00:24:01Z`; a `v2.1.0-vscode` pre-release has the same timestamp. Most recent commits on the default branch are docs changes dated 2026-07-21. [C4, raw]
- Release page for v2.0.0-vscode has no release notes beyond the commit title; the fetched summary reported the commit as co-authored with Cursor. [C5, summarised]
- Dates of 16-18 June 2026 for the acquisition appear only in third-party coverage surfaced by search (titles/snippets only, pages not opened). They are **not** primary and are listed under "Not verified". The only primary date near the event is the final release, 2026-06-19.
- Docs site (docs.continue.dev) is still served and shows no status/acquisition banner. [C6, summarised]

### VS Code Copilot Chat extension repo: archived because it moved
- `microsoft/vscode-copilot-chat` shows an archive banner dated **May 20, 2026**; README says the project moved into the main `microsoft/vscode` repository. [M7, summarised; M8, raw API `archived: true`, last push 2026-05-20]

---

## 2. Table by user task

### Task: "Is this product alive, and under what licence?"

| Product | Status | Latest release at source | Licence | Sources |
|---|---|---|---|---|
| Cline | Active (repo not archived; pushed 2026-11-22) | `v4.1.27`, published 2026-11-21 | Apache-2.0 | [K1 raw README], [K2 raw API] |
| Zed | Active (repo not archived; pushed 2026-11-22) | `v1.29.3`, published 2026-11-20 | README: primarily GPL-3.0-or-later with Apache-2.0 components where marked (GitHub API reports licence as NOASSERTION) | [Z1 summarised], [Z2 raw API] |
| VS Code (BYOK) | Active | `1.147.0`, published 2026-11-18 (microsoft/vscode) | MIT for the `microsoft/vscode` repo; the former Copilot Chat repo (MIT) archived May 20, 2026 after moving into it | [M8 raw API], [M7 summarised] |
| Void | Archived Jun 2, 2026; README says deprecated | `v1.3.4` pre-release 2025-04-15 (main repo); `1.99.30044` 2025-06-23 (binaries repo) | Apache-2.0 | [V1]-[V5] |
| Continue | Homepage says acquired by Cursor (undated); README says no longer actively maintained and read-only; repo not flagged archived by GitHub | `v2.0.0-vscode`, published 2026-06-19, described in README as final | Apache-2.0 | [C1], [C3], [C4] |

### Task: "Use a local model"

| Product | Local runtimes documented | Fully offline? | Sources |
|---|---|---|---|
| Cline | Ollama, LM Studio, Atomic Chat (the latter exposes an OpenAI-compatible server); a separate OpenAI-compatible provider page exists (listed in docs index, page itself not opened). Cline Desktop has a Local Models page that installs/starts Ollama or LM Studio and recommends models for the machine. | Not stated in the docs read. (The telemetry page says that with telemetry off Cline still contacts its servers for sign-in, feature flags and Cline-provider requests; it does not say whether those are required when using a local provider.) | [K3 raw], [K4 raw, grep only], [K7 raw], [K8 raw index] |
| Zed | llama.cpp, Ollama, LM Studio, local OpenAI-compatible servers; local/self-hosted edit prediction configured separately. Ollama default context sent by Zed is 4096 tokens unless overridden. | Not stated in the docs read. | [Z3 raw] |
| VS Code (BYOK) | BYOK via built-in providers, extensions, or a "Custom endpoint" provider (Chat Completions / Responses / Messages API types; replaces the deprecated OpenAI Compatible provider). The built-in Ollama provider is deprecated in favour of the Ollama publisher's extension. LM Studio and llama.cpp-as-BYOK not mentioned on the page read. Separate experimental Copilot-managed on-device models run through llama.cpp and need GitHub sign-in. | Yes, documented: BYOK local models work without a GitHub account, Copilot plan, or internet connection. Features depending on the Copilot service (inline suggestions, semantic search, embeddings) are unavailable; utility models must be pointed at a BYOK model when signed out. Caveat: BYOK without sign-in is described for the Local harness, which the page says is deprecated and scheduled for removal in February 2027; BYOK in the Copilot harness is behind the experimental `chat.agentHost.byokModels.enabled` setting. | [M1 summarised, page dated 11/18/2026] |
| Void | README: bring any model or host locally (no runtime named). Website shows Ollama, vLLM and OpenAI-compatible endpoints. Codebase guide lists `'ollama'` as a provider name. LM Studio / llama.cpp not named in the pages read. | Not stated in the docs read. (README says messages go directly to providers without Void retaining data; that is not an offline statement.) | [V3 raw], [V6 summarised], [V7 raw] |
| Continue | Ollama guide; docs nav also lists a self-hosting guide (not opened). | Yes, documented: a "running without internet" guide with four steps: install the extension from a downloaded file, turn off anonymous telemetry, set a local model, restart VS Code. | [C7 summarised], [C8 summarised], [C6 summarised] |

### Task: "Review an AI edit before it lands"

| Product | Review model | Sources |
|---|---|---|
| Cline | README: in VS Code and JetBrains each edit appears as a diff the user can review, modify or revert; file edits need approval unless auto-approve is on. Checkpoints (on by default) snapshot the project into a shadow Git repo after each tool use; Compare opens a diff, Restore offers files-only, task-only, or both. Per-hunk accept/reject: not stated in the docs read. | [K1 raw], [K5 raw], [K6 raw] |
| Zed | After the agent edits, a Review Changes multi-buffer lists all changes; the user can accept or reject each hunk or the whole set. Optional inline single-file review (`agent.single_file_review`). The wording ("once the agent has made changes") indicates review happens after edits are written to the project. Checkpoints: not stated in the agent-panel text read (keyword search only). Edit tools can also be gated by tool-permission rules matched on file path. | [Z4 raw, keyword-filtered], [Z5 raw] |
| VS Code (BYOK) | Pending edits are already saved to disk when reviewed; Keep/Undo per individual change, per file, or all. `chat.editing.autoAcceptDelay` auto-keeps after a delay (Local harness). Checkpoints on by default (`chat.checkpoints.enabled`); restoring does not undo terminal commands or external effects. `chat.tools.edits.autoApprove` glob patterns can force confirmation before matching edits are saved. | [M2 summarised, page dated 11/18/2026] |
| Void | README: checkpoint and visualise changes. Codebase guide: Apply (Fast Apply via search/replace blocks, Slow Apply rewriting the file) streams changes into red/green diff zones; the agent's Edit tool uses the same Apply path; an approval-state service derives what the user still needs to review. Accept/reject granularity: not stated in the docs read. | [V3 raw], [V7 raw] |
| Continue | Edit mode shows inline diffs in VS Code; accept or reject each change individually or all at once, with keyboard shortcuts. JetBrains uses an inline popup instead. How Agent-mode file edits are displayed: not stated in the docs read. | [C9 summarised] |

### Task: "Run a shell command the model suggested"

| Product | Approval model | Sources |
|---|---|---|
| Cline | Default: terminal commands need approval. Auto Approve has separate toggles for "Execute safe commands" and "Execute all commands". There is no fixed allowlist: the model itself flags each command with `requires_approval`. YOLO mode auto-approves everything, with no confirmation dialog when enabling it. | [K1 raw], [K5 raw] |
| Zed | `agent.tool_permissions`: default is `confirm`; per-tool regex rules `always_allow`, `always_deny`, `always_confirm` for the `terminal` tool (matched against the command string; chained commands are parsed and each sub-command checked). Global `"default": "allow"` auto-approves most tools. A small hardcoded set of `rm -rf` rules on critical directories cannot be overridden. An OS-level agent sandboxing page exists (listed in index, not opened). | [Z5 raw], [Z6 raw index] |
| VS Code (BYOK) | Prompt options in Copilot sessions: Allow Once, In this Session, Always Allow, Skip. Rules in `chat.tools.terminal.autoApprove` map patterns to true/false; built-in default rules exist; `chat.tools.terminal.enableAutoApprove` turns rules and saved approvals off; `chat.tools.global.autoApprove` skips ordinary confirmations. Permission levels: Manual (default), Assisted, Allow all. Docs describe command matching as best effort and point to sandboxing. | [M3 summarised], [M4 summarised], both dated 11/18/2026 |
| Void | Not stated in the docs read (README, codebase guide and website say nothing about command approval). | [V3], [V6], [V7] |
| Continue | Agent mode asks before each tool call by default; per-tool policies can set a tool to Automatic or exclude it. A run-terminal-command tool is among the write/execute tools. Command allowlists: not stated in the docs read. | [C10 summarised], [C11 summarised] |

### Task: "Use agent / tool calling with a local model"

| Product | What the docs say | Sources |
|---|---|---|
| Cline | Recommends enabling "Use Compact Prompt" for local inference, keeping tasks focused, and starting a new task when context grows. RAM guidance: 16-32 GB small/quantised, 32-64 GB mid-size coding models, 64 GB+ larger. Cline Desktop recommends models "picked for agentic coding" per machine and shows each model's capabilities (tool use, thinking, vision). No named model list on the pages read. | [K3 raw], [K4 raw, grep only] |
| Zed | Tool calling must be supported individually by each model and provider. llama.cpp models are auto-discovered with tool/vision capability; Ollama and manual entries carry a `supports_tools` flag. Examples use mistral and qwen2.5-coder but the page does not label them recommendations. | [Z3 raw], [Z4 raw, keyword-filtered] |
| VS Code (BYOK) | A model must support tool calling (`"toolCalling": true` in its config) to appear in the agent model picker; models without it are hidden. Token limits must fit the model's context window. Docs warn local models may lack cloud safety filters and be more open to malicious instructions, especially with auto-approval. No recommended local models named. | [M1 summarised] |
| Void | Codebase guide says the provider layer exposes grammars for tool tags and thinking tags (README) and that the LLM's Edit tool goes through Apply. Model requirements or recommendations for local tool use: not stated in the docs read. | [V3 raw], [V7 raw] |
| Continue | Agent and Plan modes need a model/provider with tool support; add `tool_use` under `capabilities` if needed. Guide warns some models advertise tools but are unreliable (DeepSeek R1 given as the example) and suggests Llama 3.1 or Mistral, or enabling system-message tools. Named suggestions include qwen2.5-coder:7b, llama3.1:8b, mistral:7b; lower `contextLength` if memory errors occur. | [C8 summarised], [C10 summarised] |

### Task: "Measure or compare models on my own code"

| Product | Built-in benchmark / eval | Sources |
|---|---|---|
| Cline | None found in the docs read. (The repo listing shows an `evals/` directory; its contents and purpose were not opened, so nothing is claimed about it.) | [K8 raw index], [K9 summarised] |
| Zed | None found in the docs read. | [Z6 raw index, AI section] |
| VS Code (BYOK) | None found in the docs read. | [M1]-[M4] |
| Void | None found in the docs read. | [V3], [V6], [V7] |
| Continue | None found in the docs read. | [C6], [C7]-[C11] |

Scope note: "none found" covers only the pages listed; no product's full documentation set was searched exhaustively.

### Task: "Know what is sent home, and turn it off"

| Product | Telemetry | How to turn it off | Sources |
|---|---|---|---|
| Cline | On by default in the VS Code/JetBrains extensions, Desktop and CLI. Records feature use, task events, errors, token counts, model/provider names, version/OS/editor, plus a device identifier. Says code and prompts are not included except for requests to the Cline / ClinePass providers. | Extensions: Settings > General > clear "Allow error and usage reporting"; in VS Code it also follows the editor's telemetry setting (a few required events still sent while editor telemetry is on). Desktop: Settings > General > Telemetry. CLI: `telemetryOptOut: true` in `~/.cline/data/settings/global-settings.json`. With telemetry off it still contacts its servers for sign-in, feature flags and Cline-provider requests. | [K7 raw] |
| Zed | Anonymous client-side telemetry (crash diagnostics; usage metrics such as file extensions, features used, project statistics), said not to include code. Server-side metadata when hosted services are used. A local telemetry log can be opened. | `"telemetry": { "diagnostics": false, "metrics": false }` in settings. Server-side collection for hosted services is described as required for those features. | [Z7 raw] |
| VS Code (BYOK) | Crash reports, error telemetry, usage data. | `telemetry.telemetryLevel`: `all` / `error` / `crash` / `off`. Docs note extensions may collect their own data outside this setting, and that turning it off does not make VS Code offline. | [M5 summarised, page dated 11/18/2026] |
| Void | Not stated in the docs read. README says messages go straight to providers and Void does not retain user data; telemetry as such is not discussed in README, website or codebase guide. | Not stated in the docs read. | [V3], [V6], [V7] |
| Continue | README: the final 2.0.0 release removed anonymous telemetry. The offline guide (possibly written for earlier versions) still describes an "Allow Anonymous Telemetry" VS Code setting and names PostHog as the destination. | Per the guide: disable "Allow Anonymous Telemetry" in VS Code settings. A dedicated telemetry docs page was tried and returned 404. | [C3 raw], [C7 summarised], [C12 could not open] |

### Task: "Run it on my machine" (platforms)

| Product | Platforms | Sources |
|---|---|---|
| Cline | VS Code extension; JetBrains plugin (README says JetBrains plugins are not open-sourced); CLI via npm; desktop app for macOS and Windows; SDK. | [K1 raw] |
| Zed | macOS, Linux, Windows. README lists Web as not yet available. | [Z1 summarised], [Z6 raw index] |
| VS Code (BYOK) | Windows (64-bit), macOS (versions with Apple security update support), Linux (Debian- and Red Hat-based; glibc 2.28+). | [M6 summarised, page dated 02/04/2026] |
| Void | Not listed in README or website. The binaries repo's last release ships macOS (arm64, x64), Windows (x64, arm64) and Linux (several architectures; AppImage, rpm, tar.gz) assets. | [V5 raw] |
| Continue | VS Code extension (Marketplace and OpenVSX), JetBrains plugin (README recommends the CLI over it), CLI via npm. | [C3 raw] |

---

## 3. Could not open

- https://code.visualstudio.com/docs/copilot/agents/approvals : HTTP 404 (wrong path guessed; the correct page [M4] was then found via a link on [M3] and opened).
- https://docs.continue.dev/customize/telemetry : HTTP 404. Continue telemetry cells rest on the README and the offline guide only.
- GitHub code search API for Void telemetry code: returned 401 (needs authentication); not pursued.

## 4. Every URL opened (all on 2026-11-22)

Cline
- [K1] https://raw.githubusercontent.com/cline/cline/main/README.md (raw, first 150 lines) and https://github.com/cline/cline (summarised) = [K9]
- [K2] https://api.github.com/repos/cline/cline and https://api.github.com/repos/cline/cline/releases/latest
- [K3] https://docs.cline.bot/running-models-locally/overview.md
- [K4] https://docs.cline.bot/usage/cline-desktop-local-models.md (keyword-filtered lines only)
- [K5] https://docs.cline.bot/features/auto-approve.md
- [K6] https://docs.cline.bot/core-workflows/checkpoints.md
- [K7] https://docs.cline.bot/enterprise-solutions/monitoring/telemetry.md
- [K8] https://docs.cline.bot/llms.txt (keyword-filtered lines only)

Zed
- [Z1] https://github.com/zed-industries/zed
- [Z2] https://api.github.com/repos/zed-industries/zed and https://api.github.com/repos/zed-industries/zed/releases/latest
- [Z3] https://zed.dev/docs/ai/use-a-local-model.md
- [Z4] https://zed.dev/docs/ai/agent-panel.md (keyword-filtered lines only)
- [Z5] https://zed.dev/docs/ai/tool-permissions.md (first ~7000 characters)
- [Z6] https://zed.dev/docs/llms.txt (keyword-filtered lines only)
- [Z7] https://zed.dev/docs/telemetry.md
- Also keyword-searched, nothing used beyond what is cited: https://zed.dev/docs/ai/zed-agent.md , https://zed.dev/docs/ai/llm-providers.md , https://zed.dev/docs/ai/privacy-and-security.md , https://zed.dev/docs/ai/tools.md , https://zed.dev/docs/ai/quick-start.md

VS Code
- [M1] https://code.visualstudio.com/docs/copilot/customization/language-models
- [M2] https://code.visualstudio.com/docs/copilot/chat/review-code-edits
- [M3] https://code.visualstudio.com/docs/copilot/agents/agent-tools
- [M4] https://code.visualstudio.com/docs/agents/run/approvals
- [M5] https://code.visualstudio.com/docs/configure/telemetry
- [M6] https://code.visualstudio.com/docs/supporting/requirements
- [M7] https://github.com/microsoft/vscode-copilot-chat
- [M8] https://api.github.com/repos/microsoft/vscode , https://api.github.com/repos/microsoft/vscode/releases/latest , https://api.github.com/repos/microsoft/vscode-copilot-chat , https://api.github.com/repos/microsoft/vscode-copilot-chat/releases/latest

Void
- [V1] https://github.com/voideditor/void
- [V2] https://api.github.com/repos/voideditor/void
- [V3] https://raw.githubusercontent.com/voideditor/void/main/README.md (first 60 lines)
- [V4] https://api.github.com/repos/voideditor/void/releases?per_page=3 and https://api.github.com/repos/voideditor/void/releases/latest (404: no non-prerelease)
- [V5] https://api.github.com/repos/voideditor/binaries , https://api.github.com/repos/voideditor/binaries/releases?per_page=3 , https://api.github.com/repos/voideditor/binaries/releases/latest
- [V6] https://voideditor.com
- [V7] https://raw.githubusercontent.com/voideditor/void/main/VOID_CODEBASE_GUIDE.md (keyword-filtered lines only)

Continue
- [C1] https://continue.dev/
- [C2] https://blog.continue.dev
- [C3] https://raw.githubusercontent.com/continuedev/continue/main/README.md and https://github.com/continuedev/continue (summarised)
- [C4] https://api.github.com/repos/continuedev/continue , https://api.github.com/repos/continuedev/continue/releases/latest , https://api.github.com/repos/continuedev/continue/releases?per_page=6 , https://api.github.com/repos/continuedev/continue/commits?per_page=5
- [C5] https://github.com/continuedev/continue/releases/tag/v2.0.0-vscode
- [C6] https://docs.continue.dev
- [C7] https://docs.continue.dev/guides/running-continue-without-internet
- [C8] https://docs.continue.dev/guides/ollama-guide
- [C9] https://docs.continue.dev/ide-extensions/edit/quick-start
- [C10] https://docs.continue.dev/ide-extensions/agent/quick-start
- [C11] https://docs.continue.dev/ide-extensions/agent/how-it-works
- [C12] https://docs.continue.dev/customize/telemetry (404)
- https://docs.continue.dev/llms.txt (fetched; keyword filter returned nothing)

Other
- One web search ("Continue.dev acquired announcement blog") used only to locate primary pages; result pages other than continue.dev were not opened.
- https://code.visualstudio.com/docs/copilot/agents/approvals (404)
- https://api.github.com/search/code?q=posthog+repo:voideditor/void (401)

## 5. Not verified

- **Date of the Continue acquisition.** No primary source gives one. Third-party articles surfaced by search give 16 or 18 June 2026 and mention a 15 July data-export/deletion deadline and a founder joining Cursor; none of those pages were opened and none are primary. Do not cite a date; cite the undated homepage statement plus the 2026-06-19 final release.
- **A Cursor-side announcement** of the Continue acquisition: not searched for on cursor.com, not found.
- **Continue homepage FAQ answers** (open source, data, subscription): headings seen, answer text not retrieved.
- **Whether Continue 2.0.0 still has the telemetry setting** described in the offline guide: README says telemetry was removed; the guide was not checked for its revision date.
- **Void telemetry**: not documented in the pages read; source code not inspected.
- **Void command-approval and accept/reject granularity**: not documented in the pages read.
- **Void supported runtimes beyond Ollama / vLLM / OpenAI-compatible**: website read through a summary; logos may have been incompletely captured.
- **Cline offline operation with a local provider**: docs read are silent.
- **Zed offline operation with a local model** and **Zed checkpoints**: docs read are silent (agent-panel page was keyword-filtered, not read in full; tool-permissions page was truncated at ~7000 characters).
- **Cline `evals/` directory**: seen in the repo listing only; whether it is a user-facing feature is unknown.
- **Cline OpenAI-compatible provider page, Zed sandboxing page, Continue self-hosting guide**: seen in indexes, not opened.
- **VS Code requirements page date** "02/04/2026": format ambiguous as displayed.
- **All "summarised" cells**: read via a model-written summary of the page rather than the raw page text; any wording presented as a quotation (there are three short ones in this file, each under 15 words) should be re-checked against the live page before publication. Setting names from summarised VS Code pages (`chat.agentHost.byokModels.enabled`, `chat.editing.autoAcceptDelay`, `chat.checkpoints.enabled`, `chat.tools.edits.autoApprove`, `chat.tools.terminal.autoApprove`, `chat.tools.terminal.enableAutoApprove`, `chat.tools.global.autoApprove`, `telemetry.telemetryLevel`) should likewise be spot-checked.
- **Release dates** come from GitHub's REST API `published_at` (UTC), not from the rendered release pages.
