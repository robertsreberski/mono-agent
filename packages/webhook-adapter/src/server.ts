import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { dirname } from "node:path/posix";

import {
  isAgentResponseCancelledError,
  type AgentMessageStream,
  type AgentRequestBase,
  type AgentResponder,
  type AgentResponse,
} from "@worklab-ai/agent-contracts";
import {
  assertSafeBind,
  close,
  hostForUrl,
  listen,
} from "@worklab-ai/settings";
import express, { type NextFunction, type Request, type Response } from "express";

export type WebhookInvocationMode = "sync" | "async";

export interface WebhookRequestMetadata {
  readonly requestId: string;
  readonly mode: WebhookInvocationMode;
  readonly method: string;
  readonly path: string;
  readonly receivedAt: string;
  readonly remoteAddress?: string;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly payloadMetadata?: unknown;
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

export interface WebhookAdapterOptions {
  readonly host?: string;
  readonly port?: number;
  readonly path?: string;
  readonly allowNonLoopback?: boolean;
  readonly defaultMode?: WebhookInvocationMode;
  readonly retentionMs?: number;
  readonly maxStoredRequests?: number;
  readonly responder: AgentResponder<WebhookInvocationRequest, AgentMessageStream, AgentResponse>;
  readonly logger?: WebhookAdapterLogger;
}

export interface WebhookAdapterStartResult {
  readonly url: string;
  readonly invokeUrl: string;
  readonly statusBasePath: string;
  readonly host: string;
  readonly port: number;
  readonly activeRequestCount: number;
  getStatus(requestId: string): WebhookInvocationStatus | undefined;
  stop(): Promise<void>;
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
  const path = normalizePath(options.path ?? DEFAULT_PATH);
  const retentionMs = options.retentionMs ?? DEFAULT_RETENTION_MS;
  const maxStoredRequests = options.maxStoredRequests ?? DEFAULT_MAX_STORED_REQUESTS;
  const defaultMode = options.defaultMode ?? DEFAULT_MODE;
  assertSafeBind(host, options.allowNonLoopback === true, (boundHost) =>
    new WebhookAdapterError(
      "unsafe_host",
      "Webhook adapter refuses to bind a non-loopback host unless allowNonLoopback is true.",
      { host: boundHost },
    ));

  const app = express();
  const server = createServer(app);
  const activeByConversation = new Map<string, ActiveRun>();
  const statuses = new Map<string, StoredStatus>();
  const statusBasePath = `${dirname(path) === "/" ? "" : dirname(path)}/requests`;

  app.use(express.json({ limit: "1mb" }));
  app.post(path, (req, res) => {
    void handleInvoke(req, res).catch((error: unknown) => {
      options.logger?.error?.("Webhook invocation failed before response.", {
        error: errorToMessage(error),
      });
      if (!res.headersSent) {
        res.status(500).json({ status: "failed", error: errorToMessage(error) });
      }
    });
  });
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

  async function handleInvoke(req: Request, res: Response): Promise<void> {
    pruneStatuses(statuses, retentionMs, maxStoredRequests);
    const requestId = randomUUID();
    const receivedAt = new Date().toISOString();
    const body = normalizeBody(req.body, {
      requestId,
      defaultMode,
    });
    const statusUrl = `${statusBasePath}/${requestId}`;
    const controller = new AbortController();

    if (activeByConversation.has(body.conversationId)) {
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
    activeByConversation.set(body.conversationId, active);
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
      text: body.text,
      abortSignal: controller.signal,
      metadata: {
        webhook: {
          requestId,
          mode: body.mode,
          method: req.method,
          path: req.path,
          receivedAt,
          ...(req.socket.remoteAddress === undefined ? {} : { remoteAddress: req.socket.remoteAddress }),
          headers: req.headers,
          ...(body.metadata === undefined ? {} : { payloadMetadata: body.metadata }),
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
      void runResponder({ request, statusUrl, receivedAt, startedAt, statuses, activeByConversation, active, options, retentionMs, maxStoredRequests });
      return;
    }

    res.once("close", () => {
      if (!res.writableEnded) {
        controller.abort(new Error("Webhook client disconnected."));
      }
    });

    const status = await runResponder({ request, statusUrl, receivedAt, startedAt, statuses, activeByConversation, active, options, retentionMs, maxStoredRequests });
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

  return {
    url,
    invokeUrl: `${url}${path}`,
    statusBasePath,
    host,
    port: boundPort,
    get activeRequestCount() {
      return activeByConversation.size;
    },
    getStatus(requestId: string): WebhookInvocationStatus | undefined {
      return statuses.get(requestId)?.status;
    },
    async stop() {
      for (const active of activeByConversation.values()) {
        active.controller.abort(new Error("Webhook adapter stopped."));
      }
      activeByConversation.clear();
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
  readonly activeByConversation: Map<string, ActiveRun>;
  readonly active: ActiveRun;
  readonly options: WebhookAdapterOptions;
  readonly retentionMs: number;
  readonly maxStoredRequests: number;
}): Promise<WebhookInvocationStatus> {
  const stream = new InMemoryMessageStream();
  let status: WebhookInvocationStatus;
  try {
    const response = await input.options.responder.respond(input.request, stream);
    await stream.finish(response.text);
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
  } catch (error) {
    const cancelled = input.request.abortSignal.aborted || isAgentResponseCancelledError(error);
    status = {
      status: cancelled ? "cancelled" : "failed",
      requestId: input.active.requestId,
      conversationId: input.request.conversationId,
      statusUrl: input.statusUrl,
      receivedAt: input.receivedAt,
      startedAt: input.startedAt,
      completedAt: new Date().toISOString(),
      error: errorToMessage(error),
    };
    input.options.logger?.[cancelled ? "warn" : "error"]?.("Webhook responder failed.", {
      requestId: input.active.requestId,
      conversationId: input.request.conversationId,
      error: status.error,
    });
  } finally {
    if (input.activeByConversation.get(input.request.conversationId) === input.active) {
      input.activeByConversation.delete(input.request.conversationId);
    }
  }
  setStatus(input.statuses, status, input.retentionMs, input.maxStoredRequests);
  return status;
}

class InMemoryMessageStream implements AgentMessageStream {
  private currentText = "";
  private done = false;

  get text(): string {
    return this.currentText.trim();
  }

  async status(_text: string): Promise<void> {}

  async append(delta: string): Promise<void> {
    this.assertOpen();
    this.currentText += delta;
  }

  async replace(text: string): Promise<void> {
    this.assertOpen();
    this.currentText = text;
  }

  async finish(finalText?: string): Promise<void> {
    if (this.done) {
      return;
    }
    this.done = true;
    if (finalText !== undefined) {
      this.currentText = finalText;
    }
  }

  private assertOpen(): void {
    if (this.done) {
      throw new WebhookAdapterError("invalid_config", "Cannot write to a finished webhook stream.");
    }
  }
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
  return {
    text,
    conversationId: rawConversationId ?? `webhook:${input.requestId}`,
    mode,
    ...(body.metadata === undefined ? {} : { metadata: body.metadata }),
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
  normalizePath(options.path ?? DEFAULT_PATH);
}

function validatePositiveInteger(value: number | undefined, name: string): void {
  if (value === undefined) {
    return;
  }
  if (!Number.isInteger(value) || value < 1) {
    throw new WebhookAdapterError("invalid_config", `Webhook ${name} must be a positive integer.`);
  }
}

function normalizePath(path: string): string {
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
