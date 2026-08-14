import { constants as fsConstants, type Stats } from "node:fs";
import { lstat, open, opendir, unlink } from "node:fs/promises";
import { basename, join } from "node:path";
import process from "node:process";

import type {
  AdditionalLaunchdLogInspection,
  AdditionalLaunchdLogMaintenanceResult,
  ManagedLaunchdLogMonitor,
} from "./background-log-maintenance.js";
import {
  inspectLaunchdLogs,
  LAUNCHD_LOG_MONITOR_INTERVAL_SECONDS,
} from "./launchd-logs.js";
import type { LaunchdLogInspection } from "./launchd-logs.js";
import {
  kickstart,
  launchdServiceInfo,
  WEB_MAINTENANCE_LAUNCHD_LABEL,
} from "./launchd.js";
import type { LaunchctlRunner, LaunchdPaths } from "./launchd.js";

const LEGACY_SCAN_ENTRY_LIMIT = 256;
const LEGACY_CANDIDATE_LIMIT = 32;
const LEGACY_PREFIX = /^web\..*\.log\.(?:rollover|retiring)/u;
const CANONICAL_UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const LEGACY_NAME = new RegExp(`^web\\.(?:out|err)\\.log\\.(?:rollover|retiring)-${CANONICAL_UUID}$`, "u");
const WAKE_COOLDOWN_MS = [5, 10, 20, 40, 60].map((minutes) => minutes * 60_000);

type WebLogPaths = Pick<LaunchdPaths, "logDir" | "stdoutPath" | "stderrPath">;

export type ManagedWebLogMonitorOutcome =
  | "idle"
  | "cooldown"
  | "stopped"
  | "helper-unloaded"
  | "helper-running"
  | "requested"
  | "request-failed"
  | "inspection-failed";

export interface ManagedWebLogMonitorStatus {
  readonly version: 1;
  readonly lastInspectionAt: string;
  readonly wakeCount: number;
  readonly lastOutcome: ManagedWebLogMonitorOutcome;
  readonly cooldownDeadline: string;
}

export interface ManagedWebLogMonitorDependencies {
  readonly runner: LaunchctlRunner;
  readonly getuid: () => number;
  readonly inspectLogs?: (paths: WebLogPaths) => Promise<LaunchdLogInspection>;
  readonly inspectLegacy?: (paths: WebLogPaths) => Promise<AdditionalLaunchdLogInspection>;
  readonly stderr: (text: string) => void | Promise<void>;
  readonly recordStatus?: (status: ManagedWebLogMonitorStatus) => void | Promise<void>;
  readonly monotonicNow?: () => number;
  readonly wallClockNow?: () => number;
  readonly isStopped?: () => boolean;
}

interface WebWakeState {
  cooldownIndex: number;
  cooldownDeadlineMonotonicMs: number;
  wakeCount: number;
  lastOutcome: ManagedWebLogMonitorOutcome;
  lastReportedOutcome: ManagedWebLogMonitorOutcome | undefined;
}

/**
 * The managed worker only inspects and wakes the dedicated helper. It never
 * stops itself and never rotates, renames, truncates, or unlinks a log.
 */
export function startManagedWebLogMonitor(
  paths: WebLogPaths,
  deps: ManagedWebLogMonitorDependencies,
): ManagedLaunchdLogMonitor {
  let stopped = false;
  let checking = false;
  const monotonicNow = deps.monotonicNow ?? (() => performance.now());
  const wallClockNow = deps.wallClockNow ?? Date.now;
  const state: WebWakeState = {
    cooldownIndex: 0,
    cooldownDeadlineMonotonicMs: monotonicNow() + WAKE_COOLDOWN_MS[0]!,
    wakeCount: 0,
    lastOutcome: "idle",
    lastReportedOutcome: undefined,
  };
  const inspect = async (): Promise<void> => {
    if (stopped || checking) return;
    checking = true;
    try {
      const [logs, legacy] = await Promise.all([
        (deps.inspectLogs ?? inspectLaunchdLogs)(paths),
        (deps.inspectLegacy ?? inspectLegacyManagedWebLogArtifacts)(paths),
      ]);
      if (stopped || deps.isStopped?.() === true) {
        setOutcome(state, "stopped");
        return;
      }
      if (!logs.canMaintain || !legacy.canMaintain) {
        throw new Error([...logs.issues, ...legacy.issues].join("; ") || "the bounded inventory is unsafe");
      }
      if (!logs.needsMaintenance && !legacy.needsMaintenance) {
        resetCooldown(state, monotonicNow());
        setOutcome(state, "idle");
        return;
      }
      if (monotonicNow() < state.cooldownDeadlineMonotonicMs) {
        setOutcome(state, "cooldown");
        return;
      }
      const helper = await launchdServiceInfo(deps.runner, WEB_MAINTENANCE_LAUNCHD_LABEL, deps.getuid());
      if (stopped || deps.isStopped?.() === true) {
        setOutcome(state, "stopped");
        return;
      }
      if (!helper.loaded) {
        advanceCooldown(state, monotonicNow());
        setOutcome(state, "helper-unloaded");
        return;
      }
      if (helper.pid !== undefined) {
        advanceCooldown(state, monotonicNow());
        setOutcome(state, "helper-running");
        return;
      }
      setOutcome(state, "request-failed");
      const result = await kickstart(deps.runner, WEB_MAINTENANCE_LAUNCHD_LABEL, deps.getuid());
      advanceCooldown(state, monotonicNow());
      if (result.code !== 0) {
        throw new Error(`launchctl kickstart exited ${String(result.code)}${commandDetail(result.stderr, result.stdout)}`);
      }
      state.wakeCount += 1;
      setOutcome(state, "requested");
    } catch (error) {
      if (state.lastOutcome !== "request-failed") setOutcome(state, "inspection-failed");
      if (!stopped && shouldReport(state, state.lastOutcome)) {
        safeReport(deps, `Managed web log monitor: ${safeDetail(error)}`);
      }
    } finally {
      if (!stopped) safeRecordStatus(deps, statusFor(state, monotonicNow(), wallClockNow()));
      checking = false;
    }
  };
  const guarded = (): void => {
    void inspect().catch((error: unknown) => safeReport(deps, `Managed web log monitor: ${safeDetail(error)}`));
  };
  const interval = setInterval(guarded, LAUNCHD_LOG_MONITOR_INTERVAL_SECONDS * 1_000);
  interval.unref();
  guarded();
  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      clearInterval(interval);
    },
  };
}

/** Bounded inspection of only the two retired pre-helper filename families. */
export async function inspectLegacyManagedWebLogArtifacts(
  paths: WebLogPaths,
): Promise<AdditionalLaunchdLogInspection> {
  const inventory = await legacyInventory(paths.logDir);
  return {
    needsMaintenance: inventory.candidates.length > 0 || inventory.refusals.length > 0,
    canMaintain: !inventory.exceededBound,
    issues: inventory.refusals,
  };
}

/** Remove only re-authenticated safe legacy artifacts after stopped-writer proof. */
export async function maintainLegacyManagedWebLogArtifacts(
  paths: WebLogPaths,
): Promise<AdditionalLaunchdLogMaintenanceResult> {
  const inventory = await legacyInventory(paths.logDir);
  if (inventory.exceededBound) return { refusals: inventory.refusals };
  const refusals = [...inventory.refusals];
  for (const candidate of inventory.candidates) {
    try {
      await removeSameLegacyFile(candidate.path, candidate.stats);
    } catch (error) {
      refusals.push(`Legacy web log ${basename(candidate.path)} was preserved: ${safeDetail(error)}`);
    }
  }
  return { refusals };
}

interface LegacyCandidate {
  readonly path: string;
  readonly stats: Stats;
}

interface LegacyInventory {
  readonly candidates: readonly LegacyCandidate[];
  readonly refusals: readonly string[];
  readonly exceededBound: boolean;
}

async function legacyInventory(logDir: string): Promise<LegacyInventory> {
  const candidates: LegacyCandidate[] = [];
  const refusals: string[] = [];
  let seen = 0;
  let exceededBound = false;
  const directory = await opendir(logDir);
  try {
    for await (const entry of directory) {
      seen += 1;
      if (seen > LEGACY_SCAN_ENTRY_LIMIT) {
        exceededBound = true;
        refusals.push(`Legacy web log scan exceeded ${String(LEGACY_SCAN_ENTRY_LIMIT)} direct children.`);
        break;
      }
      if (!LEGACY_PREFIX.test(entry.name)) continue;
      if (!LEGACY_NAME.test(entry.name)) {
        refusals.push(`Legacy-like web log ${safeName(entry.name)} was preserved because its name is not canonical.`);
        continue;
      }
      if (candidates.length >= LEGACY_CANDIDATE_LIMIT) {
        exceededBound = true;
        refusals.push(`Legacy web log candidates exceeded ${String(LEGACY_CANDIDATE_LIMIT)} files.`);
        continue;
      }
      const path = join(logDir, entry.name);
      try {
        const stats = await lstat(path);
        assertSafeLegacyFile(stats, path);
        candidates.push({ path, stats });
      } catch (error) {
        refusals.push(`Legacy web log ${safeName(entry.name)} was preserved: ${safeDetail(error)}`);
      }
    }
  } finally {
    await directory.close().catch(() => undefined);
  }
  return { candidates, refusals, exceededBound };
}

async function removeSameLegacyFile(path: string, expected: Stats): Promise<void> {
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  try {
    const opened = await handle.stat();
    assertSafeLegacyFile(opened, path);
    if (!sameIdentity(expected, opened)) throw new Error("its identity changed before removal");
    const current = await lstat(path);
    assertSafeLegacyFile(current, path);
    if (!sameIdentity(opened, current)) throw new Error("its pathname changed before removal");
    await unlink(path);
  } finally {
    await handle.close();
  }
}

function assertSafeLegacyFile(stats: Stats, path: string): void {
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1) {
    throw new Error(`${basename(path)} is not one regular non-symbolic-link file with one link`);
  }
  const uid = process.getuid?.();
  if (uid !== undefined && stats.uid !== uid) throw new Error(`${basename(path)} is not owned by the current user`);
  if (!Number.isSafeInteger(stats.size) || stats.size < 0) throw new Error(`${basename(path)} has an unsafe size`);
}

function sameIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.uid === right.uid
    && left.nlink === right.nlink
    && left.size === right.size;
}

function setOutcome(state: WebWakeState, outcome: ManagedWebLogMonitorOutcome): void {
  state.lastOutcome = outcome;
}

function resetCooldown(state: WebWakeState, now: number): void {
  state.cooldownIndex = 0;
  state.cooldownDeadlineMonotonicMs = now + WAKE_COOLDOWN_MS[0]!;
  state.lastReportedOutcome = undefined;
}

function advanceCooldown(state: WebWakeState, now: number): void {
  state.cooldownIndex = Math.min(state.cooldownIndex + 1, WAKE_COOLDOWN_MS.length - 1);
  state.cooldownDeadlineMonotonicMs = now + WAKE_COOLDOWN_MS[state.cooldownIndex]!;
}

function shouldReport(state: WebWakeState, outcome: ManagedWebLogMonitorOutcome): boolean {
  if (outcome === "idle" || outcome === "cooldown" || outcome === "stopped") return false;
  if (state.lastReportedOutcome === outcome) return false;
  state.lastReportedOutcome = outcome;
  return true;
}

function statusFor(state: WebWakeState, monotonicNow: number, wallClockNow: number): ManagedWebLogMonitorStatus {
  return {
    version: 1,
    lastInspectionAt: new Date(wallClockNow).toISOString(),
    wakeCount: state.wakeCount,
    lastOutcome: state.lastOutcome,
    cooldownDeadline: new Date(wallClockNow + Math.max(0, state.cooldownDeadlineMonotonicMs - monotonicNow)).toISOString(),
  };
}

function safeRecordStatus(deps: ManagedWebLogMonitorDependencies, status: ManagedWebLogMonitorStatus): void {
  try {
    const result = deps.recordStatus?.(status);
    if (result !== undefined) void Promise.resolve(result).catch(() => undefined);
  } catch {
    // A monitor status failure cannot alter the worker lifecycle.
  }
}

function safeReport(deps: ManagedWebLogMonitorDependencies, message: string): void {
  const line = `[error] ${safeText(message, 620)}\n`;
  try {
    const result = deps.stderr(Buffer.byteLength(line, "utf8") <= 640 ? line : "[error] Managed web log monitor failed.\n");
    if (result !== undefined) void Promise.resolve(result).catch(() => undefined);
  } catch {
    // Diagnostics are bounded and non-fatal.
  }
}

function commandDetail(stderr: string, stdout: string): string {
  const detail = safeText(stderr || stdout, 256);
  return detail.length === 0 ? "" : `: ${detail}`;
}

function safeDetail(error: unknown): string {
  return safeText(error instanceof Error ? error.message : String(error), 512);
}

function safeName(value: string): string {
  return safeText(value, 160);
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
