import dns from "node:dns";

import { describe, expect, it } from "vitest";

import { isWildcardHost, type AgentResponder } from "@mono-agent/agent-contracts";

import { startOpenAIApiAdapter, type OpenAIApiChatRequest } from "../index.js";

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

  it("accepts OpenWebUI image_url content parts as structural attachments", async () => {
    const seen: unknown[] = [];
    const responder: AgentResponder<OpenAIApiChatRequest> = {
      async respond(request, stream) {
        seen.push({
          text: request.text,
          imageAttachments: request.imageAttachments,
          attachments: request.attachments,
          metadata: request.metadata.openaiApi,
        });
        await stream.append("image received");
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
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "Describe this" },
                {
                  type: "image_url",
                  image_url: {
                    url: "data:image/png;base64,iVBORw0KGgo=",
                    detail: "high",
                  },
                },
              ],
            },
          ],
        }),
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        choices: [
          {
            message: {
              content: "image received",
            },
          },
        ],
      });
      expect(seen).toEqual([
        {
          text: "user: Describe this",
          imageAttachments: [
            {
              type: "image",
              source: "image_url",
              url: "data:image/png;base64,iVBORw0KGgo=",
              urlKind: "data",
              mediaType: "image/png",
              detail: "high",
              messageRole: "user",
              messageIndex: 0,
              contentPartIndex: 1,
            },
          ],
          // The base64 data: image is also forwarded on the shared attachments
          // contract so it reaches the agent through the generic responder/harness.
          attachments: [
            { kind: "image", mimeType: "image/png", data: "iVBORw0KGgo=" },
          ],
          metadata: expect.objectContaining({
            attachments: {
              count: 1,
              images: [
                {
                  type: "image",
                  source: "image_url",
                  urlKind: "data",
                  mediaType: "image/png",
                  detail: "high",
                  messageRole: "user",
                  messageIndex: 0,
                  contentPartIndex: 1,
                },
              ],
            },
          }),
        },
      ]);
    } finally {
      await server.stop();
    }
  });

  it("bridges only base64 data: images to request.attachments (remote URLs stay metadata-only)", async () => {
    const seen: Array<{ imageAttachments: unknown; attachments: unknown }> = [];
    const responder: AgentResponder<OpenAIApiChatRequest> = {
      async respond(request, stream) {
        seen.push({ imageAttachments: request.imageAttachments, attachments: request.attachments });
        await stream.append("ok");
        return {};
      },
    };
    const server = await startOpenAIApiAdapter({ host: "127.0.0.1", port: 0, modelId: "agent", responder });

    try {
      await fetch(`${server.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "agent",
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "look" },
                // Remote URL: structural only, NOT bridged to shared attachments.
                { type: "image_url", image_url: { url: "https://example.com/cat.png" } },
                // Parameterized base64 data URL: bridged (F157 parser must accept it).
                { type: "image_url", image_url: { url: "data:image/png;charset=utf-8;base64,iVBORw0KGgo=" } },
              ],
            },
          ],
        }),
      });

      // Both images are in the full structural list.
      expect((seen[0]?.imageAttachments as unknown[]).length).toBe(2);
      // Only the base64 data: image reaches the shared attachments contract.
      expect(seen[0]?.attachments).toEqual([
        { kind: "image", mimeType: "image/png", data: "iVBORw0KGgo=" },
      ]);
    } finally {
      await server.stop();
    }
  });

  it("rejects malformed image_url content parts", async () => {
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
                { type: "image_url", image_url: { url: "" } },
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

  it("rejects unsupported message content part types other than text and image_url", async () => {
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
                { type: "text", text: "Transcribe this" },
                { type: "input_audio", input_audio: { data: "abc", format: "wav" } },
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
      expect(response.headers.get("x-accel-buffering")).toBe("no");
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

  it("opens the SSE stream before the responder setup resolves", async () => {
    const releaseRespond = deferred<void>();
    const responder: AgentResponder = {
      async respond(_request, stream) {
        // Simulate slow agent setup latency before any streaming happens.
        await releaseRespond.promise;
        await stream.append("hello after setup");
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
          messages: [{ role: "user", content: "Stream early" }],
        }),
      });

      // Headers must be visible immediately, before the responder resolves.
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/event-stream");
      expect(response.headers.get("x-accel-buffering")).toBe("no");

      const reader = response.body?.getReader();
      if (reader === undefined) {
        throw new Error("Expected a streaming response body.");
      }
      // The assistant-role chunk must reach the client before setup completes,
      // proving the stream opened eagerly. The stream opens with a real `data:`
      // chunk — NOT a leading SSE comment (": open"), which some OpenAI-compatible
      // clients (Open WebUI) mishandle when it precedes the first data event.
      const earlyBody = await readUntil(reader, "\"role\":\"assistant\"");
      expect(earlyBody.startsWith("data:")).toBe(true);
      expect(earlyBody).not.toContain(": open");
      expect(earlyBody).toContain("\"object\":\"chat.completion.chunk\"");
      expect(earlyBody).not.toContain("hello after setup");

      releaseRespond.resolve(undefined);
      const body = earlyBody + await readRemaining(reader);
      expect(body).toContain("\"content\":\"hello after setup\"");
      expect(body).toContain("\"finish_reason\":\"stop\"");
      expect(body.trim().endsWith("data: [DONE]")).toBe(true);
    } finally {
      releaseRespond.resolve(undefined);
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
          name: "mcp__context_example__search",
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
      expect(body).toContain("\"reasoning_content\":\"Running mcp__context_example__search...\"");
      expect(body).toContain("<details type=\\\"tool_calls\\\" done=\\\"true\\\"");
      expect(body).toContain("id=\\\"call-1\\\"");
      expect(body).toContain("name=\\\"mcp__context_example__search\\\"");
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

  it("streams internally executed tool progress before the tool completes", async () => {
    const releaseTool = deferred<void>();
    const responder: AgentResponder = {
      async respond(_request, stream) {
        await stream.event?.({
          type: "tool_call_started",
          id: "call-1",
          name: "mcp__context_example__search",
          arguments: { query: "OpenWebUI tool rendering" },
        });
        await releaseTool.promise;
        await stream.event?.({
          type: "tool_call_completed",
          id: "call-1",
          content: { matches: 2 },
          isError: false,
        });
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
      const reader = response.body?.getReader();
      if (reader === undefined) {
        throw new Error("Expected a streaming response body.");
      }
      const earlyBody = await readUntil(
        reader,
        "\"reasoning_content\":\"Running mcp__context_example__search...\"",
      );
      expect(earlyBody).not.toContain("<details type=\\\"tool_calls\\\" done=\\\"true\\\"");

      releaseTool.resolve(undefined);
      const body = earlyBody + await readRemaining(reader);
      expect(body).toContain("<details type=\\\"tool_calls\\\" done=\\\"true\\\"");
      expect(body.trim().endsWith("data: [DONE]")).toBe(true);
    } finally {
      releaseTool.resolve(undefined);
      await server.stop();
    }
  });

  it("does not duplicate tool-start progress already emitted as a runtime thought", async () => {
    const responder: AgentResponder = {
      async respond(_request, stream) {
        await stream.event?.({ type: "assistant_thought", text: "Running mcp__context_example__search..." });
        await stream.event?.({
          type: "tool_call_started",
          id: "call-1",
          name: "mcp__context_example__search",
          arguments: { query: "OpenWebUI tool rendering" },
        });
        await stream.event?.({
          type: "tool_call_completed",
          id: "call-1",
          content: { matches: 2 },
          isError: false,
        });
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
      expect(body.match(/"reasoning_content":"Running mcp__context_example__search\.\.\."/gu)).toHaveLength(1);
      expect(body).toContain("<details type=\\\"tool_calls\\\" done=\\\"true\\\"");
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

  it("aborts active requests and bounds shutdown even when a streaming responder hangs", async () => {
    let requestStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      requestStarted = resolve;
    });
    let requestSignal: AbortSignal | undefined;
    const responder: AgentResponder = {
      async respond(request) {
        requestSignal = request.abortSignal;
        requestStarted();
        await new Promise<never>(() => undefined);
        return {};
      },
    };
    const server = await startOpenAIApiAdapter({
      host: "127.0.0.1",
      port: 0,
      modelId: "agent",
      responder,
    });

    const response = await fetch(`${server.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "agent",
        stream: true,
        messages: [{ role: "user", content: "hang forever" }],
      }),
    });
    await started;

    const outcome = await Promise.race([
      server.stop().then(() => "stopped" as const),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 1_000)),
    ]);
    expect(outcome).toBe("stopped");
    expect(requestSignal?.aborted).toBe(true);
    await response.body?.cancel().catch(() => undefined);
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

  it.each(["127.attacker.example", "127.0.0.1.attacker.example", "localhost.attacker.example"])(
    "rejects loopback-looking hostnames before DNS resolution (%s)",
    async (host) => {
      await expect(
        startOpenAIApiAdapter({
          host,
          port: 0,
          modelId: "agent",
          responder: echoResponder(),
        }),
      ).rejects.toMatchObject({ code: "unsafe_host" });
    },
  );

  it("rejects an explicitly allowed non-loopback bind without bearer auth", async () => {
    await expect(
      startOpenAIApiAdapter({
        host: "0.0.0.0",
        port: 0,
        allowNonLoopback: true,
        modelId: "agent",
        responder: echoResponder(),
      }),
    ).rejects.toMatchObject({ code: "missing_required_config" });
  });

  it("requires bearer auth when localhost resolves to a non-loopback address after consent", async () => {
    const originalLookup = dns.lookup;
    dns.lookup = wildcardLocalhostLookup as typeof dns.lookup;
    try {
      await expect(
        startOpenAIApiAdapter({
          host: "localhost",
          // Let the kernel choose atomically. Reserving and releasing a fixed
          // port before this bind races every parallel package test/process.
          port: 0,
          allowNonLoopback: true,
          modelId: "agent",
          responder: echoResponder(),
        }),
      ).rejects.toMatchObject({ code: "missing_required_config" });
    } finally {
      dns.lookup = originalLookup;
    }
  });

  it("advertises concrete usable URLs instead of a wildcard bind address", async () => {
    const server = await startOpenAIApiAdapter({
      host: "0.0.0.0",
      port: 0,
      allowNonLoopback: true,
      apiKey: "test-key",
      modelId: "agent",
      responder: echoResponder(),
    });

    try {
      expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
      expect(server.baseUrl).toBe(server.baseUrls[0]);
      expect(server.baseUrls.length).toBeGreaterThan(0);
      expect(server.baseUrls.every((url) => !url.includes("0.0.0.0"))).toBe(true);
      const models = await fetch(`${server.baseUrl}/models`, {
        headers: { authorization: "Bearer test-key" },
      });
      expect(models.status).toBe(200);
    } finally {
      await server.stop();
    }
  });

  it("advertises only concrete URLs for an IPv4-mapped IPv6 wildcard bind", async () => {
    const server = await startOpenAIApiAdapter({
      host: "[::ffff:0.0.0.0]",
      port: 0,
      allowNonLoopback: true,
      apiKey: "test-key",
      modelId: "agent",
      responder: echoResponder(),
    });

    try {
      expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
      expect(server.baseUrl).toBe(server.baseUrls[0]);
      expect(server.baseUrls.every((url) => !isWildcardHost(new URL(url).hostname))).toBe(true);
      expect(server.baseUrls.every((url) => !url.includes("::ffff:0"))).toBe(true);
      const models = await fetch(`${server.baseUrl}/models`, {
        headers: { authorization: "Bearer test-key" },
      });
      expect(models.status).toBe(200);
    } finally {
      await server.stop();
    }
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

function wildcardLocalhostLookup(
  _hostname: string,
  options: unknown,
  callback?: unknown,
): void {
  const done = typeof options === "function" ? options : callback;
  if (typeof done !== "function") {
    throw new TypeError("dns.lookup callback is required");
  }
  queueMicrotask(() => {
    (done as (error: null, address: string, family: number) => void)(null, "0.0.0.0", 4);
  });
}

function echoResponder(): AgentResponder {
  return {
    async respond(request, stream) {
      await stream.append(`echo: ${request.text}`);
      return {};
    },
  };
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, text: string): Promise<string> {
  const decoder = new TextDecoder();
  let body = "";
  while (!body.includes(text)) {
    const next = await readNextChunk(reader, 1_000);
    if (next.done) {
      break;
    }
    body += decoder.decode(next.value, { stream: true });
  }
  body += decoder.decode();
  if (!body.includes(text)) {
    throw new Error(`Timed out before stream contained: ${text}`);
  }
  return body;
}

async function readRemaining(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let body = "";
  for (;;) {
    const next = await reader.read();
    if (next.done) {
      return body + decoder.decode();
    }
    body += decoder.decode(next.value, { stream: true });
  }
}

async function readNextChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("Timed out waiting for stream chunk.")), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
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
