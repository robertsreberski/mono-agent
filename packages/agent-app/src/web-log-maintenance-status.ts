import { constants as fsConstants, type Stats } from "node:fs";
import { open } from "node:fs/promises";
import process from "node:process";

import { writeOwnerPrivateLaunchdFile } from "./background.js";
import type { ManagedWebLogMonitorStatus } from "./managed-web-logs.js";

const MAX_MONITOR_STATUS_BYTES = 1024;
const MAX_MAINTENANCE_STATUS_BYTES = 4 * 1024;

export type WebLogMaintenancePhase =
  | "authenticating"
  | "inspecting"
  | "stopping"
  | "stopped"
  | "rotating"
  | "restoring"
  | "complete";

export interface WebLogMaintenanceStatus {
  readonly version: 1;
  readonly state: "running" | "success" | "degraded" | "failed";
  readonly phase: WebLogMaintenancePhase;
  readonly updatedAt: string;
  readonly detail?: string;
  readonly refusals?: readonly string[];
}

export type WebStatusRead<T> =
  | { readonly kind: "absent" }
  | { readonly kind: "valid"; readonly status: T }
  | { readonly kind: "invalid"; readonly detail: string };

type PrivateWriter = (path: string, contents: string) => Promise<void>;

export async function writeWebLogMonitorStatus(
  path: string,
  status: ManagedWebLogMonitorStatus,
  writer: PrivateWriter = writeOwnerPrivateLaunchdFile,
): Promise<void> {
  validateMonitorStatus(status);
  await writeBoundedJson(path, status, MAX_MONITOR_STATUS_BYTES, writer);
}

export async function readWebLogMonitorStatus(
  path: string,
): Promise<WebStatusRead<ManagedWebLogMonitorStatus>> {
  return await readBoundedStatus(path, MAX_MONITOR_STATUS_BYTES, (value) => {
    validateMonitorStatus(value as ManagedWebLogMonitorStatus);
    return value as ManagedWebLogMonitorStatus;
  });
}

export async function writeWebLogMaintenanceStatus(
  path: string,
  status: WebLogMaintenanceStatus,
  writer: PrivateWriter = writeOwnerPrivateLaunchdFile,
): Promise<void> {
  const safe = sanitizeMaintenanceStatus(status);
  await writeBoundedJson(path, safe, MAX_MAINTENANCE_STATUS_BYTES, writer);
}

export async function readWebLogMaintenanceStatus(
  path: string,
): Promise<WebStatusRead<WebLogMaintenanceStatus>> {
  return await readBoundedStatus(path, MAX_MAINTENANCE_STATUS_BYTES, parseMaintenanceStatus);
}

async function writeBoundedJson(
  path: string,
  value: object,
  maxBytes: number,
  writer: PrivateWriter,
): Promise<void> {
  const contents = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(contents, "utf8") > maxBytes) {
    throw new Error("Web log maintenance status exceeds its bounded size.");
  }
  await writer(path, contents);
}

async function readBoundedStatus<T>(
  path: string,
  maxBytes: number,
  parse: (value: unknown) => T,
): Promise<WebStatusRead<T>> {
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent" };
    return { kind: "invalid", detail: "the owner-private status file is unreadable" };
  }
  try {
    const before = await handle.stat();
    assertPrivateStatusFile(before, maxBytes);
    const data = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < data.length) {
      const read = await handle.read(data, offset, data.length - offset, offset);
      if (read.bytesRead === 0) throw new Error("the status file ended while read");
      offset += read.bytesRead;
    }
    const after = await handle.stat();
    assertPrivateStatusFile(after, maxBytes);
    if (!sameSnapshot(before, after)) throw new Error("the status file changed while read");
    const value = JSON.parse(data.toString("utf8")) as unknown;
    return { kind: "valid", status: parse(value) };
  } catch {
    return { kind: "invalid", detail: "the owner-private status file is malformed or unsafe" };
  } finally {
    await handle.close();
  }
}

function validateMonitorStatus(value: ManagedWebLogMonitorStatus): void {
  if (!isRecord(value)
    || value.version !== 1
    || !isIsoInstant(value.lastInspectionAt)
    || !isIsoInstant(value.cooldownDeadline)
    || !Number.isSafeInteger(value.wakeCount)
    || value.wakeCount < 0
    || ![
      "idle",
      "cooldown",
      "stopped",
      "helper-unloaded",
      "helper-running",
      "requested",
      "request-failed",
      "inspection-failed",
    ].includes(value.lastOutcome)) {
    throw new Error("Web log monitor status has an invalid schema.");
  }
  assertExactKeys(value, ["version", "lastInspectionAt", "wakeCount", "lastOutcome", "cooldownDeadline"]);
}

function sanitizeMaintenanceStatus(status: WebLogMaintenanceStatus): WebLogMaintenanceStatus {
  const value: WebLogMaintenanceStatus = {
    version: 1,
    state: status.state,
    phase: status.phase,
    updatedAt: status.updatedAt,
    ...(status.detail === undefined ? {} : { detail: safeText(status.detail, 512) }),
    ...(status.refusals === undefined
      ? {}
      : { refusals: status.refusals.slice(0, 8).map((item) => safeText(item, 256)) }),
  };
  parseMaintenanceStatus(value);
  return value;
}

function parseMaintenanceStatus(value: unknown): WebLogMaintenanceStatus {
  if (!isRecord(value)
    || value.version !== 1
    || typeof value.state !== "string"
    || !["running", "success", "degraded", "failed"].includes(value.state)
    || typeof value.phase !== "string"
    || !["authenticating", "inspecting", "stopping", "stopped", "rotating", "restoring", "complete"].includes(value.phase)
    || !isIsoInstant(value.updatedAt)
    || (value.detail !== undefined && (typeof value.detail !== "string" || value.detail.length > 512))
    || (value.refusals !== undefined && (!Array.isArray(value.refusals)
      || value.refusals.length > 8
      || value.refusals.some((item) => typeof item !== "string" || item.length > 256)))) {
    throw new Error("Web log maintenance status has an invalid schema.");
  }
  assertExactKeys(value, [
    "version",
    "state",
    "phase",
    "updatedAt",
    ...(value.detail === undefined ? [] : ["detail"]),
    ...(value.refusals === undefined ? [] : ["refusals"]),
  ]);
  return value as unknown as WebLogMaintenanceStatus;
}

function assertPrivateStatusFile(stats: Stats, maxBytes: number): void {
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1) throw new Error("status is not one regular file");
  if ((stats.mode & 0o777) !== 0o600) throw new Error("status is not owner-only");
  if (!Number.isSafeInteger(stats.size) || stats.size < 1 || stats.size > maxBytes) throw new Error("status size is unsafe");
  const uid = process.getuid?.();
  if (uid !== undefined && stats.uid !== uid) throw new Error("status has the wrong owner");
}

function sameSnapshot(left: Stats, right: Stats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs
    && left.nlink === right.nlink
    && left.uid === right.uid;
}

function isIsoInstant(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  if (actual.length !== sorted.length || actual.some((key, index) => key !== sorted[index])) {
    throw new Error("Web log maintenance status has unexpected fields.");
  }
}

function safeText(value: string, maxLength: number): string {
  return value
    .replace(/[\u0000-\u001f\u007f]+/gu, " ")
    .replace(/\b(token|secret|password|api[-_]?key|authorization)\s*[=:]\s*\S+/giu, "$1=<redacted>")
    .replace(/\bBearer\s+\S+/giu, "Bearer <redacted>")
    .replace(/(?:\/[A-Za-z0-9._~!$&'()+,;=:@%-]+){2,}/gu, "<path>")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, maxLength);
}
