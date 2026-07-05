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

export type ConnStatus = "loading" | "live" | "reconnecting" | "fixture" | "error";

export interface DetailStatus {
  loading?: boolean;
  error?: string;
}

export interface RecorderStore {
  instances: WebInstance[];
  sessions: Session[];
  status: ConnStatus;
  error?: string;
  detailStatus: Record<string, DetailStatus>;
  /** Trigger a lazy detail fetch for a run if its steps aren't loaded yet. */
  ensureDetail: (key: string) => void;
  /** Retry a failed detail fetch for a run. */
  retryDetail: (key: string) => void;
  /** Retry the initial API/SSE connection after credentials or network state change. */
  reload: () => void;
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
      const key = sessionStoreKey(op.session);
      map.set(key, mergeSessionUpsert(map.get(key), op.session));
    }
  }
  return [...map.values()].sort(byNewest);
}

function mergeSessionUpsert(existing: Session | undefined, incoming: Session): Session {
  if (existing === undefined) {
    return incoming;
  }
  const preserveTimeline =
    existing.steps.length > 0 &&
    (incoming.steps.length < existing.steps.length || incoming.totals.steps < existing.totals.steps);
  const preserveFinalText = existing.finalText.trim().length > 0 && incoming.finalText.trim().length === 0;
  if (!preserveTimeline && !preserveFinalText) {
    return incoming;
  }

  return {
    ...incoming,
    ...(preserveTimeline
      ? {
          steps: existing.steps,
          toolCounts: existing.toolCounts,
          totals: {
            ...incoming.totals,
            asst: Math.max(incoming.totals.asst, existing.totals.asst),
            tcalls: Math.max(incoming.totals.tcalls, existing.totals.tcalls),
            think: Math.max(incoming.totals.think, existing.totals.think),
            steps: Math.max(incoming.totals.steps, existing.totals.steps),
          },
        }
      : {}),
    ...(preserveFinalText
      ? {
          finalText: existing.finalText,
          outcome: existing.outcome,
          ...(existing.finalTr === undefined ? {} : { finalTr: existing.finalTr }),
        }
      : {}),
  };
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
  const [detailStatus, setDetailStatus] = useState<Record<string, DetailStatus>>({});
  const [reloadToken, setReloadToken] = useState(0);

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
    let streamErrorTimer: number | undefined;

    const clearStreamErrorTimer = () => {
      if (streamErrorTimer !== undefined) {
        window.clearTimeout(streamErrorTimer);
        streamErrorTimer = undefined;
      }
    };

    const markReconnectingSoon = () => {
      clearStreamErrorTimer();
      streamErrorTimer = window.setTimeout(() => {
        if (!disposed) setStatus("reconnecting");
      }, 800);
    };

    (async () => {
      try {
        setStatus("loading");
        setError(undefined);
        const [ins, ses] = await Promise.all([fetchInstances(), fetchSessions("all", 2000)]);
        if (disposed) return;
        setInstances(ins);
        setSessions([...ses].sort(byNewest));
        setStatus("reconnecting");

        closeStream = openStream({
          onOpen: () => {
            clearStreamErrorTimer();
            if (!disposed) setStatus("live");
          },
          onError: () => {
            if (!disposed) markReconnectingSoon();
          },
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
      clearStreamErrorTimer();
      closeStream?.();
    };
  }, [queueUpsert, queueRemove, reloadToken]);

  const loadDetail = useCallback(
    (key: string, force = false) => {
      if (statusRef.current !== "live" && statusRef.current !== "reconnecting") return; // fixture already carries steps
      if (inflight.current.has(key) || loadedDetail.current.has(key)) return; // in-flight or already attempted
      const s = sessionsRef.current.find((x) => sessionStoreKey(x) === key);
      if (!s) return;
      if (!force && (s.steps?.length ?? 0) > 0) {
        loadedDetail.current.add(key);
        setDetailStatus((prev) => {
          if (prev[key] === undefined) return prev;
          const next = { ...prev };
          delete next[key];
          return next;
        });
        return;
      }
      inflight.current.add(key);
      setDetailStatus((prev) => ({ ...prev, [key]: { loading: true } }));
      const sourceId = resolveSourceId(s, instancesRef.current);
      fetchSessionDetail(sourceId, s.id)
        .then((full) => {
          loadedDetail.current.add(key);
          queueUpsert(full);
          setDetailStatus((prev) => {
            if (prev[key] === undefined) return prev;
            const next = { ...prev };
            delete next[key];
            return next;
          });
        })
        .catch((error_) => {
          loadedDetail.current.delete(key);
          setDetailStatus((prev) => ({
            ...prev,
            [key]: { error: error_ instanceof Error ? error_.message : String(error_) },
          }));
        })
        .finally(() => inflight.current.delete(key));
    },
    [queueUpsert],
  );

  const ensureDetail = useCallback((key: string) => loadDetail(key, false), [loadDetail]);
  const retryDetail = useCallback((key: string) => {
    loadedDetail.current.delete(key);
    loadDetail(key, true);
  }, [loadDetail]);
  const reload = useCallback(() => {
    setReloadToken((n) => n + 1);
  }, []);

  const value: RecorderStore = { instances, sessions, status, error, detailStatus, ensureDetail, retryDetail, reload };
  return createElement(RecorderContext.Provider, { value }, children);
}

export function useRecorder(): RecorderStore {
  const ctx = useContext(RecorderContext);
  if (!ctx) throw new Error("useRecorder must be used within <RecorderProvider>");
  return ctx;
}
