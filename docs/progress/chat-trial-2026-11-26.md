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

## Not fixed here: the edit request

The fourth message fails in every run, before and after: the model's first editFile call has an empty "search", which the tool refuses (correctly: the file exists); the model then writes a tool call as text, `{"name": "readFile", "arguments": {...}}`, after a sentence of prose, which the text repair does not recognise, so the run ends "completed" with that JSON shown and nothing read or changed. The run's protocol had also moved from the constrained envelope to repaired text by then. That is the editing path, not conversation, and it is left for its own change.
