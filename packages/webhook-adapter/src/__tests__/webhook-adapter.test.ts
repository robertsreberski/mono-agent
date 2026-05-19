import { describe, expect, it } from "vitest";

import type { AgentResponder } from "@worklab-ai/agent-contracts";

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
