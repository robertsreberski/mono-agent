import { createServer } from "node:http";

import type { RunEventBus, RunEventFrame } from "@mono-agent/agent-contracts";
import {
  assertSafeBind,
  bearerTokensEqual,
  close,
  hostForUrl,
  listen,
  normalizeOptionalString,
  readAuthorizationBearer,
} from "@mono-agent/settings";
import express, { type Request, type Response } from "express";

import {
  DEFAULT_LIVE_BASE_PATH,
  DEFAULT_LIVE_HOST,
  DEFAULT_LIVE_PORT,
  LIVE_ADAPTER_INFO_SCHEMA,
  LIVE_HEARTBEAT_INTERVAL_MS,
} from "./constants.js";
import { LiveAdapterError } from "./errors.js";

const MAX_SSE_QUEUE_FRAMES = 1_000;

export interface LiveAdapterLogger {
  debug?(message: string, metadata?: Record<string, unknown>): void;
  info?(message: string, metadata?: Record<string, unknown>): void;
  warn?(message: string, metadata?: Record<string, unknown>): void;
  error?(message: string, metadata?: Record<string, unknown>): void;
}

export interface LiveAdapterOptions {
  /** In-process bus the adapter subscribes to and replays. Read-only — never written. */
  readonly bus: RunEventBus;
  readonly host?: string;
  readonly port?: number;
  readonly basePath?: string;
  readonly allowNonLoopback?: boolean;
  /** When set, both routes require `Authorization: Bearer <apiKey>`; a mismatch is a 401. */
  readonly apiKey?: string;
  /** Human label surfaced by GET /v1/info so a discovery probe can name the instance. */
  readonly label?: string;
  /**
   * Invoked when the already-listening HTTP server dies (e.g. a socket-level
   * failure appearing later). The hosting channel driver maps this to its
   * onFailure hook so the channel flips to "failed" instead of silently serving
   * nothing.
   */
  readonly onServerError?: (reason: string) => void;
  readonly logger?: LiveAdapterLogger;
}

export interface LiveAdapterHandle {
  /** SSE root: `http://<host>:<actualPort><basePath>`. `/v1/events` and `/v1/info` hang off it. */
  readonly baseUrl: string;
  /** Tear down every open SSE connection and close the HTTP server. */
  stop(): Promise<void>;
}

/** One live SSE connection, tracked so `stop()` can end it deterministically. */
interface LiveConnection {
  readonly res: Response;
  /** Idempotent: clears the heartbeat and unsubscribes from the bus. */
  readonly teardown: () => void;
}

/**
 * Start a loopback, read-only SSE server that relays a {@link RunEventBus} to
 * operator surfaces. It observes only: there is no turn-driving endpoint and no
 * reference to a responder.
 */
export async function startLiveAdapter(options: LiveAdapterOptions): Promise<LiveAdapterHandle> {
  if (options.bus === undefined || typeof options.bus.subscribe !== "function") {
    throw new LiveAdapterError("invalid_config", "startLiveAdapter requires a RunEventBus.");
  }
  const host = options.host ?? DEFAULT_LIVE_HOST;
  const port = options.port ?? DEFAULT_LIVE_PORT;
  const basePath = normalizeBasePath(options.basePath ?? DEFAULT_LIVE_BASE_PATH);
  const apiKey = normalizeOptionalString(options.apiKey);
  const label = normalizeOptionalString(options.label);

  assertSafeBind(host, options.allowNonLoopback === true, (boundHost) =>
    new LiveAdapterError(
      "unsafe_host",
      "Live adapter refuses to bind a non-loopback host unless allowNonLoopback is true.",
      { host: boundHost },
    ));

  const app = express();
  const server = createServer(app);
  const infoPath = `${basePath}/v1/info`;
  const eventsPath = `${basePath}/v1/events`;
  const connections = new Set<LiveConnection>();

  app.get(infoPath, (req, res) => {
    if (!authorize(req, res, apiKey)) {
      return;
    }
    res.status(200).json({
      schema: LIVE_ADAPTER_INFO_SCHEMA,
      pid: process.pid,
      ...(label === undefined ? {} : { label }),
    });
  });

  app.get(eventsPath, (req, res) => {
    if (!authorize(req, res, apiKey)) {
      return;
    }
    handleEvents(res);
  });

  const address = await listen(server, port, host, {
    listenFailed: (reason) =>
      new LiveAdapterError("start_failed", "Live adapter failed to listen.", { reason }),
    noAddress: () => new LiveAdapterError("start_failed", "Live adapter did not receive a TCP address."),
  });
  server.on("error", (error) => {
    options.onServerError?.(errorToMessage(error));
  });
  const baseUrl = `http://${hostForUrl(host)}:${address.port}${basePath}`;

  function handleEvents(res: Response): void {
    // SSE handshake. Mirror the openai-api-adapter header set; disable Nagle so
    // each frame flushes immediately, and flush headers before subscribing so
    // the client sees the stream open promptly.
    res.status(200);
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.socket?.setNoDelay(true);
    res.flushHeaders();

    const queue: string[] = [];
    let draining = false;
    let closed = false;
    let teardown: (() => void) | undefined;

    const flush = (): void => {
      while (!closed && !draining && queue.length > 0) {
        const payload = queue.shift();
        if (payload === undefined) {
          break;
        }
        if (res.writableEnded) {
          closed = true;
          return;
        }
        const ok = res.write(payload);
        if (!ok) {
          draining = true;
          res.once("drain", () => {
            draining = false;
            flush();
          });
          return;
        }
      }
    };

    const closeSlowClient = (): void => {
      if (closed) {
        return;
      }
      options.logger?.warn?.("Closing slow live SSE client after queue overflow.", {
        queuedFrames: queue.length,
        maxQueuedFrames: MAX_SSE_QUEUE_FRAMES,
      });
      teardown?.();
      closed = true;
      queue.length = 0;
      if (!res.writableEnded) {
        res.end();
      }
    };

    const enqueue = (payload: string): void => {
      if (closed || res.writableEnded) {
        return;
      }
      queue.push(payload);
      if (queue.length > MAX_SSE_QUEUE_FRAMES) {
        closeSlowClient();
        return;
      }
      flush();
    };

    const write = (frame: RunEventFrame): void => {
      const payload = serializeFrame(frame, options.logger);
      if (payload !== undefined) {
        enqueue(payload);
      }
    };

    // Replay the ring buffer (oldest-first) so a late joiner can reconstruct
    // in-flight runs, then stream every subsequent frame the same way.
    for (const frame of options.bus.recentFrames()) {
      write(frame);
    }
    if (closed) {
      return;
    }
    const unsubscribe = options.bus.subscribe(write);

    const heartbeat = setInterval(() => {
      if (closed || draining || res.writableEnded) {
        return;
      }
      enqueue(": ping\n\n");
    }, LIVE_HEARTBEAT_INTERVAL_MS);
    // Never keep the process alive solely for the heartbeat timer.
    heartbeat.unref?.();

    let torn = false;
    teardown = (): void => {
      if (torn) {
        return;
      }
      torn = true;
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
      queue.length = 0;
    };
    const connection: LiveConnection = { res, teardown };
    connections.add(connection);

    res.once("close", () => {
      connections.delete(connection);
      teardown();
    });
  }

  return {
    baseUrl,
    async stop() {
      // SSE connections never end on their own, so `server.close()` would hang
      // waiting for them — tear each down and end the response first.
      for (const connection of [...connections]) {
        connection.teardown();
        if (!connection.res.writableEnded) {
          connection.res.end();
        }
      }
      connections.clear();
      await close(server);
    },
  };
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

function errorToMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }
  return String(error);
}

function normalizeBasePath(basePath: string): string {
  if (!isLiteralBasePath(basePath)) {
    throw new LiveAdapterError("invalid_config", "basePath must be an absolute literal path made of slash-separated URL path segments.");
  }
  return basePath.length === 1 ? "" : basePath.replace(/\/+$/u, "");
}

function serializeFrame(frame: RunEventFrame, logger: LiveAdapterLogger | undefined): string | undefined {
  try {
    // JSON.stringify is single-line, so the only newlines are the SSE terminator.
    return `data: ${JSON.stringify(frame)}\n\n`;
  } catch (error) {
    logger?.warn?.("Dropped unserializable live event frame.", {
      reason: error instanceof Error ? error.message : String(error),
      runId: "runId" in frame ? frame.runId : undefined,
    });
    return undefined;
  }
}

function isLiteralBasePath(basePath: string): boolean {
  return basePath === "/" || /^\/[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*\/?$/u.test(basePath);
}
