import { webHealthcheck } from "./health.js";
import { formatManagedRuntimeProgress } from "../../managed-runtime-progress.js";
import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { dirname } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { pruneTraceSources } from "@mono-agent/observability";
import type { WebTheme } from "@mono-agent/web";

import {
  DEFAULT_WEB_HOST,
  DEFAULT_WEB_PORT,
  DEFAULT_WEB_THEME,
} from "../../web-service-definition.js";
import { resolveGlobalTraceRegistryDir } from "../../composition/app-config.js";
import { acquireFilesystemLifecycleLock } from "../../launchd-lifecycle-lock.js";
import { ensureOwnerPrivateLaunchdDirectory } from "../../launchd-private-files.js";
import { inspectOwnerPrivateLaunchdPlist, readOwnerPrivateLaunchdPlist, writeOwnerPrivateLaunchdFile } from "../launchd/plist-files.js";
import { selectBackgroundOperationalEnvironment } from "../../background-environment.js";
import { ensureManagedBackgroundRuntime } from "../../background-runtime.js";
import {
  bootout,
  bootstrap,
  buildWebMaintenancePlistXml,
  buildWebPlistXml,
  defaultPathEnv,
  launchdMaintenanceEntrypointPathForCli,
  launchdServiceInfo,
  launchdWebMaintenanceInfo,
  makeLaunchctlRunner,
  WEB_LAUNCHD_LABEL,
  WEB_MAINTENANCE_LAUNCHD_LABEL,
  webMaintenanceCalendarMinute,
} from "../../launchd.js";
import type { LaunchctlRunner, LaunchdServiceInfo } from "../../launchd.js";
import {
  beginLaunchdLogMaintenanceIntent,
  clearLaunchdLogMaintenanceIntent,
  inspectLaunchdLogs,
  markLaunchdLogMaintenanceRestoring,
  markLaunchdLogMaintenanceStopped,
  readLaunchdLogMaintenanceIntent,
  rotateStoppedLaunchdLogs,
} from "../../launchd-logs.js";
import {
  inspectLegacyManagedWebLogArtifacts,
  maintainLegacyManagedWebLogArtifacts,
  startManagedWebLogMonitor,
} from "../../managed-web-logs.js";
import { managedWebLogMaintenanceEnvironment } from "../../managed-web-maintenance-environment.js";
import { managedWebPaths } from "../../web-maintenance-paths.js";
import type { ManagedWebPaths } from "../../web-maintenance-paths.js";
import {
  readWebLogMaintenanceStatus,
  writeWebLogMaintenanceStatus,
  writeWebLogMonitorStatus,
} from "../../web-log-maintenance-status.js";
import { healthUrl, inspectInstalledWebMaintenanceHelper, installedWebDefinition, requiredUid } from "./inspection.js";
import { commandDetail, errorMessage, printWebUrls, sharingAttemptDescription, shellQuote, urlHost, writeCommandDetail } from "./presentation.js";
import { isRecord, readOptionalText, readServiceRecord } from "./record.js";
import { statusWeb } from "./status.js";
import { ensureTailscaleServe, makeTailscaleRunner, readTailscaleDnsName, readTailscaleOwnership, removeOwnedTailscaleServe, tailscaleWebHostname } from "./tailscale.js";
import { WEB_SERVICE_SCHEMA } from "./types.js";
import type {
  ManagedRuntimeResult,
  PrepareWebStateOptions,
  PreviousWebServiceSnapshot,
  ResetWebStateOptions,
  RunWebCommandDeps,
  RunWebCommandOptions,
  StartWebServerOptions,
  TailscaleServeResult,
  WebMaintenancePublicationInputs,
  WebPublicationSnapshot,
  WebServerHandle,
  WebServiceRecord,
} from "./types.js";
import * as ui from "../../ui.js";
// Deliberately outside `com.mono-agent.*`: fleet discovery reserves that prefix
// for configured agent instances.
const MANAGED_WEB_WORKER_ENV = "MONO_AGENT_MANAGED_WEB_WORKER";
const DEFAULT_LOG_LINES = 200;
const READY_TIMEOUT_MS = 15_000;
const READY_POLL_MS = 200;
const WEB_PACKAGE_NAME = "@mono-agent/web";

export async function runWebForeground(options: RunWebCommandOptions, deps: RunWebCommandDeps): Promise<number> {
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  const host = effectiveHost(options);
  const port = options.port ?? DEFAULT_WEB_PORT;
  const theme = selectedWebTheme(options.theme);
  const consoleName = selectedWebConsoleName(options.name);
  const paths = managedWebPaths(deps.homeDir);
  await (deps.prepareState ?? defaultPrepareWebState)({ stateDir: paths.stateDir, env: options.env });
  const registryDir = resolveGlobalTraceRegistryDir(options.env);
  await pruneTraceSources({ registryDir });
  let handle: WebServerHandle;
  try {
    const startServer = deps.startServer ?? defaultStartWebServer;
    handle = await startServer({
      host,
      port,
      theme,
      ...(consoleName === undefined ? {} : { name: consoleName }),
      registryDirs: [registryDir],
      stateDir: paths.stateDir,
      env: options.env,
    });
  } catch (error) {
    const detail = errorMessage(error);
    stderr.write(ui.errorLine(`mono-agent web failed to start: ${detail}`));
    if (/EADDRINUSE|address already in use/iu.test(detail)) {
      stderr.write(ui.hint(
        `Port ${String(port)} is already in use. Inspect the managed console with \`mono-agent web\`, or retry with --port <n>.`,
      ));
    }
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

export async function startWebBackground(
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
  const paths = managedWebPaths(deps.homeDir);
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
      if (options.shareTailnet === true) {
        stderr.write(ui.errorLine(
          "mono-agent web is already managed by launchd; use `mono-agent web restart --share-tailnet` to publish its owned Tailscale route.",
        ));
        return 1;
      }
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
          const currentCliPath = fileURLToPath(new URL("../../cli.js", import.meta.url));
          const runtime = await (deps.ensureManagedRuntime ?? ((input) => ensureManagedBackgroundRuntime(input)))({
            currentCliPath,
            nodePath: process.execPath,
            onProgress: (progress) => stdout.write(ui.hint(formatManagedRuntimeProgress(progress))),
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
    // Validate a persisted definition BEFORE installing a runtime, stopping a
    // loaded helper, or publishing anything: an unreadable or foreign
    // definition must fail with nothing changed rather than after mutation.
    const priorRecord = recordRead.kind === "valid" ? recordRead.record : undefined;
    const priorDefinition = priorRecord === undefined && existingPlist !== undefined
      ? installedWebDefinition(existingPlist)
      : undefined;
    if (priorRecord === undefined && existingPlist !== undefined && priorDefinition === undefined) {
      return await fail(
        "Refusing to start because the existing web LaunchAgent definition could not be validated; its recorded bind was preserved and nothing was changed",
      );
    }
    const prior = priorRecord ?? priorDefinition;
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
    const currentCliPath = fileURLToPath(new URL("../../cli.js", import.meta.url));
    let runtime: ManagedRuntimeResult;
    try {
      runtime = await (deps.ensureManagedRuntime ?? ((input) => ensureManagedBackgroundRuntime(input)))({
        currentCliPath,
        nodePath: process.execPath,
        onProgress: (progress) => stdout.write(ui.hint(formatManagedRuntimeProgress(progress))),
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

    const host = effectiveHost(options, prior?.host);
    const port = options.port ?? prior?.port ?? DEFAULT_WEB_PORT;
    const theme = selectedWebTheme(options.theme, prior?.theme);
    const consoleName = selectedWebConsoleName(options.name, prior?.name);
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
    // New route creation is explicit-only (`--share-tailnet`). An existing exact
    // owned route — or an ownership record we must truthfully report as
    // unverifiable — is always inspected, so a restart keeps or diagnoses the
    // route the install actually has. A pristine unshared start never runs the
    // Tailscale CLI at all.
    const inspectTailscale = options.shareTailnet === true || priorTailscaleOwnership.kind !== "absent";
    // A healthy existing Serve route must keep working through a transient
    // LocalAPI outage during restart. The owner-private, exact-route record is
    // re-verified by ensureTailscaleServe after the replacement worker starts.
    const tailscaleDnsName = inspectTailscale
      ? await readTailscaleDnsName(tailscaleRunner, deps.sleep) ?? recordedTailscaleDnsName
      : undefined;
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

    const tailscale: TailscaleServeResult = !inspectTailscale
      ? { kind: "not-requested" }
      : priorTailscaleOwnership.kind === "invalid"
        ? await ensureTailscaleServe(
            paths,
            host,
            port,
            options.env,
            { ...deps, tailscale: tailscaleRunner },
            undefined,
            options.shareTailnet === true,
          )
        : tailscaleDnsName === undefined
          ? {
              kind: "unavailable",
              detail: "the node's exact Tailscale DNS name could not be resolved; no Serve handler was changed",
              routeOutcome: "none",
            }
          : await ensureTailscaleServe(
              paths,
              host,
              port,
              options.env,
              { ...deps, tailscale: tailscaleRunner },
              tailscaleDnsName,
              options.shareTailnet === true,
            );
    if (tailscale.kind === "unavailable" && tailscale.requiresServiceRollback === true) {
      const routeState = tailscale.priorRouteRestored !== true
        ? "the prior owned route could not be confirmed restored; inspect `tailscale serve status` before retrying"
        : tailscale.replacementHandlerRemoved === false
          ? `the prior owned route was restored, but the replacement handler may remain${sharingAttemptDescription(tailscale)}; inspect \`tailscale serve status\` before retrying`
          : "the prior owned route was restored";
      return await fail(
        `Tailscale route migration failed and the replacement web worker cannot remain active (${routeState}): ${tailscale.detail}`,
      );
    }

    stdout.write(`${ui.badge("ok")}${ui.style.bold(restart ? "Restarted mono-agent web" : "Started mono-agent web")}\n`);
    printWebUrls(stdout, `http://${urlHost(host)}:${String(port)}/`, port, host, deps.discoverNetworkAddresses);
    stdout.write("No app authentication is enabled; anyone who can reach this port can operate discovered agents.\n");

    if (tailscale.kind === "active") {
      stdout.write(`mono-agent-owned Tailscale route: ${tailscale.ownership.url}${tailscale.reused ? " (existing owned handler)" : ""}\n`);
      stdout.write(ui.style.dim("Other proxies and routes are not inspected.\n"));
    } else if (tailscale.kind === "not-requested") {
      stdout.write("mono-agent-owned Tailscale route: none (other proxies and routes are not inspected).\n");
      if (options.shareTailnet !== true) {
        stdout.write(ui.hint("Publish this console on your tailnet with: mono-agent web restart --share-tailnet\n"));
      }
    } else if (options.shareTailnet === true) {
      // An explicit sharing request must never look successful when it failed,
      // and it must never claim a route is absent unless the structured cleanup
      // evidence actually proves that.
      stderr.write(ui.errorLine(`Sharing failed: ${tailscale.detail}`));
      const listener = `The local console is running at http://${urlHost(host)}:${String(port)}/.`;
      const target = sharingAttemptDescription(tailscale);
      const outcome = tailscale.routeOutcome ?? "uncertain";
      if (outcome === "none") {
        stderr.write(ui.style.yellow(
          `${listener} No Tailscale handler was changed by this command.${target}\n`,
        ));
      } else if (outcome === "rolled-back") {
        stderr.write(ui.style.yellow(
          `${listener} The newly created Tailscale handler was rolled back; no mono-agent-owned route remains.${target}\n`,
        ));
      } else if (outcome === "restored") {
        stderr.write(ui.style.yellow(
          `${listener} The previously owned Tailscale route was restored.${target}\n`,
        ));
      } else {
        stderr.write(ui.style.yellow(
          `${listener} A Tailscale handler may remain: inspect \`tailscale serve status\`${target} and remove only the handler ` +
          "this command created (`mono-agent web stop` removes only a route it provably owns).\n",
        ));
      }
      return 1;
    } else {
      stderr.write(ui.style.yellow(`⚠ Tailscale Serve was not configured: ${tailscale.detail}\n`));
      if (tailscale.routeOutcome === "uncertain") {
        stderr.write(ui.style.yellow(
          `⚠ A Tailscale handler may remain: inspect \`tailscale serve status\`${sharingAttemptDescription(tailscale)}.\n`,
        ));
      }
      stderr.write(ui.hint(`The console remains reachable on ${host}:${String(port)}. Resolve Tailscale, then run mono-agent web restart --share-tailnet.\n`));
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

export async function stopWebBackground(options: RunWebCommandOptions, deps: RunWebCommandDeps): Promise<number> {
  const guard = requireDarwin(deps, "stop");
  if (guard !== undefined) return guard;
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  const launchctl = deps.launchctl ?? makeLaunchctlRunner();
  const uid = (deps.getuid ?? requiredUid)();
  const paths = managedWebPaths(deps.homeDir);
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

export async function tailWebLogs(options: RunWebCommandOptions, deps: RunWebCommandDeps): Promise<number> {
  const guard = requireDarwin(deps, "logs");
  if (guard !== undefined) return guard;
  const paths = managedWebPaths(deps.homeDir);
  const args = [
    "-n",
    String(options.lines ?? DEFAULT_LOG_LINES),
    ...(options.follow === true ? ["-F"] : []),
    paths.launchd.stderrPath,
    paths.launchd.stdoutPath,
  ];
  return await (deps.spawnTail ?? defaultSpawnTail)(args);
}

export async function resetWeb(options: RunWebCommandOptions, deps: RunWebCommandDeps): Promise<number> {
  const stderr = deps.stderr ?? process.stderr;
  const stdout = deps.stdout ?? process.stdout;
  const paths = managedWebPaths(deps.homeDir);
  if ((deps.platform ?? process.platform) === "linux") {
    const { inspectSystemd, readSystemdDefinition, SYSTEMD_WEB_IDENTITY } = await import("../../systemd.js");
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

function selectedWebTheme(value?: string, priorTheme?: WebTheme): WebTheme {
  if (value === undefined) return priorTheme ?? DEFAULT_WEB_THEME;
  return value as WebTheme;
}

/**
 * Console label precedence: this invocation's flag, then the persisted record, then
 * undefined so the worker falls back to the machine hostname. A single hyphen resets
 * the persisted choice to that fallback.
 */
function selectedWebConsoleName(value?: string, priorName?: string): string | undefined {
  if (value === undefined) return priorName;
  const name = value.trim();
  return name === "-" ? undefined : name;
}

async function ensureWebDirectories(paths: ManagedWebPaths): Promise<void> {
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
  paths: ManagedWebPaths,
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
  paths: ManagedWebPaths,
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
  paths: ManagedWebPaths,
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
  paths: ManagedWebPaths,
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

async function acquireWebLifecycleLock(paths: ManagedWebPaths): Promise<(() => Promise<void>) | undefined> {
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
  paths: ManagedWebPaths,
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
  paths: ManagedWebPaths,
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

function requireDarwin(deps: RunWebCommandDeps, action: string): number | undefined {
  if ((deps.platform ?? process.platform) === "darwin") return undefined;
  (deps.stderr ?? process.stderr).write(ui.errorLine(
    `mono-agent web ${action} background management requires macOS launchd; use mono-agent web run on this platform.`,
  ));
  return 1;
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

function mergeWebAllowedHosts(configured: string | undefined, tailscaleDnsName: string | undefined): string | undefined {
  const hosts = [
    ...(configured?.split(",") ?? []),
    ...(tailscaleDnsName === undefined ? [] : [tailscaleDnsName]),
  ].map((host) => host.trim()).filter((host) => host.length > 0);
  const merged = [...new Set(hosts)].join(",");
  return merged.length === 0 ? undefined : merged;
}
