# H-6's first campaign: invalid, and kept

This campaign does not decide H-6. It is kept because of what it found.

`determinism.json`: 146 of 160 repetitions were the same trajectory as their unit's first. The other 14 (7 for each model, in 5 of the 40 units) all differ at turn 1, in the digest of the request. None differs in a response, a tool call or a tool's result. By the registration a divergence that follows an identical past with a different request is the harness's, and "invalidates the study until fixed". `first-run-verdict.json` is what the analysis wrote for this campaign; it is not named as an outcome file so that nothing reads it as one.

**The defect.** A prompt carries, as background, the files that were committed most recently. The runtime service kept that list for a minute. A campaign checks out a task, runs its units, and checks out the next; for the rest of that minute the prompts of the new task named the files of the old one. When the minute ran out between two repetitions of a unit, the two first requests differed. The digests show it: the request a unit settles on is the same for both models, and the request before it is not.

**The fix** is in `src/vs/platform/onyxRuntime/node/onyxRuntimeService.ts`: a campaign's checkout drops what was kept. `test/onyx/checks/r54-determinism.test.mts` has the case, on a small repository whose two tasks have different recent files: before the fix the second task's first request named the first task's files.

**The campaign that decides H-6** is `2026-11-22-determinism-2`, run with the fix (PREREGISTRATION.md, Amendment 4, written before it ran).

**What else ran with the defect:** every agent-loop campaign before the fix, which is L9's engine run, H-2's campaign, L12's injection run and the first anchors campaign. Amendment 4 says which are run again and why the others are not.
