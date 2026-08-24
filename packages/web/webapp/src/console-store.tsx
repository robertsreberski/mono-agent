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
  conversationPath,
  conversationThreadFromPath,
  effectiveRunPreference,
  messageAnchor,
  messageIdFromHash,
} from "./conversation-workspace";
import {
  memoryPath,
  workspaceRouteFromPath,
  type WorkspaceRoute,
} from "./memory-workspace";
import { DEFAULT_UPLOAD_LIMITS } from "./types";
import type {
  AgentSummary,
  Bootstrap,
  CronOverview,
  SkillRegistryState,
  StartTurnInput,
  ThreadDetail,
  ThreadPage,
  ThreadQuery,
  ThreadSummary,
  WebAgentPreferences,
  WebCollection,
  WebEvent,
  WebRunPreference,
  WebWorkflowStatus,
} from "./types";

export type ConnectionState = "connecting" | "live" | "reconnecting" | "offline";

interface ConsoleStoreValue {
  readonly bootstrap: Bootstrap | null;
  readonly agents: readonly AgentSummary[];
  readonly visibleAgents: readonly AgentSummary[];
  readonly threads: readonly ThreadSummary[];
  readonly collections: readonly WebCollection[];
  readonly collectionsLoading: boolean;
  readonly workspaceRevision: number;
  readonly agentPreferences: Readonly<Record<string, WebRunPreference | null | undefined>>;
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
  readonly effectiveModel: string;
  readonly effectiveEffort: string;
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
  readonly loadAgentPreferences: (sourceId: string) => Promise<WebAgentPreferences>;
  readonly setAgentRunPreference: (
    sourceId: string,
    preference: WebRunPreference | null,
  ) => Promise<void>;
  readonly selectThread: (threadId: string, messageId?: string) => void;
  readonly selectSearchMatch: (threadId: string, messageId?: string) => void;
  readonly pendingMessageId: string | null;
  readonly clearPendingMessage: () => void;
  readonly jumpToLatest: () => Promise<void>;
  readonly openConversationIndex: () => void;
  readonly conversationDetailOpen: boolean;
  readonly workspaceRoute: WorkspaceRoute;
  readonly openMemory: (sourceId?: string) => void;
  readonly createThread: (sourceId?: string) => Promise<ThreadSummary>;
  readonly renameThread: (threadId: string, title: string) => Promise<void>;
  readonly archiveThread: (threadId: string) => Promise<void>;
  readonly unarchiveThread: (threadId: string) => Promise<void>;
  readonly deleteThread: (threadId: string) => Promise<void>;
  readonly updateThreadWorkspace: (
    threadId: string,
    patch: {
      readonly workflowStatus?: WebWorkflowStatus;
      readonly pinned?: boolean;
      readonly collectionId?: string | null;
    },
  ) => Promise<void>;
  readonly queryWorkspaceThreads: (query: ThreadQuery) => Promise<ThreadPage>;
  readonly createCollection: (name: string) => Promise<WebCollection>;
  readonly renameCollection: (collectionId: string, name: string) => Promise<void>;
  readonly deleteCollection: (collectionId: string) => Promise<void>;
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
  for (const thread of incoming) {
    const existing = merged.get(thread.id);
    if (existing === undefined || thread.revision >= existing.revision) merged.set(thread.id, thread);
  }
  return [...merged.values()].sort(byMostRecent);
};

export const cronChannelPath = (sourceId: string, jobId: string): string =>
  `/agents/${encodeURIComponent(sourceId)}/cron/${encodeURIComponent(jobId)}`;

const threadRoute = (thread: ThreadSummary | undefined): string =>
  thread?.trigger?.kind === "cron" && thread.trigger.jobId !== undefined
    ? cronChannelPath(thread.sourceId, thread.trigger.jobId)
    : conversationPath(thread?.id);

const updateThreadRoute = (
  thread: ThreadSummary | undefined,
  replace = false,
  targetMessageId?: string,
): void => {
  const path = `${threadRoute(thread)}${targetMessageId ? `#${messageAnchor(targetMessageId)}` : ""}`;
  if (`${window.location.pathname}${window.location.hash}` === path) return;
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
export const RUN_PREFERENCES_STORAGE_KEY = "mono-agent.web.run-preferences";
export const preferenceKeyForThread = (sourceId: string, threadId: string | null): string =>
  JSON.stringify([sourceId, threadId ?? "new"]);

export interface StoredRunPreference {
  readonly model: string;
  readonly effort: string;
}

export const parseStoredPreferenceKey = (
  key: string,
): { readonly sourceId: string; readonly threadId: string | null } | undefined => {
  try {
    const parsed = JSON.parse(key) as unknown;
    if (
      !Array.isArray(parsed)
      || parsed.length !== 2
      || typeof parsed[0] !== "string"
      || typeof parsed[1] !== "string"
    ) return undefined;
    return { sourceId: parsed[0], threadId: parsed[1] === "new" ? null : parsed[1] };
  } catch {
    return undefined;
  }
};

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
): StoredRunPreference => {
  if (!agent) return { model: "", effort: "" };
  const model = preference.model && agent.models?.includes(preference.model)
    ? preference.model
    : "";
  const effectiveModel = model || agent.defaultModel || agent.models?.[0] || "";
  const efforts = effortLevelsForAgentModel(agent, effectiveModel);
  return {
    model,
    effort: preference.effort && efforts.includes(preference.effort)
      ? preference.effort
      : "",
  };
};

export function ConsoleStoreProvider({ children }: { readonly children: ReactNode }) {
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
  const [collections, setCollections] = useState<readonly WebCollection[]>([]);
  const [collectionsLoading, setCollectionsLoading] = useState(true);
  const [workspaceRevision, setWorkspaceRevision] = useState(0);
  const [agentPreferences, setAgentPreferences] = useState<
    Record<string, WebRunPreference | null | undefined>
  >({});
  const [preferenceMigrationComplete, setPreferenceMigrationComplete] = useState(false);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(() => {
    const route = workspaceRouteFromPath();
    return route.kind === "memory"
      ? route.sourceId
      : cronRouteSelection()?.sourceId ?? localStorage.getItem(SELECTED_AGENT_STORAGE_KEY);
  });
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
  const [pendingMessageId, setPendingMessageId] = useState<string | null>(null);
  const selectedThreadRef = useRef<string | null>(null);
  const selectedAgentRef = useRef<string | null>(selectedAgentId);
  const skillRequestGenerationRef = useRef(0);
  const skillRegistryStateRef = useRef(skillRegistryState);
  const refreshTimerRef = useRef<number | null>(null);
  const refreshInFlightRef = useRef(false);
  const refreshQueuedRef = useRef(false);
  const queueRefreshRef = useRef<() => void>(() => undefined);
  const migrationStartedRef = useRef(false);
  const pendingAnchorRef = useRef<{ readonly threadId: string; readonly messageId: string } | null>(null);
  const runPreferenceQueueRef = useRef<Promise<void>>(Promise.resolve());
  const runPreferenceGenerationRef = useRef(0);
  const runPreferenceDraftRef = useRef<{
    readonly threadId: string;
    readonly preference: WebRunPreference | null;
  } | null>(null);

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
    const normalized = next.collections === undefined
      ? { ...next, collections: [] }
      : next;
    setBootstrap(normalized);
    setCollections(normalized.collections);
    setCollectionsLoading(false);
    setWorkspaceRevision((revision) => revision + 1);
    setError(null);
    setLoading(false);
    const baseSelection = resolveBootstrapSelection(
      normalized,
      selectedAgentRef.current,
      selectedThreadRef.current,
      readPersistedThreadIds(),
    );
    const route = cronRouteSelection();
    const routeThread = route === undefined
      ? undefined
      : normalized.threads.find((thread) =>
          thread.sourceId === route.sourceId
          && thread.trigger?.kind === "cron"
          && thread.trigger.jobId === route.jobId);
    const conversationRouteId = conversationThreadFromPath();
    const conversationRouteThread = conversationRouteId === undefined
      ? undefined
      : normalized.threads.find((thread) => thread.id === conversationRouteId);
    const workspaceRoute = workspaceRouteFromPath();
    const selection = workspaceRoute.kind === "memory"
      ? {
          agentId: workspaceRoute.sourceId,
          threadId: baseSelection.agentId === workspaceRoute.sourceId
            ? baseSelection.threadId
            : null,
        }
      : routeThread !== undefined
        ? { agentId: routeThread.sourceId, threadId: routeThread.id }
        : conversationRouteId !== undefined
          ? {
              agentId: conversationRouteThread?.sourceId ?? baseSelection.agentId,
              threadId: conversationRouteId,
            }
          : baseSelection;
    selectedAgentRef.current = selection.agentId;
    selectedThreadRef.current = selection.threadId;
    setSelectedAgentId(selection.agentId);
    setSelectedThreadId(selection.threadId);
    if (selection.agentId) {
      localStorage.setItem(SELECTED_AGENT_STORAGE_KEY, selection.agentId);
      const selected = normalized.threads.find((thread) => thread.id === selection.threadId);
      persistThreadId(
        selection.agentId,
        selected && !selected.archivedAt ? selected.id : null,
      );
    }
    if (workspaceRoute.kind === "malformed-memory") {
      window.history.replaceState(window.history.state, "", conversationPath());
    } else if (window.location.pathname === "/") {
      window.history.replaceState(window.history.state, "", conversationPath());
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
      if (selectedThreadRef.current === threadId) {
        if (pendingAnchorRef.current?.threadId !== threadId) setDetail(next);
        setBootstrap((current) => current === null
          ? current
          : { ...current, threads: mergeThreads(current.threads, [next.thread]) });
        if (selectedAgentRef.current !== next.thread.sourceId) {
          selectedAgentRef.current = next.thread.sourceId;
          setSelectedAgentId(next.thread.sourceId);
          localStorage.setItem(SELECTED_AGENT_STORAGE_KEY, next.thread.sourceId);
        }
      }
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
        && selectedThreadRef.current === nextDetail.thread.id
        && pendingAnchorRef.current?.threadId !== nextDetail.thread.id
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
      let webEvent: WebEvent | undefined;
      try {
        webEvent = JSON.parse((event as MessageEvent<string>).data) as WebEvent;
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
      if (eventType === "agent.preferences.changed") {
        const sourceId = (webEvent?.payload as { readonly sourceId?: unknown } | undefined)?.sourceId;
        if (typeof sourceId === "string") {
          setAgentPreferences((current) => {
            const next = { ...current };
            delete next[sourceId];
            return next;
          });
        }
      }
      if (eventType === "ready" || eventType === "agents.changed" || eventType === "cron.changed") {
        setCronRefreshToken((value) => value + 1);
      }
      queueRefresh();
    };
    const eventTypes: WebEvent["type"][] = [
      "ready",
      "agents.changed",
      "agent.preferences.changed",
      "collections.changed",
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
      const remainInMemory = workspaceRouteFromPath().kind === "memory";
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
      if (remainInMemory) {
        const path = memoryPath(sourceId);
        if (window.location.pathname !== path || window.location.hash) {
          window.history.pushState(window.history.state, "", path);
          setRouteRevision((value) => value + 1);
        }
      } else {
        updateThreadRoute(recent);
      }
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

  const loadAgentPreferences = useCallback(async (sourceId: string) => {
    const preferences = await api.agentPreferences(sourceId);
    setAgentPreferences((current) => ({
      ...current,
      [sourceId]: preferences.runPreference,
    }));
    return preferences;
  }, []);

  const setAgentRunPreference = useCallback(async (
    sourceId: string,
    preference: WebRunPreference | null,
  ) => {
    try {
      const updated = await api.patchAgentPreferences(sourceId, preference);
      setAgentPreferences((current) => ({
        ...current,
        [sourceId]: updated.runPreference,
      }));
      setActionError(null);
    } catch (preferenceError) {
      setActionError(errorMessage(preferenceError));
      throw preferenceError;
    }
  }, []);

  useEffect(() => {
    if (
      !preferenceMigrationComplete
      || selectedAgentId === null
      || agentPreferences[selectedAgentId] !== undefined
    ) return;
    const controller = new AbortController();
    void api.agentPreferences(selectedAgentId, controller.signal).then((preferences) => {
      if (!controller.signal.aborted) {
        setAgentPreferences((current) => ({
          ...current,
          [selectedAgentId]: preferences.runPreference,
        }));
      }
    }).catch((preferenceError: unknown) => {
      if (!controller.signal.aborted) setActionError(errorMessage(preferenceError));
    });
    return () => controller.abort();
  }, [agentPreferences, preferenceMigrationComplete, selectedAgentId]);

  const selectThread = useCallback(
    (threadId: string, targetMessageId?: string) => {
      setPendingMessageId(targetMessageId ?? null);
      pendingAnchorRef.current = targetMessageId === undefined
        ? null
        : { threadId, messageId: targetMessageId };
      const thread = threads.find((candidate) => candidate.id === threadId);
      if (thread) {
        selectedAgentRef.current = thread.sourceId;
        setSelectedAgentId(thread.sourceId);
        localStorage.setItem(SELECTED_AGENT_STORAGE_KEY, thread.sourceId);
        if (!thread.archivedAt) persistThreadId(thread.sourceId, thread.id);
        updateThreadRoute(thread, false, targetMessageId);
        setRouteRevision((value) => value + 1);
      }
      selectedThreadRef.current = threadId;
      setSelectedThreadId(threadId);
      setActionError(null);
      if (thread === undefined) {
        void api.thread(threadId).then((next) => {
          if (selectedThreadRef.current !== threadId) return;
          const canonical = next.thread;
          setBootstrap((current) => current === null
            ? current
            : { ...current, threads: mergeThreads(current.threads, [canonical]) });
          if (targetMessageId === undefined) setDetail(next);
          selectedAgentRef.current = canonical.sourceId;
          selectedThreadRef.current = canonical.id;
          setSelectedAgentId(canonical.sourceId);
          setSelectedThreadId(canonical.id);
          localStorage.setItem(SELECTED_AGENT_STORAGE_KEY, canonical.sourceId);
          if (!canonical.archivedAt) persistThreadId(canonical.sourceId, canonical.id);
          updateThreadRoute(canonical, true, targetMessageId);
          setRouteRevision((value) => value + 1);
        }).catch((selectionError: unknown) => setActionError(errorMessage(selectionError)));
      }
    },
    [threads],
  );

  const selectSearchMatch = useCallback((threadId: string, messageId?: string) => {
    selectThread(threadId, messageId);
    if (messageId === undefined) return;
    void Promise.all([api.thread(threadId), api.messagesAround(threadId, messageId)]).then(
      ([threadDetail, page]) => {
        const pending = pendingAnchorRef.current;
        if (
          selectedThreadRef.current !== threadId
          || pending?.threadId !== threadId
          || pending.messageId !== messageId
        ) return;
        setBootstrap((current) => current === null
          ? current
          : { ...current, threads: mergeThreads(current.threads, [threadDetail.thread]) });
        setDetail({
          thread: threadDetail.thread,
          messages: page.messages,
          ...(page.nextCursor === undefined ? {} : { messagesNextCursor: page.nextCursor }),
        });
      },
    ).catch((selectionError: unknown) => {
      const pending = pendingAnchorRef.current;
      if (pending?.threadId === threadId && pending.messageId === messageId) {
        pendingAnchorRef.current = null;
        setPendingMessageId(null);
        setActionError(errorMessage(selectionError));
      }
    });
  }, [selectThread]);

  const clearPendingMessage = useCallback(() => {
    pendingAnchorRef.current = null;
    setPendingMessageId(null);
  }, []);

  const jumpToLatest = useCallback(async () => {
    const threadId = selectedThreadRef.current;
    const anchor = messageIdFromHash();
    if (threadId === null || anchor === undefined) return;
    try {
      const latest = await api.thread(threadId);
      if (selectedThreadRef.current !== threadId || messageIdFromHash() !== anchor) return;
      const canonical = latest.thread;
      pendingAnchorRef.current = null;
      setPendingMessageId(null);
      selectedAgentRef.current = canonical.sourceId;
      selectedThreadRef.current = canonical.id;
      setSelectedAgentId(canonical.sourceId);
      setSelectedThreadId(canonical.id);
      localStorage.setItem(SELECTED_AGENT_STORAGE_KEY, canonical.sourceId);
      if (!canonical.archivedAt) persistThreadId(canonical.sourceId, canonical.id);
      setBootstrap((current) => current === null
        ? current
        : { ...current, threads: mergeThreads(current.threads, [canonical]) });
      setDetail(latest);
      updateThreadRoute(canonical, true);
      setRouteRevision((value) => value + 1);
      setActionError(null);
    } catch (latestError) {
      setActionError(errorMessage(latestError));
      throw latestError;
    }
  }, []);

  const openConversationIndex = useCallback(() => {
    pendingAnchorRef.current = null;
    setPendingMessageId(null);
    if (window.location.pathname !== conversationPath() || window.location.hash) {
      window.history.pushState(window.history.state, "", conversationPath());
      setRouteRevision((value) => value + 1);
    }
  }, []);

  const workspaceRoute = useMemo(() => workspaceRouteFromPath(), [routeRevision]);

  const openMemory = useCallback((sourceId?: string) => {
    const target = sourceId ?? selectedAgentRef.current;
    if (target === null || target === undefined) {
      setActionError("Select an agent before opening memory.");
      return;
    }
    const path = memoryPath(target);
    if (window.location.pathname === path && !window.location.hash) return;
    window.history.pushState(window.history.state, "", path);
    setRouteRevision((value) => value + 1);
    setActionError(null);
  }, []);

  const conversationDetailOpen = workspaceRoute.kind === "conversations"
    && (conversationThreadFromPath() !== undefined || cronRouteSelection() !== undefined);

  useEffect(() => {
    const route = workspaceRouteFromPath();
    if (route.kind === "malformed-memory") {
      window.history.replaceState(window.history.state, "", conversationPath());
      setRouteRevision((value) => value + 1);
      return;
    }
    if (route.kind !== "memory" || selectedAgentRef.current === route.sourceId) return;
    const persistedId = readPersistedThreadIds()[route.sourceId];
    const persisted = threads.find((thread) =>
      thread.id === persistedId && thread.sourceId === route.sourceId && !thread.archivedAt);
    const recent = persisted ?? [...threads]
      .filter((thread) => thread.sourceId === route.sourceId && !thread.archivedAt)
      .sort(byMostRecent)[0];
    selectedAgentRef.current = route.sourceId;
    selectedThreadRef.current = recent?.id ?? null;
    setSelectedAgentId(route.sourceId);
    setSelectedThreadId(recent?.id ?? null);
    localStorage.setItem(SELECTED_AGENT_STORAGE_KEY, route.sourceId);
    persistThreadId(route.sourceId, recent?.id ?? null);
    setActionError(null);
  }, [routeRevision, threads]);

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
    const threadId = conversationThreadFromPath();
    if (threadId === undefined) return;
    const messageId = messageIdFromHash();
    if (messageId !== undefined) {
      const pending = pendingAnchorRef.current;
      if (
        selectedThreadRef.current !== threadId
        || pending?.threadId !== threadId
        || pending.messageId !== messageId
      ) selectSearchMatch(threadId, messageId);
      return;
    }
    if (selectedThreadRef.current !== threadId) selectThread(threadId);
  }, [routeRevision, selectSearchMatch, selectThread]);

  const createThread = useCallback(async (sourceId?: string) => {
    const targetSourceId = sourceId ?? selectedAgentId;
    if (!targetSourceId) throw new Error("Select an agent before starting a conversation.");
    try {
      const thread = await api.createThread(targetSourceId);
      selectedAgentRef.current = targetSourceId;
      setSelectedAgentId(targetSourceId);
      localStorage.setItem(SELECTED_AGENT_STORAGE_KEY, targetSourceId);
      selectedThreadRef.current = thread.id;
      setSelectedThreadId(thread.id);
      persistThreadId(targetSourceId, thread.id);
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
    setBootstrap((current) => current === null
      ? current
      : { ...current, threads: mergeThreads(current.threads, [fetched.thread]) });
    return fetched.thread;
  }, [detail, threads]);

  useEffect(() => {
    if (bootstrap === null || migrationStartedRef.current) return;
    const stored = readStoredRunPreferences();
    if (Object.keys(stored).length === 0) {
      localStorage.removeItem(RUN_PREFERENCES_STORAGE_KEY);
      migrationStartedRef.current = true;
      setPreferenceMigrationComplete(true);
      return;
    }
    migrationStartedRef.current = true;
    let remaining = { ...stored };
    const persistRemaining = () => {
      if (Object.keys(remaining).length === 0) {
        localStorage.removeItem(RUN_PREFERENCES_STORAGE_KEY);
      } else {
        localStorage.setItem(RUN_PREFERENCES_STORAGE_KEY, JSON.stringify(remaining));
      }
    };
    void (async () => {
      for (const [key, legacy] of Object.entries(stored)) {
        const context = parseStoredPreferenceKey(key);
        const source = context === undefined
          ? undefined
          : bootstrap.agents.find(({ sourceId }) => sourceId === context.sourceId);
        if (context === undefined || source === undefined) {
          delete remaining[key];
          persistRemaining();
          continue;
        }
        const validated = validateRunPreference(source, legacy);
        const runPreference: WebRunPreference | null = validated.model || validated.effort
          ? {
              ...(validated.model ? { model: validated.model } : {}),
              ...(validated.effort ? { effort: validated.effort } : {}),
            }
          : null;
        if (runPreference === null) {
          delete remaining[key];
          persistRemaining();
          continue;
        }
        try {
          if (context.threadId === null) {
            const current = await api.agentPreferences(context.sourceId);
            setAgentPreferences((preferences) => ({
              ...preferences,
              [context.sourceId]: current.runPreference,
            }));
            if (current.runPreference === null) {
              const updated = await api.patchAgentPreferences(context.sourceId, runPreference);
              setAgentPreferences((preferences) => ({
                ...preferences,
                [context.sourceId]: updated.runPreference,
              }));
            }
          } else {
            const current = bootstrap.threads.find(({ id }) => id === context.threadId)
              ?? (await api.thread(context.threadId)).thread;
            if (current.sourceId !== context.sourceId || current.workflowStatus === undefined) {
              delete remaining[key];
              persistRemaining();
              continue;
            }
            if (current.runPreference === null) {
              const updated = await api.patchThread(current.id, {
                runPreference,
                expectedRevision: current.revision,
              });
              setBootstrap((snapshot) => snapshot === null
                ? snapshot
                : { ...snapshot, threads: mergeThreads(snapshot.threads, [updated]) });
              setDetail((snapshot) => snapshot?.thread.id === updated.id
                ? { ...snapshot, thread: updated }
                : snapshot);
            }
          }
          delete remaining[key];
          persistRemaining();
        } catch (migrationError) {
          if (
            migrationError !== null
            && typeof migrationError === "object"
            && "status" in migrationError
            && migrationError.status === 404
          ) {
            delete remaining[key];
            persistRemaining();
            continue;
          }
          setActionError(errorMessage(migrationError));
        }
      }
    })().finally(() => setPreferenceMigrationComplete(true));
  }, [bootstrap]);

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
    } catch (unarchiveError) {
      setActionError(errorMessage(unarchiveError));
      throw unarchiveError;
    }
  }, [fetchThreadSummary]);

  const deleteThread = useCallback(async (threadId: string) => {
    try {
      const thread = await fetchThreadSummary(threadId);
      await api.deleteThread(thread.id);
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

  const updateThreadWorkspace = useCallback(async (
    threadId: string,
    patch: {
      readonly workflowStatus?: WebWorkflowStatus;
      readonly pinned?: boolean;
      readonly collectionId?: string | null;
    },
  ) => {
    try {
      const current = await fetchThreadSummary(threadId);
      const updated = await api.patchThread(current.id, {
        ...patch,
        expectedRevision: current.revision,
      });
      setBootstrap((snapshot) => snapshot === null
        ? snapshot
        : {
            ...snapshot,
            threads: snapshot.threads.map((thread) => thread.id === updated.id ? updated : thread),
          });
      setDetail((snapshot) => snapshot?.thread.id === updated.id
        ? { ...snapshot, thread: updated }
        : snapshot);
      setActionError(null);
    } catch (workspaceError) {
      setActionError(errorMessage(workspaceError));
      throw workspaceError;
    }
  }, [fetchThreadSummary]);

  const queryWorkspaceThreads = useCallback(async (query: ThreadQuery) => {
    try {
      const page = await api.workspaceThreads(query);
      const durableThreads = page.threads.map(({ searchMatch: _searchMatch, ...thread }) => thread);
      setBootstrap((snapshot) => snapshot === null
        ? snapshot
        : { ...snapshot, threads: mergeThreads(snapshot.threads, durableThreads) });
      setActionError(null);
      return page;
    } catch (queryError) {
      setActionError(errorMessage(queryError));
      throw queryError;
    }
  }, []);

  const createCollection = useCallback(async (name: string) => {
    try {
      const collection = await api.createCollection(name.trim());
      setCollections((current) => [...current, collection]
        .sort((left, right) => left.name.localeCompare(right.name)));
      setBootstrap((snapshot) => snapshot === null
        ? snapshot
        : { ...snapshot, collections: [...snapshot.collections, collection] });
      setActionError(null);
      return collection;
    } catch (collectionError) {
      setActionError(errorMessage(collectionError));
      throw collectionError;
    }
  }, []);

  const renameCollection = useCallback(async (collectionId: string, name: string) => {
    try {
      const updated = await api.patchCollection(collectionId, name.trim());
      setCollections((current) => current
        .map((collection) => collection.id === updated.id ? updated : collection)
        .sort((left, right) => left.name.localeCompare(right.name)));
      setBootstrap((snapshot) => snapshot === null
        ? snapshot
        : {
            ...snapshot,
            collections: snapshot.collections.map((collection) =>
              collection.id === updated.id ? updated : collection),
          });
      setActionError(null);
    } catch (collectionError) {
      setActionError(errorMessage(collectionError));
      throw collectionError;
    }
  }, []);

  const deleteCollection = useCallback(async (collectionId: string) => {
    try {
      await api.deleteCollection(collectionId);
      setCollections((current) => current.filter(({ id }) => id !== collectionId));
      setBootstrap((snapshot) => snapshot === null
        ? snapshot
        : {
            ...snapshot,
            collections: snapshot.collections.filter(({ id }) => id !== collectionId),
            threads: snapshot.threads.map((thread) => thread.collectionId === collectionId
              ? { ...thread, collectionId: null }
              : thread),
          });
      setDetail((snapshot) => snapshot?.thread.collectionId === collectionId
        ? { ...snapshot, thread: { ...snapshot.thread, collectionId: null } }
        : snapshot);
      setActionError(null);
    } catch (collectionError) {
      setActionError(errorMessage(collectionError));
      throw collectionError;
    }
  }, []);

  const modelOptions = selectedAgent?.models ?? [];
  const conversationPreference = selectedThread?.runPreference;
  const agentPreference = selectedAgentId === null
    ? null
    : agentPreferences[selectedAgentId];
  const effectivePreference = effectiveRunPreference(
    conversationPreference,
    agentPreference,
    {
      model: selectedAgent?.defaultModel ?? modelOptions[0],
      effort: selectedAgent?.defaultEffort,
    },
  );
  const model = conversationPreference?.model
    && selectedAgent?.models?.includes(conversationPreference.model)
    ? conversationPreference.model
    : "";
  const effectiveModel = effectivePreference.model;
  const effortOptions = effortLevelsForAgentModel(selectedAgent, effectiveModel);
  const effort = conversationPreference?.effort
    && effortOptions.includes(conversationPreference.effort)
    ? conversationPreference.effort
    : "";
  const effectiveEffort = effortOptions.includes(effectivePreference.effort)
    ? effectivePreference.effort
    : "";

  const persistSelectedRunPreference = useCallback((next: WebRunPreference | null) => {
    const thread = selectedThread;
    if (!thread || thread.workflowStatus === undefined) return;
    const generation = ++runPreferenceGenerationRef.current;
    runPreferenceDraftRef.current = { threadId: thread.id, preference: next };
    const optimistic = { ...thread, runPreference: next };
    setBootstrap((current) => current === null
      ? current
      : {
          ...current,
          threads: current.threads.map((item) => item.id === thread.id ? optimistic : item),
        });
    setDetail((current) => current?.thread.id === thread.id
      ? { ...current, thread: optimistic }
      : current);
    const operation = runPreferenceQueueRef.current.then(async () => {
      const updated = await api.patchThread(thread.id, { runPreference: next });
      const draft = runPreferenceDraftRef.current;
      const projected = draft?.threadId === updated.id && generation !== runPreferenceGenerationRef.current
        ? { ...updated, runPreference: draft.preference }
        : updated;
      setBootstrap((current) => current === null
        ? current
        : {
            ...current,
            threads: current.threads.map((item) => item.id === projected.id ? projected : item),
          });
      setDetail((current) => current?.thread.id === projected.id
        ? { ...current, thread: projected }
        : current);
      if (generation === runPreferenceGenerationRef.current) {
        runPreferenceDraftRef.current = null;
        setActionError(null);
      }
    });
    runPreferenceQueueRef.current = operation.catch(() => undefined);
    void operation.catch(async (preferenceError: unknown) => {
      if (generation !== runPreferenceGenerationRef.current) return;
      try {
        const authoritative = await api.thread(thread.id);
        setBootstrap((current) => current === null
          ? current
          : { ...current, threads: mergeThreads(current.threads, [authoritative.thread]) });
        setDetail((current) => current?.thread.id === authoritative.thread.id
          ? authoritative
          : current);
      } catch {
        // Keep the optimistic value visible; the normal live refresh can still reconcile it.
      }
      runPreferenceDraftRef.current = null;
      setActionError(errorMessage(preferenceError));
    });
  }, [selectedThread]);

  const setModel = useCallback((next: string) => {
    if (!selectedThread) return;
    const current = runPreferenceDraftRef.current?.threadId === selectedThread.id
      ? runPreferenceDraftRef.current.preference
      : selectedThread.runPreference;
    const nextEffectiveModel = next
      || agentPreference?.model
      || selectedAgent?.defaultModel
      || selectedAgent?.models?.[0]
      || "";
    const validEfforts = effortLevelsForAgentModel(selectedAgent, nextEffectiveModel);
    const preference: WebRunPreference = {
      ...(next ? { model: next } : {}),
      ...(current?.effort && validEfforts.includes(current.effort)
        ? { effort: current.effort }
        : {}),
    };
    persistSelectedRunPreference(Object.keys(preference).length > 0 ? preference : null);
  }, [agentPreference?.model, persistSelectedRunPreference, selectedAgent, selectedThread]);

  const setEffort = useCallback((next: string) => {
    if (!selectedThread) return;
    const current = runPreferenceDraftRef.current?.threadId === selectedThread.id
      ? runPreferenceDraftRef.current.preference
      : selectedThread.runPreference;
    const preference: WebRunPreference = {
      ...(current?.model
        ? { model: current.model }
        : {}),
      ...(next ? { effort: next } : {}),
    };
    persistSelectedRunPreference(Object.keys(preference).length > 0 ? preference : null);
  }, [persistSelectedRunPreference, selectedThread]);

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
      collections,
      collectionsLoading,
      workspaceRevision,
      agentPreferences,
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
      loadAgentPreferences,
      setAgentRunPreference,
      selectThread,
      selectSearchMatch,
      pendingMessageId,
      clearPendingMessage,
      jumpToLatest,
      openConversationIndex,
      conversationDetailOpen,
      workspaceRoute,
      openMemory,
      createThread,
      renameThread,
      archiveThread,
      unarchiveThread,
      deleteThread,
      updateThreadWorkspace,
      queryWorkspaceThreads,
      createCollection,
      renameCollection,
      deleteCollection,
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
      agentPreferences,
      agents,
      archiveThread,
      bootstrap,
      cancelTurn,
      connection,
      collections,
      collectionsLoading,
      clearPendingMessage,
      jumpToLatest,
      workspaceRevision,
      createThread,
      createCollection,
      cronLoading,
      cronError,
      cronOverview,
      detail,
      detailLoading,
      deleteThread,
      deleteCollection,
      effort,
      effectiveEffort,
      effectiveModel,
      effortOptions,
      error,
      hiddenOfflineAgentCount,
      hasMoreThreads,
      hasOlderMessages,
      loadBootstrap,
      loadAgentPreferences,
      loadMoreThreads,
      loadOlderMessages,
      loadCronRunActivity,
      loading,
      model,
      modelOptions,
      skillRegistry,
      renameThread,
      refreshCron,
      renameCollection,
      selectAgent,
      selectSearchMatch,
      selectThread,
      setAgentRunPreference,
      selectedAgent,
      selectedAgentId,
      selectedThread,
      selectedThreadId,
      pendingMessageId,
      openConversationIndex,
      conversationDetailOpen,
      workspaceRoute,
      openMemory,
      sendTurn,
      sendLiveInput,
      setEffort,
      setAgentPinned,
      setModel,
      showArchived,
      showOfflineAgents,
      threads,
      unarchiveThread,
      updateThreadWorkspace,
      visibleAgents,
      visibleThreads,
      queryWorkspaceThreads,
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
