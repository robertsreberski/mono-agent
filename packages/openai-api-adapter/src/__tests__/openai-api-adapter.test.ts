import { describe, expect, it } from "vitest";

import type { AgentResponder } from "@mono-agent/agent-contracts";

import { startOpenAIApiAdapter } from "../index.js";

describe("OpenAI API adapter", () => {
  it("serves OpenAI-compatible model discovery for OpenWebUI", async () => {
    const server = await startOpenAIApiAdapter({
      host: "127.0.0.1",
      port: 0,
      modelId: "agent",
      responder: echoResponder(),
    });

    try {
      const response = await fetch(`${server.baseUrl}/models`);

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        object: "list",
        data: [
          expect.objectContaining({
            id: "agent",
            object: "model",
            owned_by: "host",
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
      modelId: "agent",
      responder,
    });

    try {
      const response = await fetch(`${server.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "agent",
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
        model: "agent",
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
            model: "agent",
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
      modelId: "agent",
      responder,
    });

    try {
      const response = await fetch(server.baseUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "agent",
          metadata: { conversation_id: "chat-base" },
          messages: [{ role: "user", content: "Hello base URL" }],
        }),
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        object: "chat.completion",
        model: "agent",
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
      modelId: "agent",
      apiKey: "redacted-value",
      responder,
    });

    try {
      const response = await fetch(`${server.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: "Bearer redacted-value",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "agent",
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
      modelId: "agent",
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
      modelId: "agent",
      responder: responder.responder,
    });

    try {
      const response = await fetch(`${server.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "agent",
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
      modelId: "agent",
      responder: responder.responder,
    });

    try {
      const response = await fetch(`${server.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "agent",
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
      modelId: "agent",
      responder: responder.responder,
    });

    try {
      const response = await fetch(`${server.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "agent",
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
      modelId: "agent",
      responder,
    });

    try {
      const response = await fetch(`${server.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "agent",
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

  it("streams thoughts and internally executed tools without client tool calls or duplicate final text", async () => {
    const responder: AgentResponder = {
      async respond(_request, stream) {
        await stream.event?.({ type: "assistant_thought", text: "checking available context" });
        await stream.event?.({
          type: "tool_call_started",
          id: "call-1",
          name: "mcp__context_a8c__search",
          arguments: { query: "OpenWebUI tool rendering" },
        });
        await stream.event?.({
          type: "tool_call_completed",
          id: "call-1",
          content: { matches: 2 },
          isError: false,
        });
        await stream.append("Final answer.");
        return { text: "Final answer." };
      },
    };
    const server = await startOpenAIApiAdapter({
      host: "127.0.0.1",
      port: 0,
      modelId: "agent",
      responder,
    });

    try {
      const response = await fetch(`${server.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "agent",
          stream: true,
          messages: [{ role: "user", content: "Show progress" }],
        }),
      });

      expect(response.status).toBe(200);
      const body = await response.text();
      expect(body).toContain("\"reasoning_content\":\"checking available context\"");
      expect(body).toContain("<details type=\\\"tool_calls\\\" done=\\\"true\\\"");
      expect(body).toContain("id=\\\"call-1\\\"");
      expect(body).toContain("name=\\\"mcp__context_a8c__search\\\"");
      expect(body).toContain("OpenWebUI tool rendering");
      expect(body).toContain("{\\\"matches\\\":2}");
      expect(body).not.toContain("\"tool_calls\"");
      expect(body).not.toContain("\"finish_reason\":\"tool_calls\"");
      expect(body.match(/"content":"Final answer\."/gu)).toHaveLength(1);
      expect(body.trim().endsWith("data: [DONE]")).toBe(true);
    } finally {
      await server.stop();
    }
  });

  it("requires bearer auth when an API key is configured", async () => {
    const server = await startOpenAIApiAdapter({
      host: "127.0.0.1",
      port: 0,
      modelId: "agent",
      apiKey: "redacted-value",
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
        headers: { Authorization: "Bearer redacted-value" },
      });
      expect(authorized.status).toBe(200);
    } finally {
      await server.stop();
    }
  });

  it("routes models and chat completions at the root when basePath is '/'", async () => {
    const server = await startOpenAIApiAdapter({
      host: "127.0.0.1",
      port: 0,
      basePath: "/",
      modelId: "agent",
      responder: echoResponder(),
    });

    try {
      expect(server.baseUrl).toBe(server.url);

      const models = await fetch(`${server.url}/models`);
      expect(models.status).toBe(200);
      await expect(models.json()).resolves.toMatchObject({ object: "list" });

      const chat = await fetch(`${server.url}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "agent",
          messages: [{ role: "user", content: "root path" }],
        }),
      });
      expect(chat.status).toBe(200);
      await expect(chat.json()).resolves.toMatchObject({
        choices: [{ message: { content: "echo: user: root path" } }],
      });

      const base = await fetch(server.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "agent",
          messages: [{ role: "user", content: "root base" }],
        }),
      });
      expect(base.status).toBe(200);
      await expect(base.json()).resolves.toMatchObject({
        choices: [{ message: { content: "echo: user: root base" } }],
      });
    } finally {
      await server.stop();
    }
  });

  it.each(["/v1?foo=bar", "/v1#frag", "no-leading-slash"])(
    "rejects a basePath that is not a clean absolute path (%s)",
    async (basePath) => {
      await expect(
        startOpenAIApiAdapter({
          host: "127.0.0.1",
          port: 0,
          basePath,
          modelId: "agent",
          responder: echoResponder(),
        }),
      ).rejects.toMatchObject({ code: "invalid_config" });
    },
  );

  it("aborts the responder when the client disconnects mid-request", async () => {
    let abortObserved!: () => void;
    const abortSeen = new Promise<void>((resolve) => {
      abortObserved = resolve;
    });
    const responder: AgentResponder = {
      async respond(request) {
        await new Promise<void>((resolve, reject) => {
          request.abortSignal.addEventListener("abort", () => {
            abortObserved();
            reject(new Error("aborted by client"));
          });
        });
        return {};
      },
    };
    const server = await startOpenAIApiAdapter({
      host: "127.0.0.1",
      port: 0,
      modelId: "agent",
      responder,
    });

    try {
      const controller = new AbortController();
      const pending = fetch(`${server.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "agent",
          messages: [{ role: "user", content: "hang" }],
        }),
        signal: controller.signal,
      });
      const settled = pending.catch(() => undefined);

      // Give the request time to reach the responder, then disconnect.
      await new Promise((resolve) => setTimeout(resolve, 50));
      controller.abort();

      await abortSeen;
      await settled;
    } finally {
      await server.stop();
    }
  });

  it("rejects non-loopback binds unless explicitly allowed", async () => {
    await expect(
      startOpenAIApiAdapter({
        host: "0.0.0.0",
        port: 0,
        modelId: "agent",
        responder: echoResponder(),
      }),
    ).rejects.toMatchObject({ code: "unsafe_host" });
  });

  describe("conversation session continuity", () => {
    it("derives the conversation id from x-openwebui-chat-id and sends only the latest user message", async () => {
      const capture = capturingResponder();
      const server = await startOpenAIApiAdapter({
        host: "127.0.0.1",
        port: 0,
        modelId: "agent",
        responder: capture.responder,
      });

      try {
        const response = await postChat(server.baseUrl, {
          messages: [
            { role: "system", content: "You are concise." },
            { role: "user", content: "A" },
            { role: "assistant", content: "B" },
            { role: "user", content: "C" },
          ],
        }, { "x-openwebui-chat-id": "owui-chat-1" });

        expect(response.status).toBe(200);
        expect(capture.seen).toEqual([{ conversationId: "owui-chat-1", text: "C" }]);
      } finally {
        await server.stop();
      }
    });

    it("accepts the generic x-conversation-id header", async () => {
      const capture = capturingResponder();
      const server = await startOpenAIApiAdapter({
        host: "127.0.0.1",
        port: 0,
        modelId: "agent",
        responder: capture.responder,
      });

      try {
        const response = await postChat(server.baseUrl, {
          messages: [
            { role: "user", content: "A" },
            { role: "assistant", content: "B" },
            { role: "user", content: "C" },
          ],
        }, { "x-conversation-id": "generic-1" });

        expect(response.status).toBe(200);
        expect(capture.seen).toEqual([{ conversationId: "generic-1", text: "C" }]);
      } finally {
        await server.stop();
      }
    });

    it("prefers body metadata conversation ids over headers", async () => {
      const capture = capturingResponder();
      const server = await startOpenAIApiAdapter({
        host: "127.0.0.1",
        port: 0,
        modelId: "agent",
        responder: capture.responder,
      });

      try {
        const response = await postChat(server.baseUrl, {
          metadata: { conversation_id: "body-id" },
          messages: [
            { role: "user", content: "A" },
            { role: "assistant", content: "B" },
            { role: "user", content: "C" },
          ],
        }, { "x-openwebui-chat-id": "header-id" });

        expect(response.status).toBe(200);
        expect(capture.seen).toEqual([{ conversationId: "body-id", text: "C" }]);
      } finally {
        await server.stop();
      }
    });

    it("keeps the full transcript on the first turn of a stable conversation", async () => {
      const capture = capturingResponder();
      const server = await startOpenAIApiAdapter({
        host: "127.0.0.1",
        port: 0,
        modelId: "agent",
        responder: capture.responder,
      });

      try {
        const response = await postChat(server.baseUrl, {
          messages: [
            { role: "system", content: "You are concise." },
            { role: "user", content: "Hello" },
          ],
        }, { "x-openwebui-chat-id": "owui-first" });

        expect(response.status).toBe(200);
        expect(capture.seen).toEqual([
          { conversationId: "owui-first", text: "system: You are concise.\nuser: Hello" },
        ]);
      } finally {
        await server.stop();
      }
    });

    it("joins multiple trailing user messages into one turn", async () => {
      const capture = capturingResponder();
      const server = await startOpenAIApiAdapter({
        host: "127.0.0.1",
        port: 0,
        modelId: "agent",
        responder: capture.responder,
      });

      try {
        const response = await postChat(server.baseUrl, {
          messages: [
            { role: "user", content: "A" },
            { role: "assistant", content: "B" },
            { role: "user", content: "X" },
            { role: "user", content: "Y" },
          ],
        }, { "x-openwebui-chat-id": "owui-multi" });

        expect(response.status).toBe(200);
        expect(capture.seen).toEqual([{ conversationId: "owui-multi", text: "X\nY" }]);
      } finally {
        await server.stop();
      }
    });

    it("falls back to the full transcript when no user message follows the last assistant message", async () => {
      const capture = capturingResponder();
      const server = await startOpenAIApiAdapter({
        host: "127.0.0.1",
        port: 0,
        modelId: "agent",
        responder: capture.responder,
      });

      try {
        const response = await postChat(server.baseUrl, {
          messages: [
            { role: "user", content: "A" },
            { role: "assistant", content: "B" },
          ],
        }, { "x-openwebui-chat-id": "owui-continue" });

        expect(response.status).toBe(200);
        expect(capture.seen).toEqual([
          { conversationId: "owui-continue", text: "user: A\nassistant: B" },
        ]);
      } finally {
        await server.stop();
      }
    });

    it("keeps full-transcript flattening for requests without any conversation id", async () => {
      const capture = capturingResponder();
      const server = await startOpenAIApiAdapter({
        host: "127.0.0.1",
        port: 0,
        modelId: "agent",
        responder: capture.responder,
      });

      try {
        const response = await postChat(server.baseUrl, {
          messages: [
            { role: "user", content: "A" },
            { role: "assistant", content: "B" },
            { role: "user", content: "C" },
          ],
        });

        expect(response.status).toBe(200);
        expect(capture.seen).toEqual([
          {
            conversationId: expect.stringMatching(/^openai-api:/u),
            text: "user: A\nassistant: B\nuser: C",
          },
        ]);
      } finally {
        await server.stop();
      }
    });

    it("treats body.user as a conversation id but keeps the full transcript", async () => {
      const capture = capturingResponder();
      const server = await startOpenAIApiAdapter({
        host: "127.0.0.1",
        port: 0,
        modelId: "agent",
        responder: capture.responder,
      });

      try {
        const response = await postChat(server.baseUrl, {
          user: "owui-user",
          messages: [
            { role: "user", content: "A" },
            { role: "assistant", content: "B" },
            { role: "user", content: "C" },
          ],
        });

        expect(response.status).toBe(200);
        expect(capture.seen).toEqual([
          { conversationId: "owui-user", text: "user: A\nassistant: B\nuser: C" },
        ]);
      } finally {
        await server.stop();
      }
    });

    it("applies latest-message extraction to body metadata conversation ids", async () => {
      const capture = capturingResponder();
      const server = await startOpenAIApiAdapter({
        host: "127.0.0.1",
        port: 0,
        modelId: "agent",
        responder: capture.responder,
      });

      try {
        const response = await postChat(server.baseUrl, {
          metadata: { conversation_id: "chat-2" },
          messages: [
            { role: "user", content: "Hi" },
            { role: "assistant", content: "Hello" },
            { role: "user", content: "Next" },
          ],
        });

        expect(response.status).toBe(200);
        expect(capture.seen).toEqual([{ conversationId: "chat-2", text: "Next" }]);
      } finally {
        await server.stop();
      }
    });
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

async function postChat(
  baseUrl: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<globalThis.Response> {
  return fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ model: "agent", ...body }),
  });
}

function capturingResponder(): {
  readonly responder: AgentResponder;
  readonly seen: Array<{ conversationId: string; text: string }>;
} {
  const seen: Array<{ conversationId: string; text: string }> = [];
  return {
    seen,
    responder: {
      async respond(request, stream) {
        seen.push({ conversationId: request.conversationId, text: request.text });
        await stream.append("ok");
        return {};
      },
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
