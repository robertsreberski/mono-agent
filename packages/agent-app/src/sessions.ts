import { lstat, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import {
  ToolHistoryReader,
  toolHistoryDiskUsage,
  TOOL_HISTORY_OWNER_DATABASE,
} from "@mono-agent/agent-harness";

import type { MonoAgentAppConfigInput } from "./app-config.js";
import { resolveConversationStatePurgeRoots } from "./conversation-state-roots.js";
import { loadProcessJobsSettings } from "./process-jobs-config.js";

export interface PurgeSessionsResult {
  /** The resolved sessions root, or undefined when sessions are in-memory only. */
  readonly root?: string;
  /** True when an on-disk sessions store existed and was removed. */
  readonly removed: boolean;
  /** Count of removed `*.jsonl` session files (best-effort; 0 when none/unknown). */
  readonly files: number;
}

export interface PurgeConversationHistoryResult {
  /** The durable conversation-history root beside the configured artifact directory. */
  readonly root: string;
  /** True when an on-disk history store existed and was removed. */
  readonly removed: boolean;
  readonly messageHistory: {
    /** Count of removed top-level `*.history.json` conversation records. */
    readonly files: number;
    readonly bytes: number;
  };
  readonly toolHistory: {
    /** Content-sidecar files plus the owner database in `.locks`. */
    readonly files: number;
    readonly bytes: number;
    /** False means counts could not be read and are deliberately not reported as zero. */
    readonly countsKnown: boolean;
    readonly calls?: number;
    readonly records?: number;
    readonly tombstones?: number;
  };
}

export interface PurgeAcpSessionAuthorizationsResult {
  /** The durable ACP session-authorization root beside conversation history. */
  readonly root: string;
  /** True when an on-disk authorization store existed and was removed. */
  readonly removed: boolean;
  /** Count of removed `*.json` authorization records. */
  readonly files: number;
}

export interface PurgeConversationStateResult {
  readonly sessions: PurgeSessionsResult;
  readonly history: PurgeConversationHistoryResult;
  readonly acpSessions: PurgeAcpSessionAuthorizationsResult;
}

/**
 * Remove the durable pi-session store so the next start begins with fresh sessions
 * instead of resuming persisted transcripts. A no-op (`removed: false`) when no
 * on-disk store is configured (in-memory sessions) or the directory does not exist.
 *
 * The runtime recreates the directory on the next session, and the agent's durable
 * memory lives elsewhere (`memory.path`), so this drops only resumable conversation
 * transcripts — not the knowledge base. Stop the worker before calling this so it is
 * not writing sessions while they are deleted.
 */
export async function purgeSessions(input: MonoAgentAppConfigInput): Promise<PurgeSessionsResult> {
  const root = (await resolveConversationStatePurgeRoots(input)).sessions;
  return await purgeSessionsRoot(root);
}

async function purgeSessionsRoot(root: string | undefined): Promise<PurgeSessionsResult> {
  if (root === undefined) {
    return { removed: false, files: 0 };
  }

  let files = 0;
  try {
    files = await countSessionFiles(root);
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      // The store may not exist yet; treat it as nothing to remove.
      return { root, removed: false, files: 0 };
    }
    throw error;
  }

  await rm(root, { recursive: true, force: true });
  return { root, removed: true, files };
}

/**
 * Remove the configured responder's canonical active-conversation history.
 * This root is separate from both run artifacts and `memory.path`; callers must
 * stop the worker first so no history transaction is active during deletion.
 */
export async function purgeConversationHistory(
  input: MonoAgentAppConfigInput,
): Promise<PurgeConversationHistoryResult> {
  const root = (await resolveConversationStatePurgeRoots(input)).history;
  return await purgeConversationHistoryRoot(root);
}

async function purgeConversationHistoryRoot(root: string): Promise<PurgeConversationHistoryResult> {
  let messageHistory = { files: 0, bytes: 0 };
  try {
    messageHistory = await countTopLevelFilesWithSuffix(root, ".history.json");
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      return {
        root,
        removed: false,
        messageHistory,
        toolHistory: { files: 0, bytes: 0, countsKnown: true, calls: 0, records: 0, tombstones: 0 },
      };
    }
    throw error;
  }
  const sidecarUsage = await toolHistoryDiskUsage(root);
  const ownerUsage = await optionalFileBytes(join(root, ".locks", TOOL_HISTORY_OWNER_DATABASE));
  let toolCounts: Pick<NonNullable<ReturnType<ToolHistoryReader["stats"]>>, "calls" | "records" | "tombstones"> | undefined;
  let countsKnown = true;
  try {
    const stats = new ToolHistoryReader(root).stats();
    toolCounts = stats === undefined ? { calls: 0, records: 0, tombstones: 0 } : stats;
  } catch {
    countsKnown = false;
  }
  const toolHistory = {
    files: sidecarUsage.files + ownerUsage.files,
    bytes: sidecarUsage.bytes + ownerUsage.bytes,
    countsKnown,
    ...(toolCounts === undefined ? {} : {
      calls: toolCounts.calls,
      records: toolCounts.records,
      tombstones: toolCounts.tombstones,
    }),
  };
  await rm(root, { recursive: true, force: true });
  return { root, removed: true, messageHistory, toolHistory };
}

/** Revoke every durable ACP session id associated with the configured responder. */
export async function purgeAcpSessionAuthorizations(
  input: MonoAgentAppConfigInput,
): Promise<PurgeAcpSessionAuthorizationsResult> {
  const root = (await resolveConversationStatePurgeRoots(input)).acpSessions;
  return await purgeAcpSessionAuthorizationsRoot(root);
}

async function purgeAcpSessionAuthorizationsRoot(
  root: string,
): Promise<PurgeAcpSessionAuthorizationsResult> {
  let files = 0;
  try {
    files = await countFilesWithSuffix(root, ".json");
  } catch (error) {
    if (isErrno(error, "ENOENT")) return { root, removed: false, files: 0 };
    throw error;
  }
  await rm(root, { recursive: true, force: true });
  return { root, removed: true, files };
}

/** Clear every persisted conversation-continuity store while preserving memory and run artifacts. */
export async function purgeConversationState(
  input: MonoAgentAppConfigInput,
): Promise<PurgeConversationStateResult> {
  // Validate before removing the first root so a newly edited config cannot
  // make clear-sessions erase or partially erase durable process-job state.
  await loadProcessJobsSettings(input);
  const roots = await resolveConversationStatePurgeRoots(input);
  const sessions = await purgeSessionsRoot(roots.sessions);
  const acpSessions = await purgeAcpSessionAuthorizationsRoot(roots.acpSessions);
  const history = await purgeConversationHistoryRoot(roots.history);
  return { sessions, history, acpSessions };
}

/** Recursively count `*.jsonl` session files under a sessions root. */
async function countSessionFiles(dir: string): Promise<number> {
  return await countFilesWithSuffix(dir, ".jsonl");
}

async function countFilesWithSuffix(dir: string, suffix: string): Promise<number> {
  const entries = await readdir(dir, { withFileTypes: true });
  let total = 0;
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      total += await countFilesWithSuffix(full, suffix);
    } else if (entry.isFile() && entry.name.endsWith(suffix)) {
      total += 1;
    }
  }
  return total;
}

async function countTopLevelFilesWithSuffix(
  dir: string,
  suffix: string,
): Promise<{ files: number; bytes: number }> {
  const entries = await readdir(dir, { withFileTypes: true });
  let files = 0;
  let bytes = 0;
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith(suffix)) continue;
    files += 1;
    bytes += (await stat(join(dir, entry.name))).size;
  }
  return { files, bytes };
}

async function optionalFileBytes(path: string): Promise<{ files: number; bytes: number }> {
  try {
    const info = await lstat(path);
    return info.isFile() && !info.isSymbolicLink() ? { files: 1, bytes: info.size } : { files: 0, bytes: 0 };
  } catch (error) {
    if (isErrno(error, "ENOENT")) return { files: 0, bytes: 0 };
    throw error;
  }
}

function isErrno(error: unknown, code: string): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
