import type { listRecordedRuns, listTraceSources, TraceSourceListItem } from "@mono-agent/observability";

import type { ApprovedBackgroundSnapshotBinding } from "./approved-background-snapshot.js";
import type { MaintenanceActivityRequest } from "../launchd/launchd-maintenance-activity.js";
import type { LaunchctlResult, LaunchctlRunner, LaunchdPaths } from "../launchd/launchd.js";
import type { LaunchdLogInspection, LaunchdLogMaintenanceIntent } from "../launchd/launchd-logs.js";
import type {
  ManagedBackgroundRuntime,
  ManagedBackgroundRuntimeInput,
  ManagedRuntimeAdditionalPackage,
  ManagedRuntimeLaunchVerification,
  ManagedRuntimeSourceIdentity,
} from "../managed-runtime/types.js";
import type { BackgroundSnapshot } from "./background-snapshot.js";
import type { OwnerPrivateLock } from "../../durable-state/owner-private-lock.js";
import type {
  BackgroundLifecycleTarget,
  BackgroundLockAcquireOptions,
} from "../launchd/launchd-lifecycle-lock.js";
import type { PollOptions } from "./background-lifecycle-utils.js";

/**
 * Background-service orchestration for the mono-agent CLI. The interactive
 * control commands never talk to the worker directly: they derive a stable
 * launchd label + the trace-source registry location from the resolved config
 * path, drive `launchctl`, and read the worker's published manifest to learn
 * when it is up and what to print.
 */

export interface BackgroundCliArgs {
  readonly configPath?: string;
  readonly envFile?: string;
}

export interface InstanceTarget {
  readonly cwd: string;
  readonly configPath: string;
  readonly label: string;
  readonly registryDir: string;
  /**
   * Machine-wide registry that holds the worker's best-effort manifest mirror
   * when `registryDir` differs from it. A relative `traceability.registryDir`
   * is resolved against the caller's cwd, so a control command run outside the
   * agent folder finds the worker only through this mirror. Read by
   * `status` only; lifecycle commands never act on mirror entries.
   */
  readonly mirrorRegistryDir?: string;
  readonly staleAfterMs: number;
  readonly paths: LaunchdPaths;
  readonly nodePath: string;
  readonly cliPath: string;
  /** Mutable controller CLI retained only as inert runtime-installation input. */
  readonly controllerCliPath?: string;
  readonly envFile?: string;
  /**
   * Transient effective config environment reconstructed by the controller.
   * It may contain secrets: never serialize, log, or materialize it in launchd.
   */
  readonly configurationEnvironment: Readonly<Record<string, string | undefined>>;
  readonly environment: Readonly<Record<string, string>>;
  /** Exact wizard/approval snapshot this launch is allowed to claim ready. */
  readonly expectedSnapshot?: BackgroundSnapshot;
  /** Opaque proof that the selected managed runtime was finalized and verified. */
  readonly managedRuntimeLaunchProof?: string;
}

export interface ResolveInstanceTargetInput {
  readonly args: BackgroundCliArgs;
  readonly env: Record<string, string | undefined>;
  readonly cwd: string;
  /** Absolute path to the running cli.js, baked into the plist. */
  readonly cliPath: string;
}

export interface BackgroundDeps {
  readonly maintenanceNotNeeded?: () => Promise<void>;
  readonly maintenanceCompleted?: () => Promise<void>;
  readonly clearMaintenanceDeferral?: (target: BackgroundLifecycleTarget) => Promise<void>;
  readonly unattendedLogStop?: (request: MaintenanceActivityRequest) => Promise<boolean>;
  readonly allowUnattendedStop?: (target: BackgroundLifecycleTarget, request: MaintenanceActivityRequest) => Promise<boolean>;
  readonly runner: LaunchctlRunner;
  readonly getuid: () => number;
  readonly currentPid: () => number;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly listRecordedRuns: typeof listRecordedRuns;
  readonly listTraceSources: typeof listTraceSources;
  readonly writeFile: (path: string, data: string) => Promise<void>;
  readonly mkdir: (path: string) => Promise<void>;
  readonly rm: (path: string) => Promise<void>;
  readonly inspectLaunchdLogs: (
    paths: Pick<LaunchdPaths, "logDir" | "stdoutPath" | "stderrPath">,
  ) => Promise<LaunchdLogInspection>;
  readonly rotateStoppedLaunchdLogs: (
    paths: Pick<LaunchdPaths, "logDir" | "stdoutPath" | "stderrPath">,
  ) => Promise<void>;
  readonly readLaunchdLogMaintenanceIntent: (
    paths: Pick<LaunchdPaths, "logDir" | "stdoutPath" | "stderrPath">,
  ) => Promise<LaunchdLogMaintenanceIntent | undefined>;
  readonly beginLaunchdLogMaintenanceIntent: (
    paths: Pick<LaunchdPaths, "logDir" | "stdoutPath" | "stderrPath">,
    intent: LaunchdLogMaintenanceIntent,
  ) => Promise<void>;
  readonly markLaunchdLogMaintenanceStopped: (
    paths: Pick<LaunchdPaths, "logDir" | "stdoutPath" | "stderrPath">,
    expected: LaunchdLogMaintenanceIntent,
  ) => Promise<LaunchdLogMaintenanceIntent>;
  readonly markLaunchdLogMaintenanceRestoring: (
    paths: Pick<LaunchdPaths, "logDir" | "stdoutPath" | "stderrPath">,
    expected: LaunchdLogMaintenanceIntent,
  ) => Promise<LaunchdLogMaintenanceIntent>;
  readonly markLaunchdLogMaintenanceStopping: (
    paths: Pick<LaunchdPaths, "logDir" | "stdoutPath" | "stderrPath">,
    expected: LaunchdLogMaintenanceIntent,
  ) => Promise<LaunchdLogMaintenanceIntent>;
  readonly clearLaunchdLogMaintenanceIntent: (
    paths: Pick<LaunchdPaths, "logDir" | "stdoutPath" | "stderrPath">,
    expected?: LaunchdLogMaintenanceIntent,
  ) => Promise<void>;
  readonly removeLaunchdLogMonitorStatus?: (target: BackgroundLifecycleTarget) => Promise<void>;
  /** Read and fingerprint the exact owner-private plist without mutating it. */
  readonly verifyLaunchdPlist: (path: string) => Promise<string>;
  /** True when a pid is still alive (or alive but owned by another user). */
  readonly isAlive: (pid: number) => boolean;
  /** Install/verify an immutable CLI outside npm/npx's disposable cache. */
  readonly ensureManagedRuntime: (input: ManagedBackgroundRuntimeInput) => Promise<ManagedBackgroundRuntime>;
  /** Inspect mutable source as inert bytes; never execute it. */
  readonly inspectManagedRuntimeSourceIdentity: (cliPath: string) => Promise<ManagedRuntimeSourceIdentity>;
  /** Verify the exact private closure and proof persisted in the loaded worker. */
  readonly verifyManagedRuntimeLaunch: (
    input: { readonly currentCliPath: string; readonly launchProof: string },
  ) => Promise<ManagedRuntimeLaunchVerification>;
  /** Resolve config-selected plugin-tier packages before the disposable source can disappear. */
  readonly resolveManagedRuntimePackages?: (
    target: InstanceTarget,
  ) => Promise<readonly ManagedRuntimeAdditionalPackage[]>;
  /** Fail closed when another lifecycle command owns this config label. */
  readonly acquireLifecycleLock: (
    target: BackgroundLifecycleTarget,
    options?: BackgroundLockAcquireOptions,
  ) => Promise<(() => Promise<void>) | undefined>;
  /** Hold KeepAlive respawns until the replacement runtime and plist are committed. */
  readonly acquireRuntimePublicationBarrier?: (target: BackgroundLifecycleTarget) => Promise<OwnerPrivateLock | undefined>;
  readonly resolveApprovedSnapshot?: (binding: ApprovedBackgroundSnapshotBinding) => BackgroundSnapshot;
  readonly invalidateApprovedSnapshots?: (target: BackgroundLifecycleTarget) => Promise<void>;
  readonly captureSnapshot?: (target: InstanceTarget) => Promise<BackgroundSnapshot>;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  /** Run `tail` with inherited stdio; resolves with its exit code. */
  readonly spawnTail: (args: readonly string[]) => Promise<number>;
}

export interface ReadyPollOptions extends PollOptions {
  /** Only accept a worker that started at or after this time (restart safety). */
  readonly sinceMs: number;
}

export type BackgroundLaunchAction = "started" | "restarted";

export type BackgroundLaunchResult =
  | {
      readonly ok: true;
      readonly action: BackgroundLaunchAction;
      /** The fresh, authoritative worker trace that proved startup complete. */
      readonly source: TraceSourceListItem;
    }
  | {
      readonly ok: false;
      readonly action: "start" | "restart";
      readonly reason: "runtime" | "snapshot" | "preparation" | "ownership" | "deferred-busy" | "shared-contention" | "launchctl" | "readiness" | "timeout";
    };

export interface LaunchdControllerOptions {
  /** False only when the originally installed controller checkout disappeared. */
  readonly sourceAvailable: boolean;
  readonly controlPoll?: PollOptions;
  readonly readinessPoll?: PollOptions;
  /** Full structural validation, invoked only after fast proof identifies recovery work. */
  readonly recoveryPreflight?: () => Promise<number>;
}

export interface BackgroundReadyInternalOptions {
  readonly unattendedMaintenance?: MaintenanceActivityRequest;
  /** Recovery helpers cannot boot out and wait for their own launchd process. */
  readonly preserveMaintenanceService?: boolean;
  /** Scheduled recovery keeps both definitions so the calendar schedule can retry. */
  readonly preserveDefinitionsOnFailure?: boolean;
  /** Helpers defer immediately; interactive lifecycle commands wait visibly. */
  readonly sharedLockMode?: "automatic" | "interactive";
}

export type LaunchOutcome =
  | { readonly ok: true; readonly restarted: boolean }
  | { readonly ok: false; readonly restarted: boolean; readonly failure: LaunchctlResult };

export interface StatusBackgroundOptions {
  readonly json?: boolean;
}

export interface LogOptions {
  readonly follow: boolean;
  readonly lines: number;
}
