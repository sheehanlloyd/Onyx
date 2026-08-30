# Contributing to Onyx

> **Note:** the `CONTRIBUTING.md` in the repository root belongs to upstream
> Visual Studio Code and describes contributing to *that* project. This file
> takes precedence on GitHub and is the one that applies to Onyx. The upstream
> file is left untouched on purpose — see [`REBASE.md`](../REBASE.md).

Onyx is a fork of VS Code that runs entirely on local models. Contributions are
welcome. This document is short because most of what you need to know is a
consequence of one constraint.

## The one constraint: Onyx must stay rebaseable

Onyx tracks upstream VS Code. If the fork accumulates edits scattered across
upstream files, every rebase becomes a merge marathon and the project dies of
maintenance. So:

**All new code goes in Onyx-owned paths.**

```
src/vs/platform/onyxRuntime/     pure logic + Node-side services
src/vs/workbench/contrib/onyx/   the product surface
test/onyx/                       mocks, end-to-end harness, benchmarks
```

**Edits to upstream files need justification and a REBASE.md entry.** When you
genuinely must touch upstream, prefer in this order:

1. A `product.json` field
2. A settings default
3. A context key
4. A new additive file
5. A small, guarded edit

Never reformat upstream code, and never make an upstream edit larger than it has
to be. Every upstream touch gets a row in [`REBASE.md`](../REBASE.md) explaining
what and why. The current fork is a handful of registration one-liners, and the
last three rebase drills against upstream produced exactly one trivial conflict
each. Keep it that way.

## Architecture in one paragraph

Pure decisions live in `common/` as plain functions with no service
dependencies, so they can be unit tested directly — the edit parsers, the
terminal approval policy, the hunk algebra, the benchmark scoring. Anything
touching the filesystem or a model runtime lives in `node/` behind the
`onyxRuntime` channel. UI lives in `browser/`. If you find yourself writing a
decision inside a view, it belongs in `common/` with a test.

## Before you open a pull request

Run the gates. All of them pass on `main`; a PR that breaks one will not merge.

```bash
npm run typecheck-client
npm run valid-layers-check
npx eslint src/vs/platform/onyxRuntime src/vs/workbench/contrib/onyx test/onyx
./scripts/test.sh --grep Onyx
```

And for anything touching behaviour, the end-to-end harness. It boots a real
workbench against two mock runtimes and asserts on the run journal and live DOM:

```bash
node test/onyx/run-e2e.mts
```

New behaviour should come with both a unit test for the decision and an
end-to-end check for the wiring. `test/onyx/README.md` explains how to add one.

## What makes a good Onyx change

- **It works on a 1.5B model.** Onyx's whole premise is that a laptop-sized model
  is enough if the harness around it is good. Features that only work when the
  model is smart are not Onyx features. Test against the smallest model you have.
- **It fails honestly.** Onyx would rather tell you it could not do something than
  silently produce a plausible wrong answer. Parsers that guess, retrieval that
  returns something rather than nothing, and benchmarks that flatter the tool are
  all bugs.
- **It measures rather than claims.** If you add a performance feature, add it to
  `test/onyx/run-benchmarks.mts` so the claim is reproducible on someone else's
  machine. Onyx ships a measurement showing speculative decoding *not* helping on
  the author's hardware; that is the standard.

## Sign-off

Contributions are accepted under the
[Developer Certificate of Origin](https://developercertificate.org/). Certify it
by signing off your commits:

```bash
git commit -s -m "your message"
```

This adds a `Signed-off-by:` line, which states you have the right to submit the
work under the project's license. There is no CLA.

## Licensing of contributions

By contributing you agree your work is licensed MIT, matching the rest of the
project. Note that source files must carry the upstream copyright header to pass
the inherited `header/header` lint rule — [`NOTICE.md`](../NOTICE.md) explains
why that is a build requirement rather than a statement about who wrote what.

## Reporting bugs and asking for features

Use the Onyx issue templates. Include which model and runtime you were on —
"qwen2.5-coder:7b on Ollama" — because with local models that is usually the
first thing that matters.
