import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isThreadNotificationsMuted,
  setThreadNotificationsMuted,
  syncThreadNotificationsToWorker,
  THREAD_NOTIFICATION_CACHE_URL,
  THREAD_NOTIFICATION_CHANGED,
  THREAD_NOTIFICATION_STORAGE_KEY,
  threadNotificationsMuted,
} from "./thread-notifications";

describe("thread notification preferences", () => {
  const cached = new Map<string, Response>();
  const cache = {
    match: vi.fn(async (key: string) => cached.get(key)),
    put: vi.fn(async (key: string, response: Response) => { cached.set(key, response); }),
  };

  beforeEach(() => {
    cached.clear();
    localStorage.clear();
    vi.stubGlobal("caches", { open: vi.fn(async () => cache) });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("updates the page immediately and mirrors the mute for the service worker", async () => {
    const changed = vi.fn();
    window.addEventListener(THREAD_NOTIFICATION_CHANGED, changed);
    await setThreadNotificationsMuted("thread-a", true);

    expect(threadNotificationsMuted("thread-a")).toBe(true);
    expect(changed).toHaveBeenCalledOnce();
    expect(cache.put).toHaveBeenCalledWith(THREAD_NOTIFICATION_CACHE_URL, expect.any(Response));

    localStorage.removeItem(THREAD_NOTIFICATION_STORAGE_KEY);
    expect(await isThreadNotificationsMuted("thread-a")).toBe(true);
    window.removeEventListener(THREAD_NOTIFICATION_CHANGED, changed);
  });

  it("synchronizes preferences created by an older page session", async () => {
    localStorage.setItem(THREAD_NOTIFICATION_STORAGE_KEY, JSON.stringify(["thread-b"]));
    await syncThreadNotificationsToWorker();
    localStorage.clear();

    expect(await isThreadNotificationsMuted("thread-b")).toBe(true);
  });
});
