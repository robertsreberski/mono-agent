import { afterEach, describe, expect, test, vi } from "vitest";

import { clearAuthToken, fetchInstances, fetchSessionPage, fetchSessions, openStream, saveAuthToken } from "./api";

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

function installWindow(search = "", storage: Storage = memoryStorage()): ReturnType<typeof vi.fn> {
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
    localStorage: storage,
    sessionStorage: storage,
  });

  return replaceState;
}

function headersFrom(call: readonly unknown[]): Record<string, string> {
  const init = call[1] as RequestInit | undefined;
  return init?.headers as Record<string, string>;
}

afterEach(() => {
  clearAuthToken();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("session-web API auth", () => {
  test("bootstraps auth from a URL fragment and keeps bearer tokens out of request URLs", async () => {
    const replaceState = installWindow("#token=session-secret");
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({ instances: [], sessions: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await fetchInstances();
    await fetchSessions("agent one", 10);

    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/instances");
    expect(headersFrom(fetchMock.mock.calls[0] ?? []).authorization).toBe("Bearer session-secret");
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/sessions?instance=agent+one&limit=10");
    expect(headersFrom(fetchMock.mock.calls[1] ?? []).authorization).toBe("Bearer session-secret");
    expect(replaceState).toHaveBeenCalledWith(undefined, "", "/");
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
    const replaceState = installWindow("?token=url-secret", throwingStorage());
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({ instances: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await fetchInstances();
    await fetchInstances();

    expect(replaceState).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual(["/api/instances", "/api/instances"]);
    expect(fetchMock.mock.calls.map((call) => headersFrom(call).authorization)).toEqual(["Bearer url-secret", "Bearer url-secret"]);
  });

  test("streams with Authorization fetch headers and never puts the token in the URL", async () => {
    installWindow();
    const frame = { t: "instances", instances: [] };
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(frame)}\n\n`));
      },
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
  });
});
