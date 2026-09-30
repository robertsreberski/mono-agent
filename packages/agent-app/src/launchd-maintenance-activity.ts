import type { BackgroundLifecycleTarget } from "./background.js";
import { launchdServiceInfo, type LaunchctlRunner, type LaunchdPaths } from "./launchd.js";
import { LAUNCHD_LOG_MAX_BYTES, type LaunchdLogInspection } from "./launchd-logs.js";
import { readPrivateLaunchdState, writePrivateLaunchdState } from "./private-launchd-state.js";
import { probeWorkerActivity, type WorkerActivityProbe } from "./worker-activity-snapshot.js";

export const MAINTENANCE_MAX_DEFERRAL_MS = 4 * 60 * 60 * 1_000;
export const MAINTENANCE_MAX_DEFERRALS = 48;
export type MaintenanceReason = "log-size" | "snapshot-drift" | "definition-drift" | "runtime-upgrade" | "runtime-unverified";
export type MaintenanceOverride = "permission-repair" | "transaction-recovery" | "worker-unready";
export type MaintenanceDecision = "deferred-busy" | "proceeded-idle" | "forced-ceiling" | "forced-size" | `override-${MaintenanceOverride}`;
export interface MaintenanceEpisode {
  readonly reasons: readonly MaintenanceReason[];
  readonly firstDeferredAt: string;
  readonly count: number;
  readonly lastProbe: WorkerActivityProbe;
  readonly forcedBy: string;
}
export interface MaintenanceDecisionRecord {
  readonly outcome: MaintenanceDecision;
  readonly at: string;
  readonly reasons: readonly MaintenanceReason[];
  readonly probe: WorkerActivityProbe;
}
export interface LaunchdMaintenanceActivityStatus {
  readonly version: 1;
  readonly pending?: MaintenanceEpisode;
  readonly lastDecision?: MaintenanceDecisionRecord;
  readonly lastForced?: MaintenanceDecisionRecord;
}
export interface MaintenanceActivityRequest {
  readonly reasons: readonly MaintenanceReason[];
  readonly inspection?: LaunchdLogInspection;
  readonly override?: MaintenanceOverride;
}
export interface MaintenanceActivityDependencies {
  readonly runner: LaunchctlRunner;
  readonly getuid: () => number;
  readonly now: () => number;
  readonly isAlive: (pid: number) => boolean;
  readonly probe?: typeof probeWorkerActivity;
  readonly readStatus?: typeof readLaunchdMaintenanceActivityStatus;
  readonly writeStatus?: (target: BackgroundLifecycleTarget, status: LaunchdMaintenanceActivityStatus) => Promise<void>;
}

export function logPermissionRepairNeeded(inspection: LaunchdLogInspection): boolean {
  return inspection.sharedDirectoryNeedsMaintenance
    || [...inspection.stdout.files, ...inspection.stderr.files].some((file) => file.state === "repairable");
}
export function logEmergencySize(inspection: LaunchdLogInspection): boolean {
  // Emergency scheduling threshold, NOT a new cap. Sampling can overshoot it.
  return Math.max(inspection.stdout.activeBytes, inspection.stderr.activeBytes) >= 2 * LAUNCHD_LOG_MAX_BYTES;
}
export function maintenanceCeilingReached(firstDeferredAt: number, count: number, now: number): boolean {
  // The count backstop bounds episodes even if the wall clock rolls backwards.
  return Math.max(0, now - firstDeferredAt) >= MAINTENANCE_MAX_DEFERRAL_MS || count >= MAINTENANCE_MAX_DEFERRALS;
}

/** Call only on unattended paths, immediately before intent publication/bootout.
 * Atomic snapshots reduce but do not eliminate the sub-second start/stop race:
 * no admission reservation is held between this final read and launchd bootout.
 * Ceilings never override lifecycle authentication, unsafe paths, or lock refusals.
 */
export async function allowUnattendedMaintenanceStop(
  target: BackgroundLifecycleTarget,
  deps: MaintenanceActivityDependencies,
  request: MaintenanceActivityRequest,
): Promise<boolean> {
  const status = await (deps.readStatus ?? readLaunchdMaintenanceActivityStatus)(target.label, target.paths)
    ?? { version: 1 };
  // Read launchd again, not a PID captured before runtime installation/inspection.
  const service = await launchdServiceInfo(deps.runner, target.label, deps.getuid());
  const probe = await (deps.probe ?? probeWorkerActivity)(target.label, target.paths, service.pid, deps.isAlive);
  const now = deps.now();
  const reasons = [...new Set([...(status.pending?.reasons ?? []), ...request.reasons])];
  const firstDeferredAt = status.pending?.firstDeferredAt ?? new Date(now).toISOString();
  const count = (status.pending?.count ?? 0) + 1;
  let outcome: MaintenanceDecision;
  if (request.override !== undefined) outcome = `override-${request.override}`;
  else if (probe.disposition === "idle" || probe.disposition === "not-running") outcome = "proceeded-idle";
  else if (request.inspection !== undefined && logEmergencySize(request.inspection)) outcome = "forced-size";
  else if (maintenanceCeilingReached(Date.parse(firstDeferredAt), count, now)) outcome = "forced-ceiling";
  else outcome = "deferred-busy";
  const lastDecision: MaintenanceDecisionRecord = { outcome, at: new Date(now).toISOString(), reasons, probe };
  const lastForced = outcome === "forced-size" || outcome === "forced-ceiling" ? lastDecision : status.lastForced;
  await (deps.writeStatus ?? writeLaunchdMaintenanceActivityStatus)(target, {
    version: 1, lastDecision,
    ...(lastForced === undefined ? {} : { lastForced }),
    // A decision is not stopped-writer proof. Preserve the original budget
    // through a failed stop; only lifecycle completion/vanished need clears it.
    ...(status.pending === undefined && !["deferred-busy", "forced-ceiling", "forced-size"].includes(outcome) ? {} : { pending: {
      reasons, firstDeferredAt, count, lastProbe: probe,
      forcedBy: new Date(Date.parse(firstDeferredAt) + MAINTENANCE_MAX_DEFERRAL_MS).toISOString(),
    } }),
  });
  return outcome !== "deferred-busy";
}

export async function writeLaunchdMaintenanceActivityStatus(target: BackgroundLifecycleTarget, status: LaunchdMaintenanceActivityStatus): Promise<void> {
  validateStatus(status);
  await writePrivateLaunchdState(target, "launchd-maintenance", status);
}
export async function readLaunchdMaintenanceActivityStatus(mainLabel: string, paths: Pick<LaunchdPaths, "logDir">): Promise<LaunchdMaintenanceActivityStatus | undefined> {
  const status = await readPrivateLaunchdState(mainLabel, paths, "launchd-maintenance");
  if (status === undefined) return undefined;
  validateStatus(status);
  return status;
}

export function describeMaintenanceActivity(status: LaunchdMaintenanceActivityStatus): string {
  const pending = status.pending;
  const counts = pending?.lastProbe.counts ?? status.lastDecision?.probe.counts;
  return [
    `maintenance: ${status.lastDecision?.outcome ?? "none"}`,
    ...(pending === undefined ? [] : [`pending=${pending.reasons.join(",")} since=${pending.firstDeferredAt} deferrals=${pending.count} force-by=${pending.forcedBy} (or ${MAINTENANCE_MAX_DEFERRALS} deferrals / emergency size)`]),
    `probe=${pending?.lastProbe.disposition ?? status.lastDecision?.probe.disposition ?? "unknown"}`,
    ...(counts === undefined ? [] : [`turns=${counts.turns} jobs=${counts.jobs} asks=${counts.asks}`]),
    ...(status.lastForced === undefined ? [] : [`last forced=${status.lastForced.outcome} at=${status.lastForced.at}`]),
  ].join("; ");
}

const REASONS = new Set<MaintenanceReason>(["log-size", "snapshot-drift", "definition-drift", "runtime-upgrade", "runtime-unverified"]);
const DECISIONS = new Set<MaintenanceDecision>(["deferred-busy", "proceeded-idle", "forced-ceiling", "forced-size", "override-permission-repair", "override-transaction-recovery", "override-worker-unready"]);
function date(value: unknown): boolean { return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value; }
function keys(value: object, allowed: readonly string[]): boolean { return Object.keys(value).every((key) => allowed.includes(key)); }
function reasons(value: unknown): boolean { return Array.isArray(value) && value.length <= REASONS.size && value.every((reason) => REASONS.has(reason)); }
function probe(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const p = value as WorkerActivityProbe;
  return keys(p, ["disposition", "counts"]) && ["busy", "idle", "unknown", "not-running"].includes(p.disposition)
    && (p.counts === undefined || (typeof p.counts === "object" && p.counts !== null
      && Object.keys(p.counts).sort().join(",") === "asks,jobs,turns"
      && [p.counts.turns, p.counts.jobs, p.counts.asks].every((n) => Number.isSafeInteger(n) && n >= 0)));
}
function decision(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const d = value as MaintenanceDecisionRecord;
  return keys(d, ["outcome", "at", "reasons", "probe"]) && DECISIONS.has(d.outcome) && date(d.at) && reasons(d.reasons) && probe(d.probe);
}
function validateStatus(value: unknown): asserts value is LaunchdMaintenanceActivityStatus {
  if (typeof value !== "object" || value === null) throw new Error("Malformed maintenance activity status.");
  const s = value as LaunchdMaintenanceActivityStatus;
  const p = s.pending;
  if (!keys(s, ["version", "pending", "lastDecision", "lastForced"]) || s.version !== 1 || (s.lastDecision !== undefined && !decision(s.lastDecision))
    || (s.lastForced !== undefined && (!decision(s.lastForced) || !["forced-ceiling", "forced-size"].includes(s.lastForced.outcome)))
    || (p !== undefined && (typeof p !== "object" || p === null || !keys(p, ["reasons", "firstDeferredAt", "count", "lastProbe", "forcedBy"]) || !reasons(p.reasons) || !date(p.firstDeferredAt)
      || !Number.isSafeInteger(p.count) || p.count < 1 || !probe(p.lastProbe) || !date(p.forcedBy)))) {
    throw new Error("Malformed maintenance activity status.");
  }
}

export class MaintenanceDeferred extends Error {
  constructor() { super("Unattended maintenance deferred while worker activity is busy or unknown."); }
}

/** Acknowledge completed maintenance/fresh healthy startup or vanished need; retain history. */
export async function clearMaintenanceDeferral(target: BackgroundLifecycleTarget): Promise<void> {
  const status = await readLaunchdMaintenanceActivityStatus(target.label, target.paths);
  if (status?.pending === undefined) return;
  const { pending: _pending, ...history } = status;
  await writeLaunchdMaintenanceActivityStatus(target, history);
}
