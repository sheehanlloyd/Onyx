# Security policy

> **Note:** the `SECURITY.md` in the repository root belongs to upstream Visual
> Studio Code and routes reports to the Microsoft Security Response Center. That
> is the right destination for vulnerabilities in VS Code itself. This file takes
> precedence on GitHub and covers Onyx's own code.

## Reporting a vulnerability

**Do not open a public issue for a security bug.**

Use GitHub's [private vulnerability
reporting](https://github.com/sheehanlloyd/cursor2.0/security/advisories/new) on
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

- **A model can propose a destructive command.** The terminal tool never executes
  anything without an approval prompt. Commands are classified against eighteen
  patterns for destructive, privilege-escalating, and remote-code-executing
  shapes; a command that matches cannot be added to any allowlist and cannot be
  auto-approved — the "always allow" option is not offered for it. The classifier
  deliberately over-warns rather than under-warns, including inside quoted
  strings, because a parser gap is an evasion path. It is an honesty mechanism
  for the approval prompt, **not a sandbox**: a shell command can hide its intent,
  and you are the last line of defence. Read what you approve.

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
