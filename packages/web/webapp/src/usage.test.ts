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

  it("keeps exact current context separate from aggregate last-turn work", () => {
    expect(conversationConsoleUsage(detail(message("one", [
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
    ])))).toEqual({
      context: {
        input: 100,
        cachedInput: 900,
        cacheCreation: 5,
        output: 20,
        total: 1_025,
        contextWindow: 372_000,
        model: "pi:openai-codex:gpt-5.5",
      },
      processed: {
        input: 1200,
        cachedInput: 800,
        cacheCreation: 12,
        output: 345,
        reasoning: 90,
        model: "pi:openai-codex:gpt-5.5",
      },
      cost: 0.0123,
    });
  });

  it("lets a later post-compaction context snapshot decrease", () => {
    expect(conversationConsoleUsage(detail(
      message("first", [{
        type: "telemetry",
        event: "runtime_telemetry",
        data: { kind: "context_usage", data: { contextWindow: 100_000, tokens: { total: 90_000 } } },
      }]),
      message("second", [{
        type: "telemetry",
        event: "runtime_telemetry",
        data: { kind: "context_usage", data: { contextWindow: 100_000, tokens: { total: 20_000 } } },
      }]),
    ))).toEqual({ context: { total: 20_000, contextWindow: 100_000 } });
  });

  it("shows only the latest turn's processed tokens while summing per-turn cost", () => {
    expect(conversationConsoleUsage(detail(
      message("first", [{
        type: "telemetry",
        event: "usage_update",
        data: { cumulativeUsd: 0.25, tokens: { input: 50, output: 8 } },
      }]),
      message("second", [
        { type: "telemetry", event: "usage_update", data: { cumulativeUsd: 0.5, tokens: { input: 100 } } },
        { type: "telemetry", event: "usage_update", data: { cumulativeUsd: 0.75, tokens: { input: 200, output: 12 } } },
      ]),
    ))).toEqual({ processed: { input: 200, output: 12 }, cost: 1 });
  });

  it("keeps legacy aggregate telemetry useful without claiming context occupancy", () => {
    expect(conversationConsoleUsage(detail(message("legacy", [{
      type: "telemetry",
      event: "usage_update",
      data: {
        model: "provider/model",
        cumulativeUsd: 5.104078,
        tokens: { input: 429_128, output: 15_773, cacheRead: 4_970_496 },
      },
    }])))).toEqual({
      processed: {
        input: 429_128,
        cachedInput: 4_970_496,
        output: 15_773,
        model: "provider/model",
      },
      cost: 5.104078,
    });
  });

  it("reads snake-case fields and ignores invalid values without inventing totals", () => {
    expect(conversationConsoleUsage(detail(message("one", [{
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
            output_tokens: Number.POSITIVE_INFINITY,
            reasoning_tokens: 9,
          },
        },
      },
    }])))).toEqual({
      processed: { input: 100, cachedInput: 80, cacheCreation: 4, reasoning: 9, model: "fallback/model" },
      cost: 0.2,
    });
  });
});
