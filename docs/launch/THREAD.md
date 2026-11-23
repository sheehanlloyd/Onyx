# Thread (draft)

Not posted. Seven posts. Every number links to a committed file; the base for the links is the repository at the release tag.

**1.**
I spent months building a local-model code editor, then measured it properly. On real tasks from its own git history, no model reproduced a single one: 0 of 3,182 attempts. Here is what I built, what I measured, and why I am publishing it anyway.
→ docs/research/REPORT.md

**2.**
It is a fork of Code - OSS (the open-source base of VS Code) for Apple-silicon Macs. Models run on your machine through Ollama. The premise: a small local model is an untrusted component, so the editor around it has to be the part you can rely on.

**3.**
So an edit is a proposal until you accept it, per hunk, and it is placed only where its quoted text matches your file exactly, once. I tested the usual alternative, a fuzzy applier: it placed 28.7 points more edits, and 53.8% of attempts under it ended silently wrong.
→ docs/research/results/2026-11-22-edit-mechanisms/

**4.**
Every shell command asks, every time. There is no "always allow", and nothing a repository contains can grant it. The harness has a written contract of fourteen invariants and a simulator that attacks them: 50,000 of 50,000 seeded episodes without a violation, and 41 of 41 planted defects caught.
→ docs/research/results/2026-11-22-assurance/

**5.**
The unflattering part, in full. Under the product's own settings, neither of the two models I ship it tested with proposed an edit in 320 agent runs on real tasks. Of ten hypotheses I registered in advance, four are supported, one is refuted and five are inconclusive, mostly because nothing succeeded often enough to compare.
→ docs/progress/L13.md

**6.**
One thing did surprise me in the other direction: with temperature 0 and a fixed seed, 160 of 160 repeated agent runs on a local runtime were identical. The first attempt at that study failed, 146 of 160, and the cause was a bug in my own harness that the study found.
→ docs/research/results/2026-11-22-determinism-2/

**7.**
One machine, three small models, two repositories, one person. Bigger models may do much better; I have not measured them. If you run local models on a Mac and want to try it or tear the method apart: the signed build, what is supported, and one command per number are here.
→ [release link] · docs/SUPPORT.md · docs/research/REPRODUCE.md
