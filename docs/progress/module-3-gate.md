# Module 3: what the gate found before it passed

The first run of `node test/onyx/run-module-gate.mts --module 3` (at 9eea8268780, clean tree, fresh output)
ended "68 checks: 65 passed, 0 expected failure(s), 0 skipped, 3 blocking". This file says what the three
were. `gate-module-3.json` beside it is the result of the run that passed.

## 1. The 20,000-episode campaign reported a staging after Stop (two checks: Module 2's and Module 3's)

```
campaign: 6000 of 20000 episodes ran with no violation class outside the baseline table; failed shards:
2001-4000, 6001-8000, 8001-10000, 10001-12000, 14001-16000, 16001-18000, 18001-20000
I-05/stage-after-stop (seed 3019: src/math.ts was staged after Stop)
```

**The product had not staged anything after Stop. The rig had written two events down in the wrong order.**
In seed 3019 the model's first turn is an `editFile` call, and the user presses Stop at the boundary right
after that call. The edit is staged during the call, before Stop. But at a boundary the rig carried out the
user's step first and recorded what it observed afterwards, so the trace read: Stop, then the staging. The
rig now records what was staged before a boundary before the user acts at it
(`onyxSimRig.ts`, `boundary`). A staging that really follows a Stop is still seen: it is observed at the
next boundary, after the Stop.

Why it was not seen before. `I-05/stage-after-stop` was in the baseline exception table until B10, which
fixed a real case of it and removed the entry on the strength of 2,000 episodes from seed 1. The combination
above does not occur below seed 2,001. Every campaign of this module's items was 2,000 episodes; the plan
asks for 20,000 at the gate, and this is why. Eleven of the 1,000 seeded traces in the behaviour snapshot
changed (the order of two events), and no trace of the corpus.

After the correction: "campaign: 20000 of 20000 episodes ran with no violation class outside the baseline
table", with the table empty, and all 36 mutants still detected.

## 2. The end-to-end suite aborted

```
E2E aborted: … playwright-cli.js -s=onyx-e2e-11529 run-code --filename=…/focus-chat-input.ts
The browser 'onyx-e2e-11529' is not open, please run open first
```

No check had failed. This is the third abort of the runner on 2026-11-21, each at a different step (C8.md
after 38 passing checks; L6.md at startup, which was the first-run dialog and was fixed; this one 140 seconds
in). The message is the test driver's: it keeps its attachment to the workbench in a process of its own, and
that process was gone. The system wrote no crash report for the application on any of the three occasions.

**The cause is not known.** What was done is to make the runner say what it finds and stop guessing: when
the driver's session is gone it asks whether the workbench still answers on its debugging port. If it does,
the driver is attached again and the command is sent once more, counted and printed, and the run's last
line says how often. If it does not, the run aborts saying that the application has exited or is blocked,
which is a different failure and is not retried. A run that needed a re-attachment is therefore visible as
one, and the next occurrence will say which of the two it was.

## The run that passed

See `gate-module-3.json` and `STATE.md`.
