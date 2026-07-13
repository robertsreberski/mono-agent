import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { userInfo } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import process from "node:process";

import {
  currentProcessIncarnation,
  isSameProcessIncarnation as matchesProcessIncarnation,
  processIncarnationFromJson,
} from "./process-incarnation.js";
import type { ProcessIncarnation, SameProcessIncarnation } from "./process-incarnation.js";

const LEASE_SCHEMA = "mono-agent.background-worker-lease.v2";
const DEFAULT_OWNERLESS_GRACE_MS = 5 * 60_000;
const MAX_ACQUIRE_ATTEMPTS = 4;

interface WorkerLeaseOwner {
  readonly schema: typeof LEASE_SCHEMA;
  readonly configPath: string;
  readonly pid: number;
  readonly token: string;
  readonly createdAt: string;
  readonly incarnation: ProcessIncarnation;
}

export interface BackgroundWorkerLease {
  readonly configPath: string;
  readonly path: string;
  readonly ownerPid: number;
  /** Idempotently release only this process's exact lease token. */
  release(): Promise<void>;
}

export interface BackgroundWorkerLeaseOptions {
  readonly homeDir?: string;
  readonly pid?: number;
  readonly now?: () => number;
  /** Test/embed seam for the owner record written by this acquisition. */
  readonly processIncarnation?: ProcessIncarnation;
  /** Test/embed seam; production checks boot session plus process birth. */
  readonly isSameProcessIncarnation?: SameProcessIncarnation;
  readonly randomToken?: () => string;
  readonly ownerlessGraceMs?: number;
  /** Narrow deterministic seams for filesystem-race tests. */
  readonly hooks?: {
    readonly afterLeaseDirectoryCreated?: () => Promise<void>;
    readonly beforeStaleLeaseRename?: () => Promise<void>;
  };
}

interface LeaseDirectoryIdentity {
  readonly dev: number | bigint;
  readonly ino: number | bigint;
}

type ExistingLease =
  | { readonly kind: "owned"; readonly owner: WorkerLeaseOwner; readonly identity: LeaseDirectoryIdentity }
  | { readonly kind: "ownerless"; readonly mtimeMs: number; readonly identity: LeaseDirectoryIdentity };

/**
 * Stable owner-private lifetime-lease path for one exact resolved config.
 * The full path digest avoids relying on the shorter human-facing launchd hash.
 */
export function backgroundWorkerLeasePath(
  configPath: string,
  homeDir: string = effectiveUserHome(),
): string {
  const resolvedConfig = resolve(configPath);
  const digest = createHash("sha256").update(resolvedConfig).digest("hex");
  return join(resolve(homeDir), ".mono-agent", "worker-leases", `${digest}.lease`);
}

/**
 * Acquire the process-lifetime singleton for a config.
 *
 * `undefined` means either a live owner or a fresh ownerless directory (the
 * atomic mkdir -> owner.json initialization window) already holds the lease.
 * Dead owners and old ownerless crash debris are atomically quarantined before
 * one bounded retry. The returned lease must be held until worker shutdown.
 */
export async function acquireBackgroundWorkerLease(
  configPath: string,
  options: BackgroundWorkerLeaseOptions = {},
): Promise<BackgroundWorkerLease | undefined> {
  const resolvedConfig = await canonicalLeaseConfigPath(configPath);
  // The singleton location belongs to the effective OS account, not an
  // ambient HOME override. Tests and explicit embeddings retain a narrow
  // homeDir seam, while normal workers always converge on one lease root.
  const home = resolve(options.homeDir ?? effectiveUserHome());
  const pid = options.pid ?? process.pid;
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error(`Background worker lease pid must be a positive safe integer; received ${String(pid)}.`);
  }
  const now = options.now ?? (() => Date.now());
  const incarnation = options.processIncarnation ?? await currentProcessIncarnation();
  const isSameProcess = options.isSameProcessIncarnation ?? matchesProcessIncarnation;
  const randomToken = options.randomToken ?? randomUUID;
  const ownerlessGraceMs = options.ownerlessGraceMs ?? DEFAULT_OWNERLESS_GRACE_MS;
  if (!Number.isFinite(ownerlessGraceMs) || ownerlessGraceMs < 0) {
    throw new Error("Background worker lease ownerless grace must be a non-negative finite duration.");
  }

  const leasesRoot = await ensurePrivateLeaseRoot(home);
  const leasePath = backgroundWorkerLeasePath(resolvedConfig, home);
  const leaseId = basename(leasePath, ".lease");
  const ownerPath = join(leasePath, "owner.json");

  for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt += 1) {
    let createdIdentity: LeaseDirectoryIdentity | undefined;
    try {
      await mkdir(leasePath, { mode: 0o700 });
      const created = await assertPrivateDirectory(leasePath, "Background worker lease");
      createdIdentity = identityOf(created);
      await options.hooks?.afterLeaseDirectoryCreated?.();
      await assertSamePrivateDirectory(leasePath, createdIdentity, "Background worker lease");

      const token = safeToken(randomToken());
      const owner: WorkerLeaseOwner = {
        schema: LEASE_SCHEMA,
        configPath: resolvedConfig,
        pid,
        token,
        createdAt: new Date(now()).toISOString(),
        incarnation,
      };
      await writeOwnerRecord(ownerPath, owner);
      await assertSamePrivateDirectory(leasePath, createdIdentity, "Background worker lease");
      return createLease({
        configPath: resolvedConfig,
        leasePath,
        leasesRoot,
        owner,
        identity: createdIdentity,
        leaseId,
        randomToken,
      });
    } catch (error) {
      if (createdIdentity !== undefined) {
        await removeIfSameDirectory(leasePath, createdIdentity).catch(() => undefined);
      }
      if (!isErrno(error, "EEXIST")) throw error;
    }

    const existing = await inspectExistingLease(leasePath, ownerPath, resolvedConfig);
    if (existing === undefined) continue;
    if (existing.kind === "owned") {
      let sameOwner = true;
      try {
        sameOwner = await isSameProcess(existing.owner.pid, existing.owner.incarnation);
      } catch {
        // A failed incarnation probe cannot authorize stealing another process's lease.
        sameOwner = true;
      }
      if (sameOwner) return undefined;
    } else if (now() - existing.mtimeMs < ownerlessGraceMs) {
      // Never steal the normal mkdir -> owner.json initialization window.
      return undefined;
    }

    await options.hooks?.beforeStaleLeaseRename?.();
    if (!(await samePrivateDirectory(leasePath, existing.identity))) continue;
    const quarantine = join(
      leasesRoot,
      `.${leaseId}-${now()}-${pid}-${safeToken(randomToken())}.stale`,
    );
    try {
      await rename(leasePath, quarantine);
    } catch (error) {
      if (isErrno(error, "ENOENT") || isErrno(error, "EEXIST")) continue;
      return undefined;
    }
    const moved = await lstat(quarantine);
    if (!sameIdentity(moved, existing.identity)) {
      // A same-user path swap crossed the final rename boundary. Restore when
      // possible and fail closed rather than claiming a potentially live lease.
      await rename(quarantine, leasePath).catch(() => undefined);
      return undefined;
    }
    await rm(quarantine, { recursive: true, force: true });
  }
  return undefined;
}

async function canonicalLeaseConfigPath(configPath: string): Promise<string> {
  const lexical = resolve(configPath);
  try {
    const candidate = join(await realpath(dirname(lexical)), basename(lexical));
    try {
      const details = await lstat(candidate);
      return details.isSymbolicLink() ? candidate : await realpath(candidate);
    } catch (error) {
      if (isErrno(error, "ENOENT") || isErrno(error, "ENOTDIR")) return candidate;
      throw error;
    }
  } catch (error) {
    // The lease helper is also useful for fail-closed diagnostics/tests before
    // a config exists. Normal foreground startup has already required the
    // config and therefore always takes the canonical-parent branch.
    if (isErrno(error, "ENOENT") || isErrno(error, "ENOTDIR")) return lexical;
    throw error;
  }
}

function effectiveUserHome(): string {
  const home = userInfo().homedir;
  if (home.length === 0) {
    throw new Error("Cannot determine the effective OS user's home for the background worker lease.");
  }
  return home;
}

function createLease(input: {
  readonly configPath: string;
  readonly leasePath: string;
  readonly leasesRoot: string;
  readonly owner: WorkerLeaseOwner;
  readonly identity: LeaseDirectoryIdentity;
  readonly leaseId: string;
  readonly randomToken: () => string;
}): BackgroundWorkerLease {
  let released = false;
  return {
    configPath: input.configPath,
    path: input.leasePath,
    ownerPid: input.owner.pid,
    async release(): Promise<void> {
      if (released) return;
      await assertSamePrivateDirectory(input.leasePath, input.identity, "Background worker lease");
      const current = await readOwnerRecord(join(input.leasePath, "owner.json"), input.configPath);
      if (current === undefined
        || current.pid !== input.owner.pid
        || current.token !== input.owner.token) {
        throw new Error(`Background worker lease ${input.leasePath} is no longer owned by this worker.`);
      }
      const releasedPath = join(
        input.leasesRoot,
        `.${input.leaseId}-${input.owner.pid}-${safeToken(input.randomToken())}.released`,
      );
      await rename(input.leasePath, releasedPath);
      const moved = await assertPrivateDirectory(releasedPath, "Released background worker lease");
      if (!sameIdentity(moved, input.identity)) {
        await rename(releasedPath, input.leasePath).catch(() => undefined);
        throw new Error(`Background worker lease ${input.leasePath} changed during release.`);
      }
      released = true;
      await rm(releasedPath, { recursive: true, force: true });
    },
  };
}

async function ensurePrivateLeaseRoot(home: string): Promise<string> {
  const homeDetails = await lstat(home);
  if (!homeDetails.isDirectory() || homeDetails.isSymbolicLink()) {
    throw new Error(`Background worker lease home ${home} must be a real directory.`);
  }
  assertOwned(homeDetails, home, "Background worker lease home");

  const managedRoot = join(home, ".mono-agent");
  const leasesRoot = join(managedRoot, "worker-leases");
  for (const path of [managedRoot, leasesRoot]) {
    try {
      await mkdir(path, { mode: 0o700 });
    } catch (error) {
      if (!isErrno(error, "EEXIST")) throw error;
    }
    const before = await lstat(path);
    if (!before.isDirectory() || before.isSymbolicLink()) {
      throw new Error(`Background worker lease parent ${path} must be a real directory.`);
    }
    assertOwned(before, path, "Background worker lease parent");
    await chmod(path, 0o700);
    const secured = await lstat(path);
    if (!sameIdentity(secured, identityOf(before))) {
      throw new Error(`Background worker lease parent ${path} changed while it was secured.`);
    }
    assertPrivateDirectoryDetails(secured, path, "Background worker lease parent");
  }
  return leasesRoot;
}

async function inspectExistingLease(
  leasePath: string,
  ownerPath: string,
  configPath: string,
): Promise<ExistingLease | undefined> {
  let details;
  try {
    details = await assertPrivateDirectory(leasePath, "Existing background worker lease");
  } catch (error) {
    if (isErrno(error, "ENOENT")) return undefined;
    throw error;
  }
  const identity = identityOf(details);
  const owner = await readOwnerRecord(ownerPath, configPath);
  return owner === undefined
    ? { kind: "ownerless", mtimeMs: details.mtimeMs, identity }
    : { kind: "owned", owner, identity };
}

async function writeOwnerRecord(path: string, owner: WorkerLeaseOwner): Promise<void> {
  const flags = fsConstants.O_WRONLY
    | fsConstants.O_CREAT
    | fsConstants.O_EXCL
    | (fsConstants.O_NOFOLLOW ?? 0);
  const handle = await open(path, flags, 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
    await handle.sync();
    assertPrivateOwnerFile(await handle.stat(), path);
  } finally {
    await handle.close();
  }
}

async function readOwnerRecord(path: string, configPath: string): Promise<WorkerLeaseOwner | undefined> {
  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
  let handle;
  try {
    handle = await open(path, flags);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return undefined;
    throw error;
  }
  try {
    assertPrivateOwnerFile(await handle.stat(), path);
    let parsed: Partial<WorkerLeaseOwner>;
    try {
      parsed = JSON.parse(await handle.readFile("utf8")) as Partial<WorkerLeaseOwner>;
    } catch {
      return undefined;
    }
    const incarnation = processIncarnationFromJson(parsed.incarnation);
    return parsed.schema === LEASE_SCHEMA
      && parsed.configPath === configPath
      && typeof parsed.pid === "number"
      && Number.isSafeInteger(parsed.pid)
      && parsed.pid > 0
      && typeof parsed.token === "string"
      && parsed.token.length > 0
      && typeof parsed.createdAt === "string"
      && incarnation !== undefined
      ? {
        schema: LEASE_SCHEMA,
        configPath,
        pid: parsed.pid,
        token: parsed.token,
        createdAt: parsed.createdAt,
        incarnation,
      }
      : undefined;
  } finally {
    await handle.close();
  }
}

async function assertPrivateDirectory(path: string, label: string) {
  const details = await lstat(path);
  assertPrivateDirectoryDetails(details, path, label);
  return details;
}

function assertPrivateDirectoryDetails(
  details: Stats,
  path: string,
  label: string,
): void {
  if (!details.isDirectory() || details.isSymbolicLink()) {
    throw new Error(`${label} ${path} must be a real directory.`);
  }
  assertOwned(details, path, label);
  if ((details.mode & 0o077) !== 0) {
    throw new Error(`${label} ${path} must be owner-only (mode 0700).`);
  }
}

function assertPrivateOwnerFile(
  details: Stats,
  path: string,
): void {
  if (!details.isFile()
    || details.isSymbolicLink()
    || details.nlink !== 1
    || (details.mode & 0o077) !== 0) {
    throw new Error(`Background worker lease owner ${path} must be an owner-only single-link regular file.`);
  }
  assertOwned(details, path, "Background worker lease owner");
}

function assertOwned(
  details: { readonly uid: number },
  path: string,
  label: string,
): void {
  if (typeof process.getuid === "function" && details.uid !== process.getuid()) {
    throw new Error(`${label} ${path} is not owned by the current user.`);
  }
}

async function assertSamePrivateDirectory(
  path: string,
  identity: LeaseDirectoryIdentity,
  label: string,
): Promise<void> {
  const details = await assertPrivateDirectory(path, label);
  if (!sameIdentity(details, identity)) {
    throw new Error(`${label} ${path} changed while the lease was active.`);
  }
}

async function samePrivateDirectory(path: string, identity: LeaseDirectoryIdentity): Promise<boolean> {
  try {
    const details = await assertPrivateDirectory(path, "Background worker lease");
    return sameIdentity(details, identity);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return false;
    throw error;
  }
}

async function removeIfSameDirectory(path: string, identity: LeaseDirectoryIdentity): Promise<void> {
  if (await samePrivateDirectory(path, identity)) {
    await rm(path, { recursive: true, force: true });
  }
}

function identityOf(details: { readonly dev: number | bigint; readonly ino: number | bigint }): LeaseDirectoryIdentity {
  return { dev: details.dev, ino: details.ino };
}

function sameIdentity(
  details: { readonly dev: number | bigint; readonly ino: number | bigint },
  identity: LeaseDirectoryIdentity,
): boolean {
  return details.dev === identity.dev && details.ino === identity.ino;
}

function safeToken(value: string): string {
  if (!/^[0-9A-Za-z._-]+$/u.test(value) || value.length === 0) {
    throw new Error("Background worker lease token contains unsupported characters.");
  }
  return value;
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === code;
}
