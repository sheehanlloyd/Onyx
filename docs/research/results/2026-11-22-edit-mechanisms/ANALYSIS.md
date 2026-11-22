# The edit mechanisms: 2026-11-22-edit-mechanisms

Computed from the saved replies of 4 campaigns by `node test/onyx/lab/analyze-edits.mts --out docs/research/results/2026-11-22-edit-mechanisms --campaign docs/research/results/2026-11-22-single-turn --campaign docs/research/results/2026-11-22-confidence --campaign docs/research/results/2026-11-22-attribution --anchors docs/research/results/2026-11-22-anchors-2`. No model was run for this analysis. `attempts.jsonl` has one line an attempt, with digests and verdicts and no source text.

## Where the attempts come from

| Campaign | Records | Replies or edit calls | Attempts (blocks) |
|---|---|---|---|
| 2026-11-22-single-turn | 240 | 240 | 303 |
| 2026-11-22-confidence | 600 | 600 | 726 |
| 2026-11-22-attribution | 960 | 280 | 272 |
| 2026-11-22-anchors-2 | 160 | 55 | 0 |

## H-3: the appliers

1301 attempts, pooled. An attempt is one SEARCH/REPLACE block against the file as it was when the block was sent.

| Applier | Placed | Apply rate | Placed though the text is not in the file | Silently wrong | Silently-wrong rate (of attempts) | Mean score |
|---|---|---|---|---|---|---|
| exact-unique | 424 of 1301 | 32.6% [30.1, 35.2] | 0 | 350 | 26.9% [24.6, 29.4] | 0.030 |
| whitespace-insensitive | 649 of 1301 | 49.9% [47.2, 52.6] | 178 | 551 | 42.4% [39.7, 45.1] | 0.057 |
| unique-first-line | 594 of 1301 | 45.7% [43.0, 48.4] | 195 | 512 | 39.4% [36.7, 42.0] | 0.061 |
| fuzzy | 798 of 1301 | 61.3% [58.7, 63.9] | 319 | 700 | 53.8% [51.1, 56.5] | 0.067 |

Apply rate of the fuzzy comparator less exact-unique: 28.7 points [26.1, 31.3] (bootstrap over attempts). Rates are with Wilson intervals. "Silently wrong" is a placement of a block whose text is not in the file exactly, or one whose result changes a line the author did not change; exact-unique can only be the second.

**qwen2.5-coder:1.5b**: 446 attempts; exact-unique placed 83, whitespace-insensitive 76, unique-first-line 88, fuzzy 136; fuzzy less exact 11.9 points [8.5, 15.5]; fuzzy silently wrong 106.

**qwen2.5-coder:7b**: 855 attempts; exact-unique placed 341, whitespace-insensitive 573, unique-first-line 506, fuzzy 662; fuzzy less exact 37.5 points [34.3, 40.8]; fuzzy silently wrong 594.

By the registered thresholds: **supported**. decided on the pooled sample of 1301 attempts; the registered minimum is 500 for each model and the models have qwen2.5-coder:1.5b: 446, qwen2.5-coder:7b: 855.

## H-4: constrained anchors against free-form

| Model | Arm | Runs | Edit calls | Refused | Runs whose proposal changed a line the author did not | Mean score | Median seconds | 90th percentile seconds |
|---|---|---|---|---|---|---|---|---|
| qwen2.5-coder:7b | search-replace | 40 | 0 | 0 | 0 | 0.000 | 4.8 | 6.2 |
| qwen2.5-coder:7b | constrained-anchors | 40 | 31 | 0 | 30 | 0.006 | 8.1 | 44.6 |
| qwen2.5-coder:1.5b | search-replace | 40 | 0 | 0 | 0 | 0.000 | 1.4 | 2.7 |
| qwen2.5-coder:1.5b | constrained-anchors | 40 | 24 | 1 | 21 | 0.003 | 1.9 | 17.0 |

Tasks with an edit call in both arms: 0.

By the registered thresholds: **inconclusive**. no task had an edit call in both arms (55 edit calls in all): there is no pair to compare.

## H-5: grounded against ungrounded edits

Edits of agent runs whose certificate says where the model had seen the text it quoted. Grounded: 163 edits, mean score 0.021. Ungrounded: 36 edits, mean score 0.000. Left out: 0 unknown, 73 not applicable. Difference in mean score: 0.021 [0.009, 0.034]; Cliff's delta 0.08. The registered minimum is 300 edits a class.

By the registered thresholds: **refuted**. the registered minimum is 300 edits a class; Cliff's delta 0.08.
