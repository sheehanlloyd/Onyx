# Module 1 state

*Written 2026-11-19 at the end of a session that stopped on a usage limit. Branch `module-1`, draft PR
sheehanlloyd/Onyx#1. Everything below is evidence-backed by the per-item reports in this folder.*

## Done and merged into module-1

| Item | Branch | Report | Evidence |
|---|---|---|---|
| A1 | codex/a1-inventory | A1.md, a1-inventory.json | R-37 self-check |
| A2 | a2-nul-bytes | A2.md | hygiene `nul-bytes` |
| A3 | a3-stale-urls | A3.md | hygiene `stale-strings`, `identity-urls` |
| A4 | a4-e2e-path | A4.md | harness-paths self-check |
| A5 | a5-speculative | A5.md | hygiene `image-manifest` |
| A6 | a6-hygiene-ci | A6.md | onyx-ci hygiene job |
| A7 | a7-ci-asserts | A7.md | R-23 self-check; CI runs 44637992357 (cold) and 44641307251 (warm, cache hit) both green |
| A12 | a12-module-gate | A12.md | R-57 self-check; `run-module-gate.mts` |
| A8 | a8-packaged-harness | A8.md, packaged-smoke-*.json | packaged smoke CI 44637992474 (release mode fails as expected, owner B1/B3) |
| A9 | a9-upstream-trial | A9.md, upstream-drill/1.147.0.md | trial checkout, drill workflow |
| A10 | a10-lfs-strategy | A10.md | REBASE.md section |
| A11 | a11-inherited-automation | A11.md | hygiene `inherited-automation` |
| L1 | l1-sim-rig | L1.md | OnyxSim suite, 240–264 episodes/s |
| L2 | l2-harness-contract | L2.md, docs/research/HARNESS-CONTRACT.md | R-42, 11 owned baseline exceptions |

Module-1 head before L3: e7249800d0a. CI run F for that push: 44643548593 (was in progress when the
session ended; check it and add it to A7.md's table).

## In progress: L3 (branch `codex/l3-trace-provenance`, head 9f552e4b3dd, pushed, NOT merged)

Done on the branch, all green locally (typecheck-client clean, transpile 2.7 s, `--grep OnyxTrace` 3
passing, `--grep OnyxSim` 7 passing incl. the new R-43 sim test, eslint 0 errors / 3 `in`-operator
warnings in `onyxTrace.ts` lines 187 and 205 to replace with `hasKey` or `typeof` checks):

- `src/vs/workbench/contrib/onyx/common/onyxTrace.ts`: schema v2, `parseTrace`, fail-closed `validateTrace`
- one `trace` header and one `traceTurn` record per model turn in the journal (agent loop); approvals from
  the terminal tool with `source`; acceptances from the change set service
- seed on every chat request (`IOnyxChatParams.seed`), `seedHonoured` from the echoed seed /
  `system_fingerprint`; model digest and Ollama version on discovered models
- mock-ollama echoes the seed; sim fakes report `seedHonoured`
- R-43 at the pure layer (`onyxTrace.test.ts`) and the simulator layer (`onyxSim.test.ts`)

Still to do for L3, in order:

1. `test/onyx/lab/manifest.schema.json` and `test/onyx/lab/manifest.mts` (validator); `make-charts.mts`
   requires `--manifest` (add `--out-dir`) and refuses invalid input
2. `docs/research/README.md` and `docs/research/PREREGISTRATION.md` (H-1..H-10 with metric, sample size,
   analysis, threshold); record the pre-registration commit hash here
3. `test/onyx/checks/r43-provenance.test.mts`: chart refusal; seed on the wire and honoured, via the compiled
   node runtime against the mock started with a seed
4. an e2e check that validates the journal of a real run as v2
5. gate row `R-43` in `test/onyx/gates/module-1.json`; README/test README updates; `docs/progress/L3.md`
6. merge into module-1, push; wait for CI (two consecutive greens needed, second warm)

## After L3

- `node test/onyx/run-fresh.mts --stamp-only` then
  `ONYX_PACKAGED_APP=/Users/sheehan/Desktop/VSCode-darwin-arm64/Onyx.app node test/onyx/run-module-gate.mts --module 1`
  (the untracked `docs/progress/gate-module-1.json` is a partial run; overwrite it with the full one, then
  commit it)
- the full integration suite from ActionPlan §11 once more; only allowed failures: packaged release mode
  missing read tools, and baseline-exceptions.json violations with owners
- update this file, commit, push; final report

## Decisions waiting on a human

- DEC-05: recommendation is to keep the current base through Module 1 and rebase onto 1.147.0 at the start
  of Module 2 (upstream moved to pnpm 12.16.0 and Node 24.22.1; see A9.md and upstream-drill/1.147.0.md).

## Open baseline exceptions (test/onyx/sim/baseline-exceptions.json)

I-02/repository-allowlist (B2); I-03/no-time-budget (B12, B10); I-03/status-overwritten (B10);
I-04/no-output-cap (B13); I-04/over-budget (B13); I-05/command-after-stop, I-05/stage-after-stop (B10);
I-08/inexact-anchor-staged (B6); I-08/ambiguous-anchor-staged (B6, B7); I-11/truncated-reported-complete
(B12); I-13/oversized-proposal (B7).

## Housekeeping

- Owner's checkout `/Users/sheehan/Desktop/onyx` is untouched (hashes re-checked at session end; index
  still absent). The four audit documents are excluded via `.git/info/exclude` here and never committed.
- `/Users/sheehan/Desktop/onyx-upstream-trial` is a disposable trial clone (never pushed); delete when A9
  is no longer needed.
