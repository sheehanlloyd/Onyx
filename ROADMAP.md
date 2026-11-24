# Roadmap

This replaces the status section of [ONYX.md](./ONYX.md), which listed every phase as shipped. "Shipped" there meant "the code exists and ran once in a development build". This page says what has evidence, what is waiting, and what is not planned. The record behind it is [docs/progress/STATE.md](./docs/progress/STATE.md).

## Where the alpha stands (2026-11-22)

Not released. There is no download. `v0.1.0-alpha.1` is defined in [docs/SUPPORT.md](./docs/SUPPORT.md); these are the parts of it.

| Part | State | Evidence |
|---|---|---|
| Authority: every shell command asks, repository content grants nothing, tools meet a reviewed contract | Done | Module 2 gate; `docs/progress/B2.md`, `B3.md` |
| Edit integrity: exact-or-refuse matching, versioned proposals, review per hunk, stop means stop, verification of what was accepted | Done | Module 3 gate; `docs/progress/B6.md` to `B10.md`, `C1.md`, `C2.md` |
| Simulation rig, harness contract, mutation corpus | Done | 50,000 episodes with no violation, 41 of 41 mutants detected; `docs/research/results/2026-11-22-assurance/` |
| Measurement: model datasheets, a private benchmark from your history, Measure Models for This Repository | Done | Module 4 gate; `docs/progress/L5.md`, `L10.md`, `L11.md` |
| Studies H-1 to H-10 | Done, each with an outcome: four supported, one refuted, five inconclusive | [docs/research/REPORT.md](./docs/research/REPORT.md) |
| Extensions from Open VSX | Done for the named set | `docs/progress/D1.md` |
| Manual update, rollback, uninstall; update check command | Done | `docs/progress/D3.md` |
| Production readiness pass | Done, with what it could not cover stated | `docs/progress/production-readiness.md` |
| Signed, notarized download | **Blocked on the owner**: needs Apple Developer enrolment, a certificate and a notary key. The workflow exists and its signed path has never run | `docs/RELEASING.md` |
| Rename and new logo | **Waiting on the owner's choice**: a shortlist and three directions are prepared, nothing is applied | `docs/naming/`, `docs/brand/` |
| Clean-machine install run | **Waiting**: needs the signed download and a person | `docs/RUNBOOK-clean-install.md` |
| Pilot with outside developers | **Not started**: the kit is prepared, nobody has been contacted | `docs/pilot/` |
| Tag and publish | **Not done**, and not before everything above | |

## What the measurements say about usefulness

The safety machinery is tested. The usefulness of the two pinned models as agents is not established, and the evidence so far is against it: under the product's own configuration neither got an edit as far as staging in 320 agent runs (in 18 the edit call was rejected for its arguments) on real tasks of this repository, and no model reproduced a real task exactly in 3,182 attempts across every campaign. Whether the product should keep recommending these two models for agent work is an open decision. Single-turn features (inline edit, commit message, autocomplete, review) do not depend on an agent loop and were not the subject of those campaigns.

## After the alpha, in order

1. **Fix what the pilot finds.** Every P0 and P1 from the pilot gets a regression test before the candidate is rebuilt.
2. **Larger local models.** Everything measured so far is 7B or smaller on a 24 GB machine. The lab can measure a 14B or 32B model on a machine that holds one; nobody has.
3. **LM Studio.** Never measured in any study. Its rows in older tables are from August 2026 with no raw report.
4. **Windows** (milestone M2): the command runner already refuses there instead of guessing; a signed installer and the platform seam's Windows side are the work.
5. **A compatible automatic update service.** Today updating is manual by design.

## Not planned

Mac App Store distribution (the App Sandbox blocks shells, arbitrary folders and extensions), a cloud model fallback, telemetry or any automatic upload of measurements, MCP tools until one can be classified and gated, universal binaries, a Homebrew cask before a notarized release exists.

## Known gaps, kept visible

- A clean file that stays clean after an acceptance is reported as "timed out", not "verified".
- Reasoning models are handled by code tested on constructed transcripts only.
- H-9's token counts are estimates from timing, and its success condition was met with no eviction occurring.
- H-2 and the injection run were made with a campaign-engine defect (a stale list of recent files) that was found afterwards; they were not run again.
- Extension signatures are not verified.
- The published throughput charts were measured on a busy machine and read about half of the idle figures.
