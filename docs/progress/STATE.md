# Onyx plan state
Plan version: v4
Current module: 1      Status: gate passed
Revision: 8b85d0efe70 (branch `module-1`; this file's commit follows it and changes nothing else)
Isolated checkout: branch `module-1` in a sibling clone of the owner's folder (clone directory `onyx-module-1`), draft PR sheehanlloyd/Onyx#1; the four audit documents are excluded there via `.git/info/exclude` and never committed
Pre-registration commit: 5f98a0ca2c7 (adds `docs/research/PREREGISTRATION.md`; merged as efbd077fd53)

## Module 1
Items done:
| Item | Branch → PR | Report | Gate check ids |
|---|---|---|---|
| A1 | codex/a1-inventory → #1 | A1.md, a1-inventory.json | R-37 |
| A2 | a2-nul-bytes → #1 | A2.md | hygiene (nul-bytes) |
| A3 | a3-stale-urls → #1 | A3.md | hygiene (stale-strings, identity-urls) |
| A4 | a4-e2e-path → #1 | A4.md | A4-paths |
| A5 | a5-speculative → #1 | A5.md | hygiene (image-manifest) |
| A6 | a6-hygiene-ci → #1 | A6.md | hygiene, A6-fixtures |
| A7 | a7-ci-asserts → #1 | A7.md | R-23, R-35, benchmarks |
| A12 | a12-module-gate → #1 | A12.md | R-57 |
| A8 | a8-packaged-harness → #1 | A8.md, packaged-smoke-baseline.json, packaged-smoke-release.json | packaged-baseline, packaged-release (expected failure) |
| A9 | a9-upstream-trial → #1 | A9.md, upstream-drill/1.147.0.md | evidence-A1-A11 (drill workflow runs weekly and on dispatch) |
| A10 | a10-lfs-strategy → #1 | A10.md | evidence-A1-A11 |
| A11 | a11-inherited-automation → #1 | A11.md | hygiene (inherited-automation) |
| L1 | l1-sim-rig → #1 | L1.md | R-41, sim-episodes, sim-tables-sync |
| L2 | l2-harness-contract → #1 | L2.md, docs/research/HARNESS-CONTRACT.md | R-41 (R-42), sim-smoke, sim-tables-sync |
| L3 | codex/l3-trace-provenance → #1 | L3.md, docs/research/README.md, PREREGISTRATION.md | R-43, R-43-unit, e2e (two R-43 checks) |
Items remaining: none
Scope dispositions:
  A8: release mode included as a harness, expected to fail until B1 and B3 (5 of 15 checks: the four read tools are absent, so read → staged edit → accept cannot run); baseline mode passes
  A9: trial run on upstream 1.147.0 (pnpm 12.16.0, Node 24.22.1 required); recommendation recorded, decision is DEC-05's
  L1: the rig does not instantiate the inline-edit controller, the Changes view, diagnostics export, child processes or the memory tool; the contract names the owner item per invariant
  L3: the manifest-driven seed (a lab run without a profile edit) is L9's launcher; the report builder that shares the manifest rule is L19 (the validator in test/onyx/lab/manifest.mts is the single implementation); B12 fills the stream-end class for stalled streams; L4 supplies the harness configuration content
Baseline exceptions still open (test/onyx/sim/baseline-exceptions.json): I-02/repository-allowlist → B2; I-03/no-time-budget → B12, B10; I-03/status-overwritten → B10; I-04/no-output-cap → B13; I-04/over-budget → B13; I-05/command-after-stop → B10; I-05/stage-after-stop → B10; I-08/inexact-anchor-staged → B6; I-08/ambiguous-anchor-staged → B6, B7; I-11/truncated-reported-complete → B12; I-13/oversized-proposal → B7
Mutants added: none (L12 defines the corpus; Modules 2 and 3 add one per fixed defect)
Gate: `ONYX_PACKAGED_APP=<path to the rebuilt Onyx.app> node test/onyx/run-module-gate.mts --module 1`, 2026-11-20T02:56:20Z, exit 0, docs/progress/gate-module-1.json — "23 checks: 22 passed, 1 expected failure(s), 0 skipped, 0 blocking", fresh output stamped from 8b85d0efe70 with a clean tree, packaged app rebuilt from the same revision first (`npm run gulp vscode-darwin-arm64-min`, exit 0)
Integration suite (Section 11, run once more after the gate, 2026-11-20T02:56Z to 03:08Z): node v24.20.0; typecheck-client, transpile-client, valid-layers-check, eslint (Onyx paths), stylelint all exit 0; `./scripts/test.sh --grep Onyx` "180 passing, 2 pending" (the two pending are the opt-in campaign and trace-dump tests); `run-benchmarks.mts --skip-models` exit 0; `run-e2e.mts` "all 47 checks passed"; packaged release mode "5 of 15 checks failed" (the named B1/B3 exception, the only failure); packaged baseline mode passed
Simulation campaign: ONYX_SIM_EPISODES=2000 ONYX_SIM_SEED=1 → 2,000 episodes in 7.4 s (269.7 episodes/s), 28,888 boundaries, statuses completed 1827 / failed 86 / cancelled 87, every violation class in the table (R-42), none outside it
CI (onyx-ci.yml on module-1): 44637992357 cold (v2 key) green; 44641307251 warm (cache hit) green; 44643548593 warm green; 44645309171 red at hygiene (home-directory paths in the previous STATE.md, fixed in 8b85d0efe70); 44662540238 (8b85d0efe70) green; packaged smoke workflow green on every one of those pushes; the push of this file is the next run
Human actions waiting: DEC-05. Recommendation (A9.md): keep the current base through Module 1 and rebase onto upstream 1.147.0 at the start of Module 2, because upstream moved to pnpm 12.16.0 and Node 24.22.1 and the trial's merge, install and build succeeded only on that toolchain; the drill workflow keeps the merge-tree and symbol report current meanwhile
Notes for the next session:
  Module 2 enters when this gate is recorded as passed for the current revision: it is (above). Start with B1; the packaged release-mode smoke becomes its acceptance.
  Never write an absolute path into a committed doc; the hygiene check fails on home directories, and the owner's checkout and the trial clone are both sibling folders of this one.
  The owner's checkout stays untouched (its index is absent by design); every commit happens in the isolated clone.
