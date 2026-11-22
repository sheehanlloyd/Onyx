# Module 4: what the gate found before it passed

The first run of `node test/onyx/run-module-gate.mts --module 4` (at 091b9c67374, clean tree, fresh output, the packaged application rebuilt from the same revision) ended:

```
87 checks: 86 passed, 0 expected failure(s), 0 skipped, 1 blocking
  blocking: R-52-campaign (fail) — campaign: 50000 of 50000 episodes with no violation, in 521 s; exit 0 ⏎ mutants: 41 of 41 killed, in 87 s; the test's exit 0 ⏎ write-assurance: the manifest it would write is invalid: ⏎   manifest.name: "gate-assurance" does not match ^[0-9]{4}-[0-9]{2}-[0-9]{2}-[a-z0-9][a-z0-9-]*$
module 4 gate: FAILED
```

The campaign had passed and every mutant had been killed. What failed was the gate entry itself: it told `write-assurance.mts` to write into `.build/gate-assurance`, and the script names its manifest after its directory and refuses a name that is not a results directory's. The entry had never been run through the gate before; the script had only been run with a dated directory. The entry now gives `.build/gate-assurance/0000-00-00-gate`. No check was removed, loosened or skipped.

The run that passed is on d88beede49f, the commit of that correction, with the packaged application rebuilt from it:

```
87 checks: 87 passed, 0 expected failure(s), 0 skipped, 0 blocking
module 4 gate: PASSED
```

`gate-module-4.json` beside this file is that run. It includes Modules 1 to 3: 23, 24 and 21 checks, with the end-to-end suite ("all 72 checks passed"), the packaged application in baseline and release mode, and the 20,000-episode campaigns of Modules 2 and 3.

## Earlier in the session

Two things failed before the gate was run and are in the items' reports, not here: the evidence checks failed in CI from L10's merge until the CI job was given the repository's history (`codex/m4-ci-history`), and one evidence check written late in the session asked for a line of descent that does not exist (`docs/progress/L18.md`, "Gate output").
