import { describe, expect, it, vi } from "vitest";

import type { AgentResponder } from "@mono-agent/agent-contracts";

import { startCronAdapter, toCronJobs } from "../index.js";
// handleTick is an internal export (not re-exported from the package index) so
// the overlap defense-in-depth fallback can be tested directly, bypassing the
// startup validateOptions gate that rejects an invalid overlap value.
import { handleTick } from "../scheduler.js";

describe("Cron adapter", () => {
  it("runs due cron jobs through a structural responder with cron metadata", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const calls: unknown[] = [];
    const responder: AgentResponder = {
      async respond(request, stream) {
        calls.push(request.metadata?.cron);
        await stream.append(`ran: ${request.text}`);
        return {};
      },
    };
    const results: unknown[] = [];

    const scheduler = startCronAdapter({
      responder,
      jobs: [{
        id: "heartbeat",
        expression: "* * * * *",
        timezone: "UTC",
        prompt: "check status",
        conversationId: "cron:heartbeat",
      }],
      now: () => new Date(Date.now()),
      onResult: (result) => {
        results.push(result);
      },
    });

    try {
      expect(scheduler.jobs).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(calls).toEqual([
        expect.objectContaining({
          jobId: "heartbeat",
          expression: "* * * * *",
          scheduledAt: "1970-01-01T00:01:00.000Z",
          startedAt: "1970-01-01T00:01:00.000Z",
        }),
      ]);
      expect(results).toEqual([
        expect.objectContaining({
          kind: "succeeded",
          jobId: "heartbeat",
          text: "ran: check status",
        }),
      ]);
    } finally {
      scheduler.stop();
      vi.useRealTimers();
    }
  });

  it("queues overlapping ticks for the same job and runs each after the prior finishes (preserve)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const started: string[] = [];
    const gates: Array<() => void> = [];
    const responder: AgentResponder = {
      async respond(request) {
        const cron = (request.metadata as { cron: { scheduledAt: string } }).cron;
        started.push(cron.scheduledAt);
        await new Promise<void>((resolve) => {
          gates.push(resolve);
        });
        return { text: "done" };
      },
    };
    const results: Array<{ kind: string }> = [];

    const scheduler = startCronAdapter({
      responder,
      // queue is opt-in (the default is skip), so request it explicitly.
      overlap: "queue",
      jobs: [{ id: "slow", expression: "* * * * *", prompt: "slow work" }],
      now: () => new Date(Date.now()),
      onResult: (result) => {
        results.push(result);
      },
    });

    try {
      await vi.advanceTimersByTimeAsync(60_000); // tick 1 -> run 1 starts (gated)
      await vi.advanceTimersByTimeAsync(60_000); // tick 2 -> queued (NOT skipped)

      expect(started).toHaveLength(1);
      expect(results).toContainEqual(expect.objectContaining({ kind: "queued", jobId: "slow" }));
      expect(results.some((r) => r.kind === "skipped")).toBe(false);

      gates[0]?.(); // run 1 completes -> drains the queued firing
      await vi.runOnlyPendingTimersAsync();
      await expect.poll(() => started).toHaveLength(2); // queued firing ran
      gates[1]?.();
      await vi.runOnlyPendingTimersAsync();
      await expect
        .poll(() => results.filter((r) => r.kind === "succeeded").length)
        .toBe(2); // both firings preserved + completed
    } finally {
      scheduler.stop();
      vi.useRealTimers();
    }
  });

  it("overlap:'skip' preserves the legacy skip-on-overlap behavior", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let finish!: () => void;
    const responder: AgentResponder = {
      async respond() {
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        return { text: "done" };
      },
    };
    const results: Array<{ kind: string }> = [];

    const scheduler = startCronAdapter({
      responder,
      overlap: "skip",
      jobs: [{ id: "slow", expression: "* * * * *", prompt: "slow work" }],
      now: () => new Date(Date.now()),
      onResult: (result) => {
        results.push(result);
      },
    });

    try {
      await vi.advanceTimersByTimeAsync(60_000);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(results).toContainEqual(
        expect.objectContaining({ kind: "skipped", jobId: "slow", reason: "overlap" }),
      );
      finish();
      await vi.runOnlyPendingTimersAsync();
      // The original (first) run must still complete successfully after finish();
      // skipping the overlap must not abandon the in-flight run.
      expect(results).toContainEqual(
        expect.objectContaining({ kind: "succeeded", jobId: "slow" }),
      );
    } finally {
      scheduler.stop();
      vi.useRealTimers();
    }
  });

  it("unrecognized overlap mode defaults to skip (not unbounded queue)", async () => {
    // Drive handleTick directly so an invalid overlap value reaches the
    // dispatch fallback. (Going through startCronAdapter would fail fast at
    // validateOptions; this exercises the runtime defense-in-depth path.)
    let finish!: () => void;
    let started = 0;
    const responder: AgentResponder = {
      async respond() {
        started += 1;
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        return { text: "done" };
      },
    };
    const results: Array<{ kind: string; reason?: string }> = [];

    const options = {
      responder,
      // An invalid value a JS/untyped consumer (or `as` cast) could pass; the
      // dispatch must fall back to the safe "skip" default, not the unbounded
      // "queue" branch.
      overlap: "bogus" as never,
      jobs: [{ id: "slow", expression: "* * * * *", prompt: "slow work" }],
      now: () => new Date(Date.now()),
      onResult: (result: { kind: string }) => {
        results.push(result);
      },
    };
    const jobStates = new Map();

    // tick 1 -> no active run, starts (and gates) the in-flight run.
    handleTick(options.jobs[0]!, new Date(0), options, jobStates);
    await expect.poll(() => started).toBe(1);

    // tick 2 -> overlaps the active run with an unrecognized mode.
    handleTick(options.jobs[0]!, new Date(60_000), options, jobStates);
    await expect
      .poll(() => results.filter((r) => r.kind !== "succeeded"))
      .toContainEqual(expect.objectContaining({ kind: "skipped", jobId: "slow", reason: "overlap" }));
    expect(results.some((r) => r.kind === "queued")).toBe(false);
    expect(started).toBe(1); // overlap was NOT queued/run

    // The in-flight run must still complete; defaulting to skip must not
    // abandon the active run.
    finish();
    await expect
      .poll(() => results)
      .toContainEqual(expect.objectContaining({ kind: "succeeded", jobId: "slow" }));
  });

  it("overlap:'replace' reports the replaced run as cancelled even if its responder ignores abort and returns text", async () => {
    // Drive handleTick directly (as the "unrecognized overlap mode" test does) so
    // we control the gate precisely. The first (replaced) responder IGNORES the
    // abort signal and resolves with text after being replaced; the success path
    // must still classify it as cancelled, not succeeded.
    const gates: Array<() => void> = [];
    let started = 0;
    const responder: AgentResponder = {
      async respond() {
        started += 1;
        // Note: deliberately does NOT honor request.abortSignal; it just waits
        // for the gate and then resolves with text.
        await new Promise<void>((resolve) => {
          gates.push(resolve);
        });
        return { text: "done (ignored abort)" };
      },
    };
    const results: Array<{ kind: string; scheduledAt?: string }> = [];

    const options = {
      responder,
      overlap: "replace" as const,
      jobs: [{ id: "slow", expression: "* * * * *", prompt: "slow work" }],
      now: () => new Date(Date.now()),
      onResult: (result: { kind: string; scheduledAt?: string }) => {
        results.push(result);
      },
    };
    const jobStates = new Map();

    // tick 1 -> no active run, starts (and gates) the first run.
    handleTick(options.jobs[0]!, new Date(0), options, jobStates);
    await expect.poll(() => started).toBe(1);

    // tick 2 -> overlaps with overlap:"replace": aborts run 1's controller and
    // queues tick 2's firing.
    handleTick(options.jobs[0]!, new Date(60_000), options, jobStates);
    await expect
      .poll(() => results)
      .toContainEqual(expect.objectContaining({ kind: "queued", jobId: "slow" }));

    // Release the (now-aborted) first responder so it resolves with text. The
    // success path must reclassify it as cancelled because its controller was
    // aborted by the replace.
    gates[0]?.();
    await expect
      .poll(() => results)
      .toContainEqual(
        expect.objectContaining({ kind: "cancelled", scheduledAt: "1970-01-01T00:00:00.000Z" }),
      );

    // The replaced (first) firing must NOT be reported as succeeded.
    expect(
      results.some(
        (r) => r.kind === "succeeded" && r.scheduledAt === "1970-01-01T00:00:00.000Z",
      ),
    ).toBe(false);

    // Drain the queued (newest) firing and let it complete normally.
    await expect.poll(() => started).toBe(2);
    gates[1]?.();
    await expect
      .poll(() => results)
      .toContainEqual(
        expect.objectContaining({ kind: "succeeded", scheduledAt: "1970-01-01T00:01:00.000Z" }),
      );
  });

  it("overlap:'replace' emits a terminal 'dropped' for a queued firing it discards on a second replace", async () => {
    // Drive handleTick directly (as the prior replace test does) to bypass the
    // validateOptions overlap gate and control the gates precisely. A double
    // replace on one un-drained abort-ignoring run must surface a terminal
    // "dropped" for the firing the second replace discards — otherwise that
    // firing's earlier kind:"queued" is silently orphaned (no terminal).
    const gates: Array<() => void> = [];
    let started = 0;
    const responder: AgentResponder = {
      async respond() {
        started += 1;
        // Ignores request.abortSignal; waits for its gate, then resolves.
        await new Promise<void>((resolve) => {
          gates.push(resolve);
        });
        return { text: "done (ignored abort)" };
      },
    };
    const results: Array<{ kind: string; scheduledAt?: string; reason?: string }> = [];

    const options = {
      responder,
      overlap: "replace" as const,
      jobs: [{ id: "slow", expression: "* * * * *", prompt: "slow work" }],
      now: () => new Date(Date.now()),
      onResult: (result: { kind: string; scheduledAt?: string; reason?: string }) => {
        results.push(result);
      },
    };
    const jobStates = new Map();

    // tick 1 -> no active run, starts (and gates) the first run.
    handleTick(options.jobs[0]!, new Date(0), options, jobStates);
    await expect.poll(() => started).toBe(1);

    // tick 2 (replace) -> aborts run 1's controller and queues firing F1.
    handleTick(options.jobs[0]!, new Date(60_000), options, jobStates);
    await expect
      .poll(() => results)
      .toContainEqual(
        expect.objectContaining({ kind: "queued", scheduledAt: "1970-01-01T00:01:00.000Z" }),
      );

    // tick 3 (replace) BEFORE F1 drains (run 1 is still gated/active) -> F1 must
    // receive a terminal "dropped" instead of being silently orphaned.
    handleTick(options.jobs[0]!, new Date(120_000), options, jobStates);
    await expect
      .poll(() => results)
      .toContainEqual(
        expect.objectContaining({
          kind: "dropped",
          jobId: "slow",
          scheduledAt: "1970-01-01T00:01:00.000Z",
          reason: "overflow",
        }),
      );

    // Release the (aborted) first responder so the active slot clears and the
    // newest firing (F2 from tick 3) drains.
    gates[0]?.();
    await expect.poll(() => started).toBe(2);
    gates[1]?.();
    await expect
      .poll(() => results)
      .toContainEqual(
        expect.objectContaining({ kind: "succeeded", scheduledAt: "1970-01-01T00:02:00.000Z" }),
      );
  });

  it("reports a stop()-aborted run as cancelled even if its responder ignores abort and returns text", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let finish!: () => void;
    let started = 0;
    const responder: AgentResponder = {
      async respond() {
        started += 1;
        // Ignores request.abortSignal; resolves with text after the gate.
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        return { text: "done (ignored abort)" };
      },
    };
    const results: Array<{ kind: string }> = [];

    const scheduler = startCronAdapter({
      responder,
      jobs: [{ id: "slow", expression: "* * * * *", prompt: "slow work" }],
      now: () => new Date(Date.now()),
      onResult: (result) => {
        results.push(result);
      },
    });

    try {
      await vi.advanceTimersByTimeAsync(60_000); // tick 1 -> run 1 active (gated)
      await expect.poll(() => started).toBe(1);

      scheduler.stop(); // aborts the active run's controller

      finish(); // responder ignores abort and resolves with text
      await expect
        .poll(() => results)
        .toContainEqual(expect.objectContaining({ kind: "cancelled", jobId: "slow" }));
      expect(results.some((r) => r.kind === "succeeded")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects an invalid overlap mode at startup", () => {
    const responder: AgentResponder = {
      async respond() {
        return {};
      },
    };

    expect(() => startCronAdapter({
      responder,
      overlap: "bogus" as never,
      jobs: [{ id: "slow", expression: "* * * * *", prompt: "slow work" }],
      now: () => new Date(0),
    })).toThrow(/overlap/u);
  });

  it("rejects an invalid overflow policy at startup", () => {
    const responder: AgentResponder = {
      async respond() {
        return {};
      },
    };

    expect(() => startCronAdapter({
      responder,
      overlap: "queue",
      overflow: "bogus" as never,
      jobs: [{ id: "slow", expression: "* * * * *", prompt: "slow work" }],
      now: () => new Date(0),
    })).toThrow(/overflow/u);
  });

  it("drops the oldest queued firing past maxQueueDepth with overflow:'drop-oldest'", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const gates: Array<() => void> = [];
    const responder: AgentResponder = {
      async respond() {
        await new Promise<void>((resolve) => {
          gates.push(resolve);
        });
        return { text: "done" };
      },
    };
    const results: Array<{ kind: string; reason?: string }> = [];

    const scheduler = startCronAdapter({
      responder,
      overlap: "queue",
      maxQueueDepth: 1,
      overflow: "drop-oldest",
      jobs: [{ id: "slow", expression: "* * * * *", prompt: "slow work" }],
      now: () => new Date(Date.now()),
      onResult: (result) => {
        results.push(result);
      },
    });

    try {
      await vi.advanceTimersByTimeAsync(60_000); // run 1 active
      await vi.advanceTimersByTimeAsync(60_000); // queued depth 1
      await vi.advanceTimersByTimeAsync(60_000); // depth would be 2 > 1 -> drop oldest
      expect(results).toContainEqual(
        expect.objectContaining({ kind: "dropped", jobId: "slow", reason: "overflow" }),
      );
      gates.forEach((g) => g());
      await vi.runOnlyPendingTimersAsync();
    } finally {
      scheduler.stop();
      vi.useRealTimers();
    }
  });

  it("aborts active jobs on stop", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let observedAbort = false;
    const responder: AgentResponder = {
      async respond(request) {
        await new Promise<void>((resolve) => {
          request.abortSignal.addEventListener("abort", () => {
            observedAbort = true;
            resolve();
          }, { once: true });
        });
        return { text: "cancelled" };
      },
    };

    const scheduler = startCronAdapter({
      responder,
      jobs: [{ id: "cancel-me", expression: "* * * * *", prompt: "wait" }],
      now: () => new Date(Date.now()),
    });

    try {
      await vi.advanceTimersByTimeAsync(60_000);
      scheduler.stop();
      expect(observedAbort).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not schedule or run jobs disabled in config", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const calls: unknown[] = [];
    const responder: AgentResponder = {
      async respond(request) {
        calls.push(request.text);
        return {};
      },
    };

    const scheduler = startCronAdapter({
      responder,
      jobs: toCronJobs({
        jobs: [{ id: "off", enabled: false, expression: "* * * * *", timezone: "UTC", prompt: "should not run" }],
      }),
      now: () => new Date(Date.now()),
    });

    try {
      expect(scheduler.jobs).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(calls).toEqual([]);
    } finally {
      scheduler.stop();
      vi.useRealTimers();
    }
  });

  it("rejects cron expressions that are not five fields", () => {
    const responder: AgentResponder = {
      async respond() {
        return {};
      },
    };

    expect(() => startCronAdapter({
      responder,
      jobs: [{ id: "seconds", expression: "* * * * * *", prompt: "too often" }],
      now: () => new Date(0),
    })).toThrow(/five fields/u);
  });

  it("does not run jobs early when the next tick is beyond Node's max timeout", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const calls: unknown[] = [];
    const responder: AgentResponder = {
      async respond(request) {
        calls.push(request.metadata?.cron);
        return { text: "march" };
      },
    };
    const maxTimeoutMs = 2_147_483_647;
    const firstMarchTickMs = Date.UTC(1970, 2, 1);

    const scheduler = startCronAdapter({
      responder,
      jobs: [{ id: "monthly", expression: "0 0 1 3 *", prompt: "march check" }],
      now: () => new Date(Date.now()),
    });

    try {
      await vi.advanceTimersByTimeAsync(maxTimeoutMs);
      expect(calls).toEqual([]);

      await vi.advanceTimersByTimeAsync(firstMarchTickMs - maxTimeoutMs);
      expect(calls).toEqual([
        expect.objectContaining({
          jobId: "monthly",
          scheduledAt: "1970-03-01T00:00:00.000Z",
        }),
      ]);
    } finally {
      scheduler.stop();
      vi.useRealTimers();
    }
  });
});
