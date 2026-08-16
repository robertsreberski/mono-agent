import { randomUUID } from "node:crypto";
import { constants as fsConstants, type BigIntStats, type Dirent } from "node:fs";
import { lstat, mkdir, open, opendir, readdir, realpath, rename, rm, stat, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  ToolHistoryReader,
  toolHistoryDiskUsage,
  TOOL_HISTORY_OWNER_DATABASE,
} from "@mono-agent/agent-harness";

import type { MonoAgentAppConfigInput } from "./app-config.js";
import {
  assertConversationStatePurgePlanUnchanged,
  assertConversationStatePurgeRootUnchanged,
  CLEAR_SESSIONS_CONTROL_DIRECTORY,
  clearSessionsRegistryRoot as resolveClearSessionsRegistryRoot,
  conversationStatePurgePlanEntries,
  type ConversationStatePurgePlan,
  type ConversationStatePurgeRoots,
  type ResolvedConversationStatePurgeRoot,
  resolveAndAttestConversationStatePurgeRoot,
  resolveConversationStatePurgePlan,
  resolveConversationStatePurgeRoots,
  sameFileSystemIdentity,
} from "./conversation-state-roots.js";
import { syncDirectory } from "./continuation-store-fs.js";
import {
  assertProcessJobsConfigSnapshotUnchanged,
  loadProcessJobsSettings,
  readProcessJobsConfigSnapshot,
  resolveProcessJobsRegistryWorkspace,
  type ProcessJobsConfigSnapshot,
} from "./process-jobs-config.js";
import {
  assertProcessJobsRegistryDisjointFromPaths,
  freezeProcessJobsRootRegistry,
  type ProcessJobsRootRegistryFreeze,
} from "./process-jobs-root-registry.js";

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
    /** Simulate process death after the manifest is durable but before the root rename. */
    readonly afterManifestPublished?: (path: string) => void | Promise<void>;
    /** Simulate process death after the durable manifest and quarantine rename. */
    readonly afterRootQuarantined?: (path: string) => void | Promise<void>;
    /** Simulate process death after quarantine deletion but before manifest removal. */
    readonly afterQuarantineRemoved?: (path: string) => void | Promise<void>;
    /** Race seam immediately before the final quarantine identity proof. */
    readonly beforeQuarantineRemoval?: (path: string) => void | Promise<void>;
  };
}

interface ClearSessionsDestructiveProtection {
  readonly registry: AttestedPrivateDirectory;
  readonly processRegistry: ProcessJobsRootRegistryFreeze;
}

interface CurrentConversationStateRoots {
  readonly snapshot: ProcessJobsConfigSnapshot;
  readonly workspace: string;
  readonly roots: ConversationStatePurgeRoots;
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
  return await withClearSessionsDestructiveProtection(input.cwd, async (protection) => {
    const current = await resolveCurrentConversationStateRoots(input);
    const root = current.roots.sessions === undefined
      ? undefined
      : await resolveAndAttestConversationStatePurgeRoot(
          "Pi provider sessions",
          current.roots.sessions,
        );
    return await purgeSessionsRoot(root, protection, current);
  });
}

async function purgeSessionsRoot(
  root: ResolvedConversationStatePurgeRoot | undefined,
  protection: ClearSessionsDestructiveProtection,
  current: CurrentConversationStateRoots,
): Promise<PurgeSessionsResult> {
  const roots = root === undefined ? [] : [root];
  await assertStandalonePurgeProtected(protection, current, roots);
  const inspected = await inspectSessionsRoot(root);
  await securelyRemoveStandaloneRoots(
    protection.registry,
    roots.filter((candidate) => candidate.target !== undefined),
    async () => await assertStandalonePurgeProtected(protection, current, roots),
  );
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
  return await withClearSessionsDestructiveProtection(input.cwd, async (protection) => {
    const current = await resolveCurrentConversationStateRoots(input);
    const root = await resolveAndAttestConversationStatePurgeRoot(
      "durable session/tool history",
      current.roots.history,
    );
    return await purgeConversationHistoryRoot(root, protection, current);
  });
}

async function purgeConversationHistoryRoot(
  root: ResolvedConversationStatePurgeRoot,
  protection: ClearSessionsDestructiveProtection,
  current: CurrentConversationStateRoots,
): Promise<PurgeConversationHistoryResult> {
  await assertStandalonePurgeProtected(protection, current, [root]);
  const inspected = await inspectConversationHistoryRoot(root);
  await securelyRemoveStandaloneRoots(
    protection.registry,
    root.target === undefined ? [] : [root],
    async () => await assertStandalonePurgeProtected(protection, current, [root]),
  );
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
  return await withClearSessionsDestructiveProtection(input.cwd, async (protection) => {
    const current = await resolveCurrentConversationStateRoots(input);
    const root = await resolveAndAttestConversationStatePurgeRoot(
      "ACP sessions",
      current.roots.acpSessions,
    );
    return await purgeAcpSessionAuthorizationsRoot(root, protection, current);
  });
}

async function purgeAcpSessionAuthorizationsRoot(
  root: ResolvedConversationStatePurgeRoot,
  protection: ClearSessionsDestructiveProtection,
  current: CurrentConversationStateRoots,
): Promise<PurgeAcpSessionAuthorizationsResult> {
  await assertStandalonePurgeProtected(protection, current, [root]);
  const inspected = await inspectAcpSessionAuthorizationsRoot(root);
  await securelyRemoveStandaloneRoots(
    protection.registry,
    root.target === undefined ? [] : [root],
    async () => await assertStandalonePurgeProtected(protection, current, [root]),
  );
  return inspected;
}

/** Clear every persisted conversation-continuity store while preserving memory and run artifacts. */
export async function purgeConversationState(
  input: MonoAgentAppConfigInput,
  options: PurgeConversationStateOptions = {},
): Promise<PurgeConversationStateResult> {
  return await withClearSessionsDestructiveProtection(input.cwd, async (protection) => {
    const snapshot = await readProcessJobsConfigSnapshot(input);
    const frozenInput = { ...input, env: { ...snapshot.env } };
    const workspace = resolveProcessJobsRegistryWorkspace(snapshot, input.cwd);
    const plan = await resolveConversationStatePurgePlan(frozenInput, snapshot);
    // A stale default store remains protected even after processJobs is removed
    // from config. Startup stays dormant; only this destructive path opts in.
    const processJobs = await loadProcessJobsSettings(frozenInput, {
      purgePlan: plan,
      validateDormantStateRoot: true,
      snapshot,
    });
    await assertProcessJobsConfigSnapshotUnchanged(snapshot);
    assertPurgeRootsDisjoint(plan);
    assertRegistryPathDisjoint(clearSessionsRegistryRoot(frozenInput.cwd), plan, processJobs.stateDir);
    await assertRegistryDisjoint(protection.registry, plan, processJobs.stateDir);
    const purgeEntries = conversationStatePurgePlanEntries(plan);
    const attestedProcessRegistry = await protection.processRegistry.reattest(workspace);
    assertProcessJobsRegistryDisjointFromPaths(
      attestedProcessRegistry,
      clearSessionsDestructivePaths(protection.registry, purgeEntries),
    );
    await options.hooks?.afterValidation?.(plan);
    // Re-attest every target before counting so a detected swap cannot redirect
    // even read-only traversal, and again after counting before the first rename.
    const preInspectionRegistry = await protection.processRegistry.reattest(workspace);
    assertProcessJobsRegistryDisjointFromPaths(
      preInspectionRegistry,
      clearSessionsDestructivePaths(protection.registry, purgeEntries),
    );
    await Promise.all([
      assertProcessJobsConfigSnapshotUnchanged(snapshot),
      assertConversationStatePurgePlanUnchanged(plan),
    ]);
    const [sessions, history, acpSessions] = await Promise.all([
      inspectSessionsRoot(plan.sessions),
      inspectConversationHistoryRoot(plan.history),
      inspectAcpSessionAuthorizationsRoot(plan.acpSessions),
    ]);
    await Promise.all([
      assertProcessJobsConfigSnapshotUnchanged(snapshot),
      assertConversationStatePurgePlanUnchanged(plan),
    ]);
    await securelyRemovePurgeRoots(
      purgeEntries.filter((root) => root.target !== undefined),
      protection.registry,
      options,
      async () => {
        const currentRegistry = await protection.processRegistry.reattest(workspace);
        assertProcessJobsRegistryDisjointFromPaths(
          currentRegistry,
          clearSessionsDestructivePaths(protection.registry, purgeEntries),
        );
        await Promise.all([
          assertProcessJobsConfigSnapshotUnchanged(snapshot),
          assertConversationStatePurgePlanUnchanged(plan),
        ]);
      },
    );
    return { sessions, history, acpSessions };
  });
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

const CLEAR_SESSIONS_MANIFEST_SCHEMA = "mono-agent.clear-sessions-manifest.v1";
const MAX_CLEAR_SESSIONS_MANIFESTS = 16;
const MAX_CLEAR_SESSIONS_CONTROL_ENTRIES = 32;
const MAX_CLEAR_SESSIONS_MANIFEST_BYTES = 8 * 1024;
const MANIFEST_NAME = /^manifest-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.json$/u;
const TEMP_MANIFEST_NAME = /^\.manifest-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.tmp$/u;
const QUARANTINE_NAME = /^([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.quarantine$/u;

interface AttestedPrivateDirectory {
  readonly path: string;
  readonly canonicalPath: string;
  readonly identity: { readonly dev: bigint; readonly ino: bigint };
}

interface ClearSessionsManifest {
  readonly schema: typeof CLEAR_SESSIONS_MANIFEST_SCHEMA;
  readonly id: string;
  readonly kind: ResolvedConversationStatePurgeRoot["kind"];
  readonly originalPath: string;
  readonly originalCanonicalPath: string;
  readonly originalIdentity: WireIdentity;
  readonly originalParentPath: string;
  readonly originalParentCanonicalPath: string;
  readonly originalParentIdentity: WireIdentity;
  readonly controlPath: string;
  readonly controlCanonicalPath: string;
  readonly controlIdentity: WireIdentity;
  readonly quarantinePath: string;
  readonly quarantineCanonicalPath: string;
}

interface WireIdentity { readonly dev: string; readonly ino: string }

interface QuarantinedPurgeRoot {
  readonly root: ResolvedConversationStatePurgeRoot;
  readonly registry: AttestedPrivateDirectory;
  readonly control: AttestedPrivateDirectory;
  readonly path: string;
  readonly canonicalPath: string;
  readonly manifestPath: string;
  readonly manifestIdentity: { readonly dev: bigint; readonly ino: bigint };
}

/** Stable model-private registry root used by the sandbox recovery guard. */
export function clearSessionsRegistryRoot(cwd: string): string {
  return resolveClearSessionsRegistryRoot(cwd);
}

/** Generic, path-free model boundary: any pending or unsafe recovery state blocks execution. */
export async function assertClearSessionsRecoveryResolved(cwd: string): Promise<void> {
  try {
    const path = clearSessionsRegistryRoot(cwd);
    let registry: AttestedPrivateDirectory;
    try {
      registry = await attestStableRegistry(cwd);
    } catch (error) {
      if (isErrno(error, "ENOENT")) return;
      throw error;
    }
    const entries = await boundedDirectoryEntries(registry.path, MAX_CLEAR_SESSIONS_MANIFESTS);
    await assertPrivateDirectoryUnchanged(registry, "clear-sessions registry");
    if (entries.length !== 0) throw new Error("pending");
  } catch {
    throw new Error("Clear-sessions recovery is unresolved; run restart --clear-sessions before model execution.");
  }
}

async function securelyRemoveStandaloneRoots(
  registry: AttestedPrivateDirectory,
  roots: readonly ResolvedConversationStatePurgeRoot[],
  beforeFirstRename: () => Promise<void>,
): Promise<void> {
  for (const root of roots) {
    if (pathsContainEachOther(registry.canonicalPath, root.canonicalPath)) {
      throw new Error("Clear-sessions registry must be disjoint from every purge root.");
    }
  }
  await securelyRemovePurgeRoots(roots, registry, {}, beforeFirstRename);
}

async function resolveCurrentConversationStateRoots(
  input: MonoAgentAppConfigInput,
): Promise<CurrentConversationStateRoots> {
  const snapshot = await readProcessJobsConfigSnapshot(input);
  const frozenInput = { ...input, env: { ...snapshot.env } };
  const workspace = resolveProcessJobsRegistryWorkspace(snapshot, input.cwd);
  const roots = await resolveConversationStatePurgeRoots(frozenInput, snapshot);
  return { snapshot, workspace, roots };
}

async function assertStandalonePurgeProtected(
  protection: ClearSessionsDestructiveProtection,
  current: CurrentConversationStateRoots,
  roots: readonly ResolvedConversationStatePurgeRoot[],
): Promise<void> {
  assertClearSessionsRegistryDisjointFromRoots(protection.registry, roots);
  const processRegistry = await protection.processRegistry.reattest(current.workspace);
  await Promise.all([
    assertProcessJobsConfigSnapshotUnchanged(current.snapshot),
    ...roots.map(assertConversationStatePurgeRootUnchanged),
  ]);
  assertProcessJobsRegistryDisjointFromPaths(
    processRegistry,
    clearSessionsDestructivePaths(protection.registry, roots),
  );
}

function assertClearSessionsRegistryDisjointFromRoots(
  registry: AttestedPrivateDirectory,
  roots: readonly ResolvedConversationStatePurgeRoot[],
): void {
  for (const root of roots) {
    if ([registry.path, registry.canonicalPath].some((registryPath) =>
      [root.path, root.canonicalPath].some((rootPath) =>
        pathsContainEachOther(registryPath, rootPath)))) {
      throw new Error("Clear-sessions registry must be disjoint from every purge root.");
    }
  }
}

function clearSessionsDestructivePaths(
  registry: AttestedPrivateDirectory,
  roots: readonly ResolvedConversationStatePurgeRoot[],
): readonly string[] {
  return [
    registry.path,
    registry.canonicalPath,
    ...roots.flatMap((root) => [
      root.path,
      root.canonicalPath,
      join(root.parent?.path ?? dirname(root.path), CLEAR_SESSIONS_CONTROL_DIRECTORY),
      join(root.parent?.canonicalPath ?? dirname(root.canonicalPath), CLEAR_SESSIONS_CONTROL_DIRECTORY),
    ]),
  ];
}

async function withClearSessionsDestructiveProtection<T>(
  cwd: string,
  run: (protection: ClearSessionsDestructiveProtection) => Promise<T>,
): Promise<T> {
  const protection = await prepareClearSessionsRecovery(cwd);
  try {
    return await run(protection);
  } finally {
    await protection.processRegistry.release().catch(() => undefined);
  }
}

async function prepareClearSessionsRecovery(
  cwd: string,
): Promise<ClearSessionsDestructiveProtection> {
  // Recovery cannot depend on the current config: an invalid replacement must
  // not strand an older durable quarantine. The canonical agent root is a
  // structural workspace that safely validates every registered descendant.
  const structuralWorkspace = await realpath(resolve(cwd));
  const processRegistry = await freezeProcessJobsRootRegistry(cwd, structuralWorkspace);
  try {
    const registry = await ensureClearSessionsRegistry(cwd);
    const pendingRecoveryPaths = await inspectClearSessionsRecoveryPaths(registry);
    const attestedProcessRegistry = await processRegistry.reattest(structuralWorkspace);
    assertProcessJobsRegistryDisjointFromPaths(attestedProcessRegistry, pendingRecoveryPaths);
    await reconcileClearSessionsRecovery(registry);
    return { registry, processRegistry };
  } catch (error) {
    await processRegistry.release().catch(() => undefined);
    throw error;
  }
}

/** Read every pending destructive/control path without mutating recovery state. */
async function inspectClearSessionsRecoveryPaths(
  registry: AttestedPrivateDirectory,
): Promise<readonly string[]> {
  const entries = await boundedDirectoryEntries(registry.path, MAX_CLEAR_SESSIONS_MANIFESTS);
  const paths = [registry.path, registry.canonicalPath];
  for (const entry of entries) {
    if (TEMP_MANIFEST_NAME.test(entry.name)) {
      if (!entry.isFile() || entry.isSymbolicLink()) {
        throw new Error("Clear-sessions registry contains an unsafe temporary manifest.");
      }
      continue;
    }
    if (!entry.isFile() || entry.isSymbolicLink() || !MANIFEST_NAME.test(entry.name)) {
      throw new Error("Clear-sessions registry contains an unsupported entry; recovery remains unresolved.");
    }
    const manifest = (await readManifest(registry, entry.name)).value;
    paths.push(
      manifest.originalPath,
      manifest.originalCanonicalPath,
      manifest.originalParentPath,
      manifest.originalParentCanonicalPath,
      manifest.controlPath,
      manifest.controlCanonicalPath,
      manifest.quarantinePath,
      manifest.quarantineCanonicalPath,
    );
  }
  await assertPrivateDirectoryUnchanged(registry, "clear-sessions registry");
  return paths;
}

async function securelyRemovePurgeRoots(
  roots: readonly ResolvedConversationStatePurgeRoot[],
  registry: AttestedPrivateDirectory,
  options: PurgeConversationStateOptions,
  beforeFirstRename?: () => Promise<void>,
): Promise<void> {
  if (roots.length === 0) return;
  await Promise.all(roots.map(assertConversationStatePurgeRootUnchanged));
  const quarantined: QuarantinedPurgeRoot[] = [];
  for (const [index, root] of roots.entries()) {
    await assertConversationStatePurgeRootUnchanged(root);
    const value = await quarantinePurgeRoot(
      root,
      registry,
      index === 0 ? beforeFirstRename : undefined,
      options.hooks?.afterManifestPublished,
    );
    quarantined.push(value);
    await options.hooks?.afterRootQuarantined?.(value.path);
  }

  await Promise.all(quarantined.map(assertQuarantinedRootUnchanged));
  for (const value of quarantined) {
    await options.hooks?.beforeQuarantineRemoval?.(value.path);
    await assertQuarantinedRootUnchanged(value);
    // The owner-private control directory is protected from model tools, and
    // same-UID ambient OS processes are outside this deletion boundary.
    await rm(value.path, { recursive: true, force: false });
    await syncAndReattestPrivateDirectory(value.control, "clear-sessions control directory");
    await options.hooks?.afterQuarantineRemoved?.(value.path);
    await removeManifest(value);
  }
}

async function quarantinePurgeRoot(
  root: ResolvedConversationStatePurgeRoot,
  registry: AttestedPrivateDirectory,
  beforeRename?: () => Promise<void>,
  afterManifestPublished?: (path: string) => void | Promise<void>,
): Promise<QuarantinedPurgeRoot> {
  const target = root.target;
  if (target === undefined) throw new Error(`Cannot quarantine missing purge root: ${root.path}`);
  const control = await ensurePrivateDirectory(
    join(target.parent.path, CLEAR_SESSIONS_CONTROL_DIRECTORY),
    "clear-sessions control directory",
  );
  if (pathsContainEachOther(control.canonicalPath, root.canonicalPath)) {
    throw new Error("Clear-sessions control directory must be disjoint from its purge root.");
  }
  const id = randomUUID();
  const quarantinePath = join(control.path, `${id}.quarantine`);
  const quarantineCanonicalPath = join(control.canonicalPath, `${id}.quarantine`);
  const manifestPath = join(registry.path, `manifest-${id}.json`);
  const temporaryManifestPath = join(registry.path, `.manifest-${id}.tmp`);
  await Promise.all([
    assertMissing(quarantinePath, "Clear-sessions quarantine destination already exists."),
    assertMissing(manifestPath, "Clear-sessions manifest destination already exists."),
    assertMissing(temporaryManifestPath, "Clear-sessions temporary manifest destination already exists."),
  ]);
  const manifest: ClearSessionsManifest = {
    schema: CLEAR_SESSIONS_MANIFEST_SCHEMA,
    id,
    kind: root.kind,
    originalPath: root.path,
    originalCanonicalPath: root.canonicalPath,
    originalIdentity: wireIdentity(target.identity),
    originalParentPath: target.parent.path,
    originalParentCanonicalPath: target.parent.canonicalPath,
    originalParentIdentity: wireIdentity(target.parent.identity),
    controlPath: control.path,
    controlCanonicalPath: control.canonicalPath,
    controlIdentity: wireIdentity(control.identity),
    quarantinePath,
    quarantineCanonicalPath,
  };
  const manifestIdentity = await writeManifest(
    registry,
    temporaryManifestPath,
    manifestPath,
    manifest,
  );
  await afterManifestPublished?.(manifestPath);
  await Promise.all([
    assertConversationStatePurgeRootUnchanged(root),
    assertPrivateDirectoryUnchanged(control, "clear-sessions control directory"),
    assertPrivateDirectoryUnchanged(registry, "clear-sessions registry"),
  ]);
  await beforeRename?.();
  await rename(root.path, quarantinePath);
  const quarantined = {
    root,
    registry,
    control,
    path: quarantinePath,
    canonicalPath: quarantineCanonicalPath,
    manifestPath,
    manifestIdentity,
  };
  await assertQuarantinedRootUnchanged(quarantined);
  await syncAndReattestParent(root);
  await syncAndReattestPrivateDirectory(control, "clear-sessions control directory");
  return quarantined;
}

async function assertQuarantinedRootUnchanged(value: QuarantinedPurgeRoot): Promise<void> {
  const target = value.root.target;
  if (target === undefined) throw new Error(`Missing attestation for quarantined purge root: ${value.root.path}`);
  await Promise.all([
    assertParentUnchanged(value.root),
    assertPrivateDirectoryUnchanged(value.control, "clear-sessions control directory"),
    assertPrivateDirectoryUnchanged(value.registry, "clear-sessions registry"),
  ]);
  const details = await lstat(value.path, { bigint: true });
  assertRealDirectory(details, value.path);
  if (!sameFileSystemIdentity(details, target.identity) || await realpath(value.path) !== value.canonicalPath) {
    throw new Error(`restart --clear-sessions quarantined ${value.root.kind} changed; the replacement was left untouched.`);
  }
}

async function removeManifest(value: QuarantinedPurgeRoot): Promise<void> {
  await assertPrivateDirectoryUnchanged(value.registry, "clear-sessions registry");
  const details = await lstat(value.manifestPath, { bigint: true });
  assertPrivateFile(details, "clear-sessions manifest");
  if (!sameFileSystemIdentity(details, value.manifestIdentity)) {
    throw new Error("Clear-sessions manifest identity changed; recovery remains unresolved.");
  }
  await unlink(value.manifestPath);
  await syncAndReattestPrivateDirectory(value.registry, "clear-sessions registry");
}

async function syncAndReattestParent(root: ResolvedConversationStatePurgeRoot): Promise<void> {
  const parent = root.target?.parent;
  if (parent === undefined) throw new Error(`Missing parent attestation for purge root: ${root.path}`);
  await assertParentUnchanged(root);
  await syncDirectory(parent.path);
  await assertParentUnchanged(root);
}

async function assertParentUnchanged(root: ResolvedConversationStatePurgeRoot): Promise<void> {
  const parent = root.target?.parent ?? root.parent;
  if (parent === undefined) throw new Error(`Missing parent attestation for purge root: ${root.path}`);
  const details = await lstat(parent.path, { bigint: true });
  assertSecureContainingDirectory(details, parent.path);
  if (!sameFileSystemIdentity(details, parent.identity) || await realpath(parent.path) !== parent.canonicalPath) {
    throw new Error(`restart --clear-sessions ${root.kind} parent identity or canonical path changed; no replacement was deleted.`);
  }
}

async function ensureClearSessionsRegistry(cwd: string): Promise<AttestedPrivateDirectory> {
  await ensureClearSessionsRegistryParent(cwd);
  await ensurePrivateDirectory(clearSessionsRegistryRoot(cwd), "clear-sessions registry");
  return await attestStableRegistry(cwd);
}

async function ensureClearSessionsRegistryParent(cwd: string): Promise<void> {
  const agentRoot = resolve(cwd);
  const monoAgentRoot = dirname(clearSessionsRegistryRoot(cwd));
  await ensureDirectoryUnderSecureParent(agentRoot, monoAgentRoot, ".mono-agent state directory", false);
}

async function attestStableRegistry(cwd: string): Promise<AttestedPrivateDirectory> {
  const agentRoot = await attestDirectory(resolve(cwd), "agent root", false);
  const monoAgentRoot = await attestDirectory(dirname(clearSessionsRegistryRoot(cwd)), ".mono-agent state directory", false);
  const registry = await attestPrivateDirectory(clearSessionsRegistryRoot(cwd), "clear-sessions registry");
  if (dirname(monoAgentRoot.canonicalPath) !== agentRoot.canonicalPath
    || dirname(registry.canonicalPath) !== monoAgentRoot.canonicalPath) {
    throw new Error("Clear-sessions registry escaped its attested agent root.");
  }
  return registry;
}

async function ensureDirectoryUnderSecureParent(
  parent: string,
  path: string,
  label: string,
  ownerPrivate: boolean,
): Promise<AttestedPrivateDirectory> {
  const parentBefore = await lstat(parent, { bigint: true });
  assertSecureContainingDirectory(parentBefore, parent);
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if (!isErrno(error, "EEXIST")) throw error;
  }
  const parentAfter = await lstat(parent, { bigint: true });
  assertSecureContainingDirectory(parentAfter, parent);
  if (!sameFileSystemIdentity(parentBefore, parentAfter)) throw new Error(`${label} parent changed during creation.`);
  return await attestDirectory(path, label, ownerPrivate);
}

async function ensurePrivateDirectory(path: string, label: string): Promise<AttestedPrivateDirectory> {
  return await ensureDirectoryUnderSecureParent(dirname(path), path, label, true);
}

async function attestPrivateDirectory(path: string, label: string): Promise<AttestedPrivateDirectory> {
  return await attestDirectory(path, label, true);
}

async function attestDirectory(
  path: string,
  label: string,
  ownerPrivate: boolean,
): Promise<AttestedPrivateDirectory> {
  const initial = await lstat(path, { bigint: true });
  assertSecureContainingDirectory(initial, path);
  if (ownerPrivate && (initial.mode & 0o077n) !== 0n) throw new Error(`${label} must be owner-only.`);
  const canonicalPath = await realpath(path);
  const current = await lstat(path, { bigint: true });
  assertSecureContainingDirectory(current, path);
  if (!sameFileSystemIdentity(initial, current)) throw new Error(`${label} identity changed during attestation.`);
  return { path, canonicalPath, identity: { dev: initial.dev, ino: initial.ino } };
}

async function assertPrivateDirectoryUnchanged(value: AttestedPrivateDirectory, label: string): Promise<void> {
  const current = await attestPrivateDirectory(value.path, label);
  if (current.canonicalPath !== value.canonicalPath || !sameFileSystemIdentity(current.identity, value.identity)) {
    throw new Error(`${label} identity or canonical path changed.`);
  }
}

async function syncAndReattestPrivateDirectory(value: AttestedPrivateDirectory, label: string): Promise<void> {
  await assertPrivateDirectoryUnchanged(value, label);
  await syncDirectory(value.path);
  await assertPrivateDirectoryUnchanged(value, label);
}

async function writeManifest(
  registry: AttestedPrivateDirectory,
  temporaryPath: string,
  path: string,
  manifest: ClearSessionsManifest,
): Promise<{ readonly dev: bigint; readonly ino: bigint }> {
  const body = `${JSON.stringify(manifest)}\n`;
  if (Buffer.byteLength(body) > MAX_CLEAR_SESSIONS_MANIFEST_BYTES) throw new Error("Clear-sessions manifest is too large.");
  await assertPrivateDirectoryUnchanged(registry, "clear-sessions registry");
  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(body, "utf8");
    await handle.sync();
    const details = await handle.stat({ bigint: true });
    assertPrivateFile(details, "clear-sessions manifest");
    const named = await lstat(temporaryPath, { bigint: true });
    assertPrivateFile(named, "clear-sessions manifest");
    if (!sameFileSystemIdentity(details, named)) throw new Error("Clear-sessions manifest changed during publication.");
    await rename(temporaryPath, path);
    const published = await lstat(path, { bigint: true });
    assertPrivateFile(published, "clear-sessions manifest");
    if (!sameFileSystemIdentity(details, published)) throw new Error("Clear-sessions manifest changed during publication.");
    await syncAndReattestPrivateDirectory(registry, "clear-sessions registry");
    return { dev: details.dev, ino: details.ino };
  } finally {
    await handle.close();
  }
}

interface LoadedManifest {
  readonly value: ClearSessionsManifest;
  readonly path: string;
  readonly identity: { readonly dev: bigint; readonly ino: bigint };
}

async function reconcileClearSessionsRecovery(registry: AttestedPrivateDirectory): Promise<void> {
  const entries = await boundedDirectoryEntries(registry.path, MAX_CLEAR_SESSIONS_MANIFESTS);
  const temporaryEntries = entries.filter((entry) => TEMP_MANIFEST_NAME.test(entry.name));
  for (const entry of temporaryEntries) {
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error("Clear-sessions registry contains an unsafe temporary manifest.");
    const path = join(registry.path, entry.name);
    const details = await lstat(path, { bigint: true });
    assertPrivateFile(details, "clear-sessions temporary manifest");
    await unlink(path);
    await syncAndReattestPrivateDirectory(registry, "clear-sessions registry");
  }
  const manifestEntries = entries.filter((entry) => !TEMP_MANIFEST_NAME.test(entry.name));
  const loaded = await Promise.all(manifestEntries.map(async (entry) => {
    if (!entry.isFile() || entry.isSymbolicLink() || !MANIFEST_NAME.test(entry.name)) {
      throw new Error("Clear-sessions registry contains an unsupported entry; recovery remains unresolved.");
    }
    return await readManifest(registry, entry.name);
  }));
  const ids = new Set<string>();
  for (const manifest of loaded) {
    if (ids.has(manifest.value.id)) throw new Error("Clear-sessions registry contains a duplicate manifest.");
    ids.add(manifest.value.id);
  }
  await Promise.all(loaded.map((manifest) => validateRecoveryManifest(manifest.value)));
  await validateRecoveryControls(loaded);
  for (const manifest of loaded) await reconcileManifest(registry, manifest);
  const remaining = await boundedDirectoryEntries(registry.path, MAX_CLEAR_SESSIONS_MANIFESTS);
  if (remaining.length !== 0) throw new Error("Clear-sessions recovery did not settle every manifest.");
  await syncAndReattestPrivateDirectory(registry, "clear-sessions registry");
}

async function validateRecoveryManifest(manifest: ClearSessionsManifest): Promise<void> {
  await attestManifestControl(manifest);
  const [original, quarantined] = await Promise.all([
    optionalLstat(manifest.originalPath),
    optionalLstat(manifest.quarantinePath),
  ]);
  if (original !== undefined && quarantined !== undefined) {
    throw new Error("Clear-sessions recovery found both original and quarantine targets; neither was deleted.");
  }
  if (quarantined !== undefined) {
    assertRealDirectory(quarantined, manifest.quarantinePath);
    if (!sameWireIdentity(quarantined, manifest.originalIdentity)
      || await realpath(manifest.quarantinePath) !== manifest.quarantineCanonicalPath) {
      throw new Error("Clear-sessions quarantine identity changed; the replacement was left untouched.");
    }
    return;
  }
  if (original !== undefined) {
    assertRealDirectory(original, manifest.originalPath);
    if (!sameWireIdentity(original, manifest.originalIdentity)
      || await realpath(manifest.originalPath) !== manifest.originalCanonicalPath) {
      throw new Error("Clear-sessions original target changed while recovery was pending; it was left untouched.");
    }
  }
}

async function validateRecoveryControls(manifests: readonly LoadedManifest[]): Promise<void> {
  const byControl = new Map<string, LoadedManifest[]>();
  for (const manifest of manifests) {
    const values = byControl.get(manifest.value.controlPath) ?? [];
    values.push(manifest);
    byControl.set(manifest.value.controlPath, values);
  }
  for (const [path, values] of byControl) {
    const control = await attestManifestControl(values[0]!.value);
    const entries = await boundedDirectoryEntries(path, MAX_CLEAR_SESSIONS_CONTROL_ENTRIES);
    const expected = new Set(values.map((value) => `${value.value.id}.quarantine`));
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()
        || !QUARANTINE_NAME.test(entry.name) || !expected.has(entry.name)) {
        throw new Error("Clear-sessions control directory contains an unattested entry; recovery remains unresolved.");
      }
    }
    await assertPrivateDirectoryUnchanged(control, "clear-sessions control directory");
  }
}

async function reconcileManifest(
  registry: AttestedPrivateDirectory,
  loaded: LoadedManifest,
): Promise<void> {
  const manifest = loaded.value;
  const control = await attestManifestControl(manifest);
  const original = await optionalLstat(manifest.originalPath);
  const quarantined = await optionalLstat(manifest.quarantinePath);
  if (quarantined !== undefined) {
    if (original !== undefined) {
      throw new Error("Clear-sessions recovery found both original and quarantine targets; neither was deleted.");
    }
    assertRealDirectory(quarantined, manifest.quarantinePath);
    if (!sameWireIdentity(quarantined, manifest.originalIdentity)
      || await realpath(manifest.quarantinePath) !== manifest.quarantineCanonicalPath) {
      throw new Error("Clear-sessions quarantine identity changed; the replacement was left untouched.");
    }
    await assertPrivateDirectoryUnchanged(control, "clear-sessions control directory");
    await rm(manifest.quarantinePath, { recursive: true, force: false });
    await syncAndReattestPrivateDirectory(control, "clear-sessions control directory");
  } else if (original !== undefined) {
    assertRealDirectory(original, manifest.originalPath);
    if (!sameWireIdentity(original, manifest.originalIdentity)
      || await realpath(manifest.originalPath) !== manifest.originalCanonicalPath) {
      throw new Error("Clear-sessions original target changed while recovery was pending; it was left untouched.");
    }
  }
  await removeLoadedManifest(registry, loaded);
}

async function readManifest(
  registry: AttestedPrivateDirectory,
  name: string,
): Promise<LoadedManifest> {
  const match = MANIFEST_NAME.exec(name);
  if (match === null) throw new Error("Clear-sessions manifest name is invalid.");
  const path = join(registry.path, name);
  await assertPrivateDirectoryUnchanged(registry, "clear-sessions registry");
  const handle = await open(
    path,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0),
  );
  try {
    const before = await handle.stat({ bigint: true });
    assertPrivateFile(before, "clear-sessions manifest");
    if (before.size > BigInt(MAX_CLEAR_SESSIONS_MANIFEST_BYTES)) throw new Error("Clear-sessions manifest is too large.");
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    const named = await lstat(path, { bigint: true });
    assertPrivateFile(after, "clear-sessions manifest");
    assertPrivateFile(named, "clear-sessions manifest");
    if (!sameManifestFile(before, after) || !sameManifestFile(after, named)
      || bytes.byteLength !== Number(after.size)) {
      throw new Error("Clear-sessions manifest changed while it was read.");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
    } catch (error) {
      throw new Error("Clear-sessions manifest is malformed.", { cause: error });
    }
    const value = parseManifest(parsed, match[1]!);
    return { value, path, identity: { dev: before.dev, ino: before.ino } };
  } finally {
    await handle.close();
  }
}

function parseManifest(value: unknown, expectedId: string): ClearSessionsManifest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Clear-sessions manifest is malformed.");
  const record = value as Record<string, unknown>;
  const keys = [
    "controlCanonicalPath", "controlIdentity", "controlPath", "id", "kind",
    "originalCanonicalPath", "originalIdentity", "originalParentCanonicalPath",
    "originalParentIdentity", "originalParentPath", "originalPath", "quarantineCanonicalPath",
    "quarantinePath", "schema",
  ];
  if (Object.keys(record).sort().join(",") !== keys.sort().join(",")) throw new Error("Clear-sessions manifest has unknown fields.");
  if (record.schema !== CLEAR_SESSIONS_MANIFEST_SCHEMA || record.id !== expectedId
    || !isPurgeKind(record.kind)) throw new Error("Clear-sessions manifest identity is invalid.");
  const manifest = record as unknown as ClearSessionsManifest;
  for (const path of [
    manifest.originalPath,
    manifest.originalCanonicalPath,
    manifest.originalParentPath,
    manifest.originalParentCanonicalPath,
    manifest.controlPath,
    manifest.controlCanonicalPath,
    manifest.quarantinePath,
    manifest.quarantineCanonicalPath,
  ]) {
    if (typeof path !== "string" || !isAbsolute(path)) throw new Error("Clear-sessions manifest path is invalid.");
  }
  for (const identity of [manifest.originalIdentity, manifest.originalParentIdentity, manifest.controlIdentity]) {
    assertWireIdentity(identity);
  }
  if (dirname(manifest.originalPath) !== manifest.originalParentPath
    || dirname(manifest.originalCanonicalPath) !== manifest.originalParentCanonicalPath
    || manifest.controlPath !== join(manifest.originalParentPath, CLEAR_SESSIONS_CONTROL_DIRECTORY)
    || manifest.controlCanonicalPath !== join(manifest.originalParentCanonicalPath, CLEAR_SESSIONS_CONTROL_DIRECTORY)
    || manifest.quarantinePath !== join(manifest.controlPath, `${expectedId}.quarantine`)
    || manifest.quarantineCanonicalPath !== join(manifest.controlCanonicalPath, `${expectedId}.quarantine`)) {
    throw new Error("Clear-sessions manifest path relationships are invalid.");
  }
  return manifest;
}

async function attestManifestControl(manifest: ClearSessionsManifest): Promise<AttestedPrivateDirectory> {
  const control = await attestPrivateDirectory(manifest.controlPath, "clear-sessions control directory");
  if (control.canonicalPath !== manifest.controlCanonicalPath
    || !sameWireIdentity(control.identity, manifest.controlIdentity)) {
    throw new Error("Clear-sessions control directory identity changed; recovery remains unresolved.");
  }
  const parent = await lstat(manifest.originalParentPath, { bigint: true });
  assertSecureContainingDirectory(parent, manifest.originalParentPath);
  if (!sameWireIdentity(parent, manifest.originalParentIdentity)
    || await realpath(manifest.originalParentPath) !== manifest.originalParentCanonicalPath) {
    throw new Error("Clear-sessions original parent changed; recovery remains unresolved.");
  }
  return control;
}

async function removeLoadedManifest(
  registry: AttestedPrivateDirectory,
  loaded: LoadedManifest,
): Promise<void> {
  await assertPrivateDirectoryUnchanged(registry, "clear-sessions registry");
  const details = await lstat(loaded.path, { bigint: true });
  assertPrivateFile(details, "clear-sessions manifest");
  if (!sameFileSystemIdentity(details, loaded.identity)) throw new Error("Clear-sessions manifest identity changed.");
  await unlink(loaded.path);
  await syncAndReattestPrivateDirectory(registry, "clear-sessions registry");
}

async function assertRegistryDisjoint(
  registry: AttestedPrivateDirectory,
  plan: ConversationStatePurgePlan,
  processJobsStateDir: string,
): Promise<void> {
  for (const root of conversationStatePurgePlanEntries(plan)) {
    if (pathsContainEachOther(registry.canonicalPath, root.canonicalPath)) {
      throw new Error("Clear-sessions registry must be disjoint from every purge root.");
    }
  }
  const stateDir = await canonicalExistingPrefix(processJobsStateDir);
  if (pathsContainEachOther(registry.path, stateDir)) {
    throw new Error("Clear-sessions registry must be disjoint from process-job durable state.");
  }
}

async function canonicalExistingPrefix(path: string): Promise<string> {
  let cursor = resolve(path);
  const missing: string[] = [];
  while (true) {
    try {
      return resolve(await realpath(cursor), ...missing);
    } catch (error) {
      if (!isErrno(error, "ENOENT")) throw error;
    }
    const parent = dirname(cursor);
    if (parent === cursor) throw new Error("Clear-sessions path has no canonical ancestor.");
    missing.unshift(basename(cursor));
    cursor = parent;
  }
}

function assertRegistryPathDisjoint(
  registryPath: string,
  plan: ConversationStatePurgePlan,
  processJobsStateDir: string,
): void {
  for (const root of conversationStatePurgePlanEntries(plan)) {
    if (pathsContainEachOther(resolve(registryPath), resolve(root.path))) {
      throw new Error("Clear-sessions registry must be disjoint from every purge root.");
    }
  }
  if (pathsContainEachOther(resolve(registryPath), resolve(processJobsStateDir))) {
    throw new Error("Clear-sessions registry must be disjoint from process-job durable state.");
  }
}

async function boundedDirectoryEntries(path: string, maximum: number): Promise<Dirent[]> {
  const directory = await opendir(path);
  const entries: Dirent[] = [];
  try {
    for await (const entry of directory) {
      if (entries.length >= maximum) throw new Error("Clear-sessions recovery work exceeds its safety bound.");
      entries.push(entry);
    }
  } finally {
    await directory.close().catch(() => undefined);
  }
  return entries;
}

async function optionalLstat(path: string): Promise<BigIntStats | undefined> {
  try {
    return await lstat(path, { bigint: true });
  } catch (error) {
    if (isErrno(error, "ENOENT")) return undefined;
    throw error;
  }
}

function assertSecureContainingDirectory(details: BigIntStats, path: string): void {
  assertRealDirectory(details, path);
  if (process.getuid !== undefined && details.uid !== BigInt(process.getuid())) {
    throw new Error("Clear-sessions directory is not owned by the current user.");
  }
  if ((details.mode & 0o022n) !== 0n) {
    throw new Error("Clear-sessions directory must not be group/world writable.");
  }
}

function assertPrivateFile(details: BigIntStats, label: string): void {
  if (!details.isFile() || details.isSymbolicLink() || details.nlink !== 1n
    || (details.mode & 0o077n) !== 0n
    || (process.getuid !== undefined && details.uid !== BigInt(process.getuid()))) {
    throw new Error(`${label} must be one owner-private regular file.`);
  }
}

function sameManifestFile(left: BigIntStats, right: BigIntStats): boolean {
  return sameFileSystemIdentity(left, right)
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs
    && left.mode === right.mode
    && left.uid === right.uid
    && left.nlink === right.nlink;
}

function wireIdentity(value: { readonly dev: bigint; readonly ino: bigint }): WireIdentity {
  return { dev: value.dev.toString(), ino: value.ino.toString() };
}

function assertWireIdentity(value: unknown): asserts value is WireIdentity {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Clear-sessions manifest identity is invalid.");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== "dev,ino"
    || typeof record.dev !== "string" || !/^\d+$/u.test(record.dev)
    || typeof record.ino !== "string" || !/^\d+$/u.test(record.ino)) {
    throw new Error("Clear-sessions manifest identity is invalid.");
  }
}

function sameWireIdentity(
  value: { readonly dev: bigint; readonly ino: bigint },
  expected: WireIdentity,
): boolean {
  return value.dev.toString() === expected.dev && value.ino.toString() === expected.ino;
}

function isPurgeKind(value: unknown): value is ResolvedConversationStatePurgeRoot["kind"] {
  return value === "Pi provider sessions"
    || value === "durable session/tool history"
    || value === "ACP sessions";
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
