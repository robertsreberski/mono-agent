import { webcrypto } from "node:crypto";

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agent, bootstrap, thread } from "./test/fixtures";

const storeMock = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));

vi.mock("./console-store", () => ({
  useConsoleStore: () => storeMock.current,
}));
vi.mock("./api", async (importOriginal) => {
  const original = await importOriginal<typeof import("./api")>();
  return {
    ...original,
    api: {
      thread: vi.fn(),
      pushSubscription: vi.fn(),
      registerPushSubscription: vi.fn(),
      deletePushSubscription: vi.fn(),
      testPushSubscription: vi.fn(),
      acknowledgePushEvent: vi.fn(),
    },
  };
});

import { api, ApiError } from "./api";
import {
  NOTIFICATIONS_STORAGE_KEY,
  PUSH_PENDING_DELETE_STORAGE_KEY,
  PUSH_SUBSCRIPTION_ENDPOINT_DIGEST_STORAGE_KEY,
  PUSH_SUBSCRIPTION_ID_STORAGE_KEY,
  NotificationBell,
  NotificationsProvider,
  responseArrivals,
  responseNotificationTitle,
  responsePreview,
} from "./notifications";

const source = agent("agent", { label: "Research agent" });
const running = thread("thread", "agent", {
  title: "Investigation",
  runState: { id: "turn-1", status: "running" },
});
const complete = thread("thread", "agent", {
  title: "Investigation",
  runState: { id: "turn-1", status: "complete" },
});

const createStore = (currentThread = running) => ({
  bootstrap: bootstrap([source], [currentThread]),
  agents: [source],
  threads: [currentThread],
  selectedThread: currentThread,
  selectThread: vi.fn(),
});

class FakeNotification {
  static permission: NotificationPermission = "granted";
  static requestPermission = vi.fn(async (): Promise<NotificationPermission> =>
    FakeNotification.permission,
  );
}

const showNotification = vi.fn().mockResolvedValue(undefined);
const getNotifications = vi.fn().mockResolvedValue([]);
const unsubscribe = vi.fn().mockResolvedValue(true);
const browserSubscription = {
  endpoint: "https://push.example.test/send/opaque",
  expirationTime: null,
  options: { userVisibleOnly: true },
  getKey: vi.fn(),
  unsubscribe,
  toJSON: () => ({
    endpoint: "https://push.example.test/send/opaque",
    expirationTime: null,
    keys: { p256dh: "p256dh", auth: "auth" },
  }),
};
const getSubscription = vi.fn().mockResolvedValue(null);
const subscribe = vi.fn().mockResolvedValue(browserSubscription);
const serviceWorker = {
  ready: Promise.resolve({
    getNotifications,
    showNotification,
    pushManager: { getSubscription, subscribe },
  }),
  controller: null as null | { postMessage: (message: unknown, ports: readonly unknown[]) => void },
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
};

class FakeMessageChannel {
  readonly port1: { onmessage: ((event: { data: unknown }) => void) | null } = { onmessage: null };
  readonly port2 = { reply: (data: unknown) => this.port1.onmessage?.({ data }) };
}

const activeServerSubscription = {
  id: "subscription-1",
  state: "active" as const,
  keyFingerprint: "test-fingerprint",
  createdAt: "2026-08-13T08:00:00.000Z",
  updatedAt: "2026-08-13T08:00:00.000Z",
};

const enablePushSupport = () => {
  vi.stubGlobal("PushManager", class FakePushManager {});
  vi.stubGlobal("MessageChannel", FakeMessageChannel);
  serviceWorker.controller = {
    postMessage: (_message, ports) => {
      (ports[0] as { reply: (data: unknown) => void }).reply({ version: 2 });
    },
  };
};

const endpointDigest = async (endpoint: string): Promise<string> => {
  const digest = await webcrypto.subtle.digest("SHA-256", new TextEncoder().encode(endpoint));
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/gu, "-")
    .replace(/\//gu, "_")
    .replace(/=+$/gu, "");
};

describe("response notifications", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    showNotification.mockResolvedValue(undefined);
    getNotifications.mockResolvedValue([]);
    getSubscription.mockResolvedValue(null);
    subscribe.mockResolvedValue(browserSubscription);
    unsubscribe.mockResolvedValue(true);
    serviceWorker.controller = null;
    vi.mocked(api.pushSubscription).mockResolvedValue(activeServerSubscription);
    vi.mocked(api.registerPushSubscription).mockResolvedValue(activeServerSubscription);
    vi.mocked(api.deletePushSubscription).mockResolvedValue(undefined);
    vi.mocked(api.testPushSubscription).mockResolvedValue(activeServerSubscription);
    vi.mocked(api.acknowledgePushEvent).mockResolvedValue(undefined);
    FakeNotification.requestPermission.mockImplementation(async () =>
      FakeNotification.permission,
    );
    FakeNotification.permission = "granted";
    vi.stubGlobal("Notification", FakeNotification);
    vi.stubGlobal("crypto", webcrypto);
    Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: serviceWorker,
    });
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    Reflect.deleteProperty(window, "isSecureContext");
    Reflect.deleteProperty(navigator, "serviceWorker");
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
  });

  it("finds only newly completed successful runs", () => {
    const previous = new Map([[running.id, { id: "turn-1", status: "running" as const }]]);

    expect(responseArrivals(previous, [complete])).toEqual([
      { thread: complete, turnId: "turn-1" },
    ]);
    expect(responseArrivals(
      new Map([[complete.id, { id: "turn-1", status: "complete" as const }]]),
      [complete],
    )).toEqual([]);
    expect(responseArrivals(previous, [{
      ...complete,
      runState: { id: "turn-1", status: "failed" },
    }])).toEqual([]);
    const notification = {
      ...complete,
      id: "notification-one",
      trigger: { kind: "cron" as const },
    };
    expect(responseArrivals(new Map(), [notification])).toEqual([
      { thread: notification, turnId: "turn-1" },
    ]);
  });

  it("builds a bounded preview from response text only", () => {
    expect(responsePreview({
      thread: complete,
      messages: [{
        id: "response",
        threadId: complete.id,
        turnId: "turn-1",
        role: "assistant",
        parts: [
          { type: "reasoning", text: "private reasoning" },
          { type: "text", text: `Ready ${"now ".repeat(60)}` },
          { type: "error", message: "not included" },
        ],
        attachments: [],
        createdAt: "2026-07-20T10:00:00.000Z",
        updatedAt: "2026-07-20T10:00:00.000Z",
        status: "complete",
      }],
    }, "turn-1")).toMatch(/^Ready .*…$/u);

    const sanitized = responsePreview({
      thread: complete,
      messages: [{
        id: "safe-response",
        threadId: complete.id,
        turnId: "turn-safe",
        role: "assistant",
        parts: [{
          type: "text",
          text: '# **Ready** [open](https://example.test) {"apiKey":"my-secret-value"} token\u202E: another-secret-value',
        }],
        attachments: [],
        createdAt: "2026-07-20T10:00:00.000Z",
        updatedAt: "2026-07-20T10:00:00.000Z",
        status: "complete",
      }],
    }, "turn-safe");
    expect(sanitized).toContain('Ready open {"apiKey":"[redacted]"} token: [redacted]');
    expect(sanitized).not.toMatch(/https:\/\/|my-secret|another-secret|\u202E|\*\*/u);

    const embeddedSeparator = responsePreview({
      thread: complete,
      messages: [{
        id: "separator-response",
        threadId: complete.id,
        turnId: "turn-separator",
        role: "assistant",
        parts: [{
          type: "text",
          text: 'password: "two words" Authorization: Bearer abcdefgh\u200Bijklmnop Bearer abcdefgh\uFEFFqrstuvwx token abcdefgh\u2060ijklmnop basic abcdefgh\u034Fqrstuvwx Bearer abcdefgh\uFFF9ijklmnop',
        }],
        attachments: [],
        createdAt: "2026-07-20T10:00:00.000Z",
        updatedAt: "2026-07-20T10:00:00.000Z",
        status: "complete",
      }],
    }, "turn-separator");
    expect(embeddedSeparator).toBe("password: [redacted] Authorization: [redacted] Bearer [redacted] token [redacted] basic [redacted] Bearer [redacted]");
    expect(embeddedSeparator).not.toMatch(/two words|abcdefgh|ijklmnop|qrstuvwx|[\u00ad\u034f\u200b-\u200f\u2060-\u2064\u3164\ufeff\ufff9]/u);
  });

  it("marks cron and webhook arrivals in browser notification titles", () => {
    expect(responseNotificationTitle("Research agent", complete)).toBe("Research agent replied");
    expect(responseNotificationTitle("Research agent", {
      ...complete,
      trigger: { kind: "cron" },
    })).toBe("Research agent · CRON");
    expect(responseNotificationTitle("Research agent", {
      ...complete,
      trigger: { kind: "webhook" },
    })).toBe("Research agent · WEBHOOK");
  });

  it("shows one service-worker notification when a hidden console receives a response", async () => {
    localStorage.setItem(NOTIFICATIONS_STORAGE_KEY, "1");
    storeMock.current = createStore(running);
    vi.mocked(api.thread).mockResolvedValue({
      thread: complete,
      messages: [{
        id: "response",
        threadId: complete.id,
        turnId: "turn-1",
        role: "assistant",
        parts: [{ type: "text", text: "The investigation is complete." }],
        attachments: [],
        createdAt: "2026-07-20T10:00:00.000Z",
        updatedAt: "2026-07-20T10:00:00.000Z",
        status: "complete",
      }],
    });
    const notificationTree = () => (
      <NotificationsProvider>
        <NotificationBell />
      </NotificationsProvider>
    );
    const view = render(notificationTree());
    expect(screen.getByRole("button", { name: "Disable push notifications" }))
      .toHaveAttribute("aria-pressed", "true");
    await waitFor(() => expect(serviceWorker.addEventListener).toHaveBeenCalled());

    storeMock.current = createStore(complete);
    view.rerender(notificationTree());

    await waitFor(() => expect(api.thread).toHaveBeenCalledWith("thread"));
    await waitFor(() => expect(showNotification).toHaveBeenCalledWith(
      "Research agent replied",
      expect.objectContaining({
        body: "The investigation is complete.",
        tag: "mono-agent-turn-turn-1",
        data: expect.objectContaining({ threadId: "thread" }),
      }),
    ));
    expect(showNotification).toHaveBeenCalledTimes(1);
  });

  it("does not notify for a response that arrives in the focused console", async () => {
    localStorage.setItem(NOTIFICATIONS_STORAGE_KEY, "1");
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    vi.mocked(document.hasFocus).mockReturnValue(true);
    storeMock.current = createStore(running);
    const notificationTree = () => (
      <NotificationsProvider>
        <NotificationBell />
      </NotificationsProvider>
    );
    const view = render(notificationTree());
    await waitFor(() => expect(serviceWorker.addEventListener).toHaveBeenCalled());

    storeMock.current = createStore(complete);
    view.rerender(notificationTree());

    expect(api.thread).not.toHaveBeenCalled();
    expect(showNotification).not.toHaveBeenCalled();
  });

  it("requests permission only from the explicit bell action", async () => {
    FakeNotification.permission = "default";
    storeMock.current = createStore();
    render(
      <NotificationsProvider>
        <NotificationBell />
      </NotificationsProvider>,
    );

    expect(FakeNotification.requestPermission).not.toHaveBeenCalled();
    FakeNotification.requestPermission.mockImplementationOnce(async () => {
      FakeNotification.permission = "granted";
      return "granted";
    });
    fireEvent.click(screen.getByRole("button", { name: "Enable push notifications" }));

    await waitFor(() => expect(localStorage.getItem(NOTIFICATIONS_STORAGE_KEY)).toBe("1"));
    expect(FakeNotification.requestPermission).toHaveBeenCalledOnce();
  });

  it("subscribes and registers only after the explicit bell action, then queues a test", async () => {
    enablePushSupport();
    FakeNotification.permission = "default";
    storeMock.current = createStore();
    render(
      <NotificationsProvider>
        <NotificationBell />
      </NotificationsProvider>,
    );
    FakeNotification.requestPermission.mockImplementationOnce(async () => {
      FakeNotification.permission = "granted";
      return "granted";
    });

    fireEvent.click(screen.getByRole("button", { name: "Enable push notifications" }));

    await waitFor(() => expect(subscribe).toHaveBeenCalledWith(expect.objectContaining({ userVisibleOnly: true })));
    await waitFor(() => expect(api.registerPushSubscription).toHaveBeenCalledWith(browserSubscription, undefined));
    await waitFor(() => expect(api.testPushSubscription).toHaveBeenCalledWith("subscription-1"));
    expect(localStorage.getItem(PUSH_SUBSCRIPTION_ID_STORAGE_KEY)).toBe("subscription-1");
    expect(screen.getByRole("button", { name: "Disable push notifications" }))
      .toHaveAttribute("aria-pressed", "true");
  });

  it("keeps a browser subscription intact when the status request fails transiently", async () => {
    enablePushSupport();
    localStorage.setItem(NOTIFICATIONS_STORAGE_KEY, "1");
    localStorage.setItem(PUSH_SUBSCRIPTION_ID_STORAGE_KEY, "subscription-1");
    getSubscription.mockResolvedValue(browserSubscription);
    vi.mocked(api.pushSubscription).mockRejectedValue(new ApiError("temporarily unavailable", 503));
    storeMock.current = createStore();

    render(
      <NotificationsProvider>
        <NotificationBell />
      </NotificationsProvider>,
    );

    await waitFor(() => expect(api.pushSubscription).toHaveBeenCalledWith("subscription-1"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Reconnect push notifications" })).toBeVisible());
    expect(unsubscribe).not.toHaveBeenCalled();
    expect(api.registerPushSubscription).not.toHaveBeenCalled();
    expect(localStorage.getItem(PUSH_SUBSCRIPTION_ID_STORAGE_KEY)).toBe("subscription-1");
  });

  it("re-registers an existing browser subscription only after a confirmed 404", async () => {
    enablePushSupport();
    localStorage.setItem(NOTIFICATIONS_STORAGE_KEY, "1");
    localStorage.setItem(PUSH_SUBSCRIPTION_ID_STORAGE_KEY, "missing-subscription");
    localStorage.setItem(
      PUSH_SUBSCRIPTION_ENDPOINT_DIGEST_STORAGE_KEY,
      await endpointDigest(browserSubscription.endpoint),
    );
    getSubscription.mockResolvedValue(browserSubscription);
    vi.mocked(api.pushSubscription).mockRejectedValue(new ApiError("not found", 404));
    storeMock.current = createStore();

    render(
      <NotificationsProvider>
        <NotificationBell />
      </NotificationsProvider>,
    );

    await waitFor(() => expect(api.registerPushSubscription).toHaveBeenCalledWith(
      browserSubscription,
      "missing-subscription",
    ));
    expect(unsubscribe).not.toHaveBeenCalled();
    expect(localStorage.getItem(PUSH_SUBSCRIPTION_ID_STORAGE_KEY)).toBe("subscription-1");
  });

  it("detects browser subscription rotation and atomically replaces the stale server id", async () => {
    enablePushSupport();
    localStorage.setItem(NOTIFICATIONS_STORAGE_KEY, "1");
    localStorage.setItem(PUSH_SUBSCRIPTION_ID_STORAGE_KEY, "subscription-1");
    localStorage.setItem(PUSH_SUBSCRIPTION_ENDPOINT_DIGEST_STORAGE_KEY, "old-endpoint-digest");
    getSubscription.mockResolvedValue(browserSubscription);
    vi.mocked(api.registerPushSubscription).mockResolvedValue({
      ...activeServerSubscription,
      id: "subscription-2",
    });
    storeMock.current = createStore();

    render(
      <NotificationsProvider>
        <NotificationBell />
      </NotificationsProvider>,
    );

    await waitFor(() => expect(api.registerPushSubscription).toHaveBeenCalledWith(
      browserSubscription,
      "subscription-1",
    ));
    expect(unsubscribe).not.toHaveBeenCalled();
    expect(localStorage.getItem(PUSH_SUBSCRIPTION_ID_STORAGE_KEY)).toBe("subscription-2");
    expect(localStorage.getItem(PUSH_SUBSCRIPTION_ENDPOINT_DIGEST_STORAGE_KEY))
      .toBe(await endpointDigest(browserSubscription.endpoint));
  });

  it("replaces a browser subscription when its matching server row is expired", async () => {
    enablePushSupport();
    localStorage.setItem(NOTIFICATIONS_STORAGE_KEY, "1");
    localStorage.setItem(PUSH_SUBSCRIPTION_ID_STORAGE_KEY, "subscription-1");
    localStorage.setItem(
      PUSH_SUBSCRIPTION_ENDPOINT_DIGEST_STORAGE_KEY,
      await endpointDigest(browserSubscription.endpoint),
    );
    getSubscription.mockResolvedValue(browserSubscription);
    vi.mocked(api.pushSubscription).mockResolvedValue({
      ...activeServerSubscription,
      state: "expired",
    });
    storeMock.current = createStore();

    render(
      <NotificationsProvider>
        <NotificationBell />
      </NotificationsProvider>,
    );

    await waitFor(() => expect(unsubscribe).toHaveBeenCalledOnce());
    await waitFor(() => expect(subscribe).toHaveBeenCalledOnce());
    await waitFor(() => expect(api.registerPushSubscription).toHaveBeenCalledWith(
      browserSubscription,
      "subscription-1",
    ));
  });

  it("retries pending server deletion while notifications remain disabled", async () => {
    enablePushSupport();
    localStorage.setItem(PUSH_SUBSCRIPTION_ID_STORAGE_KEY, "subscription-1");
    localStorage.setItem(PUSH_PENDING_DELETE_STORAGE_KEY, "subscription-1");
    storeMock.current = createStore();

    render(
      <NotificationsProvider>
        <NotificationBell />
      </NotificationsProvider>,
    );

    await waitFor(() => expect(api.deletePushSubscription).toHaveBeenCalledWith("subscription-1"));
    expect(localStorage.getItem(PUSH_PENDING_DELETE_STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem(PUSH_SUBSCRIPTION_ID_STORAGE_KEY)).toBeNull();
    expect(api.pushSubscription).not.toHaveBeenCalled();
  });

  it("treats an already-deleted pending subscription as completed cleanup", async () => {
    enablePushSupport();
    localStorage.setItem(PUSH_SUBSCRIPTION_ID_STORAGE_KEY, "subscription-1");
    localStorage.setItem(PUSH_PENDING_DELETE_STORAGE_KEY, "subscription-1");
    vi.mocked(api.deletePushSubscription).mockRejectedValue(new ApiError("not found", 404));
    storeMock.current = createStore();

    render(
      <NotificationsProvider>
        <NotificationBell />
      </NotificationsProvider>,
    );

    await waitFor(() => expect(localStorage.getItem(PUSH_PENDING_DELETE_STORAGE_KEY)).toBeNull());
    expect(localStorage.getItem(PUSH_SUBSCRIPTION_ID_STORAGE_KEY)).toBeNull();
    expect(screen.getByRole("button", { name: "Enable push notifications" })).toBeVisible();
  });

  it("acknowledges a pending push only for the exact focused conversation", async () => {
    enablePushSupport();
    localStorage.setItem(NOTIFICATIONS_STORAGE_KEY, "1");
    localStorage.setItem(PUSH_SUBSCRIPTION_ID_STORAGE_KEY, "subscription-1");
    getSubscription.mockResolvedValue(browserSubscription);
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    vi.mocked(document.hasFocus).mockReturnValue(true);
    storeMock.current = createStore(complete);
    render(
      <NotificationsProvider>
        <NotificationBell />
      </NotificationsProvider>,
    );
    await waitFor(() => expect(api.pushSubscription).toHaveBeenCalledWith("subscription-1"));

    window.dispatchEvent(new CustomEvent("mono-agent:push-pending", {
      detail: { eventId: "wrong", threadId: "another-thread", ackToken: "a".repeat(32) },
    }));
    expect(api.acknowledgePushEvent).not.toHaveBeenCalled();
    window.dispatchEvent(new CustomEvent("mono-agent:push-pending", {
      detail: { eventId: "event-1", threadId: complete.id, ackToken: "b".repeat(32) },
    }));
    await waitFor(() => expect(api.acknowledgePushEvent).toHaveBeenCalledWith(
      "event-1",
      "subscription-1",
      "b".repeat(32),
    ));
  });

  it("disables the page-derived fallback after a push subscription is confirmed", async () => {
    enablePushSupport();
    localStorage.setItem(NOTIFICATIONS_STORAGE_KEY, "1");
    localStorage.setItem(PUSH_SUBSCRIPTION_ID_STORAGE_KEY, "subscription-1");
    getSubscription.mockResolvedValue(browserSubscription);
    storeMock.current = createStore(running);
    const notificationTree = () => (
      <NotificationsProvider>
        <NotificationBell />
      </NotificationsProvider>
    );
    const view = render(notificationTree());
    await waitFor(() => expect(api.pushSubscription).toHaveBeenCalledWith("subscription-1"));
    const expectedDigest = await endpointDigest(browserSubscription.endpoint);
    await waitFor(() => expect(localStorage.getItem(PUSH_SUBSCRIPTION_ENDPOINT_DIGEST_STORAGE_KEY))
      .toBe(expectedDigest));

    storeMock.current = createStore(complete);
    view.rerender(notificationTree());

    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
    expect(api.thread).not.toHaveBeenCalled();
    expect(showNotification).not.toHaveBeenCalled();
  });
});
