// Data-access layer. Talks to the same-origin backend served by
// @mono-agent/session-web. Every call throws on failure so the store can either
// show a real backend error or fall back to bundled fixtures for standalone
// `vite dev`/`preview` where /api routes do not exist.

import type { Session, WebInstance, StreamMessage } from "./types";

const AUTH_TOKEN_PARAM = "token";
const AUTH_TOKEN_STORAGE_KEY = "mono-agent.session-web.authToken";

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
  const requestUrl = withAuthToken(url);
  const headers: Record<string, string> = { accept: "application/json" };
  const token = currentAuthToken();
  if (token !== undefined) {
    headers.authorization = `Bearer ${token}`;
  }
  const res = await fetch(requestUrl, { headers });
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

export async function fetchSessions(instance: string, limit = 200): Promise<Session[]> {
  const q = `instance=${encodeURIComponent(instance)}&limit=${limit}`;
  const data = await getJSON<{ sessions: Session[] }>(`/api/sessions?${q}`);
  return data.sessions || [];
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
    es = new EventSource(withAuthToken("/api/stream"));
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

function withAuthToken(path: string): string {
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
    try {
      window.sessionStorage.setItem(AUTH_TOKEN_STORAGE_KEY, fromUrl);
    } catch {
      /* ignore storage failures; the URL token still works for this load */
    }
    return fromUrl;
  }
  try {
    const stored = window.sessionStorage.getItem(AUTH_TOKEN_STORAGE_KEY)?.trim();
    return stored === undefined || stored.length === 0 ? undefined : stored;
  } catch {
    return undefined;
  }
}
