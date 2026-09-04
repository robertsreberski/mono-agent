import { createHmac } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createMessengerWebhookServer, type MessengerWebhookServer } from "../server.js";

const appSecret = "app-secret";
let server: MessengerWebhookServer | undefined;

afterEach(async () => {
  await server?.stop();
  server = undefined;
});

async function startServer(onPayload = vi.fn()): Promise<{ base: string; onPayload: ReturnType<typeof vi.fn> }> {
  server = createMessengerWebhookServer({
    host: "127.0.0.1",
    port: 0,
    webhookPath: "/messenger/webhook",
    verifyToken: "verify-me",
    appSecret,
    maxBodyBytes: 256,
    onPayload,
  });
  const { port } = await server.start();
  return { base: `http://127.0.0.1:${port}`, onPayload };
}

function sign(body: string): string {
  return `sha256=${createHmac("sha256", appSecret).update(body).digest("hex")}`;
}

describe("createMessengerWebhookServer", () => {
  it("answers the verification handshake only with the right token", async () => {
    const { base } = await startServer();
    const ok = await fetch(`${base}/messenger/webhook?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=12345`);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe("12345");
    const bad = await fetch(`${base}/messenger/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1`);
    expect(bad.status).toBe(403);
  });

  it("accepts a signed payload, acks 200, and hands the parsed body to onPayload", async () => {
    const { base, onPayload } = await startServer();
    const body = JSON.stringify({ object: "page", entry: [] });
    const response = await fetch(`${base}/messenger/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-hub-signature-256": sign(body) },
      body,
    });
    expect(response.status).toBe(200);
    await vi.waitFor(() => expect(onPayload).toHaveBeenCalledWith({ object: "page", entry: [] }));
  });

  it("rejects missing, invalid, and oversized requests", async () => {
    const { base, onPayload } = await startServer();
    const body = JSON.stringify({ object: "page" });
    expect((await fetch(`${base}/messenger/webhook`, { method: "POST", body })).status).toBe(400);
    expect((await fetch(`${base}/messenger/webhook`, {
      method: "POST",
      headers: { "x-hub-signature-256": `sha256=${"0".repeat(64)}` },
      body,
    })).status).toBe(401);
    expect((await fetch(`${base}/messenger/webhook`, {
      method: "POST",
      headers: { "x-hub-signature-256": sign("{not json") },
      body: "{not json",
    })).status).toBe(400);
    const huge = "x".repeat(1_000);
    const oversized = await fetch(`${base}/messenger/webhook`, {
      method: "POST",
      headers: { "x-hub-signature-256": sign(huge) },
      body: huge,
    }).catch(() => undefined);
    expect(oversized === undefined || oversized.status === 413).toBe(true);
    expect(onPayload).not.toHaveBeenCalled();
  });

  it("serves health and 404s everything else", async () => {
    const { base } = await startServer();
    const health = await fetch(`${base}/messenger/webhook/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true, channel: "messenger" });
    expect((await fetch(`${base}/other`)).status).toBe(404);
    expect((await fetch(`${base}/messenger/webhook`, { method: "PUT" })).status).toBe(405);
  });
});
