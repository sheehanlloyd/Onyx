# Benchmark reports

Every chart published in this repository is drawn from a report in this folder (C8).

| Folder | What it holds |
|---|---|
| `<date>/report.json` | What `test/onyx/run-benchmarks.mts --json-out` wrote: a `provenance` block (commit, clean tree or not, machine, load average, runtime versions, model digests, parameters), every result row, every repository-benchmark attempt, every failure and every skip |
| `<date>/speculative.json` | Where present: a second report from `--only-speculative --json-out`, the speculative-decoding comparison alone |
| `<date>/manifest.json` | The experiment manifest the chart builder requires (`test/onyx/lab/manifest.schema.json`), with the commands that regenerate the report and the charts |

`node test/onyx/make-charts.mts --manifest <date>/manifest.json <date>/report.json [<date>/speculative.json]`
redraws the charts. It refuses a report without the provenance block.

## 2026-11-24

Both runtimes, on the reference machine (Apple M4 Pro, 24 GB): three models on Ollama 0.33.0 and three
qwen2.5-coder variants on LM Studio 0.4.23, whose GGUF files have the same SHA-256 as the Ollama weight layers.
The README's charts come from this run.

`report.json` is the full run (commit `aa32e8f`, clean tree; load average 4 at the start, 19 at the end, on 14
cores). Its LM Studio `version` is `null`: the reader looked for the version at the top level of LM Studio's
file, where it is not; it is fixed, and `speculative.json` has it (0.4.23). Its single speculative row (1.33x)
is from the one-prompt measurement this branch replaced.

`speculative.json` is the speculative-decoding comparison alone (commit `373fc58`, clean tree; load 14 to 16),
code and prose apart, median of three rounds, with the draft's attachment read back from LM Studio before
measuring: code 1.49x, prose 0.97x.

## 2026-11-21

Superseded by 2026-11-24 for the README; kept as the record of that run. Three models on Ollama 0.33.0, on the reference machine (Apple M4 Pro, 24 GB). LM Studio was not running
and nothing was measured on it; speculative decoding was not measured.

The machine was busy during the run: a one-minute load average of 39 at the start and 14 at the end, on 14
cores. Throughput and latency are about half of what the same models measured on the idle machine the same
day (`docs/research/results/2026-11-21-context-allocation/`). Tool-call proportions and repository-benchmark
scores (temperature 0) do not depend on load, with one exception that the report records: one task timed out
for `llama3.2:3b` and is under `failures`, not scored as zero.
