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
import { fetchInstances, fetchSessions, fetchSessionDetail, openStream } from "./api";
import { FIXTURE_INSTANCES, FIXTURE_SESSIONS } from "./fixture";

export type ConnStatus = "loading" | "live" | "fixture";

export interface RecorderStore {
  instances: WebInstance[];
  sessions: Session[];
  status: ConnStatus;
  /** Trigger a lazy detail fetch for a run if its steps aren't loaded yet. */
  ensureDetail: (id: string) => void;
}

const RecorderContext = createContext<RecorderStore | null>(null);

const byNewest = (a: Session, b: Session) => +new Date(b.startTs) - +new Date(a.startTs);

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
  const pendingOps = useRef<Map<string, Session | null>>(new Map());
  const flushScheduled = useRef(false);

  const flushPending = useCallback(() => {
    flushScheduled.current = false;
    const ops = pendingOps.current;
    if (ops.size === 0) return;
    pendingOps.current = new Map();
    setSessions((prev) => {
      const map = new Map(prev.map((s) => [s.id, s] as const));
      for (const [id, op] of ops) {
        if (op === null) map.delete(id);
        else map.set(id, op);
      }
      return [...map.values()].sort(byNewest);
    });
  }, []);

  const scheduleFlush = useCallback(() => {
    if (flushScheduled.current) return;
    flushScheduled.current = true;
    queueMicrotask(flushPending);
  }, [flushPending]);

  const queueUpsert = useCallback(
    (incoming: Session) => {
      pendingOps.current.set(incoming.id, incoming);
      scheduleFlush();
    },
    [scheduleFlush],
  );

  const queueRemove = useCallback(
    (runId: string) => {
      pendingOps.current.set(runId, null);
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
            else if (msg.t === "session_removed") queueRemove(msg.runId);
          },
        });
      } catch {
        // No backend — develop/verify against the bundled fixture.
        if (disposed) return;
        setInstances(FIXTURE_INSTANCES);
        setSessions([...FIXTURE_SESSIONS].sort(byNewest));
        setStatus("fixture");
      }
    })();

    return () => {
      disposed = true;
      closeStream?.();
    };
  }, [queueUpsert, queueRemove]);

  const ensureDetail = useCallback(
    (id: string) => {
      if (statusRef.current !== "live") return; // fixture already carries steps
      if (inflight.current.has(id) || loadedDetail.current.has(id)) return; // in-flight or already attempted
      const s = sessionsRef.current.find((x) => x.id === id);
      if (!s) return;
      loadedDetail.current.add(id);
      inflight.current.add(id);
      const sourceId = resolveSourceId(s, instancesRef.current);
      fetchSessionDetail(sourceId, id)
        .then((full) => queueUpsert(full))
        .catch(() => {})
        .finally(() => inflight.current.delete(id));
    },
    [queueUpsert],
  );

  const value: RecorderStore = { instances, sessions, status, ensureDetail };
  return createElement(RecorderContext.Provider, { value }, children);
}

export function useRecorder(): RecorderStore {
  const ctx = useContext(RecorderContext);
  if (!ctx) throw new Error("useRecorder must be used within <RecorderProvider>");
  return ctx;
}
