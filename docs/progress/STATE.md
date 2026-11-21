# Onyx plan state
Plan version: v4
Current module: 2      Status: in progress (session started 2026-11-20 on `main` at 44fdc073e34; Module 1's gate is recorded below as passed for this base)
Revision: 881936cd52c (branch `upstream-1.147.0`, pull request sheehanlloyd/Onyx#2; this file's commit follows it and changes only documents, one workflow comment and the gate's result files)
Isolated checkout: branch `upstream-1.147.0` in a sibling clone of the owner's folder (clone directory `onyx-module-1`); the four audit documents are excluded there via `.git/info/exclude` and never committed
Pre-registration commit: 5f98a0ca2c7 (adds `docs/research/PREREGISTRATION.md`; merged as efbd077fd53; an ancestor of this revision and of `main`)
Upstream base: release 1.147.0 = 8a14f0cc1b0, merged as ed8f992f0cc. Until 2026-11-20 the base was 36d38757a15 (August 2026)
Toolchain: Node 24.22.1 pinned in `.nvmrc` (CI ran 24.22.1; the gate machine ran 24.22.3, a newer 24.x, which the preinstall check accepts); pnpm 12.16.0 from corepack, pinned by `packageManager`; lint is oxlint running the `eslint.config.js` rules

## Module 2 (in progress; this section is updated after every merge and rewritten when the module ends)
Branch: `module-2` → draft pull request sheehanlloyd/Onyx#3. One branch per item, merged into `module-2` with a merge commit when its checks pass.
Merged and pushed: B1, B2, B3, B4, B5, B11, B12, B13, B14, C4, C5, C6, C7, L4. Reports: `docs/progress/<item>.md`.
Not started: L5.
Next: L5, then the gate (R-45, the 20,000-episode campaign, the `docs/SUPPORT.md` check), the Section 11 integration suite once more, CI green twice, and this file's rewrite.
Optional scope: C6 included, C7 included (`docs/SUPPORT.md`, "Optional feature states"). Agent Host: excluded (B3).
Mutants so far: 24 (`test/onyx/sim/mutants/`). Baseline exceptions still open: 7, all owned by Module 3.
Integration on the L4 tree (3e66f3b7f10): harness self-checks 29 of 29, packaged smoke in release mode 26 of 26, end-to-end 57 of 57.
CI: green on 1a1ecf34f55 (44785897566, 44785897694) and on 7055ed1faa3 (44785973722, 44785973332), after the failure on 669dd50b67d (44756056767, 44756057488) that C7's commit fixed. The run on this commit covers L4.
To resume if this session stops: `git checkout module-2`; every item listed as merged is complete with its report; start the first item under "Not started" on a new branch. L5 needs the two pinned models under a local Ollama; start `ollama serve` on a port other than 11434 and stop it afterwards; pull nothing.

## DEC-05 (upstream baseline)
Decision: confirmed by the owner on 2026-11-20: move the fork to upstream release 1.147.0. Completed the same day as its own step between Module 1 and Module 2; report in `docs/progress/DEC-05.md`, merge record in `REBASE.md`.
Module 1 (sheehanlloyd/Onyx#1) was merged into `main` first, with a merge commit (a7d60ac2856), so the pre-registration commit and the Module 1 gate revision 8b85d0efe70 stay ancestors of `main`; the push-to-main run 44676758550 was green before the upstream branch was pushed.
The move is one `git merge` of the tag (7,778 upstream commits, no rewritten history) and six commits on top. The pull request is merged into `main` with a merge commit only after two consecutive green CI runs.

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
| DEC-05 | upstream-1.147.0 → #2 | DEC-05.md | the whole Module 1 gate, re-run on the merged tree |
Items remaining: none
Scope dispositions:
  A8: release mode included as a harness, expected to fail until B1 and B3 (5 of 15 checks: the four read tools are absent, so read → staged edit → accept cannot run); baseline mode passes. Same five failures and the same eight advertised tools on the 1.147.0 build as on the August base
  A9: the trial's recommendation was accepted (DEC-05). The trial ran before A11 and L1 to L3 existed and never ran lint or the end-to-end suite, so it predicted five of the nineteen conflicts and none of the six problems that merged without a conflict; `REBASE.md` lists all of them with the check that found each
  L1: the rig does not instantiate the inline-edit controller, the Changes view, diagnostics export, child processes or the memory tool; the contract names the owner item per invariant
  L3: the manifest-driven seed (a lab run without a profile edit) is L9's launcher; the report builder that shares the manifest rule is L19 (the validator in test/onyx/lab/manifest.mts is the single implementation); B12 fills the stream-end class for stalled streams; L4 supplies the harness configuration content
Baseline exceptions still open (test/onyx/sim/baseline-exceptions.json, unchanged by the move): I-02/repository-allowlist → B2; I-03/no-time-budget → B12, B10; I-03/status-overwritten → B10; I-04/no-output-cap → B13; I-04/over-budget → B13; I-05/command-after-stop → B10; I-05/stage-after-stop → B10; I-08/inexact-anchor-staged → B6; I-08/ambiguous-anchor-staged → B6, B7; I-11/truncated-reported-complete → B12; I-13/oversized-proposal → B7
Mutants added: none (L12 defines the corpus; Modules 2 and 3 add one per fixed defect)
Gate: `ONYX_PACKAGED_APP=<path to the rebuilt Onyx.app> node test/onyx/run-module-gate.mts --module 1`, 2026-11-20T05:49:07Z, exit 0, docs/progress/gate-module-1.json — "23 checks: 22 passed, 1 expected failure(s), 0 skipped, 0 blocking", fresh output stamped from 881936cd52c with a clean tree (node v24.22.3, pnpm 12.16.0), packaged app rebuilt from the same revision first (`pnpm run gulp vscode-darwin-arm64-min`, exit 0; the app reports Onyx 1.147.0, Electron 43.8.9, product.json commit 881936cd52c). The one expected failure is packaged release mode, owner B1 and B3, as before the move
Integration suite (Section 11, run once more after the gate, 2026-11-20T05:51Z to 06:01Z): node v24.22.3, pnpm 12.16.0; typecheck-client, transpile-client, valid-layers-check, oxlint (Onyx paths, 153 files), stylelint all exit 0; `./scripts/test.sh --grep Onyx` "181 passing, 2 pending" (one more than before the move: the OnyxChatDefaults regression; the two pending are the opt-in campaign and trace-dump tests); `run-benchmarks.mts --skip-models` exit 0; `run-e2e.mts` "all 47 checks passed"; packaged release mode "5 of 15 checks failed" (the named B1/B3 exception, the only failure); packaged baseline mode passed
Simulation campaign: ONYX_SIM_EPISODES=2000 ONYX_SIM_SEED=1 → 2,000 episodes in 2.8 s (719.8 episodes/s), 28,888 boundaries, statuses completed 1827 / failed 86 / cancelled 87: the same boundaries and status mix as before the move. All eleven classes in the table were seen (R-42), none outside it
CI on sheehanlloyd/Onyx#2: 44679483500 (the merge commit alone, ed8f992f0cc) red as expected, at hygiene (a new upstream URL in product.json) and at `npm ci` (no package-lock.json any more); 44682021132 (881936cd52c) green on a cold pnpm store, 47 end-to-end checks on Linux; packaged smoke 44682021232 and upstream drill 44682086587 green on the same revision; the push of this file is the second run, on the warm store, and the pull request is merged only if it is green
Human actions waiting: none
Notes for the next session:
  Module 2 enters on this base: the gate is recorded as passed for 881936cd52c on upstream 1.147.0. Start with B1; the packaged release-mode smoke becomes its acceptance.
  Toolchain: `corepack enable pnpm`, then always `GIT_LFS_SKIP_SMUDGE=1 pnpm_config_frozen_lockfile=true pnpm install --frozen-lockfile`; an unfrozen install rewrites the lockfile. The gate calls `pnpm`, so it must be on PATH. Lint is `pnpm run oxlint <paths>` and fails on warnings. `REBASE.md`, "Toolchain".
  Upstream's Agent Host (the Copilot SDK harness) still starts with the product; only the default for a new chat was moved back to the local harness. B3's capability contract should decide whether its session types stay selectable. Never write an absolute path into a committed doc, and the owner's checkout stays untouched.
