# Video script (draft)

Length 60 to 90 seconds. One take of one real task on the signed release build. No cuts inside the task; if a wait is shortened, a caption says "cut: 40 s" with the real figure. A timer is visible throughout. Recorded by the owner; this is the script, not a recording.

**On-screen caption for the whole video, bottom left:** `<Mac model, memory> · Ollama <version> · qwen2.5-coder:7b · real time`

Fill the bracketed parts from the machine the video is recorded on.

| Time | Picture | Voice |
|---|---|---|
| 0:00 | The editor, title bar showing "Experimental Alpha". | "This is Onyx. It is a fork of Code - OSS, the open-source project behind VS Code, that runs coding models on your own Mac. This is a [Mac model] with [memory], Ollama [version], and a seven-billion-parameter model, qwen2.5-coder." |
| 0:10 | A small repository open (pilot repository A). The agent chat. The prompt of pilot task A2 is typed in full. | "One real task: a bug fix in a repository the model has not seen. The timer is real." |
| 0:18 | The control plane: the agent calls `grep`, then `readFile` on the file that holds the bug. | "It searches, then reads the file. Every tool call is listed as it happens." |
| 0:30 | A proposal appears. It opens in the diff editor with two hunks. | "It proposes an edit. Nothing has been written to my file. A proposal is placed only where its quoted text matches the file exactly; otherwise it is refused." |
| 0:40 | One hunk is rejected, the other accepted. The file changes only at the accepted hunk. | "I reject one hunk and accept the other. Only that one lands." |
| 0:48 | The approval dialog for the test command: the command, the folder, the timeout, Run Once and Deny. Run Once is clicked. | "It wants to run the tests. Every command asks, every time. There is no always-allow." |
| 0:58 | The verification result on the timeline, naming the accepted change. | "The verification ran against the code I accepted, and says so." |
| 1:05 | The README's Research section, scrolled to the first finding. | "Now the part most demos leave out. On real tasks from this project's own history, this model did not reproduce a single one, and in agent runs under the product's own settings it usually proposed nothing at all. Getting the take you just watched took [N] attempts." |
| 1:18 | Three links on screen: the release, docs/SUPPORT.md, docs/research/REPORT.md. | "What it does guarantee is narrower: nothing changes without you, and every claim has a command you can run. The release, what is supported, and the raw results are linked below." |

## Notes for the recording

- **Count the attempts and say the number.** The project's measurements make a first-take success unlikely with this model. Record how many attempts it took to get a take where the agent read the file and proposed an edit, and put that number in the 1:05 line. If no take succeeds in a reasonable number of tries, record the inline edit path instead (select the function, Cmd+I, the instruction) and say in the voice-over that the agent proposed nothing and this is the single-turn path.
- If the proposal has only one hunk, say "I accept it" and drop the rejection; do not stage a second hunk.
- Do not record against the mock runtime.
- Do not show a feature that is outside the supported workflow.
- Description text under the video: the Mac, the runtime version, the model and digest, the release link, `docs/SUPPORT.md`, `docs/research/REPORT.md`, and the raw benchmark report `docs/benchmarks/2026-11-21/report.json`.
