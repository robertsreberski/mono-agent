import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { dirname } from "node:path/posix";

import {
  BufferedMessageStream,
  DEFAULT_AGENT_ATTACHMENT_MAX_BYTES,
  DEFAULT_AGENT_ATTACHMENT_MIME_ALLOWLIST,
  isAgentResponseCancelledError,
  isDeliverableConversation,
  unsupportedReplyPartDeliveryOutcomes,
  type AgentAttachment,
  type AgentMessageStream,
  type AgentReplyPartDeliveryOutcome,
  type AgentRequestBase,
  type AgentResponder,
  type AgentResponse,
} from "@mono-agent/agent-contracts";
import {
  assertSafeBind,
  bearerTokensEqual,
  close,
  hostForUrl,
  isLoopbackHost,
  listen,
  readAuthorizationBearer,
  sanitizeInboundHttpHeaders,
} from "@mono-agent/agent-contracts";
import express, { type NextFunction, type Request, type Response } from "express";

export type WebhookInvocationMode = "sync" | "async";

export interface WebhookRequestMetadata {
  readonly requestId: string;
  /** Name of the endpoint that received the request (multi-endpoint routing). */
  readonly endpointName: string;
  readonly mode: WebhookInvocationMode;
  readonly method: string;
  readonly path: string;
  readonly receivedAt: string;
  readonly remoteAddress?: string;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly payloadMetadata?: unknown;
  /** Present when the invocation carried an audio upload (counts attachments, never bytes). */
  readonly hasAttachments?: boolean;
  readonly attachmentCount?: number;
  readonly nativeNotify?: {
    readonly enabled: true;
    readonly conversationId?: string;
  };
  /** Resolved runtime model override (request body `model` wins over endpoint config). Validated by the app. */
  readonly model?: string;
  /** Resolved reasoning effort override (request body `effort` wins over endpoint config). Validated by the app. */
  readonly effort?: string;
}

export interface WebhookInvocationRequest extends AgentRequestBase {
  readonly conversationId: string;
  readonly text: string;
  readonly abortSignal: AbortSignal;
  readonly metadata: {
    readonly webhook: WebhookRequestMetadata;
    readonly [key: string]: unknown;
  };
}

export type WebhookInvocationStatus = (
  | {
      readonly status: "accepted" | "running";
      readonly requestId: string;
      readonly conversationId: string;
      readonly statusUrl: string;
      readonly receivedAt: string;
      readonly startedAt?: string;
    }
  | {
      readonly status: "succeeded";
      readonly requestId: string;
      readonly conversationId: string;
      readonly statusUrl: string;
      readonly receivedAt: string;
      readonly startedAt: string;
      readonly completedAt: string;
      readonly text?: string;
      readonly metadata?: Record<string, unknown>;
    }
  | {
      readonly status: "failed" | "cancelled";
      readonly requestId: string;
      readonly conversationId: string;
      readonly statusUrl: string;
      readonly receivedAt: string;
      readonly startedAt: string;
      readonly completedAt: string;
      readonly error: string;
    }) & {
      /** Terminal, sanitized outcomes for rich parts this adapter cannot deliver. */
      readonly replyPartOutcomes?: readonly AgentReplyPartDeliveryOutcome[];
    };

/**
 * Transport-only 409 response shape. Unlike {@link WebhookInvocationStatus},
 * a busy result is never stored or replayed via the status endpoint, so it is
 * kept out of the persisted status union.
 */
export interface WebhookBusyResponse {
  readonly status: "busy";
  readonly requestId: string;
  readonly conversationId: string;
  readonly error: string;
}

export interface WebhookAdapterLogger {
  debug?(message: string, metadata?: Record<string, unknown>): void;
  info?(message: string, metadata?: Record<string, unknown>): void;
  warn?(message: string, metadata?: Record<string, unknown>): void;
  error?(message: string, metadata?: Record<string, unknown>): void;
}

/**
 * Channel schemes whose request conversation may become a native-notify reply
 * target. WhatsApp is intentionally excluded until its plugin driver exposes a
 * native notify hook; explicit and host-resolved destinations remain available.
 */
export const NATIVE_NOTIFY_CALLBACK_CHANNEL_IDS = Object.freeze(["telegram", "slack"] as const);

/**
 * One HTTP endpoint of the webhook server. Multiple endpoints share one server,
 * host and port; each has its own POST path, default mode, optional `prompt`
 * (pre-instructions prepended to the incoming request text), and optional run
 * watchdog override.
 */
export interface WebhookEndpointOption {
  readonly name: string;
  readonly path: string;
  readonly mode?: WebhookInvocationMode;
  readonly prompt?: string;
  /** When true, the app host may deliver the final answer to a notify-capable conversation. */
  readonly notify?: boolean;
  /** Optional destination conversationId for native notification delivery. */
  readonly notifyConversationId?: string;
  /**
   * Pre-resolved fallback used after an explicit endpoint or deliverable request
   * conversation. Hosts with a live destination set should prefer the
   * adapter-level per-invocation resolver.
   */
  readonly notifyFallbackConversationId?: string;
  /** Per-endpoint runtime model override (raw string; a request body `model` wins). */
  readonly model?: string;
  /** Per-endpoint reasoning effort override (raw string; a request body `effort` wins). */
  readonly effort?: string;
  /**
   * Per-endpoint wall-clock run bound in milliseconds. Wins over the adapter
   * fallback. Must be an integer from 0 to 86,400,000; set 0 to disable the
   * watchdog for this endpoint.
   */
  readonly maxRunMs?: number;
}

export interface WebhookAdapterOptions {
  readonly host?: string;
  readonly port?: number;
  readonly allowNonLoopback?: boolean;
  /** Optional static bearer token. Required for every non-loopback bind. */
  readonly apiKey?: string;
  readonly retentionMs?: number;
  readonly maxStoredRequests?: number;
  /**
   * Adapter-level wall-clock fallback (ms) for a webhook run. An endpoint's
   * `maxRunMs` wins. On timeout the request signal is aborted and the
   * conversation's slot is reclaimed even if the responder never settles.
   * Omit or set <= 0 to disable. Matters most for async runs, which have no
   * client disconnect to bound them.
   */
  readonly maxRunMs?: number;
  /**
   * Decoded-byte ceiling for one inbound audio attachment (multipart/form-data
   * or raw `audio/*` bodies). Oversize uploads are rejected with HTTP 413.
   * Omit to use `DEFAULT_AGENT_ATTACHMENT_MAX_BYTES`. The 1 MB JSON limit is
   * unaffected.
   */
  readonly maxAttachmentBytes?: number;
  readonly responder: AgentResponder<WebhookInvocationRequest, AgentMessageStream, AgentResponse>;
  readonly logger?: WebhookAdapterLogger;
  /**
   * Host-owned fallback resolver for notify-enabled invocations without an
   * explicit endpoint or deliverable request destination. It runs once per
   * invocation so request.replyTo and completion delivery share one snapshot.
   * The optional signal allows cooperative cancellation; the adapter also
   * races resolver settlement against it.
   */
  readonly resolveNotifyFallbackConversationId?: (abortSignal?: AbortSignal) => Promise<string | undefined>;
  /** Endpoints to serve. When omitted, a single legacy endpoint is built from `path`/`defaultMode`. */
  readonly endpoints?: readonly WebhookEndpointOption[];
  /** Legacy single-endpoint path. Folded into a one-element `endpoints` list when `endpoints` is omitted. */
  readonly path?: string;
  /** Default invocation mode for the legacy single endpoint and for endpoints that omit `mode`. */
  readonly defaultMode?: WebhookInvocationMode;
  /** Best-effort completion hook; failures here must not affect HTTP responses or stored status. */
  readonly onResult?: (status: WebhookInvocationStatus, request: WebhookInvocationRequest) => void | Promise<void>;
}

export interface WebhookEndpointSummary {
  readonly name: string;
  readonly path: string;
  readonly invokeUrl: string;
  readonly statusBasePath: string;
  readonly mode: WebhookInvocationMode;
}

export interface WebhookAdapterStartResult {
  readonly url: string;
  /** Invoke URL of the first endpoint (back-compat). See `endpoints` for all of them. */
  readonly invokeUrl: string;
  /** Status base path of the first endpoint (back-compat). */
  readonly statusBasePath: string;
  readonly host: string;
  readonly port: number;
  readonly endpoints: readonly WebhookEndpointSummary[];
  readonly activeRequestCount: number;
  getStatus(requestId: string): WebhookInvocationStatus | undefined;
  stop(): Promise<void>;
}

/** A single resolved endpoint with all defaults applied. */
interface ResolvedEndpoint {
  readonly name: string;
  readonly path: string;
  readonly mode: WebhookInvocationMode;
  readonly prompt?: string;
  readonly notify?: boolean;
  readonly notifyConversationId?: string;
  readonly notifyFallbackConversationId?: string;
  readonly model?: string;
  readonly effort?: string;
  readonly maxRunMs?: number;
  readonly statusBasePath: string;
}

export type WebhookAdapterErrorCode =
  | "invalid_config"
  | "missing_required_config"
  | "unsafe_host"
  | "start_failed";

export interface WebhookAdapterErrorDetails {
  readonly code?: WebhookAdapterErrorCode;
  readonly reason?: string;
  readonly [key: string]: unknown;
}

export class WebhookAdapterError extends Error {
  readonly code: WebhookAdapterErrorCode;
  readonly details: WebhookAdapterErrorDetails;

  constructor(code: WebhookAdapterErrorCode, message: string, details: WebhookAdapterErrorDetails = {}) {
    super(message);
    this.name = "WebhookAdapterError";
    this.code = code;
    this.details = { ...details, code };
  }
}

interface ActiveRun {
  readonly controller: AbortController;
  readonly requestId: string;
}

interface StoredStatus {
  readonly status: WebhookInvocationStatus;
  readonly updatedAtMs: number;
}

interface NormalizedBody {
  readonly text: string;
  readonly conversationId: string;
  readonly mode: WebhookInvocationMode;
  readonly metadata?: unknown;
  /** Per-request runtime model override (wins over the endpoint config). */
  readonly model?: string;
  /** Per-request reasoning effort override (wins over the endpoint config). */
  readonly effort?: string;
}

/**
 * Audio upload decoded by the invoke-body middleware and stashed for
 * `handleInvoke`. `text` stays optional here: when absent the endpoint prompt
 * (or a fixed fallback line) becomes the user message.
 */
interface WebhookAudioInput {
  readonly text?: string;
  readonly conversationId?: string;
  readonly mode?: string;
  readonly model?: string;
  readonly effort?: string;
  readonly metadata?: unknown;
  readonly hasMetadata: boolean;
  readonly mimeType: string;
  readonly bytes: Buffer;
  /** Client-supplied filename (trimmed, length-capped), when usable. */
  readonly fileName?: string;
}

interface NormalizedAudioBody {
  readonly text?: string;
  readonly conversationId: string;
  readonly mode: WebhookInvocationMode;
  readonly metadata?: unknown;
  readonly model?: string;
  readonly effort?: string;
  readonly attachment: AgentAttachment;
}

type AudioParseResult =
  | { readonly ok: true; readonly value: WebhookAudioInput }
  | { readonly ok: false; readonly status: number; readonly error: string };

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 0;
const DEFAULT_PATH = "/webhook/invoke";
const DEFAULT_MODE: WebhookInvocationMode = "sync";
const DEFAULT_RETENTION_MS = 300_000;
const DEFAULT_MAX_STORED_REQUESTS = 100;
const MAX_RUN_MS = 86_400_000;
/** Upper bound for the operator-configured attachment ceiling (mirrors Telegram). */
const MAX_ATTACHMENT_CONFIG_BYTES = 2_147_483_648;
/**
 * Slack above `maxAttachmentBytes` for the multipart framing itself
 * (boundaries, part headers, text fields). The audio file bytes are still
 * capped exactly; only the envelope may use this headroom.
 */
const MULTIPART_FORM_OVERHEAD_BYTES = 1_048_576;
/** User message when an audio upload carries no text and the endpoint has no prompt. */
const VOICE_MESSAGE_FALLBACK_TEXT = "Voice message attached.";
/** Multipart field names accepted for the single audio file part. */
const AUDIO_FILE_FIELD_NAMES: readonly string[] = ["audio", "file"];
/** Client filenames are display-only; cap them so they stay out of status noise. */
const MAX_AUDIO_FILE_NAME_CHARS = 120;
/** Apple/encoder MIME aliases normalized to the allowlist's canonical form. */
const AUDIO_MIME_ALIASES: Record<string, string> = {
  "audio/x-m4a": "audio/mp4",
  "audio/m4a": "audio/mp4",
  "audio/x-wav": "audio/wav",
  "audio/mp3": "audio/mpeg",
};
/** Extension for generated `voice-<requestId>` names (the harness sanitizes names for disk). */
const AUDIO_MIME_EXTENSIONS: Record<string, string> = {
  "audio/ogg": ".ogg",
  "audio/mpeg": ".mp3",
  "audio/mp4": ".m4a",
  "audio/aac": ".aac",
  "audio/wav": ".wav",
  "audio/webm": ".webm",
  "audio/flac": ".flac",
};
/** Audio subset of the shared attachment allowlist; anything else is HTTP 415. */
const AUDIO_ATTACHMENT_MIME_ALLOWLIST: readonly string[] = DEFAULT_AGENT_ATTACHMENT_MIME_ALLOWLIST.filter(
  (mime) => mime.startsWith("audio/"),
);
/** Per-request audio stash: set by the body middleware, consumed once by `handleInvoke`. */
const audioInputs = new WeakMap<object, WebhookAudioInput>();
const FORCE_CLOSE_AFTER_MS = 250;
export async function startWebhookAdapter(options: WebhookAdapterOptions): Promise<WebhookAdapterStartResult> {
  validateOptions(options);
  const host = options.host ?? DEFAULT_HOST;
  const port = options.port ?? DEFAULT_PORT;
  const apiKey = normalizeOptionalString(options.apiKey);
  const retentionMs = options.retentionMs ?? DEFAULT_RETENTION_MS;
  const maxStoredRequests = options.maxStoredRequests ?? DEFAULT_MAX_STORED_REQUESTS;
  const maxAttachmentBytes = options.maxAttachmentBytes ?? DEFAULT_AGENT_ATTACHMENT_MAX_BYTES;
  const endpoints = resolveEndpoints(options);
  assertSafeBind(host, options.allowNonLoopback === true, (boundHost) =>
    new WebhookAdapterError(
      "unsafe_host",
      "Webhook adapter refuses to bind a non-loopback host unless allowNonLoopback is true.",
      { host: boundHost },
    ));
  if (!isLoopbackHost(host) && apiKey === undefined) {
    throw new WebhookAdapterError(
      "missing_required_config",
      "Webhook adapter requires an API key for every non-loopback bind.",
      { host },
    );
  }

  const app = express();
  const server = createServer(app);
  let stopping = false;
  // Active runs are keyed by `${endpoint.name}:${conversationId}` so the same
  // conversation can be in-flight on two different endpoints without a false 409.
  const activeByRun = new Map<string, ActiveRun>();
  const statuses = new Map<string, StoredStatus>();

  const parseJsonBody = express.json({ limit: "1mb" });
  // Raw audio bodies are capped exactly at the attachment ceiling; multipart
  // gets headroom for its framing while the file bytes stay capped exactly.
  const parseRawAudioBody = express.raw({ type: "audio/*", limit: maxAttachmentBytes });
  const parseMultipartBody = express.raw({
    type: "multipart/form-data",
    limit: maxAttachmentBytes + MULTIPART_FORM_OVERHEAD_BYTES,
  });
  for (const endpoint of endpoints) {
    app.post(
      endpoint.path,
      (req, res, next) => {
        if (authorize(req, res, apiKey)) {
          next();
        }
      },
      parseRawAudioBody,
      parseMultipartBody,
      parseJsonBody,
      (req, res, next) => {
        void decodeAudioBody(req, res, next, maxAttachmentBytes);
      },
      (req, res) => {
        void handleInvoke(req, res, endpoint).catch((error: unknown) => {
          options.logger?.error?.("Webhook invocation failed before response.", {
            endpoint: endpoint.name,
            error: errorToMessage(error),
          });
          if (!res.headersSent) {
            res.status(500).json({ status: "failed", error: errorToMessage(error) });
          }
        });
      },
    );
  }
  // Register one status route per UNIQUE base path (endpoints sharing a parent
  // directory share a status route; lookups hit the shared, requestId-keyed store).
  for (const statusBasePath of new Set(endpoints.map((endpoint) => endpoint.statusBasePath))) {
    app.get(`${statusBasePath}/:requestId`, (req, res) => {
      if (!authorize(req, res, apiKey)) {
        return;
      }
      pruneStatuses(statuses, retentionMs, maxStoredRequests);
      const requestId = req.params.requestId;
      const stored = requestId === undefined ? undefined : statuses.get(requestId);
      if (stored === undefined) {
        res.status(404).json({ status: "not_found", requestId });
        return;
      }
      res.status(200).json(sanitizeWebhookInvocationStatus(stored.status));
    });
  }
  app.use((error: unknown, req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      next(error);
      return;
    }
    if (isEntityTooLargeError(error) && (isMultipartContent(req) || isAudioContent(req))) {
      res.status(413).json({
        status: "failed",
        error: `Webhook audio body exceeds the ${String(maxAttachmentBytes)}-byte attachment limit.`,
      });
      return;
    }
    res.status(400).json({ status: "failed", error: errorToMessage(error) });
  });

  const address = await listen(server, port, host, {
    listenFailed: (reason) =>
      new WebhookAdapterError("start_failed", "Webhook adapter failed to listen.", { reason }),
    noAddress: () =>
      new WebhookAdapterError("start_failed", "Webhook adapter did not receive a TCP address."),
  });
  const boundPort = address.port;

  async function closeRejectedServer(): Promise<void> {
    stopping = true;
    for (const active of activeByRun.values()) {
      active.controller.abort(new Error("Webhook adapter rejected its actual bound address."));
    }
    const closed = await closeServerBounded(server);
    if (!closed) {
      options.logger?.warn?.("Webhook adapter could not confirm rejected-server cleanup before reporting the rejected bind.", {
        boundAddress: address.address,
        boundPort: address.port,
      });
    }
    activeByRun.clear();
    statuses.clear();
  }

  const boundNonLoopback = !isLoopbackHost(address.address);
  if (boundNonLoopback && options.allowNonLoopback !== true) {
    await closeRejectedServer();
    throw new WebhookAdapterError(
      "unsafe_host",
      "Webhook adapter resolved a loopback host to a non-loopback bind address.",
      { host, boundAddress: address.address, boundPort },
    );
  }
  if (boundNonLoopback && apiKey === undefined) {
    await closeRejectedServer();
    throw new WebhookAdapterError(
      "missing_required_config",
      "Webhook adapter requires an API key when the actual bound address is non-loopback.",
      { host, boundAddress: address.address, boundPort },
    );
  }

  const url = `http://${hostForUrl(host)}:${boundPort}`;

  async function handleInvoke(req: Request, res: Response, endpoint: ResolvedEndpoint): Promise<void> {
    if (stopping) {
      res.status(503).json({
        status: "failed",
        error: "Webhook adapter is stopping before request admission.",
      });
      return;
    }
    pruneStatuses(statuses, retentionMs, maxStoredRequests);
    const requestId = randomUUID();
    const receivedAt = new Date().toISOString();
    const audio = takeAudioInput(req);
    const body: NormalizedBody | NormalizedAudioBody = audio === undefined
      ? normalizeBody(req.body, {
        requestId,
        defaultMode: endpoint.mode,
      })
      : normalizeAudioBody(audio, {
        requestId,
        defaultMode: endpoint.mode,
      });
    const attachment = "attachment" in body ? body.attachment : undefined;
    const statusUrl = `${endpoint.statusBasePath}/${requestId}`;
    const runKey = `${endpoint.name}:${body.conversationId}`;
    const maxRunMs = endpoint.maxRunMs ?? options.maxRunMs;
    const controller = new AbortController();

    if (activeByRun.has(runKey)) {
      const busy: WebhookBusyResponse = {
        status: "busy",
        requestId,
        conversationId: body.conversationId,
        error: "A request is already active for this conversation.",
      };
      res.status(409).json(busy);
      return;
    }

    const active: ActiveRun = { controller, requestId };
    activeByRun.set(runKey, active);
    const startedAt = new Date().toISOString();
    const running: WebhookInvocationStatus = {
      status: "running",
      requestId,
      conversationId: body.conversationId,
      statusUrl,
      receivedAt,
      startedAt,
    };
    setStatus(statuses, running, retentionMs, maxStoredRequests);

    const request: WebhookInvocationRequest = {
      conversationId: body.conversationId,
      // Audio uploads may omit text: the endpoint prompt (or a fixed fallback
      // line) becomes the user message while the file rides as an attachment.
      text: body.text === undefined
        ? (endpoint.prompt === undefined || endpoint.prompt.length === 0
          ? VOICE_MESSAGE_FALLBACK_TEXT
          : endpoint.prompt)
        : composePromptText(endpoint.prompt, body.text),
      abortSignal: controller.signal,
      ...(attachment === undefined ? {} : { attachments: [attachment] }),
      metadata: {
        webhook: {
          requestId,
          endpointName: endpoint.name,
          mode: body.mode,
          method: req.method,
          path: req.path,
          receivedAt,
          ...(req.socket.remoteAddress === undefined ? {} : { remoteAddress: req.socket.remoteAddress }),
          headers: sanitizeInboundHttpHeaders(req.headers),
          ...(attachment === undefined ? {} : { hasAttachments: true, attachmentCount: 1 }),
          ...(body.metadata === undefined ? {} : { payloadMetadata: body.metadata }),
          ...(endpoint.notify === true
            ? {
                nativeNotify: {
                  enabled: true,
                  ...(endpoint.notifyConversationId === undefined ? {} : { conversationId: endpoint.notifyConversationId }),
                },
              }
            : {}),
          // Precedence: request body model/effort win over the endpoint config defaults.
          ...((body.model ?? endpoint.model) === undefined ? {} : { model: body.model ?? endpoint.model }),
          ...((body.effort ?? endpoint.effort) === undefined ? {} : { effort: body.effort ?? endpoint.effort }),
        },
      },
    };
    const resolveRunNotifyConversationId = endpoint.notify === true
      ? async (abortSignal?: AbortSignal) => await resolveNotifyConversationId(
          endpoint,
          body.conversationId,
          options,
          abortSignal ?? controller.signal,
        )
      : undefined;

    if (body.mode === "async") {
      res.status(202).json({
        status: "accepted",
        requestId,
        conversationId: body.conversationId,
        statusUrl,
        receivedAt,
      });
      void runResponder({
        request,
        ...(resolveRunNotifyConversationId === undefined ? {} : { resolveNotifyConversationId: resolveRunNotifyConversationId }),
        statusUrl,
        receivedAt,
        startedAt,
        statuses,
        activeByRun,
        runKey,
        active,
        options,
        ...(maxRunMs === undefined ? {} : { maxRunMs }),
        retentionMs,
        maxStoredRequests,
      });
      return;
    }

    res.once("close", () => {
      if (!res.writableEnded) {
        controller.abort(new Error("Webhook client disconnected."));
      }
    });

    const status = await runResponder({
      request,
      ...(resolveRunNotifyConversationId === undefined ? {} : { resolveNotifyConversationId: resolveRunNotifyConversationId }),
      statusUrl,
      receivedAt,
      startedAt,
      statuses,
      activeByRun,
      runKey,
      active,
      options,
      ...(maxRunMs === undefined ? {} : { maxRunMs }),
      retentionMs,
      maxStoredRequests,
    });
    if (res.destroyed || res.writableEnded) {
      return;
    }
    if (status.status === "succeeded") {
      res.status(200).json(status);
      return;
    }
    if (status.status === "cancelled") {
      res.status(499).json(status);
      return;
    }
    res.status(500).json(status);
  }

  const endpointSummaries: readonly WebhookEndpointSummary[] = endpoints.map((endpoint) => ({
    name: endpoint.name,
    path: endpoint.path,
    invokeUrl: `${url}${endpoint.path}`,
    statusBasePath: endpoint.statusBasePath,
    mode: endpoint.mode,
  }));

  return {
    url,
    invokeUrl: endpointSummaries[0]?.invokeUrl ?? url,
    statusBasePath: endpointSummaries[0]?.statusBasePath ?? "/requests",
    host,
    port: boundPort,
    endpoints: endpointSummaries,
    get activeRequestCount() {
      return activeByRun.size;
    },
    getStatus(requestId: string): WebhookInvocationStatus | undefined {
      const status = statuses.get(requestId)?.status;
      return status === undefined ? undefined : sanitizeWebhookInvocationStatus(status);
    },
    async stop() {
      stopping = true;
      for (const active of activeByRun.values()) {
        active.controller.abort(new Error("Webhook adapter stopped."));
      }
      activeByRun.clear();
      await close(server);
    },
  };
}

async function closeServerBounded(server: ReturnType<typeof createServer>): Promise<boolean> {
  let closeResult = settleServerClose(server);
  // On supported Node versions close() already reaps idle connections. A second
  // eager idle sweep can race a fully queued request before the 503 latch runs.
  let forceTimer: ReturnType<typeof setTimeout> | undefined;
  const force = new Promise<"forced">((resolvePromise) => {
    forceTimer = setTimeout(() => {
      server.closeAllConnections();
      resolvePromise("forced");
    }, FORCE_CLOSE_AFTER_MS);
    forceTimer.unref?.();
  });
  const outcome = await Promise.race([closeResult, force]);
  if (forceTimer !== undefined) {
    clearTimeout(forceTimer);
  }
  if (outcome === "closed") {
    return true;
  }

  server.closeAllConnections();
  if (outcome === "failed") {
    closeResult = settleServerClose(server);
  }

  let finalTimer: ReturnType<typeof setTimeout> | undefined;
  const finalOutcome = await Promise.race([
    closeResult,
    new Promise<void>((resolvePromise) => {
      finalTimer = setTimeout(() => {
        server.closeAllConnections();
        resolvePromise();
      }, FORCE_CLOSE_AFTER_MS);
      finalTimer.unref?.();
    }),
  ]);
  if (finalTimer !== undefined) {
    clearTimeout(finalTimer);
  }
  return finalOutcome === "closed";
}

function settleServerClose(server: ReturnType<typeof createServer>): Promise<"closed" | "failed"> {
  return close(server).then(
    () => "closed" as const,
    () => "failed" as const,
  );
}

function authorize(req: Request, res: Response, apiKey: string | undefined): boolean {
  if (apiKey === undefined) {
    return true;
  }
  const presented = readAuthorizationBearer(req.header("authorization"));
  if (presented !== undefined && bearerTokensEqual(presented, apiKey)) {
    return true;
  }
  res.status(401).json({ status: "unauthorized", error: "Invalid API key." });
  return false;
}

async function runResponder(input: {
  readonly request: WebhookInvocationRequest;
  readonly resolveNotifyConversationId?: (abortSignal?: AbortSignal) => Promise<string | undefined>;
  readonly statusUrl: string;
  readonly receivedAt: string;
  readonly startedAt: string;
  readonly statuses: Map<string, StoredStatus>;
  readonly activeByRun: Map<string, ActiveRun>;
  readonly runKey: string;
  readonly active: ActiveRun;
  readonly options: WebhookAdapterOptions;
  readonly maxRunMs?: number;
  readonly retentionMs: number;
  readonly maxStoredRequests: number;
}): Promise<WebhookInvocationStatus> {
  const stream = new BufferedMessageStream({
    onClosed: () =>
      new WebhookAdapterError("invalid_config", "Cannot write to a finished webhook stream."),
  });
  let status: WebhookInvocationStatus;
  // Max-run watchdog (mirrors the cron adapter): bound the run so a responder
  // that hangs — especially in async mode, where there is no client to
  // disconnect — cannot hold the conversation's slot (activeByRun) forever. On
  // timeout we abort the request signal AND win the race below, so the slot is
  // reclaimed even if the responder never settles.
  const maxRunMs = input.maxRunMs;
  let timedOut = false;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  let selectedNotifyConversationId: string | undefined;
  try {
    const respondPromise = (async () => {
      selectedNotifyConversationId = await input.resolveNotifyConversationId?.(input.request.abortSignal);
      if (input.request.abortSignal.aborted) {
        throw input.request.abortSignal.reason ?? new Error("Webhook run was cancelled before responder start.");
      }
      // The responder receives its own request object. Its structural readonly
      // type is not a runtime trust boundary, so completion delivery must never
      // depend on this object (or its replyTo) remaining unmodified.
      const responderRequest = withSnapshottedReplyTarget(input.request, selectedNotifyConversationId);
      const result = await input.options.responder.respond(responderRequest, stream);
      await stream.finish(result.text, {
        ...(result.parts === undefined ? {} : { parts: result.parts }),
        unsupportedPartFallback: "none",
      });
      return result;
    })();
    // If the timeout wins the race, the responder promise may reject later (on
    // the abort) with nobody awaiting it — attach a no-op handler so that does
    // not surface as an unhandled rejection.
    void respondPromise.catch(() => undefined);

    let response: AgentResponse;
    if (maxRunMs !== undefined && maxRunMs > 0) {
      const timeoutPromise = new Promise<never>((_resolve, reject) => {
        watchdog = setTimeout(() => {
          timedOut = true;
          input.active.controller.abort(new Error(`Webhook run exceeded maxRunMs (${maxRunMs}ms).`));
          reject(new Error(`Webhook run timed out after ${maxRunMs}ms.`));
        }, maxRunMs);
        (watchdog as { unref?: () => void }).unref?.();
      });
      response = await Promise.race([respondPromise, timeoutPromise]);
    } else {
      response = await respondPromise;
    }
    const replyPartOutcomes = unsupportedReplyPartDeliveryOutcomes(response.parts);
    if (input.request.abortSignal.aborted) {
      // The responder resolved but the run was aborted in flight (client
      // disconnect or a maxRunMs the responder ignored): report it as cancelled,
      // not succeeded. Mirrors the cron adapter's post-run abort guard.
      status = {
        status: "cancelled",
        requestId: input.active.requestId,
        conversationId: input.request.conversationId,
        statusUrl: input.statusUrl,
        receivedAt: input.receivedAt,
        startedAt: input.startedAt,
        completedAt: new Date().toISOString(),
        error: "Webhook run was aborted before completion.",
        ...(replyPartOutcomes === undefined ? {} : { replyPartOutcomes }),
      };
      input.options.logger?.warn?.("Webhook responder resolved after an abort; reporting cancelled.", {
        requestId: input.active.requestId,
        conversationId: input.request.conversationId,
      });
    } else {
      status = {
        status: "succeeded",
        requestId: input.active.requestId,
        conversationId: input.request.conversationId,
        statusUrl: input.statusUrl,
        receivedAt: input.receivedAt,
        startedAt: input.startedAt,
        completedAt: new Date().toISOString(),
        ...((response.text ?? stream.text).length === 0 ? {} : { text: response.text ?? stream.text }),
        ...(response.metadata === undefined ? {} : { metadata: response.metadata }),
        ...(replyPartOutcomes === undefined ? {} : { replyPartOutcomes }),
      };
    }
    if (replyPartOutcomes !== undefined) {
      input.options.logger?.warn?.("Webhook rich reply parts were not delivered by this destination.", {
        requestId: input.active.requestId,
        conversationId: input.request.conversationId,
        replyPartOutcomes,
      });
    }
  } catch (error) {
    // A watchdog timeout is a server-imposed failure, not a user cancel.
    const cancelled = !timedOut && (input.request.abortSignal.aborted || isAgentResponseCancelledError(error));
    status = {
      status: cancelled ? "cancelled" : "failed",
      requestId: input.active.requestId,
      conversationId: input.request.conversationId,
      statusUrl: input.statusUrl,
      receivedAt: input.receivedAt,
      startedAt: input.startedAt,
      completedAt: new Date().toISOString(),
      error: timedOut
        ? `Webhook run timed out after ${String(maxRunMs)}ms (run did not settle); reclaiming the slot.`
        : errorToMessage(error),
    };
    input.options.logger?.[cancelled ? "warn" : "error"]?.("Webhook run failed.", {
      requestId: input.active.requestId,
      conversationId: input.request.conversationId,
      error: status.error,
    });
  } finally {
    if (watchdog !== undefined) {
      clearTimeout(watchdog);
    }
    if (input.activeByRun.get(input.runKey) === input.active) {
      input.activeByRun.delete(input.runKey);
    }
  }
  // Every external destination receives its own sanitized copy. Keeping the
  // store, callback, and HTTP result separate also prevents an onResult hook
  // from mutating the status later returned by the status endpoint.
  setStatus(input.statuses, status, input.retentionMs, input.maxStoredRequests);
  // Reconstruct the completion request from the run-owned base and private
  // scalar snapshot. A responder may rewrite/delete replyTo (or inject one when
  // no route was selected), but none of those mutations can redirect/suppress
  // native delivery through onResult.
  const completionRequest = withSnapshottedReplyTarget(input.request, selectedNotifyConversationId);
  emitResult({ ...input, request: completionRequest }, sanitizeWebhookInvocationStatus(status));
  return sanitizeWebhookInvocationStatus(status);
}

function withSnapshottedReplyTarget(
  request: WebhookInvocationRequest,
  conversationId: string | undefined,
): WebhookInvocationRequest {
  const { replyTo: _untrustedReplyTarget, ...requestWithoutReplyTarget } = request;
  const requestSnapshot: WebhookInvocationRequest = {
    ...requestWithoutReplyTarget,
    metadata: {
      ...requestWithoutReplyTarget.metadata,
      webhook: { ...requestWithoutReplyTarget.metadata.webhook },
    },
  };
  return conversationId === undefined
    ? requestSnapshot
    : { ...requestSnapshot, replyTo: { conversationId } };
}

function emitResult(input: {
  readonly request: WebhookInvocationRequest;
  readonly active: ActiveRun;
  readonly options: WebhookAdapterOptions;
}, status: WebhookInvocationStatus): void {
  try {
    const result = input.options.onResult?.(status, input.request);
    if (result !== undefined) {
      void Promise.resolve(result).catch((error: unknown) => {
        logResultHookFailure(input, error);
      });
    }
  } catch (error) {
    logResultHookFailure(input, error);
  }
}

function logResultHookFailure(input: {
  readonly request: WebhookInvocationRequest;
  readonly active: ActiveRun;
  readonly options: WebhookAdapterOptions;
}, error: unknown): void {
  input.options.logger?.warn?.("Webhook onResult callback failed.", {
    requestId: input.active.requestId,
    conversationId: input.request.conversationId,
    error: errorToMessage(error),
  });
}

function normalizeBody(body: unknown, input: { readonly requestId: string; readonly defaultMode: WebhookInvocationMode }): NormalizedBody {
  if (!isRecord(body)) {
    throw new WebhookAdapterError("invalid_config", "Webhook body must be a JSON object.");
  }
  const text = normalizeOptionalString(body.text);
  if (text === undefined) {
    throw new WebhookAdapterError("invalid_config", "Webhook body requires non-empty text.");
  }
  const mode = normalizeOptionalString(body.mode) ?? input.defaultMode;
  if (mode !== "sync" && mode !== "async") {
    throw new WebhookAdapterError("invalid_config", "Webhook mode must be sync or async.");
  }
  const rawConversationId = normalizeOptionalString(body.conversationId);
  const model = normalizeOptionalString(body.model);
  const effort = normalizeOptionalString(body.effort);
  return {
    text,
    conversationId: rawConversationId ?? `webhook:${input.requestId}`,
    mode,
    ...(body.metadata === undefined ? {} : { metadata: body.metadata }),
    ...(model === undefined ? {} : { model }),
    ...(effort === undefined ? {} : { effort }),
  };
}

/**
 * Decode a buffered multipart/form-data or raw `audio/*` body into a stashed
 * audio input. JSON bodies (non-Buffer) pass through untouched. Format-level
 * failures answer directly with their contract status (400/413/415); semantic
 * failures (e.g. an invalid `mode`) stay with `normalizeAudioBody` so they
 * surface exactly like their JSON equivalents.
 */
async function decodeAudioBody(
  req: Request,
  res: Response,
  next: NextFunction,
  maxAttachmentBytes: number,
): Promise<void> {
  if (!Buffer.isBuffer(req.body)) {
    next();
    return;
  }
  const raw = req.body as Buffer;
  const parsed = isMultipartContent(req)
    ? await parseMultipartAudioBody(requestContentType(req), raw, maxAttachmentBytes)
    : decodeRawAudioBody(req, raw, maxAttachmentBytes);
  if (!parsed.ok) {
    res.status(parsed.status).json({ status: "failed", error: parsed.error });
    return;
  }
  audioInputs.set(req, parsed.value);
  next();
}

function decodeRawAudioBody(req: Request, raw: Buffer, maxAttachmentBytes: number): AudioParseResult {
  const mimeType = normalizeAudioMimeType(requestContentType(req));
  if (mimeType === undefined) {
    return audioParseFailure(415, unsupportedAudioMimeError(displayRequestContentType(req)));
  }
  if (raw.byteLength === 0) {
    return audioParseFailure(400, "Webhook audio body is empty.");
  }
  if (raw.byteLength > maxAttachmentBytes) {
    return audioParseFailure(413, oversizeAudioError(maxAttachmentBytes));
  }
  const fileName = normalizeAudioFileName(
    normalizeOptionalString(req.get("X-File-Name")) ?? firstQueryParam(req.query.name),
  );
  const text = firstQueryParam(req.query.text);
  const conversationId = firstQueryParam(req.query.conversationId);
  const mode = firstQueryParam(req.query.mode);
  const model = firstQueryParam(req.query.model);
  const effort = firstQueryParam(req.query.effort);
  return {
    ok: true,
    value: {
      ...(text === undefined ? {} : { text }),
      ...(conversationId === undefined ? {} : { conversationId }),
      ...(mode === undefined ? {} : { mode }),
      ...(model === undefined ? {} : { model }),
      ...(effort === undefined ? {} : { effort }),
      hasMetadata: false,
      mimeType,
      bytes: raw,
      ...(fileName === undefined ? {} : { fileName }),
    },
  };
}

/**
 * Parse a buffered multipart body with undici's `Response.formData()` (Node >=
 * 24, no extra dependency): exactly one file part under `audio`/`file`, plus
 * the JSON-equivalent text fields. `metadata` may be a JSON string field.
 */
async function parseMultipartAudioBody(
  contentType: string,
  raw: Buffer,
  maxAttachmentBytes: number,
): Promise<AudioParseResult> {
  let form: FormData;
  try {
    form = await new Response(raw, { headers: { "content-type": contentType } }).formData();
  } catch {
    return audioParseFailure(400, "Webhook multipart body could not be parsed.");
  }
  const fields = new Map<string, string>();
  const files: Array<{ readonly field: string; readonly file: File }> = [];
  for (const [name, value] of form.entries()) {
    if (typeof value === "string") {
      if (!fields.has(name)) {
        fields.set(name, value);
      }
    } else {
      files.push({ field: name, file: value });
    }
  }
  if (files.length === 0) {
    return audioParseFailure(400, "Multipart webhook invocation requires exactly one \"audio\" or \"file\" part.");
  }
  if (files.length > 1) {
    return audioParseFailure(400, "Multipart webhook invocation accepts a single audio file part.");
  }
  const single = files[0];
  if (single === undefined || !AUDIO_FILE_FIELD_NAMES.includes(single.field)) {
    return audioParseFailure(
      400,
      `Multipart file part must use the "audio" or "file" field name (received "${single?.field ?? "(missing)"}").`,
    );
  }
  const mimeType = normalizeAudioMimeType(single.file.type);
  if (mimeType === undefined) {
    return audioParseFailure(415, unsupportedAudioMimeError(single.file.type === "" ? "(missing)" : single.file.type));
  }
  const bytes = Buffer.from(await single.file.arrayBuffer());
  if (bytes.byteLength === 0) {
    return audioParseFailure(400, "Webhook audio file is empty.");
  }
  if (bytes.byteLength > maxAttachmentBytes) {
    return audioParseFailure(413, oversizeAudioError(maxAttachmentBytes));
  }
  const rawMetadata = fields.get("metadata");
  let metadata: unknown;
  if (rawMetadata !== undefined) {
    try {
      metadata = JSON.parse(rawMetadata) as unknown;
    } catch {
      return audioParseFailure(400, "Webhook metadata field must contain valid JSON.");
    }
  }
  const fileName = normalizeAudioFileName(single.file.name);
  const text = normalizeOptionalString(fields.get("text"));
  const conversationId = normalizeOptionalString(fields.get("conversationId"));
  const mode = normalizeOptionalString(fields.get("mode"));
  const model = normalizeOptionalString(fields.get("model"));
  const effort = normalizeOptionalString(fields.get("effort"));
  return {
    ok: true,
    value: {
      ...(text === undefined ? {} : { text }),
      ...(conversationId === undefined ? {} : { conversationId }),
      ...(mode === undefined ? {} : { mode }),
      ...(model === undefined ? {} : { model }),
      ...(effort === undefined ? {} : { effort }),
      ...(rawMetadata === undefined ? { hasMetadata: false as const } : { hasMetadata: true as const, metadata }),
      mimeType,
      bytes,
      ...(fileName === undefined ? {} : { fileName }),
    },
  };
}

/**
 * Mirror `normalizeBody` for audio uploads, except `text` is optional. The
 * attachment becomes an ordinary `document` `AgentAttachment` (the same shape
 * Telegram voice notes use); the harness persists it and exposes it to MCP
 * request-context transcribe tools. The adapter never transcribes.
 */
function normalizeAudioBody(
  audio: WebhookAudioInput,
  input: { readonly requestId: string; readonly defaultMode: WebhookInvocationMode },
): NormalizedAudioBody {
  const mode = audio.mode ?? input.defaultMode;
  if (mode !== "sync" && mode !== "async") {
    throw new WebhookAdapterError("invalid_config", "Webhook mode must be sync or async.");
  }
  return {
    ...(audio.text === undefined ? {} : { text: audio.text }),
    conversationId: audio.conversationId ?? `webhook:${input.requestId}`,
    mode,
    ...(audio.hasMetadata ? { metadata: audio.metadata } : {}),
    ...(audio.model === undefined ? {} : { model: audio.model }),
    ...(audio.effort === undefined ? {} : { effort: audio.effort }),
    attachment: {
      kind: "document",
      mimeType: audio.mimeType,
      data: audio.bytes.toString("base64"),
      name: audio.fileName ?? `voice-${input.requestId}${AUDIO_MIME_EXTENSIONS[audio.mimeType] ?? ""}`,
      sizeBytes: audio.bytes.byteLength,
    },
  };
}

function takeAudioInput(req: Request): WebhookAudioInput | undefined {
  const audio = audioInputs.get(req);
  if (audio !== undefined) {
    audioInputs.delete(req);
  }
  return audio;
}

/** Lowercase MIME base type with Apple/encoder aliases resolved; undefined when unsupported. */
function normalizeAudioMimeType(rawMimeType: string): string | undefined {
  const base = rawMimeType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (base.length === 0) {
    return undefined;
  }
  const canonical = AUDIO_MIME_ALIASES[base] ?? base;
  return AUDIO_ATTACHMENT_MIME_ALLOWLIST.includes(canonical) ? canonical : undefined;
}

/** Client filenames are display-only metadata; trim and cap them, never treat them as paths. */
function normalizeAudioFileName(rawName: string | undefined): string | undefined {
  const trimmed = normalizeOptionalString(rawName);
  if (trimmed === undefined) {
    return undefined;
  }
  if (trimmed === "blob") {
    return undefined;
  }
  return trimmed.slice(0, MAX_AUDIO_FILE_NAME_CHARS);
}

function firstQueryParam(value: unknown): string | undefined {
  return normalizeOptionalString(Array.isArray(value) ? value[0] : value);
}

function requestContentType(req: Request): string {
  return req.get("content-type") ?? "";
}

function displayRequestContentType(req: Request): string {
  const base = requestContentType(req).split(";")[0]?.trim() ?? "";
  return base.length === 0 ? "(missing)" : base;
}

function isAudioContent(req: Request): boolean {
  return (requestContentType(req).split(";")[0]?.trim().toLowerCase() ?? "").startsWith("audio/");
}

function isMultipartContent(req: Request): boolean {
  return (requestContentType(req).split(";")[0]?.trim().toLowerCase() ?? "") === "multipart/form-data";
}

function isEntityTooLargeError(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && (error as { readonly type?: unknown }).type === "entity.too.large";
}

function unsupportedAudioMimeError(received: string): string {
  return `Unsupported audio MIME type "${received}". Supported types: ${AUDIO_ATTACHMENT_MIME_ALLOWLIST.join(", ")}.`;
}

function oversizeAudioError(maxAttachmentBytes: number): string {
  return `Webhook audio exceeds the ${String(maxAttachmentBytes)}-byte attachment limit.`;
}

function audioParseFailure(status: number, error: string): AudioParseResult {
  return { ok: false, status, error };
}

function setStatus(
  statuses: Map<string, StoredStatus>,
  status: WebhookInvocationStatus,
  retentionMs: number,
  maxStoredRequests: number,
): void {
  statuses.set(status.requestId, {
    status: sanitizeWebhookInvocationStatus(status),
    updatedAtMs: Date.now(),
  });
  pruneStatuses(statuses, retentionMs, maxStoredRequests);
}

/**
 * A webhook responder is only structurally typed and may be supplied by a host,
 * so treat its metadata as untrusted at the HTTP boundary. The reserved
 * `metadata.summary.systemPrompt` field is private recorder data; remove exactly
 * that field while preserving every sibling and unrelated metadata branch.
 */
function sanitizeWebhookInvocationStatus(status: WebhookInvocationStatus): WebhookInvocationStatus {
  const snapshot: WebhookInvocationStatus = {
    ...status,
    ...(status.replyPartOutcomes === undefined
      ? {}
      : { replyPartOutcomes: status.replyPartOutcomes.map((outcome) => ({ ...outcome })) }),
  };
  if (snapshot.status !== "succeeded" || snapshot.metadata === undefined) {
    return snapshot;
  }
  return {
    ...snapshot,
    metadata: sanitizeWebhookResponseMetadata(snapshot.metadata),
  };
}

function sanitizeWebhookResponseMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const snapshot = jsonSafeSnapshot(metadata);
  const externalMetadata = isRecord(snapshot) ? snapshot : {};
  const summary = externalMetadata.summary;
  if (summary === undefined) {
    return externalMetadata;
  }
  // Only an ordinary JSON object is a valid summary. Arrays, functions,
  // primitives, accessors, cyclic values, and other malformed shapes are
  // removed rather than handed to JSON.stringify where a serialization hook
  // could reconstruct the reserved field.
  if (!isRecord(summary)) {
    delete externalMetadata.summary;
    return externalMetadata;
  }
  delete summary.systemPrompt;
  return externalMetadata;
}

type JsonSafeValue = null | boolean | number | string | JsonSafeValue[] | JsonSafeObject;
interface JsonSafeObject {
  [key: string]: JsonSafeValue;
}

const MAX_JSON_SNAPSHOT_DEPTH = 64;

/**
 * Clone untrusted responder metadata without invoking getters or `toJSON`.
 * Every sanitizer call builds a fresh graph, so the store, callback, HTTP
 * response and programmatic status APIs never share nested mutable objects.
 * Unsupported object properties are omitted; unsupported array entries become
 * null, matching JSON's fail-closed container behavior.
 */
function jsonSafeSnapshot(
  value: unknown,
  ancestors: ReadonlySet<object> = new Set(),
  depth = 0,
): JsonSafeValue | undefined {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value !== "object" || depth >= MAX_JSON_SNAPSHOT_DEPTH || ancestors.has(value)) {
    return undefined;
  }
  try {
    if (value instanceof Date) {
      return Date.prototype.toISOString.call(value);
    }
  } catch {
    return undefined;
  }

  const nextAncestors = new Set(ancestors);
  nextAncestors.add(value);
  if (Array.isArray(value)) {
    let length: number;
    try {
      length = value.length;
    } catch {
      return undefined;
    }
    const snapshot: JsonSafeValue[] = [];
    for (let index = 0; index < length; index += 1) {
      let descriptor: PropertyDescriptor | undefined;
      try {
        descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      } catch {
        snapshot.push(null);
        continue;
      }
      if (descriptor === undefined || !("value" in descriptor)) {
        snapshot.push(null);
        continue;
      }
      snapshot.push(jsonSafeSnapshot(descriptor.value, nextAncestors, depth + 1) ?? null);
    }
    return snapshot;
  }

  let descriptors: PropertyDescriptorMap;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    return undefined;
  }
  const snapshot = Object.create(null) as JsonSafeObject;
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (descriptor.enumerable !== true || !("value" in descriptor)) {
      continue;
    }
    const child = jsonSafeSnapshot(descriptor.value, nextAncestors, depth + 1);
    if (child === undefined) {
      continue;
    }
    Object.defineProperty(snapshot, key, {
      value: child,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return snapshot;
}

function pruneStatuses(
  statuses: Map<string, StoredStatus>,
  retentionMs: number,
  maxStoredRequests: number,
): void {
  const cutoff = Date.now() - retentionMs;
  for (const [requestId, status] of statuses) {
    if (status.updatedAtMs < cutoff) {
      statuses.delete(requestId);
    }
  }
  while (statuses.size > maxStoredRequests) {
    const oldest = statuses.keys().next().value as string | undefined;
    if (oldest === undefined) {
      return;
    }
    statuses.delete(oldest);
  }
}

function validateOptions(options: WebhookAdapterOptions): void {
  if (typeof options.responder?.respond !== "function") {
    throw new WebhookAdapterError("missing_required_config", "Webhook adapter requires a responder.");
  }
  if (!Number.isInteger(options.port ?? DEFAULT_PORT) || (options.port ?? DEFAULT_PORT) < 0 || (options.port ?? DEFAULT_PORT) > 65535) {
    throw new WebhookAdapterError("invalid_config", "Webhook adapter port must be an integer from 0 to 65535.");
  }
  validatePositiveInteger(options.retentionMs, "retentionMs");
  validatePositiveInteger(options.maxStoredRequests, "maxStoredRequests");
  validateAttachmentBytes(options.maxAttachmentBytes);
  const mode = options.defaultMode ?? DEFAULT_MODE;
  if (mode !== "sync" && mode !== "async") {
    throw new WebhookAdapterError("invalid_config", "Webhook defaultMode must be sync or async.");
  }
}

/**
 * Resolve the configured endpoints, applying defaults and validating uniqueness.
 * When no `endpoints` are given, a single legacy endpoint is synthesized from
 * `path`/`defaultMode` so existing single-webhook callers keep working.
 */
function resolveEndpoints(options: WebhookAdapterOptions): readonly ResolvedEndpoint[] {
  const defaultMode = options.defaultMode ?? DEFAULT_MODE;
  const source: readonly WebhookEndpointOption[] =
    options.endpoints !== undefined && options.endpoints.length > 0
      ? options.endpoints
      : [{ name: "default", path: options.path ?? DEFAULT_PATH, mode: defaultMode }];

  const resolved = source.map((endpoint): ResolvedEndpoint => {
    const path = normalizePath(endpoint.path);
    validateEndpointMaxRunMs(endpoint.maxRunMs, endpoint.name);
    return {
      name: endpoint.name,
      path,
      mode: endpoint.mode ?? defaultMode,
      statusBasePath: statusBasePathFor(path),
      ...(endpoint.prompt === undefined ? {} : { prompt: endpoint.prompt }),
      ...(endpoint.notify === undefined ? {} : { notify: endpoint.notify }),
      ...(endpoint.notifyConversationId === undefined ? {} : { notifyConversationId: endpoint.notifyConversationId }),
      ...(endpoint.notifyFallbackConversationId === undefined ? {} : { notifyFallbackConversationId: endpoint.notifyFallbackConversationId }),
      ...(endpoint.model === undefined ? {} : { model: endpoint.model }),
      ...(endpoint.effort === undefined ? {} : { effort: endpoint.effort }),
      ...(endpoint.maxRunMs === undefined ? {} : { maxRunMs: endpoint.maxRunMs }),
    };
  });

  assertUnique(resolved.map((endpoint) => endpoint.name), "name");
  assertUnique(resolved.map((endpoint) => endpoint.path), "path");
  return resolved;
}

function validateEndpointMaxRunMs(value: number | undefined, endpointName: string): void {
  if (value === undefined) {
    return;
  }
  if (!Number.isInteger(value) || value < 0 || value > MAX_RUN_MS) {
    throw new WebhookAdapterError(
      "invalid_config",
      `Webhook endpoint maxRunMs must be an integer from 0 to ${String(MAX_RUN_MS)} milliseconds.`,
      { endpointName, maxRunMs: value },
    );
  }
}

function assertUnique(values: readonly string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      throw new WebhookAdapterError("invalid_config", `Duplicate webhook endpoint ${label} "${value}".`, { [label]: value });
    }
    seen.add(value);
  }
}

function statusBasePathFor(path: string): string {
  return `${dirname(path) === "/" ? "" : dirname(path)}/requests`;
}

/** Prepend an endpoint's `prompt` (pre-instructions) to the posted text, if any. */
function composePromptText(prompt: string | undefined, text: string): string {
  return prompt === undefined || prompt.length === 0 ? text : `${prompt}\n\n${text}`;
}

async function resolveNotifyConversationId(
  endpoint: ResolvedEndpoint,
  requestConversationId: string,
  options: WebhookAdapterOptions,
  abortSignal: AbortSignal,
): Promise<string | undefined> {
  if (endpoint.notify !== true) {
    return undefined;
  }
  const configured = endpoint.notifyConversationId
    ?? (isDeliverableConversation(
      requestConversationId,
      NATIVE_NOTIFY_CALLBACK_CHANNEL_IDS,
    ) ? requestConversationId : undefined)
    ?? endpoint.notifyFallbackConversationId;
  if (configured !== undefined) {
    return configured;
  }
  if (options.resolveNotifyFallbackConversationId === undefined) {
    return undefined;
  }
  try {
    const resolution = Promise.resolve(options.resolveNotifyFallbackConversationId(abortSignal));
    return normalizeOptionalString(await raceAgainstAbort(resolution, abortSignal));
  } catch (error) {
    if (abortSignal.aborted) {
      throw abortSignal.reason ?? error;
    }
    options.logger?.warn?.("Webhook native-notify destination resolution failed; running without a reply target.", {
      endpointName: endpoint.name,
      error: errorToMessage(error),
    });
    return undefined;
  }
}

/**
 * Reject when the request is aborted even if host-owned resolver work ignores
 * the signal. Both settlement handlers stay attached so a later resolver
 * rejection is consumed after the abort path has already finalized the run.
 */
function raceAgainstAbort<T>(operation: Promise<T>, abortSignal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      abortSignal.removeEventListener("abort", onAbort);
      reject(abortSignal.reason ?? new Error("Webhook run was aborted."));
    };
    // Observe the resolver before consulting the signal. A host resolver can
    // synchronously trigger stop and only then return its promise; its eventual
    // rejection must still be consumed after abort wins.
    void operation.then(
      (value) => {
        abortSignal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        abortSignal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
    if (abortSignal.aborted) {
      onAbort();
    } else {
      abortSignal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

function validatePositiveInteger(value: number | undefined, name: string): void {
  if (value === undefined) {
    return;
  }
  if (!Number.isInteger(value) || value < 1) {
    throw new WebhookAdapterError("invalid_config", `Webhook ${name} must be a positive integer.`);
  }
}

function validateAttachmentBytes(value: number | undefined): void {
  if (value === undefined) {
    return;
  }
  if (!Number.isInteger(value) || value < 1 || value > MAX_ATTACHMENT_CONFIG_BYTES) {
    throw new WebhookAdapterError(
      "invalid_config",
      `Webhook maxAttachmentBytes must be an integer from 1 to ${String(MAX_ATTACHMENT_CONFIG_BYTES)} bytes.`,
    );
  }
}

export function normalizePath(path: string): string {
  const normalized = path.trim();
  if (!normalized.startsWith("/") || normalized.includes("?") || normalized.includes("#")) {
    throw new WebhookAdapterError("invalid_config", "Webhook path must be an absolute path without query or hash.");
  }
  return normalized.length === 1 ? DEFAULT_PATH : normalized.replace(/\/+$/u, "");
}

function errorToMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length === 0 ? undefined : normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
