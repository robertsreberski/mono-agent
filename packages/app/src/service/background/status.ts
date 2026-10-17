import process from "node:process";

import type { TraceSourceListItem } from "@mono-agent/observability";

import { describeMaintenanceActivity, readLaunchdMaintenanceActivityStatus } from "../../launchd-maintenance-activity.js";
import { readLaunchdLogMonitorStatus } from "../../launchd-log-monitor-status.js";
import { hasCompletedManagedStartup } from "../../managed-startup.js";
import { launchdServiceInfo } from "../../launchd.js";
import { readLaunchdSnapshotRefusal, SNAPSHOT_REFUSAL_MESSAGE } from "../../launchd-snapshot-refusal.js";
import { RUNS_HEALTH_MAX_RUNS } from "../../runs-health.js";
import { canonicalBackgroundConfigPath } from "./target.js";
import { channelRecords, commandFlags, formatOtherInstance, isPlainRecord, writeInstanceDetail, writeRunsHealthDetail } from "./presentation.js";
import type { BackgroundDeps, InstanceTarget, StatusBackgroundOptions } from "./types.js";
import * as ui from "../../ui.js";

export async function statusBackground(
  target: InstanceTarget,
  deps: BackgroundDeps,
  options: StatusBackgroundOptions = {},
): Promise<number> {
  const [classified, service] = await Promise.all([
    classifyStatusSources(target, deps),
    launchdServiceInfo(deps.runner, target.label, deps.getuid()),
  ]);
  const matchingSources = classified.filter((entry) => entry.matches).map((entry) => entry.source);
  // Status is diagnostic: unsafe or unreadable refusal state is reported, never fatal.
  const snapshotRefused = await readLaunchdSnapshotRefusal(target.label, target.paths).catch((error: unknown) => {
    deps.stderr(ui.errorLine(`Could not read the managed snapshot refusal status: ${error instanceof Error ? error.message : String(error)}`));
    return false;
  });
  const recorded = service.pid === undefined
    ? matchingSources[0]
    : matchingSources.find((source) => source.pid === service.pid) ?? matchingSources[0];
  const active = service.loaded
    && service.pid !== undefined
    && deps.isAlive(service.pid)
    && recorded?.pid === service.pid
    && recorded.health === "running";
  const current = recorded === undefined || active ? recorded : inactiveStatusSource(recorded);
  // Only surface other instances that are live or crashed — cleanly stopped
  // manifests linger in the registry and would just be noise.
  const others = classified
    .filter((entry) => !entry.matches && entry.source.health !== "stopped")
    .map((entry) => entry.source);

  const maintenanceActivity = await readLaunchdMaintenanceActivityStatus(target.label, target.paths).catch(() => "unavailable" as const);
  const logMonitor = await readLaunchdLogMonitorStatus(target.label, target.paths).catch(() => "unavailable" as const);
  if (options.json === true) {
    const instance = current === undefined ? null : await assembleInstanceStatus(current, target, deps);
    deps.stdout(`${JSON.stringify({
      ok: active,
      instance,
      maintenanceActivity: maintenanceActivity ?? null,
      logMonitor: logMonitor ?? null,
      ...(snapshotRefused ? { startupFailure: { reason: "snapshot-refused", message: SNAPSHOT_REFUSAL_MESSAGE } } : {}),
      others: others.map(assembleOtherInstanceStatus),
    })}\n`);
    return active ? 0 : 1;
  }

  if (current === undefined) {
    deps.stdout(ui.style.dim(`No running mono-agent instance for ${target.configPath}.`) + "\n");
    deps.stdout(ui.hint(`Start it with: mono-agent start${commandFlags(target)}`));
  } else {
    writeInstanceDetail(current, target, deps);
    await writeRunsHealthDetail(current, deps);
  }

  if (maintenanceActivity !== undefined) deps.stdout((maintenanceActivity === "unavailable" ? "Maintenance: owner-private status is unavailable or unsafe." : describeMaintenanceActivity(maintenanceActivity)) + "\n");
  if (logMonitor !== undefined) deps.stdout(logMonitor === "unavailable" ? "Log monitor: owner-private status is unavailable or unsafe.\n" : `Log monitor: ${logMonitor.lastOutcome}; wakes=${logMonitor.wakeCount}\n`);
  if (snapshotRefused) deps.stdout(ui.errorLine(SNAPSHOT_REFUSAL_MESSAGE));

  if (others.length > 0) {
    deps.stdout("\n" + ui.rule("Other mono-agent instances"));
    for (const source of others) {
      deps.stdout(`${formatOtherInstance(source)}\n`);
    }
  }

  return active ? 0 : 1;
}

function inactiveStatusSource(source: TraceSourceListItem): TraceSourceListItem {
  const {
    transports: _staleTransports,
    pid: _stalePid,
    ...withoutLiveProcessFacts
  } = source;
  const metadata = source.metadata;
  const channels = metadata?.channels;
  const stoppedChannels = isPlainRecord(channels)
    ? Object.fromEntries(Object.entries(channels).map(([id, value]) => {
        if (!isPlainRecord(value) || value.kind !== "running") return [id, value];
        return [id, { kind: "stopped", reason: "instance is not running" }];
      }))
    : undefined;
  return {
    ...withoutLiveProcessFacts,
    health: "stopped",
    status: "stopped",
    ...(metadata === undefined
      ? {}
      : {
          metadata: {
            ...metadata,
            ...(stoppedChannels === undefined ? {} : { channels: stoppedChannels }),
          },
        }),
  } as TraceSourceListItem;
}

/**
 * The machine-readable instance record for `status --json`. It mirrors the
 * fields the human `writeInstanceDetail`/`writeRunsHealthDetail` render, reading
 * only the already-computed trace-source manifest (content-free, safe to publish)
 * and the same runs-health probe the human path performs — no extra probes.
 */
async function assembleInstanceStatus(
  source: TraceSourceListItem,
  target: InstanceTarget,
  deps: BackgroundDeps,
): Promise<Record<string, unknown>> {
  const metadata = source.metadata ?? {};
  const processJobs = metadata.processJobs;
  const sandbox = metadata.sandbox;
  const session = metadata.session;
  const channels = metadata.channels;
  return {
    sourceId: source.sourceId,
    label: source.label,
    launchdLabel: target.label,
    pid: source.pid ?? null,
    health: source.health,
    status: source.status,
    configPath: target.configPath,
    startedAt: source.startedAt,
    updatedAt: source.updatedAt,
    ...(source.artifactDir === undefined ? {} : { artifactDir: source.artifactDir }),
    ...(source.transports === undefined ? {} : { transports: source.transports }),
    logs: { stdout: target.paths.stdoutPath, stderr: target.paths.stderrPath },
    ...(isPlainRecord(processJobs) ? { processJobs } : {}),
    ...(isPlainRecord(sandbox) ? { sandbox } : {}),
    ...(isPlainRecord(session) ? { session } : {}),
    ...(isPlainRecord(channels) ? { channels } : {}),
    ...(source.memoryHealth === undefined ? {} : { memoryHealth: source.memoryHealth }),
    runsHealth: await assembleRunsHealthStatus(source, deps),
  };
}

async function assembleRunsHealthStatus(
  source: TraceSourceListItem,
  deps: BackgroundDeps,
): Promise<{ readonly totalRuns: number; readonly warnings: readonly string[] } | null> {
  if (source.artifactDir === undefined || source.artifactDir.trim().length === 0) {
    return null;
  }
  const { totalRuns, warnings } = await deps.listRecordedRuns({
    artifactDir: source.artifactDir,
    maxRuns: RUNS_HEALTH_MAX_RUNS,
    scope: "agent",
  });
  return { totalRuns, warnings };
}

function assembleOtherInstanceStatus(source: TraceSourceListItem): Record<string, unknown> {
  return {
    sourceId: source.sourceId,
    label: source.label,
    health: source.health,
    pid: source.pid ?? null,
    ...(source.configPath === undefined ? {} : { configPath: source.configPath }),
  };
}

/**
 * Status only (read-only): every source in the target's registry, classified
 * against its config, plus every entry for the same config in the global
 * mirror. Duplicates are kept; status picks the one whose pid is the launchd
 * service pid. Lifecycle commands keep using {@link findInstances}.
 */
async function classifyStatusSources(
  target: InstanceTarget,
  deps: BackgroundDeps,
): Promise<readonly { readonly source: TraceSourceListItem; readonly matches: boolean }[]> {
  const classify = async (registryDir: string) => await Promise.all(
    (await deps.listTraceSources({ registryDir, staleAfterMs: target.staleAfterMs })).sources.map(async (source) => ({
      source,
      matches: await matchesConfig(source, target.configPath),
    })),
  );
  const local = await classify(target.registryDir);
  if (target.mirrorRegistryDir === undefined) return local;
  return [...local, ...(await classify(target.mirrorRegistryDir)).filter((entry) => entry.matches)];
}

export async function findInstances(target: InstanceTarget, deps: BackgroundDeps): Promise<readonly TraceSourceListItem[]> {
  const result = await deps.listTraceSources({ registryDir: target.registryDir, staleAfterMs: target.staleAfterMs });
  const matches = await Promise.all(result.sources.map(async (source) => ({
    source,
    matches: await matchesConfig(source, target.configPath),
  })));
  return matches.filter((entry) => entry.matches).map((entry) => entry.source);
}

async function matchesConfig(source: TraceSourceListItem, configPath: string): Promise<boolean> {
  if (source.configPath === undefined) return false;
  return await canonicalBackgroundConfigPath(process.cwd(), source.configPath) === configPath;
}

export function isReady(source: TraceSourceListItem): boolean {
  if (source.health !== "running" || !hasCompletedManagedStartup(source)) return false;
  if (source.memoryHealth?.status === "unhealthy") return false;
  const channels = channelRecords(source);
  if (channels.some((channel) => channel.kind === "failed")) return false;
  return true;
}

export function startedAtMs(source: TraceSourceListItem): number {
  const parsed = Date.parse(source.startedAt);
  return Number.isFinite(parsed) ? parsed : 0;
}
