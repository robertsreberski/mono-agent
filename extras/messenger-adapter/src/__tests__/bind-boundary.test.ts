import { describe, expect, it, vi } from "vitest";

import type { AgentResponder } from "../adapter.js";
import { MessengerAdapterConfigError, type MessengerAdapterConfig } from "../config.js";
import { createMessengerWebhookServer } from "../server.js";
import { startMessengerAdapter } from "../start.js";

const responder: AgentResponder = { respond: async () => ({ text: "ok" }) };

/**
 * A config that never went through `loadMessengerAdapterConfig` — the exact
 * shape a programmatic caller can hand to the public entry points.
 */
function handBuiltConfig(overrides: Partial<MessengerAdapterConfig> = {}): MessengerAdapterConfig {
  return {
    enabled: true,
    pageAccessToken: "page-token",
    appSecret: "app-secret",
    verifyToken: "verify-token",
    allowedUserIds: ["42"],
    allowAllUsers: false,
    host: "127.0.0.1",
    port: 0,
    webhookPath: "/messenger/webhook",
    apiVersion: "v21.0",
    allowNonLoopback: false,
    proactiveMessagingType: "RESPONSE",
    ...overrides,
  };
}

describe("startMessengerAdapter revalidation", () => {
  it("refuses a contradictory non-loopback config that never passed the loader", async () => {
    const createServer = vi.fn();

    await expect(startMessengerAdapter({
      config: handBuiltConfig({ host: "0.0.0.0" }),
      responder,
      createServer: createServer as never,
    })).rejects.toBeInstanceOf(MessengerAdapterConfigError);

    // Rejected before anything could bind.
    expect(createServer).not.toHaveBeenCalled();
  });

  it("refuses an enabled config with a missing credential", async () => {
    await expect(startMessengerAdapter({
      config: handBuiltConfig({ verifyToken: "" }),
      responder,
      createServer: (() => {
        throw new Error("must not construct a server");
      }) as never,
    })).rejects.toBeInstanceOf(MessengerAdapterConfigError);
  });

  it("refuses an enabled config with neither an allowlist nor allow-all", async () => {
    await expect(startMessengerAdapter({
      config: handBuiltConfig({ allowedUserIds: [], allowAllUsers: false }),
      responder,
      createServer: (() => {
        throw new Error("must not construct a server");
      }) as never,
    })).rejects.toBeInstanceOf(MessengerAdapterConfigError);
  });

  it("starts on loopback and carries the opt-in into the bind layer", async () => {
    const createServer = vi.fn(() => ({
      start: async () => ({ host: "127.0.0.1", port: 8650 }),
      stop: async () => undefined,
    }));

    const started = await startMessengerAdapter({
      config: handBuiltConfig(),
      responder,
      client: {
        sendText: async () => ({ messageIds: [] }),
        sendAttachmentUrl: async () => ({ messageIds: [] }),
        senderAction: async () => undefined,
      },
      createServer,
    });

    expect(createServer).toHaveBeenCalledWith(expect.objectContaining({ allowNonLoopback: false }));
    await started.stop();
  });

  it("passes an explicit non-loopback opt-in through to the bind layer", async () => {
    const createServer = vi.fn(() => ({
      start: async () => ({ host: "0.0.0.0", port: 8650 }),
      stop: async () => undefined,
    }));

    const started = await startMessengerAdapter({
      config: handBuiltConfig({ host: "0.0.0.0", allowNonLoopback: true }),
      responder,
      client: {
        sendText: async () => ({ messageIds: [] }),
        sendAttachmentUrl: async () => ({ messageIds: [] }),
        senderAction: async () => undefined,
      },
      createServer,
    });

    expect(createServer).toHaveBeenCalledWith(expect.objectContaining({ host: "0.0.0.0", allowNonLoopback: true }));
    await started.stop();
  });
});

describe("createMessengerWebhookServer bind gate", () => {
  it("refuses to listen on a non-loopback host without the opt-in", async () => {
    const server = createMessengerWebhookServer({
      host: "0.0.0.0",
      port: 0,
      webhookPath: "/messenger/webhook",
      verifyToken: "verify-me",
      appSecret: "app-secret",
      allowNonLoopback: false,
      onPayload: () => undefined,
    });

    await expect(server.start()).rejects.toBeInstanceOf(MessengerAdapterConfigError);
    // No socket was opened, so stop() has nothing to close.
    await expect(server.stop()).resolves.toBeUndefined();
  });

  it("binds loopback without an opt-in", async () => {
    const server = createMessengerWebhookServer({
      host: "127.0.0.1",
      port: 0,
      webhookPath: "/messenger/webhook",
      verifyToken: "verify-me",
      appSecret: "app-secret",
      allowNonLoopback: false,
      onPayload: () => undefined,
    });

    const listening = await server.start();
    expect(listening.host).toBe("127.0.0.1");
    await server.stop();
  });
});
