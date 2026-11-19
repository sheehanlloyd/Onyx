# What is in `.github/`, and what can run

Onyx is a rebaseable fork of microsoft/vscode. This directory holds two kinds of things: **Onyx's own
automation and community files**, which are the only workflows that can execute, and **upstream's
instruction trees and skills**, kept so contributors can use them and so merges stay small.

## Onyx-owned, active

| File | Trigger | Purpose |
|---|---|---|
| `workflows/onyx-ci.yml` | push to `main`, pull requests into `main`, manual | Hygiene; typecheck, layers, lint, stylelint, compile, Onyx unit tests, the end-to-end suite under Xvfb, the asserting benchmarks, the harness self-checks |
| `workflows/onyx-packaged.yml` | manual, `release/**` pushes, PRs that change the harness | Builds the macOS app and runs the packaged smoke (A8); release mode is the named baseline exception until B1/B3 |
| `workflows/onyx-upstream-drill.yml` | weekly, manual, PRs that change the drill | Merge-tree against the latest upstream release: conflicts, consumed API symbols, build-infrastructure drift (A9) |
| `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md` | — | Onyx's community files; they shadow upstream's root copies (see `REBASE.md`) |
| `ISSUE_TEMPLATE/`, `pull_request_template.md` | — | Onyx's issue forms and PR checklist |
| `copilot-instructions.md`, `instructions/`, `skills/`, `prompts/`, `agents/`, `learnings/` | — | Upstream's agent instruction trees, kept for contributors who use them; they run nothing |

## Inherited from upstream, inert by trigger

Upstream's fifteen workflows were "disabled manually" in this repository's Actions settings. That state
lived only in GitHub's settings, so A11 made it true in the tree: the files are deleted, together with the
bot and ownership configurations that upstream's services read. The hygiene check
(`inherited-automation`) fails if any of them comes back, so an upstream merge cannot quietly re-enable
them. On a merge, take the Onyx side ("deleted") for every path below; `REBASE.md` lists them.

| Path | State | Why |
|---|---|---|
| `workflows/pr.yml`, `pr-linux-test.yml`, `pr-darwin-test.yml`, `pr-win32-test.yml`, `pr-linux-cli-test.yml`, `pr-node-modules.yml` | deleted | Upstream's PR matrix; needs upstream's runners, secrets and Azure pipelines |
| `workflows/monaco-editor.yml`, `component-fixtures.yml`, `chat-lib-package.yml`, `chat-perf.yml`, `css-order-scan.yml`, `copilot-setup-steps.yml`, `sessions-e2e.yml`, `telemetry.yml`, `require-commit-trailer.yml` | deleted | Upstream-only checks and publishing |
| `workflows/node_modules_cache/`, `workflows/check-clean-git-state.sh` | deleted | Helpers of the deleted workflows |
| `CODEOWNERS` | deleted | Requested reviews from Microsoft staff on every PR |
| `dependabot.yml` | deleted | Would open dependency PRs against upstream's lockfiles |
| `classifier.json`, `commands.json`, `commands/`, `similarity.yml`, `insiders.yml`, `endgame/`, `CODENOTIFY` | deleted | Configuration for upstream's issue bots (vscode-triage-bot, codenotify), which are not installed here |
| `actions/` | kept | Composite actions; nothing references them now, and they run nothing on their own |

Old disabled entries in GitHub's Actions history are not a failed gate (ActionPlan A11). On an upstream
merge, take the Onyx side for every file in the second table; `REBASE.md` lists each one.
