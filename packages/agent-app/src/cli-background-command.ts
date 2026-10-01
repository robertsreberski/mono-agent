import { WorkerActivityTracker } from "./worker-activity.js";
import { publishWorkerActivity } from "./worker-activity-snapshot.js";
import { readLaunchdMaintenanceActivityStatus } from "./launchd-maintenance-activity.js";
import { stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { listRecordedRuns } from "@mono-agent/observability";
import type { TuiRestartAuthority } from "@mono-agent/operator-adapter";
import { createSupervisedRestartLatch, type SupervisedRestartLatch } from "./supervised-restart-latch.js";
import type { PreparedSupervisedRestartInputs } from "./supervised-restart.js";
import { acquireFilesystemLifecycleLock } from "./launchd-lifecycle-lock.js";
import { resolveConfiguredManagedRuntimePackages } from "./managed-runtime-packages.js";
import { resolveApprovedBackgroundSnapshot, stageApprovedBackgroundSnapshot, type ApprovedBackgroundSnapshotBinding } from "./approved-background-snapshot.js";
import { createSupervisedRestartAuthority } from "./supervised-restart-authority.js";
import {
  sandboxEffectiveStateWarning,
} from "@mono-agent/runtime-adapter";

import { startMonoAgentApp } from "./app.js";
import type { MonoAgentApp, SandboxStatus } from "./app.js";
import { startVerifiedManagedMonoAgentApp } from "./app-controller.js";
import {
  acquireBackgroundWorkerLease,
  canonicalBackgroundConfigPath,
  defaultBackgroundDeps,
  forceRestartBackground,
  maintainLaunchdController,
  managedBackgroundEnvironment,
  resolveInstanceTarget,
  restartBackground,
  startBackground,
  statusBackground,
  stopBackground,
  tailLogs,
} from "./background.js";
import type { BackgroundDeps, InstanceTarget } from "./background.js";
import type { LaunchdMaintenanceCommandArgs } from "./launchd-maintenance-command.js";
import {
  assertLaunchdMaintenanceLifecycleLease,
  withLaunchdMaintenanceControllerLock,
} from "./launchd-maintenance-gate.js";
import type { LaunchdMaintenanceLifecycleLease } from "./launchd-maintenance-gate.js";
import {
  captureBackgroundSnapshot,
  captureDurableBackgroundInputs,
  decodeBackgroundSnapshot,
  loadDurableBackgroundEnvironment,
  materializeBackgroundRuntimeInputs,
  sameBackgroundSnapshot,
} from "./background-snapshot.js";
import type { BackgroundSnapshot } from "./background-snapshot.js";
import { verifyManagedRuntimeLaunch } from "./background-runtime.js";
import type { ManagedRuntimeLaunchVerification } from "./background-runtime.js";
import { startManagedLaunchdLogMonitor } from "./background-log-maintenance.js";
import type {
  ManagedLaunchdLogMonitor,
  ManagedLaunchdLogMonitorDependencies,
} from "./background-log-maintenance.js";
import { writeLaunchdLogMonitorStatus } from "./launchd-log-monitor-status.js";
import { clearLaunchdSnapshotRefusal, writeLaunchdSnapshotRefusal } from "./launchd-snapshot-refusal.js";
import { selectBackgroundOperationalEnvironment, selectSystemdBackgroundOperationalEnvironment } from "./background-environment.js";
import { formatChannelFactValue } from "./channel-fact-format.js";
import { formatHumanChannelSections } from "./channel-status-display.js";
import type { ChannelStatus } from "./channels.js";
import { loadCliEnvFile } from "./cli-args.js";
import type { ParsedCliArgs } from "./cli-args.js";
import { validateMonoAgentFolder } from "./doctor.js";
import type {
  ValidationReport,
  ValidationSection,
  ValidationStatus,
} from "./doctor.js";
import { readCliConfigSnapshot } from "./first-run-readiness.js";
import { buildRunsHealthDisplay, RUNS_HEALTH_MAX_RUNS } from "./runs-health.js";
import { purgeConversationState, type PurgeConversationStateResult } from "./sessions.js";
import { deriveLaunchdLabel, launchdManagedWorkerInfo, launchdPathsFor, makeLaunchctlRunner } from "./launchd.js";
import { waitForManagedRuntimePublication } from "./managed-runtime-publication.js";
import * as ui from "./ui.js";

const DEFAULT_LOG_LINES = 200;
// Node's maximum setInterval/setTimeout delay (2^31 - 1 ms, ~24.8 days).
const KEEP_ALIVE_INTERVAL_MS = 2_147_483_647;
const BACKGROUND_COMMANDS = ["start", "restart", "stop", "status", "logs"] as const;

function formatSection(section: ValidationSection): string {
  let out = `${ui.badge(section.status)}${ui.style.bold(section.label)}\n`;
  for (const detail of section.details) {
    out += `    ${colorDetail(section.status, detail)}\n`;
  }
  return out;
}

function colorDetail(status: ValidationStatus, detail: string): string {
  if (status === "error") return ui.style.red(detail);
  if (detail.startsWith("[WARN]") || detail.startsWith("WARNING:")) {
    return ui.style.yellow(detail);
  }
  return ui.style.dim(detail);
}

/**
 * Outcome of the start/restart preflight. `code` is the process exit status to
 * return when refusing: 2 for a missing config file (a usage problem, matching
 * the arg-parse convention) and 1 for a config that loads but has errors.
 */
export type PreflightResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: 2; readonly kind: "missing-config"; readonly configPath: string }
  | { readonly ok: false; readonly code: 1; readonly kind: "validation"; readonly report: ValidationReport };

type PreflightFailure = Extract<PreflightResult, { ok: false }>;

/**
 * Gate for `start`/`restart`: refuse unless the directory has a present, valid
 * config. First the config FILE must exist (env vars alone are not enough — a
 * folder without a config is not a configured agent). Then run the structural
 * validation with `liveness:false` (network probes only yield `waiting`, never
 * `error`, so skipping them keeps the verdict while avoiding bounded network
 * timeouts) and refuse on any `error` section. `waiting` (e.g. Ollama not up yet) is runtime-soft and never blocks.
 */
export async function ensureStartable(
  args: Pick<ParsedCliArgs, "configPath">,
  env: Record<string, string | undefined> = process.env,
  options: {
    readonly cwd?: string;
    readonly configPath?: string;
    readonly preferAppPluginInstall?: boolean;
    readonly verifiedRuntimeProvenanceDetail?: string;
  } = {},
): Promise<PreflightResult> {
  const cwd = options.cwd ?? process.cwd();
  const configPath = options.configPath ?? resolve(cwd, args.configPath ?? "mono-agent.config.json");
  if (!(await pathExists(configPath))) {
    return { ok: false, code: 2, kind: "missing-config", configPath };
  }
  const report = await validateMonoAgentFolder({
    env,
    cwd,
    configPath,
    liveness: false,
    ignoreDuplicateKeys: true,
    ...(options.preferAppPluginInstall === true ? { preferAppPluginInstall: true } : {}),
    ...(options.verifiedRuntimeProvenanceDetail === undefined
      ? {}
      : { verifiedRuntimeProvenanceDetail: options.verifiedRuntimeProvenanceDetail }),
  });
  if (!report.structurallyValid) {
    return { ok: false, code: 1, kind: "validation", report };
  }
  return { ok: true };
}

function printPreflightFailure(result: PreflightFailure): void {
  if (result.kind === "missing-config") {
    process.stderr.write(ui.errorLine(`No mono-agent config found at ${result.configPath}.`));
    process.stderr.write(ui.hint("Run `mono-agent init` to scaffold one, or pass --config <path>."));
    return;
  }
  process.stderr.write(ui.heading("Cannot start: config has errors"));
  for (const section of result.report.sections) {
    if (section.status === "error") {
      process.stderr.write(formatSection(section));
    }
  }
  process.stderr.write(ui.hint("Run `mono-agent validate` for the full report, fix the errors, then retry."));
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function runStart(
  args: ParsedCliArgs,
  env?: Record<string, string | undefined>,
  managedBackgroundWorker = false,
  systemdBackgroundWorker = false,
): Promise<number> {
  if (args.foreground) {
    return await runForeground(args, env, managedBackgroundWorker, systemdBackgroundWorker);
  }
  return await runBackgroundCommand(args, "start", env);
}

/** Decode the secret-free worker transport and bind it to this exact invocation. */
export function decodeAndVerifyWorkerSnapshot(
  args: Pick<ParsedCliArgs, "envFile" | "expectedBackgroundSnapshot">,
  cwd: string,
  configPath: string,
): BackgroundSnapshot {
  if (args.expectedBackgroundSnapshot === undefined) {
    throw new Error("The worker is missing its approved background snapshot.");
  }
  const snapshot = decodeBackgroundSnapshot(args.expectedBackgroundSnapshot);
  const dotenvPath = resolve(cwd, args.envFile ?? ".env");
  if (snapshot.configPath !== configPath || snapshot.dotenvPath !== dotenvPath) {
    throw new Error("The approved snapshot paths do not match the worker arguments.");
  }
  return snapshot;
}

export async function recordManagedSnapshotRefusal(
  configPath: string,
  target = launchdPathsFor(deriveLaunchdLabel(configPath)),
): Promise<void> {
  const label = deriveLaunchdLabel(configPath);
  await writeLaunchdSnapshotRefusal(label, target).catch((error) => {
    process.stderr.write(ui.errorLine(`Could not publish managed snapshot refusal status: ${error instanceof Error ? error.message : String(error)}`));
  });
}

const INPUT_VALIDATION_REFUSAL = "Startup config is invalid or unreadable. Run `mono-agent validate` from its folder; the old worker is still serving.";
const CLOSURE_REFUSAL = "Config requires packages unavailable in the pinned runtime. Run `mono-agent restart` from a terminal; the old worker is still serving.";

function preflightRestartReason(result: PreflightFailure): string {
  if (result.kind === "missing-config") return "Startup config is missing. The old worker is still serving.";
  // Only fixed validator section ids enter the public reason, never file contents/errors.
  const section = result.report.sections.find((item) => item.status === "error")?.id;
  const known: Record<string, string> = {
    core: "config", config: "config", context: "IDENTITY or SOUL", tools: "tools or MCP config",
    runtime: "runtime", credentials: "provider credentials", channels: "channels", sandbox: "sandbox",
    memory: "memory", "web-tools": "web tools", continuations: "continuations", "process-jobs": "process jobs",
  };
  return `Startup ${known[section ?? ""] ?? "input"} validation failed. Run \`mono-agent validate\`; the old worker is still serving.`;
}

function captureRestartReason(error: unknown): string {
  // Classify internal errors without forwarding paths, values or arbitrary exception prose.
  const message = error instanceof Error ? error.message : "";
  if (/changed during|changed\./u.test(message)) return "Startup inputs changed during validation. Retry; the old worker is still serving.";
  if (/dotenv|\.env/u.test(message)) return "Startup .env is invalid or unreadable. The old worker is still serving.";
  if (/identity/iu.test(message)) return "Startup IDENTITY is missing or unreadable. The old worker is still serving.";
  if (/soul/iu.test(message)) return "Startup SOUL is missing or unreadable. The old worker is still serving.";
  if (/MCP/u.test(message)) return "Startup MCP config is missing or unreadable. The old worker is still serving.";
  return INPUT_VALIDATION_REFUSAL;
}

export function workerApprovalBinding(input: {
  readonly args: Pick<ParsedCliArgs, "expectedBackgroundSnapshot" | "expectedManagedRuntimeLaunch">;
  readonly configPath: string;
  readonly managedRoot?: string;
}): ApprovedBackgroundSnapshotBinding {
  const label = deriveLaunchdLabel(input.configPath);
  if (input.args.expectedBackgroundSnapshot === undefined || input.args.expectedManagedRuntimeLaunch === undefined) {
    throw new Error("Managed worker is missing its startup approval binding.");
  }
  return { label, configPath: input.configPath,
    managedRoot: input.managedRoot ?? dirname(launchdPathsFor(label).logDir),
    encodedSnapshot: input.args.expectedBackgroundSnapshot, launchProof: input.args.expectedManagedRuntimeLaunch };
}

/** Linux keeps structural validation, with freshly reconstructed durable environment. */
export async function verifySupervisedRestartInputs(input: {
  readonly args: ParsedCliArgs;
  readonly cwd: string;
  readonly configPath: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly platform: "darwin" | "linux";
}): Promise<{ readonly supported: boolean; readonly reason?: string }> {
  try {
    const approved = decodeAndVerifyWorkerSnapshot(input.args, input.cwd, input.configPath);
    if (input.platform === "darwin") {
      // This read-only legacy check grants no approval. Managed POST uses preparation below.
      const fresh = await captureBackgroundSnapshot({ cwd: input.cwd, configPath: input.configPath,
        ...(input.args.envFile === undefined ? {} : { envFile: input.args.envFile }), env: input.env });
      if (!sameBackgroundSnapshot(approved, fresh)) return { supported: false, reason: "Startup inputs changed. Run `mono-agent restart` from a terminal." };
    } else {
      let effective: Record<string, string>;
      try { effective = await loadDurableBackgroundEnvironment({ cwd: input.cwd,
        ...(input.args.envFile === undefined ? {} : { envFile: input.args.envFile }),
        operationalEnvironment: selectSystemdBackgroundOperationalEnvironment(input.env) }); }
      catch { return { supported: false, reason: "Startup .env is invalid or unreadable. The old worker is still serving." }; }
      const preflight = await ensureStartable(input.args, effective, { cwd: input.cwd, configPath: input.configPath });
      if (!preflight.ok) return { supported: false, reason: preflightRestartReason(preflight) };
    }
    return { supported: true };
  } catch (error) { return { supported: false, reason: captureRestartReason(error) }; }
}

/** Authenticated POST only. No supervisor mutation or runtime provisioning is performed here. */
export async function prepareSupervisedRestartInputs(input: {
  readonly args: ParsedCliArgs;
  readonly cwd: string;
  readonly configPath: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly runtime: ManagedRuntimeLaunchVerification;
  readonly signal: AbortSignal;
  readonly runner: ReturnType<typeof makeLaunchctlRunner>;
  readonly pid?: number;
  readonly uid?: number;
  readonly managedRoot?: string;
  readonly retainLifecycle: (release: () => Promise<void>) => void;
}): Promise<PreparedSupervisedRestartInputs> {
  let release: (() => Promise<void>) | undefined;
  let staged: Awaited<ReturnType<typeof stageApprovedBackgroundSnapshot>> | undefined;
  let published = false;
  const dispose = async (): Promise<void> => {
    try { await staged?.dispose(); } finally {
      if (!published) { const held = release; release = undefined; await held?.(); }
    }
  };
  const refuse = async (reason: string): Promise<PreparedSupervisedRestartInputs> => {
    await dispose();
    return { supported: false, reason, dispose: async () => undefined };
  };
  try {
    decodeAndVerifyWorkerSnapshot(input.args, input.cwd, input.configPath);
    const binding = workerApprovalBinding(input);
    const paths = launchdPathsFor(binding.label);
    const lockPaths = input.managedRoot === undefined ? paths : { ...paths, logDir: resolve(input.managedRoot, "logs") };
    try { release = await acquireFilesystemLifecycleLock({ label: binding.label, paths: lockPaths }, { waitTimeoutMs: 0 }); }
    catch { return await refuse("Startup approval lifecycle lock is unavailable. The old worker is still serving."); }
    if (release === undefined) return await refuse("Another lifecycle command is active. Retry after it finishes; the old worker is still serving.");
    let worker: Awaited<ReturnType<typeof launchdManagedWorkerInfo>>;
    try { worker = await launchdManagedWorkerInfo(input.runner, binding.label, input.uid ?? process.getuid!()); }
    catch { return await refuse("Loaded supervisor verification failed. The old worker is still serving."); }
    const definition = worker.definition;
    if (!worker.loaded || worker.pid !== (input.pid ?? process.pid) || worker.relaunchOnFailure !== true
      || definition === undefined || definition.configPath !== input.configPath || definition.cwd !== input.cwd
      || definition.envFile !== input.args.envFile
      || definition.expectedBackgroundSnapshot !== binding.encodedSnapshot
      || definition.expectedManagedRuntimeLaunch !== binding.launchProof
      || JSON.stringify(selectBackgroundOperationalEnvironment(definition.environment))
        !== JSON.stringify(selectBackgroundOperationalEnvironment(input.env))) {
      return await refuse("Loaded supervisor inputs do not match this worker. The old worker is still serving.");
    }
    let verified: ManagedRuntimeLaunchVerification;
    try { verified = await verifyManagedRuntimeLaunch({ currentCliPath: definition.cliPath, launchProof: binding.launchProof }); }
    catch { return await refuse("Pinned managed runtime verification failed. The old worker is still serving."); }
    if (verified.installRoot !== input.runtime.installRoot) return await refuse("Loaded runtime does not match this worker. The old worker is still serving.");
    try {
      await loadDurableBackgroundEnvironment({ cwd: input.cwd,
        ...(input.args.envFile === undefined ? {} : { envFile: input.args.envFile }), operationalEnvironment: definition.environment });
    } catch { return await refuse("Startup .env is invalid or unreadable. The old worker is still serving."); }
    const candidate = await captureDurableBackgroundInputs({ cwd: input.cwd, configPath: input.configPath,
      ...(input.args.envFile === undefined ? {} : { envFile: input.args.envFile }), operationalEnvironment: definition.environment });
    let packages: Awaited<ReturnType<typeof resolveConfiguredManagedRuntimePackages>>;
    try { packages = await resolveConfiguredManagedRuntimePackages({ cwd: input.cwd, configPath: input.configPath, env: candidate.environment }); }
    catch { return await refuse(CLOSURE_REFUSAL); }
    if (packages.some((pkg) => !pkg.packageSource.startsWith(`${verified.installRoot}/`))) return await refuse(CLOSURE_REFUSAL);
    const materialized = await materializeBackgroundRuntimeInputs({ snapshot: candidate.snapshot, cwd: input.cwd,
      env: candidate.environment, ...(input.managedRoot === undefined ? {} : { runtimeRoot: resolve(input.managedRoot, "runtime-inputs") }) });
    try {
      const preflight = await ensureStartable(input.args, materialized.environment, { cwd: input.cwd,
        configPath: materialized.configPath, preferAppPluginInstall: true, verifiedRuntimeProvenanceDetail: verified.provenanceDetail });
      if (!preflight.ok) return await refuse(preflightRestartReason(preflight));
    } finally { await materialized.dispose(); }
    const final = await captureDurableBackgroundInputs({ cwd: input.cwd, configPath: input.configPath,
      ...(input.args.envFile === undefined ? {} : { envFile: input.args.envFile }), operationalEnvironment: definition.environment });
    if (!sameBackgroundSnapshot(candidate.snapshot, final.snapshot)) return await refuse("Startup inputs changed during validation. Retry; the old worker is still serving.");
    if (input.signal.aborted) return await refuse("Startup input validation timed out. The old worker is still serving.");
    try { staged = await stageApprovedBackgroundSnapshot(binding, candidate.snapshot); }
    catch { return await refuse("Startup approval staging failed. The old worker is still serving."); }
    if (input.signal.aborted) return await refuse("Startup input validation timed out. The old worker is still serving.");
    return { supported: true, dispose, publish: () => {
      if (input.signal.aborted || release === undefined) throw new Error("Startup approval preparation expired. The old worker is still serving.");
      staged!.publish();
      published = true;
      input.retainLifecycle(release);
    } };
  } catch (error) { return await refuse(captureRestartReason(error)); }
}

/**
 * The blocking worker: builds the responder, starts every configured channel
 * plus traceability, and stays alive until a signal. This is what launchd
 * invokes (via `start --foreground`) and what users get with `--foreground`/`-f`.
 */
async function runForeground(
  args: ParsedCliArgs,
  env: Record<string, string | undefined> = process.env,
  managedBackgroundWorker = false,
  systemdBackgroundWorker = false,
): Promise<number> {
  const cwd = process.cwd();
  const configPath = await canonicalBackgroundConfigPath(cwd, args.configPath);

  let managedRuntime: ManagedRuntimeLaunchVerification | undefined;
  if (managedBackgroundWorker) {
    try {
      const label = deriveLaunchdLabel(configPath);
      const paths = launchdPathsFor(label);
      await waitForManagedRuntimePublication({
        label,
        managedRoot: dirname(paths.logDir),
      });
      if (args.expectedBackgroundSnapshot === undefined) {
        process.stderr.write(ui.errorLine("Managed LaunchAgent worker is missing its approved background snapshot."));
        return 0;
      }
      if (args.expectedManagedRuntimeLaunch === undefined) {
        process.stderr.write(ui.errorLine("Managed LaunchAgent worker is missing its finalized runtime proof."));
        return 0;
      }
      managedRuntime = await verifyManagedRuntimeLaunch({
        currentCliPath: fileURLToPath(new URL("./cli.js", import.meta.url)),
        launchProof: args.expectedManagedRuntimeLaunch,
      });
    } catch (error) {
      process.stderr.write(ui.errorLine(
        `Managed worker could not verify its finalized runtime: ${error instanceof Error ? error.message : String(error)}`,
      ));
      // KeepAlive restarts only unsuccessful exits. A controller must publish a
      // fresh proven plist before this worker can safely recover.
      return 0;
    }
  }
  if (managedBackgroundWorker) {
    loadCliEnvFile(resolve(cwd, args.envFile ?? ".env"));
  }
  const startupEnvironment = { ...env };

  let systemdBackgroundSnapshot: BackgroundSnapshot | undefined;
  if (systemdBackgroundWorker) {
    try {
      systemdBackgroundSnapshot = decodeAndVerifyWorkerSnapshot(args, cwd, configPath);
    } catch (error) {
      process.stderr.write(ui.errorLine(
        `Systemd worker could not verify its startup snapshot: ${error instanceof Error ? error.message : String(error)}`,
      ));
      // systemd's Restart=on-failure policy is bounded by StartLimitBurst. A
      // non-zero exit preserves a visible failed unit instead of disguising a
      // malformed or mismatched installed worker as a clean shutdown.
      return 1;
    }
  }

  let lease;
  try {
    lease = await acquireBackgroundWorkerLease(configPath);
  } catch (error) {
    process.stderr.write(ui.errorLine(
      `Could not acquire the worker singleton lease: ${error instanceof Error ? error.message : String(error)}`,
    ));
    return 1;
  }
  if (lease === undefined) {
    process.stderr.write(ui.errorLine(
      `Another foreground or managed background worker already owns ${configPath}; refusing to start a duplicate.`,
    ));
    return 1;
  }

  let runtimeInputs: Awaited<ReturnType<typeof materializeBackgroundRuntimeInputs>> | undefined;
  let app: MonoAgentApp | undefined;
  let logMonitor: ReturnType<typeof startManagedLaunchdLogMonitor> | undefined;
  const activityTracker = new WorkerActivityTracker();
  let activityPublisher: Awaited<ReturnType<typeof publishWorkerActivity>> | undefined;
  let shutdownWaitStarted = false;
  const restartLatch = managedBackgroundWorker || systemdBackgroundWorker ? createSupervisedRestartLatch() : undefined;
  let restartLifecycleRelease: (() => Promise<void>) | undefined;
  const restartAuthority: TuiRestartAuthority | undefined = restartLatch === undefined ? undefined
    : createSupervisedRestartAuthority({
        configPath,
        startedAt: new Date().toISOString(),
        ...(managedBackgroundWorker ? { launchdRunner: makeLaunchctlRunner(2_000) } : {}),
        ...(managedBackgroundWorker && managedRuntime !== undefined ? {
          prepareStartupInputs: (signal: AbortSignal) => prepareSupervisedRestartInputs({
            args, cwd, configPath, env: startupEnvironment, runtime: managedRuntime!, signal,
            runner: makeLaunchctlRunner(2_000), retainLifecycle: (release) => { restartLifecycleRelease = release; },
          }),
        } : { verifyStartupInputs: () => verifySupervisedRestartInputs({
          args, cwd, configPath, env: startupEnvironment,
          platform: "linux",
        }) }),
        logger: consoleLogger(),
      }, restartLatch);
  try {
    let backgroundSnapshot = systemdBackgroundSnapshot;
    if (managedBackgroundWorker) {
      try {
        decodeAndVerifyWorkerSnapshot(args, cwd, configPath);
        backgroundSnapshot = resolveApprovedBackgroundSnapshot(workerApprovalBinding({ args, configPath }));
        runtimeInputs = await materializeBackgroundRuntimeInputs({
          snapshot: backgroundSnapshot,
          cwd,
          env: startupEnvironment,
        });
      } catch (error) {
        process.stderr.write(ui.errorLine(
          `Managed worker could not freeze its startup snapshot: ${error instanceof Error ? error.message : String(error)}`,
        ));
        // KeepAlive must not spin on an unapproved snapshot. Publish an offline
        // status before a successful exit; scheduled/explicit controllers repair it.
        await recordManagedSnapshotRefusal(configPath);
        return 0;
      }
    }

    const preflightEnvironment = runtimeInputs?.environment ?? startupEnvironment;
    const pre = await ensureStartable(args, preflightEnvironment, {
      ...(runtimeInputs === undefined
        ? {}
        : {
            cwd,
            configPath: runtimeInputs.configPath,
            preferAppPluginInstall: true,
          }),
      ...(managedRuntime === undefined
        ? {}
        : { verifiedRuntimeProvenanceDetail: managedRuntime.provenanceDetail }),
    });
    if (!pre.ok) {
      printPreflightFailure(pre);
      return managedBackgroundWorker ? 0 : pre.code;
    }
    try {
      await readCliConfigSnapshot(runtimeInputs?.configPath ?? configPath);
    } catch (error) {
      process.stderr.write(ui.errorLine(
        `Cannot establish the foreground config identity: ${error instanceof Error ? error.message : String(error)}`,
      ));
      return managedBackgroundWorker ? 0 : 1;
    }

    if (managedBackgroundWorker) {
      const label = deriveLaunchdLabel(configPath);
      activityPublisher = await publishWorkerActivity({ label, paths: launchdPathsFor(label) }, activityTracker,
        () => process.stderr.write(ui.errorLine("Could not publish managed worker activity; maintenance will treat it as unknown.")));
    }
    const appOptions = {
      activityTracker,
      cwd,
      configPath,
      ...(runtimeInputs === undefined ? {} : {
        configReadPath: runtimeInputs.configPath,
        privateRuntimePaths: runtimeInputs.privateRuntimePaths,
      }),
      env: runtimeInputs?.environment ?? startupEnvironment,
      logger: consoleLogger(),
      ...(backgroundSnapshot === undefined ? {} : { backgroundSnapshot }),
      ...(restartAuthority === undefined ? {} : { restartAuthority }),
    };
    app = managedRuntime === undefined
      ? await startMonoAgentApp(appOptions)
      : await startVerifiedManagedMonoAgentApp(appOptions, managedRuntime);

    if (managedBackgroundWorker) {
      await clearLaunchdSnapshotRefusal(deriveLaunchdLabel(configPath), launchdPathsFor(deriveLaunchdLabel(configPath)))
        .catch((error) => process.stderr.write(ui.errorLine(`Could not clear the managed snapshot refusal status: ${error instanceof Error ? error.message : String(error)}`)));
    }
    await printAppStatus(app);
    // Block until a shutdown signal. Returning here (the old behavior) let the
    // process exit immediately whenever no channel owned a live handle — e.g. a
    // traceability-only config, now that the operator console is retired and the
    // trace heartbeat timer is unref'd.
    if (managedBackgroundWorker) {
      logMonitor = startManagedBackgroundLogMonitorForConfig(configPath, {
        ...defaultBackgroundDeps(), isWorkerBusy: () => activityTracker.busy(),
        maintenanceEpisode: async () => (await readLaunchdMaintenanceActivityStatus(deriveLaunchdLabel(configPath), launchdPathsFor(deriveLaunchdLabel(configPath))))?.pending,
      });
    }
    const shutdown = waitForShutdownSignal(app, () => {
      logMonitor?.stop();
      logMonitor = undefined;
    }, restartLatch);
    shutdownWaitStarted = true;
    return await shutdown;
  } finally {
    logMonitor?.stop();
    // The shutdown waiter already called stop exactly once; even if it failed,
    // do not issue a second process shutdown for one accepted operation.
    if (!shutdownWaitStarted) await app?.stop().catch(() => undefined);
    await activityPublisher?.stop().catch(() => undefined);
    await runtimeInputs?.dispose().catch(() => undefined);
    await restartLifecycleRelease?.().catch(() => undefined);
    await lease.release().catch((error) => {
      process.stderr.write(ui.style.yellow(
        `⚠ Could not cleanly release worker singleton lease ${lease.path}: ${error instanceof Error ? error.message : String(error)}`,
      ) + "\n");
    });
  }
}

/** The exact managed-worker composition, exported for a real idle-path contract test. */
export function startManagedBackgroundLogMonitorForConfig(
  configPath: string,
  deps: ManagedLaunchdLogMonitorDependencies,
): ManagedLaunchdLogMonitor {
  const label = deriveLaunchdLabel(configPath);
  const monitorTarget = { label, paths: launchdPathsFor(label) };
  return startManagedLaunchdLogMonitor(monitorTarget, {
    inspectLaunchdLogs: deps.inspectLaunchdLogs,
    runner: deps.runner,
    getuid: deps.getuid,
    stderr: deps.stderr,
    ...(deps.isWorkerBusy === undefined ? {} : { isWorkerBusy: deps.isWorkerBusy }),
    ...(deps.maintenanceEpisode === undefined ? {} : { maintenanceEpisode: deps.maintenanceEpisode }),
    ...(deps.monotonicNow === undefined ? {} : { monotonicNow: deps.monotonicNow }),
    ...(deps.wallClockNow === undefined ? {} : { wallClockNow: deps.wallClockNow }),
    ...(deps.isStopped === undefined ? {} : { isStopped: deps.isStopped }),
    recordStatus: deps.recordStatus
      ?? (async (status) => await writeLaunchdLogMonitorStatus(monitorTarget, status)),
  });
}

export async function runBackgroundCommand(
  args: ParsedCliArgs,
  command: (typeof BACKGROUND_COMMANDS)[number],
  env: Record<string, string | undefined> = process.env,
): Promise<number> {
  if (process.platform === "linux") {
    const { runSystemdAgentCommand } = await import("./systemd-command.js");
    return await runSystemdAgentCommand(args, command, env);
  }
  const guard = requireDarwin(command);
  if (guard !== undefined) {
    return guard;
  }

  let controllerEnvironment: Record<string, string | undefined>;
  try {
    controllerEnvironment = await loadDurableBackgroundEnvironment({
      cwd: process.cwd(),
      ...(args.envFile === undefined ? {} : { envFile: args.envFile }),
      operationalEnvironment: managedBackgroundEnvironment(env),
    });
  } catch (error) {
    if (command === "start" || command === "restart") {
      process.stderr.write(ui.errorLine(
        `Cannot reconstruct the managed worker environment: ${error instanceof Error ? error.message : String(error)}`,
      ));
      process.stderr.write(ui.hint("No LaunchAgent changes were made. Fix the dotenv path and retry."));
      return 1;
    }
    controllerEnvironment = { ...env };
    process.stderr.write(ui.style.yellow(
      `⚠ Could not reconstruct the managed worker environment; ${command} will use the current shell only: ${error instanceof Error ? error.message : String(error)}`,
    ) + "\n");
  }

  // Refuse to launch (or relaunch) an unconfigured/broken folder BEFORE writing
  // the plist and bootstrapping launchctl — otherwise the worker would crash and
  // launchd's KeepAlive would retry it forever. stop/status/logs stay ungated so
  // a broken instance can still be inspected and torn down.
  if (command === "start" || command === "restart") {
    const pre = await ensureStartable(args, controllerEnvironment);
    if (!pre.ok) {
      printPreflightFailure(pre);
      return pre.code;
    }
  }

  let target = await resolveInstanceTarget({
    args: {
      ...(args.configPath === undefined ? {} : { configPath: args.configPath }),
      ...(args.envFile === undefined ? {} : { envFile: args.envFile }),
    },
    env: controllerEnvironment,
    cwd: process.cwd(),
    cliPath: fileURLToPath(new URL("./cli.js", import.meta.url)),
  });
  if (command === "start" || command === "restart") {
    try {
      const expectedSnapshot = await captureBackgroundSnapshot({
        cwd: target.cwd,
        configPath: target.configPath,
        ...(target.envFile === undefined ? {} : { envFile: target.envFile }),
        env: controllerEnvironment,
      });
      target = { ...target, expectedSnapshot };
    } catch (error) {
      process.stderr.write(ui.errorLine(
        `Cannot prove the durable background snapshot: ${error instanceof Error ? error.message : String(error)}`,
      ));
      process.stderr.write(ui.hint("No LaunchAgent changes were made. Fix the config/dotenv/Identity/Soul/MCP mismatch and retry."));
      return 1;
    }
  }
  const deps = defaultBackgroundDeps();

  switch (command) {
    case "start":
      return await startBackground(target, deps);
    case "restart":
      return args.clearSessions === true
        ? await runForceRestart(target, deps, controllerEnvironment)
        : await restartBackground(target, deps);
    case "stop":
      return await stopBackground(target, deps);
    case "status":
      return await statusBackground(target, deps, { json: args.json === true });
    case "logs":
      return await tailLogs(target, deps, { follow: args.follow, lines: args.lines ?? DEFAULT_LOG_LINES });
  }
}

/** Private launchd-only entry point; `runCli` recognizes its launchd-only env marker. */
export async function runLaunchdLogMaintenanceCommand(
  args: ParsedCliArgs,
  deps: BackgroundDeps = defaultBackgroundDeps(),
): Promise<number> {
  const guard = requireDarwin("scheduled log maintenance");
  if (guard !== undefined) return guard;
  if (args.configPath === undefined || args.controllerCliPath === undefined
    || args.agentCwd === undefined || args.agentPath === undefined) {
    process.stderr.write(ui.errorLine("Managed launchd recovery requires its pinned config, controller CLI, agent cwd, and worker PATH."));
    return 2;
  }
  const agentCwd = resolve(args.agentCwd);
  try {
    const configPath = await canonicalBackgroundConfigPath(agentCwd, args.configPath);
    const label = deriveLaunchdLabel(configPath);
    const lockTarget = { label, paths: launchdPathsFor(label) };
    return await withLaunchdMaintenanceControllerLock(lockTarget, deps, async (ownership) =>
      await runLaunchdLogMaintenanceCommandWithLifecycleLease(args, ownership, deps));
  } catch (error) {
    process.stderr.write(ui.errorLine(
      `Scheduled recovery could not establish its canonical ownership boundary: ${error instanceof Error ? error.message : String(error)}`,
    ));
    return 1;
  }
}

/** Heavy reconciliation path callable only with the per-agent capability minted by the leaf gate. */
export async function runLaunchdLogMaintenanceCommandWithLifecycleLease(
  args: LaunchdMaintenanceCommandArgs | ParsedCliArgs,
  ownership: LaunchdMaintenanceLifecycleLease,
  deps: BackgroundDeps = defaultBackgroundDeps(),
): Promise<number> {
  const guard = requireDarwin("scheduled log maintenance");
  if (guard !== undefined) return guard;
  if (args.configPath === undefined || args.controllerCliPath === undefined
    || args.agentCwd === undefined || args.agentPath === undefined) {
    process.stderr.write(ui.errorLine("Managed launchd recovery requires its pinned config, controller CLI, agent cwd, and worker PATH."));
    return 2;
  }
  const controllerCliPathInput = args.controllerCliPath;
  const agentCwd = resolve(args.agentCwd);
  try {
    const configPath = await canonicalBackgroundConfigPath(agentCwd, args.configPath);
    const label = deriveLaunchdLabel(configPath);
    const lockTarget = { label, paths: launchdPathsFor(label) };
    assertLaunchdMaintenanceLifecycleLease(ownership, lockTarget);
    let controllerEnvironment: Record<string, string | undefined>;
    try {
      controllerEnvironment = await loadDurableBackgroundEnvironment({
        cwd: agentCwd,
        ...(args.envFile === undefined ? {} : { envFile: args.envFile }),
        operationalEnvironment: managedBackgroundEnvironment({
          ...process.env,
          // The helper itself keeps a closed system PATH. Rehydrate the worker's
          // original non-secret PATH from its private launchd arguments so a
          // healthy login pass is stable and recovery preserves tool discovery.
          PATH: args.agentPath,
        }),
      });
    } catch (error) {
      process.stderr.write(ui.errorLine(
        `Scheduled recovery could not reconstruct the managed worker environment: ${error instanceof Error ? error.message : String(error)}`,
      ));
      return 1;
    }

    let sourceAvailable: boolean;
    try {
      sourceAvailable = await controllerCliAvailable(controllerCliPathInput);
    } catch (error) {
      process.stderr.write(ui.errorLine(
        `Scheduled recovery could not inspect the original controller CLI: ${error instanceof Error ? error.message : String(error)}`,
      ));
      return 1;
    }
    const controllerCliPath = sourceAvailable
      ? resolve(controllerCliPathInput)
      : fileURLToPath(new URL("./cli.js", import.meta.url));
    let target: InstanceTarget;
    try {
      target = await resolveInstanceTarget({
        args: {
          configPath,
          ...(args.envFile === undefined ? {} : { envFile: args.envFile }),
        },
        env: controllerEnvironment,
        cwd: agentCwd,
        cliPath: controllerCliPath,
      });
    } catch (error) {
      process.stderr.write(ui.errorLine(
        `Scheduled recovery could not resolve the managed worker target: ${error instanceof Error ? error.message : String(error)}`,
      ));
      return 1;
    }
    if (target.label !== lockTarget.label || target.configPath !== configPath) {
      process.stderr.write(ui.errorLine(
        "Scheduled recovery refused a target whose canonical identity changed after lock acquisition.",
      ));
      return 1;
    }
    target = {
      ...target,
      // A fallback recovery installs from the helper closure for this run, but
      // the durable helper must keep probing the original source. Otherwise one
      // missing checkout would permanently pin all later recoveries to the old
      // private closure even after the source reappeared.
      controllerCliPath: resolve(controllerCliPathInput),
    };
    try {
      target = {
        ...target,
        expectedSnapshot: await captureBackgroundSnapshot({
          cwd: target.cwd,
          configPath: target.configPath,
          ...(target.envFile === undefined ? {} : { envFile: target.envFile }),
          env: controllerEnvironment,
        }),
      };
    } catch (error) {
      process.stderr.write(ui.errorLine(
        `Scheduled recovery could not prove the durable background snapshot: ${error instanceof Error ? error.message : String(error)}`,
      ));
      return 1;
    }
    return await maintainLaunchdController(target, deps, {
      sourceAvailable,
      recoveryPreflight: async () => {
        const preflight = await ensureStartable(
          args,
          controllerEnvironment,
          { cwd: agentCwd, configPath },
        );
        if (preflight.ok) return 0;
        printPreflightFailure(preflight);
        return preflight.code;
      },
    }, ownership);
  } catch (error) {
    process.stderr.write(ui.errorLine(
      `Scheduled recovery failed inside its owned-lock boundary: ${error instanceof Error ? error.message : String(error)}`,
    ));
    return 1;
  }
}

async function controllerCliAvailable(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    const code = typeof error === "object" && error !== null
      ? (error as { readonly code?: unknown }).code
      : undefined;
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw error;
  }
}

/**
 * `restart --clear-sessions`: stop the worker, purge provider transcripts, canonical
 * active-conversation history, and ACP session authorizations, then start fresh.
 * Stopping first guarantees no conversation state is being written during deletion.
 * Durable memory and run artifacts live elsewhere and remain untouched.
 */
async function runForceRestart(
  target: InstanceTarget,
  deps: BackgroundDeps,
  environment: Record<string, string | undefined>,
): Promise<number> {
  return await forceRestartBackground(target, deps, async () => {
    const result = await purgeConversationState({ env: environment, cwd: target.cwd, configPath: target.configPath });
    process.stdout.write(formatConversationStatePurgeResult(result));
  });
}

/** Describe every store the stopped clear-sessions operation actually removed. */
export function formatConversationStatePurgeResult(result: PurgeConversationStateResult): string {
  const cleared: string[] = [];
  if (result.sessions.removed) {
    const count = result.sessions.files === 0
      ? ""
      : ` (${result.sessions.files} session file${result.sessions.files === 1 ? "" : "s"})`;
    cleared.push(`persisted provider sessions${count}`);
  }
  if (result.history.removed) {
    const count = result.history.messageHistory.files === 0
      ? ""
      : ` (${result.history.messageHistory.files} conversation file${result.history.messageHistory.files === 1 ? "" : "s"}, ${result.history.messageHistory.bytes} bytes)`;
    cleared.push(`active conversation history${count}`);
    const toolCounts = result.history.toolHistory.countsKnown
      ? `; ${result.history.toolHistory.calls ?? 0} calls, ${result.history.toolHistory.records ?? 0} records, ${result.history.toolHistory.tombstones ?? 0} tombstones`
      : "; record counts unavailable";
    cleared.push(`tool history (${result.history.toolHistory.files} files, ${result.history.toolHistory.bytes} bytes${toolCounts})`);
  }
  if (result.acpSessions.removed) {
    const count = result.acpSessions.files === 0
      ? ""
      : ` (${result.acpSessions.files} authorization file${result.acpSessions.files === 1 ? "" : "s"})`;
    cleared.push(`ACP session authorizations${count}`);
  }
  if (result.subagents.removed) {
    cleared.push(`persistent subagents (${result.subagents.registries} ${result.subagents.registries === 1 ? "registry" : "registries"}, ${result.subagents.sessions} session file${result.subagents.sessions === 1 ? "" : "s"})`);
  }
  if (cleared.length > 0) {
    return `${ui.badge("ok")}${ui.style.bold(`Cleared ${cleared.join(" and ")}`)}.\n`;
  } else {
    return ui.style.dim("No persisted provider sessions, conversation history, ACP authorizations, or subagents to clear.") + "\n";
  }
}

/**
 * Background service mode is launchd-specific. On other platforms point the
 * user at the still-supported blocking foreground path.
 */
function requireDarwin(command: string): number | undefined {
  if (process.platform === "darwin") {
    return undefined;
  }
  process.stderr.write(ui.errorLine(`Background service mode (mono-agent ${command}) requires macOS (launchd).`));
  process.stderr.write(ui.hint("Run `mono-agent start --foreground` to run in the foreground on this platform."));
  return 1;
}

export interface PrintAppStatusOptions {
  readonly listRecordedRuns?: typeof listRecordedRuns;
  readonly nowMs?: number;
}

export async function printAppStatus(app: MonoAgentApp, options: PrintAppStatusOptions = {}): Promise<void> {
  const trace = app.traceabilityStatus;
  process.stdout.write(ui.rule("instance"));
  process.stdout.write(
    ui.keyValue(
      [
        ["config", app.configPath],
        [
          "traceability",
          trace.kind === "running" ? `running (source ${trace.sourceId})` : `${trace.kind}: ${trace.reason}`,
        ],
      ],
      2,
    ),
  );
  const artifactDir = app.traceabilityStatus.kind === "running" ? app.traceabilityStatus.artifactDir : undefined;
  if (app.processJobsProtection !== undefined) {
    process.stdout.write(ui.rule("process jobs protection"));
    process.stdout.write(
      `  protection: ${app.processJobsProtection.protection}; retained roots: ${app.processJobsProtection.retainedRoots ? "yes" : "no"}` +
      `${app.processJobsProtection.warning === undefined ? "" : `; ${ui.style.yellow(app.processJobsProtection.warning)}`}\n`,
    );
  }
  process.stdout.write(ui.rule("sandbox"));
  process.stdout.write(`  ${describeSandboxStatus(app.sandboxStatus)}\n`);
  const channels = [...app.channelStatuses()];
  if (channels.length > 0) {
    const sections = formatHumanChannelSections(channels.map(([id, status]) => ({
      id,
      kind: status.kind,
      text: describeChannelStatus(status),
    })));
    for (const section of sections) {
      process.stdout.write(ui.rule(section.title));
      for (const line of section.lines) process.stdout.write(`${line}\n`);
    }
  }
  await writeAppRunsHealthDetail(app, options);
}

async function writeAppRunsHealthDetail(app: MonoAgentApp, options: PrintAppStatusOptions): Promise<void> {
  const artifactDir = app.traceabilityStatus.kind === "running" ? app.traceabilityStatus.artifactDir : undefined;
  if (artifactDir === undefined || artifactDir.trim().length === 0) {
    return;
  }
  const reader = options.listRecordedRuns ?? listRecordedRuns;
  let result;
  try {
    result = await reader({ artifactDir, maxRuns: RUNS_HEALTH_MAX_RUNS, scope: "agent" });
  } catch (error) {
    result = {
      totalRuns: 0,
      runs: [],
      warnings: [`Unable to read run summaries: ${reasonOf(error)}`],
    };
  }
  const display = buildRunsHealthDisplay({
    artifactDir,
    totalRuns: result.totalRuns,
    runs: result.runs,
    warnings: result.warnings,
    includeSelectedSkills: true,
    runOwnerAlive: true,
    maxRuns: RUNS_HEALTH_MAX_RUNS,
    ...(app.selectedSkills === undefined ? {} : { selectedSkills: app.selectedSkills }),
    ...(options.nowMs === undefined ? {} : { nowMs: options.nowMs }),
  });
  process.stdout.write(ui.rule("runs health"));
  for (const detail of display.details) {
    process.stdout.write(`  ${detail}\n`);
  }
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function describeSandboxStatus(status: SandboxStatus): string {
  const engineAvailability = status.engineAvailable === true
    ? "present"
    : status.engineAvailable === false
      ? "absent"
      : "not checked";
  const parts = [
    `effective: ${status.effective}`,
    `engine: ${status.engine ?? "none"} (${engineAvailability})`,
    ...(status.fallback === undefined ? [] : [`fallback: ${status.fallback}`]),
    `fallback active: ${status.fallbackActive ? "yes" : "no"}`,
    status.detail,
  ];
  const warning = status.warning ?? sandboxEffectiveStateWarning(status);
  if (warning !== undefined) {
    parts.push(ui.style.yellow(warning));
  }
  return parts.join("; ");
}

export function describeChannelStatus(status: ChannelStatus): string {
  if (status.kind === "running") {
    const facts = Object.entries(status.summary)
      .map(([key, value]) => `${key}=${formatChannelFactValue(value)}`)
      .join(" ");
    return facts.length === 0 ? "running" : `running (${facts})`;
  }
  return `${status.kind}: ${status.reason}`;
}

/**
 * Block the foreground process until SIGINT/SIGTERM, then stop the app and
 * resolve the exit code. A referenced no-op timer owns the event loop so the
 * process stays alive even with no channel handle (signal listeners alone do
 * NOT keep Node running, and the trace heartbeat is unref'd). Cleared on stop so
 * the loop drains cleanly without a forceful `process.exit`. Exported for tests.
 */
export function waitForShutdownSignal(
  app: Pick<MonoAgentApp, "stop">,
  beforeAppStop?: () => void,
  restartLatch?: SupervisedRestartLatch,
): Promise<number> {
  return new Promise<number>((resolve) => {
    const keepAlive = setInterval(() => {}, KEEP_ALIVE_INTERVAL_MS);
    let stopping = false;
    let receivedSignal: NodeJS.Signals | undefined;
    const beginShutdown = (signal?: NodeJS.Signals): void => {
      if (stopping) {
        return;
      }
      stopping = true;
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
      clearInterval(keepAlive);
      void (async () => {
        try {
          process.stdout.write("\n" + ui.hint(signal === undefined ? "Supervised restart accepted; stopping mono agent app…" : `Received ${signal}; stopping mono agent app…`));
        } catch {
          // Reporter failure cannot prevent app shutdown or become unhandled.
        }
        let latchFailed = false;
        try {
          beforeAppStop?.();
        } catch (error) {
          latchFailed = true;
          try {
            process.stderr.write(ui.errorLine(
              `Foreground shutdown latch failed: ${error instanceof Error ? error.message : String(error)}`,
            ));
          } catch {
            // Reporter failure cannot prevent app shutdown or become unhandled.
          }
        }
        try {
          const deadline = restartLatch?.beginShutdownDeadline();
          await app.stop(deadline);
          resolve(restartLatch?.exitCode || (latchFailed ? 1 : 0));
        } catch (error) {
          try {
            process.stderr.write(ui.errorLine(
              `Foreground shutdown failed: ${error instanceof Error ? error.message : String(error)}`,
            ));
          } catch {
            // Reporter failure cannot prevent outer idempotent cleanup.
          }
          // Resolve so runForeground's finally block can retry idempotent app
          // cleanup and release the process-lifetime singleton lease.
          resolve(restartLatch?.exitCode || 1);
        }
      })();
    };
    const onSignal = (signal: NodeJS.Signals): void => {
      receivedSignal = signal;
      restartLatch?.signal();
      beginShutdown(signal);
    };
    const onSigint = () => onSignal("SIGINT");
    const onSigterm = () => onSignal("SIGTERM");
    process.on("SIGINT", onSigint);
    process.on("SIGTERM", onSigterm);
    restartLatch?.onStop(() => beginShutdown(receivedSignal));
  });
}

function consoleLogger() {
  return {
    info(message: string, metadata?: Record<string, unknown>) {
      process.stdout.write(`${message}${metadata === undefined ? "" : ` ${JSON.stringify(metadata)}`}\n`);
    },
    warn(message: string, metadata?: Record<string, unknown>) {
      process.stderr.write(`${message}${metadata === undefined ? "" : ` ${JSON.stringify(metadata)}`}\n`);
    },
    error(message: string, metadata?: Record<string, unknown>) {
      process.stderr.write(`${message}${metadata === undefined ? "" : ` ${JSON.stringify(metadata)}`}\n`);
    },
  };
}
