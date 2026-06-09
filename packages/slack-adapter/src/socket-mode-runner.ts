import WebSocket from "ws";

import type { SlackEventCallback, SlackSocketModeEnvelope, SlackWebApi } from "./types.js";
import type { SlackEventHandlingResult } from "./adapter.js";

export interface SlackEventCallbackHandler {
  handleEventCallback(callback: SlackEventCallback): Promise<SlackEventHandlingResult>;
}

export interface SlackSocketModeRunnerBackoffOptions {
  initialMs?: number;
  maxMs?: number;
}

export interface SlackSocketModeRunnerLogger {
  debug?(message: string, metadata?: Record<string, unknown>): void;
  info?(message: string, metadata?: Record<string, unknown>): void;
  warn?(message: string, metadata?: Record<string, unknown>): void;
  error?(message: string, metadata?: Record<string, unknown>): void;
}

export interface SlackSocketModeRunnerOptions {
  api: SlackWebApi;
  handler: SlackEventCallbackHandler;
  reconnect?: SlackSocketModeRunnerBackoffOptions;
  webSocketFactory?: SlackWebSocketFactory;
  onEventResult?: (result: SlackEventHandlingResult) => void | Promise<void>;
  logger?: SlackSocketModeRunnerLogger;
}

export interface SlackSocketModeRunnerStartOptions {
  signal?: AbortSignal;
}

export type SlackWebSocketFactory = (url: string) => SlackWebSocketLike;

export interface SlackWebSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: "open", listener: () => void): this;
  on(event: "message", listener: (data: unknown) => void): this;
  on(event: "close", listener: (code?: number, reason?: unknown) => void): this;
  on(event: "error", listener: (error: unknown) => void): this;
}

const DEFAULT_INITIAL_BACKOFF_MS = 500;
const DEFAULT_MAX_BACKOFF_MS = 10_000;

export class SlackSocketModeRunner {
  private readonly api: SlackWebApi;
  private readonly handler: SlackEventCallbackHandler;
  private readonly initialBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly webSocketFactory: SlackWebSocketFactory;
  private readonly onEventResult:
    | ((result: SlackEventHandlingResult) => void | Promise<void>)
    | undefined;
  private readonly logger: SlackSocketModeRunnerLogger | undefined;
  private activeSocket: SlackWebSocketLike | undefined;

  constructor(options: SlackSocketModeRunnerOptions) {
    this.api = options.api;
    this.handler = options.handler;
    this.initialBackoffMs = options.reconnect?.initialMs ?? DEFAULT_INITIAL_BACKOFF_MS;
    this.maxBackoffMs = options.reconnect?.maxMs ?? DEFAULT_MAX_BACKOFF_MS;
    this.webSocketFactory = options.webSocketFactory ?? ((url) => new WebSocket(url) as SlackWebSocketLike);
    this.onEventResult = options.onEventResult;
    this.logger = options.logger;

    if (!Number.isFinite(this.initialBackoffMs) || this.initialBackoffMs < 0) {
      throw new RangeError("SlackSocketModeRunner initial backoff must be non-negative.");
    }
    if (!Number.isFinite(this.maxBackoffMs) || this.maxBackoffMs < this.initialBackoffMs) {
      throw new RangeError("SlackSocketModeRunner max backoff must be at least the initial backoff.");
    }
  }

  async start(options: SlackSocketModeRunnerStartOptions = {}): Promise<void> {
    if (isSignalAborted(options.signal)) {
      return;
    }

    let backoffMs = this.initialBackoffMs;
    while (!isSignalAborted(options.signal)) {
      try {
        await this.connectOnce(options.signal);
        backoffMs = this.initialBackoffMs;
      } catch (error) {
        if (isSignalAborted(options.signal)) {
          return;
        }
        this.logger?.warn?.("Slack Socket Mode connection failed; backing off.", {
          error: error instanceof Error ? error.message : String(error),
          backoffMs,
        });
        await abortableDelay(backoffMs, options.signal);
        backoffMs = Math.min(this.maxBackoffMs, Math.max(backoffMs * 2, 1));
      }
    }
  }

  private async connectOnce(signal: AbortSignal | undefined): Promise<void> {
    const connection = await this.api.appsConnectionsOpen({ ...(signal === undefined ? {} : { signal }) });
    if (isSignalAborted(signal)) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const socket = this.webSocketFactory(connection.url);
      this.activeSocket = socket;
      let settled = false;

      const settle = (action: () => void): void => {
        if (settled) {
          return;
        }
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        if (this.activeSocket === socket) {
          this.activeSocket = undefined;
        }
        action();
      };

      const onAbort = () => {
        try {
          socket.close();
        } finally {
          settle(resolve);
        }
      };

      const closeForReconnect = (): void => {
        try {
          socket.close();
        } catch {
          settle(resolve);
        }
      };
      const failForBackoff = (error: Error): void => {
        settle(() => reject(error));
        try {
          socket.close();
        } catch {
          // Already rejected; close errors do not change the reconnect decision.
        }
      };

      socket.on("open", () => {
        this.logger?.info?.("Slack Socket Mode connected.");
      });
      socket.on("message", (data: unknown) => {
        const envelope = parseSocketEnvelope(data);
        if (envelope === undefined) {
          this.logger?.warn?.("Slack Socket Mode envelope was malformed.");
          return;
        }
        if (envelope.type === "disconnect") {
          this.logger?.info?.("Slack Socket Mode disconnect requested.", {
            reason: envelope.reason,
          });
          if (envelope.reason !== "refresh_requested") {
            failForBackoff(new Error(`Slack Socket Mode disconnect requested: ${envelope.reason ?? "unknown"}`));
            return;
          }
          closeForReconnect();
          return;
        }
        void this.handleEnvelope(socket, envelope).catch((error: unknown) => {
          this.logger?.error?.("Slack Socket Mode envelope handling failed.", {
            error: error instanceof Error ? error.message : String(error),
          });
        });
      });
      socket.on("close", () => {
        settle(resolve);
      });
      socket.on("error", (error: unknown) => {
        settle(() => reject(error instanceof Error ? error : new Error(String(error))));
      });

      if (signal?.aborted === true) {
        onAbort();
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  private async handleEnvelope(
    socket: SlackWebSocketLike,
    envelope: SlackSocketModeEnvelope,
  ): Promise<void> {
    if (envelope.envelope_id !== undefined) {
      socket.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
    }
    if (envelope.type !== "events_api" || !isSlackEventCallback(envelope.payload)) {
      return;
    }

    const result = await this.handler.handleEventCallback(envelope.payload);
    await this.onEventResult?.(result);
  }
}

function parseSocketEnvelope(data: unknown): SlackSocketModeEnvelope | undefined {
  const text = dataToString(data);
  if (text === undefined) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!isRecord(parsed)) {
      return undefined;
    }
    const envelope: SlackSocketModeEnvelope = {};
    if (typeof parsed.envelope_id === "string") {
      envelope.envelope_id = parsed.envelope_id;
    }
    if (typeof parsed.type === "string") {
      envelope.type = parsed.type;
    }
    if (typeof parsed.accepts_response_payload === "boolean") {
      envelope.accepts_response_payload = parsed.accepts_response_payload;
    }
    if ("payload" in parsed) {
      envelope.payload = parsed.payload;
    }
    if (typeof parsed.reason === "string") {
      envelope.reason = parsed.reason;
    }
    return envelope;
  } catch {
    return undefined;
  }
}

function dataToString(data: unknown): string | undefined {
  if (typeof data === "string") {
    return data;
  }
  if (data instanceof Buffer) {
    return data.toString("utf8");
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf8");
  }
  if (Array.isArray(data) && data.every((part) => part instanceof Buffer)) {
    return Buffer.concat(data).toString("utf8");
  }
  return undefined;
}

function isSlackEventCallback(value: unknown): value is SlackEventCallback {
  if (!isRecord(value) || value.type !== "event_callback") {
    return false;
  }
  return typeof value.event_id === "string" && isRecord(value.event);
}

function isSignalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function abortableDelay(
  ms: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (ms <= 0 || signal?.aborted === true) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    const onAbort = () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      resolve();
    };

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
