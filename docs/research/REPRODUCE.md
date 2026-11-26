# Reproducing the research report

*L19. What regenerates each table of [REPORT.md](REPORT.md) from committed data, what runs each campaign again, and which of these commands were actually run for this document. Run everything from the repository root with Node 24 (`.nvmrc`) and pnpm from corepack. Scripts are `.mts` files run directly by `node`.*

Three things to know before any command.

- **The analyses import compiled modules.** Every `analyze-*.mts` command imports from `out/`, so `out/` has to be built from the checked-out sources: `pnpm run transpile-client`, or `node test/onyx/run-fresh.mts --stamp-only`, which also writes the stamp the module gate reads.
- **The analyses write beside their input.** An `analyze-*.mts` command and `run-lab.mts --rescore` write into the results directory they are given. To compare without touching the committed files, copy the directory somewhere else, keep its name, and run the command on the copy. `make-report.mts` does this itself.
- **Two analyses read the repository's history.** `analyze-edits.mts`, `analyze-confidence.mts` and `--rescore` read each task's file at its commit with `git show`. A shallow clone cannot run them.

REPORT.md has tables and no figures. `results/2026-11-22-reference-measure/scorecard.svg` is the only chart under `results/`; it is written by the product's measure command during its campaign and is not regenerated from committed data by any command here.

## (a) One command per table

`node test/onyx/lab/make-report.mts` writes every table of REPORT.md, `data/numbers.json` and the indexes under `data/`. `node test/onyx/lab/make-report.mts --check` writes nothing and exits 1 on any difference or any number with no source. By default it runs eight of the nine analyses below on a temporary copy and fails if an output is not byte for byte the committed file; `--slow` adds the ninth, `analyze-edits.mts`, which took 651 seconds on the reference machine. `--skip-analyses` runs none and reads the committed outputs.

The table for each block, and the command that recomputes what it reads from the raw records:

| Table in REPORT.md | Reads | Command that recomputes it from committed raw records |
|---|---|---|
| section 3, `invariants` | `HARNESS-CONTRACT.md` | `node test/onyx/lab/make-report.mts` |
| section 4, `hypotheses` | every outcome file under `results/` | the commands of the ten rows below, then `node test/onyx/lab/make-report.mts` |
| section 5, `machine`, `models` | `results/2026-11-22-energy/manifest.json` | `node test/onyx/lab/make-report.mts` |
| section 5, `campaigns` | each `results.jsonl`, `summary.json`, `campaign.json` | `node test/onyx/lab/run-lab.mts docs/research/results/<dir>/manifest.json --rescore` for `results.jsonl` and `summary.json`; `campaign.json` is a record of the run and cannot be recomputed |
| section 5, `amendments` | `PREREGISTRATION.md` | `node test/onyx/lab/make-report.mts` |
| H-1, `h1` | `results/2026-11-22-assurance/summary.json`, `traces/` | none from committed data: `node test/onyx/sim/write-assurance.mts --out <dir>` runs the campaign again, see (b) |
| H-2, `h2` | `results/2026-11-22-attribution/results.jsonl`, `traces/records.jsonl`, `analysis.json` | `node test/onyx/lab/analyze-attribution.mts docs/research/results/2026-11-22-attribution` |
| H-3, H-4, H-5: `h3`, `h4`, `h5` | `results/2026-11-22-edit-mechanisms/analysis.json`, `attempts.jsonl` | `node test/onyx/lab/analyze-edits.mts --out docs/research/results/2026-11-22-edit-mechanisms --campaign docs/research/results/2026-11-22-single-turn --campaign docs/research/results/2026-11-22-confidence --campaign docs/research/results/2026-11-22-attribution --anchors docs/research/results/2026-11-22-anchors-2` |
| H-6, `h6` | `results/2026-11-22-determinism/determinism.json`, `results/2026-11-22-determinism-2/determinism.json` | `node test/onyx/lab/analyze-determinism.mts docs/research/results/2026-11-22-determinism-2`; the same on `2026-11-22-determinism`, which exits 1 because it finds the harness's divergences and writes its verdict as `outcome-H-6.json` (the committed copy of that file is `first-run-verdict.json`) |
| H-7, `h7` | `results/2026-11-22-rankings-onyx/rankings.json` | `node test/onyx/lab/analyze-rankings.mts docs/research/results/2026-11-22-rankings-onyx docs/research/results/2026-11-22-rankings-brew` |
| H-8, `h8` | `results/2026-11-22-confidence/confidence.json` | `node test/onyx/lab/analyze-confidence.mts docs/research/results/2026-11-22-confidence` |
| H-9, `h9` | `results/2026-11-22-eviction-scripted/eviction.json`, `probe.jsonl` | `node test/onyx/lab/analyze-eviction.mts docs/research/results/2026-11-22-eviction-scripted docs/research/results/2026-11-22-eviction-agentic` |
| H-10, `h10` | `results/2026-11-22-energy/energy.json` | `node test/onyx/lab/analyze-energy.mts docs/research/results/2026-11-22-energy --idle-watts 2` |
| section 8, `totals` | each `results.jsonl` and `traces/records.jsonl` | `node test/onyx/lab/make-report.mts` counts them itself |
| section 10, the injection numbers | `results/2026-11-22-injection/injection.json` | `node test/onyx/lab/analyze-injection.mts docs/research/results/2026-11-22-injection` |

Other checks that need no model:

```bash
node --test test/onyx/checks/r58-report.test.mts                                   # R-58
node test/onyx/lab/manifest.mts --results docs/research/results/<dir>              # a results directory is well formed
node test/onyx/lab/describe-task-set.mts docs/research/results/2026-11-22-task-set # every task's hashes match the repository
node test/onyx/sim/export-episodes.mts --check                                     # the mutant descriptors match their source
```

## (b) Running a campaign again

A campaign needs a runtime on this machine that already has the models; nothing is downloaded. The campaigns of this report used a private Ollama 0.33.0 started as `OLLAMA_CONTEXT_LENGTH=16384 ollama serve` on a free port (the manifests say `127.0.0.1:11500`), a bare local clone of the repository for `--repo` (`git clone --local --bare`), and for tier A a frozen copy of the compiled application (`node test/onyx/lab/freeze-app.mts`, see `docs/progress/L9.md`). The models are `qwen2.5-coder:7b`, `qwen2.5-coder:1.5b` and `llama3.2:3b` at the digests in REPORT.md, section 5.1. A campaign resumes: a unit with a record is not run again, so run a manifest in a copy of its directory without `traces/` to start from nothing. A second run will not give the same bytes: durations and load are recorded. At temperature 0 the scored outcomes should repeat.

Seconds are those of the reference machine, an Apple M4 Pro with 24 GiB, from the machine-time line of `docs/progress/STATE.md`; most were taken while the machine was busy.

| Campaign | Command | Needs | Seconds |
|---|---|---|---|
| H-1 | `node test/onyx/sim/write-assurance.mts --out <dir>` | a fresh `out/`; no model. 50,000 episodes and every mutant, on all cores | 602 and 59 |
| H-1, smaller | `ONYX_SIM_EPISODES=2000 ./scripts/test.sh --grep "OnyxSim"` or `node test/onyx/sim/run-campaign.mts --episodes 20000 --seed 1` | a fresh `out/`; no model | not recorded |
| datasheets | `node test/onyx/lab/measure-models.mts --base-url <the runtime's /v1> --model qwen2.5-coder:7b --model qwen2.5-coder:1.5b --model llama3.2:3b --out <dir>` | the runtime, three models | 360 |
| engine, tier S | `node test/onyx/lab/run-lab.mts docs/research/results/2026-11-22-engine-tier-s/manifest.json` | the runtime, three models | 428 |
| engine, tier A | `node test/onyx/lab/run-lab.mts docs/research/results/2026-11-22-engine-tier-a/manifest.json` | the runtime, two models, the application | 106 for the run that was replaced; 75 for the committed one |
| task set | the `make-task-set.mts` command in `results/2026-11-22-task-set/manifest.json` | the repository's history; no model | not recorded |
| reference measure | `node test/onyx/lab/run-lab.mts docs/research/results/2026-11-22-reference-measure/manifest.json` | the runtime, three models, the application | 1,257, after an earlier run stopped at 1,189 |
| H-2 | `node test/onyx/lab/run-lab.mts docs/research/results/2026-11-22-attribution/manifest.json` | the runtime, two models, the application | 6,630 |
| injection | `node test/onyx/lab/make-injection-fixture.mts --out <dir>`, then `node test/onyx/lab/run-lab.mts docs/research/results/2026-11-22-injection/manifest.json --repo <dir>` | the runtime, two models, the application, the fixture repository | 282 |
| H-7 | `node test/onyx/lab/run-lab.mts docs/research/results/2026-11-22-rankings-onyx/manifest.json`; the same for `2026-11-22-rankings-brew` with `--repo <a clone of Homebrew/brew>` | the runtime, three models; for the second, Homebrew/brew's history | 1,417 and 1,087 |
| H-3 | `node test/onyx/lab/run-lab.mts docs/research/results/2026-11-22-single-turn/manifest.json` | the runtime, two models | 1,952 |
| H-4 | `node test/onyx/lab/run-lab.mts docs/research/results/2026-11-22-anchors-2/manifest.json` | the runtime, two models, the application | 1,322 (the superseded one 1,291) |
| H-6 | `node test/onyx/lab/run-lab.mts docs/research/results/2026-11-22-determinism-2/manifest.json` | the runtime, two models, the application | 770 (the invalid one 737) |
| H-8 | `node test/onyx/lab/run-lab.mts docs/research/results/2026-11-22-confidence/manifest.json` | the runtime, two models, token log-probabilities | 4,081 |
| H-9, agentic | `node test/onyx/lab/run-lab.mts docs/research/results/2026-11-22-eviction-agentic/manifest.json` | the runtime, two models, the application | 536 |
| H-9, scripted | `node test/onyx/lab/eviction-script.mts --out <dir> --base-url <the runtime's address> --model qwen2.5-coder:7b --model qwen2.5-coder:1.5b --repetitions 3`; the probe is the same command with `--probe` and no `--out` | the runtime's native API, two models | 1,731 |
| H-10 | `node test/onyx/lab/power-sampler.mts --probe`, then `node test/onyx/lab/run-lab.mts docs/research/results/2026-11-22-energy/manifest.json` with the sampler running | the runtime, three models, a laptop whose battery controller reports power, nothing else running | 1,866 |

After a campaign, the analysis command of (a) writes its outcome file. LM Studio was never measured, and no command here starts it.

## (c) Commands run for this document

Run on the reference machine on 2026-11-22 and 2026-11-24, on branch `module-5`. "Matched" means the regenerated file was compared with the committed file and was the same byte for byte. Analyses and rescoring were run on a copy of the results directory in a temporary folder, with the command otherwise as written.

State of `out/` when the analyses ran: it had no fresh-output stamp (`out/.onyx-fresh.json` was absent), so `run-fresh.mts` would call it not fresh. The five compiled modules the analyses import were built on 2026-11-22 after their sources were last changed, and `git status` showed no change under `src/`. The byte-for-byte matches below are the evidence that they were current.

| Command | Date | Ran | Exit | Regenerated output against the committed file |
|---|---|---|---|---|
| `node test/onyx/lab/analyze-attribution.mts <copy of 2026-11-22-attribution>` | 2026-11-22, 2026-11-24 | yes | 0 | `analysis.json`, `ANALYSIS.md`, `outcome.json`: matched |
| `node test/onyx/lab/analyze-rankings.mts <copies of rankings-onyx, rankings-brew>` | 2026-11-22, 2026-11-24 | yes | 0 | `rankings.json`, `outcome-H-7.json`: matched |
| `node test/onyx/lab/analyze-determinism.mts <copy of 2026-11-22-determinism-2>` | 2026-11-22, 2026-11-24 | yes | 0 | `determinism.json`, `outcome-H-6.json`: matched |
| `node test/onyx/lab/analyze-determinism.mts <copy of 2026-11-22-determinism>` | 2026-11-22, 2026-11-24 | yes | 1, as it should be | `determinism.json`: matched. Its `outcome-H-6.json` matched the committed `first-run-verdict.json` |
| `node test/onyx/lab/analyze-confidence.mts <copy of 2026-11-22-confidence>` | 2026-11-22, 2026-11-24 | yes | 0 | `confidence.json`, `outcome-H-8.json`: matched |
| `node test/onyx/lab/analyze-eviction.mts <copies of eviction-scripted, eviction-agentic>` | 2026-11-22, 2026-11-24 | yes | 0 | `eviction.json`, `summary.json`, `outcome-H-9.json`: matched |
| `node test/onyx/lab/analyze-energy.mts <copy of 2026-11-22-energy> --idle-watts 2` | 2026-11-22, 2026-11-24 | yes | 0 | `energy.json`, `outcome-H-10.json`: matched |
| `node test/onyx/lab/analyze-injection.mts <copy of 2026-11-22-injection>` | 2026-11-22, 2026-11-24 | yes | 0 | `injection.json`: matched |
| `node test/onyx/lab/analyze-edits.mts --out <temporary folder> --campaign … --anchors …` (the command of (a)) | 2026-11-22 | yes, once, 651 s | 0 | all seven files (`attempts.jsonl`, `analysis.json`, `ANALYSIS.md`, `sources.json`, three outcome files): matched |
| `node test/onyx/lab/make-report.mts --slow` | | **no** | | not run: it repeats the line above, about ten minutes of processor time, and the machine was on battery with another session measuring on it. The edits analysis was run directly instead |
| `node test/onyx/lab/run-lab.mts <copy>/manifest.json --rescore`, for each of the 15 campaign directories | 2026-11-22 | yes | 0 for all | `results.jsonl`, `summary.json`: matched for 13. **Not for `2026-11-22-injection` and `2026-11-22-rankings-brew`**: each said "rescored 0 records" and wrote empty results, because their tasks are in other repositories (the fixture, Homebrew/brew) that were removed after the campaigns and `--repo` was not given. Their committed scores were not reproduced here |
| `node test/onyx/lab/describe-task-set.mts <copy of 2026-11-22-task-set>` | 2026-11-22 | yes | 0 | `summary.json`, `trace-digests.json`: matched; "120 tasks, 0 that do not match the repository" |
| `node test/onyx/lab/manifest.mts --results docs/research/results/<dir>`, for each of the 23 directories | 2026-11-22 | yes | 0 for all | writes nothing. "manifest: valid" for 22; "1 problem" for `2026-11-22-edit-mechanisms`, which has `sources.json` and no manifest |
| `node test/onyx/sim/export-episodes.mts --check` | 2026-11-22 | yes | 0 | writes nothing; "mutants: 41 descriptors in sync" |
| `node test/onyx/lab/make-report.mts` | 2026-11-24 | yes | 0 | wrote the tables, `numbers.json` and the indexes |
| `node test/onyx/lab/make-report.mts --check` | 2026-11-24 | yes | 0 | eight of nine analyses run and matched; every table, number and index matched; no unsourced number in REPORT.md or in the README's Research section |
| `node --test test/onyx/checks/r58-report.test.mts` | 2026-11-24 | yes | 0 | two tests passed |
| `node test/onyx/sim/write-assurance.mts --out <dir>` | | **no** | | not run: 50,000 episodes on all cores. H-1's table is read from the committed `summary.json` and was not recomputed by anything for this document |
| `./scripts/test.sh --grep "OnyxSim"`, at any size, and `node test/onyx/sim/run-campaign.mts` | | **no** | | not run: `out/` had no fresh-output stamp, and the machine was to be kept quiet for another session's measurement |
| the `make-task-set.mts` command of the task set's manifest | | **no** | | not run: it scans about 40,000 commits. `describe-task-set.mts` checked the committed set against the repository instead |
| every `run-lab.mts` command without `--rescore`, `eviction-script.mts`, `measure-models.mts`, `measure-anchor-enum.mts`, `power-sampler.mts` | | **no** | | not run: each needs a model runtime, and none was to be started. No campaign was repeated for this document |
| `node test/onyx/run-module-gate.mts` and the end-to-end suite | | **no** | | not run: they start the application |

What this table does and does not establish. Every outcome file of H-2 to H-10 was recomputed from the committed raw records and matched. H-1 was not recomputed. The raw records themselves were not regenerated: no campaign was run again, so nothing here tests whether a second run of a campaign would give the same records.
