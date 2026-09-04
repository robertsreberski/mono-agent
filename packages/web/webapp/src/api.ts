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

export const api = {
  bootstrap: (signal?: AbortSignal) =>
    request<Bootstrap>("/api/v1/bootstrap", { signal }),

  thread: (threadId: string, signal?: AbortSignal) =>
    request<ThreadDetail>(`/api/v1/threads/${encodeURIComponent(threadId)}`, {
      signal,
    }),

  threads: (sourceId: string, archived: boolean, before?: string, signal?: AbortSignal) => {
    const query = new URLSearchParams({ sourceId, archived: String(archived), limit: "200" });
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
  createThread: async (sourceId: string, signal?: AbortSignal) => {
    const result = await request<{ thread: ThreadSummary }>("/api/v1/threads", {
      method: "POST",
      body: JSON.stringify({ sourceId }),
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
