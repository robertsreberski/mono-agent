import { formatManagedRuntimeProgress } from "./managed-runtime-progress.js";
import {
  MaintenanceDeferred, logPermissionRepairNeeded,
  type MaintenanceActivityRequest, type MaintenanceReason,
} from "./launchd-maintenance-activity.js";
import { dirname, resolve } from "node:path";

import type { TraceSourceListItem } from "@mono-agent/observability";

import {
  bootstrap,
  buildLaunchdMaintenancePlistXml,
  buildPlistXml,
  deriveLaunchdMaintenanceLabel,
  isLoaded,
  launchdManagedWorkerInfo,
  launchdMaintenanceEntrypointPathForCli,
  launchdServiceInfo,
  launchdMaintenanceCalendarMinute,
} from "./launchd.js";
import type {
  LaunchctlResult,
  LaunchdManagedWorkerDefinition,
} from "./launchd.js";
import type { LaunchdLogMaintenanceIntent } from "./launchd-logs.js";
import type {
  ManagedRuntimeLaunchVerification,
  ManagedRuntimeSourceIdentity,
} from "./service/managed-runtime/types.js";
import {
  backgroundSnapshotFromMetadata,
  captureBackgroundSnapshot,
  encodeBackgroundSnapshot,
  sameBackgroundSnapshot,
} from "./background-snapshot.js";
import type { BackgroundSnapshot } from "./background-snapshot.js";
import { clearLaunchdSnapshotRefusal } from "./launchd-snapshot-refusal.js";
import { acquireManagedRuntimePublicationBarrier } from "./managed-runtime-publication.js";
import type { OwnerPrivateLock } from "./durable-state/owner-private-lock.js";
import { acquireSharedLaunchdLogLock } from "./launchd-lifecycle-lock.js";
import type { BackgroundLifecycleTarget } from "./launchd-lifecycle-lock.js";
import {
  assertLaunchdMaintenanceLifecycleLease,
  withLaunchdMaintenanceControllerLock,
} from "./launchd-maintenance-gate.js";
import type { LaunchdMaintenanceLifecycleLease } from "./launchd-maintenance-gate.js";
import {
  lifecycleFailure,
  maintenanceErrorMessage,
  pollUntil,
  uniquePids,
  unloadLaunchdService,
} from "./background-lifecycle-utils.js";
import type { PollOptions } from "./background-lifecycle-utils.js";
import {
  maintainLaunchdLogsWithLifecycleLockOperation,
  reportMaintenanceFailure
} from "./background-log-maintenance.js";
import { managedLaunchdLogMaintenanceEnvironment } from "./service/background/target.js";
import { findInstances, isReady, startedAtMs } from "./service/background/status.js";
import {
  formatLifecycleDuration,
  printInstanceInfo,
  reportLaunchFailure,
  reportLifecycleException,
  reportOwnershipConflict,
  reportReadinessCleanup,
  reportReadinessException,
  reportSnapshotDrift,
  reportTimeout,
  runtimeVerificationLabel,
} from "./service/background/presentation.js";
import type {
  BackgroundDeps,
  BackgroundLaunchResult,
  BackgroundReadyInternalOptions,
  InstanceTarget,
  LaunchdControllerOptions,
  LaunchOutcome,
  LogOptions,
  ReadyPollOptions,
} from "./service/background/types.js";
import * as ui from "./cli/ui.js";

const DEFAULT_CONTROL_POLL: PollOptions = { timeoutMs: 18_000, intervalMs: 400 };
const DEFAULT_READINESS_POLL: PollOptions = { timeoutMs: 60_000, intervalMs: 400 };

export async function startBackground(
  target: InstanceTarget,
  deps: BackgroundDeps,
  poll?: PollOptions,
): Promise<number> {
  return (await ensureBackgroundReady(target, deps, poll)).ok ? 0 : 1;
}

/** Restart is behaviourally identical: ensure a single fresh running instance. */
export async function restartBackground(
  target: InstanceTarget,
  deps: BackgroundDeps,
  poll?: PollOptions,
): Promise<number> {
  return (await ensureBackgroundReady(target, deps, poll)).ok ? 0 : 1;
}

/**
 * Private one-shot recovery controller invoked by the maintenance LaunchAgent.
 * It authenticates the exact helper PID launchd owns, compares the inert source
 * CLI identity with the strictly parsed loaded worker definition, and repairs
 * only when the worker, snapshot, definition, or available source closure has
 * drifted. A healthy worker remains serving while a replacement runtime is
 * materialized.
 */
export async function maintainLaunchdController(
  target: InstanceTarget,
  deps: BackgroundDeps,
  options: LaunchdControllerOptions,
  lifecycleLease?: LaunchdMaintenanceLifecycleLease,
): Promise<number> {
  if (lifecycleLease !== undefined) {
    assertLaunchdMaintenanceLifecycleLease(lifecycleLease, target);
    return await maintainLaunchdControllerWithLifecycleLease(target, deps, options);
  }
  return await withLaunchdMaintenanceControllerLock(target, deps, async (ownership) =>
    await maintainLaunchdController(target, deps, options, ownership));
}

/** Reconcile while the authenticated helper owns only this agent's lifecycle. */
async function maintainLaunchdControllerWithLifecycleLease(
  target: InstanceTarget,
  deps: BackgroundDeps,
  options: LaunchdControllerOptions,
): Promise<number> {
  const uid = deps.getuid();
  let maintainLogsOnly = false;
  let resultCode = 1;
  try {
    const [worker, sources, desiredIdentity] = await Promise.all([
      launchdManagedWorkerInfo(deps.runner, target.label, uid),
      findInstances(target, deps),
      deps.inspectManagedRuntimeSourceIdentity(target.cliPath),
    ]);
    let loadedIdentity: ManagedRuntimeLaunchVerification | undefined;
    if (worker.definition !== undefined) {
      try {
        loadedIdentity = await deps.verifyManagedRuntimeLaunch({
          currentCliPath: worker.definition.cliPath,
          launchProof: worker.definition.expectedManagedRuntimeLaunch,
        });
      } catch {
        // A malformed/unverified loaded closure is a recovery condition. Do not
        // trust any identity or execute its advertised CLI.
      }
    }
    const source = worker.pid === undefined
      ? undefined
      : sources.find((candidate) => candidate.pid === worker.pid);
    const durableSnapshotStillMatches = await snapshotStillMatches(target, deps);
    const workerReady = worker.loaded
      && worker.pid !== undefined
      && deps.isAlive(worker.pid)
      && source !== undefined
      && isReady(source);
    const snapshotMatches = source !== undefined
      && snapshotMetadataMatches(source, target.expectedSnapshot) && durableSnapshotStillMatches;
    const workerHealthy = workerReady && snapshotMatches;
    const definitionMatches = worker.definition !== undefined
      && managedWorkerDefinitionMatchesTarget(worker.definition, target, deps);
    const runtimeMatches = loadedIdentity !== undefined
      && sameManagedRuntimeIdentity(loadedIdentity, desiredIdentity);
    const recoveryReasons: MaintenanceReason[] = [
      ...(!snapshotMatches ? ["snapshot-drift" as const] : []),
      ...(!definitionMatches ? ["definition-drift" as const] : []),
      ...(loadedIdentity === undefined ? ["runtime-unverified" as const] : []),
      ...(options.sourceAvailable && !runtimeMatches ? ["runtime-upgrade" as const] : []),
    ];
    const needsRecovery = !workerHealthy
      || !definitionMatches
      || loadedIdentity === undefined
      || (options.sourceAvailable && !runtimeMatches);
    if (!needsRecovery) {
      maintainLogsOnly = true;
      resultCode = 0;
    } else {
      const preflightCode = await options.recoveryPreflight?.() ?? 0;
      if (preflightCode !== 0) return preflightCode;
      if (!options.sourceAvailable) {
        deps.stderr(ui.style.dim(
          `The original controller CLI is unavailable; recovering ${target.label} from the helper's private closure without claiming an upgrade.`,
        ) + "\n");
      }
      const recovered = await ensureBackgroundReadyUnlocked(
        target,
        deps,
        options.controlPoll ?? DEFAULT_CONTROL_POLL,
        options.readinessPoll ?? DEFAULT_READINESS_POLL,
        {
          preserveMaintenanceService: true,
          preserveDefinitionsOnFailure: true,
          sharedLockMode: "automatic",
          unattendedMaintenance: { reasons: recoveryReasons },
        },
      );
      resultCode = recovered.ok || recovered.reason === "shared-contention" || recovered.reason === "deferred-busy" ? 0 : 1;
    }
  } catch (error) {
    reportMaintenanceFailure(target, deps, "reconcile the managed worker", error);
    resultCode = 1;
  }
  return maintainLogsOnly
    ? await maintainLaunchdLogsWithLifecycleLockOperation(
        target,
        unattendedLogDeps(target, deps),
        options.controlPoll ?? DEFAULT_CONTROL_POLL,
        async () => await acquireSharedLaunchdLogLock(target, deps, "automatic"),
      )
    : resultCode;
}

function managedWorkerDefinitionMatchesTarget(
  definition: LaunchdManagedWorkerDefinition,
  target: InstanceTarget,
  deps: BackgroundDeps,
): boolean {
  let effective: string;
  try {
    effective = deps.resolveApprovedSnapshot === undefined ? definition.expectedBackgroundSnapshot
      : encodeBackgroundSnapshot(deps.resolveApprovedSnapshot({
        label: target.label, managedRoot: dirname(target.paths.logDir), configPath: definition.configPath,
        encodedSnapshot: definition.expectedBackgroundSnapshot, launchProof: definition.expectedManagedRuntimeLaunch,
      }));
  } catch { return false; }
  return target.expectedSnapshot !== undefined
    && definition.plistPath === target.paths.plistPath
    && definition.nodePath === target.nodePath
    && definition.configPath === target.configPath
    && definition.cwd === target.cwd
    && definition.envFile === target.envFile
    && definition.stdoutPath === target.paths.stdoutPath
    && definition.stderrPath === target.paths.stderrPath
    && effective === encodeBackgroundSnapshot(target.expectedSnapshot)
    && sameStringRecord(definition.environment, target.environment);
}

function sameManagedRuntimeIdentity(
  loaded: Pick<ManagedRuntimeLaunchVerification, "packageVersion" | "cliSha256">,
  desired: ManagedRuntimeSourceIdentity,
): boolean {
  return loaded.packageVersion === desired.packageVersion && loaded.cliSha256 === desired.cliSha256;
}

function sameStringRecord(
  left: Readonly<Record<string, string>>,
  right: Readonly<Record<string, string>>,
): boolean {
  const leftEntries = Object.entries(left).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  const rightEntries = Object.entries(right).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  return leftEntries.length === rightEntries.length
    && leftEntries.every(([name, value], index) => {
      const other = rightEntries[index];
      return other?.[0] === name && other[1] === value;
    });
}

/**
 * Stop, perform the caller's stopped-worker mutation, and start again while
 * retaining one lifecycle lock. This closes the force-restart gap in which a
 * concurrent start could previously enter while the session store was purged.
 */
export async function forceRestartBackground(
  target: InstanceTarget,
  deps: BackgroundDeps,
  whileStopped: () => Promise<void>,
  poll?: PollOptions,
): Promise<number> {
  const release = await deps.acquireLifecycleLock(target);
  if (release === undefined) {
    deps.stderr(ui.errorLine(`Another lifecycle command is already active for ${target.label}.`));
    deps.stderr(ui.hint("No LaunchAgent or session changes were made. Wait for that command to finish, then retry."));
    return 1;
  }
  try {
    const controlPoll = poll ?? DEFAULT_CONTROL_POLL;
    const stopCode = await stopBackgroundUnlocked(target, deps, controlPoll);
    if (stopCode !== 0) return stopCode;
    await deps.invalidateApprovedSnapshots?.(target);
    await whileStopped();
    return (await ensureBackgroundReadyUnlocked(
      target,
      deps,
      controlPoll,
      poll ?? DEFAULT_READINESS_POLL,
    )).ok ? 0 : 1;
  } finally {
    await release().catch((error: unknown) => {
      deps.stderr(ui.errorLine(
        `Could not release lifecycle lock for ${target.label}: ${error instanceof Error ? error.message : String(error)}`,
      ));
    });
  }
}

/**
 * Ensure the canonical per-config LaunchAgent is running and return the fresh
 * trace source that proved it completed the full startup lifecycle. This is the shared
 * lifecycle boundary for CLI start/restart and remote configuration handoffs;
 * callers must not open a console when the result is not ok.
 */
export async function ensureBackgroundReady(
  target: InstanceTarget,
  deps: BackgroundDeps,
  poll?: PollOptions,
): Promise<BackgroundLaunchResult> {
  const release = await deps.acquireLifecycleLock(target);
  if (release === undefined) {
    deps.stderr(ui.errorLine(`Another lifecycle command is already active for ${target.label}.`));
    deps.stderr(ui.hint("No LaunchAgent changes were made. Wait for that command to finish, then retry."));
    return { ok: false, action: "start", reason: "ownership" };
  }
  try {
    return await ensureBackgroundReadyUnlocked(
      target,
      deps,
      poll ?? DEFAULT_CONTROL_POLL,
      poll ?? DEFAULT_READINESS_POLL,
    );
  } finally {
    await release().catch((error: unknown) => {
      deps.stderr(ui.errorLine(
        `Could not release lifecycle lock for ${target.label}: ${error instanceof Error ? error.message : String(error)}`,
      ));
    });
  }
}

async function ensureBackgroundReadyUnlocked(
  target: InstanceTarget,
  deps: BackgroundDeps,
  controlPoll: PollOptions,
  readinessPoll: PollOptions,
  options: BackgroundReadyInternalOptions = {},
): Promise<BackgroundLaunchResult> {
  if (target.expectedSnapshot === undefined) {
    deps.stderr(ui.errorLine("Refusing to launch a managed worker without an approved background snapshot."));
    deps.stderr(ui.hint("No LaunchAgent changes were made. Retry from the wizard or `mono-agent start`."));
    return { ok: false, action: "start", reason: "snapshot" };
  }
  if (!(await snapshotStillMatches(target, deps))) {
    reportSnapshotDrift(target, deps);
    return { ok: false, action: "start", reason: "snapshot" };
  }
  let publicationBarrier: OwnerPrivateLock | undefined;
  try {
    publicationBarrier = await (deps.acquireRuntimePublicationBarrier
      ?? ((input: BackgroundLifecycleTarget) => acquireManagedRuntimePublicationBarrier({
        label: input.label,
        managedRoot: dirname(input.paths.logDir),
      })))(target);
  } catch (error) {
    reportLifecycleException(target, deps, "establish the managed runtime publication barrier", error);
    return { ok: false, action: "start", reason: "ownership" };
  }
  if (publicationBarrier === undefined) {
    deps.stderr(ui.errorLine(`Another runtime publication is already active for ${target.label}.`));
    return { ok: false, action: "start", reason: "ownership" };
  }
  return await ensureBackgroundReadyWithPublicationBarrier(
    target,
    deps,
    controlPoll,
    readinessPoll,
    publicationBarrier,
    options,
  );
}

export function unattendedLogDeps(target: BackgroundLifecycleTarget, deps: BackgroundDeps): BackgroundDeps {
  const { clearMaintenanceDeferral, allowUnattendedStop } = deps;
  return {
    ...deps,
    ...(clearMaintenanceDeferral === undefined ? {} : {
      maintenanceNotNeeded: () => clearMaintenanceDeferral(target),
      maintenanceCompleted: () => clearMaintenanceDeferral(target),
    }),
    ...(allowUnattendedStop === undefined ? {} : {
      unattendedLogStop: (request: MaintenanceActivityRequest) => allowUnattendedStop(target, request),
    }),
  };
}

async function ensureBackgroundReadyWithPublicationBarrier(
  target: InstanceTarget,
  deps: BackgroundDeps,
  controlPoll: PollOptions,
  readinessPoll: PollOptions,
  publicationBarrier: OwnerPrivateLock,
  options: BackgroundReadyInternalOptions,
): Promise<BackgroundLaunchResult> {
  let barrierReleased = false;
  const releaseBarrier = async (): Promise<void> => {
    if (barrierReleased) return;
    await publicationBarrier.release();
    barrierReleased = true;
  };
  try {
    return await ensureBackgroundReadyAfterPublicationBarrier(
      target,
      deps,
      controlPoll,
      readinessPoll,
      releaseBarrier,
      options,
    );
  } finally {
    if (!barrierReleased) {
      await releaseBarrier().catch((error: unknown) => {
        deps.stderr(ui.errorLine(
          `Could not release runtime publication barrier for ${target.label}: ${error instanceof Error ? error.message : String(error)}`,
        ));
      });
    }
  }
}

async function ensureBackgroundReadyAfterPublicationBarrier(
  target: InstanceTarget,
  deps: BackgroundDeps,
  controlPoll: PollOptions,
  readinessPoll: PollOptions,
  releaseBarrier: () => Promise<void>,
  options: BackgroundReadyInternalOptions,
): Promise<BackgroundLaunchResult> {
  const uid = deps.getuid();
  let launchTarget: InstanceTarget;
  const runtimeStartedAt = deps.now();
  deps.stdout(ui.hint("Verifying the durable managed runtime…"));
  try {
    const additionalPackages = await deps.resolveManagedRuntimePackages?.(target) ?? [];
    const runtime = await deps.ensureManagedRuntime({
      currentCliPath: target.cliPath,
      nodePath: target.nodePath,
      additionalPackages,
      onProgress: (progress) => {
        // The lifecycle wrapper already prints the initial hint and ready summary.
        if (progress.phase !== "ready" && !(progress.phase === "reuse" && progress.completed === 0)) {
          deps.stdout(ui.hint(formatManagedRuntimeProgress(progress)));
        }
      },
    });
    launchTarget = {
      ...target,
      cliPath: runtime.cliPath,
      nodePath: runtime.nodePath,
      managedRuntimeLaunchProof: runtime.launchProof,
    };
    deps.stdout(ui.hint(
      `Managed runtime ready (${runtimeVerificationLabel(runtime.verificationMode)}, `
      + `${formatLifecycleDuration(deps.now() - runtimeStartedAt)}).`,
    ));
  } catch (error) {
    reportLifecycleException(target, deps, "install and verify the durable managed runtime", error);
    return { ok: false, action: "start", reason: "runtime" };
  }

  // Exact-closure copying and integrity verification can take time. Recheck the
  // approved files after runtime preparation and before writing any
  // LaunchAgent state.
  if (!(await snapshotStillMatches(launchTarget, deps))) {
    reportSnapshotDrift(launchTarget, deps);
    return { ok: false, action: "start", reason: "snapshot" };
  }

  try {
    const conflict = await findOwnershipConflict(launchTarget, deps, uid);
    if (conflict !== undefined) {
      reportOwnershipConflict(launchTarget, deps, conflict);
      return { ok: false, action: "start", reason: "ownership" };
    }
  } catch (error) {
    reportLifecycleException(launchTarget, deps, "verify the existing background worker ownership", error);
    return { ok: false, action: "start", reason: "ownership" };
  }

  let releaseSharedLogLock: (() => Promise<void>) | undefined;
  try {
    releaseSharedLogLock = await acquireSharedLaunchdLogLock(
      launchTarget,
      deps,
      options.sharedLockMode ?? "interactive",
    );
  } catch (error) {
    reportLifecycleException(launchTarget, deps, "acquire the shared launchd-log mutation lock", error);
    return { ok: false, action: "start", reason: "ownership" };
  }
  if (releaseSharedLogLock === undefined) {
    if (options.sharedLockMode !== "automatic") {
      deps.stderr(ui.errorLine(
        "Shared launchd-log maintenance is already active for another agent on this account.",
      ));
    }
    return { ok: false, action: "start", reason: "shared-contention" };
  }

  let sinceMs = deps.now();
  let outcome: LaunchOutcome;
  let prepared = false;
  deps.stdout(ui.hint("Replacing the managed worker…"));
  try {
    const priorInspection = options.unattendedMaintenance === undefined ? undefined : await deps.inspectLaunchdLogs(launchTarget.paths);
    if (priorInspection !== undefined && !priorInspection.canMaintain) throw new Error("Unsafe launchd log inventory before unattended replacement.");
    const permissionRepair = priorInspection !== undefined && logPermissionRepairNeeded(priorInspection);
    await prepareLaunchdDirectories(launchTarget, deps);
    let interruptedMaintenance = await deps.readLaunchdLogMaintenanceIntent(launchTarget.paths);
    if (interruptedMaintenance?.phase === "stopping" || interruptedMaintenance?.phase === "restoring") {
      const current = await launchdServiceInfo(deps.runner, launchTarget.label, uid);
      if (!current.loaded) {
        throw new Error(
          "Interrupted launchd-log maintenance lost its writer PID before durable stopped-writer proof; refusing restart.",
        );
      }
    }
    const checkUnattendedActivity = async (): Promise<void> => {
      if (options.unattendedMaintenance !== undefined && deps.allowUnattendedStop !== undefined) {
        const inspection = await deps.inspectLaunchdLogs(launchTarget.paths);
        if (!inspection.canMaintain) throw new Error("Unsafe launchd log inventory before unattended replacement.");
        // Runtime preparation can outlast startup. The override belongs to the
        // current launchd PID's readiness NOW, not the reconciliation-entry trace.
        const current = await launchdServiceInfo(deps.runner, launchTarget.label, uid);
        const currentSource = (await findInstances(launchTarget, deps)).find((source) => source.pid === current.pid);
        const readyNow = current.loaded && current.pid !== undefined && deps.isAlive(current.pid)
          && currentSource !== undefined && isReady(currentSource);
        const override = interruptedMaintenance !== undefined || inspection.pendingTransaction
          ? "transaction-recovery" as const
          : permissionRepair || logPermissionRepairNeeded(inspection) ? "permission-repair" as const
          : !readyNow ? "worker-unready" as const : undefined;
        if (!await deps.allowUnattendedStop(launchTarget, { reasons: options.unattendedMaintenance.reasons, inspection,
          ...(override === undefined ? {} : { override }) })) throw new MaintenanceDeferred();
      }
    };
    outcome = await bootstrapOrRestart(launchTarget, deps, uid, controlPoll, async () => {
      const stoppedIntent = interruptedMaintenance;
      if (stoppedIntent?.phase === "stopped") {
        interruptedMaintenance = await deps.markLaunchdLogMaintenanceStopping(
          launchTarget.paths,
          stoppedIntent,
        );
      }
    }, async (mainStopProven) => {
      const stoppingIntent = interruptedMaintenance;
      if (stoppingIntent?.phase === "stopping" || stoppingIntent?.phase === "restoring") {
        if (!mainStopProven) {
          throw new Error("The controller could not renew stopped-writer proof for interrupted log maintenance.");
        }
        interruptedMaintenance = await deps.markLaunchdLogMaintenanceStopped(
          launchTarget.paths,
          stoppingIntent,
        );
      }
      await deps.rotateStoppedLaunchdLogs(launchTarget.paths);
      // A controller may be completing a maintainer that died after bootout.
      // Once journal recovery finishes under the stopped-writer proof, cancel
      // its old restore authority before replacing either plist.
      await deps.clearLaunchdLogMaintenanceIntent(launchTarget.paths, interruptedMaintenance);
      await deps.invalidateApprovedSnapshots?.(launchTarget);
      await writePlists(launchTarget, deps);
      sinceMs = deps.now();
      prepared = true;
      // The replacement plist now contains the finalized-runtime proof. Let
      // launchd respawn only after the stopped-window commit is complete.
      await releaseBarrier();
    }, { preserveMaintenanceService: options.preserveMaintenanceService === true, checkUnattendedActivity });
  } catch (error) {
    if (error instanceof MaintenanceDeferred) return { ok: false, action: "start", reason: "deferred-busy" };
    reportLifecycleException(
      launchTarget,
      deps,
      prepared ? "start the LaunchAgent" : "prepare the stopped LaunchAgent",
      error,
    );
    return { ok: false, action: "start", reason: prepared ? "launchctl" : "preparation" };
  } finally {
    await releaseSharedLogLock?.().catch((error: unknown) => {
      deps.stderr(ui.errorLine(
        `Could not release the shared launchd-log mutation lock for ${launchTarget.label}: ${error instanceof Error ? error.message : String(error)}`,
      ));
    });
  }
  const action = outcome.restarted ? "restart" as const : "start" as const;
  if (!outcome.ok) {
    reportLaunchFailure(launchTarget, deps, action, outcome.failure);
    return { ok: false, action, reason: "launchctl" };
  }
  deps.stdout(ui.hint("Waiting for the worker to report ready…"));
  let ready: TraceSourceListItem | undefined;
  try {
    ready = await pollInstanceReady(launchTarget, deps, {
      ...readinessPoll,
      sinceMs,
    });
  } catch (error) {
    reportReadinessException(deps, error);
    const stopped = await cleanUpUnreadyBackground(launchTarget, deps, controlPoll, options);
    reportReadinessCleanup(launchTarget, deps, stopped, options);
    return { ok: false, action, reason: "readiness" };
  }
  if (ready === undefined) {
    if (!(await snapshotStillMatches(launchTarget, deps))) {
      const stopped = await cleanUpUnreadyBackground(launchTarget, deps, controlPoll, options) ? 0 : 1;
      reportSnapshotDrift(launchTarget, deps);
      if (stopped === 0) {
        deps.stderr(ui.style.dim("The drifted LaunchAgent was stopped before returning control.") + "\n");
      } else {
        deps.stderr(ui.style.yellow("The drifted LaunchAgent could not be proven stopped; follow the recovery commands above.") + "\n");
      }
      return { ok: false, action, reason: "snapshot" };
    }
    reportTimeout(deps);
    const stopped = await cleanUpUnreadyBackground(launchTarget, deps, controlPoll, options);
    reportReadinessCleanup(launchTarget, deps, stopped, options);
    return { ok: false, action, reason: "timeout" };
  }
  // Successful explicit start/restart also satisfies an older helper episode.
  // Stop deliberately leaves it; no completion is claimed until readiness proof.
  try { await deps.clearMaintenanceDeferral?.(launchTarget); }
  catch (error) {
    reportLifecycleException(launchTarget, deps, "acknowledge completed maintenance", error);
    return { ok: false, action, reason: "preparation" };
  }
  const completedAction = outcome.restarted ? "restarted" as const : "started" as const;
  printInstanceInfo(ready, launchTarget, deps, completedAction);
  return { ok: true, action: completedAction, source: ready };
}

async function prepareLaunchdDirectories(target: InstanceTarget, deps: BackgroundDeps): Promise<void> {
  // launchd will not create the log file's parent directory, so make both dirs
  // before writing the plist that references them.
  await deps.mkdir(dirname(target.paths.logDir));
  await deps.mkdir(target.paths.logDir);
  await deps.mkdir(target.paths.launchAgentsDir);
}

async function writePlists(target: InstanceTarget, deps: BackgroundDeps): Promise<void> {
  if (target.expectedSnapshot === undefined) {
    throw new Error("A managed LaunchAgent requires an approved background snapshot.");
  }
  if (target.managedRuntimeLaunchProof === undefined) {
    throw new Error("A managed LaunchAgent requires a finalized runtime launch proof.");
  }
  const agentPath = target.environment.PATH;
  if (agentPath === undefined || agentPath.length === 0) {
    throw new Error("A managed LaunchAgent recovery controller requires the durable worker PATH.");
  }
  const maintenance = maintenancePathsForTarget(target);
  const mainXml = buildPlistXml({
    label: target.label,
    nodePath: target.nodePath,
    cliPath: target.cliPath,
    configPath: target.configPath,
    cwd: target.cwd,
    ...(target.envFile === undefined ? {} : { envFile: target.envFile }),
    expectedBackgroundSnapshot: encodeBackgroundSnapshot(target.expectedSnapshot),
    expectedManagedRuntimeLaunch: target.managedRuntimeLaunchProof,
    stdoutPath: target.paths.stdoutPath,
    stderrPath: target.paths.stderrPath,
    environment: target.environment,
  });
  const maintenanceXml = buildLaunchdMaintenancePlistXml({
    label: maintenance.label,
    nodePath: target.nodePath,
    cliPath: launchdMaintenanceEntrypointPathForCli(target.cliPath),
    configPath: target.configPath,
    controllerCliPath: target.controllerCliPath ?? target.cliPath,
    agentCwd: target.cwd,
    agentPath,
    expectedManagedRuntimeLaunch: target.managedRuntimeLaunchProof,
    ...(target.envFile === undefined ? {} : { envFile: target.envFile }),
    // The agent folder may be renamed or removed while its already-running
    // worker still owns log descriptors. Keep the scheduler's cwd in the
    // durable account state tree; its config argument is already absolute.
    cwd: dirname(target.paths.logDir),
    environment: managedLaunchdLogMaintenanceEnvironment(target.environment),
    calendarMinute: launchdMaintenanceCalendarMinute(target.label),
  });
  await deps.writeFile(target.paths.plistPath, mainXml);
  await deps.writeFile(maintenance.plistPath, maintenanceXml);
}

/**
 * Idempotent: bootstrap when not loaded. A loaded job is always fully removed
 * before bootstrap so launchd cannot retain stale ProgramArguments or env from
 * the previous plist.
 */
async function bootstrapOrRestart(
  target: InstanceTarget,
  deps: BackgroundDeps,
  uid: number,
  poll: PollOptions,
  beforeMainBootout: () => Promise<void>,
  whileStopped: (mainStopProven: boolean) => Promise<void>,
  options: { readonly preserveMaintenanceService?: boolean; readonly checkUnattendedActivity?: () => Promise<void> } = {},
): Promise<LaunchOutcome> {
  const maintenance = maintenancePathsForTarget(target);
  const [service, maintenanceService] = await Promise.all([
    launchdServiceInfo(deps.runner, target.label, uid),
    launchdServiceInfo(deps.runner, maintenance.label, uid),
  ]);
  const restarted = service.loaded;

  // Stop the scheduler first. A helper that is already running either holds
  // this lifecycle lock (so the controller could not enter) or is waiting to
  // acquire it; bootout plus PID death prevents a post-stop resurrection.
  if (options.preserveMaintenanceService !== true) {
    const maintenanceStopped = await unloadLaunchdService(
      maintenance.label,
      maintenanceService,
      uniquePids([maintenanceService.pid]),
      deps,
      uid,
      poll,
    );
    if (!maintenanceStopped.ok) {
      return { ok: false, restarted, failure: maintenanceStopped.failure };
    }
  }

  let mainStopProven = false;
  if (service.loaded) {
    const oldSources = await findInstances(target, deps);
    const oldPids = uniquePids([
      service.pid,
      // A cleanly stopped manifest can outlive its process long enough for the OS
      // to reuse that pid for unrelated work. It is historical evidence, not an
      // ownership claim, so never wait for its recycled pid during restart.
      ...oldSources
        .filter((source) => source.health !== "stopped")
        .map((source) => source.pid),
    ]);
    // Outside unloadLaunchdService: a deferral is not a failed bootout.
    await options.checkUnattendedActivity?.();
    const mainStopped = await unloadLaunchdService(
      target.label,
      service,
      oldPids,
      deps,
      uid,
      poll,
      beforeMainBootout,
    );
    if (!mainStopped.ok) {
      const restoreFailure = options.preserveMaintenanceService === true
        ? undefined
        : await restoreMaintenanceDefinition(
            maintenanceService.loaded,
            maintenance,
            deps,
            uid,
            poll,
          );
      return {
        ok: false,
        restarted: true,
        failure: restoreFailure === undefined
          ? mainStopped.failure
          : lifecycleFailure(
              mainStopped.failure,
              `scheduled maintenance restoration failed: ${maintenanceErrorMessage(restoreFailure)}`,
            ),
      };
    }
    mainStopProven = true;
  }

  await whileStopped(mainStopProven);

  if (options.preserveMaintenanceService !== true) {
    const maintenanceBooted = await bootstrap(deps.runner, maintenance.plistPath, uid);
    const maintenanceLoaded = await pollUntil(
      deps,
      poll,
      async () => await isLoaded(deps.runner, maintenance.label, uid),
    );
    if (!maintenanceLoaded) {
      return {
        ok: false,
        restarted,
        failure: lifecycleFailure(maintenanceBooted, "scheduled recovery controller did not report loaded"),
      };
    }
  }

  const booted = await bootstrap(deps.runner, target.paths.plistPath, uid);
  if (booted.code === 0 || (await isLoaded(deps.runner, target.label, uid))) {
    return { ok: true, restarted };
  }
  if (options.preserveMaintenanceService === true) {
    return {
      ok: false,
      restarted,
      failure: lifecycleFailure(booted, "main service did not load; scheduled recovery remains loaded for retry"),
    };
  }
  const maintenanceServiceAfterFailure = await launchdServiceInfo(deps.runner, maintenance.label, uid);
  const maintenanceRemoval = await unloadLaunchdService(
    maintenance.label,
    maintenanceServiceAfterFailure,
    uniquePids([maintenanceServiceAfterFailure.pid]),
    deps,
    uid,
    poll,
  );
  return {
    ok: false,
    restarted,
    failure: lifecycleFailure(
      booted,
      maintenanceRemoval.ok
        ? "main service did not load; scheduled maintenance was unloaded"
        : `main service did not load; scheduled maintenance cleanup failed: ${maintenanceErrorMessage(maintenanceRemoval.failure)}`,
    ),
  };
}

function maintenancePathsForTarget(target: BackgroundLifecycleTarget): {
  readonly label: string;
  readonly plistPath: string;
} {
  const label = deriveLaunchdMaintenanceLabel(target.label);
  return { label, plistPath: resolve(target.paths.launchAgentsDir, `${label}.plist`) };
}

async function restoreMaintenanceDefinition(
  wasLoaded: boolean,
  maintenance: { readonly label: string; readonly plistPath: string },
  deps: BackgroundDeps,
  uid: number,
  poll: PollOptions,
): Promise<LaunchctlResult | undefined> {
  if (!wasLoaded) return undefined;
  const restored = await bootstrap(deps.runner, maintenance.plistPath, uid);
  const returned = await pollUntil(
    deps,
    poll,
    async () => await isLoaded(deps.runner, maintenance.label, uid),
  );
  if (returned) return undefined;
  return lifecycleFailure(restored, "scheduled maintenance did not return after the main stop failed");
}

async function findOwnershipConflict(
  target: InstanceTarget,
  deps: BackgroundDeps,
  uid: number,
): Promise<string | undefined> {
  const [service, sources] = await Promise.all([
    launchdServiceInfo(deps.runner, target.label, uid),
    findInstances(target, deps),
  ]);
  const live = sources.filter(
    (source) => source.health !== "stopped" && source.pid !== undefined && deps.isAlive(source.pid),
  );
  if (live.length === 0) return undefined;
  if (!service.loaded || service.pid === undefined || !deps.isAlive(service.pid)) {
    return `live matching trace pid(s) ${live.map((source) => source.pid).join(", ")} are not owned by a live ${target.label} launchd job`;
  }
  const foreign = live.filter((source) => source.pid !== service.pid);
  if (foreign.length > 0) {
    return `live matching trace pid(s) ${foreign.map((source) => source.pid).join(", ")} differ from launchd pid ${service.pid}`;
  }
  return undefined;
}

export async function stopBackground(
  target: InstanceTarget,
  deps: BackgroundDeps,
  poll: PollOptions = DEFAULT_CONTROL_POLL,
): Promise<number> {
  const release = await deps.acquireLifecycleLock(target);
  if (release === undefined) {
    deps.stderr(ui.errorLine(`Another lifecycle command is already active for ${target.label}.`));
    deps.stderr(ui.hint("The LaunchAgent plist was preserved. Wait for that command to finish, then retry."));
    return 1;
  }
  try {
    const code = await stopBackgroundUnlocked(target, deps, poll);
    if (code === 0) await deps.invalidateApprovedSnapshots?.(target);
    return code;
  } finally {
    await release().catch((error: unknown) => {
      deps.stderr(ui.errorLine(
        `Could not release lifecycle lock for ${target.label}: ${error instanceof Error ? error.message : String(error)}`,
      ));
    });
  }
}

async function stopBackgroundUnlocked(
  target: InstanceTarget,
  deps: BackgroundDeps,
  poll: PollOptions,
): Promise<number> {
  let releaseSharedLogLock: (() => Promise<void>) | undefined;
  try {
    releaseSharedLogLock = await acquireSharedLaunchdLogLock(target, deps, "interactive");
  } catch (error) {
    reportLifecycleException(target, deps, "acquire the shared launchd-log mutation lock", error);
    return 1;
  }
  if (releaseSharedLogLock === undefined) {
    deps.stderr(ui.errorLine(
      "Shared launchd-log maintenance is still active for another agent on this account.",
    ));
    return 1;
  }
  try {
    return await stopBackgroundWithSharedLogLock(target, deps, poll);
  } finally {
    await releaseSharedLogLock().catch((error: unknown) => {
      deps.stderr(ui.errorLine(
        `Could not release the shared launchd-log mutation lock for ${target.label}: ${error instanceof Error ? error.message : String(error)}`,
      ));
    });
  }
}

async function stopBackgroundWithSharedLogLock(
  target: InstanceTarget,
  deps: BackgroundDeps,
  poll: PollOptions,
): Promise<number> {
  const uid = deps.getuid();
  const maintenance = maintenancePathsForTarget(target);
  const existing = await findInstances(target, deps);
  const [service, maintenanceService] = await Promise.all([
    launchdServiceInfo(deps.runner, target.label, uid),
    launchdServiceInfo(deps.runner, maintenance.label, uid),
  ]);
  let maintenanceIntent: LaunchdLogMaintenanceIntent | undefined;
  try {
    maintenanceIntent = await deps.readLaunchdLogMaintenanceIntent(target.paths);
  } catch (error) {
    deps.stderr(ui.errorLine(`Failed to inspect pending launchd-log maintenance for ${target.label}.`));
    deps.stderr(ui.style.dim(error instanceof Error ? error.message : String(error)) + "\n");
    return 1;
  }
  if ((maintenanceIntent?.phase === "stopping" || maintenanceIntent?.phase === "restoring") && !service.loaded) {
    deps.stderr(ui.errorLine(
      `Refusing to erase interrupted launchd-log maintenance for ${target.label} without stopped-writer proof.`,
    ));
    deps.stderr(ui.hint("Confirm the prior worker is gone, then restore or remove the owner-private maintenance marker explicitly."));
    return 1;
  }
  const liveTracePids = uniquePids(existing
    .filter((source) => source.health !== "stopped" && source.pid !== undefined && deps.isAlive(source.pid))
    .map((source) => source.pid));
  if (liveTracePids.some((pid) => pid !== service.pid)) {
    deps.stderr(ui.errorLine(
      `Refusing to stop ${target.label}: matching live trace pid(s) ${liveTracePids.join(", ")} are not owned by that launchd job.`,
    ));
    deps.stderr(ui.hint("The LaunchAgent plist was preserved. Stop the unmanaged process explicitly, then retry."));
    return 1;
  }

  const maintenanceStopped = await unloadLaunchdService(
    maintenance.label,
    maintenanceService,
    uniquePids([maintenanceService.pid]),
    deps,
    uid,
    poll,
  );
  if (!maintenanceStopped.ok) {
    deps.stderr(ui.errorLine(`Failed to stop scheduled log maintenance for ${target.label}.`));
    const detail = (maintenanceStopped.failure.stderr || maintenanceStopped.failure.stdout).trim();
    if (detail.length > 0) deps.stderr(ui.style.dim(detail) + "\n");
    deps.stderr(ui.hint("Both LaunchAgent plists were preserved. Retry stop after the maintenance helper exits."));
    return 1;
  }

  const ownedPids = uniquePids([service.pid, ...liveTracePids]);
  const mainStopped = await unloadLaunchdService(
    target.label,
    service,
    ownedPids,
    deps,
    uid,
    poll,
    async () => {
      const stoppedIntent = maintenanceIntent;
      if (stoppedIntent?.phase === "stopped") {
        maintenanceIntent = await deps.markLaunchdLogMaintenanceStopping(target.paths, stoppedIntent);
      }
    },
  );
  if (!mainStopped.ok) {
    const result = mainStopped.failure;
    const maintenanceRestoreFailure = await restoreMaintenanceDefinition(
      maintenanceService.loaded,
      maintenance,
      deps,
      uid,
      poll,
    );
    deps.stderr(ui.errorLine(
      `Failed to prove ${target.label} stopped${result?.code === undefined || result.code === 0 ? "" : ` (launchctl bootout exited ${result.code})`}.`,
    ));
    const detail = (result?.stderr || result?.stdout || "").trim();
    if (detail.length > 0) {
      deps.stderr(ui.style.dim(detail) + "\n");
    }
    if (maintenanceRestoreFailure !== undefined) {
      deps.stderr(ui.style.yellow(
        `Scheduled log maintenance also could not be restored: ${maintenanceErrorMessage(maintenanceRestoreFailure)}`,
      ) + "\n");
    }
    deps.stderr(ui.hint("Both LaunchAgent plists were preserved so the service remains recoverable. Inspect status/logs and retry."));
    return 1;
  }

  try {
    // Explicit stop cancels any interrupted maintainer's restore authority
    // only after both jobs and every observed pid are proven gone.
    if (maintenanceIntent?.phase === "stopping" || maintenanceIntent?.phase === "restoring") {
      maintenanceIntent = await deps.markLaunchdLogMaintenanceStopped(target.paths, maintenanceIntent);
    }
    await deps.clearLaunchdLogMaintenanceIntent(target.paths, maintenanceIntent);
    await deps.removeLaunchdLogMonitorStatus?.(target);
    await clearLaunchdSnapshotRefusal(target.label, target.paths);
  } catch (error) {
    deps.stderr(ui.errorLine(`Failed to clear pending launchd-log state for ${target.label}.`));
    deps.stderr(ui.style.dim(error instanceof Error ? error.message : String(error)) + "\n");
    deps.stderr(ui.hint("Both LaunchAgent plists were preserved; retry stop after the owner-private marker is inspectable."));
    return 1;
  }

  // Remove both definitions only after the helper and worker are unloaded and
  // every observed PID is dead. The helper can never resurrect a stopped job.
  await deps.rm(maintenance.plistPath);
  await deps.rm(target.paths.plistPath);
  for (const source of existing) await maybeUnlinkDeadManifest(target, deps, source);

  deps.stdout(
    service.loaded
      ? `${ui.badge("ok")}${ui.style.bold(`Stopped ${target.label}`)} and removed its LaunchAgent.\n`
      : `${ui.style.dim(`${target.label} was not running; removed its LaunchAgent if present.`)}\n`,
  );
  deps.stdout(ui.keyValue([["config", target.configPath]]));
  return 0;
}

export async function tailLogs(target: InstanceTarget, deps: BackgroundDeps, options: LogOptions): Promise<number> {
  const args = [
    "-n",
    String(options.lines),
    ...(options.follow ? ["-F"] : []),
    target.paths.stderrPath,
    target.paths.stdoutPath,
  ];
  return await deps.spawnTail(args);
}

export async function pollInstanceReady(
  target: InstanceTarget,
  deps: BackgroundDeps,
  options: ReadyPollOptions,
): Promise<TraceSourceListItem | undefined> {
  const deadline = deps.now() + options.timeoutMs;
  for (;;) {
    const service = await launchdServiceInfo(deps.runner, target.label, deps.getuid());
    if (service.loaded && service.pid !== undefined && deps.isAlive(service.pid)) {
      const matches = await findInstances(target, deps);
      const match = matches.find((source) => source.pid === service.pid);
      if (match !== undefined
        && isReady(match)
        && startedAtMs(match) >= options.sinceMs
        && snapshotMetadataMatches(match, target.expectedSnapshot)
        && await snapshotStillMatches(target, deps)) {
        return match;
      }
    }
    if (deps.now() >= deadline) {
      return undefined;
    }
    await deps.sleep(options.intervalMs);
  }
}

async function snapshotStillMatches(target: InstanceTarget, deps: BackgroundDeps): Promise<boolean> {
  if (target.expectedSnapshot === undefined) return true;
  const capture = deps.captureSnapshot ?? captureTargetSnapshot;
  try {
    return sameBackgroundSnapshot(await capture(target), target.expectedSnapshot);
  } catch {
    return false;
  }
}

async function captureTargetSnapshot(target: InstanceTarget): Promise<BackgroundSnapshot> {
  return await captureBackgroundSnapshot({
    cwd: target.cwd,
    configPath: target.configPath,
    ...(target.envFile === undefined ? {} : { envFile: target.envFile }),
    env: target.configurationEnvironment,
  });
}

function snapshotMetadataMatches(
  source: TraceSourceListItem,
  expected: BackgroundSnapshot | undefined,
): boolean {
  if (expected === undefined) return true;
  const actual = backgroundSnapshotFromMetadata(source.metadata);
  return actual !== undefined && sameBackgroundSnapshot(actual, expected);
}

async function maybeUnlinkDeadManifest(
  target: InstanceTarget,
  deps: BackgroundDeps,
  existing: TraceSourceListItem | undefined,
): Promise<void> {
  // Only clean up a manifest whose process is already gone; a worker that is
  // still shutting down will mark its own manifest stopped.
  if (existing?.pid === undefined || deps.isAlive(existing.pid)) {
    return;
  }
  await deps.rm(resolve(target.registryDir, `${existing.sourceId}.json`));
}

async function cleanUpUnreadyBackground(
  target: InstanceTarget,
  deps: BackgroundDeps,
  poll: PollOptions,
  options: BackgroundReadyInternalOptions = {},
): Promise<boolean> {
  try {
    if (options.preserveDefinitionsOnFailure === true) {
      const uid = deps.getuid();
      const [service, sources] = await Promise.all([
        launchdServiceInfo(deps.runner, target.label, uid),
        findInstances(target, deps),
      ]);
      const liveTracePids = uniquePids(sources
        .filter((source) => source.health !== "stopped"
          && source.pid !== undefined
          && deps.isAlive(source.pid))
        .map((source) => source.pid));
      if (liveTracePids.some((pid) => pid !== service.pid)) return false;
      const stopped = await unloadLaunchdService(
        target.label,
        service,
        uniquePids([service.pid, ...liveTracePids]),
        deps,
        uid,
        poll,
      );
      return stopped.ok;
    }
    return await stopBackgroundUnlocked(target, { ...deps, stdout: () => undefined }, poll) === 0;
  } catch (error) {
    deps.stderr(ui.errorLine(
      `Failed while trying to stop the unready LaunchAgent: ${error instanceof Error ? error.message : String(error)}`,
    ));
    return false;
  }
}
