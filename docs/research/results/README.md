# Research results

Each campaign that produces a published number lives in its own directory here, named
`<date>-<name>` after its manifest's `name`, and holds:

| File | What |
|---|---|
| `manifest.json` | The experiment manifest, valid against `test/onyx/lab/manifest.schema.json`: models with digests, seeds, sampling, harness configurations with their hashes, the task-set hash, repetitions, the machine, and the command that regenerates each table |
| `summary.json` | The numbers the report quotes, with denominators and intervals |
| `traces/` or `trace-digests.json` | The raw v2 journals of every run (`onyxTrace.ts`), or their digests when the traces are too large to commit |
| anything else | Only what `manifest.regenerate` can rebuild |

`node test/onyx/lab/manifest.mts --results docs/research/results/<dir>` checks a directory. The pre-registration
commit (`docs/research/PREREGISTRATION.md`) must be an ancestor of every commit that adds a directory here
(DEC-09); the Module 4 gate checks that. Module 1 defined the format; Modules 3 and 4 fill it.

| Directory | Item | What |
|---|---|---|
| `2026-11-21-datasheets/` | L5 | Datasheets for `qwen2.5-coder:7b` and `qwen2.5-coder:1.5b` on Ollama 0.33.0. Its traces are probe transcripts, not agent journals: each request in outline and each reply as it came. The probes do not go through the agent loop, so the manifest's harness configuration is a placeholder that says so |
