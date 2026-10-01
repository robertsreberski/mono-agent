---
name: flaky-tests
description: Classify a suspected flaky test and route it by PR scope — fix it in the current PR when the flake is inside that PR's scope, otherwise file or update a GitHub issue. Use when a test fails intermittently, passes on rerun at the same commit, fails in CI on code the diff cannot reach, or when asked about flaky tests.
---

# Flaky tests

A flaky test fails and passes at the same commit without a causal change. A
flake is never silently rerun until green and forgotten: every confirmed flake
either gets fixed in the PR that owns it or gets a GitHub issue.

## 1. Confirm it is flaky

Treat a failure as a suspected flake only with evidence, not because it is
inconvenient. Any one of these is enough:

- The same commit failed and then passed on rerun (CI attempt 2, or a local rerun).
- The failing test cannot be reached by the diff: compare the changed files with
  the test's imports and fixtures, and check that `origin/main` is green.
- Different tests in the same file fail across runs, typically timeouts or
  `vi.waitFor` give-ups under load.

If the failure reproduces deterministically, it is a real failure, not a flake:
diagnose it as one (see `verify-green` failure handling). When the failure may
pre-exist, compare against the exact base SHA in a detached worktree before
deciding.

Collect the evidence once: test file and test name, the error excerpt, the CI
run URL and job, the head SHA, and whether rerun at the same SHA passed.

## 2. Decide scope

The flake is **in scope** of the current PR when any of these is true:

- The PR adds or modifies the failing test, its file, or its shared test helpers.
- The PR changes the code under test, or the fixture, timer, config or build
  input that the test depends on.
- The flake appeared with this PR's change (it does not fail on the base SHA
  under the same conditions).

Otherwise it is **out of scope**: an unrelated package, a test the diff cannot
reach, or a flake that already fails on `main`.

When the call is close, prefer out of scope. A PR keeps its stated goal; it
does not absorb unrelated repairs.

## 3. In scope: fix it in the PR

Fix the cause, not the symptom:

- Replace wall-clock sleeps and implicit budgets with deterministic
  synchronization: await the event, use fake timers, give each `vi.waitFor` an
  explicit timeout that fits the documented path, and keep enclosing test
  timeouts larger than the waits inside them.
- Isolate shared state (temp dirs, ports, module mocks, environment variables)
  between cases.
- Keep every assertion and test name. Do not skip, quarantine, `.only`, or add
  `retry` to make the flake disappear. A real hang must still fail.
- If the flake exposes a product race rather than a test race, fix the product
  code and say so.

Prove the fix by running the single test repeatedly, ideally under load
(alongside its package suite), for example:

```bash
for i in $(seq 1 20); do
  pnpm --filter @mono-agent/<pkg> exec vitest run <path> -t "<test name>" || break
done
```

When the root cause is a pattern (for example an unbudgeted `vi.waitFor`), add a
cheap guard test that fails on the old pattern. Commit the fix separately, with
a `test(<scope>):` or `fix(<scope>):` message, and mention it in the PR body as
a flake fix, with the evidence from step 1.

## 4. Out of scope: file a GitHub issue

Do not fix it in the current PR. First search for an existing report:

```bash
gh issue list --state all --search "Flaky <test name or file> in:title,body"
```

- An **open** issue already covers it: add a comment with the new occurrence
  (run URL, SHA, error excerpt). Do not open a duplicate.
- A **closed** issue covers it: the fix did not hold. Open a new issue that
  links the old one.
- Nothing matches: open a new issue.

Title it `Flaky: <package> <short test description>` and label it `bug`. Use
this body:

```markdown
## Summary
<package> `<test file>` — "<test name>" failed once and passed on rerun at the
same commit. Error excerpt, run URL, job, head SHA.

## Why it is a flake and not a caller's bug
What the PR changed, why that cannot reach this test, and whether `main` was
green at the time.

## Suspicion
The likely race or budget mismatch, with file:line where known. Say plainly if
the cause is unknown.

## Desired behavior
What a fix should achieve, and whether the window is test-only or reachable in
production.
```

Keep logs to the relevant excerpt; never paste secrets, tokens or private user
data into the issue. Then link the issue from the PR (`Unrelated flake: #N`), and
rerun only the failed CI jobs to obtain the PR's verdict.

## Report

State the classification (real failure, in-scope flake, out-of-scope flake),
the evidence, and the outcome: the fixing commit and repeated-run result, or the
issue number that was filed or updated.
