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
      const json = await response.json();
      expect(json).toMatchObject({
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
      });
      expect(json).not.toHaveProperty("usage");
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

  it("accepts chat completion requests posted directly to the configured base URL", async () => {
    const seen: unknown[] = [];
    const responder: AgentResponder = {
      async respond(request, stream) {
        seen.push({
          conversationId: request.conversationId,
          text: request.text,
          metadata: request.metadata?.openaiApi,
        });
        await stream.append("base url ok");
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
      const response = await fetch(server.baseUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "mono-agent",
          metadata: { conversation_id: "chat-base" },
          messages: [{ role: "user", content: "Hello base URL" }],
        }),
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        object: "chat.completion",
        model: "mono-agent",
        choices: [
          {
            message: {
              role: "assistant",
              content: "base url ok",
            },
          },
        ],
      });
      expect(seen).toEqual([
        expect.objectContaining({
          conversationId: "chat-base",
          text: "user: Hello base URL",
          metadata: expect.objectContaining({
            path: "/v1",
          }),
        }),
      ]);
    } finally {
      await server.stop();
    }
  });

  it("omits authorization metadata when API key auth is configured", async () => {
    const seen: unknown[] = [];
    const responder: AgentResponder = {
      async respond(request, stream) {
        seen.push((request.metadata as { readonly openaiApi: { readonly headers: unknown } }).openaiApi.headers);
        await stream.append("ok");
        return {};
      },
    };
    const server = await startOpenAIApiAdapter({
      host: "127.0.0.1",
      port: 0,
      modelId: "mono-agent",
      apiKey: "local-secret",
      responder,
    });

    try {
      const response = await fetch(`${server.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: "Bearer local-secret",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "mono-agent",
          messages: [{ role: "user", content: "Hello Mono" }],
        }),
      });

      expect(response.status).toBe(200);
      expect(seen).toHaveLength(1);
      expect(seen[0]).toEqual(expect.not.objectContaining({
        authorization: expect.anything(),
      }));
    } finally {
      await server.stop();
    }
  });

  it("rejects chat completion requests for a different model", async () => {
    const responder = countingResponder();
    const server = await startOpenAIApiAdapter({
      host: "127.0.0.1",
      port: 0,
      modelId: "mono-agent",
      responder: responder.responder,
    });

    try {
      const response = await fetch(`${server.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "other-model",
          messages: [{ role: "user", content: "Hello Mono" }],
        }),
      });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: {
          type: "invalid_request_error",
        },
      });
      expect(responder.calls).toBe(0);
    } finally {
      await server.stop();
    }
  });

  it.each([
    ["tools", []],
    ["tool_choice", "auto"],
    ["functions", []],
    ["function_call", "auto"],
    ["response_format", { type: "json_object" }],
    ["audio", { voice: "alloy" }],
    ["modalities", ["text", "audio"]],
  ])("rejects unsupported request field %s", async (field, value) => {
    const responder = countingResponder();
    const server = await startOpenAIApiAdapter({
      host: "127.0.0.1",
      port: 0,
      modelId: "mono-agent",
      responder: responder.responder,
    });

    try {
      const response = await fetch(`${server.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "mono-agent",
          messages: [{ role: "user", content: "Hello Mono" }],
          [field]: value,
        }),
      });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: {
          type: "invalid_request_error",
        },
      });
      expect(responder.calls).toBe(0);
    } finally {
      await server.stop();
    }
  });

  it("rejects unsupported message content part types", async () => {
    const responder = countingResponder();
    const server = await startOpenAIApiAdapter({
      host: "127.0.0.1",
      port: 0,
      modelId: "mono-agent",
      responder: responder.responder,
    });

    try {
      const response = await fetch(`${server.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "mono-agent",
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "Describe this" },
                { type: "image_url", image_url: { url: "https://example.com/image.png" } },
              ],
            },
          ],
        }),
      });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: {
          type: "invalid_request_error",
        },
      });
      expect(responder.calls).toBe(0);
    } finally {
      await server.stop();
    }
  });

  it.each(["tool_calls", "function_call"])("rejects unsupported assistant message %s", async (field) => {
    const responder = countingResponder();
    const server = await startOpenAIApiAdapter({
      host: "127.0.0.1",
      port: 0,
      modelId: "mono-agent",
      responder: responder.responder,
    });

    try {
      const response = await fetch(`${server.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "mono-agent",
          messages: [
            { role: "user", content: "Hello Mono" },
            {
              role: "assistant",
              content: null,
              [field]: field === "tool_calls" ? [] : { name: "lookup", arguments: "{}" },
            },
          ],
        }),
      });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: {
          type: "invalid_request_error",
        },
      });
      expect(responder.calls).toBe(0);
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

function countingResponder(): { readonly responder: AgentResponder; readonly calls: number } {
  const state = {
    calls: 0,
    responder: {
      async respond(_request, stream) {
        state.calls += 1;
        await stream.append("ok");
        return {};
      },
    } satisfies AgentResponder,
  };
  return state;
}
