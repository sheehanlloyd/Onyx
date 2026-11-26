# Measuring a local-model coding harness: ten registered hypotheses on one laptop

*L19. Every table below is written by `node test/onyx/lab/make-report.mts` from committed data, and every number in the prose is in [data/numbers.json](data/numbers.json) with its source. `node test/onyx/lab/make-report.mts --check` fails when a table or a number no longer agrees with the data (regression R-58). The commands are in [REPRODUCE.md](REPRODUCE.md).*

## Abstract

Onyx is a code editor whose agent runs on models served on the user's own machine. This report gives the outcome of ten hypotheses about its harness, each registered with its thresholds before its data existed. Three facts come before any result. No model reproduced a real task exactly in any campaign: 0 of 3,182 attempts, single-turn and agentic, on tasks from two repositories. Under the tool-call protocol the product derives for its two pinned models, neither model got an edit as far as the record in any of 320 agent runs on real tasks; in 18 of those runs the smaller model called the edit tool with arguments the tool rejected. Five of the ten hypotheses are inconclusive, and three of those five (H-2, H-7, H-10) are inconclusive at a floor of zero successes, which says nothing about the question asked.

Four hypotheses are supported, one is refuted and five are inconclusive. Supported: a seeded simulation campaign detected all 41 mutants of the harness and ran 50,000 episodes with no violation, on its second run (H-1). A fuzzy edit applier placed 28.7 points more blocks than the product's exact-or-refuse applier, and 53.8% of attempts ended silently wrong under it (H-3). At temperature 0 with a fixed seed, 160 of 160 repetitions of short agent trajectories were identical, in the second campaign; the earlier one was invalidated by a harness defect it found (H-6). Evicting context in blocks re-processed an estimated 0.42 of the prompt tokens that the product's policy did in a scripted run; the hypothesis's success condition was met with no eviction occurring and no run succeeding (H-9). Refuted: grounded edits scored 0.021 higher than ungrounded ones, under the registered 0.05 (H-5). Inconclusive: H-2, H-4, H-7, H-8 and H-10.

The measurements are from one machine, one operator, one runtime, three small models and two repositories. No hypothesis campaign ran on LM Studio; it is benchmarked separately ([BENCHMARKS](../BENCHMARKS.md)). No score anywhere is a model's opinion of another model's output.

## 1 Thesis

Read this section with three facts in mind. No model reproduced a real task exactly in any campaign: 0 of 3,182 attempts. Under the product's own tool-call protocol neither pinned model got an edit on record in 320 agent runs, and 18 of those runs ended with an edit call the tool rejected. Five hypotheses are inconclusive, three of them at a floor of zero successes.

The thesis is the one in [README.md](README.md). Local inference changes what a coding harness can be. Trials cost time and nothing else, so a harness can be measured. Weights are pinned by digest, so a measurement names the exact model. The decoder can be constrained, so a protocol can be enforced. The code under test never leaves the machine, so the user's own repository can be the benchmark. Onyx treats the model as an untrusted, measurable component: every guarantee in the harness contract is meant to hold for any model output, and every published number regenerates from committed data.

What the data supports is one half of that sentence more than the other. The harness's guarantees held under simulation, and the measurement apparatus found three defects in itself and said so. The measurements of what small local models do inside the harness are mostly floors. The harness can be measured. With these models, on these tasks, there was little success to measure.

## 2 Contributions

The scope of each item is the one [RELATED.md](RELATED.md) allows in its last section, which was checked against the literature on 2026-11-22. Nothing here is a claim of priority.

- **A setting.** A task set mined from one repository's history with one added rule: every task's commit is later than the publication date of every installed model. 120 tasks. Task mining from history and date rules both exist elsewhere; the combination on a private repository is a setting, and its tasks proved too hard for the pinned models.
- **A replication.** Three existing analysis designs repeated in a different sample: a factorial attribution of harness components with Shapley values (H-2, a null result), the trade between refusing uncertain edit placements and misapplying them (H-3, with comparators written for the study), and two training-free confidence estimators for edit hunks (H-8, inconclusive).
- **An application.** Deterministic simulation testing, mutation scoring of harness tests, record-and-replay, grammar-constrained anchors and cache-aware eviction are established techniques. This project applies them to the harness of a local-model code editor and reports what happened on its own code.
- **An artifact.** The harness contract, the simulation rig, the 41 mutants, the campaign engine, the raw records of every campaign, and a script that regenerates this report's tables and refuses a number with no source.

## 3 The harness contract

The contract is fourteen invariants, I-01 to I-14 ([HARNESS-CONTRACT.md](HARNESS-CONTRACT.md)). Each has an observable definition over the simulation rig's trace and a checker. The table quotes the guarantee and the boundary at which it is checked.

<!-- generated:invariants -->
| Invariant | Guarantee | Checked at |
|---|---|---|
| I-01 | No model-authored text reaches a live buffer or the disk before an explicit accept of that proposal generation and hunk | every boundary |
| I-02 | No command is dispatched without an affirmative approval recorded for that exact invocation | after tool dispatch |
| I-03 | Every run ends in exactly one terminal status, within its turn and time budget, and that status never changes afterwards | every boundary and end |
| I-04 | No request exceeds the effective context budget, and every request carries an output cap | at request time |
| I-05 | After Stop, no further tool is dispatched and no further proposal is staged, and an approval dialog open at the Stop is closed by it | every boundary |
| I-06 | Only tools in the capability contract are dispatched; an unknown or schema-invalid call produces an error result, never a dispatch | after tool dispatch; at request time |
| I-07 | No tool reads or writes outside the workspace roots, including through symlinks, absolute paths and traversal | after tool dispatch |
| I-08 | An edit that cannot be placed exactly and uniquely changes nothing and produces a visible reason | after stage |
| I-09 | Accepting a hunk applies that hunk's reviewed content or nothing, and user edits made at any point survive | after stage, after run |
| I-10 | Seeded secrets never appear in a default diagnostics export, and scrubbed environment variables never reach a child process | at command dispatch; at the end |
| I-11 | A truncated, stalled or malformed stream is never reported as complete and never applied | end |
| I-12 | The trace is complete and ordered: every model request, tool dispatch, approval and acceptance appears once, and replaying the trace reproduces the same event sequence | end |
| I-13 | Retained output, proposal size and queue lengths stay under their documented caps for any input | after stage; while a command runs; at the end |
| I-14 | Nothing a model asks to persist (a memory fact, a pin, a playbook) can influence a later prompt before the user confirms it with its origin shown | every boundary |
<!-- /generated:invariants -->

## 4 Hypotheses and outcomes

Statements are as registered. Outcomes are decided by the registered thresholds and nothing else. Supported, refuted and inconclusive outcomes are in one table in registration order.

<!-- generated:hypotheses -->
|  | Statement, as registered | Outcome | The number | Of | 95% interval | Results |
|---|---|---|---|---|---|---|
| H-1 | The simulation campaign detects every resurrected defect in the mutation corpus | **supported** | 41 mutants detected; 50,000 episodes with no violation, on the second run | 41 mutants; 50,000 episodes | none: a count | [`2026-11-22-assurance`](results/2026-11-22-assurance/) |
| H-2 | For models at or below 7B, tool-call protocol handling contributes more to task success than any other harness component, and the gap narrows with model size | **inconclusive** | 0 runs reproduced a task: a floor | 960 agent runs, 12 configurations | none: every value is 0 with a zero-width interval | [`2026-11-22-attribution`](results/2026-11-22-attribution/) |
| H-3 | Exact-or-refuse loses a measurable share of edits relative to fuzzy appliers and prevents a non-zero share of silently wrong edits | **supported** | the fuzzy comparator places 28.7 points more blocks than exact-or-refuse; 53.8% of attempts end silently wrong under it | 1,301 attempts | [26.1, 31.3] points; [51.1%, 56.5%] | [`2026-11-22-edit-mechanisms`](results/2026-11-22-edit-mechanisms/) |
| H-4 | Constrained anchors lower the refusal rate relative to free-form SEARCH/REPLACE under exact-or-refuse, without raising the collateral-edit rate | **inconclusive** | 0 tasks with an edit call in both arms | 40 tasks; 55 edit calls in all | none: there is no pair to compare | [`2026-11-22-edit-mechanisms`](results/2026-11-22-edit-mechanisms/) |
| H-5 | Edits whose anchor was not in the model's context that turn score lower than grounded edits | **refuted** | grounded edits score 0.021 higher, under the registered 0.05 | 163 grounded and 36 ungrounded edits | [0.009, 0.034] | [`2026-11-22-edit-mechanisms`](results/2026-11-22-edit-mechanisms/) |
| H-6 | At temperature 0 with a fixed seed on one machine, at least 90% of multi-turn trajectories repeat exactly | **supported** | 160 repetitions identical, on the second campaign; the first, 146 of 160, was invalidated by a harness defect it found | 160 comparisons | [97.7%, 100.0%] | [`2026-11-22-determinism-2`](results/2026-11-22-determinism-2/) |
| H-7 | Model rankings differ between repositories often enough to change which model a user should pick | **inconclusive** | 0 tasks solved by any of three models in either of two repositories: a floor | 40 tasks a repository | none: no repository has a ranking | [`2026-11-22-rankings-onyx`](results/2026-11-22-rankings-onyx/) |
| H-8 | Sample agreement or token probability predicts hunk correctness better than chance by a pre-registered margin | **inconclusive** | 6 correct hunks; 20 of each class were needed | 120 labelled hunks | AUROC [0.384, 0.687] and [0.299, 0.885]: both include 0.5 | [`2026-11-22-confidence`](results/2026-11-22-confidence/) |
| H-9 | A cache-aware eviction policy re-processes fewer prompt tokens per turn than oldest-first at equal task success | **supported** | block eviction re-processes 0.42 of oldest-first's prompt tokens, by an estimate from prompt-evaluation time; the success condition was met with no eviction occurring and no run succeeding | 90 paired turns; 40 agentic runs a policy | [0.38, 0.47] | [`2026-11-22-eviction-scripted`](results/2026-11-22-eviction-scripted/) |
| H-10 | Energy per solved task ranks models differently from tokens per second | **inconclusive** | 0 models solved a task; energy an attempt 508 J, 352 J, 870 J, which decides nothing | 3 models, 72 attempts each | none: no energy per solved task exists | [`2026-11-22-energy`](results/2026-11-22-energy/) |
<!-- /generated:hypotheses -->

Four notes that belong beside the table and not only in a later section. H-1's earlier run printed two violations; both were errors in the rig's own bookkeeping, and the supported outcome is of the second run. H-6's supported outcome is of its second campaign; the one before it, 146 of 160, is invalid. H-9's token counts are estimates from prompt-evaluation time, and its success condition was met with no eviction occurring. H-2 was run with a campaign-engine defect and was not run again.

## 5 Methods

### 5.1 Machine, runtime and models

<!-- generated:machine -->
|  |  |
|---|---|
| Machine | Apple M4 Pro, 24 GiB, macOS 26.5.1 (darwin arm64) |
| Node | 24.22.3 |
| Power | AC Power, 100%, adapter 94 W |
| Runtime | ollama 0.33.0 |
<!-- /generated:machine -->

<!-- generated:models -->
| Model | Weights digest | Runtime | Context verified |
|---|---|---|---|
| `qwen2.5-coder:7b` | `dae161e27b0e90dd1856c8bb3209201fd6736d8eb66298e75ed87571486f4364` | ollama 0.33.0 | 16,384 tokens |
| `qwen2.5-coder:1.5b` | `d7372fd828518a4d38b1eb196c673c31a85f2ed302b3d1e406c4c2d1b64a0668` | ollama 0.33.0 | 16,384 tokens |
| `llama3.2:3b` | `a80c4f17acd55265feec403c7aef86be0c25983ab279d83f3bcd3abbcb5b8b72` | ollama 0.33.0 | 16,384 tokens |
<!-- /generated:models -->

One laptop with 24 GiB of memory, on external power at 94 W. The runtime was a private Ollama server started for the campaigns on `127.0.0.1:11500` with `OLLAMA_CONTEXT_LENGTH=16384`. Nothing was downloaded. The two pinned models are both at or below 7B; the third model is used for H-7 and H-10 only. No statement is made about models above 7B. LM Studio was never started and never measured.

Most campaigns ran on a machine that was not quiet: other applications were open and swap was in use. The load average at the start and end of each campaign is in the table of section 5.3. Only the throughput numbers of H-10's campaign were taken on a quiet machine. No other number in this report is a throughput claim.

### 5.2 The campaign engine

A manifest names models, seeds, harness configurations and a task set (`test/onyx/lab/run-lab.mts`). Tier S sends each model one request a task from plain Node. Tier A starts the application on a disposable worktree and runs the real agent loop, with its tools, staging and journal. The engine writes one record a unit, and the launcher scores the records afterwards. A campaign runs no command a model asks for and accepts no edit.

### 5.3 Campaigns

<!-- generated:campaigns -->
| Campaign | Hypotheses | Tier | Units | Attempted | Exact | Seconds | Load average, start to end | Campaign engine |
|---|---|---|---|---|---|---|---|---|
| `2026-11-22-anchors` | H-4, H-5 (superseded) | A | 160 | 160 | 0 | 1,291 | 9.0 to 8.4 | ran with the defect |
| `2026-11-22-anchors-2` | H-4, H-5 | A | 160 | 160 | 0 | 1,322 | 5.2 to 8.3 | ran with the fix |
| `2026-11-22-attribution` | H-2 | A | 960 | 960 | 0 | 6,630 | 5.3 to 10.8 | ran with the defect |
| `2026-11-22-confidence` | H-8 | S | 600 | 600 | 0 | 4,081 | 8.1 to 8.8 | single requests |
| `2026-11-22-determinism` | H-6 (superseded) | A | 200 | 200 | 0 | 737 | 8.4 to 8.3 | ran with the defect |
| `2026-11-22-determinism-2` | H-6 | A | 200 | 200 | 0 | 770 | 8.4 to 5.2 | ran with the fix |
| `2026-11-22-energy` | H-10 | S | 216 | 216 | 0 | 1,866 | 2.1 to 5.4 | single requests |
| `2026-11-22-engine-tier-a` | none | A | 8 | 8 | 0 | 75 | 3.7 to 3.2 | ran with the defect |
| `2026-11-22-engine-tier-s` | none | S | 24 | 24 | 0 | 428 | 4.8 to 33.2 | single requests |
| `2026-11-22-eviction-agentic` | H-9 | A | 120 | 120 | 0 | 536 | 2.6 to 4.6 | ran with the fix |
| `2026-11-22-injection` | none | A | 96 | 92 | 3 | 282 | 7.4 to 12.5 | ran with the defect |
| `2026-11-22-rankings-brew` | H-7 | S | 120 | 120 | 0 | 1,087 | 6.0 to 7.8 | single requests |
| `2026-11-22-rankings-onyx` | H-7 | S | 120 | 120 | 0 | 1,417 | 8.4 to 6.0 | single requests |
| `2026-11-22-reference-measure` | none | S, in the application | 54 | 54 | 0 | 1,257 | 11.6 to 8.4 | single requests |
| `2026-11-22-single-turn` | H-3 | S | 240 | 240 | 0 | 1,952 | 7.8 to 9.0 | single requests |
<!-- /generated:campaigns -->

"Ran with the defect" means the campaign-engine defect of section 10: for up to a minute after a campaign checked out a task, prompts named the recently committed files of the task before. Two campaigns were run again with the fix and the earlier ones are superseded. H-2's campaign and the injection run were made with the defect and were not run again.

### 5.4 Sampling

Campaigns ran at temperature 0 with one seed. H-8's campaign ran at temperature 0.2 with five seeds, because agreement across samples needs samples that can differ. The runtime does not say whether it honoured a seed, so every run is in the stratum "not known to be honoured".

### 5.5 The scorer

A task is one commit that changed one file. The file is at most 12,000 characters before the change. A task succeeds when the file as proposed has exactly the author's lines, compared trimmed and as a multiset with empty lines ignored. A secondary score, an F1 over changed lines, is reported and decides no outcome. No task was scored by executing tests: 19 of the 120 tasks have a test change, and a campaign's worktree has neither the dependencies nor a build. There are no model-graded scores anywhere.

The scorer can be satisfied. On the one-line tasks of the injection fixture, 3 of 92 attempts succeeded.

### 5.6 The simulation rig

The rig runs the real agent loop, control plane, change-set service, edit tool and terminal tool. It simulates the model stream, the user's dialog decisions, the file system and the clock, and drives them from one seed. Checkers for I-01 to I-14 read its trace. A violation is a seed and a shrunk script. The index of the rig's files is [data/simulation-index.json](data/simulation-index.json).

### 5.7 What was registered, and the four amendments

[PREREGISTRATION.md](PREREGISTRATION.md) was committed on 2026-11-19 as `5f98a0ca2c7`, before any campaign. It fixes each hypothesis's metric, sample, analysis and thresholds. Intervals are 95% intervals: bootstrap over tasks with 1,000 resamples, or Wilson for proportions with small counts.

<!-- generated:amendments -->
| Amendment | Date | Subject, as its heading says |
|---|---|---|
| 1 | 2026-11-22 | models, tasks, sampling, and the design of H-2 |
| 2 | 2026-11-22 | the designs of H-3 to H-10 on this machine |
| 3 | 2026-11-22 | what is counted in H-6 to H-10, the injection run, and two changes of design |
| 4 | 2026-11-22 | H-6's first campaign is invalid, and why two campaigns are run again |
<!-- /generated:amendments -->

The reasons, in the amendments' own terms. Amendment 1: the registration expected a model above 7B and none is installed; the instruction and the success rule were left open; one seed is used because at temperature 0 further seeds are repetitions; H-2's factorial is cut from the registered 32 configurations to 12, with two components left out for stated reasons. Amendment 2: the machine was slower than when the samples were registered, so several samples are smaller, and each design says in advance when it will end inconclusive. Amendment 3: it fixes what is counted in H-6 to H-10 and records two changes before their campaigns, the estimate used for H-9 if the runtime does not report evaluated tokens, and H-9's agentic arm at a context of 8,192 tokens. Amendment 4: H-6's earlier campaign is invalid by the registration's own rule; H-6 and H-4 are run again; H-2 and the injection run are not. Each amendment was committed before the campaigns it governs. Amendment 4 was written after H-6's invalid campaign had been analysed, which is what it reports.

## 6 Results

### 6.1 H-1: the simulation campaign and its mutants (supported)

<!-- generated:h1 -->
|  | Count | Of |
|---|---|---|
| Mutants detected by their own script and by the campaign's first seeds | 41 | 41 |
| Mutants that bring back an audited defect | 36 | 41 |
| Generic mutants, one guard removed, no audited defect behind them | 5 | 41 |
| Seeded episodes each mutant was run against | 2,000 |  |
| Second run: episodes of the candidate harness with no violation | 50,000 | 50,000 |
| First run: episodes in shards that reported nothing | 46,000 | 50,000 |
| First run: episodes that printed a violation, both judged the rig's own | 2 | 50,000 |
| Episodes of the simulated injection corpus, run in every shard | 80 |  |
| Seconds, campaign and mutants | 602 and 59 |  |
<!-- /generated:h1 -->

All 41 mutants were detected, and the second run of the campaign reported no violation in 50,000 episodes. The run before it printed a violation in two episodes, at seeds 32218 and 46211. In neither had model-authored text reached the disk; the rig had recorded a save that did not happen. The rig was corrected and the campaign was run again. The registered threshold says the hypothesis is refuted if the candidate harness shows a violation, so the judgement that these two were the rig's own is the weakest point of this outcome, and `results/2026-11-22-assurance/NOTES.md` gives the evidence for it. Of the 41 mutants, 36 bring back a defect an audit found and 5 are generic.

### 6.2 H-2: what each harness component is worth (inconclusive)

<!-- generated:h2 -->
| Model | Tool-call protocol | Runs | Reproduced the author's change | Runs scoring above 0 | Runs with an edit on record | Runs whose edit call the tool rejected |
|---|---|---|---|---|---|---|
| `qwen2.5-coder:7b` | native | 160 | 0 | 0 | 0 | 0 |
| `qwen2.5-coder:7b` | repaired text | 160 | 0 | 12 | 79 | 0 |
| `qwen2.5-coder:7b` | constrained envelope (the product's) | 160 | 0 | 0 | 0 | 0 |
| `qwen2.5-coder:1.5b` | native | 160 | 0 | 0 | 0 | 0 |
| `qwen2.5-coder:1.5b` | repaired text | 160 | 0 | 1 | 53 | 86 |
| `qwen2.5-coder:1.5b` | constrained envelope (the product's) | 160 | 0 | 0 | 0 | 18 |

Protocol handling's Shapley value of task success in the primary game: `qwen2.5-coder:7b` 0.000 [0.000, 0.000]; `qwen2.5-coder:1.5b` 0.000 [0.000, 0.000]. Every other Shapley value, main effect and interaction of task success is the same zero (`docs/research/results/2026-11-22-attribution/ANALYSIS.md`).
<!-- /generated:h2 -->

No run reproduced the author's change: 0 of 960. Every configuration's success rate is 0 of 40, with a Wilson upper bound of 8.8%. Every Shapley value is therefore zero, which the registration names as inconclusive: a floor is not evidence that the components are worth the same. The campaign ran with the campaign-engine defect and was not run again. A secondary measure in a secondary game, which decides nothing, is not at the floor: for the 7B model, moving from native tool calls to repaired text is worth 0.019 of mean score, with an interval of 0.003 to 0.041.

### 6.3 H-3: exact-or-refuse against fuzzy appliers (supported)

<!-- generated:h3 -->
| Applier | Placed | Placed though its text is not in the file | Silently wrong, of all attempts | Mean score |
|---|---|---|---|---|
| exact-unique (the product) | 424 (32.6%) | 0 | 350 (26.9% [24.6%, 29.4%]) | 0.030 |
| whitespace-insensitive | 649 (49.9%) | 178 | 551 (42.4% [39.7%, 45.1%]) | 0.057 |
| unique-first-line | 594 (45.7%) | 195 | 512 (39.4% [36.7%, 42.0%]) | 0.061 |
| fuzzy | 798 (61.3%) | 319 | 700 (53.8% [51.1%, 56.5%]) | 0.067 |

1,301 SEARCH/REPLACE blocks: 855 from `qwen2.5-coder:7b`, 446 from `qwen2.5-coder:1.5b`. The fuzzy comparator placed 28.7 points more than exact-unique [26.1, 31.3].
<!-- /generated:h3 -->

Both registered conditions hold on the pooled sample of 1,301 attempts. The fuzzy comparator placed 28.7 points more blocks, and 53.8% of all attempts ended silently wrong under it; 319 of its 798 placements were of text that is not in the file. The sample is under the registered 500 attempts for one model, which has 446. Two things the hypothesis did not ask. Most placements are wrong under every applier: 350 of the product's own 424 placements changed a line the author did not. And the fuzzy appliers have the higher mean score. The product's choice is not justified by score. It is justified by the placements a fuzzy applier makes where the model did not quote.

### 6.4 H-4: constrained anchors (inconclusive)

<!-- generated:h4 -->
| Model | Arm | Runs | Edit calls on record | Refused | Proposals that changed a line the author did not | Seconds a run, 90th percentile |
|---|---|---|---|---|---|---|
| `qwen2.5-coder:7b` | search and replace | 40 | 0 | 0 | 0 | 6.2 |
| `qwen2.5-coder:7b` | constrained anchors | 40 | 31 | 0 | 30 | 44.6 |
| `qwen2.5-coder:1.5b` | search and replace | 40 | 0 | 0 | 0 | 2.7 |
| `qwen2.5-coder:1.5b` | constrained anchors | 40 | 24 | 1 | 21 | 17.0 |
<!-- /generated:h4 -->

No task has an edit on record in both arms, so there is no pair to compare. The table shows something outside the hypothesis: with anchors the models produce edit calls, 55 in all, and nearly every one changes a line the author did not. These numbers are from the second campaign. The one before it ran with the campaign-engine defect, which fell on one arm, and is in no analysis.

### 6.5 H-5: grounded and ungrounded edits (refuted)

<!-- generated:h5 -->
| Class | Edits | Mean score |
|---|---|---|
| Grounded: the anchor was in the model's context that turn | 163 | 0.021 |
| Ungrounded | 36 | 0.000 |
| Left out: grounding not applicable | 73 |  |
| Difference, grounded less ungrounded |  | 0.021 [0.009, 0.034] |
| Cliff's delta |  | 0.08 |
<!-- /generated:h5 -->

The difference is 0.021, and its whole interval lies under the registered 0.05, which the registration calls refuted. The direction is the hypothesised one and the interval excludes zero. The effect is smaller than was registered as mattering, on a sample under the registered 300 edits a class, with both means near the floor.

### 6.6 H-6: trajectory determinism (supported, on the second campaign)

<!-- generated:h6 -->
| Campaign | Repetitions identical to the unit's first | Share, Wilson interval | Units with all five identical | Divergences: the runtime's | Divergences: the harness's |
|---|---|---|---|---|---|
| `2026-11-22-determinism` (first, invalid) | 146 of 160 | 91.3% [85.8%, 94.7%] | 35 of 40 | 0 | 14 |
| `2026-11-22-determinism-2` (second, with the fix: decides H-6) | 160 of 160 | 100.0% [97.7%, 100.0%] | 40 of 40 | 0 | 0 |
<!-- /generated:h6 -->

The earlier campaign found 146 of 160 repetitions identical. All 14 divergences were in the opening request of a run, before the runtime had answered: they were the harness's, and by the registration one such divergence invalidates the study. The cause was the campaign-engine defect of section 10. The second campaign, with the fix, found 160 of 160 identical, a share of 100% with a lower bound of 97.7%, against thresholds of 90% and 80%. The runtime did not diverge in any of the 320 comparisons of the two campaigns. These are short trajectories of two or three turns, back to back on one machine with the model resident.

### 6.7 H-7: rankings across repositories (inconclusive)

<!-- generated:h7 -->
| Repository | Model | Tasks solved | Mean score (not the registered metric) |
|---|---|---|---|
| this repository | `qwen2.5-coder:7b` | 0 of 40 | 0.040 |
| this repository | `qwen2.5-coder:1.5b` | 0 of 40 | 0.017 |
| this repository | `llama3.2:3b` | 0 of 40 | 0.037 |
| Homebrew/brew | `qwen2.5-coder:7b` | 0 of 40 | 0.146 |
| Homebrew/brew | `qwen2.5-coder:1.5b` | 0 of 40 | 0.021 |
| Homebrew/brew | `llama3.2:3b` | 0 of 40 | 0.069 |
<!-- /generated:h7 -->

No model solved a task in either repository, so neither repository has a ranking by the registered metric. Two repositories were used where three were registered, which means the hypothesis could not have been refuted in any case.

### 6.8 H-8: hunk confidence (inconclusive)

<!-- generated:h8 -->
| Estimator | Labelled hunks | Correct | AUROC, interval | ECE | By the registered thresholds |
|---|---|---|---|---|---|
| agreement of five samples | 120 | 6 | 0.507 [0.384, 0.687] | 0.215 | inconclusive |
| least token probability of the block | 114 | 6 | 0.599 [0.299, 0.885] | 0.093 | inconclusive |

600 runs, 120 units (a model and a task). 58 units had no hunk to label because their first reply placed no edit. For 103 of 120 hunks the first sample's hunk appeared in no other sample.
<!-- /generated:h8 -->

There are 6 correct hunks among 120 labelled ones. The registration asked for at least 500 labelled hunks, and Amendment 2 fixed in advance that nothing is decided with fewer than 20 hunks of either class. Both AUROC intervals include 0.5. No confidence badge ships.

### 6.9 H-9: cache-aware eviction (supported, with two caveats)

<!-- generated:h9 -->
| Policy, scripted runs | Re-processed tokens, turns 2 to 16, estimated | Ratio to oldest-first, interval | Mean time to first token, ms |
|---|---|---|---|
| `oldest-results-first` (the product) | 365,920 |  | 8,062 |
| `block-to-low-watermark` | 153,178 | 0.42 [0.38, 0.47] | 3,343 |
| `placeholder-results` | 339,187 | 0.93 [0.90, 0.95] | 8,460 |

18 scripted runs, 90 paired turns a policy. The probe: the same prompt twice to `qwen2.5-coder:7b`; the runtime reported 2,963 prompt tokens evaluated both times, in 6,296 ms and then 22 ms.

| Policy, agentic runs | Succeeded | Runs in which anything was evicted |
|---|---|---|
| `oldest-results-first` | 0 of 40 | 0 of 40 |
| `block-to-low-watermark` | 0 of 40 | 0 of 40 |
| `placeholder-results` | 0 of 40 | 0 of 40 |
<!-- /generated:h9 -->

Block eviction's ratio is 0.42, under the registered 0.70, with an interval that excludes 1.0. Two caveats belong with that sentence. The token counts are estimates: the runtime reported the whole prompt as evaluated whether it was cached or not, so re-processed tokens are estimated from prompt-evaluation time, a fallback Amendment 3 recorded before the campaign. And the success condition was met with no eviction occurring: in the agentic runs no policy evicted anything and no run succeeded, so the registered condition on success holds with a difference of zero. This campaign says nothing about whether block eviction costs task success. The product's default policy is unchanged.

### 6.10 H-10: energy to solution (inconclusive)

<!-- generated:h10 -->
| Model | Block, s | Energy, J | Bound on the block's ends, J | Solved | Energy an attempt, J | Energy a thousand tokens, J | Tokens a second |
|---|---|---|---|---|---|---|---|
| `qwen2.5-coder:7b` | 506 | 36,603 | 4,569 (12%) | 0 of 72 | 508 | 1,725 | 49.5 |
| `qwen2.5-coder:1.5b` | 381 | 25,372 | 7,969 (31%) | 0 of 72 | 352 | 456 | 160.3 |
| `llama3.2:3b` | 975 | 62,669 | 7,548 (12%) | 0 of 72 | 870 | 764 | 91.7 |
<!-- /generated:h10 -->

No model solved a task, so energy per solved task has no value and the two rankings cannot be compared. Energy per attempt decides nothing by registration. The bound on each block's ends is wide, up to 31% of a block's energy, because the power telemetry refreshes about once a minute. Accuracy against an external meter is not established. The tokens-a-second column is the only throughput in this report taken on a quiet machine.

## 7 Negative and inconclusive results

**H-5, refuted.** The registered claim was a difference of at least 0.05 in mean score. The measured difference is 0.021. A fair test needed 300 edits a class and scores away from the floor; there were 163 and 36, and the grounded mean is 0.021.

**H-2, inconclusive.** Needed: at least one configuration that succeeds on some tasks, so that configurations can differ. There were 0 successes in 960 runs. Also missing: a run of the campaign without the engine defect.

**H-4, inconclusive.** Needed: tasks with an edit attempt in both arms, to pair. There were 0 such tasks, because under search and replace no run got an edit on record.

**H-7, inconclusive.** Needed: a ranking in each repository, which needs solved tasks, and a third repository for a refutation. There were 0 solved tasks of 40 for each of three models in each of two repositories.

**H-8, inconclusive.** Needed: at least 20 correct and 20 incorrect labelled hunks, and 500 in all. There were 6 correct of 120.

**H-10, inconclusive.** Needed: at least two models that solved a task. There were 0 of 3.

Three of these five (H-2, H-7, H-10) are at a floor of zero successes. H-4 is at zero pairs for the same underlying reason. A floor does not favour either answer to the question asked.

## 8 What the measurements say about the product

<!-- generated:totals -->
| Campaign | Attempts on real tasks | Reproduced the author's change exactly |
|---|---|---|
| `2026-11-22-anchors` (superseded) | 160 | 0 |
| `2026-11-22-anchors-2` | 160 | 0 |
| `2026-11-22-attribution` | 960 | 0 |
| `2026-11-22-confidence` | 600 | 0 |
| `2026-11-22-determinism` (superseded) | 200 | 0 |
| `2026-11-22-determinism-2` | 200 | 0 |
| `2026-11-22-energy` | 216 | 0 |
| `2026-11-22-engine-tier-a` | 8 | 0 |
| `2026-11-22-engine-tier-s` | 24 | 0 |
| `2026-11-22-eviction-agentic` | 120 | 0 |
| `2026-11-22-rankings-brew` | 120 | 0 |
| `2026-11-22-rankings-onyx` | 120 | 0 |
| `2026-11-22-reference-measure` | 54 | 0 |
| `2026-11-22-single-turn` | 240 | 0 |
| **All campaigns on real tasks** | **3,182** | **0** |
| `2026-11-22-injection` (fixture tasks, in no total) | 92 | 3 |

| Agent runs on real tasks under the constrained envelope with search-and-replace edits | Runs | Runs with an edit on record | Runs whose edit call the tool rejected |
|---|---|---|---|
| H-2's campaign, its four constrained-envelope configurations (the count STATE.md states) | 320 | 0 | 18 |
| Every configuration with the product's hash `9801945d`, 6 campaigns | 648 | 0 | 15 |
| Every such configuration, 7 campaigns | 1,008 | 0 | 38 |
<!-- /generated:totals -->

**No model reproduced a real task exactly.** The total is 0 of 3,182 attempts over 14 campaigns, single-turn and agentic. It counts attempts, not independent trials: campaigns reuse tasks, H-6 repeats each unit, and 360 of the attempts are from the two superseded campaigns, which leaves 2,822. The total reproduces the figure `docs/progress/STATE.md` states.

**Under the product's tool-call protocol neither pinned model got an edit on record.** STATE.md states this as 0 of 320 agent runs, and the count reproduces: the 320 are the four constrained-envelope configurations of H-2's campaign, and none of their records carries an edit. Two qualifications come from the raw records. In 18 of the 320 runs the 1.5B model called the edit tool with arguments the tool rejected, so "proposed no edit" is exact only in the sense that no edit reached staging. And three of those four configurations differ from the product's in elision or line numbering. Counting only configurations with the product's exact hash gives 0 of 648 runs with an edit over six campaigns, and counting every constrained-envelope configuration with search-and-replace edits gives 0 of 1,008. Under repaired text the same models do get edits on record, and under constrained anchors they do too; none reproduced a task.

The two pinned models are the ones the product's catalog recommends for a laptop of this size. On real single-file changes from this repository, the agent loop with either model completed none.

## 9 Threats to validity

- **One machine, one operator, one runtime, three small models, two repositories.** Nothing here was repeated by anyone else or anywhere else. No hypothesis campaign ran on LM Studio; its benchmark rows (2026-11-24) are outside this report.
- **A machine that was not quiet.** Most campaigns ran with other applications open. Only H-10's throughput numbers were taken on a quiet machine. H-9's token estimate is derived from time and inherits whatever else the machine was doing.
- **A campaign-engine defect in two campaigns that were not run again.** H-2's campaign and the injection run of L12 were made while the runtime service kept a stale list of recently committed files across checkouts, so prompts named the previous task's files. H-2's edit calls also enter H-3 and H-5. Amendment 4 argues that an applier's verdict does not depend on that background; that argument was not tested.
- **Judgement calls.** H-1's two printed violations were judged the rig's own by the people who wrote the rig. H-6's invalid campaign was replaced under an amendment written after its analysis.
- **Floors.** With no solved tasks, three hypotheses were never tested, and the task set may simply be too hard for these models. Tasks were scored by exact reproduction of the author's change, which rejects correct alternatives.
- **Samples under their registered minimums.** H-3 for one model, H-5 for both classes, H-8 for the total and for one class.
- **Dependent observations.** Campaigns share tasks, and repetitions at temperature 0 are near copies. Intervals over turns or comparisons understate the uncertainty; H-9's interval is over the turns of one transcript.
- **No external check of the instruments.** Energy was not compared with a meter. Seeds are not known to be honoured.
- **No model-graded scores.** This removes one source of error and means nothing here measures whether an inexact edit was nonetheless acceptable.

### 9.1 Limits of these verdicts

Each verdict above is the registered rule applied to the data, and none is changed here. This is what each one does not carry, read from the same committed records (2026-11-26).

- **H-1 rests on a judgement the registration did not provide for.** Its thresholds have no inconclusive outcome and no clause for errors of the rig or the checkers (PREREGISTRATION.md, H-1). The first run printed two violations (seeds 32218 and 46211, both `I-01/disk`); they were judged the rig's own and the rig was changed before the second run, which is the one reported. The mutants and the invariant checkers were written by the same authors, so a blind spot shared by both would not show.
- **H-3 is close to true by construction.** A fuzzy applier places almost everything exact matching places and more (on these attempts: both placed 410, fuzzy only 388, exact only 14), so condition 1 measures how much more. Condition 2 tests the fuzzy applier's own silently-wrong rate against 0.5%, not against exact-or-refuse; exact-or-refuse's own rate, 26.9% (350 of 1,301), would pass the same condition.
- **H-5's refutation is forced by the floor.** All 36 ungrounded edits score 0, and 150 of the 163 grounded ones do, the highest 0.4; the difference is the grounded mean, and with no task solved a difference of 0.05 was out of reach whatever grounding is worth.
- **H-6 measured repetition of short runs with no edit.** All 200 runs proposed no edit (10 edit calls were made, all rejected for their arguments); 190 had two turns and 10 had three. Whether a run that edits repeats is not tested.
- **H-9's success condition is 0 = 0, and nothing was evicted in the agentic arm.** Every policy succeeded on 0 of 40 tasks, and the largest prompt was 3,384 of 8,192 tokens, so no policy had to evict. The 0.42 ratio comes from the scripted arm and is estimated from prompt-evaluation time, not counted in tokens.
- **Amendments 2 to 4 were written while neighbouring data existed.** Amendment 2 was committed while H-2's campaign was running, Amendment 3 later in the same campaign and after H-1's two runs, and Amendment 4 after the campaigns that feed H-3, H-4 (its first), H-6 (its first) and H-7 had finished. Each says what had been looked at. Running H-4 again under Amendment 4 sits against the registration's own rule that a hypothesis whose data exists is frozen; the amendment says no H-4 edit had been read or scored.
- **The product's default protocol got no edit on record.** Under the constrained envelope, which the datasheet selects for both pinned models, neither had an edit on record in 320 runs of H-2 (in 18 the 1.5B's edit call was rejected for its arguments), while under repaired text 79 runs of the 7B and 53 of the 1.5B had one, and under constrained anchors 55 of 80 runs made an edit call (H-4). No protocol reproduced a task. Which protocol the product should default to is a decision for the owner, and it is open.

## 10 Defects the campaigns found

Each was fixed with a regression test. All three are defects of the measuring apparatus or of the product's request path, found by reading campaign records.

1. **A campaign's seed and temperature were recorded and not sent.** The trace said temperature 0 and seed 1 while the provider sent the model profile's own values. Found in the earliest records of H-2's campaign; those records were deleted and the campaign restarted (`docs/progress/L9.md`, Erratum).
2. **No one-shot request carried an output cap.** The reference measurement never finished on one model until it was stopped by hand (`docs/progress/L11.md`).
3. **The runtime service kept the list of recently committed files across a campaign's checkouts.** Prompts named the previous task's files for up to a minute. H-6's request-digest comparison found it. It affected every agent-loop campaign before its fix; H-6 and H-4 were run again, H-2 and the injection run were not (`docs/progress/L15.md`).

The simulation campaigns also found errors in the rig's own bookkeeping, twice, each time on a run at a larger size than any before it (section 6.1; `docs/progress/module-3-gate.md`).

The injection run with real models, made with defect 3: in 80 runs of tasks carrying a planted instruction, a model reached for the planted kind of tool in 4 and the planted effect happened in 0. A campaign denies every command, so this shows campaign policy holding and not the product's approval dialog.

## 11 Related work

[RELATED.md](RELATED.md) is a dated check of prior work for each of the ten items, made on 2026-11-22, with what was read in full and what was not. Its last section gives the narrowest description each item supports, and section 2 above follows it. In short: simulation testing with mutation scoring, factorial attribution with Shapley values, task mining from history with date rules, the refuse-or-misapply trade for edit application (measured on synthetic file drift in arXiv 2609.11957), grammar-constrained decoding, record-and-replay, localized confidence for edits, cache-aware eviction, repetition at temperature 0 on local runtimes, and energy per solved task all exist in prior work. This project's results are measurements in one setting. RELATED.md supplies no grounds for wording about priority, and none is used here.

## 12 Reproduction

[REPRODUCE.md](REPRODUCE.md) has one command for each table of this report, the command that runs each campaign again from its manifest with what it needs, and a table of which of those commands were actually run for this document and what they returned. [data/](data/README.md) holds the numbers file and the indexes of the simulation scripts, the shrunk counterexamples, the injection corpus, the mutation corpus and the task-set hashes.
