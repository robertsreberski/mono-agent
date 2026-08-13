import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

import { describe, expect, it, vi } from "vitest";

type WorkerHandler = (event: Record<string, unknown>) => void;

describe("Web Push service worker", () => {
  it("renders declarative payloads and confines navigation to the console origin", async () => {
    const handlers = new Map<string, WorkerHandler>();
    const showNotification = vi.fn(async () => undefined);
    const focus = vi.fn(async () => undefined);
    const postMessage = vi.fn();
    const openWindow = vi.fn(async () => undefined);
    const worker = {
      location: { origin: "https://console.example.test" },
      registration: { showNotification },
      clients: {
        matchAll: vi.fn(async () => [{
          url: "https://console.example.test/?thread=thread-1",
          focus,
          postMessage,
        }]),
        openWindow,
      },
      addEventListener: (type: string, handler: WorkerHandler) => handlers.set(type, handler),
    };
    const source = await readFile(new URL("../../webapp/public/notification-sw.js", import.meta.url), "utf8");
    runInNewContext(source, { self: worker, URL, Date });

    let pushWork: Promise<unknown> | undefined;
    handlers.get("push")?.({
      data: {
        json: () => ({
          web_push: 8030,
          notification: {
            title: "Agent replied",
            body: "Plain preview",
            navigate: "https://attacker.example/escape",
            tag: "mono-agent-event",
            data: { eventId: "event-1", kind: "response.ready", threadId: "thread-1" },
          },
        }),
      },
      waitUntil: (work: Promise<unknown>) => { pushWork = work; },
    });
    await pushWork;

    expect(showNotification).toHaveBeenCalledWith("Agent replied", expect.objectContaining({
      body: "Plain preview",
      tag: "mono-agent-event",
      data: expect.objectContaining({
        eventId: "event-1",
        threadId: "thread-1",
        url: "https://console.example.test/?thread=thread-1",
      }),
    }));

    let clickWork: Promise<unknown> | undefined;
    const close = vi.fn();
    handlers.get("notificationclick")?.({
      notification: {
        close,
        data: { threadId: "thread-1", url: "https://attacker.example/escape" },
      },
      waitUntil: (work: Promise<unknown>) => { clickWork = work; },
    });
    await clickWork;

    expect(close).toHaveBeenCalledOnce();
    expect(focus).toHaveBeenCalledOnce();
    expect(postMessage).toHaveBeenCalledWith({
      type: "mono-agent:select-thread",
      threadId: "thread-1",
    });
    expect(openWindow).not.toHaveBeenCalled();
  });
});
