# Pilot kit (E1)

Prepared on 2026-11-22. **The pilot has not started. Nobody has been contacted, and there is no signed build to give anyone yet.** The owner leads the pilot; this folder is everything needed up to that point.

| File | What it is |
|---|---|
| [REPOSITORIES.md](./REPOSITORIES.md) | Three small public repositories, each pinned to a commit, with setup and test commands |
| [TASKS.md](./TASKS.md) | The frozen task list, version 1: four tasks a repository (a feature, a bug fix, a search question, a conflict scenario), each with an exact prompt and checkable acceptance criteria |
| [PROTOCOL.md](./PROTOCOL.md) | How a session runs, what is recorded, the comparison with Cline and Zed, and what makes a session invalid |
| [RECORDING-SHEET.md](./RECORDING-SHEET.md) | The sheet a participant fills in, one a session |
| [RECRUITMENT.md](./RECRUITMENT.md) | Draft text for finding participants. Not sent to anyone |

## What the pilot is for

Section 12's "External use" gate: real tasks on the release artifact by people other than the author, with zero lost work, and some of them using it again within a week. It is also where scorecards from at least three different machines come from (the Measurement gate).

## What it needs before it can start

1. A signed, notarized release candidate (`docs/RELEASING.md`). An unsigned build cannot be handed to a participant: macOS would refuse it, and nothing here tells anyone to bypass that.
2. The clean-machine run (`docs/RUNBOOK-clean-install.md`) done once by the owner, so that the first participant is not the first person to install it.
3. Five to ten participants across 16, 24 and 48 GB Apple-silicon Macs who already run local models. At least two of them willing to repeat the tasks in Cline and in Zed.
4. The owner's decision on the pinned-model question in `docs/progress/STATE.md`. The project's own measurements say the two pinned models rarely propose an edit as agents. A pilot that only confirms that wastes participants' time; the protocol therefore lets a participant also use one larger model they already have, recorded separately.

## What comes out

`docs/pilot/<date>.md` with the raw numbers and quotes, each participant's sheet, and each participant's exported scorecard under `docs/scorecards/`. Every P0 and P1 found becomes an item with a regression test before the candidate is rebuilt (E2). Until a pilot runs there is nothing for E2 to fix.
