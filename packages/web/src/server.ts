import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { chmod, open, readFile, rename, unlink } from "node:fs/promises";
import { createServer } from "node:http";
import { isIP } from "node:net";
import { hostname as systemHostname } from "node:os";
import { dirname, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

import {
  AGENT_LIVE_INPUT_MAX_CHARACTERS,
  closeServerBounded,
  hostForUrl,
  listen,
  normalizeHostForBind,
  type ChannelAskAnswer,
} from "@mono-agent/agent-contracts";
import express, { type NextFunction, type Request, type Response } from "express";

import {
  DEFAULT_WEB_THEME,
  WEB_API_VERSION,
  WEB_MAX_TURN_TEXT_CHARACTERS,
  WEB_THEMES,
  type CreateWebCollectionInput,
  type CreateWebThreadInput,
  type CreateWebUploadInput,
  type PatchWebAgentPreferencesInput,
  type PatchWebAgentInput,
  type PatchWebCollectionInput,
  type PatchWebThreadInput,
  type StartWebLiveInputInput,
  type StartWebTurnInput,
  type WebEvent,
  type WebConsoleIdentity,
  type WebMemoryActionInput,
  type WebMemoryEditInput,
  type WebMemoryGraphQuery,
  type WebMemoryRecordQuery,
  type WebMessagePart,
  type WebTheme,
} from "./contracts.js";
import { errorMessage, WebConsoleError } from "./errors.js";
import {
  MCP_APP_PROXY_CONTENT_SECURITY_POLICY,
  MCP_APP_PROXY_DOCUMENT,
  MCP_APP_PROXY_PATH,
} from "./mcp-app-proxy.js";
import {
  startWebNotificationIngress,
  type WebNotificationIngressHandle,
} from "./notification-ingress.js";
import { WebService, type CreateWebServiceOptions } from "./service.js";

export const DEFAULT_WEB_HOST = "0.0.0.0";
export const DEFAULT_WEB_PORT = 5050;
const HEARTBEAT_INTERVAL_MS = 15_000;
const MAX_SSE_CLIENTS = 64;
const MAX_MCP_APP_BRIDGE_REQUEST_BYTES = 64 * 1024;
const MAX_MEMORY_ACTION_BODY_BYTES = 64 * 1024;
const MAX_MEMORY_RECORD_PAGE = 100;
const MAX_MEMORY_GRAPH_NODES = 200;
const MAX_MEMORY_ID_CODE_POINTS = 512;
const MAX_MEMORY_QUERY_CODE_POINTS = 512;
const MAX_MEMORY_TEXT_CODE_POINTS = 4_000;
const MAX_MEMORY_TAGS = 32;
const MAX_MEMORY_TAG_CODE_POINTS = 64;
const MAX_MEMORY_COLLECTION_CODE_POINTS = 128;
const MEMORY_IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,199}$/u;
const MEMORY_COLLECTION = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const INVALID_MEMORY_SEMANTIC_TEXT = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;
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
  app.use(securityHeaders);
  app.use(validateLocalRequest(host, allowedHosts));
  app.use("/api", (_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Pragma", "no-cache");
    next();
  });
  app.use("/api/v1/agents/:id/memory", express.json({ limit: MAX_MEMORY_ACTION_BODY_BYTES, strict: true }));
  app.use("/api/v1", express.json({ limit: "256kb", strict: true }));

  app.get("/healthz", (_req, res) => {
    res.status(200).json({
      status: "ok",
      version: WEB_API_VERSION,
      push: service.webPushDegraded() ? "degraded" : "ok",
    });
  });

  app.get("/api/v1/bootstrap", (_req, res, next) => {
    void service.bootstrap()
      .then((bootstrap) => res.status(200).json({ ...bootstrap, console: consoleIdentity }))
      .catch(next);
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

  app.get("/api/v1/agents/:id/preferences", (req, res, next) => {
    try {
      res.status(200).json({ preferences: service.agentPreferences(pathParam(req.params.id)) });
    } catch (error) {
      next(error);
    }
  });

  app.patch("/api/v1/agents/:id/preferences", (req, res, next) => {
    try {
      const input = parsePatchAgentPreferences(req.body);
      res.status(200).json({
        preferences: service.patchAgentPreferences(pathParam(req.params.id), input),
      });
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

  app.get("/api/v1/agents/:id/memory", (req, res, next) => {
    try {
      assertMemoryQueryFields(req, []);
      void trackOperation(service.memoryOverview(pathParam(req.params.id)), activeOperations)
        .then((availability) => res.status(200).json(availability))
        .catch(next);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/v1/agents/:id/memory/records", (req, res, next) => {
    try {
      const query = memoryRecordQuery(req);
      void trackOperation(service.memoryRecords(pathParam(req.params.id), query), activeOperations)
        .then((page) => res.status(200).json(page))
        .catch(next);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/v1/agents/:id/memory/records/:recordId", (req, res, next) => {
    try {
      assertMemoryQueryFields(req, []);
      void trackOperation(service.memoryRecord(
        pathParam(req.params.id),
        memoryIdentifier(req.params.recordId, "record"),
      ), activeOperations).then((detail) => res.status(200).json(detail)).catch(next);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/v1/agents/:id/memory/graph", (req, res, next) => {
    try {
      const query = memoryGraphQuery(req);
      void trackOperation(service.memoryGraph(pathParam(req.params.id), query), activeOperations)
        .then((graph) => res.status(200).json({ graph }))
        .catch(next);
    } catch (error) {
      next(error);
    }
  });

  app.patch("/api/v1/agents/:id/memory/records/:recordId", (req, res, next) => {
    try {
      exactRequestOrigin(req);
      assertMemoryQueryFields(req, []);
      const input = parseMemoryEditInput(req.body);
      void trackOperation(service.memoryEdit(
        pathParam(req.params.id),
        memoryIdentifier(req.params.recordId, "record"),
        input,
      ), activeOperations).then((result) => res.status(202).json(result)).catch(next);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/v1/agents/:id/memory/records/:recordId/forget", (req, res, next) => {
    try {
      exactRequestOrigin(req);
      assertMemoryQueryFields(req, []);
      const input = parseMemoryActionInput(req.body);
      void trackOperation(service.memoryForget(
        pathParam(req.params.id),
        memoryIdentifier(req.params.recordId, "record"),
        input,
      ), activeOperations).then((result) => {
        res.status(result.kind === "confirmation_required" ? 428 : 202).json(result);
      }).catch(next);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/v1/agents/:id/memory/records/:recordId/restore", (req, res, next) => {
    try {
      exactRequestOrigin(req);
      assertMemoryQueryFields(req, []);
      const input = parseMemoryActionInput(req.body);
      void trackOperation(service.memoryRestore(
        pathParam(req.params.id),
        memoryIdentifier(req.params.recordId, "record"),
        input,
      ), activeOperations).then((result) => res.status(202).json(result)).catch(next);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/v1/agents/:id/memory/operations/:operationId", (req, res, next) => {
    try {
      assertMemoryQueryFields(req, []);
      void trackOperation(service.memoryOperation(
        pathParam(req.params.id),
        memoryIdentifier(req.params.operationId, "operation"),
      ), activeOperations).then((operation) => res.status(200).json({ operation })).catch(next);
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
      res.status(201).json({ thread: service.createThread(input.sourceId) });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/v1/collections", (_req, res, next) => {
    try {
      res.status(200).json({ collections: service.collections() });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/v1/collections", (req, res, next) => {
    try {
      const input = parseCreateCollection(req.body);
      res.status(201).json({ collection: service.createCollection(input.name) });
    } catch (error) {
      next(error);
    }
  });

  app.patch("/api/v1/collections/:id", (req, res, next) => {
    try {
      const input = parsePatchCollection(req.body);
      res.status(200).json({
        collection: service.patchCollection(pathParam(req.params.id), input.name),
      });
    } catch (error) {
      next(error);
    }
  });

  app.delete("/api/v1/collections/:id", (req, res, next) => {
    try {
      service.deleteCollection(pathParam(req.params.id));
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/v1/threads", (req, res, next) => {
    try {
      const legacySourceIds = optionalRepeatedQueryStrings(req.query.sourceId, "sourceId", 512);
      const sourceIds = optionalRepeatedQueryStrings(req.query.sourceIds, "sourceIds", 512);
      if (legacySourceIds !== undefined && sourceIds !== undefined) {
        throw new WebConsoleError("invalid_page", "Provide sourceId or sourceIds, not both.", 400);
      }
      const selectedSourceIds = sourceIds ?? legacySourceIds;
      const archived = optionalBooleanQuery(req.query.archived, "archived") ?? false;
      const workflowStatus = optionalEnumQuery(
        req.query.workflowStatus,
        "workflowStatus",
        ["todo", "in_progress", "done"] as const,
      );
      const collectionValue = optionalQueryString(req.query.collectionId, 256);
      const collectionId = collectionValue === undefined
        ? undefined
        : collectionValue === "unfiled" ? null : collectionValue;
      const pinned = optionalBooleanQuery(req.query.pinned, "pinned");
      const type = optionalEnumQuery(
        req.query.type,
        "type",
        ["interactive", "cron", "webhook"] as const,
      );
      const q = optionalQueryString(req.query.q, 512);
      const groupBy = optionalEnumQuery(
        req.query.groupBy,
        "groupBy",
        ["none", "collection", "agent"] as const,
      );
      const before = optionalQueryString(req.query.before, 4_096);
      res.status(200).json(service.threadsPage({
        ...(selectedSourceIds === undefined ? {} : { sourceIds: selectedSourceIds }),
        archived,
        ...(workflowStatus === undefined ? {} : { workflowStatus }),
        ...(collectionId === undefined ? {} : { collectionId }),
        ...(pinned === undefined ? {} : { pinned }),
        ...(type === undefined ? {} : { type }),
        ...(q === undefined ? {} : { q }),
        ...(groupBy === undefined ? {} : { groupBy }),
        limit: boundedQueryLimit(req.query.limit, 200, 200),
        ...(before === undefined ? {} : { before }),
      }));
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/v1/threads/:id", (req, res, next) => {
    try {
      res.status(200).json(service.thread(pathParam(req.params.id)));
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/v1/threads/:id/messages", (req, res, next) => {
    try {
      const before = optionalQueryString(req.query.before, 4_096);
      const anchor = optionalQueryString(req.query.anchor, 256);
      if (before !== undefined && anchor !== undefined) {
        throw new WebConsoleError("invalid_page", "before and anchor are mutually exclusive.", 400);
      }
      res.status(200).json(service.messagePage(pathParam(req.params.id), {
        limit: boundedQueryLimit(req.query.limit, 100, 100),
        ...(before === undefined ? {} : { before }),
        ...(anchor === undefined ? {} : { anchor }),
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
      ).then(async ({ part, response }) => {
        if (response.body === null) throw new WebConsoleError("reply_attachment_unavailable", "Attachment stream is unavailable.", 502);
        setReplyDownloadHeaders(res, part);
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

  app.get("/api/v1/events", (_req, res) => {
    if (activeStreams.size >= MAX_SSE_CLIENTS) {
      res.status(503).json({ error: { code: "sse_capacity", message: "Too many event streams are connected." } });
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
    const send = (event: WebEvent): boolean => {
      if (closed || res.writableEnded) return false;
      const writable = res.write(formatSse(event));
      if (!writable) {
        // Events are state-invalidation hints, not an unbounded replay log. A
        // client that cannot drain one frame must reconnect and bootstrap.
        closeStream();
        return false;
      }
      return true;
    };
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

  app.use(express.static(staticDir, { fallthrough: true, index: false, redirect: false }));
  app.get("/{*splat}", (_req, res, next) => {
    // Keep the managed runtime's hidden ~/.mono-agent parent out of the
    // request-relative path. Express otherwise applies its dotfile policy to
    // the absolute path and rejects an existing index.html as Not Found.
    res.sendFile("index.html", { root: staticDir }, (error) => {
      if (error !== undefined && error !== null) next(error);
    });
  });

  app.use((error: unknown, req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      next(error);
      return;
    }
    const known = error instanceof WebConsoleError;
    const syntax = error instanceof SyntaxError && (error as { status?: unknown }).status === 400;
    const invalidPathEncoding = error instanceof URIError && (error as { status?: unknown }).status === 400;
    const tooLarge = typeof error === "object" && error !== null
      && ((error as { status?: unknown }).status === 413 || (error as { type?: unknown }).type === "entity.too.large");
    const memoryRequest = isMemoryApiRequest(req);
    const status = known ? error.status : tooLarge ? 413 : syntax || invalidPathEncoding ? 400 : 500;
    const code = known
      ? error.code
      : memoryRequest && (tooLarge || syntax || invalidPathEncoding)
        ? "invalid_request"
        : tooLarge ? "request_too_large" : syntax ? "invalid_json" : "internal_error";
    const message = memoryRequest && tooLarge
      ? "Memory request body is too large."
      : memoryRequest && invalidPathEncoding
        ? "Memory request path is not valid UTF-8."
        : memoryRequest && syntax
          ? "Request body is not valid JSON."
          : known || syntax ? errorMessage(error) : "Internal server error.";
    if (status >= 500) logger?.error?.("Web console request failed.", { error: errorMessage(error) });
    res.status(status).json({
      error: {
        code,
        message,
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
): void {
  const risky = /^(?:text\/(?:html|javascript|xml)|application\/(?:javascript|xhtml\+xml|xml)|image\/svg\+xml)$/iu
    .test(part.mediaType);
  res.status(200);
  res.setHeader("Content-Type", risky ? "application/octet-stream" : part.mediaType);
  if (risky) res.setHeader("X-Original-Content-Type", part.mediaType);
  res.setHeader("Content-Length", String(part.sizeBytes));
  res.setHeader("Accept-Ranges", "none");
  res.setHeader("Content-Disposition", contentDisposition(part.name, "attachment"));
  res.setHeader("Cache-Control", "private, no-store, max-age=0");
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
  return { sourceId: requireString(body.sourceId, "sourceId", 256) };
}

function parseCreateCollection(value: unknown): CreateWebCollectionInput {
  const body = requireRecord(value);
  return { name: requireString(body.name, "name", 80) };
}

function parsePatchCollection(value: unknown): PatchWebCollectionInput {
  const body = requireRecord(value);
  return { name: requireString(body.name, "name", 80) };
}

function parsePatchAgent(value: unknown): PatchWebAgentInput {
  const body = requireRecord(value);
  if (typeof body.pinned !== "boolean") throw invalidBody("pinned must be boolean.");
  return { pinned: body.pinned };
}

function parsePatchAgentPreferences(value: unknown): PatchWebAgentPreferencesInput {
  const body = requireRecord(value);
  if (!Object.hasOwn(body, "runPreference")) {
    throw invalidBody("runPreference is required and may be null to inherit.");
  }
  return { runPreference: parseRunPreference(body.runPreference) };
}

function parsePatchThread(value: unknown): PatchWebThreadInput {
  const body = requireRecord(value);
  const title = optionalString(body.title, "title", 120);
  const archived = body.archived;
  if (archived !== undefined && typeof archived !== "boolean") throw invalidBody("archived must be boolean.");
  const workflowStatus = body.workflowStatus;
  if (workflowStatus !== undefined
    && workflowStatus !== "todo" && workflowStatus !== "in_progress" && workflowStatus !== "done") {
    throw invalidBody("workflowStatus must be todo, in_progress, or done.");
  }
  const pinned = body.pinned;
  if (pinned !== undefined && typeof pinned !== "boolean") throw invalidBody("pinned must be boolean.");
  const hasCollectionId = Object.hasOwn(body, "collectionId");
  const collectionId = hasCollectionId
    ? body.collectionId === null ? null : requireString(body.collectionId, "collectionId", 256)
    : undefined;
  const hasRunPreference = Object.hasOwn(body, "runPreference");
  const runPreference = hasRunPreference ? parseRunPreference(body.runPreference) : undefined;
  const expectedRevision = body.expectedRevision;
  if (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || Number(expectedRevision) < 1)) {
    throw invalidBody("expectedRevision must be a positive integer.");
  }
  if (title === undefined && archived === undefined && workflowStatus === undefined && pinned === undefined
    && !hasCollectionId && !hasRunPreference) {
    throw invalidBody("Provide thread metadata to update.");
  }
  return {
    ...(title === undefined ? {} : { title }),
    ...(archived === undefined ? {} : { archived }),
    ...(workflowStatus === undefined ? {} : { workflowStatus }),
    ...(pinned === undefined ? {} : { pinned }),
    ...(hasCollectionId ? { collectionId: collectionId! } : {}),
    ...(hasRunPreference ? { runPreference: runPreference! } : {}),
    ...(expectedRevision === undefined ? {} : { expectedRevision: expectedRevision as number }),
  };
}

function parseRunPreference(value: unknown): NonNullable<PatchWebThreadInput["runPreference"]> | null {
  if (value === null) return null;
  const preference = requireRecord(value);
  const model = optionalString(preference.model, "runPreference.model", 512);
  const effort = optionalString(preference.effort, "runPreference.effort", 128);
  if (model === undefined && effort === undefined) {
    throw invalidBody("runPreference requires model or effort, or null to inherit.");
  }
  return { ...(model === undefined ? {} : { model }), ...(effort === undefined ? {} : { effort }) };
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
    throw new WebConsoleError("origin_required", "An exact same-origin request is required.", 403);
  }
  const origin = validateExactOrigin(req, rawOrigin);
  if (req.headers.origin !== undefined && claimedOrigin !== undefined
    && validateExactOrigin(req, claimedOrigin) !== origin) {
    throw new WebConsoleError("origin_mismatch", "Requests must come from this exact console origin.", 403);
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
    throw new WebConsoleError("origin_mismatch", "Requests must come from this exact console origin.", 403);
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

function requiredQueryString(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > max) {
    throw new WebConsoleError("invalid_page", `${field} is required.`, 400);
  }
  return value;
}

function optionalQueryString(value: unknown, max: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    throw new WebConsoleError("invalid_page", "Pagination cursor is invalid.", 400);
  }
  return value;
}

function optionalRepeatedQueryStrings(
  value: unknown,
  field: string,
  max: number,
): readonly string[] | undefined {
  if (value === undefined) return undefined;
  const values = Array.isArray(value) ? value : [value];
  if (values.length === 0 || values.length > 64
    || !values.every((entry) => typeof entry === "string" && entry.trim().length > 0 && entry.length <= max)) {
    throw new WebConsoleError("invalid_page", `${field} must contain 1 to 64 ids.`, 400);
  }
  return [...new Set(values as string[])];
}

function optionalBooleanQuery(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new WebConsoleError("invalid_page", `${field} must be true or false.`, 400);
}

function optionalEnumQuery<const T extends string>(
  value: unknown,
  field: string,
  allowed: readonly T[],
): T | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) return value as T;
  throw new WebConsoleError("invalid_page", `${field} is invalid.`, 400);
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

function assertMemoryQueryFields(req: Request, allowed: readonly string[]): void {
  if (Object.keys(req.query).some((key) => !allowed.includes(key))) {
    throw invalidMemoryRequest("Memory query contains an unsupported field.");
  }
}

function memoryRecordQuery(req: Request): WebMemoryRecordQuery {
  assertMemoryQueryFields(req, ["q", "lifecycle", "type", "collection", "limit", "before"]);
  const query = normalizedMemoryQueryString(req.query.q, "q", MAX_MEMORY_QUERY_CODE_POINTS);
  const collection = normalizedMemoryQueryString(
    req.query.collection,
    "collection",
    MAX_MEMORY_COLLECTION_CODE_POINTS,
  );
  const before = boundedMemoryCursor(req.query.before);
  const lifecycle = exactMemoryQueryString(req.query.lifecycle, "lifecycle");
  if (lifecycle !== undefined && lifecycle !== "active" && lifecycle !== "superseded" && lifecycle !== "forgotten") {
    throw invalidMemoryRequest("lifecycle must be active, superseded, or forgotten.");
  }
  const type = exactMemoryQueryString(req.query.type, "type");
  if (type !== undefined && type !== "task" && type !== "event" && type !== "note") {
    throw invalidMemoryRequest("type must be task, event, or note.");
  }
  return {
    ...(query === undefined ? {} : { query }),
    ...(lifecycle === undefined ? {} : { lifecycle }),
    ...(type === undefined ? {} : { type }),
    ...(collection === undefined ? {} : { collection }),
    limit: boundedMemoryLimit(req.query.limit, MAX_MEMORY_RECORD_PAGE, 50),
    ...(before === undefined ? {} : { before }),
  };
}

function memoryGraphQuery(req: Request): WebMemoryGraphQuery {
  assertMemoryQueryFields(req, ["focusId", "includeHistory", "limit"]);
  const focusId = req.query.focusId === undefined
    ? undefined
    : memoryIdentifier(singleMemoryQueryString(req.query.focusId, "focusId"), "record");
  let includeHistory: boolean | undefined;
  if (req.query.includeHistory !== undefined) {
    if (req.query.includeHistory === "true") includeHistory = true;
    else if (req.query.includeHistory === "false") includeHistory = false;
    else throw invalidMemoryRequest("includeHistory must be true or false.");
  }
  return {
    ...(focusId === undefined ? {} : { focusId }),
    ...(includeHistory === undefined ? {} : { includeHistory }),
    limit: boundedMemoryLimit(req.query.limit, MAX_MEMORY_GRAPH_NODES, 100),
  };
}

function exactMemoryQueryString(value: unknown, name: string): string | undefined {
  return value === undefined ? undefined : singleMemoryQueryString(value, name);
}

function singleMemoryQueryString(value: unknown, name: string): string {
  if (typeof value !== "string") throw invalidMemoryRequest(`${name} must be a single string.`);
  return value;
}

function normalizedMemoryQueryString(
  value: unknown,
  name: string,
  maxCodePoints: number,
): string | undefined {
  if (value === undefined) return undefined;
  const normalized = singleMemoryQueryString(value, name).normalize("NFKC").trim();
  if (normalized.length === 0 || [...normalized].length > maxCodePoints) {
    throw invalidMemoryRequest(
      `${name} must be non-empty and at most ${String(maxCodePoints)} Unicode code points.`,
    );
  }
  return normalized;
}

function boundedMemoryCursor(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const cursor = singleMemoryQueryString(value, "before");
  if (cursor.length === 0 || Buffer.byteLength(cursor, "utf8") > 4_096) {
    throw invalidMemoryRequest("before is not a valid bounded cursor.");
  }
  return cursor;
}

function boundedMemoryLimit(value: unknown, maximum: number, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !/^\d+$/u.test(value)) {
    throw invalidMemoryRequest("limit must be a positive integer.");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw invalidMemoryRequest(`limit must be 1-${String(maximum)}.`);
  }
  return parsed;
}

function memoryIdentifier(
  value: string | readonly string[] | undefined,
  kind: "record" | "operation",
): string {
  const id = Array.isArray(value) ? undefined : value;
  if (typeof id !== "string" || id.length === 0 || [...id].length > MAX_MEMORY_ID_CODE_POINTS
    || INVALID_MEMORY_SEMANTIC_TEXT.test(id)) {
    throw invalidMemoryRequest(`A valid memory ${kind} id is required.`);
  }
  return id;
}

function parseMemoryActionInput(value: unknown): WebMemoryActionInput {
  const body = requireRecord(value);
  assertMemoryActionKeys(body, ["expectedRevision", "idempotencyKey", "confirmationToken"]);
  return parseMemoryActionFields(body);
}

function parseMemoryEditInput(value: unknown): WebMemoryEditInput {
  const body = requireRecord(value);
  assertMemoryActionKeys(body, ["expectedRevision", "idempotencyKey", "confirmationToken", "patch"]);
  const patch = requireRecord(body.patch);
  assertMemoryActionKeys(patch, ["text", "type", "tags", "salience", "collection", "dueAt", "validFrom"]);
  if (Object.keys(patch).length === 0) {
    throw invalidMemoryRequest("patch must change at least one semantic field.");
  }
  const text = patch.text === undefined
    ? undefined
    : normalizeMemorySemanticText(patch.text, "patch.text", MAX_MEMORY_TEXT_CODE_POINTS);
  let type: WebMemoryEditInput["patch"]["type"];
  if (patch.type !== undefined) {
    if (patch.type !== "task" && patch.type !== "event" && patch.type !== "note") {
      throw invalidMemoryRequest("patch.type must be task, event, or note.");
    }
    type = patch.type;
  }
  let tags: readonly string[] | undefined;
  if (patch.tags !== undefined) {
    if (!Array.isArray(patch.tags) || patch.tags.length > MAX_MEMORY_TAGS) {
      throw invalidMemoryRequest(`patch.tags must contain at most ${String(MAX_MEMORY_TAGS)} strings.`);
    }
    tags = patch.tags.map((tag, index) => normalizeMemorySemanticText(
      tag,
      `patch.tags[${String(index)}]`,
      MAX_MEMORY_TAG_CODE_POINTS,
    ));
    if (new Set(tags).size !== tags.length) {
      throw invalidMemoryRequest("patch.tags must not contain duplicates.");
    }
  }
  let salience: number | undefined;
  if (patch.salience !== undefined) {
    if (typeof patch.salience !== "number" || !Number.isFinite(patch.salience)
      || patch.salience < 0 || patch.salience > 1) {
      throw invalidMemoryRequest("patch.salience must be between 0 and 1.");
    }
    salience = patch.salience;
  }
  const collection = normalizeNullableMemoryCollection(patch.collection);
  const dueAt = nullableMemoryTimestamp(patch.dueAt, "patch.dueAt");
  const validFrom = nullableMemoryTimestamp(patch.validFrom, "patch.validFrom");
  return {
    ...parseMemoryActionFields(body),
    patch: {
      ...(text === undefined ? {} : { text }),
      ...(type === undefined ? {} : { type }),
      ...(tags === undefined ? {} : { tags }),
      ...(salience === undefined ? {} : { salience }),
      ...(collection === undefined ? {} : { collection }),
      ...(dueAt === undefined ? {} : { dueAt }),
      ...(validFrom === undefined ? {} : { validFrom }),
    },
  };
}

function parseMemoryActionFields(value: Record<string, unknown>): WebMemoryActionInput {
  if (typeof value.expectedRevision !== "string" || !/^[a-f0-9]{64}$/u.test(value.expectedRevision)) {
    throw invalidMemoryRequest("expectedRevision must be 64 lowercase hexadecimal characters.");
  }
  if (typeof value.idempotencyKey !== "string" || !MEMORY_IDEMPOTENCY_KEY.test(value.idempotencyKey)) {
    throw invalidMemoryRequest("idempotencyKey has an invalid format.");
  }
  let confirmationToken: string | undefined;
  if (value.confirmationToken !== undefined) {
    if (typeof value.confirmationToken !== "string" || value.confirmationToken.length === 0
      || Buffer.byteLength(value.confirmationToken, "utf8") > 1_024) {
      throw invalidMemoryRequest("confirmationToken must be a non-empty bounded string.");
    }
    confirmationToken = value.confirmationToken;
  }
  return {
    expectedRevision: value.expectedRevision,
    idempotencyKey: value.idempotencyKey,
    ...(confirmationToken === undefined ? {} : { confirmationToken }),
  };
}

function assertMemoryActionKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const unexpected = Object.keys(value).find((key) => !allowed.includes(key));
  if (unexpected !== undefined) {
    throw invalidMemoryRequest(`Unexpected memory action field: ${unexpected}.`);
  }
}

function normalizeMemorySemanticText(value: unknown, name: string, maxCodePoints: number): string {
  if (typeof value !== "string") throw invalidMemoryRequest(`${name} must be a string.`);
  const normalized = value.normalize("NFKC").trim();
  if (normalized.length === 0 || [...normalized].length > maxCodePoints
    || INVALID_MEMORY_SEMANTIC_TEXT.test(normalized)
    || (name === "patch.text" && normalized.includes("<!--mem"))) {
    throw invalidMemoryRequest(`${name} is invalid or exceeds ${String(maxCodePoints)} Unicode code points.`);
  }
  return normalized;
}

function normalizeNullableMemoryCollection(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return value;
  if (typeof value !== "string") {
    throw invalidMemoryRequest("patch.collection must be a string or null.");
  }
  const normalized = value
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase("en-US")
    .replace(/[ _]+/gu, "-");
  if (normalized.length === 0 || [...normalized].length > MAX_MEMORY_COLLECTION_CODE_POINTS
    || !MEMORY_COLLECTION.test(normalized)) {
    throw invalidMemoryRequest("patch.collection must be a bounded slug or null.");
  }
  return normalized;
}

function nullableMemoryTimestamp(value: unknown, name: string): string | null | undefined {
  if (value === undefined || value === null) return value;
  if (typeof value !== "string") throw invalidMemoryRequest(`${name} must be an exact ISO timestamp or null.`);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw invalidMemoryRequest(`${name} must be an exact ISO timestamp or null.`);
  }
  return value;
}

function invalidMemoryRequest(message: string): WebConsoleError {
  return new WebConsoleError("invalid_request", message, 400);
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

function isMemoryApiRequest(req: Request): boolean {
  return /^\/api\/v1\/agents\/[^/]+\/memory(?:\/|\?|$)/u.test(req.originalUrl);
}

function normalizePort(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 65_535) throw new WebConsoleError("invalid_port", "Web port must be an integer from 0 to 65535.", 400);
  return value;
}

function defaultStaticDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../webapp/dist");
}
