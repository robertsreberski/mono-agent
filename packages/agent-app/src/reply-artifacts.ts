import { createHash, randomUUID } from "node:crypto";
import {
  close as closeFd,
  constants,
  fstat,
  openSync,
  read as readFd,
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
  readonly retentionDays?: number;
  readonly maxFileBytes?: number;
  readonly now?: () => Date;
  /** Shared with other reply-part producers in the app composition root. */
  readonly replyPartBudget?: ReplyPartBudget;
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
  const root = resolve(options.artifactDir, "reply-files");
  const stagingRoot = join(root, STAGING_NAMESPACE);
  const workspace = resolve(options.workspace);
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_AGENT_ATTACHMENT_MAX_BYTES;
  const retentionDays = options.retentionDays ?? DEFAULT_RETENTION_DAYS;
  const stagingGraceMs = options.stagingGraceMs ?? DEFAULT_STAGING_GRACE_MS;
  const now = options.now ?? (() => new Date());
  const budget = options.replyPartBudget ?? createReplyPartBudget();
  const partsByRun = new Map<string, AgentReplyPart[]>();
  const partsByIdentityByRun = new Map<string, Map<string, AgentReplyPart>>();
  const artifactIdsByRun = new Map<string, Set<string>>();
  const activeStagingIds = new Set<string>();
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
      const source = await openAuthorizedSource(input.path, workspace, [
        resolve(options.artifactDir, "outbound", binding.runId),
      ], options.beforeSourceOpen);
      try {
        const sourceStat = await source.stat();
        if (!sourceStat.isFile()) throw new CodedError("artifact_publish_failed", "Only regular files can be published.");
        if (sourceStat.size > maxFileBytes) {
          throw new CodedError("artifact_too_large", `Generated files may not exceed ${maxFileBytes} bytes.`);
        }
        const id = randomUUID();
        const directory = join(root, id);
        const stagingDirectory = join(stagingRoot, id);
        const contentPath = join(stagingDirectory, "content");
        activeStagingIds.add(id);
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
          published = true;
          return part;
        } finally {
          if (!published) await rm(stagingDirectory, { recursive: true, force: true }).catch(() => undefined);
          activeStagingIds.delete(id);
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
      const failure: AgentReplyPartFailure = {
        type: "failure",
        id: stablePartId("reply-file-failure", failureIdentity),
        code,
        message: code === "artifact_too_large"
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
      return { attachment, body: streamHandle(handle, fileStat.size) };
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw error;
    }
  }

  async function cleanupExpired(): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const cutoff = now().getTime();
    await Promise.all(entries.filter((entry) => ARTIFACT_ID.test(entry)).map(async (entry) => {
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
    await cleanupStaging(stagingRoot, cutoff - stagingGraceMs, activeStagingIds);
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
            retainRun(runId);
            retainedRunId = runId;
            return response;
          }
          await bindDeliveryConversation(root, published, request.conversationId);
          const parts = mergeReplyParts(response.parts, published);
          retainRun(runId);
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

  function retainRun(runId: string): void {
    partsByRun.delete(runId);
    partsByIdentityByRun.delete(runId);
    artifactIdsByRun.delete(runId);
    runOwners.delete(runId);
    budget.release(runId);
  }

  async function discardRun(runId: string): Promise<void> {
    const ids = [...(artifactIdsByRun.get(runId) ?? [])];
    retainRun(runId);
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
  extraRoots: readonly string[],
  beforeOpen?: () => void | Promise<void>,
): Promise<AuthorizedSource> {
  if (pathInput.includes("\0")) throw new CodedError("artifact_publish_failed", "Invalid generated file path.");
  const candidate = resolve(isAbsolute(pathInput) ? pathInput : join(workspace, pathInput));
  const roots = [workspace, ...extraRoots].map((root) => resolve(root));
  if (!roots.some((root) => isPathInside(root, candidate))) {
    throw new CodedError("artifact_publish_failed", "Generated file path is outside the authorized roots.");
  }
  const canonical = await realpath(candidate);
  const canonicalRoots = await Promise.all(roots.map(async (root) => await realpath(root).catch(() => root)));
  if (!canonicalRoots.some((root) => isPathInside(root, canonical))) {
    throw new CodedError("artifact_publish_failed", "Generated file path resolves outside the authorized roots.");
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
  const handle: AuthorizedSource = process.platform === "darwin"
    ? sourceFromFd(openSync(canonical, flags))
    : await openFile(canonical, flags);
  try {
    const [opened, currentPath, currentCanonical] = await Promise.all([
      handle.stat(),
      lstat(canonical),
      realpath(candidate),
    ]);
    if (
      !opened.isFile()
      || !currentPath.isFile()
      || currentCanonical !== canonical
      || opened.dev !== currentPath.dev
      || opened.ino !== currentPath.ino
    ) {
      throw new CodedError("artifact_publish_failed", "The generated file path changed during authorization.");
    }
    return handle;
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
  close(): Promise<void>;
}

function sourceFromFd(fd: number): AuthorizedSource {
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

function sanitizeDisplayName(input: string, fallbackId: string): string {
  let name = basename(input).normalize("NFC")
    .replace(/[\u0000-\u001f\u007f]/gu, "_")
    .replace(/[\\/:]/gu, "_")
    .trim()
    .replace(/^\.+$/u, "");
  if (name.length === 0) name = `attachment-${fallbackId.slice(0, 8)}`;
  while (Buffer.byteLength(name, "utf8") > MAX_DISPLAY_NAME_BYTES) name = name.slice(0, -1);
  return name;
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
  activeIds: ReadonlySet<string>,
): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(stagingRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  await Promise.all(entries.filter((entry) => ARTIFACT_ID.test(entry) && !activeIds.has(entry)).map(async (entry) => {
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
  parts: readonly AgentReplyPart[],
  conversationId: string,
): Promise<void> {
  await Promise.all(parts.filter((part): part is AgentReplyAttachmentPart => part.type === "attachment").map(async (part) => {
    const manifest = await readManifest(root, part.reference.id);
    if (manifest.deliveryConversationId === conversationId) return;
    const directory = join(root, manifest.id);
    const temp = join(directory, `metadata.${randomUUID()}.partial`);
    const manifestJson = serializeBoundedJsonLine(
      { ...manifest, deliveryConversationId: conversationId },
      MAX_MANIFEST_BYTES,
    );
    await writeFile(temp, manifestJson, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await rename(temp, join(directory, "metadata.json"));
  }));
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

async function* streamHandle(handle: Awaited<ReturnType<typeof openFile>>, size: number): AsyncGenerator<Uint8Array> {
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
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
