# The assurance campaign: what the first run reported

This directory is the result of the second run of `write-assurance.mts`, on `cad0d2d3746`. The first run, on `63ebc2fc771`, is kept in `traces/first-run/campaign.txt`. It ended "46000 of 50000 episodes with no violation": two shards failed, each for one episode.

| Seed | Reported | What happened in the episode |
|---|---|---|
| 32218 | `I-01/disk`: `src/math.ts` on disk differs from what the user saved or had | The simulated model asked for commands, all denied. The environment changed the file on disk. The user typed. An autosave followed |
| 46211 | the same | The environment changed the file on disk; the user saved |

In neither episode did text a model wrote reach the disk: in the first no edit was ever staged. The file had changed on disk under a dirty buffer, the save did not go through (the editor does not overwrite a newer file unasked), and the rig recorded the buffer as what the user had sanctioned on disk although nothing had been written. The disk still held the environment's change, which the rig had recorded as sanctioned when it happened and then overwrote in its own books. The rig now records a save as sanctioning the disk only when the disk holds what was saved (`onyxSimRig.ts`, the `save` and `autosaveTick` steps). Both seeds then pass, and so do all 50,000.

This is the second time a campaign larger than any run before it found an error in the rig's own bookkeeping, not in the harness: Module 3's gate found one at 20,000 episodes, in seeds 3019, 3631 and 3809 (`docs/progress/module-3-gate.md`). Seeds 20,001 to 50,000 had never been run before this item.

H-1's threshold says the hypothesis is refuted if "the candidate harness shows a violation". The first run printed a violation and the harness had not committed one. The outcome recorded here, supported, is of the second run; the first is on this page so that the judgement can be checked: the two traces can be reproduced with `ONYX_SIM_TRACE_SEED=32218 ./scripts/test.sh --grep "OnyxSim trace dump"` on `63ebc2fc771`.
