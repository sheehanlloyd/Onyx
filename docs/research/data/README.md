# Reproduction data

*L19. Everything here except this file is written by `node test/onyx/lab/make-report.mts` from committed files, and `node test/onyx/lab/make-report.mts --check` fails when one of them is out of date. Nothing under `results/` or `test/onyx/sim/` is copied here: the indexes point at it.*

| File | What it is | Generated from |
|---|---|---|
| `numbers.json` | Every number [REPORT.md](../REPORT.md) and the README's Research section may quote: an id, the value, a denominator and an interval where there is one, the source file, the place in it or how it was counted, and how it was derived. Its head lists the analysis commands that are run again and the kinds of token the docs check does not treat as a number | the outcome, summary and analysis files under `results/`, the raw `results.jsonl` and `traces/records.jsonl`, and quotations from `PREREGISTRATION.md` |
| `simulation-index.json` | Where the simulation rig is, by path: the rig, the fakes, the invariant checkers, the shrinker, the scenarios, the mutants, the runners, and the 27 scripted workflows with their personas | the files under `src/vs/workbench/contrib/onyx/test/browser/sim/` and `test/onyx/sim/episodes/`. The one-line description of each rig file is written in `make-report.mts`; the script fails if a file is added or removed without one |
| `counterexamples.json` | The shrunk scripts of violations found during development, by seed. Each was removed from `test/onyx/sim/baseline/` by the commit that fixed its class, so each is named at the revision before that commit, with the `git show` command that prints it. A second list has the seeds at which a campaign printed a violation that was judged the rig's own error; no shrunk script was committed for those | `results/2026-11-22-assurance/summary.json`, the scripts read from history for their seeds, and `results/2026-11-22-assurance/NOTES.md`. It needs the repository's history |
| `injection-corpus.json` | The simulated injection corpus (path, 80 episodes, surfaces, effects, what is not simulated) and the fixture of the real-model injection run (its generator, 24 tasks, how many carry a planted instruction) | `results/2026-11-22-assurance/summary.json`, `results/2026-11-22-injection/tasks.json` |
| `mutants.json` | The mutation corpus: the 41 mutants, each with the defect it puts back, the item that fixed that defect, the violation the campaign must report, the test-only class that resurrects it, and whether the committed run detected it and at which seed | `test/onyx/sim/mutants/*.json`, `results/2026-11-22-assurance/traces/mutation.json` |
| `task-sets.json` | The task set's hash, the SHA-256 of its `tasks.json`, where the per-task hashes are, and for each campaign the name, hash and count of the subset it used | `results/2026-11-22-task-set/`, each campaign's `manifest.json` and `tasks.json` |

How a number in `numbers.json` was derived:

- `committed`: read from a committed JSON file at the path given.
- `analysis`: read from the output of the `analyze-*.mts` command named. `make-report.mts` runs that command on a temporary copy of the committed raw records and fails if its output differs from the committed file by a byte. The command behind H-3 to H-5 takes about ten minutes and is run only with `--slow`; without it those values are the committed ones, and the counts among them are counted again from `attempts.jsonl`.
- `recount`: counted by `make-report.mts` itself from `results.jsonl` or `traces/records.jsonl`. The cross-campaign totals are of this kind, and each says which campaigns it sums.
- `registered`: a threshold or a size quoted from `PREREGISTRATION.md`. The quotation is checked to be in that file.

What is not here. No raw record is duplicated: they are under `results/<campaign>/`. The shrunk scripts of the rig's own bookkeeping errors do not exist as files. The Homebrew/brew clone and the injection fixture repository that two campaigns read were removed after the campaigns; the fixture can be written again by its generator, and [REPRODUCE.md](../REPRODUCE.md) says what could not be recomputed without them.
