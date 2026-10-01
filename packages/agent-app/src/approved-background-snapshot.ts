import { createHash, randomUUID } from "node:crypto";
import {
  constants, closeSync, fstatSync, fsyncSync, lstatSync, openSync, readSync,
  renameSync, unlinkSync, type Stats,
} from "node:fs";
import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import { ensureOwnerPrivateLaunchdDirectory } from "./launchd-private-files.js";
import { decodeBackgroundSnapshot, encodeBackgroundSnapshot, type BackgroundSnapshot } from "./background-snapshot.js";

const SCHEMA = "mono-agent.approved-startup.v1";
const MAX_BYTES = 65_536;

/** The ORIGINAL cached argv is the anchor, never a subsequently resolved approval. */
export interface ApprovedBackgroundSnapshotBinding {
  readonly managedRoot: string;
  readonly label: string;
  readonly configPath: string;
  readonly encodedSnapshot: string;
  readonly launchProof: string;
}

export interface PreparedBackgroundApproval {
  /** Synchronous commit; call only inside the authenticated restart latch. */
  publish(): void;
  dispose(): Promise<void>;
}

export function approvedBackgroundSnapshotPath(binding: ApprovedBackgroundSnapshotBinding): string {
  assertBinding(binding);
  return join(binding.managedRoot, "approved-startup", binding.label, `${generation(binding)}.json`);
}

function generation(binding: ApprovedBackgroundSnapshotBinding): string {
  return createHash("sha256").update(JSON.stringify([
    SCHEMA, binding.label, binding.configPath, binding.encodedSnapshot, binding.launchProof,
  ])).digest("hex");
}

function assertBinding(binding: ApprovedBackgroundSnapshotBinding): void {
  if (!isAbsolute(binding.managedRoot) || !isAbsolute(binding.configPath)
    || !/^com\.mono-agent\.[A-Za-z0-9_-]+$/u.test(binding.label)
    || binding.launchProof.length === 0 || binding.launchProof.length > MAX_BYTES) {
    throw new Error("The startup approval binding is invalid.");
  }
  if (decodeBackgroundSnapshot(binding.encodedSnapshot).configPath !== binding.configPath) {
    throw new Error("The startup approval config binding does not match.");
  }
}

function sameIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function assertPrivate(stats: Stats, directory: boolean): void {
  if (stats.isSymbolicLink() || (directory ? !stats.isDirectory() : !stats.isFile())
    || (stats.mode & 0o077) !== 0
    || (typeof process.getuid === "function" && stats.uid !== process.getuid())
    || (!directory && stats.nlink !== 1)) {
    throw new Error("Startup approval state must be owner-private and must not contain links.");
  }
}

function directories(binding: Pick<ApprovedBackgroundSnapshotBinding, "managedRoot" | "label">): string[] {
  return [binding.managedRoot, join(binding.managedRoot, "approved-startup"),
    join(binding.managedRoot, "approved-startup", binding.label)];
}

/** Missing descendants mean no approval. A present insecure ancestor is never ignored. */
function inspectDirectories(binding: ApprovedBackgroundSnapshotBinding): Stats[] | undefined {
  const result: Stats[] = [];
  for (const path of directories(binding)) {
    let details: Stats;
    try { details = lstatSync(path); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    assertPrivate(details, true);
    result.push(details);
  }
  return result;
}

function readPrivate(path: string): { bytes: Buffer; stats: Stats } | undefined {
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    const before = fstatSync(fd);
    assertPrivate(before, false);
    if (before.size > MAX_BYTES) throw new Error("The startup approval record is too large.");
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length > MAX_BYTES) throw new Error("The startup approval record is too large.");
    const bytes = buffer.subarray(0, length);
    const after = lstatSync(path);
    assertPrivate(after, false);
    if (!sameIdentity(before, after) || before.ctimeMs !== after.ctimeMs || bytes.length !== before.size) {
      throw new Error("Startup approval state changed during inspection.");
    }
    return { bytes, stats: after };
  } finally { closeSync(fd); }
}

function decodeRecord(binding: ApprovedBackgroundSnapshotBinding, bytes: Buffer): BackgroundSnapshot {
  const record = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
  if (record === null || typeof record !== "object" || Array.isArray(record)
    || Object.keys(record).sort().join(",") !== "generation,schema,snapshot"
    || record.schema !== SCHEMA || record.generation !== generation(binding)
    || typeof record.snapshot !== "string") {
    throw new Error("The startup approval record is malformed or has a different binding.");
  }
  const snapshot = decodeBackgroundSnapshot(record.snapshot);
  const anchor = decodeBackgroundSnapshot(binding.encodedSnapshot);
  if (snapshot.configPath !== anchor.configPath || snapshot.dotenvPath !== anchor.dotenvPath) {
    throw new Error("The startup approval paths do not match the cached worker arguments.");
  }
  return snapshot;
}

/** Read-only, fail-closed resolver shared by workers, maintenance and attestation. */
export function resolveApprovedBackgroundSnapshot(binding: ApprovedBackgroundSnapshotBinding): BackgroundSnapshot {
  const path = approvedBackgroundSnapshotPath(binding);
  const before = inspectDirectories(binding);
  if (before === undefined) return decodeBackgroundSnapshot(binding.encodedSnapshot);
  const record = readPrivate(path);
  const after = inspectDirectories(binding);
  if (after === undefined || before.some((details, i) => !sameIdentity(details, after[i]!))) {
    throw new Error("Startup approval directories changed during inspection.");
  }
  return record === undefined ? decodeBackgroundSnapshot(binding.encodedSnapshot) : decodeRecord(binding, record.bytes);
}

function syncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

/** Staging is inert: even a late/abandoned preparation cannot change startup authority. */
export async function stageApprovedBackgroundSnapshot(
  binding: ApprovedBackgroundSnapshotBinding,
  snapshot: BackgroundSnapshot,
  hooks: { readonly afterRename?: () => void; readonly beforeRestore?: () => void } = {},
): Promise<PreparedBackgroundApproval> {
  const path = approvedBackgroundSnapshotPath(binding);
  const bytes = Buffer.from(JSON.stringify({ schema: SCHEMA, generation: generation(binding), snapshot: encodeBackgroundSnapshot(snapshot) }));
  if (bytes.length > MAX_BYTES) throw new Error("The startup approval record is too large.");
  decodeRecord(binding, bytes);
  for (const directory of directories(binding)) {
    await mkdir(directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    assertPrivate(lstatSync(directory), true);
  }
  const parents = inspectDirectories(binding)!;
  const previous = readPrivate(path);
  // Refuse to overwrite malformed approval state; terminal restart is recovery.
  if (previous !== undefined) decodeRecord(binding, previous.bytes);
  const staged = `${path}.stage-${randomUUID()}`;
  const rollback = `${path}.previous-${randomUUID()}`;
  const writeStaged = async (destination: string, content: Buffer): Promise<void> => {
    const handle = await open(destination, "wx", 0o600);
    try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
    const verified = readPrivate(destination);
    if (verified === undefined || !verified.bytes.equals(content)) throw new Error("Startup approval staging failed exact verification.");
  };
  const dispose = async (): Promise<void> => {
    await Promise.all([staged, rollback].map((file) => rm(file, { force: true })));
  };
  try {
    await writeStaged(staged, bytes);
    if (previous !== undefined) await writeStaged(rollback, previous.bytes);
    syncDirectory(directories(binding)[2]!);
  } catch (error) { await dispose(); throw error; }
  let consumed = false;
  return {
    dispose,
    publish() {
      if (consumed) throw new Error("The startup approval preparation was already consumed.");
      consumed = true;
      let renamed = false;
      try {
        const currentParents = inspectDirectories(binding);
        if (currentParents === undefined || parents.some((details, i) => !sameIdentity(details, currentParents[i]!))) {
          throw new Error("Startup approval directories changed before publication.");
        }
        const current = readPrivate(path);
        if ((current === undefined) !== (previous === undefined)
          || (current !== undefined && previous !== undefined
            && (!sameIdentity(current.stats, previous.stats) || !current.bytes.equals(previous.bytes)))) {
          throw new Error("Startup approval state changed before publication.");
        }
        const candidate = readPrivate(staged);
        if (candidate === undefined || !candidate.bytes.equals(bytes)) throw new Error("Startup approval staging changed before publication.");
        // Commit point: the visible record is already complete, synced and validated.
        renameSync(staged, path);
        renamed = true;
        hooks.afterRename?.();
        const published = readPrivate(path);
        if (published === undefined || !published.bytes.equals(bytes)) throw new Error("Startup approval publication failed exact verification.");
        syncDirectory(directories(binding)[2]!);
      } catch {
        if (renamed) {
          try {
            hooks.beforeRestore?.();
            const current = readPrivate(path);
            if (current === undefined || !current.bytes.equals(bytes)) throw new Error("Startup approval changed before restoration.");
            if (previous === undefined) unlinkSync(path);
            else renameSync(rollback, path);
            syncDirectory(directories(binding)[2]!);
          } catch {
            throw new Error("Startup approval publication and restoration failed; validated approval may be active. The old worker is still serving.");
          }
        }
        throw new Error("Startup approval publication failed. The old worker is still serving.");
      }
    },
  };
}

/** Called only under lifecycle ownership, including unchanged-input replacements. */
export async function invalidateApprovedBackgroundSnapshots(
  input: Pick<ApprovedBackgroundSnapshotBinding, "managedRoot" | "label">,
): Promise<void> {
  if (!isAbsolute(input.managedRoot) || !/^com\.mono-agent\.[A-Za-z0-9_-]+$/u.test(input.label)) {
    throw new Error("The startup approval invalidation binding is invalid.");
  }
  // The trusted managed root owns directory entries, even when an entry is
  // foreign-owned, unreadable or a symlink. Never follow a link target.
  try { assertPrivate(await lstat(input.managedRoot), true); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const store = join(input.managedRoot, "approved-startup");
  let details: Stats;
  try { details = await lstat(store); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (details.isDirectory() && !details.isSymbolicLink() && (details.mode & 0o500) === 0o500
    && (typeof process.getuid !== "function" || details.uid === process.getuid())) {
    // Startup still rejects wrong modes; a lifecycle owner may repair them.
    await ensureOwnerPrivateLaunchdDirectory(store);
    const entry = join(store, input.label);
    const quarantined = `${entry}.quarantined-${randomUUID()}`;
    try { await rename(entry, quarantined); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    syncDirectory(store);
    // Revocation is committed already; unreadable remnants cannot block restart.
    await rm(quarantined, { recursive: true, force: true }).catch(() => undefined);
  } else {
    // Renaming a foreign entry or a link needs only the private parent's
    // ownership. The link target and foreign descendants are never touched.
    await rename(store, `${store}.quarantined-${randomUUID()}`);
    await ensureOwnerPrivateLaunchdDirectory(store);
    syncDirectory(input.managedRoot);
  }
}
