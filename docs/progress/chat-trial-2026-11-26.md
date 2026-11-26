# Plain conversation with a real model (2026-11-26)

The owner said the chat "is not conversational like when you say thank you". This is the trial that establishes what it does, and the fix for what was the harness's.

**How it was run.** The packaged build of `main` at 3b80e063fce, a fresh profile, the product's default configuration except one setting: `onyx.endpoints` naming a private Ollama 0.33.0 on `127.0.0.1:11500` and exposing only `qwen2.5-coder:7b` (on disk; nothing downloaded). A workspace with `src/math.ts` (two functions) open in the editor. Four messages in one chat session, in order, sent through the chat input as a person would. The model's raw output is from the run's own journal; the time is from pressing Enter to the first text of the reply shown. On mains; Ollama was stopped afterwards.

## Before the fix (3b80e063fce)

| Message | Reply shown, verbatim | First text shown | Protocol of the run | Tool forced where a reply was right? |
|---|---|---|---|---|
| hey | Hello! How can I assist you with your code in src/math.ts? | 1,214 ms | constrained envelope | no: an answer action |
| thank you | Understood! How can I assist you with the code in src/math.ts? | 1,250 ms | constrained envelope | no: an answer action |
| what does this file do? | The file `src/math.ts` contains two functions: `addNumbers` and `clamp`. The `addNumbers` function takes two numbers as arguments and returns their sum. The `clamp` function takes a number and clamps it between a minimum and maximum value, returning the clamped value. (after a readFile) | 724 ms | constrained envelope | not applicable |
| Add a subtractNumbers function next to addNumbers. | editFile did not complete: … every edit needs a non-empty "search" …, then: Understood! Let's read the file and find the correct lines to replace. {"name": "readFile", "arguments": {"path": "src/math.ts"}} | none before the run ended | repaired text | not applicable |

A second run gave the same shape: "thank you" got "Understood. I'm ready to help with src/math.ts. What specific task or issue would you like assistance with?" (the product samples at temperature 0.2).

**Judgement.** A greeting got a normal reply. A thank-you did not: "Understood!" and a question about the file is not how a person answers thanks. The harness did not force a tool or an envelope action where a reply was right: every one of these turns was an answer action.

## The cause: the harness, one message

The thank-you turn's exact request, from the journal, replayed against the model directly, five seeds each at the product's temperature (tool schemas reduced to their names, the only approximation):

| Request | Replies that acknowledge the thanks |
|---|---|
| as the product sent it (system prompt, envelope instruction and schema, the workspace-context message, the request) | 0 of 5 ("I'm ready to help with src/math.ts. What specific task…") |
| without the envelope | 1 of 5 |
| without the workspace-context message | 5 of 5 ("You're welcome! If you have any questions…") |
| with no system prompt at all | 5 of 5 |
| the workspace context inside the request message, after its text | 0 of 5 (every one a listDirectory call) |
| the workspace context inside the request message, before its text | 5 of 5 |
| the workspace context as a system message right before the request | 5 of 5 |

The prompt builder sent the workspace context ("[Workspace context — background, not a request] Files the user is working on: src/math.ts") as a user turn immediately before the request, and the model answered that turn. The fix makes it a system message in the same place: it stays the volatile tail next to the newest request, and a message of its own that the context budget can drop when room is short. The model is not the cause: without that message, or with it as a system message, it thanks back.

## After the fix (5cb140e2d19), two sessions

| Message | Reply shown, verbatim (session 1; session 2) | First text shown |
|---|---|---|
| hey | Hello! How can I assist you today? (both) | 1,237 ms; 1,230 ms |
| thank you | You're welcome! Let me know if you need help with anything.; You're welcome! Let me know if you have any questions or need help with anything. | 1,250 ms; 1,233 ms |
| what does this file do? | a correct two-function summary after a readFile (both) | 726 ms; 725 ms |
| Add a subtractNumbers function next to addNumbers. | unchanged: the edit fails as before | none |

Tests: OnyxSim "a thank-you is a plain turn: the workspace context reaches the model as a system message before it…" (seen failing on the old role first); the end-to-end check "a thank-you gets a plain reply: no tool is called, the run completes, and the workspace context is a system message before it", on the suite's "Thanks, that is all." turn against the mock (74 of 74 on the packaged build of 5cb140e2d19).

## The edit request, fixed afterwards (branch `edit-path`)

What failed in every session, and what each part was:

- **(a) A tool call written as JSON after prose was shown, not run.** The text repair recognised only a reply that was wholly a call. It now also recognises one at the end of a reply, after prose or in a `json` fence, and runs it: it must be the last thing, parse, name a tool on offer, carry only a call's keys and have object arguments; JSON in an answer that is not such a call is shown as before (tests in both directions, `OnyxFencedStreaming`). While the reply streams, the line that opens it is held back, so the call is not shown as JSON.
- **(b) A run ended "completed" with an unrun call in its last text.** It now ends "failed", saying the call was written as text and not run (`OnyxSim`, "a tool call the model writes as JSON after prose is run; one that cannot be run ends the run as failed").
- **(c) The protocol changed mid-session; not intended.** The profile blends an observed tool-call failure rate in after three requests, but the rate is fed only by calls on the tool channel, and an envelope turn never has one. So after three answers and envelope turns the rate was still its initial zero, the 7B was judged a reliable caller (0.84, over the 0.75 that keeps it constrained), and the next run left the envelope. Observed quality now needs three tool-call observations (`OnyxRoutingAndProfiles`). With the fix the 7B stays in the envelope for the whole session.
- **(d) The empty-"search" refusal.** Adding code to an existing file has a supported form, and needs no new one: quote the lines it goes after and give them back followed by the new code. Exact-or-refuse is unchanged. What changed is what the model is told: the refusal names the next two calls; the edit tool's description says how to add code; the ambiguity refusal says to quote the line before a closing "}"; a quote that differs from the file only in leading whitespace is refused as before, and the refusal now shows those lines as the file has them, as JSON strings, so a tab is visible. Under the envelope, no answer is offered from a refused edit until an edit is staged (or the turn cap ends the run, as "budget-exhausted"): told what to do, the 7B had otherwise answered with the instructions, and given one more turn, read the file and answered that the function "has been added" with nothing staged.

**(e) The same four messages, five sessions each, on each build along the way.** A session counts when its fourth message ends with an edit staged that, applied to the file, adds `subtractNumbers` returning `a - b` and leaves `addNumbers` and `clamp` as they were.

| Build | What it added | Staged | Correct |
|---|---|---|---|
| 3b80e063fce (`main`, before) | | 0 of 2 sessions recorded earlier | 0 |
| 262445817db | (a) to (c), the first wording of (d) | 0 of 5 | 0 of 5: each answered the refusal back to the user |
| 4c38e12b1e7 | a tool step after a refused edit | 0 of 5 | 0 of 5: each read the file, then answered; four said the function had been added |
| 16c5f41b342 | no answer until an edit is staged; refusals say how to quote | 1 of 5 | 0 of 5: the model quoted a lone "}" (the first wording's example) or re-indented with spaces; four ended "budget-exhausted" |
| afd9a0decef | the indentation refusal shows the file's lines | 3 of 5 | 2 of 5 |
| **09b37c0c8b8 (the pull request)** | a reply arriving in one chunk is checked too | **5 of 5** | **4 of 5** |

On the last build every session went: an edit with an empty "search" (refused), a read, an edit re-indented with spaces (refused, with the file's lines shown), then the edit that was staged. The one that is not correct put the new function inside `addNumbers` and lost `clamp`; it is staged, not applied, so the file is unchanged until the user accepts it. Two of the five final answers say the function "has been added" where it was staged. The conversational turns held on every build: "hey" got "Hello! How can I assist you today?" and "thank you" a "You're welcome!" in all 27 sessions after the earlier fix (25 here and 2 in the trial above); the first text of each reply showed in 0.7 to 1.3 seconds.

What this does not show: that a longer file, another language or another model does as well; five sessions of one request are a smoke test, not a rate.
