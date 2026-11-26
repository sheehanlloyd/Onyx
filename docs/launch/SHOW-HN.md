# Show HN (draft)

Not posted. Post only after the signed release is published and the links resolve.

**Title:** Show HN: Onyx, a local-model code editor whose own benchmarks say 0 of 3,182

**URL:** the repository

**Text:**

Onyx is a fork of Code - OSS (the open-source base of VS Code) for Apple-silicon Macs that runs coding models locally through Ollama. I built it on the premise that a small local model is an untrusted component, and then I measured the result. The headline measurement is not flattering, so I will lead with it:

On tasks taken from real commits of two repositories, no model reproduced a task exactly in any campaign: 0 of 3,182 attempts, across three models of 7B and under. Under the product's own configuration, the two models it is tested with did not get an edit as far as staging in 320 agent runs (in 18, the edit call was rejected for malformed arguments). You can regenerate those numbers from the committed raw data:

    node test/onyx/lab/make-report.mts --check

What the editor does guarantee is narrower, and it is the part I can stand behind:

- A model's edit is a proposal until you accept it, per hunk, and is placed only where its quoted text matches your file exactly and once. I compared that with a fuzzy applier on the same model output: the fuzzy one placed 28.7 points more edits, and 53.8% of attempts under it ended silently wrong.
- Every shell command asks, every time. No "always allow"; nothing in a repository can grant it.
- The agent loop has a written contract of fourteen invariants and a deterministic simulator with an adversarial model, a user who edits mid-run and a faulty environment. 50,000 of 50,000 seeded episodes ran without a violation, and each of 41 test-only mutants (36 of them defects I had fixed, put back) was detected.
- With temperature 0 and a fixed seed, 160 of 160 repeated agent runs on Ollama were identical. The first run of that study got 146 of 160, and the cause was a defect in my harness that the study found.

Ten hypotheses were registered before their data existed. Four are supported, one is refuted, five are inconclusive, mostly at a floor of zero successes. The report gives each the same space: docs/research/REPORT.md. Related work, read at its source and dated, is in docs/research/RELATED.md; close prior work exists for each technique, and what is here is a setting and a set of replications, not an invention.

Limits you should know before trying it: one machine (an M4 Pro with 24 GB), one person, three small models, two repositories. Larger local models may do far better and I have not measured them. LM Studio is benchmarked but was in none of the research campaigns. macOS on Apple silicon only. It is an experimental alpha and says so in its title bar. There is no telemetry, and the repository has a capture of what the application sends over the network and what that capture could not see.

Being a fork has real costs (monthly upstream merges, no Microsoft marketplace, no extension signature verification), and docs/DESIGN.md lists them. If the host exposed staging and per-command approval as extension points, most of the fork would be unnecessary.

I would most like to hear from people who run local models daily: where the method is wrong, and what happens with a model I could not fit.

Download, supported matrix and tool list: [release link], docs/SUPPORT.md
