---
title: "Flaky CI test timeouts: find the slow path before raising the limit"
description: "Flaky CI test timeouts? Derive the slow path floor from deadline plus grace, split durable from in-memory waits, then size timeouts without hiding failures."
publishDate: 2026-09-24
tags: ["ci-testing", "flaky-tests", "subagents", "mono-agent"]
heroImage: ./hero-flaky-ci-wait-budgets.png
heroAlt: "Generated illustration of a flaky CI wait: a lime signal passes through three glass chambers for deadline, grace and durable delivery, ending at a check mark."
heroCaption: "Generated illustration of deadline, grace and durable delivery stages; not a product screenshot."
---

A flaky CI wait is not fixed by adding an arbitrary delay. First find what the assertion observes, then calculate the earliest time that state can exist. In mono-agent, a timeout-fenced subagent job could not deliver its wake for at least 6.6 seconds, yet two tests allowed only nine seconds for the entire durable path. I changed the *test's* upper bound, not the job's behavior or the assertion, in [PR #949](https://github.com/robertsreberski/mono-agent/pull/949).

That sounds like an unglamorous fix because it is. A larger timeout can conceal a real regression. It can also be the correct way to stop a test from reporting an expected, measured slow path as a failure. The difference is whether I can show where the time goes, whether the assertion still catches the wrong outcome, and whether the enclosing test actually allows the wait to finish.

## Why the flaky test timed out: a deadline, not a failed wake

One `main` CI run reported `expected 'pending' to be 'delivered'` in the background-subagent tests. The assertion checks a wake: after a detached child settles, its result has to be published durably and delivered back to the parent. On my machine, the affected waits passed when run alone and failed under load. The [PR #949 investigation](https://github.com/robertsreberski/mono-agent/pull/949) records both the failing run and the reproduction; I did not infer flakiness just because a rerun happened to pass.

The tempting repair would have been to retry the whole test, sleep before checking, or stop checking delivery and assert only that the job reached a terminal state. Each would make a red build easier to turn green without proving the wake got through. A terminal job and a delivered wake are different facts. The test needed to retain the latter assertion.

The test also had two clocks that looked easy to conflate. The job's `timeoutMs: 1500` is a *runtime* deadline. After that deadline aborts its provider, the job launcher allows a further 5,100 ms of grace before final settlement. The [launcher source at the merged revision](https://github.com/robertsreberski/mono-agent/blob/7bd7a06857073a80f5be78e230780fe33614cc54/packages/agent-app/src/process-jobs-internal.ts) and the [test fixture](https://github.com/robertsreberski/mono-agent/blob/7bd7a06857073a80f5be78e230780fe33614cc54/packages/agent-app/src/__tests__/background-subagents.test.ts) show those numbers. In this timeout-fence case, 1,500 + 5,100 = **6,600 ms before wake delivery can even begin**. A nine-second assertion wait leaves only 2.4 seconds for durable publication and wake settlement under a busy package test run.

That is the distinction that made the diagnosis useful: nine seconds sounds generous beside a 1.5-second job timeout. It is not generous beside the actual end-to-end path. The failure message reported what the store still said when the assertion gave up, not proof that delivery would never happen.

## Measure the slow path before raising the test timeout

The file already had `DURABLE_DELIVERY_TIMEOUT_MS = 15_000` and a comment explaining that durable publication plus wake settlement had repeatedly taken seven to nine seconds under full-package load. Three other waits on the same delivered-wake condition used that constant. The two timeout-fence waits still carried `9000`, despite having the additional 6.6-second floor. In [PR #949](https://github.com/robertsreberski/mono-agent/pull/949), I put them on the existing budget and widened their enclosing test deadlines so the wait and trailing assertions could actually complete. No production deadline, grace period, delivery code, assertion or test skip changed.

A load reproduction helped distinguish a hypothetical timing argument from the observed failure. With 16-way synthetic CPU contention and another test file running, the corrected cases completed in 11,809, 11,190 and 11,433 ms across three trials. Every one exceeded the old nine-second limit; every one completed within the new bound. On an idle machine, the cases ran in roughly 8.9–9.1 seconds, uncomfortably close to their old ceiling. Those measurements do not prove an upper bound for all machines or make contention on a developer computer equivalent to hosted CI. They do explain why the old setting was brittle.

There is a cost: if the wake is truly stuck, the assertion can now wait up to 15 seconds before failing. That cost is explicit. `vi.waitFor` exits as soon as its condition succeeds, so increasing the ceiling does not add six seconds to a passing case. In exchange, the test still fails when durable delivery never reaches the required state. A timeout should bound a real failure, not race a path the code deliberately takes.

## Durable and in-memory waits need different timeout budgets

A related [PR #990](https://github.com/robertsreberski/mono-agent/pull/990) addressed more waits in the same test file, but they did not all have the timeout fence. Three `main` runs within a day in September 2026 failed on *different* waits: a service-degradation state after a journal fault, a confirmed publication, and separately persisted subagent progress. Four waits had relied on [Vitest's one-second `vi.waitFor` default](https://vitest.dev/api/vi.html#vi-waitfor); one had an explicit five seconds. The file's own seven-to-nine-second observation of durable settlement made those budgets suspect under package-wide contention.

The key question was not just which state a wait read, but what had to happen *before that state could change*. The progress test makes the split visible: it checks `f.service.get(id)` for live in-memory progress, then separately checks `f.store.get(id)` for persisted progress. Only the store wait acquired the 15-second budget. The journal-fault test is the exception to a simplistic store-versus-service rule: it reads `f.service.health.state`, but health can turn `degraded` only after the injected durable journal write fails in the asynchronous publication path. Its existing five-second wait also needed the larger budget. [PR #990](https://github.com/robertsreberski/mono-agent/pull/990) changed those five waits, along with their enclosing test deadlines, without widening the adjacent live-progress wait. That distinction matters more than the number 15: changing every timeout in the file would make genuine stalls slower to detect without evidence that those paths need the extra time.

The PR's local verification was also bounded. The file's cases and the rest of the package passed in partitions, but an unsharded full-package run — the contended setting that had produced the flakes — did not finish within the time limit for my local commands. I treated hosted CI as the check for that claim, not the smaller local slices as a substitute. The [#990 CI run](https://github.com/robertsreberski/mono-agent/actions/runs/35590163776) passed its required checks, including Verify; [#949's run](https://github.com/robertsreberski/mono-agent/actions/runs/35335537621) did too. Both PRs were subsequently merged. Those two green runs validate their respective heads, not the long-term absence of this flake on every future `main` run.

## Checklist: diagnosing a flaky CI wait timeout

When an asynchronous CI assertion expires, I now trace it in this order:

1. Identify the exact state being asserted.
2. Find the store or projection supplying it, and the work required before it can change.
3. Add up upstream deadlines, grace windows, retries and durable writes.
4. Compare that lower bound and observed durations with the wait's ceiling.
5. Check that the enclosing test deadline leaves room for assertions after the wait.

Only then do I choose between a code fix, a better synchronization point and a longer test budget.

This rule is not permission to turn every one-second wait into 15 seconds. A wait on a fast in-memory state can reveal a real regression at one second, while a wait on a durable publication path may be structurally incapable of succeeding that quickly under load. A shared constant can make the latter budget reviewable, but only if its callers really observe the same kind of work.

The unexciting takeaway is that **a red timeout is evidence about the observation window, not automatically about the system's final state**. Next time a wait goes red, the first number I want is the floor, not the ceiling.
