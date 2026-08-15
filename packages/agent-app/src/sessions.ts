import { randomUUID } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { lstat, readdir, realpath, rename, rm, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, sep } from "node:path";

import {
  ToolHistoryReader,
  toolHistoryDiskUsage,
  TOOL_HISTORY_OWNER_DATABASE,
} from "@mono-agent/agent-harness";

import type { MonoAgentAppConfigInput } from "./app-config.js";
import {
  assertConversationStatePurgePlanUnchanged,
  assertConversationStatePurgeRootUnchanged,
  conversationStatePurgePlanEntries,
  type ConversationStatePurgePlan,
  type ResolvedConversationStatePurgeRoot,
  resolveAndAttestConversationStatePurgeRoot,
  resolveConversationStatePurgePlan,
  resolveConversationStatePurgeRoots,
  sameFileSystemIdentity,
} from "./conversation-state-roots.js";
import { syncDirectory } from "./continuation-store-fs.js";
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

export interface PurgeConversationStateOptions {
  /** @internal Deterministic race-test seam after every preflight validation and before any traversal. */
  readonly hooks?: {
    readonly afterValidation?: (plan: ConversationStatePurgePlan) => void | Promise<void>;
  };
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
  if (root === undefined) return { removed: false, files: 0 };
  return await purgeSessionsRoot(await resolveAndAttestConversationStatePurgeRoot("Pi provider sessions", root));
}

async function purgeSessionsRoot(
  root: ResolvedConversationStatePurgeRoot | undefined,
): Promise<PurgeSessionsResult> {
  const inspected = await inspectSessionsRoot(root);
  if (root?.target === undefined) return inspected;
  await securelyRemovePurgeRoots([root]);
  return inspected;
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
  return await purgeConversationHistoryRoot(
    await resolveAndAttestConversationStatePurgeRoot("durable session/tool history", root),
  );
}

async function purgeConversationHistoryRoot(
  root: ResolvedConversationStatePurgeRoot,
): Promise<PurgeConversationHistoryResult> {
  const inspected = await inspectConversationHistoryRoot(root);
  if (root.target === undefined) return inspected;
  await securelyRemovePurgeRoots([root]);
  return inspected;
}

async function inspectConversationHistoryRoot(
  root: ResolvedConversationStatePurgeRoot,
): Promise<PurgeConversationHistoryResult> {
  let messageHistory = { files: 0, bytes: 0 };
  if (root.target === undefined) {
    return {
      root: root.path,
      removed: false,
      messageHistory,
      toolHistory: { files: 0, bytes: 0, countsKnown: true, calls: 0, records: 0, tombstones: 0 },
    };
  }
  messageHistory = await countTopLevelFilesWithSuffix(root.path, ".history.json");
  const sidecarUsage = await toolHistoryDiskUsage(root.path);
  const ownerUsage = await optionalFileBytes(join(root.path, ".locks", TOOL_HISTORY_OWNER_DATABASE));
  let toolCounts: Pick<NonNullable<ReturnType<ToolHistoryReader["stats"]>>, "calls" | "records" | "tombstones"> | undefined;
  let countsKnown = true;
  try {
    const stats = new ToolHistoryReader(root.path).stats();
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
  return { root: root.path, removed: true, messageHistory, toolHistory };
}

/** Revoke every durable ACP session id associated with the configured responder. */
export async function purgeAcpSessionAuthorizations(
  input: MonoAgentAppConfigInput,
): Promise<PurgeAcpSessionAuthorizationsResult> {
  const root = (await resolveConversationStatePurgeRoots(input)).acpSessions;
  return await purgeAcpSessionAuthorizationsRoot(
    await resolveAndAttestConversationStatePurgeRoot("ACP sessions", root),
  );
}

async function purgeAcpSessionAuthorizationsRoot(
  root: ResolvedConversationStatePurgeRoot,
): Promise<PurgeAcpSessionAuthorizationsResult> {
  const inspected = await inspectAcpSessionAuthorizationsRoot(root);
  if (root.target === undefined) return inspected;
  await securelyRemovePurgeRoots([root]);
  return inspected;
}

/** Clear every persisted conversation-continuity store while preserving memory and run artifacts. */
export async function purgeConversationState(
  input: MonoAgentAppConfigInput,
  options: PurgeConversationStateOptions = {},
): Promise<PurgeConversationStateResult> {
  const plan = await resolveConversationStatePurgePlan(input);
  // A stale default store remains protected even after processJobs is removed
  // from config. Startup stays dormant; only this destructive path opts in.
  await loadProcessJobsSettings(input, {
    purgePlan: plan,
    validateDormantStateRoot: true,
  });
  assertPurgeRootsDisjoint(plan);
  await options.hooks?.afterValidation?.(plan);
  // Re-attest every target before counting so a detected swap cannot redirect
  // even read-only traversal, and again after counting before the first rename.
  await assertConversationStatePurgePlanUnchanged(plan);
  const [sessions, history, acpSessions] = await Promise.all([
    inspectSessionsRoot(plan.sessions),
    inspectConversationHistoryRoot(plan.history),
    inspectAcpSessionAuthorizationsRoot(plan.acpSessions),
  ]);
  await assertConversationStatePurgePlanUnchanged(plan);
  await securelyRemovePurgeRoots(
    conversationStatePurgePlanEntries(plan).filter((root) => root.target !== undefined),
  );
  return { sessions, history, acpSessions };
}

async function inspectSessionsRoot(
  root: ResolvedConversationStatePurgeRoot | undefined,
): Promise<PurgeSessionsResult> {
  if (root === undefined) return { removed: false, files: 0 };
  if (root.target === undefined) return { root: root.path, removed: false, files: 0 };
  return { root: root.path, removed: true, files: await countSessionFiles(root.path) };
}

async function inspectAcpSessionAuthorizationsRoot(
  root: ResolvedConversationStatePurgeRoot,
): Promise<PurgeAcpSessionAuthorizationsResult> {
  if (root.target === undefined) return { root: root.path, removed: false, files: 0 };
  return { root: root.path, removed: true, files: await countFilesWithSuffix(root.path, ".json") };
}

function assertPurgeRootsDisjoint(plan: ConversationStatePurgePlan): void {
  const roots = conversationStatePurgePlanEntries(plan);
  for (let first = 0; first < roots.length; first += 1) {
    for (let second = first + 1; second < roots.length; second += 1) {
      const left = roots[first]!;
      const right = roots[second]!;
      if (!pathsContainEachOther(left.canonicalPath, right.canonicalPath)) continue;
      throw new Error(
        `restart --clear-sessions purge roots must be disjoint; ${left.kind} and ${right.kind} overlap. No conversation state was deleted.`,
      );
    }
  }
}

interface QuarantinedPurgeRoot {
  readonly root: ResolvedConversationStatePurgeRoot;
  readonly path: string;
  readonly canonicalPath: string;
}

async function securelyRemovePurgeRoots(
  roots: readonly ResolvedConversationStatePurgeRoot[],
): Promise<void> {
  if (roots.length === 0) return;
  await Promise.all(roots.map(assertConversationStatePurgeRootUnchanged));
  const quarantined: QuarantinedPurgeRoot[] = [];
  try {
    for (const root of roots) {
      await assertConversationStatePurgeRootUnchanged(root);
      quarantined.push(await quarantinePurgeRoot(root));
    }
  } catch (error) {
    const rollbackErrors = await restoreQuarantinedRoots(quarantined);
    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        [error, ...rollbackErrors],
        "restart --clear-sessions quarantine failed and one or more exact roots could not be restored; no quarantined root was deleted.",
      );
    }
    throw error;
  }

  // Prove every quarantine before deleting the first one. An unexpected
  // replacement remains untouched, and no original lexical path is traversed.
  await Promise.all(quarantined.map(assertQuarantinedRootUnchanged));
  for (const value of quarantined) {
    await assertQuarantinedRootUnchanged(value);
    await rm(value.path, { recursive: true, force: false });
    await syncAndReattestParent(value.root);
  }
}

async function quarantinePurgeRoot(
  root: ResolvedConversationStatePurgeRoot,
): Promise<QuarantinedPurgeRoot> {
  if (root.target === undefined) throw new Error(`Cannot quarantine missing purge root: ${root.path}`);
  const name = `.${basename(root.path)}.clear-sessions-${String(process.pid)}-${randomUUID()}.quarantine`;
  const path = join(root.target.parent.path, name);
  const canonicalPath = join(root.target.parent.canonicalPath, name);
  await assertMissing(path, `restart --clear-sessions quarantine destination already exists: ${path}`);
  await rename(root.path, path);
  const quarantined = { root, path, canonicalPath };
  try {
    await assertQuarantinedRootUnchanged(quarantined);
    await syncAndReattestParent(root);
    return quarantined;
  } catch (error) {
    const rollbackErrors = await restoreQuarantinedRoots([quarantined]);
    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        [error, ...rollbackErrors],
        `restart --clear-sessions could not verify or restore quarantined ${root.kind}; it was not deleted.`,
      );
    }
    throw error;
  }
}

async function assertQuarantinedRootUnchanged(value: QuarantinedPurgeRoot): Promise<void> {
  const target = value.root.target;
  if (target === undefined) throw new Error(`Missing attestation for quarantined purge root: ${value.root.path}`);
  await assertParentUnchanged(value.root);
  const details = await lstat(value.path, { bigint: true });
  assertRealDirectory(details, value.path);
  if (!sameFileSystemIdentity(details, target.identity)) {
    throw new Error(`restart --clear-sessions quarantined ${value.root.kind} identity changed; the replacement was left untouched.`);
  }
  if (await realpath(value.path) !== value.canonicalPath) {
    throw new Error(`restart --clear-sessions quarantined ${value.root.kind} canonical path changed; the replacement was left untouched.`);
  }
}

async function syncAndReattestParent(root: ResolvedConversationStatePurgeRoot): Promise<void> {
  const parent = root.target?.parent;
  if (parent === undefined) throw new Error(`Missing parent attestation for purge root: ${root.path}`);
  await assertParentUnchanged(root);
  await syncDirectory(parent.path);
  await assertParentUnchanged(root);
}

async function assertParentUnchanged(root: ResolvedConversationStatePurgeRoot): Promise<void> {
  const parent = root.target?.parent;
  if (parent === undefined) throw new Error(`Missing parent attestation for purge root: ${root.path}`);
  const details = await lstat(parent.path, { bigint: true });
  assertRealDirectory(details, parent.path);
  if (!sameFileSystemIdentity(details, parent.identity) || await realpath(parent.path) !== parent.canonicalPath) {
    throw new Error(`restart --clear-sessions ${root.kind} parent identity or canonical path changed; no replacement was deleted.`);
  }
}

async function restoreQuarantinedRoots(
  roots: readonly QuarantinedPurgeRoot[],
): Promise<unknown[]> {
  const errors: unknown[] = [];
  for (const value of [...roots].reverse()) {
    try {
      await assertQuarantinedRootUnchanged(value);
      await assertMissing(
        value.root.path,
        `restart --clear-sessions cannot restore ${value.root.kind} because its original path was replaced.`,
      );
      await rename(value.path, value.root.path);
      await assertConversationStatePurgeRootUnchanged(value.root);
      await syncAndReattestParent(value.root);
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
}

async function assertMissing(path: string, message: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return;
    throw error;
  }
  throw new Error(message);
}

function assertRealDirectory(details: BigIntStats, path: string): void {
  if (!details.isDirectory() || details.isSymbolicLink()) {
    throw new Error(`restart --clear-sessions refuses a non-directory or symbolic-link purge target: ${path}`);
  }
}

function pathsContainEachOther(first: string, second: string): boolean {
  return pathContains(first, second) || pathContains(second, first);
}

function pathContains(parent: string, child: string): boolean {
  const candidate = relative(parent, child);
  return candidate.length === 0
    || (candidate !== ".." && !candidate.startsWith(`..${sep}`) && !isAbsolute(candidate));
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
