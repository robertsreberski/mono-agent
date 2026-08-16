import { randomUUID } from "node:crypto";
import { lstatSync, realpathSync, type BigIntStats, type Dirent } from "node:fs";
import { chmod, link, lstat, mkdir, opendir, realpath, rmdir, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import process from "node:process";

import {
  type AgentRootCoordinator,
  type AgentRootProtectionGeneration,
} from "./agent-root-coordinator.js";
import { clearSessionsRegistryRoot } from "./conversation-state-roots.js";
import { acquireOwnerPrivateLock, type OwnerPrivateLock } from "./owner-private-lock.js";
import { readVerifiedFile, secureFileReplace } from "./secure-file-replace.js";
import { syncDirectory } from "./continuation-store-fs.js";

export const PROCESS_JOBS_ROOT_REGISTRY_SCHEMA = "mono-agent.process-jobs-roots.v1";
export const PROCESS_JOBS_ROOT_REGISTRY_DIRECTORY = "process-jobs-roots-v1";
export const PROCESS_JOBS_ROOT_REGISTRY_FILE = "registry.json";
export const PROCESS_JOBS_ROOT_REGISTRY_RECOVERY_DIRECTORY = "process-jobs-roots-v1.recovery";
export const PROCESS_JOBS_ROOT_REGISTRY_STAGING_FILE = "registry.staging.json";
export const PROCESS_JOBS_ROOT_REGISTRY_PREVIOUS_FILE = "registry.previous.json";
export const PROCESS_JOBS_ROOT_REGISTRY_FAILED_FILE = "registry.failed.json";
export const PROCESS_JOBS_ROOT_REGISTRY_MAX_RECOVERY_ENTRIES = 3;
export const PROCESS_JOBS_ROOT_REGISTRY_MAX_ROOTS = 64;
export const PROCESS_JOBS_ROOT_REGISTRY_MAX_SEGMENTS = 64;
export const PROCESS_JOBS_ROOT_REGISTRY_MAX_SEGMENT_BYTES = 255;
export const PROCESS_JOBS_ROOT_REGISTRY_MAX_ROOT_BYTES = 2 * 1024;
export const PROCESS_JOBS_ROOT_REGISTRY_MAX_BYTES = 256 * 1024;

export const PROCESS_JOBS_REGISTRY_UNAVAILABLE_ERROR =
  "Process-job private-state protection is unavailable.";

const EMPTY_GENERATION_ID = "mono-agent.process-jobs-roots.absent";
const REGISTRY_LOCK_SCHEMA = "mono-agent.process-jobs-roots-lock.v1";
const REGISTRY_LOCK_OWNERLESS_GRACE_MS = 1_000;
const REGISTRATION_PROOF = Symbol("process-jobs-root-registration-proof");

interface RegistryManifest {
  readonly schema: typeof PROCESS_JOBS_ROOT_REGISTRY_SCHEMA;
  readonly generation: string;
  readonly roots: readonly (readonly string[])[];
}

interface FileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
}

interface ProvenManifest {
  readonly path: string;
  readonly manifest: RegistryManifest;
  readonly contents: Buffer;
  readonly details: BigIntStats;
}

interface RecoveryArtifacts {
  readonly staging?: ProvenManifest;
  readonly previous?: ProvenManifest;
  readonly failed?: ProvenManifest;
}

export interface RegisteredProcessJobsRoot {
  readonly segments: readonly string[];
  readonly key: string;
  readonly lexicalPath: string;
  readonly canonicalPath: string;
  readonly protectedPaths: readonly string[];
}

export interface EmptyProcessJobsRootRegistrySnapshot {
  readonly kind: "empty";
  readonly agentRoot: string;
  readonly registryDir: string;
  readonly recoveryDir: string;
  readonly manifestPath: string;
  readonly mutationLockPath: string;
  readonly generation: AgentRootProtectionGeneration;
  readonly roots: readonly [];
  readonly protectedRoots: readonly [];
}

export interface ReadyProcessJobsRootRegistrySnapshot {
  readonly kind: "ready";
  readonly agentRoot: string;
  readonly registryDir: string;
  readonly recoveryDir: string;
  readonly manifestPath: string;
  readonly mutationLockPath: string;
  readonly generation: AgentRootProtectionGeneration;
  readonly roots: readonly RegisteredProcessJobsRoot[];
  readonly protectedRoots: readonly string[];
  readonly manifestIdentity: FileIdentity;
  readonly manifestContents: Buffer;
}

export interface FailedProcessJobsRootRegistrySnapshot {
  readonly kind: "failed";
  readonly agentRoot: string;
  readonly registryDir: string;
  readonly recoveryDir: string;
  readonly manifestPath: string;
  readonly mutationLockPath: string;
  readonly generation: AgentRootProtectionGeneration;
  readonly roots: readonly [];
  readonly protectedRoots: readonly string[];
  readonly error: string;
}

export type ProcessJobsRootRegistrySnapshot =
  | EmptyProcessJobsRootRegistrySnapshot
  | ReadyProcessJobsRootRegistrySnapshot
  | FailedProcessJobsRootRegistrySnapshot;

export interface ProcessJobsRootRegistrationProof {
  readonly snapshot: ReadyProcessJobsRootRegistrySnapshot;
  readonly rootKey: string;
  readonly [REGISTRATION_PROOF]: true;
}

interface ProcessJobsRootRegistrationHooks {
  /** @internal Deterministic failure seam after first-directory creation and before manifest staging. */
  readonly afterRegistryDirectoryCreated?: () => void | Promise<void>;
  /** @internal Deterministic publication and recovery seams for crash-matrix tests. */
  readonly afterManifestPublish?: () => void | Promise<void>;
  readonly beforeManifestRestore?: () => void | Promise<void>;
  readonly beforeRegistryRecovery?: () => void | Promise<void>;
}

export interface ProcessJobsRootRegistryFreeze {
  readonly snapshot: EmptyProcessJobsRootRegistrySnapshot | ReadyProcessJobsRootRegistrySnapshot;
  reattest(workspace: string): Promise<EmptyProcessJobsRootRegistrySnapshot | ReadyProcessJobsRootRegistrySnapshot>;
  release(): Promise<void>;
}

export function processJobsRootRegistryPaths(agentRoot: string): {
  readonly registryDir: string;
  readonly recoveryDir: string;
  readonly manifestPath: string;
  readonly stagingPath: string;
  readonly previousPath: string;
  readonly failedPath: string;
  readonly mutationLockPath: string;
} {
  const managedRoot = resolve(agentRoot, ".mono-agent");
  const registryDir = join(managedRoot, PROCESS_JOBS_ROOT_REGISTRY_DIRECTORY);
  const recoveryDir = join(managedRoot, PROCESS_JOBS_ROOT_REGISTRY_RECOVERY_DIRECTORY);
  return {
    registryDir,
    recoveryDir,
    manifestPath: join(registryDir, PROCESS_JOBS_ROOT_REGISTRY_FILE),
    stagingPath: join(recoveryDir, PROCESS_JOBS_ROOT_REGISTRY_STAGING_FILE),
    previousPath: join(recoveryDir, PROCESS_JOBS_ROOT_REGISTRY_PREVIOUS_FILE),
    failedPath: join(recoveryDir, PROCESS_JOBS_ROOT_REGISTRY_FAILED_FILE),
    mutationLockPath: join(managedRoot, `.${PROCESS_JOBS_ROOT_REGISTRY_DIRECTORY}.lock`),
  };
}

/** Load a strict snapshot; malformed or unsafe durable state becomes a provider-zero state. */
export async function loadProcessJobsRootRegistryProtection(
  agentRoot: string,
  workspace: string,
): Promise<ProcessJobsRootRegistrySnapshot> {
  const canonicalRoot = await canonicalAgentRoot(agentRoot);
  try {
    return await loadStrict(canonicalRoot, workspace);
  } catch {
    return failedProcessJobsRootRegistryProtection(canonicalRoot);
  }
}

export function failedProcessJobsRootRegistryProtection(
  canonicalAgentRoot: string,
): FailedProcessJobsRootRegistrySnapshot {
  const agentRoot = resolve(canonicalAgentRoot);
  const paths = processJobsRootRegistryPaths(agentRoot);
  return {
    kind: "failed",
    agentRoot,
    ...paths,
    generation: Object.freeze({
      id: "mono-agent.process-jobs-roots.failed",
      rootKeys: Object.freeze([]),
    }),
    roots: [],
    protectedRoots: Object.freeze([paths.registryDir, paths.recoveryDir, paths.mutationLockPath]),
    error: PROCESS_JOBS_REGISTRY_UNAVAILABLE_ERROR,
  };
}

/** Re-read and identity-prove the captured manifest at a request/destructive boundary. */
export async function attestProcessJobsRootRegistrySnapshot(
  snapshot: ProcessJobsRootRegistrySnapshot,
  workspace: string,
): Promise<EmptyProcessJobsRootRegistrySnapshot | ReadyProcessJobsRootRegistrySnapshot> {
  if (snapshot.kind === "failed") throw new Error(PROCESS_JOBS_REGISTRY_UNAVAILABLE_ERROR);
  const current = await loadStrict(snapshot.agentRoot, workspace);
  if (snapshot.kind === "empty") {
    if (current.kind !== "empty") throw new Error(PROCESS_JOBS_REGISTRY_UNAVAILABLE_ERROR);
    return current;
  }
  if (current.kind !== "ready"
    || current.generation.id !== snapshot.generation.id
    || !sameStringArrays(current.generation.rootKeys, snapshot.generation.rootKeys)
    || current.manifestIdentity.dev !== snapshot.manifestIdentity.dev
    || current.manifestIdentity.ino !== snapshot.manifestIdentity.ino
    || !current.manifestContents.equals(snapshot.manifestContents)) {
    throw new Error(PROCESS_JOBS_REGISTRY_UNAVAILABLE_ERROR);
  }
  return current;
}

/** Fsync a monotonic registration before any ProcessJobs root creation/open. */
export async function registerProcessJobsRoot(options: {
  readonly agentRoot: string;
  readonly workspace: string;
  readonly stateDir: string;
  readonly coordinator: AgentRootCoordinator;
  readonly hooks?: ProcessJobsRootRegistrationHooks;
}): Promise<ProcessJobsRootRegistrationProof> {
  const agentRoot = await canonicalAgentRoot(options.agentRoot);
  const rootSegments = relativeSegments(agentRoot, options.stateDir);
  const rootKey = rootSegments.join("/");
  const paths = processJobsRootRegistryPaths(agentRoot);
  // Reject an unsafe candidate before publishing it into the monotonic
  // manifest; a bad config must fail closed without permanently poisoning an
  // otherwise valid registry generation.
  validateRegisteredRoot({
    agentRoot,
    workspace: options.workspace,
    registryDir: paths.registryDir,
    recoveryDir: paths.recoveryDir,
    mutationLockPath: paths.mutationLockPath,
    segments: rootSegments,
  });
  await ensurePrivateDirectory(dirname(paths.registryDir), "Process-job registry parent");
  const lock = await acquireRegistryLock(paths.mutationLockPath);
  if (lock === undefined) throw new Error(PROCESS_JOBS_REGISTRY_UNAVAILABLE_ERROR);
  try {
    await ensureRecoveryDirectory(paths);
    await recoverRegistryArtifacts(paths, options.hooks);
    // A first-registration crash may leave only the durable directory. Strict
    // request readers remain provider-zero; the mutation-locked writer alone
    // may remove that exact empty artifact before retrying publication.
    await removeExactEmptyRegistryDirectory(paths.registryDir);
    let current = await loadStrict(agentRoot, options.workspace);
    if (current.kind === "ready" && current.generation.rootKeys.includes(rootKey)) {
      options.coordinator.publishGeneration(current.generation);
      return proof(current, rootKey);
    }
    const roots = [
      ...(current.kind === "ready" ? current.roots.map((root) => root.segments) : []),
      rootSegments,
    ].sort(compareSegments);
    if (roots.length > PROCESS_JOBS_ROOT_REGISTRY_MAX_ROOTS) {
      throw new Error(PROCESS_JOBS_REGISTRY_UNAVAILABLE_ERROR);
    }
    const manifest: RegistryManifest = {
      schema: PROCESS_JOBS_ROOT_REGISTRY_SCHEMA,
      generation: randomUUID(),
      roots,
    };
    const contents = encodeManifest(manifest);
    if (current.kind === "empty") {
      await ensurePrivateDirectory(paths.registryDir, "Process-job registry");
      await options.hooks?.afterRegistryDirectoryCreated?.();
      await replaceManifest(paths, contents, undefined, options.hooks);
    } else {
      await replaceManifest(paths, contents, current, options.hooks);
    }
    await syncDirectory(paths.registryDir);
    await syncDirectory(dirname(paths.registryDir));
    current = await loadStrict(agentRoot, options.workspace);
    if (current.kind !== "ready"
      || current.generation.id !== manifest.generation
      || !current.generation.rootKeys.includes(rootKey)) {
      throw new Error(PROCESS_JOBS_REGISTRY_UNAVAILABLE_ERROR);
    }
    options.coordinator.publishGeneration(current.generation);
    return proof(current, rootKey);
  } catch (error) {
    try {
      await recoverRegistryArtifacts(paths, options.hooks);
      await removeExactEmptyRegistryDirectory(paths.registryDir);
    } catch (cleanupError) {
      throw new Error(PROCESS_JOBS_REGISTRY_UNAVAILABLE_ERROR, {
        cause: new AggregateError([error, cleanupError], "Registry publication and empty-directory cleanup failed."),
      });
    }
    if (error instanceof Error && error.message === PROCESS_JOBS_REGISTRY_UNAVAILABLE_ERROR) throw error;
    throw new Error(PROCESS_JOBS_REGISTRY_UNAVAILABLE_ERROR, { cause: error });
  } finally {
    await lock.release().catch(() => undefined);
  }
}

/** Hold the registry mutation lock across clear-sessions preflight and first rename. */
export async function freezeProcessJobsRootRegistry(
  agentRoot: string,
  workspace: string,
): Promise<ProcessJobsRootRegistryFreeze> {
  const canonicalRoot = await canonicalAgentRoot(agentRoot);
  const paths = processJobsRootRegistryPaths(canonicalRoot);
  await ensurePrivateDirectory(dirname(paths.registryDir), "Process-job registry parent");
  const lock = await acquireRegistryLock(paths.mutationLockPath);
  if (lock === undefined) throw new Error(PROCESS_JOBS_REGISTRY_UNAVAILABLE_ERROR);
  try {
    await recoverRegistryArtifacts(paths);
    await removeExactEmptyRegistryDirectory(paths.registryDir);
    const snapshot = await loadStrict(canonicalRoot, workspace);
    return {
      snapshot,
      reattest: async (nextWorkspace) =>
        await attestProcessJobsRootRegistrySnapshot(snapshot, nextWorkspace),
      release: async () => await lock.release(),
    };
  } catch (error) {
    await lock.release().catch(() => undefined);
    throw error;
  }
}

/** Prove a supplied state directory remains in the exact registered generation. */
export async function attestProcessJobsRootRegistration(
  proofValue: ProcessJobsRootRegistrationProof,
  workspace: string,
  stateDir: string,
): Promise<ReadyProcessJobsRootRegistrySnapshot> {
  if (proofValue?.[REGISTRATION_PROOF] !== true) {
    throw new Error(PROCESS_JOBS_REGISTRY_UNAVAILABLE_ERROR);
  }
  const current = await attestProcessJobsRootRegistrySnapshot(proofValue.snapshot, workspace);
  if (current.kind !== "ready") throw new Error(PROCESS_JOBS_REGISTRY_UNAVAILABLE_ERROR);
  const key = relativeSegments(current.agentRoot, stateDir).join("/");
  if (key !== proofValue.rootKey || !current.generation.rootKeys.includes(key)) {
    throw new Error(PROCESS_JOBS_REGISTRY_UNAVAILABLE_ERROR);
  }
  return current;
}

/** All state roots must remain disjoint from every destructive/control path. */
export function assertProcessJobsRegistryDisjointFromPaths(
  snapshot: EmptyProcessJobsRootRegistrySnapshot | ReadyProcessJobsRootRegistrySnapshot,
  paths: readonly string[],
): void {
  if (snapshot.kind === "empty") return;
  const privatePaths = [snapshot.registryDir, snapshot.recoveryDir, snapshot.mutationLockPath,
    ...snapshot.roots.flatMap((root) => root.protectedPaths)];
  for (const privatePath of privatePaths) {
    for (const candidate of paths) {
      if (pathsOverlap(resolve(privatePath), resolve(candidate))) {
        throw new Error("restart --clear-sessions overlaps retained process-job private state; nothing was deleted.");
      }
    }
  }
}

export function processJobsProtectionPolicyRoots(snapshot: ProcessJobsRootRegistrySnapshot): readonly string[] {
  return snapshot.kind === "empty" ? [] : snapshot.protectedRoots;
}

export function processJobsRootForKey(
  snapshot: ProcessJobsRootRegistrySnapshot,
  key: string,
): RegisteredProcessJobsRoot | undefined {
  return snapshot.kind === "ready" ? snapshot.roots.find((root) => root.key === key) : undefined;
}

export function processJobsRegistryGeneration(
  snapshot: ProcessJobsRootRegistrySnapshot,
): AgentRootProtectionGeneration {
  return snapshot.generation;
}

async function loadStrict(
  agentRoot: string,
  workspace: string,
): Promise<EmptyProcessJobsRootRegistrySnapshot | ReadyProcessJobsRootRegistrySnapshot> {
  const paths = processJobsRootRegistryPaths(agentRoot);
  const target = await inspectRegistryTarget(paths);
  const recovery = await scanRecoveryArtifacts(paths, target.directoryDetails);
  if (hasRecoveryArtifacts(recovery)) throw new Error(PROCESS_JOBS_REGISTRY_UNAVAILABLE_ERROR);
  if (target.directoryDetails === undefined) {
    return {
      kind: "empty",
      agentRoot,
      ...paths,
      generation: Object.freeze({ id: EMPTY_GENERATION_ID, rootKeys: Object.freeze([]) }),
      roots: [],
      protectedRoots: [],
    };
  }
  const read = target.current;
  if (read === undefined) throw new Error(PROCESS_JOBS_REGISTRY_UNAVAILABLE_ERROR);
  const manifest = read.manifest;
  const roots = manifest.roots.map((segments) => validateRegisteredRoot({
    agentRoot,
    workspace,
    registryDir: paths.registryDir,
    recoveryDir: paths.recoveryDir,
    mutationLockPath: paths.mutationLockPath,
    segments,
  }));
  const rootKeys = roots.map((root) => root.key);
  const protectedRoots = uniquePaths([
    paths.registryDir,
    paths.recoveryDir,
    paths.mutationLockPath,
    ...roots.flatMap((root) => root.protectedPaths),
  ]);
  return {
    kind: "ready",
    agentRoot,
    ...paths,
    generation: Object.freeze({ id: manifest.generation, rootKeys: Object.freeze(rootKeys) }),
    roots: Object.freeze(roots),
    protectedRoots: Object.freeze(protectedRoots),
    manifestIdentity: { dev: read.details.dev, ino: read.details.ino },
    manifestContents: Buffer.from(read.contents),
  };
}

async function inspectRegistryTarget(
  paths: ReturnType<typeof processJobsRootRegistryPaths>,
): Promise<{ readonly directoryDetails?: BigIntStats; readonly current?: ProvenManifest }> {
  return await inspectRegistryTargetWithReader(paths, readProvenManifest);
}

async function inspectRegistryTargetForRecovery(
  paths: ReturnType<typeof processJobsRootRegistryPaths>,
): Promise<{ readonly directoryDetails?: BigIntStats; readonly current?: ProvenManifest }> {
  return await inspectRegistryTargetWithReader(paths, readRecoveryPairCandidateManifest);
}

async function inspectRegistryTargetWithReader(
  paths: ReturnType<typeof processJobsRootRegistryPaths>,
  readCurrent: (path: string) => Promise<ProvenManifest>,
): Promise<{ readonly directoryDetails?: BigIntStats; readonly current?: ProvenManifest }> {
  let before: BigIntStats;
  try {
    before = await lstat(paths.registryDir, { bigint: true });
  } catch (error) {
    if (!isErrno(error, "ENOENT")) throw error;
    if (await readManifest(paths.manifestPath) !== undefined) {
      throw new Error(PROCESS_JOBS_REGISTRY_UNAVAILABLE_ERROR);
    }
    return {};
  }
  assertPrivateDirectory(before, "Process-job registry");
  if (await realpath(paths.registryDir) !== paths.registryDir) {
    throw new Error(PROCESS_JOBS_REGISTRY_UNAVAILABLE_ERROR);
  }
  const directory = await opendir(paths.registryDir);
  let entry: Dirent | null;
  try {
    entry = await directory.read();
    if (entry !== null && (entry.name !== PROCESS_JOBS_ROOT_REGISTRY_FILE
      || !entry.isFile() || entry.isSymbolicLink())) {
      throw new Error(PROCESS_JOBS_REGISTRY_UNAVAILABLE_ERROR);
    }
    if (await directory.read() !== null) throw new Error(PROCESS_JOBS_REGISTRY_UNAVAILABLE_ERROR);
  } finally {
    await directory.close();
  }
  const current = entry === null ? undefined : await readCurrent(paths.manifestPath);
  const after = await lstat(paths.registryDir, { bigint: true });
  assertPrivateDirectory(after, "Process-job registry");
  if (!sameFileIdentity(before, after)) throw new Error(PROCESS_JOBS_REGISTRY_UNAVAILABLE_ERROR);
  return { directoryDetails: after, ...(current === undefined ? {} : { current }) };
}

async function scanRecoveryArtifacts(
  paths: ReturnType<typeof processJobsRootRegistryPaths>,
  registryDetails?: BigIntStats,
): Promise<RecoveryArtifacts> {
  return await scanRecoveryArtifactsWithPreviousReader(paths, registryDetails, readProvenManifest);
}

async function scanRecoveryArtifactsForRecovery(
  paths: ReturnType<typeof processJobsRootRegistryPaths>,
  registryDetails?: BigIntStats,
): Promise<RecoveryArtifacts> {
  return await scanRecoveryArtifactsWithPreviousReader(
    paths,
    registryDetails,
    readRecoveryPairCandidateManifest,
  );
}

async function scanRecoveryArtifactsWithPreviousReader(
  paths: ReturnType<typeof processJobsRootRegistryPaths>,
  registryDetails: BigIntStats | undefined,
  readPrevious: (path: string) => Promise<ProvenManifest>,
): Promise<RecoveryArtifacts> {
  let before: BigIntStats;
  try {
    before = await lstat(paths.recoveryDir, { bigint: true });
  } catch (error) {
    if (isErrno(error, "ENOENT")) return {};
    throw error;
  }
  assertRecoveryDirectory(before);
  if (await realpath(paths.recoveryDir) !== paths.recoveryDir) {
    throw new Error(PROCESS_JOBS_REGISTRY_UNAVAILABLE_ERROR);
  }
  const filesystemPeer = registryDetails ?? await lstat(dirname(paths.recoveryDir), { bigint: true });
  assertPrivateDirectory(filesystemPeer, "Process-job registry filesystem peer");
  if (before.dev !== filesystemPeer.dev) throw new Error(PROCESS_JOBS_REGISTRY_UNAVAILABLE_ERROR);

  let staging: ProvenManifest | undefined;
  let previous: ProvenManifest | undefined;
  let failed: ProvenManifest | undefined;
  let count = 0;
  const directory = await opendir(paths.recoveryDir);
  try {
    for (;;) {
      const entry = await directory.read();
      if (entry === null) break;
      count += 1;
      if (count > PROCESS_JOBS_ROOT_REGISTRY_MAX_RECOVERY_ENTRIES) {
        throw new Error(PROCESS_JOBS_REGISTRY_UNAVAILABLE_ERROR);
      }
      if (!entry.isFile() || entry.isSymbolicLink()) {
        throw new Error(PROCESS_JOBS_REGISTRY_UNAVAILABLE_ERROR);
      }
      if (entry.name === PROCESS_JOBS_ROOT_REGISTRY_STAGING_FILE) {
        staging = await readProvenManifest(paths.stagingPath);
      } else if (entry.name === PROCESS_JOBS_ROOT_REGISTRY_PREVIOUS_FILE) {
        previous = await readPrevious(paths.previousPath);
      } else if (entry.name === PROCESS_JOBS_ROOT_REGISTRY_FAILED_FILE) {
        failed = await readProvenManifest(paths.failedPath);
      } else {
        throw new Error(PROCESS_JOBS_REGISTRY_UNAVAILABLE_ERROR);
      }
    }
  } finally {
    await directory.close();
  }
  const after = await lstat(paths.recoveryDir, { bigint: true });
  assertRecoveryDirectory(after);
  if (!sameFileIdentity(before, after)) throw new Error(PROCESS_JOBS_REGISTRY_UNAVAILABLE_ERROR);
  return {
    ...(staging === undefined ? {} : { staging }),
    ...(previous === undefined ? {} : { previous }),
    ...(failed === undefined ? {} : { failed }),
  };
}

async function readProvenManifest(path: string): Promise<ProvenManifest> {
  const read = await readManifest(path);
  if (read === undefined) throw new Error(PROCESS_JOBS_REGISTRY_UNAVAILABLE_ERROR);
  return { path, manifest: parseManifest(read.contents), contents: read.contents, details: read.details };
}

async function readRecoveryPairCandidateManifest(path: string): Promise<ProvenManifest> {
  const read = await readVerifiedFile(path, {
    validate: (details) => {
      if (!details.isFile() || details.isSymbolicLink()
        || (details.nlink !== 1n && details.nlink !== 2n)
        || details.size > BigInt(PROCESS_JOBS_ROOT_REGISTRY_MAX_BYTES)) {
        throw new Error(PROCESS_JOBS_REGISTRY_UNAVAILABLE_ERROR);
      }
      if (typeof process.getuid === "function" && details.uid !== BigInt(process.getuid())) {
        throw new Error(PROCESS_JOBS_REGISTRY_UNAVAILABLE_ERROR);
      }
      if ((details.mode & 0o777n) !== 0o600n) throw new Error(PROCESS_JOBS_REGISTRY_UNAVAILABLE_ERROR);
    },
    changedError: () => new Error(PROCESS_JOBS_REGISTRY_UNAVAILABLE_ERROR),
  });
  if (read === undefined) throw new Error(PROCESS_JOBS_REGISTRY_UNAVAILABLE_ERROR);
  return { path, manifest: parseManifest(read.contents), contents: read.contents, details: read.details };
}

function hasRecoveryArtifacts(artifacts: RecoveryArtifacts): boolean {
  return artifacts.staging !== undefined || artifacts.previous !== undefined || artifacts.failed !== undefined;
}

async function readManifest(path: string): Promise<{ readonly contents: Buffer; readonly details: BigIntStats } | undefined> {
  return await readVerifiedFile(path, {
    validate: (details) => {
      if (!details.isFile() || details.isSymbolicLink() || details.nlink !== 1n
        || details.size > BigInt(PROCESS_JOBS_ROOT_REGISTRY_MAX_BYTES)) {
        throw new Error(PROCESS_JOBS_REGISTRY_UNAVAILABLE_ERROR);
      }
      if (typeof process.getuid === "function" && details.uid !== BigInt(process.getuid())) {
        throw new Error(PROCESS_JOBS_REGISTRY_UNAVAILABLE_ERROR);
      }
      if ((details.mode & 0o777n) !== 0o600n) throw new Error(PROCESS_JOBS_REGISTRY_UNAVAILABLE_ERROR);
    },
    changedError: () => new Error(PROCESS_JOBS_REGISTRY_UNAVAILABLE_ERROR),
  });
}

function parseManifest(contents: Buffer): RegistryManifest {
  if (contents.byteLength < 1 || contents.byteLength > PROCESS_JOBS_ROOT_REGISTRY_MAX_BYTES) {
    throw new Error(PROCESS_JOBS_REGISTRY_UNAVAILABLE_ERROR);
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(contents));
  } catch {
    throw new Error(PROCESS_JOBS_REGISTRY_UNAVAILABLE_ERROR);
  }
  if (!isRecord(value)
    || !hasExactKeys(value, ["schema", "generation", "roots"])
    || value.schema !== PROCESS_JOBS_ROOT_REGISTRY_SCHEMA
    || typeof value.generation !== "string"
    || !isUuid(value.generation)
    || !Array.isArray(value.roots)
    || value.roots.length < 1
    || value.roots.length > PROCESS_JOBS_ROOT_REGISTRY_MAX_ROOTS) {
    throw new Error(PROCESS_JOBS_REGISTRY_UNAVAILABLE_ERROR);
  }
  const roots = value.roots.map(validateSegments);
  const sorted = [...roots].sort(compareSegments);
  if (!sameSegmentRoots(roots, sorted)
    || new Set(roots.map((root) => root.join("/"))).size !== roots.length) {
    throw new Error(PROCESS_JOBS_REGISTRY_UNAVAILABLE_ERROR);
  }
  return { schema: PROCESS_JOBS_ROOT_REGISTRY_SCHEMA, generation: value.generation, roots };
}

function validateSegments(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > PROCESS_JOBS_ROOT_REGISTRY_MAX_SEGMENTS) {
    throw new Error(PROCESS_JOBS_REGISTRY_UNAVAILABLE_ERROR);
  }
  const segments = value.map((segment) => {
    if (typeof segment !== "string"
      || segment.length === 0
      || segment === "."
      || segment === ".."
      || segment.includes("/")
      || segment.includes("\\")
      || segment.includes("\0")
      || Buffer.byteLength(segment, "utf8") > PROCESS_JOBS_ROOT_REGISTRY_MAX_SEGMENT_BYTES) {
      throw new Error(PROCESS_JOBS_REGISTRY_UNAVAILABLE_ERROR);
    }
    return segment;
  });
  if (Buffer.byteLength(segments.join("/"), "utf8") > PROCESS_JOBS_ROOT_REGISTRY_MAX_ROOT_BYTES) {
    throw new Error(PROCESS_JOBS_REGISTRY_UNAVAILABLE_ERROR);
  }
  return Object.freeze(segments);
}

function validateRegisteredRoot(input: {
  readonly agentRoot: string;
  readonly workspace: string;
  readonly registryDir: string;
  readonly recoveryDir: string;
  readonly mutationLockPath: string;
  readonly segments: readonly string[];
}): RegisteredProcessJobsRoot {
  const lexicalPath = resolve(input.agentRoot, ...input.segments);
  const lexicalWorkspace = resolve(input.workspace);
  const canonicalWorkspace = realpathSync(lexicalWorkspace);
  const key = input.segments.join("/");
  // Reject the configured spelling before touching any candidate component.
  // Keep this recoveryDir branch distinct from the canonical check below:
  // case-folding and other non-symlink filesystem aliases need both proofs.
  if (!strictDescendant(input.agentRoot, lexicalPath)
    || pathsOverlap(lexicalPath, input.registryDir)
    || pathsOverlap(lexicalPath, input.recoveryDir)
    || pathsOverlap(lexicalPath, input.mutationLockPath)
    || pathsOverlap(lexicalPath, clearSessionsRegistryRoot(input.agentRoot))
    || stateRootContainsWorkspace(lexicalPath, lexicalWorkspace, canonicalWorkspace)) {
    throw new Error(PROCESS_JOBS_REGISTRY_UNAVAILABLE_ERROR);
  }
  let current = input.agentRoot;
  let canonicalPath = lexicalPath;
  for (const [index, segment] of input.segments.entries()) {
    current = join(current, segment);
    let details: BigIntStats;
    try {
      details = lstatSync(current, { bigint: true });
    } catch (error) {
      if (isErrno(error, "ENOENT")) break;
      throw error;
    }
    if (!details.isDirectory() || details.isSymbolicLink()) {
      throw new Error(PROCESS_JOBS_REGISTRY_UNAVAILABLE_ERROR);
    }
    assertOwned(details);
    const final = index === input.segments.length - 1;
    if (final && (details.mode & 0o077n) !== 0n) {
      throw new Error(PROCESS_JOBS_REGISTRY_UNAVAILABLE_ERROR);
    }
    if (!final && (details.mode & 0o022n) !== 0n) {
      throw new Error(PROCESS_JOBS_REGISTRY_UNAVAILABLE_ERROR);
    }
    if (final) canonicalPath = realpathSync(current);
  }
  // Symlink components are rejected above rather than followed. This second
  // recoveryDir branch covers a canonical alias exposed without a symlink and
  // must not be collapsed into the lexical-only check.
  if (!strictDescendant(input.agentRoot, canonicalPath)
    || pathsOverlap(canonicalPath, input.registryDir)
    || pathsOverlap(canonicalPath, input.recoveryDir)
    || pathsOverlap(canonicalPath, input.mutationLockPath)
    || pathsOverlap(canonicalPath, clearSessionsRegistryRoot(input.agentRoot))
    || stateRootContainsWorkspace(canonicalPath, lexicalWorkspace, canonicalWorkspace)) {
    throw new Error(PROCESS_JOBS_REGISTRY_UNAVAILABLE_ERROR);
  }
  return Object.freeze({
    segments: Object.freeze([...input.segments]),
    key,
    lexicalPath,
    canonicalPath,
    protectedPaths: Object.freeze(uniquePaths([lexicalPath, canonicalPath])),
  });
}

async function replaceManifest(
  paths: ReturnType<typeof processJobsRootRegistryPaths>,
  contents: Buffer,
  previous: ReadyProcessJobsRootRegistrySnapshot | undefined,
  hooks?: ProcessJobsRootRegistrationHooks,
): Promise<void> {
  // Fixed recovery names are safe only while every official publisher holds
  // the mutation lock and proves the recovery namespace drained immediately
  // before entering secureFileReplace, whose cross-directory rename paths are
  // intentionally fixed for this registry.
  await assertRecoveryArtifactsDrained(paths);
  await secureFileReplace({
    path: paths.manifestPath,
    temporaryPath: paths.stagingPath,
    contents,
    mode: 0o600,
    target: previous === undefined
      ? {
          expected: { kind: "missing" },
          failedPath: paths.failedPath,
          recovery: "preserve-current",
          ...(hooks?.afterManifestPublish === undefined
            ? {} : { afterPublish: hooks.afterManifestPublish }),
        }
      : {
          expected: {
            kind: "present",
            claimPath: paths.previousPath,
            validate: async (candidate) => {
              const current = await readManifest(candidate);
              return current !== undefined
                && current.details.dev === previous.manifestIdentity.dev
                && current.details.ino === previous.manifestIdentity.ino
                && current.contents.equals(previous.manifestContents);
            },
            invalidError: () => new Error(PROCESS_JOBS_REGISTRY_UNAVAILABLE_ERROR),
          },
          failedPath: paths.failedPath,
          recovery: "restore-previous",
          ...(hooks?.afterManifestPublish === undefined
            ? {} : { afterPublish: hooks.afterManifestPublish }),
          ...(hooks?.beforeManifestRestore === undefined
            ? {} : { beforeRestore: hooks.beforeManifestRestore }),
        },
  });
}

async function ensureRecoveryDirectory(
  paths: ReturnType<typeof processJobsRootRegistryPaths>,
): Promise<void> {
  let created = false;
  try {
    await mkdir(paths.recoveryDir, { mode: 0o700 });
    created = true;
  } catch (error) {
    if (!isErrno(error, "EEXIST")) throw error;
  }
  if (created) await chmod(paths.recoveryDir, 0o700);
  const details = await lstat(paths.recoveryDir, { bigint: true });
  assertRecoveryDirectory(details);
  if (await realpath(paths.recoveryDir) !== paths.recoveryDir) {
    throw new Error(PROCESS_JOBS_REGISTRY_UNAVAILABLE_ERROR);
  }
  let filesystemPeer: BigIntStats;
  try {
    filesystemPeer = await lstat(paths.registryDir, { bigint: true });
    assertPrivateDirectory(filesystemPeer, "Process-job registry");
  } catch (error) {
    if (!isErrno(error, "ENOENT")) throw error;
    filesystemPeer = await lstat(dirname(paths.recoveryDir), { bigint: true });
    assertPrivateDirectory(filesystemPeer, "Process-job registry parent");
  }
  if (details.dev !== filesystemPeer.dev) throw new Error(PROCESS_JOBS_REGISTRY_UNAVAILABLE_ERROR);
  if (created) {
    await syncDirectory(dirname(paths.recoveryDir));
    const after = await lstat(paths.recoveryDir, { bigint: true });
    assertRecoveryDirectory(after);
    if (!sameFileIdentity(details, after)) throw new Error(PROCESS_JOBS_REGISTRY_UNAVAILABLE_ERROR);
  }
}

async function assertRecoveryArtifactsDrained(
  paths: ReturnType<typeof processJobsRootRegistryPaths>,
): Promise<void> {
  const target = await inspectRegistryTarget(paths);
  const artifacts = await scanRecoveryArtifacts(paths, target.directoryDetails);
  if (hasRecoveryArtifacts(artifacts)) {
    throw new Error(PROCESS_JOBS_REGISTRY_UNAVAILABLE_ERROR);
  }
}

async function createMissingRegistryDirectoryForRestore(
  paths: ReturnType<typeof processJobsRootRegistryPaths>,
): Promise<void> {
  try {
    await mkdir(paths.registryDir, { mode: 0o700 });
  } catch (error) {
    // A pathname appearing after the absent-target proof is ambiguous. Never
    // adopt, chmod, remove, or overwrite it as part of recovery.
    if (isErrno(error, "EEXIST")) throw new Error(PROCESS_JOBS_REGISTRY_UNAVAILABLE_ERROR);
    throw error;
  }
  const before = await lstat(paths.registryDir, { bigint: true });
  assertPrivateDirectory(before, "Process-job registry");
  await chmod(paths.registryDir, 0o700);
  const after = await lstat(paths.registryDir, { bigint: true });
  assertPrivateDirectory(after, "Process-job registry");
  if (!sameFileIdentity(before, after) || await realpath(paths.registryDir) !== paths.registryDir) {
    throw new Error(PROCESS_JOBS_REGISTRY_UNAVAILABLE_ERROR);
  }
  const recovery = await lstat(paths.recoveryDir, { bigint: true });
  assertRecoveryDirectory(recovery);
  if (after.dev !== recovery.dev) throw new Error(PROCESS_JOBS_REGISTRY_UNAVAILABLE_ERROR);

  const parentPath = dirname(paths.registryDir);
  await syncDirectory(parentPath);
  const proven = await lstat(paths.registryDir, { bigint: true });
  assertPrivateDirectory(proven, "Process-job registry");
  if (!sameFileIdentity(after, proven)) throw new Error(PROCESS_JOBS_REGISTRY_UNAVAILABLE_ERROR);
}

async function recoverRegistryArtifacts(
  paths: ReturnType<typeof processJobsRootRegistryPaths>,
  hooks?: ProcessJobsRootRegistrationHooks,
): Promise<void> {
  await hooks?.beforeRegistryRecovery?.();
  let target = await inspectRegistryTargetForRecovery(paths);
  let artifacts = await scanRecoveryArtifactsForRecovery(paths, target.directoryDetails);

  if (target.current?.details.nlink === 2n || artifacts.previous?.details.nlink === 2n) {
    const interruptedTarget = target.current;
    const interruptedPrevious = artifacts.previous;
    if (interruptedTarget === undefined
      || interruptedPrevious === undefined
      || interruptedTarget.details.nlink !== 2n
      || interruptedPrevious.details.nlink !== 2n
      || !sameFileIdentity(interruptedTarget.details, interruptedPrevious.details)
      || !interruptedTarget.contents.equals(interruptedPrevious.contents)) {
      throw new Error(PROCESS_JOBS_REGISTRY_UNAVAILABLE_ERROR);
    }
    await completeInterruptedPreviousRestore(paths, interruptedTarget, interruptedPrevious);
    // Return to the ordinary single-link readers before considering any other
    // artifact cleanup. No general two-link state is admitted beyond the exact
    // target+previous recovery pair completed above.
    target = await inspectRegistryTarget(paths);
    artifacts = await scanRecoveryArtifacts(paths, target.directoryDetails);
  }
  if (!hasRecoveryArtifacts(artifacts)) return;

  if (target.current !== undefined) {
    for (const artifact of [artifacts.previous, artifacts.staging, artifacts.failed]) {
      if (artifact !== undefined) await removeProvenRecoveryArtifact(paths.recoveryDir, artifact);
    }
    await proveManifestUnchanged(target.current);
    return;
  }

  if (artifacts.previous !== undefined) {
    if (target.directoryDetails === undefined) {
      await createMissingRegistryDirectoryForRestore(paths);
    }
    await restorePreviousManifest(paths, artifacts.previous);
    for (const artifact of [artifacts.staging, artifacts.failed]) {
      if (artifact !== undefined) await removeProvenRecoveryArtifact(paths.recoveryDir, artifact);
    }
    return;
  }

  if (artifacts.failed !== undefined) {
    // A failed publication without a previous generation cannot prove which
    // generation should be authoritative.
    throw new Error(PROCESS_JOBS_REGISTRY_UNAVAILABLE_ERROR);
  }
  if (artifacts.staging !== undefined) {
    await removeProvenRecoveryArtifact(paths.recoveryDir, artifacts.staging);
  }
}

async function restorePreviousManifest(
  paths: ReturnType<typeof processJobsRootRegistryPaths>,
  previous: ProvenManifest,
): Promise<void> {
  await proveManifestUnchanged(previous);
  await link(previous.path, paths.manifestPath);
  const target = await readRecoveryPairCandidateManifest(paths.manifestPath);
  const linkedPrevious = await readRecoveryPairCandidateManifest(previous.path);
  if (target.details.nlink !== 2n
    || linkedPrevious.details.nlink !== 2n
    || !sameFileIdentity(target.details, linkedPrevious.details)
    || !target.contents.equals(linkedPrevious.contents)) {
    throw new Error(PROCESS_JOBS_REGISTRY_UNAVAILABLE_ERROR);
  }
  await completeInterruptedPreviousRestore(paths, target, linkedPrevious);
}

async function completeInterruptedPreviousRestore(
  paths: ReturnType<typeof processJobsRootRegistryPaths>,
  expectedTarget: ProvenManifest,
  expectedPrevious: ProvenManifest,
): Promise<void> {
  let target = await proveRecoveryPairCandidateUnchanged(expectedTarget);
  let previous = await proveRecoveryPairCandidateUnchanged(expectedPrevious);
  assertExactInterruptedPreviousRestorePair(target, previous);

  // The target link may have been created immediately before process death.
  // Make it durable before consuming the only recovery pathname, then reprove
  // both names after the fsync yield and immediately before unlinking.
  await syncDirectory(paths.registryDir);
  target = await proveRecoveryPairCandidateUnchanged(target);
  previous = await proveRecoveryPairCandidateUnchanged(previous);
  assertExactInterruptedPreviousRestorePair(target, previous);

  await unlink(previous.path);
  await syncDirectory(paths.recoveryDir);
  const restored = await readProvenManifest(paths.manifestPath);
  if (!sameFileIdentity(target.details, restored.details)
    || !target.contents.equals(restored.contents)
    || restored.details.nlink !== 1n) {
    throw new Error(PROCESS_JOBS_REGISTRY_UNAVAILABLE_ERROR);
  }
  try {
    await lstat(previous.path);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return;
    throw error;
  }
  throw new Error(PROCESS_JOBS_REGISTRY_UNAVAILABLE_ERROR);
}

function assertExactInterruptedPreviousRestorePair(
  target: ProvenManifest,
  previous: ProvenManifest,
): void {
  if (target.path === previous.path
    || target.details.nlink !== 2n
    || previous.details.nlink !== 2n
    || !sameFileIdentity(target.details, previous.details)
    || !target.contents.equals(previous.contents)) {
    throw new Error(PROCESS_JOBS_REGISTRY_UNAVAILABLE_ERROR);
  }
}

async function proveRecoveryPairCandidateUnchanged(expected: ProvenManifest): Promise<ProvenManifest> {
  const current = await readRecoveryPairCandidateManifest(expected.path);
  if (!sameFileIdentity(expected.details, current.details)
    || !expected.contents.equals(current.contents)) {
    throw new Error(PROCESS_JOBS_REGISTRY_UNAVAILABLE_ERROR);
  }
  return current;
}

async function removeProvenRecoveryArtifact(
  recoveryDir: string,
  artifact: ProvenManifest,
): Promise<void> {
  await proveManifestUnchanged(artifact);
  await unlink(artifact.path);
  await syncDirectory(recoveryDir);
  try {
    await lstat(artifact.path);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return;
    throw error;
  }
  throw new Error(PROCESS_JOBS_REGISTRY_UNAVAILABLE_ERROR);
}

async function proveManifestUnchanged(expected: ProvenManifest): Promise<void> {
  const current = await readProvenManifest(expected.path);
  if (!sameFileIdentity(expected.details, current.details)
    || !expected.contents.equals(current.contents)) {
    throw new Error(PROCESS_JOBS_REGISTRY_UNAVAILABLE_ERROR);
  }
}

function encodeManifest(manifest: RegistryManifest): Buffer {
  const contents = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  if (contents.byteLength > PROCESS_JOBS_ROOT_REGISTRY_MAX_BYTES) {
    throw new Error(PROCESS_JOBS_REGISTRY_UNAVAILABLE_ERROR);
  }
  return contents;
}

async function acquireRegistryLock(path: string): Promise<OwnerPrivateLock | undefined> {
  return await acquireOwnerPrivateLock({
    path,
    label: "Process-job root registry",
    schemaTag: REGISTRY_LOCK_SCHEMA,
    ownerlessGraceMs: REGISTRY_LOCK_OWNERLESS_GRACE_MS,
    invalidOwner: "error",
  });
}

/** Remove only the exact owner-private empty artifact left by first registration. */
async function removeExactEmptyRegistryDirectory(path: string): Promise<boolean> {
  let before: BigIntStats;
  try {
    before = await lstat(path, { bigint: true });
  } catch (error) {
    if (isErrno(error, "ENOENT")) return false;
    throw error;
  }
  assertPrivateDirectory(before, "Process-job registry");
  if (await directoryHasEntry(path)) return false;
  if (await realpath(path) !== path) throw new Error(PROCESS_JOBS_REGISTRY_UNAVAILABLE_ERROR);

  const parentPath = dirname(path);
  const parentBefore = await lstat(parentPath, { bigint: true });
  assertPrivateDirectory(parentBefore, "Process-job registry parent");
  const current = await lstat(path, { bigint: true });
  assertPrivateDirectory(current, "Process-job registry");
  if (!sameFileIdentity(before, current)) throw new Error(PROCESS_JOBS_REGISTRY_UNAVAILABLE_ERROR);
  const parentCurrent = await lstat(parentPath, { bigint: true });
  assertPrivateDirectory(parentCurrent, "Process-job registry parent");
  if (!sameFileIdentity(parentBefore, parentCurrent)) {
    throw new Error(PROCESS_JOBS_REGISTRY_UNAVAILABLE_ERROR);
  }
  try {
    await rmdir(path);
  } catch (error) {
    // An entry appeared after the bounded empty check. Preserve it so the
    // strict loader can fail closed; never recursively clean unknown state.
    if (isErrno(error, "ENOTEMPTY") || isErrno(error, "EEXIST")) return false;
    throw error;
  }
  await syncDirectory(parentPath);
  const parentAfter = await lstat(parentPath, { bigint: true });
  assertPrivateDirectory(parentAfter, "Process-job registry parent");
  if (!sameFileIdentity(parentBefore, parentAfter)) {
    throw new Error(PROCESS_JOBS_REGISTRY_UNAVAILABLE_ERROR);
  }
  try {
    await lstat(path);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return true;
    throw error;
  }
  throw new Error(PROCESS_JOBS_REGISTRY_UNAVAILABLE_ERROR);
}

async function directoryHasEntry(path: string): Promise<boolean> {
  const directory = await opendir(path);
  try {
    return await directory.read() !== null;
  } finally {
    await directory.close();
  }
}

async function ensurePrivateDirectory(path: string, _label: string): Promise<void> {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if (!isErrno(error, "EEXIST")) throw error;
  }
  const before = await lstat(path, { bigint: true });
  if (!before.isDirectory() || before.isSymbolicLink()) throw new Error(PROCESS_JOBS_REGISTRY_UNAVAILABLE_ERROR);
  assertOwned(before);
  await chmod(path, 0o700);
  const after = await lstat(path, { bigint: true });
  if (after.dev !== before.dev || after.ino !== before.ino) throw new Error(PROCESS_JOBS_REGISTRY_UNAVAILABLE_ERROR);
  assertPrivateDirectory(after, "Process-job registry");
}

function assertPrivateDirectory(details: BigIntStats, _label: string): void {
  if (!details.isDirectory() || details.isSymbolicLink() || (details.mode & 0o077n) !== 0n) {
    throw new Error(PROCESS_JOBS_REGISTRY_UNAVAILABLE_ERROR);
  }
  assertOwned(details);
}

function assertRecoveryDirectory(details: BigIntStats): void {
  if (!details.isDirectory() || details.isSymbolicLink()
    || (details.mode & 0o777n) !== 0o700n) {
    throw new Error(PROCESS_JOBS_REGISTRY_UNAVAILABLE_ERROR);
  }
  assertOwned(details);
}

function assertOwned(details: Pick<BigIntStats, "uid">): void {
  if (typeof process.getuid === "function" && details.uid !== BigInt(process.getuid())) {
    throw new Error(PROCESS_JOBS_REGISTRY_UNAVAILABLE_ERROR);
  }
}

function sameFileIdentity(
  left: Pick<BigIntStats, "dev" | "ino">,
  right: Pick<BigIntStats, "dev" | "ino">,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function canonicalAgentRoot(path: string): Promise<string> {
  const canonical = await realpath(resolve(path));
  const details = await lstat(canonical, { bigint: true });
  assertPrivateDirectoryOwner(details);
  return canonical;
}

function assertPrivateDirectoryOwner(details: BigIntStats): void {
  if (!details.isDirectory() || details.isSymbolicLink()) throw new Error(PROCESS_JOBS_REGISTRY_UNAVAILABLE_ERROR);
  assertOwned(details);
}

function relativeSegments(agentRoot: string, stateDir: string): readonly string[] {
  const candidate = resolve(stateDir);
  const relativePath = relative(agentRoot, candidate);
  if (relativePath.length === 0 || relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new Error(PROCESS_JOBS_REGISTRY_UNAVAILABLE_ERROR);
  }
  return validateSegments(relativePath.split(sep));
}

function proof(snapshot: ReadyProcessJobsRootRegistrySnapshot, rootKey: string): ProcessJobsRootRegistrationProof {
  return Object.freeze({ snapshot, rootKey, [REGISTRATION_PROOF]: true as const });
}

function compareSegments(left: readonly string[], right: readonly string[]): number {
  return Buffer.compare(Buffer.from(left.join("/"), "utf8"), Buffer.from(right.join("/"), "utf8"));
}

function sameSegmentRoots(
  left: readonly (readonly string[])[],
  right: readonly (readonly string[])[],
): boolean {
  return left.length === right.length && left.every((root, index) => sameStringArrays(root, right[index] ?? []));
}

function sameStringArrays(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function uniquePaths(paths: readonly string[]): string[] {
  return [...new Set(paths.map((path) => resolve(path)))].sort();
}

function strictDescendant(parent: string, child: string): boolean {
  const candidate = relative(parent, child);
  return candidate.length > 0 && candidate !== ".." && !candidate.startsWith(`..${sep}`) && !isAbsolute(candidate);
}

function pathsOverlap(left: string, right: string): boolean {
  return containsPath(left, right) || containsPath(right, left);
}

/** A private leaf may sit inside the workspace; it must never own the workspace. */
function stateRootContainsWorkspace(
  stateRoot: string,
  lexicalWorkspace: string,
  canonicalWorkspace: string,
): boolean {
  return containsPath(stateRoot, lexicalWorkspace)
    || containsPath(stateRoot, canonicalWorkspace);
}

function containsPath(parent: string, child: string): boolean {
  const candidate = relative(parent, child);
  return candidate.length === 0 || (candidate !== ".." && !candidate.startsWith(`..${sep}`) && !isAbsolute(candidate));
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return sameStringArrays(actual, expected);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value);
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === code;
}
