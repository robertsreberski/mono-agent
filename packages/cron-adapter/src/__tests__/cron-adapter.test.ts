import { describe, expect, it, vi } from "vitest";

import type { AgentResponder } from "@worklab-ai/agent-contracts";

import { startCronAdapter } from "../index.js";

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

  it("skips overlapping ticks for the same job", async () => {
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
    const results: unknown[] = [];

    const scheduler = startCronAdapter({
      responder,
      jobs: [{
        id: "slow",
        expression: "* * * * *",
        prompt: "slow work",
      }],
      now: () => new Date(Date.now()),
      onResult: (result) => {
        results.push(result);
      },
    });

    try {
      await vi.advanceTimersByTimeAsync(60_000);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(results).toEqual([
        expect.objectContaining({ kind: "skipped", jobId: "slow", reason: "overlap" }),
      ]);

      finish();
      await vi.runOnlyPendingTimersAsync();
      await expect.poll(() => results).toContainEqual(expect.objectContaining({ kind: "succeeded", jobId: "slow" }));
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
