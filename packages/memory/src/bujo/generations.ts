import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";

import { canonicalMemoryRootPath } from "./path-safety.js";
import type { BujoTier } from "./types.js";

export const MANAGED_INDEX_SCHEMA_VERSION = 1;
export const MEMORY_REBUILD_POLICY_VERSION = "mono-agent-memory-rebuild-v1";

const GENERATION_RE = /^g-[0-9]{8}T[0-9]{9}Z-[a-f0-9-]{36}$/u;
const SOURCE_LOCATION_RE = /^(?:daily\/[^/]+|\d{4}-\d{2}-\d{2})\.md:\d+$/u;
const MANAGED_DIR = ".index";
const MANIFEST_FILE = "manifest.json";
const WRITER_LOCK_FILE = "writer.lock";

export interface ManagedGeneration {
  readonly name: string;
  readonly tier: BujoTier;
  readonly sourceFingerprint: string;
  readonly policyVersion: string;
  readonly createdAt: string;
  readonly embeddingModel?: string;
  readonly dimension?: number;
  readonly origin: "rebuild" | "legacy-snapshot";
  /** Trusted logical state commitment; required before a generation can be activated as rollback. */
  readonly integrityDigest?: string;
  readonly skippedRawRecords?: number;
  readonly skippedUnstructuredRecords?: number;
  readonly skippedMissingIdentityRecords?: number;
  readonly missingIdentityLocations?: readonly string[];
  readonly skippedLegacySourceRecords?: number;
  readonly legacySourceLocations?: readonly string[];
  readonly skippedJournalDuplicateRecords?: number;
  readonly parsedSourceItems?: number;
  readonly derivedLegacyAssociations?: number;
}

export interface ManagedIndexManifest {
  readonly schemaVersion: typeof MANAGED_INDEX_SCHEMA_VERSION;
  readonly active: ManagedGeneration;
  readonly rollback?: ManagedGeneration;
}

export interface MemoryWriterLease {
  readonly root: string;
  readonly path: string;
  release(): void;
}

export interface MemoryWriterLeaseHooks {
  /** Test-only seam for a post-O_EXCL write/fsync failure. */
  readonly afterCreate?: () => void;
}

export interface ManagedManifestState {
  readonly exists: boolean;
  readonly dev?: number;
  readonly ino?: number;
  readonly sha256?: string;
}

export interface ManagedLayoutState {
  readonly managed: { readonly dev: number; readonly ino: number };
  readonly generations: { readonly dev: number; readonly ino: number };
}

export interface SafeSqlitePathState {
  readonly exists: boolean;
  readonly dev?: number;
  readonly ino?: number;
}

export function captureManagedManifestState(root: string): ManagedManifestState {
  const canonicalRoot = canonicalMemoryRoot(root, true);
  const path = manifestPath(canonicalRoot);
  if (!existsSync(path)) {
    assertSafeExistingAncestors(canonicalRoot, dirname(path));
    return { exists: false };
  }
  assertSafeRegularFile(canonicalRoot, path, "managed memory manifest");
  const stat = lstatSync(path);
  return {
    exists: true,
    dev: stat.dev,
    ino: stat.ino,
    sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
  };
}

/** Pin the real managed directories so later leaf checks cannot be redirected through a replaced ancestor. */
export function captureManagedLayoutState(root: string): ManagedLayoutState {
  const canonicalRoot = canonicalMemoryRoot(root, true);
  ensureManagedLayout(canonicalRoot);
  return {
    managed: directoryIdentity(canonicalRoot, managedPath(canonicalRoot), "managed memory directory"),
    generations: directoryIdentity(canonicalRoot, generationsPath(canonicalRoot), "memory generations directory"),
  };
}

export function assertManagedLayoutState(root: string, expected: ManagedLayoutState): void {
  const canonicalRoot = canonicalMemoryRoot(root, true);
  assertDirectoryIdentity(canonicalRoot, managedPath(canonicalRoot), expected.managed, "managed memory directory");
  assertDirectoryIdentity(
    canonicalRoot,
    generationsPath(canonicalRoot),
    expected.generations,
    "memory generations directory",
  );
}

export function assertManagedManifestState(root: string, expected: ManagedManifestState): void {
  const actual = captureManagedManifestState(root);
  if (actual.exists !== expected.exists || actual.dev !== expected.dev || actual.ino !== expected.ino
    || actual.sha256 !== expected.sha256) {
    throw new Error("memory-rebuild: managed index manifest changed concurrently; refusing to overwrite it.");
  }
}

/** Resolve the exact active SQLite file once. A valid manifest always wins over legacy memory.db. */
export function resolveActiveMemoryDbPath(root: string): string {
  const canonicalRoot = canonicalMemoryRoot(root, true);
  const manifest = readManagedIndexManifest(canonicalRoot);
  if (manifest === undefined) {
    const path = join(canonicalRoot, "memory.db");
    captureSafeSqlitePathState(canonicalRoot, path, "legacy memory database");
    return path;
  }
  return generationDbPath(canonicalRoot, manifest.active.name, true);
}

export function readManagedIndexManifest(root: string): ManagedIndexManifest | undefined {
  const canonicalRoot = canonicalMemoryRoot(root, true);
  const path = manifestPath(canonicalRoot);
  if (!existsSync(path)) {
    assertSafeExistingAncestors(canonicalRoot, dirname(path));
    return undefined;
  }
  assertSafeRegularFile(canonicalRoot, path, "managed memory manifest");
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`memory-rebuild: managed index manifest is malformed: ${reasonOf(error)}`);
  }
  const manifest = parseManifest(parsed);
  generationDbPath(canonicalRoot, manifest.active.name, true);
  if (manifest.rollback !== undefined) generationDbPath(canonicalRoot, manifest.rollback.name, true);
  return manifest;
}

export function managedGenerationDbPath(root: string, name: string, requireExisting = false): string {
  return generationDbPath(canonicalMemoryRoot(root, true), name, requireExisting);
}

export function createManagedGeneration(root: string, now = new Date()): { readonly name: string; readonly dir: string; readonly dbPath: string } {
  const canonicalRoot = canonicalMemoryRoot(root, true);
  ensureManagedLayout(canonicalRoot);
  const stamp = now.toISOString().replaceAll("-", "").replaceAll(":", "").replace(".", "");
  const name = `g-${stamp}-${randomUUID()}`;
  if (!GENERATION_RE.test(name)) throw new Error("memory-rebuild: generated an unsafe generation name.");
  const dir = join(generationsPath(canonicalRoot), name);
  mkdirSync(dir, { mode: 0o700 });
  assertSafeDirectory(canonicalRoot, dir, "memory generation");
  fsyncDirectory(dirname(dir));
  return { name, dir, dbPath: join(dir, "memory.db") };
}

/**
 * Acquire the long-lived configured-writer lease before resolving/opening the DB.
 * Safe rebuild and rollback use the same lease, so they fail before constructing providers.
 */
export function acquireMemoryWriterLease(root: string, hooks: MemoryWriterLeaseHooks = {}): MemoryWriterLease {
  const canonicalRoot = canonicalMemoryRoot(root, true);
  ensureManagedLayout(canonicalRoot);
  const layoutState = captureManagedLayoutState(canonicalRoot);
  const path = join(managedPath(canonicalRoot), WRITER_LOCK_FILE);
  const token = randomUUID();
  const payload = `${JSON.stringify({
    schemaVersion: 1,
    pid: process.pid,
    uid: typeof process.getuid === "function" ? process.getuid() : undefined,
    token,
    createdAt: new Date().toISOString(),
  })}\n`;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let fd: number | undefined;
    let ownedIdentity: { readonly dev: number; readonly ino: number } | undefined;
    try {
      const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0);
      fd = openSync(path, flags, 0o600);
      const created = fstatSync(fd);
      ownedIdentity = { dev: created.dev, ino: created.ino };
      try {
        hooks.afterCreate?.();
        assertManagedLayoutState(canonicalRoot, layoutState);
        const current = fileIdentity(path, canonicalRoot, "memory writer lock");
        if (current.dev !== ownedIdentity.dev || current.ino !== ownedIdentity.ino) {
          throw new Error("memory-rebuild: memory writer lock was replaced during acquisition.");
        }
        writeFileSync(fd, payload, "utf8");
        fsyncSync(fd);
      } finally {
        closeSync(fd);
        fd = undefined;
      }
      fsyncDirectory(dirname(path));
      const identity = fileIdentity(path, canonicalRoot, "memory writer lock");
      let released = false;
      return {
        root: canonicalRoot,
        path,
        release: () => {
          if (released) return;
          released = true;
          const current = safeLockIdentity(path, canonicalRoot);
          if (current === undefined || current.dev !== identity.dev || current.ino !== identity.ino) return;
          const record = parseLock(readFileSync(path, "utf8"));
          if (record.token !== token) return;
          unlinkSync(path);
          fsyncDirectory(dirname(path));
        },
      };
    } catch (error) {
      const cleanupErrors: unknown[] = [];
      if (fd !== undefined) {
        try { closeSync(fd); } catch (closeError) { cleanupErrors.push(closeError); }
      }
      if (ownedIdentity !== undefined) {
        try {
          const current = safeLockIdentity(path, canonicalRoot);
          if (current !== undefined && current.dev === ownedIdentity.dev && current.ino === ownedIdentity.ino) {
            unlinkSync(path);
            fsyncDirectory(dirname(path));
          }
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
        }
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError([error, ...cleanupErrors], "memory-rebuild: writer lease acquisition and cleanup failed.");
      }
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || ownedIdentity !== undefined) throw error;
      if (attempt === 0 && removeProvenStaleLock(canonicalRoot, path)) continue;
      throw new Error("memory-rebuild: an active memory writer or rebuild owns this root; stop it and retry.");
    }
  }
  throw new Error("memory-rebuild: could not acquire the memory writer lease.");
}

export async function activateManagedIndex(
  root: string,
  manifest: ManagedIndexManifest,
  hooks: {
    readonly afterManifestTempFsync?: () => void | Promise<void>;
    readonly beforeManifestRename?: () => void;
    readonly afterManifestRename?: () => void | Promise<void>;
    readonly afterManifestDirFsync?: () => void | Promise<void>;
  } = {},
): Promise<void> {
  const canonicalRoot = canonicalMemoryRoot(root, true);
  ensureManagedLayout(canonicalRoot);
  const layoutState = captureManagedLayoutState(canonicalRoot);
  validateManifest(manifest);
  generationDbPath(canonicalRoot, manifest.active.name, true);
  if (manifest.rollback !== undefined) generationDbPath(canonicalRoot, manifest.rollback.name, true);

  const path = manifestPath(canonicalRoot);
  const temp = join(managedPath(canonicalRoot), `.manifest-${randomUUID()}.tmp`);
  const data = `${JSON.stringify(manifest, null, 2)}\n`;
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0);
  let renamed = false;
  let tempIdentity!: { readonly dev: number; readonly ino: number };
  const expectedTempDigest = createHash("sha256").update(data).digest("hex");
  const assertManifestTemp = (): void => {
    const current = fileIdentity(temp, canonicalRoot, "managed memory manifest temporary file");
    if (current.dev !== tempIdentity.dev || current.ino !== tempIdentity.ino
      || createHash("sha256").update(readFileSync(temp)).digest("hex") !== expectedTempDigest) {
      throw new Error("memory-rebuild: managed index manifest temporary file changed before activation.");
    }
  };
  const assertActivatedManifest = (): void => {
    const current = fileIdentity(path, canonicalRoot, "managed memory manifest");
    if (current.dev !== tempIdentity.dev || current.ino !== tempIdentity.ino
      || createHash("sha256").update(readFileSync(path)).digest("hex") !== expectedTempDigest) {
      throw new Error("memory-rebuild: activated managed index manifest changed during durability confirmation.");
    }
  };
  try {
    const fd = openSync(temp, flags, 0o600);
    try {
      writeFileSync(fd, data, "utf8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    tempIdentity = fileIdentity(temp, canonicalRoot, "managed memory manifest temporary file");
    await hooks.afterManifestTempFsync?.();
    hooks.beforeManifestRename?.();
    assertManagedLayoutState(canonicalRoot, layoutState);
    // No JavaScript yield remains between this exact-byte/identity check and
    // the same-directory rename.
    assertManifestTemp();
    renameSync(temp, path);
    renamed = true;
    assertActivatedManifest();
    await hooks.afterManifestRename?.();
    assertManagedLayoutState(canonicalRoot, layoutState);
    assertActivatedManifest();
    fsyncDirectory(dirname(path));
    assertActivatedManifest();
    await hooks.afterManifestDirFsync?.();
    assertManagedLayoutState(canonicalRoot, layoutState);
    assertActivatedManifest();
  } catch (error) {
    if (!renamed) {
      try {
        assertManagedLayoutState(canonicalRoot, layoutState);
        if (existsSync(temp)) unlinkSync(temp);
      } catch {
        // Never follow a replaced managed ancestor merely to clean up a temp file.
      }
    }
    if (renamed) {
      throw new Error(`memory-rebuild: manifest activation completed but durability reporting is uncertain: ${reasonOf(error)}`);
    }
    throw error;
  }
}

export function canonicalMemoryRoot(root: string, create: boolean): string {
  const canonical = canonicalMemoryRootPath(root, create);
  assertSafeDirectory(canonical, canonical, "memory root");
  return canonical;
}

export function fsyncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function assertSafeRegularFile(root: string, path: string, label: string): void {
  assertInside(root, path);
  assertSafeAncestors(root, dirname(path));
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
    throw new Error(`memory-rebuild: ${label} must be a regular, single-link file and not a symlink.`);
  }
}

export function assertSafeDirectory(root: string, path: string, label: string): void {
  assertInside(root, path);
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`memory-rebuild: ${label} must be a real directory and not a symlink.`);
  }
  if (resolve(path) !== resolve(root)) assertSafeAncestors(root, dirname(path));
}

/** Validate a SQLite database and any pre-existing sidecars without following links. */
export function captureSafeSqlitePathState(root: string, path: string, label: string): SafeSqlitePathState {
  assertInside(root, path);
  assertSafeAncestors(root, dirname(path));
  const state = optionalRegularFileState(path, label);
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    optionalRegularFileState(`${path}${suffix}`, `${label} ${suffix.slice(1)} sidecar`);
  }
  return state;
}

/** Revalidate after SQLite opens and reject a path-identity swap across the open boundary. */
export function assertSafeSqlitePathState(
  root: string,
  path: string,
  expected: SafeSqlitePathState,
  label: string,
): void {
  const actual = captureSafeSqlitePathState(root, path, label);
  if (!actual.exists) throw new Error(`memory-rebuild: ${label} was not created as a regular file.`);
  if (expected.exists && (actual.dev !== expected.dev || actual.ino !== expected.ino)) {
    throw new Error(`memory-rebuild: ${label} changed identity while it was being opened.`);
  }
}

function parseManifest(value: unknown): ManagedIndexManifest {
  validateManifest(value);
  return value;
}

function validateManifest(value: unknown): asserts value is ManagedIndexManifest {
  if (!isRecord(value) || value.schemaVersion !== MANAGED_INDEX_SCHEMA_VERSION) {
    throw new Error("memory-rebuild: managed index manifest has an unsupported schema version.");
  }
  validateGeneration(value.active, "active");
  if (value.rollback !== undefined) validateGeneration(value.rollback, "rollback");
}

function validateGeneration(value: unknown, label: string): asserts value is ManagedGeneration {
  if (!isRecord(value)
    || typeof value.name !== "string" || !GENERATION_RE.test(value.name)
    || (value.tier !== "lite" && value.tier !== "journal" && value.tier !== "bujo")
    || typeof value.sourceFingerprint !== "string" || !/^[a-f0-9]{64}$/u.test(value.sourceFingerprint)
    || value.policyVersion !== MEMORY_REBUILD_POLICY_VERSION
    || typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt))
    || (value.origin !== "rebuild" && value.origin !== "legacy-snapshot")
    || (value.integrityDigest !== undefined
      && (typeof value.integrityDigest !== "string" || !/^[a-f0-9]{64}$/u.test(value.integrityDigest)))
    || (value.embeddingModel !== undefined && typeof value.embeddingModel !== "string")
    || (value.dimension !== undefined && (!Number.isInteger(value.dimension) || Number(value.dimension) <= 0))
    || !optionalNonNegativeInteger(value.skippedRawRecords)
    || !optionalNonNegativeInteger(value.skippedUnstructuredRecords)
    || !optionalNonNegativeInteger(value.skippedMissingIdentityRecords)
    || (value.missingIdentityLocations !== undefined && (!Array.isArray(value.missingIdentityLocations)
      || value.missingIdentityLocations.some((location) => typeof location !== "string" || !SOURCE_LOCATION_RE.test(location))))
    || (Array.isArray(value.missingIdentityLocations) && value.skippedMissingIdentityRecords !== undefined
      && value.missingIdentityLocations.length !== value.skippedMissingIdentityRecords)
    || !optionalNonNegativeInteger(value.skippedLegacySourceRecords)
    || (value.legacySourceLocations !== undefined && (!Array.isArray(value.legacySourceLocations)
      || value.legacySourceLocations.some((location) => typeof location !== "string" || !SOURCE_LOCATION_RE.test(location))))
    || (Array.isArray(value.legacySourceLocations) && value.skippedLegacySourceRecords !== undefined
      && value.legacySourceLocations.length !== value.skippedLegacySourceRecords)
    || !optionalNonNegativeInteger(value.skippedJournalDuplicateRecords)
    || !optionalNonNegativeInteger(value.parsedSourceItems)
    || !optionalNonNegativeInteger(value.derivedLegacyAssociations)) {
    throw new Error(`memory-rebuild: managed index manifest ${label} generation is malformed.`);
  }
}

function optionalNonNegativeInteger(value: unknown): boolean {
  return value === undefined || (Number.isInteger(value) && Number(value) >= 0);
}

function generationDbPath(root: string, name: string, requireExisting: boolean): string {
  if (!GENERATION_RE.test(name)) throw new Error("memory-rebuild: unsafe generation name in manifest.");
  const dir = join(generationsPath(root), name);
  const db = join(dir, "memory.db");
  if (requireExisting) {
    assertSafeDirectory(root, dir, "memory generation");
    assertSafeRegularFile(root, db, "memory generation database");
    captureSafeSqlitePathState(root, db, "memory generation database");
  }
  return db;
}

function optionalRegularFileState(path: string, label: string): SafeSqlitePathState {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
      throw new Error(`memory-rebuild: ${label} must be a regular, single-link file and not a symlink.`);
    }
    return { exists: true, dev: stat.dev, ino: stat.ino };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { exists: false };
    throw error;
  }
}

function ensureManagedLayout(root: string): void {
  const managed = managedPath(root);
  const generations = generationsPath(root);
  ensureManagedDirectory(root, managed, "managed memory directory");
  ensureManagedDirectory(root, generations, "memory generations directory");
}

function ensureManagedDirectory(root: string, path: string, label: string): void {
  if (!existsSync(path)) {
    try {
      mkdirSync(path, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    // Persist the directory entry in its parent before any lock, generation,
    // or manifest inside this directory is treated as a durable boundary.
    fsyncDirectory(dirname(path));
  }
  assertSafeDirectory(root, path, label);
}

function directoryIdentity(
  root: string,
  path: string,
  label: string,
): { readonly dev: number; readonly ino: number } {
  assertSafeDirectory(root, path, label);
  const stat = lstatSync(path);
  return { dev: stat.dev, ino: stat.ino };
}

function assertDirectoryIdentity(
  root: string,
  path: string,
  expected: { readonly dev: number; readonly ino: number },
  label: string,
): void {
  const actual = directoryIdentity(root, path, label);
  if (actual.dev !== expected.dev || actual.ino !== expected.ino) {
    throw new Error(`memory-rebuild: ${label} was replaced concurrently.`);
  }
}

function managedPath(root: string): string {
  return join(root, MANAGED_DIR);
}

function generationsPath(root: string): string {
  return join(managedPath(root), "generations");
}

function manifestPath(root: string): string {
  return join(managedPath(root), MANIFEST_FILE);
}

function assertSafeAncestors(root: string, path: string): void {
  assertInside(root, path);
  const rel = relative(root, path);
  if (rel === "") return;
  let current = root;
  for (const component of rel.split(sep)) {
    current = join(current, component);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error("memory-rebuild: paths inside the canonical memory root must not contain symlinks.");
    }
  }
}

function assertSafeExistingAncestors(root: string, path: string): void {
  assertInside(root, path);
  const rel = relative(root, path);
  if (rel === "") return;
  let current = root;
  for (const component of rel.split(sep)) {
    current = join(current, component);
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error("memory-rebuild: paths inside the canonical memory root must not contain symlinks.");
    }
  }
}

function assertInside(root: string, path: string): void {
  const rel = relative(resolve(root), resolve(path));
  if (rel === ".." || rel.startsWith(`..${sep}`) || resolve(path) === resolve(root) && path !== root) {
    throw new Error("memory-rebuild: managed path escapes the canonical memory root.");
  }
}

function removeProvenStaleLock(root: string, path: string): boolean {
  const identity = safeLockIdentity(path, root);
  if (identity === undefined) return false;
  let record: ReturnType<typeof parseLock>;
  try {
    record = parseLock(readFileSync(path, "utf8"));
  } catch {
    return false;
  }
  if (typeof process.getuid === "function" && record.uid !== process.getuid()) return false;
  try {
    process.kill(record.pid, 0);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") return false;
  }
  const current = safeLockIdentity(path, root);
  if (current === undefined || current.dev !== identity.dev || current.ino !== identity.ino) return false;
  unlinkSync(path);
  fsyncDirectory(dirname(path));
  return true;
}

function safeLockIdentity(path: string, root: string): { readonly dev: number; readonly ino: number } | undefined {
  try {
    assertSafeAncestors(root, dirname(path));
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600) return undefined;
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) return undefined;
    assertInside(root, path);
    return { dev: stat.dev, ino: stat.ino };
  } catch {
    return undefined;
  }
}

function fileIdentity(path: string, root: string, label: string): { readonly dev: number; readonly ino: number } {
  assertSafeRegularFile(root, path, label);
  const stat = lstatSync(path);
  if ((stat.mode & 0o777) !== 0o600) throw new Error(`memory-rebuild: ${label} must use mode 0600.`);
  return { dev: stat.dev, ino: stat.ino };
}

function parseLock(raw: string): { readonly pid: number; readonly uid?: number; readonly token: string } {
  const value = JSON.parse(raw) as unknown;
  if (!isRecord(value) || value.schemaVersion !== 1 || !Number.isInteger(value.pid) || Number(value.pid) <= 0
    || typeof value.token !== "string" || value.token.length === 0
    || (value.uid !== undefined && !Number.isInteger(value.uid))) {
    throw new Error("memory-rebuild: malformed writer lock.");
  }
  return {
    pid: Number(value.pid),
    ...(value.uid === undefined ? {} : { uid: Number(value.uid) }),
    token: value.token,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
