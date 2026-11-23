# Runbook: clean-machine install (D5)

A person runs this once on each release candidate, on the signed and notarized disk image from the draft release. It has **not been run**: no signed candidate exists yet. Budget two hours. Record the screen for the whole run; the recording is linked from the release notes.

It proves what no automated check can: that someone with a Mac, no checkout and no developer tools can get from the download to a verified change, and that macOS shows only its normal confirmation (the last clause of R-39).

## Before you start

- A Mac with Apple silicon, macOS 14 or later, 16 GB or more. Write down the model, memory and macOS version.
- The release candidate's `.dmg` and `.dmg.sha256`, downloaded with a browser from the draft release (a browser download carries the quarantine attribute; a file copied over AirDrop or `scp` may not, and then Gatekeeper is not exercised).
- A stopwatch, or the recording's clock. Two times are wanted, kept apart: **app setup** and **model download**.
- Do not use `xattr`, do not right-click and Open, do not change anything in Privacy & Security. If the normal path fails, that is the result. Stop and report it.

## 1. A fresh account

1. System Settings, Users & Groups, Add User. A standard user named for the test. No Apple Account sign-in.
2. Log in as that user. Confirm there is no `~/Library/Application Support/Onyx`, no `~/.onyx`, no `~/.ollama`, and no Xcode or Homebrew configured for this user.
3. Start the screen recording.

## 2. The runtime and the models (time this: **model download**)

1. Install Ollama from ollama.com as a new user would (the app download, not Homebrew). Record its version: `ollama --version`. The supported version is in `docs/SUPPORT.md`; if the site serves a newer one, note it and continue.
2. Start the stopwatch. `ollama pull qwen2.5-coder:7b` then `ollama pull qwen2.5-coder:1.5b`. Stop the stopwatch. Record the time and the connection speed.
3. `ollama list`: record both digests and compare the first twelve characters with `docs/SUPPORT.md`.

## 3. Install (time this: **app setup**, from here to the end of step 4)

1. Start the stopwatch.
2. In Terminal, in the download folder: `shasum -a 256 -c Onyx-<version>-darwin-arm64.dmg.sha256`. It must print `OK`.
3. **Turn Wi-Fi off.** The first launch must work offline: that is what stapling is for.
4. Open the disk image. Drag Onyx to Applications. Eject the image.
5. Open Onyx from Applications. **Record exactly what macOS shows.** Expected: one dialog saying the application was downloaded from the internet, with Open. Anything else (cannot be opened, damaged, unidentified developer, a trip to System Settings) is a failed run.
6. Turn Wi-Fi back on.

## 4. First run

1. The first-run dialog appears. It should find the Ollama runtime and both models without any configuration. Record what it shows. Step through it.
2. The title bar says Experimental Alpha. Click it; read the notice.
3. Stop the stopwatch: that is **app setup**.

## 5. One real task

Use the first task of the pilot list (`docs/pilot/TASKS.md`, task A1) in its repository.

1. Open the repository folder. Open the agent chat. Give the task's prompt exactly as written.
2. **One terminal approval.** When the agent proposes a command, read the dialog: the exact command, the working directory, the timeout, the two choices. Choose Run Once. If the agent proposes none during the task, ask it to run the repository's test command and approve that.
3. **One accept.** When an edit is proposed, open it in the diff editor. Reject one hunk if there is more than one; accept the rest. Confirm the file changed only where you accepted.
4. **One verification.** Let the verification run after the acceptance. Record what it reports and that it names the accepted change.
5. If the model proposes no edit at all, which the project's own measurements say is likely with these models, record that as the result. Then do the same four steps with an inline edit (Cmd+I on a selected function, "add input validation"), which does not depend on the agent loop. Say in the record which path you took.

## 6. Leaving

1. `Onyx: Check for Updates`: record what it says.
2. Quit. Follow the uninstall section of `docs/UPDATING.md`. Confirm the data folders exist before the removal commands and are gone after.
3. Stop the recording. Log out and delete the test user.

## Record

| | |
|---|---|
| Date, operator | |
| Mac model, memory, macOS | |
| Release candidate: version, commit, SHA-256 | |
| Ollama version; model digests | |
| **Model download time** (and connection speed) | |
| **App setup time** (step 3.1 to step 4.3) | |
| First-launch dialog, verbatim | |
| Offline first launch worked | yes / no |
| First-run dialog found the runtime and models | yes / no |
| Task path taken: agent, or inline edit after the agent proposed nothing | |
| Terminal approval, accept, verification each happened | |
| Anything surprising, confusing or broken | |
| Recording | link |

Commit the filled record as `docs/progress/clean-install-<date>.md` and link the recording in the release notes.
