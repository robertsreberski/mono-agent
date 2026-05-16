import { describe, expect, it, vi } from "vitest";
import { AgentResponderCancelledError, type AgentRequest } from "../adapter.js";
import type { AgentMessageStream } from "../message-stream.js";
import {
  createRuntimeResponder,
  RuntimeResponderError,
  type AgentRuntimeLike,
  type RuntimeEventLike,
} from "../runtime-responder.js";

class FakeStream implements AgentMessageStream {
  readonly events: string[] = [];
  current = "";

  async status(text: string): Promise<void> {
    this.events.push(`status:${text}`);
  }

  async append(delta: string): Promise<void> {
    this.current += delta;
    this.events.push(`append:${delta}`);
  }

  async replace(text: string): Promise<void> {
    this.current = text;
    this.events.push(`replace:${text}`);
  }

  async finish(finalText?: string): Promise<void> {
    if (finalText !== undefined) {
      this.current = finalText;
    }
    this.events.push("finish");
  }
}

function request(overrides: Partial<AgentRequest> = {}): AgentRequest {
  const controller = new AbortController();
  return {
    conversationId: "whatsapp:123@s.whatsapp.net",
    chatJid: "123@s.whatsapp.net",
    remoteJid: "123@s.whatsapp.net",
    chatKind: "direct",
    text: "hello",
    trigger: "direct",
    abortSignal: controller.signal,
    metadata: {
      whatsapp: {
        chat: { jid: "123@s.whatsapp.net", kind: "direct" },
        message: {},
        mentionedJids: [],
        trigger: "direct",
      },
    },
    ...overrides,
  };
}

describe("createRuntimeResponder", () => {
  it("builds runtime options from a WhatsApp request and returns runtime metadata", async () => {
    const runtime: AgentRuntimeLike = {
      run: vi.fn(async () => ({
        text: "runtime response",
        model: "gpt-5.5",
        sdk: "openai-codex",
        cost: { totalUsd: 0.01 },
        capabilitiesUsed: ["mcp"],
      })),
    };
    const model = { sdk: "openai-codex", model: "gpt-5.5" };
    const responder = createRuntimeResponder({
      runtime,
      systemPrompt: "system",
      model,
      executionMode: "cli",
      effort: "high",
      cwd: "/repo",
      maxTurns: 3,
    });

    const response = await responder.respond(request(), new FakeStream());

    expect(runtime.run).toHaveBeenCalledWith(
      "system",
      expect.objectContaining({
        model,
        messages: [{ role: "user", content: "hello" }],
        executionMode: "cli",
        effort: "high",
        cwd: "/repo",
        maxTurns: 3,
      }),
    );
    expect(response).toEqual({
      text: "runtime response",
      metadata: {
        runtime: {
          model: "gpt-5.5",
          sdk: "openai-codex",
          cost: { totalUsd: 0.01 },
          capabilitiesUsed: ["mcp"],
        },
      },
    });
  });

  it("streams assistant text events to the WhatsApp stream", async () => {
    const runtime: AgentRuntimeLike = {
      run: vi.fn(async (_systemPrompt, options) => {
        const event: RuntimeEventLike = {
          type: "assistant",
          message: { content: [{ type: "text", text: "streamed" }] },
        };
        options.onEvent?.(event);
        return {};
      }),
    };
    const stream = new FakeStream();
    const responder = createRuntimeResponder({
      runtime,
      systemPrompt: "system",
      model: { sdk: "fake", model: "model" },
    });

    const response = await responder.respond(request(), stream);

    expect(response).toEqual({ metadata: { runtime: {} } });
    expect(stream.current).toBe("streamed");
    expect(stream.events).toEqual(["append:streamed"]);
  });

  it("propagates runtime failure and cancellation honestly", async () => {
    const failingRuntime: AgentRuntimeLike = {
      run: vi.fn(async () => ({ error: "boom", failureKind: "runtime_error" })),
    };
    const cancelledRuntime: AgentRuntimeLike = {
      run: vi.fn(async () => ({ cancelled: true })),
    };

    await expect(
      createRuntimeResponder({
        runtime: failingRuntime,
        systemPrompt: "system",
        model: { sdk: "fake", model: "model" },
      }).respond(request(), new FakeStream()),
    ).rejects.toBeInstanceOf(RuntimeResponderError);

    await expect(
      createRuntimeResponder({
        runtime: cancelledRuntime,
        systemPrompt: "system",
        model: { sdk: "fake", model: "model" },
      }).respond(request(), new FakeStream()),
    ).rejects.toBeInstanceOf(AgentResponderCancelledError);
  });
});
