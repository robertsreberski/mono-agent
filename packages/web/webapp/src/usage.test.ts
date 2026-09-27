import { describe, expect, it } from "vitest";
import { thread } from "./test/fixtures";
import type { MessagePart, RunStatus, ThreadDetail, WebMessage } from "./types";
import { contextLevel, conversationConsoleUsage, windowUsage } from "./usage";

const message = (
  id: string,
  parts: readonly MessagePart[],
  status: WebMessage["status"] = "complete",
): WebMessage => ({
  id,
  threadId: "thread",
  role: "assistant",
  parts,
  attachments: [],
  createdAt: "2026-07-17T10:00:00.000Z",
  updatedAt: "2026-07-17T10:00:00.000Z",
  status,
});

const detail = (
  messages: readonly WebMessage[],
  runStatus: RunStatus = "complete",
): ThreadDetail => ({
  thread: thread("thread", "agent", { runState: { status: runStatus } }),
  messages,
});

const contextPart = (
  total: number,
  options: { readonly model?: string; readonly timestamp?: number; readonly contextWindow?: number } = {},
): MessagePart => ({
  type: "telemetry",
  event: "runtime_telemetry",
  data: {
    type: "runtime_telemetry",
    kind: "context_usage",
    data: {
      ...(options.model === undefined ? {} : { model: options.model }),
      ...(options.timestamp === undefined ? {} : { timestamp: options.timestamp }),
      ...(options.contextWindow === undefined ? {} : { contextWindow: options.contextWindow }),
      tokens: { total },
    },
  },
});

const compactionPart = (
  status: "running" | "succeeded" | "skipped" | "failed",
  timestamp: number,
): MessagePart => ({
  type: "telemetry",
  event: "runtime_telemetry",
  data: {
    type: "runtime_telemetry",
    kind: "context_compaction",
    data: { operationId: "compact-1", status, timestamp },
  },
});

describe("conversationConsoleUsage", () => {
  it("returns null only while no conversation detail is selected", () => {
    expect(conversationConsoleUsage(null)).toBeNull();
    expect(conversationConsoleUsage(detail([message("one", [
      { type: "telemetry", event: "provider_status", data: { kind: "request_completed" } },
    ])]))).toEqual({
      context: {
        status: "unavailable",
        reason: "Exact context usage has not been reported for this conversation.",
      },
    });
  });

  it("keeps exact current context separate from aggregate last-turn work", () => {
    expect(conversationConsoleUsage(detail([message("one", [
      {
        type: "telemetry",
        event: "usage_update",
        data: {
          model: "pi:openai-codex:gpt-5.5",
          cumulativeUsd: 0.0123,
          tokens: { input: 1200, output: 345, cacheRead: 800, cacheCreation: 12, reasoning: 90 },
        },
      },
      {
        type: "telemetry",
        event: "runtime_telemetry",
        data: {
          kind: "context_usage",
          data: {
            model: "pi:openai-codex:gpt-5.5",
            contextWindow: 372_000,
            tokens: { input: 100, output: 20, cacheRead: 900, cacheCreation: 5, total: 1_025 },
          },
        },
      },
    ])]), { selectedModel: "pi:openai-codex:gpt-5.5" })).toEqual({
      context: {
        status: "current",
        usage: {
          input: 100,
          cachedInput: 900,
          cacheCreation: 5,
          cacheHitRatio: 900 / 1005,
          output: 20,
          total: 1_025,
          contextWindow: 372_000,
          model: "pi:openai-codex:gpt-5.5",
        },
        measuredModel: "pi:openai-codex:gpt-5.5",
      },
    });
  });

  it("accepts ACP's exact used/window snapshot without treating it as aggregate token work", () => {
    expect(conversationConsoleUsage(detail([message("acp", [{
      type: "telemetry",
      event: "runtime_telemetry",
      data: {
        type: "runtime_telemetry",
        kind: "context_usage",
        data: {
          model: "acp:trusted:assistant",
          source: "acp",
          context: { used: 48_000, window: 128_000 },
          cost: { amount: 0.02, currency: "USD" },
        },
      },
    }])]), { selectedModel: "acp:trusted:assistant" })).toEqual({
      context: {
        status: "current",
        usage: {
          total: 48_000,
          contextWindow: 128_000,
          model: "acp:trusted:assistant",
        },
        measuredModel: "acp:trusted:assistant",
      },
    });
  });

  it("never adds durable-history size or aggregate billing usage to an exact snapshot", () => {
    expect(conversationConsoleUsage(detail([message("history", [
      {
        type: "telemetry",
        event: "usage_update",
        data: { tokens: { input: 900_000, output: 20_000 } },
      },
      {
        type: "telemetry",
        event: "runtime_telemetry",
        data: {
          type: "runtime_telemetry",
          kind: "context_usage",
          data: {
            contextWindow: 128_000,
            tokens: { total: 12_500 },
            durableToolHistory: { retainedBytes: 256 * 1024 * 1024 },
          },
        },
      },
    ])]))).toEqual({
      context: {
        status: "current",
        usage: { total: 12_500, contextWindow: 128_000 },
      },
    });
  });

  it("lets a post-compaction provider snapshot become current and decrease", () => {
    expect(conversationConsoleUsage(detail([
      message("first", [contextPart(90_000, { timestamp: 100, contextWindow: 100_000 })]),
      message("second", [
        compactionPart("succeeded", 200),
        contextPart(20_000, { timestamp: 300, contextWindow: 100_000 }),
      ]),
    ]))).toEqual({
      context: {
        status: "current",
        usage: { total: 20_000, contextWindow: 100_000 },
      },
    });
  });

  it("suppresses a pre-compaction number until a newer exact measurement arrives", () => {
    expect(conversationConsoleUsage(detail([
      message("first", [contextPart(90_000, { timestamp: 100, contextWindow: 100_000 })]),
      // The store updates the compaction row in its original position. Its
      // terminal timestamp must still invalidate a snapshot appended while the
      // operation was running, even though that snapshot follows it in parts.
      message("second", [
        compactionPart("succeeded", 200),
        contextPart(70_000, { timestamp: 150, contextWindow: 100_000 }),
      ]),
    ]))).toEqual({
      context: {
        status: "awaiting_measurement",
        compaction: { running: false },
        reason: "Compaction changed the context. It's measured again on the next turn.",
      },
    });
  });

  it("keeps the prior exact measurement when compaction is skipped or fails", () => {
    for (const status of ["skipped", "failed"] as const) {
      expect(conversationConsoleUsage(detail([
        message("first", [contextPart(90_000, { timestamp: 100 })]),
        message("second", [compactionPart(status, 200)]),
      ]))?.context).toEqual({ status: "current", usage: { total: 90_000 } });
    }
  });

  it("labels a running turn's latest exact snapshot as updating", () => {
    expect(conversationConsoleUsage(detail([
      message("running", [contextPart(42_000, { model: "pi:p:m", timestamp: 100 })], "running"),
    ], "running"), { selectedModel: "pi:p:m" })?.context).toEqual({
      status: "updating",
      usage: { total: 42_000, model: "pi:p:m" },
      measuredModel: "pi:p:m",
      reason: "The provider measurement is exact, but the current turn is still updating context.",
    });
  });

  it("shows updating without inventing a number before the first running-turn snapshot", () => {
    expect(conversationConsoleUsage(detail([
      message("running", [{ type: "reasoning", text: "Working" }], "running"),
    ], "running"))?.context).toEqual({
      status: "updating",
      reason: "The current turn has not reported an exact provider measurement yet.",
    });
  });

  it("ignores a failed turn's snapshots and falls back to the last committed measurement", () => {
    expect(conversationConsoleUsage(detail([
      message("complete", [contextPart(30_000, { model: "pi:p:m", timestamp: 100 })]),
      message("failed", [contextPart(99_000, { model: "pi:p:m", timestamp: 200 })], "failed"),
    ], "failed"), { selectedModel: "pi:p:m" })?.context).toEqual({
      status: "last_measured",
      usage: { total: 30_000, model: "pi:p:m" },
      measuredModel: "pi:p:m",
      lastTurnFailed: true,
      reason: "The latest turn did not complete, so this is the last successful provider measurement.",
    });
  });

  it("labels an exact snapshot for a different next model as last measured", () => {
    expect(conversationConsoleUsage(detail([
      message("complete", [contextPart(30_000, { model: "pi:p:old", timestamp: 100 })]),
    ]), { selectedModel: "pi:p:new" })?.context).toEqual({
      status: "last_measured",
      usage: { total: 30_000, model: "pi:p:old" },
      measuredModel: "pi:p:old",
      nextModel: "pi:p:new",
      reason: "This measurement belongs to pi:p:old; the next turn is set to pi:p:new.",
    });
  });

  it("states explicitly when direct Claude cannot provide a measurement", () => {
    expect(conversationConsoleUsage(detail([]), { selectedModel: "claude:sonnet" })?.context).toEqual({
      status: "unavailable",
      noContextRuntime: "claude",
      reason: "This Claude runtime does not expose exact context measurements.",
    });
  });


});

describe("redesigned usage projections", () => {
  it("projects the compaction estimate until a newer exact measurement", () => {
    const estimate = { type: "telemetry", event: "runtime_telemetry", data: {
      kind: "context_compaction", data: { status: "succeeded", timestamp: 200,
        tokensBefore: 90_000, tokensAfter: 20_000, tokenCountsExact: false },
    } } as MessagePart;
    expect(conversationConsoleUsage(detail([
      message("first", [contextPart(90_000, { timestamp: 100, contextWindow: 100_000 })]),
      message("second", [estimate]),
    ]))?.context).toMatchObject({ status: "awaiting_measurement",
      usage: { total: 20_000, contextWindow: 100_000 },
      compaction: { tokensBefore: 90_000, tokensAfter: 20_000, tokenCountsExact: false, running: false },
    });
    expect(conversationConsoleUsage(detail([
      message("first", [contextPart(90_000, { timestamp: 100, contextWindow: 100_000 })]),
      message("second", [{ type: "telemetry", event: "runtime_telemetry", data: {
        kind: "context_compaction", data: { status: "running", timestamp: 200 },
      } }]),
    ]))?.context).toMatchObject({ status: "awaiting_measurement", usage: { total: 90_000, contextWindow: 100_000 }, compaction: { running: true } });
  });
  it("keeps unrounded thresholds and marks loaded-window fallbacks partial", () => {
    expect([79.9, 80, 94.9, 95].map(contextLevel)).toEqual(["normal", "warning", "warning", "danger"]);
    const sample = { ...detail([message("first", [{ type: "telemetry", event: "usage_update",
      data: { cumulativeUsd: 0, tokens: { input: 1, output: 2 } } }])]), messagesNextCursor: "older" };
    expect(windowUsage(sample).total).toMatchObject({ tokensPartial: true, costPartial: true, costUsd: 0 });
    expect(windowUsage(sample)).not.toHaveProperty("settledAssistantTurns");
    expect(windowUsage({ ...sample, messagesNextCursor: undefined })).toHaveProperty("settledAssistantTurns");
  });
});
