import { describe, expect, it, vi } from "vitest";

import type { AgentResponder } from "@mono-agent/agent-contracts";

import { startWebhookAdapter } from "../index.js";

describe("Webhook adapter", () => {
  it("runs sync HTTP invocations through a structural responder", async () => {
    const seen: unknown[] = [];
    const responder: AgentResponder = {
      async respond(request, stream) {
        seen.push(request.metadata?.webhook);
        await stream.append(`echo: ${request.text}`);
        return { metadata: { ok: true } };
      },
    };

    const server = await startWebhookAdapter({
      host: "127.0.0.1",
      port: 0,
      path: "/webhook/invoke",
      responder,
    });

    try {
      const response = await fetch(`${server.url}/webhook/invoke`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "hello", conversationId: "conversation-1", mode: "sync" }),
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        status: "succeeded",
        conversationId: "conversation-1",
        text: "echo: hello",
        metadata: { ok: true },
      });
      expect(seen).toEqual([
        expect.objectContaining({
          mode: "sync",
          path: "/webhook/invoke",
          requestId: expect.any(String),
        }),
      ]);
    } finally {
      await server.stop();
    }
  });

  it("strips an unsafe responder system prompt from sync HTTP without changing unrelated metadata", async () => {
    const responder: AgentResponder = {
      async respond(_request, stream) {
        await stream.append("safe response");
        return {
          metadata: {
            summary: {
              status: "succeeded",
              runId: "run-1",
              systemPrompt: "private compiled prompt",
              diagnostics: {
                systemPrompt: "unrelated nested value",
                nested: {
                  retained: true,
                  toJSON() {
                    return { systemPrompt: "nested serialization bypass" };
                  },
                },
              },
              toJSON() {
                return { systemPrompt: "summary serialization bypass" };
              },
            },
            trace: { systemPrompt: "unrelated metadata value" },
          },
        };
      },
    };
    const server = await startWebhookAdapter({ host: "127.0.0.1", port: 0, responder });

    try {
      const response = await fetch(`${server.invokeUrl}`, postJson({ text: "hello", mode: "sync" }));
      expect(response.status).toBe(200);
      const body = await response.json() as {
        metadata?: {
          summary?: Record<string, unknown>;
          trace?: Record<string, unknown>;
        };
      };
      expect(body.metadata?.summary).toEqual({
        status: "succeeded",
        runId: "run-1",
        diagnostics: {
          systemPrompt: "unrelated nested value",
          nested: { retained: true },
        },
      });
      expect(body.metadata?.summary).not.toHaveProperty("systemPrompt");
      expect(body.metadata?.trace).toEqual({ systemPrompt: "unrelated metadata value" });
    } finally {
      await server.stop();
    }
  });

  it.each([
    {
      shape: "array",
      summary: () => Object.assign([], {
        toJSON() {
          return { systemPrompt: "array serialization bypass" };
        },
      }),
    },
    {
      shape: "function",
      summary: () => Object.assign(() => undefined, {
        toJSON() {
          return { systemPrompt: "function serialization bypass" };
        },
      }),
    },
    { shape: "primitive", summary: () => "not-a-summary-object" },
  ])("drops a malformed $shape responder summary instead of serializing it", async ({ summary }) => {
    const responder: AgentResponder = {
      async respond() {
        return {
          text: "safe response",
          metadata: {
            summary: summary(),
            retained: { safe: true },
          },
        };
      },
    };
    const server = await startWebhookAdapter({ host: "127.0.0.1", port: 0, responder });

    try {
      const response = await fetch(`${server.invokeUrl}`, postJson({ text: "hello", mode: "sync" }));
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toMatchObject({
        status: "succeeded",
        metadata: { retained: { safe: true } },
      });
      expect(body).not.toHaveProperty("metadata.summary");
    } finally {
      await server.stop();
    }
  });

  it("includes native notify metadata and reports completed runs", async () => {
    const seen: unknown[] = [];
    const results: unknown[] = [];
    const responder: AgentResponder = {
      async respond(request, stream) {
        seen.push(request);
        await stream.append(`digest: ${request.text}`);
        return {};
      },
    };

    const server = await startWebhookAdapter({
      host: "127.0.0.1",
      port: 0,
      endpoints: [
        {
          name: "digest",
          path: "/digest",
          mode: "sync",
          notify: true,
          notifyConversationId: "telegram:42",
        },
      ],
      responder,
      onResult: (status, request) => {
        results.push({ status, webhook: request.metadata.webhook });
      },
    });

    try {
      const response = await fetch(`${server.url}/digest`, postJson({ text: "payload", conversationId: "c1", mode: "sync" }));

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({ status: "succeeded", text: "digest: payload" });
      expect(seen).toEqual([
        expect.objectContaining({
          conversationId: "c1",
          replyTo: { conversationId: "telegram:42" },
          metadata: {
            webhook: expect.objectContaining({
              endpointName: "digest",
              nativeNotify: { enabled: true, conversationId: "telegram:42" },
            }),
          },
        }),
      ]);
      expect(results).toEqual([
        expect.objectContaining({
          status: expect.objectContaining({ status: "succeeded", text: "digest: payload" }),
          webhook: expect.objectContaining({ endpointName: "digest" }),
        }),
      ]);
    } finally {
      await server.stop();
    }
  });

  it("prefers a deliverable request conversation over the host-inferred fallback", async () => {
    const seen: unknown[] = [];
    const responder: AgentResponder = {
      async respond(request, stream) {
        seen.push(request.replyTo);
        await stream.append("ok");
        return {};
      },
    };
    const server = await startWebhookAdapter({
      host: "127.0.0.1",
      port: 0,
      endpoints: [{
        name: "callback",
        path: "/callback",
        mode: "sync",
        notify: true,
        notifyFallbackConversationId: "slack:C-FALLBACK",
      }],
      responder,
    });

    try {
      const response = await fetch(
        `${server.url}/callback`,
        postJson({ text: "payload", conversationId: "slack:C-REQUEST", mode: "sync" }),
      );
      expect(response.status).toBe(200);
      expect(seen).toEqual([{ conversationId: "slack:C-REQUEST" }]);
    } finally {
      await server.stop();
    }
  });

  it("carries endpoint model/effort and lets the request body override them", async () => {
    const seen: unknown[] = [];
    const responder: AgentResponder = {
      async respond(request, stream) {
        seen.push(request.metadata?.webhook);
        await stream.append("ok");
        return {};
      },
    };

    const server = await startWebhookAdapter({
      host: "127.0.0.1",
      port: 0,
      endpoints: [
        {
          name: "delegate",
          path: "/delegate",
          mode: "sync",
          model: "claude:claude-sonnet-4-6",
          effort: "low",
        },
      ],
      responder,
    });

    try {
      // Request body model/effort win over the endpoint defaults (delegate use case).
      await fetch(
        `${server.url}/delegate`,
        postJson({ text: "deep research", conversationId: "c1", mode: "sync", model: "claude:claude-opus-4-8", effort: "high" }),
      );
      // No body override: endpoint defaults apply.
      await fetch(`${server.url}/delegate`, postJson({ text: "quick", conversationId: "c2", mode: "sync" }));

      expect(seen).toEqual([
        expect.objectContaining({ model: "claude:claude-opus-4-8", effort: "high" }),
        expect.objectContaining({ model: "claude:claude-sonnet-4-6", effort: "low" }),
      ]);
    } finally {
      await server.stop();
    }
  });

  it("logs and contains rejected async onResult hooks", async () => {
    const logger = { warn: vi.fn() };
    const server = await startWebhookAdapter({
      host: "127.0.0.1",
      port: 0,
      path: "/webhook/invoke",
      responder: echoResponder(),
      logger,
      onResult: async () => {
        await Promise.resolve();
        throw new Error("async hook failure");
      },
    });

    try {
      const response = await invokeSync(server.url, "payload", "conversation-hook");

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({ status: "succeeded", text: "echo: payload" });
      await expect.poll(() => logger.warn.mock.calls.length).toBe(1);
      expect(logger.warn).toHaveBeenCalledWith(
        "Webhook onResult callback failed.",
        expect.objectContaining({
          conversationId: "conversation-hook",
          error: "async hook failure",
        }),
      );
    } finally {
      await server.stop();
    }
  });

  it("accepts async invocations and exposes in-memory request status", async () => {
    let finish!: () => void;
    let onResultStatus: unknown;
    const responder: AgentResponder = {
      async respond(_request, stream) {
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        await stream.append("async done");
        return {
          metadata: {
            summary: {
              status: "succeeded",
              runId: "async-run",
              systemPrompt: "private async prompt",
              cost: { totalUsd: 0.01 },
            },
            custom: { retained: true },
            toJSON() {
              return { summary: { systemPrompt: "metadata serialization bypass" } };
            },
          },
        };
      },
    };

    const server = await startWebhookAdapter({
      host: "127.0.0.1",
      port: 0,
      path: "/webhook/invoke",
      responder,
      onResult: (status) => {
        onResultStatus = structuredClone(status);
        if (status.status === "succeeded") {
          const custom = status.metadata?.custom;
          if (custom !== null && typeof custom === "object" && !Array.isArray(custom)) {
            (custom as Record<string, unknown>).retained = false;
          }
          const summary = status.metadata?.summary;
          if (summary !== null && typeof summary === "object" && !Array.isArray(summary)) {
            (summary as Record<string, unknown>).systemPrompt = "mutation through onResult";
            const cost = (summary as Record<string, unknown>).cost;
            if (cost !== null && typeof cost === "object" && !Array.isArray(cost)) {
              (cost as Record<string, unknown>).totalUsd = 999;
            }
          }
        }
      },
    });

    try {
      const accepted = await fetch(`${server.url}/webhook/invoke`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "background", mode: "async" }),
      });
      expect(accepted.status).toBe(202);
      const acceptedBody = await accepted.json() as { requestId: string; statusUrl: string };
      expect(acceptedBody).toMatchObject({
        requestId: expect.any(String),
        status: "accepted",
        statusUrl: expect.stringContaining(`/webhook/requests/${acceptedBody.requestId}`),
      });

      const running = await fetch(`${server.url}${acceptedBody.statusUrl}`);
      expect(running.status).toBe(200);
      await expect(running.json()).resolves.toMatchObject({ status: "running" });

      finish();

      let statusBody: unknown;
      await expect.poll(async () => {
        const response = await fetch(`${server.url}${acceptedBody.statusUrl}`);
        statusBody = await response.json();
        return statusBody;
      }).toMatchObject({
        status: "succeeded",
        text: "async done",
        metadata: {
          summary: {
            status: "succeeded",
            runId: "async-run",
            cost: { totalUsd: 0.01 },
          },
          custom: { retained: true },
        },
      });

      expect(statusBody).not.toHaveProperty("metadata.summary.systemPrompt");
      expect(onResultStatus).toMatchObject({
        status: "succeeded",
        metadata: { summary: { runId: "async-run" }, custom: { retained: true } },
      });
      expect(onResultStatus).not.toHaveProperty("metadata.summary.systemPrompt");

      const programmaticStatus = server.getStatus(acceptedBody.requestId);
      expect(programmaticStatus).not.toHaveProperty("metadata.summary.systemPrompt");
      if (programmaticStatus?.status === "succeeded") {
        const summary = programmaticStatus.metadata?.summary;
        if (summary !== null && typeof summary === "object" && !Array.isArray(summary)) {
          (summary as Record<string, unknown>).systemPrompt = "mutation through getStatus";
          const cost = (summary as Record<string, unknown>).cost;
          if (cost !== null && typeof cost === "object" && !Array.isArray(cost)) {
            (cost as Record<string, unknown>).totalUsd = 777;
          }
        }
        const custom = programmaticStatus.metadata?.custom;
        if (custom !== null && typeof custom === "object" && !Array.isArray(custom)) {
          (custom as Record<string, unknown>).retained = false;
        }
      }

      const afterMutation = await fetch(`${server.url}${acceptedBody.statusUrl}`);
      const afterMutationBody = await afterMutation.json();
      expect(afterMutationBody).not.toHaveProperty("metadata.summary.systemPrompt");
      expect(afterMutationBody).toMatchObject({
        metadata: {
          summary: { cost: { totalUsd: 0.01 } },
          custom: { retained: true },
        },
      });
      expect(server.getStatus(acceptedBody.requestId)).toMatchObject({
        metadata: {
          summary: { cost: { totalUsd: 0.01 } },
          custom: { retained: true },
        },
      });
    } finally {
      await server.stop();
    }
  });

  it("returns busy for concurrent active requests with the same conversation id", async () => {
    let finish!: () => void;
    const responder: AgentResponder = {
      async respond() {
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        return { text: "done" };
      },
    };

    const server = await startWebhookAdapter({
      host: "127.0.0.1",
      port: 0,
      path: "/webhook/invoke",
      responder,
    });

    try {
      const first = fetch(`${server.url}/webhook/invoke`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "first", conversationId: "same", mode: "sync" }),
      });

      await expect.poll(async () => server.activeRequestCount).toBe(1);

      const second = await fetch(`${server.url}/webhook/invoke`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "second", conversationId: "same", mode: "sync" }),
      });

      expect(second.status).toBe(409);
      await expect(second.json()).resolves.toMatchObject({ status: "busy", conversationId: "same" });

      finish();
      await expect(first).resolves.toMatchObject({ status: 200 });
    } finally {
      await server.stop();
    }
  });

  it("derives the status base path from the invoke path's parent directory", async () => {
    const nested = await startWebhookAdapter({
      host: "127.0.0.1",
      port: 0,
      path: "/webhook/invoke",
      responder: echoResponder(),
    });
    try {
      expect(nested.statusBasePath).toBe("/webhook/requests");
      expect(nested.invokeUrl).toBe(`${nested.url}/webhook/invoke`);
    } finally {
      await nested.stop();
    }

    const topLevel = await startWebhookAdapter({
      host: "127.0.0.1",
      port: 0,
      path: "/invoke",
      responder: echoResponder(),
    });
    try {
      expect(topLevel.statusBasePath).toBe("/requests");
    } finally {
      await topLevel.stop();
    }
  });

  it("prunes stored statuses once the per-request cap is exceeded", async () => {
    const server = await startWebhookAdapter({
      host: "127.0.0.1",
      port: 0,
      path: "/webhook/invoke",
      maxStoredRequests: 1,
      responder: echoResponder(),
    });

    try {
      const first = await invokeSync(server.url, "first", "conversation-a");
      expect(first.status).toBe(200);
      const firstId = (await first.json() as { requestId: string }).requestId;
      expect(server.getStatus(firstId)).toBeDefined();

      const second = await invokeSync(server.url, "second", "conversation-b");
      expect(second.status).toBe(200);
      const secondId = (await second.json() as { requestId: string }).requestId;

      // Oldest entry is evicted to honour maxStoredRequests: 1.
      expect(server.getStatus(secondId)).toBeDefined();
      expect(server.getStatus(firstId)).toBeUndefined();

      const lookup = await fetch(`${server.url}${server.statusBasePath}/${firstId}`);
      expect(lookup.status).toBe(404);
      await expect(lookup.json()).resolves.toMatchObject({ status: "not_found" });
    } finally {
      await server.stop();
    }
  });

  it("prunes stored statuses once they age past the retention window", async () => {
    const server = await startWebhookAdapter({
      host: "127.0.0.1",
      port: 0,
      path: "/webhook/invoke",
      retentionMs: 1,
      responder: echoResponder(),
    });

    try {
      const stored = await invokeSync(server.url, "ephemeral", "conversation-ttl");
      expect(stored.status).toBe(200);
      const requestId = (await stored.json() as { requestId: string }).requestId;

      await new Promise((resolve) => setTimeout(resolve, 10));

      // A status lookup triggers a prune of the now-expired entry.
      const lookup = await fetch(`${server.url}${server.statusBasePath}/${requestId}`);
      expect(lookup.status).toBe(404);
      expect(server.getStatus(requestId)).toBeUndefined();
    } finally {
      await server.stop();
    }
  });

  it("aborts the responder when a sync client disconnects", async () => {
    let abortObserved!: () => void;
    const abortSeen = new Promise<void>((resolve) => {
      abortObserved = resolve;
    });
    const responder: AgentResponder = {
      async respond(request) {
        await new Promise<void>((_resolve, reject) => {
          request.abortSignal.addEventListener("abort", () => {
            abortObserved();
            reject(new Error("aborted by client"));
          });
        });
        return {};
      },
    };
    const server = await startWebhookAdapter({
      host: "127.0.0.1",
      port: 0,
      path: "/webhook/invoke",
      responder,
    });

    try {
      const controller = new AbortController();
      const pending = fetch(`${server.url}/webhook/invoke`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "hang", conversationId: "conversation-abort", mode: "sync" }),
        signal: controller.signal,
      });
      const settled = pending.catch(() => undefined);

      await expect.poll(async () => server.activeRequestCount).toBe(1);
      controller.abort();

      await abortSeen;
      await settled;
      await expect.poll(async () => server.activeRequestCount).toBe(0);
    } finally {
      await server.stop();
    }
  });

  it("returns 400 for a malformed JSON body via the express error handler", async () => {
    const server = await startWebhookAdapter({
      host: "127.0.0.1",
      port: 0,
      path: "/webhook/invoke",
      responder: echoResponder(),
    });

    try {
      const response = await fetch(`${server.url}/webhook/invoke`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{ not json",
      });
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ status: "failed" });
    } finally {
      await server.stop();
    }
  });

  it.each([
    ["non-object body", "[]"],
    ["missing text", JSON.stringify({ conversationId: "c" })],
    ["blank text", JSON.stringify({ text: "   " })],
    ["invalid mode", JSON.stringify({ text: "hi", mode: "fire-and-forget" })],
  ])("returns 500 with a failed status for a semantically invalid body (%s)", async (_label, body) => {
    const server = await startWebhookAdapter({
      host: "127.0.0.1",
      port: 0,
      path: "/webhook/invoke",
      responder: echoResponder(),
    });

    try {
      const response = await fetch(`${server.url}/webhook/invoke`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toMatchObject({ status: "failed" });
    } finally {
      await server.stop();
    }
  });

  it("rejects non-loopback binds unless explicitly allowed", async () => {
    await expect(
      startWebhookAdapter({
        host: "0.0.0.0",
        port: 0,
        path: "/webhook/invoke",
        responder: { async respond() { return { text: "ok" }; } },
      }),
    ).rejects.toMatchObject({ code: "unsafe_host" });
  });

  it("aborts a hung async run at maxRunMs and reclaims the conversation slot", async () => {
    let resolveResult: ((status: { status: string; error?: string }) => void) | undefined;
    const resultPromise = new Promise<{ status: string; error?: string }>((resolve) => {
      resolveResult = resolve;
    });
    // A responder that never settles AND ignores the abort signal: the runaway
    // case the cron-style watchdog must reclaim. async mode has no client to
    // disconnect, so the max-run bound is its only escape.
    const hangingResponder: AgentResponder = { respond: () => new Promise<never>(() => {}) };

    const server = await startWebhookAdapter({
      host: "127.0.0.1",
      port: 0,
      path: "/webhook/invoke",
      defaultMode: "async",
      maxRunMs: 100,
      responder: hangingResponder,
      onResult: (status) => { resolveResult?.(status as { status: string; error?: string }); },
    });

    try {
      const accepted = await fetch(`${server.url}/webhook/invoke`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "hang", conversationId: "c-timeout", mode: "async" }),
      });
      expect(accepted.status).toBe(202);

      const result = await resultPromise;
      expect(result.status).toBe("failed");
      expect(result.error).toMatch(/timed out/i);
      // The slot was reclaimed even though the responder never settled.
      await expect.poll(async () => server.activeRequestCount).toBe(0);
    } finally {
      await server.stop();
    }
  });

  it("reports cancelled when a responder resolves after the run was aborted", async () => {
    let resolveResult: ((status: { status: string }) => void) | undefined;
    const resultPromise = new Promise<{ status: string }>((resolve) => { resolveResult = resolve; });
    let abortObserved!: () => void;
    const abortSeen = new Promise<void>((resolve) => { abortObserved = resolve; });
    // A responder that observes the abort but RESOLVES successfully anyway — the
    // success path must still classify the run as cancelled, not succeeded.
    const responder: AgentResponder = {
      async respond(request) {
        await new Promise<void>((resolve) => {
          request.abortSignal.addEventListener("abort", () => { abortObserved(); resolve(); }, { once: true });
        });
        return { text: "ignored the abort" };
      },
    };

    const server = await startWebhookAdapter({
      host: "127.0.0.1",
      port: 0,
      path: "/webhook/invoke",
      responder,
      onResult: (status) => { resolveResult?.(status as { status: string }); },
    });

    try {
      const controller = new AbortController();
      const pending = fetch(`${server.url}/webhook/invoke`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "x", conversationId: "c-abort-success", mode: "sync" }),
        signal: controller.signal,
      });
      const settled = pending.catch(() => undefined);

      await expect.poll(async () => server.activeRequestCount).toBe(1);
      controller.abort();
      await abortSeen;
      await settled;

      const result = await resultPromise;
      expect(result.status).toBe("cancelled");
      await expect.poll(async () => server.activeRequestCount).toBe(0);
    } finally {
      await server.stop();
    }
  });

  it("leaves a run that finishes within maxRunMs untouched", async () => {
    const server = await startWebhookAdapter({
      host: "127.0.0.1",
      port: 0,
      path: "/webhook/invoke",
      maxRunMs: 5000,
      responder: echoResponder(),
    });

    try {
      const response = await invokeSync(server.url, "hi", "c-fast");
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({ status: "succeeded", text: "echo: hi" });
    } finally {
      await server.stop();
    }
  });
});

describe("Webhook adapter multi-endpoint", () => {
  it("serves multiple endpoints on one server and prepends each endpoint's prompt", async () => {
    const seen: Array<{ text: string; endpoint: string | undefined }> = [];
    const responder: AgentResponder = {
      async respond(request, stream) {
        const webhook = request.metadata?.webhook as { endpointName?: string } | undefined;
        seen.push({ text: request.text, endpoint: webhook?.endpointName });
        await stream.append("ok");
        return {};
      },
    };

    const server = await startWebhookAdapter({
      host: "127.0.0.1",
      port: 0,
      defaultMode: "sync",
      endpoints: [
        { name: "plain", path: "/plain" },
        { name: "guided", path: "/guided", prompt: "PREAMBLE", mode: "sync" },
      ],
      responder,
    });

    try {
      expect(server.endpoints.map((endpoint) => endpoint.name)).toEqual(["plain", "guided"]);
      expect(server.endpoints[1]?.invokeUrl).toBe(`${server.url}/guided`);

      await fetch(`${server.url}/guided`, postJson({ text: "hello", conversationId: "c1", mode: "sync" }));
      await fetch(`${server.url}/plain`, postJson({ text: "hi", conversationId: "c2", mode: "sync" }));

      expect(seen).toContainEqual({ text: "PREAMBLE\n\nhello", endpoint: "guided" });
      expect(seen).toContainEqual({ text: "hi", endpoint: "plain" });
    } finally {
      await server.stop();
    }
  });

  it("namespaces active runs per endpoint so the same conversation is not busy across endpoints", async () => {
    const server = await startWebhookAdapter({
      host: "127.0.0.1",
      port: 0,
      endpoints: [
        { name: "a", path: "/a", mode: "async" },
        { name: "b", path: "/b", mode: "async" },
      ],
      responder: blockingResponder(),
    });

    try {
      const a1 = await fetch(`${server.url}/a`, postJson({ text: "x", conversationId: "same" }));
      expect(a1.status).toBe(202);
      await expect.poll(async () => server.activeRequestCount).toBe(1);

      // Same conversation, different endpoint → must NOT be reported busy.
      const b1 = await fetch(`${server.url}/b`, postJson({ text: "x", conversationId: "same" }));
      expect(b1.status).toBe(202);
      await expect.poll(async () => server.activeRequestCount).toBe(2);

      // Same conversation AND same endpoint → busy.
      const a2 = await fetch(`${server.url}/a`, postJson({ text: "x", conversationId: "same" }));
      expect(a2.status).toBe(409);
      await expect(a2.json()).resolves.toMatchObject({ status: "busy", conversationId: "same" });
    } finally {
      await server.stop();
    }
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

function blockingResponder(): AgentResponder {
  return {
    async respond(request) {
      await new Promise<void>((resolve) => {
        request.abortSignal.addEventListener("abort", () => resolve());
      });
      return { text: "aborted" };
    },
  };
}

function postJson(body: Record<string, unknown>): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

async function invokeSync(url: string, text: string, conversationId: string): Promise<globalThis.Response> {
  return fetch(`${url}/webhook/invoke`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, conversationId, mode: "sync" }),
  });
}
