import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { api } from "./api";
import { DEFAULT_UPLOAD_LIMITS } from "./types";
import type {
  AgentSummary,
  Bootstrap,
  CatalogModel,
  CronOverview,
  SkillRegistryState,
  StartTurnInput,
  ThreadDetail,
  ThreadSummary,
  WebEvent,
} from "./types";
import {
  effectiveModelForAgent,
  effortLevelsForAgentModel,
  findCatalogModel,
  providerOfModel,
} from "./components/model-catalog";

export type ConnectionState = "connecting" | "live" | "reconnecting" | "offline";

interface ConsoleStoreValue {
  readonly bootstrap: Bootstrap | null;
  readonly agents: readonly AgentSummary[];
  readonly visibleAgents: readonly AgentSummary[];
  readonly threads: readonly ThreadSummary[];
  readonly visibleThreads: readonly ThreadSummary[];
  readonly selectedAgent: AgentSummary | null;
  readonly selectedThread: ThreadSummary | null;
  readonly detail: ThreadDetail | null;
  readonly selectedAgentId: string | null;
  readonly selectedThreadId: string | null;
  readonly loading: boolean;
  readonly detailLoading: boolean;
  readonly error: string | null;
  readonly actionError: string | null;
  readonly connection: ConnectionState;
  readonly showArchived: boolean;
  readonly showOfflineAgents: boolean;
  readonly hiddenOfflineAgentCount: number;
  readonly model: string;
  readonly effort: string;
  /** What the next turn will actually run on, override or agent default. */
  readonly effectiveModel: string;
  readonly effectiveEffort: string;
  /** True while this conversation overrides what the agent would start with. */
  readonly hasRunOverride: boolean;
  readonly resetRunOverride: () => void;
  readonly modelOptions: readonly string[];
  readonly effortOptions: readonly string[];
  readonly catalogByProvider: Readonly<Record<string, ProviderCatalogState>>;
  readonly ensureProviderCatalog: (provider: string) => Promise<void>;
  readonly skillRegistry: SkillRegistryState;
  readonly cronOverview: CronOverview | null;
  readonly cronLoading: boolean;
  readonly cronError: string | null;
  readonly hasMoreThreads: boolean;
  readonly hasOlderMessages: boolean;
  readonly selectAgent: (sourceId: string) => void;
  readonly setAgentPinned: (sourceId: string, pinned: boolean) => Promise<void>;
  readonly selectThread: (threadId: string) => void;
  readonly createThread: () => Promise<ThreadSummary>;
  readonly renameThread: (threadId: string, title: string) => Promise<void>;
  readonly archiveThread: (threadId: string) => Promise<void>;
  readonly unarchiveThread: (threadId: string) => Promise<void>;
  readonly deleteThread: (threadId: string) => Promise<void>;
  readonly sendTurn: (
    input: StartTurnInput,
    onThreadResolved?: (threadId: string) => void,
  ) => Promise<void>;
  readonly sendLiveInput: (text: string) => Promise<void>;
  readonly cancelTurn: () => Promise<void>;
  readonly setShowArchived: (show: boolean) => void;
  readonly setShowOfflineAgents: (show: boolean) => void;
  readonly setModel: (model: string) => void;
  readonly setEffort: (effort: string) => void;
  readonly retry: () => void;
  readonly clearActionError: () => void;
  readonly loadMoreThreads: () => Promise<void>;
  readonly loadOlderMessages: () => Promise<void>;
  readonly refreshCron: () => Promise<void>;
  readonly loadCronRunActivity: (runId: string) => Promise<void>;
}

const ConsoleStore = createContext<ConsoleStoreValue | null>(null);

const byMostRecent = (a: ThreadSummary, b: ThreadSummary) =>
  Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
const threadBucketKey = (sourceId: string, archived: boolean): string =>
  `${sourceId}\0${archived ? "archived" : "active"}`;
const cronChannelKey = (sourceId: string, jobId: string): string => `${sourceId}\0${jobId}`;

const mergeThreads = (
  current: readonly ThreadSummary[],
  incoming: readonly ThreadSummary[],
): ThreadSummary[] => {
  const merged = new Map(current.map((thread) => [thread.id, thread]));
  for (const thread of incoming) merged.set(thread.id, thread);
  return [...merged.values()].sort(byMostRecent);
};

export const cronChannelPath = (sourceId: string, jobId: string): string =>
  `/agents/${encodeURIComponent(sourceId)}/cron/${encodeURIComponent(jobId)}`;

const threadRoute = (thread: ThreadSummary | undefined): string =>
  thread?.trigger?.kind === "cron" && thread.trigger.jobId !== undefined
    ? cronChannelPath(thread.sourceId, thread.trigger.jobId)
    : "/";

const updateThreadRoute = (thread: ThreadSummary | undefined, replace = false): void => {
  const path = threadRoute(thread);
  if (window.location.pathname === path) return;
  window.history[replace ? "replaceState" : "pushState"](window.history.state, "", path);
};

const cronRouteSelection = (): { readonly sourceId: string; readonly jobId: string } | undefined => {
  const match = /^\/agents\/([^/]+)\/cron\/([^/]+)\/?$/u.exec(window.location.pathname);
  if (match === null) return undefined;
  try {
    return { sourceId: decodeURIComponent(match[1]!), jobId: decodeURIComponent(match[2]!) };
  } catch {
    return undefined;
  }
};

export const SELECTED_AGENT_STORAGE_KEY = "mono-agent.web.selected-agent";
export const SELECTED_THREADS_STORAGE_KEY = "mono-agent.web.selected-threads";
/** Bounded catalog walk: 5 x 100 rows is well past any advertised cap. */
const CATALOG_PAGE_LIMIT = 5;
/**
 * How long a fetched provider catalog is trusted before the next request for
 * it refetches. Nothing pushes a catalog change, and a page is only a snapshot
 * of what one agent process served at one moment: pulling an Ollama model or
 * editing local-provider config changes it under a process that never
 * restarts, so `AgentSummary.generation` cannot see it. Until this, a loaded
 * provider was never re-read at all for the life of the tab, and one tab kept
 * offering grades a second tab had already made the server reject.
 */
export const CATALOG_TTL_MS = 60_000;

export const RUN_PREFERENCES_STORAGE_KEY = "mono-agent.web.run-preferences";
export const preferenceKeyForThread = (sourceId: string, threadId: string | null): string =>
  JSON.stringify([sourceId, threadId ?? "new"]);

export interface StoredRunPreference {
  readonly model: string;
  readonly effort: string;
}

/**
 * One provider's lazily fetched `/v1/models` slice, cached per agent process.
 *
 * There is no cursor here on purpose. One was stored and never resumed, which
 * made the walk look continuable when it was not; a revalidation restarts from
 * the first page and replaces the rows, which is both simpler and the only
 * behaviour that can drop a model the provider no longer serves.
 */
export interface ProviderCatalogState {
  readonly models: readonly CatalogModel[];
  readonly status: "loading" | "loaded" | "error";
  /** `Date.now()` of the walk that produced `models`; absent until one has. */
  readonly fetchedAt?: number;
}

const asciiNoCase = (value: string): string =>
  value.replace(/[A-Z]/g, (character) =>
    String.fromCharCode(character.charCodeAt(0) + 32),
  );

export const sortAgentsPinnedFirst = (
  agents: readonly AgentSummary[],
): readonly AgentSummary[] => [...agents].sort((left, right) => {
  const pinOrder = Number(right.pinned) - Number(left.pinned);
  if (pinOrder !== 0) return pinOrder;
  // SQLite NOCASE folds ASCII only. Keep optimistic ordering identical to the
  // authoritative store so a refresh never makes international labels jump.
  const leftLabel = asciiNoCase(left.label);
  const rightLabel = asciiNoCase(right.label);
  if (leftLabel < rightLabel) return -1;
  if (leftLabel > rightLabel) return 1;
  return left.sourceId < right.sourceId ? -1 : left.sourceId > right.sourceId ? 1 : 0;
});

export const agentVisibility = (
  agents: readonly AgentSummary[],
  selectedAgentId: string | null,
  showOfflineAgents: boolean,
): {
  readonly visibleAgents: readonly AgentSummary[];
  readonly hiddenOfflineAgentCount: number;
} => {
  const hiddenIds = new Set(agents.flatMap((agent) =>
    agent.status === "offline" && !agent.pinned && agent.sourceId !== selectedAgentId
      ? [agent.sourceId]
      : [],
  ));
  return {
    visibleAgents: showOfflineAgents
      ? agents
      : agents.filter((agent) => !hiddenIds.has(agent.sourceId)),
    hiddenOfflineAgentCount: hiddenIds.size,
  };
};

export const readStoredRunPreferences = (): Record<string, StoredRunPreference> => {
  try {
    const stored = JSON.parse(localStorage.getItem(RUN_PREFERENCES_STORAGE_KEY) ?? "{}") as unknown;
    if (!stored || typeof stored !== "object" || Array.isArray(stored)) return {};
    return Object.fromEntries(
      Object.entries(stored).flatMap(([key, value]) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) return [];
        const candidate = value as { model?: unknown; effort?: unknown };
        if (typeof candidate.model !== "string" || typeof candidate.effort !== "string") return [];
        return [[key, { model: candidate.model, effort: candidate.effort }]];
      }),
    );
  } catch {
    return {};
  }
};

const readPersistedThreadIds = (): Record<string, string> => {
  try {
    const stored = JSON.parse(localStorage.getItem(SELECTED_THREADS_STORAGE_KEY) ?? "{}") as unknown;
    if (!stored || typeof stored !== "object" || Array.isArray(stored)) return {};
    return Object.fromEntries(
      Object.entries(stored).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
  } catch {
    return {};
  }
};

const persistThreadId = (sourceId: string, threadId: string | null): void => {
  const selections = readPersistedThreadIds();
  if (threadId) selections[sourceId] = threadId;
  else delete selections[sourceId];
  localStorage.setItem(SELECTED_THREADS_STORAGE_KEY, JSON.stringify(selections));
};

export const resolveBootstrapSelection = (
  next: Bootstrap,
  selectedAgentId: string | null,
  selectedThreadId: string | null,
  persistedThreadIds: Readonly<Record<string, string>> = {},
): { readonly agentId: string | null; readonly threadId: string | null } => {
  const currentAgent = next.agents.find((agent) => agent.sourceId === selectedAgentId);
  const agentId =
    currentAgent?.sourceId ??
    next.agents.find((agent) => agent.status !== "offline")?.sourceId ??
    next.agents[0]?.sourceId ??
    null;
  const currentThread = next.threads.find(
    (thread) => thread.id === selectedThreadId && thread.sourceId === agentId,
  );
  const persistedThread = next.threads.find(
    (thread) =>
      thread.id === persistedThreadIds[agentId ?? ""] &&
      thread.sourceId === agentId &&
      !thread.archivedAt,
  );
  const thread =
    currentThread ??
    persistedThread ??
    [...next.threads]
      .filter((candidate) => candidate.sourceId === agentId && !candidate.archivedAt)
      .sort(byMostRecent)[0];
  return { agentId, threadId: thread?.id ?? null };
};

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "The web console request failed.";

/**
 * How long any one thread write may take before it is abandoned. Writes to one
 * conversation are serialized (see `enqueueThreadWrite`), so an unbounded one
 * does not merely hang itself: it wedges every later write to that thread, and
 * the optimistic UI keeps showing a selection that never reached the server.
 */
export const THREAD_WRITE_TIMEOUT_MS = 15_000;

/**
 * Start one request under a deadline, and hand back the two different answers
 * a CALLER and a QUEUE need from it.
 *
 * `result` is the caller's. The signal is what a healthy `fetch` needs, and the
 * race is what makes the deadline hold anyway: a transport that ignores abort
 * (a proxy holding the socket, a service worker that never answers) would
 * otherwise leave it pending forever, and the whole point is that the caller
 * always settles.
 *
 * `settled` is the write chain's, and it is deliberately NOT the deadline. A
 * timeout aborts a request; it does not un-send it. Advancing the queue when
 * the deadline fired released the next write to the same conversation while the
 * abandoned one was still on the wire, and the older mutation landed last --
 * precisely the reordering the chain exists to prevent. A healthy `fetch`
 * rejects the moment it sees the abort, so the two settle together. A transport
 * that ignores abort now stalls that one conversation's queue rather than
 * silently reordering it, and the operator sees the timeout either way. Wedging
 * one visible queue is the honest failure; reordering writes is a silent one.
 */
export const startBoundedRequest = <T,>(
  run: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number = THREAD_WRITE_TIMEOUT_MS,
): { readonly result: Promise<T>; readonly settled: Promise<void> } => {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const attempt = run(controller.signal);
  // Also keeps the loser of the race handled, so a late rejection is never
  // reported as unhandled.
  const settled = attempt.then(() => undefined, () => undefined);
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("The web console request timed out."));
    }, timeoutMs);
  });
  const result = (async () => {
    try {
      return await Promise.race([attempt, deadline]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  })();
  return { result, settled };
};

/** {@link startBoundedRequest} for callers with no queue to advance. */
export const boundedRequest = <T,>(
  run: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number = THREAD_WRITE_TIMEOUT_MS,
): Promise<T> => startBoundedRequest(run, timeoutMs).result;

/**
 * How long a deleted conversation stays remembered. The tombstone exists to
 * reject responses that were already in flight when the delete landed, so it
 * has to outlive the longest request the console can have outstanding --
 * `THREAD_WRITE_TIMEOUT_MS` bounds every write, and reads are bounded by the
 * transport. Ten minutes is orders of magnitude past that and costs a string.
 */
export const REMOVED_THREAD_TTL_MS = 10 * 60_000;
/** Memory backstop only. See {@link createRemovedThreadRegistry}. */
export const REMOVED_THREAD_MEMORY = 4_096;

export interface RemovedThreadRegistry {
  readonly remember: (threadId: string) => void;
  /** Undo a {@link RemovedThreadRegistry.remember} whose delete then failed. */
  readonly forget: (threadId: string) => void;
  readonly has: (threadId: string) => boolean;
  readonly size: () => number;
}

/**
 * Deleted conversations remembered long enough to reject a late response.
 *
 * Eviction is by AGE, not by count. A fixed 256-entry ring dropped the oldest
 * tombstone on the 257th delete, and a response held across that delete then
 * put the conversation back -- the one thing a tombstone is for. The cap
 * survives only as a memory backstop, far enough above any plausible burst that
 * reaching it means something else is wrong; it does still drop the oldest
 * entry when reached, and that limit is real rather than argued away.
 */
export const createRemovedThreadRegistry = (
  now: () => number = () => Date.now(),
  ttlMs: number = REMOVED_THREAD_TTL_MS,
  cap: number = REMOVED_THREAD_MEMORY,
): RemovedThreadRegistry => {
  const removedAt = new Map<string, number>();
  const expired = (at: number): boolean => now() - at >= ttlMs;
  return {
    remember: (threadId) => {
      removedAt.delete(threadId);
      removedAt.set(threadId, now());
      // Insertion order is chronological, so the live entries are a suffix.
      for (const [candidate, at] of removedAt) {
        if (!expired(at)) break;
        removedAt.delete(candidate);
      }
      while (removedAt.size > cap) {
        const oldest = removedAt.keys().next().value;
        if (oldest === undefined) break;
        removedAt.delete(oldest);
      }
    },
    forget: (threadId) => { removedAt.delete(threadId); },
    has: (threadId) => {
      const at = removedAt.get(threadId);
      if (at === undefined) return false;
      if (expired(at)) {
        removedAt.delete(threadId);
        return false;
      }
      return true;
    },
    size: () => removedAt.size,
  };
};

/**
 * The threads a response may put into the projection.
 *
 * Every insertion path runs through this. The tombstone used to be consulted at
 * three of eleven of them, so a bootstrap, a thread page, or a selection fetch
 * held across a delete put the conversation straight back into the sidebar --
 * and `refreshNow` fires on every SSE event behind a 300 ms debounce, which
 * makes an in-flight bootstrap across a delete ordinary rather than exotic.
 */
const admitThreads = (
  removed: RemovedThreadRegistry,
  incoming: readonly ThreadSummary[],
): readonly ThreadSummary[] => incoming.filter((thread) => !removed.has(thread.id));

export interface ThreadWriteChain {
  readonly enqueue: <T>(
    threadId: string,
    run: (signal: AbortSignal) => Promise<T>,
    timeoutMs?: number,
  ) => Promise<T>;
  /** Resolve once every write ISSUED BEFORE THIS CALL has left the queue. */
  readonly settle: (threadId: string) => Promise<void>;
  /** Conversations with work in flight. */
  readonly pending: () => readonly string[];
}

/**
 * Serialize every write to one conversation. Ordering is the contract: two
 * operator choices released together landed in transport order, so the older
 * one could overwrite the newer, and the one-time migration could land after a
 * selection the operator had already made. Rename, archive and unarchive belong
 * here for the same reason -- they PATCH the same row and apply the whole
 * thread the server hands back, so a held rename response reset an archive that
 * had already completed.
 *
 * A module-level factory rather than a closure over refs so the ordering
 * invariant can be tested for what it is -- ordering -- with no React, no
 * fifteen-second deadline, and no knowledge of what any request looks like.
 *
 * `onDrain` fires when a conversation's queue empties.
 */
export const createThreadWriteChain = (
  onDrain: (threadId: string) => void = () => undefined,
): ThreadWriteChain => {
  const tails = new Map<string, Promise<unknown>>();
  return {
    enqueue: <T,>(
      threadId: string,
      run: (signal: AbortSignal) => Promise<T>,
      timeoutMs: number = THREAD_WRITE_TIMEOUT_MS,
    ): Promise<T> => {
      const previous = tails.get(threadId) ?? Promise.resolve();
      // The link is claimed synchronously, so writes issued in one tick chain
      // in issue order, and is resolved from inside the run with the request's
      // REAL settlement -- see `startBoundedRequest` for why that is not the
      // deadline. It is the link, never the caller's promise, so a failed write
      // hands the queue on rather than stranding every write behind it.
      let handOff!: (settled: Promise<void> | undefined) => void;
      const link = new Promise<unknown>((resolve) => { handOff = resolve; });
      tails.set(threadId, link);
      const next = previous.then(() => {
        let started: { readonly result: Promise<T>; readonly settled: Promise<void> };
        try {
          started = startBoundedRequest(run, timeoutMs);
        } catch (error) {
          // A synchronous throw still has to release the queue.
          handOff(undefined);
          throw error;
        }
        handOff(started.settled);
        return started.result;
      });
      void link.then(() => {
        if (tails.get(threadId) !== link) return;
        tails.delete(threadId);
        onDrain(threadId);
      });
      return next;
    },
    // One await is the whole guarantee: the tail read here already stands
    // behind every earlier write, and anything enqueued after it is by
    // definition not something this caller was waiting for.
    settle: async (threadId) => {
      const tail = tails.get(threadId);
      if (tail === undefined) return;
      await tail;
    },
    pending: () => [...tails.keys()],
  };
};

export const validateRunPreference = (
  agent: AgentSummary | null,
  preference: StoredRunPreference,
  advertisedProviders: readonly string[] = [],
  // The fetched catalog pages. A model reached only through `/v1/models` has no
  // `modelOptions` entry, so without this the effort it advertises is judged
  // against nothing and the selection the picker just offered is erased.
  catalogByProvider: Readonly<Record<string, readonly CatalogModel[]>> = {},
): StoredRunPreference => {
  // With no agent context there is nothing to judge the preference against.
  if (!agent) return preference;
  const advertisedModels = agent.models ?? [];
  // Discovery may briefly report an empty shortlist while the agent boots. The
  // operator's overrides are server-admitted by then (or harmless drafts), so
  // keep them: invalidating a real run selection against a boot blip would
  // silently erase what the conversation actually runs on.
  if (advertisedModels.length === 0) return preference;
  const advertisedProviderSet = new Set<string>([
    ...advertisedModels.map((reference) => providerOfModel(reference)),
    ...advertisedProviders,
  ]);
  const model = preference.model && (
    advertisedModels.includes(preference.model) ||
    advertisedProviderSet.has(providerOfModel(preference.model))
  )
    ? preference.model
    : "";
  const effectiveModel = effectiveModelForAgent(agent, model) ?? "";
  const efforts = effortLevelsForAgentModel(
    agent,
    effectiveModel,
    findCatalogModel(catalogByProvider, effectiveModel),
  );
  return {
    model,
    effort: preference.effort && efforts.includes(preference.effort)
      ? preference.effort
      : "",
  };
};

export function ConsoleStoreProvider({ children }: { readonly children: ReactNode }) {
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(() =>
    cronRouteSelection()?.sourceId ?? localStorage.getItem(SELECTED_AGENT_STORAGE_KEY),
  );
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ThreadDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [skillRegistryState, setSkillRegistryState] = useState<{
    readonly sourceId: string | null;
    readonly registry: SkillRegistryState;
  }>({ sourceId: null, registry: { status: "loading", items: [] } });
  const [skillRefreshToken, setSkillRefreshToken] = useState(0);
  const [cronRefreshToken, setCronRefreshToken] = useState(0);
  const [showArchived, setShowArchived] = useState(false);
  const [threadCursorByBucket, setThreadCursorByBucket] = useState<Record<string, string | null | undefined>>({});
  const [cronRunCursorByChannel, setCronRunCursorByChannel] = useState<Record<string, string | null | undefined>>({});
  const [cronOverview, setCronOverview] = useState<CronOverview | null>(null);
  const [cronLoading, setCronLoading] = useState(false);
  const [cronError, setCronError] = useState<string | null>(null);
  const [routeRevision, setRouteRevision] = useState(0);
  const [showOfflineAgents, setShowOfflineAgents] = useState(false);
  const [modelByContext, setModelByContext] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      Object.entries(readStoredRunPreferences()).map(([key, value]) => [key, value.model]),
    ),
  );
  const [effortByContext, setEffortByContext] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      Object.entries(readStoredRunPreferences()).map(([key, value]) => [key, value.effort]),
    ),
  );
  const [catalogByProvider, setCatalogByProvider] = useState<Record<string, ProviderCatalogState>>({});
  const catalogInFlightRef = useRef<Set<string>>(new Set());
  const migratedKeysRef = useRef<Set<string>>(new Set());
  // Bumped by every operator-initiated override write, PER THREAD. The
  // legacy-preference migration reads the thread and then patches it; a
  // selection made inside that window is newer than the browser-local value
  // being adopted, so the migration abandons rather than restoring the stale
  // value over it. One shared counter read any write anywhere as a write to
  // the migrating thread: changing thread B made A's migration drop A's
  // preference and send no PATCH, deleting it while A's server override stayed
  // null. The generation therefore has to be per conversation.
  const overrideWriteRef = useRef<Map<string, number>>(new Map());
  // Every write to one conversation -- the one-time migration, each operator
  // choice, rename, archive, unarchive -- queues behind the previous one, so
  // the server sees them in the order the operator made them. Two writes
  // released concurrently landed out of order, making the OLDER selection
  // final. See `createThreadWriteChain`.
  const threadWriteChainRef = useRef<ThreadWriteChain>(createThreadWriteChain(
    // The write generation only guards a migration, and a migration runs INSIDE
    // this chain: with the queue empty there is none left to guard. Kept, the
    // map grew one entry per conversation ever written to for the life of the
    // tab and was pruned only by a permanent delete.
    (threadId) => { overrideWriteRef.current.delete(threadId); },
  ));
  // Conversations deleted in this session. A response already in flight when
  // one was deleted must not put it back into the projection.
  const removedThreadsRef = useRef<RemovedThreadRegistry>(createRemovedThreadRegistry());
  const selectedThreadRef = useRef<string | null>(null);
  const selectedAgentRef = useRef<string | null>(selectedAgentId);
  /** The catalog scope a page walk was started under. See `catalogScope`. */
  const catalogScopeRef = useRef<string>("");
  const skillRequestGenerationRef = useRef(0);
  const skillRegistryStateRef = useRef(skillRegistryState);
  const refreshTimerRef = useRef<number | null>(null);
  const refreshInFlightRef = useRef(false);
  const refreshQueuedRef = useRef(false);
  const queueRefreshRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    const keys = new Set([...Object.keys(modelByContext), ...Object.keys(effortByContext)]);
    const stored = Object.fromEntries(
      [...keys].flatMap((key) => {
        const preference = {
          model: modelByContext[key] ?? "",
          effort: effortByContext[key] ?? "",
        };
        return preference.model || preference.effort ? [[key, preference]] : [];
      }),
    );
    localStorage.setItem(RUN_PREFERENCES_STORAGE_KEY, JSON.stringify(stored));
  }, [effortByContext, modelByContext]);

  useEffect(() => {
    selectedThreadRef.current = selectedThreadId;
  }, [selectedThreadId]);

  useEffect(() => {
    selectedAgentRef.current = selectedAgentId;
  }, [selectedAgentId]);

  useEffect(() => {
    skillRegistryStateRef.current = skillRegistryState;
  }, [skillRegistryState]);

  const applyBootstrap = useCallback((rawNext: Bootstrap) => {
    // A bootstrap is a wholesale replacement, so a deleted conversation it
    // still lists is re-added, selected, and routed to. It is also the single
    // most likely response to be in flight across a delete: `refreshNow` issues
    // one on every SSE event, including the one the delete itself produced.
    const next: Bootstrap = {
      ...rawNext,
      threads: admitThreads(removedThreadsRef.current, rawNext.threads),
    };
    setBootstrap(next);
    setError(null);
    setLoading(false);
    const baseSelection = resolveBootstrapSelection(
      next,
      selectedAgentRef.current,
      selectedThreadRef.current,
      readPersistedThreadIds(),
    );
    const route = cronRouteSelection();
    const routeThread = route === undefined
      ? undefined
      : next.threads.find((thread) =>
          thread.sourceId === route.sourceId
          && thread.trigger?.kind === "cron"
          && thread.trigger.jobId === route.jobId);
    const selection = routeThread === undefined
      ? baseSelection
      : { agentId: routeThread.sourceId, threadId: routeThread.id };
    selectedAgentRef.current = selection.agentId;
    selectedThreadRef.current = selection.threadId;
    setSelectedAgentId(selection.agentId);
    setSelectedThreadId(selection.threadId);
    if (selection.agentId) {
      localStorage.setItem(SELECTED_AGENT_STORAGE_KEY, selection.agentId);
      const selected = next.threads.find((thread) => thread.id === selection.threadId);
      persistThreadId(
        selection.agentId,
        selected && !selected.archivedAt ? selected.id : null,
      );
    }
  }, []);

  const loadBootstrap = useCallback(async () => {
    try {
      const next = await api.bootstrap();
      applyBootstrap(next);
      setConnection("live");
    } catch (loadError) {
      setError(errorMessage(loadError));
      setLoading(false);
      setConnection(navigator.onLine ? "reconnecting" : "offline");
    }
  }, [applyBootstrap]);

  useEffect(() => {
    void loadBootstrap();
  }, [loadBootstrap]);

  useEffect(() => {
    const onPopState = () => setRouteRevision((value) => value + 1);
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const loadThreadBucket = useCallback(async (
    sourceId: string,
    archived: boolean,
    before?: string,
  ) => {
    const page = await api.threads(sourceId, archived, before);
    const key = threadBucketKey(sourceId, archived);
    const admitted = admitThreads(removedThreadsRef.current, page.threads);
    setBootstrap((current) => {
      if (current === null) return current;
      const retained = before === undefined
        ? current.threads.filter((thread) =>
            thread.sourceId !== sourceId || Boolean(thread.archivedAt) !== archived)
        : current.threads;
      return { ...current, threads: mergeThreads(retained, admitted) };
    });
    setThreadCursorByBucket((current) => ({
      ...current,
      [key]: page.nextCursor ?? null,
    }));
  }, []);

  useEffect(() => {
    if (selectedAgentId === null) return;
    void loadThreadBucket(selectedAgentId, showArchived).catch((loadError: unknown) => {
      setActionError(errorMessage(loadError));
    });
  }, [loadThreadBucket, selectedAgentId, showArchived]);

  const loadThread = useCallback(async (threadId: string, signal: AbortSignal) => {
    setDetailLoading(true);
    try {
      const next = await api.thread(threadId, signal);
      if (removedThreadsRef.current.has(threadId)) return;
      if (selectedThreadRef.current === threadId) setDetail(next);
    } catch (loadError) {
      if (!signal.aborted) setActionError(errorMessage(loadError));
    } finally {
      if (selectedThreadRef.current === threadId) setDetailLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!selectedThreadId) {
      setDetail(null);
      setDetailLoading(false);
      return;
    }
    setDetail((current) => (current?.thread.id === selectedThreadId ? current : null));
    const controller = new AbortController();
    void loadThread(selectedThreadId, controller.signal);
    return () => controller.abort();
  }, [loadThread, selectedThreadId]);

  const refreshNow = useCallback(async () => {
    if (refreshInFlightRef.current) {
      refreshQueuedRef.current = true;
      return;
    }
    refreshInFlightRef.current = true;
    try {
      const [nextBootstrap, nextDetail] = await Promise.all([
        api.bootstrap(),
        selectedThreadRef.current ? api.thread(selectedThreadRef.current) : Promise.resolve(null),
      ]);
      applyBootstrap(nextBootstrap);
      if (
        nextDetail
        && !removedThreadsRef.current.has(nextDetail.thread.id)
        && selectedThreadRef.current === nextDetail.thread.id
      ) setDetail(nextDetail);
    } catch (refreshError) {
      setActionError(errorMessage(refreshError));
    } finally {
      refreshInFlightRef.current = false;
      if (refreshQueuedRef.current) {
        refreshQueuedRef.current = false;
        queueRefreshRef.current();
      }
    }
  }, [applyBootstrap]);

  const queueRefresh = useCallback(() => {
    if (refreshInFlightRef.current) {
      refreshQueuedRef.current = true;
      return;
    }
    if (refreshTimerRef.current !== null) return;
    refreshTimerRef.current = window.setTimeout(() => {
      refreshTimerRef.current = null;
      void refreshNow();
    }, 300);
  }, [refreshNow]);
  queueRefreshRef.current = queueRefresh;

  useEffect(() => {
    const events = new EventSource("/api/v1/events");
    const handleEvent = (event: Event) => {
      let eventType: WebEvent["type"] | undefined;
      try {
        const webEvent = JSON.parse((event as MessageEvent<string>).data) as WebEvent;
        if (webEvent.version !== 1) return;
        eventType = webEvent.type;
        if (webEvent.type === "push.pending") {
          window.dispatchEvent(new CustomEvent("mono-agent:push-pending", { detail: webEvent.payload }));
          setConnection("live");
          return;
        }
      } catch {
        // A ready ping without JSON still proves the stream is alive.
      }
      setConnection("live");
      if (eventType === "ready" || eventType === "agents.changed") {
        setSkillRefreshToken((value) => value + 1);
      }
      if (eventType === "ready" || eventType === "agents.changed" || eventType === "cron.changed") {
        setCronRefreshToken((value) => value + 1);
      }
      queueRefresh();
    };
    const eventTypes: WebEvent["type"][] = [
      "ready",
      "agents.changed",
      "cron.changed",
      "threads.changed",
      "thread.changed",
      "message.changed",
      "turn.changed",
      "attachment.changed",
      "push.pending",
    ];
    events.onopen = () => {
      setConnection("live");
      setSkillRefreshToken((value) => value + 1);
    };
    events.onmessage = handleEvent;
    for (const type of eventTypes) events.addEventListener(type, handleEvent);
    events.onerror = () => setConnection(navigator.onLine ? "reconnecting" : "offline");
    const onOnline = () => {
      setConnection("reconnecting");
      setSkillRefreshToken((value) => value + 1);
      queueRefresh();
    };
    const onOffline = () => setConnection("offline");
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      events.close();
      for (const type of eventTypes) events.removeEventListener(type, handleEvent);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      if (refreshTimerRef.current !== null) window.clearTimeout(refreshTimerRef.current);
    };
  }, [queueRefresh]);

  const agents = useMemo(
    () => sortAgentsPinnedFirst(bootstrap?.agents ?? []),
    [bootstrap?.agents],
  );
  const threads = bootstrap?.threads ?? [];
  const selectedAgent =
    agents.find((agent) => agent.sourceId === selectedAgentId) ?? null;
  // The catalog cache is per agent AND per agent PROCESS. A source id outlives
  // the process behind it: reconfigure an agent and restart it and the next
  // generation advertises a different catalog under the same id. Keyed on the
  // id alone, a tab kept offering the retired generation's models until it was
  // reloaded, and `startTurn` rejected every turn that used one. The browser
  // had nothing generation-shaped to watch until `AgentSummary.generation`.
  const catalogScope = `${selectedAgentId ?? ""}\u0000${selectedAgent?.generation ?? ""}`;
  // Assigned during render, like `queueRefreshRef` below: an in-flight page
  // walk has to compare against the CURRENT scope, and an effect would leave it
  // comparing against the previous one for a whole commit.
  catalogScopeRef.current = catalogScope;
  useEffect(() => {
    setCatalogByProvider({});
    catalogInFlightRef.current.clear();
  }, [catalogScope]);
  const skillRegistry = skillRegistryState.sourceId === selectedAgentId
    ? skillRegistryState.registry
    : { status: "loading" as const, items: [] as const };
  const { visibleAgents, hiddenOfflineAgentCount } = useMemo(
    () => agentVisibility(agents, selectedAgentId, showOfflineAgents),
    [agents, selectedAgentId, showOfflineAgents],
  );
  const selectedThread =
    threads.find((thread) => thread.id === selectedThreadId) ?? detail?.thread ?? null;
  const visibleThreads = useMemo(
    () =>
      [...threads]
        .filter(
          (thread) =>
            thread.sourceId === selectedAgentId && Boolean(thread.archivedAt) === showArchived,
        )
        .sort(byMostRecent),
    [selectedAgentId, showArchived, threads],
  );
  const activeBucketKey = selectedAgentId === null
    ? undefined
    : threadBucketKey(selectedAgentId, showArchived);
  const hasMoreThreads = activeBucketKey !== undefined
    && typeof threadCursorByBucket[activeBucketKey] === "string";
  const selectedCronJobId = selectedThread?.trigger?.kind === "cron"
    ? selectedThread.trigger.jobId
    : undefined;
  const selectedCronThreadId = selectedCronJobId === undefined ? undefined : selectedThread?.id;
  const selectedCronChannelKey = selectedAgentId === null || selectedCronJobId === undefined
    ? undefined
    : cronChannelKey(selectedAgentId, selectedCronJobId);
  const hasOlderMessages = detail?.messagesNextCursor !== undefined
    || (selectedAgent?.cron?.read === true
      && selectedCronChannelKey !== undefined
      && typeof cronRunCursorByChannel[selectedCronChannelKey] === "string");

  const loadMoreThreads = useCallback(async () => {
    if (selectedAgentId === null) return;
    const cursor = threadCursorByBucket[threadBucketKey(selectedAgentId, showArchived)];
    if (typeof cursor !== "string") return;
    await loadThreadBucket(selectedAgentId, showArchived, cursor);
  }, [loadThreadBucket, selectedAgentId, showArchived, threadCursorByBucket]);

  const loadOlderMessages = useCallback(async () => {
    const current = detail;
    if (current === null) return;
    if (current.messagesNextCursor !== undefined) {
      const page = await api.messages(current.thread.id, current.messagesNextCursor);
      setDetail((latest) => {
        if (latest?.thread.id !== current.thread.id) return latest;
        const ids = new Set(latest.messages.map((message) => message.id));
        const messages = [...page.messages.filter((message) => !ids.has(message.id)), ...latest.messages];
        if (page.nextCursor !== undefined) return { ...latest, messages, messagesNextCursor: page.nextCursor };
        const { messagesNextCursor: _cursor, ...withoutCursor } = latest;
        return { ...withoutCursor, messages };
      });
      return;
    }
    if (
      selectedAgent?.cron?.read !== true
      || selectedAgentId === null
      || selectedCronJobId === undefined
      || selectedCronThreadId !== current.thread.id
      || selectedCronChannelKey === undefined
    ) return;
    const cursor = cronRunCursorByChannel[selectedCronChannelKey];
    if (typeof cursor !== "string") return;
    const page = await api.cronRuns(selectedAgentId, selectedCronJobId, cursor);
    setCronRunCursorByChannel((latest) => ({
      ...latest,
      [selectedCronChannelKey]: page.nextCursor ?? null,
    }));
    setDetail((latest) => {
      if (latest?.thread.id !== current.thread.id) return latest;
      const ids = new Set(latest.messages.map((message) => message.id));
      const messages = [
        ...(page.messages ?? []).filter((message) => !ids.has(message.id)),
        ...latest.messages,
      ];
      return { ...latest, messages };
    });
  }, [
    cronRunCursorByChannel,
    detail,
    selectedAgent?.cron?.read,
    selectedAgentId,
    selectedCronChannelKey,
    selectedCronJobId,
    selectedCronThreadId,
  ]);

  const refreshCron = useCallback(async () => {
    const sourceId = selectedAgentId;
    const jobId = selectedCronJobId;
    if (sourceId === null || selectedAgent?.cron?.read !== true) {
      setCronOverview(null);
      setCronError(null);
      return;
    }
    setCronLoading(true);
    setCronError(null);
    try {
      const overview = await api.cronOverview(sourceId);
      setCronOverview(overview);
      await loadThreadBucket(sourceId, showArchived);
      if (jobId !== undefined) {
        const page = await api.cronRuns(sourceId, jobId);
        const channelKey = cronChannelKey(sourceId, jobId);
        setCronRunCursorByChannel((current) => Object.prototype.hasOwnProperty.call(current, channelKey)
          ? current
          : { ...current, [channelKey]: page.nextCursor ?? null });
        const nextDetail = await api.thread(selectedCronThreadId!);
        if (selectedThreadRef.current === nextDetail.thread.id) setDetail(nextDetail);
      }
    } catch (cronError) {
      setCronError(errorMessage(cronError));
    } finally {
      setCronLoading(false);
    }
  }, [
    loadThreadBucket,
    selectedAgent?.cron?.read,
    selectedAgentId,
    selectedCronJobId,
    selectedCronThreadId,
    showArchived,
  ]);

  const loadCronRunActivity = useCallback(async (runId: string) => {
    const sourceId = selectedAgentId;
    const jobId = selectedCronJobId;
    const threadId = selectedCronThreadId;
    if (sourceId === null || jobId === undefined || threadId === undefined) return;
    setCronLoading(true);
    setCronError(null);
    try {
      const message = await api.cronRun(sourceId, jobId, runId);
      setDetail((current) => {
        if (current?.thread.id !== threadId) return current;
        const exists = current.messages.some((candidate) => candidate.id === message.id);
        return {
          ...current,
          messages: exists
            ? current.messages.map((candidate) => candidate.id === message.id ? message : candidate)
            : [...current.messages, message].sort((left, right) =>
                left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)),
        };
      });
    } catch (loadError) {
      setCronError(errorMessage(loadError));
    } finally {
      setCronLoading(false);
    }
  }, [selectedAgentId, selectedCronJobId, selectedCronThreadId]);

  useEffect(() => {
    void refreshCron();
  }, [cronRefreshToken, refreshCron]);

  useEffect(() => {
    const generation = ++skillRequestGenerationRef.current;
    const sourceId = selectedAgentId;
    const prior = skillRegistryStateRef.current;
    const retainAsStale = (): SkillRegistryState => {
      if (
        prior.sourceId === sourceId
        && (prior.registry.status === "ready" || prior.registry.status === "stale")
      ) {
        return {
          status: "stale",
          items: prior.registry.items,
          total: prior.registry.total,
          ...(prior.registry.truncated === true ? { truncated: true } : {}),
        };
      }
      return selectedAgent?.status === "offline"
        ? { status: "offline", items: [] }
        : { status: "loading", items: [] };
    };

    if (sourceId === null) {
      setSkillRegistryState({ sourceId: null, registry: { status: "loading", items: [] } });
      return;
    }
    if (selectedAgent?.status === "offline" || connection !== "live") {
      setSkillRegistryState({ sourceId, registry: retainAsStale() });
      return;
    }

    const controller = new AbortController();
    setSkillRegistryState({
      sourceId,
      registry: prior.sourceId === sourceId
        && (prior.registry.status === "ready" || prior.registry.status === "stale")
        ? retainAsStale()
        : { status: "loading", items: [] },
    });
    void api.agentSkills(sourceId, controller.signal).then((registry) => {
      if (controller.signal.aborted || generation !== skillRequestGenerationRef.current) return;
      setSkillRegistryState({ sourceId, registry });
    }).catch(() => {
      if (controller.signal.aborted || generation !== skillRequestGenerationRef.current) return;
      setSkillRegistryState({
        sourceId,
        registry: prior.sourceId === sourceId
          && (prior.registry.status === "ready" || prior.registry.status === "stale")
          ? retainAsStale()
          : { status: "error", items: [] },
      });
    });
    return () => controller.abort();
  }, [connection, selectedAgent?.status, selectedAgentId, skillRefreshToken]);

  const selectAgent = useCallback(
    (sourceId: string) => {
      selectedAgentRef.current = sourceId;
      setSelectedAgentId(sourceId);
      localStorage.setItem(SELECTED_AGENT_STORAGE_KEY, sourceId);
      const persistedId = readPersistedThreadIds()[sourceId];
      const persisted = threads.find(
        (thread) =>
          thread.id === persistedId && thread.sourceId === sourceId && !thread.archivedAt,
      );
      const recent = persisted ?? [...threads]
        .filter((thread) => thread.sourceId === sourceId && !thread.archivedAt)
        .sort(byMostRecent)[0];
      selectedThreadRef.current = recent?.id ?? null;
      setSelectedThreadId(recent?.id ?? null);
      persistThreadId(sourceId, recent?.id ?? null);
      updateThreadRoute(recent);
      setShowArchived(false);
      setActionError(null);
    },
    [threads],
  );

  const setAgentPinned = useCallback(async (sourceId: string, pinned: boolean) => {
    try {
      const agent = await api.patchAgent(sourceId, pinned);
      setBootstrap((current) => current
        ? {
            ...current,
            agents: sortAgentsPinnedFirst(
              current.agents.map((item) => item.sourceId === sourceId
                ? { ...item, pinned: agent.pinned }
                : item),
            ),
          }
        : current);
      setActionError(null);
      queueRefresh();
    } catch (pinError) {
      setActionError(errorMessage(pinError));
      throw pinError;
    }
  }, [queueRefresh]);

  const selectThread = useCallback(
    (threadId: string) => {
      const thread = threads.find((candidate) => candidate.id === threadId);
      if (thread) {
        selectedAgentRef.current = thread.sourceId;
        setSelectedAgentId(thread.sourceId);
        localStorage.setItem(SELECTED_AGENT_STORAGE_KEY, thread.sourceId);
        if (!thread.archivedAt) persistThreadId(thread.sourceId, thread.id);
        updateThreadRoute(thread);
      }
      selectedThreadRef.current = threadId;
      setSelectedThreadId(threadId);
      setActionError(null);
      if (thread === undefined) {
        void api.thread(threadId).then((next) => {
          const canonical = next.thread;
          // Deleted while this fetch was outstanding: selecting it now would
          // re-add it, route to it, and persist it as this agent's selection.
          if (removedThreadsRef.current.has(canonical.id)) return;
          setBootstrap((current) => current === null
            ? current
            : { ...current, threads: mergeThreads(current.threads, [canonical]) });
          setDetail(next);
          selectedAgentRef.current = canonical.sourceId;
          selectedThreadRef.current = canonical.id;
          setSelectedAgentId(canonical.sourceId);
          setSelectedThreadId(canonical.id);
          localStorage.setItem(SELECTED_AGENT_STORAGE_KEY, canonical.sourceId);
          if (!canonical.archivedAt) persistThreadId(canonical.sourceId, canonical.id);
          updateThreadRoute(canonical, true);
        }).catch((selectionError: unknown) => setActionError(errorMessage(selectionError)));
      }
    },
    [threads],
  );

  useEffect(() => {
    const route = cronRouteSelection();
    if (route === undefined) return;
    const job = cronOverview?.jobs.find(
      (candidate) => candidate.jobId === route.jobId,
    );
    if (job === undefined || route.sourceId !== selectedAgentId) return;
    if (selectedThreadRef.current !== job.threadId) selectThread(job.threadId);
  }, [cronOverview, routeRevision, selectThread, selectedAgentId]);

  const createThread = useCallback(async () => {
    if (!selectedAgentId) throw new Error("Select an agent before starting a conversation.");
    try {
      const thread = await api.createThread(selectedAgentId);
      const draftPreferenceKey = preferenceKeyForThread(selectedAgentId, null);
      const threadPreferenceKey = preferenceKeyForThread(selectedAgentId, thread.id);
      setModelByContext((current) => {
        if (current[draftPreferenceKey] === undefined) return current;
        const next = { ...current, [threadPreferenceKey]: current[draftPreferenceKey] ?? "" };
        delete next[draftPreferenceKey];
        return next;
      });
      setEffortByContext((current) => {
        if (current[draftPreferenceKey] === undefined) return current;
        const next = { ...current, [threadPreferenceKey]: current[draftPreferenceKey] ?? "" };
        delete next[draftPreferenceKey];
        return next;
      });
      selectedThreadRef.current = thread.id;
      setSelectedThreadId(thread.id);
      persistThreadId(selectedAgentId, thread.id);
      setShowArchived(false);
      updateThreadRoute(thread);
      setBootstrap((current) =>
        current ? { ...current, threads: [thread, ...current.threads] } : current,
      );
      setDetail({ thread, messages: [] });
      setActionError(null);
      return thread;
    } catch (createError) {
      setActionError(errorMessage(createError));
      throw createError;
    }
  }, [selectedAgentId]);

  const fetchThreadSummary = useCallback(async (threadId: string): Promise<ThreadSummary> => {
    const known = threads.find((candidate) => candidate.id === threadId) ??
      (detail?.thread.id === threadId ? detail.thread : undefined);
    if (known !== undefined) return known;
    const fetched = await api.thread(threadId);
    if (removedThreadsRef.current.has(fetched.thread.id)) {
      throw new Error("This conversation was deleted.");
    }
    setBootstrap((current) => current === null
      ? current
      : { ...current, threads: mergeThreads(current.threads, [fetched.thread]) });
    return fetched.thread;
  }, [detail, threads]);

  const applyThreadUpdate = useCallback((nextThread: ThreadSummary) => {
    // A response can outlive the conversation it describes: the migration's
    // read, an optimistic rollback, any write already in flight when the
    // operator deleted the thread. `mergeThreads` would re-add it, so the
    // sidebar showed a conversation the server had already destroyed.
    if (removedThreadsRef.current.has(nextThread.id)) return;
    setBootstrap((current) =>
      current ? { ...current, threads: mergeThreads(current.threads, [nextThread]) } : current,
    );
    setDetail((current) =>
      current?.thread.id === nextThread.id ? { ...current, thread: nextThread } : current,
    );
  }, []);

  const enqueueThreadWrite = useCallback(<T,>(
    threadId: string,
    run: (signal: AbortSignal) => Promise<T>,
    timeoutMs?: number,
  ): Promise<T> => threadWriteChainRef.current.enqueue(threadId, run, timeoutMs), []);

  const settleThreadWrites = useCallback(
    async (threadId: string): Promise<void> => threadWriteChainRef.current.settle(threadId),
    [],
  );

  const renameThread = useCallback(async (threadId: string, title: string) => {
    const trimmed = title.trim();
    if (!trimmed) return;
    try {
      const target = await fetchThreadSummary(threadId);
      // Queued and bounded like every other write to this conversation. Rename,
      // archive and the override writes all PATCH the same row and all apply
      // the COMPLETE thread the server returns, so two in flight together let
      // the older response overwrite the newer state: holding a rename until an
      // archive had completed put `archivedAt` back to null.
      const thread = await enqueueThreadWrite(target.id, (signal) =>
        api.patchThread(target.id, { title: trimmed }, signal));
      applyThreadUpdate(thread);
    } catch (renameError) {
      setActionError(errorMessage(renameError));
      throw renameError;
    }
  }, [applyThreadUpdate, enqueueThreadWrite, fetchThreadSummary]);

  const archiveThread = useCallback(
    async (threadId: string) => {
      try {
        const target = await fetchThreadSummary(threadId);
        const thread = await enqueueThreadWrite(target.id, (signal) =>
          api.patchThread(target.id, { archived: true }, signal));
        applyThreadUpdate(thread);
        if (selectedThreadRef.current === target.id || selectedThreadRef.current === threadId) {
          const replacement = visibleThreads.find((item) => item.id !== target.id);
          selectedThreadRef.current = replacement?.id ?? null;
          setSelectedThreadId(replacement?.id ?? null);
          persistThreadId(thread.sourceId, replacement?.id ?? null);
          updateThreadRoute(replacement, true);
        } else if (readPersistedThreadIds()[thread.sourceId] === target.id) {
          persistThreadId(thread.sourceId, null);
        }
      } catch (archiveError) {
        setActionError(errorMessage(archiveError));
        throw archiveError;
      }
    },
    [applyThreadUpdate, enqueueThreadWrite, fetchThreadSummary, visibleThreads],
  );

  const unarchiveThread = useCallback(async (threadId: string) => {
    try {
      const target = await fetchThreadSummary(threadId);
      const thread = await enqueueThreadWrite(target.id, (signal) =>
        api.patchThread(target.id, { archived: false }, signal));
      applyThreadUpdate(thread);
      selectedThreadRef.current = thread.id;
      setSelectedThreadId(thread.id);
      persistThreadId(thread.sourceId, thread.id);
      setShowArchived(false);
      updateThreadRoute(thread, true);
    } catch (unarchiveError) {
      setActionError(errorMessage(unarchiveError));
      throw unarchiveError;
    }
  }, [applyThreadUpdate, enqueueThreadWrite, fetchThreadSummary]);

  const deleteThread = useCallback(async (threadId: string) => {
    try {
      const thread = await fetchThreadSummary(threadId);
      // Tombstoned BEFORE the round trip, and reversed if the round trip fails.
      // Recorded afterwards, every response that arrived DURING the delete --
      // the bootstrap `refreshNow` issues on the delete's own SSE event, a
      // queued write's result -- was admitted, and the conversation came back.
      //
      // Deliberately NOT queued behind this conversation's other writes, unlike
      // every other mutation. A delete produces no thread snapshot for a later
      // response to overwrite, and the tombstone already makes every earlier
      // response inert, so ordering buys nothing here -- while queueing would
      // make the operator wait out a stalled write's full deadline before a
      // conversation they asked to remove disappeared. It is still bounded.
      removedThreadsRef.current.remember(thread.id);
      try {
        await boundedRequest((signal) => api.deleteThread(thread.id, signal));
      } catch (deleteRequestError) {
        removedThreadsRef.current.forget(thread.id);
        throw deleteRequestError;
      }
      // Nothing can write to it again, so its write generation is dead weight.
      overrideWriteRef.current.delete(thread.id);
      const preferenceKey = preferenceKeyForThread(thread.sourceId, thread.id);
      setModelByContext((current) => {
        const next = { ...current };
        delete next[preferenceKey];
        return next;
      });
      setEffortByContext((current) => {
        const next = { ...current };
        delete next[preferenceKey];
        return next;
      });
      setBootstrap((current) => current
        ? { ...current, threads: current.threads.filter((item) => item.id !== thread.id) }
        : current);
      if (selectedThreadRef.current === thread.id || selectedThreadRef.current === threadId) {
        const replacement = visibleThreads.find((item) => item.id !== thread.id);
        selectedThreadRef.current = replacement?.id ?? null;
        setSelectedThreadId(replacement?.id ?? null);
        setDetail(null);
        updateThreadRoute(replacement, true);
      }
      if (readPersistedThreadIds()[thread.sourceId] === thread.id) {
        persistThreadId(thread.sourceId, null);
      }
      setActionError(null);
    } catch (deleteError) {
      setActionError(errorMessage(deleteError));
      throw deleteError;
    }
  }, [fetchThreadSummary, visibleThreads]);

  const ensureProviderCatalog = useCallback(async (provider: string) => {
    const sourceId = selectedAgentId;
    const scope = catalogScope;
    if (!sourceId || !provider) return;
    if (catalogInFlightRef.current.has(provider)) return;
    const existing = catalogByProvider[provider];
    // Revalidate rather than trust forever. An `"error"` entry always refetches;
    // a `"loaded"` one refetches once it is older than `CATALOG_TTL_MS`, which
    // is the only thing that can notice a catalog changing under a live
    // process. A `"loading"` entry is already being fetched.
    const fresh = existing !== undefined
      && existing.status !== "error"
      && (existing.status === "loading"
        || Date.now() - (existing.fetchedAt ?? 0) < CATALOG_TTL_MS);
    if (fresh) return;
    catalogInFlightRef.current.add(provider);
    setCatalogByProvider((current) => ({
      ...current,
      [provider]: { models: [...(current[provider]?.models ?? [])], status: "loading" },
    }));
    try {
      // Follow the cursor instead of treating the first page as the whole
      // catalog. A provider whose `maxAdvertisedModels` exceeds the 100-row
      // page size otherwise shows only its first page, with the rest silently
      // unreachable. Bounded so a large or misbehaving producer cannot make the
      // picker fetch forever; the agent caps what it advertises anyway.
      const collected: CatalogModel[] = [];
      let cursor: string | undefined;
      let lastCursor: string | undefined;
      for (let page = 0; page < CATALOG_PAGE_LIMIT; page += 1) {
        const result = await api.agentModels(sourceId, provider, cursor);
        if (selectedAgentRef.current !== sourceId || catalogScopeRef.current !== scope) return;
        collected.push(...result.models);
        // A producer that repeats a cursor would loop forever; stop instead.
        if (result.nextCursor === undefined || result.nextCursor === lastCursor) {
          cursor = undefined;
          break;
        }
        lastCursor = result.nextCursor;
        cursor = result.nextCursor;
      }
      const fetchedAt = Date.now();
      setCatalogByProvider((current) => {
        // Replaced, not merged into what was already held: a revalidation that
        // merged could never drop a model the provider had stopped serving.
        const deduped = new Map(collected.map((catalog) => [catalog.id, catalog]));
        return {
          ...current,
          [provider]: { models: [...deduped.values()], status: "loaded", fetchedAt },
        };
      });
    } catch {
      if (selectedAgentRef.current !== sourceId || catalogScopeRef.current !== scope) return;
      setCatalogByProvider((current) => ({
        ...current,
        [provider]: { models: [...(current[provider]?.models ?? [])], status: "error" },
      }));
    } finally {
      catalogInFlightRef.current.delete(provider);
    }
  }, [catalogByProvider, catalogScope, selectedAgentId]);

  // The fetched catalog pages flattened to what the effort helpers consume.
  // Every effort decision below reads this same projection, so the picker rows,
  // the validated stored preference, and the ladder a model switch re-checks
  // against cannot disagree about what a catalog-only model supports.
  const catalogModels = useMemo<Readonly<Record<string, readonly CatalogModel[]>>>(
    () => Object.fromEntries(
      Object.entries(catalogByProvider).map(([provider, state]) => [provider, state.models]),
    ),
    [catalogByProvider],
  );

  const modelOptions = selectedAgent?.models ?? [];
  const preferenceKey = selectedAgentId
    ? preferenceKeyForThread(selectedAgentId, selectedThreadId)
    : "";
  // Overrides live on the thread (persisted by the server). Browser-local
  // prefs survive only for threads that have not been migrated yet, which keeps
  // the one-time PATCH that adopts them from ever overriding a real server
  // value.
  const serverOverrideActive =
    selectedThread !== null &&
    ((selectedThread.runModel ?? null) !== null || (selectedThread.runEffort ?? null) !== null);
  const storedPreference = serverOverrideActive
    ? { model: selectedThread?.runModel ?? "", effort: selectedThread?.runEffort ?? "" }
    : {
        model: modelByContext[preferenceKey] ?? "",
        effort: effortByContext[preferenceKey] ?? "",
      };
  const advertisedProviders = Object.keys(catalogByProvider);
  const validatedPreference = validateRunPreference(
    selectedAgent,
    storedPreference,
    advertisedProviders,
    catalogModels,
  );
  const model = validatedPreference.model;
  const effectiveModel = selectedAgent
    ? effectiveModelForAgent(selectedAgent, model) ?? ""
    : "";
  const effortOptions = effortLevelsForAgentModel(
    selectedAgent,
    effectiveModel,
    findCatalogModel(catalogModels, effectiveModel),
  );
  const effort = validatedPreference.effort;
  const effectiveEffort = effort || selectedAgent?.defaultEffort || "";
  // An override is what the operator chose for THIS conversation, as opposed to
  // whatever the agent would otherwise start with.
  const hasRunOverride = model.length > 0 || effort.length > 0;

  useEffect(() => {
    if (!preferenceKey || serverOverrideActive) return;
    if (storedPreference.model !== validatedPreference.model) {
      setModelByContext((current) => ({
        ...current,
        [preferenceKey]: validatedPreference.model,
      }));
    }
    if (storedPreference.effort !== validatedPreference.effort) {
      setEffortByContext((current) => ({
        ...current,
        [preferenceKey]: validatedPreference.effort,
      }));
    }
  }, [
    preferenceKey,
    serverOverrideActive,
    storedPreference.effort,
    storedPreference.model,
    validatedPreference.effort,
    validatedPreference.model,
  ]);

  // One-time adoption of a browser-local override into the thread's server
  // fields. A server value always wins, and a reset can never resurrect a
  // migrated key because the local copy is dropped once patched.
  //
  // Two windows have to stay closed here:
  //
  // 1. `selectedThread` falls back to `detail?.thread` when the selected id
  //    resolves to nothing, so right after switching to an agent that has no
  //    conversation it still points at the PREVIOUS agent's thread while
  //    `preferenceKey` already names the new one. Patching then wrote one
  //    agent's local override onto another agent's thread. The projection must
  //    therefore be the thread `preferenceKey` was built from.
  // 2. The projection can also be stale -- another tab or device may have set
  //    an override this tab has not observed -- so the decision is re-checked
  //    against a fresh read immediately before patching, and abandoned if the
  //    operator changed model or effort inside that round trip. Their choice
  //    already went to the server and is newer than the value being adopted.
  useEffect(() => {
    if (!selectedThread || !preferenceKey) return;
    if (selectedThread.id !== selectedThreadId || selectedThread.sourceId !== selectedAgentId) return;
    if (migratedKeysRef.current.has(preferenceKey)) return;
    if (
      (selectedThread.runModel ?? null) !== null ||
      (selectedThread.runEffort ?? null) !== null
    ) return;
    const local = {
      model: modelByContext[preferenceKey] ?? "",
      effort: effortByContext[preferenceKey] ?? "",
    };
    if (local.model === "" && local.effort === "") return;
    const threadId = selectedThread.id;
    const writeGeneration = overrideWriteRef.current.get(threadId) ?? 0;
    migratedKeysRef.current.add(preferenceKey);
    const dropLocal = () => {
      setModelByContext((current) => {
        const nextMap = { ...current };
        delete nextMap[preferenceKey];
        return nextMap;
      });
      setEffortByContext((current) => {
        const nextMap = { ...current };
        delete nextMap[preferenceKey];
        return nextMap;
      });
    };
    // Queued like any other write to this conversation, so an operator choice
    // made while it runs is sent after it rather than racing it. The body
    // reports its own failures, so nothing here can reject.
    void enqueueThreadWrite(threadId, async (signal) => {
      try {
        const fresh = await api.thread(threadId, signal);
        if (removedThreadsRef.current.has(threadId)) {
          dropLocal();
          return;
        }
        if (
          (fresh.thread.runModel ?? null) !== null
          || (fresh.thread.runEffort ?? null) !== null
        ) {
          // Someone set an override while this tab held a stale projection.
          // Adopt theirs and drop the local copy rather than overwriting it.
          applyThreadUpdate(fresh.thread);
          dropLocal();
          return;
        }
        if ((overrideWriteRef.current.get(threadId) ?? 0) !== writeGeneration) {
          // The operator picked a model or effort for THIS conversation during
          // the read. That write is already queued behind this one; adopting
          // the browser-local value now would restore what they just replaced.
          dropLocal();
          return;
        }
        // Conditional: the read above is a projection, and only the server can
        // rule on it. Another tab may have written between the two calls, and
        // an unconditional PATCH makes this tab's stale local value final.
        const next = await api.patchThread(threadId, {
          model: local.model || null,
          effort: local.effort || null,
          ifRunConfigUnset: true,
        }, signal);
        applyThreadUpdate(next);
        dropLocal();
        setActionError(null);
      } catch (migrationError) {
        migratedKeysRef.current.delete(preferenceKey);
        setActionError(errorMessage(migrationError));
      }
    }).catch(() => undefined);
  }, [
    applyThreadUpdate,
    effortByContext,
    enqueueThreadWrite,
    modelByContext,
    preferenceKey,
    selectedAgentId,
    selectedThread,
    selectedThreadId,
  ]);

  const patchThreadOverride = useCallback(async (
    patch: { model?: string | null; effort?: string | null },
  ) => {
    const thread = selectedThread;
    if (!thread) return;
    // Tell this conversation's in-flight legacy-preference migration that the
    // operator has spoken since it read the thread.
    const generations = overrideWriteRef.current;
    generations.set(thread.id, (generations.get(thread.id) ?? 0) + 1);
    const previous = { model: thread.runModel ?? null, effort: thread.runEffort ?? null };
    // Optimistic straight away; the write itself queues behind whatever else
    // is already writing to this conversation, so the server sees the
    // operator's choices in the order they were made.
    applyThreadUpdate({
      ...thread,
      runModel: "model" in patch ? patch.model ?? null : previous.model,
      runEffort: "effort" in patch ? patch.effort ?? null : previous.effort,
    });
    try {
      const next = await enqueueThreadWrite(thread.id, (signal) =>
        api.patchThread(thread.id, patch, signal));
      applyThreadUpdate(next);
      setActionError(null);
    } catch (patchError) {
      applyThreadUpdate(thread);
      setActionError(errorMessage(patchError));
    }
  }, [applyThreadUpdate, enqueueThreadWrite, selectedThread]);

  const setModel = useCallback(
    (next: string) => {
      if (!selectedAgentId || !preferenceKey) return;
      if (selectedThread) {
        const nextEffectiveModel = selectedAgent
          ? effectiveModelForAgent(selectedAgent, next) ?? ""
          : "";
        const nextEfforts = effortLevelsForAgentModel(
          selectedAgent,
          nextEffectiveModel,
          findCatalogModel(catalogModels, nextEffectiveModel),
        );
        const currentEffort = selectedThread.runEffort ?? "";
        void patchThreadOverride({
          model: next === "" ? null : next,
          ...(currentEffort !== "" && !nextEfforts.includes(currentEffort)
            ? { effort: null }
            : {}),
        });
        return;
      }
      setModelByContext((current) => ({ ...current, [preferenceKey]: next }));
      const nextEffectiveModel = selectedAgent
        ? effectiveModelForAgent(selectedAgent, next) ?? ""
        : "";
      const nextEfforts = effortLevelsForAgentModel(
        selectedAgent,
        nextEffectiveModel,
        findCatalogModel(catalogModels, nextEffectiveModel),
      );
      setEffortByContext((current) => ({
        ...current,
        [preferenceKey]: nextEfforts.includes(current[preferenceKey] ?? "")
          ? (current[preferenceKey] ?? "")
          : "",
      }));
    },
    [
      catalogModels,
      patchThreadOverride,
      preferenceKey,
      selectedAgent,
      selectedAgentId,
      selectedThread,
    ],
  );

  const resetRunOverride = useCallback(() => {
    if (!preferenceKey) return;
    setModelByContext((current) => {
      const next = { ...current };
      delete next[preferenceKey];
      return next;
    });
    setEffortByContext((current) => {
      const next = { ...current };
      delete next[preferenceKey];
      return next;
    });
    if (selectedThread) {
      void patchThreadOverride({ model: null, effort: null });
    }
  }, [patchThreadOverride, preferenceKey, selectedThread]);

  const setEffort = useCallback(
    (next: string) => {
      if (!selectedAgentId || !preferenceKey) return;
      if (selectedThread) {
        void patchThreadOverride({ effort: next === "" ? null : next });
        return;
      }
      setEffortByContext((current) => ({ ...current, [preferenceKey]: next }));
    },
    [patchThreadOverride, preferenceKey, selectedAgentId, selectedThread],
  );

  const sendTurn = useCallback(
    async (input: StartTurnInput, onThreadResolved?: (threadId: string) => void) => {
      let thread = selectedThread;
      if (!thread) thread = await createThread();
      if (thread.archivedAt) throw new Error("Unarchive this conversation before sending.");
      onThreadResolved?.(thread.id);
      try {
        // The override the operator just set -- or just CLEARED -- can still be
        // in flight. A blank selection is omitted from this POST, and the
        // server then falls back to the conversation's persisted override, so
        // reset-then-send ran the very override the reset was clearing. Every
        // write issued before this send must reach the server before the send
        // asks the server what to run on.
        await settleThreadWrites(thread.id);
        const result = await api.startTurn(thread.id, {
          ...input,
        });
        setBootstrap((current) =>
          current
            ? {
                ...current,
                threads: current.threads.map((item) =>
                  item.id === result.thread.id ? result.thread : item,
                ),
              }
            : current,
        );
        setDetail((current) =>
          current?.thread.id === result.thread.id
            ? { ...current, thread: result.thread }
            : current,
        );
        setActionError(null);
        queueRefresh();
      } catch (turnError) {
        setActionError(errorMessage(turnError));
        throw turnError;
      }
    },
    [createThread, queueRefresh, selectedThread, settleThreadWrites],
  );

  const cancelTurn = useCallback(async () => {
    if (!selectedThreadId) return;
    try {
      const result = await api.cancelTurn(selectedThreadId);
      setDetail((current) =>
        current?.thread.id === result.thread.id ? { ...current, thread: result.thread } : current,
      );
      queueRefresh();
    } catch (cancelError) {
      setActionError(errorMessage(cancelError));
      throw cancelError;
    }
  }, [queueRefresh, selectedThreadId]);

  const sendLiveInput = useCallback(async (text: string) => {
    if (!selectedThreadId) throw new Error("Select a conversation before sending a follow-up.");
    try {
      const receipt = await api.liveInput(selectedThreadId, text);
      setDetail((current) => {
        if (current?.thread.id !== selectedThreadId) return current;
        const exists = current.messages.some((message) => message.id === receipt.message.id);
        return {
          ...current,
          messages: exists
            ? current.messages.map((message) => message.id === receipt.message.id ? receipt.message : message)
            : [...current.messages, receipt.message],
        };
      });
      setActionError(null);
      queueRefresh();
    } catch (liveInputError) {
      setActionError(errorMessage(liveInputError));
      throw liveInputError;
    }
  }, [queueRefresh, selectedThreadId]);

  const value = useMemo<ConsoleStoreValue>(
    () => ({
      bootstrap,
      agents,
      visibleAgents,
      threads,
      visibleThreads,
      selectedAgent,
      selectedThread,
      detail,
      selectedAgentId,
      selectedThreadId,
      loading,
      detailLoading,
      error,
      actionError,
      connection,
      showArchived,
      showOfflineAgents,
      hiddenOfflineAgentCount,
      model,
      effort,
      effectiveModel,
      effectiveEffort,
      hasRunOverride,
      resetRunOverride,
      modelOptions,
      effortOptions,
      catalogByProvider,
      ensureProviderCatalog,
      skillRegistry,
      cronOverview,
      cronLoading,
      cronError,
      hasMoreThreads,
      hasOlderMessages,
      selectAgent,
      setAgentPinned,
      selectThread,
      createThread,
      renameThread,
      archiveThread,
      unarchiveThread,
      deleteThread,
      sendTurn,
      sendLiveInput,
      cancelTurn,
      setShowArchived,
      setShowOfflineAgents,
      setModel,
      setEffort,
      retry: () => {
        setLoading(true);
        setError(null);
        void loadBootstrap();
      },
      clearActionError: () => setActionError(null),
      loadMoreThreads,
      loadOlderMessages,
      refreshCron,
      loadCronRunActivity,
    }),
    [
      actionError,
      agents,
      archiveThread,
      bootstrap,
      cancelTurn,
      connection,
      createThread,
      cronLoading,
      cronError,
      cronOverview,
      catalogByProvider,
      ensureProviderCatalog,
      detail,
      detailLoading,
      deleteThread,
      effort,
      effectiveEffort,
      effectiveModel,
      effortOptions,
      error,
      hiddenOfflineAgentCount,
      hasMoreThreads,
      hasOlderMessages,
      loadBootstrap,
      loadMoreThreads,
      loadOlderMessages,
      loadCronRunActivity,
      loading,
      hasRunOverride,
      model,
      modelOptions,
      resetRunOverride,
      skillRegistry,
      renameThread,
      refreshCron,
      selectAgent,
      selectThread,
      selectedAgent,
      selectedAgentId,
      selectedThread,
      selectedThreadId,
      sendTurn,
      sendLiveInput,
      setEffort,
      setAgentPinned,
      setModel,
      showArchived,
      showOfflineAgents,
      threads,
      unarchiveThread,
      visibleAgents,
      visibleThreads,
    ],
  );

  return <ConsoleStore.Provider value={value}>{children}</ConsoleStore.Provider>;
}

export function useConsoleStore(): ConsoleStoreValue {
  const value = useContext(ConsoleStore);
  if (!value) throw new Error("useConsoleStore must be used inside ConsoleStoreProvider.");
  return value;
}

export const useUploadLimits = () =>
  useConsoleStore().bootstrap?.limits ?? DEFAULT_UPLOAD_LIMITS;
