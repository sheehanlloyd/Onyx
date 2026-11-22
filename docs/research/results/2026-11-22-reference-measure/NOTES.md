# The reference machine's measurement: the run before this one

This directory is the second run of `Onyx: Measure Models for This Repository` on the reference machine. The first was stopped by hand after 1,189 seconds and its results are not used. What is kept of it is in `traces/first-run/`: the launcher's `campaign.json`, which records the session as cancelled, and four lines of the runtime's log.

The command had measured the three datasheets and was giving the models their tasks. In answer to one task, `llama3.2:3b` did not stop: the runtime's log shows one request, with a prompt of 2,674 tokens, at 34,174 generated tokens when the run was cancelled. The request carried no output cap, so nothing but the model's own end token could end it, and the runtime shifts its context window for as long as a reply goes on.

That was a defect in the product and not only in the command: no one-shot request sent an output cap (the repository benchmark, a tournament, a commit message, a review, an inline edit and a refactoring are the others). It is fixed in `browser/agent/onyxOneShot.ts`, with a regression test (`OnyxOneShot`): a one-shot request now sends a cap of 4,096 tokens unless its caller names another. The second run is of the build with that fix, at the revision in `campaign.json`.

A reply that reaches the cap is cut there and scored as it stands. The scorecard does not yet say which replies were cut.
