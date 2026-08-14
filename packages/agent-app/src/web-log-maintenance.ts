import { fileURLToPath } from "node:url";

import {
  acquireFilesystemLifecycleLock,
  defaultBackgroundDeps,
  inspectOwnerPrivateLaunchdPlist,
  readOwnerPrivateLaunchdPlist,
} from "./background.js";
import type { BackgroundLifecycleTarget } from "./background.js";
import {
  maintainLaunchdLogsWithSharedLockOperation,
} from "./background-log-maintenance.js";
import type {
  LaunchdLogMaintenanceDeps,
} from "./background-log-maintenance.js";
import {
  buildWebMaintenancePlistXml,
  launchdServiceInfo,
  launchdWebMaintenanceInfo,
  WEB_LAUNCHD_LABEL,
  WEB_MAINTENANCE_LAUNCHD_LABEL,
  webMaintenanceCalendarMinute,
} from "./launchd.js";
import type { LaunchctlRunner } from "./launchd.js";
import type { LaunchdWebMaintenanceInfo } from "./launchd.js";
import {
  inspectLegacyManagedWebLogArtifacts,
  maintainLegacyManagedWebLogArtifacts,
} from "./managed-web-logs.js";
import { managedWebLogMaintenanceEnvironment } from "./managed-web-maintenance-environment.js";
import { verifyManagedRuntimeMaintenanceEntrypoint } from "./managed-runtime-maintenance-entry.js";
import { managedWebPaths } from "./web-maintenance-paths.js";
import type { WebLogMaintenanceCommandArgs } from "./web-log-maintenance-command.js";
import {
  writeWebLogMaintenanceStatus,
} from "./web-log-maintenance-status.js";
import type {
  WebLogMaintenancePhase,
  WebLogMaintenanceStatus,
} from "./web-log-maintenance-status.js";

const MAINTENANCE_POLL = { timeoutMs: 15_000, intervalMs: 200 } as const;

export interface WebLogMaintenanceDependencies {
  readonly platform?: NodeJS.Platform;
  readonly runner?: LaunchctlRunner;
  readonly getuid?: () => number;
  readonly currentPid?: () => number;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly isAlive?: (pid: number) => boolean;
  readonly homeDir?: string;
  readonly currentEntrypointPath?: string;
  readonly inspectHelperService?: (
    runner: LaunchctlRunner,
    uid: number,
  ) => Promise<LaunchdWebMaintenanceInfo>;
  readonly verifyEntrypoint?: typeof verifyManagedRuntimeMaintenanceEntrypoint;
  readonly readPlist?: typeof readOwnerPrivateLaunchdPlist;
  readonly verifyPlist?: typeof inspectOwnerPrivateLaunchdPlist;
  readonly acquireLifecycleLock?: (
    target: BackgroundLifecycleTarget,
  ) => Promise<(() => Promise<void>) | undefined>;
  readonly maintenanceDeps?: LaunchdLogMaintenanceDeps;
  readonly writeStatus?: (path: string, status: WebLogMaintenanceStatus) => Promise<void>;
}

/**
 * Authenticate the helper and paired main plist, then run the shared stopped-
 * writer protocol while holding only the web lifecycle lock.
 */
export async function runWebLogMaintenanceCommand(
  args: WebLogMaintenanceCommandArgs,
  deps: WebLogMaintenanceDependencies = {},
): Promise<number> {
  if ((deps.platform ?? process.platform) !== "darwin") return 1;
  const background = defaultBackgroundDeps();
  const runner = deps.runner ?? background.runner;
  const getuid = deps.getuid ?? background.getuid;
  const currentPid = deps.currentPid ?? (() => process.pid);
  const now = deps.now ?? background.now;
  const sleep = deps.sleep ?? background.sleep;
  const isAlive = deps.isAlive ?? background.isAlive;
  const paths = managedWebPaths(deps.homeDir);
  const target: BackgroundLifecycleTarget = { label: WEB_LAUNCHD_LABEL, paths: paths.launchd };
  const currentEntrypointPath = deps.currentEntrypointPath
    ?? fileURLToPath(new URL("./launchd-maintenance-entry.js", import.meta.url));
  const verifyEntrypoint = deps.verifyEntrypoint ?? verifyManagedRuntimeMaintenanceEntrypoint;
  const readPlist = deps.readPlist ?? readOwnerPrivateLaunchdPlist;
  const verifyPlist = deps.verifyPlist ?? inspectOwnerPrivateLaunchdPlist;
  const writeStatus = deps.writeStatus ?? writeWebLogMaintenanceStatus;
  const inspectHelperService = deps.inspectHelperService ?? launchdWebMaintenanceInfo;
  let authenticated = false;
  let release: (() => Promise<void>) | undefined;
  let phase: WebLogMaintenancePhase = "authenticating";
  let lastError = "";
  let refusals: readonly string[] = [];
  const status = async (
    state: WebLogMaintenanceStatus["state"],
    detail?: string,
  ): Promise<void> => {
    await writeStatus(paths.maintenanceStatusPath, {
      version: 1,
      state,
      phase,
      updatedAt: new Date(now()).toISOString(),
      ...(detail === undefined || detail.length === 0 ? {} : { detail }),
      ...(refusals.length === 0 ? {} : { refusals }),
    });
  };
  const authenticate = async (): Promise<void> => {
    await verifyEntrypoint({
      currentEntrypointPath,
      launchProof: args.expectedManagedRuntimeLaunch,
    });
    const helper = await inspectHelperService(runner, getuid());
    if (!helper.loaded || helper.pid !== currentPid() || !isAlive(currentPid())) {
      throw new Error("The private web-maintenance process is not launchd's exact live helper PID.");
    }
    const definition = helper.definition;
    if (definition === undefined
      || definition.plistPath !== paths.maintenancePlistPath
      || definition.nodePath !== process.execPath
      || definition.cliPath !== currentEntrypointPath
      || definition.cwd !== paths.stateDir
      || definition.expectedManagedRuntimeLaunch !== args.expectedManagedRuntimeLaunch
      || definition.expectedWebPlistIdentity !== args.expectedWebPlistIdentity) {
      throw new Error("launchd's cached web-maintenance helper definition is stale or invalid.");
    }
    const helperPlist = await readPlist(paths.maintenancePlistPath);
    const expectedHelper = buildWebMaintenancePlistXml({
      label: WEB_MAINTENANCE_LAUNCHD_LABEL,
      nodePath: process.execPath,
      cliPath: currentEntrypointPath,
      cwd: paths.stateDir,
      expectedManagedRuntimeLaunch: args.expectedManagedRuntimeLaunch,
      expectedWebPlistIdentity: args.expectedWebPlistIdentity,
      environment: managedWebLogMaintenanceEnvironment(),
      calendarMinute: webMaintenanceCalendarMinute(),
    });
    if (helperPlist.contents !== expectedHelper) {
      throw new Error("The loaded web-maintenance helper does not match its exact owner-private definition.");
    }
    const mainIdentity = await verifyPlist(paths.launchd.plistPath);
    if (mainIdentity !== args.expectedWebPlistIdentity) {
      throw new Error("The main web LaunchAgent identity does not match the helper's composite identity.");
    }
  };

  try {
    await authenticate();
    authenticated = true;
    release = await (deps.acquireLifecycleLock ?? acquireFilesystemLifecycleLock)(target);
    if (release === undefined) {
      // A lifecycle owner is already doing the authoritative work. Preserve the
      // prior durable result: a clean deferral must never erase a real failure.
      return 0;
    }
    // Re-authenticate after lock acquisition so lock waiting cannot preserve
    // stale helper or main-plist authority.
    await authenticate();
    await status("running");

    const maintenanceDeps: LaunchdLogMaintenanceDeps = {
      ...(deps.maintenanceDeps ?? background),
      runner,
      getuid,
      now,
      sleep,
      isAlive,
      inspectAdditionalLaunchdLogArtifacts:
        deps.maintenanceDeps?.inspectAdditionalLaunchdLogArtifacts
        ?? inspectLegacyManagedWebLogArtifacts,
      maintainAdditionalLaunchdLogArtifacts:
        deps.maintenanceDeps?.maintainAdditionalLaunchdLogArtifacts
        ?? maintainLegacyManagedWebLogArtifacts,
      recordAdditionalLaunchdLogRefusals: async (items) => {
        refusals = [...items];
        await status("running");
      },
      recordMaintenancePhase: async (nextPhase) => {
        phase = nextPhase;
        await status("running");
      },
      stderr: (text) => {
        if (lastError.length === 0) lastError = safeDetail(text);
      },
    };
    // Web intentionally holds no shared agent log lock: its log directory is
    // outside the shared ~/.mono-agent/logs agent chain.
    const result = await maintainLaunchdLogsWithSharedLockOperation(
      target,
      maintenanceDeps,
      MAINTENANCE_POLL,
    );
    const mainIdentity = await verifyPlist(paths.launchd.plistPath);
    if (mainIdentity !== args.expectedWebPlistIdentity) {
      throw new Error("The main web LaunchAgent identity changed during maintenance.");
    }
    phase = "complete";
    if (result === 0) {
      await status("success");
      return 0;
    }
    await status(refusals.length > 0 ? "degraded" : "failed", lastError || "Web log maintenance did not complete.");
    return 1;
  } catch (error) {
    if (authenticated) {
      lastError = safeDetail(error);
      await status("failed", lastError).catch(() => undefined);
    }
    return 1;
  } finally {
    await release?.().catch(async (error: unknown) => {
      if (authenticated) await status("failed", `Could not release the web lifecycle lock: ${safeDetail(error)}`).catch(() => undefined);
    });
  }
}

function safeDetail(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/[\u0000-\u001f\u007f]+/gu, " ")
    .replace(/\b(token|secret|password|api[-_]?key|authorization)\s*[=:]\s*\S+/giu, "$1=<redacted>")
    .replace(/\bBearer\s+\S+/giu, "Bearer <redacted>")
    .replace(/(?:\/[A-Za-z0-9._~!$&'()+,;=:@%-]+){2,}/gu, "<path>")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 512);
}
