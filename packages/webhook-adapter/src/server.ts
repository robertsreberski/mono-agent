import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { dirname } from "node:path/posix";

import {
  BufferedMessageStream,
  isAgentResponseCancelledError,
  type AgentMessageStream,
  type AgentRequestBase,
  type AgentResponder,
  type AgentResponse,
} from "@mono-agent/agent-contracts";
import {
  assertSafeBind,
  close,
  hostForUrl,
  listen,
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

export type WebhookInvocationStatus =
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
 * One HTTP endpoint of the webhook server. Multiple endpoints share one server,
 * host and port; each has its own POST path, default mode, and optional `prompt`
 * (pre-instructions prepended to the incoming request text).
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
  /** Per-endpoint runtime model override (raw string; a request body `model` wins). */
  readonly model?: string;
  /** Per-endpoint reasoning effort override (raw string; a request body `effort` wins). */
  readonly effort?: string;
}

export interface WebhookAdapterOptions {
  readonly host?: string;
  readonly port?: number;
  readonly allowNonLoopback?: boolean;
  readonly retentionMs?: number;
  readonly maxStoredRequests?: number;
  /**
   * Wall-clock bound (ms) for a single webhook run. On timeout the request
   * signal is aborted and the conversation's slot is reclaimed even if the
   * responder never settles. Omit or set <= 0 to disable. Matters most for
   * async runs, which have no client disconnect to bound them.
   */
  readonly maxRunMs?: number;
  readonly responder: AgentResponder<WebhookInvocationRequest, AgentMessageStream, AgentResponse>;
  readonly logger?: WebhookAdapterLogger;
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
  readonly model?: string;
  readonly effort?: string;
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

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 0;
const DEFAULT_PATH = "/webhook/invoke";
const DEFAULT_MODE: WebhookInvocationMode = "sync";
const DEFAULT_RETENTION_MS = 300_000;
const DEFAULT_MAX_STORED_REQUESTS = 100;

export async function startWebhookAdapter(options: WebhookAdapterOptions): Promise<WebhookAdapterStartResult> {
  validateOptions(options);
  const host = options.host ?? DEFAULT_HOST;
  const port = options.port ?? DEFAULT_PORT;
  const retentionMs = options.retentionMs ?? DEFAULT_RETENTION_MS;
  const maxStoredRequests = options.maxStoredRequests ?? DEFAULT_MAX_STORED_REQUESTS;
  const endpoints = resolveEndpoints(options);
  assertSafeBind(host, options.allowNonLoopback === true, (boundHost) =>
    new WebhookAdapterError(
      "unsafe_host",
      "Webhook adapter refuses to bind a non-loopback host unless allowNonLoopback is true.",
      { host: boundHost },
    ));

  const app = express();
  const server = createServer(app);
  // Active runs are keyed by `${endpoint.name}:${conversationId}` so the same
  // conversation can be in-flight on two different endpoints without a false 409.
  const activeByRun = new Map<string, ActiveRun>();
  const statuses = new Map<string, StoredStatus>();

  app.use(express.json({ limit: "1mb" }));
  for (const endpoint of endpoints) {
    app.post(endpoint.path, (req, res) => {
      void handleInvoke(req, res, endpoint).catch((error: unknown) => {
        options.logger?.error?.("Webhook invocation failed before response.", {
          endpoint: endpoint.name,
          error: errorToMessage(error),
        });
        if (!res.headersSent) {
          res.status(500).json({ status: "failed", error: errorToMessage(error) });
        }
      });
    });
  }
  // Register one status route per UNIQUE base path (endpoints sharing a parent
  // directory share a status route; lookups hit the shared, requestId-keyed store).
  for (const statusBasePath of new Set(endpoints.map((endpoint) => endpoint.statusBasePath))) {
    app.get(`${statusBasePath}/:requestId`, (req, res) => {
      pruneStatuses(statuses, retentionMs, maxStoredRequests);
      const requestId = req.params.requestId;
      const stored = requestId === undefined ? undefined : statuses.get(requestId);
      if (stored === undefined) {
        res.status(404).json({ status: "not_found", requestId });
        return;
      }
      res.status(200).json(stored.status);
    });
  }
  app.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      next(error);
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
  const url = `http://${hostForUrl(host)}:${boundPort}`;

  async function handleInvoke(req: Request, res: Response, endpoint: ResolvedEndpoint): Promise<void> {
    pruneStatuses(statuses, retentionMs, maxStoredRequests);
    const requestId = randomUUID();
    const receivedAt = new Date().toISOString();
    const body = normalizeBody(req.body, {
      requestId,
      defaultMode: endpoint.mode,
    });
    const statusUrl = `${endpoint.statusBasePath}/${requestId}`;
    const runKey = `${endpoint.name}:${body.conversationId}`;
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
      text: composePromptText(endpoint.prompt, body.text),
      abortSignal: controller.signal,
      metadata: {
        webhook: {
          requestId,
          endpointName: endpoint.name,
          mode: body.mode,
          method: req.method,
          path: req.path,
          receivedAt,
          ...(req.socket.remoteAddress === undefined ? {} : { remoteAddress: req.socket.remoteAddress }),
          headers: req.headers,
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

    if (body.mode === "async") {
      res.status(202).json({
        status: "accepted",
        requestId,
        conversationId: body.conversationId,
        statusUrl,
        receivedAt,
      });
      void runResponder({ request, statusUrl, receivedAt, startedAt, statuses, activeByRun, runKey, active, options, retentionMs, maxStoredRequests });
      return;
    }

    res.once("close", () => {
      if (!res.writableEnded) {
        controller.abort(new Error("Webhook client disconnected."));
      }
    });

    const status = await runResponder({ request, statusUrl, receivedAt, startedAt, statuses, activeByRun, runKey, active, options, retentionMs, maxStoredRequests });
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
      return statuses.get(requestId)?.status;
    },
    async stop() {
      for (const active of activeByRun.values()) {
        active.controller.abort(new Error("Webhook adapter stopped."));
      }
      activeByRun.clear();
      await close(server);
    },
  };
}

async function runResponder(input: {
  readonly request: WebhookInvocationRequest;
  readonly statusUrl: string;
  readonly receivedAt: string;
  readonly startedAt: string;
  readonly statuses: Map<string, StoredStatus>;
  readonly activeByRun: Map<string, ActiveRun>;
  readonly runKey: string;
  readonly active: ActiveRun;
  readonly options: WebhookAdapterOptions;
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
  const maxRunMs = input.options.maxRunMs;
  let timedOut = false;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  try {
    const respondPromise = (async () => {
      const result = await input.options.responder.respond(input.request, stream);
      await stream.finish(result.text);
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
        ...(stream.text.length === 0 ? {} : { text: stream.text }),
        ...(response.metadata === undefined ? {} : { metadata: response.metadata }),
      };
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
        ? `Webhook run timed out after ${String(maxRunMs)}ms (responder did not settle); reclaiming the slot.`
        : errorToMessage(error),
    };
    input.options.logger?.[cancelled ? "warn" : "error"]?.("Webhook responder failed.", {
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
  setStatus(input.statuses, status, input.retentionMs, input.maxStoredRequests);
  emitResult(input, status);
  return status;
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

function setStatus(
  statuses: Map<string, StoredStatus>,
  status: WebhookInvocationStatus,
  retentionMs: number,
  maxStoredRequests: number,
): void {
  statuses.set(status.requestId, { status, updatedAtMs: Date.now() });
  pruneStatuses(statuses, retentionMs, maxStoredRequests);
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
    return {
      name: endpoint.name,
      path,
      mode: endpoint.mode ?? defaultMode,
      statusBasePath: statusBasePathFor(path),
      ...(endpoint.prompt === undefined ? {} : { prompt: endpoint.prompt }),
      ...(endpoint.notify === undefined ? {} : { notify: endpoint.notify }),
      ...(endpoint.notifyConversationId === undefined ? {} : { notifyConversationId: endpoint.notifyConversationId }),
      ...(endpoint.model === undefined ? {} : { model: endpoint.model }),
      ...(endpoint.effort === undefined ? {} : { effort: endpoint.effort }),
    };
  });

  assertUnique(resolved.map((endpoint) => endpoint.name), "name");
  assertUnique(resolved.map((endpoint) => endpoint.path), "path");
  return resolved;
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

function validatePositiveInteger(value: number | undefined, name: string): void {
  if (value === undefined) {
    return;
  }
  if (!Number.isInteger(value) || value < 1) {
    throw new WebhookAdapterError("invalid_config", `Webhook ${name} must be a positive integer.`);
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
