import { randomUUID } from "node:crypto";
import { createServer } from "node:http";

import {
  createChannelUserCancelReason,
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
  isLoopbackHost,
  listen,
  normalizeOptionalString,
  readAuthorizationBearer,
} from "@mono-agent/agent-contracts";
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
  /**
   * The statically configured reasoning-effort level. Per-run overrides
   * (e.g. a per-trigger effort override on a given turn) do NOT flow through
   * here — those arrive via the `run_config` runtime_telemetry event instead.
   */
  readonly effort?: string;
  /**
   * The candidate models a TUI session may switch to — the host's primary model
   * first, then each configured fallback, as canonical reference strings. Absent
   * on older agents; the TUI tolerates that and offers no model picker.
   */
  readonly models?: readonly string[];
  /**
   * Per-model reasoning/effort metadata, keyed by the same canonical ref
   * strings that appear in `models`. Local-provider models resolve a precise
   * `reasoningMode` (`"effort"` with graded `effortLevels`, `"toggle"` for
   * binary thinking, or `"none"`); cloud models degrade to `{ reasoning: true }`
   * with no mode/levels so the TUI falls back to the global effort enum. Absent
   * on older agents; the TUI tolerates that and offers no model-aware picker.
   */
  readonly modelOptions?: Record<string, { readonly effortLevels?: readonly string[]; readonly reasoning?: boolean; readonly reasoningMode?: string; readonly label?: string }>;
}

export interface TuiAdapterOptions {
  readonly host?: string;
  readonly port?: number;
  readonly basePath?: string;
  readonly allowNonLoopback?: boolean;
  readonly apiKey?: string;
  readonly responder: AgentResponder;
  readonly logger?: TuiAdapterLogger;
  /**
   * Static info, OR a provider invoked fresh on every GET /v1/info. Discovery
   * of local-provider models can change after the adapter starts (an endpoint
   * started later, or restarted); a provider lets `/v1/info` reflect that
   * without a restart. The channel composition layer is responsible for
   * caching/rate-limiting any expensive work the provider does — this adapter
   * just calls it (and awaits it) on every request.
   */
  readonly info?: TuiAdapterInfo | (() => TuiAdapterInfo | Promise<TuiAdapterInfo>);
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
    void resolveInfo(options.info)
      .then((info) => {
        res.status(200).json({
          schema: TUI_WIRE_SCHEMA,
          pid: process.pid,
          ...(info?.label === undefined ? {} : { label: info.label }),
          ...(info?.model === undefined ? {} : { model: info.model }),
          ...(info?.effort === undefined ? {} : { effort: info.effort }),
          ...(info?.models === undefined || info.models.length === 0 ? {} : { models: info.models }),
          ...(info?.modelOptions === undefined || Object.keys(info.modelOptions).length === 0
            ? {}
            : { modelOptions: info.modelOptions }),
        });
      })
      .catch((error: unknown) => {
        options.logger?.error?.("TUI info provider failed.", { error: errorToMessage(error) });
        sendJsonError(res, 500, error);
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
    options.responder.cancel(conversationId, createChannelUserCancelReason("TUI"));
    res.status(202).json({ cancelled: conversationId });
  });

  app.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      next(error);
      return;
    }
    // 400 only for client mistakes (invalid_request, body-parse SyntaxError);
    // anything else is a server-side failure and must read as one.
    const isClientError =
      codeOf(error) === "invalid_request" ||
      (error instanceof SyntaxError && (error as { status?: unknown }).status === 400);
    sendJsonError(res, isClientError ? 400 : 500, error);
  });

  const address = await listen(server, port, host, {
    listenFailed: (reason) =>
      new TuiAdapterError("start_failed", "TUI adapter failed to listen.", { reason }),
    noAddress: () => new TuiAdapterError("start_failed", "TUI adapter did not receive a TCP address."),
  });

  async function closeRejectedServer(): Promise<void> {
    await close(server);
  }

  const boundNonLoopback = !isLoopbackHost(address.address);
  if (boundNonLoopback && options.allowNonLoopback !== true) {
    await closeRejectedServer();
    throw new TuiAdapterError(
      "unsafe_host",
      "TUI adapter resolved a loopback host to a non-loopback bind address.",
      { host, boundAddress: address.address, boundPort: address.port },
    );
  }

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
 * absorbed by the socket buffer. Oversized event frames are reduced or replaced
 * with a marker to meet the exported UTF-8 byte cap; non-event frames retain
 * their existing behavior.
 */
class NdjsonMessageStream implements AgentMessageStream {
  constructor(private readonly res: Response) {}

  writeFrame(frame: AgentStreamWireFrame): void {
    if (this.res.writableEnded) {
      return;
    }
    let line = serializeAgentStreamFrame(frame);
    if (Buffer.byteLength(line, "utf8") > MAX_FRAME_BYTES && frame.kind === "event") {
      line = serializeCappedEventFrame(frame.event, line);
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
 * Prepare a stable reducer for the payload-bearing event variants whose shape
 * the operator adapter preserves under truncation. The input is the parsed
 * snapshot of the already serialized frame, so getters/toJSON hooks from the
 * provider event cannot run again on every size probe. Other event variants
 * use the bounded oversized-event marker directly.
 */
function prepareEventReducer(
  event: AgentStreamEvent,
): ((maxPayloadChars: number) => AgentStreamEvent) | undefined {
  if (!isPayloadReducibleEventType(event.type)) {
    return undefined;
  }
  const metadata = { ...event.metadata, truncated: true };
  if (event.type === "tool_call_progress") {
    const partialResult = serializeUnknown(event.partialResult);
    return (maxPayloadChars) => ({
      ...event,
      partialResult: truncatePreparedText(partialResult, maxPayloadChars),
      metadata,
    });
  }
  if (event.type === "tool_call_completed") {
    const content = serializeUnknown(event.content);
    const argumentsText = event.arguments === undefined
      ? undefined
      : serializeUnknown(event.arguments);
    return (maxPayloadChars) => ({
      ...event,
      content: truncatePreparedText(content, maxPayloadChars),
      ...(argumentsText === undefined
        ? {}
        : { arguments: truncatePreparedText(argumentsText, maxPayloadChars) }),
      metadata,
    });
  }
  if (event.type === "tool_call_started") {
    const argumentsText = serializeUnknown(event.arguments);
    return (maxPayloadChars) => ({
      ...event,
      arguments: truncatePreparedText(argumentsText, maxPayloadChars),
      metadata,
    });
  }
  if (event.type === "assistant_thought") {
    return (maxPayloadChars) => ({
      ...event,
      text: event.text.slice(0, maxPayloadChars),
      metadata,
    });
  }
  return undefined;
}

function isPayloadReducibleEventType(type: string): boolean {
  return type === "assistant_thought"
    || type === "tool_call_started"
    || type === "tool_call_progress"
    || type === "tool_call_completed";
}

/**
 * Reject non-reducible variants before parsing their oversized payload, then
 * stabilize reducible variants from the already serialized frame and probe the
 * minimal candidate before binary search. The search never reserializes the
 * original unbounded provider object, and an oversized invariant field/metadata
 * object falls back after one minimal probe. Measuring each bounded candidate
 * keeps multibyte text, JSON escaping, metadata, and the trailing newline inside
 * the byte contract.
 */
function serializeCappedEventFrame(
  originalEvent: AgentStreamEvent,
  serializedFrame: string,
): string {
  if (!isPayloadReducibleEventType(originalEvent.type)) {
    return serializeOversizedEventMarker(originalEvent.type);
  }
  const event = (JSON.parse(serializedFrame) as Extract<
    AgentStreamWireFrame,
    { kind: "event" }
  >).event;
  const reduceEvent = prepareEventReducer(event);
  if (reduceEvent === undefined) {
    return serializeOversizedEventMarker(event.type);
  }

  const minimal = serializeAgentStreamFrame({ kind: "event", event: reduceEvent(0) });
  if (Buffer.byteLength(minimal, "utf8") > MAX_FRAME_BYTES) {
    return serializeOversizedEventMarker(event.type);
  }

  let lower = 1;
  let upper = MAX_FRAME_BYTES;
  let best = minimal;

  while (lower <= upper) {
    const maxPayloadChars = Math.floor((lower + upper) / 2);
    const candidate = serializeAgentStreamFrame({
      kind: "event",
      event: reduceEvent(maxPayloadChars),
    });
    if (Buffer.byteLength(candidate, "utf8") <= MAX_FRAME_BYTES) {
      best = candidate;
      lower = maxPayloadChars + 1;
    } else {
      upper = maxPayloadChars - 1;
    }
  }

  return best;
}

function serializeOversizedEventMarker(originalType: string): string {
  return serializeAgentStreamFrame({
    kind: "event",
    event: {
      type: "runtime_telemetry",
      kind: "oversized_event",
      data: { originalType: originalType.slice(0, 128) },
      metadata: { truncated: true },
    },
  });
}

function serializeUnknown(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value) ?? "";
}

function truncatePreparedText(text: string, cap: number): string {
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

async function resolveInfo(info: TuiAdapterOptions["info"]): Promise<TuiAdapterInfo | undefined> {
  if (typeof info === "function") {
    return await info();
  }
  return info;
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
