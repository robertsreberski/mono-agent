import { describe, expect, it, vi } from "vitest";

import { MAX_AGENT_REPLY_PARTS, type AgentReplyPart, type AgentResponder } from "@mono-agent/agent-contracts";

import type {
  CronAdapterOptions,
  CronFiringIdentity,
  CronJob,
  CronJobResult,
  CronPreflightRecord,
} from "../index.js";
import { CronAdapterError, startCronAdapter, toCronJobs } from "../index.js";
// handleTick is an internal export (not re-exported from the package index) so
// the overlap defense-in-depth fallback can be tested directly, bypassing the
// startup validateOptions gate that rejects an invalid overlap value.
import { handleTick } from "../scheduler.js";

function sensitiveReplyParts(): readonly AgentReplyPart[] {
  const sensitive = "/private/private-report.csv?token=capability-secret#sha256:deadbeef";
  return [
    {
      type: "attachment",
      id: sensitive,
      reference: { scheme: "mono-agent-artifact", id: sensitive },
      name: sensitive,
      mediaType: "text/csv",
      sizeBytes: 42,
      integrityId: "sha256:deadbeef",
    },
    {
      type: "mcp_app",
      id: sensitive,
      invocationId: sensitive,
      connectionId: sensitive,
      serverName: sensitive,
      toolName: sensitive,
      resourceUri: `http://127.0.0.1:4319/${sensitive}`,
      mediaType: "text/html;profile=mcp-app",
      protocolVersion: "2026-01-26",
      title: sensitive,
    },
    ...Array.from({ length: 20 }, (_, index) => ({
      type: "failure" as const,
      id: `${sensitive}:${String(index)}`,
      code: "artifact_missing" as const,
      message: sensitive.repeat(1_000),
      relatedPartId: sensitive,
    })),
  ];
}

function sparseReplyParts(length: number): readonly AgentReplyPart[] {
  const parts = new Array<AgentReplyPart>(length);
  parts[1] = {
    type: "failure",
    id: "known-sparse-one",
    code: "artifact_missing",
    message: "not copied",
  };
  if (length > 3) {
    parts[length - 1] = {
      type: "failure",
      id: "known-sparse-last",
      code: "artifact_expired",
      message: "not copied",
    };
  }
  return parts;
}

describe("Cron adapter", () => {
  it("keeps text verbatim and retains bounded sanitized failures for every unsupported rich part", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const results: CronJobResult[] = [];
    const parts = sensitiveReplyParts();
    const exactText = "  verbatim notification\n";
    const scheduler = startCronAdapter({
      responder: {
        async respond() {
          return {
            text: exactText,
            parts,
          };
        },
      },
      jobs: [{ id: "verbatim", expression: "* * * * *", prompt: "run" }],
      now: () => new Date(Date.now()),
      onResult: (result) => { results.push(result); },
    });
    try {
      await vi.advanceTimersByTimeAsync(60_000);
      await expect.poll(() => results.length).toBe(1);
      const result = results[0];
      expect(result?.kind).toBe("succeeded");
      if (result?.kind !== "succeeded") throw new Error("Expected a succeeded cron result.");
      expect(result.text).toBe(exactText);
      expect(result.replyPartOutcomes).toHaveLength(MAX_AGENT_REPLY_PARTS);
      expect(result.replyPartOutcomes?.slice(0, 2)).toEqual([
        expect.objectContaining({ partIndex: 0, partType: "attachment", code: "unsupported_destination" }),
        expect.objectContaining({ partIndex: 1, partType: "mcp_app", code: "unsupported_destination" }),
      ]);
      expect(result.replyPartOutcomes?.at(-1)).toMatchObject({
        code: "reply_part_too_large",
        affectedPartCount: 3,
      });
      const serialized = JSON.stringify(result);
      expect(Buffer.byteLength(serialized, "utf8")).toBeLessThan(6_000);
      expect(serialized).not.toContain("private-report");
      expect(serialized).not.toContain("capability-secret");
      expect(serialized).not.toContain("deadbeef");
    } finally {
      scheduler.stop();
      vi.useRealTimers();
    }
  });

  it("emits dense JSON-safe outcomes for sparse below- and above-cap reply arrays", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const results: CronJobResult[] = [];
    const scheduler = startCronAdapter({
      responder: {
        async respond(request) {
          return {
            text: `  ${request.text}\n`,
            parts: sparseReplyParts(request.text === "below" ? 4 : MAX_AGENT_REPLY_PARTS + 3),
          };
        },
      },
      jobs: [
        { id: "below", expression: "* * * * *", prompt: "below" },
        { id: "above", expression: "* * * * *", prompt: "above" },
      ],
      now: () => new Date(Date.now()),
      onResult: (result) => { results.push(result); },
    });
    try {
      await vi.advanceTimersByTimeAsync(60_000);
      await expect.poll(() => results.length).toBe(2);
      for (const [jobId, expectedLength, affectedPartCount] of [
        ["below", 4, undefined],
        ["above", MAX_AGENT_REPLY_PARTS, 4],
      ] as const) {
        const result = results.find((candidate) => candidate.jobId === jobId);
        expect(result?.kind).toBe("succeeded");
        if (result?.kind !== "succeeded") throw new Error(`Expected ${jobId} to succeed.`);
        expect(result.text).toBe(`  ${jobId}\n`);
        expect(result.replyPartOutcomes).toHaveLength(expectedLength);
        expect(result.replyPartOutcomes?.map((outcome) => outcome.partIndex))
          .toEqual(Array.from({ length: expectedLength }, (_, index) => index));
        if (affectedPartCount === undefined) {
          expect(result.replyPartOutcomes?.at(-1)).not.toHaveProperty("affectedPartCount");
        } else {
          expect(result.replyPartOutcomes?.at(-1)).toMatchObject({ affectedPartCount });
        }
        const serialized = JSON.stringify(result.replyPartOutcomes);
        expect(serialized).not.toContain("null");
        expect(JSON.parse(serialized)).toEqual(result.replyPartOutcomes);
        expect(result.replyPartOutcomes!.length).toBeLessThanOrEqual(MAX_AGENT_REPLY_PARTS);
      }
    } finally {
      scheduler.stop();
      vi.useRealTimers();
    }
  });

  it("seeds hashed schedules from the stable job id", () => {
    const random = vi.spyOn(Math, "random").mockReturnValue(0.5);
    let scheduler: ReturnType<typeof startCronAdapter> | undefined;

    try {
      scheduler = startCronAdapter({
        responder: { respond: async () => ({}) },
        jobs: [{ id: "stable-hash", expression: "H * * * *", prompt: "check status" }],
        now: () => new Date("2026-07-10T07:30:00.000Z"),
      });
      expect(scheduler.jobs).toHaveLength(1);
      expect(random).not.toHaveBeenCalled();
    } finally {
      scheduler?.stop();
      random.mockRestore();
    }
  });

  it("runs due cron jobs through a structural responder with cron metadata", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const calls: unknown[] = [];
    const responder: AgentResponder = {
      async respond(request, stream) {
        calls.push(request);
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
        notify: true,
        notifyConversationId: "telegram:42",
        model: "claude:claude-opus-4-8",
        effort: "high",
      }],
      now: () => new Date(Date.now()),
      onResult: (result: CronJobResult) => {
        results.push(result);
      },
    });

    try {
      expect(scheduler.jobs).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(calls).toEqual([
        expect.objectContaining({
          conversationId: "cron:heartbeat",
          replyTo: { conversationId: "telegram:42" },
          metadata: {
            cron: expect.objectContaining({
              jobId: "heartbeat",
              expression: "* * * * *",
              nativeNotify: {
                enabled: true,
                conversationId: "telegram:42",
              },
              model: "claude:claude-opus-4-8",
              effort: "high",
              scheduledAt: "1970-01-01T00:01:00.000Z",
              startedAt: "1970-01-01T00:01:00.000Z",
            }),
          },
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

  it("contains a synchronous durable-admission failure and re-arms the next scheduled instant", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const responder = { respond: vi.fn(async () => ({ text: "ok" })) };
    const degraded = vi.fn();
    const error = vi.fn();
    let admitted = 0;
    const scheduler = startCronAdapter({
      responder,
      jobs: [{ id: "durable", expression: "* * * * *", prompt: "run" }],
      now: () => new Date(Date.now()),
      admitFiring(input) {
        admitted += 1;
        if (admitted === 1) throw new Error("control database unavailable");
        return {
          runId: `cron:${input.jobId}:${input.scheduledAt}`,
          jobId: input.jobId,
          scheduledAt: input.scheduledAt,
          orderedAt: input.observedAt,
          sequence: 1,
          trigger: input.trigger,
        };
      },
      onDegraded: degraded,
      logger: { error },
    });

    try {
      await vi.advanceTimersByTimeAsync(60_000);
      expect(responder.respond).not.toHaveBeenCalled();
      expect(degraded).toHaveBeenCalledWith(
        "Cron firing admission failed. control database unavailable",
      );
      expect(error).toHaveBeenCalledWith(
        "Cron firing admission failed.",
        expect.objectContaining({
          jobId: "durable",
          scheduledAt: "1970-01-01T00:01:00.000Z",
          error: "control database unavailable",
        }),
      );
      expect(scheduler.snapshots()[0]).toMatchObject({
        nextRunAt: "1970-01-01T00:02:00.000Z",
      });

      await vi.advanceTimersByTimeAsync(60_000);
      await expect.poll(() => responder.respond).toHaveBeenCalledOnce();
      expect(admitted).toBe(2);
    } finally {
      scheduler.stop();
      vi.useRealTimers();
    }
  });

  it.each(["synchronous", "asynchronous"] as const)(
    "contains a %s run-start persistence failure, reclaims the slot, and keeps scheduling",
    async (failureMode) => {
      vi.useFakeTimers();
      vi.setSystemTime(0);
      const responder = { respond: vi.fn(async () => ({ text: "ok" })) };
      const results: CronJobResult[] = [];
      const degraded = vi.fn();
      let starts = 0;
      const scheduler = startCronAdapter({
        responder,
        jobs: [{ id: "start-state", expression: "* * * * *", prompt: "run" }],
        now: () => new Date(Date.now()),
        onRunStarted() {
          starts += 1;
          if (starts !== 1) return;
          if (failureMode === "synchronous") throw new Error("mark-started failed");
          return Promise.reject(new Error("mark-started failed"));
        },
        onResult: (result) => {
          results.push(result);
        },
        onDegraded: degraded,
      });

      try {
        await vi.advanceTimersByTimeAsync(60_000);
        await expect.poll(() => results).toContainEqual(expect.objectContaining({
          kind: "failed",
          jobId: "start-state",
          sequence: 1,
          error: "mark-started failed",
        }));
        expect(responder.respond).not.toHaveBeenCalled();
        expect(degraded).toHaveBeenCalledWith(
          "Cron run-start persistence failed. mark-started failed",
        );
        expect(scheduler.snapshots()[0]).toMatchObject({
          nextRunAt: "1970-01-01T00:02:00.000Z",
        });

        await vi.advanceTimersByTimeAsync(60_000);
        await expect.poll(() => responder.respond).toHaveBeenCalledOnce();
        await expect.poll(() => results).toContainEqual(expect.objectContaining({
          kind: "succeeded",
          jobId: "start-state",
          sequence: 2,
        }));
      } finally {
        scheduler.stop();
        vi.useRealTimers();
      }
    },
  );

  it("keeps a mid-lifecycle destination snapshot in both replyTo and the completion result", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const requests: unknown[] = [];
    const results: unknown[] = [];
    let candidates = ["slack:C1"];
    let resolutionCount = 0;
    const resolveNotifyFallbackConversationId = vi.fn(async () => {
      const resolved = candidates.length === 1 ? candidates[0] : undefined;
      if (resolutionCount === 0) {
        // The allowlist changes after this firing selects C1 but before the
        // responder starts. Neither replyTo nor the completion route may
        // re-resolve against the now-ambiguous candidate set.
        candidates = ["slack:C1", "slack:C2"];
      }
      resolutionCount += 1;
      return resolved;
    });
    const responder: AgentResponder = {
      async respond(request) {
        requests.push(request);
        return { text: "digest" };
      },
    };
    const scheduler = startCronAdapter({
      responder,
      jobs: [{ id: "digest", expression: "* * * * *", prompt: "p", notify: true }],
      now: () => new Date(Date.now()),
      resolveNotifyFallbackConversationId,
      onResult: (result: CronJobResult) => {
        results.push(result);
      },
    });

    try {
      await vi.advanceTimersByTimeAsync(60_000);
      expect(requests[0]).toEqual(expect.objectContaining({
        replyTo: { conversationId: "slack:C1" },
      }));
      expect(results[0]).toEqual(expect.objectContaining({
        kind: "succeeded",
        notifyConversationId: "slack:C1",
      }));

      await vi.advanceTimersByTimeAsync(60_000);
      expect(requests).toHaveLength(2);
      expect(results).toHaveLength(2);
      expect(requests[1]).not.toHaveProperty("replyTo");
      expect(results[1]).not.toHaveProperty("notifyConversationId");
      expect(resolveNotifyFallbackConversationId).toHaveBeenCalledTimes(2);
    } finally {
      scheduler.stop();
      vi.useRealTimers();
    }
  });

  it("preserves configured route precedence and contains live resolver rejection", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const seen = new Map<string, unknown>();
    const results: unknown[] = [];
    const warn = vi.fn();
    const resolveNotifyFallbackConversationId = vi.fn(async () => {
      throw new Error("destination lookup failed");
    });
    const responder: AgentResponder = {
      async respond(request) {
        const jobId = (request.metadata as { cron: { jobId: string } }).cron.jobId;
        seen.set(jobId, request.replyTo);
        return { text: jobId };
      },
    };
    const scheduler = startCronAdapter({
      responder,
      jobs: [
        {
          id: "explicit",
          expression: "* * * * *",
          prompt: "p",
          notify: true,
          notifyConversationId: "slack:C-EXPLICIT",
          notifyFallbackConversationId: "slack:C-FALLBACK",
        },
        {
          id: "fallback",
          expression: "* * * * *",
          prompt: "p",
          notify: true,
          notifyFallbackConversationId: "slack:C-FALLBACK",
        },
        { id: "dynamic", expression: "* * * * *", prompt: "p", notify: true },
      ],
      now: () => new Date(Date.now()),
      resolveNotifyFallbackConversationId,
      onResult: (result: CronJobResult) => {
        results.push(result);
      },
      logger: { warn },
    });

    try {
      await vi.advanceTimersByTimeAsync(60_000);

      expect(seen.get("explicit")).toEqual({ conversationId: "slack:C-EXPLICIT" });
      expect(seen.get("fallback")).toEqual({ conversationId: "slack:C-FALLBACK" });
      expect(seen.has("dynamic")).toBe(true);
      expect(seen.get("dynamic")).toBeUndefined();
      expect(resolveNotifyFallbackConversationId).toHaveBeenCalledOnce();
      expect(results).toHaveLength(3);
      expect(results).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "succeeded", jobId: "explicit", notifyConversationId: "slack:C-EXPLICIT" }),
        expect.objectContaining({ kind: "succeeded", jobId: "fallback", notifyConversationId: "slack:C-FALLBACK" }),
        expect.objectContaining({ kind: "succeeded", jobId: "dynamic" }),
      ]));
      const dynamicResult = results.find(
        (result) => (result as { jobId?: string }).jobId === "dynamic",
      );
      expect(dynamicResult).not.toHaveProperty("notifyConversationId");
      expect(warn).toHaveBeenCalledWith(
        "Cron native-notify destination resolution failed; running without a reply target.",
        { jobId: "dynamic", error: "destination lookup failed" },
      );
    } finally {
      scheduler.stop();
      vi.useRealTimers();
    }
  });

  it("reclaims the slot when a responder hangs past maxRunMs (watchdog), so future firings still run", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let respondCount = 0;
    const responder: AgentResponder = {
      async respond() {
        respondCount += 1;
        // Never settles and ignores the abort signal — models a wedged responder that would
        // otherwise pin state.active forever and skip every future firing.
        await new Promise(() => {});
        return {};
      },
    };
    const results: unknown[] = [];

    const scheduler = startCronAdapter({
      responder,
      jobs: [{ id: "wedged", expression: "* * * * *", timezone: "UTC", prompt: "x", conversationId: "cron:wedged" }],
      now: () => new Date(Date.now()),
      onResult: (result) => {
        results.push(result);
      },
      maxRunMs: 5_000,
    });

    try {
      await vi.advanceTimersByTimeAsync(60_000); // first firing starts, then hangs
      expect(respondCount).toBe(1);

      await vi.advanceTimersByTimeAsync(5_000); // watchdog fires -> abort + reclaim the slot
      const failed = results.find(
        (r): r is { kind: string; error?: string } => (r as { kind?: string }).kind === "failed",
      );
      expect(failed).toBeDefined();
      expect(failed?.error).toMatch(/timed out after 5000ms/u);

      await vi.advanceTimersByTimeAsync(55_000); // next minute boundary -> a NEW run starts
      expect(respondCount).toBe(2); // proves the slot was reclaimed, not skipped as "prior run active"
    } finally {
      scheduler.stop();
      vi.useRealTimers();
    }
  });

  it("includes destination resolution in maxRunMs and reclaims a slot when the resolver hangs", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const responder = { respond: vi.fn(async () => ({ text: "unexpected" })) } satisfies AgentResponder;
    const settleResolvers: Array<(value: string | undefined) => void> = [];
    const resolveNotifyFallbackConversationId = vi.fn(() => {
      return new Promise<string | undefined>((resolve) => {
        settleResolvers.push(resolve);
      });
    });
    const results: unknown[] = [];
    const scheduler = startCronAdapter({
      responder,
      jobs: [{ id: "resolver-hang", expression: "* * * * *", prompt: "p", notify: true }],
      now: () => new Date(Date.now()),
      resolveNotifyFallbackConversationId,
      onResult: (result) => {
        results.push(result);
      },
      maxRunMs: 5_000,
    });

    try {
      await vi.advanceTimersByTimeAsync(60_000);
      expect(resolveNotifyFallbackConversationId).toHaveBeenCalledTimes(1);
      expect(responder.respond).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(5_000);
      expect(results).toContainEqual(expect.objectContaining({
        kind: "failed",
        jobId: "resolver-hang",
        error: expect.stringMatching(/timed out after 5000ms/u),
      }));

      settleResolvers[0]?.("slack:C1");
      for (let turn = 0; turn < 4; turn += 1) {
        await Promise.resolve();
      }
      expect(responder.respond).not.toHaveBeenCalled();
      expect(results).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(55_000);
      expect(resolveNotifyFallbackConversationId).toHaveBeenCalledTimes(2);
      expect(responder.respond).not.toHaveBeenCalled();
    } finally {
      scheduler.stop();
      vi.useRealTimers();
    }
  });

  it("aborts hung destination resolution on stop without maxRunMs and ignores late settlement", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let resolverSignal: AbortSignal | undefined;
    let settleResolver!: (value: string | undefined) => void;
    const resolverPromise = new Promise<string | undefined>((resolve) => {
      settleResolver = resolve;
    });
    const resolveNotifyFallbackConversationId = vi.fn((abortSignal?: AbortSignal) => {
      resolverSignal = abortSignal;
      return resolverPromise;
    });
    const responder = { respond: vi.fn(async () => ({ text: "unexpected" })) } satisfies AgentResponder;
    const results: Array<{ kind: string }> = [];
    const scheduler = startCronAdapter({
      responder,
      jobs: [{ id: "resolver-stop", expression: "* * * * *", prompt: "p", notify: true }],
      now: () => new Date(Date.now()),
      resolveNotifyFallbackConversationId,
      onResult: (result) => {
        results.push(result);
      },
    });

    try {
      await vi.advanceTimersByTimeAsync(60_000);
      expect(resolveNotifyFallbackConversationId).toHaveBeenCalledOnce();
      expect(responder.respond).not.toHaveBeenCalled();

      scheduler.stop();
      await expect.poll(() => results).toContainEqual(expect.objectContaining({
        kind: "cancelled",
        jobId: "resolver-stop",
      }));
      expect(resolverSignal?.aborted).toBe(true);

      settleResolver("slack:C-STALE");
      for (let turn = 0; turn < 4; turn += 1) {
        await Promise.resolve();
      }
      expect(responder.respond).not.toHaveBeenCalled();
      expect(results).toHaveLength(1);
    } finally {
      scheduler.stop();
      vi.useRealTimers();
    }
  });

  it("preserves a harness-like failure kind on failed results", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const failure = new Error("No API key for provider: openai-codex") as Error & {
      failure: { kind: string };
    };
    failure.failure = { kind: "provider_unavailable_exhausted" };
    const responder: AgentResponder = {
      async respond() {
        throw failure;
      },
    };
    const results: unknown[] = [];

    const scheduler = startCronAdapter({
      responder,
      jobs: [{ id: "morning", expression: "* * * * *", timezone: "UTC", prompt: "brief" }],
      now: () => new Date(Date.now()),
      onResult: (result) => {
        results.push(result);
      },
    });

    try {
      await vi.advanceTimersByTimeAsync(60_000);
      await expect
        .poll(() => results)
        .toContainEqual(
          expect.objectContaining({
            kind: "failed",
            jobId: "morning",
            error: "No API key for provider: openai-codex",
            failureKind: "provider_unavailable_exhausted",
          }),
        );
    } finally {
      scheduler.stop();
      vi.useRealTimers();
    }
  });

  it("lets a job-specific maxRunMs override the adapter watchdog limit", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const responder: AgentResponder = {
      async respond() {
        await new Promise(() => {});
        return {};
      },
    };
    const results: unknown[] = [];

    const scheduler = startCronAdapter({
      responder,
      jobs: [{ id: "short", expression: "* * * * *", timezone: "UTC", prompt: "x", maxRunMs: 2_000 }],
      now: () => new Date(Date.now()),
      onResult: (result) => {
        results.push(result);
      },
      maxRunMs: 10_000,
    });

    try {
      await vi.advanceTimersByTimeAsync(60_000);
      await vi.advanceTimersByTimeAsync(1_999);
      expect(results.some((r) => (r as { kind?: string }).kind === "failed")).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      const failed = results.find(
        (r): r is { kind: string; error?: string } => (r as { kind?: string }).kind === "failed",
      );
      expect(failed).toBeDefined();
      expect(failed?.error).toMatch(/timed out after 2000ms/u);
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
    const lateText = "  done (ignored abort)\n";
    const responder: AgentResponder = {
      async respond() {
        started += 1;
        // Note: deliberately does NOT honor request.abortSignal; it just waits
        // for the gate and then resolves with text.
        await new Promise<void>((resolve) => {
          gates.push(resolve);
        });
        return { text: lateText, parts: sparseReplyParts(MAX_AGENT_REPLY_PARTS + 3) };
      },
    };
    const results: CronJobResult[] = [];

    const options = {
      responder,
      overlap: "replace" as const,
      jobs: [{ id: "slow", expression: "* * * * *", prompt: "slow work" }],
      now: () => new Date(Date.now()),
      onResult: (result: CronJobResult) => {
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
    await expect.poll(() => gates.length).toBe(1);
    gates[0]!();
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
    const firstTerminal = results.filter((result) =>
      result.scheduledAt === "1970-01-01T00:00:00.000Z"
      && ["succeeded", "failed", "cancelled"].includes(result.kind),
    );
    expect(firstTerminal).toHaveLength(1);
    expect(firstTerminal[0]).toMatchObject({
      kind: "cancelled",
      error: "Cron job cancelled (responder resolved after abort).",
      replyPartOutcomes: expect.arrayContaining([
        expect.objectContaining({ partIndex: 0, partType: "unknown" }),
        expect.objectContaining({ partIndex: 1, partType: "failure", code: "artifact_missing" }),
      ]),
    });
    if (firstTerminal[0]?.kind !== "cancelled") throw new Error("Expected the replaced run to be cancelled.");
    expect(firstTerminal[0]).not.toHaveProperty("text");
    expect(firstTerminal[0].replyPartOutcomes).toHaveLength(MAX_AGENT_REPLY_PARTS);
    expect(firstTerminal[0].replyPartOutcomes?.at(-1)).toMatchObject({ affectedPartCount: 4 });
    expect(JSON.stringify(firstTerminal[0].replyPartOutcomes)).not.toContain("null");
    expect(JSON.stringify(firstTerminal[0])).not.toContain(lateText.trim());

    // Drain the queued (newest) firing and let it complete normally.
    await expect.poll(() => started).toBe(2);
    gates[1]?.();
    await expect
      .poll(() => results)
      .toContainEqual(
        expect.objectContaining({ kind: "succeeded", scheduledAt: "1970-01-01T00:01:00.000Z" }),
      );
  });

  it("overlap:'replace' aborts hung destination resolution without maxRunMs and ignores late settlement", async () => {
    const resolverSignals: AbortSignal[] = [];
    const settleResolvers: Array<(value: string | undefined) => void> = [];
    const resolveNotifyFallbackConversationId = vi.fn((abortSignal?: AbortSignal) => {
      if (abortSignal !== undefined) {
        resolverSignals.push(abortSignal);
      }
      return new Promise<string | undefined>((resolve) => {
        settleResolvers.push(resolve);
      });
    });
    const seenReplyTargets: unknown[] = [];
    const responder: AgentResponder = {
      async respond(request) {
        seenReplyTargets.push(request.replyTo);
        return { text: "done" };
      },
    };
    const results: Array<{ kind: string; scheduledAt?: string; notifyConversationId?: string }> = [];
    const options = {
      responder,
      overlap: "replace" as const,
      jobs: [{ id: "resolve", expression: "* * * * *", prompt: "p", notify: true }],
      now: () => new Date(Date.now()),
      resolveNotifyFallbackConversationId,
      onResult: (result: { kind: string; scheduledAt?: string; notifyConversationId?: string }) => {
        results.push(result);
      },
    };
    const jobStates = new Map();

    handleTick(options.jobs[0]!, new Date(0), options, jobStates);
    await expect.poll(() => resolveNotifyFallbackConversationId.mock.calls.length).toBe(1);
    expect(resolverSignals[0]?.aborted).toBe(false);
    expect(seenReplyTargets).toEqual([]);

    // Replacing the first firing must abort its resolver race and drain the
    // newest firing even though no watchdog is configured.
    handleTick(options.jobs[0]!, new Date(60_000), options, jobStates);
    await expect
      .poll(() => results)
      .toContainEqual(expect.objectContaining({
        kind: "cancelled",
        scheduledAt: "1970-01-01T00:00:00.000Z",
    }));
    expect(resolverSignals[0]?.aborted).toBe(true);
    await expect.poll(() => resolveNotifyFallbackConversationId.mock.calls.length).toBe(2);

    // Settling the discarded resolver later must neither start its responder
    // nor emit a second terminal result for that firing.
    settleResolvers[0]?.("slack:C-STALE");
    for (let turn = 0; turn < 4; turn += 1) {
      await Promise.resolve();
    }
    expect(seenReplyTargets).toEqual([]);
    expect(
      results.filter(
        (result) =>
          result.scheduledAt === "1970-01-01T00:00:00.000Z"
          && ["cancelled", "failed", "succeeded"].includes(result.kind),
      ),
    ).toEqual([expect.objectContaining({ kind: "cancelled" })]);

    settleResolvers[1]?.("slack:C-NEW");
    await expect.poll(() => seenReplyTargets).toEqual([{ conversationId: "slack:C-NEW" }]);
    await expect
      .poll(() => results)
      .toContainEqual(expect.objectContaining({
        kind: "succeeded",
        scheduledAt: "1970-01-01T00:01:00.000Z",
        notifyConversationId: "slack:C-NEW",
      }));
  });

  it("observes a resolver that reentrantly replaces its run before returning a late rejection", async () => {
    const job = { id: "resolve", expression: "* * * * *", prompt: "p", notify: true };
    const jobStates = new Map();
    let rejectDiscardedResolver!: (error: Error) => void;
    const discardedResolver = new Promise<string | undefined>((_resolve, reject) => {
      rejectDiscardedResolver = reject;
    });
    const thenSpy = vi.spyOn(discardedResolver, "then");
    let resolverCallCount = 0;
    let options!: Parameters<typeof handleTick>[2];
    const responder = {
      respond: vi.fn(
        async (_request: Parameters<AgentResponder["respond"]>[0]) => ({ text: "done" }),
      ),
    } satisfies AgentResponder;
    const results: Array<{ kind: string; scheduledAt?: string; notifyConversationId?: string }> = [];
    options = {
      responder,
      overlap: "replace",
      jobs: [job],
      resolveNotifyFallbackConversationId: () => {
        resolverCallCount += 1;
        if (resolverCallCount === 1) {
          // Re-enter replacement before returning the first operation. The
          // resolver race therefore receives an already-aborted signal.
          handleTick(job, new Date(60_000), options, jobStates);
          return discardedResolver;
        }
        return Promise.resolve("slack:C-NEW");
      },
      onResult: (result) => {
        results.push(result);
      },
    };

    handleTick(job, new Date(0), options, jobStates);
    await expect
      .poll(() => results)
      .toContainEqual(expect.objectContaining({
        kind: "cancelled",
        scheduledAt: "1970-01-01T00:00:00.000Z",
      }));
    await expect.poll(() => responder.respond.mock.calls.length).toBe(1);
    expect(thenSpy).toHaveBeenCalledOnce();
    expect(responder.respond.mock.calls[0]?.[0]).toHaveProperty(
      "replyTo.conversationId",
      "slack:C-NEW",
    );
    await expect
      .poll(() => results)
      .toContainEqual(expect.objectContaining({
        kind: "succeeded",
        scheduledAt: "1970-01-01T00:01:00.000Z",
        notifyConversationId: "slack:C-NEW",
      }));
    await expect.poll(() => jobStates.size).toBe(0);

    rejectDiscardedResolver(new Error("late discarded resolver rejection"));
    for (let turn = 0; turn < 4; turn += 1) {
      await Promise.resolve();
    }
    expect(responder.respond).toHaveBeenCalledOnce();
    expect(
      results.filter(
        (result) =>
          result.scheduledAt === "1970-01-01T00:00:00.000Z"
          && ["cancelled", "failed", "succeeded"].includes(result.kind),
      ),
    ).toHaveLength(1);
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

  it("rejects an invalid preflight declaration at startup", () => {
    const responder: AgentResponder = {
      async respond() {
        return {};
      },
    };
    const base = { responder, now: () => new Date(0) };

    expect(() => startCronAdapter({
      ...base,
      jobs: [{ id: "bad", expression: "* * * * *", prompt: "p", preflight: [] }],
    })).toThrow(/preflight/u);
    expect(() => startCronAdapter({
      ...base,
      jobs: [{ id: "bad", expression: "* * * * *", prompt: "p", preflight: ["ok", ""] }],
    })).toThrow(/non-empty argument strings/u);
    expect(() => startCronAdapter({
      ...base,
      jobs: [{ id: "bad", expression: "* * * * *", prompt: "p", preflight: ["gate"], preflightTimeoutMs: 60_001 }],
    })).toThrow(/no greater than 60000/u);
    expect(() => startCronAdapter({
      ...base,
      preflightTimeoutMs: 0,
      jobs: [{ id: "bad", expression: "* * * * *", prompt: "p" }],
    })).toThrow(/preflightTimeoutMs/u);
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

  it("registers effectively-disabled jobs without arming them and can enable them at runtime", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const responder = { respond: vi.fn(async () => ({ text: "done" })) } satisfies AgentResponder;
    const scheduler = startCronAdapter({
      responder,
      jobs: [{ id: "runtime", enabled: false, expression: "* * * * *", prompt: "run" }],
      now: () => new Date(Date.now()),
    });

    try {
      expect(scheduler.jobs).toHaveLength(1);
      expect(scheduler.snapshots()).toEqual([
        expect.objectContaining({ jobId: "runtime", effectiveEnabled: false }),
      ]);
      expect(scheduler.snapshots()[0]).not.toHaveProperty("nextRunAt");
      await vi.advanceTimersByTimeAsync(120_000);
      expect(responder.respond).not.toHaveBeenCalled();

      const enabled = scheduler.setEffectiveEnabled("runtime", true);
      expect(enabled).toEqual(expect.objectContaining({
        effectiveEnabled: true,
        nextRunAt: "1970-01-01T00:03:00.000Z",
      }));
      await vi.advanceTimersByTimeAsync(60_000);
      expect(responder.respond).toHaveBeenCalledOnce();

      const disabled = scheduler.setEffectiveEnabled("runtime", false);
      expect(disabled.effectiveEnabled).toBe(false);
      expect(disabled).not.toHaveProperty("nextRunAt");
      await vi.advanceTimersByTimeAsync(120_000);
      expect(responder.respond).toHaveBeenCalledOnce();
    } finally {
      scheduler.stop();
      vi.useRealTimers();
    }
  });

  it("uses disjoint manual ids and a total per-job order for same-instant overlap", async () => {
    const gates: Array<() => void> = [];
    const results: CronJobResult[] = [];
    const responder: AgentResponder = {
      async respond() {
        await new Promise<void>((resolve) => gates.push(resolve));
        return { text: "done" };
      },
    };
    const now = new Date("2026-08-14T12:00:00.000Z");
    const options = {
      responder,
      jobs: [{ id: "a:b", expression: "* * * * *", prompt: "run" }],
      now: () => now,
      overlap: "skip" as const,
      onResult: (result: CronJobResult) => {
        results.push(result);
      },
    };
    const jobStates = new Map();
    const sequenceByJob = new Map<string, number>();

    const scheduled = handleTick(options.jobs[0]!, now, options, jobStates, sequenceByJob, "scheduled");
    const manual = handleTick(options.jobs[0]!, now, options, jobStates, sequenceByJob, "manual");

    expect(scheduled).toMatchObject({
      runId: "cron:a%3Ab:2026-08-14T12:00:00.000Z",
      orderedAt: "2026-08-14T12:00:00.000Z",
      sequence: 1,
      trigger: "scheduled",
    });
    expect(manual).toMatchObject({
      runId: "cron:a%3Ab:2026-08-14T12:00:00.000Z:m2",
      orderedAt: "2026-08-14T12:00:00.000Z",
      sequence: 2,
      trigger: "manual",
    });
    await expect.poll(() => results).toContainEqual(expect.objectContaining({
      kind: "skipped",
      cronRunId: manual.runId,
      sequence: 2,
      orderedAt: manual.orderedAt,
      blockedByRunId: scheduled.runId,
      blockedByTrigger: "scheduled",
    }));

    await expect.poll(() => gates.length).toBe(1);
    gates[0]!();
    await expect.poll(() => results).toContainEqual(expect.objectContaining({
      kind: "succeeded",
      cronRunId: scheduled.runId,
      sequence: 1,
      orderedAt: scheduled.orderedAt,
    }));
  });

  it("keeps queued and dropped records on the firing's immutable admission order", async () => {
    let finish!: () => void;
    const results: CronJobResult[] = [];
    const responder: AgentResponder = {
      async respond() {
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        return { text: "done" };
      },
    };
    const options = {
      responder,
      jobs: [{ id: "ordered", expression: "* * * * *", prompt: "run" }],
      now: () => new Date("2026-08-14T12:00:02.000Z"),
      overlap: "queue" as const,
      maxQueueDepth: 0,
      overflow: "drop-oldest" as const,
      onResult: (result: CronJobResult) => {
        results.push(result);
      },
    };
    const jobStates = new Map();
    const sequenceByJob = new Map<string, number>();

    handleTick(options.jobs[0]!, new Date("2026-08-14T12:00:00.000Z"), options, jobStates, sequenceByJob);
    const overflowed = handleTick(
      options.jobs[0]!,
      new Date("2026-08-14T12:01:00.000Z"),
      options,
      jobStates,
      sequenceByJob,
    );
    await expect.poll(() => results.filter((result) => result.cronRunId === overflowed.runId)).toEqual([
      expect.objectContaining({
        kind: "dropped",
        orderedAt: "2026-08-14T12:00:02.000Z",
        sequence: 2,
      }),
      expect.objectContaining({
        kind: "queued",
        orderedAt: "2026-08-14T12:00:02.000Z",
        sequence: 2,
      }),
    ]);
    await expect.poll(() => typeof finish).toBe("function");
    finish();
    await expect.poll(() => results.some((result) => result.kind === "succeeded")).toBe(true);
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

  it.each([
    {
      expression: "",
      message: "Cron job expression is required.",
      details: { code: "invalid_config", jobId: "contract" },
    },
    {
      expression: "* * * * * *",
      message: "Cron job expression must use exactly five fields.",
      details: { code: "invalid_config", jobId: "contract", fieldCount: 6 },
    },
    {
      expression: "61 * * * *",
      message: "Cron job expression is invalid.",
      details: {
        code: "invalid_config",
        jobId: "contract",
        reason: expect.stringMatching(/range 0-59/u),
      },
    },
  ])("preserves the scheduler error contract for '$expression'", ({ expression, message, details }) => {
    const responder: AgentResponder = {
      async respond() {
        return {};
      },
    };

    let thrown: unknown;
    try {
      startCronAdapter({
        responder,
        jobs: [{ id: "contract", expression, prompt: "validate me" }],
        now: () => new Date(0),
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(CronAdapterError);
    expect(thrown).toMatchObject({
      code: "invalid_config",
      message,
      details,
    });
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

  it("does not double-fire the same scheduledAt when the timer wakes early (timer coalescing)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    // A mutable clock skew models OS timer coalescing: the fake timer wakes at the
    // scheduled wall-clock instant, but the adapter's now() reads a few ms EARLIER
    // (production showed startedAt 16:29:59.995 for scheduledAt 16:30:00.000).
    let skewMs = 0;
    const now = () => new Date(Date.now() + skewMs);
    let respondCount = 0;
    const gates: Array<() => void> = [];
    const responder: AgentResponder = {
      async respond() {
        respondCount += 1;
        // Gate the run so it stays active across the second (potential duplicate)
        // wake — mirroring how the real run is still in flight when the coalesced
        // duplicate arrives and trips the overlap guard.
        await new Promise<void>((resolve) => {
          gates.push(resolve);
        });
        return { text: "done" };
      },
    };
    const results: Array<{ kind: string; scheduledAt?: string; startedAt?: string }> = [];

    const scheduler = startCronAdapter({
      responder,
      jobs: [{ id: "hb", expression: "* * * * *", prompt: "heartbeat" }],
      now,
      onResult: (result) => {
        results.push(result);
      },
    });

    try {
      // Make now() read 5ms BEFORE scheduledAt when the 00:01:00 timer fires.
      // Old scheduler: dispatches the firing at 00:00:59.995, then the post-fire
      // recompute (now < scheduledAt) returns the SAME 00:01:00 and fires it AGAIN
      // — a duplicate caught by the overlap guard as a spurious kind:"skipped".
      skewMs = -5;
      await vi.advanceTimersByTimeAsync(60_000); // early wake -> re-arm the sliver, do NOT fire
      await vi.advanceTimersByTimeAsync(5); // now() reaches 00:01:00 exactly -> fire once

      expect(respondCount).toBe(1); // responder invoked exactly once
      expect(results.filter((r) => r.kind === "skipped")).toHaveLength(0); // no spurious overlap-skip

      // Let the single run finish and assert the succeeded result did NOT start early.
      gates[0]?.();
      await expect.poll(() => results.filter((r) => r.kind === "succeeded")).toHaveLength(1);
      const succeeded = results.find((r) => r.kind === "succeeded")!;
      expect(succeeded.scheduledAt).toBe("1970-01-01T00:01:00.000Z");
      expect(Date.parse(succeeded.startedAt!)).toBeGreaterThanOrEqual(
        Date.parse(succeeded.scheduledAt!),
      ); // run started at/after scheduledAt (no ms-early startedAt)

      // With the skew cleared, the next minute must fire exactly one more time.
      skewMs = 0;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(respondCount).toBe(2);
      expect(results.filter((r) => r.kind === "skipped")).toHaveLength(0);
    } finally {
      scheduler.stop();
      vi.useRealTimers();
    }
  });
});

describe("Cron adapter — preflight gate", () => {
  it("skips the firing without a responder turn when the gate answers run:false", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const events: string[] = [];
    const results: CronJobResult[] = [];
    const responder = { respond: vi.fn(async () => ({ text: "must not run" })) } satisfies AgentResponder;
    const onRunStarted = vi.fn();
    const onPreflight = vi.fn((firing: { runId: string }, record: { outcome: string }) => {
      events.push(`preflight:${record.outcome}`);
    });
    const scheduler = startCronAdapter({
      responder,
      jobs: [{ id: "gated", expression: "* * * * *", prompt: "p", preflight: ["gate"] }],
      now: () => new Date(Date.now()),
      preflight: async () => ({ outcome: "skip", reason: "nothing new" }),
      onPreflight,
      onRunStarted,
      onResult: (result) => {
        events.push(`result:${result.kind}`);
        results.push(result);
      },
    });

    try {
      await vi.advanceTimersByTimeAsync(60_000);
      await expect.poll(() => results.length).toBe(1);
      expect(results[0]).toMatchObject({
        kind: "skipped",
        reason: "gate",
        jobId: "gated",
        completedAt: "1970-01-01T00:01:00.000Z",
        gateReason: "nothing new",
      });
      expect(responder.respond).not.toHaveBeenCalled();
      expect(onRunStarted).not.toHaveBeenCalled();
      expect(onPreflight).toHaveBeenCalledOnce();
      expect(onPreflight.mock.calls[0]?.[1]).toEqual({
        outcome: "skip",
        reason: "nothing new",
        startedAt: "1970-01-01T00:01:00.000Z",
        completedAt: "1970-01-01T00:01:00.000Z",
      });
      // The record is observed before the skip result is emitted.
      expect(events).toEqual(["preflight:skip", "result:skipped"]);
      // The slot was released, so the next minute fires again and is gated again.
      await vi.advanceTimersByTimeAsync(60_000);
      await expect.poll(() => results.length).toBe(2);
      expect(onPreflight).toHaveBeenCalledTimes(2);
    } finally {
      scheduler.stop();
      vi.useRealTimers();
    }
  });

  it("runs with the composed prompt and metadata when the gate answers run:true with input", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const seen: Array<{ text: string; preflight: unknown }> = [];
    const results: CronJobResult[] = [];
    const responder: AgentResponder = {
      async respond(request) {
        seen.push({
          text: request.text,
          preflight: (request.metadata as { cron?: { preflight?: unknown } }).cron?.preflight,
        });
        return { text: "done" };
      },
    };
    const scheduler = startCronAdapter({
      responder,
      jobs: [{ id: "gated", expression: "* * * * *", prompt: "Summarize.", preflight: ["gate"] }],
      now: () => new Date(Date.now()),
      preflight: async () => ({ outcome: "run", input: "3 new items" }),
      onResult: (result) => {
        results.push(result);
      },
    });

    try {
      await vi.advanceTimersByTimeAsync(60_000);
      await expect.poll(() => results.length).toBe(1);
      expect(seen).toEqual([{
        text: "Summarize.\n\n<preflight-input>\n3 new items\n</preflight-input>",
        preflight: { outcome: "run", inputBytes: 11 },
      }]);
      expect(results[0]).toMatchObject({ kind: "succeeded" });
    } finally {
      scheduler.stop();
      vi.useRealTimers();
    }
  });

  it("leaves an ungated firing byte-for-byte unchanged", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const requests: Array<{ text: string; cron: Record<string, unknown> }> = [];
    const responder: AgentResponder = {
      async respond(request) {
        requests.push({ text: request.text, cron: (request.metadata as { cron: Record<string, unknown> }).cron });
        return {};
      },
    };
    const scheduler = startCronAdapter({
      responder,
      jobs: [{ id: "plain", expression: "* * * * *", prompt: "exact prompt text" }],
      now: () => new Date(Date.now()),
      preflight: async () => ({ outcome: "run", input: "never used" }),
    });

    try {
      await vi.advanceTimersByTimeAsync(60_000);
      await expect.poll(() => requests.length).toBe(1);
      expect(requests[0]?.text).toBe("exact prompt text");
      expect(requests[0]?.cron).not.toHaveProperty("preflight");
    } finally {
      scheduler.stop();
      vi.useRealTimers();
    }
  });

  it("does not consume maxRunMs while the gate is evaluating", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const results: CronJobResult[] = [];
    const responder = { respond: vi.fn(async () => ({ text: "ok" })) } satisfies AgentResponder;
    let settleGate: (() => void) | undefined;
    const scheduler = startCronAdapter({
      responder,
      jobs: [{ id: "slow-gate", expression: "* * * * *", prompt: "p", preflight: ["gate"] }],
      now: () => new Date(Date.now()),
      maxRunMs: 5_000,
      preflight: async () => {
        await new Promise<void>((resolve) => {
          settleGate = resolve;
        });
        return { outcome: "run" };
      },
      onResult: (result) => {
        results.push(result);
      },
    });

    try {
      await vi.advanceTimersByTimeAsync(60_000);
      expect(responder.respond).not.toHaveBeenCalled();
      // 4s of gate time must not arm the run watchdog.
      await vi.advanceTimersByTimeAsync(4_000);
      settleGate?.();
      await expect.poll(() => results.length).toBe(1);
      expect(results[0]).toMatchObject({ kind: "succeeded" });
      // The run itself is still watchdogged from its own start.
      expect(responder.respond).toHaveBeenCalledOnce();
    } finally {
      scheduler.stop();
      vi.useRealTimers();
    }
  });

  it("fails open with the plain prompt when the gate exceeds the adapter timeout, once", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const records: Array<Record<string, unknown>> = [];
    const seen: string[] = [];
    const results: CronJobResult[] = [];
    let settleGate: (() => void) | undefined;
    const responder: AgentResponder = {
      async respond(request) {
        seen.push(request.text);
        return {};
      },
    };
    const scheduler = startCronAdapter({
      responder,
      jobs: [{ id: "hung-gate", expression: "* * * * *", prompt: "plain", preflight: ["gate"], preflightTimeoutMs: 1_000 }],
      now: () => new Date(Date.now()),
      preflight: async () => {
        await new Promise<void>((resolve) => {
          settleGate = resolve;
        });
        return { outcome: "skip" };
      },
      onPreflight: (_firing, record) => {
        records.push({ ...record });
      },
      onResult: (result) => {
        results.push(result);
      },
    });

    try {
      await vi.advanceTimersByTimeAsync(60_000);
      await vi.advanceTimersByTimeAsync(1_000); // adapter race timeout wins
      await expect.poll(() => results.length).toBe(1);
      expect(seen).toEqual(["plain"]);
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({ outcome: "timeout" });
      expect(records[0]).not.toHaveProperty("code");
      // The late skip verdict must be ignored: no second record, no second run.
      settleGate?.();
      await vi.advanceTimersByTimeAsync(0);
      expect(records).toHaveLength(1);
      expect(seen).toEqual(["plain"]);
      expect(results.filter((result) => result.kind === "skipped")).toHaveLength(0);
    } finally {
      scheduler.stop();
      vi.useRealTimers();
    }
  });

  it("records an error verdict and runs with the plain prompt", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const records: Array<Record<string, unknown>> = [];
    const seen: string[] = [];
    const responder: AgentResponder = {
      async respond(request) {
        seen.push(request.text);
        return {};
      },
    };
    const scheduler = startCronAdapter({
      responder,
      jobs: [{ id: "err-gate", expression: "* * * * *", prompt: "plain", preflight: ["gate"] }],
      now: () => new Date(Date.now()),
      preflight: async () => ({ outcome: "error", code: "exit_nonzero", reason: "gate exited with code 3" }),
      onPreflight: (_firing, record) => {
        records.push({ ...record });
      },
    });

    try {
      await vi.advanceTimersByTimeAsync(60_000);
      await expect.poll(() => seen.length).toBe(1);
      expect(seen).toEqual(["plain"]);
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({ outcome: "error", code: "exit_nonzero", reason: "gate exited with code 3" });
    } finally {
      scheduler.stop();
      vi.useRealTimers();
    }
  });

  it("fails open when the host callback rejects or returns an invalid verdict", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const records: Array<Record<string, unknown>> = [];
    const seen: string[] = [];
    const responder: AgentResponder = {
      async respond(request) {
        seen.push(request.text);
        return {};
      },
    };
    const scheduler = startCronAdapter({
      responder,
      // A deliberately off-contract host callback (untyped JS caller).
      preflight: (async () => ({ outcome: "maybe", input: 42 })) as unknown as () => Promise<{ outcome: "run" }>,
      jobs: [{ id: "bad-gate", expression: "* * * * *", prompt: "plain", preflight: ["gate"] }],
      now: () => new Date(Date.now()),
      onPreflight: (_firing, record) => {
        records.push({ ...record });
      },
    });

    try {
      await vi.advanceTimersByTimeAsync(60_000);
      await expect.poll(() => seen.length).toBe(1);
      expect(seen).toEqual(["plain"]);
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({ outcome: "error", code: "invalid_verdict" });
    } finally {
      scheduler.stop();
      vi.useRealTimers();
    }
  });

  it("still runs when a job declares a preflight but the host wires no executor", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const warn = vi.fn();
    const seen: string[] = [];
    const responder: AgentResponder = {
      async respond(request) {
        seen.push(request.text);
        return {};
      },
    };
    const scheduler = startCronAdapter({
      responder,
      jobs: [{ id: "no-executor", expression: "* * * * *", prompt: "plain", preflight: ["gate"] }],
      now: () => new Date(Date.now()),
      logger: { warn },
    });

    try {
      await vi.advanceTimersByTimeAsync(60_000);
      await expect.poll(() => seen.length).toBe(1);
      expect(seen).toEqual(["plain"]);
      expect(warn).toHaveBeenCalledWith(
        "Cron job declares a preflight but the host has no preflight executor; running with the plain prompt.",
        { jobId: "no-executor", runId: "cron:no-executor:1970-01-01T00:01:00.000Z" },
      );
    } finally {
      scheduler.stop();
      vi.useRealTimers();
    }
  });

  it("lets a manual firing override run:false and keeps the gate input", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const records: Array<Record<string, unknown>> = [];
    const seen: string[] = [];
    const results: CronJobResult[] = [];
    const responder: AgentResponder = {
      async respond(request) {
        seen.push(request.text);
        return {};
      },
    };
    const scheduler = startCronAdapter({
      responder,
      jobs: [{ id: "manual-gate", expression: "0 0 1 1 *", prompt: "p", preflight: ["gate"] }],
      now: () => new Date(Date.now()),
      preflight: async () => ({ outcome: "skip", input: "override me", reason: "nothing new" }),
      onPreflight: (_firing, record) => {
        records.push({ ...record });
      },
      onResult: (result) => {
        results.push(result);
      },
    });

    try {
      scheduler.runNow("manual-gate");
      await expect.poll(() => seen.length).toBe(1);
      expect(seen).toEqual(["p\n\n<preflight-input>\noverride me\n</preflight-input>"]);
      await expect.poll(() => results.length).toBe(1);
      expect(results[0]).toMatchObject({ kind: "succeeded", trigger: "manual" });
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({ outcome: "overridden", reason: "nothing new", inputBytes: 11 });
    } finally {
      scheduler.stop();
      vi.useRealTimers();
    }
  });

  it("blocks a firing that arrives during the gate as an overlap skip by the gating firing", async () => {
    // Driven through handleTick so a second firing can land strictly inside the
    // gate phase: the gating firing holds the job's overlap slot throughout.
    const job: CronJob = {
      id: "held",
      expression: "* * * * *",
      prompt: "p",
      preflight: ["gate"],
      preflightTimeoutMs: 60_000,
    };
    const jobStates = new Map();
    const results: CronJobResult[] = [];
    const gates: string[] = [];
    let settleGate: (() => void) | undefined;
    const options: CronAdapterOptions = {
      responder: { async respond() { return {}; } },
      jobs: [job],
      now: () => new Date(Date.now()),
      preflight: async (firing) => {
        gates.push(firing.runId);
        await new Promise<void>((resolve) => {
          settleGate = resolve;
        });
        return { outcome: "skip" };
      },
      onResult: (result) => {
        results.push(result);
      },
    };

    handleTick(job, new Date(60_000), options, jobStates);
    await expect.poll(() => gates.length).toBe(1);
    handleTick(job, new Date(120_000), options, jobStates);
    await expect.poll(() => results.length).toBe(1);
    expect(results[0]).toMatchObject({
      kind: "skipped",
      reason: "overlap",
      cronRunId: "cron:held:1970-01-01T00:02:00.000Z",
      blockedByRunId: gates[0],
      blockedByTrigger: "scheduled",
    });
    // The gating firing was never displaced: it still owns the slot and ends
    // with its own gate verdict.
    settleGate?.();
    await expect.poll(() => results.length).toBe(2);
    expect(results[1]).toMatchObject({ kind: "skipped", reason: "gate" });
    expect(gates).toEqual(["cron:held:1970-01-01T00:01:00.000Z"]);
  });

  it("cancels a firing stopped during the gate without a startedAt and never launches it", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const results: CronJobResult[] = [];
    const records: Array<Record<string, unknown>> = [];
    let settleGate: (() => void) | undefined;
    const responder = { respond: vi.fn(async () => ({})) } satisfies AgentResponder;
    const scheduler = startCronAdapter({
      responder,
      jobs: [{ id: "stopped", expression: "* * * * *", prompt: "p", preflight: ["gate"] }],
      now: () => new Date(Date.now()),
      preflight: async () => {
        await new Promise<void>((resolve) => {
          settleGate = resolve;
        });
        return { outcome: "run", input: "late" };
      },
      onPreflight: (_firing, record) => {
        records.push({ ...record });
      },
      onResult: (result) => {
        results.push(result);
      },
    });

    try {
      await vi.advanceTimersByTimeAsync(60_000);
      scheduler.stop();
      await expect.poll(() => results.length).toBe(1);
      expect(results[0]).toMatchObject({
        kind: "cancelled",
        completedAt: "1970-01-01T00:01:00.000Z",
      });
      expect(results[0]).not.toHaveProperty("startedAt");
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({ outcome: "cancelled" });
      settleGate?.();
      await vi.advanceTimersByTimeAsync(0);
      expect(responder.respond).not.toHaveBeenCalled();
      expect(records).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gates every queued firing drained after the gating run", async () => {
    const job: CronJob = {
      id: "queued",
      expression: "* * * * *",
      prompt: "p",
      preflight: ["gate"],
      preflightTimeoutMs: 60_000,
    };
    const jobStates = new Map();
    const results: CronJobResult[] = [];
    const gates: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const options: CronAdapterOptions = {
      responder: { async respond() { return {}; } },
      jobs: [job],
      overlap: "queue",
      now: () => new Date(Date.now()),
      preflight: async (firing) => {
        gates.push(firing.runId);
        if (gates.length === 1) {
          await new Promise<void>((resolve) => {
            releaseFirst = resolve;
          });
        }
        return { outcome: "skip" };
      },
      onResult: (result) => {
        results.push(result);
      },
    };

    handleTick(job, new Date(60_000), options, jobStates);
    await expect.poll(() => gates.length).toBe(1);
    handleTick(job, new Date(120_000), options, jobStates);
    handleTick(job, new Date(180_000), options, jobStates);
    await expect.poll(() => results.length).toBe(2);
    expect(results).toEqual([
      expect.objectContaining({ kind: "queued", cronRunId: "cron:queued:1970-01-01T00:02:00.000Z", queueDepth: 1 }),
      expect.objectContaining({ kind: "queued", cronRunId: "cron:queued:1970-01-01T00:03:00.000Z", queueDepth: 2 }),
    ]);

    releaseFirst?.();
    await expect.poll(() => gates.length).toBe(3);
    expect(gates).toEqual([
      "cron:queued:1970-01-01T00:01:00.000Z",
      "cron:queued:1970-01-01T00:02:00.000Z",
      "cron:queued:1970-01-01T00:03:00.000Z",
    ]);
    await expect.poll(() => results.filter((result) => result.kind === "skipped").length).toBe(3);
    expect(results.filter((result) => result.kind === "skipped").map((result) => result.cronRunId)).toEqual([
      "cron:queued:1970-01-01T00:01:00.000Z",
      "cron:queued:1970-01-01T00:02:00.000Z",
      "cron:queued:1970-01-01T00:03:00.000Z",
    ]);
  });

  it("cancels the gate on overlap replace and gates the replacement firing", async () => {
    const job: CronJob = {
      id: "replaced",
      expression: "* * * * *",
      prompt: "p",
      preflight: ["gate"],
      preflightTimeoutMs: 60_000,
    };
    const jobStates = new Map();
    const records: Array<{ runId: string; outcome: string }> = [];
    const gates: string[] = [];
    const seenTexts: string[] = [];
    const optionJobs = [job];
    let releaseFirst: (() => void) | undefined;
    const responder: AgentResponder = {
      async respond(request) {
        seenTexts.push(request.text);
        return {};
      },
    };
    const options: CronAdapterOptions = {
      responder,
      jobs: optionJobs,
      overlap: "replace",
      now: () => new Date(Date.now()),
      preflight: async (firing) => {
        gates.push(firing.runId);
        if (gates.length === 1) {
          await new Promise<void>((resolve) => {
            releaseFirst = resolve;
          });
        }
        return { outcome: "run", input: `input-for-${firing.runId}` };
      },
      onPreflight: (firing: CronFiringIdentity, record: CronPreflightRecord) => {
        records.push({ runId: firing.runId, outcome: record.outcome });
      },
    };

    handleTick(job, new Date(60_000), options, jobStates);
    await expect.poll(() => gates.length).toBe(1);
    handleTick(job, new Date(120_000), options, jobStates);
    await expect.poll(() => gates.length).toBe(2);
    expect(gates).toEqual([
      "cron:replaced:1970-01-01T00:01:00.000Z",
      "cron:replaced:1970-01-01T00:02:00.000Z",
    ]);
    expect(records).toContainEqual({ runId: "cron:replaced:1970-01-01T00:01:00.000Z", outcome: "cancelled" });
    await expect.poll(() => seenTexts.length).toBe(1);
    // Only the replacement firing reaches the responder, with its own gate input.
    expect(seenTexts).toEqual([
      "p\n\n<preflight-input>\ninput-for-cron:replaced:1970-01-01T00:02:00.000Z\n</preflight-input>",
    ]);
    // A late verdict from the cancelled gate must be ignored.
    releaseFirst?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(seenTexts).toHaveLength(1);
    expect(records.filter((record) => record.runId === "cron:replaced:1970-01-01T00:01:00.000Z")).toHaveLength(1);
  });
});
