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
import {
  api,
  ApiError,
  LEAN_MESSAGE_PAGE_LIMIT,
  LEAN_THREAD_PAGE_LIMIT,
  MESSAGE_PAGE_LIMIT,
  NOT_MODIFIED,
  THREAD_PAGE_LIMIT,
  type BootstrapScope,
  type NotModified,
  type ReadThreadDetail,
} from "./api";
import { currentDataMode } from "./data-mode";
import { recordDataUsage } from "./data-usage";
import { recordServerTime } from "./server-clock";
import {
  createThreadCache,
  holdsToolCall,
  newerProjection,
  readMessageDelta,
  THREAD_CACHE_ENTRIES,
  type ThreadCache,
  type ThreadCacheEntry,
} from "./thread-cache";
import {
  createThreadPersistence,
  type HydratedConsole,
  type PersistableState,
  type ThreadPersistence,
} from "./thread-persistence";
import { API_VERSION, DEFAULT_UPLOAD_LIMITS } from "./types";
import type {
  AgentSummary,
  Bootstrap,
  CatalogModel,
  CronOverview,
  MessageDelta,
  MessagePart,
  RunState,
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

export { holdsToolCall, mergeToolCallPart } from "./thread-cache";

export type ConnectionState = "connecting" | "live" | "reconnecting" | "offline";

/** One reply attachment, as the store hands it back after minting access. */
type ReplyAttachmentMessagePart = Extract<MessagePart, { readonly type: "attachment" }>;

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
  /** What this thread, or the next draft thread, will actually run on. */
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
  readonly setAgentRunDefaults: (model: string | null, effort: string | null) => Promise<void>;
  readonly clearAgentRunDefaults: () => Promise<void>;
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
  /**
   * Replace one truncated tool call in the open conversation with its whole
   * body. Resolves to `true` when the transcript changed.
   */
  readonly loadFullToolCall: (toolCallId: string) => Promise<boolean>;
  /**
   * Mint a fresh capability for one reply attachment of the open conversation.
   *
   * What this device keeps carries no capability URLs -- they are short-lived
   * credentials and persistence strips them -- so a picture or a file restored
   * from the device arrives with an identity and no way to read its bytes. It is
   * not gone, and this is how the transcript asks for the key again.
   */
  readonly refreshReplyAttachmentAccess: (partId: string) => Promise<ReplyAttachmentMessagePart>;
  /**
   * Forget everything this browser is keeping on the device, and everything it
   * is keeping in memory except the conversation on screen.
   */
  readonly clearCachedData: () => Promise<void>;
  /**
   * Whether the listing on screen came from the SERVER, or is what this device
   * kept from the last visit.
   *
   * A cold start now draws before anything is asked for, so "there is a
   * projection" and "the server answered" are no longer the same question --
   * and everything that treats the listing as fact has to ask this one instead.
   */
  readonly hasServerSnapshot: boolean;
  /** Dismiss the failure banner. The next successful snapshot clears it too. */
  readonly clearError: () => void;
}

const ConsoleStore = createContext<ConsoleStoreValue | null>(null);

const byMostRecent = (a: ThreadSummary, b: ThreadSummary) =>
  Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
/** How the console names one (agent, archived) listing, on the wire and on the device. */
export const threadBucketKey = (sourceId: string, archived: boolean): string =>
  `${sourceId}\0${archived ? "archived" : "active"}`;
const cronChannelKey = (sourceId: string, jobId: string): string => `${sourceId}\0${jobId}`;
/**
 * "This conversation is not in THIS bucket" -- see {@link UNLISTED_THREAD_MEMORY}.
 *
 * Keyed by the bucket the answering page came from, never by the conversation
 * alone. A page of agent A's bucket says nothing whatever about agent B's, and
 * an answer recorded against the id alone silenced every later event for a
 * conversation that had simply fallen outside A's window: switch to B, whose
 * bucket the bootstrap already seeded so nothing refetches, and B's most
 * recently active conversation would never appear.
 */
const unlistedThreadKey = (sourceId: string, archived: boolean, threadId: string): string =>
  `${threadBucketKey(sourceId, archived)}\0${threadId}`;

/**
 * One bucket's rows and one answer about them, as one listing.
 *
 * ORDERED BY THE SERVER'S REVISION, not by the order the responses reached the
 * tab. Two reads of one bucket are not ordered against each other -- a page, a
 * bootstrap and a `{thread}` payload all describe the same rows -- so taking
 * the last arrival unconditionally let a delayed revision 2 overwrite a
 * revision 3 the tab had already applied, rolling back a title, an archive
 * state or a run override the server had accepted. An EQUAL revision is the
 * same server state, and the incoming one wins so an optimistic edit made at
 * the revision it is patching still lands.
 */
const mergeThreads = (
  current: readonly ThreadSummary[],
  incoming: readonly ThreadSummary[],
): ThreadSummary[] => {
  const merged = new Map(current.map((thread) => [thread.id, thread]));
  for (const thread of incoming) {
    const held = merged.get(thread.id);
    merged.set(thread.id, held === undefined ? thread : newerProjection(held, thread));
  }
  return [...merged.values()].sort(byMostRecent);
};

/**
 * What the transcript reads from one cached conversation.
 *
 * `detail` stays exactly the shape it was -- the open conversation's summary
 * and messages -- so `runtime.tsx`, `Chat.tsx` and `notifications.tsx` are
 * untouched by the cache behind it. What changed is that the arrays inside it
 * are the CACHE's, and the cache reuses them: an untouched transcript projects
 * to the same `messages` array it did last time, which is what assistant-ui
 * short-circuits its whole store update on.
 */
const projectDetail = (entry: ThreadCacheEntry): ThreadDetail => ({
  thread: entry.thread,
  messages: entry.messages,
  ...(entry.messagesNextCursor === undefined
    ? {}
    : { messagesNextCursor: entry.messagesNextCursor }),
});

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
    // The bucket the SERVER opened on when this tab named none: it resolves the
    // same chain, and adopting its answer is what keeps a first load to one
    // request instead of a bootstrap plus the page for a different agent.
    next.agents.find((agent) => agent.sourceId === next.threadsSourceId)?.sourceId ??
    next.agents.find((agent) => agent.status !== "offline")?.sourceId ??
    next.agents[0]?.sourceId ??
    null;
  // A bootstrap carries ONE page of ONE bucket now, so a conversation missing
  // from `threads` is the ordinary case -- older than the page, or another
  // agent's -- and no longer says anything about whether it still exists.
  // Re-resolving for that alone moves the operator out of the conversation
  // they were in, so an id this tab is ALREADY on is kept and the detail read
  // the selection issues is what settles it: `loadThread` closes the
  // conversation the server answers 404 for and moves off one it finds
  // archived. An answer that DOES carry it and shows it unusable here --
  // archived, or another agent's -- settles it right now instead.
  if (currentAgent !== undefined && selectedThreadId !== null) {
    // An archived conversation the operator is READING stays open; only one
    // this answer says belongs to someone else is re-resolved.
    const selected = next.threads.find((thread) => thread.id === selectedThreadId);
    if (selected === undefined || selected.sourceId === agentId) {
      return { agentId, threadId: selectedThreadId };
    }
  }
  // The stored selection is per agent, so the agent this resolves to has one
  // whether or not it is the agent the tab came in on.
  const persistedId = agentId === null ? undefined : persistedThreadIds[agentId];
  const persisted = persistedId === undefined
    ? undefined
    : next.threads.find((thread) => thread.id === persistedId);
  if (persistedId !== undefined) {
    if (persisted !== undefined && persisted.sourceId === agentId && !persisted.archivedAt) {
      return { agentId, threadId: persistedId };
    }
    // Unlisted is "keep it" only for the agent the tab is already on. For an
    // agent it is falling back TO, this page is the only evidence there is and
    // an id it does not carry is not something to open blind.
    if (persisted === undefined && currentAgent !== undefined) return { agentId, threadId: persistedId };
  }
  const thread = [...next.threads]
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
 * What the REQUEST ITSELF did, as opposed to what the caller was told.
 *
 * A deadline aborts a request; it does not un-send it, and a transport that
 * ignores abort can go on to deliver the mutation long after the caller has
 * given up. Anything that has to reason about ordering needs this rather than
 * the caller's promise.
 *
 * THREE answers, not two, because the browser promise only has two and one of
 * them is a lie. `fetch` rejects the moment it sees an abort -- the request it
 * has already transmitted keeps running through the proxy and the server -- so
 * a rejection AFTER WE ABORTED says only that this caller stopped listening.
 * Collapsing that into "the request failed" is what let a reconciliation read
 * around a DELETE that was still on the wire.
 *
 * - `answered`: the request reached the server and the server replied. True
 *   even after an abort: a transport that finished anyway has still landed, and
 *   that is evidence.
 * - `failed`: the request itself failed, on its own, and the error is the
 *   server's or the transport's. Something is known.
 * - `abandoned`: WE stopped listening. Nothing is known -- not that it failed,
 *   not that it was applied, not that it stopped.
 */
export type RequestLanding =
  | { readonly outcome: "answered" }
  | { readonly outcome: "failed"; readonly error: unknown }
  | { readonly outcome: "abandoned" };

/**
 * Start one request under a deadline, and hand back the three different answers
 * a CALLER, a QUEUE and an ORDERING argument need from it.
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
 *
 * `landed` is for anything that has to ORDER itself against this request, and
 * it never rejects. A reconciliation that reads while the request it is
 * reconciling is still on the wire is not a linearization point at all: the
 * read saw the row, the abandoned DELETE then removed it, and the console had
 * already called that a refusal. Waiting on this first is what makes the read
 * mean anything.
 *
 * Which is why it reports `abandoned` rather than the rejection the deadline
 * itself provoked. Waiting on the browser promise was still reading around the
 * request: `fetch` rejects on the abort while the DELETE runs on, so the wait
 * ended at the one moment that proves nothing. A caller ordering against this
 * needs to be told that, not handed the abort dressed as settlement.
 */
export const startBoundedRequest = <T,>(
  run: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number = THREAD_WRITE_TIMEOUT_MS,
): {
  readonly result: Promise<T>;
  readonly settled: Promise<void>;
  readonly landed: Promise<RequestLanding>;
} => {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Set BEFORE the abort, so no rejection the abort causes can be read as the
  // request's own. A rejection that arrives first -- a real failure a
  // microtask ahead of the deadline's macrotask -- still finds it false.
  let abandoned = false;
  const attempt = run(controller.signal);
  // Also keeps the loser of the race handled, so a late rejection is never
  // reported as unhandled.
  const landed: Promise<RequestLanding> = attempt.then(
    // Fulfilment is proof of landing however late it is, so this is NOT
    // conditioned on the abort: a transport that finished the request anyway
    // has told us the one thing an abandoned request usually cannot.
    () => ({ outcome: "answered" }) as const,
    (error: unknown) => (abandoned
      ? ({ outcome: "abandoned" }) as const
      : ({ outcome: "failed", error }) as const),
  );
  const settled = landed.then(() => undefined);
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      abandoned = true;
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
  return { result, settled, landed };
};

/**
 * One signal that aborts when either of two does.
 *
 * `AbortSignal.any` is Safari 17.4+, and this console is installed as an iOS
 * PWA on whatever iPhone the operator has; a static method the phone does not
 * have is a blank screen, not a slow read.
 */
const anySignal = (first: AbortSignal, second: AbortSignal): AbortSignal => {
  const controller = new AbortController();
  const abort = () => { controller.abort(); };
  for (const source of [first, second]) {
    if (source.aborted) {
      controller.abort();
      break;
    }
    source.addEventListener("abort", abort, { once: true });
  }
  return controller.signal;
};

/**
 * ONE conversation read, conditional whenever a validator is held.
 *
 * Every path that re-reads the open conversation goes through this -- the
 * selection effect, the debounced refresh and the gap resync -- so a console
 * that has already been served this transcript never asks for it again
 * unconditionally. A cold read holds no validator and quotes none.
 */
export const readConversation = (
  threadId: string,
  etag: string | undefined,
  signal: AbortSignal,
): Promise<ReadThreadDetail | NotModified> => (etag === undefined
  ? api.thread(threadId, signal)
  : api.threadIfChanged(threadId, etag, signal));

/** {@link startBoundedRequest} for callers with no queue to advance. */
export const boundedRequest = <T,>(
  run: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number = THREAD_WRITE_TIMEOUT_MS,
): Promise<T> => startBoundedRequest(run, timeoutMs).result;

/**
 * How long any one READ may take before it is abandoned.
 *
 * Reads had no deadline at all, and the tombstone's whole argument for a
 * ten-minute lifetime was that it outlives every request the console can have
 * outstanding. That argument was false: a bootstrap, a thread page or a
 * selection fetch on a wedged transport stays pending forever, so it could
 * answer after its tombstone expired and re-admit a conversation the server had
 * destroyed. Bounding the read is what makes the lifetime an upper bound;
 * generous compared to a write because a slow phone on a metered link should
 * see a slow sidebar, not an error.
 */
export const THREAD_READ_TIMEOUT_MS = 60_000;

/**
 * How long events are collected before one refresh answers all of them.
 *
 * A running turn emits several events per second, and a debounce is what makes
 * a burst cost one request rather than one per event.
 */
export const REFRESH_DEBOUNCE_MS = 300;

/**
 * The same window, widened on a lean link.
 *
 * A hint-driven refresh is a whole conditional read of the open conversation.
 * Waiting a second before answering a burst of them turns a running turn's
 * worth of hints into one request instead of three.
 */
export const LEAN_REFRESH_DEBOUNCE_MS = 1_000;

/**
 * How long applied writes are collected before the transcript is re-published.
 *
 * The bytes are already spent by the time a delta arrives -- what this saves is
 * the work of drawing every frame of a streamed answer, which on a phone is
 * battery and heat. The cache is written the moment each delta lands, in order,
 * so nothing about correctness depends on this: it is only when the operator's
 * screen is redrawn. A write that ENDS a turn is never held back.
 */
export const LEAN_DELTA_BATCH_MS = 1_000;

/** Read at the moment of the request, so a mode change needs no re-render. */
const threadPageLimit = (): number =>
  currentDataMode() === "lean" ? LEAN_THREAD_PAGE_LIMIT : THREAD_PAGE_LIMIT;

/**
 * How long changes are collected before one transaction writes them to the
 * device.
 *
 * A streaming turn commits a delta about once a second, and each of those is a
 * transcript this browser would otherwise rewrite. One second is short enough
 * that closing the tab mid-turn loses at most the last second of it -- which a
 * restored entry's conditional read pays for anyway -- and long enough that a
 * burst of deltas, a repair and a summary patch cost one transaction between
 * them.
 */
export const PERSIST_DEBOUNCE_MS = 1_000;

/**
 * How long the boot waits for the device before going to the network anyway.
 *
 * `indexedDB.open` is not guaranteed to answer: WebKit has shipped several
 * versions where an open from a page resumed out of suspension never fires
 * `success`, `error` OR `blocked`, and the request simply sits there. Awaiting
 * that unbounded is a console that never loads and a "Try again" that awaits
 * the same dead promise. The device is an optimisation; the network is the
 * product, so the network always goes out.
 */
export const HYDRATION_DEADLINE_MS = 1_500;

/**
 * Wait for hydration, or for {@link HYDRATION_DEADLINE_MS}, whichever is first,
 * and say which happened.
 *
 * Never rejects and never leaves a timer behind. A hang is not the only way the
 * device can hold the boot: anything the applier throws would reject the race,
 * the caller's own catch would run, and the snapshot request would never be
 * issued at all -- permanently, because the hydration promise is memoised and a
 * retry re-awaits the same rejection. The network goes out either way.
 *
 * What it does NOT do is cancel the hydration: a read that answers late is
 * still a read that answered, and the applier decides on its own terms whether
 * it is still wanted.
 */
export const withHydrationDeadline = async (
  hydration: Promise<void>,
): Promise<"hydrated" | "deadline"> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      hydration.then(
        () => "hydrated" as const,
        (hydrationError: unknown) => {
          console.debug(`[mono-agent] restoring from the device failed: ${String(hydrationError)}`);
          return "hydrated" as const;
        },
      ),
      new Promise<"deadline">((resolve) => {
        timer = setTimeout(() => resolve("deadline"), HYDRATION_DEADLINE_MS);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

/**
 * How long a selection has to settle before the stream re-points at it.
 *
 * A `?thread=` subscription is fixed at connect time, so following the
 * selection means closing one socket and opening another. Walking the sidebar
 * with the arrow keys would otherwise open one per row, and the server caps a
 * console at {@link MAX_SSE_CLIENTS} on its side. A conversation the operator
 * lands back on inside this window costs nothing at all: the subscription never
 * moved.
 */
export const STREAM_SUBSCRIPTION_DEBOUNCE_MS = 250;

/**
 * How long a BACKGROUNDED console may go without a frame before its stream is
 * presumed dead.
 *
 * iOS suspends a tab's connections without closing them: `readyState` still
 * reads OPEN when the app comes back, and a read-only stream never writes, so
 * the browser may never find out. Counted only ACROSS a hidden period -- a
 * console in the foreground is quiet because nothing is happening, not because
 * its stream died -- and the heartbeat is an SSE comment, invisible to
 * JavaScript, so silence is measured from the last real frame.
 */
export const STREAM_SILENCE_LIMIT_MS = 30_000;

/** `EventSource.CLOSED`, by value: the constructor is replaced under test. */
const STREAM_CLOSED = 2;

/**
 * How long an event that names NO conversation is held before the selected
 * bucket page is re-read.
 *
 * Deliberately longer than {@link REFRESH_DEBOUNCE_MS}: this is the least
 * specific and most expensive thing an event can ask for, and it is reached
 * only by the handful of server invalidations that carry neither a conversation
 * nor a summary -- a bulk cron sync, or a conversation this tab has never seen.
 * Everything a running turn emits names its conversation and never gets here.
 */
export const THREAD_LIST_REVALIDATE_DEBOUNCE_MS = 2_000;

/**
 * What one refresh has to re-read.
 *
 * Accumulated by every caller that asks for one and read once when the debounce
 * fires, so an event that invalidated only the open conversation costs only the
 * open conversation -- and two different asks inside one debounce window still
 * cost one round trip each at most.
 */
interface RefreshScope {
  /** The agent list, the thread listing, and the selection they resolve to. */
  readonly bootstrap: boolean;
  /** The selected conversation's messages. */
  readonly detail: boolean;
}

const NOTHING_TO_REFRESH: RefreshScope = { bootstrap: false, detail: false };

/**
 * How many conversations the console remembers as "not in the bucket on
 * screen".
 *
 * A bare listing event names a conversation and nothing else -- not even the
 * agent it belongs to -- so every turn on a BACKGROUND agent asks this tab to
 * go looking for a row it will never list, twice per turn (at the start and at
 * the finish). One page answers that question; this is where the answer is
 * kept, so the next event about the same conversation costs nothing. Bounded
 * and evicted oldest-first, so a long-lived tab cannot grow it without limit.
 */
export const UNLISTED_THREAD_MEMORY = 256;

/**
 * How long a deleted conversation stays remembered. The tombstone exists to
 * reject responses that were already in flight when the delete landed, so it
 * has to outlive the longest request the console can have outstanding.
 *
 * DERIVED from those deadlines rather than asserted next to them: the previous
 * ten minutes was a comment claiming a relationship the code did not enforce,
 * and the read half of the claim was not even true. Written this way, raising
 * either deadline raises the lifetime with it and the relationship cannot
 * silently invert.
 */
export const REMOVED_THREAD_TTL_MS =
  10 * Math.max(THREAD_READ_TIMEOUT_MS, THREAD_WRITE_TIMEOUT_MS);

export interface RemovedThreadRegistry {
  readonly remember: (threadId: string, suppressed: ThreadSummary) => void;
  /**
   * Record a projection this tombstone kept out. A delete that then FAILS has
   * to hand back what it hid: responses that arrived while it was pending had
   * already filtered the conversation out, so forgetting the tombstone alone
   * left the sidebar missing a conversation the server still has.
   *
   * Kept only if it is NEWER than what is already held -- ordered by the
   * server's revision, not by the order the responses reached the tab.
   */
  readonly suppress: (threadId: string, suppressed: ThreadSummary) => void;
  /**
   * Stop asserting that this conversation is gone, and hand back the newest
   * projection the tombstone suppressed so the caller can put it back.
   *
   * The FENCE stays. This is the unreconcilable case -- the delete may well
   * have been applied -- so a response issued before it still cannot be trusted
   * to say the conversation exists. See {@link RemovedThreadRegistry.release}
   * for the case where the server has told us it refused.
   */
  readonly forget: (threadId: string) => ThreadSummary | undefined;
  /**
   * Undo the delete entirely: the server ANSWERED that it refused, and a read
   * issued afterwards still saw the conversation. Nothing was applied, so a
   * response issued before the delete is no longer stale about whether the
   * conversation exists and must not be fenced out -- a pre-delete bootstrap
   * answering after the restore would otherwise drop the row straight back out
   * of the sidebar with no refresh to put it back.
   */
  readonly release: (threadId: string) => ThreadSummary | undefined;
  readonly has: (threadId: string) => boolean;
  /**
   * The admission epoch a caller must quote for its response to be considered.
   * Read it when a request is ISSUED, and hand it back when the response is
   * applied; every delete advances it.
   */
  readonly epoch: () => number;
  /**
   * True when a response issued at `issuedAt` was overtaken by a delete of this
   * conversation, and so cannot speak to whether it still exists.
   */
  readonly predatesDelete: (threadId: string, issuedAt: number) => boolean;
  /** Live tombstones -- entries kept only as a fence are not counted. */
  readonly size: () => number;
}

interface RemovedThread {
  readonly at: number;
  /** The admission epoch this delete was issued at. */
  readonly fencedAt: number;
  /** False once a failed delete has taken the assertion back. */
  tombstoned: boolean;
  /**
   * True when an EARLIER delete of this same row ended without proving it was
   * not applied, and so is still relying on a fence.
   *
   * A second delete REPLACES the entry the first left behind, which is the only
   * record that the fence is still protecting something. Without carrying this
   * across, a later delete the server refused would `release` -- and take with
   * it a fence the earlier delete deliberately kept.
   */
  readonly unreconciled: boolean;
  suppressed: ThreadSummary;
}

/**
 * Deleted conversations remembered long enough to reject a late response.
 *
 * Eviction is by AGE ALONE. A fixed 256-entry ring dropped the oldest tombstone
 * on the 257th delete, and a response held across that delete then put the
 * conversation back -- the one thing a tombstone is for. A 4,096-entry backstop
 * was kept after that and had exactly the same defect at a higher threshold:
 * it, too, could drop a tombstone that was still protecting something. So there
 * is no count limit. Age already bounds the map -- every entry is swept once it
 * expires, so its size is the delete rate times the lifetime, and reaching even
 * a few thousand live entries would take thousands of deletes inside ten
 * minutes, which no operator produces and which would cost a few hundred
 * kilobytes if it happened. Bounded memory is not worth resurrecting a
 * conversation the operator deleted.
 */
export const createRemovedThreadRegistry = (
  now: () => number = () => Date.now(),
  ttlMs: number = REMOVED_THREAD_TTL_MS,
): RemovedThreadRegistry => {
  const removed = new Map<string, RemovedThread>();
  // Advanced by every delete. A read quotes it when it is ISSUED, so a response
  // that quotes a lower epoch than a conversation's delete was overtaken by
  // that delete and cannot be admitted -- however the delete then turned out.
  let epoch = 0;
  const expired = (entry: RemovedThread): boolean => now() - entry.at >= ttlMs;
  const live = (threadId: string): RemovedThread | undefined => {
    const entry = removed.get(threadId);
    if (entry === undefined) return undefined;
    if (expired(entry)) {
      removed.delete(threadId);
      return undefined;
    }
    return entry;
  };
  const tombstone = (threadId: string): RemovedThread | undefined => {
    const entry = live(threadId);
    return entry?.tombstoned === true ? entry : undefined;
  };
  const stopAsserting = (
    threadId: string,
    keepFence: boolean,
  ): ThreadSummary | undefined => {
    const entry = tombstone(threadId);
    if (entry === undefined) return undefined;
    // The fence may not be dropped while an EARLIER delete of this row is still
    // unreconciled. `release` is the server saying THIS delete applied nothing;
    // it says nothing whatever about the one before it, which may yet commit,
    // so a response issued before either of them is still not evidence the row
    // survived. Keeping the fence costs the caller nothing -- the repair a
    // refusal makes quotes the CURRENT epoch and is admitted -- while dropping
    // it is what let a response held across the first delete resurrect a
    // conversation the server had destroyed.
    if (keepFence || entry.unreconciled) entry.tombstoned = false;
    else removed.delete(threadId);
    return entry.suppressed;
  };
  return {
    remember: (threadId, suppressed) => {
      // A live entry here is an earlier delete of the SAME row that never
      // proved it was not applied: `release` -- the one outcome that proves
      // that -- takes its entry away, so anything still standing is unresolved.
      // Carried forward because this delete replaces that entry, and with it
      // the only record that its fence is still protecting something.
      const unreconciled = live(threadId) !== undefined;
      removed.delete(threadId);
      epoch += 1;
      removed.set(
        threadId,
        { at: now(), fencedAt: epoch, tombstoned: true, unreconciled, suppressed },
      );
      // Insertion order is chronological, so the live entries are a suffix.
      for (const [candidate, entry] of removed) {
        if (!expired(entry)) break;
        removed.delete(candidate);
      }
    },
    suppress: (threadId, suppressed) => {
      const entry = tombstone(threadId);
      if (entry === undefined) return;
      // ORDERED BY REVISION, not by arrival. Overwriting unconditionally made
      // "the newest projection this tombstone hid" mean "the last response to
      // reach the tab", and responses do not arrive in the order the server
      // produced them: a delayed revision 2 landing after revision 3 became
      // what a failed delete restored, rolling back a title, an archive state
      // or a run override the server had already accepted. The revision is the
      // server's own monotonic counter for the row, so it orders the
      // projections by when the SERVER made them.
      //
      // An equal revision is the same server state, so the first one wins and
      // nothing is gained by replacing it.
      if (suppressed.revision <= entry.suppressed.revision) return;
      entry.suppressed = suppressed;
    },
    forget: (threadId) => stopAsserting(threadId, true),
    release: (threadId) => stopAsserting(threadId, false),
    has: (threadId) => tombstone(threadId) !== undefined,
    epoch: () => epoch,
    // The fence outlives the tombstone deliberately: it is what a response
    // issued before the delete has to be measured against, and such a response
    // is bounded by the same deadlines the lifetime is derived from.
    predatesDelete: (threadId, issuedAt) => {
      const entry = live(threadId);
      return entry !== undefined && issuedAt < entry.fencedAt;
    },
    size: () => [...removed.values()].filter((entry) => entry.tombstoned).length,
  };
};

/**
 * What a failed DELETE actually tells you about the server.
 *
 * It tells you the ANSWER did not arrive. It does not tell you the request was
 * never applied: the server commits the row deletion first and only then awaits
 * attachment cleanup and emits its invalidations, so a dropped connection or
 * this console's own deadline can fire while the conversation is already gone.
 *
 * - `refused`: the server answered with one of the codes it publishes for this
 *   route BEFORE it touches anything -- the conversation still has an active
 *   turn, is not archived, is a configured cron channel, or a guard rejected
 *   the mutation outright. Nothing was applied.
 * - `applied`: the console's own handler answered `thread_not_found`. It is the
 *   handler that would have deleted the row, so the postcondition the operator
 *   asked for already holds however it got there.
 * - `unknown`: everything else. The state is genuinely unknown and neither
 *   assumption is available -- see {@link reconcileFailedDelete}.
 */
export type DeleteFailureVerdict = "refused" | "applied" | "unknown";

/**
 * Every code the DELETE route can answer with before it has touched anything:
 * the three the handler itself raises, and the guards that reject a mutation
 * before any handler runs.
 *
 * A CODE, not a status class. Reading "4xx" as "the server refused" credits
 * this server with every 4xx on the path -- a proxy's 404, a gateway's 408, a
 * load balancer's 429 -- and none of those knows whether the delete was
 * applied. Anything not published here is `unknown`, which is reconciled rather
 * than assumed, so an unlisted code costs a round trip and never a wrong answer.
 */
const DELETE_REFUSAL_CODES: ReadonlySet<string> = new Set([
  "turn_active",
  "thread_not_archived",
  "cron_channel_configured",
  "untrusted_host",
  "cross_site_request",
  "invalid_origin",
  "origin_mismatch",
  "origin_required",
  "invalid_host",
]);

export const classifyDeleteFailure = (error: unknown): DeleteFailureVerdict => {
  if (!(error instanceof ApiError)) return "unknown";
  // Only the route's own not-found is evidence. A bare 404 is as likely to be
  // a proxy that never reached this console, and the console's `/api` fallback
  // answers `not_found` for a route that does not exist at all.
  if (error.status === 404) return error.code === "thread_not_found" ? "applied" : "unknown";
  if (error.status < 400 || error.status >= 500) return "unknown";
  return error.code !== undefined && DELETE_REFUSAL_CODES.has(error.code)
    ? "refused"
    : "unknown";
};

export interface FailedDeleteOutcome {
  readonly verdict: DeleteFailureVerdict;
  /**
   * What the server said the conversation is, when it was asked -- present
   * whenever a read answered, including on `unknown`. A verdict is a claim
   * about the REQUEST; this is an observation of the ROW, and the two come
   * apart exactly when the request ended without an answer.
   */
  readonly thread?: ThreadSummary;
}

/**
 * How long a reconciliation waits for THIS CLIENT'S OWN abandoned DELETE to
 * stop being outstanding.
 *
 * The write deadline again, because that is the budget the request already had
 * and a healthy `fetch` rejects the instant it sees the abort, so a live
 * transport pays nothing here at all.
 */
export const DELETE_LANDING_GRACE_MS = THREAD_WRITE_TIMEOUT_MS;

/** `undefined` when the request is still outstanding after `timeoutMs`. */
const landingWithin = async (
  landed: Promise<RequestLanding>,
  timeoutMs: number,
): Promise<RequestLanding | undefined> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const grace = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), timeoutMs);
  });
  try {
    return await Promise.race([landed, grace]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

/**
 * Turn a delete failure into an answer by ASKING the server, rather than by
 * assuming either way -- and ask only once the question can be answered.
 *
 * TWO things have to be true before a read means anything here.
 *
 * First, this client's own DELETE must have stopped being outstanding. The
 * console's deadline aborts a request; it does not un-send one, so a read
 * issued while the DELETE is still on the wire cannot order itself against it:
 * the read saw the row, the DELETE then landed and removed it, and the console
 * had already called that a refusal. `landed` is what makes the read a
 * linearization point with respect to this client.
 *
 * Which is why an ABANDONED request is `unknown` and not a rejection to
 * classify. `fetch` rejects on the abort while the request it transmitted goes
 * on running, so waiting for the browser promise still ended the wait at the
 * one moment that proves nothing -- the same defect one level in. The two ways
 * to have no linearization point, a request that never settles and a request
 * this console stopped listening to, are now told apart and answered the same
 * honest way: nothing is claimed, and nothing is read.
 *
 * Second, a refusal is about the REQUEST, never about the conversation as it
 * stands. "Cancel the active turn first" is a true statement about a row
 * another client may have deleted while the answer was in flight, so a refusal
 * is confirmed by a read like anything else. This costs one round trip on a
 * refused delete and is the only thing that can notice the row is already gone.
 *
 * Which makes `refused` a two-sided test, and the read only one side of it. The
 * server has to have ANSWERED that it refused, AND a read issued after that has
 * to still find the row. Taking the read alone made a sighting a refusal even
 * for a failure that was never an answer, and a request that was never answered
 * is a request that may still be running: the row was there when the read ran,
 * and the DELETE committed just after it. That is the abandoned case
 * with a different first move, and it is answered the same honest way -- the
 * row is reported so the caller can repair its projection from it, and the
 * verdict stays `unknown` so nothing downstream may act as though the server
 * had promised the conversation survived.
 *
 * Bounded by the WRITE deadline, not the more generous read one: the operator
 * is already waiting on a delete that failed, and a reconciliation that has not
 * answered inside that budget has told us what it can -- nothing.
 *
 * REMAINING GAP, stated rather than closed: nothing here linearizes against
 * OTHER clients. Between this read answering and the projection being repaired,
 * another tab can delete the conversation, and no client-side protocol can see
 * that. The read narrows the window to one round trip and the server's next
 * invalidation closes it; a client cannot do better than that.
 */
export const reconcileFailedDelete = async (
  threadId: string,
  landed: Promise<RequestLanding>,
): Promise<FailedDeleteOutcome> => {
  const landing = await landingWithin(landed, DELETE_LANDING_GRACE_MS);
  // Still on the wire, or abandoned by this console's own deadline. Either way
  // there is nothing to order a read against, so no verdict is available.
  if (landing === undefined || landing.outcome === "abandoned") return { verdict: "unknown" };
  // It answered after the caller gave up, which is exactly what an abandoned
  // request is always allowed to do.
  if (landing.outcome === "answered") return { verdict: "applied" };
  const answer = classifyDeleteFailure(landing.error);
  if (answer === "applied") return { verdict: "applied" };
  try {
    const current = await boundedRequest((signal) => api.thread(threadId, signal));
    // The conversation outlived the request. That is proof NOTHING WAS APPLIED
    // only when the server ANSWERED, because an answer is what ends a request
    // and only an ended request makes this read a linearization point.
    //
    // A rejection that is not an answer is the abandoned case one door along.
    // `fetch` rejects on a reset connection, a proxy that dropped the socket, a
    // gateway that replied for a server it could not reach -- and in every one
    // of those the DELETE this console transmitted may still be running and may
    // commit immediately after this read. So the row is REPORTED, because it is
    // the freshest thing the server has said and the caller needs it, and the
    // verdict is WITHHELD, because a point-in-time sighting is not a refusal.
    return answer === "refused"
      ? { verdict: "refused", thread: current.thread }
      : { verdict: "unknown", thread: current.thread };
  } catch (reconcileError) {
    // A second failure is not a second chance to guess: only an affirmative
    // "not found" moves this off `unknown`.
    return { verdict: classifyDeleteFailure(reconcileError) === "applied" ? "applied" : "unknown" };
  }
};

/**
 * Whether one response may put one conversation into the projection.
 *
 * Every insertion path runs through this. The tombstone used to be consulted at
 * three of eleven of them, so a bootstrap, a thread page, or a selection fetch
 * held across a delete put the conversation straight back into the sidebar --
 * and `refreshNow` fires on every SSE event behind a 300 ms debounce, which
 * makes an in-flight bootstrap across a delete ordinary rather than exotic.
 *
 * TWO tests, not one. The tombstone filters while it stands, and what it
 * filters it also RECORDS, because a delete that fails has to be able to put
 * back everything it hid -- the detail paths used to drop those projections on
 * the floor, so the newest thing this tab had seen was not what a rollback
 * handed back. The fence outlives the tombstone: a delete that turns out
 * unreconcilable stops asserting the conversation is gone, but a response
 * ISSUED BEFORE it is still not evidence that it survived. Without the fence an
 * archived page that predated the delete walked back into the sidebar over the
 * refresh that had just removed the row.
 *
 * `issuedAt` is {@link RemovedThreadRegistry.epoch} read when the request went
 * out. It is a required argument on purpose: a caller that cannot say when it
 * asked has no business inserting anything.
 */
const admitThread = (
  removed: RemovedThreadRegistry,
  incoming: ThreadSummary,
  issuedAt: number,
): boolean => {
  if (removed.has(incoming.id)) {
    removed.suppress(incoming.id, incoming);
    return false;
  }
  return !removed.predatesDelete(incoming.id, issuedAt);
};

/** {@link admitThread} over one response's worth of conversations. */
const admitThreads = (
  removed: RemovedThreadRegistry,
  incoming: readonly ThreadSummary[],
  issuedAt: number,
): readonly ThreadSummary[] =>
  incoming.filter((thread) => admitThread(removed, thread, issuedAt));

/**
 * One message repair, and what became known while it was on the wire.
 *
 * The join is what keeps a copy that fell behind from buying a request per
 * streamed frame; `wantedSeq` and `dirty` are what keep the join from being a
 * silent drop, because the read was issued before those versions existed and
 * its answer cannot be assumed to carry them.
 */
interface MessageRepair {
  promise: Promise<void>;
  /** The highest version a delta named while this was out. */
  wantedSeq: number;
  /** A hint arrived while this was out, and hints carry no version. */
  dirty: boolean;
}

export interface ThreadWriteChain {
  readonly enqueue: <T>(
    threadId: string,
    run: (signal: AbortSignal) => Promise<T>,
    timeoutMs?: number,
  ) => Promise<T>;
  /**
   * Resolve once every write ISSUED BEFORE THIS CALL has left the queue -- and
   * REJECT if the last of them did not reach the server.
   *
   * Settlement used to collapse fulfilment and rejection to `void`, which made
   * "everything I sent has landed" indistinguishable from "everything I sent
   * has stopped". A send waits on this precisely so the server is not asked
   * what to run on until the operator's newest run settings are there; after a
   * failed reset the server still holds the OLD override and answers with it,
   * so proceeding ran the very configuration the operator had just cleared.
   *
   * A later write that SUCCEEDS clears the failure: it is the operator's newest
   * intent and the server has it, so it must not wedge the composer.
   */
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
  // The last write to this conversation that did not reach the server, still
  // unobserved by a `settle`. Recorded from INSIDE the request rather than off
  // the caller's promise, so it is already written by the time the queue link
  // resolves and `settle` cannot read it a microtask too early.
  const unlanded = new Map<string, unknown>();
  return {
    enqueue: <T,>(
      threadId: string,
      run: (signal: AbortSignal) => Promise<T>,
      timeoutMs: number = THREAD_WRITE_TIMEOUT_MS,
    ): Promise<T> => {
      const previous = tails.get(threadId) ?? Promise.resolve();
      const recorded = (signal: AbortSignal): Promise<T> => run(signal).then(
        (value) => { unlanded.delete(threadId); return value; },
        (error: unknown) => { unlanded.set(threadId, error); throw error; },
      );
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
          started = startBoundedRequest(recorded, timeoutMs);
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
      // Nothing outstanding: whatever failed earlier has already been reported
      // to the operator and rolled back, so the projection they are looking at
      // is the server's own state and there is nothing to hold back.
      if (tail === undefined) {
        unlanded.delete(threadId);
        return;
      }
      await tail;
      if (!unlanded.has(threadId)) return;
      const error = unlanded.get(threadId);
      unlanded.delete(threadId);
      throw new Error(
        `An earlier change to this conversation did not reach the server: ${errorMessage(error)}`,
      );
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
  /**
   * The conversation the OPEN stream names, which lags the selection by
   * {@link STREAM_SUBSCRIPTION_DEBOUNCE_MS}.
   *
   * Seeded from the selection this browser stored, so the ordinary page load
   * opens its one stream already pointed at the conversation the snapshot is
   * about to resolve to. A guess that turns out wrong costs one reconnect; not
   * guessing cost one on every single load.
   */
  const [subscribedThreadId, setSubscribedThreadId] = useState<string | null>(() => {
    const sourceId = cronRouteSelection()?.sourceId ?? localStorage.getItem(SELECTED_AGENT_STORAGE_KEY);
    if (sourceId === null) return null;
    return readPersistedThreadIds()[sourceId] || null;
  });
  /**
   * Bumped to rebuild the stream in place -- same subscription, new socket.
   *
   * What a resume needs and what an `EventSource` the operating system killed
   * will not do for itself.
   */
  const [streamGeneration, setStreamGeneration] = useState(0);
  const [detail, setDetail] = useState<ThreadDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [connection, setConnectionState] = useState<ConnectionState>("connecting");
  /**
   * Whether a snapshot from the SERVER has landed.
   *
   * False on a console that opened on what the device kept and has not been
   * answered yet -- which is a console whose listing, whose agents and whose
   * run state are all last-visit facts. See {@link ConsoleStoreValue.hasServerSnapshot}.
   */
  const [hasServerSnapshot, setHasServerSnapshot] = useState(false);
  const [skillRegistryState, setSkillRegistryState] = useState<{
    readonly sourceId: string | null;
    readonly registry: SkillRegistryState;
    /** The validator the last READY answer carried, quoted by the next read. */
    readonly etag?: string;
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
  /**
   * Bumped by every selection the OPERATOR makes -- an agent, a conversation, a
   * new conversation, an archive or unarchive -- and by nothing the console
   * decides on its own.
   *
   * A failed delete owes the operator the selection its tombstone cost them,
   * and the question it has to answer is "have they chosen somewhere else since
   * I started?". `selectedThreadRef.current === null` was standing in for that
   * and answers a different question in both directions: a bootstrap that
   * answered mid-delete re-resolves the selection to a surviving conversation,
   * which is not null and not a choice, so the repair was skipped; and an
   * operator who deliberately moved to an empty agent leaves it null, which IS
   * a choice, so Alpha's conversation id was restored under Beta and every
   * later run action targeted a thread the console was not showing.
   */
  const operatorSelectionRef = useRef(0);
  const selectedAgentRef = useRef<string | null>(selectedAgentId);
  /** The catalog scope a page walk was started under. See `catalogScope`. */
  const catalogScopeRef = useRef<string>("");
  const skillRequestGenerationRef = useRef(0);
  const skillRegistryStateRef = useRef(skillRegistryState);
  const refreshTimerRef = useRef<number | null>(null);
  const refreshInFlightRef = useRef(false);
  const refreshQueuedRef = useRef(false);
  const refreshScopeRef = useRef<RefreshScope>(NOTHING_TO_REFRESH);
  /** Conversations whose applied deltas are waiting for the lean paint tick. */
  const deltaPublishRef = useRef<{ timer: number | null; threads: Set<string> }>({
    timer: null,
    threads: new Set(),
  });
  const scheduleRefreshRef = useRef<(scope: Partial<RefreshScope>) => void>(() => undefined);
  const threadListTimerRef = useRef<number | null>(null);
  /**
   * The (agent, archived) buckets a bootstrap has already delivered.
   *
   * A bootstrap carries every bucket the server has, so the page request the
   * sidebar issued right after one fetched the same rows a second time -- on
   * the first load, on every agent switch and on every archive toggle.
   */
  const seededBucketsRef = useRef<Set<string>>(new Set());
  /** The current listing and selection, for the SSE handler to read at event time. */
  const threadsRef = useRef<readonly ThreadSummary[]>([]);
  /** The open conversation's own summary, which outlives its row in the listing. */
  const detailThreadRef = useRef<ThreadSummary | null>(null);
  /**
   * What this browser keeps between visits -- see `thread-persistence.ts`.
   *
   * Created on first render rather than per render: the module opens nothing
   * until it is asked to, but there is exactly one owner of the device store.
   */
  const persistenceRef = useRef<ThreadPersistence | null>(null);
  persistenceRef.current ??= createThreadPersistence();
  /**
   * Whether hydration has settled.
   *
   * Nothing may be WRITTEN before it has: the first flush deletes every stored
   * row this tab is not holding, and before hydration it is holding none of
   * them.
   */
  const persistReadyRef = useRef(false);
  const persistTimerRef = useRef<number | null>(null);
  const schedulePersistRef = useRef<() => void>(() => undefined);
  /** The listing and the snapshot as of this render, for the flush to write. */
  const persistedBucketRef = useRef<PersistableState["bucket"]>(undefined);
  const persistedSnapshotRef = useRef<PersistableState["snapshot"]>(undefined);
  /**
   * The console that wrote what was restored, until the live one is known.
   *
   * Checked exactly once, against the first snapshot that answers: a different
   * host is a different console's conversations, and none of it is this one's
   * to show.
   */
  const hydratedHostRef = useRef<string | null>(null);
  /** The one hydration, so every caller awaits the same read. */
  const hydrationRef = useRef<Promise<void> | null>(null);
  /** Whether the boot has already given the device its one wait. */
  const hydrationDeadlineSpentRef = useRef(false);

  /**
   * Every conversation this tab is keeping, not just the one on screen.
   *
   * A ref rather than state on purpose: it is the console's copy of the SERVER,
   * and `detail` is a projection of one entry in it. Writes to it are made from
   * event handlers, from responses and from an operator action, and they have
   * to be visible to the next one immediately -- a repair that read a
   * pre-commit snapshot is exactly the defect the previous round had to guard
   * against with a decision made outside the state updater.
   */
  const threadCacheRef = useRef<ThreadCache>(createThreadCache(
    THREAD_CACHE_ENTRIES,
    undefined,
    // Off the render path by construction: the cache is written from event
    // handlers and from responses, and this only arms a timer.
    () => schedulePersistRef.current(),
  ));
  /**
   * The message repairs on the wire, by (conversation, message).
   *
   * A running turn writes a message every ~50 ms, so a copy that has fallen
   * behind sees a gap on every frame until the read that fixes it answers. One
   * read answers all of them -- and `wantedSeq`/`dirty` are what a version that
   * became known WHILE that read was out is recorded in, so joining the read
   * does not silently swallow it.
   */
  const messageRepairsRef = useRef<Map<string, MessageRepair>>(new Map());
  /** See {@link UNLISTED_THREAD_MEMORY}. */
  const unlistedThreadsRef = useRef<Set<string>>(new Set());

  /** The conversations the next bucket revalidation is being asked about. */
  const pendingRevalidationRef = useRef<Set<string>>(new Set());

  const showArchivedRef = useRef(showArchived);
  const selectedCronJobIdRef = useRef<string | undefined>(undefined);
  const completeThreadRemovalRef = useRef<(thread: ThreadSummary, requestedId: string) => void>(
    () => undefined,
  );
  /** Whether the bootstrap this component asked for on mount has answered. */
  const initialBootstrapRef = useRef<"pending" | "answered">("pending");
  /** Whether this store is still mounted. See `scheduleRefresh`. */
  const mountedRef = useRef(true);
  /**
   * A selection this store RESTORED rather than the operator making it.
   *
   * The stored id outlives the browser and one bucket page cannot confirm it,
   * so an id the answer did not carry is opened on trust -- and the detail read
   * is the only thing that can say the conversation was deleted or archived
   * from another client since. What the OPERATOR opened -- a search hit, a push
   * deep link, a sidebar row -- is their choice and is never second-guessed.
   */
  const restoredSelectionRef = useRef<string | null>(null);
  const hasBootstrapRef = useRef(false);
  /**
   * The next `ready` has a GAP behind it: the stream dropped, the app was
   * suspended, or the link went away, and this console cannot say what it
   * missed. It answers with the conditional resync below.
   *
   * A `ready` on a stream this console re-pointed ITSELF -- the operator opened
   * another conversation -- carries no such gap and costs nothing.
   */
  const resyncOnReadyRef = useRef(false);
  /**
   * The listing missed the same window the stream did.
   *
   * Set by a drop, answered by ONE merge page of the active bucket rather than
   * the whole snapshot a reconnect used to buy.
   */
  const staleBucketRef = useRef(false);
  /** When the last frame arrived, so a resume can tell a quiet stream from a dead one. */
  const lastEventAtRef = useRef(0);
  /**
   * The connection state the DOM handlers read.
   *
   * Written by {@link applyConnection}, never during render: `online` fires
   * from a browser event and decides what to do on the state as of the LAST
   * decision, not as of the last commit. Read from a render-assigned ref, an
   * `offline` immediately followed by an `online` still looked "live" and the
   * console stayed offline behind a banner it could not clear.
   */
  const connectionRef = useRef<ConnectionState>("connecting");
  /**
   * {@link hasServerSnapshot}, for the handlers that run between commits.
   *
   * ONE-WAY on purpose: a refresh that fails LATER leaves the console live
   * behind the error banner, because demoting a console the server has answered
   * -- and whose stream is up -- over one failed request would take the
   * composer away from an operator who can still use it. The gate exists for
   * the cold start, which is the case where the listing on screen has no server
   * behind it at all.
   */
  const hasServerSnapshotRef = useRef(false);
  /**
   * The last connection decision as it was MADE, before the snapshot gate
   * below turned it down.
   *
   * A socket can be up while the snapshot is still in flight or has failed
   * outright. Remembering that it said so is what lets the console promote
   * itself the moment the gate opens, rather than waiting for an event that may
   * not come for hours on a quiet fleet.
   */
  const streamLiveRef = useRef(false);
  /**
   * A resume this console owes because the tab was still in the background
   * when it was asked for.
   *
   * `resume` refuses to rebuild a socket the system is about to suspend again;
   * without recording that, an `online` arriving while hidden was simply lost
   * and the next `visibilitychange` -- unforced -- saw a socket that reads
   * healthy and left the console offline over it.
   */
  const resumeOwedRef = useRef(false);
  /**
   * A socket a resume built that has neither opened nor failed yet.
   *
   * `online` can land inside that window, when `readyState` and `errored` still
   * describe the socket that was closed -- and forcing a second resume there
   * tore down the replacement before it had a chance to open.
   */
  const resumeInFlightRef = useRef(false);
  /**
   * Whether this tab has opened a stream before.
   *
   * Every stream after the first is a REBUILD, and a rebuild loses whatever the
   * server emitted between closing one socket and registering the next --
   * `thread.changed` is broadcast to every connection, subscribed or not. What
   * provoked it does not matter: a subscription that moved, a resume, or a
   * dependency of the effect that changed. The `ready` that follows one has a
   * gap behind it like any other.
   */
  const streamOpenedBeforeRef = useRef(false);
  /** When the document went to the background, or `null` while it is on screen. */
  const hiddenSinceRef = useRef<number | null>(null);
  /**
   * The conversation `selectThread` is reading itself.
   *
   * Opening a conversation the sidebar does not list -- a push deep link, a
   * search hit -- reads it from there, because only that path can name the
   * agent, merge the row into the listing and follow a redirect to the
   * canonical id. The selection effect would otherwise read the very same
   * conversation a second time on every deep link.
   */
  const selectionReadRef = useRef<string | null>(null);

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

  // SET on every mount, not just cleared on teardown: StrictMode runs this
  // setup, its cleanup, and this setup again, and the ref survives all three.
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    selectedThreadRef.current = selectedThreadId;
  }, [selectedThreadId]);

  useEffect(() => {
    selectedAgentRef.current = selectedAgentId;
  }, [selectedAgentId]);

  useEffect(() => {
    skillRegistryStateRef.current = skillRegistryState;
  }, [skillRegistryState]);

  useEffect(() => {
    showArchivedRef.current = showArchived;
  }, [showArchived]);

  /**
   * The ONE writer of the connection state.
   *
   * Keeps {@link connectionRef} exactly in step with it, because the DOM
   * handlers that decide what a resume owes run between commits.
   */
  const applyConnection = useCallback((next: ConnectionState) => {
    streamLiveRef.current = next === "live";
    // "live" is a claim about the CONSOLE, not about the socket: it is what
    // enables the composer, the run controls and the model picker. A tab that
    // opened on what this device kept and whose snapshot has not landed is
    // showing a listing no server stands behind, and a stream that connects
    // anyway is not evidence about that listing -- so it may not promote it.
    const gated: ConnectionState = next === "live" && !hasServerSnapshotRef.current
      ? "reconnecting"
      : next;
    connectionRef.current = gated;
    setConnectionState(gated);
  }, []);

  /**
   * Write what this tab holds to the device, at most once every
   * {@link PERSIST_DEBOUNCE_MS}.
   *
   * Armed by the cache's own commit hook and by the effect that watches the
   * listing, so nothing here runs during a render. The flush is a full
   * statement of what is held -- every conversation, the active listing, the
   * snapshot -- which is what makes an eviction, a removal and a tombstone all
   * reach the device without any of them having to say so; the module writes
   * only the transcripts whose objects actually moved.
   */
  const schedulePersist = useCallback(() => {
    // An empty flush before hydration has read would delete the very rows the
    // cold start is about to draw. A torn-down console has nothing to say
    // either.
    if (!persistReadyRef.current || !mountedRef.current) return;
    if (persistTimerRef.current !== null) return;
    persistTimerRef.current = window.setTimeout(() => {
      persistTimerRef.current = null;
      const persistence = persistenceRef.current;
      if (persistence === null) return;
      const bucket = persistedBucketRef.current;
      void persistence.save({
        entries: threadCacheRef.current.snapshot(),
        ...(persistedSnapshotRef.current === undefined
          ? {}
          : { snapshot: persistedSnapshotRef.current }),
        // ONLY a listing this bucket was actually filled with. `visibleThreads`
        // is filtered from whatever the projection holds, and an agent switch
        // moves the key one commit before the page that fills it lands -- so
        // for that window the pair is the NEW bucket's key and the OLD bucket's
        // rows, which is an empty listing written over a good one.
        ...(bucket === undefined || !seededBucketsRef.current.has(bucket.key)
          ? {}
          : { bucket }),
      });
    }, PERSIST_DEBOUNCE_MS);
  }, []);
  /** Disarm the pending flush. What it would have written is no longer wanted. */
  const cancelPersist = useCallback(() => {
    if (persistTimerRef.current === null) return;
    window.clearTimeout(persistTimerRef.current);
    persistTimerRef.current = null;
  }, []);
  // Assigned during render, like `scheduleRefreshRef`: the cache's commit hook
  // is created once, and an effect would leave it a commit behind.
  schedulePersistRef.current = schedulePersist;

  /**
   * Show what the cache holds for one conversation -- and nothing else.
   *
   * The ONE place `detail` is written. Every path that used to build a
   * transcript and hand it to `setDetail` now writes it to the cache and calls
   * this, so there is a single answer to "what is on screen": the projection of
   * the selected entry. A publish for a conversation that is no longer selected
   * is a no-op, which is what makes every late response inert without each of
   * them having to remember to check.
   *
   * The updater returns the CURRENT value when nothing in the entry moved, so
   * React bails out of the render rather than handing assistant-ui a new
   * container around arrays it has already converted.
   */
  const publishDetail = useCallback((threadId: string | null) => {
    if (threadId === null) {
      setDetail(null);
      return;
    }
    if (selectedThreadRef.current !== threadId) return;
    const entry = threadCacheRef.current.get(threadId);
    if (entry === undefined) {
      setDetail(null);
      return;
    }
    setDetail((current) => (current !== null
      && current.thread === entry.thread
      && current.messages === entry.messages
      && current.messagesNextCursor === entry.messagesNextCursor)
      ? current
      : projectDetail(entry));
  }, []);

  /**
   * Put what this device kept back on screen, before anything is asked for.
   *
   * The console used to open on an empty shell and a spinner: nothing could be
   * drawn until the snapshot answered, and nothing of the conversation until
   * its own read did. This draws the agents, the listing and the transcript the
   * operator was last in from the device, and marks every one of them suspect
   * -- so the reads that follow are the ordinary conditional ones, and a
   * console that has been away for ten seconds pays a status line rather than a
   * transcript.
   *
   * Everything restored is STALE by construction (see `ThreadCache.restore`).
   * Nothing here claims to be current; it claims to be worth drawing.
   */
  const hydrateFromDevice = useCallback((): Promise<void> => {
    const running = hydrationRef.current;
    if (running !== null) return running;
    const started = (async () => {
      const persistence = persistenceRef.current;
      const restored: HydratedConsole | null = persistence === null
        ? null
        : await persistence.hydrate();
      // Whatever came back, the device store may now be written: a flush from
      // here on can only delete rows this tab genuinely stopped holding.
      persistReadyRef.current = true;
      if (restored === null) return;
      // TOO LATE: the SERVER has spoken. Everything below would put a
      // last-visit transcript over one the server just gave -- `restore`
      // replaces the entry it names, and it always lands stale. The device is
      // not a second opinion about live data; it is what there is before there
      // is any.
      //
      // Deliberately not "the boot has finished": that is also true when the
      // boot FAILED, and a console with no server and a slow device is exactly
      // the one that needs what this holds. Discarding it there left the
      // operator on the fatal screen with everything this browser had sitting
      // unread on the device.
      if (hasServerSnapshotRef.current) return;
      hydratedHostRef.current = restored.host;
      const cache = threadCacheRef.current;
      for (const stored of restored.threads) {
        cache.restore({
          thread: stored.thread,
          messages: stored.messages,
          ...(stored.messagesNextCursor === undefined
            ? {}
            : { messagesNextCursor: stored.messagesNextCursor }),
          ...(stored.etag === undefined ? {} : { etag: stored.etag }),
          repairedToolCallIds: new Set(stored.repairedToolCallIds),
          pagedInIds: new Set(stored.pagedInIds),
        });
      }
      // These entries ARE the stored rows, so the first flush has nothing to
      // write for them: without this every cold start rewrote all eight
      // transcripts a second after restoring them.
      persistence?.markPersisted(cache.snapshot());
      const agentId = selectedAgentRef.current;
      const bucket = agentId === null
        ? undefined
        : restored.buckets.find(
            (candidate) => candidate.key === threadBucketKey(agentId, showArchivedRef.current),
          );
      const snapshot = restored.snapshot;
      if (snapshot !== null) {
        setBootstrap({
          version: API_VERSION,
          console: snapshot.console,
          push: snapshot.push,
          agents: snapshot.agents,
          // One bucket, exactly as a real snapshot carries one. Deliberately
          // NOT recorded in `seededBucketsRef`: this listing is as old as the
          // last visit, and the mount snapshot is what delivers the bucket.
          threads: bucket?.threads ?? [],
          threadsSourceId: agentId,
          threadsNextCursor: bucket?.nextCursor ?? null,
          limits: snapshot.limits,
        });
        // Honest about what this is: content on screen that no live connection
        // stands behind yet. The stream's first `ready` clears it.
        applyConnection("reconnecting");
      }
      // A cron URL is the operator's own instruction about what to open, and
      // the cron effect resolves it once the overview lands.
      if (selectedThreadRef.current !== null || cronRouteSelection() !== undefined) return;
      const storedThreadId = agentId === null ? undefined : readPersistedThreadIds()[agentId];
      if (storedThreadId === undefined || cache.get(storedThreadId) === undefined) return;
      // The same rule a snapshot applies: a selection the listing carries has
      // been confirmed by something, and one it does not is opened on trust --
      // which only a whole answer can settle. See `restoredSelectionRef`.
      const listed = (bucket?.threads ?? []).some(
        (candidate) => candidate.id === storedThreadId && candidate.archivedAt === null,
      );
      restoredSelectionRef.current = listed ? null : storedThreadId;
      selectedThreadRef.current = storedThreadId;
      cache.setSelected(storedThreadId);
      setSelectedThreadId(storedThreadId);
      // In the SAME batch as the selection, so no commit ever draws the shell
      // with a header and no transcript under it.
      publishDetail(storedThreadId);
    })();
    hydrationRef.current = started;
    return started;
  }, [applyConnection, publishDetail]);

  /**
   * The console answering is not the console that wrote what was restored.
   *
   * Same origin, different machine behind it -- a laptop reached at the same
   * name as the one before, a service moved. None of the restored
   * conversations, and none of the restored listing, belongs to this console,
   * so all of it goes: from memory, from the device, and from the selection.
   * Checked exactly once, against the first snapshot to answer.
   */
  const discardOtherHostData = useCallback((hostName: string) => {
    const wrote = hydratedHostRef.current;
    if (wrote === null) return;
    hydratedHostRef.current = null;
    if (wrote === hostName) return;
    // Before anything else: an armed flush still describes the other console's
    // conversations, and letting it fire would write them straight back.
    cancelPersist();
    threadCacheRef.current.clear();
    selectedThreadRef.current = null;
    setDetail(null);
    // A read for the other console's copy may already be on the wire, and it
    // cannot fill what this just emptied: the snapshot is about to re-resolve
    // the selection to the SAME id, so the effect that would re-read never
    // re-runs. One debounced detail refresh is what puts this console's
    // transcript on screen -- and it quotes nothing, because there is nothing
    // left to quote.
    scheduleRefreshRef.current({ detail: true });
    // Fired rather than awaited, because the caller is `applyBootstrap` and it
    // is synchronous -- and it is safe to: the armed flush is cancelled above,
    // this clear's transaction is created before any later one, and `clearAll`
    // forgets what it believed was stored BEFORE it deletes, so a flush that
    // starts meanwhile writes its rows fresh rather than skipping them.
    void persistenceRef.current?.clearAll();
  }, [cancelPersist]);

  const applyBootstrap = useCallback((rawNext: Bootstrap, issuedAt: number, archived: boolean) => {
    // BEFORE anything is read off the current selection: what a different
    // console left behind is not a selection to keep.
    discardOtherHostData(rawNext.console.hostName);
    const previouslySelected = selectedThreadRef.current;
    // A bootstrap is a wholesale replacement, so a deleted conversation it
    // still lists is re-added, selected, and routed to. It is also the single
    // most likely response to be in flight across a delete: `refreshNow` issues
    // one on every SSE event, including the one the delete itself produced.
    const next: Bootstrap = {
      ...rawNext,
      threads: admitThreads(removedThreadsRef.current, rawNext.threads, issuedAt),
    };
    // REPLACED, not added to. A bootstrap answers with one bucket and the
    // projection it lands in is a wholesale replacement, so every other bucket
    // is gone from the sidebar -- and an "already seeded" entry left behind for
    // one of them would leave that agent's sidebar empty with nothing to
    // refill it. Recorded before the state lands, because the effect that would
    // re-request this bucket runs on the commit this schedules.
    const seeded = next.threadsSourceId === null
      ? undefined
      : threadBucketKey(next.threadsSourceId, archived);
    seededBucketsRef.current = new Set(seeded === undefined ? [] : [seeded]);
    // The page came with its own cursor, so "load more" works on a
    // bootstrap-seeded bucket without a page request to learn one.
    if (seeded !== undefined) {
      setThreadCursorByBucket((current) => ({ ...current, [seeded]: next.threadsNextCursor }));
    }
    setBootstrap(next);
    hasBootstrapRef.current = true;
    // The listing on screen is the SERVER's from here on, whatever the device
    // seeded before it.
    hasServerSnapshotRef.current = true;
    setHasServerSnapshot(true);
    setError(null);
    setLoading(false);
    // The gate just opened. A stream that came up while the snapshot was in
    // flight -- or while it was failing -- already reported itself live and
    // will not say so again until the next event, which on a quiet fleet can
    // be hours away.
    if (streamLiveRef.current) applyConnection("live");
    // A conversation this tab has TOMBSTONED is not a selection to keep,
    // however this answer describes it: the operator asked for it to go, and
    // the automatic re-resolution to a survivor is what a failed delete then
    // owes them back. Anything else the answer merely did not list is kept.
    const live = (threadId: string | null): string | null =>
      threadId !== null && !removedThreadsRef.current.has(threadId) ? threadId : null;
    const baseSelection = resolveBootstrapSelection(
      next,
      selectedAgentRef.current,
      live(selectedThreadRef.current),
      Object.fromEntries(
        Object.entries(readPersistedThreadIds()).filter(([, threadId]) => live(threadId) !== null),
      ),
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
    // Only a selection this answer CHANGED can be a restore, and only when the
    // answer does not carry it. A bootstrap re-apply is routine -- one lands on
    // every `agents.changed` -- and a conversation the operator opened from
    // search or a push link is by definition absent from the active bucket, so
    // re-arming for a selection that did not move ejected them out of it the
    // moment their own read answered. A KEPT selection has already issued its
    // read; whatever that read settles, it settles.
    if (selection.threadId !== previouslySelected) {
      restoredSelectionRef.current = selection.threadId !== null
        && !next.threads.some((thread) => thread.id === selection.threadId)
        ? selection.threadId
        : null;
    }
    selectedAgentRef.current = selection.agentId;
    selectedThreadRef.current = selection.threadId;
    setSelectedAgentId(selection.agentId);
    setSelectedThreadId(selection.threadId);
    if (selection.agentId) {
      localStorage.setItem(SELECTED_AGENT_STORAGE_KEY, selection.agentId);
      const selected = next.threads.find((thread) => thread.id === selection.threadId);
      // Only what the answer ACTUALLY carries is evidence about the stored
      // selection. One bucket page is not the whole bucket, so clearing it for
      // a conversation this answer merely did not list would throw away the
      // operator's place in a conversation that is still there.
      if (selection.threadId === null) persistThreadId(selection.agentId, null);
      else if (selected !== undefined) {
        persistThreadId(selection.agentId, selected.archivedAt ? null : selected.id);
      }
    }
  }, [applyConnection, discardOtherHostData]);

  /**
   * The bucket a bootstrap should carry: the one this tab is showing.
   *
   * A bootstrap used to answer with every agent's conversations and the sidebar
   * re-read the single bucket it shows anyway. An agent this tab has not
   * resolved yet names none, and the server falls back the same way this store
   * does.
   */
  const bootstrapScope = useCallback((): BootstrapScope => ({
    ...(selectedAgentRef.current === null ? {} : { sourceId: selectedAgentRef.current }),
    archived: showArchivedRef.current,
    limit: threadPageLimit(),
  }), []);

  const loadBootstrap = useCallback(async () => {
    try {
      // BEFORE the first request goes out -- but never for longer than
      // {@link HYDRATION_DEADLINE_MS}, and never twice. What this device kept is
      // on screen while this read is on the wire, and the entries it restored
      // are what make the conversation read that follows a conditional one; an
      // `indexedDB.open` that never answers must not be able to hold the whole
      // console at a spinner, and `retry()` must not pay that wait again for a
      // device that has already failed to answer once.
      if (!hydrationDeadlineSpentRef.current) {
        hydrationDeadlineSpentRef.current =
          await withHydrationDeadline(hydrateFromDevice()) === "deadline";
      }
      // Bounded like every other read. See `THREAD_READ_TIMEOUT_MS`: the
      // tombstone's lifetime is only an upper bound on late responses while
      // the responses themselves have one.
      const issuedAt = removedThreadsRef.current.epoch();
      const scope = bootstrapScope();
      const next = await boundedRequest((signal) => api.bootstrap(signal, scope), THREAD_READ_TIMEOUT_MS);
      applyBootstrap(next, issuedAt, scope.archived === true);
      applyConnection("live");
    } catch (loadError) {
      setError(errorMessage(loadError));
      setLoading(false);
      applyConnection(navigator.onLine ? "reconnecting" : "offline");
    } finally {
      initialBootstrapRef.current = "answered";
    }
  }, [applyBootstrap, applyConnection, bootstrapScope, hydrateFromDevice]);

  useEffect(() => {
    void loadBootstrap();
  }, [loadBootstrap]);

  useEffect(() => {
    const onPopState = () => setRouteRevision((value) => value + 1);
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  /**
   * One page of one (agent, archived) bucket, and the rows it surfaced.
   *
   * `mode` decides what happens to the rows the page does NOT carry.
   *
   * - `"replace"` is the authoritative fill: the bucket becomes exactly this
   *   page, so a conversation the server no longer lists disappears with it,
   *   and the page's cursor becomes the bucket's.
   * - `"merge"` is a REVALIDATION. It refreshes the rows it returns and keeps
   *   every other row, because it is answering an event that named a
   *   conversation this tab does not hold -- and replacing would cut a
   *   bootstrap-seeded window down to one page to do it. It keeps an existing
   *   cursor too: its page starts at the top of the bucket, so its own cursor
   *   would walk rows it has just refreshed rather than the older ones the
   *   bucket is already pointing at. It DOES adopt one when the bucket has no
   *   cursor to page FROM -- absent, or `null` for "nothing older, as of the
   *   answer that said so" -- which is how a bucket whose window has since
   *   grown past one page learns that there is anything older to reach at all.
   */
  const loadThreadBucket = useCallback(async (
    sourceId: string,
    archived: boolean,
    before?: string,
    mode: "replace" | "merge" = "replace",
  ): Promise<readonly ThreadSummary[]> => {
    const issuedAt = removedThreadsRef.current.epoch();
    const page = await boundedRequest(
      (signal) => api.threads(sourceId, archived, before, signal, threadPageLimit()),
      THREAD_READ_TIMEOUT_MS,
    );
    const key = threadBucketKey(sourceId, archived);
    const admitted = admitThreads(removedThreadsRef.current, page.threads, issuedAt);
    // The authoritative fill DELIVERS this bucket, exactly as a bootstrap does,
    // so the sidebar effect must not buy it again -- an agent switch back and
    // forth, or an archive toggle, otherwise re-read the same page every time.
    // A revalidation does not count (it merges into rows already held) and
    // neither does a page walk (it carries the older window, not the bucket).
    // `applyBootstrap` REPLACES this set, so a new snapshot re-arms every other
    // bucket for the read that fills it.
    if (before === undefined && mode === "replace") seededBucketsRef.current.add(key);
    setBootstrap((current) => {
      if (current === null) return current;
      const retained = before === undefined && mode === "replace"
        ? current.threads.filter((thread) =>
            thread.sourceId !== sourceId || Boolean(thread.archivedAt) !== archived)
        : current.threads;
      return { ...current, threads: mergeThreads(retained, admitted) };
    });
    setThreadCursorByBucket((current) => mode === "merge" && typeof current[key] === "string"
      ? current
      : { ...current, [key]: page.nextCursor ?? null });
    return admitted;
  }, []);

  const hasBootstrap = bootstrap !== null;
  useEffect(() => {
    // `loading` is still true until the first bootstrap has been applied or has
    // failed; fetching before then races the answer that seeds this bucket.
    //
    // A bootstrap that FAILED no longer leaves nothing behind -- the device may
    // have seeded a projection, and `hasBootstrap` is then true -- so the guard
    // that used to be implicit is explicit: a page request into the server that
    // just refused the snapshot is one more failure to show for nothing. The
    // operator's retry, or the next successful refresh, is what fills the
    // sidebar.
    if (selectedAgentId === null || loading || !hasBootstrap || error !== null) return;
    // Already delivered by a bootstrap -- see `seededBucketsRef`.
    if (seededBucketsRef.current.has(threadBucketKey(selectedAgentId, showArchived))) return;
    void loadThreadBucket(selectedAgentId, showArchived).then((page) => {
      // A bootstrap carries ONE bucket, so switching agents lands on rows this
      // tab has never held: `selectAgent` resolves the conversation to open
      // from what it holds and finds nothing, and this page is the first thing
      // there is to resolve from. Only when nothing is selected -- an operator
      // choice, a deep link and a restored selection all make this false, and
      // none of them is this effect's to overrule -- and never on the archive
      // shelf, which has never moved the selection.
      if (showArchived
        || selectedAgentRef.current !== selectedAgentId
        || selectedThreadRef.current !== null) return;
      const persistedId = readPersistedThreadIds()[selectedAgentId];
      const next = page.find((item) => item.id === persistedId && !item.archivedAt)
        ?? [...page].filter((item) => !item.archivedAt).sort(byMostRecent)[0];
      if (next === undefined) return;
      restoredSelectionRef.current = null;
      selectedThreadRef.current = next.id;
      setSelectedThreadId(next.id);
      persistThreadId(selectedAgentId, next.id);
      updateThreadRoute(next);
    }).catch((loadError: unknown) => {
      setActionError(errorMessage(loadError));
    });
  }, [error, hasBootstrap, loadThreadBucket, loading, selectedAgentId, showArchived]);

  /**
   * The conversation on screen is gone: a read of it was answered "not found".
   *
   * The same repair the `thread.changed` removal arm makes for a conversation
   * this tab holds no row for -- clear the selection, say so, and drop the
   * stored id, which is what otherwise resolves the dead conversation again on
   * every single load.
   */
  const closeMissingThread = useCallback((threadId: string) => {
    selectedThreadRef.current = null;
    setSelectedThreadId(null);
    threadCacheRef.current.evict(threadId);
    setDetail(null);
    const sourceId = selectedAgentRef.current;
    if (sourceId !== null && readPersistedThreadIds()[sourceId] === threadId) {
      persistThreadId(sourceId, null);
    }
    setActionError("This conversation was deleted.");
  }, []);

  /**
   * A restored conversation the server says is archived, while this tab is
   * showing the active view.
   *
   * Archiving one HERE moves the selection to the next active row and repoints
   * the stored id -- see `archiveThread` -- so one found archived is treated
   * the same way rather than opened where the sidebar cannot list it and the
   * archive toggle says nothing about it.
   */
  const leaveRestoredArchivedThread = useCallback((thread: ThreadSummary): boolean => {
    // Only while this is still the conversation on screen. A read of a restored
    // selection can answer long after the operator has created, archived,
    // unarchived or simply opened something else, and a repair applied blind
    // then moves them off what they are actually looking at.
    if (selectedThreadRef.current !== thread.id) return false;
    // Never the conversation being left, however stale the row holding it says
    // it is -- the same exclusion `archiveThread` makes.
    const replacement = [...threadsRef.current]
      .filter((item) => item.sourceId === thread.sourceId && !item.archivedAt && item.id !== thread.id)
      .sort(byMostRecent)[0];
    selectedThreadRef.current = replacement?.id ?? null;
    setSelectedThreadId(replacement?.id ?? null);
    publishDetail(replacement?.id ?? null);
    persistThreadId(thread.sourceId, replacement?.id ?? null);
    updateThreadRoute(replacement, true);
    return true;
  }, [publishDetail]);

  /**
   * Apply a 304 to the conversation it was asked about.
   *
   * Nothing is replaced -- every message comes back by reference -- and only
   * the suspicion is answered, and only when nothing was observed while the
   * read was on the wire. When something WAS, `confirmFresh` refuses and this
   * buys exactly one more read: the 304 described a state the console already
   * knows it has moved past, and nothing else is going to answer for it.
   */
  const confirmConversation = useCallback((threadId: string, issuedAt: number) => {
    const cache = threadCacheRef.current;
    cache.confirmFresh(threadId, issuedAt);
    if (cache.get(threadId)?.stale === true && selectedThreadRef.current === threadId) {
      scheduleRefreshRef.current({ detail: true });
    }
  }, []);

  /**
   * Read one conversation in full and put it into the cache.
   *
   * `cold` is whether the operator is looking at an empty pane while this runs.
   * A conversation the cache already holds is on screen from the moment it is
   * selected, and a revalidation behind it is not something to show a spinner
   * for -- that spinner replaced a transcript the tab already had.
   */
  const loadThread = useCallback(async (
    threadId: string,
    signal: AbortSignal,
    cold: boolean,
  ) => {
    if (cold) setDetailLoading(true);
    try {
      const issuedAt = removedThreadsRef.current.epoch();
      // The cache's own clock, quoted the same way: anything observed while
      // this read is on the wire is something it cannot have seen.
      const observedAt = threadCacheRef.current.clock();
      // CONDITIONAL when this tab already holds a copy and a validator for it.
      // Reopening a conversation a gap made suspect is the ordinary case now --
      // a gap stales everything held -- and the server answers most of them
      // with a status line. A restored selection is read unconditionally on
      // purpose: this read is the only thing that can say the conversation was
      // deleted or archived elsewhere, and a 304 about a summary from this same
      // session is not that evidence.
      const held = cold || restoredSelectionRef.current === threadId
        ? undefined
        : threadCacheRef.current.get(threadId)?.etag;
      const next = await boundedRequest(
        (deadline) => readConversation(threadId, held, anySignal(signal, deadline)),
        THREAD_READ_TIMEOUT_MS,
      );
      if (next === NOT_MODIFIED) {
        // What is on screen IS the server's, and nothing is replaced.
        confirmConversation(threadId, observedAt);
        return;
      }
      // Admitted like any other projection, so a tombstone RECORDS it rather
      // than dropping it: a detail read is routinely the newest thing this tab
      // has seen about a conversation, and a failed delete has to hand that
      // back rather than a staler listing.
      if (!admitThread(removedThreadsRef.current, next.thread, issuedAt)) return;
      // This read is what confirms a RESTORED selection -- nothing else does.
      if (restoredSelectionRef.current === threadId) {
        restoredSelectionRef.current = null;
        if (next.thread.archivedAt !== null
          && !showArchivedRef.current
          && leaveRestoredArchivedThread(next.thread)) return;
      }
      // A WINDOW read: it carries the newest page of the transcript, so the
      // pages this tab walked back to survive it and anything inside the window
      // it no longer carries was deleted. See `mergeMessages`.
      const entry = threadCacheRef.current.upsertFull(next, {
        reset: true,
        issuedAt: observedAt,
        // The validator this response was served with, so a reconnect can quote
        // it and be answered with a status line instead of a transcript.
        ...(next.etag === undefined ? {} : { etag: next.etag }),
      });
      publishDetail(threadId);
      // Something moved while this read was out -- a delta that arrived before
      // there was anything to apply it to, above all. The answer is already
      // behind, so it costs exactly one more read rather than leaving a
      // transcript on screen that looks settled and is not.
      // Through the ref, not the callback: this runs before `scheduleRefresh`
      // is defined, and it is async so the ref is always assigned by then.
      if (entry?.stale === true && selectedThreadRef.current === threadId) {
        scheduleRefreshRef.current({ detail: true });
      }
    } catch (loadError) {
      if (signal.aborted) return;
      if (loadError instanceof ApiError
        && loadError.status === 404
        && selectedThreadRef.current === threadId) {
        restoredSelectionRef.current = null;
        closeMissingThread(threadId);
        return;
      }
      setActionError(errorMessage(loadError));
    } finally {
      if (selectedThreadRef.current === threadId) setDetailLoading(false);
    }
  }, [closeMissingThread, confirmConversation, leaveRestoredArchivedThread, publishDetail]);

  useEffect(() => {
    const cache = threadCacheRef.current;
    cache.setSelected(selectedThreadId);
    if (!selectedThreadId) {
      setDetail(null);
      setDetailLoading(false);
      return;
    }
    const entry = cache.get(selectedThreadId);
    if (entry !== undefined) {
      // Already held: the transcript is on screen this render, with no request
      // and no empty pane. Leaving a conversation and coming back is what the
      // cache is for, and it is what used to cost a full read every time.
      publishDetail(selectedThreadId);
      setDetailLoading(false);
    } else {
      setDetail(null);
    }
    // A RESTORED selection is one the operator did not make and one bucket page
    // could not confirm -- see `restoredSelectionRef` -- and the read is the
    // only thing that can say the conversation was deleted or archived
    // elsewhere. A cached copy of it is not that evidence.
    if (entry !== undefined
      && !entry.stale
      && restoredSelectionRef.current !== selectedThreadId) return;
    // `selectThread` opened a conversation the sidebar does not list and is
    // reading it itself -- see `selectionReadRef`. Only that read can name the
    // agent, merge the row into the listing and follow a redirect, so this one
    // would be the second copy of the same transcript.
    if (selectionReadRef.current === selectedThreadId) return;
    const controller = new AbortController();
    void loadThread(selectedThreadId, controller.signal, entry === undefined);
    return () => controller.abort();
  }, [loadThread, publishDetail, selectedThreadId]);

  /**
   * One refresh, fetching exactly what the events behind it invalidated.
   *
   * The scope is claimed and cleared before the first `await`, so an event that
   * arrives while this runs accumulates a NEW scope rather than being answered
   * by a request that went out before it.
   */
  const refreshNow = useCallback(async () => {
    if (refreshInFlightRef.current) {
      refreshQueuedRef.current = true;
      return;
    }
    const scope = refreshScopeRef.current;
    if (!scope.bootstrap && !scope.detail) return;
    refreshScopeRef.current = NOTHING_TO_REFRESH;
    refreshInFlightRef.current = true;
    try {
      const issuedAt = removedThreadsRef.current.epoch();
      const observedAt = threadCacheRef.current.clock();
      const selectedForRefresh = scope.detail ? selectedThreadRef.current : null;
      const bucket = bootstrapScope();
      // CONDITIONAL, exactly as `loadThread` and the gap resync are: this is
      // the path a beaten 304 schedules its follow-up on, and an ordinary
      // switch to a conversation kept across a gap reaches it, so an
      // unconditional read here put a whole transcript back on the wire for a
      // conversation that had usually not moved at all.
      const heldEtag = selectedForRefresh === null
        ? undefined
        : threadCacheRef.current.get(selectedForRefresh)?.etag;
      const [nextBootstrap, nextDetail] = await Promise.all([
        scope.bootstrap
          ? boundedRequest((signal) => api.bootstrap(signal, bucket), THREAD_READ_TIMEOUT_MS)
          : Promise.resolve(null),
        selectedForRefresh
          ? boundedRequest(
              (signal) => readConversation(selectedForRefresh, heldEtag, signal),
              THREAD_READ_TIMEOUT_MS,
            )
          : Promise.resolve(null),
      ]);
      if (nextBootstrap !== null) applyBootstrap(nextBootstrap, issuedAt, bucket.archived === true);
      if (nextDetail === NOT_MODIFIED) {
        if (selectedForRefresh !== null) confirmConversation(selectedForRefresh, observedAt);
      } else if (
        nextDetail
        && admitThread(removedThreadsRef.current, nextDetail.thread, issuedAt)
        && selectedThreadRef.current === nextDetail.thread.id
      // Deliberately only the detail. The detail answer carries a summary of
      // the same row the listing carries, and the two reads are not ordered
      // against each other: merging it let a detail response overwrite a
      // FRESHER listing row it had no way to compare itself to. The sidebar row
      // is the listing's business, and `threads.changed` carries a new summary
      // when the server has one.
      ) {
        const entry = threadCacheRef.current.upsertFull(
          nextDetail,
          {
            reset: true,
            issuedAt: observedAt,
            ...(nextDetail.etag === undefined ? {} : { etag: nextDetail.etag }),
          },
        );
        publishDetail(nextDetail.thread.id);
        // See `loadThread`: an answer overtaken by an observation is already
        // behind, and one more read is what settles it.
        if (entry?.stale === true) scheduleRefreshRef.current({ detail: true });
      }
    } catch (refreshError) {
      setActionError(errorMessage(refreshError));
    } finally {
      refreshInFlightRef.current = false;
      if (refreshQueuedRef.current) {
        refreshQueuedRef.current = false;
        scheduleRefreshRef.current({});
      }
    }
  }, [applyBootstrap, bootstrapScope, confirmConversation, publishDetail]);

  const scheduleRefresh = useCallback((scope: Partial<RefreshScope>) => {
    // A refresh that settles after the tree is gone re-queues through the
    // scope above, and a torn-down console has no business putting another
    // request on the wire. The stream effect's cleanup clears the timer that is
    // pending AT teardown; this is the one that would be armed after it.
    if (!mountedRef.current) return;
    refreshScopeRef.current = {
      bootstrap: refreshScopeRef.current.bootstrap || scope.bootstrap === true,
      detail: refreshScopeRef.current.detail || scope.detail === true,
    };
    if (refreshInFlightRef.current) {
      refreshQueuedRef.current = true;
      return;
    }
    if (refreshTimerRef.current !== null) return;
    refreshTimerRef.current = window.setTimeout(() => {
      refreshTimerRef.current = null;
      void refreshNow();
    }, currentDataMode() === "lean" ? LEAN_REFRESH_DEBOUNCE_MS : REFRESH_DEBOUNCE_MS);
  }, [refreshNow]);
  // Assigned during render: `refreshNow` re-queues through this ref, and an
  // effect would leave it pointing at the previous commit's closure.
  scheduleRefreshRef.current = scheduleRefresh;

  /**
   * Everything this tab knows is stale: the listing, the selection it resolves
   * to, and the open conversation. Reserved for the cases where the console
   * genuinely cannot say what changed -- a reconnect, coming back online, a
   * delete whose outcome could not be established.
   */
  const queueRefresh = useCallback(
    () => {
      // The refresh re-reads the OPEN conversation. Every other one this tab is
      // keeping missed the same window and has nothing to say it is current, so
      // opening one has to pay for a read rather than show what it held.
      threadCacheRef.current.markAllStale();
      scheduleRefresh({ bootstrap: true, detail: true });
    },
    [scheduleRefresh],
  );

  /** Only the open conversation's messages. */
  const refreshSelectedThread = useCallback(
    () => { scheduleRefresh({ detail: true }); },
    [scheduleRefresh],
  );

  /** Only the agent list and the listing that comes with it. */
  const loadAgents = useCallback(
    () => { scheduleRefresh({ bootstrap: true }); },
    [scheduleRefresh],
  );

  const rememberUnlistedThread = useCallback((key: string) => {
    const remembered = unlistedThreadsRef.current;
    // Re-inserted so a repeat sighting counts as recent. Insertion order is
    // chronological, so the oldest entry is always the first one out.
    remembered.delete(key);
    remembered.add(key);
    while (remembered.size > UNLISTED_THREAD_MEMORY) {
      const oldest = remembered.values().next().value;
      if (oldest === undefined) break;
      remembered.delete(oldest);
    }
  }, []);

  /**
   * Re-read the selected bucket for the events that carry no summary and name
   * a conversation this tab does not hold. Its own, slower debounce -- see
   * {@link THREAD_LIST_REVALIDATE_DEBOUNCE_MS} -- and a MERGE, so answering
   * one cannot truncate the sidebar the operator is looking at.
   *
   * `threadId` is what the revalidation is being asked about. Anything the page
   * does not surface is not in THAT BUCKET -- most often because it belongs to
   * another agent, which these events do not name -- and is remembered against
   * the bucket that answered, so the next event about it costs nothing there
   * and still costs a page everywhere else. See {@link UNLISTED_THREAD_MEMORY}
   * and {@link unlistedThreadKey}.
   */
  const revalidateBucket = useCallback((threadId?: string) => {
    if (threadId !== undefined) pendingRevalidationRef.current.add(threadId);
    if (threadListTimerRef.current !== null) return;
    threadListTimerRef.current = window.setTimeout(() => {
      threadListTimerRef.current = null;
      const sourceId = selectedAgentRef.current;
      const archived = showArchivedRef.current;
      const asked = [...pendingRevalidationRef.current];
      pendingRevalidationRef.current.clear();
      if (sourceId === null) return;
      void loadThreadBucket(sourceId, archived, undefined, "merge")
        .then((surfaced) => {
          const listed = new Set(surfaced.map((thread) => thread.id));
          for (const id of asked) {
            if (!listed.has(id)) rememberUnlistedThread(unlistedThreadKey(sourceId, archived, id));
          }
        })
        .catch((loadError: unknown) => {
          setActionError(errorMessage(loadError));
        });
    }, THREAD_LIST_REVALIDATE_DEBOUNCE_MS);
  }, [loadThreadBucket, rememberUnlistedThread]);

  /**
   * Re-read the open conversation CONDITIONALLY, quoting what it was last
   * served with.
   *
   * The answer to a gap in the stream. `304` is the server saying the
   * transcript on screen IS the current one: nothing is replaced, no message
   * object loses its identity, and the read costs a status line rather than the
   * whole conversation -- which is what makes an app-switch resume free. A
   * conversation with no validator yet (nothing has read it since this tab
   * loaded) falls back to the ordinary read, and stores one for next time.
   */
  const revalidateSelectedThread = useCallback(async (
    threadId: string,
    etag: string | undefined,
  ) => {
    const cache = threadCacheRef.current;
    const issuedAt = removedThreadsRef.current.epoch();
    const observedAt = cache.clock();
    try {
      const answer = await boundedRequest(
        (signal) => readConversation(threadId, etag, signal),
        THREAD_READ_TIMEOUT_MS,
      );
      if (answer === NOT_MODIFIED) {
        confirmConversation(threadId, observedAt);
        return;
      }
      if (!admitThread(removedThreadsRef.current, answer.thread, issuedAt)) return;
      if (selectedThreadRef.current !== answer.thread.id) return;
      const entry = cache.upsertFull(answer, {
        reset: true,
        issuedAt: observedAt,
        ...(answer.etag === undefined ? {} : { etag: answer.etag }),
      });
      publishDetail(answer.thread.id);
      if (entry?.stale === true) scheduleRefreshRef.current({ detail: true });
    } catch (resyncError) {
      if (resyncError instanceof ApiError
        && resyncError.status === 404
        && selectedThreadRef.current === threadId) {
        restoredSelectionRef.current = null;
        closeMissingThread(threadId);
        return;
      }
      // The resync could not answer, so what is held cannot claim to be
      // current: the ordinary refresh is the fallback, and it is debounced.
      cache.markStale(threadId);
      if (selectedThreadRef.current === threadId) refreshSelectedThread();
    }
  }, [closeMissingThread, confirmConversation, publishDetail, refreshSelectedThread]);

  /**
   * A `ready` with a gap behind it.
   *
   * The events that would have told this tab what changed are exactly the ones
   * the gap lost, so NOTHING it is keeping can say it is current -- and there
   * is no cheaper evidence available. A listing summary cannot stand in for it:
   * `writeMessageParts` moves a transcript without touching the conversation
   * row at all (a Monitor wake, every mid-turn flush), so a page that reports
   * an unchanged summary is silent about writes the console actually missed.
   *
   * So: everything held is suspect, and each conversation pays when it is
   * OPENED -- one conditional GET, which is a 304 whenever nothing moved. The
   * open one is revalidated now, the sidebar is refreshed with one merge page,
   * and the snapshot is bought only when there is none. That is still far short
   * of the full bootstrap AND full conversation read a reconnect used to cost.
   */
  const resyncAfterGap = useCallback(() => {
    // The mount load failed or was never made, so there is no projection for
    // anything else here to refine.
    if (!hasBootstrapRef.current) {
      loadAgents();
      return;
    }
    // Before the reads below, so their own `clock()` is quoted afterwards and a
    // 304 can clear the suspicion this just raised.
    threadCacheRef.current.markAllStale();
    if (staleBucketRef.current) {
      staleBucketRef.current = false;
      revalidateBucket();
    }
    const threadId = selectedThreadRef.current;
    if (threadId === null) return;
    const entry = threadCacheRef.current.get(threadId);
    if (entry === undefined) {
      // Not held, so there is nothing to re-read and nowhere to land an answer.
      // The observation is what makes the cold read already on the wire -- the
      // selection effect's -- land stale and go round once more, instead of
      // settling on a transcript from before the gap.
      threadCacheRef.current.markStale(threadId);
      return;
    }
    void revalidateSelectedThread(threadId, entry.etag);
  }, [loadAgents, revalidateBucket, revalidateSelectedThread]);

  /**
   * Apply the run state a `turn.changed` already carries.
   *
   * Patches rows that are already listed and the open conversation; it never
   * inserts, so a tombstoned conversation cannot come back through it.
   */
  const patchRunState = useCallback((threadId: string, runState: RunState) => {
    setBootstrap((current) => current === null
      || !current.threads.some((item) => item.id === threadId)
      ? current
      : {
          ...current,
          threads: current.threads.map((item) =>
            item.id === threadId ? { ...item, runState } : item),
        });
    // On the CACHED entry, not just the one on screen: a conversation the
    // operator switched away from keeps the run state its event carried, so
    // coming back to it shows what is running there without a read.
    if (threadCacheRef.current.patchRunState(threadId, runState)) publishDetail(threadId);
  }, [publishDetail]);

  /**
   * Re-read ONE message, because the console cannot say what it now holds.
   *
   * The answer to every gap: a delta whose base is not the version held, a
   * `message.changed` naming a message this tab already has, a replay these
   * parts cannot mean. Four assistant-row write paths -- notification
   * reconciliation, cron-run reconciliation, the process-job card, Monitor
   * activity -- bump a message's version with NO delta and arrive as a hint, so
   * the mismatch is the ordinary, intended signal rather than an error.
   *
   * One read per (conversation, message) at a time. A turn rewrites its message
   * every ~50 ms, so a copy that has fallen behind sees a gap on every frame
   * until this answers; without the join, one missed write would buy a request
   * per frame for the rest of the turn.
   */
  const repairMessage = useCallback((
    threadId: string,
    messageId: string,
    /** The version the caller knows about, when it knows one. */
    wantedSeq?: number,
  ): Promise<void> => {
    const key = `${threadId}\u0000${messageId}`;
    const running = messageRepairsRef.current.get(key);
    if (running !== undefined) {
      // JOINED, but not swallowed. The read already on the wire was issued
      // before this version was known, so its answer may not carry it; record
      // what is now wanted and let the read that lands decide whether it has
      // to go again.
      if (wantedSeq === undefined) running.dirty = true;
      else running.wantedSeq = Math.max(running.wantedSeq, wantedSeq);
      return running.promise;
    }
    const pending: MessageRepair = {
      promise: Promise.resolve(),
      wantedSeq: wantedSeq ?? Number.NEGATIVE_INFINITY,
      dirty: wantedSeq === undefined,
    };
    pending.promise = (async () => {
      try {
        // Each round answers everything observed BEFORE it went out, so the
        // wants are cleared here and anything recorded during the read is what
        // sends it round again.
        for (;;) {
          pending.dirty = false;
          pending.wantedSeq = Number.NEGATIVE_INFINITY;
          const message = await boundedRequest(
            (signal) => api.message(threadId, messageId, signal),
            THREAD_READ_TIMEOUT_MS,
          );
          const cache = threadCacheRef.current;
          if (cache.get(threadId) === undefined) {
            // The conversation was evicted or removed while this was out, so
            // there is nowhere for the answer to land -- `upsertMessage` would
            // return false and the request would have been spent for nothing.
            //
            // The observation is recorded for the reads that CANNOT see it any
            // other way: one already on the wire for this conversation quotes a
            // clock from before it and so lands stale. It does nothing for a
            // read issued afterwards, which quotes a later clock and lands
            // fresh -- and needs to, because opening a conversation this tab no
            // longer holds is a cold read either way.
            cache.markStale(threadId);
            return;
          }
          if (cache.upsertMessage(threadId, message)) publishDetail(threadId);
          const landedSeq = message.seq ?? Number.NEGATIVE_INFINITY;
          if (!pending.dirty && pending.wantedSeq <= landedSeq) return;
        }
      } catch {
        // The message read failed, so this conversation's transcript is not
        // what this tab is showing -- and saying nothing would leave a stale
        // one on screen looking settled. The whole-conversation read is the
        // fallback, and it is the very thing the delta stream exists to avoid,
        // so it is reached only when the cheap repair could not answer.
        // Nothing is put in front of the operator. A message that has been
        // DELETED answers 404 here, which is not a fault, and a frame of a
        // running turn is not something they can act on either way -- the
        // conversation read above is what settles both.
        threadCacheRef.current.markStale(threadId);
        if (threadId === selectedThreadRef.current) refreshSelectedThread();
      } finally {
        if (messageRepairsRef.current.get(key) === pending) messageRepairsRef.current.delete(key);
      }
    })();
    messageRepairsRef.current.set(key, pending);
    return pending.promise;
  }, [publishDetail, refreshSelectedThread]);

  /**
   * Publishes what the batched deltas have already written into the cache.
   *
   * Idempotent and safe to call from either end -- the tick, or the write that
   * ends a turn -- so a finish can never be drawn behind a pending tick.
   */
  const flushDeltaPublishes = useCallback(() => {
    const pending = deltaPublishRef.current;
    if (pending.timer !== null) {
      window.clearTimeout(pending.timer);
      pending.timer = null;
    }
    if (pending.threads.size === 0) return;
    const threads = [...pending.threads];
    pending.threads.clear();
    for (const id of threads) publishDetail(id);
  }, [publishDetail]);

  /**
   * One persisted parts write, applied rather than asked about.
   *
   * The whole point of the delta stream: a streamed answer costs its own text
   * and nothing else. Anything this cannot apply for certain re-reads the ONE
   * message -- never the conversation, and never a guess.
   */
  const applyMessageDeltaEvent = useCallback((threadId: string, delta: MessageDelta) => {
    const cache = threadCacheRef.current;
    if (threadId !== selectedThreadRef.current) {
      // The stream only sends deltas for the conversation a connection names,
      // so this is a downgrade or a subscription that has not caught up. Either
      // way the transcript is not on screen: remember that it moved and read it
      // when the operator opens it.
      cache.markStale(threadId);
      return;
    }
    switch (cache.applyDelta(threadId, delta)) {
      case "applied": {
        // The cache is already written, in order. What is batched is only when
        // the operator's screen is redrawn -- and only for a turn still running,
        // because a turn that has FINISHED must read as finished at once.
        if (currentDataMode() !== "lean" || delta.status !== "running") {
          flushDeltaPublishes();
          publishDetail(threadId);
          return;
        }
        const pending = deltaPublishRef.current;
        pending.threads.add(threadId);
        pending.timer ??= window.setTimeout(() => {
          pending.timer = null;
          flushDeltaPublishes();
        }, LEAN_DELTA_BATCH_MS);
        return;
      }
      // Already at or past the version this produces: applying it again would
      // walk the transcript backwards, and reading for it would buy a request
      // for a write this tab already has.
      case "stale":
        return;
      case "unheld":
        // Nothing to apply it to and nowhere for a message read to LAND -- the
        // cold read of this conversation is on the wire, or is about to be.
        // Spending a request here bought an answer `upsertMessage` then dropped
        // on the floor; the observation is what makes that conversation read
        // land stale and read once more instead.
        cache.markStale(threadId);
        return;
      default:
        void repairMessage(threadId, delta.messageId, delta.seq);
    }
  }, [flushDeltaPublishes, publishDetail, repairMessage]);

  const applyThreadUpdate = useCallback((nextThread: ThreadSummary, issuedAt: number) => {
    // A response can outlive the conversation it describes: the migration's
    // read, an optimistic rollback, any write already in flight when the
    // operator deleted the thread. `mergeThreads` would re-add it, so the
    // sidebar showed a conversation the server had already destroyed.
    //
    // `issuedAt` is the admission epoch the producing request went out under.
    // A LOCAL decision -- an optimistic edit, a rollback, the repair a refused
    // delete owes -- is being made now and quotes the current epoch.
    if (!admitThread(removedThreadsRef.current, nextThread, issuedAt)) return;
    setBootstrap((current) =>
      current ? { ...current, threads: mergeThreads(current.threads, [nextThread]) } : current,
    );
    if (threadCacheRef.current.patchThread(nextThread.id, nextThread)) {
      publishDetail(nextThread.id);
    }
  }, [publishDetail]);

  /**
   * Follow the selection with the stream's subscription.
   *
   * The server fixes a `?thread=` subscription at connect time, so this is a
   * new socket -- hence {@link STREAM_SUBSCRIPTION_DEBOUNCE_MS}. A conversation
   * the operator opens and leaves inside that window never moves the
   * subscription at all, and the FIRST subscription is made immediately
   * because there is no live one being torn down.
   */
  useEffect(() => {
    // The seeded guess stands until the first snapshot resolves a selection:
    // re-pointing at nothing in between would spend two sockets on every load.
    if (!hasBootstrap && selectedThreadId === null) return;
    if (selectedThreadId === subscribedThreadId) return;
    if (subscribedThreadId === null) {
      setSubscribedThreadId(selectedThreadId);
      return;
    }
    const timer = window.setTimeout(
      () => setSubscribedThreadId(selectedThreadId),
      STREAM_SUBSCRIPTION_DEBOUNCE_MS,
    );
    return () => window.clearTimeout(timer);
  }, [hasBootstrap, selectedThreadId, subscribedThreadId]);

  // The debounce and the resume both re-run the stream effect, and its cleanup
  // used to clear these two timers -- which turned every conversation switch
  // into a dropped refresh, because the refs stayed set and `scheduleRefresh`
  // then believed a timer was still armed. They belong to the tab, not to one
  // socket, so they are cleared once, at teardown.
  useEffect(() => () => {
    if (refreshTimerRef.current !== null) window.clearTimeout(refreshTimerRef.current);
    if (threadListTimerRef.current !== null) window.clearTimeout(threadListTimerRef.current);
    if (persistTimerRef.current !== null) window.clearTimeout(persistTimerRef.current);
    const pendingDeltas = deltaPublishRef.current;
    if (pendingDeltas.timer !== null) window.clearTimeout(pendingDeltas.timer);
    pendingDeltas.timer = null;
    pendingDeltas.threads.clear();
    refreshTimerRef.current = null;
    threadListTimerRef.current = null;
    persistTimerRef.current = null;
    // A connection held open blocks another tab's delete or upgrade. NOT a
    // disable: StrictMode tears this down and sets it back up on the same
    // instance, and the next call simply reopens.
    persistenceRef.current?.close();
  }, []);

  useEffect(() => {
    // Any stream after the first is a REBUILD, and the round trip between
    // closing one socket and the next one registering is a gap like any other.
    // The resync it provokes quotes a validator that was fresh moments ago, so
    // it is a 304 almost every time.
    const rebuilt = streamOpenedBeforeRef.current;
    streamOpenedBeforeRef.current = true;
    if (rebuilt) resyncOnReadyRef.current = true;
    // Never blank: an empty `?thread=` is a console asking for a conversation
    // and being given none, which the server refuses with a 400.
    const events = new EventSource(subscribedThreadId === null
      ? "/api/v1/events"
      : `/api/v1/events?thread=${encodeURIComponent(subscribedThreadId)}`);
    /**
     * Whether THIS stream has reported an error the browser has not recovered
     * from.
     *
     * `readyState` alone is not enough: an automatic retry leaves an
     * `EventSource` CONNECTING for as long as it keeps failing, and a suspended
     * one can read OPEN with nothing behind it.
     */
    let errored = false;
    /**
     * One event, one decision.
     *
     * Every event used to fall through to `queueRefresh()`, which re-read the
     * whole bootstrap AND the whole open conversation -- for any type, for any
     * agent, for any conversation, including ones this tab is not showing. A
     * running turn emits several events a second, so watching one cost the
     * entire projection over and over on whatever link the operator is on.
     *
     * Each event now names what it invalidated and nothing else is re-read.
     * Anything the payload already carries is applied locally.
     */
    const handleEvent = (event: Event) => {
      const frame = (event as MessageEvent<unknown>).data;
      // The delta stream is a real cost on a metered link -- the whole reason
      // the deltas exist is that they are cheaper than re-reading -- so it is
      // counted where the frames land, and nowhere else.
      if (typeof frame === "string") recordDataUsage(new TextEncoder().encode(frame).byteLength);
      let webEvent: WebEvent | undefined;
      try {
        const parsed = JSON.parse((event as MessageEvent<string>).data) as WebEvent;
        if (parsed.version !== 1) return;
        recordServerTime(parsed.at);
        webEvent = parsed;
      } catch {
        // A ready ping without JSON still proves the stream is alive.
      }
      // A frame is proof this socket is alive, whatever it last reported.
      errored = false;
      resumeInFlightRef.current = false;
      lastEventAtRef.current = Date.now();
      applyConnection("live");
      if (webEvent === undefined) return;
      const payload = (webEvent.payload ?? {}) as {
        readonly thread?: ThreadSummary;
        readonly threadId?: string;
        readonly messageId?: string;
        readonly removed?: boolean;
        readonly sourceId?: string;
        readonly pinned?: boolean;
        readonly turn?: RunState;
      };
      const threadId = webEvent.threadId ?? payload.threadId;
      switch (webEvent.type) {
        case "push.pending":
          window.dispatchEvent(
            new CustomEvent("mono-agent:push-pending", { detail: webEvent.payload }),
          );
          return;

        case "ready": {
          // Sent once per connection, and never as a keepalive.
          //
          // A `ready` with a GAP behind it -- the link dropped, the app was
          // suspended -- may have missed anything, and `resyncAfterGap` buys
          // only what the gap could have invalidated. It used to cost a full
          // bootstrap AND a full read of the open conversation, every time.
          //
          // EVERY stream after the first has a gap behind it, a re-point
          // included: closing one socket and registering the next loses a round
          // trip of events, and `thread.changed` is broadcast to every
          // connection. Only the FIRST `ready` costs nothing -- it arrives
          // beside the snapshot this component already asked for on mount, so
          // answering it with another bootstrap doubled every page load. Only a
          // mount load that answered with NOTHING is worth asking again for.
          const gapped = resyncOnReadyRef.current;
          resyncOnReadyRef.current = false;
          if (gapped) resyncAfterGap();
          else if (initialBootstrapRef.current === "answered" && !hasBootstrapRef.current) {
            queueRefresh();
          }
          // No skills bump. A dropped stream takes `connection` off "live",
          // which is a dependency of the skills effect, so coming back to
          // "live" refetches the registry on its own -- and a registry marked
          // "stale" by that same transition made a "refetch only when it is not
          // ready" guard true every single time, putting two requests on the
          // wire per reconnect with the first aborted mid-flight.
          // Only a cron channel reads the overview.
          if (selectedCronJobIdRef.current !== undefined) {
            setCronRefreshToken((value) => value + 1);
          }
          return;
        }

        case "agents.changed": {
          // A PIN names itself. Applying one boolean locally is the whole of
          // what this event means, so it costs nothing -- the tab that pinned
          // already applied the PATCH response and re-applies the same value.
          const { sourceId, pinned } = payload;
          if (sourceId !== undefined && pinned !== undefined) {
            setBootstrap((current) => current === null
              ? current
              : {
                  ...current,
                  agents: sortAgentsPinnedFirst(
                    current.agents.map((item) => item.sourceId === sourceId
                      ? { ...item, pinned }
                      : item),
                  ),
                });
            return;
          }
          // Payload-less: emitted only when discovery actually saw a change --
          // an agent appeared or went away, or one of them advertises something
          // different. The provider catalog is keyed on the generation the
          // bootstrap carries, so replacing the snapshot is what invalidates the
          // model pages.
          loadAgents();
          setSkillRefreshToken((value) => value + 1);
          setCronRefreshToken((value) => value + 1);
          return;
        }

        case "cron.changed":
          // Every agent's cron scheduler emits these; only the one being
          // watched has an overview on screen to update.
          if (payload.sourceId !== selectedAgentRef.current) return;
          setCronRefreshToken((value) => value + 1);
          if (selectedCronJobIdRef.current !== undefined) refreshSelectedThread();
          return;

        case "threads.changed":
          if (payload.thread !== undefined) {
            applyThreadUpdate(payload.thread, removedThreadsRef.current.epoch());
            // The summary is applied above at no cost; the MESSAGES are not in
            // it. A turn that started, a cron page that reconciled and a
            // notification that landed all move a transcript and say so only
            // here, so a conversation this tab is KEEPING has to be told it can
            // no longer answer from what it holds.
            if (payload.thread.id !== selectedThreadRef.current) {
              threadCacheRef.current.markStale(payload.thread.id);
            }
            return;
          }
          // The removal is the `thread.changed` half's business: it holds the
          // tombstone and the selection repair, and it arrives with this one.
          // Read as a bare listing event, this bought a page of the bucket to
          // go looking for a conversation the same event said was gone.
          if (payload.removed === true) return;
          if (threadId !== undefined) {
            // A conversation this tab already lists needs nothing from the
            // listing: whatever changed about it arrives as its own
            // `thread.changed` or `turn.changed`.
            if (threadId !== selectedThreadRef.current) {
              threadCacheRef.current.markStale(threadId);
            }
            if (threadsRef.current.some((item) => item.id === threadId)) return;
            // Asked about once already, and the page of THIS bucket that
            // answered did not carry it. These events name no agent, so every
            // turn on a BACKGROUND agent emits two of them for a conversation
            // this tab will never list; without this each one bought another
            // page. The bucket is part of the key -- see `unlistedThreadKey`.
            const bucketSourceId = selectedAgentRef.current;
            if (
              bucketSourceId !== null
              && unlistedThreadsRef.current.has(
                unlistedThreadKey(bucketSourceId, showArchivedRef.current, threadId),
              )
            ) return;
            revalidateBucket(threadId);
            return;
          }
          revalidateBucket();
          return;

        case "thread.changed":
          if (payload.thread !== undefined) {
            // The summary IS the sidebar row, and applying it is the whole of
            // what this event means now. It used to re-read the whole
            // conversation for the transcript, because a finished turn, a
            // reconciled cron run and an appended notification all ended here
            // and nothing else said the transcript had moved. Every one of
            // those writes now names its message -- as a `message.delta` or as
            // a `message.changed` -- so the transcript arrives through the
            // paths built for it, and a turn finish costs no conversation read
            // at all.
            applyThreadUpdate(payload.thread, removedThreadsRef.current.epoch());
            if (payload.thread.id !== selectedThreadRef.current) {
              threadCacheRef.current.markStale(payload.thread.id);
            }
            return;
          }
          if (payload.removed === true && threadId !== undefined) {
            // This tab's OWN delete already owns this row: it tombstoned before
            // the request went out and finishes the local cleanup when the
            // answer lands. Re-remembering here would replace the entry its
            // reconciliation depends on.
            if (removedThreadsRef.current.has(threadId)) return;
            // Removed by someone else -- another tab, another client, a purge.
            // The open conversation's own summary counts: it outlives the row
            // in a listing that has moved past it.
            const known = threadsRef.current.find((item) => item.id === threadId)
              ?? (detailThreadRef.current?.id === threadId ? detailThreadRef.current : undefined);
            if (known !== undefined) {
              // TOMBSTONED, not merely dropped. A bootstrap or a bucket page
              // issued before this event is still in flight and still lists the
              // conversation, and nothing re-reads afterwards -- so without a
              // tombstone that response walks a destroyed conversation back
              // into the sidebar and it stays there. The server has confirmed
              // the removal, so this tombstone is never owed a rollback; it
              // expires on its own TTL.
              removedThreadsRef.current.remember(threadId, known);
              completeThreadRemovalRef.current(known, threadId);
              return;
            }
            // Nothing to name it with, so nothing to tombstone -- but if it is
            // the conversation ON SCREEN, leaving it selected shows the
            // operator something the server has destroyed. Clearing the
            // selection also makes a detail read still in flight for it inert:
            // `loadThread` only applies what the selection still points at.
            threadCacheRef.current.evict(threadId);
            if (threadId === selectedThreadRef.current) {
              selectedThreadRef.current = null;
              setSelectedThreadId(null);
              setDetail(null);
              setActionError("This conversation was deleted.");
            }
            return;
          }
          // A revision bump or a message id, and no summary to apply.
          if (threadId === undefined) return;
          if (threadId === selectedThreadRef.current) refreshSelectedThread();
          else threadCacheRef.current.markStale(threadId);
          return;

        case "message.delta": {
          if (threadId === undefined) return;
          const delta = readMessageDelta(webEvent.payload);
          // A frame this console cannot read is never applied as a partial
          // reading. Re-reading the conversation is the honest answer, and it
          // is what every event used to cost.
          if (delta === undefined) {
            if (threadId === selectedThreadRef.current) refreshSelectedThread();
            else threadCacheRef.current.markStale(threadId);
            return;
          }
          applyMessageDeltaEvent(threadId, delta);
          return;
        }

        case "message.changed": {
          if (threadId === undefined) return;
          if (threadId !== selectedThreadRef.current) {
            // Not on screen: remember that its transcript moved, and read it
            // when the operator opens it rather than now.
            threadCacheRef.current.markStale(threadId);
            return;
          }
          // A hint that names a message this tab ALREADY HOLDS is one message
          // to re-read, not a conversation. One that names an unknown message
          // is a row this transcript does not have at all -- a new turn, an
          // appended notification -- and only the conversation read can place
          // it.
          const { messageId } = payload;
          if (messageId !== undefined
            && threadCacheRef.current.holdsMessage(threadId, messageId)) {
            void repairMessage(threadId, messageId);
            return;
          }
          refreshSelectedThread();
          return;
        }

        case "turn.changed":
          // The run state IS the payload, so there is nothing to go and ask
          // for.
          if (threadId === undefined || payload.turn === undefined) return;
          patchRunState(threadId, payload.turn);
          return;

        case "attachment.changed":
          // An attachment's state is shown through the message that owns it,
          // and that message arrives with its own `message.changed`.
          return;

        default:
          return;
      }
    };
    const eventTypes: WebEvent["type"][] = [
      "ready",
      "agents.changed",
      "cron.changed",
      "threads.changed",
      "thread.changed",
      "message.changed",
      "message.delta",
      "turn.changed",
      "attachment.changed",
      "push.pending",
    ];
    events.onopen = () => {
      errored = false;
      resumeInFlightRef.current = false;
      // Same as `ready`: this transition back to "live" IS what refetches the
      // registry, through the skills effect's own dependency on `connection`.
      applyConnection("live");
    };
    events.onmessage = handleEvent;
    for (const type of eventTypes) events.addEventListener(type, handleEvent);
    events.onerror = () => {
      errored = true;
      // This socket answered -- with a failure. A resume may build another.
      resumeInFlightRef.current = false;
      // Whatever the browser's own retry does next, this stream has a gap in
      // it, and the `ready` that ends the gap is what pays for it.
      //
      // The listing is invalidated HERE and in `resume`, and deliberately not
      // by a re-point: a drop or a suspension can be arbitrarily long and the
      // sidebar it left behind is worth one merge page, while a re-point's gap
      // is a single round trip and a page per conversation switch would be
      // waste. The transcripts are handled the same way either way -- every
      // `ready` with a gap stales all of them, and each pays a conditional read
      // when it is opened.
      resyncOnReadyRef.current = true;
      staleBucketRef.current = true;
      applyConnection(navigator.onLine ? "reconnecting" : "offline");
    };

    /** A socket this console can PROVE is gone, rather than merely quiet. */
    const streamProvenDown = (): boolean => events.readyState === STREAM_CLOSED || errored;

    /**
     * Whether this stream is dead, or merely quiet because nothing happened.
     *
     * A tab the operating system suspended comes back with a socket that reads
     * OPEN and carries nothing, and a read-only stream never writes, so the
     * browser may never find out. Only ever judged across a HIDDEN period --
     * see {@link STREAM_SILENCE_LIMIT_MS} -- because a console in the
     * foreground is quiet when nothing is happening.
     */
    const streamIsDown = (hiddenSince: number | null): boolean => streamProvenDown()
      || (hiddenSince !== null
        && Date.now() - hiddenSince >= STREAM_SILENCE_LIMIT_MS
        && lastEventAtRef.current < hiddenSince);

    /**
     * The app came back. Rebuild the stream if it did not come back with it.
     *
     * `force` is for the cases where the socket's own state proves nothing: a
     * page restored from the back-forward cache, and coming back online after
     * a suspension that never produced an error.
     */
    const resume = (force = false): void => {
      // NEVER while the tab is in the background. A socket rebuilt there is one
      // more thing the system is about to suspend again, and the hidden marker
      // this resume is judged against is still accruing. RECORDED, though: the
      // next `visibilitychange` owes this resume, and takes it FORCED, because
      // by then the only evidence for it -- an `online` that fired while hidden
      // -- is gone.
      if (document.visibilityState !== "visible") {
        resumeOwedRef.current = true;
        return;
      }
      const hiddenSince = hiddenSinceRef.current;
      if (!force && !streamIsDown(hiddenSince)) {
        hiddenSinceRef.current = null;
        return;
      }
      if (!navigator.onLine) {
        // The marker is deliberately NOT spent here: nothing has been rebuilt,
        // so the silence this resume could not act on is the same silence the
        // next one (on `online`) has to judge. Clearing it here left a
        // suspended-but-OPEN socket looking healthy for the rest of the
        // session.
        applyConnection("offline");
        return;
      }
      hiddenSinceRef.current = null;
      resumeOwedRef.current = false;
      // The socket this is about to build has not opened or failed yet, so
      // nothing else may decide it is dead and build another over it.
      resumeInFlightRef.current = true;
      resyncOnReadyRef.current = true;
      // ANY gap, proven or inferred. A socket the system suspended lost exactly
      // the same events a socket that errored did, and the sidebar is one merge
      // page -- around a kilobyte compressed -- against a listing that would
      // otherwise be as old as the suspension.
      staleBucketRef.current = true;
      // The transcript keeps rendering: the operator watched a turn stream and
      // then switched apps, and blanking it would be the one thing worse than
      // showing a version that is a few frames behind. It simply cannot claim
      // to be current until the conditional read answers -- and a 304 is what
      // answers it, at the cost of a status line.
      const threadId = selectedThreadRef.current;
      if (threadId !== null) threadCacheRef.current.markStale(threadId);
      applyConnection("reconnecting");
      setStreamGeneration((value) => value + 1);
    };

    const onVisibilityChange = () => {
      if (document.visibilityState !== "visible") {
        // Left alone deliberately: iOS kills it anyway, and closing it here
        // would forfeit the events a briefly-backgrounded tab still receives.
        hiddenSinceRef.current = Date.now();
        return;
      }
      const owed = resumeOwedRef.current;
      resumeOwedRef.current = false;
      resume(owed);
    };
    const onPageShow = (event: PageTransitionEvent) => { if (event.persisted) resume(true); };
    const onOnline = () => {
      // No skills bump and no `queueRefresh`. The reconnect's `ready` resyncs
      // the open conversation conditionally, and the transition back to "live"
      // is what refetches the registry -- once.
      //
      // FORCED, unless this console is already live. The worst case is the iOS
      // one: the system suspended the socket, no `onerror` ever fired, and
      // `readyState` still reads OPEN -- so every signal available says
      // "healthy" and declaring it live left the banner hidden and the composer
      // enabled over a dead stream. One conditional read (usually a 304) is
      // what that costs instead.
      // A resume is already building one. `online` can land between the bump
      // and the new socket's first byte, when every signal still describes the
      // socket that was closed -- and forcing there tore down the replacement
      // before it had a chance to open.
      if (resumeInFlightRef.current) return;
      if (connectionRef.current === "live" && !streamIsDown(hiddenSinceRef.current)) return;
      resume(true);
    };
    const onOffline = () => applyConnection("offline");
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("pageshow", onPageShow);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      events.close();
      for (const type of eventTypes) events.removeEventListener(type, handleEvent);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("pageshow", onPageShow);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, [
    applyMessageDeltaEvent,
    applyThreadUpdate,
    loadAgents,
    patchRunState,
    queueRefresh,
    refreshSelectedThread,
    repairMessage,
    resyncAfterGap,
    revalidateBucket,
    streamGeneration,
    subscribedThreadId,
  ]);

  const agents = useMemo(
    () => sortAgentsPinnedFirst(bootstrap?.agents ?? []),
    [bootstrap?.agents],
  );
  const threads = bootstrap?.threads ?? [];
  // Assigned during render, like `catalogScopeRef` below: the SSE handler reads
  // it when an event fires, and an effect would leave it a commit behind.
  threadsRef.current = threads;
  const selectedAgent =
    agents.find((agent) => agent.sourceId === selectedAgentId) ?? null;
  // The catalog cache is per agent AND per agent PROCESS. A source id outlives
  // the process behind it: reconfigure an agent and restart it and the next
  // generation advertises a different catalog under the same id. Keyed on the
  // id alone, a tab kept offering the retired generation's models until it was
  // reloaded, and `startTurn` rejected every turn that used one. The browser
  // had nothing generation-shaped to watch until `AgentSummary.generation`.
  const catalogScope = `${selectedAgentId ?? ""}\u0000${selectedAgent?.generation ?? ""}`;
  // Assigned during render, like `scheduleRefreshRef` above: an in-flight page
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
  // Assigned during render, like `threadsRef`: a removal event has to be able
  // to name a conversation the listing has moved past.
  detailThreadRef.current = detail?.thread ?? null;
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
  const activeBucketCursor = activeBucketKey === undefined
    ? undefined
    : threadCursorByBucket[activeBucketKey];
  const hasMoreThreads = typeof activeBucketCursor === "string";
  // Assigned during render, like `threadsRef`: the flush runs between commits
  // and has to write the listing and the snapshot the operator is looking at.
  persistedSnapshotRef.current = bootstrap === null
    ? undefined
    : {
        agents: bootstrap.agents,
        console: bootstrap.console,
        limits: bootstrap.limits,
        push: bootstrap.push,
      };
  persistedBucketRef.current = activeBucketKey === undefined
    ? undefined
    : {
        key: activeBucketKey,
        threads: visibleThreads,
        nextCursor: typeof activeBucketCursor === "string" ? activeBucketCursor : null,
      };
  // The listing and the snapshot move through state rather than through the
  // cache, so they arm the same throttle themselves and land in the same
  // transaction as whatever the cache changed.
  useEffect(() => {
    schedulePersist();
  }, [activeBucketKey, bootstrap, schedulePersist, threadCursorByBucket]);
  const selectedCronJobId = selectedThread?.trigger?.kind === "cron"
    ? selectedThread.trigger.jobId
    : undefined;
  const selectedCronThreadId = selectedCronJobId === undefined ? undefined : selectedThread?.id;
  selectedCronJobIdRef.current = selectedCronJobId;
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
      const page = await api.messages(
        current.thread.id,
        current.messagesNextCursor,
        undefined,
        currentDataMode() === "lean" ? LEAN_MESSAGE_PAGE_LIMIT : MESSAGE_PAGE_LIMIT,
      );
      // Into the CACHE, which is what makes a walked-back transcript survive
      // the next refresh: a window read keeps everything older than its own
      // window rather than dropping the pages the operator scrolled to.
      threadCacheRef.current.prependOlder(current.thread.id, {
        messages: page.messages,
        ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
      });
      publishDetail(current.thread.id);
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
    const older = page.messages ?? [];
    // The agent-owned run page carries no message cursor of its own; the
    // channel's cursor above is what walks it, so this only adds rows.
    threadCacheRef.current.prependOlder(current.thread.id, {
      messages: older,
      ...(current.messagesNextCursor === undefined
        ? {}
        : { nextCursor: current.messagesNextCursor }),
    });
    publishDetail(current.thread.id);
  }, [
    cronRunCursorByChannel,
    detail,
    publishDetail,
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
      // The overview and, for a cron channel, its run page. Neither the bucket
      // listing nor the open conversation is re-read here: this used to pull a
      // whole 200-row page AND a full thread detail alongside the overview, on
      // every `ready` and every `cron.changed` of every agent. The listing is
      // the bootstrap's, and the conversation is refreshed by the event that
      // actually changed it -- see the `cron.changed` arm of the event table.
      const overview = await api.cronOverview(sourceId);
      setCronOverview(overview);
      if (jobId !== undefined) {
        const page = await api.cronRuns(sourceId, jobId);
        const channelKey = cronChannelKey(sourceId, jobId);
        setCronRunCursorByChannel((current) => Object.prototype.hasOwnProperty.call(current, channelKey)
          ? current
          : { ...current, [channelKey]: page.nextCursor ?? null });
      }
    } catch (cronError) {
      setCronError(errorMessage(cronError));
    } finally {
      setCronLoading(false);
    }
  }, [selectedAgent?.cron?.read, selectedAgentId, selectedCronJobId]);

  const loadCronRunActivity = useCallback(async (runId: string) => {
    const sourceId = selectedAgentId;
    const jobId = selectedCronJobId;
    const threadId = selectedCronThreadId;
    if (sourceId === null || jobId === undefined || threadId === undefined) return;
    setCronLoading(true);
    setCronError(null);
    try {
      const message = await api.cronRun(sourceId, jobId, runId);
      // REPLACED, not merged: the operator asked for this run's activity and
      // the answer is the same row at the same version with the detail filled
      // in, which a version comparison would read as nothing new.
      if (threadCacheRef.current.upsertMessage(threadId, message, { replace: true })) {
        publishDetail(threadId);
      }
    } catch (loadError) {
      setCronError(errorMessage(loadError));
    } finally {
      setCronLoading(false);
    }
  }, [publishDetail, selectedAgentId, selectedCronJobId, selectedCronThreadId]);

  const refreshReplyAttachmentAccess = useCallback(
    async (partId: string): Promise<ReplyAttachmentMessagePart> => {
      const threadId = selectedThreadRef.current;
      if (threadId === null) throw new Error("No conversation is open.");
      const message = threadCacheRef.current.get(threadId)?.messages.find((candidate) =>
        candidate.parts.some((part) => part.type === "attachment" && part.id === partId));
      if (message === undefined) throw new Error("This conversation no longer holds that file.");
      // Bounded like every other read: a wedged transport must not leave a tile
      // waiting on a promise that never settles. The answer is NOT written into
      // the cache -- the capability expires, and the part that asked for it is
      // the only thing that should hold one.
      return await boundedRequest(
        (signal) => api.replyAttachmentAccess(threadId, message.id, partId, signal),
        THREAD_READ_TIMEOUT_MS,
      );
    },
    [],
  );

  // Deliberately stable: this is handed to the transcript through a context, and
  // a new identity on every streamed token would re-render every tool row for
  // the whole of a running turn.
  const loadFullToolCall = useCallback(async (toolCallId: string): Promise<boolean> => {
    const cache = threadCacheRef.current;
    const threadId = selectedThreadRef.current;
    if (threadId === null) return false;
    const message = cache.get(threadId)?.messages.find((candidate) =>
      holdsToolCall(candidate, toolCallId));
    if (message === undefined) return false;
    // Bounded like every other read. Unbounded, a wedged transport left the
    // row's notice on "Loading..." for good: nothing settles the promise it is
    // waiting on, so it can neither report the failure nor offer the button
    // again. See {@link THREAD_READ_TIMEOUT_MS}.
    const part = await boundedRequest(
      (signal) => api.toolCallPart(threadId, message.id, toolCallId, signal),
      THREAD_READ_TIMEOUT_MS,
    );
    // Straight into the cache, which is the console's own copy of the server
    // and is written synchronously. Two repairs in one message -- two clicks on
    // a cluster, two subagent steps -- used to each substitute a message built
    // from a pre-commit snapshot, so the first silently reverted to its preview
    // while both reported success; the second one now reads the first.
    //
    // The cache also REMEMBERS the call, so the untruncated body survives a
    // later write of that slot instead of reverting to the preview the delta
    // carries. See `ThreadCacheEntry.repairedToolCallIds`.
    const replaced = cache.repairToolCall(threadId, message.id, toolCallId, part);
    if (!replaced) return false;
    // The round trip is not instant and the operator can leave the conversation
    // during it. The repair is kept either way -- it is the server's answer, and
    // coming back to this conversation should not have to ask again -- but the
    // boolean answers for the row that asked, and that row is gone.
    if (selectedThreadRef.current !== threadId) return false;
    publishDetail(threadId);
    return true;
  }, [publishDetail]);

  /**
   * "Clear cached data": forget what this browser is keeping, everywhere.
   *
   * The device store is emptied, and so is the cache -- except the conversation
   * on screen, because the operator asked for what is KEPT to go, not for the
   * transcript in front of them to be replaced by a spinner and bought again.
   * `clear` is deliberately not a content change, so nothing is written back
   * the moment this returns; ordinary use fills the device again from here.
   */
  const clearCachedData = useCallback(async () => {
    // The armed flush FIRST. It carries the snapshot, the listing and every
    // entry held as of a moment ago, so leaving it to fire wrote all of it back
    // a second after the "Cleared…" toast. The cache goes next, so anything a
    // frame arriving DURING the clear arms can only describe what is left --
    // and the second cancel drops even that.
    cancelPersist();
    threadCacheRef.current.clear(selectedThreadRef.current ?? undefined);
    await persistenceRef.current?.clearAll();
    cancelPersist();
  }, [cancelPersist]);

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
    // The validator survives every one of these transitions: it describes the
    // ANSWER this tab is holding, not the connection that fetched it, and a
    // reconnect is exactly when it is worth quoting.
    const held = prior.sourceId === sourceId ? prior.etag : undefined;
    const retained = held === undefined ? {} : { etag: held };
    if (selectedAgent?.status === "offline" || connection !== "live") {
      setSkillRegistryState({ sourceId, registry: retainAsStale(), ...retained });
      return;
    }
    const controller = new AbortController();
    setSkillRegistryState({
      sourceId,
      registry: prior.sourceId === sourceId
        && (prior.registry.status === "ready" || prior.registry.status === "stale")
        ? retainAsStale()
        : { status: "loading", items: [] },
      ...retained,
    });
    // Only ever one, and only after a 304 this tab could not act on.
    let retried = false;
    // CONDITIONAL when this tab holds a validator for this agent's registry.
    // The registry changes when the agent's advertisement does, which is rare;
    // the reads are not, because every transition back to "live" buys one.
    const readRegistry = async (quoted: string | undefined): Promise<void> => {
      const answer = await api.agentSkills(sourceId, controller.signal, quoted);
      if (controller.signal.aborted || generation !== skillRequestGenerationRef.current) return;
      if (answer !== NOT_MODIFIED) {
        const { etag, ...rest } = answer;
        const next = rest as SkillRegistryState;
        setSkillRegistryState({
          sourceId,
          registry: next,
          // ONLY a READY answer's validator, which is the invariant the field
          // is declared with. The server answers 200 with `unsupported` and
          // `offline` payloads too and Express mints an ETag for those; stored,
          // one of those validators later answered 304 for a registry
          // `retainAsStale` cannot lift back to "ready", and the console sat at
          // "Loading skills…" for the rest of the session -- re-quoting the
          // same poisoned validator on every reconnect. A 200 that carries no
          // ETag DROPS the one held, rather than keeping a validator that
          // describes an older answer.
          ...(next.status === "ready" && etag !== undefined ? { etag } : {}),
        });
        return;
      }
      // What this tab holds IS the agent's registry: the "stale" a disconnect
      // marked it with is simply lifted.
      const current = skillRegistryStateRef.current;
      if (current.sourceId === sourceId && current.registry.status === "stale") {
        setSkillRegistryState({
          ...current,
          registry: { ...current.registry, status: "ready" },
        });
        return;
      }
      // A 304 for a registry there is no stale copy to lift. Either the
      // validator and the copy this tab holds have come apart, or this read is
      // simply one commit ahead of the ref it checks -- `skillRegistryStateRef`
      // is assigned by an effect, so a 304 that lands before React has
      // committed the "stale" this effect just set finds the PREVIOUS registry
      // here. Neither is something to leave the operator inside: read once more
      // without a validator rather than sit at a registry that never resolves.
      if (retried) return;
      retried = true;
      await readRegistry(undefined);
    };
    void readRegistry(held).catch(() => {
      if (controller.signal.aborted || generation !== skillRequestGenerationRef.current) return;
      setSkillRegistryState({
        sourceId,
        registry: prior.sourceId === sourceId
          && (prior.registry.status === "ready" || prior.registry.status === "stale")
          ? retainAsStale()
          : { status: "error", items: [] },
        ...retained,
      });
    });
    return () => controller.abort();
  }, [connection, selectedAgent?.status, selectedAgentId, skillRefreshToken]);

  const selectAgent = useCallback(
    (sourceId: string) => {
      operatorSelectionRef.current += 1;
      // Whatever this resolves to is the operator's, never a provisional
      // restore. See `restoredSelectionRef`.
      restoredSelectionRef.current = null;
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
      // In the SAME batch as the selection. Publishing the cached transcript
      // from the selection effect instead puts them in different commits, so
      // the header, the composer and the run controls switch a frame before the
      // transcript does and the conversation being left flashes under the new
      // one. A conversation the cache does not hold publishes as empty, which
      // is also what the operator should see while it is read.
      publishDetail(recent?.id ?? null);
      // Only a row this tab HOLDS is evidence. With one bucket per bootstrap,
      // holding none for an agent means its bucket has not been fetched yet --
      // not that the operator's last conversation there is gone -- and clearing
      // the stored id here would throw away what the page is about to open on.
      if (recent !== undefined) persistThreadId(sourceId, recent.id);
      updateThreadRoute(recent);
      setShowArchived(false);
      setActionError(null);
    },
    [publishDetail, threads],
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
      // No refresh: the PATCH answered with the agent row it just wrote and it
      // is applied above. Re-reading every agent and every conversation to
      // learn one boolean this tab already holds is the whole cost that used to
      // follow a pin.
    } catch (pinError) {
      setActionError(errorMessage(pinError));
      throw pinError;
    }
  }, []);

  const selectThread = useCallback(
    (threadId: string) => {
      operatorSelectionRef.current += 1;
      restoredSelectionRef.current = null;
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
      // See `selectAgent`: same batch, so a cached conversation is on screen in
      // the commit that selects it rather than the one after.
      publishDetail(threadId);
      setActionError(null);
      if (thread === undefined) {
        const issuedAt = removedThreadsRef.current.epoch();
        // The cache's clock, quoted the way `loadThread` quotes it. A push deep
        // link and a search hit both open a conversation this tab holds no row
        // for, and that read goes out from HERE rather than from the selection
        // effect -- so without this it was the one read a write landing during
        // it could overtake silently.
        const observedAt = threadCacheRef.current.clock();
        // Claimed BEFORE the request, so the selection effect this commit is
        // about to run sees it: the two used to read the same conversation
        // twice on every deep link and every search hit.
        selectionReadRef.current = threadId;
        setDetailLoading(true);
        void boundedRequest(
          (signal) => api.thread(threadId, signal),
          THREAD_READ_TIMEOUT_MS,
        ).then((next) => {
          selectionReadRef.current = null;
          const canonical = next.thread;
          // Deleted while this fetch was outstanding: selecting it now would
          // re-add it, route to it, and persist it as this agent's selection.
          if (!admitThread(removedThreadsRef.current, canonical, issuedAt)) return;
          setBootstrap((current) => current === null
            ? current
            : { ...current, threads: mergeThreads(current.threads, [canonical]) });
          const entry = threadCacheRef.current.upsertFull(
            next,
            {
              reset: true,
              issuedAt: observedAt,
              ...(next.etag === undefined ? {} : { etag: next.etag }),
            },
          );
          selectedAgentRef.current = canonical.sourceId;
          selectedThreadRef.current = canonical.id;
          setSelectedAgentId(canonical.sourceId);
          setSelectedThreadId(canonical.id);
          localStorage.setItem(SELECTED_AGENT_STORAGE_KEY, canonical.sourceId);
          publishDetail(canonical.id);
          // Overtaken while it was on the wire: one more read, exactly as
          // `loadThread` does, rather than a transcript that looks settled.
          if (entry?.stale === true) scheduleRefreshRef.current({ detail: true });
          if (!canonical.archivedAt) persistThreadId(canonical.sourceId, canonical.id);
          updateThreadRoute(canonical, true);
        }).catch((selectionError: unknown) => {
          // The read this selection owns did not answer, so nothing else will:
          // the effect stood aside for it. Reported, and the spinner cleared.
          selectionReadRef.current = null;
          if (selectionError instanceof ApiError
            && selectionError.status === 404
            && selectedThreadRef.current === threadId) {
            closeMissingThread(threadId);
            return;
          }
          setActionError(errorMessage(selectionError));
        }).finally(() => {
          if (selectedThreadRef.current === threadId) setDetailLoading(false);
        });
      }
    },
    [closeMissingThread, publishDetail, threads],
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
      const issuedAt = removedThreadsRef.current.epoch();
      const draftPreferenceKey = preferenceKeyForThread(selectedAgentId, null);
      const runConfig = {
        ...(Object.hasOwn(modelByContext, draftPreferenceKey)
          ? { model: modelByContext[draftPreferenceKey] || null }
          : {}),
        ...(Object.hasOwn(effortByContext, draftPreferenceKey)
          ? { effort: effortByContext[draftPreferenceKey] || null }
          : {}),
      };
      const thread = await boundedRequest(
        (signal) => api.createThread(selectedAgentId, runConfig, signal),
      );
      // The server commits and emits `threads.changed` before this POST
      // answers, so by the time it does the console may have admitted this
      // conversation from an SSE refresh -- and the operator may have deleted
      // it. Prepending the response blind therefore either listed it twice or
      // undid the delete. Every other insertion path was routed through the
      // tombstone and `mergeThreads`; this one was not.
      if (!admitThread(removedThreadsRef.current, thread, issuedAt)) {
        throw new Error("This conversation was deleted.");
      }
      setModelByContext((current) => {
        if (current[draftPreferenceKey] === undefined) return current;
        const next = { ...current };
        delete next[draftPreferenceKey];
        return next;
      });
      setEffortByContext((current) => {
        if (current[draftPreferenceKey] === undefined) return current;
        const next = { ...current };
        delete next[draftPreferenceKey];
        return next;
      });
      operatorSelectionRef.current += 1;
      // See `restoredSelectionRef`: what the operator opens is theirs, and a
      // read still in flight for what they left has nothing to settle here.
      restoredSelectionRef.current = null;
      selectedThreadRef.current = thread.id;
      setSelectedThreadId(thread.id);
      persistThreadId(selectedAgentId, thread.id);
      setShowArchived(false);
      updateThreadRoute(thread);
      setBootstrap((current) =>
        current ? { ...current, threads: mergeThreads(current.threads, [thread]) } : current,
      );
      threadCacheRef.current.upsertFull({ thread, messages: [] });
      publishDetail(thread.id);
      setActionError(null);
      return thread;
    } catch (createError) {
      setActionError(errorMessage(createError));
      throw createError;
    }
  }, [effortByContext, modelByContext, publishDetail, selectedAgentId]);

  const applyAgentUpdate = useCallback((agent: AgentSummary) => {
    setBootstrap((current) => current === null
      ? current
      : {
          ...current,
          agents: current.agents.map((item) => item.sourceId === agent.sourceId ? agent : item),
        });
  }, []);

  const setAgentRunDefaults = useCallback(async (model: string | null, effort: string | null) => {
    if (!selectedAgentId) throw new Error("Select an agent before changing its defaults.");
    try {
      const agent = await api.setAgentRunDefaults(selectedAgentId, { model, effort });
      applyAgentUpdate(agent);
      setActionError(null);
    } catch (settingsError) {
      setActionError(errorMessage(settingsError));
      throw settingsError;
    }
  }, [applyAgentUpdate, selectedAgentId]);

  const clearAgentRunDefaults = useCallback(async () => {
    if (!selectedAgentId) throw new Error("Select an agent before changing its defaults.");
    try {
      const agent = await api.clearAgentRunDefaults(selectedAgentId);
      applyAgentUpdate(agent);
      setActionError(null);
    } catch (settingsError) {
      setActionError(errorMessage(settingsError));
      throw settingsError;
    }
  }, [applyAgentUpdate, selectedAgentId]);

  const fetchThreadSummary = useCallback(async (threadId: string): Promise<ThreadSummary> => {
    const known = threads.find((candidate) => candidate.id === threadId) ??
      (detail?.thread.id === threadId ? detail.thread : undefined);
    if (known !== undefined) return known;
    const issuedAt = removedThreadsRef.current.epoch();
    const fetched = await boundedRequest(
      (signal) => api.thread(threadId, signal),
      THREAD_READ_TIMEOUT_MS,
    );
    if (!admitThread(removedThreadsRef.current, fetched.thread, issuedAt)) {
      throw new Error("This conversation was deleted.");
    }
    setBootstrap((current) => current === null
      ? current
      : { ...current, threads: mergeThreads(current.threads, [fetched.thread]) });
    return fetched.thread;
  }, [detail, threads]);

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
      const issuedAt = removedThreadsRef.current.epoch();
      // Queued and bounded like every other write to this conversation. Rename,
      // archive and the override writes all PATCH the same row and all apply
      // the COMPLETE thread the server returns, so two in flight together let
      // the older response overwrite the newer state: holding a rename until an
      // archive had completed put `archivedAt` back to null.
      const thread = await enqueueThreadWrite(target.id, (signal) =>
        api.patchThread(target.id, { title: trimmed }, signal));
      applyThreadUpdate(thread, issuedAt);
    } catch (renameError) {
      setActionError(errorMessage(renameError));
      throw renameError;
    }
  }, [applyThreadUpdate, enqueueThreadWrite, fetchThreadSummary]);

  const archiveThread = useCallback(
    async (threadId: string) => {
      try {
        const target = await fetchThreadSummary(threadId);
        const issuedAt = removedThreadsRef.current.epoch();
        const thread = await enqueueThreadWrite(target.id, (signal) =>
          api.patchThread(target.id, { archived: true }, signal));
        applyThreadUpdate(thread, issuedAt);
        if (selectedThreadRef.current === target.id || selectedThreadRef.current === threadId) {
          operatorSelectionRef.current += 1;
          restoredSelectionRef.current = null;
          const replacement = visibleThreads.find((item) => item.id !== target.id);
          selectedThreadRef.current = replacement?.id ?? null;
          setSelectedThreadId(replacement?.id ?? null);
          publishDetail(replacement?.id ?? null);
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
    [applyThreadUpdate, enqueueThreadWrite, fetchThreadSummary, publishDetail, visibleThreads],
  );

  const unarchiveThread = useCallback(async (threadId: string) => {
    try {
      const target = await fetchThreadSummary(threadId);
      const issuedAt = removedThreadsRef.current.epoch();
      const thread = await enqueueThreadWrite(target.id, (signal) =>
        api.patchThread(target.id, { archived: false }, signal));
      applyThreadUpdate(thread, issuedAt);
      operatorSelectionRef.current += 1;
      restoredSelectionRef.current = null;
      selectedThreadRef.current = thread.id;
      setSelectedThreadId(thread.id);
      // In the same batch as the selection -- see `selectAgent`.
      publishDetail(thread.id);
      persistThreadId(thread.sourceId, thread.id);
      setShowArchived(false);
      updateThreadRoute(thread, true);
    } catch (unarchiveError) {
      setActionError(errorMessage(unarchiveError));
      throw unarchiveError;
    }
  }, [applyThreadUpdate, enqueueThreadWrite, fetchThreadSummary, publishDetail]);

  /**
   * Everything a CONFIRMED delete leaves this tab to clean up.
   *
   * Shared by the success path and by a failure whose reconciliation proved the
   * server applied it anyway, because both end in the same place: the
   * conversation does not exist. Deliberately unreachable from an UNCONFIRMED
   * failure -- dropping the run preference of a conversation that still exists
   * is the one-way door the previous round shipped.
   */
  const completeThreadRemoval = useCallback((thread: ThreadSummary, requestedId: string) => {
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
    threadCacheRef.current.evict(thread.id);
    threadCacheRef.current.evict(requestedId);
    if (selectedThreadRef.current === thread.id || selectedThreadRef.current === requestedId) {
      const replacement = visibleThreads.find((item) => item.id !== thread.id);
      selectedThreadRef.current = replacement?.id ?? null;
      setSelectedThreadId(replacement?.id ?? null);
      publishDetail(replacement?.id ?? null);
      updateThreadRoute(replacement, true);
    }
    if (readPersistedThreadIds()[thread.sourceId] === thread.id) {
      persistThreadId(thread.sourceId, null);
    }
    setActionError(null);
  }, [publishDetail, visibleThreads]);
  // Assigned during render: it changes with the visible listing, and putting it
  // in the SSE effect's dependencies would tear down and reopen the event
  // stream every time a conversation moved.
  completeThreadRemovalRef.current = completeThreadRemoval;

  /**
   * The deletes this tab has on the wire, by the conversation they remove.
   *
   * KEYED BY THE ID THE CALLER ASKED FOR, which is the conversation:
   * `fetchThreadSummary` resolves a summary BY id, so the row it hands back is
   * always the row that was asked for.
   */
  const deletesInFlightRef = useRef(new Map<string, Promise<void>>());

  /** Everything one delete of one conversation does -- see {@link deleteThread}. */
  const runThreadDelete = useCallback(async (threadId: string) => {
    try {
      const thread = await fetchThreadSummary(threadId);
      // Tombstoned BEFORE the round trip, and reversed if the round trip proves
      // the server refused it. Recorded afterwards, every response that arrived
      // DURING the delete -- the bootstrap `refreshNow` issues on the delete's
      // own SSE event, a queued write's result -- was admitted, and the
      // conversation came back.
      //
      // Deliberately NOT queued behind this conversation's other writes, unlike
      // every other mutation. A delete produces no thread snapshot for a later
      // response to overwrite, and the tombstone already makes every earlier
      // response inert, so ordering buys nothing here -- while queueing would
      // make the operator wait out a stalled write's full deadline before a
      // conversation they asked to remove disappeared. It is still bounded.
      const wasSelected = selectedThreadRef.current === thread.id
        || selectedThreadRef.current === threadId;
      const selectionAtRequest = operatorSelectionRef.current;
      removedThreadsRef.current.remember(thread.id, thread);
      // `startBoundedRequest`, not `boundedRequest`: the reconciliation needs
      // the request's REAL settlement, not the caller's. See
      // `reconcileFailedDelete` -- a read issued while this DELETE is still on
      // the wire cannot order itself against it.
      const attempt = startBoundedRequest((signal) => api.deleteThread(thread.id, signal));
      try {
        await attempt.result;
      } catch (deleteRequestError) {
        // A rejection says the ANSWER did not arrive. Restoring on every one of
        // them treated it as proof the request was never applied, and the
        // server commits the row deletion before it awaits attachment cleanup
        // and emits its invalidations -- so a dropped answer or this console's
        // own deadline resurrected a conversation the server no longer had,
        // over an authoritative refresh that had already removed it.
        const outcome = await reconcileFailedDelete(thread.id, attempt.landed);
        if (outcome.verdict === "applied") {
          // Confirmed gone: either the abandoned request landed after the
          // caller gave up, or a read issued once it had settled was answered
          // "not found". The operator asked for exactly this, so the tombstone
          // stands and the local cleanup runs. Not a failure reported as a
          // success -- a postcondition that was CHECKED rather than assumed.
          completeThreadRemoval(thread, threadId);
          return;
        }
        if (outcome.thread === undefined) {
          // Nothing was even OBSERVED: the reconciling read failed too, or
          // there was never a point to read from. Neither assumption is
          // available -- restoring may resurrect a deleted conversation, and
          // keeping the tombstone hides a live one for the rest of its
          // lifetime. So stop asserting anything -- drop the tombstone, keep
          // the local projection as the last thing the server actually said,
          // and ask it again. Nothing that a confirmed delete cleans up is
          // touched.
          //
          // FORGOTTEN, not released: the delete may well have been applied, so
          // the fence stays and a response issued before it still cannot put
          // the conversation back. Only what the refresh below returns can.
          removedThreadsRef.current.forget(thread.id);
          queueRefresh();
          throw deleteRequestError;
        }
        // A read issued once the DELETE had settled still found the
        // conversation, so whatever happened to the request there is a row to
        // put back, and the server's own answer is the thing to put back.
        //
        // The FENCE is the entire difference between the two ways of arriving
        // here, and it turns on whether the server ANSWERED.
        //
        // RELEASED on a refusal: the server told us it applied nothing, so a
        // response issued before the delete is no longer stale about whether
        // the conversation exists and must not be fenced out. A pre-delete
        // bootstrap answering after this repair would otherwise drop the row
        // straight back out of a sidebar with no refresh coming.
        //
        // FORGOTTEN on anything else: a rejection that was not an answer leaves
        // the DELETE possibly still running, so the sighting above is a
        // sighting and not a promise. The row is restored -- it is the freshest
        // thing the server has said -- while the fence stays, because a
        // response ISSUED BEFORE the delete is still no evidence the row
        // survived, and dropping the fence on a delete that then commits let
        // exactly such a response walk the conversation back into the sidebar
        // over the refresh that had just removed it.
        //
        // Either way this is not undoing the delete. Every response that
        // answered while the tombstone stood -- the bootstrap `refreshNow`
        // issues on the delete's own SSE event above all -- has already
        // filtered this conversation out of the projection, and nothing else
        // puts it back: the shipped test only proved that a LATER refresh
        // eventually would. The tombstone hands back the newest projection it
        // suppressed, so the repair happens here, where the failure is.
        const suppressed = outcome.verdict === "refused"
          ? removedThreadsRef.current.release(thread.id)
          : removedThreadsRef.current.forget(thread.id);
        const restored = newerProjection(suppressed ?? thread, outcome.thread);
        applyThreadUpdate(restored, removedThreadsRef.current.epoch());
        // A sighting is not a settlement, so an unknown verdict still ASKS. The
        // row above is the best projection this tab has and the operator gets
        // it back immediately; the refresh is what converges if the delete this
        // console could not account for turns out to have committed after all.
        if (outcome.verdict !== "refused") queueRefresh();
        // A bootstrap that answered while it was tombstoned also re-resolved
        // the selection over a sidebar this conversation was missing from, so
        // restoring the row without the selection left the operator staring at
        // an empty pane. Only when the OPERATOR has not chosen somewhere else
        // since -- see `operatorSelectionRef`; an automatic re-resolution is
        // not a choice, and a deliberate move to another agent is. The agent
        // comes back with it, because the automatic re-resolution can move that
        // too, and a conversation restored under another agent is targeted by
        // run actions the console is showing someone else's capabilities for.
        if (wasSelected && operatorSelectionRef.current === selectionAtRequest) {
          selectedAgentRef.current = restored.sourceId;
          setSelectedAgentId(restored.sourceId);
          localStorage.setItem(SELECTED_AGENT_STORAGE_KEY, restored.sourceId);
          selectedThreadRef.current = restored.id;
          setSelectedThreadId(restored.id);
          // In the same batch as the selection -- see `selectAgent`. A bootstrap
          // that answered while this was tombstoned moved the selection to a
          // survivor, so without this the survivor's transcript sat under the
          // restored conversation's header for a frame.
          publishDetail(restored.id);
          persistThreadId(restored.sourceId, restored.archivedAt ? null : restored.id);
          updateThreadRoute(restored, true);
        }
        throw deleteRequestError;
      }
      completeThreadRemoval(thread, threadId);
    } catch (deleteError) {
      setActionError(errorMessage(deleteError));
      throw deleteError;
    }
  }, [
    applyThreadUpdate,
    completeThreadRemoval,
    fetchThreadSummary,
    publishDetail,
    queueRefresh,
  ]);

  /**
   * One conversation, one delete.
   *
   * The delete button stays enabled while its request is outstanding -- which
   * is precisely when an operator clicks it again -- and every re-entry took
   * out a SECOND tombstone for the same row. `remember` REPLACES the entry it
   * finds, so the second ask threw away the newest projection the first had
   * recorded, and whichever ask reconciled first then released or forgot a
   * tombstone the other was still relying on: a response arriving in that
   * window walked the conversation back into the sidebar with its delete still
   * on the wire. Two requests also give the server two different questions to
   * answer about one row, and the console no way to say which answer was about
   * which.
   *
   * Asking twice is one intent, so it gets one request and one answer. Not a
   * disabled button: a button is one caller of several, and the invariant is
   * about the conversation, not about the widget the operator used.
   *
   * The entry is released once the delete SETTLES, never before and never
   * later. A delete the server refused leaves a conversation that is still
   * there and still deletable, and an entry that outlived its request would
   * answer that next ask with a promise for a request that is over.
   */
  const deleteThread = useCallback((threadId: string): Promise<void> => {
    const inFlight = deletesInFlightRef.current;
    const running = inFlight.get(threadId);
    if (running !== undefined) return running;
    const attempt = runThreadDelete(threadId);
    inFlight.set(threadId, attempt);
    const release = () => {
      // Only its own entry: a later delete of the same conversation owns the
      // slot by then.
      if (inFlight.get(threadId) === attempt) inFlight.delete(threadId);
    };
    // `then(release, release)` rather than `finally`, whose promise rejects in
    // turn: nothing is listening to it, so a failed delete no caller awaited
    // would surface as an unhandled rejection.
    void attempt.then(release, release);
    return attempt;
  }, [runThreadDelete]);

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
  const localModelPresent = preferenceKey !== "" && Object.hasOwn(modelByContext, preferenceKey);
  const localEffortPresent = preferenceKey !== "" && Object.hasOwn(effortByContext, preferenceKey);
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
  // A provider advertised by the agent can own persisted catalog-only models
  // before this tab has fetched its first page. Catalog keys remain included
  // for compatibility with older agent payloads that do not expose providers.
  const advertisedProviders = [
    ...(selectedAgent?.providers?.map((provider) => provider.id) ?? []),
    ...Object.keys(catalogByProvider),
  ];
  const validatedPreference = validateRunPreference(
    selectedAgent,
    storedPreference,
    advertisedProviders,
    catalogModels,
  );
  const model = validatedPreference.model;
  const configModel = selectedAgent ? effectiveModelForAgent(selectedAgent, "") ?? "" : "";
  const draftInheritsWebModel = selectedThread === null && !localModelPresent;
  const inheritedModel = draftInheritsWebModel
    ? selectedAgent?.runSettings.effective.model ?? configModel
    : configModel;
  const effectiveModel = model || inheritedModel;
  const effortOptions = effortLevelsForAgentModel(
    selectedAgent,
    effectiveModel,
    findCatalogModel(catalogModels, effectiveModel),
  );
  const effort = validatedPreference.effort;
  const configEffort = selectedAgent?.defaultEffort ?? "";
  const draftInheritsWebEffort = selectedThread === null && !localEffortPresent;
  const inheritedEffort = draftInheritsWebEffort
    ? selectedAgent?.runSettings.effective.effort ?? configEffort
    : configEffort;
  const effectiveEffort = effort || inheritedEffort;
  // An override is what the operator chose for THIS conversation, as opposed to
  // whatever the agent would otherwise start with.
  const hasRunOverride = selectedThread === null
    ? localModelPresent || localEffortPresent
    : model.length > 0 || effort.length > 0;

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
    // Already tombstoned: do not start, and above all do not MARK. The delete
    // owns this conversation's preference key from here -- it removes it when
    // it lands and leaves it alone when it fails -- and marking on the way past
    // would spend the one-time adoption on a conversation that may be coming
    // back.
    if (removedThreadsRef.current.has(threadId)) return;
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
    const migrationIssuedAt = removedThreadsRef.current.epoch();
    void enqueueThreadWrite(threadId, async (signal) => {
      try {
        const fresh = await api.thread(threadId, signal);
        if (removedThreadsRef.current.has(threadId)) {
          // RECORD it on the way past. This read is a projection like any
          // other, and a delete that then fails has to hand back the newest
          // one this tab saw.
          removedThreadsRef.current.suppress(threadId, fresh.thread);
          // Tombstoned while this read was out. DEFER, do not complete: the
          // adoption never happened, so dropping the operator's browser-local
          // choice here destroyed the only remaining copy of it. The delete
          // itself removes this conversation's preference key when it lands,
          // and when it FAILS the conversation is still theirs and so is the
          // preference -- which a completed migration had already erased,
          // leaving the server override unset, the local copy gone and the key
          // marked migrated, unrecoverable by reload.
          migratedKeysRef.current.delete(preferenceKey);
          return;
        }
        if (
          (fresh.thread.runModel ?? null) !== null
          || (fresh.thread.runEffort ?? null) !== null
        ) {
          // Someone set an override while this tab held a stale projection.
          // Adopt theirs and drop the local copy rather than overwriting it.
          applyThreadUpdate(fresh.thread, migrationIssuedAt);
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
        applyThreadUpdate(next, migrationIssuedAt);
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
    const issuedAt = removedThreadsRef.current.epoch();
    // Optimistic straight away; the write itself queues behind whatever else
    // is already writing to this conversation, so the server sees the
    // operator's choices in the order they were made.
    applyThreadUpdate({
      ...thread,
      runModel: "model" in patch ? patch.model ?? null : previous.model,
      runEffort: "effort" in patch ? patch.effort ?? null : previous.effort,
    }, issuedAt);
    try {
      const next = await enqueueThreadWrite(thread.id, (signal) =>
        api.patchThread(thread.id, patch, signal));
      applyThreadUpdate(next, issuedAt);
      setActionError(null);
    } catch (patchError) {
      applyThreadUpdate(thread, issuedAt);
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
      setEffortByContext((current) => {
        const authored = Object.hasOwn(current, preferenceKey);
        const candidate = authored
          ? current[preferenceKey] ?? ""
          : selectedAgent?.runSettings.effective.effort ?? "";
        if (candidate === "" || nextEfforts.includes(candidate)) return current;
        // Deliberately materialize explicit null only when the inherited or
        // authored effort cannot run on the newly selected draft model.
        return { ...current, [preferenceKey]: "" };
      });
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
        if (threadCacheRef.current.patchThread(result.thread.id, result.thread)) {
          publishDetail(result.thread.id);
        }
        setActionError(null);
        // The POST already returned the conversation's new summary, applied
        // above; only its messages have to be read back.
        refreshSelectedThread();
      } catch (turnError) {
        setActionError(errorMessage(turnError));
        throw turnError;
      }
    },
    [createThread, publishDetail, refreshSelectedThread, selectedThread, settleThreadWrites],
  );

  const cancelTurn = useCallback(async () => {
    if (!selectedThreadId) return;
    try {
      const result = await api.cancelTurn(selectedThreadId);
      if (threadCacheRef.current.patchThread(result.thread.id, result.thread)) {
        publishDetail(result.thread.id);
      }
      // The sidebar row carries the "responding" marker, and it used to be
      // cleared by the bootstrap this cancel triggered. The cancel's own answer
      // already says the run is over, so apply it rather than wait for an event
      // that may never arrive on a stream that is down.
      patchRunState(result.thread.id, result.thread.runState);
      refreshSelectedThread();
    } catch (cancelError) {
      setActionError(errorMessage(cancelError));
      throw cancelError;
    }
  }, [patchRunState, publishDetail, refreshSelectedThread, selectedThreadId]);

  const sendLiveInput = useCallback(async (text: string) => {
    if (!selectedThreadId) throw new Error("Select a conversation before sending a follow-up.");
    try {
      const receipt = await api.liveInput(selectedThreadId, text);
      // Merged by version like any other projection. `replace` is for an answer
      // that is authoritative WITHOUT being newer -- the cron activity read --
      // and this is not one: a repair that landed while this receipt was on the
      // wire is a later version of the same row, and forcing this one over it
      // walked the transcript backwards.
      if (threadCacheRef.current.upsertMessage(selectedThreadId, receipt.message)) {
        publishDetail(selectedThreadId);
      }
      setActionError(null);
      refreshSelectedThread();
    } catch (liveInputError) {
      setActionError(errorMessage(liveInputError));
      throw liveInputError;
    }
  }, [publishDetail, refreshSelectedThread, selectedThreadId]);

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
      setAgentRunDefaults,
      clearAgentRunDefaults,
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
      loadFullToolCall,
      refreshReplyAttachmentAccess,
      clearCachedData,
      hasServerSnapshot,
      clearError: () => setError(null),
    }),
    [
      actionError,
      agents,
      archiveThread,
      clearCachedData,
      bootstrap,
      cancelTurn,
      clearAgentRunDefaults,
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
      hasServerSnapshot,
      loadBootstrap,
      loadMoreThreads,
      loadOlderMessages,
      loadCronRunActivity,
      loadFullToolCall,
      refreshReplyAttachmentAccess,
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
      setAgentRunDefaults,
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
