import { createHash, randomUUID } from "node:crypto";
import {
  close as closeFd,
  constants,
  fstat,
  openSync,
  read as readFd,
  type Dirent,
  type Stats,
} from "node:fs";
import {
  lstat,
  open as openFile,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  CodedError,
  DEFAULT_AGENT_ATTACHMENT_MAX_BYTES,
  type AgentReplyArtifactOpenRequest,
  type AgentReplyArtifactStream,
  type AgentReplyAttachmentPart,
  type AgentReplyPart,
  type AgentReplyPartFailure,
  type AgentResponder,
} from "@mono-agent/agent-contracts";
import type { ToolPolicyInput } from "@mono-agent/agent-harness";
import * as z from "zod/v4";

import type { RuntimeOptionsExtension } from "./runtime-option-extensions.js";
import { agentArtifactDerivedRoots } from "./agent-artifact-paths.js";
import {
  createReplyPartBudget,
  mergeReplyParts,
  type ReplyPartBudget,
} from "./reply-part-budget.js";

const PRIVATE_CAPABILITY_URL = Symbol.for("@mono-agent/private-capability-url");

export const REPLY_ARTIFACT_MCP_SERVER_NAME = "mono-agent-reply-artifacts";
export const PUBLISH_REPLY_FILE_TOOL_NAME = "PublishReplyFile";

const PUBLISH_REPLY_FILE_ALIASES = [
  PUBLISH_REPLY_FILE_TOOL_NAME,
  "publish_reply_file",
  `mcp__${REPLY_ARTIFACT_MCP_SERVER_NAME}__${PUBLISH_REPLY_FILE_TOOL_NAME}`,
  `mcp__${REPLY_ARTIFACT_MCP_SERVER_NAME}__*`,
] as const;
const ARTIFACT_ID = /^[0-9a-f]{8}-[0-9a-f-]{27,35}$/u;
const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/u;
const MAX_DISPLAY_NAME_BYTES = 240;
const MAX_MANIFEST_BYTES = 16 * 1024;
const DEFAULT_RETENTION_DAYS = 30;
const READ_CHUNK_BYTES = 64 * 1024;
const STAGING_NAMESPACE = ".staging";
const DEFAULT_STAGING_GRACE_MS = 10 * 60 * 1000;
export const DEFAULT_REPLY_ARTIFACT_STORAGE_MAX_BYTES = 256 * 1024 * 1024;
const REPLY_ARTIFACT_STORAGE_NAMESPACES = ["reply-files", "mcp-apps"] as const;
const BIDI_CONTROL = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;
const DEFAULT_IGNORABLE = /\p{Default_Ignorable_Code_Point}/gu;
const SENSITIVE_FILE_EXTENSIONS = [
  ".cer",
  ".crt",
  ".csr",
  ".db",
  ".db-journal",
  ".db-shm",
  ".db-wal",
  ".der",
  ".dirty.json",
  ".env",
  ".history.json",
  ".jks",
  ".kdb",
  ".kdbx",
  ".key",
  ".keystore",
  ".mobileprovision",
  ".ovpn",
  ".p12",
  ".p8",
  ".pem",
  ".pfx",
  ".pkcs12",
  ".pkcs8",
  ".ppk",
  ".sqlite",
  ".sqlite-journal",
  ".sqlite-shm",
  ".sqlite-wal",
  ".sqlite3",
  ".sqlite3-journal",
  ".sqlite3-shm",
  ".sqlite3-wal",
] as const;
const SENSITIVE_NAME_SEGMENTS = new Set([
  "apikey",
  "auth",
  "authorization",
  "cert",
  "certificate",
  "certificates",
  "credential",
  "credentials",
  "keystore",
  "keyring",
  "oauth",
  "oauth1",
  "oauth2",
  "secret",
  "secrets",
  "token",
  "tokens",
  "truststore",
]);
// Darwin's O_NOFOLLOW_ANY rejects symlinks in every path component. Node does
// not currently expose the constant, so use the stable fcntl.h value only on
// Darwin and retain post-open identity verification everywhere else.
const DARWIN_O_NOFOLLOW_ANY = 0x20000000;

const PUBLISH_INPUT = z.object({
  path: z.string().min(1),
  name: z.string().optional(),
  mediaType: z.string().optional(),
}).strict();

type PublishInput = z.infer<typeof PUBLISH_INPUT>;
type ReplyArtifactPolicy = Pick<ToolPolicyInput, "allowedTools" | "disallowedTools">;

interface ReplyArtifactManifest {
  readonly schema: 1;
  readonly id: string;
  readonly runId: string;
  readonly conversationId: string;
  readonly deliveryConversationId?: string;
  readonly name: string;
  readonly mediaType: string;
  readonly sizeBytes: number;
  readonly integrityId: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface ReplyArtifactServiceOptions {
  readonly artifactDir: string;
  readonly workspace: string;
  /** Resolved state, memory, credential, config, and other private roots. */
  readonly privateRoots?: readonly string[];
  readonly retentionDays?: number;
  readonly maxFileBytes?: number;
  readonly now?: () => Date;
  /** Shared with other reply-part producers in the app composition root. */
  readonly replyPartBudget?: ReplyPartBudget;
  /** Shared aggregate durable-storage admission across rich-part producers. */
  readonly storageBudget?: ReplyArtifactStorageBudget;
  /** @internal deterministic cleanup/concurrency test seam. */
  readonly stagingGraceMs?: number;
  /** @internal runs after canonicalization and before the source fd is opened. */
  readonly beforeSourceOpen?: () => void | Promise<void>;
  /** @internal runs after all staged files are durable and before directory rename. */
  readonly beforePublicationCommit?: () => void | Promise<void>;
}

export interface ReplyArtifactService {
  readonly createExtension: RuntimeOptionsExtension;
  wrapResponder(responder: AgentResponder): AgentResponder;
  open(request: AgentReplyArtifactOpenRequest): Promise<AgentReplyArtifactStream>;
  cleanupExpired(): Promise<void>;
}

type ReplyArtifactStorageNamespace = (typeof REPLY_ARTIFACT_STORAGE_NAMESPACES)[number];

export interface ReplyArtifactStorageReservation {
  release(): Promise<void>;
}

export interface ReplyArtifactStorageProtection {
  release(): Promise<void>;
}

export interface ReplyArtifactStorageBudget {
  readonly maxBytes: number;
  reserve(maximumBytes: number): Promise<ReplyArtifactStorageReservation | undefined>;
  protect(namespace: ReplyArtifactStorageNamespace, id: string): Promise<ReplyArtifactStorageProtection>;
  runExclusive<T>(
    operation: (isProtected: (namespace: ReplyArtifactStorageNamespace, id: string) => boolean) => Promise<T>,
  ): Promise<T>;
}

interface ReplyArtifactStorageState {
  readonly artifactDir: string;
  readonly maxBytes: number;
  readonly protections: Map<string, number>;
  reservedBytes: number;
  gate: Promise<void>;
}

const replyArtifactStorageStates = new Map<string, ReplyArtifactStorageState>();

/**
 * One process-wide coordinator per artifact root. Every admission re-inventories
 * both durable rich-reply namespaces, so a fresh process accounts for content
 * left by a previous one before accepting any new bytes.
 */
export function replyArtifactStorageBudgetFor(
  artifactDir: string,
  maxBytes = DEFAULT_REPLY_ARTIFACT_STORAGE_MAX_BYTES,
): ReplyArtifactStorageBudget {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new RangeError("reply artifact storage maxBytes must be a positive safe integer.");
  }
  const canonicalArtifactDir = resolve(artifactDir);
  const stateKey = `${canonicalArtifactDir}\0${String(maxBytes)}`;
  const state = replyArtifactStorageStates.get(stateKey) ?? {
    artifactDir: canonicalArtifactDir,
    maxBytes,
    protections: new Map<string, number>(),
    reservedBytes: 0,
    gate: Promise.resolve(),
  };
  replyArtifactStorageStates.set(stateKey, state);
  return {
    maxBytes,
    async reserve(maximumBytes) {
      if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) {
        throw new RangeError("reply artifact storage reservation must be a non-negative safe integer.");
      }
      return await runStorageExclusive(state, async () => {
        const storedBytes = await inventoryReplyArtifactBytes(state.artifactDir);
        if (
          maximumBytes > state.maxBytes
          || storedBytes > state.maxBytes - state.reservedBytes - maximumBytes
        ) return undefined;
        state.reservedBytes += maximumBytes;
        let released = false;
        return {
          release: async () => {
            if (released) return;
            released = true;
            await runStorageExclusive(state, async () => {
              state.reservedBytes = Math.max(0, state.reservedBytes - maximumBytes);
            });
          },
        };
      });
    },
    async protect(namespace, id) {
      const key = storageProtectionKey(namespace, id);
      await runStorageExclusive(state, async () => {
        state.protections.set(key, (state.protections.get(key) ?? 0) + 1);
      });
      let released = false;
      return {
        release: async () => {
          if (released) return;
          released = true;
          await runStorageExclusive(state, async () => {
            const count = state.protections.get(key) ?? 0;
            if (count <= 1) state.protections.delete(key);
            else state.protections.set(key, count - 1);
          });
        },
      };
    },
    async runExclusive(operation) {
      return await runStorageExclusive(state, async () => await operation(
        (namespace, id) => state.protections.has(storageProtectionKey(namespace, id)),
      ));
    },
  };
}

export class ReplyArtifactStorageFullError extends Error {
  constructor() {
    super("The aggregate reply artifact storage ceiling was reached.");
    this.name = "ReplyArtifactStorageFullError";
  }
}

/** Resolve the same policy aliases accepted by other app-owned MCP tools. */
export function isPublishReplyFileToolAllowed(policy: ReplyArtifactPolicy | undefined): boolean {
  const allowed = policy?.allowedTools ?? [];
  const denied = policy?.disallowedTools ?? [];
  if (denied.includes("*") || PUBLISH_REPLY_FILE_ALIASES.some((name) => denied.includes(name))) return false;
  return allowed.includes("*") || PUBLISH_REPLY_FILE_ALIASES.some((name) => allowed.includes(name));
}

/**
 * Durable generated-file publisher. Its normal reply surface contains only
 * metadata and opaque ids; bytes stay below the private artifact root.
 */
export function createReplyArtifactService(options: ReplyArtifactServiceOptions): ReplyArtifactService {
  const artifactDir = resolve(options.artifactDir);
  const root = resolve(artifactDir, "reply-files");
  const stagingRoot = join(root, STAGING_NAMESPACE);
  const workspace = resolve(options.workspace);
  const outboundRoot = agentArtifactDerivedRoots(artifactDir).outbound;
  const privateRoots = [
    artifactDir,
    resolve(workspace, ".mono-agent"),
    ...(options.privateRoots ?? []).map((path) => resolve(path)),
  ];
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_AGENT_ATTACHMENT_MAX_BYTES;
  const retentionDays = options.retentionDays ?? DEFAULT_RETENTION_DAYS;
  const stagingGraceMs = options.stagingGraceMs ?? DEFAULT_STAGING_GRACE_MS;
  const now = options.now ?? (() => new Date());
  const budget = options.replyPartBudget ?? createReplyPartBudget();
  const storage = options.storageBudget ?? replyArtifactStorageBudgetFor(artifactDir);
  const partsByRun = new Map<string, AgentReplyPart[]>();
  const partsByIdentityByRun = new Map<string, Map<string, AgentReplyPart>>();
  const artifactIdsByRun = new Map<string, Set<string>>();
  const artifactProtectionsByRun = new Map<string, Map<string, ReplyArtifactStorageProtection>>();
  const responseContext = new AsyncLocalStorage<{ readonly runIds: Set<string> }>();
  const runOwners = new Map<string, { readonly runIds: Set<string> } | undefined>();

  if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes < 1) {
    throw new RangeError("reply artifact maxFileBytes must be a positive safe integer.");
  }
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) {
    throw new RangeError("reply artifact retentionDays must be positive.");
  }
  if (!Number.isSafeInteger(stagingGraceMs) || stagingGraceMs < 1) {
    throw new RangeError("reply artifact stagingGraceMs must be a positive safe integer.");
  }

  const capacityFailure = (runId: string): AgentReplyPartFailure => ({
    type: "failure",
    id: stablePartId("reply-files-limit", runId),
    code: "artifact_publish_failed",
    message: "This reply already reached the maximum number of rich parts.",
  });

  const recordPart = (
    runId: string,
    identity: string,
    part: AgentReplyPart,
  ): { readonly part: AgentReplyPart; readonly accepted: boolean } => {
    const claim = budget.claim(runId, identity);
    if (claim === "limit") return { part: capacityFailure(runId), accepted: false };
    const byIdentity = partsByIdentityByRun.get(runId) ?? new Map<string, AgentReplyPart>();
    if (claim === "duplicate") {
      return { part: byIdentity.get(identity) ?? capacityFailure(runId), accepted: false };
    }
    const current = partsByRun.get(runId) ?? [];
    current.push(part);
    byIdentity.set(identity, part);
    partsByRun.set(runId, current);
    partsByIdentityByRun.set(runId, byIdentity);
    return { part, accepted: true };
  };

  const publish = async (binding: {
    readonly runId: string;
    readonly conversationId: string;
  }, input: PublishInput): Promise<AgentReplyAttachmentPart | AgentReplyPartFailure> => {
    let claimedIdentity: string | undefined;
    try {
      const source = await openAuthorizedSource(
        input.path,
        workspace,
        runOutboundRoot(outboundRoot, binding.runId),
        privateRoots,
        options.beforeSourceOpen,
      );
      try {
        const sourceStat = await source.stat();
        if (!sourceStat.isFile()) throw new CodedError("artifact_publish_failed", "Only regular files can be published.");
        if (sourceStat.size > maxFileBytes) {
          throw new CodedError("artifact_too_large", `Generated files may not exceed ${maxFileBytes} bytes.`);
        }
        const storageReservation = await storage.reserve(sourceStat.size + MAX_MANIFEST_BYTES);
        if (storageReservation === undefined) throw new ReplyArtifactStorageFullError();
        const id = randomUUID();
        const directory = join(root, id);
        const stagingDirectory = join(stagingRoot, id);
        const contentPath = join(stagingDirectory, "content");
        const storageProtection = await storage.protect("reply-files", id);
        let published = false;
        try {
          await mkdir(stagingRoot, { recursive: true, mode: 0o700 });
          await mkdir(stagingDirectory, { recursive: false, mode: 0o700 });
          const target = await openFile(contentPath, "wx", 0o600);
          const hash = createHash("sha256");
          let copied = 0;
          try {
            const buffer = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, maxFileBytes));
            for (;;) {
              const { bytesRead } = await source.read(buffer, 0, buffer.byteLength, copied);
              if (bytesRead === 0) break;
              copied += bytesRead;
              if (copied > maxFileBytes) {
                throw new CodedError("artifact_too_large", `Generated files may not exceed ${maxFileBytes} bytes.`);
              }
              const chunk = buffer.subarray(0, bytesRead);
              hash.update(chunk);
              await target.write(chunk);
            }
            await target.sync();
          } finally {
            await target.close();
          }
          if (copied !== sourceStat.size) {
            throw new CodedError("artifact_publish_failed", "The generated file changed while it was being published.");
          }
          const finalSourceStat = await source.verify();
          if (!sameSourceSnapshot(sourceStat, finalSourceStat)) {
            throw new CodedError("artifact_publish_failed", "The generated file changed while it was being published.");
          }
          const createdAt = now();
          const manifest: ReplyArtifactManifest = {
            schema: 1,
            id,
            runId: binding.runId,
            conversationId: binding.conversationId,
            name: sanitizeDisplayName(input.name ?? basename(input.path), id),
            mediaType: normalizeMediaType(input.mediaType, input.path),
            sizeBytes: copied,
            integrityId: `sha256:${hash.digest("hex")}`,
            createdAt: createdAt.toISOString(),
            expiresAt: new Date(createdAt.getTime() + retentionDays * 86_400_000).toISOString(),
          };
          const manifestJson = serializeBoundedJsonLine(manifest, MAX_MANIFEST_BYTES);
          await writeFile(join(stagingDirectory, "metadata.json"), manifestJson, {
            encoding: "utf8",
            mode: 0o600,
            flag: "wx",
          });
          await options.beforePublicationCommit?.();
          const identity = `attachment:${manifest.integrityId}`;
          const part = attachmentPart(manifest, id);
          const recorded = recordPart(binding.runId, identity, part);
          if (!recorded.accepted) return recorded.part as AgentReplyAttachmentPart | AgentReplyPartFailure;
          claimedIdentity = identity;
          await rename(stagingDirectory, directory);
          const ids = artifactIdsByRun.get(binding.runId) ?? new Set<string>();
          ids.add(id);
          artifactIdsByRun.set(binding.runId, ids);
          const protections = artifactProtectionsByRun.get(binding.runId)
            ?? new Map<string, ReplyArtifactStorageProtection>();
          protections.set(id, storageProtection);
          artifactProtectionsByRun.set(binding.runId, protections);
          published = true;
          return part;
        } finally {
          if (!published) await rm(stagingDirectory, { recursive: true, force: true }).catch(() => undefined);
          if (!published) await storageProtection.release();
          await storageReservation.release();
        }
      } finally {
        await source.close();
      }
    } catch (error) {
      if (claimedIdentity !== undefined) rollbackRecordedPart(binding.runId, claimedIdentity);
      const code = error instanceof CodedError && error.code === "artifact_too_large"
        ? "artifact_too_large"
        : "artifact_publish_failed";
      const failureIdentity = `attachment-failure:${stableDigest({
        path: input.path,
        name: input.name,
        mediaType: input.mediaType,
        code,
      })}`;
      const storageFull = error instanceof ReplyArtifactStorageFullError;
      const failure: AgentReplyPartFailure = {
        type: "failure",
        id: stablePartId("reply-file-failure", failureIdentity),
        code,
        message: storageFull
          ? "Reply artifact storage is full; this file was not published."
          : code === "artifact_too_large"
          ? errorMessage(error)
          : "The generated file could not be published safely.",
      };
      return recordPart(binding.runId, failureIdentity, failure).part as AgentReplyPartFailure;
    }
  };

  const createExtension: RuntimeOptionsExtension = async ({ request, runId }) => {
    await mkdir(stagingRoot, { recursive: true, mode: 0o700 });
    const owner = responseContext.getStore();
    owner?.runIds.add(runId);
    runOwners.set(runId, owner);
    await cleanupExpired().catch(() => undefined);
    const endpointPath = `/mcp/${randomUUID()}`;
    let port: number | undefined;
    const http = createServer((incoming, response) => {
      if (incoming.url !== endpointPath || !isLoopbackHost(incoming.headers.host) || port === undefined) {
        response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        response.end("Not found");
        return;
      }
      const boundPort = port;
      void (async () => {
        const parsedBody = incoming.method === "POST" ? await readJsonBody(incoming) : undefined;
        const server = createPublishServer(async (input) => {
          return await publish({ runId, conversationId: request.conversationId }, input);
        });
        const transport = new WebStandardStreamableHTTPServerTransport({
          enableJsonResponse: true,
          allowedHosts: [`127.0.0.1:${boundPort}`],
          enableDnsRebindingProtection: true,
        });
        try {
          await server.connect(transport as never);
          const webResponse = await transport.handleRequest(nodeRequestAsWebRequest(incoming), { parsedBody });
          if (webResponse === undefined) throw new Error("Reply artifact MCP transport is unavailable.");
          await writeWebResponse(response, webResponse);
        } finally {
          await server.close().catch(() => undefined);
        }
      })().catch(() => {
        if (!response.headersSent) response.writeHead(500);
        response.end();
      });
    });

    await listenLoopback(http);
    port = (http.address() as AddressInfo).port;
    let closed = false;
    const serverSpec = privateLoopbackHttpServerSpec(`http://127.0.0.1:${port}${endpointPath}`);
    return {
      runtimeOptions: {
        mcpServers: {
          [REPLY_ARTIFACT_MCP_SERVER_NAME]: serverSpec,
        },
      },
      cleanup: async () => {
        if (closed) return;
        closed = true;
        await closeHttpServer(http);
      },
      settleCleanup: async () => {
        if (runOwners.get(runId) === undefined) await discardRun(runId);
      },
    };
  };

  async function open(request: AgentReplyArtifactOpenRequest): Promise<AgentReplyArtifactStream> {
    const protection = await storage.protect("reply-files", request.reference.id);
    try {
      const manifest = await readManifest(root, request.reference.id);
      if (
        request.conversationId !== manifest.conversationId
        && request.conversationId !== manifest.deliveryConversationId
      ) {
        throw new CodedError("artifact_forbidden", "The artifact does not belong to this conversation.");
      }
      if (Date.parse(manifest.expiresAt) <= now().getTime()) {
        throw new CodedError("artifact_expired", "The generated file has expired.");
      }
      if (request.expectedIntegrityId !== undefined && request.expectedIntegrityId !== manifest.integrityId) {
        throw new CodedError("artifact_integrity_failed", "The message integrity id does not match the artifact.");
      }
      const contentPath = join(root, manifest.id, "content");
      const handle = await openFile(contentPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const fileStat = await handle.stat();
        if (!fileStat.isFile() || fileStat.size !== manifest.sizeBytes || fileStat.size > maxFileBytes) {
          throw new CodedError("artifact_integrity_failed", "The generated file size no longer matches its manifest.");
        }
        const actualIntegrity = await hashHandle(handle, fileStat.size);
        if (actualIntegrity !== manifest.integrityId) {
          throw new CodedError("artifact_integrity_failed", "The generated file failed its integrity check.");
        }
        const attachment = attachmentPart(manifest, manifest.id);
        return {
          attachment,
          body: streamHandle(handle, fileStat.size, async () => await protection.release()),
        };
      } catch (error) {
        await handle.close().catch(() => undefined);
        throw error;
      }
    } catch (error) {
      await protection.release();
      throw error;
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
      await Promise.all(entries.filter((entry) => ARTIFACT_ID.test(entry)).map(async (entry) => {
        if (isProtected("reply-files", entry)) return;
        try {
          const manifest = await readManifest(root, entry);
          if (Date.parse(manifest.expiresAt) <= cutoff) {
            await rm(join(root, entry), { recursive: true, force: true });
          }
        } catch {
          // Partial/corrupt publications are never served. Remove only directories
          // whose names were minted by this service.
          await rm(join(root, entry), { recursive: true, force: true }).catch(() => undefined);
        }
      }));
      await cleanupStaging(
        stagingRoot,
        cutoff - stagingGraceMs,
        (id) => isProtected("reply-files", id),
      );
    });
  }

  function wrapResponder(responder: AgentResponder): AgentResponder {
    return {
      ...responder,
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
          const published = partsByRun.get(runId) ?? [];
          if (published.length === 0) {
            await retainRun(runId);
            retainedRunId = runId;
            return response;
          }
          const finalized = await finalizeDeliveryParts({ runId, conversationId: request.conversationId }, published);
          const parts = mergeReplyParts(response.parts, finalized);
          await retainRun(runId);
          retainedRunId = runId;
          return { ...response, parts };
        } finally {
          await Promise.all([...context.runIds]
            .filter((runId) => runId !== retainedRunId)
            .map(async (runId) => await discardRun(runId)));
        }
      },
      openReplyArtifact: open,
    };
  }

  async function retainRun(runId: string): Promise<void> {
    const protections = [...(artifactProtectionsByRun.get(runId)?.values() ?? [])];
    partsByRun.delete(runId);
    partsByIdentityByRun.delete(runId);
    artifactIdsByRun.delete(runId);
    artifactProtectionsByRun.delete(runId);
    runOwners.delete(runId);
    budget.release(runId);
    await Promise.all(protections.map(async (protection) => await protection.release()));
  }

  async function discardRun(runId: string): Promise<void> {
    const ids = [...(artifactIdsByRun.get(runId) ?? [])];
    await retainRun(runId);
    await Promise.all(ids.map(async (id) => {
      await rm(join(root, id), { recursive: true, force: true }).catch(() => undefined);
    }));
  }

  function rollbackRecordedPart(runId: string, identity: string): void {
    const byIdentity = partsByIdentityByRun.get(runId);
    const part = byIdentity?.get(identity);
    byIdentity?.delete(identity);
    if (byIdentity?.size === 0) partsByIdentityByRun.delete(runId);
    if (part !== undefined) {
      const parts = partsByRun.get(runId)?.filter((candidate) => candidate !== part) ?? [];
      if (parts.length === 0) partsByRun.delete(runId);
      else partsByRun.set(runId, parts);
    }
    budget.unclaim(runId, identity);
  }

  async function finalizeDeliveryParts(
    binding: { readonly runId: string; readonly conversationId: string },
    parts: readonly AgentReplyPart[],
  ): Promise<readonly AgentReplyPart[]> {
    const finalized: AgentReplyPart[] = [];
    for (const part of parts) {
      if (part.type !== "attachment") {
        finalized.push(part);
        continue;
      }
      const protection = await storage.protect("reply-files", part.reference.id);
      try {
        await bindDeliveryConversation(root, part, binding.conversationId, storage);
        finalized.push(part);
      } catch {
        const failure = replaceAttachmentWithDeliveryFailure(binding.runId, part);
        artifactIdsByRun.get(binding.runId)?.delete(part.reference.id);
        await rm(join(root, part.reference.id), { recursive: true, force: true }).catch(() => undefined);
        finalized.push(failure);
      } finally {
        await protection.release();
      }
    }
    return finalized;
  }

  function replaceAttachmentWithDeliveryFailure(
    runId: string,
    part: AgentReplyAttachmentPart,
  ): AgentReplyPartFailure {
    const failureIdentity = `attachment-delivery-failure:${part.reference.id}`;
    const failure: AgentReplyPartFailure = {
      type: "failure",
      id: stablePartId("reply-file-delivery-failure", failureIdentity),
      code: "artifact_publish_failed",
      message: "The generated file could not be finalized for delivery.",
      relatedPartId: part.id,
    };
    replaceRecordedPart(runId, part, failureIdentity, failure);
    return failure;
  }

  function replaceRecordedPart(
    runId: string,
    replaced: AgentReplyPart,
    replacementIdentity: string,
    replacement: AgentReplyPart,
  ): void {
    const byIdentity = partsByIdentityByRun.get(runId) ?? new Map<string, AgentReplyPart>();
    const oldIdentity = [...byIdentity].find(([, part]) => part === replaced)?.[0];
    if (oldIdentity !== undefined) {
      byIdentity.delete(oldIdentity);
      budget.unclaim(runId, oldIdentity);
    }
    if (budget.claim(runId, replacementIdentity) === "accepted") {
      byIdentity.set(replacementIdentity, replacement);
    }
    const current = partsByRun.get(runId) ?? [];
    const index = current.indexOf(replaced);
    if (index >= 0) current[index] = replacement;
    partsByRun.set(runId, current);
    partsByIdentityByRun.set(runId, byIdentity);
  }

  return { createExtension, wrapResponder, open, cleanupExpired };
}

/**
 * Keep a request capability available to the in-process runtime without making
 * it part of ordinary option serialization or error reporting. Shallow MCP
 * server-map merges preserve the spec object by identity.
 */
function privateLoopbackHttpServerSpec(url: string): { readonly type: "http"; readonly url: string } {
  const spec = { type: "http" } as { readonly type: "http"; readonly url: string };
  Object.defineProperty(spec, "url", { value: url, enumerable: false });
  Object.defineProperty(spec, PRIVATE_CAPABILITY_URL, { value: true, enumerable: false });
  return spec;
}

function createPublishServer(
  publish: (input: PublishInput) => Promise<AgentReplyAttachmentPart | AgentReplyPartFailure>,
): McpServer {
  const server = new McpServer({ name: REPLY_ARTIFACT_MCP_SERVER_NAME, version: "1.0.0" });
  server.registerTool(PUBLISH_REPLY_FILE_TOOL_NAME, {
    title: "Attach a generated file",
    description: "Publish one generated workspace file with the assistant reply. Call once per file after writing it. The host copies, hashes, retains, and authorizes the file; the response carries only an opaque id and sanitized metadata. Paths outside the workspace or this run's MCP output directory, symlinks, non-files, and files over 20 MiB are rejected.",
    inputSchema: PUBLISH_INPUT,
  }, async (input) => {
    const part = await publish(input);
    if (part.type === "attachment") {
      return {
        content: [{ type: "text" as const, text: `Published ${part.name} (${part.sizeBytes} bytes, ${part.integrityId}). It will be attached to this reply.` }],
        structuredContent: {
          published: true,
          attachmentId: part.reference.id,
          name: part.name,
          mediaType: part.mediaType,
          sizeBytes: part.sizeBytes,
          integrityId: part.integrityId,
        },
      };
    }
    return {
      isError: true,
      content: [{ type: "text" as const, text: part.message }],
      structuredContent: { published: false, code: part.code },
    };
  });
  return server;
}

async function openAuthorizedSource(
  pathInput: string,
  workspace: string,
  currentRunOutboundRoot: string | undefined,
  privateRoots: readonly string[],
  beforeOpen?: () => void | Promise<void>,
): Promise<AuthorizedSource> {
  if (pathInput.includes("\0")) throw new CodedError("artifact_publish_failed", "Invalid generated file path.");
  const candidate = resolve(isAbsolute(pathInput) ? pathInput : join(workspace, pathInput));
  const outboundCandidate = currentRunOutboundRoot !== undefined
    && isPathInside(currentRunOutboundRoot, candidate);
  const authorizationRoot = outboundCandidate ? currentRunOutboundRoot : workspace;
  if (!isPathInside(authorizationRoot, candidate)) {
    throw new CodedError("artifact_publish_failed", "Generated file path is outside the authorized roots.");
  }
  assertSafePublicationComponents(authorizationRoot, candidate);
  if (isBlockedByPrivateRoot(candidate, privateRoots, outboundCandidate ? authorizationRoot : undefined)) {
    throw new CodedError("artifact_publish_failed", "Generated file path is private.");
  }
  const canonical = await realpath(candidate);
  const canonicalAuthorizationRoot = await realpath(authorizationRoot).catch(() => authorizationRoot);
  const canonicalPrivateRoots = await Promise.all(
    privateRoots.map(async (root) => await realpath(root).catch(() => root)),
  );
  if (!isPathInside(canonicalAuthorizationRoot, canonical)) {
    throw new CodedError("artifact_publish_failed", "Generated file path resolves outside the authorized roots.");
  }
  assertSafePublicationComponents(canonicalAuthorizationRoot, canonical);
  if (isBlockedByPrivateRoot(
    canonical,
    canonicalPrivateRoots,
    outboundCandidate ? canonicalAuthorizationRoot : undefined,
  )) {
    throw new CodedError("artifact_publish_failed", "Generated file path resolves into private state.");
  }
  await beforeOpen?.();
  // Darwin rejects combining O_NOFOLLOW and O_NOFOLLOW_ANY; the latter is the
  // stronger flag because it covers the final component as well as parents.
  const flags = constants.O_RDONLY | (process.platform === "darwin"
    ? DARWIN_O_NOFOLLOW_ANY
    : (constants.O_NOFOLLOW ?? 0));
  // Node's promise-based fs.open currently rejects Darwin's O_NOFOLLOW_ANY
  // even though the kernel accepts it. Use the raw numeric flag through the
  // synchronous open syscall (the only synchronous operation is opening one
  // already-resolved path), then keep all copying on the owned descriptor.
  const handle: Omit<AuthorizedSource, "verify"> = process.platform === "darwin"
    ? sourceFromFd(openSync(canonical, flags))
    : await openFile(canonical, flags);
  const verify = async (): Promise<Stats> => {
    const [opened, currentPath, currentCanonical] = await Promise.all([
      handle.stat(),
      lstat(canonical),
      realpath(candidate),
    ]);
    if (
      !opened.isFile()
      || opened.nlink !== 1
      || !currentPath.isFile()
      || currentPath.isSymbolicLink()
      || currentPath.nlink !== 1
      || currentCanonical !== canonical
      || opened.dev !== currentPath.dev
      || opened.ino !== currentPath.ino
    ) {
      throw new CodedError("artifact_publish_failed", "The generated file path changed during authorization.");
    }
    return opened;
  };
  try {
    await verify();
    return {
      stat: async () => await handle.stat(),
      read: async (buffer, offset, length, position) => await handle.read(buffer, offset, length, position),
      verify,
      close: async () => await handle.close(),
    };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

interface AuthorizedSource {
  stat(): Promise<Stats>;
  read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ readonly bytesRead: number }>;
  verify(): Promise<Stats>;
  close(): Promise<void>;
}

function sourceFromFd(fd: number): Omit<AuthorizedSource, "verify"> {
  let closed = false;
  return {
    stat: async () => await new Promise<Stats>((resolveStat, reject) => {
      fstat(fd, (error, value) => error === null ? resolveStat(value) : reject(error));
    }),
    read: async (buffer, offset, length, position) => await new Promise((resolveRead, reject) => {
      readFd(fd, buffer, offset, length, position, (error, bytesRead) => {
        if (error !== null) reject(error);
        else resolveRead({ bytesRead });
      });
    }),
    close: async () => {
      if (closed) return;
      closed = true;
      await new Promise<void>((resolveClose, reject) => {
        closeFd(fd, (error) => error === null ? resolveClose() : reject(error));
      });
    },
  };
}

function isPathInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

function runOutboundRoot(outboundRoot: string, runId: string): string | undefined {
  if (
    runId.length === 0
    || runId.includes("\0")
    || runId.includes("/")
    || runId.includes("\\")
    || runId === "."
    || runId === ".."
  ) return undefined;
  const candidate = resolve(outboundRoot, runId);
  return isPathInside(outboundRoot, candidate) && candidate !== outboundRoot ? candidate : undefined;
}

function isBlockedByPrivateRoot(
  candidate: string,
  privateRoots: readonly string[],
  outboundExceptionRoot: string | undefined,
): boolean {
  return privateRoots.some((privateRoot) => {
    if (!isPathInside(privateRoot, candidate)) return false;
    return outboundExceptionRoot === undefined || !isPathInside(privateRoot, outboundExceptionRoot);
  });
}

function assertSafePublicationComponents(root: string, candidate: string): void {
  const path = relative(root, candidate);
  for (const component of path.split(/[\\/]/u).filter((value) => value.length > 0)) {
    if (isSensitivePublicationComponent(component)) {
      throw new CodedError("artifact_publish_failed", "Generated file path contains a private component.");
    }
  }
}

function isSensitivePublicationComponent(component: string): boolean {
  const skeleton = wellFormed(component)
    .normalize("NFKD")
    .replace(/\p{Mark}/gu, "")
    .replace(DEFAULT_IGNORABLE, "")
    .toLowerCase();
  if (skeleton.startsWith(".")) return true;
  if (/^id_[a-z0-9]/u.test(skeleton)) return true;
  if (SENSITIVE_FILE_EXTENSIONS.some((extension) => skeleton.endsWith(extension))) return true;
  if (/^(?:authorized_keys|cacerts|kubeconfig|known_hosts|netrc|npmrc)$/u.test(skeleton)) return true;
  if (/^mono-agent(?:[._-][a-z0-9-]+)*[._-]config(?:[._-]|$)/u.test(skeleton)) return true;
  if (/^mcp(?:[._-](?:config|servers?|auth|credentials?))?\.(?:json|jsonc|ya?ml|toml)$/u.test(skeleton)) {
    return true;
  }
  const segments = skeleton.split(/[^a-z0-9]+/u).filter((value) => value.length > 0);
  if (segments.some((segment) => SENSITIVE_NAME_SEGMENTS.has(segment))) return true;
  const joined = segments.join("");
  return joined.includes("apikey")
    || joined.includes("clientsecret")
    || joined.includes("keystore")
    || joined.includes("keyring")
    || joined.includes("privatekey")
    || joined.includes("serviceaccount")
    || joined.includes("applicationdefaultcredentials")
    || joined.includes("truststore");
}

function sanitizeDisplayName(input: string, fallbackId: string): string {
  let name = wellFormed(basename(input)).normalize("NFC")
    .replace(BIDI_CONTROL, "")
    .replace(/[\u0000-\u001f\u007f]/gu, "_")
    .replace(/[\\/:]/gu, "_")
    .trim()
    .replace(/^\.+$/u, "");
  if (name.length === 0) name = `attachment-${fallbackId.slice(0, 8)}`;
  return truncateUtf8ByCodePoint(name, MAX_DISPLAY_NAME_BYTES);
}

function wellFormed(input: string): string {
  let output = "";
  for (const codePoint of input) {
    const unit = codePoint.charCodeAt(0);
    output += codePoint.length === 1 && unit >= 0xd800 && unit <= 0xdfff ? "\ufffd" : codePoint;
  }
  return output;
}

function truncateUtf8ByCodePoint(input: string, maxBytes: number): string {
  let output = "";
  let bytes = 0;
  for (const codePoint of input) {
    const codePointBytes = Buffer.byteLength(codePoint, "utf8");
    if (bytes + codePointBytes > maxBytes) break;
    output += codePoint;
    bytes += codePointBytes;
  }
  return output;
}

function sameSourceSnapshot(before: Stats, after: Stats): boolean {
  return before.dev === after.dev
    && before.ino === after.ino
    && before.nlink === 1
    && after.nlink === 1
    && before.size === after.size
    && before.mtimeMs === after.mtimeMs
    && before.ctimeMs === after.ctimeMs;
}

function normalizeMediaType(input: string | undefined, path: string): string {
  const normalized = input?.trim().toLowerCase();
  if (normalized !== undefined && MEDIA_TYPE.test(normalized)) return normalized;
  return ({
    ".csv": "text/csv",
    ".json": "application/json",
    ".md": "text/markdown",
    ".pdf": "application/pdf",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".txt": "text/plain",
    ".zip": "application/zip",
  } as Record<string, string>)[extname(path).toLowerCase()] ?? "application/octet-stream";
}

function attachmentPart(manifest: ReplyArtifactManifest, partId: string): AgentReplyAttachmentPart {
  return {
    type: "attachment",
    id: partId,
    reference: { scheme: "mono-agent-artifact", id: manifest.id },
    name: manifest.name,
    mediaType: manifest.mediaType,
    sizeBytes: manifest.sizeBytes,
    integrityId: manifest.integrityId,
    expiresAt: manifest.expiresAt,
  };
}

function stableDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value) ?? "null").digest("hex");
}

function stablePartId(prefix: string, identity: string): string {
  return `${prefix}-${stableDigest(identity).slice(0, 24)}`;
}

async function cleanupStaging(
  stagingRoot: string,
  staleBeforeMs: number,
  isProtected: (id: string) => boolean,
): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(stagingRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  await Promise.all(entries.filter((entry) => ARTIFACT_ID.test(entry) && !isProtected(entry)).map(async (entry) => {
    const path = join(stagingRoot, entry);
    try {
      const entryStat = await lstat(path);
      if (entryStat.mtimeMs > staleBeforeMs) return;
      await rm(path, { recursive: true, force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }));
}

async function bindDeliveryConversation(
  root: string,
  part: AgentReplyAttachmentPart,
  conversationId: string,
  storage: ReplyArtifactStorageBudget,
): Promise<void> {
  const manifest = await readManifest(root, part.reference.id);
  if (manifest.deliveryConversationId === conversationId) return;
  const directory = join(root, manifest.id);
  const temp = join(directory, `metadata.${randomUUID()}.partial`);
  const manifestJson = serializeBoundedJsonLine(
    { ...manifest, deliveryConversationId: conversationId },
    MAX_MANIFEST_BYTES,
  );
  const reservation = await storage.reserve(Buffer.byteLength(manifestJson, "utf8"));
  if (reservation === undefined) throw new ReplyArtifactStorageFullError();
  let committed = false;
  try {
    await writeFile(temp, manifestJson, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await rename(temp, join(directory, "metadata.json"));
    committed = true;
  } finally {
    if (!committed) await rm(temp, { force: true }).catch(() => undefined);
    await reservation.release();
  }
}

async function readManifest(root: string, id: string): Promise<ReplyArtifactManifest> {
  if (!ARTIFACT_ID.test(id)) throw new CodedError("artifact_missing", "The generated file reference is invalid.");
  const path = join(root, id, "metadata.json");
  let data: Buffer;
  try {
    const fileStat = await stat(path);
    if (!fileStat.isFile() || fileStat.size > MAX_MANIFEST_BYTES) throw new Error("invalid manifest");
    data = await readFile(path);
  } catch {
    throw new CodedError("artifact_missing", "The generated file is missing.");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(data.toString("utf8"));
  } catch {
    throw new CodedError("artifact_missing", "The generated file metadata is unavailable.");
  }
  if (!isManifest(raw) || raw.id !== id) {
    throw new CodedError("artifact_missing", "The generated file metadata is invalid.");
  }
  return raw;
}

function isManifest(value: unknown): value is ReplyArtifactManifest {
  if (!isRecord(value)) return false;
  return value.schema === 1
    && typeof value.id === "string"
    && typeof value.runId === "string"
    && typeof value.conversationId === "string"
    && (value.deliveryConversationId === undefined || typeof value.deliveryConversationId === "string")
    && typeof value.name === "string"
    && typeof value.mediaType === "string"
    && typeof value.sizeBytes === "number"
    && Number.isSafeInteger(value.sizeBytes)
    && value.sizeBytes >= 0
    && typeof value.integrityId === "string"
    && /^sha256:[0-9a-f]{64}$/u.test(value.integrityId)
    && typeof value.createdAt === "string"
    && Number.isFinite(Date.parse(value.createdAt))
    && typeof value.expiresAt === "string"
    && Number.isFinite(Date.parse(value.expiresAt));
}

function serializeBoundedJsonLine(value: unknown, maxBytes: number): string {
  const serialized = `${JSON.stringify(value) ?? "null"}\n`;
  if (Buffer.byteLength(serialized, "utf8") > maxBytes) {
    throw new RangeError("Reply artifact metadata exceeded its byte limit.");
  }
  return serialized;
}

async function hashHandle(handle: Awaited<ReturnType<typeof openFile>>, size: number): Promise<string> {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
  let offset = 0;
  while (offset < size) {
    const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.byteLength, size - offset), offset);
    if (bytesRead === 0) break;
    hash.update(buffer.subarray(0, bytesRead));
    offset += bytesRead;
  }
  if (offset !== size) throw new CodedError("artifact_integrity_failed", "The generated file could not be read completely.");
  return `sha256:${hash.digest("hex")}`;
}

async function* streamHandle(
  handle: Awaited<ReturnType<typeof openFile>>,
  size: number,
  releaseProtection: () => Promise<void>,
): AsyncGenerator<Uint8Array> {
  const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
  let offset = 0;
  try {
    while (offset < size) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.byteLength, size - offset), offset);
      if (bytesRead === 0) throw new CodedError("artifact_interrupted", "The generated file stream ended early.");
      offset += bytesRead;
      yield Uint8Array.from(buffer.subarray(0, bytesRead));
    }
  } finally {
    await handle.close().catch(() => undefined);
    await releaseProtection().catch(() => undefined);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function storageProtectionKey(namespace: ReplyArtifactStorageNamespace, id: string): string {
  return `${namespace}:${id}`;
}

async function runStorageExclusive<T>(
  state: ReplyArtifactStorageState,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = state.gate;
  let release!: () => void;
  state.gate = new Promise<void>((resolveGate) => { release = resolveGate; });
  await previous;
  try {
    return await operation();
  } finally {
    release();
  }
}

async function inventoryReplyArtifactBytes(artifactDir: string): Promise<number> {
  let total = 0;
  for (const namespace of REPLY_ARTIFACT_STORAGE_NAMESPACES) {
    total = addStorageBytes(total, await inventoryTreeBytes(join(artifactDir, namespace)));
  }
  return total;
}

async function inventoryTreeBytes(root: string): Promise<number> {
  let entries: Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
  let total = 0;
  for (const entry of entries) {
    const path = join(root, entry.name);
    let entryStat: Stats;
    try {
      entryStat = await lstat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    total = entryStat.isDirectory() && !entryStat.isSymbolicLink()
      ? addStorageBytes(total, await inventoryTreeBytes(path))
      : addStorageBytes(total, entryStat.size);
  }
  return total;
}

function addStorageBytes(left: number, right: number): number {
  return left > Number.MAX_SAFE_INTEGER - right ? Number.MAX_SAFE_INTEGER : left + right;
}

function isLoopbackHost(host: string | undefined): boolean {
  return host !== undefined && /^127\.0\.0\.1:\d+$/u.test(host);
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > 1_000_000) throw new Error("Reply artifact MCP request exceeds 1 MB.");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function nodeRequestAsWebRequest(request: IncomingMessage): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) for (const item of value) headers.append(name, item);
    else if (value !== undefined) headers.set(name, value);
  }
  return new Request(`http://${String(request.headers.host)}${request.url ?? "/"}`, {
    method: request.method ?? "GET",
    headers,
  });
}

async function writeWebResponse(response: import("node:http").ServerResponse, webResponse: Response): Promise<void> {
  const headers: Record<string, string> = {};
  webResponse.headers.forEach((value, name) => { headers[name] = value; });
  response.writeHead(webResponse.status, headers);
  if (webResponse.body === null) {
    response.end();
    return;
  }
  const reader = webResponse.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    response.write(Buffer.from(value));
  }
  response.end();
}

async function listenLoopback(server: Server): Promise<void> {
  await new Promise<void>((resolveListen, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resolveListen();
    });
  });
}

async function closeHttpServer(server: Server): Promise<void> {
  server.closeAllConnections?.();
  if (!server.listening) return;
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
}
