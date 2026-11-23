# Pilot repositories

Version 1, dated 2026-11-22. Companion to `TASKS.md` in this directory.

Three small public repositories, one per language. Each was checked with a
read-only `gh api repos/<owner>/<name>` call, cloned, checked out at the pinned
commit, and its test suite was run on the verification machine. No participant
or maintainer was contacted.

Verification machine: Apple-silicon Mac (arm64), macOS 26.5.1.

| Id | Language | Repository | Licence | Pinned commit | Source lines |
|----|----------|------------|---------|---------------|--------------|
| A | Python | https://github.com/tkem/cachetools | MIT | `c5de5137153b301933922e47bc70b598970e0627` | 1,682 |
| B | TypeScript | https://github.com/unjs/ufo | MIT | `f06c800d0c59f2a4a1b9ba65eb6cb61a84419be6` | 1,571 |
| C | Go | https://github.com/Masterminds/semver | MIT | `dd2b995c61c39ddd668b23ac919b04d607be35ab` | 1,710 |

Why these: each is a library with no service, database or network dependency
at test time; each is widely used as a dependency but small enough that few
people have read its source; each has a suite that finishes in seconds.

All commands below are run from the root of the cloned repository.

## A. cachetools (Python)

- URL: https://github.com/tkem/cachetools
- What it is: memoizing collections and decorators (LRU, LFU, TTL caches).
- Licence: MIT (`gh api` reports SPDX `MIT`; `LICENSE` in the repository).
- Pinned commit: `c5de5137153b301933922e47bc70b598970e0627`
- Commit date: 2026-11-18T21:19:28Z (tip of `master` when verified).
- Maintenance: not archived; last push 2026-11-19.
- Lines of source: 1,682, counted with `wc -l src/cachetools/*.py`
  (seven files; the `.pyi` stub files and `tests/` are not counted).
- Setup:

  ```
  git clone https://github.com/tkem/cachetools.git
  cd cachetools
  git checkout c5de5137153b301933922e47bc70b598970e0627
  python3 -m venv .venv
  .venv/bin/python -m pip install -e . pytest
  ```

- Test command:

  ```
  .venv/bin/python -m pytest -q
  ```

- Result seen: `476 passed, 24 subtests passed in 1.50s` (wall time about
  2 seconds).
- Tool versions: Python 3.14.7, pip 26.2.1, pytest 9.2.0. The project declares
  `requires-python >= 3.11`. pytest is not pinned by the repository, so the
  version installed is whatever is current on the day of setup.

## B. ufo (TypeScript)

- URL: https://github.com/unjs/ufo
- What it is: URL parsing and manipulation helpers.
- Licence: MIT (`gh api` reports SPDX `MIT`; `LICENSE` in the repository).
- Pinned commit: `f06c800d0c59f2a4a1b9ba65eb6cb61a84419be6`
- Commit date: 2026-04-29T10:51:45Z (tip of `main` when verified).
- Maintenance: not archived; `gh api` shows a push on 2026-11-21, but that
  push was not to `main`, whose tip is the April commit above. Treat it as
  stable rather than fast-moving.
- Lines of source: 1,571, counted with `wc -l src/*.ts` (seven files; `test/`
  is not counted).
- Setup:

  ```
  git clone https://github.com/unjs/ufo.git
  cd ufo
  git checkout f06c800d0c59f2a4a1b9ba65eb6cb61a84419be6
  pnpm install --frozen-lockfile
  ```

- Test command:

  ```
  pnpm vitest run
  ```

- Result seen: `Test Files  13 passed (13)`, `Tests  489 passed (489)`,
  duration 3.07s (wall time about 7 seconds). The install took about
  8 seconds.
- Tool versions: Node.js v26.13.1, pnpm 9.15.0, vitest 4.1.5,
  TypeScript 6.0.3 (the last two come from the lockfile).
- Notes:
  - `package.json` declares `packageManager: pnpm@10.33.2`. The install and
    the tests succeeded with pnpm 9.15.0 against the committed lockfile
    (lockfile version 9.0). pnpm 10.33.2 itself was not tried.
  - The repository's own `pnpm test` script also runs eslint, prettier and a
    type check. The pilot uses `pnpm vitest run` only, so that formatting
    differences between tools do not decide a task. `pnpm test` was not run.

## C. semver (Go)

- URL: https://github.com/Masterminds/semver
- What it is: semantic version parsing, comparison and constraint checking.
- Licence: MIT (`gh api` reports SPDX `MIT`; `LICENSE.txt` in the repository).
- Pinned commit: `dd2b995c61c39ddd668b23ac919b04d607be35ab`
- Commit date: 2026-08-14T20:55:09Z (tip of `master` when verified).
- Maintenance: not archived; last push 2026-08-14. Stable.
- Lines of source: 1,710, counted with `wc -l` over the four non-test `.go`
  files in the repository root (`version.go` 879, `constraints.go` 623,
  `doc.go` 184, `collection.go` 24). The `_test.go` files add 2,733 lines and
  are not counted.
- Setup:

  ```
  git clone https://github.com/Masterminds/semver.git
  cd semver
  git checkout dd2b995c61c39ddd668b23ac919b04d607be35ab
  ```

  The module has no dependencies outside the Go standard library, so there is
  nothing to download.

- Test command:

  ```
  go test ./...
  ```

- Result seen: `ok  	github.com/Masterminds/semver/v3	0.445s`. Wall time was
  about 23 seconds on the initial run (compilation) and under 2 seconds
  afterwards. `go test -v .` reports 49 top-level tests, all passing.
- Tool versions: go1.27.0 darwin/arm64. `go.mod` declares `go 1.21`.

## Resetting a repository between tasks

Every task starts from a clean tree at the pinned commit (task A2 starts from
the planted baseline described in `TASKS.md`). To reset without reinstalling
dependencies:

```
git reset --hard <baseline commit>
git clean -fdx -e .venv -e node_modules
```

## Not verified

- The suites were run on one machine only. Other operating systems, other
  CPU architectures and other Python, Node.js or Go versions were not tried.
- Candidates considered and set aside without running their tests:
  `r1chardj0n3s/parse`, `microsoft/node-jsonc-parser`, `bmatcuk/doublestar`.
  `dustin/go-humanize` was rejected because `gh api` reports no recognised
  licence identifier.
- "Unlikely to have been read by a typical developer" is a judgement, not a
  measurement. The session script should ask each participant whether they
  have read or contributed to any of the three.
