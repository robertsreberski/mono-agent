import type {
  AgentSummary,
  AgentSkillRegistry,
  AskAnswer,
  AskSnapshot,
  AskSubmissionResult,
  Bootstrap,
  ChannelConfigView,
  CronJob,
  CronMutationResult,
  CronOverview,
  CronRun,
  CronRunPage,
  LiveInputReceipt,
  McpAppPart,
  McpAppResource,
  MessagePart,
  MemoryActionInput,
  MemoryAvailability,
  MemoryEditInput,
  MemoryGraph,
  MemoryGraphQuery,
  MemoryMutationAdmission,
  MemoryOperation,
  MemoryRecordDetail,
  MemoryRecordPage,
  MemoryRecordQuery,
  PushSubscriptionStatus,
  ProcessJobProjection,
  StartTurnInput,
  ThreadDetail,
  ThreadQuery,
  MessagePage,
  ThreadPage,
  ThreadSummary,
  WebAttachment,
  WebAgentPreferences,
  WebCollection,
  WebMessage,
  WebRunPreference,
  WebWorkflowStatus,
} from "./types";

export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

const readError = async (response: Response): Promise<ApiError> => {
  let message = `${response.status} ${response.statusText}`.trim();
  let code: string | undefined;
  try {
    const payload = (await response.json()) as {
      error?: string | { message?: string; code?: string };
      message?: string;
      code?: string;
    };
    if (typeof payload.error === "string") message = payload.error;
    if (payload.error && typeof payload.error === "object") {
      message = payload.error.message ?? message;
      code = payload.error.code;
    }
    message = payload.message ?? message;
    code = payload.code ?? code;
  } catch {
    // The status line is still useful when the response is not JSON.
  }
  return new ApiError(message, response.status, code);
};

const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(path, {
    ...init,
    headers: {
      Accept: "application/json",
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  if (!response.ok) throw await readError(response);
  return (await response.json()) as T;
};

type WireThreadSummary = Omit<
  ThreadSummary,
  "workflowStatus" | "pinned" | "collectionId" | "runPreference"
> & Partial<Pick<
  ThreadSummary,
  "workflowStatus" | "pinned" | "collectionId" | "runPreference"
>>;

type WireThreadPage = Omit<ThreadPage, "threads"> & {
  readonly threads: readonly WireThreadSummary[];
};

type WireThreadDetail = Omit<ThreadDetail, "thread"> & {
  readonly thread: WireThreadSummary;
};

type WireBootstrap = Omit<Bootstrap, "collections" | "threads"> & {
  readonly collections?: readonly WebCollection[];
  readonly threads: readonly WireThreadSummary[];
};

let legacyV1WithoutCollections = false;
let legacyV1SourceIds: readonly string[] = [];

const normalizeThreadSummary = (thread: WireThreadSummary): ThreadSummary => {
  const {
    workflowStatus,
    pinned,
    collectionId,
    runPreference,
    ...stable
  } = thread;
  return {
    ...stable,
    ...(stable.trigger === undefined
      ? { workflowStatus: workflowStatus ?? (stable.messageCount > 0 ? "in_progress" : "todo") }
      : {}),
    pinned: pinned ?? false,
    collectionId: collectionId ?? null,
    runPreference: runPreference ?? null,
  };
};

const normalizeThreadPage = (page: WireThreadPage): ThreadPage => ({
  ...page,
  threads: page.threads.map(normalizeThreadSummary),
});

const normalizeThreadDetail = (detail: WireThreadDetail): ThreadDetail => ({
  ...detail,
  thread: normalizeThreadSummary(detail.thread),
});

const normalizeBootstrap = (bootstrap: WireBootstrap): Bootstrap => {
  legacyV1WithoutCollections = bootstrap.collections === undefined;
  legacyV1SourceIds = legacyV1WithoutCollections
    ? [...new Set(bootstrap.agents.map(({ sourceId }) => sourceId))]
    : [];
  return {
    ...bootstrap,
    collections: bootstrap.collections ?? [],
    threads: bootstrap.threads.map(normalizeThreadSummary),
  };
};

const isLegacySourceIdRequired = (error: unknown): error is ApiError =>
  error instanceof ApiError
  && error.status === 400
  && (error.code === "invalid_page" || error.code === "invalid_request")
  && error.message === "sourceId is required.";

const compareDescendingText = (left: string, right: string): number =>
  left === right ? 0 : left < right ? 1 : -1;

const compareWorkspaceThreads = (left: ThreadSummary, right: ThreadSummary): number => {
  const pinOrder = Number(right.pinned) - Number(left.pinned);
  if (pinOrder !== 0) return pinOrder;
  const updatedOrder = Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
  if (Number.isFinite(updatedOrder) && updatedOrder !== 0) return updatedOrder;
  const updatedTextOrder = compareDescendingText(left.updatedAt, right.updatedAt);
  return updatedTextOrder !== 0
    ? updatedTextOrder
    : compareDescendingText(left.id, right.id);
};

const mergeLegacyThreadPages = (
  pages: readonly WireThreadPage[],
  limit: number,
): ThreadPage => {
  const threads = new Map<string, ThreadSummary>();
  for (const page of pages) {
    for (const candidate of page.threads.map(normalizeThreadSummary)) {
      const current = threads.get(candidate.id);
      if (
        current === undefined
        || candidate.revision > current.revision
        || (candidate.revision === current.revision
          && compareWorkspaceThreads(candidate, current) < 0)
      ) threads.set(candidate.id, candidate);
    }
  }
  return {
    threads: [...threads.values()].sort(compareWorkspaceThreads).slice(0, limit),
  };
};

const threadQueryString = (input: ThreadQuery): string => {
  const query = new URLSearchParams();
  for (const sourceId of input.sourceIds ?? []) query.append("sourceIds", sourceId);
  if (input.archived !== undefined) query.set("archived", String(input.archived));
  if (input.workflowStatus !== undefined) query.set("workflowStatus", input.workflowStatus);
  if (input.collectionId !== undefined) query.set("collectionId", input.collectionId);
  if (input.pinned !== undefined) query.set("pinned", String(input.pinned));
  if (input.type !== undefined) query.set("type", input.type);
  if (input.q !== undefined && input.q.trim()) query.set("q", input.q.trim());
  if (input.groupBy !== undefined) query.set("groupBy", input.groupBy);
  if (input.before !== undefined) query.set("before", input.before);
  query.set("limit", String(input.limit ?? 200));
  return query.toString();
};

/** Reject a compromised/stale DTO that tries to move a private rich-part request off origin. */
export const sameOriginReplyUrl = (value: string): string => {
  const url = new URL(value, window.location.origin);
  if (url.origin !== window.location.origin || !url.pathname.startsWith("/api/v1/threads/")) {
    throw new Error("The reply part endpoint is not on this console origin.");
  }
  return `${url.pathname}${url.search}`;
};

type ReplyAttachmentPart = Extract<MessagePart, { readonly type: "attachment" }>;
type RichReplyPart = ReplyAttachmentPart | McpAppPart;
type RichReplyType = RichReplyPart["type"];
const inFlightReplyAccessRefreshes = new WeakMap<
  AbortSignal,
  Map<string, Promise<RichReplyPart>>
>();

/** Adopt only the exact rich part returned by an authenticated access refresh. */
export type ReplyAccessRefreshHandler<T extends RichReplyType> = (
  part: Extract<RichReplyPart, { readonly type: T }>,
) => void;

interface ReplyEndpoint {
  readonly type: RichReplyType;
  readonly partId: string;
  readonly accessPath: string;
}

const replyEndpoint = (value: string): ReplyEndpoint => {
  const sameOrigin = sameOriginReplyUrl(value);
  const url = new URL(sameOrigin, window.location.origin);
  const match = /^\/api\/v1\/threads\/([^/]+)\/messages\/([^/]+)\/(reply-attachments|mcp-apps)\/([^/]+)(\/content|\/requests)?$/u
    .exec(url.pathname);
  if (match === null) throw new Error("The reply part endpoint has an invalid route.");
  const [, , , family, encodedPartId, suffix = ""] = match;
  const type = family === "reply-attachments" ? "attachment" : "mcp_app";
  if ((type === "attachment" && suffix !== "/content") || (type === "mcp_app" && suffix === "/content")) {
    throw new Error("The reply part endpoint has an invalid route.");
  }
  let partId: string;
  try {
    partId = decodeURIComponent(encodedPartId!);
  } catch {
    throw new Error("The reply part endpoint has an invalid identifier.");
  }
  const basePath = suffix.length === 0 ? url.pathname : url.pathname.slice(0, -suffix.length);
  return { type, partId, accessPath: `${basePath}/access` };
};

export const isReplyAccessExpired = (error: unknown): error is ApiError =>
  error instanceof ApiError && error.code === "reply_access_expired";

const refreshReplyPartAccess = async <T extends RichReplyType>(
  staleUrl: string,
  expectedType: T,
  signal?: AbortSignal,
): Promise<Extract<RichReplyPart, { readonly type: T }>> => {
  const endpoint = replyEndpoint(staleUrl);
  if (endpoint.type !== expectedType) throw new Error("The reply part endpoint type changed.");
  const payload = await request<{ readonly part: MessagePart }>(endpoint.accessPath, {
    method: "POST",
    headers: { "X-Mono-Agent-Web-Origin": window.location.origin },
    ...(signal === undefined ? {} : { signal }),
  });
  const part = payload.part;
  if (part.type !== expectedType || part.id !== endpoint.partId) {
    throw new Error("The refreshed reply part identity changed.");
  }
  let capabilityUrls: readonly string[];
  if (part.type === "attachment") {
    if (part.contentUrl === undefined) {
      throw new Error("The refreshed reply part has no private endpoint.");
    }
    capabilityUrls = [part.contentUrl];
  } else {
    if (part.resourceUrl === undefined || part.bridgeUrl === undefined) {
      throw new Error("The refreshed MCP App has incomplete private endpoints.");
    }
    capabilityUrls = [part.resourceUrl, part.bridgeUrl];
  }
  for (const capabilityUrl of capabilityUrls) {
    const refreshedEndpoint = replyEndpoint(capabilityUrl);
    if (
      refreshedEndpoint.type !== endpoint.type
      || refreshedEndpoint.partId !== endpoint.partId
      || refreshedEndpoint.accessPath !== endpoint.accessPath
    ) {
      throw new Error("The refreshed reply part binding changed.");
    }
  }
  return part as Extract<RichReplyPart, { readonly type: T }>;
};

const coordinatedReplyPartAccessRefresh = async <T extends RichReplyType>(
  staleUrl: string,
  expectedType: T,
  signal?: AbortSignal,
): Promise<Extract<RichReplyPart, { readonly type: T }>> => {
  if (signal === undefined) return await refreshReplyPartAccess(staleUrl, expectedType);
  const endpoint = replyEndpoint(staleUrl);
  const key = `${expectedType}:${endpoint.accessPath}`;
  let byEndpoint = inFlightReplyAccessRefreshes.get(signal);
  if (byEndpoint === undefined) {
    byEndpoint = new Map();
    inFlightReplyAccessRefreshes.set(signal, byEndpoint);
  }
  let pending = byEndpoint.get(key);
  if (pending === undefined) {
    pending = refreshReplyPartAccess(staleUrl, expectedType, signal).finally(() => {
      if (byEndpoint?.get(key) === pending) byEndpoint.delete(key);
      if (byEndpoint?.size === 0) inFlightReplyAccessRefreshes.delete(signal);
    });
    byEndpoint.set(key, pending);
  }
  const refreshed = await pending;
  if (refreshed.type !== expectedType) throw new Error("The refreshed reply part type changed.");
  return refreshed as Extract<RichReplyPart, { readonly type: T }>;
};

const withReplyAccessRetry = async <T extends RichReplyType, TResult>(
  initialUrl: string,
  type: T,
  refreshedUrl: (part: Extract<RichReplyPart, { readonly type: T }>) => string | undefined,
  operation: (url: string) => Promise<TResult>,
  signal?: AbortSignal,
  onAccessRefreshed?: ReplyAccessRefreshHandler<T>,
): Promise<TResult> => {
  try {
    return await operation(sameOriginReplyUrl(initialUrl));
  } catch (error) {
    if (!isReplyAccessExpired(error) || signal?.aborted === true) throw error;
  }
  const refreshed = await coordinatedReplyPartAccessRefresh(initialUrl, type, signal);
  const nextUrl = refreshedUrl(refreshed);
  if (nextUrl === undefined) throw new Error("The refreshed reply part has no private endpoint.");
  const boundNextUrl = sameOriginReplyUrl(nextUrl);
  signal?.throwIfAborted();
  // The caller owns the in-memory DTO projection. Hand it only the validated,
  // exact-type/exact-id refresh result so later operations can stop replaying
  // the stale capability without granting any broader renewal authority.
  onAccessRefreshed?.(refreshed);
  // Only an authenticated expiry response reaches this retry, and the newly
  // minted request is attempted exactly once.
  return await operation(boundNextUrl);
};

const cronMutation = async <T>(path: string, body: Readonly<Record<string, unknown>>): Promise<CronMutationResult<T>> => {
  const response = await fetch(path, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-Mono-Agent-Web-Origin": window.location.origin,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok && response.status !== 428) throw await readError(response);
  return await response.json() as CronMutationResult<T>;
};

const memoryBasePath = (sourceId: string): string =>
  `/api/v1/agents/${encodeURIComponent(sourceId)}/memory`;

const memoryRecordQueryString = (input: MemoryRecordQuery): string => {
  const query = new URLSearchParams();
  if (input.q !== undefined && input.q.trim()) query.set("q", input.q.trim());
  if (input.lifecycle !== undefined) query.set("lifecycle", input.lifecycle);
  if (input.type !== undefined) query.set("type", input.type);
  if (input.collection !== undefined && input.collection.trim()) {
    query.set("collection", input.collection.trim());
  }
  if (input.limit !== undefined) query.set("limit", String(input.limit));
  if (input.before !== undefined) query.set("before", input.before);
  return query.toString();
};

const memoryGraphQueryString = (input: MemoryGraphQuery): string => {
  const query = new URLSearchParams();
  if (input.focusId !== undefined) query.set("focusId", input.focusId);
  if (input.includeHistory !== undefined) query.set("includeHistory", String(input.includeHistory));
  if (input.limit !== undefined) query.set("limit", String(input.limit));
  return query.toString();
};

const memoryMutation = async (
  path: string,
  method: "PATCH" | "POST",
  body: MemoryActionInput | MemoryEditInput,
  signal: AbortSignal | undefined,
  confirmationAllowed: boolean,
): Promise<MemoryMutationAdmission> => {
  const response = await fetch(path, {
    method,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-Mono-Agent-Web-Origin": window.location.origin,
    },
    body: JSON.stringify(body),
    ...(signal === undefined ? {} : { signal }),
  });
  if (response.status !== 202 && !(confirmationAllowed && response.status === 428)) {
    if (!response.ok) throw await readError(response);
    throw new ApiError("Memory mutation returned an unexpected status.", response.status);
  }
  const admission = await response.json() as unknown;
  const kind = typeof admission === "object" && admission !== null && "kind" in admission
    ? admission.kind
    : undefined;
  const expectedKind = response.status === 202 ? "queued" : "confirmation_required";
  if (kind !== expectedKind) {
    throw new ApiError("Memory mutation returned an unexpected response.", 502, "invalid_memory_response");
  }
  return admission as MemoryMutationAdmission;
};

export const api = {
  bootstrap: async (signal?: AbortSignal) =>
    normalizeBootstrap(await request<WireBootstrap>("/api/v1/bootstrap", { signal })),

  thread: async (threadId: string, signal?: AbortSignal) =>
    normalizeThreadDetail(await request<WireThreadDetail>(
      `/api/v1/threads/${encodeURIComponent(threadId)}`,
      { signal },
    )),

  threads: async (sourceId: string, archived: boolean, before?: string, signal?: AbortSignal) => {
    const query = new URLSearchParams({ sourceId, archived: String(archived), limit: "200" });
    if (before !== undefined) query.set("before", before);
    return normalizeThreadPage(await request<WireThreadPage>(
      `/api/v1/threads?${query.toString()}`,
      { signal },
    ));
  },

  workspaceThreads: async (input: ThreadQuery, signal?: AbortSignal) => {
    try {
      return normalizeThreadPage(await request<WireThreadPage>(
        `/api/v1/threads?${threadQueryString(input)}`,
        { signal },
      ));
    } catch (error) {
      const sourceIds = input.sourceIds?.length
        ? [...new Set(input.sourceIds)]
        : legacyV1WithoutCollections
          ? legacyV1SourceIds
          : [];
      if (!isLegacySourceIdRequired(error) || sourceIds.length === 0) throw error;
      signal?.throwIfAborted();
      const archived = input.archived ?? false;
      const limit = input.limit ?? 200;
      const pages = await Promise.all(sourceIds.map(async (sourceId) => {
        const query = new URLSearchParams({
          sourceId,
          archived: String(archived),
          limit: String(limit),
        });
        return await request<WireThreadPage>(
          `/api/v1/threads?${query.toString()}`,
          { signal },
        );
      }));
      return mergeLegacyThreadPages(pages, limit);
    }
  },

  messages: (threadId: string, before: string, signal?: AbortSignal) => {
    const query = new URLSearchParams({ before, limit: "100" });
    return request<MessagePage>(
      `/api/v1/threads/${encodeURIComponent(threadId)}/messages?${query.toString()}`,
      { signal },
    );
  },

  messagesAround: (threadId: string, anchor: string, signal?: AbortSignal) => {
    const query = new URLSearchParams({ anchor, limit: "100" });
    return request<MessagePage>(
      `/api/v1/threads/${encodeURIComponent(threadId)}/messages?${query.toString()}`,
      { signal },
    );
  },

  threadJob: async (threadId: string, jobId: string, signal?: AbortSignal) => {
    const result = await request<{ job: ProcessJobProjection }>(
      `/api/v1/threads/${encodeURIComponent(threadId)}/jobs/${encodeURIComponent(jobId)}`,
      { signal },
    );
    return result.job;
  },

  createThread: async (sourceId: string) => {
    const result = await request<{ thread: WireThreadSummary }>("/api/v1/threads", {
      method: "POST",
      body: JSON.stringify({ sourceId }),
    });
    return normalizeThreadSummary(result.thread);
  },

  patchAgent: async (sourceId: string, pinned: boolean) => {
    const result = await request<{ agent: AgentSummary }>(
      `/api/v1/agents/${encodeURIComponent(sourceId)}`,
      { method: "PATCH", body: JSON.stringify({ pinned }) },
    );
    return result.agent;
  },

  agentSkills: (sourceId: string, signal?: AbortSignal) =>
    request<AgentSkillRegistry>(
      `/api/v1/agents/${encodeURIComponent(sourceId)}/skills`,
      { signal },
    ),

  patchThread: async (
    threadId: string,
    patch: {
      title?: string;
      archived?: boolean;
      workflowStatus?: WebWorkflowStatus;
      pinned?: boolean;
      collectionId?: string | null;
      runPreference?: WebRunPreference | null;
      expectedRevision?: number;
    },
  ) => {
    const result = await request<{ thread: WireThreadSummary }>(
      `/api/v1/threads/${encodeURIComponent(threadId)}`,
      { method: "PATCH", body: JSON.stringify(patch) },
    );
    return normalizeThreadSummary(result.thread);
  },

  collections: async (signal?: AbortSignal) => {
    const result = await request<{ collections: readonly WebCollection[] }>(
      "/api/v1/collections",
      { signal },
    );
    return result.collections;
  },

  createCollection: async (name: string) => {
    const result = await request<{ collection: WebCollection }>("/api/v1/collections", {
      method: "POST",
      body: JSON.stringify({ name }),
    });
    return result.collection;
  },

  patchCollection: async (collectionId: string, name: string) => {
    const result = await request<{ collection: WebCollection }>(
      `/api/v1/collections/${encodeURIComponent(collectionId)}`,
      { method: "PATCH", body: JSON.stringify({ name }) },
    );
    return result.collection;
  },

  deleteCollection: async (collectionId: string) => {
    const response = await fetch(`/api/v1/collections/${encodeURIComponent(collectionId)}`, {
      method: "DELETE",
      headers: { Accept: "application/json" },
    });
    if (!response.ok) throw await readError(response);
  },

  agentPreferences: async (sourceId: string, signal?: AbortSignal) => {
    try {
      const result = await request<{ preferences: WebAgentPreferences }>(
        `/api/v1/agents/${encodeURIComponent(sourceId)}/preferences`,
        { signal },
      );
      return result.preferences;
    } catch (error) {
      if (legacyV1WithoutCollections && error instanceof ApiError && error.status === 404) {
        return { sourceId, runPreference: null };
      }
      throw error;
    }
  },

  patchAgentPreferences: async (
    sourceId: string,
    runPreference: WebRunPreference | null,
  ) => {
    const result = await request<{ preferences: WebAgentPreferences }>(
      `/api/v1/agents/${encodeURIComponent(sourceId)}/preferences`,
      { method: "PATCH", body: JSON.stringify({ runPreference }) },
    );
    return result.preferences;
  },

  deleteThread: async (threadId: string) => {
    const response = await fetch(`/api/v1/threads/${encodeURIComponent(threadId)}`, {
      method: "DELETE",
      headers: { Accept: "application/json" },
    });
    if (!response.ok) throw await readError(response);
  },

  startTurn: async (threadId: string, input: StartTurnInput) => {
    const result = await request<{
      thread: WireThreadSummary;
      turn: { id: string; status: string };
    }>(
      `/api/v1/threads/${encodeURIComponent(threadId)}/turns`,
      { method: "POST", body: JSON.stringify(input) },
    );
    return { ...result, thread: normalizeThreadSummary(result.thread) };
  },

  liveInput: async (threadId: string, text: string) =>
    request<LiveInputReceipt>(
      `/api/v1/threads/${encodeURIComponent(threadId)}/live-input`,
      { method: "POST", body: JSON.stringify({ text }) },
    ),

  cancelTurn: async (threadId: string) => {
    const result = await request<{ cancelled: true; thread: WireThreadSummary }>(
      `/api/v1/threads/${encodeURIComponent(threadId)}/cancel`,
      { method: "POST" },
    );
    return { ...result, thread: normalizeThreadSummary(result.thread) };
  },

  pendingAsk: async (threadId: string, signal?: AbortSignal) => {
    const result = await request<{ ask: AskSnapshot | null }>(
      `/api/v1/threads/${encodeURIComponent(threadId)}/ask`,
      { signal },
    );
    return result.ask ?? undefined;
  },

  ask: async (threadId: string, interactionId: string, signal?: AbortSignal) => {
    const result = await request<{ ask: AskSnapshot | null }>(
      `/api/v1/threads/${encodeURIComponent(threadId)}/ask/${encodeURIComponent(interactionId)}`,
      { signal },
    );
    return result.ask ?? undefined;
  },

  submitAsk: async (threadId: string, interactionId: string, answers: readonly AskAnswer[]) =>
    request<AskSubmissionResult>(`/api/v1/threads/${encodeURIComponent(threadId)}/ask`, {
      method: "POST",
      body: JSON.stringify({ interactionId, answers }),
    }),

  cronOverview: (sourceId: string, signal?: AbortSignal) =>
    request<CronOverview>(`/api/v1/agents/${encodeURIComponent(sourceId)}/cron`, { signal }),

  cronRuns: (sourceId: string, jobId: string, before?: string, signal?: AbortSignal) => {
    const query = new URLSearchParams({ limit: "100" });
    if (before !== undefined) query.set("before", before);
    return request<CronRunPage>(
      `/api/v1/agents/${encodeURIComponent(sourceId)}/cron/jobs/${encodeURIComponent(jobId)}/runs?${query.toString()}`,
      { signal },
    );
  },

  cronRun: async (sourceId: string, jobId: string, runId: string, signal?: AbortSignal) => {
    const result = await request<{ message: WebMessage }>(
      `/api/v1/agents/${encodeURIComponent(sourceId)}/cron/jobs/${encodeURIComponent(jobId)}/runs/${encodeURIComponent(runId)}`,
      { signal },
    );
    return result.message;
  },

  cronConfigView: async (sourceId: string, signal?: AbortSignal) => {
    const result = await request<{ configView: ChannelConfigView }>(
      `/api/v1/agents/${encodeURIComponent(sourceId)}/cron/config-view`,
      { signal },
    );
    return result.configView;
  },

  cronRunNow: (
    sourceId: string,
    jobId: string,
    idempotencyKey: string,
    confirmationToken?: string,
  ) => cronMutation<{ readonly run: CronRun }>(
    `/api/v1/agents/${encodeURIComponent(sourceId)}/cron/jobs/${encodeURIComponent(jobId)}/run`,
    { idempotencyKey, ...(confirmationToken === undefined ? {} : { confirmationToken }) },
  ),

  cronSetEnabled: (
    sourceId: string,
    jobId: string,
    enabled: boolean,
    idempotencyKey: string,
    confirmationToken?: string,
  ) => cronMutation<{ readonly job: CronJob }>(
    `/api/v1/agents/${encodeURIComponent(sourceId)}/cron/jobs/${encodeURIComponent(jobId)}/effective-enabled`,
    { enabled, idempotencyKey, ...(confirmationToken === undefined ? {} : { confirmationToken }) },
  ),

  memoryOverview: (sourceId: string, signal?: AbortSignal) =>
    request<MemoryAvailability>(memoryBasePath(sourceId), { signal }),

  memoryRecords: (
    sourceId: string,
    input: MemoryRecordQuery = {},
    signal?: AbortSignal,
  ) => {
    const query = memoryRecordQueryString(input);
    return request<MemoryRecordPage>(
      `${memoryBasePath(sourceId)}/records${query ? `?${query}` : ""}`,
      { signal },
    );
  },

  memoryRecord: (
    sourceId: string,
    recordId: string,
    signal?: AbortSignal,
  ) => request<MemoryRecordDetail>(
    `${memoryBasePath(sourceId)}/records/${encodeURIComponent(recordId)}`,
    { signal },
  ),

  memoryGraph: async (
    sourceId: string,
    input: MemoryGraphQuery = {},
    signal?: AbortSignal,
  ) => {
    const query = memoryGraphQueryString(input);
    const result = await request<{ readonly graph: MemoryGraph }>(
      `${memoryBasePath(sourceId)}/graph${query ? `?${query}` : ""}`,
      { signal },
    );
    return result.graph;
  },

  memoryOperation: async (
    sourceId: string,
    operationId: string,
    signal?: AbortSignal,
  ) => {
    const result = await request<{ readonly operation: MemoryOperation }>(
      `${memoryBasePath(sourceId)}/operations/${encodeURIComponent(operationId)}`,
      { signal },
    );
    return result.operation;
  },

  editMemoryRecord: (
    sourceId: string,
    recordId: string,
    input: MemoryEditInput,
    signal?: AbortSignal,
  ) => memoryMutation(
    `${memoryBasePath(sourceId)}/records/${encodeURIComponent(recordId)}`,
    "PATCH",
    input,
    signal,
    false,
  ),

  forgetMemoryRecord: (
    sourceId: string,
    recordId: string,
    input: MemoryActionInput,
    signal?: AbortSignal,
  ) => memoryMutation(
    `${memoryBasePath(sourceId)}/records/${encodeURIComponent(recordId)}/forget`,
    "POST",
    input,
    signal,
    true,
  ),

  restoreMemoryRecord: (
    sourceId: string,
    recordId: string,
    input: MemoryActionInput,
    signal?: AbortSignal,
  ) => memoryMutation(
    `${memoryBasePath(sourceId)}/records/${encodeURIComponent(recordId)}/restore`,
    "POST",
    input,
    signal,
    false,
  ),

  registerPushSubscription: async (subscription: PushSubscription, previousSubscriptionId?: string) => {
    const serialized = subscription.toJSON();
    const p256dh = serialized.keys?.p256dh;
    const auth = serialized.keys?.auth;
    if (typeof p256dh !== "string" || typeof auth !== "string") {
      throw new Error("The browser returned an incomplete push subscription.");
    }
    const result = await request<{ subscription: PushSubscriptionStatus }>("/api/v1/push/subscriptions", {
      method: "PUT",
      headers: { "X-Mono-Agent-Web-Origin": window.location.origin },
      body: JSON.stringify({
        endpoint: subscription.endpoint,
        expirationTime: subscription.expirationTime,
        keys: { p256dh, auth },
        ...(previousSubscriptionId === undefined ? {} : { previousSubscriptionId }),
      }),
    });
    return result.subscription;
  },

  pushSubscription: async (id: string) => {
    const result = await request<{ subscription: PushSubscriptionStatus }>(
      `/api/v1/push/subscriptions/${encodeURIComponent(id)}`,
      { headers: { "X-Mono-Agent-Web-Origin": window.location.origin } },
    );
    return result.subscription;
  },

  deletePushSubscription: async (id: string) => {
    const response = await fetch(`/api/v1/push/subscriptions/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: { Accept: "application/json" },
    });
    if (!response.ok) throw await readError(response);
  },

  testPushSubscription: async (id: string) => {
    const result = await request<{ subscription: PushSubscriptionStatus }>(
      `/api/v1/push/subscriptions/${encodeURIComponent(id)}/test`,
      { method: "POST" },
    );
    return result.subscription;
  },

  acknowledgePushEvent: async (eventId: string, subscriptionId: string, ackToken: string) => {
    const response = await fetch(`/api/v1/push/events/${encodeURIComponent(eventId)}/ack`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ subscriptionId, ackToken }),
    });
    if (!response.ok) throw await readError(response);
  },

  createUpload: async (file: File) => {
    const result = await request<{ attachment: WebAttachment }>("/api/v1/uploads", {
      method: "POST",
      body: JSON.stringify({
        name: file.name,
        contentType: file.type || "application/octet-stream",
        sizeBytes: file.size,
      }),
    });
    return result.attachment;
  },

  deleteUpload: async (uploadId: string) => {
    const response = await fetch(`/api/v1/uploads/${encodeURIComponent(uploadId)}`, {
      method: "DELETE",
      headers: { Accept: "application/json" },
    });
    if (!response.ok) throw await readError(response);
  },

  replyAttachmentContent: (
    contentUrl: string,
    signal?: AbortSignal,
    onAccessRefreshed?: ReplyAccessRefreshHandler<"attachment">,
  ) =>
    withReplyAccessRetry(
      contentUrl,
      "attachment",
      (part) => part.contentUrl,
      async (url) => {
        const response = await fetch(url, {
          headers: { Accept: "application/octet-stream" },
          ...(signal === undefined ? {} : { signal }),
        });
        if (!response.ok) throw await readError(response);
        return response;
      },
      signal,
      onAccessRefreshed,
    ),

  mcpAppResource: (
    resourceUrl: string,
    signal?: AbortSignal,
    onAccessRefreshed?: ReplyAccessRefreshHandler<"mcp_app">,
  ) =>
    withReplyAccessRetry(
      resourceUrl,
      "mcp_app",
      (part) => part.resourceUrl,
      (url) => request<McpAppResource>(url, { signal }),
      signal,
      onAccessRefreshed,
    ),

  mcpAppRequest: async (
    bridgeUrl: string,
    method: "resources/read" | "tools/call" | "ui/open-link" | "ui/update-model-context",
    params: unknown,
    confirmed: boolean,
    signal?: AbortSignal,
    onAccessRefreshed?: ReplyAccessRefreshHandler<"mcp_app">,
  ) => {
    return await withReplyAccessRetry(
      bridgeUrl,
      "mcp_app",
      (part) => part.bridgeUrl,
      async (url) => {
        const payload = await request<{ readonly result: unknown }>(url, {
          method: "POST",
          headers: { "X-Mono-Agent-Web-Origin": window.location.origin },
          body: JSON.stringify({ method, params, confirmed }),
          signal,
        });
        return payload.result;
      },
      signal,
      onAccessRefreshed,
    );
  },
};

export const uploadContent = (
  upload: WebAttachment,
  file: File,
  onProgress: (progress: number) => void,
  signal?: AbortSignal,
): Promise<WebAttachment> =>
  new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const onAbort = () => xhr.abort();
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    if (signal?.aborted) {
      reject(new DOMException("The upload was cancelled.", "AbortError"));
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    xhr.open("PUT", `/api/v1/uploads/${encodeURIComponent(upload.id)}/content`);
    xhr.responseType = "json";
    // The reservation already stores the declared MIME. The content endpoint
    // deliberately accepts only an opaque byte stream.
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.setRequestHeader("Accept", "application/json");
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) {
        onProgress(Math.min(99, Math.round((event.loaded / event.total) * 100)));
      }
    };
    xhr.onerror = () => {
      cleanup();
      reject(new Error("The upload connection was interrupted."));
    };
    xhr.onabort = () => {
      cleanup();
      reject(new DOMException("The upload was cancelled.", "AbortError"));
    };
    xhr.onload = () => {
      cleanup();
      const payload = xhr.response as
        | { attachment?: WebAttachment; error?: string | { message?: string } }
        | null;
      if (xhr.status < 200 || xhr.status >= 300 || !payload?.attachment) {
        const message =
          typeof payload?.error === "string"
            ? payload.error
            : payload?.error?.message ?? `Upload failed with status ${xhr.status}.`;
        reject(new ApiError(message, xhr.status));
        return;
      }
      onProgress(100);
      resolve(payload.attachment);
    };
    xhr.send(file);
  });
