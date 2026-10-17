import { DEFAULT_REPLY_FILE_STORAGE_MAX_BYTES } from "@mono-agent/config";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readdir,
} from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import {
  CodedError,
  MCP_APP_RESOURCE_MIME_TYPE,
  MCP_APP_SUPPORTED_VERSIONS,
  type AgentMcpAppHostRequest,
  type AgentMcpAppLoadRequest,
  type AgentMcpAppResource,
  type AgentReplyMcpAppPart,
  type AgentReplyPart,
  type AgentReplyPartFailure,
  type AgentResponder,
} from "@mono-agent/contracts";
import type { RuntimeMcpAppConnection, RuntimeMcpAppHost, RuntimeMcpAppRegistration } from "@mono-agent/turn/host/types";

import { mcpAppAuditStorageFor } from "./mcp-apps/audit-storage.js";
import {
  MAX_HTML_BYTES,
  MAX_STATE_BYTES,
  writeAppAtomically,
  readManifest,
  bindDeliveryConversation,
  cleanupStaging,
  readBoundedText,
  readBoundedJson,
  safeToolName,
} from "./mcp-apps/artifact-store.js";
import { APP_ID, isSupportedProtocolVersion, record } from "./mcp-apps/content.js";
import type { McpAppManifest, McpAppState } from "./mcp-apps/types.js";
import type { RuntimeOptionsExtension } from "./runtime-option-extensions.js";
import {
  createReplyPartBudget,
  mergeReplyParts,
  type ReplyPartBudget,
} from "./reply-part-budget.js";
import {
  ReplyArtifactStorageFullError,
  replyArtifactStorageBudgetFor,
  type ReplyArtifactStorageBudget,
  type ReplyArtifactStorageProtection,
} from "./reply-artifacts.js";

const MAX_BRIDGE_REQUEST_BYTES = 64 * 1024;
const MAX_BRIDGE_RESULT_BYTES = 1024 * 1024;
const STATE_JSON_OVERHEAD_BYTES = Buffer.byteLength('{"toolInput":,"toolResult":}\n', "utf8");
const MAX_STATE_VALUE_BYTES = Math.floor((MAX_STATE_BYTES - STATE_JSON_OVERHEAD_BYTES) / 2);
const DEFAULT_RETENTION_DAYS = 30;
const STAGING_NAMESPACE = ".staging";
const DEFAULT_STAGING_GRACE_MS = 10 * 60 * 1000;
const DEFAULT_MAX_RETAINED_CONNECTIONS = 8;
const DEFAULT_CONNECTION_IDLE_MS = 10 * 60 * 1000;
const DEFAULT_BRIDGE_RATE_LIMIT = 60;
const DEFAULT_BRIDGE_RATE_WINDOW_MS = 60 * 1000;
const DEFAULT_AUDIT_MAX_BYTES = 256 * 1024;
const DEFAULT_AUDIT_RETAINED_FILES = 2;
export const DEFAULT_MCP_APP_AUDIT_STORAGE_MAX_BYTES = 1024 * 1024;
const BIDI_CONTROL = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;

interface LiveInvocation {
  readonly connectionId: string;
  readonly appVisibleTools: ReadonlySet<string>;
  readonly appVisibleResources: ReadonlySet<string>;
}

interface RetainedConnection {
  readonly connection: RuntimeMcpAppConnection;
  readonly invocationIds: Set<string>;
  lastUsedAtMs: number;
}

interface McpAppServiceOptions {
  readonly artifactDir: string;
  readonly retentionDays?: number;
  readonly now?: () => Date;
  readonly replyPartBudget?: ReplyPartBudget;
  readonly storageBudget?: ReplyArtifactStorageBudget;
  /** Aggregate rich-reply ceiling, including the separately reserved audit bytes. */
  readonly aggregateStorageMaxBytes?: number | "unlimited";
  readonly maxRetainedConnections?: number;
  readonly connectionIdleMs?: number;
  readonly bridgeRateLimit?: number;
  readonly bridgeRateWindowMs?: number;
  readonly auditMaxBytes?: number;
  readonly auditRetainedFiles?: number;
  /** Independent aggregate reserve for MCP App audit files inside the rich-reply ceiling. */
  readonly auditStorageMaxBytes?: number;
  /** @internal deterministic cleanup/concurrency test seam. */
  readonly stagingGraceMs?: number;
  /** @internal runs after staged files are complete and before directory rename. */
  readonly beforePublicationCommit?: () => void | Promise<void>;
  /** @internal deterministic audit I/O observation and failure-injection seam. */
  readonly beforeAuditStorageOperation?: (
    operation: "append" | "lstat" | "readdir" | "remove" | "rename",
    path: string,
  ) => void | Promise<void>;
}

interface McpAppService {
  readonly createExtension: RuntimeOptionsExtension;
  wrapResponder(responder: AgentResponder): AgentResponder;
  load(request: AgentMcpAppLoadRequest): Promise<AgentMcpAppResource>;
  request(request: AgentMcpAppHostRequest): Promise<unknown>;
  cleanupExpired(): Promise<void>;
  dispose(): Promise<void>;
}

/** Durable MCP Apps registry with live handles scoped to exact MCP connections. */
export function createMcpAppService(options: McpAppServiceOptions): McpAppService {
  const root = resolve(options.artifactDir, "mcp-apps");
  const stagingRoot = join(root, STAGING_NAMESPACE);
  const retentionDays = options.retentionDays ?? DEFAULT_RETENTION_DAYS;
  const stagingGraceMs = options.stagingGraceMs ?? DEFAULT_STAGING_GRACE_MS;
  const maxRetainedConnections = options.maxRetainedConnections ?? DEFAULT_MAX_RETAINED_CONNECTIONS;
  const connectionIdleMs = options.connectionIdleMs ?? DEFAULT_CONNECTION_IDLE_MS;
  const bridgeRateLimit = options.bridgeRateLimit ?? DEFAULT_BRIDGE_RATE_LIMIT;
  const bridgeRateWindowMs = options.bridgeRateWindowMs ?? DEFAULT_BRIDGE_RATE_WINDOW_MS;
  const auditMaxBytes = options.auditMaxBytes ?? DEFAULT_AUDIT_MAX_BYTES;
  const auditRetainedFiles = options.auditRetainedFiles ?? DEFAULT_AUDIT_RETAINED_FILES;
  const auditStorageMaxBytes = options.auditStorageMaxBytes ?? DEFAULT_MCP_APP_AUDIT_STORAGE_MAX_BYTES;
  const now = options.now ?? (() => new Date());
  const budget = options.replyPartBudget ?? createReplyPartBudget();
  const partsByRun = new Map<string, AgentReplyPart[]>();
  const partsByIdentityByRun = new Map<string, Map<string, AgentReplyPart>>();
  const invocationIdsByRun = new Map<string, Set<string>>();
  const invocationProtectionsByRun = new Map<string, Map<string, ReplyArtifactStorageProtection>>();
  const liveByInvocation = new Map<string, LiveInvocation>();
  const connections = new Map<string, RetainedConnection>();
  const auditProtectionCounts = new Map<string, number>();
  const responseContext = new AsyncLocalStorage<{ readonly runIds: Set<string> }>();
  const runOwners = new Map<string, { readonly runIds: Set<string> } | undefined>();
  const bridgeRates = new Map<string, { startedAtMs: number; count: number }>();
  const auditQueues = new Map<string, Promise<void>>();
  const pendingAuditCompletions = new Set<{ complete(): Promise<void>; release(): Promise<void> }>();
  let idleTimer: ReturnType<typeof setTimeout> | undefined;

  if (!Number.isFinite(retentionDays) || retentionDays <= 0) {
    throw new RangeError("MCP App retentionDays must be positive.");
  }
  for (const [name, value] of [
    ["stagingGraceMs", stagingGraceMs],
    ["maxRetainedConnections", maxRetainedConnections],
    ["connectionIdleMs", connectionIdleMs],
    ["bridgeRateLimit", bridgeRateLimit],
    ["bridgeRateWindowMs", bridgeRateWindowMs],
    ["auditRetainedFiles", auditRetainedFiles],
    ["auditStorageMaxBytes", auditStorageMaxBytes],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new RangeError(`MCP App ${name} must be a positive safe integer.`);
    }
  }
  if (!Number.isSafeInteger(auditMaxBytes) || auditMaxBytes < 1_024) {
    throw new RangeError("MCP App auditMaxBytes must be a safe integer of at least 1024.");
  }
  if (auditMaxBytes > Math.floor(auditStorageMaxBytes / (auditRetainedFiles + 1))) {
    throw new RangeError(
      "MCP App auditStorageMaxBytes must hold the active audit file and every retained rotation.",
    );
  }
  const aggregateStorageMaxBytes = options.aggregateStorageMaxBytes ?? DEFAULT_REPLY_FILE_STORAGE_MAX_BYTES;
  if (aggregateStorageMaxBytes !== "unlimited" && (
    !Number.isSafeInteger(aggregateStorageMaxBytes) || aggregateStorageMaxBytes <= auditStorageMaxBytes
  )) {
    throw new RangeError("MCP App auditStorageMaxBytes must be smaller than the aggregate storage ceiling.");
  }
  const contentStorageMaxBytes = aggregateStorageMaxBytes === "unlimited"
    ? "unlimited" : aggregateStorageMaxBytes - auditStorageMaxBytes;
  const storage = options.storageBudget
    ?? replyArtifactStorageBudgetFor(options.artifactDir, contentStorageMaxBytes);
  if (contentStorageMaxBytes !== "unlimited" && (
    storage.maxBytes === "unlimited" || storage.maxBytes > contentStorageMaxBytes
  )) {
    throw new RangeError("MCP App content and audit storage budgets must fit the aggregate storage ceiling.");
  }
  const auditStorage = mcpAppAuditStorageFor(root, {
    maxBytes: auditStorageMaxBytes,
    fileMaxBytes: auditMaxBytes,
    retainedFiles: auditRetainedFiles,
  }, options.beforeAuditStorageOperation, (directory) => {
    const invocationId = basename(directory);
    if (liveByInvocation.has(invocationId) || auditProtectionCounts.has(invocationId)) return true;
    for (const protections of invocationProtectionsByRun.values()) {
      if (protections.has(invocationId)) return true;
    }
    return false;
  });

  const createExtension: RuntimeOptionsExtension = async ({ request, runId }) => {
    await mkdir(stagingRoot, { recursive: true, mode: 0o700 });
    const owner = responseContext.getStore();
    owner?.runIds.add(runId);
    runOwners.set(runId, owner);
    await cleanupExpired().catch(() => undefined);
    const host: RuntimeMcpAppHost = {
      protocolVersions: MCP_APP_SUPPORTED_VERSIONS,
      mimeTypes: [MCP_APP_RESOURCE_MIME_TYPE],
      register: async (registration) => await register(runId, request.conversationId, registration),
      recordFailure: async (failure) => recordFailure(runId, failure),
    };
    return {
      runtimeOptions: { mcpApps: host },
      cleanup: async () => {},
      settleCleanup: async () => {
        if (runOwners.get(runId) === undefined) await discardRun(runId);
      },
    };
  };

  async function register(
    runId: string,
    conversationId: string,
    registration: RuntimeMcpAppRegistration,
  ): Promise<{ readonly part: AgentReplyMcpAppPart | AgentReplyPartFailure; readonly retainConnection: boolean }> {
    const fail = (message: string): { part: AgentReplyPartFailure; retainConnection: false } => {
      const part = recordFailure(runId, {
        serverName: registration.serverName,
        toolName: registration.toolName,
        toolCallId: registration.toolCallId,
        code: "app_resource_invalid",
        message,
      });
      return { part, retainConnection: false };
    };
    if (
      !isSupportedProtocolVersion(registration.protocolVersion)
      || registration.connection.connectionId.length === 0
      || !registration.resourceUri.startsWith("ui://")
    ) {
      return fail("The MCP App registration is incompatible with this host.");
    }
    const resource = appResource(registration.resource, registration.resourceUri);
    if (resource === undefined) return fail("The MCP App resource is invalid or oversized.");
    const identity = stableAppIdentity(registration);
    const claim = budget.claim(runId, identity);
    if (claim === "limit") return { part: capacityFailure(runId), retainConnection: false };
    if (claim === "duplicate") {
      const existing = partsByIdentityByRun.get(runId)?.get(identity);
      return {
        part: existing?.type === "mcp_app" ? existing : capacityFailure(runId),
        retainConnection: false,
      };
    }
    const invocationId = randomUUID();
    const createdAt = now();
    const manifest: McpAppManifest = {
      schema: 1,
      invocationId,
      connectionId: registration.connection.connectionId,
      runId,
      conversationId,
      serverName: registration.serverName,
      toolName: registration.toolName,
      toolCallId: registration.toolCallId,
      resourceUri: registration.resourceUri,
      protocolVersion: registration.protocolVersion as McpAppManifest["protocolVersion"],
      mediaType: MCP_APP_RESOURCE_MIME_TYPE,
      ...(registration.title === undefined ? {} : { title: boundedText(registration.title, 240) }),
      ...(registration.description === undefined ? {} : { description: boundedText(registration.description, 1_000) }),
      appVisibleTools: [...new Set(registration.appVisibleTools.filter(safeToolName))].slice(0, 256),
      appVisibleResources: [registration.resourceUri],
      ...(resource.metadata === undefined ? {} : { resourceMetadata: resource.metadata }),
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + retentionDays * 86_400_000).toISOString(),
    };
    const state: McpAppState = {
      toolInput: boundedJsonValue(registration.toolInput, MAX_STATE_VALUE_BYTES),
      toolResult: boundedJsonValue(registration.toolResult, MAX_STATE_VALUE_BYTES),
    };
    const storageProtection = await storage.protect("mcp-apps", invocationId);
    let persisted = false;
    try {
      await writeAppAtomically(
        root,
        stagingRoot,
        manifest,
        resource.html,
        state,
        storage,
        options.beforePublicationCommit,
      );
      persisted = true;
    } catch (error) {
      budget.unclaim(runId, identity);
      return fail(error instanceof ReplyArtifactStorageFullError
        ? "Reply artifact storage is full; this MCP App was not retained."
        : "The MCP App resource could not be persisted safely.");
    } finally {
      if (!persisted) await storageProtection.release();
    }
    const part = partFromManifest(manifest);
    acceptClaimedPart(runId, identity, part);
    const invocationIds = invocationIdsByRun.get(runId) ?? new Set<string>();
    invocationIds.add(invocationId);
    invocationIdsByRun.set(runId, invocationIds);
    const protections = invocationProtectionsByRun.get(runId)
      ?? new Map<string, ReplyArtifactStorageProtection>();
    protections.set(invocationId, storageProtection);
    invocationProtectionsByRun.set(runId, protections);
    liveByInvocation.set(invocationId, {
      connectionId: registration.connection.connectionId,
      appVisibleTools: new Set(manifest.appVisibleTools),
      appVisibleResources: new Set(manifest.appVisibleResources),
    });
    await retainConnection(invocationId, registration.connection);
    return { part, retainConnection: true };
  }

  function capacityFailure(runId: string): AgentReplyPartFailure {
    return {
      type: "failure",
      id: stablePartId("mcp-app-limit", runId),
      code: "app_capability_mismatch",
      message: "This reply already reached the maximum number of rich parts.",
    };
  }

  function recordFailure(
    runId: string,
    input: {
      readonly serverName: string;
      readonly toolName: string;
      readonly toolCallId: string;
      readonly code: AgentReplyPartFailure["code"];
      readonly message: string;
    },
  ): AgentReplyPartFailure {
    const identity = `mcp-app-failure:${stableDigest(input)}`;
    const part: AgentReplyPartFailure = {
      type: "failure",
      id: stablePartId(`mcp-app-${safeIdSegment(input.toolCallId)}`, identity),
      code: input.code,
      message: boundedText(input.message, 1_000),
    };
    const claim = budget.claim(runId, identity);
    if (claim === "limit") return capacityFailure(runId);
    if (claim === "duplicate") {
      const existing = partsByIdentityByRun.get(runId)?.get(identity);
      return existing?.type === "failure" ? existing : capacityFailure(runId);
    }
    acceptClaimedPart(runId, identity, part);
    return part;
  }

  function acceptClaimedPart(runId: string, identity: string, part: AgentReplyPart): void {
    const current = partsByRun.get(runId) ?? [];
    const byIdentity = partsByIdentityByRun.get(runId) ?? new Map<string, AgentReplyPart>();
    current.push(part);
    byIdentity.set(identity, part);
    partsByRun.set(runId, current);
    partsByIdentityByRun.set(runId, byIdentity);
  }

  function protectAuditInvocation(invocationId: string): () => void {
    auditProtectionCounts.set(invocationId, (auditProtectionCounts.get(invocationId) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const count = auditProtectionCounts.get(invocationId) ?? 0;
      if (count <= 1) auditProtectionCounts.delete(invocationId);
      else auditProtectionCounts.set(invocationId, count - 1);
    };
  }

  async function load(request: AgentMcpAppLoadRequest): Promise<AgentMcpAppResource> {
    const releaseAuditProtection = protectAuditInvocation(request.invocationId);
    let protection: ReplyArtifactStorageProtection | undefined;
    try {
      protection = await storage.protect("mcp-apps", request.invocationId);
      await evictIdleConnections();
      const manifest = await readManifest(root, request.invocationId);
      authorizeApp(manifest, request);
      if (Date.parse(manifest.expiresAt) <= now().getTime()) {
        throw new CodedError("app_expired", "The MCP App has expired.");
      }
      const directory = join(root, manifest.invocationId);
      const [html, state] = await Promise.all([
        readBoundedText(join(directory, "resource.html"), MAX_HTML_BYTES),
        readBoundedJson<McpAppState>(join(directory, "state.json"), MAX_STATE_BYTES),
      ]);
      const live = liveByInvocation.get(manifest.invocationId);
      const retained = live === undefined ? undefined : connections.get(live.connectionId);
      const connected = retained?.connection.connectionId === manifest.connectionId;
      if (connected) touchConnection(manifest.connectionId);
      return {
        app: partFromManifest(manifest),
        html,
        toolInput: state.toolInput,
        toolResult: state.toolResult,
        ...(manifest.resourceMetadata === undefined ? {} : { resourceMetadata: manifest.resourceMetadata }),
        connected,
      };
    } finally {
      await protection?.release();
      releaseAuditProtection();
    }
  }

  async function request(input: AgentMcpAppHostRequest): Promise<unknown> {
    const releaseAuditProtection = protectAuditInvocation(input.invocationId);
    let protection: ReplyArtifactStorageProtection | undefined;
    try {
      protection = await storage.protect("mcp-apps", input.invocationId);
      await evictIdleConnections();
      const manifest = await readManifest(root, input.invocationId);
      authorizeApp(manifest, input);
      if (Date.parse(manifest.expiresAt) <= now().getTime()) {
        throw new CodedError("app_expired", "The MCP App has expired.");
      }
      if (serializedBytes(input.params) > MAX_BRIDGE_REQUEST_BYTES) {
        throw new CodedError("app_request_too_large", "The MCP App bridge request is too large.");
      }
      const live = liveByInvocation.get(manifest.invocationId);
      const retained = live === undefined ? undefined : connections.get(live.connectionId);
      if (
        live === undefined
        || retained === undefined
        || retained.connection.connectionId !== manifest.connectionId
      ) {
        throw new CodedError("app_connection_closed", "The originating MCP connection is no longer available.");
      }
      consumeBridgeRate(manifest.connectionId);
      touchConnection(manifest.connectionId);
      if (input.method === "tools/call") {
        requireConfirmation(input);
        const params = record(input.params);
        const name = typeof params?.name === "string" ? params.name : undefined;
        if (name === undefined || !live.appVisibleTools.has(name)) {
          throw new CodedError("app_tool_forbidden", "The MCP App requested a tool that is not visible to apps.");
        }
        const completionAudit = await reserveAuditCompletion(manifest, input.method);
        let result: unknown;
        try {
          result = await retained.connection.callTool(name, params?.arguments ?? {});
        } catch {
          await completionAudit.release().catch(() => undefined);
          await closeConnection(manifest.connectionId);
          throw new CodedError("app_connection_closed", "The originating MCP connection closed during the tool call.");
        }
        touchConnection(manifest.connectionId);
        try {
          await completionAudit.complete();
        } catch {
          throw new CodedError(
            "app_audit_incomplete",
            "The MCP App tool ran, but completion could not be recorded safely; do not retry automatically.",
          );
        }
        return boundedJsonValue(result, MAX_BRIDGE_RESULT_BYTES);
      }
      if (input.method === "resources/read") {
        const params = record(input.params);
        const uri = typeof params?.uri === "string" ? params.uri : undefined;
        if (uri === undefined || Buffer.byteLength(uri, "utf8") > 4_096) {
          throw new CodedError("app_resource_invalid", "The MCP App requested an invalid resource URI.");
        }
        if (!live.appVisibleResources.has(uri)) {
          throw new CodedError(
            "app_resource_forbidden",
            "The MCP App requested a resource that was not declared for this app invocation.",
          );
        }
        await appendAudit(manifest, input.method, "requested");
        try {
          const result = await retained.connection.readResource(uri);
          touchConnection(manifest.connectionId);
          return boundedJsonValue(result, MAX_BRIDGE_RESULT_BYTES);
        } catch {
          await closeConnection(manifest.connectionId);
          throw new CodedError("app_connection_closed", "The originating MCP connection closed during resource access.");
        }
      }
      if (input.method === "ui/open-link") {
        requireConfirmation(input);
        const params = record(input.params);
        const url = typeof params?.url === "string" ? safeExternalUrl(params.url) : undefined;
        if (url === undefined) throw new CodedError("app_open_link_forbidden", "Only HTTP(S) links can be opened.");
        await appendAudit(manifest, input.method, "confirmed");
        return { allowed: true, url };
      }
      requireConfirmation(input);
      await appendAudit(manifest, input.method, "rejected");
      return {
        accepted: false,
        reason: "Model-context updates require a new user-authorized turn and are not applied to a completed run.",
      };
    } finally {
      await protection?.release();
      releaseAuditProtection();
    }
  }

  async function cleanupExpired(): Promise<void> {
    await storage.runExclusive(async (isProtected) => {
      let entries: string[];
      try {
        entries = await readdir(root);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      const cutoff = now().getTime();
      for (const entry of entries.filter((value) => APP_ID.test(value))) {
        if (isProtected("mcp-apps", entry)) continue;
        try {
          const manifest = await readManifest(root, entry);
          if (Date.parse(manifest.expiresAt) > cutoff) continue;
        } catch {}
        await dropInvocation(entry);
        await auditStorage.remove(join(root, entry)).catch(() => undefined);
      }
      await cleanupStaging(
        stagingRoot,
        cutoff - stagingGraceMs,
        (id) => isProtected("mcp-apps", id),
      );
    });
    await evictIdleConnections();
  }

  async function closeConnection(connectionId: string): Promise<void> {
    const retained = connections.get(connectionId);
    connections.delete(connectionId);
    bridgeRates.delete(connectionId);
    for (const [invocationId, live] of liveByInvocation) {
      if (live.connectionId === connectionId) liveByInvocation.delete(invocationId);
    }
    await retained?.connection.close().catch(() => undefined);
    scheduleIdleEviction();
  }

  async function dropInvocation(invocationId: string): Promise<void> {
    const live = liveByInvocation.get(invocationId);
    liveByInvocation.delete(invocationId);
    auditQueues.delete(invocationId);
    if (live === undefined) return;
    const retained = connections.get(live.connectionId);
    retained?.invocationIds.delete(invocationId);
    if (retained?.invocationIds.size === 0) await closeConnection(live.connectionId);
  }

  async function retainConnection(
    invocationId: string,
    connection: RuntimeMcpAppConnection,
  ): Promise<void> {
    await evictIdleConnections();
    const retained = connections.get(connection.connectionId) ?? {
      connection,
      invocationIds: new Set<string>(),
      lastUsedAtMs: now().getTime(),
    };
    retained.invocationIds.add(invocationId);
    retained.lastUsedAtMs = now().getTime();
    connections.delete(connection.connectionId);
    connections.set(connection.connectionId, retained);
    while (connections.size > maxRetainedConnections) {
      const oldest = connections.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      await closeConnection(oldest);
    }
    scheduleIdleEviction();
  }

  function touchConnection(connectionId: string): void {
    const retained = connections.get(connectionId);
    if (retained === undefined) return;
    retained.lastUsedAtMs = now().getTime();
    connections.delete(connectionId);
    connections.set(connectionId, retained);
    scheduleIdleEviction();
  }

  async function evictIdleConnections(): Promise<void> {
    const cutoff = now().getTime() - connectionIdleMs;
    const idle = [...connections]
      .filter(([, retained]) => retained.lastUsedAtMs <= cutoff)
      .map(([connectionId]) => connectionId);
    await Promise.allSettled(idle.map(async (connectionId) => await closeConnection(connectionId)));
    scheduleIdleEviction();
  }

  function scheduleIdleEviction(): void {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    idleTimer = undefined;
    if (connections.size === 0) return;
    const nextExpiry = Math.min(...[...connections.values()]
      .map((retained) => retained.lastUsedAtMs + connectionIdleMs));
    const delay = Math.max(1, Math.min(2_147_483_647, nextExpiry - now().getTime()));
    idleTimer = setTimeout(() => {
      idleTimer = undefined;
      void evictIdleConnections();
    }, delay);
    idleTimer.unref?.();
  }

  function consumeBridgeRate(connectionId: string): void {
    const at = now().getTime();
    const current = bridgeRates.get(connectionId);
    const bucket = current === undefined || at - current.startedAtMs >= bridgeRateWindowMs
      ? { startedAtMs: at, count: 0 }
      : current;
    if (bucket.count >= bridgeRateLimit) {
      throw new CodedError("app_rate_limited", "The MCP App bridge request rate limit was exceeded.");
    }
    bucket.count += 1;
    bridgeRates.set(connectionId, bucket);
  }

  async function appendAudit(
    manifest: McpAppManifest,
    method: string,
    phase: "confirmed" | "completed" | "requested" | "rejected",
  ): Promise<void> {
    const line = mcpAppAuditLine(manifest, method, phase);
    await enqueueAudit(manifest.invocationId, async () => {
      await auditStorage.append(join(root, manifest.invocationId), line);
    });
  }

  async function reserveAuditCompletion(
    manifest: McpAppManifest,
    method: string,
  ): Promise<{ complete(): Promise<void>; release(): Promise<void> }> {
    const confirmedLine = mcpAppAuditLine(manifest, method, "confirmed");
    const completionBytes = Buffer.byteLength(mcpAppAuditLine(manifest, method, "completed"), "utf8");
    const storageReservation = await enqueueAudit(manifest.invocationId, async () => (
      await auditStorage.reserveAppend(
        join(root, manifest.invocationId),
        confirmedLine,
        completionBytes,
      )
    ));
    let settled = false;
    let reservation!: { complete(): Promise<void>; release(): Promise<void> };
    reservation = {
      complete: async () => {
        if (settled) throw new Error("MCP App audit completion was already settled.");
        settled = true;
        try {
          const line = mcpAppAuditLine(manifest, method, "completed");
          await enqueueAudit(manifest.invocationId, async () => await storageReservation.append(line));
        } catch (error) {
          await storageReservation.release().catch(() => undefined);
          throw error;
        } finally {
          pendingAuditCompletions.delete(reservation);
        }
      },
      release: async () => {
        if (settled) return;
        settled = true;
        try {
          await storageReservation.release();
        } finally {
          pendingAuditCompletions.delete(reservation);
        }
      },
    };
    pendingAuditCompletions.add(reservation);
    return reservation;
  }

  function mcpAppAuditLine(
    manifest: McpAppManifest,
    method: string,
    phase: "confirmed" | "completed" | "requested" | "rejected",
  ): string {
    const line = `${JSON.stringify({
      at: now().toISOString(),
      invocationId: manifest.invocationId,
      connectionId: manifest.connectionId,
      method,
      details: { phase },
    })}\n`;
    if (Buffer.byteLength(line, "utf8") > auditMaxBytes) {
      throw new Error("MCP App audit entry exceeded its configured file ceiling.");
    }
    return line;
  }

  async function enqueueAudit<T>(invocationId: string, operation: () => Promise<T>): Promise<T> {
    const previous = auditQueues.get(invocationId) ?? Promise.resolve();
    let result!: T;
    const next = previous.catch(() => undefined).then(async () => {
      result = await operation();
    });
    auditQueues.set(invocationId, next);
    try {
      await next;
      return result;
    } catch {
      throw new CodedError("app_audit_failed", "The MCP App action could not be recorded safely.");
    } finally {
      if (auditQueues.get(invocationId) === next) auditQueues.delete(invocationId);
    }
  }

  async function dispose(): Promise<void> {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    idleTimer = undefined;
    await Promise.allSettled([...pendingAuditCompletions].map(async (reservation) => {
      await reservation.release();
    }));
    await Promise.allSettled([...connections.keys()].map(async (id) => await closeConnection(id)));
    await Promise.allSettled([...invocationProtectionsByRun.values()].flatMap((protections) => (
      [...protections.values()].map(async (protection) => await protection.release())
    )));
    liveByInvocation.clear();
    partsByRun.clear();
    partsByIdentityByRun.clear();
    invocationIdsByRun.clear();
    invocationProtectionsByRun.clear();
    auditProtectionCounts.clear();
    runOwners.clear();
    bridgeRates.clear();
    auditQueues.clear();
    pendingAuditCompletions.clear();
    auditStorage.dispose();
  }

  function wrapResponder(responder: AgentResponder): AgentResponder {
    const originalDispose = (responder as AgentResponder & { dispose?: () => Promise<void> }).dispose;
    return {
      ...responder,
      ...(responder.importContext === undefined
        ? {}
        : { importContext: responder.importContext.bind(responder) }),
      async respond(request, stream) {
        const context = { runIds: new Set<string>() };
        let retainedRunId: string | undefined;
        try {
          const response = await responseContext.run(
            context,
            async () => await responder.respond(request, stream),
          );
          const runId = typeof response.metadata?.runId === "string" ? response.metadata.runId : undefined;
          if (runId === undefined || (context.runIds.size > 0 && !context.runIds.has(runId))) return response;
          const parts = partsByRun.get(runId) ?? [];
          if (parts.length === 0) {
            await retainRun(runId);
            retainedRunId = runId;
            return response;
          }
          const finalized = await finalizeDeliveryParts(runId, parts, request.conversationId);
          const merged = mergeReplyParts(response.parts, finalized);
          await retainRun(runId);
          retainedRunId = runId;
          return { ...response, parts: merged,
            ...(response.metadata?.turnDisposition === "silent"
              ? { metadata: { ...response.metadata, turnDisposition: "visible" } } : {}) };
        } finally {
          await Promise.all([...context.runIds]
            .filter((runId) => runId !== retainedRunId)
            .map(async (runId) => await discardRun(runId)));
        }
      },
      loadMcpApp: load,
      requestMcpApp: request,
      ...(responder.openReplyArtifact === undefined
        ? {}
        : { openReplyArtifact: responder.openReplyArtifact.bind(responder) }),
      async dispose() {
        await Promise.allSettled([
          ...(originalDispose === undefined ? [] : [originalDispose.call(responder)]),
          dispose(),
        ]);
      },
    } as AgentResponder;
  }

  async function retainRun(runId: string): Promise<void> {
    const protections = [...(invocationProtectionsByRun.get(runId)?.values() ?? [])];
    partsByRun.delete(runId);
    partsByIdentityByRun.delete(runId);
    invocationIdsByRun.delete(runId);
    invocationProtectionsByRun.delete(runId);
    runOwners.delete(runId);
    budget.release(runId);
    await Promise.all(protections.map(async (protection) => await protection.release()));
  }

  async function finalizeDeliveryParts(
    runId: string,
    parts: readonly AgentReplyPart[],
    conversationId: string,
  ): Promise<readonly AgentReplyPart[]> {
    const finalized: AgentReplyPart[] = [];
    for (const part of parts) {
      if (part.type !== "mcp_app") {
        finalized.push(part);
        continue;
      }
      const protection = await storage.protect("mcp-apps", part.invocationId);
      try {
        await bindDeliveryConversation(root, part, conversationId, storage);
        finalized.push(part);
      } catch {
        const failure = replaceAppWithDeliveryFailure(runId, part);
        invocationIdsByRun.get(runId)?.delete(part.invocationId);
        await dropInvocation(part.invocationId);
        await auditStorage.remove(join(root, part.invocationId)).catch(() => undefined);
        finalized.push(failure);
      } finally {
        await protection.release();
      }
    }
    return finalized;
  }

  function replaceAppWithDeliveryFailure(
    runId: string,
    part: AgentReplyMcpAppPart,
  ): AgentReplyPartFailure {
    const failureIdentity = `mcp-app-delivery-failure:${part.invocationId}`;
    const failure: AgentReplyPartFailure = {
      type: "failure",
      id: stablePartId("mcp-app-delivery-failure", failureIdentity),
      code: "app_resource_invalid",
      message: "The MCP App could not be finalized for delivery.",
      relatedPartId: part.id,
    };
    const byIdentity = partsByIdentityByRun.get(runId) ?? new Map<string, AgentReplyPart>();
    const oldIdentity = [...byIdentity].find(([, current]) => current === part)?.[0];
    if (oldIdentity !== undefined) {
      byIdentity.delete(oldIdentity);
      budget.unclaim(runId, oldIdentity);
    }
    if (budget.claim(runId, failureIdentity) === "accepted") byIdentity.set(failureIdentity, failure);
    const current = partsByRun.get(runId) ?? [];
    const index = current.indexOf(part);
    if (index >= 0) current[index] = failure;
    partsByRun.set(runId, current);
    partsByIdentityByRun.set(runId, byIdentity);
    return failure;
  }

  async function discardRun(runId: string): Promise<void> {
    const invocationIds = [...(invocationIdsByRun.get(runId) ?? [])];
    await retainRun(runId);
    await Promise.all(invocationIds.map(async (invocationId) => {
      await dropInvocation(invocationId);
      await auditStorage.remove(join(root, invocationId)).catch(() => undefined);
    }));
  }

  return { createExtension, wrapResponder, load, request, cleanupExpired, dispose };
}

function appResource(
  value: unknown,
  expectedUri: string,
): { html: string; metadata?: Readonly<Record<string, unknown>> } | undefined {
  const resource = record(value);
  if (
    resource?.uri !== expectedUri
    || resource.mimeType !== MCP_APP_RESOURCE_MIME_TYPE
    || typeof resource.text !== "string"
    || Buffer.byteLength(resource.text, "utf8") > MAX_HTML_BYTES
  ) return undefined;
  const metadata = record(resource._meta);
  return {
    html: resource.text,
    ...(metadata === undefined ? {} : { metadata: boundedJsonValue(metadata, 32 * 1024) as Record<string, unknown> }),
  };
}

function partFromManifest(manifest: McpAppManifest): AgentReplyMcpAppPart {
  return {
    type: "mcp_app",
    id: manifest.invocationId,
    invocationId: manifest.invocationId,
    connectionId: manifest.connectionId,
    serverName: manifest.serverName,
    toolName: manifest.toolName,
    resourceUri: manifest.resourceUri,
    mediaType: manifest.mediaType,
    protocolVersion: manifest.protocolVersion,
    ...(manifest.title === undefined ? {} : { title: manifest.title }),
    ...(manifest.description === undefined ? {} : { description: manifest.description }),
    expiresAt: manifest.expiresAt,
  };
}

function authorizeApp(manifest: McpAppManifest, request: AgentMcpAppLoadRequest): void {
  if (
    request.connectionId !== manifest.connectionId
    || (request.conversationId !== manifest.conversationId
      && request.conversationId !== manifest.deliveryConversationId)
  ) {
    throw new CodedError("app_forbidden", "The MCP App does not belong to this conversation or connection.");
  }
}

function requireConfirmation(input: AgentMcpAppHostRequest): void {
  if (input.confirmed !== true) throw new CodedError("app_confirmation_required", "This MCP App action requires confirmation.");
}

function safeExternalUrl(input: string): string | undefined {
  if (Buffer.byteLength(input, "utf8") > 8_192) return undefined;
  try {
    const url = new URL(input);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function stableAppIdentity(registration: RuntimeMcpAppRegistration): string {
  return `mcp_app:${stableDigest({
    serverName: registration.serverName,
    toolName: registration.toolName,
    toolCallId: registration.toolCallId,
    resourceUri: registration.resourceUri,
  })}`;
}

function stableDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value) ?? "null").digest("hex");
}

function safeIdSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/gu, "_").slice(0, 80) || "failure";
}

function stablePartId(prefix: string, identity: string): string {
  return `${prefix.slice(0, 120)}-${stableDigest(identity).slice(0, 24)}`;
}

function boundedText(value: string, maxBytes: number): string {
  const text = wellFormed(value).normalize("NFC")
    .replace(BIDI_CONTROL, "")
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .trim();
  let bounded = "";
  let bytes = 0;
  for (const codePoint of text) {
    const codePointBytes = Buffer.byteLength(codePoint, "utf8");
    if (bytes + codePointBytes > maxBytes) break;
    bounded += codePoint;
    bytes += codePointBytes;
  }
  return bounded;
}

function wellFormed(input: string): string {
  let output = "";
  for (const codePoint of input) {
    const unit = codePoint.charCodeAt(0);
    output += codePoint.length === 1 && unit >= 0xd800 && unit <= 0xdfff ? "\ufffd" : codePoint;
  }
  return output;
}

function serializedBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? "null", "utf8");
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function boundedJsonValue(value: unknown, maxBytes: number): unknown {
  try {
    const serialized = JSON.stringify(value) ?? "null";
    if (Buffer.byteLength(serialized, "utf8") <= maxBytes) return JSON.parse(serialized) as unknown;
  } catch {
    // Fall through to a deterministic omission marker.
  }
  return { truncated: true, reason: "value exceeded the MCP App host limit" };
}
