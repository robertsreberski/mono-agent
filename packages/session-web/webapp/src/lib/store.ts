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
import { ApiError, fetchInstances, fetchSessionDetail, fetchSessionPage, openStream, type FetchSessionsOptions, type SessionPage } from "./api";
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
  canLoadOlder: boolean;
  loadingOlder: boolean;
  historyError?: string;
  canLoadOlderFor: (instance: string) => boolean;
  loadingOlderFor: (instance: string) => boolean;
  historyErrorFor: (instance: string) => string | undefined;
  detailStatus: Record<string, DetailStatus>;
  /** Load the next page of older history beyond the current backend snapshot. */
  loadOlder: (instance?: string) => void;
  /** Trigger a lazy detail fetch for a run if its steps aren't loaded yet. */
  ensureDetail: (key: string) => void;
  /** Retry a failed detail fetch for a run. */
  retryDetail: (key: string) => void;
  /** Retry the initial API/SSE connection after credentials or network state change. */
  reload: () => void;
}

const RecorderContext = createContext<RecorderStore | null>(null);

const HISTORY_PAGE_SIZE = 200;

// Live-fold working-set cap for the browser store. Completed-run cap-evictions on
// the backend are silent (no `session_removed`), so without a browser-side bound a
// long-lived tab would accrete one row per new run for the tab's whole lifetime
// (days → unbounded memory + DOM). This caps the LIVE SSE fold only, and it never
// evicts a run the user explicitly paged in via `loadOlder` (those keys are passed
// as `protectedKeys`) — so "Load older" stays reachable to run #1 even across live
// frames, while automatic live accretion beyond the newest `cap` non-paged runs is
// still bounded. The cap only ever touches the display array; paging offsets live
// in `historyStates.loadedKeys`, which it never mutates. Retention is therefore
// newest-`cap` live + user-paged (user-bounded) + running (transient). Mirrors the
// backend's policy (evict oldest COMPLETED, never a running run); see #162/#166.
export const MAX_LIVE_SESSIONS = 1_000;

const byNewest = (a: Session, b: Session) => +new Date(b.startTs) - +new Date(a.startTs);

/**
 * Trim `sessions` (already sorted newest-first) to at most `cap`, dropping the
 * OLDEST *completed* runs. A run is never dropped when it is `running` (its live
 * fold is in flight) or when its key is in `protectedKeys` (the user paged it in,
 * so it must stay reachable). The result may therefore exceed `cap`. Order is
 * preserved (the result is a subsequence of the sorted input).
 */
export function capSessions(
  sessions: readonly Session[],
  cap: number,
  protectedKeys?: ReadonlySet<string>,
): Session[] {
  if (cap <= 0 || sessions.length <= cap) {
    return sessions as Session[];
  }
  const kept: Session[] = [];
  let budget = cap;
  for (const session of sessions) {
    if (budget > 0) {
      kept.push(session);
      budget -= 1;
    } else if (session.status === "running" || protectedKeys?.has(sessionStoreKey(session))) {
      kept.push(session);
    }
  }
  return kept;
}

interface HistoryPageState {
  readonly offset: number;
  readonly hasMore: boolean;
  readonly loading: boolean;
  readonly total?: number;
  readonly loadedKeys?: ReadonlySet<string>;
  readonly error?: string;
}

export type SessionStoreOp =
  | { readonly type: "upsert"; readonly session: Session }
  | { readonly type: "remove"; readonly sourceId: string; readonly runId: string };

export function sessionStoreKeyParts(sourceId: string, runId: string): string {
  return `${sourceId}::${runId}`;
}

export function sessionStoreKey(session: Session): string {
  return sessionStoreKeyParts(session.sourceId ?? session.instance, session.id);
}

export function applySessionOps(
  prev: readonly Session[],
  ops: readonly SessionStoreOp[],
  cap?: number,
  protectedKeys?: ReadonlySet<string>,
): Session[] {
  const map = new Map(prev.map((s) => [sessionStoreKey(s), s] as const));
  for (const op of ops) {
    if (op.type === "remove") {
      map.delete(sessionStoreKeyParts(op.sourceId, op.runId));
    } else {
      const key = sessionStoreKey(op.session);
      map.set(key, mergeSessionUpsert(map.get(key), op.session));
    }
  }
  const sorted = [...map.values()].sort(byNewest);
  // `cap` is passed only on the live SSE fold to bound long-lived-tab growth;
  // `loadOlder` omits it so paged-in history is never truncated back out, and the
  // live path passes the paged keys as `protectedKeys` so a later frame can't evict
  // them either.
  return cap === undefined ? sorted : capSessions(sorted, cap, protectedKeys);
}

function mergeSessionUpsert(existing: Session | undefined, incoming: Session): Session {
  if (existing === undefined) {
    return incoming;
  }
  const preserveTimeline =
    existing.steps.length > 0 &&
    (incoming.steps.length < existing.steps.length || incoming.totals.steps < existing.totals.steps);
  const preserveFinalText = existing.finalText.trim().length > 0 && incoming.finalText.trim().length === 0;
  // Stripped SSE list upserts carry no ctx/sysPrompt (detail-only). Keep the
  // loaded detail rather than let `...incoming` erase it.
  const preserveCtx = existing.ctx !== undefined && incoming.ctx === undefined;
  const preserveSysPrompt = existing.sysPrompt !== undefined && incoming.sysPrompt === undefined;
  if (!preserveTimeline && !preserveFinalText && !preserveCtx && !preserveSysPrompt) {
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
    ...(preserveCtx ? { ctx: existing.ctx } : {}),
    ...(preserveSysPrompt
      ? {
          sysPrompt: existing.sysPrompt,
          ...(existing.sysPromptTr === undefined ? {} : { sysPromptTr: existing.sysPromptTr }),
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

function historyKey(instance: string | undefined): string {
  const trimmed = instance?.trim();
  return trimmed === undefined || trimmed.length === 0 ? "all" : trimmed;
}

function sessionSourceId(session: Session): string {
  return session.sourceId ?? session.instance;
}

function loadedSessionCount(sessions: readonly Session[], instance: string): number {
  const key = historyKey(instance);
  if (key === "all") {
    return sessions.length;
  }
  return sessions.filter((session) => sessionSourceId(session) === key).length;
}

function baseHistoryState(states: Readonly<Record<string, HistoryPageState>>, key: string, status: ConnStatus): HistoryPageState {
  const known = states[key];
  if (known !== undefined) {
    return known;
  }
  if (status !== "live" && status !== "reconnecting") {
    return { offset: 0, hasMore: false, loading: false };
  }
  return { offset: 0, hasMore: states.all?.hasMore ?? true, loading: false };
}

function upsertLoadedKeys(
  state: HistoryPageState,
  sessions: readonly Session[],
  page?: { readonly offset: number; readonly hasMore: boolean; readonly total?: number },
): HistoryPageState {
  const loadedKeys = new Set(state.loadedKeys ?? []);
  for (const session of sessions) {
    loadedKeys.add(sessionStoreKey(session));
  }
  const loadedOffset = loadedKeys.size;
  const pageOffset = page === undefined ? 0 : page.offset + sessions.length;
  const offset = Math.max(state.offset, loadedOffset, pageOffset);
  const total = page?.total ?? state.total;
  return {
    ...state,
    offset,
    hasMore: total === undefined ? page?.hasMore ?? state.hasMore : offset < total,
    loading: page === undefined ? state.loading : false,
    loadedKeys,
    ...(total === undefined ? {} : { total }),
  };
}

function removeLoadedKeys(state: HistoryPageState, keys: ReadonlySet<string>): HistoryPageState {
  if (state.loadedKeys === undefined) {
    return state;
  }
  const loadedKeys = new Set(state.loadedKeys);
  let changed = false;
  for (const key of keys) {
    changed = loadedKeys.delete(key) || changed;
  }
  if (!changed) {
    return state;
  }
  const offset = Math.min(state.offset, loadedKeys.size);
  return {
    ...state,
    offset,
    hasMore: state.total === undefined ? state.hasMore : offset < state.total,
    loadedKeys,
  };
}

export function markHistorySessionsLoaded(
  states: Readonly<Record<string, HistoryPageState>>,
  sessions: readonly Session[],
  instance = "all",
  page?: { readonly offset: number; readonly hasMore: boolean; readonly total?: number },
): Record<string, HistoryPageState> {
  const key = historyKey(instance);
  const next: Record<string, HistoryPageState> = { ...states };
  next[key] = upsertLoadedKeys(baseHistoryState(next, key, "live"), sessions, page);
  if (key === "all") {
    const bySource = new Map<string, Session[]>();
    for (const session of sessions) {
      const sourceId = sessionSourceId(session);
      const group = bySource.get(sourceId) ?? [];
      group.push(session);
      bySource.set(sourceId, group);
    }
    for (const [sourceId, sourceSessions] of bySource) {
      next[sourceId] = upsertLoadedKeys(baseHistoryState(next, sourceId, "live"), sourceSessions);
    }
  }
  return next;
}

export function applyHistoryOps(
  states: Readonly<Record<string, HistoryPageState>>,
  ops: readonly SessionStoreOp[],
): Record<string, HistoryPageState> {
  const upserts = ops.filter((op): op is Extract<SessionStoreOp, { type: "upsert" }> => op.type === "upsert");
  let next = upserts.length > 0 ? markHistorySessionsLoaded(states, upserts.map((op) => op.session), "all") : { ...states };
  const removedKeys = new Set(
    ops
      .filter((op): op is Extract<SessionStoreOp, { type: "remove" }> => op.type === "remove")
      .map((op) => sessionStoreKeyParts(op.sourceId, op.runId)),
  );
  if (removedKeys.size === 0) {
    return next;
  }
  next = { ...next };
  for (const [key, state] of Object.entries(next)) {
    next[key] = removeLoadedKeys(state, removedKeys);
  }
  return next;
}

export function seedHistoryPageStates(
  instances: readonly WebInstance[],
  sessions: readonly Session[],
  page: { readonly offset: number; readonly hasMore: boolean; readonly total?: number },
): Record<string, HistoryPageState> {
  const allTotal = page.total;
  const allLoaded = page.offset + sessions.length;
  const allLoadedKeys = new Set(sessions.map((session) => sessionStoreKey(session)));
  const states: Record<string, HistoryPageState> = {
    all: {
      offset: allLoaded,
      hasMore: allTotal === undefined ? page.hasMore : allLoaded < allTotal,
      loading: false,
      loadedKeys: allLoadedKeys,
      ...(allTotal === undefined ? {} : { total: allTotal }),
    },
  };
  const loadedKeysBySource = new Map<string, Set<string>>();
  for (const session of sessions) {
    const sourceId = sessionSourceId(session);
    const loadedKeys = loadedKeysBySource.get(sourceId) ?? new Set<string>();
    loadedKeys.add(sessionStoreKey(session));
    loadedKeysBySource.set(sourceId, loadedKeys);
  }
  for (const instance of instances) {
    const loadedKeys = loadedKeysBySource.get(instance.sourceId) ?? new Set<string>();
    const offset = loadedKeys.size;
    const total = page.hasMore ? undefined : offset;
    states[instance.sourceId] = {
      offset,
      hasMore: total === undefined ? page.hasMore : offset < total,
      loading: false,
      loadedKeys,
      ...(total === undefined ? {} : { total }),
    };
  }
  return states;
}

export function historyStateFor(
  states: Readonly<Record<string, HistoryPageState>>,
  instance: string,
  status: ConnStatus,
  sessions: readonly Session[] = [],
): HistoryPageState {
  const key = historyKey(instance);
  if (status !== "live" && status !== "reconnecting") {
    return { offset: 0, hasMore: false, loading: false };
  }
  const known = states[key];
  if (known !== undefined) {
    const loadedOffset = known.loadedKeys?.size ?? loadedSessionCount(sessions, key);
    const offset = Math.max(known.offset, loadedOffset);
    return {
      ...known,
      offset,
      hasMore: known.total === undefined ? known.hasMore : offset < known.total,
    };
  }
  const all = states.all;
  if (key === "all") {
    return all ?? { offset: 0, hasMore: false, loading: false };
  }
  return { offset: loadedSessionCount(sessions, key), hasMore: all?.hasMore ?? true, loading: false };
}

/** Injected dependencies for {@link orchestrateLoadOlder} — the store wires these
 * to its refs/setters and the real `fetchSessionPage`; tests inject fakes. */
export interface LoadOlderDeps {
  readonly instance?: string;
  readonly getStatus: () => ConnStatus;
  readonly getSessions: () => readonly Session[];
  readonly getStates: () => Readonly<Record<string, HistoryPageState>>;
  readonly setSessions: (updater: (prev: Session[]) => Session[]) => void;
  readonly setHistoryStates: (updater: (prev: Record<string, HistoryPageState>) => Record<string, HistoryPageState>) => void;
  readonly fetchPage: (instance: string, options: FetchSessionsOptions) => Promise<SessionPage>;
  /** Notified with each freshly paged-in page so the store can protect those runs
   * from the live-fold cap (they were explicitly requested — must stay reachable). */
  readonly onPageLoaded?: (sessions: readonly Session[]) => void;
}

/**
 * The `loadOlder` fetch-orchestration seam: guard → mark-loading → fetch the next
 * page at the current offset → fold sessions + advance paging state, or record the
 * error and clear loading. Extracted from the React callback so the whole pipeline
 * (guards, transport, reducers, error path) is testable above the reducer level
 * without a browser. Returns once state has settled.
 */
export async function orchestrateLoadOlder(deps: LoadOlderDeps): Promise<void> {
  const status = deps.getStatus();
  if (status !== "live" && status !== "reconnecting") return;
  const key = historyKey(deps.instance);
  const current = historyStateFor(deps.getStates(), key, status, deps.getSessions());
  if (current.loading || !current.hasMore) return;

  deps.setHistoryStates((prev) => ({
    ...prev,
    [key]: { ...historyStateFor(prev, key, deps.getStatus(), deps.getSessions()), loading: true, error: undefined },
  }));

  try {
    const page = await deps.fetchPage(key, { limit: HISTORY_PAGE_SIZE, offset: current.offset });
    deps.onPageLoaded?.(page.sessions);
    deps.setSessions((prev) =>
      applySessionOps(prev, page.sessions.map((session): SessionStoreOp => ({ type: "upsert", session }))),
    );
    deps.setHistoryStates((prev) => markHistorySessionsLoaded(prev, page.sessions, key, page));
  } catch (error_) {
    deps.setHistoryStates((prev) => ({
      ...prev,
      [key]: {
        ...historyStateFor(prev, key, deps.getStatus(), deps.getSessions()),
        loading: false,
        error: error_ instanceof Error ? error_.message : String(error_),
      },
    }));
  }
}

export function RecorderProvider({ children }: { children: ReactNode }): ReactElement {
  const [instances, setInstances] = useState<WebInstance[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [status, setStatus] = useState<ConnStatus>("loading");
  const [error, setError] = useState<string | undefined>(undefined);
  const [historyStates, setHistoryStates] = useState<Record<string, HistoryPageState>>({});
  const [detailStatus, setDetailStatus] = useState<Record<string, DetailStatus>>({});
  const [reloadToken, setReloadToken] = useState(0);

  const instancesRef = useRef<WebInstance[]>([]);
  instancesRef.current = instances;
  const statusRef = useRef<ConnStatus>("loading");
  statusRef.current = status;
  const sessionsRef = useRef<Session[]>([]);
  sessionsRef.current = sessions;
  const inflight = useRef<Set<string>>(new Set());
  const historyStatesRef = useRef<Record<string, HistoryPageState>>({});
  historyStatesRef.current = historyStates;
  // Runs we've already fired a detail fetch for (attempted), so a legitimately
  // zero-step run isn't re-fetched on every open.
  const loadedDetail = useRef<Set<string>>(new Set());
  // Keys the user explicitly paged in via `loadOlder`. The live-fold cap must never
  // evict these (they'd otherwise vanish on the next SSE frame and become
  // unreachable, since paging offsets don't rewind) — so they stay reachable to
  // run #1 while live. Genuine removals prune the set below.
  const pagedKeys = useRef<Set<string>>(new Set());

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
    const appliedOps = [...ops.values()];
    // Genuine removals drop the run entirely — stop protecting it from the cap.
    for (const op of appliedOps) {
      if (op.type === "remove") {
        pagedKeys.current.delete(sessionStoreKeyParts(op.sourceId, op.runId));
      }
    }
    setSessions((prev) => {
      return applySessionOps(prev, appliedOps, MAX_LIVE_SESSIONS, pagedKeys.current);
    });
    setHistoryStates((prev) => applyHistoryOps(prev, appliedOps));
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
        setHistoryStates({});
        // Reset the paged-in protection set with the rest of the paging state: a
        // fresh snapshot has no user-paged history yet, so old keys must not linger
        // across reload+page cycles.
        pagedKeys.current = new Set();
        const [ins, page] = await Promise.all([fetchInstances(), fetchSessionPage("all", { limit: HISTORY_PAGE_SIZE })]);
        if (disposed) return;
        setInstances(ins);
        setSessions([...page.sessions].sort(byNewest));
        setHistoryStates(seedHistoryPageStates(ins, page.sessions, page));
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
          setHistoryStates({});
          setStatus("error");
          setError(error_ instanceof Error ? error_.message : String(error_));
          return;
        }
        // No backend — develop/verify against the bundled fixture.
        setInstances(FIXTURE_INSTANCES);
        setSessions([...FIXTURE_SESSIONS].sort(byNewest));
        setHistoryStates({});
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

  const loadOlder = useCallback((instance?: string) => {
    void orchestrateLoadOlder({
      instance,
      getStatus: () => statusRef.current,
      getSessions: () => sessionsRef.current,
      getStates: () => historyStatesRef.current,
      setSessions,
      setHistoryStates,
      fetchPage: fetchSessionPage,
      onPageLoaded: (loaded) => {
        for (const session of loaded) {
          pagedKeys.current.add(sessionStoreKey(session));
        }
      },
    });
  }, []);

  const ensureDetail = useCallback((key: string) => loadDetail(key, false), [loadDetail]);
  const retryDetail = useCallback((key: string) => {
    loadedDetail.current.delete(key);
    loadDetail(key, true);
  }, [loadDetail]);
  const reload = useCallback(() => {
    setReloadToken((n) => n + 1);
  }, []);

  const allHistory = historyStateFor(historyStates, "all", status, sessions);
  const canLoadOlderFor = useCallback(
    (instance: string) => historyStateFor(historyStates, instance, status, sessions).hasMore,
    [historyStates, sessions, status],
  );
  const loadingOlderFor = useCallback(
    (instance: string) => historyStateFor(historyStates, instance, status, sessions).loading,
    [historyStates, sessions, status],
  );
  const historyErrorFor = useCallback(
    (instance: string) => historyStateFor(historyStates, instance, status, sessions).error,
    [historyStates, sessions, status],
  );

  const value: RecorderStore = {
    instances,
    sessions,
    status,
    error,
    canLoadOlder: allHistory.hasMore,
    loadingOlder: allHistory.loading,
    historyError: allHistory.error,
    canLoadOlderFor,
    loadingOlderFor,
    historyErrorFor,
    detailStatus,
    loadOlder,
    ensureDetail,
    retryDetail,
    reload,
  };
  return createElement(RecorderContext.Provider, { value }, children);
}

export function useRecorder(): RecorderStore {
  const ctx = useContext(RecorderContext);
  if (!ctx) throw new Error("useRecorder must be used within <RecorderProvider>");
  return ctx;
}
