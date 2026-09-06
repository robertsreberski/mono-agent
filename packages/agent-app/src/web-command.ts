import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { networkInterfaces } from "node:os";
import { readFile, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { pruneTraceSources } from "@mono-agent/observability";
import { isLoopbackHost } from "@mono-agent/agent-contracts";
import type { WebTheme } from "@mono-agent/web";

import { resolveGlobalTraceRegistryDir } from "./app-config.js";
import {
  acquireFilesystemLifecycleLock,
  ensureOwnerPrivateLaunchdDirectory,
  inspectOwnerPrivateLaunchdPlist,
  readOwnerPrivateLaunchdPlist,
  writeOwnerPrivateLaunchdFile,
} from "./background.js";
import { selectBackgroundOperationalEnvironment } from "./background-environment.js";
import { ensureManagedBackgroundRuntime } from "./background-runtime.js";
import {
  bootout,
  bootstrap,
  buildEnvironmentArguments,
  buildWebMaintenancePlistXml,
  buildWebPlistXml,
  defaultPathEnv,
  INTERNAL_WEB_LOG_MAINTENANCE_COMMAND,
  launchdMaintenanceEntrypointPathForCli,
  launchdServiceInfo,
  launchdWebMaintenanceInfo,
  makeLaunchctlRunner,
  WEB_LAUNCHD_LABEL,
  WEB_MAINTENANCE_LAUNCHD_LABEL,
  webMaintenanceCalendarMinute,
} from "./launchd.js";
import type {
  LaunchctlRunner,
  LaunchdPaths,
  LaunchdServiceInfo,
  LaunchdWebMaintenanceDefinition,
  LaunchdWebMaintenanceInfo,
} from "./launchd.js";
import {
  beginLaunchdLogMaintenanceIntent,
  clearLaunchdLogMaintenanceIntent,
  inspectLaunchdLogs,
  markLaunchdLogMaintenanceRestoring,
  markLaunchdLogMaintenanceStopped,
  readLaunchdLogMaintenanceIntent,
  rotateStoppedLaunchdLogs,
} from "./launchd-logs.js";
import {
  inspectLegacyManagedWebLogArtifacts,
  maintainLegacyManagedWebLogArtifacts,
  startManagedWebLogMonitor,
} from "./managed-web-logs.js";
import type { ManagedWebLogMonitorDependencies } from "./managed-web-logs.js";
import { managedWebLogMaintenanceEnvironment } from "./managed-web-maintenance-environment.js";
import { hasCompletedManagedStartup } from "./managed-startup.js";
import { verifyManagedRuntimeMaintenanceEntrypoint } from "./managed-runtime-maintenance-entry.js";
import { managedWebPaths } from "./web-maintenance-paths.js";
import type { ManagedWebPaths } from "./web-maintenance-paths.js";
import {
  readWebLogMaintenanceStatus,
  readWebLogMonitorStatus,
  writeWebLogMaintenanceStatus,
  writeWebLogMonitorStatus,
} from "./web-log-maintenance-status.js";
import * as ui from "./ui.js";

export { WEB_LAUNCHD_LABEL } from "./launchd.js";

export const DEFAULT_WEB_HOST = "0.0.0.0";
export const DEFAULT_WEB_PORT = 5050;
// Deliberately outside `com.mono-agent.*`: fleet discovery reserves that prefix
// for configured agent instances.
export const MANAGED_WEB_WORKER_ENV = "MONO_AGENT_MANAGED_WEB_WORKER";
const DEFAULT_LOG_LINES = 200;
const WEB_SERVICE_SCHEMA = "mono-agent.web-service.v1";
const TAILSCALE_OWNERSHIP_SCHEMA = "mono-agent.web-tailscale-serve.v1";
const READY_TIMEOUT_MS = 15_000;
const READY_POLL_MS = 200;
const TAILSCALE_FALLBACK_PORT_START = 8443;
const TAILSCALE_FALLBACK_PORT_END = 8499;
const TAILSCALE_STATUS_ATTEMPTS = 3;
const TAILSCALE_STATUS_RETRY_MS = 200;
const WEB_PACKAGE_NAME = "@mono-agent/web";
const WEB_THEMES = ["evergreen", "ocean", "plum", "terracotta"] as const satisfies readonly WebTheme[];
const DEFAULT_WEB_THEME: WebTheme = "evergreen";
// Mirrors WEB_CONSOLE_NAME_MAX_CHARACTERS in @mono-agent/web; declared locally so this
// command keeps its type-only dependency on the lazily loaded web package.
const WEB_CONSOLE_NAME_MAX_CHARACTERS = 80;

interface WebServerHandle {
  readonly url: string;
  readonly host?: string;
  readonly port?: number;
  readonly boundAddress?: string;
  stop(): Promise<void>;
}

interface StartWebServerOptions {
  readonly host?: string;
  readonly port?: number;
  readonly theme?: WebTheme;
  readonly name?: string;
  readonly registryDirs?: readonly string[];
  readonly stateDir?: string;
  readonly env?: Record<string, string | undefined>;
  readonly configurationHost?: {
    supports(agent: { readonly source: import("@mono-agent/observability").TraceSourceListItem }): boolean;
    create(agent: { readonly source: import("@mono-agent/observability").TraceSourceListItem }): Promise<{
      readonly configuration: unknown;
      dispose(): Promise<void>;
    }>;
  };
}

interface ResetWebStateOptions {
  readonly stateDir?: string;
  readonly env?: Record<string, string | undefined>;
}

interface PrepareWebStateOptions {
  readonly stateDir?: string;
  readonly env?: Record<string, string | undefined>;
}

export interface RunWebCommandOptions {
  readonly positionals: readonly string[];
  readonly env: Record<string, string | undefined>;
  readonly host?: string;
  readonly port?: number;
  readonly theme?: string;
  readonly name?: string;
  readonly loopback?: boolean;
  readonly follow?: boolean;
  readonly lines?: number;
  readonly all?: boolean;
  readonly yes?: boolean;
}

export interface CommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type CommandRunner = (args: readonly string[]) => Promise<CommandResult>;

interface ManagedRuntimeResult {
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
  readonly ensureManagedRuntime?: (input: {
    readonly currentCliPath: string;
    readonly nodePath: string;
  }) => Promise<ManagedRuntimeResult>;
  readonly verifyMaintenanceEntrypoint?: typeof verifyManagedRuntimeMaintenanceEntrypoint;
  readonly inspectMaintenanceService?: (
    runner: LaunchctlRunner,
    uid: number,
  ) => Promise<LaunchdWebMaintenanceInfo>;
  readonly spawnTail?: (args: readonly string[]) => Promise<number>;
  readonly writePrivateFile?: (path: string, contents: string) => Promise<void>;
  readonly acquireLifecycleLock?: (paths: WebPaths) => Promise<(() => Promise<void>) | undefined>;
  readonly discoverNetworkAddresses?: () => readonly string[];
  readonly startManagedLogMonitor?: (
    paths: Pick<LaunchdPaths, "logDir" | "stdoutPath" | "stderrPath">,
    dependencies: ManagedWebLogMonitorDependencies,
  ) => { stop(): void };
  readonly homeDir?: string;
  readonly systemd?: import("./systemd.js").SystemdDeps;
}

interface WebServiceRecord {
  readonly schema: typeof WEB_SERVICE_SCHEMA;
  readonly host: string;
  readonly port: number;
  /** Optional only so pre-theme v1 records remain readable during upgrade. */
  readonly theme?: WebTheme;
  /** Absent means the console labels itself with the machine hostname. */
  readonly name?: string;
  readonly updatedAt: string;
}

interface PreviousWebServiceSnapshot {
  readonly plist: string;
  readonly helperInputs?: WebMaintenancePublicationInputs;
  readonly recordText?: string;
  readonly record?: WebServiceRecord;
}

interface WebPublicationSnapshot {
  readonly plist?: string;
  readonly helperInputs?: WebMaintenancePublicationInputs;
  readonly recordText?: string;
}

interface WebMaintenancePublicationInputs {
  readonly nodePath: string;
  readonly cliPath: string;
  readonly cwd: string;
  readonly expectedManagedRuntimeLaunch: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly calendarMinute: number;
}

type WebServiceRecordRead =
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

type TailscaleServeResult =
  | { readonly kind: "active"; readonly ownership: TailscaleServeOwnership; readonly reused: boolean }
  | {
      readonly kind: "unavailable";
      readonly detail: string;
      /** The old owned route was migrated, so the replacement worker must also be rolled back. */
      readonly requiresServiceRollback?: true;
    };

type TailscaleOwnershipRead =
  | { readonly kind: "absent" }
  | { readonly kind: "valid"; readonly ownership: TailscaleServeOwnership; readonly contents: string }
  | { readonly kind: "invalid"; readonly detail: string };

type OwnedRouteInspection =
  | { readonly kind: "exact" }
  | { readonly kind: "absent" }
  | { readonly kind: "changed" }
  | { readonly kind: "unavailable"; readonly detail: string };

export type WebPaths = ManagedWebPaths;

export function webPaths(homeDir?: string): WebPaths {
  return managedWebPaths(homeDir);
}

export function renderWebHelp(): string {
  return [
    "mono-agent web — always-on multi-agent web console",
    "",
    "  mono-agent web",
    "  mono-agent web start [--host <addr> | --loopback] [--port <n>] [--theme <name>] [--name <label>]",
    "  mono-agent web restart [--host <addr> | --loopback] [--port <n>] [--theme <name>] [--name <label>]",
    "  mono-agent web stop | status",
    "  mono-agent web logs [--follow|-f] [--lines <n>]",
    "  mono-agent web run [--host <addr> | --loopback] [--port <n>] [--theme <name>] [--name <label>]",
    "  mono-agent web reset --all --yes",
    "",
    `Default bind: ${DEFAULT_WEB_HOST}:${String(DEFAULT_WEB_PORT)} (LAN/Tailnet reachable; no app login).`,
    `Themes: ${WEB_THEMES.join(", ")} (default: ${DEFAULT_WEB_THEME}).`,
    "--name sets the installed PWA label, browser tab title, and rail brand (default: this machine's hostname).",
    "--loopback narrows the bind to 127.0.0.1. macOS start/restart claim a free Tailscale Serve HTTPS port; Linux HTTPS routes are externally managed.",
    "",
  ].join("\n");
}

/** Route the `mono-agent web` service namespace. Bare invocation is read-only. */
export async function runWebCommand(
  options: RunWebCommandOptions,
  deps: RunWebCommandDeps = {},
): Promise<number> {
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  const action = options.positionals[0];
  if (options.positionals.length > 1 || (action !== undefined && !WEB_ACTIONS.has(action))) {
    stderr.write(ui.errorLine(`Unknown mono-agent web action \`${options.positionals.join(" ")}\`.`));
    stdout.write(renderWebHelp());
    return 2;
  }
  const validation = validateWebFlags(action, options);
  if (validation !== undefined) {
    stderr.write(ui.errorLine(validation));
    stdout.write(renderWebHelp());
    return 2;
  }

  if ((deps.platform ?? process.platform) === "linux" && action !== "run" && action !== "reset") {
    if (action === undefined) stdout.write(renderWebHelp());
    const { runSystemdWebCommand } = await import("./systemd-command.js");
    const { isSystemdUserManagerUnavailable } = await import("./systemd.js");
    try {
      return await runSystemdWebCommand(options, {
        ...deps.systemd,
        ...(deps.homeDir === undefined ? {} : { homeDir: deps.homeDir }),
        stdout, stderr,
      });
    } catch (error) {
      if (!isSystemdUserManagerUnavailable(error) || (action !== undefined && action !== "status")) throw error;
      if (action === undefined) {
        await statusWeb(options, deps, false);
        return 0;
      }
      return await statusWeb(options, deps, true);
    }
  }

  if ((deps.platform ?? process.platform) === "linux" && action === "reset") {
    const { withSystemdLock, SYSTEMD_WEB_IDENTITY } = await import("./systemd.js");
    try {
      return await withSystemdLock(SYSTEMD_WEB_IDENTITY, {
        ...deps.systemd, ...(deps.homeDir === undefined ? {} : { homeDir: deps.homeDir }),
      }, () => resetWeb(options, deps));
    } catch (error) {
      stderr.write(ui.errorLine(`Linux web reset failed: ${errorMessage(error)}`));
      return 1;
    }
  }

  if (action === undefined) {
    stdout.write(renderWebHelp());
    await statusWeb(options, deps, false);
    return 0;
  }
  switch (action) {
    case "run":
      return await runWebForeground(options, deps);
    case "start":
      return await startWebBackground(options, deps, false);
    case "restart":
      return await startWebBackground(options, deps, true);
    case "stop":
      return await stopWebBackground(options, deps);
    case "status":
      return await statusWeb(options, deps, true);
    case "logs":
      return await tailWebLogs(options, deps);
    case "reset":
      return await resetWeb(options, deps);
  }
  return 2;
}

const WEB_ACTIONS: ReadonlySet<string> = new Set(["start", "stop", "restart", "status", "logs", "run", "reset"]);

function validateWebFlags(action: string | undefined, options: RunWebCommandOptions): string | undefined {
  if (options.loopback === true && options.host !== undefined) {
    return "Choose either --loopback or --host, not both.";
  }
  if (options.port !== undefined && options.port === 0) {
    return "mono-agent web requires a stable --port between 1 and 65535.";
  }
  if (options.theme !== undefined && !isWebTheme(options.theme)) {
    return `--theme must be one of: ${WEB_THEMES.join(", ")}.`;
  }
  if (options.name !== undefined && invalidWebConsoleName(options.name) !== undefined) {
    return invalidWebConsoleName(options.name);
  }
  if ((options.host !== undefined || options.port !== undefined || options.theme !== undefined
    || options.name !== undefined || options.loopback === true)
    && action !== "start" && action !== "restart" && action !== "run") {
    return "--host, --port, --theme, --name, and --loopback are only supported for web start, restart, or run.";
  }
  if ((options.follow === true || options.lines !== undefined) && action !== "logs") {
    return "--follow and --lines are only supported for mono-agent web logs.";
  }
  if ((options.all === true || options.yes === true) && action !== "reset") {
    return "--all and --yes are only supported for mono-agent web reset in this command namespace.";
  }
  if (action === "reset" && (options.all !== true || options.yes !== true)) {
    return "Destructive reset requires the exact confirmation: mono-agent web reset --all --yes.";
  }
  return undefined;
}

async function runWebForeground(options: RunWebCommandOptions, deps: RunWebCommandDeps): Promise<number> {
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  const host = effectiveHost(options);
  const port = options.port ?? DEFAULT_WEB_PORT;
  const theme = selectedWebTheme(options.theme);
  const consoleName = selectedWebConsoleName(options.name);
  const paths = webPaths(deps.homeDir);
  await (deps.prepareState ?? defaultPrepareWebState)({ stateDir: paths.stateDir, env: options.env });
  const registryDir = resolveGlobalTraceRegistryDir(options.env);
  await pruneTraceSources({ registryDir });
  let handle: WebServerHandle;
  try {
    const startServer = deps.startServer ?? defaultStartWebServer;
    const configurationHost = (deps.platform ?? process.platform) === "darwin"
      ? {
          supports: (agent: { readonly source: import("@mono-agent/observability").TraceSourceListItem }) =>
            agent.source.configPath !== undefined
              && agent.source.health === "running"
              && hasCompletedManagedStartup(agent.source),
          create: async (agent: { readonly source: import("@mono-agent/observability").TraceSourceListItem }) => {
            const { createManagedWebConfigurationSession } = await import("./tui-command.js");
            return await createManagedWebConfigurationSession(agent.source, options.env);
          },
        }
      : undefined;
    handle = await startServer({
      host,
      port,
      theme,
      ...(consoleName === undefined ? {} : { name: consoleName }),
      registryDirs: [registryDir],
      stateDir: paths.stateDir,
      env: options.env,
      ...(configurationHost === undefined ? {} : { configurationHost }),
    });
  } catch (error) {
    stderr.write(ui.errorLine(`mono-agent web failed to start: ${errorMessage(error)}`));
    return 1;
  }
  printWebUrls(stdout, handle.url, handle.port ?? port, host, deps.discoverNetworkAddresses);
  stdout.write("No app authentication is enabled; network reachability is the access boundary. Press Ctrl-C to stop.\n");
  const monitor = options.env[MANAGED_WEB_WORKER_ENV] === "1"
    ? (deps.startManagedLogMonitor ?? startManagedWebLogMonitor)(paths.launchd, {
        runner: deps.launchctl ?? makeLaunchctlRunner(),
        getuid: deps.getuid ?? requiredUid,
        stderr: (text) => { stderr.write(text); },
        recordStatus: async (status) => await writeWebLogMonitorStatus(
          paths.monitorStatusPath,
          status,
          deps.writePrivateFile ?? writeOwnerPrivateLaunchdFile,
        ),
      })
    : undefined;
  try {
    await (deps.waitForShutdown ?? waitForShutdownSignal)();
  } finally {
    monitor?.stop();
    await handle.stop();
  }
  stdout.write("mono-agent web stopped.\n");
  return 0;
}

async function startWebBackground(
  options: RunWebCommandOptions,
  deps: RunWebCommandDeps,
  restart: boolean,
): Promise<number> {
  const guard = requireDarwin(deps, restart ? "restart" : "start");
  if (guard !== undefined) return guard;
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  const launchctl = deps.launchctl ?? makeLaunchctlRunner();
  const getuid = deps.getuid ?? requiredUid;
  const paths = webPaths(deps.homeDir);
  try {
    await (deps.prepareState ?? defaultPrepareWebState)({ stateDir: paths.stateDir, env: options.env });
  } catch (error) {
    stderr.write(ui.errorLine(`Could not prepare the owner-private web state: ${errorMessage(error)}`));
    return 1;
  }
  const release = await (deps.acquireLifecycleLock ?? acquireWebLifecycleLock)(paths);
  if (release === undefined) {
    stderr.write(ui.errorLine("Another mono-agent web lifecycle command is active."));
    return 1;
  }
  let previous: PreviousWebServiceSnapshot | undefined;
  let previousStopped = false;
  let replacementLaunchAttempted = false;
  let publicationAttempted = false;
  let publicationSnapshot: WebPublicationSnapshot | undefined;
  let pendingMaintenanceIntent: Awaited<ReturnType<typeof readLaunchdLogMaintenanceIntent>>;
  const fail = async (message: string, error?: unknown): Promise<number> => {
    stderr.write(ui.errorLine(`${message}${error === undefined ? "" : `: ${errorMessage(error)}`}`));
    if (previousStopped && previous !== undefined) {
      const recovery = await restorePreviousWebService(previous, paths, launchctl, getuid(), deps);
      if (recovery.ok) {
        stderr.write(ui.style.yellow("⚠ The failed restart was rolled back and the previous web worker is running again.\n"));
      } else {
        stderr.write(ui.style.yellow(`⚠ The failed restart could not restore the prior worker: ${recovery.detail}\n`));
      }
    } else {
      let safeToRestorePublication = true;
      if (replacementLaunchAttempted) {
        try {
          const helper = await launchdServiceInfo(launchctl, WEB_MAINTENANCE_LAUNCHD_LABEL, getuid());
          if (helper.loaded) {
            safeToRestorePublication = await stopLaunchdOnly(
              WEB_MAINTENANCE_LAUNCHD_LABEL,
              helper,
              launchctl,
              getuid(),
              deps,
            );
          }
          const replacement = await launchdServiceInfo(launchctl, WEB_LAUNCHD_LABEL, getuid());
          if (replacement.loaded) {
            const stopped = await stopLaunchdOnly(WEB_LAUNCHD_LABEL, replacement, launchctl, getuid(), deps);
            safeToRestorePublication = safeToRestorePublication && stopped;
            stderr.write(stopped
              ? ui.style.yellow("⚠ The failed initial web worker was stopped.\n")
              : ui.style.yellow("⚠ The failed initial web worker could not be proven stopped; inspect `mono-agent web status` and logs.\n"));
          }
        } catch (cleanupError) {
          safeToRestorePublication = false;
          stderr.write(ui.style.yellow(`⚠ Could not clean up the failed initial web worker: ${errorMessage(cleanupError)}\n`));
        }
      }
      if (publicationAttempted && publicationSnapshot !== undefined && safeToRestorePublication) {
        try {
          await restoreWebPublication(paths, publicationSnapshot, deps.writePrivateFile ?? writeOwnerPrivateLaunchdFile);
        } catch (restoreError) {
          stderr.write(ui.style.yellow(`⚠ Could not restore the pre-start service definition: ${errorMessage(restoreError)}\n`));
        }
      }
    }
    return 1;
  };
  try {
    const uid = getuid();
    const existing = await launchdServiceInfo(launchctl, WEB_LAUNCHD_LABEL, uid);
    let helper = await launchdServiceInfo(launchctl, WEB_MAINTENANCE_LAUNCHD_LABEL, uid);
    if (existing.loaded && !restart) {
      if (options.theme !== undefined) {
        stderr.write(ui.errorLine(
          `mono-agent web is already managed by launchd; use \`mono-agent web restart --theme ${options.theme}\` to change its theme.`,
        ));
        return 1;
      }
      if (options.name !== undefined) {
        stderr.write(ui.errorLine(
          `mono-agent web is already managed by launchd; use \`mono-agent web restart --name ${shellQuote(options.name)}\` to change its name.`,
        ));
        return 1;
      }
      if (helper.loaded) {
        try {
          const loadedHelper = await (deps.inspectMaintenanceService ?? launchdWebMaintenanceInfo)(launchctl, uid);
          await inspectInstalledWebMaintenanceHelper(
            paths,
            undefined,
            deps.verifyMaintenanceEntrypoint,
            loadedHelper.definition,
            true,
          );
        } catch (error) {
          stderr.write(ui.errorLine(
            `The running web worker was preserved, but its maintenance helper is stale or unverifiable: ${errorMessage(error)}`,
          ));
          stderr.write(ui.hint("Repair the paired definitions with: mono-agent web restart"));
          return 1;
        }
      } else {
        try {
          await ensureWebDirectories(paths);
          const currentCliPath = fileURLToPath(new URL("./cli.js", import.meta.url));
          const runtime = await (deps.ensureManagedRuntime ?? ((input) => ensureManagedBackgroundRuntime(input)))({
            currentCliPath,
            nodePath: process.execPath,
          });
          await publishHelperForExistingMain(
            paths,
            maintenanceInputsForRuntime(runtime, paths),
            deps.writePrivateFile ?? writeOwnerPrivateLaunchdFile,
          );
          const booted = await bootstrap(launchctl, paths.maintenancePlistPath, uid);
          if (booted.code !== 0) {
            throw new Error(commandDetail(booted) || `launchctl bootstrap exited ${String(booted.code)}`);
          }
          helper = await launchdServiceInfo(launchctl, WEB_MAINTENANCE_LAUNCHD_LABEL, uid);
          if (!helper.loaded) throw new Error("launchd did not retain the maintenance helper");
        } catch (error) {
          stderr.write(ui.errorLine(
            `The running web worker was preserved, but its missing maintenance helper could not be installed: ${errorMessage(error)}`,
          ));
          stderr.write(ui.hint("Repair the paired definitions with: mono-agent web restart"));
          return 1;
        }
      }
      stdout.write(ui.style.dim("mono-agent web is already managed by launchd.\n"));
      return await statusWeb(options, deps, true);
    }
    const recordRead = await readServiceRecord(paths.recordPath);
    if (recordRead.kind === "invalid") {
      return await fail(`Refusing to start because ${recordRead.detail}`);
    }
    try {
      pendingMaintenanceIntent = await readLaunchdLogMaintenanceIntent(paths.launchd);
    } catch (error) {
      return await fail("Refusing to start because the durable web log-maintenance intent is unsafe", error);
    }
    if (pendingMaintenanceIntent?.phase === "stopping") {
      stderr.write(ui.errorLine(
        "Refusing to change either LaunchAgent because an abandoned stopping intent lacks complete prior PID-death proof.",
      ));
      stderr.write(ui.hint(
        "Recover safely with `mono-agent web stop`, then `mono-agent web start`; restart cannot promote an unproven stop.",
      ));
      return 1;
    }
    const existingPlist = await readOptionalText(paths.launchd.plistPath);
    if (pendingMaintenanceIntent !== undefined) {
      let currentMainIdentity: string;
      try {
        currentMainIdentity = await inspectOwnerPrivateLaunchdPlist(paths.launchd.plistPath);
      } catch {
        stderr.write(ui.errorLine(
          "Refusing to recover web log maintenance because its main LaunchAgent identity is absent or unsafe.",
        ));
        stderr.write(ui.hint(
          "Recover safely with `mono-agent web stop`, then `mono-agent web start`; stop clears stale authority only after both jobs are down.",
        ));
        return 1;
      }
      if (pendingMaintenanceIntent.plistFingerprint !== currentMainIdentity) {
        stderr.write(ui.errorLine(
          "Refusing to recover web log maintenance because its durable intent authenticates an older main LaunchAgent identity.",
        ));
        stderr.write(ui.hint(
          "Recover safely with `mono-agent web stop`, then `mono-agent web start`; restart cannot reuse stale rotation authority.",
        ));
        return 1;
      }
    }
    let existingHelperInputs: WebMaintenancePublicationInputs | undefined;
    if (await readOptionalText(paths.maintenancePlistPath) !== undefined) {
      try {
        existingHelperInputs = await inspectInstalledWebMaintenanceHelper(paths, undefined, deps.verifyMaintenanceEntrypoint);
      } catch {
        // Explicit start/restart may repair a stopped or stale helper. A loaded
        // healthy worker took the preserve-and-restart-instruction path above.
      }
    }
    publicationSnapshot = {
      ...(existingPlist === undefined ? {} : { plist: existingPlist }),
      ...(existingHelperInputs === undefined ? {} : { helperInputs: existingHelperInputs }),
      ...(recordRead.kind === "valid" ? { recordText: recordRead.contents } : {}),
    };
    if (existing.loaded && restart) {
      try {
        if (existingPlist === undefined) throw new Error("the loaded LaunchAgent plist is missing");
        if (recordRead.kind !== "valid") throw new Error("the loaded web service record is missing");
        previous = {
          plist: existingPlist,
          ...(existingHelperInputs === undefined ? {} : { helperInputs: existingHelperInputs }),
          recordText: recordRead.contents,
          record: recordRead.record,
        };
      } catch (error) {
        return await fail("Refusing restart because the current web service could not be snapshotted", error);
      }
    }
    // Establish structured helper inputs before unloading anything. If runtime
    // installation fails, the current pair remains untouched and no rollback
    // needs authority that was not captured.
    await ensureWebDirectories(paths);
    const currentCliPath = fileURLToPath(new URL("./cli.js", import.meta.url));
    let runtime: ManagedRuntimeResult;
    try {
      runtime = await (deps.ensureManagedRuntime ?? ((input) => ensureManagedBackgroundRuntime(input)))({
        currentCliPath,
        nodePath: process.execPath,
      });
    } catch (error) {
      return await fail("Could not install the durable web runtime", error);
    }
    const helperInputs = maintenanceInputsForRuntime(runtime, paths);
    if (publicationSnapshot.plist !== undefined && publicationSnapshot.helperInputs === undefined) {
      publicationSnapshot = { ...publicationSnapshot, helperInputs };
    }
    if (previous !== undefined && previous.helperInputs === undefined) {
      previous = { ...previous, helperInputs };
    }
    const helperWasLoaded = helper.loaded;
    if (helper.loaded) {
      const stopped = await stopLaunchdOnly(
        WEB_MAINTENANCE_LAUNCHD_LABEL,
        helper,
        launchctl,
        uid,
        deps,
      );
      if (!stopped) {
        stderr.write(ui.errorLine("Could not prove the web-maintenance helper stopped; both definitions were preserved."));
        return 1;
      }
      helper = { loaded: false };
    }
    if (existing.loaded) {
      const stopped = await stopLaunchdOnly(WEB_LAUNCHD_LABEL, existing, launchctl, uid, deps);
      if (!stopped) {
        if (helperWasLoaded) {
          const restoredHelper = await bootstrap(launchctl, paths.maintenancePlistPath, uid);
          const helperRestored = restoredHelper.code === 0
            && (await launchdServiceInfo(launchctl, WEB_MAINTENANCE_LAUNCHD_LABEL, uid)).loaded;
          if (!helperRestored) {
            stderr.write(ui.style.yellow(
              `⚠ The worker remained loaded, but its prior maintenance helper could not be proven restored: ${commandDetail(restoredHelper) || "launchd did not retain the helper"}\n`,
            ));
          }
        }
        stderr.write(ui.errorLine("Could not prove the existing mono-agent web worker stopped; its definition was preserved."));
        return 1;
      }
      previousStopped = restart && previous !== undefined;
    }

    const priorRecord = recordRead.kind === "valid" ? recordRead.record : undefined;
    const host = effectiveHost(options, priorRecord?.host);
    const port = options.port ?? priorRecord?.port ?? DEFAULT_WEB_PORT;
    const theme = selectedWebTheme(options.theme, priorRecord?.theme);
    const consoleName = selectedWebConsoleName(options.name, priorRecord?.name);
    if (existingPlist !== undefined) {
      try {
        pendingMaintenanceIntent = await maintainStoppedWebLogsBeforePublication(
          paths,
          pendingMaintenanceIntent,
          deps.now ?? Date.now,
        );
      } catch (error) {
        return await fail("Could not complete the proven stopped-window web log maintenance pass", error);
      }
    }
    const tailscaleRunner = deps.tailscale ?? makeTailscaleRunner(options.env);
    const priorTailscaleOwnership = await readTailscaleOwnership(paths.tailscalePath);
    const recordedTailscaleDnsName = priorTailscaleOwnership.kind === "valid"
      ? tailscaleWebHostname(priorTailscaleOwnership.ownership.webKey)
      : undefined;
    // A healthy existing Serve route must keep working through a transient
    // LocalAPI outage during restart. The owner-private, exact-route record is
    // re-verified by ensureTailscaleServe after the replacement worker starts.
    const tailscaleDnsName = await readTailscaleDnsName(tailscaleRunner, deps.sleep)
      ?? recordedTailscaleDnsName;
    const allowedHosts = mergeWebAllowedHosts(options.env.MONO_AGENT_WEB_ALLOWED_HOSTS, tailscaleDnsName);
    const environment = {
      ...selectBackgroundOperationalEnvironment(options.env),
      PATH: defaultPathEnv(options.env),
      [MANAGED_WEB_WORKER_ENV]: "1",
      ...(options.env.MONO_AGENT_GLOBAL_TRACE_REGISTRY_DIR === undefined
        ? {}
        : { MONO_AGENT_GLOBAL_TRACE_REGISTRY_DIR: options.env.MONO_AGENT_GLOBAL_TRACE_REGISTRY_DIR }),
      ...(allowedHosts === undefined ? {} : { MONO_AGENT_WEB_ALLOWED_HOSTS: allowedHosts }),
      ...(options.env.MONO_AGENT_WEB_PUSH_SUBJECT === undefined
        ? {}
        : { MONO_AGENT_WEB_PUSH_SUBJECT: options.env.MONO_AGENT_WEB_PUSH_SUBJECT }),
    };
    const record: WebServiceRecord = {
      schema: WEB_SERVICE_SCHEMA,
      host,
      port,
      theme,
      ...(consoleName === undefined ? {} : { name: consoleName }),
      updatedAt: new Date((deps.now ?? Date.now)()).toISOString(),
    };
    const plist = buildWebPlistXml({
      label: WEB_LAUNCHD_LABEL,
      nodePath: runtime.nodePath,
      cliPath: runtime.cliPath,
      cwd: paths.stateDir,
      host,
      port,
      theme,
      ...(consoleName === undefined ? {} : { name: consoleName }),
      stdoutPath: paths.launchd.stdoutPath,
      stderrPath: paths.launchd.stderrPath,
      environment,
    });
    const writePrivateFile = deps.writePrivateFile ?? writeOwnerPrivateLaunchdFile;
    publicationAttempted = true;
    try {
      await writePrivateFile(paths.recordPath, `${JSON.stringify(record, undefined, 2)}\n`);
      await publishPairedWebPlists(paths, plist, helperInputs, writePrivateFile);
    } catch (error) {
      return await fail("Could not publish the web LaunchAgent definition", error);
    }

    replacementLaunchAttempted = true;
    const helperBootstrapped = await bootstrap(launchctl, paths.maintenancePlistPath, uid);
    if (helperBootstrapped.code !== 0) {
      writeCommandDetail(stderr, helperBootstrapped);
      return await fail(`launchctl could not start mono-agent web maintenance (exit ${String(helperBootstrapped.code)})`);
    }
    const bootstrapped = await bootstrap(launchctl, paths.launchd.plistPath, uid);
    if (bootstrapped.code !== 0) {
      writeCommandDetail(stderr, bootstrapped);
      return await fail(`launchctl could not start mono-agent web (exit ${String(bootstrapped.code)})`);
    }
    const ready = await waitForWebReady(host, port, launchctl, uid, deps);
    if (!ready) {
      stderr.write(ui.hint("Inspect `mono-agent web logs`, then retry `mono-agent web restart`."));
      return await fail("mono-agent web did not become healthy before the startup timeout");
    }
    if (pendingMaintenanceIntent !== undefined) {
      try {
        await inspectInstalledWebMaintenanceHelper(paths, undefined, deps.verifyMaintenanceEntrypoint);
        await clearLaunchdLogMaintenanceIntent(paths.launchd, pendingMaintenanceIntent);
        const priorStatus = await readWebLogMaintenanceStatus(paths.maintenanceStatusPath);
        if (priorStatus.kind !== "valid" || priorStatus.status.state !== "degraded") {
          await writeWebLogMaintenanceStatus(paths.maintenanceStatusPath, {
            version: 1,
            state: "success",
            phase: "complete",
            updatedAt: new Date((deps.now ?? Date.now)()).toISOString(),
          });
        }
        pendingMaintenanceIntent = undefined;
      } catch (error) {
        return await fail("The replacement worker is live, but stale rotation authority could not be revoked", error);
      }
    }

    const tailscale = tailscaleDnsName === undefined
      ? { kind: "unavailable" as const, detail: "the node's exact Tailscale DNS name could not be resolved; no Serve handler was changed" }
      : await ensureTailscaleServe(
          paths,
          host,
          port,
          options.env,
          { ...deps, tailscale: tailscaleRunner },
          tailscaleDnsName,
        );
    if (tailscale.kind === "unavailable" && tailscale.requiresServiceRollback === true) {
      return await fail(`Tailscale route migration failed and the replacement web worker cannot remain active: ${tailscale.detail}`);
    }

    stdout.write(`${ui.badge("ok")}${ui.style.bold(restart ? "Restarted mono-agent web" : "Started mono-agent web")}\n`);
    printWebUrls(stdout, `http://${urlHost(host)}:${String(port)}/`, port, host, deps.discoverNetworkAddresses);
    stdout.write("No app authentication is enabled; anyone who can reach this port can operate discovered agents.\n");

    if (tailscale.kind === "active") {
      stdout.write(`Tailscale HTTPS → ${tailscale.ownership.url}${tailscale.reused ? " (existing owned handler)" : ""}\n`);
    } else {
      stderr.write(ui.style.yellow(`⚠ Tailscale Serve was not configured: ${tailscale.detail}\n`));
      stderr.write(ui.hint(`LAN HTTP remains healthy on port ${String(port)}. Resolve Tailscale, then run mono-agent web restart.`));
    }
    return 0;
  } catch (error) {
    return await fail("mono-agent web lifecycle failed", error);
  } finally {
    await release().catch((error: unknown) => {
      stderr.write(ui.style.yellow(`⚠ Could not release the web lifecycle lock: ${errorMessage(error)}\n`));
    });
  }
}

async function stopWebBackground(options: RunWebCommandOptions, deps: RunWebCommandDeps): Promise<number> {
  const guard = requireDarwin(deps, "stop");
  if (guard !== undefined) return guard;
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  const launchctl = deps.launchctl ?? makeLaunchctlRunner();
  const uid = (deps.getuid ?? requiredUid)();
  const paths = webPaths(deps.homeDir);
  const initialService = await launchdServiceInfo(launchctl, WEB_LAUNCHD_LABEL, uid);
  const initialHelper = await launchdServiceInfo(launchctl, WEB_MAINTENANCE_LAUNCHD_LABEL, uid);
  // A running worker owns the backend state lease. Stop must reach launchd
  // bootout without opening or preparing that state first. On a pristine,
  // already-stopped install, preparation creates a valid marked state root
  // before the filesystem lifecycle lock needs to place its lock directory.
  if (!initialService.loaded && !initialHelper.loaded) {
    try {
      await (deps.prepareState ?? defaultPrepareWebState)({ stateDir: paths.stateDir, env: options.env });
    } catch (error) {
      stderr.write(ui.errorLine(`Could not prepare the owner-private web state: ${errorMessage(error)}`));
      return 1;
    }
  }
  const release = await (deps.acquireLifecycleLock ?? acquireWebLifecycleLock)(paths);
  if (release === undefined) {
    stderr.write(ui.errorLine("Another mono-agent web lifecycle command is active."));
    return 1;
  }
  try {
    const helper = await launchdServiceInfo(launchctl, WEB_MAINTENANCE_LAUNCHD_LABEL, uid);
    const helperWasLoaded = helper.loaded;
    if (helper.loaded && !await stopLaunchdOnly(
      WEB_MAINTENANCE_LAUNCHD_LABEL,
      helper,
      launchctl,
      uid,
      deps,
    )) {
      stderr.write(ui.errorLine("Could not prove mono-agent web maintenance stopped; both LaunchAgents were preserved."));
      return 1;
    }
    const service = await launchdServiceInfo(launchctl, WEB_LAUNCHD_LABEL, uid);
    if (service.loaded && !await stopLaunchdOnly(WEB_LAUNCHD_LABEL, service, launchctl, uid, deps)) {
      if (helperWasLoaded) {
        let helperRestored = false;
        let restoreDetail = "launchd did not retain the helper";
        try {
          const restoredHelper = await bootstrap(launchctl, paths.maintenancePlistPath, uid);
          helperRestored = restoredHelper.code === 0
            && (await launchdServiceInfo(launchctl, WEB_MAINTENANCE_LAUNCHD_LABEL, uid)).loaded;
          restoreDetail = commandDetail(restoredHelper) || restoreDetail;
        } catch (error) {
          restoreDetail = errorMessage(error);
        }
        if (!helperRestored) {
          stderr.write(ui.style.yellow(
            `⚠ The worker remained loaded, but its prior maintenance helper could not be proven restored: ${restoreDetail}\n`,
          ));
        }
      }
      stderr.write(ui.errorLine("Could not prove mono-agent web stopped; its LaunchAgent and Tailscale handler were preserved."));
      return 1;
    }
    const tailscaleResult = await removeOwnedTailscaleServe(paths, deps);
    try {
      let intent = await readLaunchdLogMaintenanceIntent(paths.launchd);
      // Explicit stop has just proven both launchd jobs and every observed PID
      // gone. Convert pre-proof or stale restoration authority into the same
      // durable stopped proof before clearing it; clear itself never accepts a
      // raw stopping intent.
      if (intent?.phase === "stopping" || intent?.phase === "restoring") {
        intent = await markLaunchdLogMaintenanceStopped(paths.launchd, intent);
      }
      await clearLaunchdLogMaintenanceIntent(paths.launchd, intent);
      await rm(paths.monitorStatusPath, { force: true });
      await rm(paths.maintenanceStatusPath, { force: true });
    } catch (error) {
      stderr.write(ui.errorLine(`Web stopped, but maintenance recovery state could not be safely cleared: ${errorMessage(error)}`));
      return 1;
    }
    await rm(paths.maintenancePlistPath, { force: true });
    await rm(paths.launchd.plistPath, { force: true });
    if (tailscaleResult.kind === "unavailable") {
      stderr.write(ui.style.yellow(`⚠ Web stopped, but the owned Tailscale handler was preserved: ${tailscaleResult.detail}\n`));
      return 1;
    }
    stdout.write(service.loaded || helper.loaded
      ? `${ui.badge("ok")}${ui.style.bold("Stopped mono-agent web")} and removed its LaunchAgent.\n`
      : "mono-agent web was already stopped; removed its LaunchAgent if present.\n");
    return 0;
  } finally {
    await release().catch(() => undefined);
  }
}

async function statusWeb(
  options: RunWebCommandOptions,
  deps: RunWebCommandDeps,
  strictExit: boolean,
): Promise<number> {
  const stdout = deps.stdout ?? process.stdout;
  const paths = webPaths(deps.homeDir);
  const recordRead = await readServiceRecord(paths.recordPath);
  const record = recordRead.kind === "valid" ? recordRead.record : undefined;
  const host = record?.host ?? DEFAULT_WEB_HOST;
  const port = record?.port ?? DEFAULT_WEB_PORT;
  const theme = record?.theme ?? DEFAULT_WEB_THEME;
  const consoleName = record?.name;
  let service: LaunchdServiceInfo = { loaded: false };
  let helper: LaunchdWebMaintenanceInfo = { loaded: false };
  if ((deps.platform ?? process.platform) === "darwin") {
    const runner = deps.launchctl ?? makeLaunchctlRunner();
    const uid = (deps.getuid ?? requiredUid)();
    [service, helper] = await Promise.all([
      launchdServiceInfo(runner, WEB_LAUNCHD_LABEL, uid),
      (deps.inspectMaintenanceService ?? launchdWebMaintenanceInfo)(runner, uid),
    ]);
  }
  const healthState = recordRead.kind === "invalid" || !service.loaded
    ? "unavailable"
    : deps.healthcheck === undefined
      ? await webHealthStatus(healthUrl(host, port))
      : await deps.healthcheck(healthUrl(host, port)) ? "ok" : "unavailable";
  const healthy = healthState === "ok";
  const maintenanceProblems: string[] = [];
  let maintenanceSummary = helper.loaded ? "idle" : "helper missing";
  let pendingIntent: Awaited<ReturnType<typeof readLaunchdLogMaintenanceIntent>>;
  let pendingRecoveryRequiresStopStart = false;
  try {
    pendingIntent = await readLaunchdLogMaintenanceIntent(paths.launchd);
  } catch {
    pendingIntent = undefined;
    maintenanceProblems.push("maintenance intent is unreadable or unsafe");
  }
  const maintenanceStatus = await readWebLogMaintenanceStatus(paths.maintenanceStatusPath);
  const monitorStatus = await readWebLogMonitorStatus(paths.monitorStatusPath);
  if (helper.loaded) {
    try {
      await inspectInstalledWebMaintenanceHelper(
        paths,
        undefined,
        deps.verifyMaintenanceEntrypoint,
        helper.definition,
        true,
      );
    } catch {
      maintenanceProblems.push("helper definition or managed-runtime closure is invalid");
    }
  } else {
    maintenanceProblems.push("maintenance helper is not loaded");
  }
  if (pendingIntent !== undefined) {
    pendingRecoveryRequiresStopStart = pendingIntent.phase === "stopping";
    if (!pendingRecoveryRequiresStopStart) {
      try {
        pendingRecoveryRequiresStopStart = pendingIntent.plistFingerprint
          !== await inspectOwnerPrivateLaunchdPlist(paths.launchd.plistPath);
      } catch {
        pendingRecoveryRequiresStopStart = true;
      }
    }
    if (helper.pid !== undefined) {
      maintenanceSummary = `maintenance in progress (${pendingIntent.phase})`;
    } else {
      maintenanceSummary = "maintenance recovery required";
      maintenanceProblems.push("durable maintenance intent has no live helper");
    }
  } else if (helper.pid !== undefined) {
    maintenanceSummary = maintenanceStatus.kind === "valid" && maintenanceStatus.status.state === "running"
      ? `maintenance in progress (${maintenanceStatus.status.phase})`
      : "maintenance in progress";
  } else if (maintenanceStatus.kind === "valid") {
    if (maintenanceStatus.status.state === "failed" || maintenanceStatus.status.state === "degraded") {
      maintenanceSummary = maintenanceStatus.status.state;
      maintenanceProblems.push(maintenanceStatus.status.detail ?? "the last maintenance pass did not complete cleanly");
    }
    if ((maintenanceStatus.status.refusals?.length ?? 0) > 0) {
      maintenanceProblems.push("bounded legacy artifacts were refused and preserved");
    }
  } else if (maintenanceStatus.kind === "invalid") {
    maintenanceProblems.push("maintenance status is unreadable or unsafe");
  }
  if (monitorStatus.kind === "invalid") {
    maintenanceProblems.push("worker monitor status is unreadable or unsafe");
  } else if (monitorStatus.kind === "valid"
    && ["helper-unloaded", "request-failed", "inspection-failed"].includes(monitorStatus.status.lastOutcome)) {
    maintenanceProblems.push(`worker monitor reports ${monitorStatus.status.lastOutcome}`);
  }
  try {
    const [logs, legacy] = await Promise.all([
      inspectLaunchdLogs(paths.launchd),
      inspectLegacyManagedWebLogArtifacts(paths.launchd),
    ]);
    if (!logs.canMaintain || !legacy.canMaintain) maintenanceProblems.push("managed web log inventory is unsafe");
    else if (logs.needsMaintenance || legacy.needsMaintenance) {
      maintenanceSummary = maintenanceSummary === "idle"
        ? "due"
        : `${maintenanceSummary}; due`;
    }
  } catch {
    maintenanceProblems.push("managed web log inventory could not be inspected");
  }
  stdout.write(ui.rule("Web console status"));
  stdout.write(ui.keyValue([
    ["service", service.loaded
      ? healthState === "degraded" ? "running, push degraded" : healthy ? "running" : "loaded, not healthy"
      : "stopped"],
    ["bind", recordRead.kind === "invalid" ? "invalid service record" : `${host}:${String(port)}`],
    ["theme", recordRead.kind === "invalid" ? "invalid service record" : theme],
    ["name", recordRead.kind === "invalid"
      ? "invalid service record"
      : consoleName ?? "— (machine hostname)"],
    ["state", paths.stateDir],
    ["pid", service.pid === undefined ? "—" : String(service.pid)],
    ["log maintenance", maintenanceSummary],
    ["authentication", "none (network reachability is the boundary)"],
  ]));
  if (recordRead.kind === "invalid") stdout.write(ui.errorLine(recordRead.detail));
  else {
    printWebUrls(
      stdout,
      `http://${urlHost(host)}:${String(port)}/`,
      port,
      host,
      deps.discoverNetworkAddresses,
    );
  }
  const owned = await readTailscaleOwnership(paths.tailscalePath);
  if (owned.kind === "absent") {
    stdout.write("Tailscale HTTPS: not owned by mono-agent web.\n");
  } else if (owned.kind === "invalid") {
    stdout.write(`Tailscale HTTPS: ${owned.detail}\n`);
  } else {
    const inspection = await inspectOwnedTailscaleRoute(owned.ownership, deps);
    stdout.write(inspection.kind === "exact"
      ? `Tailscale HTTPS: ${owned.ownership.url}\n`
      : "Tailscale HTTPS: ownership record is stale or cannot be verified; existing handlers will not be changed.\n");
  }
  if (!service.loaded) stdout.write(ui.hint("Start it with: mono-agent web start"));
  else if (!healthy) stdout.write(ui.hint("Inspect: mono-agent web logs"));
  for (const problem of [...new Set(maintenanceProblems)]) stdout.write(ui.errorLine(problem));
  if (pendingIntent !== undefined && helper.pid === undefined) {
    stdout.write(pendingRecoveryRequiresStopStart
      ? ui.hint("Recover it with `mono-agent web stop`, then `mono-agent web start`; the prior stop or plist identity is unproven.")
      : ui.hint("Recover it with exactly: mono-agent web restart"));
  }
  return (strictExit && (!healthy || maintenanceProblems.length > 0)) || recordRead.kind === "invalid" ? 1 : 0;
}

async function tailWebLogs(options: RunWebCommandOptions, deps: RunWebCommandDeps): Promise<number> {
  const guard = requireDarwin(deps, "logs");
  if (guard !== undefined) return guard;
  const paths = webPaths(deps.homeDir);
  const args = [
    "-n",
    String(options.lines ?? DEFAULT_LOG_LINES),
    ...(options.follow === true ? ["-F"] : []),
    paths.launchd.stderrPath,
    paths.launchd.stdoutPath,
  ];
  return await (deps.spawnTail ?? defaultSpawnTail)(args);
}

async function resetWeb(options: RunWebCommandOptions, deps: RunWebCommandDeps): Promise<number> {
  const stderr = deps.stderr ?? process.stderr;
  const stdout = deps.stdout ?? process.stdout;
  const paths = webPaths(deps.homeDir);
  if ((deps.platform ?? process.platform) === "linux") {
    const { inspectSystemd, readSystemdDefinition, SYSTEMD_WEB_IDENTITY } = await import("./systemd.js");
    const systemdDeps = { ...deps.systemd, ...(deps.homeDir === undefined ? {} : { homeDir: deps.homeDir }) };
    const service = await inspectSystemd(SYSTEMD_WEB_IDENTITY, systemdDeps).catch(() => undefined);
    const definition = await readSystemdDefinition(SYSTEMD_WEB_IDENTITY, systemdDeps);
    if (definition !== undefined || (service?.pid ?? 0) > 0 || service?.activeState === "activating") {
      stderr.write(ui.errorLine("Run mono-agent web stop before resetting the systemd console."));
      return 1;
    }
  }
  if ((deps.platform ?? process.platform) === "darwin") {
    const launchctl = deps.launchctl ?? makeLaunchctlRunner();
    const uid = (deps.getuid ?? requiredUid)();
    const [service, helper] = await Promise.all([
      launchdServiceInfo(launchctl, WEB_LAUNCHD_LABEL, uid),
      launchdServiceInfo(launchctl, WEB_MAINTENANCE_LAUNCHD_LABEL, uid),
    ]);
    if (service.loaded || helper.loaded) {
      stderr.write(ui.errorLine("Refusing to reset while mono-agent web is running."));
      stderr.write(ui.hint("Run `mono-agent web stop`, then repeat `mono-agent web reset --all --yes`."));
      return 1;
    }
  }
  await (deps.prepareState ?? defaultPrepareWebState)({ stateDir: paths.stateDir, env: options.env });
  const release = await (deps.acquireLifecycleLock ?? acquireWebLifecycleLock)(paths);
  if (release === undefined) {
    stderr.write(ui.errorLine("Another mono-agent web lifecycle command is active."));
    return 1;
  }
  try {
    if (await readOptionalText(paths.launchd.plistPath) !== undefined
      || await readOptionalText(paths.maintenancePlistPath) !== undefined) {
      stderr.write(ui.errorLine("Refusing to reset while web LaunchAgent definitions remain installed."));
      stderr.write(ui.hint("Run `mono-agent web stop`, then repeat `mono-agent web reset --all --yes`."));
      return 1;
    }
    const tailscaleOwnershipBefore = await readOptionalText(paths.tailscalePath);
    await (deps.resetState ?? defaultResetWebState)({ stateDir: paths.stateDir, env: options.env });
    if (tailscaleOwnershipBefore !== undefined) {
      const after = await readOptionalText(paths.tailscalePath);
      if (after !== tailscaleOwnershipBefore) {
        await (deps.writePrivateFile ?? writeOwnerPrivateLaunchdFile)(paths.tailscalePath, tailscaleOwnershipBefore);
        stderr.write(ui.errorLine("Reset changed the Tailscale ownership record; it was restored so a live route cannot become unowned."));
        return 1;
      }
    }
  } catch (error) {
    stderr.write(ui.errorLine(`Could not reset the web console: ${errorMessage(error)}`));
    return 1;
  } finally {
    await release().catch(() => undefined);
  }
  stdout.write(`${ui.badge("ok")}Reset all mono-agent web conversations, messages, attachments, and settings.\n`);
  return 0;
}

async function defaultStartWebServer(options: StartWebServerOptions): Promise<WebServerHandle> {
  const web = await import(WEB_PACKAGE_NAME) as unknown as {
    startWebServer(options: StartWebServerOptions): Promise<WebServerHandle>;
  };
  return await web.startWebServer(options);
}

async function defaultResetWebState(options: ResetWebStateOptions): Promise<void> {
  const web = await import(WEB_PACKAGE_NAME) as unknown as {
    resetWebState(options: ResetWebStateOptions): Promise<void>;
  };
  await web.resetWebState(options);
}

async function defaultPrepareWebState(options: PrepareWebStateOptions): Promise<void> {
  const web = await import(WEB_PACKAGE_NAME) as unknown as {
    prepareWebState(options: PrepareWebStateOptions): Promise<void>;
  };
  await web.prepareWebState(options);
}

function effectiveHost(options: RunWebCommandOptions, priorHost?: string): string {
  return options.loopback === true ? "127.0.0.1" : options.host ?? priorHost ?? DEFAULT_WEB_HOST;
}

function isWebTheme(value: unknown): value is WebTheme {
  return typeof value === "string" && (WEB_THEMES as readonly string[]).includes(value);
}

function selectedWebTheme(value?: string, priorTheme?: WebTheme): WebTheme {
  if (value === undefined) return priorTheme ?? DEFAULT_WEB_THEME;
  return value as WebTheme;
}

/**
 * Console label precedence: this invocation's flag, then the persisted record, then
 * undefined so the worker falls back to the machine hostname.
 */
function selectedWebConsoleName(value?: string, priorName?: string): string | undefined {
  if (value === undefined) return priorName;
  return value.trim();
}

/** Reject labels the manifest, launchd argv, or launcher cannot carry faithfully. */
function invalidWebConsoleName(value: string): string | undefined {
  const name = value.trim();
  if (name.length === 0) return "--name must not be empty.";
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(name)) {
    return "--name must not contain control characters.";
  }
  if ([...name].length > WEB_CONSOLE_NAME_MAX_CHARACTERS) {
    return `--name must be at most ${String(WEB_CONSOLE_NAME_MAX_CHARACTERS)} characters.`;
  }
  return undefined;
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/u.test(value)) return value;
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

async function ensureWebDirectories(paths: WebPaths): Promise<void> {
  for (const path of [
    dirname(paths.stateDir),
    paths.stateDir,
    paths.launchd.logDir,
    paths.launchd.launchAgentsDir,
  ]) {
    await ensureOwnerPrivateLaunchdDirectory(path);
  }
}

function maintenanceInputsForRuntime(
  runtime: ManagedRuntimeResult,
  paths: WebPaths,
): WebMaintenancePublicationInputs {
  return {
    nodePath: runtime.nodePath,
    cliPath: launchdMaintenanceEntrypointPathForCli(runtime.cliPath),
    cwd: paths.stateDir,
    expectedManagedRuntimeLaunch: runtime.launchProof,
    environment: managedWebLogMaintenanceEnvironment(),
    calendarMinute: webMaintenanceCalendarMinute(),
  };
}

async function publishPairedWebPlists(
  paths: WebPaths,
  mainPlist: string,
  helperInputs: WebMaintenancePublicationInputs,
  writer: (path: string, contents: string) => Promise<void>,
): Promise<string> {
  await writer(paths.launchd.plistPath, mainPlist);
  // Every main write creates a new inode, even when bytes are identical. Read
  // the post-write composite identity before generating the paired helper.
  const mainIdentity = await inspectOwnerPrivateLaunchdPlist(paths.launchd.plistPath);
  const helperPlist = buildWebMaintenancePlistXml({
    label: WEB_MAINTENANCE_LAUNCHD_LABEL,
    ...helperInputs,
    expectedWebPlistIdentity: mainIdentity,
  });
  await writer(paths.maintenancePlistPath, helperPlist);
  const committedHelper = await readOwnerPrivateLaunchdPlist(paths.maintenancePlistPath);
  if (committedHelper.contents !== helperPlist) {
    throw new Error("The web-maintenance helper changed while paired publication was verified.");
  }
  if (await inspectOwnerPrivateLaunchdPlist(paths.launchd.plistPath) !== mainIdentity) {
    throw new Error("The main web LaunchAgent changed while its helper was paired.");
  }
  return mainIdentity;
}

async function publishHelperForExistingMain(
  paths: WebPaths,
  helperInputs: WebMaintenancePublicationInputs,
  writer: (path: string, contents: string) => Promise<void>,
): Promise<string> {
  const mainIdentity = await inspectOwnerPrivateLaunchdPlist(paths.launchd.plistPath);
  const helperPlist = buildWebMaintenancePlistXml({
    label: WEB_MAINTENANCE_LAUNCHD_LABEL,
    ...helperInputs,
    expectedWebPlistIdentity: mainIdentity,
  });
  await writer(paths.maintenancePlistPath, helperPlist);
  const committedHelper = await readOwnerPrivateLaunchdPlist(paths.maintenancePlistPath);
  if (committedHelper.contents !== helperPlist
    || await inspectOwnerPrivateLaunchdPlist(paths.launchd.plistPath) !== mainIdentity) {
    throw new Error("The existing main web LaunchAgent changed while its helper was published.");
  }
  return mainIdentity;
}

async function maintainStoppedWebLogsBeforePublication(
  paths: WebPaths,
  pending: Awaited<ReturnType<typeof readLaunchdLogMaintenanceIntent>>,
  now: () => number,
): Promise<Awaited<ReturnType<typeof readLaunchdLogMaintenanceIntent>>> {
  const mainIdentity = await inspectOwnerPrivateLaunchdPlist(paths.launchd.plistPath);
  if (pending !== undefined
    && (pending.label !== WEB_LAUNCHD_LABEL || pending.plistFingerprint !== mainIdentity)) {
    throw new Error("The pending web log-maintenance intent does not authenticate the current main plist.");
  }
  if (pending?.phase === "stopping") {
    throw new Error("The abandoned stopping intent has no complete prior PID-death proof; refusing rotation.");
  }
  if (pending?.phase === "restoring") return pending;
  const [logs, legacy] = await Promise.all([
    inspectLaunchdLogs(paths.launchd),
    inspectLegacyManagedWebLogArtifacts(paths.launchd),
  ]);
  if (!logs.canMaintain) {
    throw new Error(`Managed web log maintenance refused unsafe paths: ${logs.issues.join("; ")}`);
  }
  if (!logs.needsMaintenance && !legacy.needsMaintenance && pending === undefined) return undefined;
  let intent = pending;
  if (intent === undefined) {
    intent = {
      version: 1,
      phase: "stopping",
      label: WEB_LAUNCHD_LABEL,
      plistFingerprint: mainIdentity,
    };
    await beginLaunchdLogMaintenanceIntent(paths.launchd, intent);
    intent = await markLaunchdLogMaintenanceStopped(paths.launchd, intent);
  }
  await writeWebLogMaintenanceStatus(paths.maintenanceStatusPath, {
    version: 1,
    state: "running",
    phase: "rotating",
    updatedAt: new Date(now()).toISOString(),
  });
  const refusals = [...legacy.issues];
  if (legacy.canMaintain && legacy.needsMaintenance) {
    const maintained = await maintainLegacyManagedWebLogArtifacts(paths.launchd);
    refusals.push(...maintained.refusals);
  }
  await rotateStoppedLaunchdLogs(paths.launchd);
  if (await inspectOwnerPrivateLaunchdPlist(paths.launchd.plistPath) !== mainIdentity) {
    throw new Error("The main web LaunchAgent changed during stopped-window maintenance.");
  }
  intent = await markLaunchdLogMaintenanceRestoring(paths.launchd, intent);
  await writeWebLogMaintenanceStatus(paths.maintenanceStatusPath, {
    version: 1,
    state: refusals.length === 0 ? "running" : "degraded",
    phase: "restoring",
    updatedAt: new Date(now()).toISOString(),
    ...(refusals.length === 0 ? {} : { refusals }),
  });
  return intent;
}

async function inspectInstalledWebMaintenanceHelper(
  paths: WebPaths,
  expectedMainIdentity?: string,
  verifyEntrypoint: typeof verifyManagedRuntimeMaintenanceEntrypoint = verifyManagedRuntimeMaintenanceEntrypoint,
  loadedDefinition?: LaunchdWebMaintenanceDefinition,
  requireLoadedDefinition = false,
): Promise<WebMaintenancePublicationInputs> {
  const helper = await readOwnerPrivateLaunchdPlist(paths.maintenancePlistPath);
  const strings = plistProgramArguments(helper.contents);
  const expectedPrefix = [
    "/usr/bin/env",
    "-i",
    ...buildEnvironmentArguments(managedWebLogMaintenanceEnvironment()),
  ];
  const nodeIndex = expectedPrefix.length;
  if (strings.length !== expectedPrefix.length + 7
    || expectedPrefix.some((value, index) => strings[index] !== value)
    || strings[nodeIndex + 2] !== INTERNAL_WEB_LOG_MAINTENANCE_COMMAND
    || strings[nodeIndex + 3] !== "--expected-managed-runtime-launch"
    || strings[nodeIndex + 5] !== "--expected-web-plist-identity") {
    throw new Error("The web-maintenance helper has an unexpected private argv definition.");
  }
  const nodePath = strings[nodeIndex]!;
  const cliPath = strings[nodeIndex + 1]!;
  const expectedManagedRuntimeLaunch = strings[nodeIndex + 4]!;
  const embeddedMainIdentity = strings[nodeIndex + 6]!;
  const cwd = plistStringForKey(helper.contents, "WorkingDirectory");
  const calendarMinute = plistIntegerForKey(helper.contents, "Minute");
  const inputs: WebMaintenancePublicationInputs = {
    nodePath,
    cliPath,
    cwd,
    expectedManagedRuntimeLaunch,
    environment: managedWebLogMaintenanceEnvironment(),
    calendarMinute,
  };
  const rebuilt = buildWebMaintenancePlistXml({
    label: WEB_MAINTENANCE_LAUNCHD_LABEL,
    ...inputs,
    expectedWebPlistIdentity: embeddedMainIdentity,
  });
  if (rebuilt !== helper.contents) throw new Error("The web-maintenance helper definition is not canonical.");
  const mainIdentity = await inspectOwnerPrivateLaunchdPlist(paths.launchd.plistPath);
  if (embeddedMainIdentity !== mainIdentity
    || (expectedMainIdentity !== undefined && expectedMainIdentity !== mainIdentity)) {
    throw new Error("The web-maintenance helper does not carry the current composite main-plist identity.");
  }
  if (loadedDefinition !== undefined
    && (loadedDefinition.plistPath !== paths.maintenancePlistPath
      || loadedDefinition.nodePath !== nodePath
      || loadedDefinition.cliPath !== cliPath
      || loadedDefinition.cwd !== cwd
      || loadedDefinition.expectedManagedRuntimeLaunch !== expectedManagedRuntimeLaunch
      || loadedDefinition.expectedWebPlistIdentity !== embeddedMainIdentity)) {
    throw new Error("launchd's cached web-maintenance helper definition does not match the paired plist.");
  }
  if (loadedDefinition === undefined && requireLoadedDefinition) {
    throw new Error("launchd did not expose the cached web-maintenance helper definition.");
  }
  await verifyEntrypoint({
    currentEntrypointPath: cliPath,
    launchProof: expectedManagedRuntimeLaunch,
  });
  return inputs;
}

function plistProgramArguments(xml: string): readonly string[] {
  const array = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/u.exec(xml)?.[1];
  if (array === undefined) throw new Error("The web-maintenance helper is missing ProgramArguments.");
  return [...array.matchAll(/<string>([\s\S]*?)<\/string>/gu)].map((match) => decodeXml(match[1] ?? ""));
}

function plistStringForKey(xml: string, key: string): string {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const value = new RegExp(`<key>${escapedKey}<\\/key>\\s*<string>([\\s\\S]*?)<\\/string>`, "u").exec(xml)?.[1];
  if (value === undefined) throw new Error(`The web-maintenance helper is missing ${key}.`);
  return decodeXml(value);
}

function plistIntegerForKey(xml: string, key: string): number {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const raw = new RegExp(`<key>${escapedKey}<\\/key>\\s*<integer>([0-9]+)<\\/integer>`, "u").exec(xml)?.[1];
  const value = raw === undefined ? Number.NaN : Number(raw);
  if (!Number.isSafeInteger(value)) throw new Error(`The web-maintenance helper has an invalid ${key}.`);
  return value;
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&quot;/gu, "\"")
    .replace(/&apos;/gu, "'")
    .replace(/&amp;/gu, "&");
}

async function acquireWebLifecycleLock(paths: WebPaths): Promise<(() => Promise<void>) | undefined> {
  await ensureOwnerPrivateLaunchdDirectory(dirname(paths.stateDir));
  await ensureOwnerPrivateLaunchdDirectory(paths.stateDir);
  return await acquireFilesystemLifecycleLock({ label: WEB_LAUNCHD_LABEL, paths: paths.launchd });
}

async function stopLaunchdOnly(
  label: string,
  service: LaunchdServiceInfo,
  runner: LaunchctlRunner,
  uid: number,
  deps: RunWebCommandDeps,
): Promise<boolean> {
  const result = await bootout(runner, label, uid);
  if (result.code !== 0) return false;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolvePromise) => setTimeout(resolvePromise, ms)));
  const deadline = (deps.now ?? Date.now)() + READY_TIMEOUT_MS;
  for (;;) {
    const current = await launchdServiceInfo(runner, label, uid);
    const pidAlive = service.pid !== undefined && (deps.isAlive ?? processIsAlive)(service.pid);
    if (!current.loaded && !pidAlive) return true;
    if ((deps.now ?? Date.now)() >= deadline) return false;
    await sleep(READY_POLL_MS);
  }
}

async function restorePreviousWebService(
  snapshot: PreviousWebServiceSnapshot,
  paths: WebPaths,
  runner: LaunchctlRunner,
  uid: number,
  deps: RunWebCommandDeps,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly detail: string }> {
  try {
    const currentHelper = await launchdServiceInfo(runner, WEB_MAINTENANCE_LAUNCHD_LABEL, uid);
    if (currentHelper.loaded && !await stopLaunchdOnly(
      WEB_MAINTENANCE_LAUNCHD_LABEL,
      currentHelper,
      runner,
      uid,
      deps,
    )) {
      return { ok: false, detail: "the failed replacement helper could not be stopped" };
    }
    const current = await launchdServiceInfo(runner, WEB_LAUNCHD_LABEL, uid);
    if (current.loaded && !await stopLaunchdOnly(WEB_LAUNCHD_LABEL, current, runner, uid, deps)) {
      return { ok: false, detail: "the failed replacement worker could not be stopped" };
    }
    const writer = deps.writePrivateFile ?? writeOwnerPrivateLaunchdFile;
    if (snapshot.helperInputs === undefined) {
      return { ok: false, detail: "the prior main definition has no structured helper inputs" };
    }
    if (snapshot.recordText === undefined) await rm(paths.recordPath, { force: true });
    else await writer(paths.recordPath, snapshot.recordText);
    await publishPairedWebPlists(paths, snapshot.plist, snapshot.helperInputs, writer);
    const helperBooted = await bootstrap(runner, paths.maintenancePlistPath, uid);
    if (helperBooted.code !== 0) {
      return { ok: false, detail: commandDetail(helperBooted) || `helper launchctl bootstrap exited ${String(helperBooted.code)}` };
    }
    const booted = await bootstrap(runner, paths.launchd.plistPath, uid);
    if (booted.code !== 0) {
      return { ok: false, detail: commandDetail(booted) || `launchctl bootstrap exited ${String(booted.code)}` };
    }
    const now = deps.now ?? Date.now;
    const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolvePromise) => setTimeout(resolvePromise, ms)));
    const deadline = now() + READY_TIMEOUT_MS;
    for (;;) {
      const restored = await launchdServiceInfo(runner, WEB_LAUNCHD_LABEL, uid);
      const alive = restored.pid !== undefined && (deps.isAlive ?? processIsAlive)(restored.pid);
      const healthy = snapshot.record === undefined
        ? true
        : await (deps.healthcheck ?? webHealthcheck)(healthUrl(snapshot.record.host, snapshot.record.port));
      if (restored.loaded && alive && healthy) return { ok: true };
      if (now() >= deadline) return { ok: false, detail: "the restored LaunchAgent did not become healthy" };
      await sleep(READY_POLL_MS);
    }
  } catch (error) {
    return { ok: false, detail: errorMessage(error) };
  }
}

async function restoreWebPublication(
  paths: WebPaths,
  snapshot: WebPublicationSnapshot,
  writer: (path: string, contents: string) => Promise<void>,
): Promise<void> {
  if (snapshot.recordText === undefined) await rm(paths.recordPath, { force: true });
  else await writer(paths.recordPath, snapshot.recordText);
  if (snapshot.plist === undefined) {
    await rm(paths.maintenancePlistPath, { force: true });
    await rm(paths.launchd.plistPath, { force: true });
  } else {
    if (snapshot.helperInputs === undefined) {
      throw new Error("Cannot restore a main web plist without structured helper inputs.");
    }
    await publishPairedWebPlists(paths, snapshot.plist, snapshot.helperInputs, writer);
  }
}

async function waitForWebReady(
  host: string,
  port: number,
  launchctl: LaunchctlRunner,
  uid: number,
  deps: RunWebCommandDeps,
): Promise<boolean> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolvePromise) => setTimeout(resolvePromise, ms)));
  const healthcheck = deps.healthcheck ?? webHealthcheck;
  const deadline = now() + READY_TIMEOUT_MS;
  for (;;) {
    const service = await launchdServiceInfo(launchctl, WEB_LAUNCHD_LABEL, uid);
    if (service.loaded && service.pid !== undefined && (deps.isAlive ?? processIsAlive)(service.pid)
      && await healthcheck(healthUrl(host, port))) return true;
    if (now() >= deadline) return false;
    await sleep(READY_POLL_MS);
  }
}

function healthUrl(host: string, port: number): string {
  const checkHost = host === "0.0.0.0" || host === "::" || host === "[::]" ? "127.0.0.1" : urlHost(host);
  return `http://${checkHost}:${String(port)}/healthz`;
}

export async function webHealthcheck(url: string): Promise<boolean> {
  return (await webHealthStatus(url)) !== "unavailable";
}

async function webHealthStatus(url: string): Promise<"ok" | "degraded" | "unavailable"> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
    if (!response.ok || response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
      return "unavailable";
    }
    const body = await response.json() as unknown;
    if (!isRecord(body) || body.version !== 1) return "unavailable";
    if (hasExactKeys(body, ["status", "version", "push"])) {
      return body.status === "ok" && (body.push === "ok" || body.push === "degraded")
        ? body.push
        : "unavailable";
    }
    // Accept the pre-push health contract so a newer CLI can still manage an
    // older installed web service during upgrades.
    return hasExactKeys(body, ["status", "version"])
      && (body.status === "ok" || body.status === "degraded")
      ? body.status
      : "unavailable";
  } catch {
    return "unavailable";
  }
}

export async function ensureTailscaleServe(
  paths: WebPaths,
  bindHost: string,
  appPort: number,
  env: Record<string, string | undefined>,
  deps: RunWebCommandDeps,
  expectedDnsName?: string,
): Promise<TailscaleServeResult> {
  const runner = deps.tailscale ?? makeTailscaleRunner(env);
  const proxyTarget = tailscaleProxyTarget(bindHost, appPort);
  const ownershipRead = await readTailscaleOwnership(paths.tailscalePath);
  if (ownershipRead.kind === "invalid") {
    return { kind: "unavailable", detail: ownershipRead.detail };
  }
  let existing = ownershipRead.kind === "valid" ? ownershipRead.ownership : undefined;
  let priorMigration: { readonly ownership: TailscaleServeOwnership; readonly contents: string } | undefined;
  const failMigration = async (detail: string): Promise<TailscaleServeResult> => {
    if (priorMigration === undefined) return { kind: "unavailable", detail };
    const restored = await restorePriorTailscaleRoute(
      paths,
      priorMigration.ownership,
      priorMigration.contents,
      runner,
      deps,
    );
    return { kind: "unavailable", detail: `${detail}; ${restored}`, requiresServiceRollback: true };
  };
  if (proxyTarget === undefined) {
    return {
      kind: "unavailable",
      detail: `bind host ${bindHost} is not reachable through a loopback proxy; use --host 0.0.0.0, --host ::, or --loopback`,
    };
  }
  if (existing !== undefined) {
    const inspection = await inspectOwnedTailscaleRoute(existing, deps, runner);
    if (inspection.kind === "absent") {
      const cleared = await clearProvablyAbsentTailscaleOwnership(paths, existing, runner);
      if (cleared.kind === "unavailable") return { kind: "unavailable", detail: cleared.detail };
      existing = undefined;
    } else if (inspection.kind !== "exact") {
      return {
        kind: "unavailable",
        detail: inspection.kind === "unavailable"
          ? inspection.detail
          : "the prior Tailscale ownership record no longer matches its exact handler; refusing to overwrite it",
      };
    }
  }
  if (existing !== undefined) {
    if (expectedDnsName !== undefined && tailscaleWebHostname(existing.webKey) !== expectedDnsName) {
      return {
        kind: "unavailable",
        detail: "the owned Tailscale handler hostname does not match this node's exact DNS name; refusing to reuse or replace it",
      };
    }
    if (proxyTarget !== undefined && existing.proxyTarget === proxyTarget) {
      return { kind: "active", ownership: existing, reused: true };
    }
    if (ownershipRead.kind !== "valid") {
      return { kind: "unavailable", detail: "the prior Tailscale ownership record changed during migration; refusing to remove its handler" };
    }
    priorMigration = { ownership: existing, contents: ownershipRead.contents };
    const removed = await removeOwnedTailscaleServe(paths, { ...deps, tailscale: runner });
    if (removed.kind === "unavailable") {
      return await failMigration(`could not migrate the prior exact Tailscale handler: ${removed.detail}`);
    }
  }
  const initial = await readTailscaleServeStatus(runner);
  if (initial.kind === "error") return await failMigration(initial.detail);
  const httpsPort = chooseTailscaleHttpsPort(initial.status);
  if (httpsPort === undefined) {
    return await failMigration("ports 443 and 8443-8499 are already assigned; no handler was changed");
  }
  const configured = await runner(["serve", "--bg", `--https=${String(httpsPort)}`, proxyTarget]);
  if (configured.code !== 0) {
    return await failMigration(commandDetail(configured) || `tailscale serve exited ${String(configured.code)}`);
  }
  const [after, observedDnsName] = await Promise.all([
    readTailscaleServeStatus(runner),
    readTailscaleDnsName(runner, deps.sleep),
  ]);
  if (after.kind === "error") {
    const rollback = await rollbackJustCreatedTailscaleRoute(
      runner,
      httpsPort,
      proxyTarget,
      expectedDnsName ?? observedDnsName,
    );
    return await failMigration(`handler command succeeded but verification failed: ${after.detail}; ${rollback}`);
  }
  if (expectedDnsName !== undefined && observedDnsName !== expectedDnsName) {
    const rollback = await rollbackJustCreatedTailscaleRoute(runner, httpsPort, proxyTarget, observedDnsName);
    return await failMigration(`handler command succeeded but the node's exact Tailscale DNS name changed or became unavailable; ${rollback}`);
  }
  const dnsName = expectedDnsName ?? observedDnsName;
  const webKey = findTailscaleWebKey(after.status, httpsPort, proxyTarget, dnsName);
  if (webKey === undefined) {
    const rollback = await rollbackJustCreatedTailscaleRoute(runner, httpsPort, proxyTarget, dnsName);
    return await failMigration(`handler command succeeded but the exact proxy target could not be verified; ${rollback}`);
  }
  if (!isExactExpectedTailscaleRoute(after.status, webKey, httpsPort, proxyTarget)) {
    const rollback = await rollbackJustCreatedTailscaleRoute(runner, httpsPort, proxyTarget, dnsName);
    return await failMigration(`handler command succeeded but its TCP or Web handler set was not the exact root Proxy-only shape; ${rollback}`);
  }
  if (expectedDnsName !== undefined && tailscaleWebHostname(webKey) !== expectedDnsName) {
    const rollback = await rollbackJustCreatedTailscaleRoute(runner, httpsPort, proxyTarget, dnsName);
    return await failMigration(`handler command succeeded under an unexpected Tailscale hostname; ${rollback}`);
  }
  const hostname = webKey.slice(0, webKey.lastIndexOf(":"));
  const ownership: TailscaleServeOwnership = {
    schema: TAILSCALE_OWNERSHIP_SCHEMA,
    webKey,
    httpsPort,
    proxyTarget,
    configSha256: tailscalePortConfigSha256(after.status, webKey, httpsPort),
    url: `https://${hostname}${httpsPort === 443 ? "" : `:${String(httpsPort)}`}/`,
    configuredAt: new Date((deps.now ?? Date.now)()).toISOString(),
  };
  try {
    await (deps.writePrivateFile ?? writeOwnerPrivateLaunchdFile)(
      paths.tailscalePath,
      `${JSON.stringify(ownership, undefined, 2)}\n`,
    );
  } catch (error) {
    const rollback = await rollbackExactTailscaleRoute(runner, after.status, ownership);
    return await failMigration(`could not durably record Tailscale handler ownership: ${errorMessage(error)}; ${rollback}`);
  }
  return { kind: "active", ownership, reused: false };
}

async function restorePriorTailscaleRoute(
  paths: WebPaths,
  ownership: TailscaleServeOwnership,
  ownershipContents: string,
  runner: CommandRunner,
  deps: RunWebCommandDeps,
): Promise<string> {
  const before = await readTailscaleServeStatus(runner);
  if (before.kind === "error") return `the prior HTTPS route could not be restored because status failed: ${before.detail}`;
  const tcp = isRecord(before.status.TCP) ? before.status.TCP : {};
  if (Object.hasOwn(tcp, String(ownership.httpsPort))) {
    return "the prior HTTPS route could not be restored because its port is no longer free; its old ownership record was not republished";
  }
  const configured = await runner([
    "serve",
    "--bg",
    `--https=${String(ownership.httpsPort)}`,
    ownership.proxyTarget,
  ]);
  if (configured.code !== 0) {
    return `the prior HTTPS route could not be restored: ${commandDetail(configured) || `exit ${String(configured.code)}`}`;
  }
  const after = await readTailscaleServeStatus(runner);
  if (after.kind === "error" || !routeMatches(after.status, ownership)) {
    if (after.kind === "ok") {
      await rollbackJustCreatedTailscaleRoute(
        runner,
        ownership.httpsPort,
        ownership.proxyTarget,
        undefined,
      );
    }
    return "the prior HTTPS route command succeeded but its exact previous handler set was not restored";
  }
  try {
    await (deps.writePrivateFile ?? writeOwnerPrivateLaunchdFile)(paths.tailscalePath, ownershipContents);
  } catch (error) {
    const rollback = await rollbackExactTailscaleRoute(runner, after.status, ownership);
    return `the prior HTTPS route was recreated but ownership could not be republished (${errorMessage(error)}); ${rollback}`;
  }
  return "the prior exact HTTPS route and ownership record were restored";
}

export function tailscaleProxyTarget(bindHost: string, appPort: number): string | undefined {
  const normalized = bindHost.startsWith("[") && bindHost.endsWith("]")
    ? bindHost.slice(1, -1).toLowerCase()
    : bindHost.toLowerCase();
  if (normalized === "0.0.0.0") {
    return `http://127.0.0.1:${String(appPort)}`;
  }
  if (normalized === "::") return `http://[::1]:${String(appPort)}`;
  // Node may resolve localhost to either loopback family. Without the actual
  // bound address, publishing a numeric Serve target could point at the other
  // family. --loopback is the deterministic 127.0.0.1 spelling.
  if (normalized === "localhost") return undefined;
  if (!isLoopbackHost(normalized)) return undefined;
  return `http://${urlHost(normalized)}:${String(appPort)}`;
}

async function rollbackJustCreatedTailscaleRoute(
  runner: CommandRunner,
  httpsPort: number,
  proxyTarget: string,
  dnsName: string | undefined,
): Promise<string> {
  const current = await readTailscaleServeStatus(runner);
  if (current.kind === "error") {
    return `rollback could not verify an exact handler (${current.detail}); no unrelated handler was changed`;
  }
  const webKey = findTailscaleWebKey(current.status, httpsPort, proxyTarget, dnsName);
  if (webKey === undefined) return "no exact newly-created handler remained to remove";
  if (!isExactExpectedTailscaleRoute(current.status, webKey, httpsPort, proxyTarget)) {
    return "rollback refused because the newly-created port no longer had the exact root Proxy-only shape";
  }
  const ownership: TailscaleServeOwnership = {
    schema: TAILSCALE_OWNERSHIP_SCHEMA,
    webKey,
    httpsPort,
    proxyTarget,
    configSha256: tailscalePortConfigSha256(current.status, webKey, httpsPort),
    url: "",
    configuredAt: new Date(0).toISOString(),
  };
  return await rollbackExactTailscaleRoute(runner, current.status, ownership);
}

async function rollbackExactTailscaleRoute(
  runner: CommandRunner,
  status: Record<string, unknown>,
  ownership: TailscaleServeOwnership,
): Promise<string> {
  if (!routeMatches(status, ownership)) return "rollback refused because the handler no longer matched exactly";
  const removed = await runner(["serve", `--https=${String(ownership.httpsPort)}`, "off"]);
  return removed.code === 0
    ? "the exact newly-created handler was rolled back"
    : `rollback of the exact newly-created handler failed: ${commandDetail(removed) || `exit ${String(removed.code)}`}`;
}

export async function removeOwnedTailscaleServe(
  paths: WebPaths,
  deps: RunWebCommandDeps,
): Promise<{ readonly kind: "removed" | "absent" } | { readonly kind: "unavailable"; readonly detail: string }> {
  const ownershipRead = await readTailscaleOwnership(paths.tailscalePath);
  if (ownershipRead.kind === "absent") return { kind: "absent" };
  if (ownershipRead.kind === "invalid") return { kind: "unavailable", detail: ownershipRead.detail };
  const ownership = ownershipRead.ownership;
  const runner = deps.tailscale ?? makeTailscaleRunner(process.env);
  const inspection = await inspectOwnedTailscaleRoute(ownership, deps, runner);
  if (inspection.kind === "absent") {
    return await clearProvablyAbsentTailscaleOwnership(paths, ownership, runner);
  }
  if (inspection.kind !== "exact") {
    return { kind: "unavailable", detail: "the recorded handler no longer matches its exact host, port, and proxy target; refusing to remove it" };
  }
  const removed = await runner(["serve", `--https=${String(ownership.httpsPort)}`, "off"]);
  if (removed.code !== 0) {
    return { kind: "unavailable", detail: commandDetail(removed) || `tailscale serve off exited ${String(removed.code)}` };
  }
  const after = await readTailscaleServeStatus(runner);
  if (after.kind === "error" || routeMatches(after.status, ownership)) {
    return { kind: "unavailable", detail: after.kind === "error" ? after.detail : "the handler is still present after tailscale serve off" };
  }
  await rm(paths.tailscalePath, { force: true });
  return { kind: "removed" };
}

async function inspectOwnedTailscaleRoute(
  ownership: TailscaleServeOwnership,
  deps: RunWebCommandDeps,
  suppliedRunner?: CommandRunner,
): Promise<OwnedRouteInspection> {
  const status = await readTailscaleServeStatus(suppliedRunner ?? deps.tailscale ?? makeTailscaleRunner(process.env));
  if (status.kind === "error") return { kind: "unavailable", detail: status.detail };
  return classifyOwnedTailscaleRoute(status.status, ownership);
}

function classifyOwnedTailscaleRoute(
  status: Record<string, unknown>,
  ownership: TailscaleServeOwnership,
): OwnedRouteInspection {
  if (routeMatches(status, ownership)) return { kind: "exact" };
  const tcp = isRecord(status.TCP) ? status.TCP : {};
  const web = isRecord(status.Web) ? status.Web : {};
  if (!Object.hasOwn(tcp, String(ownership.httpsPort)) && !Object.hasOwn(web, ownership.webKey)) {
    return { kind: "absent" };
  }
  return { kind: "changed" };
}

async function clearProvablyAbsentTailscaleOwnership(
  paths: WebPaths,
  ownership: TailscaleServeOwnership,
  runner: CommandRunner,
): Promise<{ readonly kind: "absent" } | { readonly kind: "unavailable"; readonly detail: string }> {
  const confirmation = await readTailscaleServeStatus(runner);
  if (confirmation.kind === "error") return { kind: "unavailable", detail: confirmation.detail };
  if (classifyOwnedTailscaleRoute(confirmation.status, ownership).kind !== "absent") {
    return { kind: "unavailable", detail: "the recorded Tailscale handler changed while confirming its absence; ownership was preserved" };
  }
  await rm(paths.tailscalePath, { force: true });
  return { kind: "absent" };
}

type TailscaleStatusRead =
  | { readonly kind: "ok"; readonly status: Record<string, unknown> }
  | { readonly kind: "error"; readonly detail: string };

async function readTailscaleServeStatus(runner: CommandRunner): Promise<TailscaleStatusRead> {
  const result = await runner(["serve", "status", "--json"]);
  if (result.code !== 0) {
    return { kind: "error", detail: commandDetail(result) || `tailscale serve status exited ${String(result.code)}` };
  }
  try {
    const parsed = JSON.parse(result.stdout) as unknown;
    if (!isRecord(parsed)) throw new Error("expected an object");
    return { kind: "ok", status: parsed };
  } catch (error) {
    return { kind: "error", detail: `tailscale serve status returned invalid JSON: ${errorMessage(error)}` };
  }
}

export function chooseTailscaleHttpsPort(status: Record<string, unknown>): number | undefined {
  const tcp = isRecord(status.TCP) ? status.TCP : {};
  for (const port of [443, ...integerRange(TAILSCALE_FALLBACK_PORT_START, TAILSCALE_FALLBACK_PORT_END)]) {
    if (!Object.hasOwn(tcp, String(port))) return port;
  }
  return undefined;
}

function findTailscaleWebKey(
  status: Record<string, unknown>,
  port: number,
  proxyTarget: string,
  dnsName: string | undefined,
): string | undefined {
  const web = isRecord(status.Web) ? status.Web : {};
  const preferred = dnsName === undefined ? undefined : `${dnsName}:${String(port)}`;
  if (preferred !== undefined && webHandlerProxy(web[preferred]) === proxyTarget) return preferred;
  return Object.keys(web).find((key) => key.endsWith(`:${String(port)}`) && webHandlerProxy(web[key]) === proxyTarget);
}

function tailscaleWebHostname(webKey: string): string {
  return webKey.slice(0, webKey.lastIndexOf(":"));
}

function routeMatches(status: Record<string, unknown>, ownership: TailscaleServeOwnership): boolean {
  const tcp = isRecord(status.TCP) ? status.TCP : {};
  const port = tcp[String(ownership.httpsPort)];
  const web = isRecord(status.Web) ? status.Web : {};
  return isRecord(port)
    && port.HTTPS === true
    && webHandlerProxy(web[ownership.webKey]) === ownership.proxyTarget
    && tailscalePortConfigSha256(status, ownership.webKey, ownership.httpsPort) === ownership.configSha256;
}

function isExactExpectedTailscaleRoute(
  status: Record<string, unknown>,
  webKey: string,
  httpsPort: number,
  proxyTarget: string,
): boolean {
  const tcp = isRecord(status.TCP) ? status.TCP : {};
  const port = tcp[String(httpsPort)];
  const web = isRecord(status.Web) ? status.Web : {};
  const entry = web[webKey];
  if (!isRecord(port) || !hasExactKeys(port, ["HTTPS"]) || port.HTTPS !== true) return false;
  if (!isRecord(entry) || !hasExactKeys(entry, ["Handlers"]) || !isRecord(entry.Handlers)) return false;
  if (!hasExactKeys(entry.Handlers, ["/"]) || !isRecord(entry.Handlers["/"])) return false;
  return hasExactKeys(entry.Handlers["/"], ["Proxy"])
    && entry.Handlers["/"].Proxy === proxyTarget;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length && actual.every((key, index) => key === sortedExpected[index]);
}

function tailscalePortConfigSha256(status: Record<string, unknown>, webKey: string, httpsPort: number): string {
  const tcp = isRecord(status.TCP) ? status.TCP : {};
  const web = isRecord(status.Web) ? status.Web : {};
  const canonical = canonicalJson({ tcp: tcp[String(httpsPort)], web: web[webKey] });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function webHandlerProxy(value: unknown): string | undefined {
  if (!isRecord(value) || !isRecord(value.Handlers) || !isRecord(value.Handlers["/"])) return undefined;
  return typeof value.Handlers["/"].Proxy === "string" ? value.Handlers["/"].Proxy : undefined;
}

async function readTailscaleDnsName(
  runner: CommandRunner,
  suppliedSleep?: (ms: number) => Promise<void>,
): Promise<string | undefined> {
  const sleep = suppliedSleep ?? ((ms: number) => new Promise<void>((resolvePromise) => setTimeout(resolvePromise, ms)));
  for (let attempt = 0; attempt < TAILSCALE_STATUS_ATTEMPTS; attempt += 1) {
    const result = await runner(["status", "--json"]);
    if (result.code === 0) {
      try {
        const parsed = JSON.parse(result.stdout) as unknown;
        if (isRecord(parsed) && isRecord(parsed.Self) && typeof parsed.Self.DNSName === "string") {
          return parsed.Self.DNSName.replace(/\.$/u, "").toLowerCase();
        }
      } catch {
        // A transiently truncated LocalAPI response is retried below.
      }
    }
    if (attempt + 1 < TAILSCALE_STATUS_ATTEMPTS) await sleep(TAILSCALE_STATUS_RETRY_MS);
  }
  return undefined;
}

function makeTailscaleRunner(env: Record<string, string | undefined>): CommandRunner {
  return (args) => spawnCapture("tailscale", args, env);
}

function spawnCapture(command: string, args: readonly string[], env: Record<string, string | undefined>): Promise<CommandResult> {
  return new Promise((resolvePromise) => {
    const child = spawn(command, [...args], { stdio: ["ignore", "pipe", "pipe"], env: env as NodeJS.ProcessEnv });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", (error) => resolvePromise({ code: 127, stdout, stderr: `${stderr}${error.message}` }));
    child.on("close", (code) => resolvePromise({ code: code ?? 1, stdout, stderr }));
  });
}

async function readServiceRecord(path: string): Promise<WebServiceRecordRead> {
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return { kind: "absent" };
    return { kind: "invalid", detail: "the web service record is unreadable; repair or remove ~/.mono-agent/web/service.json" };
  }
  let value: unknown;
  try {
    value = JSON.parse(contents) as unknown;
  } catch {
    return { kind: "invalid", detail: "the web service record is malformed; repair or remove ~/.mono-agent/web/service.json" };
  }
  if (!isRecord(value) || value.schema !== WEB_SERVICE_SCHEMA || typeof value.host !== "string"
    || !Number.isSafeInteger(value.port) || (value.port as number) < 1 || (value.port as number) > 65_535
    || (value.theme !== undefined && !isWebTheme(value.theme))
    || (value.name !== undefined
      && (typeof value.name !== "string" || invalidWebConsoleName(value.name) !== undefined))
    || typeof value.updatedAt !== "string") {
    return { kind: "invalid", detail: "the web service record has an invalid schema; repair or remove ~/.mono-agent/web/service.json" };
  }
  return { kind: "valid", record: value as unknown as WebServiceRecord, contents };
}

async function readTailscaleOwnership(path: string): Promise<TailscaleOwnershipRead> {
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return { kind: "absent" };
    return { kind: "invalid", detail: "the Tailscale ownership record is unreadable; refusing to change any Serve handler" };
  }
  let value: unknown;
  try {
    value = JSON.parse(contents) as unknown;
  } catch {
    return { kind: "invalid", detail: "the Tailscale ownership record is malformed; refusing to change any Serve handler" };
  }
  if (!isRecord(value) || value.schema !== TAILSCALE_OWNERSHIP_SCHEMA
    || typeof value.webKey !== "string" || typeof value.proxyTarget !== "string" || typeof value.url !== "string"
    || typeof value.configSha256 !== "string" || !/^[0-9a-f]{64}$/u.test(value.configSha256)
    || typeof value.configuredAt !== "string" || !Number.isSafeInteger(value.httpsPort)
    || (value.httpsPort as number) < 1 || (value.httpsPort as number) > 65_535) {
    return { kind: "invalid", detail: "the Tailscale ownership record has an invalid schema; refusing to change any Serve handler" };
  }
  return { kind: "valid", ownership: value as unknown as TailscaleServeOwnership, contents };
}

async function readOptionalText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
}

function requireDarwin(deps: RunWebCommandDeps, action: string): number | undefined {
  if ((deps.platform ?? process.platform) === "darwin") return undefined;
  (deps.stderr ?? process.stderr).write(ui.errorLine(
    `mono-agent web ${action} background management requires macOS launchd; use mono-agent web run on this platform.`,
  ));
  return 1;
}

function requiredUid(): number {
  if (typeof process.getuid !== "function") throw new Error("launchd requires a numeric user id");
  return process.getuid();
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isRecord(error) && error.code === "EPERM";
  }
}

function waitForShutdownSignal(): Promise<void> {
  return new Promise((resolvePromise) => {
    const done = () => {
      process.off("SIGINT", done);
      process.off("SIGTERM", done);
      resolvePromise();
    };
    process.once("SIGINT", done);
    process.once("SIGTERM", done);
  });
}

function defaultSpawnTail(args: readonly string[]): Promise<number> {
  return new Promise((resolvePromise) => {
    const child = spawn("tail", [...args], { stdio: "inherit" });
    child.on("error", () => resolvePromise(127));
    child.on("close", (code) => resolvePromise(code ?? 0));
  });
}

function printWebUrls(
  stdout: { write(text: string): void },
  serverUrl: string,
  port: number,
  host: string,
  discover?: () => readonly string[],
): void {
  if (host === "0.0.0.0" || host === "::" || host === "[::]") {
    const ipv6Bind = host === "::" || host === "[::]";
    stdout.write(`Local      → http://${ipv6Bind ? "[::1]" : "127.0.0.1"}:${String(port)}/\n`);
    for (const address of advertisableNetworkAddresses((discover ?? discoverNetworkAddresses)())
      .filter((candidate) => candidate.includes(":") === ipv6Bind)) {
      const label = isTailscaleAddress(address) ? "Tailscale" : "LAN";
      stdout.write(`${label.padEnd(10)} → http://${urlHost(address)}:${String(port)}/\n`);
    }
    return;
  }
  stdout.write(`Web        → ${serverUrl.endsWith("/") ? serverUrl : `${serverUrl}/`}\n`);
}

function isTailscaleAddress(address: string): boolean {
  const normalized = normalizeNetworkAddress(address);
  if (normalized.split("%", 1)[0]?.startsWith("fd7a:115c:a1e0:")) return true;
  const match = /^(\d{1,3})\.(\d{1,3})\./u.exec(normalized);
  if (match?.[1] !== "100" || match[2] === undefined) return false;
  const second = Number(match[2]);
  return second >= 64 && second <= 127;
}

function discoverNetworkAddresses(): readonly string[] {
  const addresses: string[] = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (!entry.internal && (entry.family === "IPv4" || entry.family === "IPv6")) addresses.push(entry.address);
    }
  }
  return advertisableNetworkAddresses(addresses);
}

function advertisableNetworkAddresses(addresses: readonly string[]): readonly string[] {
  return [...new Set(addresses.map(normalizeNetworkAddress).filter(isAdvertisableNetworkAddress))]
    .sort((left, right) => left.localeCompare(right, "en", { numeric: true, sensitivity: "base" }));
}

function normalizeNetworkAddress(address: string): string {
  const unbracketed = address.startsWith("[") && address.endsWith("]") ? address.slice(1, -1) : address;
  return unbracketed.toLowerCase();
}

function mergeWebAllowedHosts(configured: string | undefined, tailscaleDnsName: string | undefined): string | undefined {
  const hosts = [
    ...(configured?.split(",") ?? []),
    ...(tailscaleDnsName === undefined ? [] : [tailscaleDnsName]),
  ].map((host) => host.trim()).filter((host) => host.length > 0);
  const merged = [...new Set(hosts)].join(",");
  return merged.length === 0 ? undefined : merged;
}

function isAdvertisableNetworkAddress(address: string): boolean {
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(address);
  if (ipv4 !== null) {
    const octets = ipv4.slice(1).map(Number);
    if (octets.some((value) => value > 255)) return false;
    const [first = -1, second = -1] = octets;
    return first === 10
      || (first === 172 && second >= 16 && second <= 31)
      || (first === 192 && second === 168)
      || (first === 100 && second >= 64 && second <= 127)
      || (first === 169 && second === 254);
  }
  const [literal = ""] = address.split("%", 2);
  const firstHextet = Number.parseInt(literal.split(":", 1)[0] ?? "", 16);
  if (!Number.isFinite(firstHextet)) return false;
  // Browser URL implementations do not consistently support IPv6 zone IDs,
  // so even scoped link-local literals are not advertised as concrete links.
  return (firstHextet & 0xfe00) === 0xfc00;
}

function urlHost(host: string): string {
  const normalized = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  return normalized.includes(":") ? `[${normalized.replace("%", "%25")}]` : normalized;
}

function commandDetail(result: CommandResult): string {
  return (result.stderr || result.stdout).trim();
}

function writeCommandDetail(stream: { write(text: string): void }, result: CommandResult): void {
  const detail = commandDetail(result);
  if (detail.length > 0) stream.write(ui.style.dim(detail) + "\n");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function integerRange(start: number, end: number): number[] {
  return Array.from({ length: end - start + 1 }, (_, index) => start + index);
}
