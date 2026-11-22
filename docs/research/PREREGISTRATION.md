# Pre-registration

*L3, version 1, registered 2026-11-19 on branch `module-1` (the commit hash is recorded in
`docs/progress/STATE.md`). Hypotheses H-1 to H-10 are ActionPlan Section 7's. Each entry fixes the metric, the
sample, the analysis and the decision thresholds before any of its data exists. Changes after this date go
in the Amendments section with a date and a reason, and only for a hypothesis whose campaign has not started;
a hypothesis whose data exists is frozen.*

## Common rules

- **Outcomes.** Each hypothesis ends as **supported**, **refuted**, **inconclusive** or **unavailable on this
  hardware**, by the thresholds below and nothing else. All four are published with equal prominence.
- **Correctness.** A hunk is correct when it applies exactly and uniquely and its changed lines match the
  reference diff; a task succeeds when every reference hunk is correct and the task's tests, where it has
  them, pass. No model-graded scores.
- **Intervals.** Unless stated, 95% intervals are bootstrap intervals (1,000 resamples) over tasks, with the
  model and the seed held as strata. Proportions with small counts use Wilson intervals.
- **Seeds and sampling.** Every run states its seed and temperature in its manifest and trace. A run whose
  trace shows the seed was not honoured is kept and counted, and the share of such runs is reported.
- **Models.** "The pinned models" are the two models whose datasheets Module 2 commits (one at or below 7B,
  one above), plus any model added by amendment before the campaign.
- **Tasks.** "L10's tasks" are the temporally held-out tasks built from this repository's history by L10,
  identified by commit id and content hash in the manifest; the task-set hash freezes the set.
- **Reporting.** Every number is published with its denominator and interval, and regenerates from the
  results directory by the command in its manifest.

## Hypotheses

### H-1. The simulation campaign detects every resurrected defect in the mutation corpus (L12)

- **Metric.** Mutation score: killed mutants over total mutants. A mutant is killed when the campaign reports
  at least one violation of the invariant the mutant resurrects.
- **Sample.** Every mutant under `test/onyx/sim/mutants/` (at least one per defect fixed in Modules 2 and 3,
  plus one generic mutant per invariant checker), each run against a 2,000-episode campaign at seeds 1 to
  2000; the candidate harness itself against at least 50,000 episodes.
- **Analysis.** Deterministic: a count of killed and surviving mutants, each survivor with a written
  equivalence argument or a named gap. The candidate harness's violation count is reported separately.
- **Thresholds.** Supported: mutation score 100% and zero violations on the candidate harness. Refuted: any
  mutant survives without an equivalence argument after one round of closing the gap (new persona, action or
  checker), or the candidate harness shows a violation. There is no inconclusive outcome.

### H-2. Tool-call protocol handling is the largest contributor for models at or below 7B, and the gap narrows with size (L13)

- **Metric.** Task success rate per configuration; per-component Shapley value of success rate over the
  factorial of L4's switches.
- **Sample.** Full factorial over at most five components (32 configurations) × the pinned models × L10's tasks
  (at least 40) × 3 seeds, through L9. A fractional design, if used, is documented before the run.
- **Analysis.** Main effects, pairwise interactions and Shapley values per component with bootstrap intervals
  over tasks, reported per model.
- **Thresholds.** Supported: for the model at or below 7B, protocol handling's Shapley value exceeds every
  other component's and the intervals do not overlap; and the margin between protocol handling and the
  runner-up is smaller for the larger model. Refuted: another component's interval lies wholly above protocol
  handling's for the small model, or the margin grows with size with intervals excluding equality.
  Inconclusive otherwise.

### H-3. Exact-or-refuse loses a measurable share of edits relative to fuzzy appliers and prevents a non-zero share of silently wrong edits (L14)

- **Metric.** Per applier (exact-unique, whitespace-insensitive, unique-first-line, one fuzzy comparator):
  apply rate; silently-wrong rate (applied although the SEARCH text was not in the file, or lines outside the
  reference changed); task score.
- **Sample.** Every raw model reply L9 and L10 saved, at least 500 edit attempts per pinned model.
- **Analysis.** Paired per attempt. Differences in rates with bootstrap intervals; silently-wrong counts with
  Wilson intervals.
- **Thresholds.** Supported: exact-unique's apply rate is lower than the fuzzy comparator's by at least 2
  percentage points (interval excludes 0), and the fuzzy comparator's silently-wrong rate is at least 0.5%
  with an interval excluding 0. Refuted: the apply-rate difference's interval lies wholly below 2 points, or
  the silently-wrong rate's upper bound is below 0.5%. Inconclusive otherwise.

### H-4. Constrained anchors lower the refusal rate under exact-or-refuse without raising the collateral-edit rate (L14)

- **Metric.** Refusal rate (edits that could not be placed); collateral-edit rate (edits that changed lines
  outside the reference hunk); span-selection error rate; task score; added latency.
- **Sample.** The same attempts under free-form SEARCH/REPLACE and under L7's constrained anchors, at least
  500 per pinned model.
- **Analysis.** Paired differences with bootstrap intervals; latency as median and 90th percentile.
- **Thresholds.** Supported: refusal rate lower by at least 5 points (interval excludes 0) and the collateral
  rate's difference has an upper bound of at most 1 point. Refuted: the refusal difference's interval includes
  0 or the collateral rate rises by more than 1 point with an interval excluding 1. Inconclusive otherwise. L7
  becomes the default for models whose datasheet supports it only if supported; otherwise it stays opt-in or
  is withdrawn, as `docs/SUPPORT.md` records.

### H-5. Edits whose anchor was not in the model's context that turn score lower than grounded edits (L14)

- **Metric.** Hunk score (F1 over changed lines against the reference) for grounded edits (anchor present in
  the turn's context, L6's flag) and ungrounded edits.
- **Sample.** At least 300 edits per class pooled across the pinned models from L9 and L10's saved replies.
- **Analysis.** Difference in mean score with a bootstrap interval; Cliff's delta as the effect size.
- **Thresholds.** Supported: grounded mean score exceeds ungrounded by at least 0.05 with an interval excluding
  0. Refuted: the difference's interval lies wholly below 0.05. Inconclusive otherwise.

### H-6. At temperature 0 with a fixed seed on one machine, at least 90% of multi-turn trajectories repeat exactly (L15)

- **Metric.** Share of byte-identical trajectories (same sequence of request digests, responses and tool calls)
  across repetitions; distribution of the first diverging turn; whether divergence changed the outcome.
- **Sample.** One manifest: the pinned models × 20 of L10's tasks × 5 repetitions on the reference machine,
  seed fixed, temperature 0. Where available, the same manifest on a second machine, reported separately.
- **Analysis.** Wilson interval on the identical share per model; a histogram of the first diverging turn.
  Each run's recorded responses are replayed through L8, which must reproduce the trajectory exactly; a replay
  that does not is a harness defect and invalidates the study until fixed.
- **Thresholds.** Supported: identical share at least 90% with a lower bound of at least 80%. Refuted: upper
  bound below 90%. Inconclusive otherwise. Runs whose trace shows the seed was not honoured are reported as
  their own stratum.

### H-7. Model rankings differ between repositories often enough to change which model a user should pick (L11, L13)

- **Metric.** Per repository, the ranking of the pinned models by task success; Kendall's tau between
  repositories; whether the top-ranked model differs.
- **Sample.** At least three repositories (this one and two public repositories in different languages), at
  least three models, L10's task construction per repository (at least 40 tasks each), 3 seeds.
- **Analysis.** Bootstrap over tasks for each pairwise score difference; a swap counts when the interval of
  the difference excludes 0 in one repository and the sign differs in another.
- **Thresholds.** Supported: at least one pair of repositories whose top-ranked model differs, with the
  difference significant in each. Refuted: tau = 1 across all repositories and every pairwise interval
  excludes a swap. Inconclusive otherwise.

### H-8. Sample agreement or token probability predicts hunk correctness better than chance by a pre-registered margin (L16)

- **Metric.** AUROC and expected calibration error of each estimator against hunk correctness: agreement
  (share of k = 5 differently seeded samples whose exactly applied result contains the same hunk), minimum
  token probability over the hunk where the runtime returns log-probabilities, and L6's grounding flag.
- **Sample.** At least 500 labelled hunks from L10's tasks across the pinned models.
- **Analysis.** AUROC with a bootstrap interval; a reliability diagram with ten bins; ECE.
- **Thresholds.** Supported for an estimator: AUROC lower bound at least 0.65. Refuted: upper bound below 0.60.
  Inconclusive otherwise. The badge ships only for a supported estimator whose ECE is at most 0.10; otherwise
  no badge ships and the negative result is published.

### H-9. A cache-aware eviction policy re-processes fewer prompt tokens per turn than oldest-first at equal task success (L17)

- **Metric.** Re-processed prompt tokens per turn from the runtime's prompt-evaluation counts; time to first
  token; task success rate.
- **Sample.** Three policies (oldest-first, block eviction to a lower watermark, placeholder replacement) ×
  the pinned models × scripted 16-turn runs and 20 of L10's agentic tasks × 3 seeds.
- **Analysis.** Ratio of re-processed tokens per turn against oldest-first with a bootstrap interval; difference
  in success rate with an interval. The budget is never exceeded under any policy (R-16).
- **Thresholds.** Supported: the best cache-aware policy's ratio is at most 0.70 with an interval excluding 1.0,
  and its success rate is not lower by more than 2 points (interval). Refuted: every cache-aware policy's ratio
  interval includes or exceeds 1.0. Inconclusive otherwise. The supported policy, if any, becomes an L4 option
  and is recorded.

### H-10. Energy per solved task ranks models differently from tokens per second (L18)

- **Metric.** Energy per solved task in joules from system power telemetry sampled during the campaign;
  tokens per second from the same runs; the method's stated error.
- **Sample.** The pinned models and any other installed model × L10's tasks × 3 repetitions on the reference
  laptop.
- **Analysis.** Rankings by each metric; for each adjacent pair that swaps, the energy difference with a
  bootstrap interval over tasks.
- **Thresholds.** Supported: at least one swap whose energy difference's interval excludes 0. Refuted:
  identical rankings. Inconclusive otherwise. Unavailable on this hardware: no telemetry without elevated
  privileges, shown by the committed probe output. Energy is never derived from the parameter-seconds proxy.

## Amendments

*An amendment is a dated entry here naming the hypothesis, the change and the reason, made before that hypothesis's campaign has produced data.*

### Amendment 1, 2026-11-22: models, tasks, sampling, and the design of H-2

Made at L10, before any campaign that tests a hypothesis. The commit that adds this section is an ancestor of every results commit of H-2 to H-10.

**What existed when this was written.** Three things had been run, none of them a hypothesis's campaign. (1) L9's two engine campaigns, committed under `docs/research/results/2026-11-22-engine-tier-s/` and `2026-11-22-engine-tier-a/`: 24 single-turn units and 8 agent runs on eight commits. (2) and (3) Two pilots that are not committed: 16 agent runs with the instruction below on the same eight commits, and 48 agent runs on them under three values of the tool-call protocol. The eight commits are excluded from the task set. What the pilots showed is stated with each decision they informed, because a design choice made after looking at data has to say so.

**A1.1 The models (Common rules, "Models").** The registration expected one pinned model at or below 7B and one above. The two models Module 2 pinned and measured are `qwen2.5-coder:7b` and `qwen2.5-coder:1.5b`: both are at or below 7B. No model above 7B is installed on the reference machine, and none is downloaded for this module. So: "the pinned models" are those two; where a hypothesis compares sizes, the larger is the 7B and the smaller the 1.5B; and no statement is made about models above 7B. `llama3.2:3b`, which is installed, is added for H-7 and H-10 only, which ask for a third model or for "any other installed model".

**A1.2 The tasks (Common rules, "Tasks", "Correctness").** L10's task set is `docs/research/results/2026-11-22-task-set/tasks.json`: commits of this repository authored after 2025-01-01, which is later than the day any of the three models was published, selected by the product's rule and spread over the eligible history. A campaign names the subset it uses and that subset's hash. Three points the registration left open are fixed here:

- *The instruction* is the commit's message, subject and body, without trailers, cut at 1,500 characters; a task names its one file. In an agent run the instruction ends "Read the file first, then propose the change with the editFile tool. Do not ask for more information." Reason, from the engine campaign and the first pilot: given only "In the file X, make this change: <subject>", the 7B model answered three of four tasks in prose without calling a tool, and the 1.5B model read the file and said the change was made. A campaign has no user to answer a question.
- *A task succeeds* when the file as proposed has exactly the author's lines: the same lines as the author's file, compared trimmed and as a multiset, empty lines ignored (`labTaskSucceeded`). These tasks have one hunk-bearing file and no tests of their own that a campaign runs, so "every reference hunk is correct" is this comparison. The score of C8 (`changed-line-f1-preserving/2`) is reported beside it as a secondary measure and decides no outcome.
- *A model is not given a task it cannot read*: a task's file is at most 12,000 characters before the change.

**A1.3 Sampling and seeds (H-2, H-7, H-9, H-10).** Campaigns run at temperature 0 with one seed (1), not three. Reason: at temperature 0 the seed does not enter decoding, so three seeds are three repetitions, and they would triple machine time that the reference machine does not have: the agent-loop campaigns of this module are sized to about ten hours each or less. Whether repetitions at temperature 0 agree is H-6's question and is measured there with five repetitions. A hypothesis whose interval is too wide for a decision with one seed ends as inconclusive.

**A1.4 H-2's design.** The registration allows at most five components and a documented fractional design. The design is a full factorial over three components, 12 configurations, on both pinned models and 40 tasks: 960 agent runs.

| Component | Values | In the product |
|---|---|---|
| Tool-call protocol handling | `native` (off), `repaired-text`, `constrained-envelope` | `constrained-envelope` for both models: their datasheets show 0 of 5 calls on the tool channel and a runtime that enforces schemas |
| Tool-result elision | 4,000 characters of a result (on), 16,000 (off: every task's file is returned whole) | 4,000 |
| Read-tool line numbering | on, off | on |

Every other switch is the same in all twelve and is named in the manifest (compact prompt, 8 turns, 8 tools, context 16,384, search-and-replace edits).

- *Two components are left out, for a stated reason each.* Eviction has one policy until L17, and running without eviction breaks invariant I-04, which no lab configuration may do; L17 studies the policies. Verification feedback compares the workspace's problems before and after a run, and a campaign's instance of the application runs without extensions, so there are no problems to compare: the switch would change nothing, and measuring it would report a zero that means "not exercised".
- *Protocol handling has three values, not two.* The hypothesis names "repair or constrained decoding", and the product has both. The second pilot, on the eight excluded commits, is why all three are kept: under `constrained-envelope` the 7B model read the file and then answered without editing in 8 of 8 runs, under `native` it made no recognised tool call in 8 of 8, and under `repaired-text` it called the edit tool 4 times in 8 runs, with 2 edits staged. The 1.5B model called the edit tool 11 times under `repaired-text` and once under `constrained-envelope`; none of its edits was staged. No run in either pilot reproduced the author's change. Collapsing to "on/off" would hide the difference the pilot points at.
- *Analysis.* A component's Shapley value is computed over a two-valued game. For protocol handling the game is played twice: **primary**, `native` against the product's value for the model (`constrained-envelope`); **secondary**, `native` against `repaired-text`. The other two components keep their on and off as in the table. Each game has 8 coalitions; the value of a coalition is the success rate of its configuration over the 40 tasks; intervals are bootstrap intervals over tasks, 1,000 resamples. Main effects and pairwise interactions are reported for each game.
- *Decision.* The thresholds are the registration's, applied to the **primary** game of each model: supported when protocol handling's Shapley value exceeds each other component's with intervals that do not overlap, for both models, and the margin to the runner-up is smaller for the 7B than for the 1.5B; refuted when another component's interval lies wholly above protocol handling's for either model, or the margin grows with size with intervals excluding equality; inconclusive otherwise. The secondary game is reported in full beside it and is labelled secondary wherever it appears. If no configuration succeeds on any task, every Shapley value is zero with a zero-width interval, and the outcome is inconclusive: that is a floor, not evidence of equal worth.
