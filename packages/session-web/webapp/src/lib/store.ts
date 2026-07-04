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
  const inflight = useRef<Set<string>>(new Set());

  const upsertSession = useCallback((incoming: Session) => {
    setSessions((prev) => {
      const idx = prev.findIndex((s) => s.id === incoming.id);
      const next = idx >= 0 ? prev.map((s) => (s.id === incoming.id ? incoming : s)) : [incoming, ...prev];
      return next.sort(byNewest);
    });
  }, []);

  const removeSession = useCallback((runId: string) => {
    setSessions((prev) => prev.filter((s) => s.id !== runId));
  }, []);

  // Initial load + live stream.
  useEffect(() => {
    let disposed = false;
    let closeStream: (() => void) | null = null;

    (async () => {
      try {
        const [ins, ses] = await Promise.all([fetchInstances(), fetchSessions("all", 200)]);
        if (disposed) return;
        setInstances(ins);
        setSessions([...ses].sort(byNewest));
        setStatus("live");

        closeStream = openStream({
          onMessage: (msg) => {
            if (msg.t === "instances") setInstances(msg.instances);
            else if (msg.t === "session_upsert") upsertSession(msg.session);
            else if (msg.t === "session_removed") removeSession(msg.runId);
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
  }, [upsertSession, removeSession]);

  const ensureDetail = useCallback(
    (id: string) => {
      if (statusRef.current !== "live") return; // fixture already carries steps
      if (inflight.current.has(id)) return;
      setSessions((prev) => {
        const s = prev.find((x) => x.id === id);
        if (!s || (s.steps && s.steps.length > 0)) return prev; // already have detail
        inflight.current.add(id);
        const sourceId = resolveSourceId(s, instancesRef.current);
        fetchSessionDetail(sourceId, id)
          .then((full) => upsertSession(full))
          .catch(() => {})
          .finally(() => inflight.current.delete(id));
        return prev;
      });
    },
    [upsertSession],
  );

  const value: RecorderStore = { instances, sessions, status, ensureDetail };
  return createElement(RecorderContext.Provider, { value }, children);
}

export function useRecorder(): RecorderStore {
  const ctx = useContext(RecorderContext);
  if (!ctx) throw new Error("useRecorder must be used within <RecorderProvider>");
  return ctx;
}
