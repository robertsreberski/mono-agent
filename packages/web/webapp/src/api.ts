import type {
  AgentSkillRegistry,
  AgentSummary,
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
  MessagePage,
  MessagePart,
  ModelCatalogPage,
  ProcessJobProjection,
  PushSubscriptionStatus,
  StartTurnInput,
  ThreadDetail,
  ThreadPage,
  ThreadSearchPage,
  ThreadSummary,
  WebAttachment,
  WebMessage,
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

/**
 * One request, and the response it is worth reading.
 *
 * `304` is let through, but only for a READ: it is the answer to a conditional
 * GET -- see {@link NOT_MODIFIED} -- and `readError` would turn the cheapest
 * response the server can give into a thrown "304 Not Modified". A write that
 * came back 304 is not an answer to anything this console asked, so it stays a
 * reported failure rather than a silent success.
 */
const send = async (path: string, init?: RequestInit): Promise<Response> => {
  const response = await fetch(path, {
    ...init,
    headers: {
      Accept: "application/json",
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  const method = (init?.method ?? "GET").toUpperCase();
  if (!response.ok && !(response.status === 304 && method === "GET")) throw await readError(response);
  return response;
};

const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const response = await send(path, init);
  // Only a conditional read can be answered this way, and this one quoted no
  // validator: there is no held copy for the status line to confirm, so there
  // is nothing to return. Reported rather than papered over with an empty body.
  if (response.status === 304) {
    throw new ApiError("The server answered a read that quoted no validator with 304.", 304);
  }
  return (await response.json()) as T;
};

/**
 * The server's answer to a conditional read: what this console holds is still
 * current.
 *
 * A distinct value rather than `undefined`, so a caller that forgets to handle
 * it fails a type check instead of quietly reading it as "nothing there".
 */
export const NOT_MODIFIED = Symbol("not modified");
export type NotModified = typeof NOT_MODIFIED;

/** A response body, plus the validator a later read of it may quote. */
type Validated<T> = T & { readonly etag?: string };

/** A conversation read, carrying the validator its response was served with. */
export type ReadThreadDetail = Validated<ThreadDetail>;

const validatedRequest = async <T>(
  path: string,
  etag: string | undefined,
  init?: RequestInit,
): Promise<Validated<T> | NotModified> => {
  const response = await send(path, {
    ...init,
    headers: {
      ...init?.headers,
      ...(etag === undefined ? {} : { "If-None-Match": etag }),
    },
  });
  if (response.status === 304) return NOT_MODIFIED;
  const value = (await response.json()) as T;
  const served = response.headers.get("ETag");
  return { ...value, ...(served === null ? {} : { etag: served }) };
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

/**
 * How much of one bucket the sidebar asks for.
 *
 * It used to ask for 200 rows -- the server's whole per-bucket cap -- on every
 * agent switch, every archive toggle and every cron refresh, which is the same
 * page the bootstrap had just delivered. A sidebar shows a handful of rows and
 * pages from there, so a page is what it now requests.
 */
export const THREAD_PAGE_LIMIT = 50;

/**
 * The bucket a bootstrap should carry.
 *
 * A bootstrap answers with one page of one `(sourceId, archived)` bucket and
 * says which one it chose. An absent `sourceId` is answered with the agent of
 * the current conversation rather than refused, which is what a console with
 * no stored selection asks for on its very first request.
 */
export interface BootstrapScope {
  readonly sourceId?: string;
  readonly archived?: boolean;
  readonly limit?: number;
}

export const api = {
  bootstrap: (signal?: AbortSignal, scope?: BootstrapScope) => {
    const query = new URLSearchParams();
    if (scope?.sourceId !== undefined) query.set("sourceId", scope.sourceId);
    if (scope?.archived !== undefined) query.set("archived", String(scope.archived));
    if (scope?.limit !== undefined) query.set("limit", String(scope.limit));
    const search = query.toString();
    return request<Bootstrap>(
      search === "" ? "/api/v1/bootstrap" : `/api/v1/bootstrap?${search}`,
      { signal },
    );
  },

  /**
   * One whole conversation, with the validator the response carried.
   *
   * The `etag` rides along on every read so a later one can quote it. It is an
   * ADDITION to {@link ThreadDetail}, so nothing that only wants the transcript
   * has to know about it.
   */
  thread: async (threadId: string, signal?: AbortSignal): Promise<ReadThreadDetail> => {
    const read = await validatedRequest<ThreadDetail>(
      `/api/v1/threads/${encodeURIComponent(threadId)}`,
      undefined,
      { signal },
    );
    // Unreachable: `validatedRequest` only answers this way to a request that
    // quoted a validator, and this one quoted none.
    if (read === NOT_MODIFIED) {
      throw new ApiError("The server answered a read that quoted no validator with 304.", 304);
    }
    return read;
  },

  /**
   * The same conversation, read CONDITIONALLY.
   *
   * {@link NOT_MODIFIED} is the server confirming what this console already
   * holds, for the cost of a status line instead of a transcript -- which is
   * what makes a reconnect or an app-switch resume nearly free. Never `?full=1`
   * for the same reason {@link api.message} is not: the console's held copy is
   * the DEFAULT shape, and deltas chain onto it.
   */
  threadIfChanged: (threadId: string, etag: string, signal?: AbortSignal) =>
    validatedRequest<ThreadDetail>(
      `/api/v1/threads/${encodeURIComponent(threadId)}`,
      etag,
      { signal },
    ),

  threads: (
    sourceId: string,
    archived: boolean,
    before?: string,
    signal?: AbortSignal,
    limit: number = THREAD_PAGE_LIMIT,
  ) => {
    const query = new URLSearchParams({
      sourceId,
      archived: String(archived),
      limit: String(limit),
    });
    if (before !== undefined) query.set("before", before);
    return request<ThreadPage>(`/api/v1/threads?${query.toString()}`, { signal });
  },

  /**
   * Server-side search over titles and message prose. Unlike `threads`, this is
   * not limited to a loaded page: it is the only way to reach a conversation
   * older than the sidebar has fetched.
   */
  searchThreads: (sourceId: string, query: string, signal?: AbortSignal) => {
    const params = new URLSearchParams({ sourceId, q: query });
    return request<ThreadSearchPage>(
      `/api/v1/threads/search?${params.toString()}`,
      { signal },
    );
  },

  /**
   * One tool call's untruncated payloads, for a row the server sent a preview
   * of. Addressed by (conversation, message, call): the tool-call id alone is
   * not a capability and the server refuses it on its own.
   */
  toolCallPart: async (
    threadId: string,
    messageId: string,
    toolCallId: string,
    signal?: AbortSignal,
  ) => {
    const result = await request<{ readonly part: MessagePart }>(
      `/api/v1/threads/${encodeURIComponent(threadId)}`
      + `/messages/${encodeURIComponent(messageId)}`
      + `/tool-calls/${encodeURIComponent(toolCallId)}`,
      { ...(signal === undefined ? {} : { signal }) },
    );
    return result.part;
  },

  /**
   * ONE message, by id.
   *
   * What a console reads when a `message.delta` cannot be applied: the version
   * it holds is not the one the ops were diffed against, the message is not
   * held at all, or a hint named a row it already has. Repairing one message is
   * the alternative to re-reading the whole conversation around it, which is
   * the cost the delta stream exists to remove.
   *
   * Never `?full=1`: deltas describe the DEFAULT shape, and a transcript read
   * untruncated could not take one.
   */
  message: async (threadId: string, messageId: string, signal?: AbortSignal) => {
    const result = await request<{ readonly message: WebMessage }>(
      `/api/v1/threads/${encodeURIComponent(threadId)}`
      + `/messages/${encodeURIComponent(messageId)}`,
      { ...(signal === undefined ? {} : { signal }) },
    );
    return result.message;
  },

  messages: (threadId: string, before: string, signal?: AbortSignal) => {
    const query = new URLSearchParams({ before, limit: "100" });
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

  /**
   * `signal` because the server commits and emits the creation event BEFORE it
   * answers this POST, so a held response describes a conversation the console
   * may already know about -- and may already have deleted. The caller bounds
   * it for the same reason it bounds every write.
   */
  createThread: async (
    sourceId: string,
    runConfig: { readonly model?: string | null; readonly effort?: string | null } = {},
    signal?: AbortSignal,
  ) => {
    const result = await request<{ thread: ThreadSummary }>("/api/v1/threads", {
      method: "POST",
      body: JSON.stringify({ sourceId, ...runConfig }),
      ...(signal === undefined ? {} : { signal }),
    });
    return result.thread;
  },

  patchAgent: async (sourceId: string, pinned: boolean) => {
    const result = await request<{ agent: AgentSummary }>(
      `/api/v1/agents/${encodeURIComponent(sourceId)}`,
      { method: "PATCH", body: JSON.stringify({ pinned }) },
    );
    return result.agent;
  },

  setAgentRunDefaults: async (
    sourceId: string,
    input: { readonly model: string | null; readonly effort: string | null },
  ) => {
    const result = await request<{ agent: AgentSummary }>(
      `/api/v1/agents/${encodeURIComponent(sourceId)}/run-defaults`,
      { method: "PUT", body: JSON.stringify(input) },
    );
    return result.agent;
  },

  clearAgentRunDefaults: async (sourceId: string) => {
    const result = await request<{ agent: AgentSummary }>(
      `/api/v1/agents/${encodeURIComponent(sourceId)}/run-defaults`,
      { method: "DELETE" },
    );
    return result.agent;
  },

  agentSkills: (sourceId: string, signal?: AbortSignal) =>
    request<AgentSkillRegistry>(
      `/api/v1/agents/${encodeURIComponent(sourceId)}/skills`,
      { signal },
    ),

  agentModels: (
    sourceId: string,
    provider: string,
    cursor?: string,
    signal?: AbortSignal,
  ) => {
    const query = new URLSearchParams({ provider, limit: "100" });
    if (cursor !== undefined) query.set("cursor", cursor);
    return request<ModelCatalogPage>(
      `/api/v1/agents/${encodeURIComponent(sourceId)}/models?${query.toString()}`,
      { signal },
    );
  },

  /**
   * `ifRunConfigUnset` is a compare-and-set: the server applies nothing unless
   * the conversation still has no run override. The one-time adoption of a
   * browser-local preference needs it -- it reads the thread and then writes
   * it, and another tab can set a real override in between. `signal` matters
   * for the same path: thread writes are serialized, so an unbounded one
   * blocks every later write to that conversation.
   */
  patchThread: async (
    threadId: string,
    patch: {
      title?: string;
      archived?: boolean;
      model?: string | null;
      effort?: string | null;
      ifRunConfigUnset?: boolean;
    },
    signal?: AbortSignal,
  ) => {
    const result = await request<{ thread: ThreadSummary }>(
      `/api/v1/threads/${encodeURIComponent(threadId)}`,
      { method: "PATCH", body: JSON.stringify(patch), ...(signal === undefined ? {} : { signal }) },
    );
    return result.thread;
  },

  /**
   * `signal` because an unbounded delete never settles for the operator, not
   * because it is queued: a delete deliberately BYPASSES the conversation's
   * write queue -- see `deleteThread` in the console store -- so it does not
   * wait out a stalled write before removing what the operator asked to remove.
   */
  deleteThread: async (threadId: string, signal?: AbortSignal) => {
    const response = await fetch(`/api/v1/threads/${encodeURIComponent(threadId)}`, {
      method: "DELETE",
      headers: { Accept: "application/json" },
      ...(signal === undefined ? {} : { signal }),
    });
    if (!response.ok) throw await readError(response);
  },

  startTurn: async (threadId: string, input: StartTurnInput) =>
    request<{ thread: ThreadSummary; turn: { id: string; status: string } }>(
      `/api/v1/threads/${encodeURIComponent(threadId)}/turns`,
      { method: "POST", body: JSON.stringify(input) },
    ),

  liveInput: async (threadId: string, text: string) =>
    request<LiveInputReceipt>(
      `/api/v1/threads/${encodeURIComponent(threadId)}/live-input`,
      { method: "POST", body: JSON.stringify({ text }) },
    ),

  cancelTurn: async (threadId: string) =>
    request<{ cancelled: true; thread: ThreadSummary }>(
      `/api/v1/threads/${encodeURIComponent(threadId)}/cancel`,
      { method: "POST" },
    ),

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
