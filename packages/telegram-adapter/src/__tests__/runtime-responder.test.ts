import { describe, expect, it, vi } from "vitest";

import {
  AgentResponderCancelledError,
  type AgentRequest,
} from "../adapter.js";
import type { AgentMessageStream } from "../message-stream.js";
import {
  assistantTextFromRuntimeEvent,
  createRuntimeResponder,
  RuntimeResponderError,
  type AgentRuntimeLike,
  type RuntimeRunOptions,
} from "../runtime-responder.js";

const MODEL = {
  sdk: "pi",
  provider: "openai-codex",
  model: "gpt-5.5",
  reference: "pi:openai-codex:gpt-5.5",
};

describe("createRuntimeResponder", () => {
  it("requires callers to pass a parsed runtime model reference", () => {
    expect(() =>
      createRuntimeResponder({
        runtime: fakeRuntime(async () => ({ text: "ok" })),
        systemPrompt: "You are helpful.",
        model: "pi:openai-codex:gpt-5.5" as never,
      }),
    ).toThrow(/parsed runtime model reference/);
  });

  it("calls runtime.run with user messages, model options, abort signal, and host event callback", async () => {
    const calls: Array<{ systemPrompt: string; options: RuntimeRunOptions }> = [];
    const hostEvents: unknown[] = [];
    const runtime = fakeRuntime(async (systemPrompt, options) => {
      calls.push({ systemPrompt, options });
      options.onEvent?.({
        type: "assistant",
        message: { content: [{ type: "text", text: "partial" }] },
      });
      return {
        text: "final answer",
        model: "gpt-5.5",
        sdk: "pi",
        usage: { input_tokens: 1, output_tokens: 2 },
        durationMs: 12,
        numTurns: 1,
      };
    });
    const stream = new FakeStream();
    const request = agentRequest("hello runtime");

    const responder = createRuntimeResponder({
      runtime,
      systemPrompt: "You are helpful.",
      model: MODEL,
      executionMode: "sdk",
      effort: "high",
      cwd: "/workspace",
      maxTurns: 3,
      runtimeOptions: {
        outputSchema: { type: "object" },
        onEvent: (event) => hostEvents.push(event),
      },
    });

    await expect(responder.respond(request, stream)).resolves.toEqual({
      text: "final answer",
      metadata: {
        runtime: {
          model: "gpt-5.5",
          sdk: "pi",
          usage: { input_tokens: 1, output_tokens: 2 },
          durationMs: 12,
          numTurns: 1,
        },
      },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.systemPrompt).toBe("You are helpful.");
    expect(calls[0]?.options).toMatchObject({
      model: MODEL,
      messages: [{ role: "user", content: "hello runtime" }],
      executionMode: "sdk",
      effort: "high",
      cwd: "/workspace",
      maxTurns: 3,
      outputSchema: { type: "object" },
    });
    expect(calls[0]?.options.abortSignal).toBe(request.abortSignal);
    expect(stream.events).toEqual([{ method: "append", text: "partial" }]);
    expect(hostEvents).toHaveLength(1);
  });

  it("allows hosts to customize runtime messages", async () => {
    const runtime = fakeRuntime(async (_systemPrompt, options) => ({
      text: JSON.stringify(options.messages),
    }));
    const responder = createRuntimeResponder({
      runtime,
      systemPrompt: "System",
      model: MODEL,
      buildMessages: (request) => [
        { role: "system", content: "previous context" },
        { role: "user", content: request.text, telegramMessageId: request.messageId },
      ],
      includeResultMetadata: false,
    });

    await expect(responder.respond(agentRequest("custom"), new FakeStream())).resolves.toEqual({
      text: JSON.stringify([
        { role: "system", content: "previous context" },
        { role: "user", content: "custom", telegramMessageId: 10 },
      ]),
    });
  });

  it("propagates runtime cancellations and failures honestly", async () => {
    const cancelled = createRuntimeResponder({
      runtime: fakeRuntime(async () => ({ cancelled: true })),
      systemPrompt: "System",
      model: MODEL,
    });
    const failed = createRuntimeResponder({
      runtime: fakeRuntime(async () => ({
        error: "provider rejected payload",
        failureKind: "provider_request_error",
        errorDetails: { status: 400 },
      })),
      systemPrompt: "System",
      model: MODEL,
    });

    await expect(
      cancelled.respond(agentRequest("cancel"), new FakeStream()),
    ).rejects.toBeInstanceOf(AgentResponderCancelledError);
    await expect(
      failed.respond(agentRequest("fail"), new FakeStream()),
    ).rejects.toMatchObject({
      name: "RuntimeResponderError",
      failureKind: "provider_request_error",
      runtimeError: "provider rejected payload",
      errorDetails: { status: 400 },
    });
  });
});

describe("assistantTextFromRuntimeEvent", () => {
  it("extracts text blocks from normalized assistant events only", () => {
    expect(
      assistantTextFromRuntimeEvent({
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "hello" },
            { type: "tool_use", name: "Read" },
            { type: "text", text: " world" },
          ],
        },
      }),
    ).toBe("hello world");
    expect(
      assistantTextFromRuntimeEvent({
        type: "assistant",
        message: { content: [{ type: "thinking", text: "hidden" }] },
      }),
    ).toBe("");
    expect(assistantTextFromRuntimeEvent({ type: "result", text: "done" })).toBe("");
  });
});

class FakeStream implements AgentMessageStream {
  readonly events: Array<{ method: string; text: string | undefined }> = [];

  async status(text: string): Promise<void> {
    this.events.push({ method: "status", text });
  }

  async append(delta: string): Promise<void> {
    this.events.push({ method: "append", text: delta });
  }

  async replace(text: string): Promise<void> {
    this.events.push({ method: "replace", text });
  }

  async finish(finalText?: string): Promise<void> {
    this.events.push({ method: "finish", text: finalText });
  }
}

function fakeRuntime(
  run: AgentRuntimeLike["run"],
): AgentRuntimeLike {
  return { run: vi.fn(run) };
}

function agentRequest(text: string): AgentRequest {
  const controller = new AbortController();
  return {
    conversationId: "telegram:42",
    chatId: 42,
    messageId: 10,
    updateId: 1,
    userId: 7,
    username: "alice",
    text,
    abortSignal: controller.signal,
    metadata: {
      telegram: {
        updateId: 1,
        chat: { id: 42, type: "private" },
        message: { id: 10, date: 1234 },
        from: { id: 7, username: "alice" },
      },
    },
  };
}
