# Scorecards from other machines

A scorecard is what `Onyx: Measure Models for This Repository` produces: local models measured on a repository's own tasks, on one machine, with everything needed to read the numbers. This folder collects scorecards people chose to share.

**Sharing one is opt-in and manual. Onyx never uploads anything.** The command writes three files into `.onyx/scorecards/<time>/` in your workspace only when you choose to save it, and they stay there until you move them.

## How to add yours

1. Run `Onyx: Measure Models for This Repository` and save the scorecard when it asks.
2. Read `scorecard.md` before you share it. It names your repository's folder and its commit, your machine's processor and memory, and the models' digests. It holds no source code, no file contents and no request text: tasks are named by commit id. If your repository is private, the commit ids and the file paths in the attempts table are still yours to decide about.
3. Copy the folder to `docs/scorecards/<date>-<machine>/` in a fork, keeping all three files (`scorecard.md`, `scorecard.svg`, `scorecard.json`), and open a pull request.

## How to read one

- The score is the F1 between the lines a model changed and the lines the author changed, capped at 0.5 when the model removed a line the author kept. It measures closeness to what the author did, not correctness.
- A model is ranked only when the measurement ran whole and every model was scored on at least 10 tasks. Below that the scorecard says so and gives no order.
- "Held out" means the task was committed after the model was published. "Holdout unknown" means that cannot be shown, and the model may have seen the commit in training.
- A task a model could not be served is counted apart. It is not a score of zero.
- Scorecards from different repositories are not comparable with each other: the tasks differ. Two scorecards of the same repository at the same commit, from different machines, are.

## What is here

| Folder | Machine | Repository | Models |
|---|---|---|---|

The reference machine's own scorecard is kept with the research results, not here: `docs/research/results/`.
