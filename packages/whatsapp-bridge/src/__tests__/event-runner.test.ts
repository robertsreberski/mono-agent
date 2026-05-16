import { describe, expect, it, vi } from "vitest";
import type { WhatsAppBridge, WhatsAppMessageHandlingResult } from "../bridge.js";
import { WhatsAppEventRunner } from "../event-runner.js";
import type {
  WhatsAppEventEmitterLike,
  WhatsAppJid,
  WhatsAppSendMessageContent,
  WhatsAppSendMessageOptions,
  WhatsAppSocketLike,
} from "../types.js";

class FakeEmitter implements WhatsAppEventEmitterLike {
  private readonly listeners = new Map<string, Set<(payload: unknown) => void>>();

  on(event: string, listener: (payload: unknown) => void): void {
    const existing = this.listeners.get(event) ?? new Set<(payload: unknown) => void>();
    existing.add(listener);
    this.listeners.set(event, existing);
  }

  off(event: string, listener: (payload: unknown) => void): void {
    this.listeners.get(event)?.delete(listener);
  }

  emit(event: string, payload: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(payload);
    }
  }

  listenerCount(event: string): number {
    return this.listeners.get(event)?.size ?? 0;
  }
}

class FakeSocket implements WhatsAppSocketLike {
  readonly ev = new FakeEmitter();

  async sendMessage(
    _jid: WhatsAppJid,
    _content: WhatsAppSendMessageContent,
    _options?: WhatsAppSendMessageOptions,
  ): Promise<undefined> {
    return undefined;
  }
}

function bridgeWithHandler(
  handler: (message: unknown) => Promise<WhatsAppMessageHandlingResult>,
): WhatsAppBridge {
  return { handleMessage: handler } as unknown as WhatsAppBridge;
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("WhatsAppEventRunner", () => {
  it("attaches and removes Baileys event listeners", () => {
    const socket = new FakeSocket();
    const runner = new WhatsAppEventRunner({
      socket,
      bridge: bridgeWithHandler(async () => ({ kind: "ignored", reason: "empty_text" })),
    });

    runner.start();

    expect(socket.ev.listenerCount("messages.upsert")).toBe(1);
    expect(socket.ev.listenerCount("creds.update")).toBe(1);
    expect(socket.ev.listenerCount("connection.update")).toBe(1);

    runner.stop();

    expect(socket.ev.listenerCount("messages.upsert")).toBe(0);
    expect(socket.ev.listenerCount("creds.update")).toBe(0);
    expect(socket.ev.listenerCount("connection.update")).toBe(0);
  });

  it("processes notify messages sequentially and reports results", async () => {
    const socket = new FakeSocket();
    const order: string[] = [];
    const results: WhatsAppMessageHandlingResult[] = [];
    const runner = new WhatsAppEventRunner({
      socket,
      bridge: bridgeWithHandler(async (message) => {
        const id = typeof message === "object" && message !== null && "id" in message
          ? String((message as { id: unknown }).id)
          : "unknown";
        order.push(`start:${id}`);
        await Promise.resolve();
        order.push(`end:${id}`);
        return { kind: "ignored", reason: "empty_text" };
      }),
      onMessageResult: (result) => {
        results.push(result);
      },
    });
    runner.start();

    socket.ev.emit("messages.upsert", {
      type: "notify",
      messages: [{ id: "a" }, { id: "b" }],
    });
    await runner.idle();

    expect(order).toEqual(["start:a", "end:a", "start:b", "end:b"]);
    expect(results).toHaveLength(2);
  });

  it("ignores history/appended upserts unless explicitly configured", async () => {
    const socket = new FakeSocket();
    const handleMessage = vi.fn(async () => ({ kind: "ignored", reason: "empty_text" }) as const);
    const results: WhatsAppMessageHandlingResult[] = [];
    const runner = new WhatsAppEventRunner({
      socket,
      bridge: bridgeWithHandler(handleMessage),
      onMessageResult: (result) => {
        results.push(result);
      },
    });
    runner.start();

    socket.ev.emit("messages.upsert", { type: "append", messages: [{ id: "history" }] });
    await runner.idle();

    expect(handleMessage).not.toHaveBeenCalled();
    expect(results).toEqual([{ kind: "ignored", reason: "history_sync_ignored" }]);
  });

  it("saves credentials and surfaces connection QR only through explicit callbacks", async () => {
    const socket = new FakeSocket();
    const saveCreds = vi.fn(async () => undefined);
    const onQr = vi.fn();
    const onConnectionUpdate = vi.fn();
    const logger = { info: vi.fn() };
    const runner = new WhatsAppEventRunner({
      socket,
      bridge: bridgeWithHandler(async () => ({ kind: "ignored", reason: "empty_text" })),
      saveCreds,
      onQr,
      onConnectionUpdate,
      logger,
    });
    runner.start();

    socket.ev.emit("creds.update", { secret: "do-not-read" });
    socket.ev.emit("connection.update", { connection: "connecting", qr: "sensitive-qr" });
    await flushMicrotasks();

    expect(saveCreds).toHaveBeenCalledTimes(1);
    expect(onQr).toHaveBeenCalledWith("sensitive-qr");
    expect(onConnectionUpdate).toHaveBeenCalledWith({
      connection: "connecting",
      hasQr: true,
    });
    expect(logger.info).toHaveBeenCalledWith(
      "WhatsApp connection update.",
      expect.objectContaining({ connection: "connecting", hasQr: true }),
    );
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain("sensitive-qr");
  });
});
