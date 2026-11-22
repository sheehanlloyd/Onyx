# Onyx scorecard

Local models measured on this repository's own tasks, on this machine. 54 of 54 planned units ran.

**Ranking** (by mean score, then by tasks reproduced exactly): 1. qwen2.5-coder:7b; 2. llama3.2:3b; 3. qwen2.5-coder:1.5b.

| Model | Scored tasks | Reproduced exactly | Mean score | Could not serve | Lines removed that the author kept |
|---|---|---|---|---|---|
| qwen2.5-coder:7b | 18 | 0 of 18 | 0.08 | 0 | 28 |
| llama3.2:3b | 18 | 0 of 18 | 0.01 | 0 | 168 |
| qwen2.5-coder:1.5b | 18 | 0 of 18 | 0.01 | 0 | 175 |

The score is the F1 between the lines a model changed and the lines the author changed, capped at 0.5 when the model removed a line the author kept. It measures closeness to the author's change, not correctness. A task a model could not be served is not a score of zero and is in no mean.

## Tasks

18 tasks: 18 from this repository's history, 0 from your own accepted requests.
Held out in time: 18 (authored after 2024-09-25, when the latest of these models was published); not held out: 0; unknown: 0.

## Provenance

- Generated: 2026-11-22T10:50:19.760Z
- Repository: worktree at 126d11c7c9e962687b3e8d23d29aae8f768595e4
- Machine: Apple M4 Pro, 24 GiB, darwin arm64
- Parameters: tier S, temperature 0, seed 1, metric changed-line-f1-preserving/2, task files up to 12000 characters
- Time: took 1095 s; estimated 422 s from the datasheets

### qwen2.5-coder:7b

- Weights digest: dae161e27b0e90dd1856c8bb3209201fd6736d8eb66298e75ed87571486f4364
- Runtime: ollama 0.33.0
- Context: 16384 tokens (measured)
- Published: 2024-09-19
- Datasheet, measured 2026-11-22T10:30:52.334Z:
  - Tool calls: 0 of 5 on the tool channel; 5 of 5 of the rest readable as text
  - Schema enforced: object 3 of 3, enum 3 of 3, nested 3 of 3
  - Context: 16384 tokens verified (requested nothing, reported 16384); a prompt past it lost its start
  - Output cap honoured 3 of 3; stop honoured 3 of 3
  - Reasoning: none seen (0 of 3 replies)
  - Same seed, same reply: 3 of 3; log-probabilities returned: 3 of 3
  - First token: 3254 ms cold, 92 ms warm; 48.9 tokens a second

### llama3.2:3b

- Weights digest: a80c4f17acd55265feec403c7aef86be0c25983ab279d83f3bcd3abbcb5b8b72
- Runtime: ollama 0.33.0
- Context: 16384 tokens (measured)
- Published: 2024-09-25
- Datasheet, measured 2026-11-22T10:32:02.079Z:
  - Tool calls: 5 of 5 on the tool channel; 0 of 0 of the rest readable as text
  - Schema enforced: object 3 of 3, enum 3 of 3, nested 3 of 3
  - Context: 16384 tokens verified (requested nothing, reported 16384); a prompt past it lost its start
  - Output cap honoured 3 of 3; stop honoured 3 of 3
  - Reasoning: none seen (0 of 3 replies)
  - Same seed, same reply: 3 of 3; log-probabilities returned: 3 of 3
  - First token: 1911 ms cold, 44 ms warm; 97.1 tokens a second

### qwen2.5-coder:1.5b

- Weights digest: d7372fd828518a4d38b1eb196c673c31a85f2ed302b3d1e406c4c2d1b64a0668
- Runtime: ollama 0.33.0
- Context: 16384 tokens (measured)
- Published: 2024-09-19
- Datasheet, measured 2026-11-22T10:31:18.058Z:
  - Tool calls: 0 of 5 on the tool channel; 3 of 5 of the rest readable as text
  - Schema enforced: object 3 of 3, enum 3 of 3, nested 3 of 3
  - Context: 16384 tokens verified (requested nothing, reported 16384); a prompt past it lost its start
  - Output cap honoured 3 of 3; stop honoured 3 of 3
  - Reasoning: none seen (0 of 3 replies)
  - Same seed, same reply: 3 of 3; log-probabilities returned: 3 of 3
  - First token: 878 ms cold, 28 ms warm; 172.1 tokens a second

## The router's picks

- The router's pick was the model you picked in a tournament in 0 of 0 tournaments.
- You kept what the router's pick produced in 0 of 0 runs with a recorded outcome.
- These are logged choices, not a randomized comparison: they say what happened with the model the router picked, and nothing about a model it did not pick.

## Every attempt

| Model | Task | Outcome | Score | Exact | Why |
|---|---|---|---|---|---|
| qwen2.5-coder:7b | 9eea8268780d | attempted | 0.05 | no | 4% of the author's changed lines reproduced, 8% of the model's on target; the reply removed 10 lines the author kept ("assert.deepStrictEqual({") |
| qwen2.5-coder:7b | 6f776c734816 | attempted | 0.00 | no | 0% of the author's changed lines reproduced, 0% of the model's on target; the reply removed 1 line the author kept ("## The new run, and what it could not cover") |
| qwen2.5-coder:7b | ce208b803c04 | attempted | 0.00 | no | 0% of the author's changed lines reproduced, 0% of the model's on target; the reply removed 1 line the author kept ("## Integration run") |
| qwen2.5-coder:7b | c1cffbed963d | attempted | 0.00 | no | 0% of the author's changed lines reproduced, 0% of the model's on target; the reply removed 1 line the author kept ("## Integration run") |
| qwen2.5-coder:7b | 16d61d75a060 | attempted | 0.00 | no | no edit block could be located in the file |
| qwen2.5-coder:7b | 0e8e5cbca141 | attempted | 0.00 | no | 0% of the author's changed lines reproduced, 0% of the model's on target; the reply removed 6 lines the author kept ("refused, naming the first unmatched line`") |
| qwen2.5-coder:7b | ba47c6525d41 | attempted | 0.00 | no | 0% of the author's changed lines reproduced, 0% of the model's on target; the reply removed 1 line the author kept ("## Integration run") |
| qwen2.5-coder:7b | 85e1ed30dca1 | attempted | 0.38 | no | 28% of the author's changed lines reproduced, 63% of the model's on target; the reply removed 1 line the author kept ("Branch: `module-2` → draft pull request sheehanlloyd/Onyx#3.…") |
| qwen2.5-coder:7b | ce3f3462ec88 | attempted | 0.00 | no | 0% of the author's changed lines reproduced, 0% of the model's on target |
| qwen2.5-coder:7b | 288b78e12f3a | attempted | 0.13 | no | 8% of the author's changed lines reproduced, 50% of the model's on target |
| qwen2.5-coder:7b | db1173a44dd4 | attempted | 0.00 | no | 0% of the author's changed lines reproduced, 0% of the model's on target |
| qwen2.5-coder:7b | 7055ed1faa38 | attempted | 0.00 | no | no edit block could be located in the file |
| qwen2.5-coder:7b | 51c06194368b | attempted | 0.00 | no | 0% of the author's changed lines reproduced, 0% of the model's on target |
| qwen2.5-coder:7b | 8b85d0efe707 | attempted | 0.40 | no | 33% of the author's changed lines reproduced, 50% of the model's on target |
| qwen2.5-coder:7b | 10611e4b2fdb | attempted | 0.20 | no | 13% of the author's changed lines reproduced, 50% of the model's on target |
| qwen2.5-coder:7b | 7588e115f865 | attempted | 0.00 | no | 0% of the author's changed lines reproduced, 0% of the model's on target; the reply removed 1 line the author kept ("if (workspace.workspaceFolders === undefined \|\| workspace.is…") |
| qwen2.5-coder:7b | 652443110404 | attempted | 0.35 | no | 38% of the author's changed lines reproduced, 33% of the model's on target |
| qwen2.5-coder:7b | 35cffba9f59c | attempted | 0.00 | no | 0% of the author's changed lines reproduced, 0% of the model's on target; the reply removed 6 lines the author kept ("## VS Code Main Build") |
| llama3.2:3b | 9eea8268780d | attempted | 0.00 | no | 0% of the author's changed lines reproduced, 0% of the model's on target; the reply removed 9 lines the author kept ("/*----------------------------------------------------------…") |
| llama3.2:3b | 6f776c734816 | attempted | 0.00 | no | no edit block could be located in the file |
| llama3.2:3b | ce208b803c04 | attempted | 0.00 | no | no edit block could be located in the file |
| llama3.2:3b | c1cffbed963d | attempted | 0.00 | no | 0% of the author's changed lines reproduced, 0% of the model's on target; the reply removed 52 lines the author kept ("# B9. Inline edits stage before acceptance and preserve inte…") |
| llama3.2:3b | 16d61d75a060 | attempted | 0.00 | no | 0% of the author's changed lines reproduced, 0% of the model's on target; the reply removed 58 lines the author kept ("# B7. Versioned proposals with stable hunk identity") |
| llama3.2:3b | 0e8e5cbca141 | attempted | 0.00 | no | no edit block could be located in the file |
| llama3.2:3b | ba47c6525d41 | attempted | 0.00 | no | no edit block could be located in the file |
| llama3.2:3b | 85e1ed30dca1 | attempted | 0.00 | no | 0% of the author's changed lines reproduced, 0% of the model's on target |
| llama3.2:3b | ce3f3462ec88 | attempted | 0.00 | no | no edit block could be located in the file |
| llama3.2:3b | 288b78e12f3a | attempted | 0.07 | no | 8% of the author's changed lines reproduced, 6% of the model's on target; the reply removed 8 lines the author kept ("# Onyx plan state") |
| llama3.2:3b | db1173a44dd4 | attempted | 0.00 | no | no edit block could be located in the file |
| llama3.2:3b | 7055ed1faa38 | attempted | 0.00 | no | 0% of the author's changed lines reproduced, 0% of the model's on target; the reply removed 4 lines the author kept ("Isolated checkout: branch `upstream-1.147.0` in a sibling cl…") |
| llama3.2:3b | 51c06194368b | attempted | 0.00 | no | reply was prose, not an edit |
| llama3.2:3b | 8b85d0efe707 | attempted | 0.00 | no | 0% of the author's changed lines reproduced, 0% of the model's on target |
| llama3.2:3b | 10611e4b2fdb | attempted | 0.00 | no | no edit block could be located in the file |
| llama3.2:3b | 7588e115f865 | attempted | 0.00 | no | no edit block could be located in the file |
| llama3.2:3b | 652443110404 | attempted | 0.18 | no | 25% of the author's changed lines reproduced, 14% of the model's on target |
| llama3.2:3b | 35cffba9f59c | attempted | 0.00 | no | 0% of the author's changed lines reproduced, 0% of the model's on target; the reply removed 37 lines the author kept ("```bash") |
| qwen2.5-coder:1.5b | 9eea8268780d | attempted | 0.00 | no | no edit block could be located in the file |
| qwen2.5-coder:1.5b | 6f776c734816 | attempted | 0.00 | no | no edit block could be located in the file |
| qwen2.5-coder:1.5b | ce208b803c04 | attempted | 0.00 | no | no edit block could be located in the file |
| qwen2.5-coder:1.5b | c1cffbed963d | attempted | 0.00 | no | no edit block could be located in the file |
| qwen2.5-coder:1.5b | 16d61d75a060 | attempted | 0.00 | no | no edit block could be located in the file |
| qwen2.5-coder:1.5b | 0e8e5cbca141 | attempted | 0.00 | no | 0% of the author's changed lines reproduced, 0% of the model's on target; the reply removed 3 lines the author kept ("# B6. Exact-or-refuse applier") |
| qwen2.5-coder:1.5b | ba47c6525d41 | attempted | 0.00 | no | 0% of the author's changed lines reproduced, 0% of the model's on target; the reply removed 8 lines the author kept ("# B15. Context allocation: request what the model can use") |
| qwen2.5-coder:1.5b | 85e1ed30dca1 | attempted | 0.24 | no | 44% of the author's changed lines reproduced, 16% of the model's on target; the reply removed 41 lines the author kept ("## DEC-05 (upstream baseline)") |
| qwen2.5-coder:1.5b | ce3f3462ec88 | attempted | 0.00 | no | 0% of the author's changed lines reproduced, 0% of the model's on target; the reply removed 39 lines the author kept ("Module 1 (sheehanlloyd/Onyx#1) was merged into `main` first,…") |
| qwen2.5-coder:1.5b | 288b78e12f3a | attempted | 0.00 | no | 0% of the author's changed lines reproduced, 0% of the model's on target; the reply removed 33 lines the author kept ("\| A1 \| codex/a1-inventory → #1 \| A1.md, a1-inventory.json \| …") |
| qwen2.5-coder:1.5b | db1173a44dd4 | attempted | 0.00 | no | 0% of the author's changed lines reproduced, 0% of the model's on target; the reply removed 19 lines the author kept ("# L4. Harness configuration as data") |
| qwen2.5-coder:1.5b | 7055ed1faa38 | attempted | 0.00 | no | no edit block could be located in the file |
| qwen2.5-coder:1.5b | 51c06194368b | attempted | 0.00 | no | 0% of the author's changed lines reproduced, 0% of the model's on target; the reply removed 19 lines the author kept ("# C7. Broader index coverage") |
| qwen2.5-coder:1.5b | 8b85d0efe707 | attempted | 0.00 | no | 0% of the author's changed lines reproduced, 0% of the model's on target |
| qwen2.5-coder:1.5b | 10611e4b2fdb | attempted | 0.00 | no | 0% of the author's changed lines reproduced, 0% of the model's on target; the reply removed 13 lines the author kept ("# A9. Upstream baseline trial") |
| qwen2.5-coder:1.5b | 7588e115f865 | attempted | 0.00 | no | no edit block could be located in the file |
| qwen2.5-coder:1.5b | 652443110404 | attempted | 0.00 | no | no edit block could be located in the file |
| qwen2.5-coder:1.5b | 35cffba9f59c | attempted | 0.00 | no | no edit block could be located in the file |
