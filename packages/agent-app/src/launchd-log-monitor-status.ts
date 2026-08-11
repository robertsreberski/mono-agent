import { createHash } from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import { lstat, mkdir, open, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import process from "node:process";

import type { ManagedLaunchdLogMonitorStatus } from "./background-log-maintenance.js";
import type { BackgroundLifecycleTarget } from "./background.js";
import { deriveLaunchdMaintenanceLabel } from "./launchd.js";
import type { LaunchdPaths } from "./launchd.js";
import { secureFileReplace } from "./secure-file-replace.js";

const STATUS_MAX_BYTES = 1024;
const STATUS_DIRECTORY = "launchd-log-monitor";
const STATUS_TEMPORARY_SUFFIX = ".next";
const OUTCOMES = new Set<ManagedLaunchdLogMonitorStatus["lastOutcome"]>([
  "idle",
  "shared-only",
  "pending-artifact",
  "cooldown",
  "stopped",
  "helper-unloaded",
  "helper-running",
  "requested",
  "request-failed",
  "inspection-failed",
]);

export async function writeLaunchdLogMonitorStatus(
  target: BackgroundLifecycleTarget,
  status: ManagedLaunchdLogMonitorStatus,
): Promise<void> {
  validateStatus(status);
  const paths = statusPaths(target.label, target.paths);
  await assertSafeStatusRoot(paths.root);
  await ensurePrivateDirectory(paths.directory);
  const contents = `${JSON.stringify(status)}\n`;
  if (Buffer.byteLength(contents) > STATUS_MAX_BYTES) {
    throw new Error("Launchd log monitor status exceeds its fixed size bound.");
  }
  let expected: Stats | undefined;
  try {
    expected = await lstat(paths.file);
    assertPrivateFile(expected, paths.file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await secureFileReplace({
    path: paths.file,
    temporaryPath: paths.temporary,
    contents,
    mode: 0o600,
    target: {
      expected: expected === undefined
        ? { kind: "missing" }
        : {
            kind: "present",
            validate: async (candidate) => {
              try {
                const current = await lstat(candidate);
                assertPrivateFile(current, candidate);
                return sameFile(current, expected);
              } catch {
                return false;
              }
            },
            invalidError: () => new Error("Launchd log monitor status changed before replacement."),
          },
      recovery: "restore-previous",
    },
  });
}

export async function readLaunchdLogMonitorStatus(
  mainLabel: string,
  paths: Pick<LaunchdPaths, "logDir">,
): Promise<ManagedLaunchdLogMonitorStatus | undefined> {
  const status = statusPaths(mainLabel, paths);
  await assertSafeStatusRoot(status.root);
  try {
    assertPrivateDirectory(await lstat(status.directory));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  let initial: Stats;
  try {
    initial = await lstat(status.file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  assertPrivateFile(initial, status.file);
  if (initial.size < 1 || initial.size > STATUS_MAX_BYTES) {
    throw new Error("Launchd log monitor status violates its fixed size bound.");
  }
  const handle = await open(status.file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  try {
    const opened = await handle.stat();
    assertPrivateFile(opened, status.file);
    if (!sameFile(initial, opened)) throw new Error("Launchd log monitor status changed while opened.");
    const contents = await handle.readFile();
    const after = await handle.stat();
    const current = await lstat(status.file);
    if (!sameFile(opened, after) || !sameFile(after, current) || contents.length !== after.size) {
      throw new Error("Launchd log monitor status changed while read.");
    }
    const parsed: unknown = JSON.parse(contents.toString("utf8"));
    validateStatus(parsed);
    return parsed;
  } finally {
    await handle.close();
  }
}

/**
 * Inspect but never create or chmod the shared ~/.mono-agent root. An owned
 * read-only/traversable root such as 0755 can still contain a private 0700
 * status directory while scheduled maintenance owns any root permission repair.
 */
async function assertSafeStatusRoot(path: string): Promise<void> {
  const details = await lstat(path);
  const uid = process.getuid?.();
  if (!details.isDirectory() || details.isSymbolicLink()
    || (uid !== undefined && details.uid !== uid)
    || (details.mode & 0o022) !== 0) {
    throw new Error("Launchd log monitor status root is unavailable or unsafe.");
  }
}

export async function removeLaunchdLogMonitorStatus(target: BackgroundLifecycleTarget): Promise<void> {
  const paths = statusPaths(target.label, target.paths);
  try {
    await assertSafeStatusRoot(paths.root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  try {
    assertPrivateDirectory(await lstat(paths.directory));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const path of [paths.temporary, paths.file]) {
    try {
      assertPrivateFile(await lstat(path), path);
      await rm(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

function statusPaths(mainLabel: string, paths: Pick<LaunchdPaths, "logDir">): {
  readonly root: string;
  readonly directory: string;
  readonly file: string;
  readonly temporary: string;
} {
  deriveLaunchdMaintenanceLabel(mainLabel);
  const root = resolve(dirname(paths.logDir));
  const directory = resolve(root, STATUS_DIRECTORY);
  const key = createHash("sha256").update(mainLabel).digest("hex").slice(0, 24);
  const file = resolve(directory, `${key}.json`);
  return { root, directory, file, temporary: `${file}${STATUS_TEMPORARY_SUFFIX}` };
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const details = await lstat(path);
  assertPrivateDirectory(details);
}

function assertPrivateDirectory(details: Stats): void {
  const uid = process.getuid?.();
  if (!details.isDirectory() || details.isSymbolicLink()
    || (uid !== undefined && details.uid !== uid)
    || (details.mode & 0o777) !== 0o700) {
    throw new Error("Launchd log monitor status directory must be a real owner-private directory.");
  }
}

function assertPrivateFile(details: Stats, path: string): void {
  const uid = process.getuid?.();
  if (!details.isFile() || details.isSymbolicLink() || details.nlink !== 1
    || (uid !== undefined && details.uid !== uid)
    || (details.mode & 0o777) !== 0o600) {
    throw new Error(`Launchd log monitor status ${path} must be one owner-private regular file.`);
  }
}

function sameFile(
  left: Stats,
  right: Stats,
): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.uid === right.uid
    && left.nlink === right.nlink
    && left.mode === right.mode
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function validateStatus(value: unknown): asserts value is ManagedLaunchdLogMonitorStatus {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Launchd log monitor status must be an object.");
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(",")
    !== "cooldownDeadline,lastInspectionAt,lastOutcome,version,wakeCount") {
    throw new Error("Launchd log monitor status has unexpected fields.");
  }
  if (record.version !== 1
    || typeof record.lastInspectionAt !== "string"
    || !validDate(record.lastInspectionAt)
    || typeof record.wakeCount !== "number"
    || !Number.isSafeInteger(record.wakeCount)
    || record.wakeCount < 0
    || typeof record.lastOutcome !== "string"
    || !OUTCOMES.has(record.lastOutcome as ManagedLaunchdLogMonitorStatus["lastOutcome"])
    || typeof record.cooldownDeadline !== "string"
    || !validDate(record.cooldownDeadline)) {
    throw new Error("Launchd log monitor status is malformed.");
  }
}

function validDate(value: string): boolean {
  return Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
