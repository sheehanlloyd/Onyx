# Pilot protocol

Version 1, 2026-11-22. Changing it after the first session needs a new version, and sessions under different versions are not pooled.

## Participants

Five to ten developers who already run local models on an Apple-silicon Mac, spread over 16, 24 and 48 GB of memory, at least one at each size. None of them has contributed to this repository. Record for each: machine model, memory, macOS version, runtime and version, and which local models they normally use.

## Before a session

1. The participant installs the release candidate from the disk image, checks the SHA-256, and pulls the two pinned models at the digests in `docs/SUPPORT.md`. They note setup problems on the sheet; a setup failure is a result, not a reason to help them past it silently. If they are helped, the sheet says how.
2. They clone the three repositories of `REPOSITORIES.md` at the pinned commits and run each test command once.
3. The organiser applies any planted-bug patch from `TASKS.md` to the participant's clone. The participant does not see the patch.
4. They quit other heavy applications. They record whether the Mac is on its charger.

## A session

One repository at a time, tasks in the order A, B, C, D. Fifteen minutes a task, by a timer. The prompt is given exactly as written in `TASKS.md`.

For each task the participant records on the sheet, at the time, not afterwards:

- finished or not, by the task's acceptance criteria (they run the stated command);
- how many proposals the tool made, how many hunks they accepted and rejected, how many proposals failed to apply or were refused;
- how many shell commands they were asked to approve, and how many they denied;
- minutes of manual repair: time spent editing by hand to make the acceptance criteria pass;
- whether they pressed Stop, and whether the run stopped;
- **lost work**: any text of theirs that changed or disappeared without their accepting it. The expected number is zero. One instance is a P0 and the session's run journal is exported with `Onyx: Export Diagnostics` (default options) and attached.

Task D is the conflict scenario. The participant makes the stated manual edit while the agent is running. Afterwards they record what the tool did: rebased, refused, showed a conflict, or overwrote.

If the agent proposes nothing for a task, which is likely with the pinned models, that is recorded as "no proposal" and the participant may finish the task with inline edit or by hand; the sheet says which. A participant who has a larger local model may repeat the session with it afterwards, on a fresh clone, recorded on a separate sheet marked with the model. Results with different models are never pooled.

## Measurements the product takes

After the session, in each repository, the participant runs `Onyx: Measure Models for This Repository` with the defaults and saves the scorecard. They export it and send the three files it writes. From the product's own ledger (Compute view) they copy: first-token time and task latency at the median and the 95th percentile if shown, otherwise the per-request figures, and tokens a second. They record memory pressure and swap from Activity Monitor at the end of the session (`sysctl vm.swapusage` gives the same number).

## Comparison with Cline and Zed

At least two participants repeat the same twelve tasks once with Cline (in VS Code) and once with Zed's agent, on the same machine, the same runtime and the same pinned model, on fresh clones at the same commits.

- Order is rotated between participants so that no tool always goes last, when the participant knows the repository best.
- Each tool's configuration is written down in full: version, model, context length, any auto-approve setting. Auto-approve stays off in every tool, so that the comparison is of the same task and not of permissiveness.
- The same sheet is used. Columns that do not exist in a tool (per-hunk accept, for example) are marked "not offered", not zero.
- What may be said afterwards: counts for these participants on these twelve tasks, with the configurations. Two participants do not support a ranking, and none is published. No claim about what another tool cannot do is made from a pilot.

## A week later

Each participant is asked one question: did you open it again for your own work, and if not, why not? Their answer is quoted with permission, or summarised without their name.

## What makes a session invalid

A changed prompt; a different commit; a model other than the recorded one; help from the organiser that the sheet does not record; a sheet filled in afterwards from memory. Invalid sessions are listed in the report with the reason and left out of the counts.

## Privacy

Participants work on public repositories. Nothing leaves their machine unless they send it: the sheet, the scorecard export, and a diagnostics bundle if they choose. The default diagnostics bundle holds no prompt text, file content, command or path. Names appear in the report only with written permission.

## The report

`docs/pilot/<date>.md`: participants and machines; per task and per tool, completed out of attempted; manual repair minutes; proposals accepted, rejected, failed; lost work; setup failures; cancellations; latency at the median and the 95th percentile; memory and swap; the one-week answers; quotes. Raw sheets beside it. Negative results are reported the same way as the others.
