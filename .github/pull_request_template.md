<!-- Thanks for the pull request. A few things that make review fast: -->

**What this changes**

<!-- One paragraph. Link the issue if there is one. -->

**How it was verified**

<!-- Onyx's standard is that "it typechecks" is not evidence. Say what you ran
     and what it showed — a test name, a benchmark delta, a screenshot of the
     running app, a line from the run journal. -->

- [ ] `npm run typecheck-client` and `npm run valid-layers-check`
- [ ] `npx eslint src/vs/platform/onyxRuntime src/vs/workbench/contrib/onyx test/onyx`
- [ ] `./scripts/test.sh --grep Onyx`
- [ ] `node test/onyx/run-e2e.mts` (if behavior changed)
- [ ] Shown working in the running app (if user-facing)

**Fork hygiene**

- [ ] New code lives under `src/vs/platform/onyxRuntime/`,
      `src/vs/workbench/contrib/onyx/` or `extensions/theme-onyx/`
- [ ] Any upstream file touched is listed in [REBASE.md](../REBASE.md), with
      the change described
- [ ] No network calls to anything but a user-configured local endpoint
- [ ] Commits are signed off (`git commit -s`) — see
      [CONTRIBUTING.md](../CONTRIBUTING.md)
