import { describe, expect, it, vi } from "vitest";

import { ClaudeAgentsRuntimeError, createClaudeAgentsRuntime } from "../runtime.js";
import { extractAssistantTextDelta, translateClaudeMessageToEvent, translateMcpServers } from "../translations.js";
import type { ClaudeSDKMessageLike } from "../translations.js";

describe("createClaudeAgentsRuntime", () => {
  it("returns assistant text accumulated from streamed messages when no result message arrives", async () => {
    const queryFactory = vi.fn(() => stubQuery([
      { type: "assistant", message: { content: [{ type: "text", text: "Hello " }] } },
      { type: "assistant", message: { content: [{ type: "text", text: "world." }] } },
    ]));
    const runtime = createClaudeAgentsRuntime({ queryFactory });

    const result = await runtime.run("You are a test.", {
      model: { sdk: "anthropic", model: "claude-opus-4-7" },
      messages: [{ role: "user", content: "Hi" }],
      abortSignal: new AbortController().signal,
    });

    expect(result.text).toBe("Hello world.");
    expect(result.events).toHaveLength(2);
    expect(result.sdk).toBe("anthropic");
    expect(result.model).toBe("claude-opus-4-7");
  });

  it("uses result text and metrics when a result success message is emitted", async () => {
    const queryFactory = vi.fn(() => stubQuery([
      { type: "assistant", message: { content: [{ type: "text", text: "draft" }] } },
      {
        type: "result",
        subtype: "success",
        result: "final answer",
        num_turns: 2,
        duration_ms: 1234,
        total_cost_usd: 0.05,
        usage: { input_tokens: 10, output_tokens: 7 },
        session_id: "sess_abc",
        stop_reason: "end_turn",
      },
    ]));
    const runtime = createClaudeAgentsRuntime({ queryFactory });

    const result = await runtime.run("system", {
      model: { sdk: "anthropic", model: "claude-opus-4-7" },
      messages: [{ role: "user", content: "Hi" }],
      abortSignal: new AbortController().signal,
    });

    expect(result.text).toBe("final answer");
    expect(result.numTurns).toBe(2);
    expect(result.durationMs).toBe(1234);
    expect(result.providerSessionId).toBe("sess_abc");
    expect(result.usage).toEqual({ input_tokens: 10, output_tokens: 7 });
    expect(result.cost).toEqual({ totalUsd: 0.05 });
    expect(result.failureKind).toBeUndefined();
  });

  it("forwards mcpServers, allowedTools, disallowedTools, cwd, and sdkOptions to the SDK", async () => {
    const captured: Array<{ readonly prompt: string; readonly options: Record<string, unknown> }> = [];
    const queryFactory = vi.fn((input: { readonly prompt: string; readonly options: Record<string, unknown> }) => {
      captured.push(input);
      return stubQuery([
        { type: "result", subtype: "success", result: "ok", num_turns: 1, duration_ms: 1 },
      ]);
    });
    const runtime = createClaudeAgentsRuntime({
      queryFactory,
      sdkOptions: { additionalDirectories: ["/extra"] },
    });

    await runtime.run("system", {
      model: { sdk: "anthropic", model: "claude-opus-4-7" },
      messages: [{ role: "user", content: "Hi" }],
      abortSignal: new AbortController().signal,
      allowedTools: ["Read", "Bash"],
      disallowedTools: ["Write"],
      mcpServers: { github: { type: "http", url: "http://localhost:8000" } },
      cwd: "/work",
    });

    expect(queryFactory).toHaveBeenCalledOnce();
    const sdkOptions = captured[0]?.options ?? {};
    expect(sdkOptions.allowedTools).toEqual(["Read", "Bash"]);
    expect(sdkOptions.disallowedTools).toEqual(["Write"]);
    expect(sdkOptions.cwd).toBe("/work");
    expect(sdkOptions.systemPrompt).toBe("system");
    expect(sdkOptions.model).toBe("claude-opus-4-7");
    expect(sdkOptions.mcpServers).toEqual({ github: { type: "http", url: "http://localhost:8000" } });
    expect(sdkOptions.additionalDirectories).toEqual(["/extra"]);
  });

  it("calls SDK interrupt when abortSignal fires mid-stream", async () => {
    const controller = new AbortController();
    const interrupt = vi.fn(async () => undefined);
    let receivedMessages = 0;
    const queryFactory = vi.fn(() => {
      async function* gen(): AsyncGenerator<ClaudeSDKMessageLike, void> {
        yield { type: "assistant", message: { content: [{ type: "text", text: "first" }] } };
        receivedMessages += 1;
        controller.abort();
        // simulate that after interrupt, no more messages are yielded
      }
      return Object.assign(gen(), { interrupt });
    });
    const runtime = createClaudeAgentsRuntime({ queryFactory });

    const result = await runtime.run("system", {
      model: { sdk: "anthropic", model: "claude-opus-4-7" },
      messages: [{ role: "user", content: "Hi" }],
      abortSignal: controller.signal,
    });

    expect(receivedMessages).toBe(1);
    expect(interrupt).toHaveBeenCalled();
    expect(result.cancelled).toBe(true);
  });

  it("surfaces SDK exceptions as failureKind / error on the result", async () => {
    const queryFactory = vi.fn(() => {
      async function* gen(): AsyncGenerator<ClaudeSDKMessageLike, void> {
        throw new Error("network down");
      }
      return Object.assign(gen(), { interrupt: async () => undefined });
    });
    const runtime = createClaudeAgentsRuntime({ queryFactory });

    const result = await runtime.run("system", {
      model: { sdk: "anthropic", model: "claude-opus-4-7" },
      messages: [{ role: "user", content: "Hi" }],
      abortSignal: new AbortController().signal,
    });

    expect(result.failureKind).toBe("runtime_error");
    expect(result.error).toContain("network down");
  });

  it("maps an SDK error result (subtype + errors[]) to failureKind / error", async () => {
    const queryFactory = vi.fn(() => stubQuery([
      {
        type: "result",
        subtype: "error_max_turns",
        is_error: true,
        num_turns: 5,
        duration_ms: 200,
        stop_reason: "max_turns",
        errors: ["hit the turn ceiling", "  ", "and another"],
      },
    ]));
    const runtime = createClaudeAgentsRuntime({ queryFactory });

    const result = await runtime.run("system", {
      model: { sdk: "anthropic", model: "claude-opus-4-7" },
      messages: [{ role: "user", content: "Hi" }],
      abortSignal: new AbortController().signal,
    });

    expect(result.failureKind).toBe("error_max_turns");
    expect(result.error).toBe("hit the turn ceiling; and another");
    expect(result.stopReason).toBe("max_turns");
    expect(result.numTurns).toBe(5);
  });

  it("rejects an unexpected model.sdk fail-closed", async () => {
    const runtime = createClaudeAgentsRuntime({ queryFactory: () => stubQuery([]) });
    await expect(
      runtime.run("system", {
        model: { sdk: "openai", model: "gpt-5" },
        messages: [{ role: "user", content: "Hi" }],
        abortSignal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ name: "ClaudeAgentsRuntimeError", code: "invalid_options" });
  });

  it("accepts the canonical claude sdk id as well as the anthropic alias", async () => {
    const queryFactory = vi.fn(() => stubQuery([{ type: "result", subtype: "success", result: "ok", num_turns: 1, duration_ms: 1 }]));
    const runtime = createClaudeAgentsRuntime({ queryFactory });
    const result = await runtime.run("system", {
      model: { sdk: "claude", model: "claude-opus-4-7" },
      messages: [{ role: "user", content: "Hi" }],
      abortSignal: new AbortController().signal,
    });
    expect(result.sdk).toBe("claude");
    expect(result.text).toBe("ok");
  });

  it("applies apiKey to env for the duration of the call and restores afterwards", async () => {
    const previous = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "before";
    const seen: string[] = [];
    const queryFactory = vi.fn(() => {
      seen.push(process.env.ANTHROPIC_API_KEY ?? "");
      return stubQuery([{ type: "result", subtype: "success", result: "ok", num_turns: 1, duration_ms: 1 }]);
    });
    const runtime = createClaudeAgentsRuntime({ apiKey: "during", queryFactory });

    await runtime.run("system", {
      model: { sdk: "anthropic", model: "claude-opus-4-7" },
      messages: [{ role: "user", content: "Hi" }],
      abortSignal: new AbortController().signal,
    });

    expect(seen).toEqual(["during"]);
    expect(process.env.ANTHROPIC_API_KEY).toBe("before");

    if (previous === undefined) {
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = previous;
    }
  });

  it("rejects empty system prompt and missing messages", async () => {
    const runtime = createClaudeAgentsRuntime({ queryFactory: () => stubQuery([]) });
    await expect(
      runtime.run("", {
        model: { sdk: "anthropic", model: "claude-opus-4-7" },
        messages: [{ role: "user", content: "hi" }],
        abortSignal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(ClaudeAgentsRuntimeError);
  });
});

describe("translations", () => {
  it("translateMcpServers returns a name-keyed Record (not an array), skipping invalid names", () => {
    expect(translateMcpServers(undefined)).toBeUndefined();
    expect(translateMcpServers({})).toBeUndefined();
    const result = translateMcpServers({
      github: { type: "http", url: "http://example.com" },
      "bad name with spaces": { type: "http", url: "http://x.com" },
      ok_one: { type: "stdio", command: "node" },
    });
    // Must be a Record<name, config>, with each server under its OWN key — not
    // an array wrapping a single record (Claude SDK sdk.d.ts:1498).
    expect(Array.isArray(result)).toBe(false);
    expect(result).toEqual({
      github: { type: "http", url: "http://example.com" },
      ok_one: { type: "stdio", command: "node" },
    });
    expect(result).not.toHaveProperty("bad name with spaces");
  });

  it("extractAssistantTextDelta concatenates text blocks", () => {
    expect(
      extractAssistantTextDelta({
        type: "assistant",
        message: { content: [{ type: "text", text: "a" }, { type: "tool_use" }, { type: "text", text: "b" }] },
      }),
    ).toBe("ab");
    expect(extractAssistantTextDelta({ type: "result" })).toBe("");
  });

  it("translateClaudeMessageToEvent passes through known message types", () => {
    const event = translateClaudeMessageToEvent({ type: "assistant", message: { content: [] } });
    expect(event?.type).toBe("assistant");
    expect(translateClaudeMessageToEvent({})).toBeUndefined();
  });
});

function stubQuery(messages: readonly ClaudeSDKMessageLike[]): AsyncIterable<ClaudeSDKMessageLike> & { interrupt: () => Promise<void> } {
  async function* gen(): AsyncGenerator<ClaudeSDKMessageLike, void> {
    for (const message of messages) {
      yield message;
    }
  }
  return Object.assign(gen(), { interrupt: async () => undefined });
}
