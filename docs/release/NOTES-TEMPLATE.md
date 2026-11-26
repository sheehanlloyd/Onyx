# {{PRODUCT}} {{VERSION}}

**Experimental alpha.** {{PRODUCT}} is a fork of Code - OSS that runs coding models on your own Mac through a local runtime. This release is for people who already run local models and want to try it on real work with their eyes open. It says "Experimental Alpha" in its title bar.

Read "What to expect from the models" below before you install. It is the most important part of these notes.

## Download

| File | SHA-256 |
|---|---|
| `{{DMG}}` | `{{SHA256}}` |

Built from commit `{{COMMIT}}`. The disk image and the application inside it are signed with a Developer ID certificate, notarized by Apple and stapled, so the first launch needs no network connection and shows only the standard confirmation for a downloaded application. If macOS says anything else, do not work around it: the download is damaged or is not this file. Check it:

```bash
shasum -a 256 -c {{DMG}}.sha256
```

Install by opening the disk image and dragging {{PRODUCT}} to Applications. Updating, rolling back and uninstalling are manual: [docs/UPDATING.md](https://github.com/{{REPOSITORY}}/blob/v{{VERSION}}/docs/UPDATING.md). `Onyx: Check for Updates` tells you whether a newer release exists; it downloads nothing.

## Supported

This is the whole of what was tested. Everything else is best effort.

| | Supported | Best effort, untested |
|---|---|---|
| OS and hardware | macOS 14 or later, Apple silicon, 16 GB or more | Intel Macs, 8 GB |
| Runtime | Ollama {{OLLAMA_VERSION}} | LM Studio (benchmarked, not in the supported matrix), llama.cpp server, vLLM, other OpenAI-compatible servers |
| Models | `qwen2.5-coder:7b` for the agent, `qwen2.5-coder:1.5b` for autocomplete, at the digests in docs/SUPPORT.md | Everything else in the catalog |
| Workflow | Read, propose, review in a diff editor, accept or reject each hunk, verify what you accepted; inline edit; commit message; review; measure models on your repository | Tournament, architecture map, speculative measurement, idle review, constrained anchors |
| Extensions | Python, ESLint, Prettier and GitLens from Open VSX: {{EXTENSIONS}} | Anything else on Open VSX |

## What the agent can do

Tools a model can be given, with default settings, and what stands between each and your machine:

| Tool | Can | Gate |
|---|---|---|
| `readFile`, `listDirectory`, `findFiles`, `grep` | read | contained to the workspace |
| `editFile` | write | every edit is staged as a proposal; nothing changes until you accept it |
| `terminal` | execute | an approval dialog for every invocation: Run Once or Deny. There is no "always allow" |
| `repoSymbols`, `docs`, `playbook`, `debugState`, `usages`, `testFailure` | read | none needed |
| `remember` | persist | a confirmation showing the note and where its text came from |

Three network tools exist behind one opt-in setting that a repository cannot turn on. MCP tools, extension tools and upstream's Agent Host are not available. The full contract is in [docs/SUPPORT.md](https://github.com/{{REPOSITORY}}/blob/v{{VERSION}}/docs/SUPPORT.md).

## What to expect from the models

These are measurements from the reference machine (an M4 Pro with 24 GB), not promises, and they are not flattering.

{{FINDINGS}}

What this means in use: the review, approval and verification machinery is what was built and tested; the two pinned models rarely get as far as needing it on a real task. Larger local models may do better and were not measured. The report is [docs/research/REPORT.md](https://github.com/{{REPOSITORY}}/blob/v{{VERSION}}/docs/research/REPORT.md).

## Known limits

- Extension packages from Open VSX are not signature-verified: this build cannot run the verifier. They are fetched over HTTPS from open-vsx.org and nothing else is checked.
- No automatic updates, by design.
- Where a model runs is what the runtime reports. A runtime on this machine can forward a request elsewhere, and Onyx cannot see that; it says what it knows and what it does not.
- Extension update checks and recommendations are off by default, so that nothing asks the network unless you do. Turn `extensions.autoCheckUpdates` on if you want them.
- A clean file that stays clean after you accept a change is reported as "timed out", not "verified".
- An approval dialog that is open when you press Stop stays on screen; its answer is ignored.
- Reasoning models are handled by code tested on constructed transcripts, not against a real reasoning model.
- LM Studio is benchmarked (tool calling, speed, speculative decoding) but was in none of the research campaigns, and is not in the supported matrix.
- The energy and prompt-reuse figures are estimates; the report says how each was derived.
- macOS on Apple silicon only. No Windows or Linux build.
- The built-in extensions and the upstream Agent Host code are inside the application bundle and are not started.

## Experimental

Shipped, labelled, and outside the supported workflow: tournament, architecture map, speculative-decoding measurement, idle review, constrained anchors (off by default, a lab option only).

## Evidence for this release

- Gatekeeper (R-39): {{GATEKEEPER}}. Full command output is in `gatekeeper-evidence.json`, attached.
- Packaged smoke on the signed application, release mode: {{SMOKE}}. Report attached as `packaged-smoke-release.json`.
- Production readiness report: [docs/progress/production-readiness.md](https://github.com/{{REPOSITORY}}/blob/v{{VERSION}}/docs/progress/production-readiness.md).
- Clean-machine install run: {{CLEAN_INSTALL}}.
- Module gates 1 to 5: [docs/progress/STATE.md](https://github.com/{{REPOSITORY}}/blob/v{{VERSION}}/docs/progress/STATE.md).

## Reporting a problem

Open an issue at https://github.com/{{REPOSITORY}}/issues. For a security problem use the private advisory form linked from SECURITY.md, not an issue. `Onyx: Export Diagnostics` writes a bundle that by default holds no prompt text, file content, command or path.
