# Production readiness (D8)

Candidate: the packaged build of the tip of `followup-open-gaps` (the follow-up of 2026-11-26), built on the reference machine; the module gate ran on it (STATE.md names the revision). The soak, the budgets and the accessibility probe were taken on the build of `7b44eaa5c38`, whose application inputs are the candidate's (the later commits change only tests, records and documents; `candidate-evidence.mts` checks this). The egress audit below is the module gate's, on the candidate.

**Summary.** The egress audit passed (R-60). The accessibility probe found no unnamed or unreachable control on any Onyx surface the suite opens. The budgets are measured and published as measurements. The open-source files are in place. Gitleaks found nothing. The one-hour soak passed on the candidate, after five earlier soaks that found the defects listed in its section. **This is not a clean bill of health:** the dependency audit found high-severity advisories in packages the application ships, all inherited from upstream 1.147.0 and none added by Onyx, and the final sweep therefore lists open P1 candidates that need the owner's decision under DEC-05.

## Egress audit (R-60)

The module gate's R-60 on the candidate, `node test/onyx/run-egress-audit.mts --app ../VSCode-darwin-arm64/Onyx.app --json-out .build/gate-5/egress-audit.json`, on the follow-up's candidate `05a3fa30460`, 2026-11-26, 19:01:36 to 19:21:08 UTC, copied to [egress-audit.json](./egress-audit.json): **passed**. The table is from the first audit, on the build of `4eb52add73f` on 2026-11-24; the candidate's differs only in counts: the suite had 73 checks, and in the asked phase Open VSX's file host had 6 connections. Each phase found no direct connection to a non-loopback address.

| Phase | What happened | Hosts reached outside this machine |
|---|---|---|
| workflow | the whole end-to-end suite on the packaged app ("all 72 checks passed"): first launch, the first-run dialog, agent tasks, an inline edit, review, verification, the terminal approval, a measurement run, and the rest | none |
| idle | a fresh first launch, the first-run dialog stepped through, then ten minutes untouched | none |
| asked | the Extensions view opened and searched, then `Onyx: Check for Updates` | `open-vsx.org` (3 connections), `openvsx.eclipsecontent.org` (3, Open VSX's file host), `api.github.com` (1) |

Loopback traffic went to the mock runtime (11434, and 1234 for the suite's second mock) and to the application's own local ports; at idle the runtime discovery also looked at loopback 8000 and 8080, the usual vLLM and llama.cpp ports. No direct connection to any non-loopback address was seen in any phase.

**Method.** The application was started with `--proxy-server` pointing at a recording proxy in the audit's process, which logs the host and port of every request and passes the bytes through unread. Beside it, `lsof -nP -i` on every process of the application, about three times a second, catches connections that bypass the proxy. Neither needs privileges or a system-wide change.

**What it cannot see.** A direct connection that opens and closes between two socket samples; DNS lookups, which the system resolver makes; the content of TLS connections (only hosts are recorded); and anything the application would do only outside these phases (a second day, a crash report, an extension the user installs, which can make its own requests). It observes these phases on this build. It does not prove anything about the binary.

**Harness corrections made on the way, each found by a failed or suspect run:** the end-to-end suite was first run synchronously, which froze the proxy and the sampler for the whole phase; the socket sampler itself was synchronous; Open VSX's file host was missing from the allowed set; the Changes-view clicks of the suite took element handles that a re-render detached on a loaded machine. One run (09:23 to 10:46 local) was discarded because the Mac slept for 43 minutes in the middle of it. The run above has no sleep in its window (`pmset -g log`).

Two product defaults were set for this rule (D1): extension update checks, auto-update, recommendations and experiments are off, so that the gallery is not asked at startup or on a timer.

## Open-source readiness

| File | State |
|---|---|
| LICENSE.txt | MIT, upstream's, unchanged |
| NOTICE.md, ThirdPartyNotices.txt | NOTICE says who owns what; Onyx adds no third-party dependency (checked: no dependency change against upstream 1.147.0 other than a script name in package.json) |
| .github/CONTRIBUTING.md | the module gate is now the contribution check |
| .github/CODE_OF_CONDUCT.md | present |
| .github/SECURITY.md | rewritten to the shipped model in Module 2; this module added the outbound-request list (now checked by the audit) and that extensions are code with no signature verification |
| Issue and pull-request templates | present (`onyx_bug_report.yml`, `onyx_feature_request.yml`, `pull_request_template.md`) |
| CITATION.cff | added (L19) |
| Shipped identity | the hygiene check's identity scan passes. The built bundle no longer says "Microsoft Corporation" as its company or "All rights reserved" in its copyright string (`build/lib/electron.ts`, found in this pass). `product.json` still carries upstream's `defaultChatAgent` block with `aka.ms` and `api.github.com/copilot_internal` addresses, because core reads it without guards (REBASE.md); the audit saw none of them contacted |

## Stability: one-hour soak

`node test/onyx/run-soak.mts --app ../VSCode-darwin-arm64/Onyx.app`, on the build of `7b44eaa5c38`, 2026-11-26, 16:57:11 to 18:11:35 UTC. Result in [soak.json](./soak.json): **passed**.

- **Power:** on mains (94 W) for the whole window, battery 100% at the start and at the end, Low Power Mode off (`powermode 2`, high power). The lid was open; `pmset -g log` has no Sleep, Wake or DarkWake entry in the window. No speed figure is taken from this run.
- **Suite:** 8 runs of the end-to-end suite on the packaged app, back to back, beside a second, idle instance of the app, in 74.3 minutes: all 73 checks passed in every run. Nothing was left running after any run; no crash report was written.
- **Memory:** the suite's renderer peaked between 670 and 912 MB a run, with no growth from run to run. The idle instance's renderer went from 546 MB to 186 MB over the hour.
- **Campaign:** the full simulation campaign afterwards: 50,000 of 50,000 episodes with no violation, and 48 of 48 mutants detected.

**The soaks before this one, and what each found.** None of their results is used here.

| Started (UTC) | Build | Result | What it found |
|---|---|---|---|
| 2026-11-24 17:13 | `4eb52add73f` | discarded | the suite's window behind the owner's applications stopped rendering and lost focus; the driver had no time limit (fixed: `15f571a060a`, `17a44401773`; D8.md) |
| 2026-11-25 17:39 | `4eb52add73f` | discarded | the Mac went onto battery four minutes in, which the rule then in force did not allow |
| 2026-11-25 18:40 | `4eb52add73f` | void | the Mac slept with the lid closed, on battery, 37 minutes in |
| 2026-11-26 03:46 | `4eb52add73f` | failed | one of eight runs stopped: F1 left no visible Command Palette while a run streamed (the suite now waits for it, `ab948abdeb2`) |
| 2026-11-26 05:11 | `0a8e3023a19` | failed | the campaign found a dialog that Stop did not close: the memory confirmation, after which a note could still be stored (fixed: `f0f059b0ccd`) |
| 2026-11-26 06:36 | `f0f059b0ccd` | passed, replaced | the soak of the Module 5 candidate (72.6 minutes, 43 of 43 mutants); replaced because the follow-up changed the application |

## Measured budgets

`node test/onyx/run-budgets.mts --app … --runtime http://127.0.0.1:11500`, 2026-11-26, about 18:13 to 18:17 UTC, on the build of `7b44eaa5c38`, on mains (94 W, battery 100%), one-minute load 2.9 at the start and 3.1 at the end, no sleep in the window; a private Ollama 0.33.0 on that port, started for this and stopped after it. [budgets.json](./budgets.json). The owner's other applications were open, and swap use was 9.2 GB of 10.2 GB: this is the reference machine as it is used, not an idle one. Copied into `docs/SUPPORT.md` as measurements. It replaces the measurement on the build of `f0f059b0ccd` (7B 49.7 tokens a second, 1.5B 166.5), because the application changed.

| | `qwen2.5-coder:7b` | `qwen2.5-coder:1.5b` |
|---|---|---|
| First token, cold (model not loaded) | 2,741 ms (load 2,577 ms) | 1,107 ms (load 1,062 ms) |
| First token, warm | 24 ms | 9 ms |
| Tokens a second (median of 3) | 50.8 | 169.1 |
| Model process resident memory | 5,358 MB | 1,480 MB |

The warm first-token figure is for the same prompt sent again, whose prefix the runtime has cached; a new prompt of the same length waits for its evaluation. It is the floor, not the typical case.

| Application | Measured |
|---|---|
| Start to a workbench with an editor area (fresh profile, files in the disk cache) | median 1,011 ms over 5 starts (1,005 to 1,421) |
| Idle, two minutes after the first run, CPU (all processes, % of one core) | mean 1.4, highest sample 4.3 |
| Idle, resident memory, all processes | median 1,389 MB (renderer 643 MB) |
| One agent request with the 7B model ("add a multiplyNumbers function") | completed in 8 s with no proposal; application peak 1,082 MB, model process peak 5,424 MB |

Resident memory of an Electron application's processes moves a great deal on macOS (compression, the GPU process), so read those figures as a range on this machine, not a bound. An earlier attempt of this measurement had a filter that missed Ollama's runner process and reported 0 MB for it; the filter was fixed and the measurement taken again.

## Accessibility and keyboard

The end-to-end suite drives every Onyx surface of the supported workflow by keyboard and by accessible names (Command Palette, the inline-edit widget, hunk keep and reject with Cmd+Enter and Cmd+Backspace, F7, the approval dialog, the Changes view, the diff editor). On top of that, an accessibility probe (`ONYX_E2E_A11Y_OUT`, in `test/onyx/run-e2e.mts`) ran during an end-to-end run of all 73 checks on the packaged build of `7b44eaa5c38` (2026-11-26, 16:48 to 16:56 UTC; it was first taken on `4eb52add73f`) and recorded ([accessibility-probe.json](./accessibility-probe.json)):

- the surfaces it looked at: the first-run dialog, 60 dialog appearances, the quick input, 15 inline proposals, the Onyx views (6,804 samples), and the title bar;
- **no interactive element without an accessible name, and none unreachable by keyboard**, after two false positives were taught to the probe (a toolbar separator with `role=presentation`; a radio group in upstream's onboarding that keeps one radio in the tab order, the standard pattern);
- 289 announcements to the screen-reader live region, including the run status, "Staging an edit to src/math.ts", "Onyx staged edits to 1 file, pending your review", "Proposed, not yet in the file: hunk 1 of 1, Cmd+Enter keep, Cmd+Backspace reject", "Proposing command: …", "Command denied by the user", and "All staged edits discarded. No file was changed".

What it does not establish: that the announcements are clear to a screen-reader user, that focus order is sensible everywhere, or that colour contrast meets a standard. Nobody has used Onyx with VoiceOver. That needs a person.

## Dependency and secret scan

**Secrets.** Gitleaks 8.30.1, default rules, over the 206 commits that touch Onyx-owned paths since upstream 1.147.0: **no finding** ([secret-scan.json](./secret-scan.json)).

**Dependencies.** `pnpm audit --prod`, 2026-11-22 ([dependency-audit.json](./dependency-audit.json)): 47 advisories across 885 dependencies, **none in a dependency Onyx added** (it added none). By where they are:

| Where | In the packaged app? | High or critical advisories |
|---|---|---|
| root (`undici`, `zod`, `follow-redirects` through dev tunnels) | **yes**, in `node_modules.asar` | undici: four high (a TLS certificate-validation bypass, cache poisoning, two denials of service); zod: one high; follow-redirects: one high |
| `extensions/emmet` (`image-size`) | yes | one high (denial of service on a crafted image) |
| `extensions/markdown-language-features` (`markdown-it`) | yes | one high (quadratic rendering) |
| `extensions/microsoft-authentication` (`@azure/msal-node`) | yes | one high |
| `extensions/copilot` (MCP SDK, express, proxy-addr) | no, excluded from the bundle (B3, L4) | one critical, six high |
| test and repository tooling | no | none high |

`undici` from npm is used by upstream's extension-host proxy resolver and its MCP client; Onyx's own requests go through Electron's network stack. Whether the TLS finding is reachable in this product was not established. These are inherited-base findings under DEC-05. Fixing them means moving to an upstream release that bumps them or overriding versions in the lockfile, which this session did not do (frozen installs only).

## Final sweep

| Question | Answer |
|---|---|
| Open P0 | none known |
| Open P1 | **candidates, for the owner:** the shipped `undici` TLS certificate-validation advisory and the other high-severity advisories above (inherited; DEC-05). Extension signatures are not verified (documented; D1). Neither is labelled fixed |
| Formerly optional items | every one has its DEC-12 disposition in `docs/SUPPORT.md`; nothing is "planned" (checked by `module5-docs.test.mts`) |
| Studies | H-1 to H-10 each have an outcome (L19) |
| Gates 1 to 4 on the candidate | see `docs/progress/STATE.md` |
