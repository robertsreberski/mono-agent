import { type ProcessJobWakeRecovery, validProcessJobWakeRecovery } from "./process-job-wake-recovery.js";
import {
  CONSOLE_TOOL_NAMES,
  type ConsoleToolName,
  type ConsoleToolScope,
  type ExternalConsoleToolScope,
  type WebConsoleToolScope,
} from "./console-tools.js";
import {
  parseExternalChannel,
  parseExternalKey,
  parseExternalObservation,
  parseExternalObservations,
} from "./external-conversations.js";
import { randomBytes, randomUUID } from "node:crypto";
import { chmod, lstat, open, readFile, rename, unlink } from "node:fs/promises";
import { createServer } from "node:http";

import {
  bearerTokensEqual,
  close,
  listen,
  MAX_AGENT_REPLY_PARTS,
  parseProcessJobProjection,
  readAuthorizationBearer,
  type AgentReplyPart,
  type ProcessJobProjection,
} from "@mono-agent/agent-contracts";
import express, { type NextFunction, type Request, type Response } from "express";

import { WEB_MAX_TURN_TEXT_CHARACTERS, type WebThreadNotificationTriggerKind } from "./contracts.js";
import { errorMessage, WebConsoleError } from "./errors.js";
import type { WebService, WebServiceLogger } from "./service.js";

const INGRESS_SCHEMA = 1;
const INGRESS_HOST = "127.0.0.1";
const INGRESS_PATH = "/internal/v1/notifications";
const MAX_INGRESS_BODY_BYTES = 8 * 1024 * 1024;
const MAX_INGRESS_RECORD_BYTES = 64 * 1024;
/** Upper bound on one channel turn's capability, independent of its revocation at settlement. */
const EXTERNAL_CAPABILITY_TTL_MS = 6 * 60 * 60 * 1_000;

export interface WebNotificationIngressRecord {
  readonly schema: typeof INGRESS_SCHEMA;
  readonly pid: number;
  readonly instanceId: string;
  readonly url: string;
  readonly token: string;
  readonly updatedAt: string;
}

export interface WebNotificationIngressHandle {
  readonly url: string;
  stop(): Promise<void>;
}

export async function startWebNotificationIngress(
  service: WebService,
  logger?: WebServiceLogger,
): Promise<WebNotificationIngressHandle> {
  const token = randomBytes(32).toString("base64url");
  const instanceId = randomUUID();
  const app = express();
  const server = createServer(app);
  const active = new Set<Promise<unknown>>();
  let stopPromise: Promise<void> | undefined;

  server.headersTimeout = 10_000;
  // A process-job wake may run a genuine provider turn. Keep the
  // owner-authenticated ingress bounded, but do not cut it off at the ordinary
  // five-second lifecycle-update deadline.
  server.requestTimeout = 10 * 60 * 1_000;
  server.keepAliveTimeout = 1_000;
  app.disable("x-powered-by");

  app.post(INGRESS_PATH, (req, res, next) => {
    const presented = readAuthorizationBearer(req.header("authorization"));
    if (presented === undefined || !bearerTokensEqual(presented, token)) {
      res.status(401).json({ error: { code: "unauthorized", message: "Unauthorized." } });
      return;
    }
    next();
  }, express.json({ limit: MAX_INGRESS_BODY_BYTES, strict: true }), (req, res, next) => {
    let input: ReturnType<typeof parseNotificationRequest>;
    try {
      input = parseNotificationRequest(req.body);
    } catch (error) {
      next(error);
      return;
    }
    const delivery = service.deliverNotification(input);
    active.add(delivery);
    void delivery.finally(() => active.delete(delivery)).catch(() => undefined);
    void delivery.then((result) => {
      res.status(result.duplicate ? 200 : 201).json({
        threadId: result.thread?.id ?? null,
        duplicate: result.duplicate,
        ...(result.tombstoned === true ? { tombstoned: true } : {}),
        ...(result.delivery === undefined ? {} : { delivery: result.delivery }),
      });
    }).catch(next);
  });

  // Owner discovery authorizes issuance; subsequent calls use only a turn-bound capability.
  const capabilities = new Map<string, { readonly scope: ConsoleToolScope; readonly expiresAt?: number }>();
  /** Loopback-only, same-host, no browser origin: shared by every internal callback below. */
  const localOnly = (req: Request, res: Response): boolean => {
    const bound = server.address();
    if (stopPromise !== undefined || req.header("origin") !== undefined
      || req.socket.remoteAddress !== "127.0.0.1" || bound === null || typeof bound === "string"
      || req.header("host") !== `127.0.0.1:${bound.port}`) {
      res.status(403).json({ error: { code: "forbidden", message: "Forbidden." } });
      return false;
    }
    return true;
  };
  const ownerOnly = (req: Request, res: Response, next: NextFunction): void => {
    if (!localOnly(req, res)) return;
    const presented = readAuthorizationBearer(req.header("authorization"));
    if (presented === undefined || !bearerTokensEqual(presented, token)) {
      res.status(401).json({ error: { code: "unauthorized", message: "Unauthorized." } }); return;
    }
    next();
  };
  const pruneCapabilities = (): void => {
    const now = Date.now();
    for (const [key, entry] of capabilities) {
      try {
        if (entry.expiresAt !== undefined && entry.expiresAt <= now) throw new Error("expired");
        service.assertConsoleToolTurn(entry.scope);
      } catch { capabilities.delete(key); }
    }
  };
  const mint = (scope: ConsoleToolScope, expiresAt?: number): string => {
    if (capabilities.size >= 256) throw new WebConsoleError("console_tool_busy", "Too many active console capabilities.", 409);
    const capability = randomBytes(32).toString("base64url");
    capabilities.set(capability, { scope, ...(expiresAt === undefined ? {} : { expiresAt }) });
    return capability;
  };
  app.post("/internal/v1/console-tools", (req, res, next) => {
    if (!localOnly(req, res)) return;
    const presented = readAuthorizationBearer(req.header("authorization"));
    const capability = presented === undefined ? undefined : capabilities.get(presented);
    if (presented === undefined || (!bearerTokensEqual(presented, token) && capability === undefined)) {
      res.status(401).json({ error: { code: "unauthorized", message: "Unauthorized." } }); return;
    }
    res.locals.consoleScope = capability?.scope;
    next();
  }, express.json({ limit: 16 * 1024, strict: true }), (req, res, next) => {
    try {
      const body = asRecord(req.body);
      if (body === undefined) throw new WebConsoleError("invalid_console_tool", "Invalid request.", 400);
      pruneCapabilities();
      if (res.locals.consoleScope === undefined) {
        if (Object.keys(body).some((key) => !["sourceId", "threadId", "turnId", "datedSnippets"].includes(key))
          || (body.datedSnippets !== undefined && body.datedSnippets !== true)
          || [body.sourceId, body.threadId, body.turnId].some((item) => typeof item !== "string" || item.length === 0 || item.length > 128)) {
          throw new WebConsoleError("invalid_console_tool", "Invalid turn scope.", 400);
        }
        const scope = body as unknown as WebConsoleToolScope;
        service.assertConsoleToolTurn(scope);
        const existing = [...capabilities].find(([, { scope: item }]) => item.kind !== "external"
          && item.sourceId === scope.sourceId && item.threadId === scope.threadId && item.turnId === scope.turnId && item.datedSnippets === scope.datedSnippets);
        if (existing !== undefined) { res.json({ capability: existing[0] }); return; }
        res.json({ capability: mint(scope) }); return;
      }
      // A capability revoked or expired by the prune above no longer authorizes.
      const presented = readAuthorizationBearer(req.header("authorization"));
      if (presented === undefined || !capabilities.has(presented)) {
        throw new WebConsoleError("console_tool_revoked", "The originating turn is no longer writable.", 403);
      }
      if (Object.keys(body).some((key) => !["operationId", "tool", "args"].includes(key))
        || typeof body.operationId !== "string" || typeof body.tool !== "string"
        || !CONSOLE_TOOL_NAMES.includes(body.tool as ConsoleToolName) || asRecord(body.args) === undefined) {
        throw new WebConsoleError("invalid_console_tool", "Invalid operation.", 400);
      }
      const result = service.consoleToolOperation(res.locals.consoleScope as ConsoleToolScope, {
        operationId: body.operationId, tool: body.tool as ConsoleToolName, args: body.args as Record<string, unknown>,
      });
      res.json({ result });
    } catch (error) { next(error); }
  });

  // The capability itself authorizes its own revocation; revoking twice is a no-op.
  app.post("/internal/v1/console-tools/revoke", (req, res) => {
    if (!localOnly(req, res)) return;
    const presented = readAuthorizationBearer(req.header("authorization"));
    if (presented !== undefined && !bearerTokensEqual(presented, token)) capabilities.delete(presented);
    res.json({ revoked: true });
  });

  // One-way mirror of what an owning agent process observed on a channel.
  app.post("/internal/v1/external-conversations", ownerOnly, express.json({ limit: 256 * 1024, strict: true }), (req, res, next) => {
    try {
      const body = requireFields(req.body, ["sourceId", "channel", "observations"]);
      const result = service.observeExternalConversations(sourceField(body.sourceId), parseExternalChannel(body.channel), parseExternalObservations(body.observations));
      res.json({ truncated: result.truncated });
    } catch (error) { next(error); }
  });

  // A send proved a channel conversation gone.
  app.post("/internal/v1/external-conversations/gone", ownerOnly, express.json({ limit: 16 * 1024, strict: true }), (req, res, next) => {
    try {
      const body = requireFields(req.body, ["sourceId", "channel", "key"]);
      service.markExternalConversationGone(sourceField(body.sourceId), parseExternalChannel(body.channel), parseExternalKey(body.key));
      res.json({ recorded: true });
    } catch (error) { next(error); }
  });

  // Resolve a project to its bound channel conversation for a send by the owning process.
  app.post("/internal/v1/external-destinations", ownerOnly, express.json({ limit: 16 * 1024, strict: true }), (req, res, next) => {
    try {
      const body = requireFields(req.body, ["sourceId", "channel", "projectId"]);
      if (typeof body.projectId !== "string" || body.projectId.length === 0 || body.projectId.length > 128) {
        throw new WebConsoleError("invalid_external_conversation", "Invalid projectId.", 400);
      }
      res.json(service.resolveExternalProjectDestination(sourceField(body.sourceId), parseExternalChannel(body.channel), body.projectId));
    } catch (error) { next(error); }
  });

  // Begin one channel turn: its project context, and optionally a capability
  // bound to the discovered process generation and revoked at settlement.
  app.post("/internal/v1/external-turns", ownerOnly, express.json({ limit: 16 * 1024, strict: true }), (req, res, next) => {
    try {
      const body = requireFields(req.body, ["sourceId", "channel", "pid", "turnKey", "key", "observation", "tools"]);
      const sourceId = sourceField(body.sourceId);
      const channel = parseExternalChannel(body.channel);
      const key = body.key === undefined ? undefined : parseExternalKey(body.key);
      if (!Number.isSafeInteger(body.pid) || (body.pid as number) <= 0 || typeof body.tools !== "boolean"
        || typeof body.turnKey !== "string" || !/^[A-Za-z0-9._:-]{8,128}$/u.test(body.turnKey)) {
        throw new WebConsoleError("invalid_external_conversation", "Invalid channel turn.", 400);
      }
      if (body.observation !== undefined) {
        const observation = parseExternalObservation(body.observation);
        if (observation.key !== key) throw new WebConsoleError("invalid_external_conversation", "Observation key mismatch.", 400);
        service.observeExternalConversations(sourceId, channel, [observation]);
      }
      const context = key === undefined ? {} : service.externalTurnContext(sourceId, channel, key);
      // Context never depends on tool admission: a refused capability still
      // returns the project context, with the refusal code alone.
      let capability: string | undefined, capabilityError: string | undefined;
      if (body.tools === true) {
        const scope: ExternalConsoleToolScope = { kind: "external", sourceId, channel, ...(key === undefined ? {} : { key }), turnKey: body.turnKey, pid: body.pid as number };
        try {
          service.assertExternalToolScope(scope);
          pruneCapabilities();
          capability = mint(scope, Date.now() + EXTERNAL_CAPABILITY_TTL_MS);
        } catch (error) {
          capabilityError = error instanceof WebConsoleError ? error.code : "console_tool_unavailable";
        }
      }
      res.json({
        conversation: context.conversation === undefined ? null
          : { id: context.conversation.id, label: context.conversation.label, state: context.conversation.state },
        project: context.project ?? null,
        ...(capability === undefined ? {} : { capability }),
        ...(capabilityError === undefined ? {} : { capabilityError }),
      });
    } catch (error) { next(error); }
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
    if (status >= 500) logger?.error?.("Web notification ingress failed.", { error: errorMessage(error) });
    res.status(status).json({
      error: {
        code,
        message: known || syntax ? errorMessage(error) : "Internal server error.",
      },
    });
  });

  const address = await listen(server, 0, INGRESS_HOST, {
    listenFailed: (reason) => new WebConsoleError(
      "notification_ingress_start_failed",
      `Web notification ingress failed to listen: ${reason}`,
      500,
    ),
    noAddress: () => new WebConsoleError(
      "notification_ingress_start_failed",
      "Web notification ingress did not receive a TCP address.",
      500,
    ),
  });
  const url = `http://${INGRESS_HOST}:${address.port}${INGRESS_PATH}`;
  const record: WebNotificationIngressRecord = {
    schema: INGRESS_SCHEMA,
    pid: process.pid,
    instanceId,
    url,
    token,
    updatedAt: new Date().toISOString(),
  };
  try {
    await publishIngressRecord(service.store.paths.notificationIngress, record);
  } catch (error) {
    await close(server);
    throw error;
  }

  return {
    url,
    stop() {
      stopPromise ??= (async () => {
        try {
          capabilities.clear();
          await close(server);
          await Promise.allSettled([...active]);
        } finally {
          await removeOwnIngressRecord(service.store.paths.notificationIngress, instanceId);
        }
      })();
      return stopPromise;
    },
  };
}

type ParsedNotificationRequest = {
  readonly sourceId: string;
  readonly triggerKind: WebThreadNotificationTriggerKind;
  readonly deliveryKey: string;
  readonly text: string;
  readonly jobId?: string;
  readonly runId?: string;
} | {
  readonly sourceId: string;
  readonly triggerKind: "job";
  readonly deliveryKey: string;
  readonly threadId: string;
  readonly processJob: ProcessJobProjection;
  readonly wakePrompt?: string;
  readonly wakeRecovery?: ProcessJobWakeRecovery;
  readonly text?: string;
  readonly parts?: readonly AgentReplyPart[];

};

export function parseNotificationRequest(body: unknown): ParsedNotificationRequest {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new WebConsoleError("invalid_notification", "Notification body must be a JSON object.", 400);
  }
  const record = body as Record<string, unknown>;
  const allowed = record.triggerKind === "job"
    ? new Set(["sourceId", "triggerKind", "deliveryKey", "threadId", "processJob", "wakePrompt", "wakeRecovery", "text", "parts"])
    : new Set(["sourceId", "triggerKind", "deliveryKey", "text", "jobId", "runId"]);
  if (Object.keys(record).some((key) => !allowed.has(key))) {
    throw new WebConsoleError("invalid_notification", "Notification body contains unsupported fields.", 400);
  }
  const sourceId = normalizedField(record.sourceId, "sourceId", 512);
  const deliveryKey = normalizedField(record.deliveryKey, "deliveryKey", 1_024);
  if (record.triggerKind === "job") {
    const threadId = normalizedField(record.threadId, "threadId", 512);
    let processJob: ProcessJobProjection;
    try {
      processJob = parseProcessJobProjection(record.processJob);
    } catch {
      throw new WebConsoleError("invalid_notification", "processJob must be a strict process-job projection.", 400);
    }
    if (record.text !== undefined && (typeof record.text !== "string" || record.text.trim().length === 0)) {
      throw new WebConsoleError("invalid_notification", "text must be a non-empty string when provided.", 400);
    }
    if (typeof record.text === "string" && record.text.length > 8_000) {
      throw new WebConsoleError("invalid_notification", "Process-job response text exceeds its limit.", 413);
    }
    if (record.wakeRecovery !== undefined && (!validProcessJobWakeRecovery(record.wakeRecovery) || record.wakePrompt === undefined)) {
      throw new WebConsoleError("invalid_notification", "Invalid process-job wake recovery proof.", 400);
    }
    if (record.wakePrompt !== undefined
      && (typeof record.wakePrompt !== "string"
        || record.wakePrompt.trim().length === 0
        || record.wakePrompt.length > WEB_MAX_TURN_TEXT_CHARACTERS)) {
      throw new WebConsoleError("invalid_notification", "wakePrompt must contain a bounded process-job wake prompt.", 413);
    }
    const parts = parseReplyParts(record.parts);
    return {
      sourceId,
      triggerKind: "job",
      deliveryKey,
      threadId,
      processJob,
      ...(typeof record.wakePrompt === "string" ? { wakePrompt: record.wakePrompt } : {}),
      ...(record.wakeRecovery === undefined ? {} : { wakeRecovery: record.wakeRecovery as ProcessJobWakeRecovery }),
      ...(typeof record.text === "string" ? { text: record.text } : {}),
      ...(parts === undefined ? {} : { parts }),
    };
  }
  if (record.triggerKind !== "cron" && record.triggerKind !== "webhook") {
    throw new WebConsoleError("invalid_notification", "triggerKind must be 'cron', 'webhook', or 'job'.", 400);
  }
  const jobId = record.jobId === undefined ? undefined : normalizedField(record.jobId, "jobId", 512);
  const runId = record.runId === undefined ? undefined : normalizedField(record.runId, "runId", 1_024);
  if ((jobId === undefined) !== (runId === undefined) || (jobId !== undefined && record.triggerKind !== "cron")) {
    throw new WebConsoleError(
      "invalid_notification",
      "jobId and runId must be supplied together for cron notifications only.",
      400,
    );
  }
  if (typeof record.text !== "string" || record.text.trim().length === 0) {
    throw new WebConsoleError("invalid_notification", "text is required.", 400);
  }
  if (record.text.length > WEB_MAX_TURN_TEXT_CHARACTERS) {
    throw new WebConsoleError("invalid_notification", "Notification text exceeds the web text limit.", 413);
  }
  return {
    sourceId,
    triggerKind: record.triggerKind,
    deliveryKey,
    text: record.text,
    ...(jobId === undefined ? {} : { jobId, runId: runId! }),
  };
}

function parseReplyParts(value: unknown): readonly AgentReplyPart[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new WebConsoleError("invalid_notification", "parts must be an array when provided.", 400);
  }
  if (value.length > MAX_AGENT_REPLY_PARTS) {
    throw new WebConsoleError("invalid_notification", "Process-job reply parts exceed their limit.", 413);
  }
  if (!value.every((part) => {
    if (typeof part !== "object" || part === null || Array.isArray(part)) return false;
    const record = part as Record<string, unknown>;
    return typeof record.type === "string"
      && record.type.length > 0
      && typeof record.id === "string"
      && record.id.length > 0;
  })) {
    throw new WebConsoleError("invalid_notification", "parts must contain reply-part records.", 400);
  }
  return value as readonly AgentReplyPart[];
}

function normalizedField(value: unknown, name: string, maxLength: number): string {
  if (typeof value !== "string") {
    throw new WebConsoleError("invalid_notification", `${name} is required.`, 400);
  }
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maxLength) {
    throw new WebConsoleError(
      "invalid_notification",
      `${name} must contain 1 to ${String(maxLength)} characters.`,
      400,
    );
  }
  return normalized;
}

async function publishIngressRecord(path: string, record: WebNotificationIngressRecord): Promise<void> {
  const temporary = `${path}.${record.instanceId}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
    await chmod(path, 0o600);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function removeOwnIngressRecord(path: string, instanceId: string): Promise<void> {
  const info = await lstat(path).catch(() => undefined);
  if (info === undefined || !info.isFile() || info.isSymbolicLink() || info.size > MAX_INGRESS_RECORD_BYTES) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    return;
  }
  const record = typeof parsed === "object" && parsed !== null ? parsed as Record<string, unknown> : undefined;
  if (record?.instanceId === instanceId) await unlink(path).catch(() => undefined);
}

/** A JSON object whose keys are all allowed; optional fields may be absent. */
function requireFields(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  const record = asRecord(value);
  if (record === undefined || Object.keys(record).some((key) => !allowed.includes(key))) {
    throw new WebConsoleError("invalid_external_conversation", "Invalid request.", 400);
  }
  return record;
}

function sourceField(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) {
    throw new WebConsoleError("invalid_external_conversation", "Invalid sourceId.", 400);
  }
  return value;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
