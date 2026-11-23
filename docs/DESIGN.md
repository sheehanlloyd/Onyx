# Design: what the measurements changed, and why this is a fork

Short on purpose. The architecture is in [ONYX.md](../ONYX.md); what each part promises is in [SUPPORT.md](./SUPPORT.md). This page records the decisions that came from a measurement and not from a plan, and what being a fork costs.

## Three decisions the measurements changed

### 1. The tool loop assumes the native tool-call channel will fail

The first design sent tools through the runtime's tool-call channel, as every OpenAI-compatible client does. Measured: both pinned qwen2.5-coder models used that channel in 0 of 6 requests on Ollama, although the runtime advertises tool support for them, and wrote the call as prose instead ([report](./benchmarks/2026-11-21/report.json)); the model datasheets found the same, 0 of 5 for each ([datasheets](./research/results/2026-11-21-datasheets/)).

What changed: the loop reads tool calls out of text as a matter of course, repairs their markers but never their content, and can constrain a turn to a JSON schema where the runtime enforces one. A model's advertised capability is not used to configure anything. A one-minute datasheet measured on the user's machine is (L5).

### 2. Speculative decoding is measured, never assumed

Pairing a 7B target with a 0.5B draft was expected to speed generation up. Measured in August 2026 on the reference machine: 0.72 times the speed, 48.0 down to 34.4 tokens a second. The raw report was not kept, so this number has no chart and is quoted as an older, unreproduced measurement.

What changed: the feature is a measurement, not a setting. It runs the same prompt with and without the draft on the user's machine and reports the ratio, including when the ratio is below one. It is outside the supported workflow.

### 3. The model's own account of what it did is not evidence

A local reviewer handed a diff containing a plain off-by-one reported no problems. A 7B model told to run a destructive command replied that it had been executed without calling the terminal tool; nothing ran. Both are in the README's known failure cases.

What changed: nothing the model says is taken as a fact about the workspace. An edit is a proposal until the user accepts it, placed only where its quoted text matches exactly and once (DEC-07). A command runs only after an approval of that exact invocation. "Verified" is said only of code the user accepted, by a check that ran after the acceptance. The run journal, not the transcript, is the record.

## What Module 4's studies decided

| Question | Result | Decision |
|---|---|---|
| Does a fuzzy applier place more edits than exact-or-refuse, and at what cost? (H-3) | It places 28.7 points more blocks, and 53.8% of attempts under it end silently wrong | Exact-or-refuse stays the only applier in the product |
| Do constrained anchors help? (H-4) | Inconclusive: no task had an edit call in both arms | Anchors stay opt-in, a lab option |
| Is an edit grounded in a certificate better? (H-5) | Refuted at the registered threshold: 0.021 higher, under 0.05 | Certificates are kept as a record of what was checked, not as a quality claim |
| Can a hunk carry a calibrated confidence? (H-8) | Inconclusive: 6 correct of 120 labelled hunks | No confidence badge ships |
| Does block eviction save prompt re-processing? (H-9) | Supported on scripted runs, by an estimate; no eviction happened in agent runs | The policy is a lab option; the product default is unchanged |
| Which model should be recommended? (H-7, H-10) | Inconclusive: no model solved a task | No ranking is published; the recommendation question is open |

Each row links from [research/REPORT.md](./research/REPORT.md) to its raw result.

## Why a fork, and what it costs

An extension cannot do three things this product depends on: stage every model edit behind its own review surface with no other write path, gate every shell invocation with its own dialog and exclude the tools that would bypass it, and remove the sign-in and cloud chat surfaces instead of sitting beside them. Those are properties of the host, so the host is forked.

The cost is real and recurring:

- **Upstream merges.** The move to upstream 1.147.0 was one merge of 7,778 commits: nineteen conflicts and six problems that merged cleanly and broke at run time ([REBASE.md](../REBASE.md)). Upstream ships monthly. Every month skipped makes the next merge larger, and a fork that stops merging stops receiving security fixes.
- **A second identity to maintain.** Product name, icons, bundle identifier, update path, signing certificate and notarization are all the fork's own problem.
- **No Microsoft marketplace and no signature verifier.** Extensions come from Open VSX, whose catalogue is smaller, and this build cannot verify their signatures.
- **Inherited code that is shipped and not used.** The Agent Host and the built-in Copilot sources are in the tree and partly in the bundle. They are switched off, not removed.
- **Trust.** A forked editor asks a user to trust a second party with their source tree. The answer offered here is evidence: a written contract, a simulation that checks it, and a capture of what the application sends over the network.

If the host exposed staging, per-invocation approval and tool exclusion as extension points, most of this fork would be unnecessary, and that would be the better outcome.
