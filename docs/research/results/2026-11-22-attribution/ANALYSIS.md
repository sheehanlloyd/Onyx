# What each harness component is worth: 2026-11-22-attribution

Every number here is computed from `results.jsonl` in this directory by `node test/onyx/lab/analyze-attribution.mts docs/research/results/2026-11-22-attribution`. Intervals are 95% percentile bootstrap intervals over tasks, 1000 resamples, seed 1; a task's outcomes under the eight configurations of a game are resampled together. The design and the decision rule are `docs/research/PREREGISTRATION.md`, H-2 and Amendment 1.

## Every configuration

| Model | Configuration | Units | Attempted | Proposed an edit, by score above 0 | Reproduced the author's change | Success rate | Mean score | Median seconds a unit |
|---|---|---|---|---|---|---|---|---|
| qwen2.5-coder:7b | native-elide-numbered | 40 | 40 | 0 | 0 | 0.000 [0.000, 0.088] | 0.000 | 1.4 |
| qwen2.5-coder:7b | native-elide-plain | 40 | 40 | 0 | 0 | 0.000 [0.000, 0.088] | 0.000 | 0.6 |
| qwen2.5-coder:7b | native-whole-numbered | 40 | 40 | 0 | 0 | 0.000 [0.000, 0.088] | 0.000 | 0.6 |
| qwen2.5-coder:7b | native-whole-plain | 40 | 40 | 0 | 0 | 0.000 [0.000, 0.088] | 0.000 | 0.7 |
| qwen2.5-coder:7b | repaired-elide-numbered | 40 | 40 | 4 | 0 | 0.000 [0.000, 0.088] | 0.020 | 18.2 |
| qwen2.5-coder:7b | repaired-elide-plain | 40 | 40 | 2 | 0 | 0.000 [0.000, 0.088] | 0.014 | 20.9 |
| qwen2.5-coder:7b | repaired-whole-numbered | 40 | 40 | 3 | 0 | 0.000 [0.000, 0.088] | 0.022 | 16.9 |
| qwen2.5-coder:7b | repaired-whole-plain | 40 | 40 | 3 | 0 | 0.000 [0.000, 0.088] | 0.018 | 21.2 |
| qwen2.5-coder:7b | constrained-elide-numbered | 40 | 40 | 0 | 0 | 0.000 [0.000, 0.088] | 0.000 | 5.4 |
| qwen2.5-coder:7b | constrained-elide-plain | 40 | 40 | 0 | 0 | 0.000 [0.000, 0.088] | 0.000 | 3.8 |
| qwen2.5-coder:7b | constrained-whole-numbered | 40 | 40 | 0 | 0 | 0.000 [0.000, 0.088] | 0.000 | 7.1 |
| qwen2.5-coder:7b | constrained-whole-plain | 40 | 40 | 0 | 0 | 0.000 [0.000, 0.088] | 0.000 | 5.5 |
| qwen2.5-coder:1.5b | native-elide-numbered | 40 | 40 | 0 | 0 | 0.000 [0.000, 0.088] | 0.000 | 0.4 |
| qwen2.5-coder:1.5b | native-elide-plain | 40 | 40 | 0 | 0 | 0.000 [0.000, 0.088] | 0.000 | 0.3 |
| qwen2.5-coder:1.5b | native-whole-numbered | 40 | 40 | 0 | 0 | 0.000 [0.000, 0.088] | 0.000 | 0.3 |
| qwen2.5-coder:1.5b | native-whole-plain | 40 | 40 | 0 | 0 | 0.000 [0.000, 0.088] | 0.000 | 0.3 |
| qwen2.5-coder:1.5b | repaired-elide-numbered | 40 | 40 | 1 | 0 | 0.000 [0.000, 0.088] | 0.010 | 1.8 |
| qwen2.5-coder:1.5b | repaired-elide-plain | 40 | 40 | 0 | 0 | 0.000 [0.000, 0.088] | 0.000 | 1.8 |
| qwen2.5-coder:1.5b | repaired-whole-numbered | 40 | 40 | 0 | 0 | 0.000 [0.000, 0.088] | 0.000 | 2.6 |
| qwen2.5-coder:1.5b | repaired-whole-plain | 40 | 40 | 0 | 0 | 0.000 [0.000, 0.088] | 0.000 | 2.0 |
| qwen2.5-coder:1.5b | constrained-elide-numbered | 40 | 40 | 0 | 0 | 0.000 [0.000, 0.088] | 0.000 | 1.2 |
| qwen2.5-coder:1.5b | constrained-elide-plain | 40 | 40 | 0 | 0 | 0.000 [0.000, 0.088] | 0.000 | 1.0 |
| qwen2.5-coder:1.5b | constrained-whole-numbered | 40 | 40 | 0 | 0 | 0.000 [0.000, 0.088] | 0.000 | 1.5 |
| qwen2.5-coder:1.5b | constrained-whole-plain | 40 | 40 | 0 | 0 | 0.000 [0.000, 0.088] | 0.000 | 1.3 |

Success-rate intervals in this table are Wilson intervals on the count. "Could not serve" and "blocked by policy" units are not attempts and are in no rate.

## Primary: native against the product's value, constrained-envelope: task success (the registered metric)

**qwen2.5-coder:7b**, 40 tasks.

| Component | Shapley value | Main effect |
|---|---|---|
| protocol handling | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] |
| tool-result elision | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] |
| read-tool line numbering | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] |

Pairwise interactions: protocol handling × tool-result elision 0.000 [0.000, 0.000]; protocol handling × read-tool line numbering 0.000 [0.000, 0.000]; tool-result elision × read-tool line numbering 0.000 [0.000, 0.000].
Margin of protocol handling over the runner-up: 0.000 [0.000, 0.000].

**qwen2.5-coder:1.5b**, 40 tasks.

| Component | Shapley value | Main effect |
|---|---|---|
| protocol handling | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] |
| tool-result elision | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] |
| read-tool line numbering | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] |

Pairwise interactions: protocol handling × tool-result elision 0.000 [0.000, 0.000]; protocol handling × read-tool line numbering 0.000 [0.000, 0.000]; tool-result elision × read-tool line numbering 0.000 [0.000, 0.000].
Margin of protocol handling over the runner-up: 0.000 [0.000, 0.000].

Margin of the larger model (qwen2.5-coder:7b) less that of the smaller (qwen2.5-coder:1.5b), on the 40 tasks both have whole: 0.000 [0.000, 0.000].

By the registered thresholds, on this game: **inconclusive**. no configuration succeeded on any task for either model: every value is zero, which is a floor and not evidence of equal worth.

## Primary: native against the product's value, constrained-envelope: mean score (secondary measure, decides nothing)

**qwen2.5-coder:7b**, 40 tasks.

| Component | Shapley value | Main effect |
|---|---|---|
| protocol handling | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] |
| tool-result elision | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] |
| read-tool line numbering | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] |

Pairwise interactions: protocol handling × tool-result elision 0.000 [0.000, 0.000]; protocol handling × read-tool line numbering 0.000 [0.000, 0.000]; tool-result elision × read-tool line numbering 0.000 [0.000, 0.000].
Margin of protocol handling over the runner-up: 0.000 [0.000, 0.000].

**qwen2.5-coder:1.5b**, 40 tasks.

| Component | Shapley value | Main effect |
|---|---|---|
| protocol handling | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] |
| tool-result elision | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] |
| read-tool line numbering | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] |

Pairwise interactions: protocol handling × tool-result elision 0.000 [0.000, 0.000]; protocol handling × read-tool line numbering 0.000 [0.000, 0.000]; tool-result elision × read-tool line numbering 0.000 [0.000, 0.000].
Margin of protocol handling over the runner-up: 0.000 [0.000, 0.000].

Margin of the larger model (qwen2.5-coder:7b) less that of the smaller (qwen2.5-coder:1.5b), on the 40 tasks both have whole: 0.000 [0.000, 0.000].

## Secondary: native against repaired-text: task success (the registered metric)

**qwen2.5-coder:7b**, 40 tasks.

| Component | Shapley value | Main effect |
|---|---|---|
| protocol handling | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] |
| tool-result elision | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] |
| read-tool line numbering | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] |

Pairwise interactions: protocol handling × tool-result elision 0.000 [0.000, 0.000]; protocol handling × read-tool line numbering 0.000 [0.000, 0.000]; tool-result elision × read-tool line numbering 0.000 [0.000, 0.000].
Margin of protocol handling over the runner-up: 0.000 [0.000, 0.000].

**qwen2.5-coder:1.5b**, 40 tasks.

| Component | Shapley value | Main effect |
|---|---|---|
| protocol handling | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] |
| tool-result elision | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] |
| read-tool line numbering | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] |

Pairwise interactions: protocol handling × tool-result elision 0.000 [0.000, 0.000]; protocol handling × read-tool line numbering 0.000 [0.000, 0.000]; tool-result elision × read-tool line numbering 0.000 [0.000, 0.000].
Margin of protocol handling over the runner-up: 0.000 [0.000, 0.000].

Margin of the larger model (qwen2.5-coder:7b) less that of the smaller (qwen2.5-coder:1.5b), on the 40 tasks both have whole: 0.000 [0.000, 0.000].

By the registered thresholds, on this game: **inconclusive**. no configuration succeeded on any task for either model: every value is zero, which is a floor and not evidence of equal worth.

## Secondary: native against repaired-text: mean score (secondary measure, decides nothing)

**qwen2.5-coder:7b**, 40 tasks.

| Component | Shapley value | Main effect |
|---|---|---|
| protocol handling | 0.019 [0.003, 0.041] | 0.019 [0.003, 0.041] |
| tool-result elision | -0.001 [-0.009, 0.005] | -0.002 [-0.007, 0.003] |
| read-tool line numbering | 0.003 [-0.001, 0.009] | 0.003 [-0.002, 0.009] |

Pairwise interactions: protocol handling × tool-result elision -0.003 [-0.015, 0.007]; protocol handling × read-tool line numbering 0.005 [-0.004, 0.018]; tool-result elision × read-tool line numbering 0.001 [-0.010, 0.011].
Margin of protocol handling over the runner-up: 0.016 [0.000, 0.040].

**qwen2.5-coder:1.5b**, 40 tasks.

| Component | Shapley value | Main effect |
|---|---|---|
| protocol handling | 0.003 [0.000, 0.010] | 0.003 [0.000, 0.008] |
| tool-result elision | 0.003 [0.000, 0.010] | 0.003 [0.000, 0.008] |
| read-tool line numbering | 0.003 [0.000, 0.010] | 0.003 [0.000, 0.008] |

Pairwise interactions: protocol handling × tool-result elision 0.005 [0.000, 0.015]; protocol handling × read-tool line numbering 0.005 [0.000, 0.015]; tool-result elision × read-tool line numbering 0.005 [0.000, 0.015].
Margin of protocol handling over the runner-up: 0.000 [0.000, 0.000].

Margin of the larger model (qwen2.5-coder:7b) less that of the smaller (qwen2.5-coder:1.5b), on the 40 tasks both have whole: 0.016 [0.000, 0.040].

## H-2

**inconclusive** (decided on the primary game, as Amendment 1 says). no configuration succeeded on any task for either model: every value is zero, which is a floor and not evidence of equal worth.

The number behind it: qwen2.5-coder:7b: protocol handling's Shapley value of task success 0.000 [0.000, 0.000]; qwen2.5-coder:1.5b: protocol handling's Shapley value of task success 0.000 [0.000, 0.000].
