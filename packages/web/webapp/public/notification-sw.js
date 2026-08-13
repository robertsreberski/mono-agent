const NOTIFICATION_SW_VERSION = 2;
const SELECT_THREAD_MESSAGE = "mono-agent:select-thread";
const SUBSCRIPTION_REPAIR_DELAYS_MS = [0, 1_000, 3_000];

self.addEventListener("message", (event) => {
  if (event.data?.type !== "mono-agent:notification-sw-version") return;
  event.ports[0]?.postMessage({ version: NOTIFICATION_SW_VERSION });
});

self.addEventListener("push", (event) => {
  event.waitUntil((async () => {
    let parsed;
    try {
      parsed = event.data?.json();
    } catch {
      parsed = undefined;
    }
    const notification = parsed?.web_push === 8030 && isRecord(parsed.notification)
      ? parsed.notification
      : {};
    const title = boundedText(notification.title, "mono-agent update");
    const body = boundedText(notification.body, "Open the console to view the update.");
    const data = isRecord(notification.data) ? notification.data : {};
    const threadId = typeof data.threadId === "string" ? data.threadId : undefined;
    const navigate = sameOriginNavigate(notification.navigate, threadId);
    await self.registration.showNotification(title, {
      body,
      tag: boundedText(notification.tag, `mono-agent-${Date.now()}`),
      silent: notification.silent === true,
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      data: {
        schema: "mono-agent.web-push.v1",
        ...(typeof data.eventId === "string" ? { eventId: data.eventId } : {}),
        ...(typeof data.kind === "string" ? { kind: data.kind } : {}),
        ...(threadId === undefined ? {} : { threadId }),
        url: navigate,
      },
    });
  })());
});

self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil((async () => {
    let registrationFailure;
    try {
      const subscription = event.newSubscription
        ?? await self.registration.pushManager.getSubscription();
      if (subscription) await repairChangedSubscription(subscription, event.oldSubscription);
    } catch (error) {
      registrationFailure = error;
    }
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of windows) client.postMessage({ type: "mono-agent:push-subscription-change" });
    if (registrationFailure) throw registrationFailure;
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = isRecord(event.notification.data) ? event.notification.data : {};
  const threadId = typeof data.threadId === "string" ? data.threadId : undefined;
  const url = sameOriginNavigate(data.url, threadId);
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const sameOrigin = windows.filter((client) => {
      try {
        return new URL(client.url).origin === self.location.origin;
      } catch {
        return false;
      }
    });
    const matching = threadId === undefined
      ? undefined
      : sameOrigin.find((client) => new URL(client.url).searchParams.get("thread") === threadId);
    const target = matching ?? sameOrigin[0];
    if (target) {
      await target.focus();
      if (threadId) target.postMessage({ type: SELECT_THREAD_MESSAGE, threadId });
      return;
    }
    await self.clients.openWindow(url);
  })());
});

function sameOriginNavigate(value, threadId) {
  let target;
  try {
    target = new URL(typeof value === "string" ? value : "/", self.location.origin);
  } catch {
    target = new URL("/", self.location.origin);
  }
  if (target.origin !== self.location.origin) target = new URL("/", self.location.origin);
  if (threadId) target.searchParams.set("thread", threadId);
  return target.href;
}

function boundedText(value, fallback) {
  if (typeof value !== "string") return fallback;
  const text = value
    .replace(/[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu, "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (!text) return fallback;
  const points = [...text];
  return points.length <= 180 ? text : `${points.slice(0, 179).join("").trimEnd()}…`;
}

async function registerChangedSubscription(subscription, oldSubscription) {
  const serialized = subscription.toJSON();
  if (typeof serialized?.keys?.p256dh !== "string" || typeof serialized.keys.auth !== "string") {
    const error = new Error("The rotated push subscription is incomplete.");
    error.retryable = false;
    throw error;
  }
  const response = await fetch("/api/v1/push/subscriptions", {
    method: "PUT",
    credentials: "same-origin",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-Mono-Agent-Web-Origin": self.location.origin,
    },
    body: JSON.stringify({
      endpoint: subscription.endpoint,
      expirationTime: subscription.expirationTime,
      keys: { p256dh: serialized.keys.p256dh, auth: serialized.keys.auth },
      ...(typeof oldSubscription?.endpoint === "string"
        ? { previousEndpoint: oldSubscription.endpoint }
        : {}),
    }),
  });
  if (!response.ok) {
    const error = new Error(`Push subscription repair failed with status ${response.status}.`);
    error.retryable = response.status === 408
      || response.status === 425
      || response.status === 429
      || response.status >= 500;
    throw error;
  }
}

async function repairChangedSubscription(subscription, oldSubscription) {
  let lastError;
  let currentSubscription = subscription;
  for (const delay of SUBSCRIPTION_REPAIR_DELAYS_MS) {
    if (delay > 0) {
      await wait(delay);
      try {
        currentSubscription = await self.registration.pushManager.getSubscription()
          ?? currentSubscription;
      } catch {
        // The event-provided subscription remains a usable fallback.
      }
    }
    try {
      await registerChangedSubscription(currentSubscription, oldSubscription);
      return;
    } catch (error) {
      lastError = error;
      if (isRecord(error) && error.retryable === false) break;
    }
  }
  throw lastError ?? new Error("Push subscription repair failed.");
}

function wait(delay) {
  return new Promise((resolve) => setTimeout(resolve, delay));
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
