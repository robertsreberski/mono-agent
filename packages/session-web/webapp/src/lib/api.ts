// Data-access layer. Talks to the same-origin backend served by
// @mono-agent/session-web. Every call throws on failure so the store can either
// show a real backend error or fall back to bundled fixtures for standalone
// `vite dev`/`preview` where /api routes do not exist.

import type { Session, WebInstance, StreamMessage } from "./types";

const AUTH_TOKEN_PARAM = "token";
export const AUTH_TOKEN_STORAGE = {
  currentTab: {
    storage: "sessionStorage",
    key: "mono-agent.session-web.authToken",
  },
  persistent: {
    storage: "localStorage",
    key: "mono-agent.session-web.authToken.persisted",
    lifetime: "until-cleared",
  },
} as const;
const STREAM_RECONNECT_DELAY_MS = 1_000;
let cachedAuthToken: string | undefined;

export class ApiError extends Error {
  readonly status: number | undefined;
  readonly contentType: string | undefined;

  constructor(url: string, reason: string, options: { readonly status?: number; readonly contentType?: string } = {}) {
    super(`${url} -> ${reason}`);
    this.name = "ApiError";
    this.status = options.status;
    this.contentType = options.contentType;
  }
}

async function getJSON<T>(url: string): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json" };
  const token = currentAuthToken();
  if (token !== undefined) {
    headers.authorization = `Bearer ${token}`;
  }
  const res = await fetch(url, { headers });
  if (!res.ok) throw new ApiError(url, String(res.status), { status: res.status, contentType: res.headers.get("content-type") || undefined });
  const ct = res.headers.get("content-type") || "";
  // A dev server SPA-fallback returns index.html (200) for unknown routes; guard
  // against parsing HTML as JSON so we cleanly trip the fixture fallback.
  if (!ct.includes("application/json")) throw new ApiError(url, `non-JSON (${ct})`, { status: res.status, contentType: ct });
  return (await res.json()) as T;
}

export async function fetchInstances(): Promise<WebInstance[]> {
  const data = await getJSON<{ instances: WebInstance[] }>("/api/instances");
  return data.instances || [];
}

export interface SessionPage {
  sessions: Session[];
  total?: number;
  offset: number;
  limit: number;
  hasMore: boolean;
}

export interface FetchSessionsOptions {
  limit?: number;
  offset?: number;
}

export async function fetchSessions(instance: string, limit = 200): Promise<Session[]> {
  return (await fetchSessionPage(instance, { limit })).sessions;
}

export async function fetchSessionPage(instance: string, options: FetchSessionsOptions = {}): Promise<SessionPage> {
  const limit = options.limit ?? 200;
  const offset = options.offset ?? 0;
  const params = new URLSearchParams();
  params.set("instance", instance);
  params.set("limit", String(limit));
  if (offset > 0) {
    params.set("offset", String(offset));
  }
  const data = await getJSON<{
    sessions?: Session[];
    total?: number;
    offset?: number;
    limit?: number;
    hasMore?: boolean;
  }>(`/api/sessions?${params.toString()}`);
  const sessions = data.sessions || [];
  const pageOffset = typeof data.offset === "number" ? data.offset : offset;
  const pageLimit = typeof data.limit === "number" ? data.limit : limit;
  return {
    sessions,
    ...(typeof data.total === "number" ? { total: data.total } : {}),
    offset: pageOffset,
    limit: pageLimit,
    hasMore: data.hasMore === true,
  };
}

export async function fetchSessionDetail(sourceId: string, runId: string): Promise<Session> {
  const url = `/api/sessions/${encodeURIComponent(sourceId)}/${encodeURIComponent(runId)}`;
  const data = await getJSON<{ session: Session }>(url);
  return data.session;
}

export interface StreamHandlers {
  onMessage: (msg: StreamMessage) => void;
  onOpen?: () => void;
  onError?: () => void;
}

/**
 * Open the browser SSE stream over fetch so bearer authentication stays in the
 * Authorization header instead of a query string. Returns a disposer that
 * aborts the active read; transient failures reconnect automatically.
 */
export function openStream({ onMessage, onOpen, onError }: StreamHandlers): () => void {
  let disposed = false;
  let controller: AbortController | undefined;
  let cancelActiveStream: (() => Promise<void>) | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

  const notifyError = (): void => {
    try {
      onError?.();
    } catch {
      /* consumer callbacks must not reject the fire-and-forget connection loop */
    }
  };

  const connect = async (): Promise<void> => {
    controller = new AbortController();
    let cancelOwnedStream: (() => Promise<void>) | undefined;
    let ownedReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let readerCompleted = false;
    try {
      const headers: Record<string, string> = { accept: "text/event-stream" };
      const token = currentAuthToken();
      if (token !== undefined) {
        headers.authorization = `Bearer ${token}`;
      }
      const response = await fetch("/api/stream", {
        headers,
        signal: controller.signal,
        cache: "no-store",
      });
      const responseBody = response.body;
      if (responseBody === null) {
        throw new ApiError("/api/stream", String(response.status), {
          status: response.status,
          contentType: response.headers.get("content-type") || undefined,
        });
      }
      // The successful Response body remains the cancellation owner until
      // getReader() succeeds. This covers callback/getReader failures without
      // leaving an unread fetch body alive across the reconnect delay.
      const cancelBody = cancellationOnce(() => responseBody.cancel());
      cancelOwnedStream = cancelBody;
      cancelActiveStream = cancelBody;
      if (!response.ok) {
        await cancelBody();
        throw new ApiError("/api/stream", String(response.status), {
          status: response.status,
          contentType: response.headers.get("content-type") || undefined,
        });
      }
      if (disposed) {
        await cancelBody();
        return;
      }
      onOpen?.();
      if (disposed) {
        await cancelBody();
        return;
      }
      const responseReader = responseBody.getReader();
      ownedReader = responseReader;
      // getReader() transfers stream ownership: from here on disposal and
      // exceptional reads cancel the reader, never its former body owner.
      const cancelReader = cancellationOnce(() => responseReader.cancel());
      cancelOwnedStream = cancelReader;
      cancelActiveStream = cancelReader;
      await consumeSseStream(responseReader, onMessage);
      readerCompleted = true;
      if (!disposed) {
        notifyError();
      }
    } catch {
      if (!disposed) {
        notifyError();
      }
    } finally {
      if (!readerCompleted) {
        await cancelOwnedStream?.();
      }
      try {
        ownedReader?.releaseLock();
      } catch {
        /* cancellation/read completion owns cleanup; lock release is best-effort */
      }
      if (cancelActiveStream === cancelOwnedStream) {
        cancelActiveStream = undefined;
      }
      controller = undefined;
      if (!disposed) {
        reconnectTimer = setTimeout(() => {
          reconnectTimer = undefined;
          void connect();
        }, STREAM_RECONNECT_DELAY_MS);
      }
    }
  };
  void connect();

  return () => {
    disposed = true;
    if (reconnectTimer !== undefined) {
      clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
    }
    controller?.abort();
    void cancelActiveStream?.();
  };
}

function cancellationOnce(cancel: () => Promise<unknown>): () => Promise<void> {
  let cancellation: Promise<void> | undefined;
  return () => {
    cancellation ??= Promise.resolve()
      .then(cancel)
      .then(
        () => undefined,
        () => undefined,
      );
    return cancellation;
  };
}

async function consumeSseStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  onMessage: (message: StreamMessage) => void,
): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
    let boundary = nextSseBoundary(buffer);
    while (boundary !== undefined) {
      const block = buffer.slice(0, boundary.index);
      buffer = buffer.slice(boundary.index + boundary.length);
      const data = block
        .split(/\r?\n/u)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice("data:".length).replace(/^ /u, ""))
        .join("\n");
      if (data.length > 0) {
        try {
          onMessage(JSON.parse(data) as StreamMessage);
        } catch {
          /* ignore malformed frames */
        }
      }
      boundary = nextSseBoundary(buffer);
    }
    if (done) {
      return;
    }
  }
}

function nextSseBoundary(buffer: string): { index: number; length: number } | undefined {
  const match = /\r?\n\r?\n/u.exec(buffer);
  return match === null ? undefined : { index: match.index, length: match[0].length };
}

function currentAuthToken(): string | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }
  const fragment = window.location.hash.startsWith("#") ? window.location.hash.slice(1) : window.location.hash;
  const fragmentParams = new URLSearchParams(fragment);
  const queryParams = new URLSearchParams(window.location.search);
  const fromUrl = fragmentParams.get(AUTH_TOKEN_PARAM)?.trim();
  if (fromUrl !== undefined && fromUrl.length > 0) {
    saveAuthToken(fromUrl);
    stripAuthTokenFromUrl();
    return fromUrl;
  }
  // Query credentials have already crossed the HTTP request target before the
  // PWA can inspect them. Never consume them as authentication; remove legacy
  // or empty token parameters while preserving unrelated query/hash state.
  if (fragmentParams.has(AUTH_TOKEN_PARAM) || queryParams.has(AUTH_TOKEN_PARAM)) {
    stripAuthTokenFromUrl();
  }
  if (cachedAuthToken !== undefined) return cachedAuthToken;
  try {
    const stored = window.sessionStorage.getItem(AUTH_TOKEN_STORAGE.currentTab.key)?.trim();
    if (stored !== undefined && stored.length > 0) {
      cachedAuthToken = stored;
      return stored;
    }
  } catch {
    /* ignore storage failures */
  }
  try {
    const stored = window.localStorage.getItem(AUTH_TOKEN_STORAGE.persistent.key)?.trim();
    if (stored === undefined || stored.length === 0) return undefined;
    cachedAuthToken = stored;
    return stored;
  } catch {
    return undefined;
  }
}

export function saveAuthToken(token: string): void {
  if (typeof window === "undefined") return;
  const trimmed = token.trim();
  if (!trimmed) return;
  cachedAuthToken = trimmed;
  try {
    window.sessionStorage.setItem(AUTH_TOKEN_STORAGE.currentTab.key, trimmed);
  } catch {
    /* ignore storage failures; caller may still use URL token */
  }
  try {
    window.localStorage.setItem(AUTH_TOKEN_STORAGE.persistent.key, trimmed);
  } catch {
    /* ignore storage failures */
  }
}

export function clearAuthToken(): void {
  cachedAuthToken = undefined;
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(AUTH_TOKEN_STORAGE.currentTab.key);
  } catch {
    /* ignore storage failures */
  }
  try {
    window.localStorage.removeItem(AUTH_TOKEN_STORAGE.persistent.key);
  } catch {
    /* ignore storage failures */
  }
  stripAuthTokenFromUrl();
}

function stripAuthTokenFromUrl(): void {
  if (typeof window === "undefined") return;
  try {
    const url = new URL(window.location.href);
    const fragment = new URLSearchParams(url.hash.startsWith("#") ? url.hash.slice(1) : url.hash);
    if (!url.searchParams.has(AUTH_TOKEN_PARAM) && !fragment.has(AUTH_TOKEN_PARAM)) return;
    url.searchParams.delete(AUTH_TOKEN_PARAM);
    fragment.delete(AUTH_TOKEN_PARAM);
    const nextHash = fragment.toString();
    const next = `${url.pathname}${url.search}${nextHash.length === 0 ? "" : `#${nextHash}`}`;
    window.history.replaceState(window.history.state, "", next);
  } catch {
    /* ignore history failures; storage fallback still works */
  }
}
