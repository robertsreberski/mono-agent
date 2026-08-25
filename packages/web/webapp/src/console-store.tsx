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
import {
  cronChannelPath,
  cronRouteSelection,
  parseRoute,
  routePath,
  type ConsoleRoute,
  type ConsoleView,
} from "./routes";
import { DEFAULT_UPLOAD_LIMITS } from "./types";
import type {
  AgentSummary,
  Bootstrap,
  CronOverview,
  SkillRegistryState,
  StartTurnInput,
  RunDefaults,
  ThreadState,
  ThreadDetail,
  ThreadSummary,
  WebEvent,
} from "./types";

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
  readonly activeView: ConsoleView;
  readonly route: ConsoleRoute;
  readonly showArchived: boolean;
  readonly showOfflineAgents: boolean;
  readonly hiddenOfflineAgentCount: number;
  readonly model: string;
  readonly effort: string;
  readonly effectiveModel: string;
  readonly effectiveEffort: string;
  readonly agentDefaultModel: string;
  readonly agentDefaultEffort: string;
  readonly hasRunOverride: boolean;
  readonly modelOptions: readonly string[];
  readonly effortOptions: readonly string[];
  readonly skillRegistry: SkillRegistryState;
  readonly cronOverview: CronOverview | null;
  readonly cronLoading: boolean;
  readonly cronError: string | null;
  readonly hasMoreThreads: boolean;
  readonly hasOlderMessages: boolean;
  readonly selectAgent: (sourceId: string) => void;
  readonly setAgentPinned: (sourceId: string, pinned: boolean) => Promise<void>;
  readonly setAgentRunDefaults: (sourceId: string, runDefaults: RunDefaults | null) => Promise<void>;
  readonly selectThread: (threadId: string) => void;
  readonly createThread: (sourceId?: string) => Promise<ThreadSummary>;
  readonly renameThread: (threadId: string, title: string) => Promise<void>;
  readonly archiveThread: (threadId: string) => Promise<void>;
  readonly unarchiveThread: (threadId: string) => Promise<void>;
  readonly deleteThread: (threadId: string) => Promise<void>;
  readonly setThreadPinned: (threadId: string, pinned: boolean) => Promise<void>;
  readonly setThreadState: (threadId: string, state: ThreadState) => Promise<void>;
  readonly setThreadLabels: (threadId: string, labels: readonly string[]) => Promise<void>;
  readonly setThreadProject: (threadId: string, project: string | null) => Promise<void>;
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
  readonly resetRunOverride: () => void;
  readonly navigate: (route: ConsoleRoute) => void;
  readonly loadBoardThreads: () => Promise<void>;
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

export { cronChannelPath };

const threadRoute = (thread: ThreadSummary | undefined): string =>
  thread?.trigger?.kind === "cron" && thread.trigger.jobId !== undefined
    ? cronChannelPath(thread.sourceId, thread.trigger.jobId)
    : thread === undefined ? "/" : routePath({ view: "chats", threadId: thread.id });

const updateThreadRoute = (thread: ThreadSummary | undefined, replace = false): void => {
  const path = threadRoute(thread);
  if (window.location.pathname === path) return;
  window.history[replace ? "replaceState" : "pushState"](window.history.state, "", path);
};

export const SELECTED_AGENT_STORAGE_KEY = "mono-agent.web.selected-agent";
export const SELECTED_THREADS_STORAGE_KEY = "mono-agent.web.selected-threads";
export const RUN_PREFERENCES_STORAGE_KEY = "mono-agent.web.run-preferences";
export const preferenceKeyForThread = (sourceId: string, threadId: string | null): string =>
  JSON.stringify([sourceId, threadId ?? "new"]);

export interface StoredRunPreference {
  readonly model: string;
  readonly effort: string;
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

export const GLOBAL_EFFORT_LEVELS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
] as const;

export const effortLevelsForAgentModel = (
  agent: AgentSummary | null,
  model: string,
): readonly string[] => {
  if (!agent) return [];
  const option = agent.modelOptions?.[model];
  if (!option) return agent.efforts ?? [];
  if (
    option.reasoning === false ||
    option.reasoningMode === "none" ||
    option.effortLevels?.length === 0
  ) {
    return [];
  }
  if (option.reasoningMode === "toggle") return ["high", "none"];
  return option.effortLevels ?? GLOBAL_EFFORT_LEVELS;
};

export const validateRunPreference = (
  agent: AgentSummary | null,
  preference: StoredRunPreference,
  fallbackModel?: string,
): StoredRunPreference => {
  if (!agent) return { model: "", effort: "" };
  const model = preference.model && agent.models?.includes(preference.model)
    ? preference.model
    : "";
  const effectiveModel = model || fallbackModel || agent.defaultModel || agent.models?.[0] || "";
  const efforts = effortLevelsForAgentModel(agent, effectiveModel);
  return {
    model,
    effort: preference.effort && efforts.includes(preference.effort)
      ? preference.effort
      : "",
  };
};

export function ConsoleStoreProvider({ children }: { readonly children: ReactNode }) {
  const [route, setRoute] = useState<ConsoleRoute>(() => parseRoute(window.location.pathname));
  const activeView = route.view;
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
  const boardLoadedRef = useRef(false);
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
  const selectedThreadRef = useRef<string | null>(null);
  const selectedAgentRef = useRef<string | null>(selectedAgentId);
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

  const applyBootstrap = useCallback((next: Bootstrap) => {
    setBootstrap(next);
    setError(null);
    setLoading(false);
    const baseSelection = resolveBootstrapSelection(
      next,
      selectedAgentRef.current,
      selectedThreadRef.current,
      readPersistedThreadIds(),
    );
    const currentRoute = parseRoute(window.location.pathname);
    setRoute(currentRoute);
    const cronSelection = cronRouteSelection(currentRoute);
    const routeThread = "threadId" in currentRoute
      ? next.threads.find((thread) => thread.id === currentRoute.threadId)
      : cronSelection === undefined
        ? undefined
        : next.threads.find((thread) =>
            thread.sourceId === cronSelection.sourceId
            && thread.trigger?.kind === "cron"
            && thread.trigger.jobId === cronSelection.jobId);
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
    const onPopState = () => {
      setRoute(parseRoute(window.location.pathname));
      setRouteRevision((value) => value + 1);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const navigate = useCallback((next: ConsoleRoute) => {
    const path = routePath(next);
    if (window.location.pathname !== path) {
      window.history.pushState(window.history.state, "", path);
    }
    setRoute(next);
    if (next.view === "chats" && "threadId" in next) {
      const thread = (bootstrap?.threads ?? []).find((candidate) => candidate.id === next.threadId);
      if (thread !== undefined) {
        selectedAgentRef.current = thread.sourceId;
        selectedThreadRef.current = thread.id;
        setSelectedAgentId(thread.sourceId);
        setSelectedThreadId(thread.id);
        localStorage.setItem(SELECTED_AGENT_STORAGE_KEY, thread.sourceId);
      }
    }
  }, [bootstrap?.threads]);

  const loadThreadBucket = useCallback(async (
    sourceId: string,
    archived: boolean,
    before?: string,
  ) => {
    const page = await api.threads(sourceId, archived, before);
    const key = threadBucketKey(sourceId, archived);
    setBootstrap((current) => {
      if (current === null) return current;
      const retained = before === undefined
        ? current.threads.filter((thread) =>
            thread.sourceId !== sourceId || Boolean(thread.archivedAt) !== archived)
        : current.threads;
      return { ...current, threads: mergeThreads(retained, page.threads) };
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
      if (nextDetail && selectedThreadRef.current === nextDetail.thread.id) setDetail(nextDetail);
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

  const loadBoardThreads = useCallback(async () => {
    if (boardLoadedRef.current) return;
    boardLoadedRef.current = true;
    try {
      for (const agent of agents) await loadThreadBucket(agent.sourceId, false);
    } catch (boardError) {
      boardLoadedRef.current = false;
      setActionError(errorMessage(boardError));
      throw boardError;
    }
  }, [agents, loadThreadBucket]);

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
      setRoute(recent === undefined ? { view: "chats" } : { view: "chats", threadId: recent.id });
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

  const setAgentRunDefaults = useCallback(async (
    sourceId: string,
    runDefaults: RunDefaults | null,
  ) => {
    try {
      const agent = await api.patchAgent(sourceId, { runDefaults });
      setBootstrap((current) => current === null
        ? current
        : {
            ...current,
            agents: current.agents.map((item) => item.sourceId === sourceId ? agent : item),
          });
      setActionError(null);
      queueRefresh();
    } catch (defaultsError) {
      setActionError(errorMessage(defaultsError));
      throw defaultsError;
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
        setRoute({ view: "chats", threadId: thread.id });
      }
      selectedThreadRef.current = threadId;
      setSelectedThreadId(threadId);
      setActionError(null);
      if (thread === undefined) {
        void api.thread(threadId).then((next) => {
          const canonical = next.thread;
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
          setRoute({ view: "chats", threadId: canonical.id });
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

  useEffect(() => {
    const currentRoute = parseRoute(window.location.pathname);
    if (currentRoute.view !== "chats" || !("threadId" in currentRoute)) return;
    if (selectedThreadRef.current !== currentRoute.threadId) selectThread(currentRoute.threadId);
  }, [bootstrap, routeRevision, selectThread]);

  const createThread = useCallback(async (sourceId = selectedAgentId ?? undefined) => {
    if (!sourceId) throw new Error("Select an agent before starting a conversation.");
    try {
      const thread = await api.createThread(sourceId);
      const draftPreferenceKey = preferenceKeyForThread(sourceId, null);
      const threadPreferenceKey = preferenceKeyForThread(sourceId, thread.id);
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
      selectedAgentRef.current = sourceId;
      setSelectedAgentId(sourceId);
      setSelectedThreadId(thread.id);
      localStorage.setItem(SELECTED_AGENT_STORAGE_KEY, sourceId);
      persistThreadId(sourceId, thread.id);
      setShowArchived(false);
      updateThreadRoute(thread);
      setRoute({ view: "chats", threadId: thread.id });
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
    setBootstrap((current) => current === null
      ? current
      : { ...current, threads: mergeThreads(current.threads, [fetched.thread]) });
    return fetched.thread;
  }, [detail, threads]);

  const patchThreadMetadata = useCallback(async (
    threadId: string,
    patch: Parameters<typeof api.patchThread>[1],
  ): Promise<void> => {
    try {
      await fetchThreadSummary(threadId);
      const thread = await api.patchThread(threadId, patch);
      setBootstrap((current) => current === null
        ? current
        : {
            ...current,
            threads: current.threads.map((item) => item.id === thread.id ? thread : item),
          });
      setDetail((current) => current?.thread.id === thread.id
        ? { ...current, thread }
        : current);
      setActionError(null);
    } catch (patchError) {
      setActionError(errorMessage(patchError));
      throw patchError;
    }
  }, [fetchThreadSummary]);

  const setThreadPinned = useCallback(
    async (threadId: string, pinned: boolean) => patchThreadMetadata(threadId, { pinned }),
    [patchThreadMetadata],
  );
  const setThreadState = useCallback(
    async (threadId: string, state: ThreadState) => patchThreadMetadata(threadId, { state }),
    [patchThreadMetadata],
  );
  const setThreadLabels = useCallback(
    async (threadId: string, labels: readonly string[]) => patchThreadMetadata(threadId, { labels }),
    [patchThreadMetadata],
  );
  const setThreadProject = useCallback(
    async (threadId: string, project: string | null) => patchThreadMetadata(threadId, { project }),
    [patchThreadMetadata],
  );

  const renameThread = useCallback(async (threadId: string, title: string) => {
    const trimmed = title.trim();
    if (!trimmed) return;
    try {
      await fetchThreadSummary(threadId);
      const thread = await api.patchThread(threadId, { title: trimmed });
      setBootstrap((current) =>
        current
          ? {
              ...current,
              threads: current.threads.map((item) => (item.id === thread.id ? thread : item)),
            }
          : current,
      );
      setDetail((current) =>
        current?.thread.id === thread.id ? { ...current, thread } : current,
      );
    } catch (renameError) {
      setActionError(errorMessage(renameError));
      throw renameError;
    }
  }, [fetchThreadSummary]);

  const archiveThread = useCallback(
    async (threadId: string) => {
      try {
        const target = await fetchThreadSummary(threadId);
        const thread = await api.patchThread(target.id, { archived: true });
        setBootstrap((current) =>
          current
            ? {
                ...current,
                threads: current.threads.map((item) => (item.id === thread.id ? thread : item)),
              }
            : current,
        );
        if (selectedThreadRef.current === target.id || selectedThreadRef.current === threadId) {
          const replacement = visibleThreads.find((item) => item.id !== target.id);
          selectedThreadRef.current = replacement?.id ?? null;
          setSelectedThreadId(replacement?.id ?? null);
          persistThreadId(thread.sourceId, replacement?.id ?? null);
          updateThreadRoute(replacement, true);
          setRoute(replacement === undefined ? { view: "chats" } : { view: "chats", threadId: replacement.id });
        } else if (readPersistedThreadIds()[thread.sourceId] === target.id) {
          persistThreadId(thread.sourceId, null);
        }
      } catch (archiveError) {
        setActionError(errorMessage(archiveError));
        throw archiveError;
      }
    },
    [fetchThreadSummary, visibleThreads],
  );

  const unarchiveThread = useCallback(async (threadId: string) => {
    try {
      const target = await fetchThreadSummary(threadId);
      const thread = await api.patchThread(target.id, { archived: false });
      setBootstrap((current) =>
        current
          ? {
              ...current,
              threads: current.threads.map((item) => (item.id === thread.id ? thread : item)),
            }
          : current,
      );
      selectedThreadRef.current = thread.id;
      setSelectedThreadId(thread.id);
      persistThreadId(thread.sourceId, thread.id);
      setShowArchived(false);
      updateThreadRoute(thread, true);
      setRoute({ view: "chats", threadId: thread.id });
    } catch (unarchiveError) {
      setActionError(errorMessage(unarchiveError));
      throw unarchiveError;
    }
  }, [fetchThreadSummary]);

  const deleteThread = useCallback(async (threadId: string) => {
    try {
      const thread = await fetchThreadSummary(threadId);
      await api.deleteThread(thread.id);
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
        setRoute(replacement === undefined ? { view: "chats" } : { view: "chats", threadId: replacement.id });
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

  const modelOptions = selectedAgent?.models ?? [];
  const preferenceKey = selectedAgentId
    ? preferenceKeyForThread(selectedAgentId, selectedThreadId)
    : "";
  const storedPreference = {
    model: modelByContext[preferenceKey] ?? "",
    effort: effortByContext[preferenceKey] ?? "",
  };
  const advertisedModel = selectedAgent?.defaultModel || modelOptions[0] || "";
  const defaultPreference = validateRunPreference(selectedAgent, {
    model: selectedAgent?.runDefaults?.model ?? "",
    effort: selectedAgent?.runDefaults?.effort ?? "",
  });
  const agentDefaultModel = defaultPreference.model || advertisedModel;
  const validatedPreference = validateRunPreference(selectedAgent, storedPreference, agentDefaultModel);
  const model = validatedPreference.model;
  const effectiveModel = model || agentDefaultModel;
  const effortOptions = effortLevelsForAgentModel(selectedAgent, effectiveModel);
  const effort = validatedPreference.effort;
  const advertisedEffort = selectedAgent?.defaultEffort ?? "";
  const agentDefaultEffort = effortOptions.includes(defaultPreference.effort)
    ? defaultPreference.effort
    : effortOptions.includes(advertisedEffort) ? advertisedEffort : "";
  const effectiveEffort = effort || agentDefaultEffort;
  const hasRunOverride = model.length > 0 || effort.length > 0;

  useEffect(() => {
    if (!preferenceKey) return;
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
    storedPreference.effort,
    storedPreference.model,
    validatedPreference.effort,
    validatedPreference.model,
  ]);

  const setModel = useCallback(
    (next: string) => {
      if (!selectedAgentId || !preferenceKey) return;
      setModelByContext((current) => ({ ...current, [preferenceKey]: next }));
      const nextEffectiveModel =
        next || selectedAgent?.defaultModel || selectedAgent?.models?.[0] || "";
      const nextEfforts = effortLevelsForAgentModel(selectedAgent, nextEffectiveModel);
      setEffortByContext((current) => ({
        ...current,
        [preferenceKey]: nextEfforts.includes(current[preferenceKey] ?? "")
          ? (current[preferenceKey] ?? "")
          : "",
      }));
    },
    [preferenceKey, selectedAgent, selectedAgentId],
  );

  const setEffort = useCallback(
    (next: string) => {
      if (!selectedAgentId || !preferenceKey) return;
      setEffortByContext((current) => ({ ...current, [preferenceKey]: next }));
    },
    [preferenceKey, selectedAgentId],
  );

  const resetRunOverride = useCallback(() => {
    if (!preferenceKey) return;
    setModelByContext((current) => ({ ...current, [preferenceKey]: "" }));
    setEffortByContext((current) => ({ ...current, [preferenceKey]: "" }));
  }, [preferenceKey]);

  const sendTurn = useCallback(
    async (input: StartTurnInput, onThreadResolved?: (threadId: string) => void) => {
      let thread = selectedThread;
      if (!thread) thread = await createThread();
      if (thread.archivedAt) throw new Error("Unarchive this conversation before sending.");
      onThreadResolved?.(thread.id);
      try {
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
    [createThread, queueRefresh, selectedThread],
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
      activeView,
      route,
      showArchived,
      showOfflineAgents,
      hiddenOfflineAgentCount,
      model,
      effort,
      effectiveModel,
      effectiveEffort,
      agentDefaultModel,
      agentDefaultEffort,
      hasRunOverride,
      modelOptions,
      effortOptions,
      skillRegistry,
      cronOverview,
      cronLoading,
      cronError,
      hasMoreThreads,
      hasOlderMessages,
      selectAgent,
      setAgentPinned,
      setAgentRunDefaults,
      selectThread,
      createThread,
      renameThread,
      archiveThread,
      unarchiveThread,
      deleteThread,
      setThreadPinned,
      setThreadState,
      setThreadLabels,
      setThreadProject,
      sendTurn,
      sendLiveInput,
      cancelTurn,
      setShowArchived,
      setShowOfflineAgents,
      setModel,
      setEffort,
      resetRunOverride,
      navigate,
      loadBoardThreads,
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
      activeView,
      agentDefaultEffort,
      agentDefaultModel,
      agents,
      archiveThread,
      bootstrap,
      cancelTurn,
      connection,
      createThread,
      cronLoading,
      cronError,
      cronOverview,
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
      hasRunOverride,
      loadBootstrap,
      loadMoreThreads,
      loadOlderMessages,
      loadCronRunActivity,
      loadBoardThreads,
      loading,
      model,
      modelOptions,
      navigate,
      skillRegistry,
      renameThread,
      refreshCron,
      resetRunOverride,
      route,
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
      setAgentRunDefaults,
      setThreadLabels,
      setThreadPinned,
      setThreadProject,
      setThreadState,
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
