// Data-access layer. Talks to the same-origin backend served by
// @mono-agent/session-web. Every call throws on failure so the store can fall
// back to the bundled fixture for standalone `vite dev`/`preview`.

import type { Session, WebInstance, StreamMessage } from "./types";

async function getJSON<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  const ct = res.headers.get("content-type") || "";
  // A dev server SPA-fallback returns index.html (200) for unknown routes; guard
  // against parsing HTML as JSON so we cleanly trip the fixture fallback.
  if (!ct.includes("application/json")) throw new Error(`${url} → non-JSON (${ct})`);
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
    es = new EventSource("/api/stream");
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
