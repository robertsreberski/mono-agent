import { describe, expect, it, vi } from "vitest";

import { AdvisorCancellationError } from "../cancellation.js";
import { loadAdvisorConfig } from "../config.js";
import { AdvisorContinuityCache } from "../continuity.js";
import { executeReviewIteration } from "../execution.js";
import { continuityIdForSessionKey } from "../protocol.js";
import type { AdvisorRunFactory, AdvisorRunResult, AdvisorStopReason } from "../run.js";

const input = {
  session_key: "private-session-key",
  intent: "Review the change.",
  patch: "patch",
};

async function config(maxRunMs: number) {
  return await loadAdvisorConfig({
    env: {
      MONO_AGENT_ADVISOR_ENABLED: "true",
      MONO_AGENT_ADVISOR_MODEL: "claude:claude-opus-test",
      MONO_AGENT_ADVISOR_EFFORT: "high",
      MONO_AGENT_ADVISOR_MAX_RUN_MS: String(maxRunMs),
    },
    json: {},
  });
}

function cancellableRun() {
  let rejectResult: (error: Error) => void = () => {};
  const result = new Promise<AdvisorRunResult>((_resolve, reject) => {
    rejectResult = reject;
  });
  const order: string[] = [];
  const stop = vi.fn(async (reason: AdvisorStopReason) => {
    order.push(`stop:${reason}`);
    rejectResult(new Error("stopped"));
  });
  const drain = vi.fn(async () => {
    order.push("drain");
    await result.catch(() => undefined);
  });
  const factory: AdvisorRunFactory = {
    async start() {
      return { result, stop, drain };
    },
  };
  return { factory, stop, drain, order };
}

describe("advisor cancellation", () => {
  it("returns a deterministic timeout after exactly one stop and ordered drain", async () => {
    const run = cancellableRun();
    const response = await executeReviewIteration({
      input,
      config: await config(5),
      runFactory: run.factory,
      abortSignal: new AbortController().signal,
    });
    expect(response).toMatchObject({ status: "timed_out", code: "advisor_timeout" });
    expect(run.stop).toHaveBeenCalledTimes(1);
    expect(run.stop).toHaveBeenCalledWith("timeout");
    expect(run.drain).toHaveBeenCalledTimes(1);
    expect(run.order).toEqual(["stop:timeout", "drain"]);
  });

  it.each([
    ["client_disconnected", "advisor_cancelled"],
    ["request_aborted", "advisor_cancelled"],
  ] as const)("maps %s without exposing the internal cancellation reason", async (reason, code) => {
    const run = cancellableRun();
    const controller = new AbortController();
    const pending = executeReviewIteration({
      input,
      config: await config(0),
      runFactory: run.factory,
      abortSignal: controller.signal,
    });
    controller.abort(new AdvisorCancellationError(reason));
    const response = await pending;
    expect(response).toMatchObject({ status: "cancelled", code });
    expect(run.stop).toHaveBeenCalledWith(reason);
    expect(JSON.stringify(response)).not.toContain(reason);
  });

  it("lets the first cancellation cause win and cleans up exactly once", async () => {
    const run = cancellableRun();
    const client = new AbortController();
    const shutdown = new AbortController();
    const pending = executeReviewIteration({
      input,
      config: await config(10),
      runFactory: run.factory,
      abortSignal: client.signal,
      shutdownSignal: shutdown.signal,
    });
    shutdown.abort();
    client.abort(new AdvisorCancellationError("client_disconnected"));
    const response = await pending;
    expect(response).toMatchObject({ status: "cancelled", code: "advisor_shutdown" });
    expect(run.stop).toHaveBeenCalledTimes(1);
    expect(run.stop).toHaveBeenCalledWith("server_shutdown");
    expect(run.drain).toHaveBeenCalledTimes(1);
  });

  it("reports cleanup failure but still attempts the ordered drain", async () => {
    const result = new Promise<AdvisorRunResult>(() => {});
    const stop = vi.fn(async () => {
      throw new Error("raw stop failure");
    });
    const drain = vi.fn(async () => {});
    const controller = new AbortController();
    const pending = executeReviewIteration({
      input,
      config: await config(0),
      runFactory: { async start() { return { result, stop, drain }; } },
      abortSignal: controller.signal,
    });
    controller.abort();
    const response = await pending;
    expect(response).toMatchObject({ code: "advisor_cleanup_failed" });
    expect(stop).toHaveBeenCalledTimes(1);
    expect(drain).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(response)).not.toContain("raw stop failure");
  });

  it("does not start a run when the request was already cancelled", async () => {
    const controller = new AbortController();
    controller.abort(new AdvisorCancellationError("request_aborted"));
    const factory: AdvisorRunFactory = { start: vi.fn() };
    const response = await executeReviewIteration({
      input,
      config: await config(0),
      runFactory: factory,
      abortSignal: controller.signal,
    });
    expect(response.code).toBe("advisor_cancelled");
    expect(factory.start).not.toHaveBeenCalled();
  });

  it("does not stop a completed run and drains it once", async () => {
    const stop = vi.fn(async () => {});
    const drain = vi.fn(async () => {});
    const response = await executeReviewIteration({
      input,
      config: await config(5),
      runFactory: {
        async start() {
          return { result: Promise.resolve({ text: "review" }), stop, drain };
        },
      },
      abortSignal: new AbortController().signal,
    });
    expect(response.code).toBe("ok");
    expect(stop).not.toHaveBeenCalled();
    expect(drain).toHaveBeenCalledTimes(1);
  });
});

describe("advisor continuity cache", () => {
  it("uses normalized hashes and retains metadata only", () => {
    let now = 1_000;
    const cache = new AdvisorContinuityCache({ maxSessions: 2, ttlMs: 100, now: () => now });
    const first = cache.touch("  shared\tkey ");
    now += 10;
    const second = cache.touch("shared key");
    expect(first.continuityId).toBe(continuityIdForSessionKey("shared key"));
    expect(second).toEqual({ ...first, lastUsedAt: 1_010, callCount: 2 });
    const serialized = JSON.stringify(cache.snapshot());
    expect(serialized).not.toMatch(/shared|private|patch|prompt|token|secret/u);
    expect(Object.keys(cache.snapshot()[0] ?? {}).sort()).toEqual([
      "callCount",
      "continuityId",
      "createdAt",
      "lastUsedAt",
    ]);
  });

  it("evicts least-recently-used metadata and expires entries at the TTL", () => {
    let now = 0;
    const cache = new AdvisorContinuityCache({ maxSessions: 2, ttlMs: 100, now: () => now });
    const a = cache.touch("a").continuityId;
    now = 10;
    const b = cache.touch("b").continuityId;
    now = 20;
    cache.touch("a");
    now = 30;
    const c = cache.touch("c").continuityId;
    expect(cache.get(a)).toBeDefined();
    expect(cache.get(b)).toBeUndefined();
    expect(cache.get(c)).toBeDefined();
    now = 130;
    expect(cache.snapshot()).toEqual([]);
  });
});
