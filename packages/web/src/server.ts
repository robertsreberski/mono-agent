import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { chmod, open, readFile, rename, unlink } from "node:fs/promises";
import { createServer } from "node:http";
import { isIP } from "node:net";
import { hostname as systemHostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { constants as zlibConstants } from "node:zlib";

import {
  AGENT_LIVE_INPUT_MAX_CHARACTERS,
  closeServerBounded,
  hostForUrl,
  listen,
  normalizeHostForBind,
  type ChannelAskAnswer,
} from "@mono-agent/agent-contracts";
import compression from "compression";
import express, { type NextFunction, type Request, type Response } from "express";

import {
  DEFAULT_WEB_THEME,
  WEB_API_VERSION,
  WEB_MAX_TURN_TEXT_CHARACTERS,
  WEB_THEMES,
  type CreateWebThreadInput,
  type CreateWebUploadInput,
  type PatchWebAgentInput,
  type PatchWebThreadInput,
  type PutWebAgentRunSettingsInput,
  type StartWebLiveInputInput,
  type StartWebTurnInput,
  type WebEvent,
  type WebConsoleIdentity,
  type WebMessageChangedPayload,
  type WebMessageDelta,
  type WebMessagePart,
  type WebTheme,
} from "./contracts.js";
import { errorMessage, WebConsoleError } from "./errors.js";
import {
  WEB_MESSAGE_PAGE_DEFAULT,
  WEB_MESSAGE_PAGE_MAX,
  WEB_THREAD_PAGE_DEFAULT,
  WEB_THREAD_PAGE_MAX,
  WEB_THREAD_SEARCH_MAX,
} from "./store.js";
import {
  MCP_APP_PROXY_CONTENT_SECURITY_POLICY,
  MCP_APP_PROXY_DOCUMENT,
  MCP_APP_PROXY_PATH,
} from "./mcp-app-proxy.js";
import {
  startWebNotificationIngress,
  type WebNotificationIngressHandle,
} from "./notification-ingress.js";
import { WebService, type CreateWebServiceOptions, type WebTranscriptShape } from "./service.js";

export const DEFAULT_WEB_HOST = "0.0.0.0";
export const DEFAULT_WEB_PORT = 5050;
const HEARTBEAT_INTERVAL_MS = 15_000;
const MAX_SSE_CLIENTS = 64;
/**
 * How often one connection may be told that one conversation's message moved,
 * when it is not subscribed to that conversation's content.
 *
 * A hint costs its reader a re-read, and a streaming turn produces one write
 * every 50 ms. A console that is not looking at the conversation has no reason
 * to follow it at that rate -- it needs the sidebar row to be right, which the
 * conversation events already carry.
 */
const DELTA_HINT_INTERVAL_MS = 1_000;
/** Bound on `?thread=`, matching the other bounded query strings. */
const MAX_SUBSCRIPTION_LENGTH = 512;
/**
 * How many conversations one connection remembers having hinted about.
 *
 * A hard bound, evicting the least recently hinted: a burst wider than this
 * inside one second would otherwise grow the map faster than the window can
 * retire it. Evicting an entry that is still inside its window costs one extra
 * hint for that conversation; an unbounded map on a server that runs for weeks
 * costs the server.
 */
const MAX_THROTTLED_CONVERSATIONS = 256;
const MAX_MCP_APP_BRIDGE_REQUEST_BYTES = 64 * 1024;
/**
 * Content-addressed build output and write-once upload bytes never change under
 * their URL, so the browser may hold them for a year and skip the request.
 */
const IMMUTABLE_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;
const WEB_THEME_CHROME: Readonly<Record<WebTheme, { readonly light: string; readonly dark: string }>> = {
  evergreen: { light: "#eeefeb", dark: "#0f1110" },
  ocean: { light: "#edf1f4", dark: "#0d1115" },
  plum: { light: "#f2eef3", dark: "#120f14" },
  terracotta: { light: "#f4efec", dark: "#130f0d" },
};

export interface StartWebServerOptions extends CreateWebServiceOptions {
  readonly host?: string;
  readonly port?: number;
  readonly theme?: WebTheme;
  readonly staticDir?: string;
  /** Exact additional DNS hostnames accepted at the browser boundary (for example this node's Tailscale DNSName). */
  readonly allowedHosts?: readonly string[];
}

export interface WebServerHandle {
  readonly url: string;
  readonly host: string;
  readonly port: number;
  readonly boundAddress: string;
  readonly stateDir: string;
  stop(): Promise<void>;
  close(): Promise<void>;
}

export async function startWebServer(options: StartWebServerOptions = {}): Promise<WebServerHandle> {
  const host = normalizeHostForBind(options.host ?? DEFAULT_WEB_HOST);
  const port = normalizePort(options.port ?? DEFAULT_WEB_PORT);
  const staticDir = options.staticDir ?? defaultStaticDir();
  const theme = resolveWebTheme(options.theme);
  const consoleIdentity: WebConsoleIdentity = {
    hostName: systemHostname().trim() || "localhost",
    theme,
  };
  const webManifest = await loadWebManifest(staticDir, consoleIdentity);
  const logger = options.logger;
  // Validate all synchronous startup inputs before acquiring the persistent
  // service lease so an embedding typo cannot strand SQLite ownership.
  const allowedHosts = resolveAllowedHosts(options.allowedHosts, options.env ?? process.env);
  const service = await WebService.create(options);
  const app = express();
  const server = createServer(app);
  server.headersTimeout = 15_000;
  server.requestTimeout = 5 * 60_000;
  server.keepAliveTimeout = 5_000;
  const activeStreams = new Set<() => void>();
  const activeOperations = new Set<Promise<unknown>>();
  let notificationIngress: WebNotificationIngressHandle | undefined;
  let stopPromise: Promise<void> | undefined;

  app.disable("x-powered-by");
  // Mounted first so every response body, error JSON included, is negotiated.
  // Brotli quality 4 keeps a phone-sized payload under a few milliseconds of
  // CPU; the default filter already declines anything the response marked
  // `no-transform` (SSE, attachment bytes) or that is not compressible.
  app.use(compression({
    threshold: 1024,
    level: 6,
    brotli: { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 4 } },
  }));
  app.use(securityHeaders);
  app.use(validateLocalRequest(host, allowedHosts));
  // Console state is private to this operator but not secret from their own
  // browser: `no-cache` still forces revalidation on every read, and lets
  // Express answer an unchanged payload with a 304 instead of resending it.
  app.use("/api", (_req, res, next) => {
    res.setHeader("Cache-Control", "private, no-cache");
    next();
  });
  app.use("/api/v1", express.json({ limit: "256kb", strict: true }));

  app.get("/healthz", (_req, res) => {
    res.status(200).json({
      status: "ok",
      version: WEB_API_VERSION,
      push: service.webPushDegraded() ? "degraded" : "ok",
    });
  });

  app.get("/api/v1/bootstrap", (req, res, next) => {
    try {
      // One bucket, not every agent's conversations. An unknown or absent
      // `sourceId` falls back inside the service rather than failing: the
      // first request a fresh console makes has no selection to name yet.
      // An empty `sourceId` is a console that has not resolved an agent yet,
      // which is the same thing as omitting it -- not a malformed request.
      const requested = req.query.sourceId === "" ? undefined : req.query.sourceId;
      const sourceId = optionalQueryString(requested, 512);
      void service.bootstrap({
        ...(sourceId === undefined ? {} : { sourceId }),
        archived: optionalArchivedQuery(req.query.archived) ?? false,
        limit: boundedQueryLimit(req.query.limit, WEB_THREAD_PAGE_MAX, WEB_THREAD_PAGE_DEFAULT),
      })
        .then((bootstrap) => res.status(200).json({ ...bootstrap, console: consoleIdentity }))
        .catch(next);
    } catch (error) {
      next(error);
    }
  });

  app.get(MCP_APP_PROXY_PATH, (_req, res) => {
    setMcpAppProxyHeaders(res);
    res.status(200).type("html").send(MCP_APP_PROXY_DOCUMENT);
  });

  if (webManifest !== undefined) {
    app.get("/manifest.webmanifest", (_req, res) => {
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.type("application/manifest+json").send(JSON.stringify(webManifest));
    });
  }

  app.patch("/api/v1/agents/:id", (req, res, next) => {
    try {
      const input = parsePatchAgent(req.body);
      res.status(200).json({ agent: service.patchAgent(pathParam(req.params.id), input) });
    } catch (error) {
      next(error);
    }
  });

  app.put("/api/v1/agents/:id/run-defaults", (req, res, next) => {
    try {
      const input = parsePutAgentRunSettings(req.body);
      res.status(200).json({ agent: service.setAgentRunDefaults(pathParam(req.params.id), input) });
    } catch (error) {
      next(error);
    }
  });

  app.delete("/api/v1/agents/:id/run-defaults", (req, res, next) => {
    try {
      res.status(200).json({ agent: service.clearAgentRunDefaults(pathParam(req.params.id)) });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/v1/agents/:id/skills", (req, res, next) => {
    try {
      res.status(200).json(service.agentSkills(pathParam(req.params.id)));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/v1/agents/:id/configuration-sessions", (req, res, next) => {
    try {
      exactRequestOrigin(req);
      void trackOperation(
        service.createConfigurationSession(pathParam(req.params.id)),
        activeOperations,
      ).then((session) => res.status(201).json({ session })).catch(next);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/v1/configuration-sessions/:id/turns", (req, res, next) => {
    try {
      exactRequestOrigin(req);
      const body = requireRecord(req.body);
      const text = requireString(body.text, "text", WEB_MAX_TURN_TEXT_CHARACTERS);
      void trackOperation(
        service.continueConfigurationSession(pathParam(req.params.id), text),
        activeOperations,
      ).then((session) => res.status(200).json({ session })).catch(next);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/v1/configuration-sessions/:id/proposals/:proposalId/:decision", (req, res, next) => {
    try {
      exactRequestOrigin(req);
      const decision = pathParam(req.params.decision);
      if (decision !== "approve" && decision !== "reject") {
        throw new WebConsoleError("invalid_configuration_decision", "Decision must be approve or reject.", 400);
      }
      void trackOperation(
        service.settleConfigurationSession(
          pathParam(req.params.id),
          pathParam(req.params.proposalId),
          decision,
        ),
        activeOperations,
      ).then((session) => res.status(200).json({ session })).catch(next);
    } catch (error) {
      next(error);
    }
  });

  app.delete("/api/v1/configuration-sessions/:id", (req, res, next) => {
    try {
      exactRequestOrigin(req);
      void trackOperation(
        service.closeConfigurationSession(pathParam(req.params.id)),
        activeOperations,
      ).then(() => res.status(204).end()).catch(next);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/v1/agents/:id/cron", (req, res, next) => {
    void trackOperation(service.cronOverview(pathParam(req.params.id)), activeOperations)
      .then((overview) => res.status(200).json(overview))
      .catch(next);
  });

  app.get("/api/v1/agents/:id/cron/config-view", (req, res, next) => {
    void trackOperation(service.cronConfigView(pathParam(req.params.id)), activeOperations)
      .then((configView) => res.status(200).json({ configView }))
      .catch(next);
  });

  app.get("/api/v1/agents/:id/cron/jobs/:jobId/runs", (req, res, next) => {
    try {
      const limit = boundedQueryLimit(req.query.limit, 100, 50);
      const before = optionalQueryString(req.query.before, 4_096);
      void trackOperation(service.cronRuns(
        pathParam(req.params.id),
        pathParam(req.params.jobId),
        { limit, ...(before === undefined ? {} : { before }) },
      ), activeOperations).then((page) => res.status(200).json(page)).catch(next);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/v1/agents/:id/models", (req, res, next) => {
    try {
      // The operator clamps to the same 200-model page ceiling; mirror it
      // server-side rather than trusting the client's requested size.
      const limit = boundedQueryLimit(req.query.limit, 200, 50);
      const provider = optionalSearchQuery(req.query.provider, 256);
      const q = optionalSearchQuery(req.query.q, 512);
      // The agent's `/v1/models` contract treats the two modes as mutually
      // exclusive: a supplier services `provider` and ignores the query, so a
      // request carrying both comes back looking like an answered search. The
      // agent rejects it, but the operator client re-reports any agent 4xx as
      // a 502 `agent_http_error` -- which blames the agent for the caller's
      // mistake. Keep this one local and legible.
      if (provider.length > 0 && q.length > 0) {
        throw new WebConsoleError(
          "invalid_page",
          "provider and q are mutually exclusive for the model catalog.",
          400,
        );
      }
      const cursor = optionalQueryString(req.query.cursor, 4_096);
      void trackOperation(service.agentModels(
        pathParam(req.params.id),
        {
          limit,
          ...(provider.length === 0 ? {} : { provider }),
          ...(q.length === 0 ? {} : { q }),
          ...(cursor === undefined ? {} : { cursor }),
        },
      ), activeOperations).then((page) => res.status(200).json(page)).catch(next);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/v1/agents/:id/cron/jobs/:jobId/runs/:runId", (req, res, next) => {
    void trackOperation(service.cronRun(
      pathParam(req.params.id),
      pathParam(req.params.jobId),
      pathParam(req.params.runId),
    ), activeOperations).then((message) => res.status(200).json({ message })).catch(next);
  });

  app.post("/api/v1/agents/:id/cron/jobs/:jobId/run", (req, res, next) => {
    try {
      exactRequestOrigin(req);
      const action = parseCronAction(req.body);
      void trackOperation(service.cronRunNow(
        pathParam(req.params.id),
        pathParam(req.params.jobId),
        action,
      ), activeOperations).then((result) => res.status(result.kind === "confirmation_required" ? 428 : 200).json(result)).catch(next);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/v1/agents/:id/cron/jobs/:jobId/effective-enabled", (req, res, next) => {
    try {
      exactRequestOrigin(req);
      const body = requireRecord(req.body);
      if (typeof body.enabled !== "boolean") {
        throw new WebConsoleError("invalid_cron_action", "enabled must be a boolean.", 400);
      }
      const action = parseCronAction(body);
      void trackOperation(service.cronSetEffectiveEnabled(
        pathParam(req.params.id),
        pathParam(req.params.jobId),
        body.enabled,
        action,
      ), activeOperations).then((result) => res.status(result.kind === "confirmation_required" ? 428 : 200).json(result)).catch(next);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/v1/threads", (req, res, next) => {
    try {
      const input = parseCreateThread(req.body);
      res.status(201).json({ thread: service.createThread(input.sourceId, {
        ...(input.model === undefined ? {} : { model: input.model }),
        ...(input.effort === undefined ? {} : { effort: input.effort }),
      }) });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/v1/threads", (req, res, next) => {
    try {
      const sourceId = requiredQueryString(req.query.sourceId, "sourceId", 512);
      const archived = optionalArchivedQuery(req.query.archived);
      if (archived === undefined) {
        throw new WebConsoleError("invalid_page", "archived must be true or false.", 400);
      }
      const before = optionalQueryString(req.query.before, 4_096);
      res.status(200).json(service.threadsPage({
        sourceId,
        archived,
        // A sidebar shows a handful of rows and pages from there. This used to
        // answer with the whole per-bucket cap by default.
        limit: boundedQueryLimit(req.query.limit, WEB_THREAD_PAGE_MAX, WEB_THREAD_PAGE_DEFAULT),
        ...(before === undefined ? {} : { before }),
      }));
    } catch (error) {
      next(error);
    }
  });

  // Registered above `/threads/:id` so Express matches the literal segment
  // rather than treating "search" as a conversation id.
  app.get("/api/v1/threads/search", (req, res, next) => {
    try {
      const sourceId = requiredQueryString(req.query.sourceId, "sourceId", 512);
      res.status(200).json(service.searchThreads({
        sourceId,
        query: optionalSearchQuery(req.query.q, 512),
        limit: boundedQueryLimit(req.query.limit, WEB_THREAD_SEARCH_MAX, WEB_THREAD_SEARCH_MAX),
      }));
    } catch (error) {
      next(error);
    }
  });

  // Registered above `/threads/:id` so the conversation reads and the read that
  // repairs one of their truncated tool calls stay together.
  app.get("/api/v1/threads/:threadId/messages/:messageId/tool-calls/:toolCallId", (req, res, next) => {
    try {
      res.status(200).json({
        part: service.toolCallPart(
          pathParam(req.params.threadId),
          pathParam(req.params.messageId),
          pathParam(req.params.toolCallId),
        ),
      });
    } catch (error) {
      next(error);
    }
  });

  // Registered above `/threads/:id` and above the message page for the same
  // reason the tool-call read is: this is how a console whose delta stream
  // skipped a version repairs ONE message instead of re-reading the whole
  // conversation around it.
  app.get("/api/v1/threads/:threadId/messages/:messageId", (req, res, next) => {
    try {
      res.status(200).json({
        message: service.message(
          pathParam(req.params.threadId),
          pathParam(req.params.messageId),
          fullTranscriptQuery(req.query.full),
        ),
      });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/v1/threads/:id", (req, res, next) => {
    try {
      res.status(200).json(service.thread(pathParam(req.params.id), fullTranscriptQuery(req.query.full)));
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/v1/threads/:id/messages", (req, res, next) => {
    try {
      const before = optionalQueryString(req.query.before, 4_096);
      res.status(200).json(service.messagePage(pathParam(req.params.id), {
        // A screenful, not the ceiling: the console renders the tail and pages
        // backwards from the cursor.
        limit: boundedQueryLimit(req.query.limit, WEB_MESSAGE_PAGE_MAX, WEB_MESSAGE_PAGE_DEFAULT),
        ...(before === undefined ? {} : { before }),
        ...fullTranscriptQuery(req.query.full),
      }));
    } catch (error) {
      next(error);
    }
  });

  app.post(
    "/api/v1/threads/:threadId/messages/:messageId/reply-attachments/:partId/access",
    (req, res, next) => {
      try {
        exactRequestOrigin(req);
        const part = service.replyPartAccess(
          pathParam(req.params.threadId),
          pathParam(req.params.messageId),
          pathParam(req.params.partId),
          "attachment",
        );
        res.status(200).json({ part });
      } catch (error) {
        next(error);
      }
    },
  );

  app.get(
    "/api/v1/threads/:threadId/messages/:messageId/reply-attachments/:partId/content",
    (req, res, next) => {
      const access = replyAccessQuery(req);
      const controller = new AbortController();
      res.once("close", () => {
        if (!res.writableEnded) controller.abort(new Error("Reply attachment client disconnected."));
      });
      void trackOperation(service.replyAttachment(
        pathParam(req.params.threadId),
        pathParam(req.params.messageId),
        pathParam(req.params.partId),
        access.expires,
        access.token,
        controller.signal,
      ).then(async ({ part, response, remainingSeconds }) => {
        if (response.body === null) throw new WebConsoleError("reply_attachment_unavailable", "Attachment stream is unavailable.", 502);
        setReplyDownloadHeaders(res, part, remainingSeconds);
        await pipeline(Readable.fromWeb(response.body as never), res);
      }), activeOperations).catch((error: unknown) => {
        if (res.headersSent) {
          res.destroy(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        next(error);
      });
    },
  );

  app.post("/api/v1/threads/:threadId/messages/:messageId/mcp-apps/:partId/access", (req, res, next) => {
    try {
      exactRequestOrigin(req);
      const part = service.replyPartAccess(
        pathParam(req.params.threadId),
        pathParam(req.params.messageId),
        pathParam(req.params.partId),
        "mcp_app",
      );
      res.status(200).json({ part });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/v1/threads/:threadId/messages/:messageId/mcp-apps/:partId", (req, res, next) => {
    const access = replyAccessQuery(req);
    void trackOperation(service.mcpAppResource(
      pathParam(req.params.threadId),
      pathParam(req.params.messageId),
      pathParam(req.params.partId),
      access.expires,
      access.token,
      AbortSignal.timeout(10_000),
    ), activeOperations).then((resource) => {
      setPrivateAppHeaders(res);
      res.status(200).json(resource);
    }).catch(next);
  });

  app.post("/api/v1/threads/:threadId/messages/:messageId/mcp-apps/:partId/requests", (req, res, next) => {
    try {
      exactRequestOrigin(req);
      const serializedBytes = Buffer.byteLength(JSON.stringify(req.body) ?? "null", "utf8");
      if (serializedBytes > MAX_MCP_APP_BRIDGE_REQUEST_BYTES) {
        throw new WebConsoleError("mcp_app_request_too_large", "The MCP App bridge request is too large.", 413);
      }
      const body = requireRecord(req.body);
      const method = body.method;
      if (method !== "resources/read"
        && method !== "tools/call"
        && method !== "ui/open-link"
        && method !== "ui/update-model-context") {
        throw invalidBody("MCP App method is invalid.");
      }
      if (body.confirmed !== undefined && typeof body.confirmed !== "boolean") {
        throw invalidBody("MCP App confirmation must be boolean.");
      }
      const access = replyAccessQuery(req);
      void trackOperation(service.mcpAppRequest(
        pathParam(req.params.threadId),
        pathParam(req.params.messageId),
        pathParam(req.params.partId),
        access.expires,
        access.token,
        {
          method,
          ...(body.params === undefined ? {} : { params: body.params }),
          ...(body.confirmed === undefined ? {} : { confirmed: body.confirmed }),
        },
        AbortSignal.timeout(120_000),
      ), activeOperations).then((result) => {
        setPrivateAppHeaders(res);
        res.status(200).json({ result });
      }).catch(next);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/v1/threads/:id/jobs/:jobId", (req, res, next) => {
    void trackOperation(
      service.threadJob(pathParam(req.params.id), pathParam(req.params.jobId)),
      activeOperations,
    )
      .then((job) => res.status(200).json({ job }))
      .catch(next);
  });

  app.patch("/api/v1/threads/:id", (req, res, next) => {
    try {
      const input = parsePatchThread(req.body);
      res.status(200).json({ thread: service.patchThread(pathParam(req.params.id), input) });
    } catch (error) {
      next(error);
    }
  });

  app.delete("/api/v1/threads/:id", (req, res, next) => {
    void trackOperation(service.deleteThread(pathParam(req.params.id)), activeOperations)
      .then(() => res.status(204).end())
      .catch(next);
  });

  app.post("/api/v1/threads/:id/turns", (req, res, next) => {
    let input: StartWebTurnInput;
    let threadId: string;
    try {
      input = parseTurn(req.body);
      threadId = pathParam(req.params.id);
    } catch (error) {
      next(error);
      return;
    }
    void trackOperation(service.startTurn(threadId, input), activeOperations)
      .then((started) => res.status(202).json(started))
      .catch(next);
  });

  app.post("/api/v1/threads/:id/live-input", (req, res, next) => {
    try {
      const input = parseLiveInput(req.body);
      res.status(202).json(service.submitLiveInput(pathParam(req.params.id), input.text));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/v1/threads/:id/cancel", (req, res, next) => {
    const threadId = pathParam(req.params.id);
    void trackOperation(service.cancelTurn(threadId), activeOperations)
      .then((thread) => res.status(202).json({ cancelled: true, thread }))
      .catch(next);
  });

  app.get("/api/v1/threads/:id/ask", (req, res, next) => {
    void trackOperation(service.pendingAsk(pathParam(req.params.id)), activeOperations)
      .then((ask) => res.status(200).json({ ask: ask ?? null }))
      .catch(next);
  });

  app.get("/api/v1/threads/:id/ask/:interactionId", (req, res, next) => {
    void trackOperation(service.ask(
      pathParam(req.params.id),
      pathParam(req.params.interactionId),
    ), activeOperations).then((ask) => res.status(200).json({ ask: ask ?? null })).catch(next);
  });

  app.post("/api/v1/threads/:id/ask", (req, res, next) => {
    const body = typeof req.body === "object" && req.body !== null ? req.body as Record<string, unknown> : {};
    if (typeof body.interactionId !== "string" || !Array.isArray(body.answers)) {
      next(new WebConsoleError("invalid_ask_answer", "interactionId and answers are required.", 400));
      return;
    }
    void trackOperation(
      service.submitAsk(
        pathParam(req.params.id),
        body.interactionId,
        body.answers as readonly ChannelAskAnswer[],
      ),
      activeOperations,
    ).then((result) => res.status(200).json(result)).catch(next);
  });

  app.put("/api/v1/push/subscriptions", (req, res, next) => {
    let input: ReturnType<typeof parsePushSubscription>;
    let siteOrigin: string;
    try {
      input = parsePushSubscription(req.body);
      siteOrigin = exactRequestOrigin(req);
    } catch (error) {
      next(error);
      return;
    }
    void trackOperation(service.registerWebPushSubscription({ ...input, siteOrigin }), activeOperations)
      .then((subscription) => res.status(201).json({ subscription }))
      .catch(next);
  });

  app.get("/api/v1/push/subscriptions/:id", (req, res, next) => {
    try {
      sameOriginRead(req);
      res.status(200).json({ subscription: service.webPushSubscription(pathParam(req.params.id)) });
    } catch (error) {
      next(error);
    }
  });

  app.delete("/api/v1/push/subscriptions/:id", (req, res, next) => {
    try {
      exactRequestOrigin(req);
      service.disableWebPushSubscription(pathParam(req.params.id));
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/v1/push/subscriptions/:id/test", (req, res, next) => {
    try {
      exactRequestOrigin(req);
      res.status(202).json({ subscription: service.testWebPushSubscription(pathParam(req.params.id)) });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/v1/push/events/:eventId/ack", (req, res, next) => {
    try {
      exactRequestOrigin(req);
      const body = requireRecord(req.body);
      service.acknowledgeWebPushEvent(
        pathParam(req.params.eventId),
        requireString(body.subscriptionId, "subscriptionId", 256),
        requireString(body.ackToken, "ackToken", 128),
      );
      // Deliberately idempotent and non-enumerating: invalid, late, repeated,
      // and successful acknowledgements are indistinguishable to callers.
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/v1/uploads", (req, res, next) => {
    try {
      const input = parseCreateUpload(req.body);
      res.status(201).json({ attachment: service.createUpload(input) });
    } catch (error) {
      next(error);
    }
  });

  app.put("/api/v1/uploads/:id/content", (req, res, next) => {
    void trackOperation(handleUploadContent(req, res, service), activeOperations).catch(next);
  });

  app.delete("/api/v1/uploads/:id", (req, res, next) => {
    void trackOperation(service.removeUpload(pathParam(req.params.id)), activeOperations)
      .then(() => res.status(204).end())
      .catch(next);
  });

  app.get("/api/v1/uploads/:id/content", (req, res, next) => {
    void trackOperation(handleDownloadContent(pathParam(req.params.id), res, service), activeOperations).catch(next);
  });

  /**
   * The console's live channel. {@link createWebEventDispatch} decides what each
   * connection is served; this owns the socket, the capacity cap and the
   * heartbeat.
   */
  app.get("/api/v1/events", (req, res, next) => {
    let named: string | undefined;
    try {
      named = optionalThreadSubscription(req.query.thread);
    } catch (error) {
      next(error);
      return;
    }
    if (activeStreams.size >= MAX_SSE_CLIENTS) {
      res.status(503).json({ error: { code: "sse_capacity", message: "Too many event streams are connected." } });
      return;
    }
    let subscribed: string | undefined;
    try {
      // The CANONICAL id, because that is what every event carries. A console
      // restores a selection it stored before a cron-channel adoption merged
      // that conversation away, or opens a push link minted against the old id;
      // matched by string equality, both subscribed to nothing and were served
      // throttled hints for the conversation they had open.
      //
      // AFTER the capacity check: this reads the database, and a console the
      // server is about to refuse must not be able to make it work.
      subscribed = named === undefined ? undefined : service.resolveThreadId(named);
    } catch (error) {
      next(error);
      return;
    }
    let closed = false;
    res.status(200);
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    const closeStream = (): void => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
      activeStreams.delete(closeStream);
      res.end();
    };
    const send = createWebEventDispatch({
      ...(subscribed === undefined ? {} : { subscribed }),
      write: (event) => {
        if (closed || res.writableEnded) return false;
        if (res.write(formatSse(event))) return true;
        // Events are state-invalidation hints, not an unbounded replay log. A
        // client that cannot drain one frame must reconnect and bootstrap.
        closeStream();
        return false;
      },
      close: closeStream,
      onFailure: (error) => {
        logger?.error?.("Web console event stream failed.", { error: errorMessage(error) });
      },
    });
    const unsubscribe = service.subscribe(send);
    const heartbeat = setInterval(() => {
      if (!res.write(`: heartbeat ${Date.now()}\n\n`)) closeStream();
    }, HEARTBEAT_INTERVAL_MS);
    heartbeat.unref();
    activeStreams.add(closeStream);
    res.once("close", closeStream);
    send(service.readyEvent());
  });

  app.use("/api", (_req, res) => {
    res.status(404).json({ error: { code: "not_found", message: "Not found." } });
  });

  // Vite fingerprints everything under assets/, so those URLs are immutable and
  // must be mounted ahead of the revalidating root. The root then covers the
  // service workers, icons, and the shell, which keep their names across builds
  // and so have to be revalidated (cheaply, against their ETag) every load.
  app.use("/assets", express.static(join(staticDir, "assets"), {
    fallthrough: true,
    index: false,
    redirect: false,
    immutable: true,
    maxAge: IMMUTABLE_MAX_AGE_SECONDS * 1000,
  }));
  app.use(express.static(staticDir, {
    fallthrough: true,
    index: false,
    redirect: false,
    setHeaders: (res) => res.setHeader("Cache-Control", "no-cache"),
  }));
  app.get("/{*splat}", (_req, res, next) => {
    // Keep the managed runtime's hidden ~/.mono-agent parent out of the
    // request-relative path. Express otherwise applies its dotfile policy to
    // the absolute path and rejects an existing index.html as Not Found.
    res.sendFile("index.html", { root: staticDir, headers: { "Cache-Control": "no-cache" } }, (error) => {
      if (error !== undefined && error !== null) next(error);
    });
  });

  app.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      next(error);
      return;
    }
    const known = error instanceof WebConsoleError;
    const syntax = error instanceof SyntaxError && (error as { status?: unknown }).status === 400;
    const tooLarge = typeof error === "object" && error !== null
      && ((error as { status?: unknown }).status === 413 || (error as { type?: unknown }).type === "entity.too.large");
    const status = known ? error.status : tooLarge ? 413 : syntax ? 400 : 500;
    const code = known ? error.code : tooLarge ? "request_too_large" : syntax ? "invalid_json" : "internal_error";
    if (status >= 500) logger?.error?.("Web console request failed.", { error: errorMessage(error) });
    res.status(status).json({
      error: {
        code,
        message: known || syntax ? errorMessage(error) : "Internal server error.",
        ...(known && error.details !== undefined ? { details: error.details } : {}),
      },
    });
  });

  const stop = (): Promise<void> => {
    stopPromise ??= (async () => {
      let ingressFailure: unknown;
      try {
        await notificationIngress?.stop();
      } catch (error) {
        ingressFailure = error;
      }
      for (const closeStream of [...activeStreams]) closeStream();
      try {
        await closeServerBounded(server, 500);
        await Promise.allSettled([...activeOperations]);
      } finally {
        await service.stop();
      }
      if (ingressFailure !== undefined) throw ingressFailure;
    })();
    return stopPromise;
  };

  try {
    const address = await listen(server, port, host, {
      listenFailed: (reason) => new WebConsoleError("listen_failed", `Web console failed to listen: ${reason}`, 500),
      noAddress: () => new WebConsoleError("listen_failed", "Web console did not receive a TCP address.", 500),
    });
    notificationIngress = await startWebNotificationIngress(service, logger);
    const url = `http://${hostForUrl(host)}:${address.port}/`;
    return {
      url,
      host,
      port: address.port,
      boundAddress: address.address,
      stateDir: service.store.paths.root,
      stop,
      close: stop,
    };
  } catch (error) {
    await notificationIngress?.stop().catch(() => undefined);
    if (server.listening) await closeServerBounded(server, 500).catch(() => undefined);
    await service.stop();
    throw error;
  }
}

function resolveWebTheme(value: unknown): WebTheme {
  if (value === undefined) return DEFAULT_WEB_THEME;
  if (typeof value === "string" && (WEB_THEMES as readonly string[]).includes(value)) {
    return value as WebTheme;
  }
  throw new WebConsoleError(
    "invalid_theme",
    `Web console theme must be one of: ${WEB_THEMES.join(", ")}.`,
    400,
  );
}

async function loadWebManifest(
  staticDir: string,
  identity: WebConsoleIdentity,
): Promise<Readonly<Record<string, unknown>> | undefined> {
  let contents: string;
  try {
    contents = await readFile(resolve(staticDir, "manifest.webmanifest"), "utf8");
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
  let template: unknown;
  try {
    template = JSON.parse(contents) as unknown;
  } catch {
    throw new WebConsoleError("invalid_static_manifest", "The web console manifest is invalid JSON.", 500);
  }
  if (template === null || typeof template !== "object" || Array.isArray(template)) {
    throw new WebConsoleError("invalid_static_manifest", "The web console manifest must be a JSON object.", 500);
  }
  const chrome = WEB_THEME_CHROME[identity.theme];
  return {
    ...(template as Readonly<Record<string, unknown>>),
    name: `${identity.hostName} · mono-agent Console`,
    short_name: identity.hostName,
    theme_color: chrome.dark,
    background_color: chrome.dark,
  };
}

function trackOperation<T>(operation: Promise<T>, active: Set<Promise<unknown>>): Promise<T> {
  active.add(operation);
  void operation.finally(() => active.delete(operation)).catch(() => undefined);
  return operation;
}

async function handleUploadContent(req: Request, res: Response, service: WebService): Promise<void> {
  const contentEncoding = req.headers["content-encoding"]?.trim().toLowerCase();
  if (contentEncoding !== undefined && contentEncoding !== "identity") {
    throw new WebConsoleError("unsupported_content_encoding", "Compressed upload bodies are not accepted.", 415);
  }
  if (req.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() !== "application/octet-stream") {
    throw new WebConsoleError("invalid_upload_content_type", "Upload bytes with Content-Type: application/octet-stream.", 415);
  }
  const declaredLength = parseContentLength(req.headers["content-length"]);
  const reservation = service.reserveUpload(pathParam(req.params.id));
  if (declaredLength !== undefined && declaredLength > reservation.maxBytes) {
    reservation.release();
    throw new WebConsoleError("attachment_too_large", "Attachment exceeds the 20 MiB file limit.", 413);
  }
  if (declaredLength !== undefined && reservation.attachment.sizeBytes > 0 && declaredLength !== reservation.attachment.sizeBytes) {
    reservation.release();
    throw new WebConsoleError("attachment_size_mismatch", "Upload size does not match the declared file size.", 400);
  }
  const destination = service.store.attachmentPath(reservation.attachment);
  const temporary = `${destination}.partial-${randomUUID()}`;
  let moved = false;
  try {
    const sizeBytes = await writeBoundedRequest(req, temporary, reservation.maxBytes);
    if (reservation.attachment.sizeBytes > 0 && sizeBytes !== reservation.attachment.sizeBytes) {
      throw new WebConsoleError("attachment_size_mismatch", "Upload size does not match the declared file size.", 400);
    }
    await rename(temporary, destination);
    moved = true;
    await chmod(destination, 0o600);
    const attachment = service.completeUpload(reservation.attachment.id, sizeBytes);
    res.status(200).json({ attachment });
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    if (moved) await unlink(destination).catch(() => undefined);
    throw error;
  } finally {
    reservation.release();
  }
}

async function writeBoundedRequest(req: Request, path: string, maxBytes: number): Promise<number> {
  const handle = await open(path, "wx", 0o600);
  let total = 0;
  try {
    for await (const raw of req) {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as Uint8Array);
      total += chunk.byteLength;
      if (total > maxBytes) {
        throw new WebConsoleError("attachment_too_large", "Attachment exceeds the 20 MiB file limit.", 413);
      }
      let offset = 0;
      while (offset < chunk.byteLength) {
        const { bytesWritten } = await handle.write(chunk, offset, chunk.byteLength - offset);
        if (bytesWritten <= 0) throw new WebConsoleError("upload_write_failed", "Upload storage made no write progress.", 500);
        offset += bytesWritten;
      }
    }
    await handle.sync();
    const info = await handle.stat();
    if (!info.isFile() || info.size !== total) {
      throw new WebConsoleError("upload_write_failed", "Stored upload size did not match the received bytes.", 500);
    }
    return total;
  } finally {
    await handle.close();
  }
}

async function handleDownloadContent(id: string, res: Response, service: WebService): Promise<void> {
  const attachment = service.storedAttachment(id);
  if (!attachment.uploaded) throw new WebConsoleError("attachment_not_ready", "Attachment upload is incomplete.", 409);
  const path = service.store.attachmentPath(attachment);
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    throw new WebConsoleError("attachment_integrity", `Attachment content is unavailable (${errorMessage(error)}).`, 409);
  }
  const info = await handle.stat();
  if (!info.isFile() || info.size !== attachment.sizeBytes) {
    await handle.close();
    throw new WebConsoleError("attachment_integrity", "Attachment content is unavailable.", 409);
  }
  const image = attachment.kind === "image";
  res.status(200);
  res.setHeader("Content-Type", image ? attachment.contentType : "application/octet-stream");
  res.setHeader("Content-Length", String(info.size));
  // An upload id is a fresh UUID whose bytes are written exactly once, so this
  // URL can never change meaning. `no-transform` keeps the declared length
  // honest for the client that streams these bytes back into a Blob.
  res.setHeader("Cache-Control", `private, max-age=${IMMUTABLE_MAX_AGE_SECONDS}, immutable, no-transform`);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
  res.setHeader("Content-Disposition", contentDisposition(attachment.name, image ? "inline" : "attachment"));
  const stream = handle.createReadStream({ autoClose: false });
  await pipeline(stream, res).finally(async () => handle.close());
}

function replyAccessQuery(req: Request): { readonly expires: string; readonly token: string } {
  const expires = req.query.expires;
  const token = req.query.token;
  if (
    typeof expires !== "string"
    || !/^\d{10,13}$/u.test(expires)
    || typeof token !== "string"
    || !/^[A-Za-z0-9_-]{43}$/u.test(token)
  ) {
    throw new WebConsoleError("reply_part_not_found", "The reply part is unavailable.", 404);
  }
  return { expires, token };
}

function setReplyDownloadHeaders(
  res: Response,
  part: Extract<WebMessagePart, { type: "attachment" }>,
  /** Seconds this response's own capability is still good for. */
  maxAgeSeconds: number,
): void {
  const risky = /^(?:text\/(?:html|javascript|xml)|application\/(?:javascript|xhtml\+xml|xml)|image\/svg\+xml)$/iu
    .test(part.mediaType);
  res.status(200);
  res.setHeader("Content-Type", risky ? "application/octet-stream" : part.mediaType);
  if (risky) res.setHeader("X-Original-Content-Type", part.mediaType);
  res.setHeader("Content-Length", String(part.sizeBytes));
  res.setHeader("Accept-Ranges", "none");
  res.setHeader("Content-Disposition", contentDisposition(part.name, "attachment"));
  // The client refuses a part whose Content-Length disagrees with the declared
  // size, so this response must reach it byte-for-byte -- hence `no-transform`.
  //
  // Cacheable for exactly as long as the signed key in the URL is: the mint
  // quantises its expiry to a five-minute bucket, so the same picture asked for
  // twice inside one bucket is the same URL and the browser answers the second
  // read itself. `private`, because the URL is a capability and no shared cache
  // may keep it; never past the key, because the response is only servable while
  // the key is.
  res.setHeader("Cache-Control", `private, max-age=${String(maxAgeSeconds)}, no-transform`);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Security-Policy", "sandbox; default-src 'none'; base-uri 'none'; form-action 'none'");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader("X-Mono-Agent-Integrity-Id", part.integrityId);
}

function setPrivateAppHeaders(res: Response): void {
  res.setHeader("Cache-Control", "private, no-store, max-age=0");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Security-Policy", "default-src 'none'; base-uri 'none'; frame-ancestors 'none'");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
}

function setMcpAppProxyHeaders(res: Response): void {
  res.setHeader("Cache-Control", "private, no-store, max-age=0");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Content-Security-Policy", MCP_APP_PROXY_CONTENT_SECURITY_POLICY);
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
}

function validateLocalRequest(
  configuredHost: string,
  additionalHosts: readonly string[],
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, _res, next): void => {
    try {
      const host = normalizedAuthority(req.headers.host);
      if (!isAllowedWebHostname(host.hostname, configuredHost, systemHostname(), additionalHosts)) {
        throw new WebConsoleError("untrusted_host", "This Host is not allowed for the local web console.", 421);
      }
      if (isMutation(req.method)) {
        if (req.headers["sec-fetch-site"] === "cross-site") {
          throw new WebConsoleError("cross_site_request", "Cross-site mutations are not allowed.", 403);
        }
        const rawOrigin = req.headers.origin;
        if (rawOrigin !== undefined) {
          let origin: URL;
          try {
            origin = new URL(rawOrigin);
          } catch {
            throw new WebConsoleError("invalid_origin", "Request Origin is invalid.", 403);
          }
          if ((origin.protocol !== "http:" && origin.protocol !== "https:") || origin.host.toLowerCase() !== host.authority) {
            throw new WebConsoleError("origin_mismatch", "Cross-origin mutations are not allowed.", 403);
          }
        }
      }
      next();
    } catch (error) {
      next(error);
    }
  };
}

export function isAllowedWebHostname(
  hostname: string,
  configuredHost: string,
  machineHostname = systemHostname(),
  additionalHosts: readonly string[] = [],
): boolean {
  const normalizedMachine = normalizeAllowedHostname(machineHostname);
  const allowedConfiguredNames = new Set<string>([
    normalizedMachine,
    `${normalizedMachine}.local`,
    ...additionalHosts.map(normalizeAllowedHostname),
  ]);
  const normalizedConfigured = configuredHost.toLowerCase().replace(/^\[|\]$/gu, "");
  if (isIP(normalizedConfigured) === 0 && /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/iu.test(normalizedConfigured)) {
    allowedConfiguredNames.add(normalizedConfigured);
  }
  return isAllowedLocalHostname(hostname, allowedConfiguredNames);
}

function normalizedAuthority(value: string | undefined): { readonly authority: string; readonly hostname: string } {
  if (value === undefined || value.trim().length === 0 || /[\s/@\\]/u.test(value)) {
    throw new WebConsoleError("invalid_host", "Request Host is invalid.", 400);
  }
  let parsed: URL;
  try {
    parsed = new URL(`http://${value}`);
  } catch {
    throw new WebConsoleError("invalid_host", "Request Host is invalid.", 400);
  }
  return {
    authority: parsed.host.toLowerCase(),
    hostname: parsed.hostname.toLowerCase().replace(/\.$/u, ""),
  };
}

function isAllowedLocalHostname(hostname: string, allowedConfiguredNames: ReadonlySet<string>): boolean {
  const unwrapped = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  const ipKind = isIP(unwrapped);
  if (ipKind === 4) return isPrivateIpv4(unwrapped);
  if (ipKind === 6) {
    const normalized = unwrapped.toLowerCase();
    return normalized === "::1" || normalized.startsWith("fe80:") || normalized.startsWith("fc") || normalized.startsWith("fd");
  }
  return unwrapped === "localhost"
    || unwrapped.endsWith(".localhost")
    || allowedConfiguredNames.has(unwrapped);
}

function resolveAllowedHosts(
  configured: readonly string[] | undefined,
  env: Readonly<Record<string, string | undefined>>,
): string[] {
  const fromEnv = env?.MONO_AGENT_WEB_ALLOWED_HOSTS?.split(",") ?? [];
  return [...new Set([...(configured ?? []), ...fromEnv]
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
    .map(normalizeAllowedHostname))];
}

function normalizeAllowedHostname(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/\.$/u, "");
  if (normalized.length === 0
    || normalized.includes(":")
    || !/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/u.test(normalized)) {
    throw new WebConsoleError("invalid_allowed_host", `Invalid allowed web hostname: ${value}`, 400);
  }
  return normalized;
}

function isPrivateIpv4(value: string): boolean {
  const [first = -1, second = -1] = value.split(".").map(Number);
  return first === 0
    || first === 10
    || first === 127
    || (first === 169 && second === 254)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168)
    || (first === 100 && second >= 64 && second <= 127);
}

function securityHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader("Content-Security-Policy", "default-src 'self'; connect-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; font-src 'self' data:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
  next();
}

function parseCreateThread(value: unknown): CreateWebThreadInput {
  const body = requireRecord(value);
  const model = optionalNullableString(body.model, "model", 120);
  const effort = optionalNullableString(body.effort, "effort", 120);
  return {
    sourceId: requireString(body.sourceId, "sourceId", 256),
    ...(model === undefined ? {} : { model }),
    ...(effort === undefined ? {} : { effort }),
  };
}

function parsePutAgentRunSettings(value: unknown): PutWebAgentRunSettingsInput {
  const body = requireRecord(value);
  if (!("model" in body) || !("effort" in body)) {
    throw invalidBody("model and effort are required and must be strings or null.");
  }
  const unknown = Object.keys(body).filter((key) => key !== "model" && key !== "effort");
  if (unknown.length > 0) throw invalidBody(`Unknown run-defaults field: ${unknown[0]}.`);
  const model = optionalNullableString(body.model, "model", 120);
  const effort = optionalNullableString(body.effort, "effort", 120);
  if (model === undefined || effort === undefined) {
    throw invalidBody("model and effort are required and must be strings or null.");
  }
  if (model === null && effort === null) {
    throw invalidBody("Choose a model or effort override, or use Revert to config.");
  }
  return { model, effort };
}

function parsePatchAgent(value: unknown): PatchWebAgentInput {
  const body = requireRecord(value);
  if (typeof body.pinned !== "boolean") throw invalidBody("pinned must be boolean.");
  return { pinned: body.pinned };
}

function parsePatchThread(value: unknown): PatchWebThreadInput {
  const body = requireRecord(value);
  const title = optionalString(body.title, "title", 120);
  const model = optionalNullableString(body.model, "model", 120);
  const effort = optionalNullableString(body.effort, "effort", 120);
  const archived = body.archived;
  if (archived !== undefined && typeof archived !== "boolean") throw invalidBody("archived must be boolean.");
  const ifRunConfigUnset = body.ifRunConfigUnset;
  if (ifRunConfigUnset !== undefined && typeof ifRunConfigUnset !== "boolean") {
    throw invalidBody("ifRunConfigUnset must be boolean.");
  }
  if (title === undefined && archived === undefined && model === undefined && effort === undefined) {
    throw invalidBody("Provide title, archived, model, or effort.");
  }
  return {
    ...(title === undefined ? {} : { title }),
    ...(archived === undefined ? {} : { archived }),
    ...(model === undefined ? {} : { model }),
    ...(effort === undefined ? {} : { effort }),
    ...(ifRunConfigUnset === undefined ? {} : { ifRunConfigUnset }),
  };
}

function parseTurn(value: unknown): StartWebTurnInput {
  const body = requireRecord(value);
  const text = body.text === undefined
    ? undefined
    : requireString(body.text, "text", WEB_MAX_TURN_TEXT_CHARACTERS, true);
  const quoteBody = body.quote === undefined ? undefined : requireRecord(body.quote);
  const quote = quoteBody === undefined
    ? undefined
    : {
        text: requireString(
          quoteBody.text,
          "quote.text",
          WEB_MAX_TURN_TEXT_CHARACTERS,
        ),
        messageId: requireString(quoteBody.messageId, "quote.messageId", 256),
      };
  const attachmentIds = body.attachmentIds;
  if (attachmentIds !== undefined && (!Array.isArray(attachmentIds) || !attachmentIds.every((id) => typeof id === "string" && id.length > 0))) {
    throw invalidBody("attachmentIds must be an array of ids.");
  }
  const model = optionalString(body.model, "model", 512);
  const effort = optionalString(body.effort, "effort", 128);
  return {
    ...(text === undefined ? {} : { text }),
    ...(quote === undefined ? {} : { quote }),
    ...(attachmentIds === undefined ? {} : { attachmentIds }),
    ...(model === undefined ? {} : { model }),
    ...(effort === undefined ? {} : { effort }),
  };
}

function parseLiveInput(value: unknown): StartWebLiveInputInput {
  const body = requireRecord(value);
  return {
    text: requireString(body.text, "text", AGENT_LIVE_INPUT_MAX_CHARACTERS),
  };
}

function parseCreateUpload(value: unknown): CreateWebUploadInput {
  const body = requireRecord(value);
  const sizeBytes = body.sizeBytes;
  if (sizeBytes !== undefined && (!Number.isSafeInteger(sizeBytes) || (sizeBytes as number) < 0)) {
    throw invalidBody("sizeBytes must be a non-negative integer.");
  }
  return {
    name: requireString(body.name, "name", 1_024),
    contentType: requireString(body.contentType, "contentType", 256),
    ...(sizeBytes === undefined ? {} : { sizeBytes: sizeBytes as number }),
  };
}

function parsePushSubscription(value: unknown): {
  readonly endpoint: string;
  readonly p256dh: string;
  readonly auth: string;
  readonly expirationTime?: number;
  readonly previousSubscriptionId?: string;
  readonly previousEndpoint?: string;
} {
  const body = requireRecord(value);
  const keys = requireRecord(body.keys);
  const expirationTime = body.expirationTime;
  if (expirationTime !== undefined && expirationTime !== null && !Number.isSafeInteger(expirationTime)) {
    throw invalidBody("expirationTime must be an integer timestamp or null.");
  }
  if (body.previousSubscriptionId !== undefined && body.previousEndpoint !== undefined) {
    throw invalidBody("previousSubscriptionId and previousEndpoint are mutually exclusive.");
  }
  return {
    endpoint: requireString(body.endpoint, "endpoint", 2_048),
    p256dh: requireString(keys.p256dh, "keys.p256dh", 256),
    auth: requireString(keys.auth, "keys.auth", 256),
    ...(expirationTime === undefined || expirationTime === null ? {} : { expirationTime: expirationTime as number }),
    ...(body.previousSubscriptionId === undefined
      ? {}
      : { previousSubscriptionId: requireString(body.previousSubscriptionId, "previousSubscriptionId", 256) }),
    ...(body.previousEndpoint === undefined
      ? {}
      : { previousEndpoint: requireString(body.previousEndpoint, "previousEndpoint", 2_048) }),
  };
}

function exactRequestOrigin(req: Request): string {
  const claimedOrigin = req.headers["x-mono-agent-web-origin"];
  if (claimedOrigin !== undefined && typeof claimedOrigin !== "string") {
    throw new WebConsoleError("invalid_origin", "Request Origin is invalid.", 403);
  }
  const rawOrigin = req.headers.origin ?? claimedOrigin;
  if (rawOrigin === undefined) {
    throw new WebConsoleError("origin_required", "Push subscription changes require an exact same-origin request.", 403);
  }
  const origin = validateExactOrigin(req, rawOrigin);
  if (req.headers.origin !== undefined && claimedOrigin !== undefined
    && validateExactOrigin(req, claimedOrigin) !== origin) {
    throw new WebConsoleError("origin_mismatch", "Push subscription changes must come from this exact console origin.", 403);
  }
  return origin;
}

function validateExactOrigin(req: Request, rawOrigin: string): string {
  let origin: URL;
  try {
    origin = new URL(rawOrigin);
  } catch {
    throw new WebConsoleError("invalid_origin", "Request Origin is invalid.", 403);
  }
  const host = normalizedAuthority(req.headers.host);
  if ((origin.protocol !== "http:" && origin.protocol !== "https:") || origin.host.toLowerCase() !== host.authority
    || origin.username !== "" || origin.password !== "" || origin.pathname !== "/" || origin.search !== "" || origin.hash !== "") {
    throw new WebConsoleError("origin_mismatch", "Push subscription changes must come from this exact console origin.", 403);
  }
  return origin.origin;
}

function sameOriginRead(req: Request): void {
  const site = req.headers["sec-fetch-site"];
  if (site === "cross-site" || site === "same-site") {
    throw new WebConsoleError("cross_site_request", "Cross-origin push subscription reads are not allowed.", 403);
  }
  const claimedOrigin = req.headers["x-mono-agent-web-origin"];
  if (typeof claimedOrigin !== "string") {
    throw new WebConsoleError("origin_required", "Push subscription reads require the exact console origin.", 403);
  }
  validateExactOrigin(req, claimedOrigin);
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalidBody("JSON body must be an object.");
  return value as Record<string, unknown>;
}

/**
 * One connection's view of the event stream: which frames it is served, and in
 * what form.
 *
 * A console names the conversation it is looking at with `?thread=`. It is
 * served EVERYTHING about that conversation unthrottled -- `message.delta`
 * frames carrying what each write changed, and the `message.changed` hints the
 * delta path emits when it declines (a delta bigger than the message, a
 * reconciliation that describes nothing), because both are things it must act
 * on. Anything about any OTHER conversation is reduced to a
 * `message.changed { messageId, updatedAt }` and rate-limited to one per
 * conversation per {@link DELTA_HINT_INTERVAL_MS}, dropped rather than queued:
 * a console is not rendering it.
 *
 * A console that named NO conversation is not telling this stream which
 * conversation it is looking at, so it keeps every reconciliation hint and is
 * rate-limited only on what the delta path produces -- downgraded deltas and
 * the declines above -- which is the write-rate traffic the limit exists for. A
 * turn's `thread.changed` still follows every finish unthrottled, so a dropped
 * frame never leaves a settled conversation stale.
 *
 * Every other event type passes through untouched. `Last-Event-ID` is ignored
 * and nothing is replayed: this is state invalidation, not a log. A
 * reconnecting console bootstraps, and `ready` means resync the conversation it
 * has open.
 *
 * Lives outside the route because neither of the two things that matter is
 * observable through an HTTP fixture: the rate limit is a clock decision, and a
 * frame this connection cannot serialize or write must CLOSE it rather than
 * leave a socket that reads live and receives nothing.
 */
export function createWebEventDispatch(options: {
  /** The conversation this connection named, if it named one. */
  readonly subscribed?: string;
  readonly write: (event: WebEvent) => boolean;
  readonly close: () => void;
  readonly onFailure?: (error: unknown) => void;
  readonly now?: () => number;
}): (event: WebEvent) => boolean {
  const { subscribed, write, close, onFailure } = options;
  const now = options.now ?? ((): number => Date.now());
  // Per connection, and cleared with it: what one console has already been told
  // about is no reason to keep another quiet.
  const hintedAt = new Map<string, number>();

  const hint = (event: WebEvent, payload: WebMessageChangedPayload): boolean => write({
    ...event,
    type: "message.changed",
    // `deltaDeclined` is this layer's own signal and stops here.
    payload: { messageId: payload.messageId, updatedAt: payload.updatedAt },
  });

  const rateLimited = (event: WebEvent, payload: WebMessageChangedPayload): boolean => {
    const key = event.threadId ?? "";
    const at = now();
    const last = hintedAt.get(key);
    // Dropped, not queued: a hint says only that the message moved, so the one
    // that was suppressed is answered by the one that follows it.
    if (last !== undefined && at - last < DELTA_HINT_INTERVAL_MS) return true;
    // Delete before set, so insertion order IS recency order and the eviction
    // below drops the conversation this connection heard about longest ago.
    hintedAt.delete(key);
    hintedAt.set(key, at);
    while (hintedAt.size > MAX_THROTTLED_CONVERSATIONS) {
      const oldest = hintedAt.keys().next();
      if (oldest.done === true) break;
      hintedAt.delete(oldest.value);
    }
    return hint(event, payload);
  };

  return (event: WebEvent): boolean => {
    try {
      if (event.type !== "message.delta" && event.type !== "message.changed") return write(event);
      const own = event.threadId !== undefined && event.threadId === subscribed;
      if (event.type === "message.delta") {
        const delta = requireMessageDelta(event.payload);
        return own ? write(event) : rateLimited(event, delta);
      }
      const payload = requireMessageChanged(event.payload);
      if (own) return hint(event, payload);
      if (subscribed === undefined && payload.deltaDeclined !== true) return hint(event, payload);
      return rateLimited(event, payload);
    } catch (error) {
      // A frame this connection cannot make sense of is a server bug, and the
      // honest answer is to end the stream so the console reconnects and
      // bootstraps -- never to drop the frame and keep a live-looking socket.
      onFailure?.(error);
      close();
      return false;
    }
  };
}

function requireMessageDelta(payload: unknown): WebMessageDelta {
  const delta = payload as Partial<WebMessageDelta> | null | undefined;
  if (delta === null || delta === undefined || typeof delta !== "object"
    || typeof delta.messageId !== "string"
    || typeof delta.updatedAt !== "string"
    || typeof delta.baseSeq !== "number"
    || typeof delta.seq !== "number"
    || !Array.isArray(delta.ops)) {
    throw new TypeError("A message.delta event carried no delta.");
  }
  return delta as WebMessageDelta;
}

function requireMessageChanged(payload: unknown): WebMessageChangedPayload {
  const changed = payload as Partial<WebMessageChangedPayload> | null | undefined;
  if (changed === null || changed === undefined || typeof changed !== "object"
    || typeof changed.messageId !== "string"
    || typeof changed.updatedAt !== "string") {
    throw new TypeError("A message.changed event named no message.");
  }
  return changed as WebMessageChangedPayload;
}

function requiredQueryString(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > max) {
    throw new WebConsoleError("invalid_page", `${field} is required.`, 400);
  }
  return value;
}

/**
 * A search box is typed into and cleared, so an empty or absent `q` is an
 * ordinary state answered with an empty page — not the invalid cursor that
 * `optionalQueryString` would report it as.
 */
function optionalSearchQuery(value: unknown, max: number): string {
  if (value === undefined) return "";
  if (typeof value !== "string" || value.length > max) {
    throw new WebConsoleError(
      "invalid_page",
      `q must be a string of at most ${String(max)} characters.`,
      400,
    );
  }
  return value;
}

/**
 * The conversation a console subscribes its event stream to.
 *
 * Its own code, not the pagination one: an invalid `?thread=` is a bad
 * subscription, and answering it with "Pagination cursor is invalid." sent a
 * console looking for a cursor it never sent.
 */
function optionalThreadSubscription(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw invalidSubscription();
  }
  // The TRIMMED id is the subject of every rule here: it is what the dispatch
  // compares against `event.threadId`, so it is what the length must bound and
  // what is returned. Returning the padded string matched nothing and served
  // hints for the conversation on screen.
  const named = value.trim();
  // Blank is refused rather than read as "no subscription": `?thread=` and
  // `?thread=%20` are a console asking for a conversation and getting one it
  // never named, which would look like the delta stream had simply stopped.
  if (named.length === 0 || named.length > MAX_SUBSCRIPTION_LENGTH) throw invalidSubscription();
  return named;
}

function invalidSubscription(): WebConsoleError {
  return new WebConsoleError(
    "invalid_subscription",
    `thread must name one conversation, in at most ${String(MAX_SUBSCRIPTION_LENGTH)} characters.`,
    400,
  );
}

function optionalQueryString(value: unknown, max: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    throw new WebConsoleError("invalid_page", "Pagination cursor is invalid.", 400);
  }
  return value;
}

/** `true`/`false`, or `undefined` for a query that said neither. */
function optionalArchivedQuery(value: unknown): boolean | undefined {
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === undefined) return undefined;
  throw new WebConsoleError("invalid_page", "archived must be true or false.", 400);
}

/**
 * `?full=1` (or `full=true`) turns the transcript diet off for one read: no
 * truncated tool payloads, no stripped telemetry. Anything else, including an
 * absent parameter, keeps the shaped transcript.
 *
 * It changes the SHAPE of the messages a read answers with, never how many: a
 * full conversation read still answers with one page and the rest still comes
 * from `messagesNextCursor` (or an explicit `limit`).
 */
function fullTranscriptQuery(value: unknown): WebTranscriptShape {
  return value === "1" || value === "true" ? { full: true } : {};
}

function boundedQueryLimit(value: unknown, maximum: number, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !/^\d+$/u.test(value)) {
    throw new WebConsoleError("invalid_page", "Pagination limit is invalid.", 400);
  }
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > maximum) {
    throw new WebConsoleError("invalid_page", `Pagination limit must be 1-${String(maximum)}.`, 400);
  }
  return limit;
}

function parseCronAction(value: unknown): {
  readonly idempotencyKey: string;
  readonly confirmationToken?: string;
} {
  const body = requireRecord(value);
  const idempotencyKey = requireString(body.idempotencyKey, "idempotencyKey", 256);
  const confirmationToken = optionalString(body.confirmationToken, "confirmationToken", 1_024);
  return { idempotencyKey, ...(confirmationToken === undefined ? {} : { confirmationToken }) };
}

function requireString(value: unknown, field: string, max: number, allowEmpty = false): string {
  if (typeof value !== "string" || value.length > max || (!allowEmpty && value.trim().length === 0)) {
    throw invalidBody(`${field} must be a${allowEmpty ? "" : " non-empty"} string of at most ${max} characters.`);
  }
  return value;
}

function optionalString(value: unknown, field: string, max: number): string | undefined {
  return value === undefined ? undefined : requireString(value, field, max);
}

/** Optional override field: absent (`undefined`), cleared (`null`), or a bounded string. */
function optionalNullableString(value: unknown, field: string, max: number): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return requireString(value, field, max);
}

function invalidBody(message: string): WebConsoleError {
  return new WebConsoleError("invalid_request", message, 400);
}

function pathParam(value: string | readonly string[] | undefined): string {
  const id = Array.isArray(value) ? value[0] : value;
  if (typeof id !== "string" || id.length === 0 || id.length > 512) throw invalidBody("Path id is invalid.");
  return id;
}

function parseContentLength(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/u.test(value)) throw invalidBody("Content-Length is invalid.");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw invalidBody("Content-Length is invalid.");
  return parsed;
}

function contentDisposition(name: string, disposition: "inline" | "attachment"): string {
  const ascii = name.replace(/[^\x20-\x7e]/gu, "_").replace(/["\\]/gu, "_").slice(0, 150) || "attachment";
  const encoded = encodeURIComponent(name).replace(/[!'()*]/gu, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

function formatSse(event: WebEvent): string {
  return `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

function isMutation(method: string): boolean {
  return method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
}

function normalizePort(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 65_535) throw new WebConsoleError("invalid_port", "Web port must be an integer from 0 to 65535.", 400);
  return value;
}

function defaultStaticDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../webapp/dist");
}
