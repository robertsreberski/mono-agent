import { describe, expect, it, vi } from "vitest";

import type { AgentResponder } from "@mono-agent/agent-contracts";

import { startCronAdapter, toCronJobs } from "../index.js";

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
    } finally {
      scheduler.stop();
      vi.useRealTimers();
    }
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
