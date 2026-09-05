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
import { api, ApiError, THREAD_PAGE_LIMIT, type BootstrapScope } from "./api";
import { recordServerTime } from "./server-clock";
import { DEFAULT_UPLOAD_LIMITS } from "./types";
import type {
  AgentSummary,
  Bootstrap,
  CatalogModel,
  CronOverview,
  MessagePart,
  RunState,
  SkillRegistryState,
  StartTurnInput,
  ThreadDetail,
  ThreadSummary,
  WebEvent,
  WebMessage,
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
  /**
   * Replace one truncated tool call in the open conversation with its whole
   * body. Resolves to `true` when the transcript changed.
   */
  readonly loadFullToolCall: (toolCallId: string) => Promise<boolean>;
}

const ConsoleStore = createContext<ConsoleStoreValue | null>(null);

const byMostRecent = (a: ThreadSummary, b: ThreadSummary) =>
  Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
const threadBucketKey = (sourceId: string, archived: boolean): string =>
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

/**
 * Whether a message is the one that owns a tool call -- as a part of its own,
 * or as one of a delegation's children.
 *
 * The full-body route is addressed by (conversation, message, call) because a
 * tool-call id is not a capability, so the console has to name the message it
 * already holds the preview in.
 */
export const holdsToolCall = (message: WebMessage, toolCallId: string): boolean =>
  message.parts.some((part) =>
    (part.type === "tool-call" || part.type === "subagent")
      && (part.toolCallId === toolCallId
        || (part.type === "subagent"
          && part.calls.some((call) => call.toolCallId === toolCallId))));

/**
 * Put an untruncated tool call back where its preview was, as NEW objects.
 *
 * assistant-ui caches its part conversions by object identity, so a transcript
 * repaired in place goes on rendering the preview it already converted.
 */
export const mergeToolCallPart = (existing: MessagePart, full: MessagePart): MessagePart => {
  if (full.type !== "tool-call" && full.type !== "subagent") return existing;
  if (existing.type !== "tool-call" && existing.type !== "subagent") return existing;
  if (existing.toolCallId === full.toolCallId) return full;
  if (existing.type !== "subagent" || full.type !== "tool-call") return existing;
  if (!existing.calls.some((call) => call.toolCallId === full.toolCallId)) return existing;
  // A delegation's child owns no part of its own, so the route answers with the
  // tool call it would have been and it goes back into the group.
  const { type: _type, ...call } = full;
  return {
    ...existing,
    calls: existing.calls.map((candidate) =>
      candidate.toolCallId === full.toolCallId ? call : candidate),
  };
};

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

/** The later of two projections of one conversation, by the server's revision. */
const newerProjection = (
  held: ThreadSummary,
  fetched: ThreadSummary | undefined,
): ThreadSummary => (fetched === undefined || fetched.revision < held.revision ? held : fetched);

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
  const detailRef = useRef<ThreadDetail | null>(null);
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
  /** Set true by the first `ready`, so the next one is known to be a RECONNECT. */
  const streamOpenedRef = useRef(false);
  const hasBootstrapRef = useRef(false);

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

  const applyBootstrap = useCallback((rawNext: Bootstrap, issuedAt: number, archived: boolean) => {
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
    setError(null);
    setLoading(false);
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
  }, []);

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
    limit: THREAD_PAGE_LIMIT,
  }), []);

  const loadBootstrap = useCallback(async () => {
    try {
      // Bounded like every other read. See `THREAD_READ_TIMEOUT_MS`: the
      // tombstone's lifetime is only an upper bound on late responses while
      // the responses themselves have one.
      const issuedAt = removedThreadsRef.current.epoch();
      const scope = bootstrapScope();
      const next = await boundedRequest((signal) => api.bootstrap(signal, scope), THREAD_READ_TIMEOUT_MS);
      applyBootstrap(next, issuedAt, scope.archived === true);
      setConnection("live");
    } catch (loadError) {
      setError(errorMessage(loadError));
      setLoading(false);
      setConnection(navigator.onLine ? "reconnecting" : "offline");
    } finally {
      initialBootstrapRef.current = "answered";
    }
  }, [applyBootstrap, bootstrapScope]);

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
      (signal) => api.threads(sourceId, archived, before, signal),
      THREAD_READ_TIMEOUT_MS,
    );
    const key = threadBucketKey(sourceId, archived);
    const admitted = admitThreads(removedThreadsRef.current, page.threads, issuedAt);
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
    // A bootstrap that FAILED leaves no projection at all, and a page has
    // nowhere to land: `loadThreadBucket` no-ops when there is no bootstrap to
    // merge into, so the request would be spent and discarded. The console
    // shows its error state and the operator's retry is what fills the sidebar.
    if (selectedAgentId === null || loading || !hasBootstrap) return;
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
  }, [hasBootstrap, loadThreadBucket, loading, selectedAgentId, showArchived]);

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
    setDetail(null);
    persistThreadId(thread.sourceId, replacement?.id ?? null);
    updateThreadRoute(replacement, true);
    return true;
  }, []);

  const loadThread = useCallback(async (threadId: string, signal: AbortSignal) => {
    setDetailLoading(true);
    try {
      const issuedAt = removedThreadsRef.current.epoch();
      const next = await boundedRequest(
        (deadline) => api.thread(threadId, anySignal(signal, deadline)),
        THREAD_READ_TIMEOUT_MS,
      );
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
      if (selectedThreadRef.current === threadId) setDetail(next);
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
  }, [closeMissingThread, leaveRestoredArchivedThread]);

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
      const selectedForRefresh = scope.detail ? selectedThreadRef.current : null;
      const bucket = bootstrapScope();
      const [nextBootstrap, nextDetail] = await Promise.all([
        scope.bootstrap
          ? boundedRequest((signal) => api.bootstrap(signal, bucket), THREAD_READ_TIMEOUT_MS)
          : Promise.resolve(null),
        selectedForRefresh
          ? boundedRequest(
              (signal) => api.thread(selectedForRefresh, signal),
              THREAD_READ_TIMEOUT_MS,
            )
          : Promise.resolve(null),
      ]);
      if (nextBootstrap !== null) applyBootstrap(nextBootstrap, issuedAt, bucket.archived === true);
      if (
        nextDetail
        && admitThread(removedThreadsRef.current, nextDetail.thread, issuedAt)
        && selectedThreadRef.current === nextDetail.thread.id
      // Deliberately only the detail. The detail answer carries a summary of
      // the same row the listing carries, and the two reads are not ordered
      // against each other: merging it let a detail response overwrite a
      // FRESHER listing row it had no way to compare itself to. The sidebar row
      // is the listing's business, and `threads.changed` carries a new summary
      // when the server has one.
      ) setDetail(nextDetail);
    } catch (refreshError) {
      setActionError(errorMessage(refreshError));
    } finally {
      refreshInFlightRef.current = false;
      if (refreshQueuedRef.current) {
        refreshQueuedRef.current = false;
        scheduleRefreshRef.current({});
      }
    }
  }, [applyBootstrap, bootstrapScope]);

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
    }, REFRESH_DEBOUNCE_MS);
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
    () => { scheduleRefresh({ bootstrap: true, detail: true }); },
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
    setDetail((current) => current?.thread.id === threadId
      ? { ...current, thread: { ...current.thread, runState } }
      : current);
  }, []);

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
    setDetail((current) =>
      current?.thread.id === nextThread.id ? { ...current, thread: nextThread } : current,
    );
  }, []);

  useEffect(() => {
    const events = new EventSource("/api/v1/events");
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
      let webEvent: WebEvent | undefined;
      try {
        const parsed = JSON.parse((event as MessageEvent<string>).data) as WebEvent;
        if (parsed.version !== 1) return;
        recordServerTime(parsed.at);
        webEvent = parsed;
      } catch {
        // A ready ping without JSON still proves the stream is alive.
      }
      setConnection("live");
      if (webEvent === undefined) return;
      const payload = (webEvent.payload ?? {}) as {
        readonly thread?: ThreadSummary;
        readonly threadId?: string;
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
          // A RECONNECT may have missed anything at all, so it is the one event
          // that still costs a full bootstrap and a read of the open
          // conversation -- correctness over bytes, until a conditional GET
          // makes both nearly free.
          //
          // The FIRST one is not that. It arrives beside the snapshot this
          // component already asked for on mount, so answering it with another
          // bootstrap doubled the cost of every page load. Only a mount load
          // that answered with nothing is worth asking again for.
          const reconnected = streamOpenedRef.current;
          streamOpenedRef.current = true;
          if (
            reconnected
            || (initialBootstrapRef.current === "answered" && !hasBootstrapRef.current)
          ) queueRefresh();
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
            applyThreadUpdate(payload.thread, removedThreadsRef.current.epoch());
            // The summary IS the sidebar row and it is applied above, for every
            // conversation, at no cost. The MESSAGES are not in it: a finished
            // turn, a reconciled cron run and an appended notification all end
            // in this event and nothing else says the transcript moved. Only
            // the conversation on screen has anything to show for that.
            if (threadId === selectedThreadRef.current) refreshSelectedThread();
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
            if (threadId === selectedThreadRef.current) {
              selectedThreadRef.current = null;
              setSelectedThreadId(null);
              setDetail(null);
              setActionError("This conversation was deleted.");
            }
            return;
          }
          // A revision bump or a message id, and no summary to apply: only the
          // conversation on screen has anything to show for it.
          if (threadId !== undefined && threadId === selectedThreadRef.current) {
            refreshSelectedThread();
          }
          return;

        case "message.changed":
          if (threadId !== undefined && threadId === selectedThreadRef.current) {
            refreshSelectedThread();
          }
          return;

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
      "turn.changed",
      "attachment.changed",
      "push.pending",
    ];
    events.onopen = () => {
      // Same as `ready`: this transition back to "live" IS what refetches the
      // registry, through the skills effect's own dependency on `connection`.
      setConnection("live");
    };
    events.onmessage = handleEvent;
    for (const type of eventTypes) events.addEventListener(type, handleEvent);
    events.onerror = () => setConnection(navigator.onLine ? "reconnecting" : "offline");
    const onOnline = () => {
      // Nothing was observed while the link was down, so this is the other case
      // where the console cannot say what changed.
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
      if (threadListTimerRef.current !== null) window.clearTimeout(threadListTimerRef.current);
      // "This stream has already delivered its `ready`" is a fact about the
      // stream being closed here, not about the tab. Left set, a re-run of this
      // effect -- a StrictMode double mount, a future dependency change -- would
      // read the NEW stream's first `ready` as a reconnect and spend a bootstrap
      // answering the snapshot the previous mount had already read.
      streamOpenedRef.current = false;
    };
  }, [
    applyThreadUpdate,
    loadAgents,
    patchRunState,
    queueRefresh,
    refreshSelectedThread,
    revalidateBucket,
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
  detailRef.current = detail;
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

  // Deliberately stable: this is handed to the transcript through a context, and
  // a new identity on every streamed token would re-render every tool row for
  // the whole of a running turn.
  const loadFullToolCall = useCallback(async (toolCallId: string): Promise<boolean> => {
    const current = detailRef.current;
    if (current === null) return false;
    const message = current.messages.find((candidate) => holdsToolCall(candidate, toolCallId));
    if (message === undefined) return false;
    const part = await api.toolCallPart(current.thread.id, message.id, toolCallId);
    // The round trip is not instant, and the operator can leave the conversation
    // (or a refresh can evict the message) while it is in flight. Everything is
    // decided against the freshest COMMITTED detail, before the updater and
    // never inside it: a state updater is not guaranteed to run synchronously
    // and StrictMode runs it twice, so a flag set in there reports scheduling
    // rather than whether anything was replaced.
    const latest = detailRef.current;
    if (latest === null || latest.thread.id !== current.thread.id) return false;
    const target = latest.messages.find((candidate) => candidate.id === message.id);
    if (target === undefined) return false;
    const merged = target.parts.map((existing) => mergeToolCallPart(existing, part));
    if (merged.every((next, index) => next === target.parts[index])) return false;
    // A NEW message object, and new part objects inside it: assistant-ui caches
    // its conversions by object identity, so mutating in place would leave the
    // transcript showing the preview it already rendered.
    const repaired = { ...target, parts: merged };
    setDetail((committed) => committed?.thread.id === latest.thread.id
      ? {
          ...committed,
          messages: committed.messages.map((candidate) =>
            candidate.id === message.id ? repaired : candidate),
        }
      : committed);
    return true;
  }, []);

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
      // Only a row this tab HOLDS is evidence. With one bucket per bootstrap,
      // holding none for an agent means its bucket has not been fetched yet --
      // not that the operator's last conversation there is gone -- and clearing
      // the stored id here would throw away what the page is about to open on.
      if (recent !== undefined) persistThreadId(sourceId, recent.id);
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
      setActionError(null);
      if (thread === undefined) {
        const issuedAt = removedThreadsRef.current.epoch();
        void boundedRequest(
          (signal) => api.thread(threadId, signal),
          THREAD_READ_TIMEOUT_MS,
        ).then((next) => {
          const canonical = next.thread;
          // Deleted while this fetch was outstanding: selecting it now would
          // re-add it, route to it, and persist it as this agent's selection.
          if (!admitThread(removedThreadsRef.current, canonical, issuedAt)) return;
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
      const issuedAt = removedThreadsRef.current.epoch();
      const thread = await boundedRequest(
        (signal) => api.createThread(selectedAgentId, signal),
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
      const issuedAt = removedThreadsRef.current.epoch();
      const thread = await enqueueThreadWrite(target.id, (signal) =>
        api.patchThread(target.id, { archived: false }, signal));
      applyThreadUpdate(thread, issuedAt);
      operatorSelectionRef.current += 1;
      restoredSelectionRef.current = null;
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
    if (selectedThreadRef.current === thread.id || selectedThreadRef.current === requestedId) {
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
  }, [visibleThreads]);
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
  }, [applyThreadUpdate, completeThreadRemoval, fetchThreadSummary, queueRefresh]);

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
        // The POST already returned the conversation's new summary, applied
        // above; only its messages have to be read back.
        refreshSelectedThread();
      } catch (turnError) {
        setActionError(errorMessage(turnError));
        throw turnError;
      }
    },
    [createThread, refreshSelectedThread, selectedThread, settleThreadWrites],
  );

  const cancelTurn = useCallback(async () => {
    if (!selectedThreadId) return;
    try {
      const result = await api.cancelTurn(selectedThreadId);
      setDetail((current) =>
        current?.thread.id === result.thread.id ? { ...current, thread: result.thread } : current,
      );
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
  }, [patchRunState, refreshSelectedThread, selectedThreadId]);

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
      refreshSelectedThread();
    } catch (liveInputError) {
      setActionError(errorMessage(liveInputError));
      throw liveInputError;
    }
  }, [refreshSelectedThread, selectedThreadId]);

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
      loadFullToolCall,
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
      loadFullToolCall,
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
