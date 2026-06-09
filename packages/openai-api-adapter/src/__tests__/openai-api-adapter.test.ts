import { describe, expect, it } from "vitest";

import type { AgentResponder } from "@worklab-ai/agent-contracts";

import { startOpenAIApiAdapter } from "../index.js";

describe("OpenAI API adapter", () => {
  it("serves OpenAI-compatible model discovery for OpenWebUI", async () => {
    const server = await startOpenAIApiAdapter({
      host: "127.0.0.1",
      port: 0,
      modelId: "mono-agent",
      responder: echoResponder(),
    });

    try {
      const response = await fetch(`${server.baseUrl}/models`);

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        object: "list",
        data: [
          expect.objectContaining({
            id: "mono-agent",
            object: "model",
            owned_by: "worklab-ai",
          }),
        ],
      });
    } finally {
      await server.stop();
    }
  });

  it("maps chat completion requests into structural responder calls", async () => {
    const seen: unknown[] = [];
    const responder: AgentResponder = {
      async respond(request, stream) {
        seen.push({
          conversationId: request.conversationId,
          text: request.text,
          metadata: request.metadata?.openaiApi,
        });
        await stream.append(`echo: ${request.text}`);
        return { metadata: { ok: true } };
      },
    };
    const server = await startOpenAIApiAdapter({
      host: "127.0.0.1",
      port: 0,
      modelId: "mono-agent",
      responder,
    });

    try {
      const response = await fetch(`${server.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "mono-agent",
          user: "openwebui-user",
          metadata: { conversation_id: "chat-1" },
          messages: [
            { role: "system", content: "You are concise." },
            { role: "user", content: "Hello Mono" },
          ],
        }),
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        object: "chat.completion",
        model: "mono-agent",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "echo: system: You are concise.\nuser: Hello Mono",
            },
            finish_reason: "stop",
          },
        ],
        usage: {
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0,
        },
      });
      expect(seen).toEqual([
        expect.objectContaining({
          conversationId: "chat-1",
          text: "system: You are concise.\nuser: Hello Mono",
          metadata: expect.objectContaining({
            model: "mono-agent",
            stream: false,
            path: "/v1/chat/completions",
            requestId: expect.any(String),
          }),
        }),
      ]);
    } finally {
      await server.stop();
    }
  });

  it("streams Chat Completions Server-Sent Events when requested", async () => {
    const responder: AgentResponder = {
      async respond(_request, stream) {
        await stream.append("hello");
        await stream.append(" stream");
        return {};
      },
    };
    const server = await startOpenAIApiAdapter({
      host: "127.0.0.1",
      port: 0,
      modelId: "mono-agent",
      responder,
    });

    try {
      const response = await fetch(`${server.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "mono-agent",
          stream: true,
          messages: [{ role: "user", content: "Stream it" }],
        }),
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/event-stream");
      const body = await response.text();
      expect(body).toContain("\"object\":\"chat.completion.chunk\"");
      expect(body).toContain("\"role\":\"assistant\"");
      expect(body).toContain("\"content\":\"hello\"");
      expect(body).toContain("\"content\":\" stream\"");
      expect(body).toContain("\"finish_reason\":\"stop\"");
      expect(body.trim().endsWith("data: [DONE]")).toBe(true);
    } finally {
      await server.stop();
    }
  });

  it("requires bearer auth when an API key is configured", async () => {
    const server = await startOpenAIApiAdapter({
      host: "127.0.0.1",
      port: 0,
      modelId: "mono-agent",
      apiKey: "local-secret",
      responder: echoResponder(),
    });

    try {
      const unauthorized = await fetch(`${server.baseUrl}/models`);
      expect(unauthorized.status).toBe(401);
      await expect(unauthorized.json()).resolves.toMatchObject({
        error: {
          type: "invalid_request_error",
          code: "invalid_api_key",
        },
      });

      const authorized = await fetch(`${server.baseUrl}/models`, {
        headers: { Authorization: "Bearer local-secret" },
      });
      expect(authorized.status).toBe(200);
    } finally {
      await server.stop();
    }
  });

  it("rejects non-loopback binds unless explicitly allowed", async () => {
    await expect(
      startOpenAIApiAdapter({
        host: "0.0.0.0",
        port: 0,
        modelId: "mono-agent",
        responder: echoResponder(),
      }),
    ).rejects.toMatchObject({ code: "unsafe_host" });
  });
});

function echoResponder(): AgentResponder {
  return {
    async respond(request, stream) {
      await stream.append(`echo: ${request.text}`);
      return {};
    },
  };
}
