import { readFileSync } from "node:fs";

import { afterEach, describe, expect, test, vi } from "vitest";

import {
  AUTH_TOKEN_STORAGE,
  clearAuthToken,
  fetchInstances,
  fetchSessionPage,
  fetchSessions,
  openStream,
  saveAuthToken,
} from "./api";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => Array.from(values.keys())[index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
}

function throwingStorage(): Storage {
  const fail = (): never => {
    throw new Error("storage unavailable");
  };
  return {
    get length() {
      return fail();
    },
    clear: fail,
    getItem: fail,
    key: fail,
    removeItem: fail,
    setItem: fail,
  };
}

function installWindow(
  search = "",
  localStorage: Storage = memoryStorage(),
  sessionStorage: Storage = localStorage,
): ReturnType<typeof vi.fn> {
  let url = new URL(`https://sessions.example.test/${search}`);
  const replaceState = vi.fn((_state: unknown, _title: string, nextUrl?: string | URL | null) => {
    if (nextUrl !== undefined && nextUrl !== null) {
      url = new URL(nextUrl, url.origin);
    }
  });

  vi.stubGlobal("window", {
    location: {
      get hash() {
        return url.hash;
      },
      get href() {
        return url.href;
      },
      get origin() {
        return url.origin;
      },
      get pathname() {
        return url.pathname;
      },
      get search() {
        return url.search;
      },
    },
    history: { replaceState },
    localStorage,
    sessionStorage,
  });

  return replaceState;
}

function headersFrom(call: readonly unknown[]): Record<string, string> {
  const init = call[1] as RequestInit | undefined;
  return init?.headers as Record<string, string>;
}

afterEach(() => {
  vi.useRealTimers();
  clearAuthToken();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("session-web API auth", () => {
  test("bootstraps auth from a URL fragment and keeps bearer tokens out of request URLs", async () => {
    const replaceState = installWindow("?keep=query#view=all&token=session-secret");
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({ instances: [], sessions: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await fetchInstances();
    await fetchSessions("agent one", 10);

    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/instances");
    expect(headersFrom(fetchMock.mock.calls[0] ?? []).authorization).toBe("Bearer session-secret");
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/sessions?instance=agent+one&limit=10");
    expect(headersFrom(fetchMock.mock.calls[1] ?? []).authorization).toBe("Bearer session-secret");
    expect(replaceState).toHaveBeenCalledWith(undefined, "", "/?keep=query#view=all");
  });

  test("requests paged session history with offset metadata", async () => {
    installWindow();
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({ sessions: [{ id: "older" }], total: 240, offset: 200, limit: 40, hasMore: false }));
    vi.stubGlobal("fetch", fetchMock);

    const page = await fetchSessionPage("all", { limit: 40, offset: 200 });

    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/sessions?instance=all&limit=40&offset=200");
    expect(page).toMatchObject({ total: 240, offset: 200, limit: 40, hasMore: false });
    expect(page.sessions).toEqual([{ id: "older" }]);
  });

  test("keeps a URL token in memory after stripping it when storage is unavailable", async () => {
    const replaceState = installWindow("#token=url-secret", throwingStorage());
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({ instances: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await fetchInstances();
    await fetchInstances();

    expect(replaceState).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual(["/api/instances", "/api/instances"]);
    expect(fetchMock.mock.calls.map((call) => headersFrom(call).authorization)).toEqual(["Bearer url-secret", "Bearer url-secret"]);
  });

  test("persists tokens across browser restarts until both browser copies are cleared", () => {
    const persistentStorage = memoryStorage();
    const currentTabStorage = memoryStorage();
    installWindow("", persistentStorage, currentTabStorage);

    saveAuthToken("  persistent-secret  ");

    expect(currentTabStorage.getItem(AUTH_TOKEN_STORAGE.currentTab.key)).toBe("persistent-secret");
    expect(persistentStorage.getItem(AUTH_TOKEN_STORAGE.persistent.key)).toBe("persistent-secret");

    clearAuthToken();

    expect(currentTabStorage.getItem(AUTH_TOKEN_STORAGE.currentTab.key)).toBeNull();
    expect(persistentStorage.getItem(AUTH_TOKEN_STORAGE.persistent.key)).toBeNull();
  });

  test("restores a token from persistent storage when a new browser session has no tab copy", async () => {
    const persistentStorage = memoryStorage();
    persistentStorage.setItem(AUTH_TOKEN_STORAGE.persistent.key, "restart-secret");
    installWindow("", persistentStorage, memoryStorage());
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({ instances: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await fetchInstances();

    expect(headersFrom(fetchMock.mock.calls[0] ?? []).authorization).toBe("Bearer restart-secret");
  });

  test("keeps the package and canonical docs aligned with the browser-storage contract", () => {
    const documents = [
      readFileSync(new URL("../../../README.md", import.meta.url), "utf8"),
      readFileSync(new URL("../../../../../docs/observability/cli-reference.md", import.meta.url), "utf8"),
    ];

    for (const document of documents) {
      const normalized = document.replace(/\s+/gu, " ");
      expect(normalized).toContain(`\`${AUTH_TOKEN_STORAGE.currentTab.storage}\``);
      expect(normalized).toContain(`\`${AUTH_TOKEN_STORAGE.currentTab.key}\``);
      expect(normalized).toContain(`\`${AUTH_TOKEN_STORAGE.persistent.storage}\``);
      expect(normalized).toContain(`\`${AUTH_TOKEN_STORAGE.persistent.key}\``);
      expect(normalized).toContain("survives page reloads, tab or browser closes, and browser restarts");
      expect(normalized).toContain("Clear");
      expect(normalized).toContain("site data");
    }
  });

  test("ignores and removes a query token without disturbing unrelated URL state", async () => {
    const replaceState = installWindow("?keep=query&token=query-secret#view=all", throwingStorage());
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({ instances: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await fetchInstances();
    await fetchInstances();

    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual(["/api/instances", "/api/instances"]);
    expect(fetchMock.mock.calls.map((call) => headersFrom(call).authorization)).toEqual([undefined, undefined]);
    expect(replaceState).toHaveBeenCalledOnce();
    expect(replaceState).toHaveBeenCalledWith(undefined, "", "/?keep=query#view=all");
  });

  test("streams with Authorization fetch headers and never puts the token in the URL", async () => {
    installWindow();
    const frame = { t: "instances", instances: [] };
    const cancelBody = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(frame)}\n\n`));
      },
      cancel: cancelBody,
    });
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    saveAuthToken("stream-secret");
    const onMessage = vi.fn();
    const onOpen = vi.fn();

    const close = openStream({ onMessage, onOpen });
    await vi.waitFor(() => {
      expect(onOpen).toHaveBeenCalledOnce();
      expect(onMessage).toHaveBeenCalledWith(frame);
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/stream");
    expect(headersFrom(fetchMock.mock.calls[0] ?? []).authorization).toBe("Bearer stream-secret");
    expect(String(fetchMock.mock.calls[0]?.[0])).not.toContain("stream-secret");
    close();
    await vi.waitFor(() => expect(cancelBody).toHaveBeenCalledOnce());
  });

  test("parses split CRLF frames, ignores malformed frames, and cancels disposal once", async () => {
    installWindow();
    const encoder = new TextEncoder();
    const cancelBody = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("data: {malformed}\r"));
        controller.enqueue(encoder.encode("\n\r\n: ping\r\n\r\ndata: {\"t\":\"instances\",\"instances\":[]}\r\n\r"));
        controller.enqueue(encoder.encode("\n"));
      },
      cancel: cancelBody,
    });
    const fetchMock = vi.fn(async () => new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const onMessage = vi.fn();

    const close = openStream({ onMessage });
    await vi.waitFor(() => {
      expect(onMessage).toHaveBeenCalledWith({ t: "instances", instances: [] });
    });
    expect(onMessage).toHaveBeenCalledTimes(1);

    close();
    close();
    await vi.waitFor(() => expect(cancelBody).toHaveBeenCalledOnce());
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  test("cancels every non-terminating HTTP error body before reconnecting", async () => {
    vi.useFakeTimers();
    installWindow();
    let created = 0;
    let cancelled = 0;
    const fetchMock = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      start() {
        created += 1;
      },
      cancel() {
        cancelled += 1;
      },
    }), {
      status: 401,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const close = openStream({ onMessage: vi.fn(), onError: vi.fn() });
    await vi.advanceTimersByTimeAsync(0);
    expect({ created, cancelled }).toEqual({ created: 1, cancelled: 1 });

    await vi.advanceTimersByTimeAsync(1_000);
    expect({ created, cancelled }).toEqual({ created: 2, cancelled: 2 });

    close();
    expect(created - cancelled).toBe(0);
  });

  test("cancels a non-terminating successful body when onOpen throws before reconnecting", async () => {
    vi.useFakeTimers();
    installWindow();
    let created = 0;
    let cancelled = 0;
    const events: string[] = [];
    const fetchMock = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      start() {
        created += 1;
        events.push(`created:${created}`);
      },
      cancel() {
        cancelled += 1;
        events.push(`cancelled:${cancelled}`);
      },
    }), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const onOpen = vi.fn(() => {
      throw new Error("onOpen failed");
    });
    const onError = vi.fn();

    const close = openStream({ onMessage: vi.fn(), onOpen, onError });
    await vi.advanceTimersByTimeAsync(0);
    expect({ created, cancelled, outstanding: created - cancelled }).toEqual({
      created: 1,
      cancelled: 1,
      outstanding: 0,
    });
    expect(onOpen).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(1_000);
    expect({ created, cancelled, outstanding: created - cancelled }).toEqual({
      created: 2,
      cancelled: 2,
      outstanding: 0,
    });
    expect(events.indexOf("cancelled:1")).toBeLessThan(events.indexOf("created:2"));

    close();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(created - cancelled).toBe(0);
  });

  test("cancels an exceptionally failed reader exactly once without cancelling its former body owner", async () => {
    vi.useFakeTimers();
    installWindow();
    const cancelBody = vi.fn(async () => undefined);
    const cancelReader = vi.fn(async () => undefined);
    const releaseLock = vi.fn();
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "text/event-stream" }),
      body: {
        cancel: cancelBody,
        getReader: () => ({
          read: async () => {
            throw new Error("reader failed");
          },
          cancel: cancelReader,
          releaseLock,
        }),
      },
    }) as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);
    const onError = vi.fn();

    const close = openStream({ onMessage: vi.fn(), onError });
    await vi.advanceTimersByTimeAsync(0);

    expect(onError).toHaveBeenCalledOnce();
    expect(cancelReader).toHaveBeenCalledOnce();
    expect(cancelBody).not.toHaveBeenCalled();
    expect(releaseLock).toHaveBeenCalledOnce();
    close();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(cancelReader).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  test("contains throwing error callbacks without duplicate notification or an unhandled connection rejection", async () => {
    vi.useFakeTimers();
    installWindow();
    const onError = vi.fn(() => {
      throw new Error("consumer error callback failed");
    });
    const fetchMock = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    }), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const close = openStream({ onMessage: vi.fn(), onError });
    await vi.advanceTimersByTimeAsync(0);

    expect(onError).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(onError).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    close();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
