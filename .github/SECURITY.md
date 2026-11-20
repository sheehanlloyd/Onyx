# Security policy

> **Note:** the `SECURITY.md` in the repository root belongs to upstream Visual
> Studio Code and routes reports to the Microsoft Security Response Center. That
> is the right destination for vulnerabilities in VS Code itself. This file takes
> precedence on GitHub and covers Onyx's own code.

## Reporting a vulnerability

**Do not open a public issue for a security bug.**

Use GitHub's [private vulnerability
reporting](https://github.com/sheehanlloyd/Onyx/security/advisories/new) on
this repository. Expect an acknowledgement within a week. If a report is valid I
will tell you the fix timeline and credit you in the advisory unless you prefer
otherwise.

If the bug is in upstream VS Code rather than in Onyx code, report it to
[MSRC](https://msrc.microsoft.com/create-report) instead — they own that code and
have the resources to handle it. Onyx's own surface is the paths listed in
[`NOTICE.md`](../NOTICE.md); when in doubt, report to me and I will route it.

## Threat model

Onyx's security posture is different from a cloud AI editor's, and the
differences run in both directions.

**What being local removes.** Your code is never transmitted to a third party.
There is no vendor account, no API key at rest, no server-side prompt log, no
retention policy to read, and no provider breach that can expose your source.
Onyx makes no outbound network requests except to the model runtime endpoints you
configure, which default to `127.0.0.1`. Being able to say that precisely is the
main security argument for the whole design.

**What being local does not remove.** Onyx runs a language model's output against
your machine, and a model is not a trusted party:

- **A model can propose a destructive command.** The terminal tool asks before
  every invocation, with Run Once or Deny, and an answer covers that one
  invocation: its exact command bytes, its working directory and its timeout.
  There is no "for this session" and no "always" in this release. Nothing a
  repository contains confers authority: a `terminalAllowlist` in
  `.onyx/config.json` is read as suggestions, a check task named there asks
  before each run, and Workspace Trust changes none of this. Every
  command in the pipeline, including the ones inside substitutions and
  subshells, is classified by its executable and arguments as destructive,
  privilege, remote code, network egress, persistence or unseen code, and each
  finding is named in the dialog as what the command looks like. Egress and
  persistence are always named. The classifier deliberately over-warns rather
  than under-warns, including on quoted strings and comments, because a parser
  gap is an evasion path. It warns; it does not decide, and a command it is
  silent about has not been shown to be harmless. It is an honesty mechanism
  for the approval prompt, **not a sandbox**: a shell command can hide its intent, the dialog cannot show what
  a script it starts will do, and you are the last line of defence. Read what
  you approve.

- **An approved command runs as you.** It is started with `/bin/sh -c` in the
  workspace folder, or in a directory inside it that the model named and the
  dialog showed, with your user's permissions. The limits Onyx puts on it are
  these and no others:
  - It is killed, with its whole process group, when its timeout passes
    (60 seconds unless the model asks for more, 10 minutes at most), when you
    stop it, when the window closes, and when Onyx's runtime process ends. A
    process that deliberately leaves its group (`setsid`, a daemon) is not
    reached. If the window crashes instead of closing, the timeout is what
    ends the command.
  - Its output is bounded on the way in: the first and last parts are kept,
    200,000 characters at most, of which the model sees 12,000; the rest is
    counted and discarded. What the command writes to disk is not bounded.
  - Environment variables whose names contain `TOKEN`, `SECRET`, `KEY`,
    `PASSWORD` or `CREDENTIAL` are not passed to it, unless you turn on
    `onyx.terminal.passEnvironment` (a user setting; a workspace cannot set
    it). This is defense in depth only. A credential under another name, in a
    file such as `~/.aws/credentials` or `~/.npmrc`, in your keychain or behind
    a credential helper is as reachable as it is from any shell you open.
  - There is no sandbox, no network restriction and no file-system
    restriction. The working directory is where the command starts, not a
    boundary on what it can touch.
  - On Windows, commands are refused: there is no tested way to end a process
    tree there in this release, so nothing is started.

- **A model can propose a bad edit.** The agent has exactly one write path, and it
  does not write to disk. Edits are staged into a review surface where you see
  each hunk and accept or reject it. If the underlying file changed while an edit
  was staged, hunks are re-anchored with a strict matcher that refuses to guess
  placement; anything that no longer applies is dropped and reported rather than
  applied somewhere plausible.

- **Content you feed the model is untrusted input.** Retrieved files, indexed
  documentation, and command output can all contain text aimed at steering the
  model. Onyx's mitigation is structural: the model cannot act without a tool
  call, and the consequential tools are gated behind human approval. Treat a
  repository you did not write like a web page you did not write.

- **Model weights are code you are choosing to trust.** Onyx does not verify what
  you pull from a model registry, any more than your package manager verifies the
  intent of a dependency. Get weights from sources you trust.

**Local endpoints are unauthenticated.** Ollama and LM Studio listen without
authentication by design. Onyx defaults to loopback addresses. If you point it at
a runtime on your network, anything on that network can use that runtime too —
that is a property of the runtime, not of Onyx, but it is worth knowing before
you change the default.

## Supported versions

Onyx is a single-developer project without a release train. Security fixes land
on `main`. If you are running a build, rebuild from `main`.
