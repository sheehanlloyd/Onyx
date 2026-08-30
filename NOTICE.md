# NOTICE

Onyx is a fork of [Visual Studio Code](https://github.com/microsoft/vscode). This
file records who owns what, because a fork's licensing is only clear if someone
writes it down.

## Two bodies of code, one license

| | |
|---|---|
| **Upstream VS Code** (everything not listed below) | Copyright (c) 2015 - present Microsoft Corporation, MIT — see [`LICENSE.txt`](LICENSE.txt) |
| **Onyx** (the directories listed below) | Copyright (c) 2026 Sheehan Lloyd, MIT — same terms |

Both halves are MIT. Nothing in Onyx narrows the rights you already have to the
upstream code, and the combined work is redistributable under MIT provided both
copyright notices travel with it.

## What is original to Onyx

Every line of Onyx lives in one of these paths:

```
src/vs/platform/onyxRuntime/        # runtime discovery, indexing, docs, architecture scan
src/vs/workbench/contrib/onyx/      # the entire product surface
extensions/theme-onyx/              # the built-in Onyx themes
test/onyx/                          # mock runtimes, end-to-end harness, benchmarks
.onyx/playbooks/                    # built-in playbooks
.github/CONTRIBUTING.md  .github/SECURITY.md  .github/CODE_OF_CONDUCT.md
.github/ISSUE_TEMPLATE/onyx_*.yml   # .github/workflows/onyx-ci.yml
ONYX.md  REBASE.md  LAUNCH.md  NOTICE.md  TRADEMARK.md  docs/BENCHMARKS.md
```

Outside those paths, Onyx's changes to upstream files are deliberately kept to
registration one-liners and small guarded edits. Every one of them is listed in
[`REBASE.md`](REBASE.md) with its rationale, so the fork's true surface area
against upstream is auditable in one file rather than inferred from a diff.

## Why Onyx's own files carry a Microsoft copyright header

Files under the Onyx paths above begin with the standard VS Code header:

```
Copyright (c) Microsoft Corporation. All rights reserved.
Licensed under the MIT License. See License.txt in the project root.
```

That header is required on every source file by the repository's own ESLint
configuration (`header/header`, an exact-match rule), which Onyx inherits and
deliberately does not modify. Keeping it means Onyx source passes the upstream
lint gate unchanged and stays trivially rebaseable — the fork's top design
constraint.

**The header is a build requirement, not a statement of authorship.** Copyright
in the files listed above belongs to the Onyx author under the terms in the
table at the top of this file. Authorship of any individual file is established
by this NOTICE and by the repository's commit history, and neither is affected
by the lint header. This is the same trade every VS Code fork makes.

If you are vendoring Onyx code into another project and need per-file
attribution, cite this NOTICE alongside the path.

## Trademark

Copyright and trademark are different things, and the MIT license grants no
trademark rights. See [`TRADEMARK.md`](TRADEMARK.md) for what you may and may
not call your fork.

## Third-party code

Upstream's dependency attributions in `ThirdPartyNotices.txt` continue to apply.
Onyx adds no new runtime dependencies — the entire feature set is built on the
libraries VS Code already ships.
