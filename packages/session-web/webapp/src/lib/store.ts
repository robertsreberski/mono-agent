// App data store — a small React context. Loads instances + sessions, opens the
// /api/stream EventSource and folds upserts into state, and lazy-loads full run
// detail when a card is opened. Falls back to the bundled fixture when the
// backend isn't reachable (standalone `vite dev` / `preview`).

import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import type { Session, WebInstance } from "./types";
import { ApiError, fetchInstances, fetchSessions, fetchSessionDetail, openStream } from "./api";
import { FIXTURE_INSTANCES, FIXTURE_SESSIONS } from "./fixture";

export type ConnStatus = "loading" | "live" | "fixture" | "error";

export interface RecorderStore {
  instances: WebInstance[];
  sessions: Session[];
  status: ConnStatus;
  error?: string;
  /** Trigger a lazy detail fetch for a run if its steps aren't loaded yet. */
  ensureDetail: (key: string) => void;
}

const RecorderContext = createContext<RecorderStore | null>(null);

const byNewest = (a: Session, b: Session) => +new Date(b.startTs) - +new Date(a.startTs);

export type SessionStoreOp =
  | { readonly type: "upsert"; readonly session: Session }
  | { readonly type: "remove"; readonly sourceId: string; readonly runId: string };

export function sessionStoreKeyParts(sourceId: string, runId: string): string {
  return `${sourceId}::${runId}`;
}

export function sessionStoreKey(session: Session): string {
  return sessionStoreKeyParts(session.sourceId ?? session.instance, session.id);
}

export function applySessionOps(prev: readonly Session[], ops: readonly SessionStoreOp[]): Session[] {
  const map = new Map(prev.map((s) => [sessionStoreKey(s), s] as const));
  for (const op of ops) {
    if (op.type === "remove") {
      map.delete(sessionStoreKeyParts(op.sourceId, op.runId));
    } else {
      map.set(sessionStoreKey(op.session), op.session);
    }
  }
  return [...map.values()].sort(byNewest);
}

export function shouldUseFixtureFallback(error: unknown, isDev = import.meta.env.DEV): boolean {
  if (isDev) {
    return true;
  }
  // Standalone `vite preview` serves built assets without the session-web backend:
  // /api/* either 404s or returns an HTML SPA fallback. A real session-web backend
  // returns JSON for /api failures, and 500s should surface as operator-visible
  // errors rather than fake demo data.
  if (!(error instanceof ApiError) || error.contentType?.includes("application/json")) {
    return false;
  }
  return error.status === 404 || (error.status !== undefined && error.status >= 200 && error.status < 300);
}

/** Resolve the owning trace-source id for a run, for the detail endpoint. */
function resolveSourceId(session: Session, instances: WebInstance[]): string {
  if (session.sourceId) return session.sourceId;
  const match = instances.find((i) => i.label === session.instance);
  return match?.sourceId || session.instance;
}

export function RecorderProvider({ children }: { children: ReactNode }): ReactElement {
  const [instances, setInstances] = useState<WebInstance[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [status, setStatus] = useState<ConnStatus>("loading");
  const [error, setError] = useState<string | undefined>(undefined);

  const instancesRef = useRef<WebInstance[]>([]);
  instancesRef.current = instances;
  const statusRef = useRef<ConnStatus>("loading");
  statusRef.current = status;
  const sessionsRef = useRef<Session[]>([]);
  sessionsRef.current = sessions;
  const inflight = useRef<Set<string>>(new Set());
  // Runs we've already fired a detail fetch for (attempted), so a legitimately
  // zero-step run isn't re-fetched on every open.
  const loadedDetail = useRef<Set<string>>(new Set());

  // Batch SSE folds: the connect snapshot is N separate `session_upsert` frames
  // (one per run, ~477 today) and each EventSource onmessage is its own task, so
  // React 19 does NOT batch them — applying each individually would be N full
  // setState + re-sort + list re-renders on every connect/reconnect. Coalesce
  // incoming ops by runId and apply them in ONE setSessions per microtask.
  // `op === null` means remove.
  const pendingOps = useRef<Map<string, SessionStoreOp>>(new Map());
  const flushScheduled = useRef(false);

  const flushPending = useCallback(() => {
    flushScheduled.current = false;
    const ops = pendingOps.current;
    if (ops.size === 0) return;
    pendingOps.current = new Map();
    setSessions((prev) => {
      return applySessionOps(prev, [...ops.values()]);
    });
  }, []);

  const scheduleFlush = useCallback(() => {
    if (flushScheduled.current) return;
    flushScheduled.current = true;
    queueMicrotask(flushPending);
  }, [flushPending]);

  const queueUpsert = useCallback(
    (incoming: Session) => {
      pendingOps.current.set(sessionStoreKey(incoming), { type: "upsert", session: incoming });
      scheduleFlush();
    },
    [scheduleFlush],
  );

  const queueRemove = useCallback(
    (sourceId: string, runId: string) => {
      pendingOps.current.set(sessionStoreKeyParts(sourceId, runId), { type: "remove", sourceId, runId });
      scheduleFlush();
    },
    [scheduleFlush],
  );

  // Initial load + live stream.
  useEffect(() => {
    let disposed = false;
    let closeStream: (() => void) | null = null;

    (async () => {
      try {
        const [ins, ses] = await Promise.all([fetchInstances(), fetchSessions("all", 2000)]);
        if (disposed) return;
        setInstances(ins);
        setSessions([...ses].sort(byNewest));
        setStatus("live");

        closeStream = openStream({
          onMessage: (msg) => {
            if (msg.t === "instances") setInstances(msg.instances);
            else if (msg.t === "session_upsert") queueUpsert(msg.session);
            else if (msg.t === "session_removed") queueRemove(msg.sourceId, msg.runId);
          },
        });
      } catch (error_) {
        if (disposed) return;
        if (!shouldUseFixtureFallback(error_)) {
          setInstances([]);
          setSessions([]);
          setStatus("error");
          setError(error_ instanceof Error ? error_.message : String(error_));
          return;
        }
        // No backend — develop/verify against the bundled fixture.
        setInstances(FIXTURE_INSTANCES);
        setSessions([...FIXTURE_SESSIONS].sort(byNewest));
        setStatus("fixture");
        setError(undefined);
      }
    })();

    return () => {
      disposed = true;
      closeStream?.();
    };
  }, [queueUpsert, queueRemove]);

  const ensureDetail = useCallback(
    (key: string) => {
      if (statusRef.current !== "live") return; // fixture already carries steps
      if (inflight.current.has(key) || loadedDetail.current.has(key)) return; // in-flight or already attempted
      const s = sessionsRef.current.find((x) => sessionStoreKey(x) === key);
      if (!s) return;
      loadedDetail.current.add(key);
      inflight.current.add(key);
      const sourceId = resolveSourceId(s, instancesRef.current);
      fetchSessionDetail(sourceId, s.id)
        .then((full) => queueUpsert(full))
        .catch(() => {})
        .finally(() => inflight.current.delete(key));
    },
    [queueUpsert],
  );

  const value: RecorderStore = { instances, sessions, status, error, ensureDetail };
  return createElement(RecorderContext.Provider, { value }, children);
}

export function useRecorder(): RecorderStore {
  const ctx = useContext(RecorderContext);
  if (!ctx) throw new Error("useRecorder must be used within <RecorderProvider>");
  return ctx;
}
