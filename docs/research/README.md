# Onyx research

*The agenda in one page. L3, 2026-11-19. The rules are ActionPlan DEC-09; the guarantees are
[HARNESS-CONTRACT.md](HARNESS-CONTRACT.md); the hypotheses and their thresholds are
[PREREGISTRATION.md](PREREGISTRATION.md); the data goes under [results/](results/README.md).*

## Thesis

Local inference changes what a coding harness can be. Trials cost time and nothing else, so a harness can be
measured rather than trusted. Weights are pinned by digest, so a measurement names the exact model. The decoder
can be constrained, so a protocol can be enforced rather than requested. The code under test never leaves the
machine, so the user's own repository is the benchmark. Onyx uses those four properties to treat the model as
an untrusted, measurable component: every guarantee in the harness contract holds for any model output, and
every published number regenerates from committed data.

## Questions

1. **Assurance.** Does a seeded simulation campaign with concurrent user actions and environment faults find
   the defects three independent audits found, and every defect we later fix when it is resurrected? (H-1)
2. **Attribution.** For small local models, which harness component is worth the most, and does the answer
   change with model size and with the repository? (H-2, H-7)
3. **Edit mechanisms.** What does exact-or-refuse cost against fuzzy appliers, what does it prevent, and do
   constrained anchors and grounding change the trade? (H-3, H-4, H-5)
4. **Determinism.** With a fixed seed at temperature 0, how often does a multi-turn trajectory repeat exactly on
   a local runtime, and where does it first diverge? (H-6)
5. **Confidence.** Can agreement across samples or token probability tell a correct hunk from a wrong one well
   enough to show a badge? (H-8)
6. **Efficiency.** Does cache-aware eviction save re-processed prompt tokens at equal success, and does energy
   per solved task rank models differently from tokens per second? (H-9, H-10)

## Rules

- **Pre-registration first.** Each hypothesis has a metric, a sample size, an analysis and decision thresholds
  committed before the campaign that tests it. The pre-registration commit hash is recorded in
  `docs/progress/STATE.md` and must be an ancestor of every results commit. Amendments carry a date and a
  reason and are made only before that hypothesis's data exists.
- **Provenance.** Every run writes a v2 trace (`src/vs/workbench/contrib/onyx/common/onyxTrace.ts`): harness
  configuration hash, model identifier and digest, runtime and version, sampling parameters including the seed
  and whether the runtime honoured it, the tool list with schema hashes, and per turn the request digest,
  response, stream end, tool calls, approvals and acceptances. Every campaign has a manifest
  (`test/onyx/lab/manifest.schema.json`). `make-charts.mts` refuses to draw without one.
- **Equal prominence.** Supported, refuted, inconclusive and unavailable-on-this-hardware are all published.
  An unreported hypothesis is the only failure.
- **No model-graded scores.** Correctness is exact application, reference diffs and tests, never a model's
  opinion of another model's output.
- **Scoped claims.** "First", "novel" or "never done" appear only after a dated prior-art check in
  `RELATED.md` (L19) and are scoped to a date and a setting.

## The package

| File | Item | Holds |
|---|---|---|
| `HARNESS-CONTRACT.md` | L2 | I-01 to I-14, observable definitions, baseline exceptions with owners |
| `PREREGISTRATION.md` | L3 | H-1 to H-10 with metric, sample size, analysis, thresholds; amendments |
| `results/<date>-<name>/` | L9 to L18 | manifest, raw traces or digests, summary, regeneration command |
| `RELATED.md` | L19 | the dated prior-art check |
| `REPORT.md` | L19 | the paper-form report; every number regenerates (R-58) |

## How to run what exists today

```bash
./scripts/test.sh --grep "OnyxSim"                                  # the simulation suite (L1, L2)
./scripts/test.sh --grep "OnyxTrace|OnyxRuntimeService"             # trace schema, seed on the wire (L3)
node --test test/onyx/checks/r43-provenance.test.mts                # charts refuse without a manifest (L3)
node test/onyx/lab/manifest.mts test/onyx/lab/manifest.example.json # validate a manifest
```
