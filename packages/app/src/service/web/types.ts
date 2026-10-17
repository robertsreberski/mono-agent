import type { WebTheme } from "@mono-agent/web";

import type { ManagedBackgroundRuntimeInput } from "../managed-runtime/types.js";
import type { LaunchctlRunner, LaunchdPaths, LaunchdWebMaintenanceInfo } from "../../launchd.js";
import type { ManagedWebLogMonitorDependencies } from "../../managed-web-logs.js";
import type { verifyManagedRuntimeMaintenanceEntrypoint } from "../../managed-runtime-maintenance-entry.js";
import type { ManagedWebPaths } from "../../web-maintenance-paths.js";
export interface RunWebCommandOptions {
  readonly positionals: readonly string[];
  readonly env: Record<string, string | undefined>;
  readonly host?: string;
  readonly port?: number;
  readonly theme?: string;
  readonly name?: string;
  readonly loopback?: boolean;
  readonly shareTailnet?: boolean;
  readonly json?: boolean;
  readonly follow?: boolean;
  readonly lines?: number;
  readonly all?: boolean;
  readonly yes?: boolean;
}
export const WEB_SERVICE_SCHEMA = "mono-agent.web-service.v1";
export const TAILSCALE_OWNERSHIP_SCHEMA = "mono-agent.web-tailscale-serve.v1";

export interface WebServerHandle {
  readonly url: string;
  readonly host?: string;
  readonly port?: number;
  readonly boundAddress?: string;
  stop(): Promise<void>;
}

export interface StartWebServerOptions {
  readonly host?: string;
  readonly port?: number;
  readonly theme?: WebTheme;
  readonly name?: string;
  readonly registryDirs?: readonly string[];
  readonly stateDir?: string;
  readonly env?: Record<string, string | undefined>;
}

export interface ResetWebStateOptions {
  readonly stateDir?: string;
  readonly env?: Record<string, string | undefined>;
}

export interface PrepareWebStateOptions {
  readonly stateDir?: string;
  readonly env?: Record<string, string | undefined>;
}

export interface CommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type CommandRunner = (args: readonly string[]) => Promise<CommandResult>;

export interface ManagedRuntimeResult {
  readonly cliPath: string;
  readonly nodePath: string;
  readonly launchProof: string;
}

export interface RunWebCommandDeps {
  readonly platform?: NodeJS.Platform;
  readonly getuid?: () => number;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly stdout?: { write(text: string): void };
  readonly stderr?: { write(text: string): void };
  readonly launchctl?: LaunchctlRunner;
  readonly tailscale?: CommandRunner;
  readonly startServer?: (options: StartWebServerOptions) => Promise<WebServerHandle>;
  readonly resetState?: (options: ResetWebStateOptions) => Promise<void>;
  readonly prepareState?: (options: PrepareWebStateOptions) => Promise<void>;
  readonly waitForShutdown?: () => Promise<void>;
  readonly healthcheck?: (url: string) => Promise<boolean>;
  readonly isAlive?: (pid: number) => boolean;
  readonly ensureManagedRuntime?: (input: ManagedBackgroundRuntimeInput) => Promise<ManagedRuntimeResult>;
  readonly verifyMaintenanceEntrypoint?: typeof verifyManagedRuntimeMaintenanceEntrypoint;
  readonly inspectMaintenanceService?: (
    runner: LaunchctlRunner,
    uid: number,
  ) => Promise<LaunchdWebMaintenanceInfo>;
  readonly spawnTail?: (args: readonly string[]) => Promise<number>;
  readonly writePrivateFile?: (path: string, contents: string) => Promise<void>;
  readonly acquireLifecycleLock?: (paths: ManagedWebPaths) => Promise<(() => Promise<void>) | undefined>;
  readonly discoverNetworkAddresses?: () => readonly string[];
  readonly startManagedLogMonitor?: (
    paths: Pick<LaunchdPaths, "logDir" | "stdoutPath" | "stderrPath">,
    dependencies: ManagedWebLogMonitorDependencies,
  ) => { stop(): void };
  readonly homeDir?: string;
  readonly systemd?: import("../../systemd.js").SystemdDeps;
}

export interface WebServiceRecord {
  readonly schema: typeof WEB_SERVICE_SCHEMA;
  readonly host: string;
  readonly port: number;
  /** Optional only so pre-theme v1 records remain readable during upgrade. */
  readonly theme?: WebTheme;
  /** Absent means the console labels itself with the machine hostname. */
  readonly name?: string;
  readonly updatedAt: string;
}

export interface PreviousWebServiceSnapshot {
  readonly plist: string;
  readonly helperInputs?: WebMaintenancePublicationInputs;
  readonly recordText?: string;
  readonly record?: WebServiceRecord;
}

export interface WebPublicationSnapshot {
  readonly plist?: string;
  readonly helperInputs?: WebMaintenancePublicationInputs;
  readonly recordText?: string;
}

export interface WebMaintenancePublicationInputs {
  readonly nodePath: string;
  readonly cliPath: string;
  readonly cwd: string;
  readonly expectedManagedRuntimeLaunch: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly calendarMinute: number;
}

export type WebServiceRecordRead =
  | { readonly kind: "absent" }
  | { readonly kind: "valid"; readonly record: WebServiceRecord; readonly contents: string }
  | { readonly kind: "invalid"; readonly detail: string };

export interface TailscaleServeOwnership {
  readonly schema: typeof TAILSCALE_OWNERSHIP_SCHEMA;
  readonly webKey: string;
  readonly httpsPort: number;
  readonly proxyTarget: string;
  /** Exact canonical TCP + Web handler config owned at publication time. */
  readonly configSha256: string;
  readonly url: string;
  readonly configuredAt: string;
}

export type TailscaleServeResult =
  | { readonly kind: "active"; readonly ownership: TailscaleServeOwnership; readonly reused: boolean }
  | {
      /** No owned route exists and none was requested; no Tailscale command was run. */
      readonly kind: "not-requested";
    }
  | {
      readonly kind: "unavailable";
      readonly detail: string;
      /** The old owned route was migrated, so the replacement worker must also be rolled back. */
      readonly requiresServiceRollback?: true;
      /**
       * Structured cleanup evidence for explicit-share failures; never derived
       * by parsing `detail`. `none` means this command ran no route-changing
       * command, `rolled-back` means the newly created handler was removed
       * again, `restored` means a migrated prior handler was put back, and
       * `uncertain` means a handler may remain and must be inspected.
       */
      readonly routeOutcome?: TailscaleRouteOutcome;
      /** What the command attempted, for inspection guidance when cleanup is uncertain. */
      readonly attempted?: {
        readonly httpsPort?: number;
        readonly proxyTarget?: string;
      };
      /** Present after a migrated route: whether the prior exact route is live again. */
      readonly priorRouteRestored?: boolean;
      /** Present after a migrated route: whether the replacement handler was provably removed. */
      readonly replacementHandlerRemoved?: boolean;
    };

type TailscaleRouteOutcome = "none" | "rolled-back" | "restored" | "uncertain";

export interface TailscaleCleanupResult {
  readonly ok: boolean;
  readonly detail: string;
}

export type TailscaleOwnershipRead =
  | { readonly kind: "absent" }
  | { readonly kind: "valid"; readonly ownership: TailscaleServeOwnership; readonly contents: string }
  | { readonly kind: "invalid"; readonly detail: string };

export type OwnedRouteInspection =
  | { readonly kind: "exact" }
  | { readonly kind: "absent" }
  | { readonly kind: "changed" }
  | { readonly kind: "unavailable"; readonly detail: string };

export type TailscaleStatusRead =
  | { readonly kind: "ok"; readonly status: Record<string, unknown> }
  | { readonly kind: "error"; readonly detail: string };
