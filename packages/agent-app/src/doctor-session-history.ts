import { lstat, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  isProcessAlive,
  ToolHistoryReader,
  TOOL_HISTORY_APPLICATION_ID,
  TOOL_HISTORY_DATABASE,
  TOOL_HISTORY_DIRECTORY,
  TOOL_HISTORY_OWNER_DATABASE,
  TOOL_HISTORY_USER_VERSION,
} from "@mono-agent/agent-harness";

import type { ValidationSection, ValidationStatus } from "./doctor-types.js";

interface SessionToolHistoryDoctorOptions {
  readonly historyRoot: string;
  readonly requestScopedToolSupported: boolean;
}

/** Read-only storage/security/recovery audit for canonical tool lifecycle state. */
export async function sessionToolHistorySection(
  options: SessionToolHistoryDoctorOptions,
): Promise<ValidationSection> {
  try {
    return await inspectSessionToolHistorySection(options);
  } catch (error) {
    const details = [
      `Session tool history could not be inspected (${boundedInspectionErrorCode(error)}).`,
    ];
    if (!options.requestScopedToolSupported) {
      details.push("unsupported_route: lifecycle records persist and cold-project, but this direct OpenCode/ACP route cannot expose SessionHistory.");
    }
    return { id: "session-tool-history", label: "Session tool history", status: "error", details };
  }
}

async function inspectSessionToolHistorySection(
  options: SessionToolHistoryDoctorOptions,
): Promise<ValidationSection> {
  const details: string[] = [];
  let status: ValidationStatus = "ok";
  const worsen = (next: ValidationStatus, detail: string): void => {
    details.push(detail);
    if (next === "error" || next === "waiting" && status === "ok") status = next;
  };

  const messageUsage = await topLevelMessageHistoryUsage(options.historyRoot).catch(() => undefined);
  if (messageUsage === undefined) {
    worsen("error", "Message-history bytes could not be inspected.");
  } else {
    details.push(`Message history: ${String(messageUsage.files)} files, ${String(messageUsage.bytes)} bytes.`);
  }

  const toolDirectory = join(options.historyRoot, TOOL_HISTORY_DIRECTORY);
  const contentPath = join(toolDirectory, TOOL_HISTORY_DATABASE);
  const journalPath = `${contentPath}-journal`;
  const locksDirectory = join(options.historyRoot, ".locks");
  const ownerPath = join(locksDirectory, TOOL_HISTORY_OWNER_DATABASE);
  const toolDirectoryInfo = await optionalLstat(toolDirectory);
  const ownerInfo = await optionalLstat(ownerPath);
  if (toolDirectoryInfo === undefined && ownerInfo === undefined) {
    details.push("Tool history: not created yet (0 bytes).");
    if (!options.requestScopedToolSupported) {
      worsen("waiting", "unsupported_route: lifecycle records will persist and cold-project, but this direct OpenCode/ACP route cannot expose SessionHistory.");
    }
    return { id: "session-tool-history", label: "Session tool history", status, details };
  }

  if (toolDirectoryInfo === undefined || !toolDirectoryInfo.isDirectory() || toolDirectoryInfo.isSymbolicLink()) {
    worsen("error", "Tool history directory must be a real owner-only directory.");
  } else if (!ownerOnly(toolDirectoryInfo, 0o700)) {
    worsen("error", "Tool history directory must be owned by the current user with mode 0700.");
  }
  const locksInfo = await optionalLstat(locksDirectory);
  if (locksInfo === undefined || !locksInfo.isDirectory() || locksInfo.isSymbolicLink() || !ownerOnly(locksInfo, 0o700)) {
    worsen("error", "Tool history owner-lock directory must be a real current-user directory with mode 0700.");
  }

  let entries: string[] = [];
  try { entries = await readdir(toolDirectory); } catch { /* directory error is already reported */ }
  const unexpected = entries.filter((name) => name !== TOOL_HISTORY_DATABASE && name !== `${TOOL_HISTORY_DATABASE}-journal`);
  if (unexpected.length > 0) worsen("error", `Tool history directory contains unsupported entries: ${unexpected.join(", ")}.`);
  if (entries.some((name) => name.endsWith("-wal") || name.endsWith("-shm"))) {
    worsen("error", "Tool history contains WAL/SHM state even though its canonical journal mode is DELETE.");
  }

  const owner = inspectOwner(ownerPath, ownerInfo, worsen);
  const contentInfo = await optionalLstat(contentPath);
  const contentSecure = contentInfo !== undefined
    && contentInfo.isFile()
    && !contentInfo.isSymbolicLink()
    && contentInfo.nlink === 1
    && ownerOnly(contentInfo, 0o600);
  if (!contentSecure) {
    if (contentInfo === undefined && (owner.live === true || owner.initializing === true)) {
      worsen(
        "waiting",
        owner.live === true
          ? "A live writer owns the sidecar and is still initializing the tool-history database."
          : "The zero-byte owner database is still initializing before the tool-history database is published.",
      );
    } else {
      worsen("error", "Tool history database must be a single-link regular current-user file with mode 0600.");
    }
  }
  const journalInfo = await optionalLstat(journalPath);
  let journalSecure = false;
  if (journalInfo !== undefined) {
    if (!journalInfo.isFile() || journalInfo.isSymbolicLink() || journalInfo.nlink !== 1 || !ownerOnly(journalInfo, 0o600)) {
      worsen("error", "Tool history DELETE journal must be a single-link regular current-user file with mode 0600.");
    } else {
      journalSecure = true;
    }
  }
  const canonicalToolFiles = [contentInfo, journalInfo, ownerInfo]
    .filter((info): info is NonNullable<typeof info> => info !== undefined && info.isFile() && !info.isSymbolicLink());
  details.push(
    `Tool history physical storage: ${String(canonicalToolFiles.length)} files, ${String(canonicalToolFiles.reduce((sum, info) => sum + Number(info.size), 0))} bytes.`,
  );

  const contentInspection = contentSecure
    ? inspectContentDatabase(contentPath, Number(contentInfo.size), owner.live === true, worsen)
    : "unavailable";
  if (contentInspection === "pristine") {
    details.push("Tool history database is a pristine zero-byte file; the next writer can initialize it safely.");
    if (owner.live === true) {
      worsen("waiting", "A live writer is still initializing the pristine tool-history database.");
    }
  }
  if (journalSecure) {
    if (contentInspection === "pristine") {
      worsen(
        "waiting",
        owner.live === true
          ? "An in-flight DELETE journal is present while the live writer initializes the pristine tool-history database."
          : "A crash-stale DELETE journal accompanies the pristine tool-history database; the next writer can recover and initialize it safely.",
      );
    } else if (owner.live === true) {
      worsen("waiting", "An in-flight DELETE journal is present under the protected 0700 tool-history directory.");
    } else {
      worsen("error", "A tool-history DELETE journal survived without a live writer; recovery is required before trusting the store.");
    }
  }
  if (contentInspection === "readable") {
    try {
      const stats = new ToolHistoryReader(options.historyRoot).stats();
      if (stats !== undefined) {
        details.push(
          `Tool history: ${String(stats.calls)} calls, ${String(stats.records)} records, ${String(stats.tombstones)} tombstones, ${String(stats.retainedBytes)} retained payload bytes, ${String(stats.bytes)} database bytes.`,
          `Retention: ${String(stats.limits.maxCompletedCalls)} completed calls, ${String(stats.limits.maxAgeMs)} ms age, ${String(stats.limits.maxBytes)} retained bytes, ${String(stats.limits.maxTombstones)} tombstones.`,
        );
        if (stats.dangling > 0) worsen(owner.live === true ? "waiting" : "error", `${String(stats.dangling)} dangling invocation(s) await terminal recovery.`);
        if (stats.orphanResults > 0) worsen("waiting", `${String(stats.orphanResults)} result(s) required a synthetic invocation because the provider start was missing.`);
        if (stats.recovered > 0) worsen("waiting", `${String(stats.recovered)} invocation(s) were recovered as interrupted without rerun.`);
        if (stats.writeFailures > 0) worsen("waiting", `${String(stats.writeFailures)} unresolved lifecycle write incident(s); only the matching tool-phase retry or a retry of the failed run finalization clears that incident.`);
        if (stats.idempotencyConflicts > 0) worsen("error", `${String(stats.idempotencyConflicts)} unresolved lifecycle idempotency conflict(s); only the matching tool-phase retry or canonical run-binding retry clears that incident.`);
        if (stats.maintenanceFailures > 0) worsen("waiting", `${String(stats.maintenanceFailures)} retention failure(s) remain since the latest successful retention pass.`);
        if (stats.recoveryFailures > 0) worsen("error", `${String(stats.recoveryFailures)} recovery failure(s) remain since the latest successful writer recovery.`);
        if (stats.retainedBytes > stats.limits.maxBytes) worsen("error", "Tool-history retained payload bytes exceed the configured byte ceiling.");
        else if (stats.retainedBytes >= Math.floor(stats.limits.maxBytes * 0.9)) worsen("waiting", "Tool-history retained payload bytes have reached 90% of the configured ceiling.");
      }
    } catch (error) {
      const reason = reasonOf(error);
      if (isUnsupportedSchema(error)) {
        worsen("error", `Tool-history statistics are unavailable: ${reason} Downgrade hard-fails until persisted conversation state is purged.`);
      } else {
        worsen(owner.live === true && isBusyReason(reason) ? "waiting" : "error", `Tool-history statistics are unavailable: ${reason}`);
      }
    }
  } else if (contentInspection === "unavailable" && contentInfo !== undefined && contentInfo.isFile() && !contentInfo.isSymbolicLink()) {
    details.push(`Tool history database: ${String(contentInfo.size)} physical bytes; record statistics unavailable.`);
  }

  if (owner.pid !== undefined) {
    details.push(owner.live === true
      ? `Writer owner PID ${String(owner.pid)} is live.`
      : `Recorded writer owner PID ${String(owner.pid)} is dead and will be reaped on the next bounded acquisition.`);
    if (owner.live === false) worsen("waiting", "A dead recorded writer owner remains; the next writer will reap it before acquisition.");
  }
  if (!options.requestScopedToolSupported) {
    worsen("waiting", "unsupported_route: lifecycle records persist and cold-project, but this direct OpenCode/ACP route cannot expose SessionHistory.");
  }
  return { id: "session-tool-history", label: "Session tool history", status, details };
}

function inspectContentDatabase(
  path: string,
  size: number,
  liveOwner: boolean,
  worsen: (status: ValidationStatus, detail: string) => void,
): "readable" | "pristine" | "unavailable" {
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(path, { readOnly: true });
    database.exec("PRAGMA busy_timeout=250");
    const applicationId = pragmaNumber(database, "application_id");
    const userVersion = pragmaNumber(database, "user_version");
    if (size === 0 && applicationId === 0 && userVersion === 0) return "pristine";
    if (applicationId !== TOOL_HISTORY_APPLICATION_ID) {
      worsen(
        "error",
        `Foreign tool-history schema (application_id=${String(applicationId)}, user_version=${String(userVersion)}); persisted conversation state must be purged before adoption.`,
      );
      return "unavailable";
    }
    if (userVersion < TOOL_HISTORY_USER_VERSION) {
      worsen(
        "waiting",
        `Tool-history schema upgrade is pending (user_version=${String(userVersion)}, current=${String(TOOL_HISTORY_USER_VERSION)}); the next writer will upgrade it before use.`,
      );
      return "unavailable";
    }
    if (userVersion > TOOL_HISTORY_USER_VERSION) {
      worsen(
        "error",
        `Tool-history schema is newer (user_version=${String(userVersion)}, current=${String(TOOL_HISTORY_USER_VERSION)}). Downgrade hard-fails until persisted conversation state is purged.`,
      );
      return "unavailable";
    }
    const journalMode = String(Object.values(database.prepare("PRAGMA journal_mode").get() as Record<string, unknown>)[0]).toLocaleLowerCase();
    if (journalMode !== "delete") {
      worsen("error", `Tool-history journal_mode is ${journalMode}; expected DELETE.`);
      return "unavailable";
    }
    const integrity = String(Object.values(database.prepare("PRAGMA integrity_check").get() as Record<string, unknown>)[0]);
    if (integrity !== "ok") {
      worsen("error", `Tool-history integrity_check failed: ${integrity}.`);
      return "unavailable";
    }
    return "readable";
  } catch (error) {
    const reason = reasonOf(error);
    worsen(liveOwner && isBusyReason(reason) ? "waiting" : "error", `Tool-history database cannot be inspected: ${reason}`);
    return "unavailable";
  } finally {
    try { database?.close(); } catch { /* read-only doctor */ }
  }
}

function inspectOwner(
  path: string,
  info: Awaited<ReturnType<typeof lstat>> | undefined,
  worsen: (status: ValidationStatus, detail: string) => void,
): { pid?: number; live?: boolean; initializing?: boolean } {
  if (info === undefined) return {};
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || !ownerOnly(info, 0o600)) {
    worsen("error", "Tool history owner database must be a single-link regular current-user file with mode 0600.");
    return {};
  }
  if (info.size === 0) {
    worsen(
      "waiting",
      "Tool history owner database is a pristine zero-byte file; a writer may still be initializing it, otherwise the next writer can resume initialization safely.",
    );
    return { initializing: true };
  }
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(path, { readOnly: true });
    database.exec("PRAGMA busy_timeout=250");
    const row = database.prepare("SELECT pid FROM writer_owner WHERE singleton=1").get() as Record<string, unknown> | undefined;
    const pid = Number(row?.pid);
    return Number.isSafeInteger(pid) && pid > 0 ? { pid, live: isProcessAlive(pid) } : {};
  } catch (error) {
    worsen("error", `Tool history owner database cannot be inspected: ${reasonOf(error)}`);
    return {};
  } finally {
    try { database?.close(); } catch { /* read-only doctor */ }
  }
}

async function topLevelMessageHistoryUsage(root: string): Promise<{ files: number; bytes: number }> {
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); }
  catch (error) { if (errno(error) === "ENOENT") return { files: 0, bytes: 0 }; throw error; }
  let files = 0;
  let bytes = 0;
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith(".history.json")) continue;
    files += 1;
    bytes += (await stat(join(root, entry.name))).size;
  }
  return { files, bytes };
}

async function optionalLstat(path: string): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try { return await lstat(path); }
  catch (error) { if (errno(error) === "ENOENT") return undefined; throw error; }
}

function ownerOnly(info: Awaited<ReturnType<typeof lstat>>, mode: number): boolean {
  const uid = process.getuid?.();
  return (uid === undefined || Number(info.uid) === uid)
    && (process.platform === "win32" || (Number(info.mode) & 0o777) === mode);
}

function pragmaNumber(database: DatabaseSync, name: string): number {
  return Number(Object.values(database.prepare(`PRAGMA ${name}`).get() as Record<string, unknown>)[0]);
}

function errno(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

function boundedInspectionErrorCode(error: unknown): string {
  const code = errno(error);
  return code !== undefined && /^[A-Z][A-Z0-9_]{0,31}$/u.test(code) ? code : "INSPECTION_FAILED";
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isUnsupportedSchema(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "history_schema_unsupported"
    || /schema is unsupported|schema is newer or foreign/iu.test(reasonOf(error));
}

function isBusyReason(reason: string): boolean {
  return /\b(?:busy|locked)\b/iu.test(reason);
}
