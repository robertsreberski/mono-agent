import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

import { CodedError, MCP_APP_RESOURCE_MIME_TYPE } from "@mono-agent/contracts";
import type { AgentReplyMcpAppPart } from "@mono-agent/contracts";

import { ReplyArtifactStorageFullError, type ReplyArtifactStorageBudget } from "../artifacts/reply-artifacts.js";
import { APP_ID, isSupportedProtocolVersion, record, serializeBoundedJsonLine } from "./content.js";
import type { McpAppManifest, McpAppState } from "./types.js";

export const MAX_HTML_BYTES = 2 * 1024 * 1024;
export const MAX_STATE_BYTES = 1024 * 1024;
export const MAX_MANIFEST_BYTES = 64 * 1024;

export async function writeAppAtomically(
  root: string,
  stagingRoot: string,
  manifest: McpAppManifest,
  html: string,
  state: McpAppState,
  storage: ReplyArtifactStorageBudget,
  beforeCommit?: () => void | Promise<void>,
): Promise<void> {
  const directory = join(root, manifest.invocationId);
  const stagingDirectory = join(stagingRoot, manifest.invocationId);
  const stateJson = serializeBoundedJsonLine(state, MAX_STATE_BYTES);
  const manifestJson = serializeBoundedJsonLine(manifest, MAX_MANIFEST_BYTES);
  const reservation = await storage.reserve(
    Buffer.byteLength(html, "utf8")
      + Buffer.byteLength(stateJson, "utf8")
      + Buffer.byteLength(manifestJson, "utf8"),
  );
  if (reservation === undefined) throw new ReplyArtifactStorageFullError();
  try {
    await mkdir(stagingRoot, { recursive: true, mode: 0o700 });
    await mkdir(stagingDirectory, { mode: 0o700 });
    let complete = false;
    try {
      await writeFile(join(stagingDirectory, "resource.html"), html, { encoding: "utf8", mode: 0o600, flag: "wx" });
      await writeFile(join(stagingDirectory, "state.json"), stateJson, { encoding: "utf8", mode: 0o600, flag: "wx" });
      await writeFile(join(stagingDirectory, "manifest.json"), manifestJson, { encoding: "utf8", mode: 0o600, flag: "wx" });
      await beforeCommit?.();
      await rename(stagingDirectory, directory);
      complete = true;
    } finally {
      if (!complete) await rm(stagingDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
  } finally {
    await reservation.release();
  }
}

export async function readManifest(root: string, invocationId: string): Promise<McpAppManifest> {
  if (!APP_ID.test(invocationId)) throw new CodedError("app_missing", "The MCP App reference is invalid.");
  let value: unknown;
  try {
    value = await readBoundedJson(join(root, invocationId, "manifest.json"), MAX_MANIFEST_BYTES);
  } catch {
    throw new CodedError("app_missing", "The MCP App is unavailable.");
  }
  if (!isManifest(value) || value.invocationId !== invocationId) {
    throw new CodedError("app_missing", "The MCP App metadata is invalid.");
  }
  return value;
}

function isManifest(value: unknown): value is McpAppManifest {
  const manifest = record(value);
  return manifest?.schema === 1
    && typeof manifest.invocationId === "string"
    && typeof manifest.connectionId === "string"
    && typeof manifest.runId === "string"
    && typeof manifest.conversationId === "string"
    && (manifest.deliveryConversationId === undefined || typeof manifest.deliveryConversationId === "string")
    && typeof manifest.serverName === "string"
    && typeof manifest.toolName === "string"
    && typeof manifest.toolCallId === "string"
    && typeof manifest.resourceUri === "string"
    && isSupportedProtocolVersion(manifest.protocolVersion)
    && manifest.mediaType === MCP_APP_RESOURCE_MIME_TYPE
    && Array.isArray(manifest.appVisibleTools)
    && manifest.appVisibleTools.every(safeToolName)
    && Array.isArray(manifest.appVisibleResources)
    && manifest.appVisibleResources.length > 0
    && manifest.appVisibleResources.every((uri) => typeof uri === "string" && uri.startsWith("ui://"))
    && typeof manifest.createdAt === "string"
    && Number.isFinite(Date.parse(manifest.createdAt))
    && typeof manifest.expiresAt === "string"
    && Number.isFinite(Date.parse(manifest.expiresAt));
}

export async function bindDeliveryConversation(
  root: string,
  part: AgentReplyMcpAppPart,
  conversationId: string,
  storage: ReplyArtifactStorageBudget,
): Promise<void> {
  const manifest = await readManifest(root, part.invocationId);
  if (manifest.deliveryConversationId === conversationId) return;
  const directory = join(root, manifest.invocationId);
  const temp = join(directory, `manifest.${randomUUID()}.partial`);
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
    await rename(temp, join(directory, "manifest.json"));
    committed = true;
  } finally {
    if (!committed) await rm(temp, { force: true }).catch(() => undefined);
    await reservation.release();
  }
}

export async function cleanupStaging(
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
  await Promise.all(entries.filter((entry) => APP_ID.test(entry) && !isProtected(entry)).map(async (entry) => {
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

export async function readBoundedText(path: string, maxBytes: number): Promise<string> {
  const fileStat = await stat(path);
  if (!fileStat.isFile() || fileStat.size > maxBytes) throw new CodedError("app_missing", "The MCP App resource is unavailable.");
  return await readFile(path, "utf8");
}

export async function readBoundedJson<T = unknown>(path: string, maxBytes: number): Promise<T> {
  return JSON.parse(await readBoundedText(path, maxBytes)) as T;
}

export function safeToolName(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,255}$/u.test(value);
}
