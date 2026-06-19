import { describe, expect, it, vi } from "vitest";

import type { AgentResponder } from "@mono-agent/agent-contracts";

import { startWebhookAdapter } from "../index.js";

describe("Webhook adapter", () => {
  it("routes a notify endpoint to the proactive notifier instead of a headless turn", async () => {
    const respond = vi.fn(async () => ({}));
    const notified: { conversationId: string; text: string }[] = [];
    const server = await startWebhookAdapter({
      host: "127.0.0.1",
      port: 0,
      responder: { respond } satisfies AgentResponder,
      notify: async (input) => {
        notified.push(input);
      },
      endpoints: [
        { name: "gmail-scan", path: "/hooks/gmail", mode: "sync", prompt: "A new email arrived.", notify: "telegram:7" },
      ],
    });

    try {
      const response = await fetch(`${server.url}/hooks/gmail`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "from: boss; subject: urgent" }),
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({ status: "succeeded" });
      expect(respond).not.toHaveBeenCalled();
      expect(notified).toEqual([
        {
          conversationId: "telegram:7",
          text: 'Proactive trigger from webhook "gmail-scan".\n\nA new email arrived.\n\nfrom: boss; subject: urgent',
        },
      ]);
    } finally {
      await server.stop();
    }
  });


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

  it("accepts async invocations and exposes in-memory request status", async () => {
    let finish!: () => void;
    const responder: AgentResponder = {
      async respond(_request, stream) {
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        await stream.append("async done");
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

      await expect.poll(async () => {
        const response = await fetch(`${server.url}${acceptedBody.statusUrl}`);
        return await response.json();
      }).toMatchObject({ status: "succeeded", text: "async done" });
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
