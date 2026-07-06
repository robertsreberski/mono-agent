/**
 * The single HTTP backend the browser PWA talks to. Serves the built SPA
 * (`express.static`), a read-only JSON API, and a browser SSE stream — all backed
 * by one {@link SessionAggregator}. Binds loopback-only unless `allowNonLoopback`,
 * via the shared `assertSafeBind`/`listen`/`close` host-safety helpers.
 */
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

import { SessionAggregator } from "./aggregator.js";
import type { SessionAggregatorLogger } from "./aggregator.js";
import type { BrowserStreamFrame } from "./session-model.js";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 4599;
const DEFAULT_MAX_RUNS_PER_INSTANCE = 200;
/** Browser SSE heartbeat interval — a comment frame that keeps the connection warm through proxies. */
const HEARTBEAT_INTERVAL_MS = 15_000;
const MAX_BROWSER_SSE_QUEUE_FRAMES = 10_000;
const MAX_BROWSER_SSE_FRAME_BYTES = 1_000_000;
const BROWSER_FRAME_ENCODER = new TextEncoder();

export interface StartSessionWebServerOptions {
  readonly registryDirs: readonly string[];
  readonly host?: string;
  readonly port?: number;
  readonly allowNonLoopback?: boolean;
  readonly staleAfterMs?: number;
  readonly maxRunsPerInstance?: number;
  readonly env?: Record<string, string | undefined>;
  readonly staticDir?: string;
  /**
   * Bearer token required for /api/* when present. Mandatory for non-loopback
   * binds so the read-only operator API is not published unauthenticated.
   */
  readonly authToken?: string;
  readonly logger?: {
    info?(message: string, metadata?: unknown): void;
    warn?(message: string, metadata?: unknown): void;
    error?(message: string, metadata?: unknown): void;
  };
  /** Include memory-maintenance runs in history, API responses, and live frames. Default false. */
  readonly includeMemory?: boolean;
  /** Injectable clock for deterministic stale-running projection. Defaults to Date.now. */
  readonly clock?: () => number;
}

export interface SessionWebServerHandle {
  readonly url: string;
  stop(): Promise<void>;
}

class SessionWebServerError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "SessionWebServerError";
    this.code = code;
  }
}

export async function startSessionWebServer(
  options: StartSessionWebServerOptions,
): Promise<SessionWebServerHandle> {
  const host = options.host ?? DEFAULT_HOST;
  const port = options.port ?? DEFAULT_PORT;
  const maxRunsPerInstance = options.maxRunsPerInstance ?? DEFAULT_MAX_RUNS_PER_INSTANCE;
  const staticDir = options.staticDir ?? defaultStaticDir();
  const logger = options.logger;
  const authToken = normalizeOptionalString(options.authToken);

  assertSafeBind(host, options.allowNonLoopback === true, (boundHost) =>
    new SessionWebServerError(
      "unsafe_host",
      `Session web server refuses to bind a non-loopback host (${boundHost}) unless allowNonLoopback is true.`,
    ));
  if (!isLoopbackHost(host) && authToken === undefined) {
    throw new SessionWebServerError(
      "missing_auth_token",
      "Session web server requires an auth token when binding a non-loopback host.",
    );
  }

  const aggregator = new SessionAggregator({
    registryDirs: options.registryDirs,
    maxRunsPerInstance,
    ...(options.staleAfterMs === undefined ? {} : { staleAfterMs: options.staleAfterMs }),
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(logger === undefined ? {} : { logger: logger as SessionAggregatorLogger }),
    ...(options.includeMemory === undefined ? {} : { includeMemory: options.includeMemory }),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  });
  await aggregator.start();

  const app = express();
  const server = createServer(app);
  const activeStreams = new Set<() => void>();

  if (authToken !== undefined) {
    app.use("/api", requireApiAuth(authToken));
  }

  app.get("/api/instances", (_req, res) => {
    res.json({ instances: aggregator.getInstances() });
  });

  app.get("/api/sessions", (req, res, next) => {
    const instance = firstString(req.query.instance) ?? "all";
    const offset = parseOffset(firstString(req.query.offset));
    const limit = parseLimit(firstString(req.query.limit));
    if (offset > 0 || limit !== undefined) {
      const pageLimit = limit ?? maxRunsPerInstance;
      aggregator
        .getSessionSummariesPage(instance, { offset, limit: pageLimit })
        .then((page) => {
          res.json(page);
        })
        .catch((error: unknown) => next(error));
      return;
    }
    const sessions = aggregator.getSessionSummaries(instance);
    res.json({ sessions, total: sessions.length, offset: 0, limit: sessions.length, hasMore: false });
  });

  app.get("/api/sessions/:sourceId/:runId", (req, res, next) => {
    const sourceId = req.params.sourceId;
    const runId = req.params.runId;
    aggregator
      .getSession(sourceId, runId)
      .then((session) => {
        if (session === undefined) {
          res.status(404).json({ error: { message: "Session not found.", code: "not_found" } });
          return;
        }
        res.json({ session });
      })
      .catch((error: unknown) => next(error));
  });

  app.get("/api/stream", (_req, res) => {
    handleStream(aggregator, res, activeStreams, logger);
  });

  // Any other /api/* path is a genuine 404 (never falls through to the SPA).
  app.use("/api", (_req, res) => {
    res.status(404).json({ error: { message: "Not found.", code: "not_found" } });
  });

  // Static SPA assets, then a catch-all that returns index.html for client-side
  // routes (unknown non-/api GETs). Any file that exists is served by static; the
  // fallback only fires for paths static didn't resolve.
  app.use(express.static(staticDir));
  app.use((req, res, next) => {
    if (req.method !== "GET") {
      next();
      return;
    }
    res.sendFile(join(staticDir, "index.html"), (error) => {
      if (error !== undefined && error !== null) {
        next();
      }
    });
  });

  app.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      next(error);
      return;
    }
    logger?.error?.("Session web request failed.", { error: error instanceof Error ? error.message : String(error) });
    res.status(500).json({ error: { message: "Internal server error.", code: "internal_error" } });
  });

  try {
    const address = await listen(server, port, host, {
      listenFailed: (reason) => new SessionWebServerError("start_failed", `Session web server failed to listen: ${reason}`),
      noAddress: () => new SessionWebServerError("start_failed", "Session web server did not receive a TCP address."),
    });
    const url = `http://${hostForUrl(host)}:${address.port}/`;
    return {
      url,
      async stop() {
        for (const closeStream of [...activeStreams]) {
          closeStream();
        }
        activeStreams.clear();
        await close(server);
        await aggregator.stop();
      },
    };
  } catch (error) {
    // Don't leak the aggregator's watchers/live connections if we never bound.
    await aggregator.stop();
    throw error;
  }
}

function handleStream(
  aggregator: SessionAggregator,
  res: Response,
  activeStreams: Set<() => void>,
  logger: StartSessionWebServerOptions["logger"] | undefined,
): void {
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.socket?.setNoDelay(true);
  res.flushHeaders();

  // Per-connection outbound queue that respects socket backpressure. `res.write`
  // returning false means the send buffer is full; we stop and resume on the next
  // 'drain' rather than letting Node buffer unboundedly for a slow/backgrounded
  // client. `session_upsert`s coalesce per runId — an unsent upsert is replaced in
  // place by a newer one — so a stalled client never accumulates stale duplicates
  // (it just gets the latest state for each run once it can receive again).
  interface QueueEntry {
    frame: BrowserStreamFrame;
  }
  const queue: QueueEntry[] = [];
  const pendingUpserts = new Map<string, QueueEntry>();
  const pendingRemovals = new Map<string, QueueEntry>();
  let pendingInstances: QueueEntry | undefined;
  let draining = false;
  let closed = false;
  let unsubscribe: (() => void) | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;

  const closeStream = (): void => {
    if (closed) {
      return;
    }
    closed = true;
    if (heartbeat !== undefined) {
      clearInterval(heartbeat);
      heartbeat = undefined;
    }
    unsubscribe?.();
    unsubscribe = undefined;
    queue.length = 0;
    pendingUpserts.clear();
    pendingRemovals.clear();
    pendingInstances = undefined;
    activeStreams.delete(closeStream);
    if (!res.writableEnded) {
      res.end();
    }
  };
  activeStreams.add(closeStream);

  const flush = (): void => {
    while (!closed && !draining && queue.length > 0) {
      const entry = queue.shift();
      if (entry === undefined) {
        break;
      }
      if (entry.frame.t === "session_upsert") {
        pendingUpserts.delete(sessionQueueKey(entry.frame.session));
      } else if (entry.frame.t === "session_removed") {
        pendingRemovals.delete(sessionQueueKey({ id: entry.frame.runId, sourceId: entry.frame.sourceId }));
      } else if (entry === pendingInstances) {
        pendingInstances = undefined;
      }
      if (res.writableEnded) {
        closed = true;
        return;
      }
      const payload = serializeBrowserFrame(entry.frame, logger);
      if (payload === undefined) {
        continue;
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

  const enqueue = (frame: BrowserStreamFrame): void => {
    if (closed || res.writableEnded) {
      return;
    }
    if (frame.t === "session_upsert") {
      const queueKey = sessionQueueKey(frame.session);
      const existing = pendingUpserts.get(queueKey);
      if (existing !== undefined) {
        // Coalesce by REMOVING the stale queued upsert and re-appending the latest
        // at the tail — not overwriting in place. If a session_removed for the same
        // id was enqueued between the two upserts, the removed frame keeps its slot
        // and the newer upsert lands AFTER it, so last-write-wins (run present) is
        // preserved on drain rather than the browser ending on a stale removal.
        const idx = queue.indexOf(existing);
        if (idx >= 0) {
          queue.splice(idx, 1);
        }
      }
      const entry: QueueEntry = { frame };
      pendingUpserts.set(queueKey, entry);
      queue.push(entry);
    } else if (frame.t === "session_removed") {
      const queueKey = sessionQueueKey({ id: frame.runId, sourceId: frame.sourceId });
      const staleUpsert = pendingUpserts.get(queueKey);
      if (staleUpsert !== undefined) {
        const idx = queue.indexOf(staleUpsert);
        if (idx >= 0) {
          queue.splice(idx, 1);
        }
        pendingUpserts.delete(queueKey);
      }
      const existing = pendingRemovals.get(queueKey);
      if (existing !== undefined) {
        const idx = queue.indexOf(existing);
        if (idx >= 0) {
          queue.splice(idx, 1);
        }
      }
      const entry: QueueEntry = { frame };
      pendingRemovals.set(queueKey, entry);
      queue.push(entry);
    } else if (frame.t === "instances") {
      if (pendingInstances !== undefined) {
        const idx = queue.indexOf(pendingInstances);
        if (idx >= 0) {
          queue.splice(idx, 1);
        }
      }
      pendingInstances = { frame };
      queue.push(pendingInstances);
    } else {
      queue.push({ frame });
    }
    if (queue.length > MAX_BROWSER_SSE_QUEUE_FRAMES) {
      closeStream();
      return;
    }
    flush();
  };

  // Initial snapshot: the instance list, then one upsert per current session, so a
  // fresh browser reconstructs full state before any live frame arrives. It flows
  // through the same backpressure-aware queue; the aggregator's per-instance
  // eviction cap bounds how large the snapshot can grow.
  enqueue({ t: "instances", instances: aggregator.getInstances() });
  for (const session of aggregator.getSessionSummaries("all")) {
    enqueue({ t: "session_upsert", session });
  }

  unsubscribe = aggregator.subscribe(enqueue);
  heartbeat = setInterval(() => {
    // Skip the keep-alive while draining so we don't pile onto a full buffer.
    if (!closed && !draining && !res.writableEnded) {
      res.write(": ping\n\n");
    }
  }, HEARTBEAT_INTERVAL_MS);
  heartbeat.unref?.();

  res.on("close", () => {
    closeStream();
  });
}

function sessionQueueKey(session: { readonly id: string; readonly sourceId?: string; readonly instance?: string }): string {
  return `${session.sourceId ?? session.instance ?? ""}:${session.id}`;
}

/**
 * Resolve the built SPA directory relative to this module. The dist layout is
 * `dist/server.js` alongside a sibling `webapp/dist`, so `../webapp/dist` from the
 * module dir. Overridable by `options.staticDir`.
 */
function defaultStaticDir(): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  return resolve(moduleDir, "../webapp/dist");
}

function firstString(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    return firstString(value[0]);
  }
  return normalizeOptionalString(typeof value === "string" ? value : undefined);
}

function parseLimit(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function parseOffset(value: string | undefined): number {
  if (value === undefined) {
    return 0;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function requireApiAuth(authToken: string): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    const supplied = readAuthorizationBearer(req.headers.authorization) ?? firstString(req.query.token);
    if (supplied !== undefined && bearerTokensEqual(supplied, authToken)) {
      next();
      return;
    }
    res.status(401).json({ error: { message: "Unauthorized.", code: "unauthorized" } });
  };
}

function serializeBrowserFrame(
  frame: BrowserStreamFrame,
  logger: StartSessionWebServerOptions["logger"] | undefined,
): string | undefined {
  try {
    const json = JSON.stringify(frame);
    if (BROWSER_FRAME_ENCODER.encode(json).length > MAX_BROWSER_SSE_FRAME_BYTES) {
      logger?.warn?.("Dropped oversized browser SSE frame.", {
        maxFrameBytes: MAX_BROWSER_SSE_FRAME_BYTES,
        frameType: frame.t,
      });
      return undefined;
    }
    return `data: ${json}\n\n`;
  } catch (error) {
    logger?.warn?.("Dropped unserializable browser SSE frame.", {
      reason: error instanceof Error ? error.message : String(error),
      frameType: frame.t,
    });
    return undefined;
  }
}
