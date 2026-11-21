# Onyx plan state
Plan version: v4
Current module: 3      Status: in progress (started 2026-11-21). Module 2: complete; gate passed on 719cfd5ba4d (2026-11-21), merged into `main` as 7fda8b457b5 (sheehanlloyd/Onyx#3), push-to-main CI run 44941090686 green.
Revision: branch `module-3`, from `main` at 7fda8b457b5
Isolated checkout: branch `module-3` in a work clone kept outside any cloud-synchronised folder (moved on 2026-11-21); the four audit documents are excluded there via `.git/info/exclude` and never committed
Pre-registration commit: 5f98a0ca2c7 (adds `docs/research/PREREGISTRATION.md`; merged as efbd077fd53; an ancestor of this revision and of `main`)
Upstream base: release 1.147.0 = 8a14f0cc1b0, merged as ed8f992f0cc. Until 2026-11-20 the base was 36d38757a15 (August 2026)
Toolchain: Node 24.22.1 pinned in `.nvmrc` (CI ran 24.22.1; the gate machine ran 24.22.3, a newer 24.x, which the preinstall check accepts); pnpm 12.16.0 from corepack, pinned by `packageManager`; lint is oxlint running the `eslint.config.js` rules

## Module 3
Items done: B15 (codex/b15-context-allocation → #4; B15.md; gate checks R-61, module-3-tables); B6 (codex/b6-exact-or-refuse → #4; B6.md; gate check R-07-R-08-R-33); B7 (codex/b7-versioned-proposals → #4; B7.md; gate check R-09-R-12-R-38)
Items remaining: B8, B9, B10, C1, C2, C3, C8, C9, C10, L6, L7, L8, then the gate (`node test/onyx/run-module-gate.mts --module 3`)
Item in progress: B8 (branch `codex/b8-deletion-edits`)
Context (B15): both pinned models verified at 16,384 tokens through a derived model on Ollama 0.33.0, from a server allocation of 4,096; results in `docs/research/results/2026-11-21-context-allocation/`. The measurement's aliases were removed afterwards. LM Studio was not probed (installed, not running; not started).
Baseline exceptions still open (5), all B10's: I-03/no-time-budget, I-03/status-overwritten, I-05/command-after-stop, I-05/dispatch-after-stop, I-05/stage-after-stop. Removed so far: I-08/inexact-anchor-staged, I-08/ambiguous-anchor-staged (B6), I-13/oversized-proposal (B7); zero of each in 2,000 episodes, and the 20,000-episode campaign is the gate's
Mutants added in this module: B6-fuzzy-applier, B6-first-occurrence, B7-index-accept, B7-no-size-guard (28 in all)
Rig correction (B7): the simulation rig never raised its after-run boundary, so no user step scheduled after a run was ever carried out, in generated episodes or in the scripted N2 and H4 audit scenarios; Modules 1 and 2 reported those scenarios as holding I-09 when their user had never acted. Fixed, asserted by a test, and corrected in `docs/research/HARNESS-CONTRACT.md`
Integration runs: after B15, on c8f0402e55b: self-checks 34 of 34, packaged release smoke 26 of 26, end-to-end 57 of 57. After B7, on eda1a2c41f5: self-checks 34 of 34, end-to-end 57 of 57 locally; packaged smoke by CI. After B6: unit, lint, layers, hygiene, self-checks, 2,000-episode campaign and mutants locally; end-to-end and packaged smoke by CI on the push (the machine is on a 13 W charger, so the local window runs are kept for milestones)
Gate: not run

## Module 2
Items done:
| Item | Branch → PR | Report | Gate check ids |
|---|---|---|---|
| B1 | codex/b1-read-tools → #3 | B1.md | B1-read-tools (R-24, R-30), R-36, packaged-release (R-31) |
| B2 | codex/b2-shell-approval → #3 | B2.md | R-01-R-04 |
| B3 | codex/b3-tool-contract → #3 | B3.md | R-05-R-59, B3-agent-host, packaged-release (R-05) |
| B4 | codex/b4-egress-warnings → #3 | B4.md | R-06 |
| B5 | codex/b5-command-runner → #3 | B5.md | R-18, R-40, R-40-source-scan |
| B11 | codex/b11-diagnostics-redaction → #3 | B11.md | R-20 |
| B12 | codex/b12-stream-termination → #3 | B12.md | R-19, R-28-mandatory |
| B13 | codex/b13-context-budget → #3 | B13.md | R-16 |
| B14 | codex/b14-inference-location → #3 | B14.md | R-17 |
| C4 | codex/c4-reasoning-models → #3 | C4.md | R-26 |
| C5 | codex/c5-fenced-streaming → #3 | C5.md | R-27 |
| C6 | codex/c6-constrained-streaming → #3 | C6.md | R-28-streaming |
| C7 | codex/c7-index-coverage → #3 | C7.md | C7-index-coverage |
| L4 | codex/l4-harness-config → #3 | L4.md | R-44, R-44-bundle-scan, packaged-release (two R-44 checks) |
| L5 | codex/l5-datasheet → #3 | L5.md, docs/research/results/2026-11-21-datasheets/ | R-45 |
| gate | codex/m2-gate-campaign → #3 | this file | sim-campaign-20000, module-2-tables, sim-mutants |
Items remaining: none
Scope dispositions:
  C6: included (DEC-12). C7: included (DEC-12). Both recorded in `docs/SUPPORT.md`, "Optional feature states".
  Agent Host: excluded (B3): never started, no session type or model registered; its code is still in the bundle (D8).
  C4: the reasoning transcripts behind R-26 are constructed from the documented stream shapes, not recorded: no reasoning model is installed and none was downloaded. `docs/SUPPORT.md` lists reasoning models as handled, not validated against a model.
  C5: the plan's 400-character hold applies to undecided text; a recognised tool call is held to its end.
  C7: the published retrieval figure was stale. The production index on today's tree finds 7 of 10 files, not 9 of 10; the documents say so; the chart is not redrawn (needs a manifest; C8).
  L5: the context probe stays inside what the server says it allocated, as the plan words it, so it found no limit of its own; the profile takes the server's allocation (4,096 tokens on a default Ollama) as the context.
  Defects fixed at the process boundary (B5's event flood and dispose kill, B12's process-side deadline, C7's indexer) have node regressions that were seen failing and no simulation mutant: the rig replaces that process.
Baseline exceptions still open (`test/onyx/sim/baseline-exceptions.json`, 8, all Module 3's): I-03/no-time-budget → B10; I-03/status-overwritten → B10; I-05/command-after-stop → B10; I-05/stage-after-stop → B10; I-05/dispatch-after-stop → B10 (new: found by this module's 20,000-episode campaign at seed 5545; same root as the other two); I-08/ambiguous-anchor-staged → B6, B7; I-08/inexact-anchor-staged → B6; I-13/oversized-proposal → B7.
Mutants added (24, `test/onyx/sim/mutants/`): B1-naive-read-path, B1-priority-truncation, B2-repository-allowlist, B2-reused-approval, B2-normalized-approval, B2-unasked-check-task, B3-uncontracted-tools, B3-unconfirmed-memory, B4-regex-warnings, B5-unbounded-output, B5-full-environment, B5-cwd-ignored, B5-command-outlives-window, B11-value-only-redaction, B12-truncated-is-complete, B12-unvalidated-arguments, B12-no-stream-deadline, B13-no-output-cap, B13-no-eviction, B14-address-is-locality, C4-thinking-is-answer, C5-fence-withheld, C6-constrained-answer-withheld, L4-inline-harness-record. All detected at 2,000 episodes each.
Gate: `ONYX_PACKAGED_APP=<the rebuilt Onyx.app> node test/onyx/run-module-gate.mts --module 2`, 2026-11-21, on fresh output from 719cfd5ba4d with a clean tree, exit 0, `docs/progress/gate-module-2.json` — "47 checks: 47 passed, 0 expected failure(s), 0 skipped, 0 blocking", "module 2 gate: PASSED". It runs Module 1's 23 checks too; packaged release mode is a required pass there since B3.
  Checklist: R-01 to R-06, R-16 to R-20, R-24, R-26, R-27, R-28, R-30 (read side), R-36, R-40, R-44, R-45, R-59 by the checks named above; R-31 by packaged-release and the end-to-end suite. Packaged smoke, release mode: 26 of 26. Campaign: 20,000 episodes, seeds 1 to 20,000, no class outside the table, and the table has no entry for I-02, I-04, I-06, I-07 (read side), I-10, I-11, I-13 (output) or I-14 (`module-2-tables`). `docs/SUPPORT.md` lists the tools the contract can expose and records C6 and C7 as included.
  The first gate run failed on one check: the 20,000-episode campaign ran its single test process out of memory. It now runs as ten processes over the same seeds (`test/onyx/sim/run-campaign.mts`). Seeds past 2,000, never run before, then showed two errors in the rig's bookkeeping, one checker that blamed a user-stopped reply on the model, one user undo counted against an accept, and one real defect under Module 3's I-05, added to the baseline table with its owner. Details in the commit f6bd8de0042.
Integration suite (Section 11, run once more after the gate, 2026-11-21): node v24.22.3, pnpm 12.16.0; typecheck-client, transpile-client, valid-layers-check, oxlint (Onyx paths), stylelint all exit 0; `./scripts/test.sh --grep Onyx` "275 passing, 2 pending" (the two pending are the opt-in campaign and trace-dump tests); `run-benchmarks.mts --skip-models` exit 0; `run-e2e.mts` "all 57 checks passed"; packaged release mode "release mode: all 26 checks passed"; packaged baseline mode passed. Zero unexpected failures.
Datasheets (L5): `docs/research/results/2026-11-21-datasheets/`, Ollama 0.33.0. `qwen2.5-coder:7b` (dae161e27b0e): native tool calls 0 of 5, readable as text 5 of 5, schema enforced 3 of 3 for each shape, server context 4,096, 48 tokens a second. `qwen2.5-coder:1.5b` (d7372fd82851): 0 of 5, 3 of 5, 3 of 3 each, 4,096, 159 tokens a second.
CI on sheehanlloyd/Onyx#3: red once, on 669dd50b67d (44756056767, 44756057488), for two causes fixed in C7's commit (a self-check's stale anchor; the packaged smoke not stepping through the first-run dialog). Green since on every push: 1a1ecf34f55, 7055ed1faa3, 288b78e12f3, ce3f3462ec8, 85e1ed30dca (44925425817, 44925425743) and 719cfd5ba4d (44928558606, 44928558558), the last two consecutive.
Human actions waiting:
  The repositories live under a Desktop folder that a cloud drive synchronises; it dropped 22 conflict copies into the clone during this module (removed; a hygiene check now catches them). Moving the repositories out of the synchronised folder is the owner's to do.
  The owner's local `main` has commits that are not on `origin/main` (44fdc073e34); this pull request is against `origin/main`.
  C7's default index cap (20,000 files, 284 MB for this repository) is one number to change if that is too much.
Notes for the next session:
  Module 3 enters on this base. `onyxSimBehaviourBaseline.ts` is a snapshot of the loop's behaviour on 1,000 seeds; the first item that changes the loop on purpose regenerates it with the command in its header and says why, and L8 replaces it.
  A campaign past about 14,000 episodes needs `run-campaign.mts`: one test process keeps every episode's leftovers. What is kept was not investigated.
  Before every merge run the whole self-check suite on a clean tree (`node --test --test-concurrency=1 "test/onyx/checks/*.test.mts"`), not a subset: R-35 needs a clean tree and one check rebuilds `out/`.
  Measuring a model needs a runtime already running on this machine; start `ollama serve` on a port other than 11434 and stop it afterwards. Check the machine is on its own charger first: at a few percent of battery the same model ran at a third of its speed.

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
