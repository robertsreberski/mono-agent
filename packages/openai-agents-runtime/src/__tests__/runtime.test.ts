import { describe, expect, it, vi } from "vitest";

const openAiMock = vi.hoisted(() => ({
  agentInputs: [] as Array<Record<string, unknown>>,
}));

vi.mock("@openai/agents", () => {
  class MockAgent {
    constructor(input: Record<string, unknown>) {
      openAiMock.agentInputs.push(input);
    }
  }

  class MockMCPServerStreamableHttp {
    constructor(readonly options: Record<string, unknown>) {}
  }

  class MockMCPServerSSE {
    constructor(readonly options: Record<string, unknown>) {}
  }

  class MockMCPServerStdio {
    constructor(readonly options: Record<string, unknown>) {}
  }

  return {
    Agent: MockAgent,
    MCPServerSSE: MockMCPServerSSE,
    MCPServerStdio: MockMCPServerStdio,
    MCPServerStreamableHttp: MockMCPServerStreamableHttp,
    run: vi.fn(async () => {
      async function* events(): AsyncGenerator<OpenAIStreamEventLike, void> {
        yield { type: "agent_updated_stream_event" };
      }
      return Object.assign(events(), {
        completed: Promise.resolve(),
        currentTurn: 1,
        error: null,
        lastResponseId: "resp_mock",
        output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }],
        rawResponses: [],
      });
    }),
  };
});

import { createOpenAIAgentsRuntime, OpenAIAgentsRuntimeError } from "../runtime.js";
import type { OpenAIRunFactoryInput, OpenAIRunHandle, OpenAIRunResult } from "../runtime.js";
import { translateMcpServers, translateOpenAIStreamEvent } from "../translations.js";
import type { OpenAIStreamEventLike } from "../translations.js";

describe("createOpenAIAgentsRuntime", () => {
  it("emits events from the streamed run and returns final text + numTurns", async () => {
    const events: OpenAIStreamEventLike[] = [
      { type: "agent_updated_stream_event" },
      { type: "raw_model_stream_event", data: { type: "output_text_delta", delta: "Hello" } },
      { type: "run_item_stream_event", name: "message_output_created" },
    ];
    const runtime = createOpenAIAgentsRuntime({
      runFactory: async () => buildHandle(events, { finalText: "Hello", numTurns: 1 }),
    });

    const seen: OpenAIStreamEventLike[] = [];
    const result = await runtime.run("system", {
      model: { sdk: "openai", model: "gpt-5" },
      messages: [{ role: "user", content: "Hi" }],
      abortSignal: new AbortController().signal,
      onEvent: (event) => seen.push(event),
    });

    expect(result.text).toBe("Hello");
    expect(result.events).toHaveLength(3);
    expect(seen).toHaveLength(3);
    expect(result.events?.[1]).toEqual(seen[1]);
    expect(seen[1]).toEqual({
      type: "assistant",
      message: { content: [{ type: "text", text: "Hello" }] },
      raw_event: events[1],
    });
    expect(result.numTurns).toBe(1);
    expect(result.sdk).toBe("openai");
    expect(result.model).toBe("gpt-5");
  });

  it("forwards translated MCP servers to the run factory", async () => {
    let receivedInput: OpenAIRunFactoryInput | undefined;
    const runtime = createOpenAIAgentsRuntime({
      runFactory: async (input) => {
        receivedInput = input;
        return buildHandle([], { finalText: "ok", numTurns: 1 });
      },
    });

    await runtime.run("system", {
      model: { sdk: "openai", model: "gpt-5" },
      messages: [{ role: "user", content: "Hi" }],
      abortSignal: new AbortController().signal,
      mcpServers: {
        github: { type: "http", url: "http://localhost:8000" },
        local: { command: "node", args: ["server.js"] },
      },
    });

    const kinds = receivedInput?.mcpServers.map((spec) => spec.kind).sort();
    expect(kinds).toEqual(["stdio", "streamable_http"]);
  });

  it("does not inject local tools when no MCP servers configured", async () => {
    let receivedInput: OpenAIRunFactoryInput | undefined;
    const runtime = createOpenAIAgentsRuntime({
      runFactory: async (input) => {
        receivedInput = input;
        return buildHandle([], { finalText: "ok", numTurns: 1 });
      },
    });

    await runtime.run("system", {
      model: { sdk: "openai", model: "gpt-5" },
      messages: [{ role: "user", content: "Hi" }],
      abortSignal: new AbortController().signal,
    });

    expect(receivedInput?.mcpServers).toEqual([]);
    expect(receivedInput?.agentOptions.tools).toBeUndefined();
  });

  it("surfaces runFactory errors as failureKind / error on the result", async () => {
    const runtime = createOpenAIAgentsRuntime({
      runFactory: async () => {
        throw new Error("rate limited");
      },
    });

    const result = await runtime.run("system", {
      model: { sdk: "openai", model: "gpt-5" },
      messages: [{ role: "user", content: "Hi" }],
      abortSignal: new AbortController().signal,
    });

    expect(result.failureKind).toBe("runtime_error");
    expect(result.error).toContain("rate limited");
  });

  it("marks result as cancelled when abortSignal aborts", async () => {
    const controller = new AbortController();
    const runtime = createOpenAIAgentsRuntime({
      runFactory: async (input) => {
        async function* gen(): AsyncGenerator<OpenAIStreamEventLike, void> {
          yield { type: "raw_model_stream_event", data: { type: "output_text_delta", delta: "x" } };
          input.abortSignal.dispatchEvent
            ? input.abortSignal.dispatchEvent(new Event("abort"))
            : controller.abort();
        }
        return {
          events: gen(),
          completed: async () => ({ numTurns: 0, error: new Error("aborted") }),
        };
      },
    });

    const result = await runtime.run("system", {
      model: { sdk: "openai", model: "gpt-5" },
      messages: [{ role: "user", content: "Hi" }],
      abortSignal: controller.signal,
    });
    controller.abort();
    expect(result.failureKind).toBeDefined();
  });

  it("forwards sdkOptions.agent and sdkOptions.run to the factory", async () => {
    let received: OpenAIRunFactoryInput | undefined;
    const runtime = createOpenAIAgentsRuntime({
      sdkOptions: {
        agent: { handoffs: ["other-agent"], tools: ["webSearchTool"] },
        run: { tracing: { disabled: true } },
      },
      runFactory: async (input) => {
        received = input;
        return buildHandle([], { finalText: "ok", numTurns: 1 });
      },
    });

    await runtime.run("system", {
      model: { sdk: "openai", model: "gpt-5" },
      messages: [{ role: "user", content: "Hi" }],
      abortSignal: new AbortController().signal,
    });

    expect(received?.agentOptions.handoffs).toEqual(["other-agent"]);
    expect(received?.agentOptions.tools).toEqual(["webSearchTool"]);
    expect(received?.runConfig.tracing).toEqual({ disabled: true });
  });

  it("does not forward maxTurns to the SDK when it is unlimited", async () => {
    let received: OpenAIRunFactoryInput | undefined;
    const runtime = createOpenAIAgentsRuntime({
      runFactory: async (input) => {
        received = input;
        return buildHandle([], { finalText: "ok", numTurns: 1 });
      },
    });

    await runtime.run("system", {
      model: { sdk: "openai", model: "gpt-5" },
      messages: [{ role: "user", content: "Hi" }],
      abortSignal: new AbortController().signal,
      maxTurns: 0,
    });

    expect(received?.runConfig).not.toHaveProperty("maxTurns");
  });

  it("applies a deny-only MCP tool filter in the default SDK adapter", async () => {
    openAiMock.agentInputs.length = 0;
    const runtime = createOpenAIAgentsRuntime();

    await runtime.run("system", {
      model: { sdk: "openai", model: "gpt-5" },
      messages: [{ role: "user", content: "Hi" }],
      abortSignal: new AbortController().signal,
      disallowedTools: ["blocked_tool"],
      mcpServers: {
        local: { command: "node", args: ["server.js"] },
      },
    });

    const agentOptions = openAiMock.agentInputs[0];
    const mcpConfig = agentOptions?.mcpConfig as { toolFilter?: (info: { name?: string }) => boolean } | undefined;
    expect(mcpConfig?.toolFilter?.({ name: "blocked_tool" })).toBe(false);
    expect(mcpConfig?.toolFilter?.({ name: "allowed_tool" })).toBe(true);
  });

  it("rejects empty system prompt", async () => {
    const runtime = createOpenAIAgentsRuntime({
      runFactory: async () => buildHandle([], { numTurns: 0 }),
    });
    await expect(
      runtime.run("", {
        model: { sdk: "openai", model: "gpt-5" },
        messages: [{ role: "user", content: "Hi" }],
        abortSignal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(OpenAIAgentsRuntimeError);
  });

  it("rejects an unexpected model.sdk fail-closed", async () => {
    const runtime = createOpenAIAgentsRuntime({
      runFactory: async () => buildHandle([], { numTurns: 0 }),
    });
    await expect(
      runtime.run("system", {
        model: { sdk: "claude", model: "claude-opus-4-7" },
        messages: [{ role: "user", content: "Hi" }],
        abortSignal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ name: "OpenAIAgentsRuntimeError", code: "invalid_options" });
  });
});

describe("translations", () => {
  it("translateMcpServers maps http url to streamable_http kind", () => {
    expect(
      translateMcpServers({ ok: { type: "http", url: "http://example.com" } }),
    ).toEqual([
      { kind: "streamable_http", name: "ok", options: { url: "http://example.com", name: "ok" } },
    ]);
  });

  it("translateMcpServers maps sse type to sse kind", () => {
    expect(translateMcpServers({ stream: { type: "sse", url: "http://example.com/sse" } })).toEqual([
      { kind: "sse", name: "stream", options: { url: "http://example.com/sse", name: "stream" } },
    ]);
  });

  it("translateMcpServers maps command to stdio kind", () => {
    expect(translateMcpServers({ local: { command: "node", args: ["s.js"] } })).toEqual([
      { kind: "stdio", name: "local", options: { command: "node", args: ["s.js"], name: "local" } },
    ]);
  });

  it("translateMcpServers skips entries with malformed names", () => {
    expect(translateMcpServers({ "bad name": { command: "node" } })).toEqual([]);
  });

  it("translateOpenAIStreamEvent passes through valid events", () => {
    expect(translateOpenAIStreamEvent({ type: "agent_updated_stream_event" })?.type).toBe(
      "agent_updated_stream_event",
    );
    expect(translateOpenAIStreamEvent({})).toBeUndefined();
  });

  it("translateOpenAIStreamEvent exposes output text deltas as canonical assistant text", () => {
    const raw = { type: "raw_model_stream_event", data: { type: "output_text_delta", delta: "Hello" } };
    expect(translateOpenAIStreamEvent(raw)).toEqual({
      type: "assistant",
      message: { content: [{ type: "text", text: "Hello" }] },
      raw_event: raw,
    });
  });

  it("translateOpenAIStreamEvent exposes raw reasoning deltas as canonical assistant thinking", () => {
    const raw = { type: "raw_model_stream_event", data: { type: "reasoning_delta", delta: "Checking context" } };
    expect(translateOpenAIStreamEvent(raw)).toEqual({
      type: "assistant",
      message: { content: [{ type: "thinking", text: "Checking context" }] },
      raw_event: raw,
    });
  });

  it("translateOpenAIStreamEvent exposes nested Responses reasoning deltas as canonical assistant thinking", () => {
    const raw = {
      type: "raw_model_stream_event",
      data: {
        type: "model",
        event: { type: "response.reasoning_text.delta", delta: "Reviewing tool output" },
      },
    };
    expect(translateOpenAIStreamEvent(raw)).toEqual({
      type: "assistant",
      message: { content: [{ type: "thinking", text: "Reviewing tool output" }] },
      raw_event: raw,
    });
  });

  it("translateOpenAIStreamEvent ignores nested Responses reasoning done events", () => {
    const raw = {
      type: "raw_model_stream_event",
      data: {
        type: "model",
        event: { type: "response.reasoning_text.done", text: "Reviewing tool output" },
      },
    };
    expect(translateOpenAIStreamEvent(raw)).toEqual(raw);
  });

  it("translateOpenAIStreamEvent exposes Chat Completions reasoning deltas as canonical assistant thinking", () => {
    const raw = {
      type: "raw_model_stream_event",
      data: {
        type: "model",
        event: {
          choices: [
            {
              index: 0,
              delta: { reasoning: "Planning the first step" },
            },
          ],
        },
      },
    };
    expect(translateOpenAIStreamEvent(raw)).toEqual({
      type: "assistant",
      message: { content: [{ type: "thinking", text: "Planning the first step" }] },
      raw_event: raw,
    });
  });

  it("translateOpenAIStreamEvent ignores non-primary Chat Completions reasoning deltas", () => {
    const raw = {
      type: "raw_model_stream_event",
      data: {
        type: "model",
        event: {
          choices: [
            {
              index: 1,
              delta: { reasoning: "Alternate path reasoning" },
            },
          ],
        },
      },
    };
    expect(translateOpenAIStreamEvent(raw)).toEqual(raw);
  });
});

function buildHandle(
  events: readonly OpenAIStreamEventLike[],
  result: OpenAIRunResult,
): OpenAIRunHandle {
  async function* gen(): AsyncGenerator<OpenAIStreamEventLike, void> {
    for (const event of events) {
      yield event;
    }
  }
  return {
    events: gen(),
    completed: async () => result,
  };
}
