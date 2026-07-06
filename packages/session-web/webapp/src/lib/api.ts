// Data-access layer. Talks to the same-origin backend served by
// @mono-agent/session-web. Every call throws on failure so the store can either
// show a real backend error or fall back to bundled fixtures for standalone
// `vite dev`/`preview` where /api routes do not exist.

import type { Session, WebInstance, StreamMessage } from "./types";

const AUTH_TOKEN_PARAM = "token";
const AUTH_TOKEN_STORAGE_KEY = "mono-agent.session-web.authToken";
const AUTH_TOKEN_PERSIST_KEY = "mono-agent.session-web.authToken.persisted";
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
 * Open the browser SSE stream. Returns a disposer that closes the connection.
 * EventSource auto-reconnects; `onError` fires on transient drops too.
 */
export function openStream({ onMessage, onOpen, onError }: StreamHandlers): () => void {
  let es: EventSource | null = null;
  try {
    es = new EventSource(withQueryAuthToken("/api/stream"));
  } catch {
    onError?.();
    return () => {};
  }
  es.onopen = () => onOpen?.();
  es.onerror = () => onError?.();
  es.onmessage = (ev) => {
    try {
      onMessage(JSON.parse(ev.data) as StreamMessage);
    } catch {
      /* ignore malformed frames */
    }
  };
  return () => es?.close();
}

function withQueryAuthToken(path: string): string {
  const token = currentAuthToken();
  if (token === undefined || typeof window === "undefined") {
    return path;
  }
  const url = new URL(path, window.location.origin);
  url.searchParams.set(AUTH_TOKEN_PARAM, token);
  return `${url.pathname}${url.search}${url.hash}`;
}

function currentAuthToken(): string | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }
  const fromUrl = new URLSearchParams(window.location.search).get(AUTH_TOKEN_PARAM)?.trim();
  if (fromUrl !== undefined && fromUrl.length > 0) {
    saveAuthToken(fromUrl);
    stripAuthTokenFromUrl();
    return fromUrl;
  }
  if (cachedAuthToken !== undefined) return cachedAuthToken;
  try {
    const stored = window.sessionStorage.getItem(AUTH_TOKEN_STORAGE_KEY)?.trim();
    if (stored !== undefined && stored.length > 0) {
      cachedAuthToken = stored;
      return stored;
    }
  } catch {
    /* ignore storage failures */
  }
  try {
    const stored = window.localStorage.getItem(AUTH_TOKEN_PERSIST_KEY)?.trim();
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
    window.sessionStorage.setItem(AUTH_TOKEN_STORAGE_KEY, trimmed);
  } catch {
    /* ignore storage failures; caller may still use URL token */
  }
  try {
    window.localStorage.setItem(AUTH_TOKEN_PERSIST_KEY, trimmed);
  } catch {
    /* ignore storage failures */
  }
}

export function clearAuthToken(): void {
  cachedAuthToken = undefined;
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(AUTH_TOKEN_STORAGE_KEY);
  } catch {
    /* ignore storage failures */
  }
  try {
    window.localStorage.removeItem(AUTH_TOKEN_PERSIST_KEY);
  } catch {
    /* ignore storage failures */
  }
  stripAuthTokenFromUrl();
}

function stripAuthTokenFromUrl(): void {
  if (typeof window === "undefined") return;
  try {
    const url = new URL(window.location.href);
    if (!url.searchParams.has(AUTH_TOKEN_PARAM)) return;
    url.searchParams.delete(AUTH_TOKEN_PARAM);
    const next = `${url.pathname}${url.search}${url.hash}`;
    window.history.replaceState(window.history.state, "", next);
  } catch {
    /* ignore history failures; storage fallback still works */
  }
}
