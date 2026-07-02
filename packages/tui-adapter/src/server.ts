import { randomUUID } from "node:crypto";
import { createServer } from "node:http";

import {
  isAgentResponseCancelledError,
  serializeAgentStreamFrame,
  type AgentMessageStream,
  type AgentRequestBase,
  type AgentResponder,
  type AgentResponse,
  type AgentStreamEvent,
  type AgentStreamWireFrame,
} from "@mono-agent/agent-contracts";
import {
  assertSafeBind,
  bearerTokensEqual,
  close,
  hostForUrl,
  listen,
  normalizeOptionalString,
  readAuthorizationBearer,
} from "@mono-agent/settings";
import express, { type NextFunction, type Request, type Response } from "express";

import { DEFAULT_BASE_PATH, DEFAULT_HOST, DEFAULT_PORT, MAX_FRAME_BYTES, TUI_WIRE_SCHEMA } from "./constants.js";
import { TuiAdapterError } from "./errors.js";

export interface TuiAdapterLogger {
  debug?(message: string, metadata?: Record<string, unknown>): void;
  info?(message: string, metadata?: Record<string, unknown>): void;
  warn?(message: string, metadata?: Record<string, unknown>): void;
  error?(message: string, metadata?: Record<string, unknown>): void;
}

/** Static facts surfaced by GET /v1/info so the TUI can label the session. */
export interface TuiAdapterInfo {
  readonly label?: string;
  readonly model?: string;
}

export interface TuiAdapterOptions {
  readonly host?: string;
  readonly port?: number;
  readonly basePath?: string;
  readonly allowNonLoopback?: boolean;
  readonly apiKey?: string;
  readonly responder: AgentResponder;
  readonly logger?: TuiAdapterLogger;
  readonly info?: TuiAdapterInfo;
  /**
   * Invoked when the already-listening HTTP server dies (e.g. EADDRINUSE
   * appearing later, socket-level failure). The hosting channel driver maps
   * this to its onFailure hook so the channel flips to "failed" instead of
   * silently serving nothing.
   */
  readonly onServerError?: (reason: string) => void;
}

export interface TuiAdapterStartResult {
  readonly url: string;
  readonly baseUrl: string;
  readonly infoUrl: string;
  readonly turnsUrl: string;
  readonly host: string;
  readonly port: number;
  stop(): Promise<void>;
}

export async function startTuiAdapter(options: TuiAdapterOptions): Promise<TuiAdapterStartResult> {
  if (typeof options.responder?.respond !== "function") {
    throw new TuiAdapterError("invalid_config", "startTuiAdapter requires a responder with respond().");
  }
  const host = options.host ?? DEFAULT_HOST;
  const port = options.port ?? DEFAULT_PORT;
  const basePath = normalizeBasePath(options.basePath ?? DEFAULT_BASE_PATH);
  const apiKey = normalizeOptionalString(options.apiKey);
  assertSafeBind(host, options.allowNonLoopback === true, (boundHost) =>
    new TuiAdapterError(
      "unsafe_host",
      "TUI adapter refuses to bind a non-loopback host unless allowNonLoopback is true.",
      { host: boundHost },
    ));

  const app = express();
  const server = createServer(app);
  const infoPath = `${basePath}/v1/info`;
  const turnsPath = `${basePath}/v1/turns`;
  const cancelPath = `${basePath}/v1/conversations/:conversationId/cancel`;

  app.use(express.json({ limit: "1mb" }));

  app.get(infoPath, (req, res) => {
    if (!authorize(req, res, apiKey)) {
      return;
    }
    res.status(200).json({
      schema: TUI_WIRE_SCHEMA,
      pid: process.pid,
      ...(options.info?.label === undefined ? {} : { label: options.info.label }),
      ...(options.info?.model === undefined ? {} : { model: options.info.model }),
    });
  });

  app.post(turnsPath, (req, res) => {
    if (!authorize(req, res, apiKey)) {
      return;
    }
    void handleTurn(req, res).catch((error: unknown) => {
      options.logger?.error?.("TUI turn failed before response.", { error: errorToMessage(error) });
      if (!res.headersSent) {
        sendJsonError(res, error instanceof TuiAdapterError && error.code === "invalid_request" ? 400 : 500, error);
      }
    });
  });

  app.post(cancelPath, (req, res) => {
    if (!authorize(req, res, apiKey)) {
      return;
    }
    const rawConversationId = req.params.conversationId;
    const conversationId = normalizeOptionalString(
      typeof rawConversationId === "string" ? rawConversationId : undefined,
    );
    if (conversationId === undefined) {
      sendJsonError(res, 400, new TuiAdapterError("invalid_request", "conversationId is required."));
      return;
    }
    if (typeof options.responder.cancel !== "function") {
      sendJsonError(res, 501, new TuiAdapterError("invalid_request", "This responder does not support cancel."));
      return;
    }
    options.responder.cancel(conversationId, "tui_cancel");
    res.status(202).json({ cancelled: conversationId });
  });

  app.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      next(error);
      return;
    }
    sendJsonError(res, 400, error);
  });

  const address = await listen(server, port, host, {
    listenFailed: (reason) =>
      new TuiAdapterError("start_failed", "TUI adapter failed to listen.", { reason }),
    noAddress: () => new TuiAdapterError("start_failed", "TUI adapter did not receive a TCP address."),
  });
  server.on("error", (error) => {
    options.onServerError?.(errorToMessage(error));
  });
  const boundPort = address.port;
  const url = `http://${hostForUrl(host)}:${boundPort}`;

  async function handleTurn(req: Request, res: Response): Promise<void> {
    const body = normalizeTurnBody(req.body);
    const controller = new AbortController();
    const requestId = randomUUID();
    const request: AgentRequestBase = {
      conversationId: body.conversationId,
      text: body.text,
      abortSignal: controller.signal,
      metadata: { ...body.metadata, source: "tui", tuiRequestId: requestId },
    };

    res.status(200);
    res.setHeader("Content-Type", "application/x-ndjson");
    res.setHeader("Cache-Control", "no-cache");
    res.socket?.setNoDelay(true);
    res.flushHeaders();

    res.once("close", () => {
      if (!res.writableEnded) {
        controller.abort(new Error("TUI client disconnected."));
      }
    });

    const stream = new NdjsonMessageStream(res);
    try {
      const response: AgentResponse = await options.responder.respond(request, stream);
      stream.writeFrame({
        kind: "finish",
        ...(response.text === undefined ? {} : { finalText: response.text }),
        ...(response.metadata === undefined ? {} : { metadata: response.metadata }),
      });
    } catch (error) {
      const cancelled = isAgentResponseCancelledError(error) || controller.signal.aborted;
      const code = codeOf(error);
      stream.writeFrame({
        kind: "error",
        message: errorToMessage(error),
        ...(code === undefined ? {} : { code }),
        cancelled,
      });
    } finally {
      res.end();
    }
  }

  return {
    url,
    baseUrl: `${url}${basePath}`,
    infoUrl: `${url}${infoPath}`,
    turnsUrl: `${url}${turnsPath}`,
    host,
    port: boundPort,
    async stop() {
      await close(server);
    },
  };
}

/**
 * Serializes each AgentMessageStream callback as one NDJSON frame. Writes are
 * fire-and-forget: a slow TUI must never stall the harness, so backpressure is
 * absorbed by the socket buffer and oversized event payloads are truncated.
 */
class NdjsonMessageStream implements AgentMessageStream {
  constructor(private readonly res: Response) {}

  writeFrame(frame: AgentStreamWireFrame): void {
    if (this.res.writableEnded) {
      return;
    }
    let line = serializeAgentStreamFrame(frame);
    if (Buffer.byteLength(line, "utf8") > MAX_FRAME_BYTES && frame.kind === "event") {
      line = serializeAgentStreamFrame({ kind: "event", event: truncateEvent(frame.event) });
    }
    this.res.write(line);
  }

  async status(text: string): Promise<void> {
    this.writeFrame({ kind: "status", text });
  }

  async append(delta: string): Promise<void> {
    this.writeFrame({ kind: "append", delta });
  }

  async replace(text: string): Promise<void> {
    this.writeFrame({ kind: "replace", text });
  }

  async event(event: AgentStreamEvent): Promise<void> {
    this.writeFrame({ kind: "event", event });
  }

  async finish(): Promise<void> {
    // The terminal "finish" frame is written by handleTurn from the responder's
    // AgentResponse (which carries metadata); mid-stream finish() is a no-op.
  }
}

/**
 * Shrink the unbounded fields (tool results / progress) of an oversized event
 * and mark the truncation. The full payload stays available in run artifacts.
 */
function truncateEvent(event: AgentStreamEvent): AgentStreamEvent {
  const cap = MAX_FRAME_BYTES / 2;
  if (event.type === "tool_call_progress") {
    return {
      ...event,
      partialResult: truncateUnknown(event.partialResult, cap),
      metadata: { ...event.metadata, truncated: true },
    };
  }
  if (event.type === "tool_call_completed") {
    return {
      ...event,
      content: truncateUnknown(event.content, cap),
      ...(event.arguments === undefined ? {} : { arguments: truncateUnknown(event.arguments, cap) }),
      metadata: { ...event.metadata, truncated: true },
    };
  }
  if (event.type === "tool_call_started") {
    return {
      ...event,
      arguments: truncateUnknown(event.arguments, cap),
      metadata: { ...event.metadata, truncated: true },
    };
  }
  if (event.type === "assistant_thought") {
    return {
      ...event,
      text: event.text.slice(0, cap),
      metadata: { ...event.metadata, truncated: true },
    };
  }
  // Remaining variants are small fixed shapes; if one still overflows, stringify-and-cut.
  return {
    type: "runtime_telemetry",
    kind: "oversized_event",
    data: { originalType: event.type, preview: JSON.stringify(event).slice(0, 1024) },
    metadata: { truncated: true },
  };
}

function truncateUnknown(value: unknown, cap: number): string {
  const text = typeof value === "string" ? value : JSON.stringify(value) ?? "";
  return text.length > cap ? `${text.slice(0, cap)}… [truncated]` : text;
}

interface NormalizedTurnBody {
  readonly conversationId: string;
  readonly text: string;
  readonly metadata: Record<string, unknown>;
}

function normalizeTurnBody(body: unknown): NormalizedTurnBody {
  if (typeof body !== "object" || body === null) {
    throw new TuiAdapterError("invalid_request", "Request body must be a JSON object.");
  }
  const record = body as Record<string, unknown>;
  const conversationId = normalizeOptionalString(
    typeof record.conversationId === "string" ? record.conversationId : undefined,
  );
  const text = typeof record.text === "string" ? record.text : undefined;
  if (conversationId === undefined) {
    throw new TuiAdapterError("invalid_request", "conversationId is required.");
  }
  if (text === undefined || text.length === 0) {
    throw new TuiAdapterError("invalid_request", "text is required.");
  }
  const metadata =
    typeof record.metadata === "object" && record.metadata !== null && !Array.isArray(record.metadata)
      ? (record.metadata as Record<string, unknown>)
      : {};
  return { conversationId, text, metadata };
}

function authorize(req: Request, res: Response, apiKey: string | undefined): boolean {
  if (apiKey === undefined) {
    return true;
  }
  const presented = readAuthorizationBearer(req.header("authorization"));
  if (presented !== undefined && bearerTokensEqual(presented, apiKey)) {
    return true;
  }
  res.status(401).json({ error: { message: "Invalid API key.", code: "invalid_api_key" } });
  return false;
}

function sendJsonError(res: Response, status: number, error: unknown): void {
  res.status(status).json({
    error: {
      message: errorToMessage(error),
      ...(codeOf(error) === undefined ? {} : { code: codeOf(error) }),
    },
  });
}

function codeOf(error: unknown): string | undefined {
  const candidate = (error as { code?: unknown } | null)?.code;
  return typeof candidate === "string" ? candidate : undefined;
}

function errorToMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }
  return String(error);
}

function normalizeBasePath(basePath: string): string {
  if (!basePath.startsWith("/")) {
    throw new TuiAdapterError("invalid_config", "basePath must start with '/'.");
  }
  return basePath.length === 1 ? "" : basePath.replace(/\/+$/u, "");
}
