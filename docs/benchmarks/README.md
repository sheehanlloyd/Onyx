# Benchmark reports

Every chart published in this repository is drawn from a report in this folder (C8).

| Folder | What it holds |
|---|---|
| `<date>/report.json` | What `test/onyx/run-benchmarks.mts --json-out` wrote: a `provenance` block (commit, clean tree or not, machine, load average, runtime versions, model digests, parameters), every result row, every repository-benchmark attempt, every failure and every skip |
| `<date>/manifest.json` | The experiment manifest the chart builder requires (`test/onyx/lab/manifest.schema.json`), with the commands that regenerate the report and the charts |

`node test/onyx/make-charts.mts --manifest <date>/manifest.json <date>/report.json` redraws the charts. It
refuses a report without the provenance block.

## 2026-11-21

Three models on Ollama 0.33.0, on the reference machine (Apple M4 Pro, 24 GB). LM Studio was not running
and nothing was measured on it; speculative decoding was not measured.

The machine was busy during the run: a one-minute load average of 39 at the start and 14 at the end, on 14
cores. Throughput and latency are about half of what the same models measured on the idle machine the same
day (`docs/research/results/2026-11-21-context-allocation/`). Tool-call proportions and repository-benchmark
scores (temperature 0) do not depend on load, with one exception that the report records: one task timed out
for `llama3.2:3b` and is under `failures`, not scored as zero.
