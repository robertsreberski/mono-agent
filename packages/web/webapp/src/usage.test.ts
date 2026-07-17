import { describe, expect, it } from "vitest";
import { thread } from "./test/fixtures";
import type { MessagePart, ThreadDetail, WebMessage } from "./types";
import { conversationConsoleUsage } from "./usage";

const message = (id: string, parts: readonly MessagePart[]): WebMessage => ({
  id,
  threadId: "thread",
  role: "assistant",
  parts,
  attachments: [],
  createdAt: "2026-07-17T10:00:00.000Z",
  updatedAt: "2026-07-17T10:00:00.000Z",
  status: "complete",
});

const detail = (...messages: readonly WebMessage[]): ThreadDetail => ({
  thread: thread("thread", "agent"),
  messages,
});

describe("conversationConsoleUsage", () => {
  it("returns null when no usage or cost telemetry exists", () => {
    expect(conversationConsoleUsage(null)).toBeNull();
    expect(conversationConsoleUsage(detail(message("one", [
      { type: "telemetry", event: "provider_status", data: { kind: "request_completed" } },
    ])))).toBeNull();
  });

  it("normalizes the current camel-case usage_update payload without deriving totals", () => {
    expect(conversationConsoleUsage(detail(message("one", [
      {
        type: "telemetry",
        event: "usage_update",
        data: {
          type: "usage_update",
          model: "pi:openai-codex:gpt-5.5",
          cumulativeUsd: 0.0123,
          tokens: {
            input: 1200,
            output: 345,
            cacheRead: 800,
            cacheCreation: 12,
            reasoningTokens: 90,
          },
        },
      },
    ])))).toEqual({
      input: 1200,
      cachedInput: 800,
      cacheCreation: 12,
      output: 345,
      reasoning: 90,
      cost: 0.0123,
      model: "pi:openai-codex:gpt-5.5",
    });
  });

  it("reads snake-case metrics from nested normalized runtime telemetry", () => {
    expect(conversationConsoleUsage(detail(message("one", [
      {
        type: "telemetry",
        event: "runtime_telemetry",
        data: {
          kind: "token_usage",
          model_id: "fallback/model",
          data: {
            cost_usd: 0.2,
            tokens: {
              input_tokens: 100,
              cached_input_tokens: 80,
              cache_creation_tokens: 4,
              output_tokens: 20,
              reasoning_tokens: 9,
            },
          },
        },
      },
    ])))).toEqual({
      input: 100,
      cachedInput: 80,
      cacheCreation: 4,
      output: 20,
      reasoning: 9,
      cost: 0.2,
      model: "fallback/model",
    });
  });

  it("sums the newest cumulative run snapshot from every message", () => {
    expect(conversationConsoleUsage(detail(
      message("first", [
        {
          type: "telemetry",
          event: "usage_update",
          data: {
            model: "provider/first",
            cumulativeUsd: 0.25,
            tokens: {
              input: 50,
              output: 8,
              cacheRead: 30,
              cacheCreation: 2,
              reasoning: 3,
            },
          },
        },
      ]),
      message("second", [
        {
          type: "telemetry",
          event: "usage_update",
          data: {
            model: "provider/second",
            cumulativeUsd: 0.75,
            tokens: {
              input: 100,
              output: 12,
              cacheRead: 60,
              cacheCreation: 4,
              reasoning: 7,
            },
          },
        },
      ]),
    ))).toEqual({
      input: 150,
      cachedInput: 90,
      cacheCreation: 6,
      output: 20,
      reasoning: 10,
      cost: 1,
      model: "provider/second",
    });
  });

  it("does not double count repeated cumulative snapshots within one message", () => {
    expect(conversationConsoleUsage(detail(
      message("first", [
        {
          type: "telemetry",
          event: "usage_update",
          data: { cumulativeUsd: 0.1, tokens: { input: 50, output: 5 } },
        },
        {
          type: "telemetry",
          event: "usage_update",
          data: { cumulativeUsd: 0.25, tokens: { input: 120, output: 20 } },
        },
      ]),
      message("second", [
        {
          type: "telemetry",
          event: "usage_update",
          data: { cumulativeUsd: 0.5, tokens: { input: 200, output: 30 } },
        },
      ]),
    ))).toEqual({ input: 320, output: 50, cost: 0.75 });
  });

  it("does not backfill fields from an older snapshot in the same message", () => {
    expect(conversationConsoleUsage(detail(
      message("older", [
        { type: "telemetry", event: "usage_update", data: { tokens: { input: 50, output: 8 } } },
      ]),
      message("newer", [
        { type: "telemetry", event: "usage_update", data: { tokens: { input: 100 } } },
        { type: "telemetry", event: "costUpdate", data: { totalUsd: 0.75 } },
      ]),
    ))).toEqual({ input: 50, output: 8, cost: 0.75 });
  });

  it("preserves reported zeroes while ignoring strings and non-finite numbers", () => {
    expect(conversationConsoleUsage(detail(message("one", [
      {
        type: "telemetry",
        event: "usage_update",
        data: {
          model: "provider/model",
          cumulativeUsd: Number.NaN,
          tokens: {
            input: "120",
            output: Number.POSITIVE_INFINITY,
            cacheReadTokens: 0,
          },
        },
      },
    ])))).toEqual({ cachedInput: 0, model: "provider/model" });
  });

  it("skips empty matching telemetry and continues backwards within the message", () => {
    expect(conversationConsoleUsage(detail(message("one", [
      { type: "telemetry", event: "usage_update", data: { inputTokens: 22 } },
      { type: "telemetry", event: "usage_update", data: { tokens: { input: "unknown" } } },
    ])))).toEqual({ input: 22 });
  });
});
