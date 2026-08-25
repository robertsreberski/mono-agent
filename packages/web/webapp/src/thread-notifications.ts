export const THREAD_NOTIFICATION_STORAGE_KEY = "mono-agent.web.thread-notifications";
export const THREAD_NOTIFICATION_CACHE = "mono-agent-thread-notifications-v1";
export const THREAD_NOTIFICATION_CACHE_URL = "/__mono-agent/thread-notification-mutes";
export const THREAD_NOTIFICATION_CHANGED = "mono-agent:thread-notification-changed";

const readMuted = (): Set<string> => {
  try {
    const value = JSON.parse(localStorage.getItem(THREAD_NOTIFICATION_STORAGE_KEY) ?? "[]") as unknown;
    return new Set(Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);
  } catch {
    return new Set();
  }
};

const writeWorkerMirror = async (muted: Set<string>): Promise<void> => {
  if (!("caches" in window)) return;
  const cache = await caches.open(THREAD_NOTIFICATION_CACHE);
  await cache.put(
    THREAD_NOTIFICATION_CACHE_URL,
    new Response(JSON.stringify([...muted].sort()), {
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    }),
  );
};

export const threadNotificationsMuted = (threadId: string): boolean => readMuted().has(threadId);

export async function setThreadNotificationsMuted(threadId: string, muted: boolean): Promise<void> {
  const values = readMuted();
  if (muted) values.add(threadId);
  else values.delete(threadId);
  localStorage.setItem(THREAD_NOTIFICATION_STORAGE_KEY, JSON.stringify([...values].sort()));
  window.dispatchEvent(new CustomEvent(THREAD_NOTIFICATION_CHANGED, { detail: { threadId, muted } }));
  await writeWorkerMirror(values).catch(() => undefined);
}

export const syncThreadNotificationsToWorker = async (): Promise<void> => {
  await writeWorkerMirror(readMuted()).catch(() => undefined);
};

export async function isThreadNotificationsMuted(threadId: string): Promise<boolean> {
  if (threadNotificationsMuted(threadId)) return true;
  if (!("caches" in window)) return false;
  try {
    const response = await (await caches.open(THREAD_NOTIFICATION_CACHE)).match(THREAD_NOTIFICATION_CACHE_URL);
    const value = response === undefined ? undefined : await response.json() as unknown;
    return Array.isArray(value) && value.includes(threadId);
  } catch {
    return false;
  }
}
