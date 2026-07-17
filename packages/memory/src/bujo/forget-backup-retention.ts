import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  type Stats,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { acquireMemoryMaintenanceLease } from "./maintenance.js";

export const DEFAULT_MEMORY_FORGET_BACKUP_MAX_AGE_DAYS = 30;
export const DEFAULT_MEMORY_FORGET_BACKUP_MAX_COUNT = 3;

const DAY_MS = 24 * 60 * 60 * 1_000;
const MAX_MANIFEST_BYTES = 64 * 1_024;
const SHA256_RE = /^[a-f0-9]{64}$/u;

export interface MemoryForgetBackupRetentionOptions {
  readonly root: string;
  readonly dryRun?: boolean;
  readonly clock?: () => number;
  readonly shouldContinue?: () => boolean;
}

export interface MemoryForgetBackupRetentionResult {
  readonly root: string;
  readonly dryRun: boolean;
  readonly candidateCount: number;
  readonly retainedCount: number;
  readonly prunedCount: number;
  readonly prunedPaths: readonly string[];
  readonly warnings: readonly string[];
  readonly skippedForActiveMaintenance: boolean;
}

interface Candidate {
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly updatedAtMs: number;
  readonly policy: "bounded" | "staging" | "discardable";
  readonly dev: number;
  readonly ino: number;
}

interface RetentionRoot {
  readonly root: string;
  readonly parent: string;
  readonly rootName: string;
}

/** Bound package-owned and conventional operator forget snapshots for one built-in memory root. */
export function pruneExplicitMemoryForgetBackups(
  options: MemoryForgetBackupRetentionOptions,
): MemoryForgetBackupRetentionResult {
  const dryRun = options.dryRun ?? false;
  const warnings: string[] = [];
  const retentionRoot = resolveRetentionRoot(options.root, warnings);
  if (retentionRoot === undefined) {
    return emptyResult(resolve(options.root), dryRun, warnings);
  }

  let maintenance: ReturnType<typeof acquireMemoryMaintenanceLease>;
  try {
    maintenance = acquireMemoryMaintenanceLease(retentionRoot.root);
  } catch (error) {
    warnings.push(`sweep skipped because memory maintenance is active: ${reasonOf(error)}`);
    return emptyResult(retentionRoot.root, dryRun, warnings, true);
  }

  try {
    if (existsSync(maintenance.transactionPath)) {
      warnings.push("sweep skipped because a durable memory-maintenance transaction requires recovery");
      return emptyResult(retentionRoot.root, dryRun, warnings, true);
    }
    if (options.shouldContinue?.() === false) {
      return emptyResult(retentionRoot.root, dryRun, warnings);
    }

    const candidates = collectCandidates(retentionRoot, warnings);
    const now = options.clock?.() ?? Date.now();
    const cutoff = now - DEFAULT_MEMORY_FORGET_BACKUP_MAX_AGE_DAYS * DAY_MS;
    const selected = new Set<Candidate>();
    for (const policy of ["bounded", "staging"] as const) {
      candidates
        .filter((candidate) => candidate.policy === policy)
        .sort(compareNewestFirst)
        .forEach((candidate, index) => {
          if (index >= DEFAULT_MEMORY_FORGET_BACKUP_MAX_COUNT || candidate.updatedAtMs < cutoff) {
            selected.add(candidate);
          }
        });
    }
    for (const candidate of candidates) {
      if (candidate.policy === "discardable") selected.add(candidate);
    }

    const prunedPaths: string[] = [];
    for (const candidate of [...selected].sort(compareNewestFirst).reverse()) {
      if (options.shouldContinue?.() === false) break;
      if (dryRun) {
        prunedPaths.push(candidate.relativePath);
        continue;
      }
      try {
        if (!sameSafeDirectory(candidate)) {
          warnings.push(`${candidate.relativePath}: changed before retention removal; preserved`);
          continue;
        }
        rmSync(candidate.absolutePath, { recursive: true, force: false });
        prunedPaths.push(candidate.relativePath);
      } catch (error) {
        warnings.push(`${candidate.relativePath}: removal failed: ${reasonOf(error)}`);
      }
    }

    return {
      root: retentionRoot.root,
      dryRun,
      candidateCount: candidates.length,
      retainedCount: candidates.length - prunedPaths.length,
      prunedCount: prunedPaths.length,
      prunedPaths,
      warnings,
      skippedForActiveMaintenance: false,
    };
  } finally {
    maintenance.release();
  }
}

function resolveRetentionRoot(rawRoot: string, warnings: string[]): RetentionRoot | undefined {
  const absoluteRoot = resolve(rawRoot);
  const rootName = basename(absoluteRoot);
  let parent: string;
  try {
    parent = realpathSync(dirname(absoluteRoot));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    warnings.push(`memory parent is unavailable: ${reasonOf(error)}`);
    return undefined;
  }
  if (!isOwnedNonWritableDirectory(lstatSync(parent))) {
    warnings.push("memory parent is not an owner-controlled real directory");
    return undefined;
  }

  const root = join(parent, rootName);
  if (existsSync(absoluteRoot)) {
    const info = lstatSync(absoluteRoot);
    if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(absoluteRoot) !== root) {
      warnings.push("memory root is not a canonical real directory");
      return undefined;
    }
  }
  return { root, parent, rootName };
}

function collectCandidates(retentionRoot: RetentionRoot, warnings: string[]): Candidate[] {
  const escapedRootName = escapeRegExp(retentionRoot.rootName);
  const managedPrefix = `.${retentionRoot.rootName}-forget-backup-`;
  const managedPattern = new RegExp(`^\\.${escapedRootName}-forget-backup-([a-f0-9]{24})$`, "u");
  const stagingPattern = new RegExp(
    `^\\.${escapedRootName}-forget-backup-[a-f0-9]{24}\\.tmp-[1-9][0-9]*-`
      + "[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$",
    "u",
  );
  const candidates: Candidate[] = [];

  for (const name of readNames(retentionRoot.parent, warnings, ".")) {
    const absolutePath = join(retentionRoot.parent, name);
    const managedMatch = managedPattern.exec(name);
    if (managedMatch !== null) {
      const candidate = inspectManagedCandidate(
        absolutePath,
        name,
        managedMatch[1]!,
        retentionRoot.root,
        warnings,
      );
      if (candidate !== undefined) candidates.push(candidate);
      continue;
    }
    if (name.startsWith(managedPrefix) && stagingPattern.test(name)) {
      const candidate = inspectDirectoryCandidate(absolutePath, name, "staging", warnings);
      if (candidate !== undefined) candidates.push(candidate);
    }
  }

  if (retentionRoot.rootName === "memory" && basename(retentionRoot.parent) === ".mono-agent") {
    const operatorRoot = join(retentionRoot.parent, "operator");
    if (existsSync(operatorRoot)) {
      const operatorInfo = lstatSync(operatorRoot);
      if (!isOwnedNonWritableDirectory(operatorInfo)) {
        warnings.push("operator: directory is not owner-controlled; operator forget backups were preserved");
      } else {
        for (const name of readNames(operatorRoot, warnings, "operator")) {
          if (!name.startsWith("forget-") || name.length === "forget-".length) continue;
          const relativePath = `operator/${name}`;
          const candidate = inspectDirectoryCandidate(
            join(operatorRoot, name),
            relativePath,
            "bounded",
            warnings,
          );
          if (candidate !== undefined) candidates.push(candidate);
        }
      }
    }
  }
  return candidates;
}

function inspectManagedCandidate(
  absolutePath: string,
  relativePath: string,
  nameDigest: string,
  root: string,
  warnings: string[],
): Candidate | undefined {
  let directoryInfo: Stats;
  try {
    directoryInfo = lstatSync(absolutePath);
    if (!isOwnedNonWritableDirectory(directoryInfo)) throw new Error("unsafe directory");
    const manifestPath = join(absolutePath, "manifest.json");
    const manifestInfo = lstatSync(manifestPath);
    if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink()
      || !isOwned(manifestInfo) || (manifestInfo.mode & 0o022) !== 0
      || manifestInfo.size > MAX_MANIFEST_BYTES) {
      throw new Error("unsafe manifest");
    }
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    const createdAtMs = typeof manifest["createdAt"] === "string" ? Date.parse(manifest["createdAt"]) : Number.NaN;
    if (manifest["schemaVersion"] !== 1
      || manifest["operation"] !== "memory-forget-backup"
      || !["prepared", "applying", "applied", "recovered"].includes(String(manifest["status"]))
      || manifest["rootFingerprint"] !== rootFingerprint(root)
      || typeof manifest["planDigest"] !== "string" || !SHA256_RE.test(manifest["planDigest"])
      || !manifest["planDigest"].startsWith(nameDigest)
      || !Number.isFinite(createdAtMs)) {
      throw new Error("invalid or foreign manifest");
    }
    if (manifest["status"] === "applying") {
      warnings.push(`${relativePath}: applying backup was preserved`);
      return undefined;
    }
    return candidateOf(
      absolutePath,
      relativePath,
      createdAtMs,
      manifest["status"] === "recovered" ? "discardable" : "bounded",
      directoryInfo,
    );
  } catch (error) {
    warnings.push(`${relativePath}: ${reasonOf(error)}; preserved`);
    return undefined;
  }
}

function inspectDirectoryCandidate(
  absolutePath: string,
  relativePath: string,
  policy: Candidate["policy"],
  warnings: string[],
): Candidate | undefined {
  try {
    const info = lstatSync(absolutePath);
    if (!isOwnedNonWritableDirectory(info)) throw new Error("unsafe directory");
    return candidateOf(absolutePath, relativePath, info.mtimeMs, policy, info);
  } catch (error) {
    warnings.push(`${relativePath}: ${reasonOf(error)}; preserved`);
    return undefined;
  }
}

function candidateOf(
  absolutePath: string,
  relativePath: string,
  updatedAtMs: number,
  policy: Candidate["policy"],
  info: Stats,
): Candidate {
  return { absolutePath, relativePath, updatedAtMs, policy, dev: info.dev, ino: info.ino };
}

function readNames(directory: string, warnings: string[], label: string): string[] {
  try {
    return readdirSync(directory).sort();
  } catch (error) {
    warnings.push(`${label}: directory scan failed: ${reasonOf(error)}`);
    return [];
  }
}

function sameSafeDirectory(candidate: Candidate): boolean {
  try {
    const info = lstatSync(candidate.absolutePath);
    return isOwnedNonWritableDirectory(info) && info.dev === candidate.dev && info.ino === candidate.ino;
  } catch {
    return false;
  }
}

function isOwnedNonWritableDirectory(info: Stats): boolean {
  return info.isDirectory() && !info.isSymbolicLink() && isOwned(info) && (info.mode & 0o022) === 0;
}

function isOwned(info: Stats): boolean {
  return typeof process.getuid !== "function" || info.uid === process.getuid();
}

function compareNewestFirst(left: Candidate, right: Candidate): number {
  return right.updatedAtMs - left.updatedAtMs || left.relativePath.localeCompare(right.relativePath);
}

function rootFingerprint(root: string): string {
  return createHash("sha256").update(root).digest("hex");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function emptyResult(
  root: string,
  dryRun: boolean,
  warnings: readonly string[],
  skippedForActiveMaintenance = false,
): MemoryForgetBackupRetentionResult {
  return {
    root,
    dryRun,
    candidateCount: 0,
    retainedCount: 0,
    prunedCount: 0,
    prunedPaths: [],
    warnings,
    skippedForActiveMaintenance,
  };
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
