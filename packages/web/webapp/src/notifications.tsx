import { createContext, type ReactNode, useCallback, useContext, useEffect, useRef, useState } from "react";
import { api, ApiError } from "./api";
import { Icon } from "./components/Icon";
import { useConsoleStore } from "./console-store";
import type { PushBootstrap, PushSubscriptionStatus, ThreadDetail, ThreadSummary } from "./types";

export const NOTIFICATIONS_STORAGE_KEY = "mono-agent.web.notifications-enabled";
export const PUSH_SUBSCRIPTION_ID_STORAGE_KEY = "mono-agent.web.push-subscription-id";
export const PUSH_SUBSCRIPTION_ENDPOINT_DIGEST_STORAGE_KEY = "mono-agent.web.push-endpoint-sha256";
export const PUSH_PENDING_DELETE_STORAGE_KEY = "mono-agent.web.push-pending-delete";
const NOTIFICATION_MESSAGE_TYPE = "mono-agent:select-thread";
const PUSH_CHANGE_MESSAGE_TYPE = "mono-agent:push-subscription-change";
const PUSH_PENDING_EVENT_TYPE = "mono-agent:push-pending";
const SERVICE_WORKER_VERSION_REQUEST = "mono-agent:notification-sw-version";

export type NotificationPreference =
  | "unsupported"
  | "prompt"
  | "disabled"
  | "enabled"
  | "denied"
  | "degraded";

interface RunSnapshot {
  readonly id?: string;
  readonly status: ThreadSummary["runState"]["status"];
}

export interface ResponseArrival {
  readonly thread: ThreadSummary;
  readonly turnId: string;
}

interface PendingPushDetail {
  readonly eventId: string;
  readonly threadId: string;
  readonly ackToken: string;
}

const runSnapshots = (threads: readonly ThreadSummary[]): ReadonlyMap<string, RunSnapshot> =>
  new Map(threads.map((thread) => [thread.id, {
    ...(thread.runState.id === undefined ? {} : { id: thread.runState.id }),
    status: thread.runState.status,
  }]));

export const responseArrivals = (
  previous: ReadonlyMap<string, RunSnapshot>,
  threads: readonly ThreadSummary[],
): readonly ResponseArrival[] => threads.flatMap((thread) => {
  const turnId = thread.runState.id;
  if (!turnId || thread.runState.status !== "complete") return [];
  const prior = previous.get(thread.id);
  return prior?.id === turnId && prior.status === "complete"
    ? []
    : [{ thread, turnId }];
});

export const responsePreview = (detail: ThreadDetail, turnId: string): string | undefined => {
  const message = [...detail.messages].reverse().find(
    (candidate) =>
      candidate.turnId === turnId &&
      candidate.role === "assistant" &&
      candidate.status === "complete",
  );
  const text = message?.parts
    .flatMap((part) => part.type === "text" ? [part.text] : [])
    .join(" ");
  return text ? plainNotificationPreview(text) : undefined;
};

export const responseNotificationTitle = (agentLabel: string, thread: ThreadSummary): string =>
  thread.trigger === undefined
    ? `${agentLabel} replied`
    : `${agentLabel} · ${thread.trigger.kind.toUpperCase()}`;

const pageNotificationsSupported = (): boolean =>
  window.isSecureContext === true &&
  typeof Notification !== "undefined" &&
  "serviceWorker" in navigator;

const pushSupported = (): boolean =>
  pageNotificationsSupported() && "PushManager" in window;

const preference = (): NotificationPreference => {
  if (!pageNotificationsSupported()) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  if (Notification.permission === "default") return "prompt";
  return localStorage.getItem(NOTIFICATIONS_STORAGE_KEY) === "1" ? "enabled" : "disabled";
};

const dispatchNotice = (message: string): void => {
  window.dispatchEvent(new CustomEvent("mono-agent:notice", { detail: { message } }));
};

interface NotificationsValue {
  readonly preference: NotificationPreference;
  readonly toggle: () => Promise<void>;
}

const NotificationsContext = createContext<NotificationsValue | null>(null);

export function NotificationsProvider({ children }: { readonly children: ReactNode }) {
  const store = useConsoleStore();
  const [currentPreference, setCurrentPreference] = useState<NotificationPreference>(preference);
  const [pushActive, setPushActive] = useState(false);
  const previousRuns = useRef<ReadonlyMap<string, RunSnapshot> | null>(null);
  const notifiedTurns = useRef(new Set<string>());
  const handledDeepLink = useRef<string | null>(null);
  const pendingThreadSelection = useRef<string | null>(null);
  const reconciling = useRef(false);

  const reconcile = useCallback(async (allowCreate: boolean) => {
    if (reconciling.current || !store.bootstrap || !pushSupported()) return;
    reconciling.current = true;
    const wantsPush = localStorage.getItem(NOTIFICATIONS_STORAGE_KEY) === "1"
      && Notification.permission === "granted";
    try {
      await finishPendingDeletion();
      if (!wantsPush) {
        setPushActive(false);
        return;
      }
      const registration = await navigator.serviceWorker.ready;
      const controlled = await assertServiceWorkerVersion(store.bootstrap.push);
      if (!controlled) {
        setPushActive(false);
        setCurrentPreference("degraded");
        return;
      }
      let browserSubscription = await registration.pushManager.getSubscription();
      let subscriptionId = localStorage.getItem(PUSH_SUBSCRIPTION_ID_STORAGE_KEY);
      const previousSubscriptionId = subscriptionId ?? undefined;
      let serverSubscription: PushSubscriptionStatus | undefined;
      if (subscriptionId) {
        try {
          serverSubscription = await api.pushSubscription(subscriptionId);
        } catch (error) {
          if (!isNotFound(error)) throw error;
        }
      }
      let endpointDigest = browserSubscription === null
        ? undefined
        : await pushEndpointDigest(browserSubscription.endpoint);
      const storedEndpointDigest = localStorage.getItem(PUSH_SUBSCRIPTION_ENDPOINT_DIGEST_STORAGE_KEY);
      const rotated = browserSubscription !== null
        && storedEndpointDigest !== null
        && endpointDigest !== storedEndpointDigest;
      const keyChanged = serverSubscription !== undefined
        && serverSubscription.keyFingerprint !== store.bootstrap.push.keyFingerprint;
      const currentEndpointInactive = serverSubscription !== undefined
        && serverSubscription.state !== "active"
        && !rotated;
      if (browserSubscription && (keyChanged || currentEndpointInactive)) {
        await browserSubscription.unsubscribe().catch(() => false);
        browserSubscription = null;
        serverSubscription = undefined;
        endpointDigest = undefined;
      }
      if (!browserSubscription && allowCreate) {
        browserSubscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: applicationServerKey(store.bootstrap.push.applicationServerKey),
        });
        endpointDigest = await pushEndpointDigest(browserSubscription.endpoint);
      }
      const registrationNeeded = browserSubscription !== null && (
        serverSubscription === undefined
        || subscriptionId === null
        || rotated
        || storedEndpointDigest === null
        || serverSubscription.state !== "active"
        || keyChanged
      );
      if (browserSubscription && registrationNeeded) {
        serverSubscription = await api.registerPushSubscription(browserSubscription, previousSubscriptionId);
        subscriptionId = serverSubscription.id;
        localStorage.setItem(PUSH_SUBSCRIPTION_ID_STORAGE_KEY, subscriptionId);
      }
      if (browserSubscription && endpointDigest !== undefined) {
        localStorage.setItem(PUSH_SUBSCRIPTION_ENDPOINT_DIGEST_STORAGE_KEY, endpointDigest);
      } else {
        localStorage.removeItem(PUSH_SUBSCRIPTION_ENDPOINT_DIGEST_STORAGE_KEY);
      }
      const configError = serverSubscription?.lastErrorCode === "push_service_401"
        || serverSubscription?.lastErrorCode === "push_service_403";
      const active = Boolean(browserSubscription && serverSubscription?.state === "active" && !configError
        && serverSubscription.keyFingerprint === store.bootstrap.push.keyFingerprint);
      setPushActive(active);
      setCurrentPreference(active ? "enabled" : "degraded");
    } catch {
      setPushActive(false);
      if (wantsPush) setCurrentPreference("degraded");
    } finally {
      reconciling.current = false;
    }
  }, [store.bootstrap]);

  const toggle = useCallback(async () => {
    if (!pageNotificationsSupported()) {
      dispatchNotice("Push notifications require a secure browser context.");
      setCurrentPreference("unsupported");
      return;
    }
    if (Notification.permission === "denied") {
      localStorage.removeItem(NOTIFICATIONS_STORAGE_KEY);
      setCurrentPreference("denied");
      dispatchNotice("Notifications are blocked in this browser's site settings.");
      return;
    }
    if (currentPreference === "enabled" && localStorage.getItem(NOTIFICATIONS_STORAGE_KEY) === "1") {
      localStorage.removeItem(NOTIFICATIONS_STORAGE_KEY);
      setPushActive(false);
      setCurrentPreference("disabled");
      const id = localStorage.getItem(PUSH_SUBSCRIPTION_ID_STORAGE_KEY);
      if (id) {
        localStorage.setItem(PUSH_PENDING_DELETE_STORAGE_KEY, id);
        await finishPendingDeletion().catch(() => undefined);
      }
      const registration = await navigator.serviceWorker.ready;
      await (await registration.pushManager.getSubscription())?.unsubscribe().catch(() => false);
      localStorage.removeItem(PUSH_SUBSCRIPTION_ENDPOINT_DIGEST_STORAGE_KEY);
      return;
    }
    const permission = Notification.permission === "granted"
      ? "granted"
      : await Notification.requestPermission();
    if (permission !== "granted") {
      localStorage.removeItem(NOTIFICATIONS_STORAGE_KEY);
      setCurrentPreference(permission === "denied" ? "denied" : "prompt");
      if (permission === "denied") dispatchNotice("Notifications are blocked in this browser's site settings.");
      return;
    }
    localStorage.setItem(NOTIFICATIONS_STORAGE_KEY, "1");
    if (!pushSupported()) {
      setPushActive(false);
      setCurrentPreference("enabled");
      dispatchNotice("Background push is unavailable here. On iPhone or iPad, add the console to the Home Screen over HTTPS; until then the page must remain open.");
      return;
    }
    await reconcile(true);
    const id = localStorage.getItem(PUSH_SUBSCRIPTION_ID_STORAGE_KEY);
    if (id) {
      await api.testPushSubscription(id).catch(() => {
        dispatchNotice("Push was connected, but the test notification could not be queued.");
      });
    } else {
      localStorage.removeItem(NOTIFICATIONS_STORAGE_KEY);
      setCurrentPreference("degraded");
      dispatchNotice("Push could not be connected. Reload after the service worker finishes updating and try again.");
    }
  }, [currentPreference, reconcile]);

  useEffect(() => {
    if (!store.bootstrap) return;
    void reconcile(Notification.permission === "granted");
  }, [reconcile, store.bootstrap]);

  useEffect(() => {
    const onPending = (event: Event) => {
      if (!pushActive || document.visibilityState !== "visible" || !document.hasFocus()) return;
      const detail = (event as CustomEvent<unknown>).detail;
      if (!isPendingPushDetail(detail) || store.selectedThread?.id !== detail.threadId) return;
      const subscriptionId = localStorage.getItem(PUSH_SUBSCRIPTION_ID_STORAGE_KEY);
      if (!subscriptionId) return;
      void api.acknowledgePushEvent(detail.eventId, subscriptionId, detail.ackToken).catch(() => undefined);
    };
    window.addEventListener(PUSH_PENDING_EVENT_TYPE, onPending);
    return () => window.removeEventListener(PUSH_PENDING_EVENT_TYPE, onPending);
  }, [pushActive, store.selectedThread?.id]);

  useEffect(() => {
    const onMessage = (event: MessageEvent<unknown>) => {
      const data = event.data;
      if (typeof data !== "object" || data === null || Array.isArray(data)) return;
      const payload = data as { type?: unknown; threadId?: unknown };
      if (payload.type === PUSH_CHANGE_MESSAGE_TYPE) {
        void reconcile(true);
        return;
      }
      if (payload.type !== NOTIFICATION_MESSAGE_TYPE || typeof payload.threadId !== "string") return;
      pendingThreadSelection.current = payload.threadId;
      if (store.threads.some((thread) => thread.id === payload.threadId)) {
        store.selectThread(payload.threadId);
        pendingThreadSelection.current = null;
      }
    };
    navigator.serviceWorker?.addEventListener("message", onMessage);
    return () => navigator.serviceWorker?.removeEventListener("message", onMessage);
  }, [reconcile, store]);

  useEffect(() => {
    const threadId = pendingThreadSelection.current;
    if (!threadId || !store.threads.some((thread) => thread.id === threadId)) return;
    store.selectThread(threadId);
    pendingThreadSelection.current = null;
  }, [store]);

  useEffect(() => {
    const url = new URL(window.location.href);
    const threadId = url.searchParams.get("thread");
    if (!threadId || handledDeepLink.current === threadId) return;
    if (!store.threads.some((thread) => thread.id === threadId)) return;
    handledDeepLink.current = threadId;
    store.selectThread(threadId);
    url.searchParams.delete("thread");
    window.history.replaceState(window.history.state, "", url);
  }, [store]);

  // Keep the existing page-derived response path only as a compatibility
  // fallback for browsers that do not yet have a confirmed server subscription.
  useEffect(() => {
    if (!store.bootstrap) return;
    const nextRuns = runSnapshots(store.bootstrap.threads);
    const previous = previousRuns.current;
    previousRuns.current = nextRuns;
    if (previous === null) return;

    for (const arrival of responseArrivals(previous, store.bootstrap.threads)) {
      if (notifiedTurns.current.has(arrival.turnId)) continue;
      notifiedTurns.current.add(arrival.turnId);
      if (
        pushActive ||
        (currentPreference !== "enabled" && currentPreference !== "degraded") ||
        Notification.permission !== "granted" ||
        (document.visibilityState === "visible" && document.hasFocus())
      ) continue;

      const agent = store.agents.find((candidate) => candidate.sourceId === arrival.thread.sourceId);
      void (async () => {
        try {
          const detail = await api.thread(arrival.thread.id);
          const registration = await navigator.serviceWorker.ready;
          const tag = `mono-agent-turn-${arrival.turnId}`;
          if ((await registration.getNotifications({ tag })).length > 0) return;
          const target = new URL(window.location.href);
          target.searchParams.set("thread", arrival.thread.id);
          await registration.showNotification(
            responseNotificationTitle(agent?.label ?? "mono-agent", arrival.thread),
            {
              body: responsePreview(detail, arrival.turnId) ?? `Response ready in ${arrival.thread.title}.`,
              tag,
              icon: "/icon-192.png",
              badge: "/icon-192.png",
              data: { threadId: arrival.thread.id, url: target.href },
            },
          );
        } catch {
          dispatchNotice("The response arrived, but its notification could not be shown.");
        }
      })();
    }
  }, [currentPreference, pushActive, store]);

  return (
    <NotificationsContext.Provider value={{ preference: currentPreference, toggle }}>
      {children}
    </NotificationsContext.Provider>
  );
}

export function NotificationBell() {
  const notifications = useContext(NotificationsContext);
  if (!notifications) throw new Error("NotificationBell must be used inside NotificationsProvider.");
  const enabled = notifications.preference === "enabled";
  const unavailable = notifications.preference === "unsupported";
  const blocked = notifications.preference === "denied";
  const degraded = notifications.preference === "degraded";
  const label = enabled
    ? "Disable push notifications"
    : blocked
      ? "Push notifications blocked"
      : unavailable
        ? "Push notifications unavailable"
        : degraded
          ? "Reconnect push notifications"
          : "Enable push notifications";
  return (
    <button
      type="button"
      className={`icon-button header-notifications${enabled ? " is-enabled" : ""}${degraded ? " is-degraded" : ""}`}
      aria-label={label}
      aria-pressed={enabled}
      title={label}
      disabled={unavailable}
      onClick={() => void notifications.toggle()}
    >
      <Icon name={blocked ? "bell-off" : "bell"} size={17} />
    </button>
  );
}

async function assertServiceWorkerVersion(push: PushBootstrap): Promise<boolean> {
  const controller = navigator.serviceWorker.controller;
  if (!controller || typeof MessageChannel === "undefined") return false;
  return await new Promise<boolean>((resolvePromise) => {
    const channel = new MessageChannel();
    const timer = window.setTimeout(() => resolvePromise(false), 1_000);
    channel.port1.onmessage = (event: MessageEvent<unknown>) => {
      window.clearTimeout(timer);
      const data = event.data as { version?: unknown } | null;
      resolvePromise(data?.version === push.serviceWorkerVersion);
    };
    controller.postMessage({ type: SERVICE_WORKER_VERSION_REQUEST }, [channel.port2]);
  });
}

async function finishPendingDeletion(): Promise<void> {
  const pending = localStorage.getItem(PUSH_PENDING_DELETE_STORAGE_KEY);
  if (!pending) return;
  try {
    await api.deletePushSubscription(pending);
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
  localStorage.removeItem(PUSH_PENDING_DELETE_STORAGE_KEY);
  if (localStorage.getItem(PUSH_SUBSCRIPTION_ID_STORAGE_KEY) === pending) {
    localStorage.removeItem(PUSH_SUBSCRIPTION_ID_STORAGE_KEY);
  }
}

function isNotFound(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}

async function pushEndpointDigest(endpoint: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(endpoint));
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/gu, "-")
    .replace(/\//gu, "_")
    .replace(/=+$/gu, "");
}

function applicationServerKey(value: string): Uint8Array<ArrayBuffer> {
  const normalized = value.replace(/-/gu, "+").replace(/_/gu, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function isPendingPushDetail(value: unknown): value is PendingPushDetail {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.eventId === "string"
    && typeof record.threadId === "string"
    && typeof record.ackToken === "string";
}

function plainNotificationPreview(value: string): string {
  let text = decodeNotificationEntities([...value].slice(0, 8_192).join(""))
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\p{Cf}\p{Default_Ignorable_Code_Point}]/gu, "")
    .replace(/```[^\n]*\n?/gu, " ")
    .replace(/~~~[^\n]*\n?/gu, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
    .replace(/<https?:\/\/[^>]+>/giu, " ")
    .replace(/<[^>]*>/gu, " ")
    .replace(/^\s{0,3}(?:#{1,6}|>|[-+*]|\d+[.)])\s+/gmu, "")
    .replace(/(^|\s)[*_~]{1,3}([^\s][\s\S]*?)[*_~]{1,3}(?=\s|$|[.,!?;:])/gu, "$1$2")
    .replace(/`+/gu, "");
  text = redactNotificationSecrets(text)
    .replace(/\s+/gu, " ")
    .trim();
  text = redactNotificationSecrets(text);
  const points = [...text];
  return points.length <= 180 ? text : `${points.slice(0, 179).join("").trimEnd()}…`;
}

function redactNotificationSecrets(value: string): string {
  return value
    .replace(/(https?:\/\/)[^\s/@:]+(?::[^\s/@]*)?@/giu, "$1[redacted]@")
    .replace(/([?&](?:access_token|api[_-]?key|auth|key|password|secret|signature|token)=)[^&#\s]*/giu, "$1[redacted]")
    .replace(/\b(authorization\s*:\s*)(?:basic|bearer|token)\s+[^\s,;]+/giu, "$1[redacted]")
    .replace(/\b(basic|bearer|token)\s+[a-z\d._~+\/-]{8,}={0,2}\b/giu, "$1 [redacted]")
    .replace(/(^|[\s{[(,])(["'](?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd|secret|token)["']\s*[:=]\s*)(["'])(?:\\.|(?!\3)[\s\S])*\3/gimu, "$1$2$3[redacted]$3")
    .replace(/(^|[\s{[(,])(["'](?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd|secret|token)["']\s*[:=]\s*)[^\s"',;}]+/gimu, "$1$2[redacted]")
    .replace(/\b((?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd|secret|token)\s*[:=]\s*)(?:"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|"(?:\\.|[^,;\n])*|'(?:\\.|[^,;\n])*|[^\s,;]+)/giu, "$1[redacted]")
    .replace(/(--(?:api[_-]?key|token|password|secret)(?:=|\s+))(?:"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|"(?:\\.|[^,;\n])*|'(?:\\.|[^,;\n])*|[^\s,;]+)/giu, "$1[redacted]")
    .replace(/\b(?:gh[opusr]_[a-z\d]{20,}|sk-[a-z\d_-]{20,}|xox[baprs]-[a-z\d-]{20,})\b/giu, "[redacted]");
}

function decodeNotificationEntities(value: string): string {
  const named: Readonly<Record<string, string>> = {
    amp: "&", apos: "'", gt: ">", lt: "<", nbsp: " ", quot: "\"",
  };
  return value.replace(/&(?:#(\d{1,7})|#x([\da-f]{1,6})|([a-z]+));/giu, (match, decimal, hex, name) => {
    if (typeof name === "string") return named[name.toLowerCase()] ?? match;
    const codePoint = Number.parseInt((decimal ?? hex) as string, decimal === undefined ? 16 : 10);
    if (!Number.isSafeInteger(codePoint) || codePoint <= 0 || codePoint > 0x10ffff) return " ";
    try {
      return String.fromCodePoint(codePoint);
    } catch {
      return " ";
    }
  });
}
