# Pilot tasks

Version 1, dated 2026-11-22.

## Rules

1. **This task list is frozen.** Any change to a prompt, a check file, a
   patch, an acceptance criterion or a time box after the first session has
   been run invalidates comparison with earlier sessions. A change therefore
   needs a new version number, and results are only compared within one
   version. This is version 1.
2. **Prompts are given verbatim.** The participant pastes the text in the
   "Prompt" block exactly as written, as the opening message of a new
   conversation, into whichever tool is being tested. The text is identical
   for every tool. The participant may send follow-up messages in their own
   words; the organiser records how many.
3. Every task has a time box of 15 minutes, measured from sending the prompt.
   When the time is up the organiser runs the acceptance checks on whatever is
   in the working tree.
4. Every task starts from a clean working tree at the baseline commit named
   for that task (see "Organiser setup"). The organiser resets the tree
   between tasks.
5. Check files are kept out of the repository during the session. The
   organiser adds them only after the time box has ended.

Repositories, pinned commits, setup and test commands are in
`REPOSITORIES.md`. All paths and commands below are relative to the root of
the cloned repository.

## Task ids

The letter is the repository, the digit is the kind of task.

| | A: cachetools (Python) | B: ufo (TypeScript) | C: semver (Go) |
|---|---|---|---|
| 1: feature addition | A1 | B1 | C1 |
| 2: bug fix | A2 (planted) | B2 (real) | C2 (real) |
| 3: search question | A3 | B3 | C3 |
| 4: conflict scenario | A4 | B4 | C4 |

## Organiser setup

For each repository, follow the setup in `REPOSITORIES.md`, then create a
local branch so that the baseline has a name:

```
git checkout -b pilot-base
```

For repository A only, also create the planted baseline used by task A2.
Save the patch from the A2 section as `a2-plant.patch` outside the
repository, then:

```
git checkout -b pilot-a2 pilot-base
git apply <path to a2-plant.patch>
git commit -am "pilot baseline"
git checkout pilot-base
```

Committing the patch keeps `git status` and `git diff` empty at the start of
A2, so the planted line does not show up as an uncommitted change.

Reset between tasks (use `pilot-a2` instead of `pilot-base` before A2):

```
git checkout -f pilot-base
git reset --hard pilot-base
git clean -fdx -e .venv -e node_modules
```

## Rules for the conflict tasks (A4, B4, C4)

- The participant sends the prompt, then makes the manual edit **and saves the
  file** while the tool is still working: as soon as the tool shows any
  activity on the named file, and in any case within 30 seconds of sending the
  prompt. In the editor under test the manual edit is typed in that editor.
  For the other tools it is typed in whatever editor the participant normally
  uses alongside that tool.
- If the tool has already finished before the manual edit is saved, the run is
  void. Reset and repeat it once.
- If the tool asks for approval before writing, the participant makes the
  manual edit before approving anything.
- After the tool has stopped (or the time box has ended) the participant
  accepts whatever the tool offers by its default action and the organiser
  runs the checks.
- The organiser records which of these happened. Outcomes 1 to 3 are
  acceptable; outcome 4 is a failure:
  1. **Rebased**: the tool's changes were applied around the manual edit.
  2. **Refused**: the tool noticed the file had changed and did not write.
  3. **Conflict shown**: the tool showed both versions and asked.
  4. **Overwritten**: the manual edit is gone and the tool said nothing.

---

# Repository A: cachetools (Python)

Baseline: `pilot-base` (commit `c5de5137153b301933922e47bc70b598970e0627`),
except A2.

## A1. Feature: `LRUCache.peek`

Time box: 15 minutes.

Prompt:

```
Add a method `peek(key, default=None)` to the `LRUCache` class in src/cachetools/__init__.py. It returns the value stored for `key` without marking the key as recently used, and returns `default` if the key is not in the cache. Example: with `c = LRUCache(maxsize=2)`, after `c["a"] = 1` and `c["b"] = 2`, `c.peek("a")` returns 1; if I then do `c["c"] = 3`, the key "a" is the one evicted, so `sorted(c)` is `["b", "c"]`. After that `c.peek("a")` returns None and `c.peek("a", 0)` returns 0. Do not change the behaviour of any existing method.
```

Acceptance criteria:

1. Save the check file below as `pilot_a1_check.py` in the repository root and
   run `.venv/bin/python pilot_a1_check.py`. Expected output, exactly:
   `A1 OK`.
2. Run `.venv/bin/python -m pytest -q`. Expected: the summary line reports no
   failures and no errors, and at least `476 passed`.

Check file `pilot_a1_check.py`:

```python
from cachetools import LRUCache

c = LRUCache(maxsize=2)
c["a"] = 1
c["b"] = 2
assert c.peek("a") == 1
c["c"] = 3
assert sorted(c) == ["b", "c"], sorted(c)
assert c.peek("a") is None
assert c.peek("a", 0) == 0
assert c.peek("b") == 2
c["d"] = 4
assert sorted(c) == ["c", "d"], sorted(c)
print("A1 OK")
```

Verified at the pinned commit:

- Absent: `grep -rn peek src` finds nothing, and the check file ends with
  `AttributeError: 'LRUCache' object has no attribute 'peek'`.
- Satisfiable: with a five-line reference implementation added to `LRUCache`
  the check printed `A1 OK` and the suite reported
  `476 passed, 24 subtests passed`. The reference implementation was then
  discarded.

## A2. Bug fix: expired item still counted (planted)

**This bug is planted.** It is not present upstream. The organiser applies the
patch below before the session (see "Organiser setup"). The participant is not
told that it is planted or where it is.

Baseline: `pilot-a2`.

Time box: 15 minutes.

Patch `a2-plant.patch`:

```diff
diff --git a/src/cachetools/__init__.py b/src/cachetools/__init__.py
index a24e801..9f1d04a 100644
--- a/src/cachetools/__init__.py
+++ b/src/cachetools/__init__.py
@@ -657,7 +657,7 @@ class TTLCache(_TimedCache):
         expired = []
         cache_delitem = Cache.__delitem__
         cache_getitem = Cache.__getitem__
-        while curr is not root and not (time < curr.expires):
+        while curr is not root and time > curr.expires:
             expired.append((curr.key, cache_getitem(self, curr.key)))
             cache_delitem(self, curr.key)
             del links[curr.key]
```

How it shows up (run in the repository root on the `pilot-a2` baseline):

```
.venv/bin/python -c "
from cachetools import TTLCache
t = [0]
c = TTLCache(maxsize=2, ttl=1, timer=lambda: t[0])
c['a'] = 1
t[0] = 1
print('a' in c, len(c))"
```

Output with the planted bug: `False 1`. Correct output: `False 0`.

Prompt:

```
There is a bug in this repository. With `c = TTLCache(maxsize=2, ttl=1, timer=...)`, I store one item at time 0 and then advance the timer to exactly 1. At that moment `"a" in c` is False, as it should be, but `len(c)` is still 1; it should be 0. Some existing tests in tests/test_ttl.py fail because of this. Find the cause in src/cachetools/ and fix it. Do not modify anything under tests/.
```

Acceptance criteria:

1. Run the reproduction command above. Expected output, exactly: `False 0`.
2. Run `.venv/bin/python -m pytest -q`. Expected summary line:
   `476 passed, 24 subtests passed` followed by the duration.
3. Run `git diff --stat pilot-a2 -- tests`. Expected output: empty.

Verified:

- The patch applies cleanly to the pinned commit (`git apply --check`).
- With the patch applied the suite reports
  `5 failed, 471 passed, 24 subtests passed`. The failing tests are
  `tests/test_ttl.py::TTLCacheTest::test_ttl`, `::test_ttl_expire`,
  `::test_ttl_iter_expired`, and
  `tests/test_func.py::TTLDecoratorTest::test_ttl_expire` and
  `::test_ttl_expire_unbound`. The reproduction command prints `False 1`.
- Without the patch the reproduction command prints `False 0` and the suite
  reports `476 passed, 24 subtests passed`.
- A search for a real defect came up empty before planting: the source was
  read in full and a randomised script (20,000 short sequences of set, get,
  delete, pop, copy, pickle, clear and timer advances against all six cache
  classes, checking size accounting) found no violation.

## A3. Search question

Time box: 15 minutes.

Prompt:

```
Do not change any files. When a cache decorator in this repository is created with `info=True`, which function builds the `CacheInfo` tuple that `cache_info()` returns, and which two public functions hand that function to the wrapper they create? Give the three names and the file each one is defined in.
```

Acceptance criteria:

1. The tool's final answer names the three functions in the answer key and no
   others as the answer. Spelling of the names must match; the file must be
   given for each.
2. `git status --porcelain` prints nothing.

The answer key is in "Organiser's answer key" at the end of this file.

Verified: by `grep -rn _make_info src tests pyproject.toml` at the pinned
commit, which returns exactly one definition and two references, all in one
file, and by reading `src/cachetools/_decorator.py` to confirm that
`cache_info()` calls the function it was handed.

## A4. Conflict scenario

Time box: 15 minutes. See "Rules for the conflict tasks".

Prompt:

```
In src/cachetools/__init__.py, add a one-line docstring to every method that does not already have one. That includes double-underscore methods and the methods of nested classes. Do not change any code and do not change any existing docstring.
```

Manual edit, made by the participant in `src/cachetools/__init__.py` while the
tool is working:

- Line 16 reads `__version__ = "8.0.2"`. Put the cursor at the end of line 16,
  press Enter, and type this as the new line 17, starting in column 1:

  ```
  # pilot-edit: A4
  ```

- Save the file.

Acceptance criteria:

1. Run `grep -c '^# pilot-edit: A4$' src/cachetools/__init__.py`. Expected
   output: `1`.
2. Run `sed -n '16,17p' src/cachetools/__init__.py`. Expected output:

   ```
   __version__ = "8.0.2"
   # pilot-edit: A4
   ```

3. Run `.venv/bin/python -m pytest -q`. Expected summary line:
   `476 passed, 24 subtests passed` followed by the duration.
4. The organiser records the outcome as rebased, refused, conflict shown or
   overwritten. Criteria 1 and 2 failing means overwritten. How many
   docstrings the tool added is recorded but does not decide the task.

Verified at the pinned commit: line 16 is `__version__ = "8.0.2"` and line 17
is blank; the string `pilot` does not occur in the file; 86 of the 102
functions and methods in the file have no docstring (counted with Python's
`ast` module), so the instruction needs many separate edits. The manual edit
itself was not rehearsed against any tool.

---

# Repository B: ufo (TypeScript)

Baseline: `pilot-base` (commit `f06c800d0c59f2a4a1b9ba65eb6cb61a84419be6`).

## B1. Feature: `withoutQuery`

Time box: 15 minutes.

Prompt:

```
Add an exported function `withoutQuery(input: string): string` to src/utils.ts. It removes the query string from a URL or path and keeps everything else, including the fragment. Examples: `withoutQuery("/foo?bar=1&baz=2")` returns "/foo"; `withoutQuery("http://example.com/foo?q=123#bar")` returns "http://example.com/foo#bar"; `withoutQuery("/foo")` returns "/foo"; `withoutQuery("/foo#a?b")` returns "/foo#a?b" because that question mark is part of the fragment; `withoutQuery("//example.com/a?b=c")` returns "//example.com/a". It must be importable from the package entry point, src/index.ts, like the other helpers.
```

Acceptance criteria:

1. Save the check file below as `test/pilot-b1.test.ts` and run
   `pnpm vitest run test/pilot-b1.test.ts`. Expected: the output contains
   `Tests  6 passed (6)`.
2. Run `pnpm vitest run`. Expected: no failed tests, and at least 495 passed
   (the 489 existing tests plus the 6 in the check file).

Check file `test/pilot-b1.test.ts`:

```ts
import { expect, test } from "vitest";
import * as ufo from "../src";

const cases: [string, string][] = [
  ["/foo?bar=1&baz=2", "/foo"],
  ["http://example.com/foo?q=123#bar", "http://example.com/foo#bar"],
  ["/foo", "/foo"],
  ["/foo#a?b", "/foo#a?b"],
  ["//example.com/a?b=c", "//example.com/a"],
  ["?q=1", ""],
];

for (const [input, out] of cases) {
  test(`withoutQuery(${JSON.stringify(input)})`, () => {
    expect((ufo as any).withoutQuery(input)).toBe(out);
  });
}
```

Verified at the pinned commit:

- Absent: `grep -rn 'ithoutQuery' src test README.md` finds nothing, and the
  check file reports `Tests  6 failed (6)` with
  `TypeError: withoutQuery is not a function`.
- Satisfiable: with a three-line reference implementation the check file
  passed. The reference implementation was then discarded.

## B2. Bug fix: slash in the query mistaken for a trailing slash (real)

**This is a real defect at the pinned commit**, found by reading the code. It
is not planted and no patch is applied. It was not checked against the
upstream issue tracker, so it may or may not be known there.

Time box: 15 minutes.

How to reproduce: save the check file below as `test/pilot-b2.test.ts` and
run `pnpm vitest run test/pilot-b2.test.ts`. At the pinned commit it reports
`Tests  2 failed (2)`. For example
`withTrailingSlash("/foo?redirect=/", true)` returns `/foo?redirect=/`
unchanged, and `hasTrailingSlash("/foo?redirect=/", true)` returns `true`.

Prompt:

```
There is a bug in src/utils.ts. When the second argument (respectQueryAndFragment) is true, `hasTrailingSlash` and `withTrailingSlash` are fooled by a slash inside the query string or the fragment. `hasTrailingSlash("/foo?redirect=/", true)` returns true but should return false, because the path "/foo" has no trailing slash. `withTrailingSlash("/foo?redirect=/", true)` returns "/foo?redirect=/" but should return "/foo/?redirect=/". Likewise `withTrailingSlash("/foo#a/", true)` should return "/foo/#a/". Fix this so that only the path part decides. Do not modify the existing tests.
```

Acceptance criteria:

1. Save the check file below as `test/pilot-b2.test.ts` and run
   `pnpm vitest run test/pilot-b2.test.ts`. Expected: the output contains
   `Tests  2 passed (2)`.
2. Run `pnpm vitest run`. Expected: no failed tests, and at least 491 passed.
3. Run `git diff --stat pilot-base -- test`. Expected output: empty (run this
   before adding the check file, or ignore the check file itself).

Check file `test/pilot-b2.test.ts`:

```ts
import { expect, test } from "vitest";
import { hasTrailingSlash, withTrailingSlash } from "../src";

test("hasTrailingSlash ignores slashes in query and fragment", () => {
  expect(hasTrailingSlash("/foo?redirect=/", true)).toBe(false);
  expect(hasTrailingSlash("/foo?a=/#x", true)).toBe(false);
  expect(hasTrailingSlash("/foo#a/", true)).toBe(false);
  expect(hasTrailingSlash("/foo/?redirect=/", true)).toBe(true);
  expect(hasTrailingSlash("/foo/#a", true)).toBe(true);
  expect(hasTrailingSlash("/foo/", true)).toBe(true);
});

test("withTrailingSlash adds the slash to the path", () => {
  expect(withTrailingSlash("/foo?redirect=/", true)).toBe("/foo/?redirect=/");
  expect(withTrailingSlash("/foo?a=b/#x", true)).toBe("/foo/?a=b/#x");
  expect(withTrailingSlash("/foo#a/", true)).toBe("/foo/#a/");
  expect(withTrailingSlash("/foo/?redirect=/", true)).toBe("/foo/?redirect=/");
});
```

Verified at the pinned commit:

- Reproduces: the check file reports `Tests  2 failed (2)`; the three values
  quoted in the prompt were observed directly.
- Not covered upstream: the existing `test/trailing-slash.test.ts` has no
  case with a slash inside a query or fragment, which is why the suite passes.
- Satisfiable: with a one-line reference fix both check tests passed and the
  whole suite, with both check files present, reported
  `Tests  497 passed (497)`. The fix was then discarded.

## B3. Search question

Time box: 15 minutes.

Prompt:

```
Do not change any files. Which function in this repository decides whether a string starts with a protocol such as `https://`, and which three functions under src/ call it? Do not count tests or documentation comments. Give the four function names and the file each one is defined in.
```

Acceptance criteria:

1. The tool's final answer names the four functions in the answer key, with
   their files, and does not list any other function as a caller.
2. `git status --porcelain` prints nothing.

Verified: by `grep -rn 'hasProtocol(' src` at the pinned commit and by reading
each hit. Besides the definition, its two overload signatures and the lines
inside documentation comments, there are exactly three call sites.

## B4. Conflict scenario

Time box: 15 minutes. See "Rules for the conflict tasks".

Prompt:

```
In src/utils.ts, add a `@returns` line to the JSDoc comment of every exported function, describing what the function returns. Do not change any code.
```

Manual edit, made by the participant in `src/utils.ts` while the tool is
working:

- Line 434 reads (after six spaces of indentation):

  ```
  // TODO: Handle .. when joining
  ```

  Replace the text of that line, keeping the indentation, with:

  ```
  // TODO(pilot-edit B4): handle ".." when joining
  ```

- Save the file. If the tool has already inserted lines above, the line is no
  longer number 434; it is the only line in the file containing `TODO`.

Acceptance criteria:

1. Run `grep -c 'TODO(pilot-edit B4): handle ".." when joining' src/utils.ts`.
   Expected output: `1`.
2. Run `grep -c 'TODO: Handle' src/utils.ts`. Expected output: `0`.
3. Run `pnpm vitest run`. Expected: the output contains
   `Tests  489 passed (489)`.
4. The organiser records the outcome as rebased, refused, conflict shown or
   overwritten. Criterion 1 or 2 failing means overwritten. How many
   `@returns` lines the tool added is recorded but does not decide the task.

Verified at the pinned commit: line 434 of `src/utils.ts` is the `TODO` line
quoted above and it is the only `TODO` in the file; the file has 30 exported
functions and no `@returns` line, so the instruction needs about 30 separate
edits. The manual edit itself was not rehearsed against any tool.

---

# Repository C: semver (Go)

Baseline: `pilot-base` (commit `dd2b995c61c39ddd668b23ac919b04d607be35ab`).

## C1. Feature: `Version.Core`

Time box: 15 minutes.

Prompt:

```
Add a method `func (v Version) Core() Version` to version.go. It returns a copy of the version with the prerelease and the build metadata removed, and leaves the receiver unchanged. The copy's `Original()` keeps a leading "v" if the receiver's original string had one, the same way `IncPatch` does. Examples: for `MustParse("1.2.3-beta.1+build.5")`, `Core().String()` is "1.2.3" and `Core().Original()` is "1.2.3"; for `MustParse("v1.2.3-rc.1")`, `Core().String()` is "1.2.3" and `Core().Original()` is "v1.2.3"; for `MustParse("1.2")`, `Core().String()` is "1.2.0".
```

Acceptance criteria:

1. Save the check file below as `pilot_c1_test.go` in the repository root and
   run `go test -run 'TestPilotC1$' -v .`. Expected: the output contains
   `--- PASS: TestPilotC1` and ends with a line starting `ok`.
2. Run `go test ./...`. Expected: a single line starting
   `ok  	github.com/Masterminds/semver/v3`.

Check file `pilot_c1_test.go` (indentation is tabs):

```go
package semver

import "testing"

func TestPilotC1(t *testing.T) {
	tests := []struct{ in, str, orig string }{
		{"1.2.3-beta.1+build.5", "1.2.3", "1.2.3"},
		{"v1.2.3-rc.1", "1.2.3", "v1.2.3"},
		{"1.2.3+build", "1.2.3", "1.2.3"},
		{"v2.0.0", "2.0.0", "v2.0.0"},
		{"1.2", "1.2.0", "1.2.0"},
	}
	for _, tc := range tests {
		v := MustParse(tc.in)
		got := v.Core()
		if got.String() != tc.str || got.Original() != tc.orig {
			t.Errorf("Core(%q): got String %q Original %q, want %q and %q",
				tc.in, got.String(), got.Original(), tc.str, tc.orig)
		}
		if got.Prerelease() != "" || got.Metadata() != "" {
			t.Errorf("Core(%q): prerelease or metadata not cleared", tc.in)
		}
		if v.Original() != tc.in {
			t.Errorf("Core(%q) changed the receiver", tc.in)
		}
	}
}
```

Verified at the pinned commit:

- Absent: `grep -n 'Core' *.go` finds nothing, and the check file fails to
  build with `v.Core undefined (type *Version has no field or method Core)`.
- Satisfiable: with a seven-line reference implementation the check passed
  and `go test .` reported `ok`. The reference implementation was then
  discarded.

## C2. Bug fix: very large numeric prerelease identifiers compared as text (real)

**This is a real defect at the pinned commit**, found by reading the code. It
is not planted and no patch is applied. It is a narrow edge case: it needs a
numeric prerelease identifier too large for a 64-bit unsigned integer. It was
not checked against the upstream issue tracker, so it may or may not be known
there.

Time box: 15 minutes.

How to reproduce: save the check file below as `pilot_c2_test.go` in the
repository root and run `go test -run 'TestPilotC2$' -v .`. At the pinned
commit it prints:

```
Compare("1.0.0-99999999999999999999", "1.0.0-100000000000000000000") = 1, want -1
Compare("1.0.0-100000000000000000000", "1.0.0-99999999999999999999") = -1, want 1
```

Prompt:

```
There is a bug in version comparison. The SemVer specification says prerelease identifiers that consist only of digits are compared numerically. That works for small numbers, but when both identifiers are too large for a uint64 they are compared as text. `MustParse("1.0.0-99999999999999999999").Compare(MustParse("1.0.0-100000000000000000000"))` returns 1; it should return -1, because 99999999999999999999 is the smaller number. Find the cause and fix it so that digit-only identifiers of any length compare numerically. Keep all existing behaviour and do not modify the existing test files.
```

Acceptance criteria:

1. Save the check file below as `pilot_c2_test.go` in the repository root and
   run `go test -run 'TestPilotC2$' -v .`. Expected: the output contains
   `--- PASS: TestPilotC2` and ends with a line starting `ok`.
2. Run `go test ./...`. Expected: a single line starting
   `ok  	github.com/Masterminds/semver/v3`.
3. Run `git diff --stat pilot-base -- '*_test.go'`. Expected output: empty.

Check file `pilot_c2_test.go` (indentation is tabs):

```go
package semver

import "testing"

func TestPilotC2(t *testing.T) {
	tests := []struct {
		a, b string
		want int
	}{
		{"1.0.0-99999999999999999999", "1.0.0-100000000000000000000", -1},
		{"1.0.0-100000000000000000000", "1.0.0-99999999999999999999", 1},
		{"1.0.0-rc.18446744073709551616", "1.0.0-rc.18446744073709551615", 1},
		{"1.0.0-rc.18446744073709551615", "1.0.0-rc.18446744073709551616", -1},
		{"1.0.0-99999999999999999999", "1.0.0-alpha", -1},
		{"1.0.0-alpha", "1.0.0-99999999999999999999", 1},
		{"1.0.0-99999999999999999999", "1.0.0-99999999999999999999", 0},
		{"1.0.0-2", "1.0.0-10", -1},
	}
	for _, tc := range tests {
		got := MustParse(tc.a).Compare(MustParse(tc.b))
		if got != tc.want {
			t.Errorf("Compare(%q, %q) = %d, want %d", tc.a, tc.b, got, tc.want)
		}
	}
}
```

Verified at the pinned commit:

- Reproduces: the check file fails with exactly the two lines quoted above.
  The other six cases in the check file already pass; they are there so that
  a fix cannot break ordinary comparisons or the number-against-text rule.
- Satisfiable: with a reference fix of about ten lines the check passed and
  `go test .` reported `ok`. The fix was then discarded.

## C3. Search question

Time box: 15 minutes.

Prompt:

```
Do not change any files. Which function in this repository compares two whole prerelease strings, for example "alpha.1" against "alpha.2", and which two functions or methods call it? Do not count test files. Give the three names and the file each one is defined in.
```

Acceptance criteria:

1. The tool's final answer names the three functions in the answer key, with
   their files, and does not list any other function as a caller. Naming the
   per-identifier helper that the function itself calls, in addition, is not
   an error as long as it is not given as the answer or as a caller.
2. `git status --porcelain` prints nothing.

Verified: by `grep -n 'comparePrerelease(' *.go` at the pinned commit, which
returns the definition and exactly two call sites, neither in a test file,
and by reading the enclosing function of each call site.

## C4. Conflict scenario

Time box: 15 minutes. See "Rules for the conflict tasks".

Prompt:

```
In constraints.go, add a Go doc comment directly above every function, method, type, variable and constant declaration that does not already have one. Do not change any code and do not change any existing comment.
```

Manual edit, made by the participant in `constraints.go` while the tool is
working:

- Line 24 reads:

  ```
  // MaxConstraintLen is the maximum allowed length of a constraint string.
  ```

  Replace that line with:

  ```
  // MaxConstraintLen is the maximum allowed length of a constraint string (pilot-edit C4).
  ```

- Save the file.

Acceptance criteria:

1. Run `grep -c 'constraint string (pilot-edit C4)\.$' constraints.go`.
   Expected output: `1`.
2. Run `grep -c 'length of a constraint string\.$' constraints.go`. Expected
   output: `0`.
3. Run `go test ./...`. Expected: a single line starting
   `ok  	github.com/Masterminds/semver/v3`.
4. The organiser records the outcome as rebased, refused, conflict shown or
   overwritten. Criterion 1 or 2 failing means overwritten. How many comments
   the tool added is recorded but does not decide the task.

Verified at the pinned commit: line 24 of `constraints.go` is the comment
quoted above; the string `pilot` does not occur in the file; the file has 33
top-level declarations, of which 14 have no comment on the line directly
above (counted with `awk`). The manual edit itself was not
rehearsed against any tool.

---

# What was and was not verified

Verified on one Apple-silicon Mac, at the pinned commits, with the tool
versions listed in `REPOSITORIES.md`:

- Every feature (A1, B1, C1) is absent, and its check file fails before and
  passes after a reference implementation.
- The planted patch (A2) applies and makes five existing tests fail.
- Both real defects (B2, C2) reproduce, and their check files fail before and
  pass after a reference fix, with the full suites still passing.
- Every search answer (A3, B3, C3) was confirmed with `grep` and by reading
  the call sites.
- The patch and the five check files printed in this file were extracted from
  this file again and compared byte for byte with the copies that were run;
  the extracted patch was also re-checked with `git apply --check`.

Not verified:

- No task was run through any AI tool, so the 15-minute time box and the
  claim that the conflict instructions "take a while" are estimates. Run one
  dry session before the pilot and, if a time box or instruction has to
  change, issue version 2 before any real session.
- The conflict tasks (A4, B4, C4) depend on timing and on how each tool
  writes files. Only the starting state of the named lines was checked.
- Whether B2 and C2 are already reported or fixed upstream after the pinned
  commits was not checked.
- Nothing was tried on Linux or Windows, or with other language versions.

---

# Organiser's answer key

Do not show this section to participants, and do not leave this file open in
the workspace the tool can read.

## A3

- The function that builds the tuple: `CacheInfo._make_info`, a classmethod
  defined in `src/cachetools/__init__.py` (line 853).
- The two public functions that hand it to the wrapper: `cached` (reference on
  line 871) and `cachedmethod` (reference on line 888), both defined in
  `src/cachetools/__init__.py`. Each passes it on only when `info` is true.
- Accept `_make_info` without the class prefix. Do not accept an answer that
  names the `cache_info` methods in `src/cachetools/_decorator.py` as the
  builder; they only call the function they were given.

## B3

- The function that decides: `hasProtocol`, defined in `src/utils.ts`
  (implementation on line 71; overload signatures on lines 37 and 43).
- The three callers:
  - `withBase` in `src/utils.ts` (call on line 291)
  - `joinRelativeURL` in `src/utils.ts` (call on line 475)
  - `parseURL` in `src/parse.ts` (call on line 68)
- Not a caller: the `hasProtocol` getter on the `$URL` class in `src/url.ts`
  (line 56) has the same name but does not call the function.

## C3

- The function that compares: `comparePrerelease`, defined in `version.go`
  (line 692).
- The two callers:
  - the method `(*Version).Compare` in `version.go` (call on line 606)
  - `constraintNotEqual` in `constraints.go` (call on line 366)
- Not the answer: `comparePrePart` in `version.go` compares one identifier at
  a time and is called by `comparePrerelease`.

## Where the bugs are (for the organiser only)

- A2: `TTLCache.expire` in `src/cachetools/__init__.py`. The planted loop
  condition is `time > curr.expires`; the original is
  `not (time < curr.expires)`. Any fix that removes items whose expiry time
  equals the current time is acceptable.
- B2: `hasTrailingSlash` in `src/utils.ts` tests the whole input against the
  regular expression `TRAILING_SLASH_RE`, which matches `/?` and `/#` anywhere
  and a final `/` even when it belongs to the query or fragment.
  `withTrailingSlash` returns early on that result.
- C2: `comparePrePart` in `version.go` uses `strconv.ParseUint`; when both
  identifiers overflow, both parse errors are taken to mean "not a number"
  and the identifiers are compared as strings.
