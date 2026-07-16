import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import { type FileHandle, lstat, mkdir, open, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import process from "node:process";

import { listRecordedRuns, listTraceSources } from "@mono-agent/observability";
import type { TraceSourceListItem } from "@mono-agent/observability";

import {
  describeSensitiveDataExportWarning,
  phoenixAppBaseUrl,
  resolveAppTraceRegistryDir,
  resolveAppTraceStaleAfterMs,
} from "./app-config.js";
import { formatChannelFactValue } from "./channel-fact-format.js";
import {
  bootout,
  bootstrap,
  buildPlistXml,
  defaultPathEnv,
  deriveLaunchdLabel,
  isLoaded,
  launchdServiceInfo,
  launchdPathsFor,
  makeLaunchctlRunner,
} from "./launchd.js";
import type { LaunchctlResult, LaunchctlRunner, LaunchdPaths } from "./launchd.js";
import { selectBackgroundOperationalEnvironment } from "./background-environment.js";
import {
  ensureManagedBackgroundRuntime,
  MANAGED_BACKGROUND_WORKER_ENV,
} from "./background-runtime.js";
import type {
  ManagedBackgroundRuntime,
  ManagedBackgroundRuntimeInput,
  ManagedRuntimeAdditionalPackage,
} from "./background-runtime.js";
import {
  backgroundSnapshotFromMetadata,
  captureBackgroundSnapshot,
  encodeBackgroundSnapshot,
  sameBackgroundSnapshot,
} from "./background-snapshot.js";
import type { BackgroundSnapshot } from "./background-snapshot.js";
import { resolveConfiguredManagedRuntimePackages } from "./managed-runtime-packages.js";
import {
  processIncarnationFromJson,
} from "./process-incarnation.js";
import type { ProcessIncarnation, SameProcessIncarnation } from "./process-incarnation.js";
import { acquireOwnerPrivateLock, validateOwnerPrivateLockInputs } from "./owner-private-lock.js";
import { buildRunsHealthDisplay, RUNS_HEALTH_MAX_RUNS } from "./runs-health.js";
import * as ui from "./ui.js";

export {
  acquireBackgroundWorkerLease,
  backgroundWorkerLeasePath,
} from "./background-worker-lease.js";
export type {
  BackgroundWorkerLease,
  BackgroundWorkerLeaseOptions,
} from "./background-worker-lease.js";

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
  readonly staleAfterMs: number;
  readonly paths: LaunchdPaths;
  readonly nodePath: string;
  readonly cliPath: string;
  readonly envFile?: string;
  /**
   * Transient effective config environment reconstructed by the controller.
   * It may contain secrets: never serialize, log, or materialize it in launchd.
   */
  readonly configurationEnvironment: Readonly<Record<string, string | undefined>>;
  readonly environment: Readonly<Record<string, string>>;
  /** Exact wizard/approval snapshot this launch is allowed to claim ready. */
  readonly expectedSnapshot?: BackgroundSnapshot;
  /** Guided/configuration handoffs additionally require a usable TUI endpoint. */
  readonly requireTui?: boolean;
}

export interface ResolveInstanceTargetInput {
  readonly args: BackgroundCliArgs;
  readonly env: Record<string, string | undefined>;
  readonly cwd: string;
  /** Absolute path to the running cli.js, baked into the plist. */
  readonly cliPath: string;
  readonly requireTui?: boolean;
}

/** Exact non-secret environment materialised into a managed LaunchAgent. */
export function managedBackgroundEnvironment(
  env: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string>> {
  return {
    ...selectBackgroundOperationalEnvironment(env),
    PATH: defaultPathEnv({ ...env }),
    // This is a lifecycle marker, not a config override. It tells cli.ts to
    // discard launchd's ambient environment before loading the chosen dotenv.
    [MANAGED_BACKGROUND_WORKER_ENV]: "1",
  };
}

/**
 * Resolve everything the control commands need from CLI args. The registry dir
 * and config path are resolved exactly as the worker will resolve them, so the
 * detached launcher can find the worker's manifest without any IPC.
 */
export async function resolveInstanceTarget(input: ResolveInstanceTargetInput): Promise<InstanceTarget> {
  const lexicalCwd = resolve(input.cwd);
  const [cwd, configPath] = await Promise.all([
    realpath(lexicalCwd),
    canonicalBackgroundConfigPath(lexicalCwd, input.args.configPath),
  ]);
  const configInput = { env: input.env, cwd, configPath };
  const [registryDir, staleAfterMs] = await Promise.all([
    resolveAppTraceRegistryDir(configInput),
    resolveAppTraceStaleAfterMs(configInput),
  ]);
  const label = deriveLaunchdLabel(configPath);
  return {
    cwd,
    configPath,
    label,
    registryDir,
    staleAfterMs,
    paths: launchdPathsFor(label),
    nodePath: process.execPath,
    cliPath: input.cliPath,
    // Bake an explicit --env-file (resolved absolute) into the plist so the
    // launchd worker loads the same env file the launcher did.
    ...(input.args.envFile === undefined ? {} : { envFile: resolve(cwd, input.args.envFile) }),
    configurationEnvironment: { ...input.env },
    environment: managedBackgroundEnvironment(input.env),
    ...(input.requireTui === true ? { requireTui: true } : {}),
  };
}

/**
 * Collapse symlinked parent aliases without following the config's final path
 * component. The final component is separately required to be a regular,
 * non-symlink file before start; keeping it unresolved preserves that check.
 * Missing parents remain addressable so stop/status/logs can still operate on
 * a previously installed label after an agent folder is damaged or removed.
 */
export async function canonicalBackgroundConfigPath(
  cwd: string,
  configuredPath?: string,
): Promise<string> {
  const lexical = resolve(cwd, configuredPath ?? "mono-agent.config.json");
  try {
    const candidate = join(await realpath(dirname(lexical)), basename(lexical));
    try {
      const details = await lstat(candidate);
      // Preserve the final-component symlink so the start-time regular-file
      // check can reject it. For a real file, realpath also canonicalises the
      // stored filename casing on the default case-insensitive macOS volume.
      return details.isSymbolicLink() ? candidate : await realpath(candidate);
    } catch (error) {
      if (isErrno(error, "ENOENT") || isErrno(error, "ENOTDIR")) return candidate;
      throw error;
    }
  } catch (error) {
    if (isErrno(error, "ENOENT") || isErrno(error, "ENOTDIR")) return lexical;
    throw error;
  }
}

export interface BackgroundDeps {
  readonly runner: LaunchctlRunner;
  readonly getuid: () => number;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly listRecordedRuns: typeof listRecordedRuns;
  readonly listTraceSources: typeof listTraceSources;
  readonly writeFile: (path: string, data: string) => Promise<void>;
  readonly mkdir: (path: string) => Promise<void>;
  readonly rm: (path: string) => Promise<void>;
  readonly stat: (path: string) => Promise<{ readonly size: number }>;
  readonly rename: (oldPath: string, newPath: string) => Promise<void>;
  /** True when a pid is still alive (or alive but owned by another user). */
  readonly isAlive: (pid: number) => boolean;
  /** Install/verify an immutable CLI outside npm/npx's disposable cache. */
  readonly ensureManagedRuntime: (input: ManagedBackgroundRuntimeInput) => Promise<ManagedBackgroundRuntime>;
  /** Resolve config-selected plugin-tier packages before the disposable source can disappear. */
  readonly resolveManagedRuntimePackages?: (
    target: InstanceTarget,
  ) => Promise<readonly ManagedRuntimeAdditionalPackage[]>;
  /** Fail closed when another lifecycle command owns this config label. */
  readonly acquireLifecycleLock: (target: InstanceTarget) => Promise<(() => Promise<void>) | undefined>;
  /** Prove a metadata-advertised TUI endpoint is actually reachable. */
  readonly probeTui: (source: TraceSourceListItem) => Promise<boolean>;
  readonly captureSnapshot?: (target: InstanceTarget) => Promise<BackgroundSnapshot>;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  /** Run `tail` with inherited stdio; resolves with its exit code. */
  readonly spawnTail: (args: readonly string[]) => Promise<number>;
}

export function defaultBackgroundDeps(): BackgroundDeps {
  return {
    runner: makeLaunchctlRunner(),
    getuid: () => process.getuid?.() ?? 0,
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms)),
    listRecordedRuns,
    listTraceSources,
    writeFile: writeOwnerPrivateLaunchdFile,
    mkdir: ensureOwnerPrivateLaunchdDirectory,
    rm: (path) => rm(path, { force: true }),
    stat: inspectOwnerPrivateLaunchdLog,
    rename,
    isAlive: (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        // EPERM means the process exists but is owned by someone else.
        return isErrno(error, "EPERM");
      }
    },
    ensureManagedRuntime: (input) => ensureManagedBackgroundRuntime(input),
    resolveManagedRuntimePackages: (target) => resolveConfiguredManagedRuntimePackages({
      cwd: target.cwd,
      configPath: target.configPath,
      env: target.configurationEnvironment,
    }),
    acquireLifecycleLock: acquireFilesystemLifecycleLock,
    probeTui: probeTuiEndpoint,
    stdout: (text) => void process.stdout.write(text),
    stderr: (text) => void process.stderr.write(text),
    spawnTail: (args) =>
      new Promise<number>((resolvePromise) => {
        const child = spawn("tail", [...args], { stdio: "inherit" });
        child.on("error", () => resolvePromise(127));
        child.on("close", (code) => resolvePromise(code ?? 0));
      }),
  };
}

export interface PollOptions {
  readonly timeoutMs: number;
  readonly intervalMs: number;
}

export interface ReadyPollOptions extends PollOptions {
  /** Only accept a worker that started at or after this time (restart safety). */
  readonly sinceMs: number;
  readonly requireTui?: boolean;
}

const DEFAULT_POLL: PollOptions = { timeoutMs: 18_000, intervalMs: 400 };
export const LAUNCHD_LOG_MAX_BYTES = 5 * 1024 * 1024;
export const LAUNCHD_LOG_ROTATION_COUNT = 3;

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
      readonly reason: "runtime" | "snapshot" | "preparation" | "ownership" | "launchctl" | "readiness" | "timeout";
    };

export async function startBackground(
  target: InstanceTarget,
  deps: BackgroundDeps,
  poll: PollOptions = DEFAULT_POLL,
): Promise<number> {
  return (await ensureBackgroundReady(target, deps, poll)).ok ? 0 : 1;
}

/** Restart is behaviourally identical: ensure a single fresh running instance. */
export async function restartBackground(
  target: InstanceTarget,
  deps: BackgroundDeps,
  poll: PollOptions = DEFAULT_POLL,
): Promise<number> {
  return (await ensureBackgroundReady(target, deps, poll)).ok ? 0 : 1;
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
  poll: PollOptions = DEFAULT_POLL,
): Promise<number> {
  const release = await deps.acquireLifecycleLock(target);
  if (release === undefined) {
    deps.stderr(ui.errorLine(`Another lifecycle command is already active for ${target.label}.`));
    deps.stderr(ui.hint("No LaunchAgent or session changes were made. Wait for that command to finish, then retry."));
    return 1;
  }
  try {
    const stopCode = await stopBackgroundUnlocked(target, deps, poll);
    if (stopCode !== 0) return stopCode;
    await whileStopped();
    return (await ensureBackgroundReadyUnlocked(target, deps, poll)).ok ? 0 : 1;
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
 * trace source that proved it reached `startup-complete`. This is the shared
 * lifecycle boundary for CLI start/restart and remote configuration handoffs;
 * callers must not open a console when the result is not ok.
 */
export async function ensureBackgroundReady(
  target: InstanceTarget,
  deps: BackgroundDeps,
  poll: PollOptions = DEFAULT_POLL,
): Promise<BackgroundLaunchResult> {
  const release = await deps.acquireLifecycleLock(target);
  if (release === undefined) {
    deps.stderr(ui.errorLine(`Another lifecycle command is already active for ${target.label}.`));
    deps.stderr(ui.hint("No LaunchAgent changes were made. Wait for that command to finish, then retry."));
    return { ok: false, action: "start", reason: "ownership" };
  }
  try {
    return await ensureBackgroundReadyUnlocked(target, deps, poll);
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
  poll: PollOptions,
): Promise<BackgroundLaunchResult> {
  if (target.expectedSnapshot === undefined) {
    deps.stderr(ui.errorLine("Refusing to launch a managed worker without an approved background snapshot."));
    deps.stderr(ui.hint("No LaunchAgent changes were made. Retry from the wizard or `mono-agent start`."));
    return { ok: false, action: "start", reason: "snapshot" };
  }
  const uid = deps.getuid();
  if (!(await snapshotStillMatches(target, deps))) {
    reportSnapshotDrift(target, deps);
    return { ok: false, action: "start", reason: "snapshot" };
  }
  let launchTarget: InstanceTarget;
  try {
    const additionalPackages = await deps.resolveManagedRuntimePackages?.(target) ?? [];
    const runtime = await deps.ensureManagedRuntime({
      currentCliPath: target.cliPath,
      nodePath: target.nodePath,
      additionalPackages,
    });
    launchTarget = {
      ...target,
      cliPath: runtime.cliPath,
      nodePath: runtime.nodePath,
    };
  } catch (error) {
    reportLifecycleException(target, deps, "install and verify the durable managed runtime", error);
    return { ok: false, action: "start", reason: "runtime" };
  }

  // Runtime materialisation can involve npm/native installation. Recheck the
  // approved files after that unbounded external work and before writing any
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

  let sinceMs: number;
  try {
    await prepareLaunchdDirectories(launchTarget, deps);
    await rotateLaunchdLogs(launchTarget.paths, deps);
    await writePlist(launchTarget, deps);
    sinceMs = deps.now();
  } catch (error) {
    reportLifecycleException(launchTarget, deps, "prepare the LaunchAgent", error);
    return { ok: false, action: "start", reason: "preparation" };
  }
  let outcome: LaunchOutcome;
  try {
    outcome = await bootstrapOrRestart(launchTarget, deps, uid, poll);
  } catch (error) {
    reportLifecycleException(launchTarget, deps, "start the LaunchAgent", error);
    return { ok: false, action: "start", reason: "launchctl" };
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
      ...poll,
      sinceMs,
      ...(launchTarget.requireTui === true ? { requireTui: true } : {}),
    });
  } catch (error) {
    reportLifecycleException(launchTarget, deps, "read the worker readiness trace", error);
    return { ok: false, action, reason: "readiness" };
  }
  if (ready === undefined) {
    if (!(await snapshotStillMatches(launchTarget, deps))) {
      const stopped = await stopBackgroundUnlocked(launchTarget, deps, poll);
      reportSnapshotDrift(launchTarget, deps);
      if (stopped === 0) {
        deps.stderr(ui.style.dim("The drifted LaunchAgent was stopped before returning control.") + "\n");
      } else {
        deps.stderr(ui.style.yellow("The drifted LaunchAgent could not be proven stopped; follow the recovery commands above.") + "\n");
      }
      return { ok: false, action, reason: "snapshot" };
    }
    reportTimeout(launchTarget, deps);
    return { ok: false, action, reason: "timeout" };
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

async function writePlist(target: InstanceTarget, deps: BackgroundDeps): Promise<void> {
  if (target.expectedSnapshot === undefined) {
    throw new Error("A managed LaunchAgent requires an approved background snapshot.");
  }
  const xml = buildPlistXml({
    label: target.label,
    nodePath: target.nodePath,
    cliPath: target.cliPath,
    configPath: target.configPath,
    cwd: target.cwd,
    ...(target.envFile === undefined ? {} : { envFile: target.envFile }),
    expectedBackgroundSnapshot: encodeBackgroundSnapshot(target.expectedSnapshot),
    stdoutPath: target.paths.stdoutPath,
    stderrPath: target.paths.stderrPath,
    environment: target.environment,
  });
  await deps.writeFile(target.paths.plistPath, xml);
}

async function rotateLaunchdLogs(paths: LaunchdPaths, deps: BackgroundDeps): Promise<void> {
  await Promise.all([
    rotateLaunchdLog(paths.stdoutPath, deps),
    rotateLaunchdLog(paths.stderrPath, deps),
  ]);
}

async function rotateLaunchdLog(path: string, deps: BackgroundDeps): Promise<void> {
  let size: number;
  try {
    size = (await deps.stat(path)).size;
  } catch (error) {
    if (isErrno(error, "ENOENT")) return;
    throw error;
  }
  if (size <= LAUNCHD_LOG_MAX_BYTES) {
    return;
  }

  await deps.rm(`${path}.${LAUNCHD_LOG_ROTATION_COUNT}`);
  for (let index = LAUNCHD_LOG_ROTATION_COUNT; index >= 1; index -= 1) {
    const source = index === 1 ? path : `${path}.${index - 1}`;
    const destination = `${path}.${index}`;
    try {
      await deps.rename(source, destination);
    } catch {
      // Missing or locked rotation segment: leave it for the next launch cycle.
    }
  }
}

async function ensureOwnerPrivateLaunchdDirectory(path: string): Promise<void> {
  const parent = dirname(path);
  const parentDetails = await lstat(parent);
  assertOwnerDirectory(parentDetails, parent, "LaunchAgent parent");
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if (!isErrno(error, "EEXIST")) throw error;
  }
  const parentAfter = await lstat(parent);
  assertOwnerDirectory(parentAfter, parent, "LaunchAgent parent");
  if (!sameFilesystemIdentity(parentDetails, parentAfter)) {
    throw new Error(`LaunchAgent parent ${parent} changed while ${path} was created.`);
  }
  const handle = await open(
    path,
    fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
  );
  try {
    const before = await handle.stat();
    assertOwnerDirectory(before, path, "LaunchAgent directory");
    await handle.chmod(0o700);
    const secured = await handle.stat();
    if (!sameFilesystemIdentity(before, secured)) {
      throw new Error(`LaunchAgent directory ${path} changed while it was secured.`);
    }
    assertOwnerDirectory(secured, path, "LaunchAgent directory");
    if ((secured.mode & 0o077) !== 0) {
      throw new Error(`LaunchAgent directory ${path} must be owner-only.`);
    }
    const current = await lstat(path);
    if (!sameFilesystemIdentity(secured, current)) {
      throw new Error(`LaunchAgent directory ${path} changed while it was secured.`);
    }
  } finally {
    await handle.close();
  }
}

async function writeOwnerPrivateLaunchdFile(path: string, data: string): Promise<void> {
  let existing: Stats | undefined;
  try {
    existing = await lstat(path);
    assertOwnerRegularFile(existing, path, "LaunchAgent plist");
  } catch (error) {
    if (!isErrno(error, "ENOENT")) throw error;
  }

  const temporaryPath = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle: FileHandle | undefined = await open(
    temporaryPath,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(data, "utf8");
    await handle.chmod(0o600);
    await handle.sync();
    await handle.close();
    handle = undefined;

    const temporary = await lstat(temporaryPath);
    assertOwnerRegularFile(temporary, temporaryPath, "temporary LaunchAgent plist");
    if ((temporary.mode & 0o777) !== 0o600) {
      throw new Error(`Temporary LaunchAgent plist ${temporaryPath} must be owner-readable and owner-writable only.`);
    }

    let current: Stats | undefined;
    try {
      current = await lstat(path);
    } catch (error) {
      if (!isErrno(error, "ENOENT")) throw error;
    }
    if (
      (existing === undefined) !== (current === undefined)
      || (existing !== undefined && current !== undefined && !sameFilesystemIdentity(existing, current))
    ) {
      throw new Error(`LaunchAgent plist ${path} changed before the new definition was committed.`);
    }

    await rename(temporaryPath, path);
    const committed = await lstat(path);
    assertOwnerRegularFile(committed, path, "LaunchAgent plist");
    if (!sameFilesystemIdentity(temporary, committed)) {
      throw new Error(`LaunchAgent plist ${path} changed while the new definition was committed.`);
    }
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

async function inspectOwnerPrivateLaunchdLog(path: string): Promise<Stats> {
  const handle = await open(
    path,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
  );
  try {
    const before = await handle.stat();
    assertOwnerRegularFile(before, path, "LaunchAgent log");
    await handle.chmod(0o600);
    const secured = await handle.stat();
    if (!sameFilesystemIdentity(before, secured)) {
      throw new Error(`LaunchAgent log ${path} changed while it was secured.`);
    }
    assertOwnerRegularFile(secured, path, "LaunchAgent log");
    const current = await lstat(path);
    if (!sameFilesystemIdentity(secured, current)) {
      throw new Error(`LaunchAgent log ${path} changed while it was secured.`);
    }
    return secured;
  } finally {
    await handle.close();
  }
}

function assertOwnerDirectory(details: Stats, path: string, description: string): void {
  if (!details.isDirectory() || details.isSymbolicLink()) {
    throw new Error(`${description} ${path} must be a real directory.`);
  }
  assertCurrentUserOwns(details, path, description);
}

function assertOwnerRegularFile(details: Stats, path: string, description: string): void {
  if (!details.isFile() || details.isSymbolicLink()) {
    throw new Error(`${description} ${path} must be a regular non-symbolic-link file.`);
  }
  if (details.nlink !== 1) {
    throw new Error(`${description} ${path} must have exactly one filesystem link.`);
  }
  assertCurrentUserOwns(details, path, description);
}

function assertCurrentUserOwns(details: Stats, path: string, description: string): void {
  if (typeof process.getuid === "function" && details.uid !== process.getuid()) {
    throw new Error(`${description} ${path} is not owned by the current user.`);
  }
}

function sameFilesystemIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

interface LaunchOutcome {
  readonly ok: boolean;
  readonly restarted: boolean;
  readonly failure?: LaunchctlResult;
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
): Promise<LaunchOutcome> {
  const service = await launchdServiceInfo(deps.runner, target.label, uid);
  if (!service.loaded) {
    const booted = await bootstrap(deps.runner, target.paths.plistPath, uid);
    if (booted.code === 0 || (await isLoaded(deps.runner, target.label, uid))) {
      return { ok: true, restarted: false };
    }
    return { ok: false, restarted: false, failure: booted };
  }

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
  const removed = await bootout(deps.runner, target.label, uid);
  const unloaded = await pollUntil(
    deps,
    poll,
    async () => !(await launchdServiceInfo(deps.runner, target.label, uid)).loaded,
  );
  if (!unloaded) {
    return {
      ok: false,
      restarted: true,
      failure: lifecycleFailure(removed, "launchd still reports the previous service as loaded after bootout"),
    };
  }
  const stopped = await pollUntil(deps, poll, async () => oldPids.every((pid) => !deps.isAlive(pid)));
  if (!stopped) {
    return {
      ok: false,
      restarted: true,
      failure: lifecycleFailure(removed, `previous worker pid(s) ${oldPids.join(", ")} remained alive after bootout`),
    };
  }

  const booted = await bootstrap(deps.runner, target.paths.plistPath, uid);
  if (booted.code === 0 || (await isLoaded(deps.runner, target.label, uid))) {
    return { ok: true, restarted: true };
  }
  return { ok: false, restarted: true, failure: booted };
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

async function pollUntil(
  deps: BackgroundDeps,
  options: PollOptions,
  condition: () => Promise<boolean>,
): Promise<boolean> {
  const deadline = deps.now() + options.timeoutMs;
  for (;;) {
    if (await condition()) return true;
    if (deps.now() >= deadline) return false;
    await deps.sleep(options.intervalMs);
  }
}

function lifecycleFailure(result: LaunchctlResult, detail: string): LaunchctlResult {
  return {
    code: result.code === 0 ? 1 : result.code,
    stdout: result.stdout,
    stderr: [result.stderr.trim(), detail].filter((value) => value.length > 0).join("\n"),
  };
}

function uniquePids(values: readonly (number | undefined)[]): number[] {
  return [...new Set(values.filter((value): value is number => value !== undefined && value > 0))];
}

export async function stopBackground(
  target: InstanceTarget,
  deps: BackgroundDeps,
  poll: PollOptions = DEFAULT_POLL,
): Promise<number> {
  const release = await deps.acquireLifecycleLock(target);
  if (release === undefined) {
    deps.stderr(ui.errorLine(`Another lifecycle command is already active for ${target.label}.`));
    deps.stderr(ui.hint("The LaunchAgent plist was preserved. Wait for that command to finish, then retry."));
    return 1;
  }
  try {
    return await stopBackgroundUnlocked(target, deps, poll);
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
  const uid = deps.getuid();
  const existing = await findInstances(target, deps);
  const service = await launchdServiceInfo(deps.runner, target.label, uid);
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

  const result = await bootout(deps.runner, target.label, uid);
  const unloaded = await pollUntil(
    deps,
    poll,
    async () => !(await launchdServiceInfo(deps.runner, target.label, uid)).loaded,
  );
  const ownedPids = uniquePids([service.pid, ...liveTracePids]);
  const stopped = await pollUntil(deps, poll, async () => ownedPids.every((pid) => !deps.isAlive(pid)));
  if (!unloaded || !stopped) {
    deps.stderr(ui.errorLine(
      `Failed to prove ${target.label} stopped${result.code === 0 ? "" : ` (launchctl bootout exited ${result.code})`}.`,
    ));
    const detail = (result.stderr || result.stdout).trim();
    if (detail.length > 0) {
      deps.stderr(ui.style.dim(detail) + "\n");
    }
    if (!unloaded) deps.stderr(ui.style.dim("launchd still reports the service as loaded.\n"));
    if (!stopped) deps.stderr(ui.style.dim(`Worker pid(s) ${ownedPids.join(", ")} are still alive.\n`));
    deps.stderr(ui.hint("The LaunchAgent plist was preserved so the service remains recoverable. Inspect status/logs and retry."));
    return 1;
  }

  // Remove the plist only after both launchd ownership and process death are
  // proven. This prevents a failed stop from destroying its recovery handle.
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

export async function statusBackground(target: InstanceTarget, deps: BackgroundDeps): Promise<number> {
  const result = await deps.listTraceSources({ registryDir: target.registryDir, staleAfterMs: target.staleAfterMs });
  const classified = await Promise.all(result.sources.map(async (source) => ({
    source,
    matches: await matchesConfig(source, target.configPath),
  })));
  const current = classified.find((entry) => entry.matches)?.source;

  if (current === undefined) {
    deps.stdout(ui.style.dim(`No running mono-agent instance for ${target.configPath}.`) + "\n");
    deps.stdout(ui.hint(`Start it with: mono-agent start${commandFlags(target)}`));
  } else {
    writeInstanceDetail(current, target, deps);
    await writeRunsHealthDetail(current, deps);
  }

  // Only surface other instances that are live or crashed — cleanly stopped
  // manifests linger in the registry and would just be noise.
  const others = classified
    .filter((entry) => !entry.matches && entry.source.health !== "stopped")
    .map((entry) => entry.source);
  if (others.length > 0) {
    deps.stdout("\n" + ui.rule("Other mono-agent instances"));
    for (const source of others) {
      deps.stdout(`${formatOtherInstance(source)}\n`);
    }
  }

  return current?.health === "running" ? 0 : 1;
}

export interface LogOptions {
  readonly follow: boolean;
  readonly lines: number;
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
        && isReady(match, options.requireTui === true)
        && startedAtMs(match) >= options.sinceMs
        && snapshotMetadataMatches(match, target.expectedSnapshot)
        && await snapshotStillMatches(target, deps)
        && (options.requireTui !== true || await deps.probeTui(match))) {
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

function reportSnapshotDrift(target: InstanceTarget, deps: BackgroundDeps): void {
  deps.stderr(ui.errorLine("The committed config, dotenv, Identity, Soul, MCP config, or durable environment changed before background readiness."));
  deps.stderr(ui.style.dim("No readiness claim was made for a different snapshot.") + "\n");
  reportLaunchRecovery(target, deps);
}

export function printInstanceInfo(
  source: TraceSourceListItem,
  target: InstanceTarget,
  deps: BackgroundDeps,
  verb: string,
): void {
  const flag = commandFlags(target);
  deps.stdout(`${ui.badge("ok")}${ui.style.bold(`mono-agent ${verb} in the background.`)}\n\n`);
  writeInstanceDetail(source, target, deps);
  deps.stdout("\n" + ui.hint(`Stop with: mono-agent stop${flag}   ·   Logs: mono-agent logs${flag} --follow`));
}

async function findInstances(target: InstanceTarget, deps: BackgroundDeps): Promise<readonly TraceSourceListItem[]> {
  const result = await deps.listTraceSources({ registryDir: target.registryDir, staleAfterMs: target.staleAfterMs });
  const matches = await Promise.all(result.sources.map(async (source) => ({
    source,
    matches: await matchesConfig(source, target.configPath),
  })));
  return matches.filter((entry) => entry.matches).map((entry) => entry.source);
}

async function findInstance(target: InstanceTarget, deps: BackgroundDeps): Promise<TraceSourceListItem | undefined> {
  return (await findInstances(target, deps))[0];
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

function reportLaunchFailure(
  target: InstanceTarget,
  deps: BackgroundDeps,
  verb: string,
  result: LaunchctlResult | undefined,
): void {
  deps.stderr(ui.errorLine(`Failed to ${verb} ${target.label} via launchctl${result === undefined ? "" : ` (exit ${result.code})`}.`));
  const detail = (result?.stderr || result?.stdout || "").trim();
  if (detail.length > 0) {
    deps.stderr(ui.style.dim(detail) + "\n");
  }
  reportLaunchRecovery(target, deps);
}

function reportOwnershipConflict(target: InstanceTarget, deps: BackgroundDeps, detail: string): void {
  deps.stderr(ui.errorLine(`Refusing to launch a second worker for ${target.configPath}.`));
  deps.stderr(ui.style.dim(`${detail}.\n`));
  deps.stderr(ui.hint("No LaunchAgent changes were made. Stop the unmanaged process or reconcile launchd ownership, then retry."));
  reportLaunchRecovery(target, deps);
}

function reportLifecycleException(
  target: InstanceTarget,
  deps: BackgroundDeps,
  operation: string,
  error: unknown,
): void {
  deps.stderr(ui.errorLine(`Failed to ${operation}: ${error instanceof Error ? error.message : String(error)}`));
  deps.stderr(ui.style.dim("The committed agent files were preserved.") + "\n");
  reportLaunchRecovery(target, deps);
}

function reportTimeout(target: InstanceTarget, deps: BackgroundDeps): void {
  deps.stderr(ui.errorLine("mono-agent did not report ready within the timeout."));
  deps.stderr(ui.style.dim("The committed agent files were preserved. It may still be starting, or it may have failed.") + "\n");
  reportLaunchRecovery(target, deps);
}

function reportLaunchRecovery(target: InstanceTarget, deps: BackgroundDeps): void {
  const flags = commandFlags(target);
  deps.stderr(ui.style.dim("Retry or inspect with:") + "\n");
  deps.stderr(
    `  ${ui.style.gray("logs:  ")} ${target.paths.stderrPath}\n` +
      `          ${target.paths.stdoutPath}\n` +
      `  ${ui.style.gray("retry: ")} mono-agent start${flags}\n` +
      `  ${ui.style.gray("status:")} mono-agent status${flags}\n` +
      `  ${ui.style.gray("follow:")} mono-agent logs${flags} --follow\n`,
  );
}

function writeInstanceDetail(source: TraceSourceListItem, target: InstanceTarget, deps: BackgroundDeps): void {
  deps.stdout(ui.rule("instance"));
  deps.stdout(
    ui.keyValue(
      [
        ["pid", String(source.pid ?? "unknown")],
        ["health", `${ui.healthBadge(source.health)}${source.health}`],
        ["config", target.configPath],
        ["label", target.label],
        ["started", source.startedAt],
        ["logs", target.paths.stdoutPath],
        ["", target.paths.stderrPath],
      ],
      2,
    ),
  );
  const observability = describeObservabilityMetadata(source);
  if (observability !== undefined) {
    deps.stdout(ui.rule("observability"));
    deps.stdout(`  ${observability}\n`);
  }
  const sandboxLines = describeSandboxMetadata(source);
  if (sandboxLines.length > 0) {
    deps.stdout(ui.rule("sandbox"));
    for (const line of sandboxLines) {
      deps.stdout(`  ${line}\n`);
    }
  }
  const sessionLines = describeSessionMetadata(source, deps.now());
  if (sessionLines.length > 0) {
    deps.stdout(ui.rule("session"));
    for (const line of sessionLines) {
      deps.stdout(`  ${line}\n`);
    }
  }
  const channelLines = formatChannels(source);
  if (channelLines.length > 0) {
    deps.stdout(ui.rule("channels"));
    for (const line of channelLines) {
      deps.stdout(`${line}\n`);
    }
  }
}

async function writeRunsHealthDetail(source: TraceSourceListItem, deps: BackgroundDeps): Promise<void> {
  if (source.artifactDir === undefined || source.artifactDir.trim().length === 0) {
    return;
  }
  const { totalRuns, runs, warnings } = await deps.listRecordedRuns({
    artifactDir: source.artifactDir,
    maxRuns: RUNS_HEALTH_MAX_RUNS,
    scope: "agent",
  });
  const selectedSkills = selectedSkillsFromMetadata(source.metadata);
  const runOwnerAlive = source.pid === undefined ? undefined : deps.isAlive(source.pid);
  const display = buildRunsHealthDisplay({
    artifactDir: source.artifactDir,
    totalRuns,
    runs,
    warnings,
    includeSelectedSkills: true,
    nowMs: deps.now(),
    maxRuns: RUNS_HEALTH_MAX_RUNS,
    ...(selectedSkills === undefined ? {} : { selectedSkills }),
    ...(runOwnerAlive === undefined ? {} : { runOwnerAlive }),
  });
  deps.stdout(ui.rule("runs health"));
  for (const detail of display.details) {
    deps.stdout(`  ${detail}\n`);
  }
}

function selectedSkillsFromMetadata(metadata: Record<string, unknown> | undefined): readonly string[] | undefined {
  const context = metadata?.context;
  if (context === null || typeof context !== "object") {
    return undefined;
  }
  const selectedSkills = (context as Record<string, unknown>).selectedSkills;
  if (!Array.isArray(selectedSkills)) {
    return undefined;
  }
  return selectedSkills.flatMap((skill) => typeof skill === "string" ? [skill] : []);
}

function formatOtherInstance(source: TraceSourceListItem): string {
  const pid = source.pid === undefined ? "?" : String(source.pid);
  const config = source.configPath ?? "(unknown config)";
  return `  ${ui.healthBadge(source.health)}${source.health.padEnd(8)} pid ${pid.padEnd(7)} ${source.sourceId}  ${config}`;
}

async function matchesConfig(source: TraceSourceListItem, configPath: string): Promise<boolean> {
  if (source.configPath === undefined) return false;
  return await canonicalBackgroundConfigPath(process.cwd(), source.configPath) === configPath;
}

function isReady(source: TraceSourceListItem, requireTui: boolean): boolean {
  if (source.health !== "running" || metadataReason(source) !== "startup-complete") return false;
  if (source.memoryHealth?.status === "unhealthy") return false;
  const channels = channelRecords(source);
  if (channels.some((channel) => channel.kind === "failed")) return false;
  if (!requireTui) return true;
  if (channels.some((channel) => typeof channel.kind === "string"
    && ["failed", "degraded", "waiting_for_config"].includes(channel.kind))) return false;
  return tuiEndpoint(source) !== undefined;
}

function channelRecords(source: TraceSourceListItem): readonly Record<string, unknown>[] {
  const channels = source.metadata?.channels;
  if (channels === null || typeof channels !== "object") return [];
  return Object.values(channels as Record<string, unknown>)
    .filter((value): value is Record<string, unknown> => value !== null && typeof value === "object");
}

function metadataReason(source: TraceSourceListItem): string | undefined {
  const reason = source.metadata?.reason;
  return typeof reason === "string" ? reason : undefined;
}

function startedAtMs(source: TraceSourceListItem): number {
  const parsed = Date.parse(source.startedAt);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Format the persisted observability exporter metadata for the detached
 * `status` reader. Reads defensively (the worker persists only endpoint +
 * warning/error strings, never headers/secrets) and always notes that JSONL
 * artifacts remain local.
 */
function describeObservabilityMetadata(source: TraceSourceListItem): string | undefined {
  const observability = source.metadata?.observability;
  if (observability === null || typeof observability !== "object") {
    return undefined;
  }
  const record = observability as Record<string, unknown>;
  const endpoint = record.endpoint;
  if (typeof endpoint !== "string" || endpoint.length === 0) {
    return undefined;
  }
  const parts = [`phoenix ${endpoint}`];
  const appUrl = phoenixAppBaseUrl(endpoint);
  if (appUrl !== undefined) {
    parts.push(`app ${appUrl}`);
  }
  if (record.includeSensitiveData === true) {
    parts.push(ui.style.yellow(describeSensitiveDataExportWarning(endpoint)));
  }
  if (typeof record.lastWarning === "string" && record.lastWarning.length > 0) {
    parts.push(`last warning: ${record.lastWarning}`);
  }
  if (typeof record.lastError === "string" && record.lastError.length > 0) {
    parts.push(`last error: ${record.lastError}`);
  }
  parts.push("JSONL artifacts remain local");
  return parts.join("; ");
}

function describeSandboxMetadata(source: TraceSourceListItem): string[] {
  const sandbox = source.metadata?.sandbox;
  if (sandbox === null || typeof sandbox !== "object") {
    return [];
  }
  const record = sandbox as Record<string, unknown>;
  const effective = stringField(record, "effective") ?? "unknown";
  const engine = stringField(record, "engine") ?? "none";
  const engineAvailability = record.engineAvailable === true
    ? "present"
    : record.engineAvailable === false
      ? "absent"
      : "not checked";
  const fallback = stringField(record, "fallback");
  const fallbackActive = record.fallbackActive === true ? "yes" : "no";
  const summary = [
    `effective: ${effective}`,
    `engine: ${engine} (${engineAvailability})`,
    ...(fallback === undefined ? [] : [`fallback: ${fallback}`]),
    `fallback active: ${fallbackActive}`,
  ].join("; ");
  return [
    summary,
    ...stringFieldAsList(record, "detail"),
    ...stringFieldAsList(record, "warning").map((warning) => ui.style.yellow(warning)),
  ];
}

function describeSessionMetadata(source: TraceSourceListItem, nowMs: number): string[] {
  const session = source.metadata?.session;
  if (session === null || typeof session !== "object") {
    return [];
  }
  const record = session as Record<string, unknown>;
  const bucket = stringField(record, "currentBucketId");
  if (bucket === undefined) {
    return [];
  }
  const current = sessionSnapshotRecord(record, bucket);
  const hasSnapshot = Array.isArray(record.snapshot);
  const state = current === undefined
    ? hasSnapshot ? "cold" : stringField(record, "state") ?? stringField(record, "status") ?? "cold"
    : "warm";
  const event = stringField(record, "event");
  const providerSessionId = current?.providerSessionId ?? stringField(record, "providerSessionId");
  const nextRolloverAt = stringField(record, "nextRolloverAt");
  const reason = stringField(record, "reason");
  const createdAt = current?.createdAt ?? numberField(record, "createdAt");
  const summary = [
    `bucket: ${bucket}`,
    `state: ${state}`,
    `age: ${formatSessionAge(createdAt, nowMs)}`,
    ...(event === undefined ? [] : [`event: ${event}`]),
    ...(providerSessionId === undefined ? [] : [`provider: ${providerSessionId}`]),
    ...(nextRolloverAt === undefined ? [] : [`next rollover: ${nextRolloverAt}`]),
    ...(reason === undefined ? [] : [`reason: ${reason}`]),
  ];
  return [summary.join("; ")];
}

function sessionSnapshotRecord(
  record: Record<string, unknown>,
  bucket: string,
): { providerSessionId: string; createdAt: number } | undefined {
  const snapshot = record.snapshot;
  if (!Array.isArray(snapshot)) {
    return undefined;
  }
  for (const item of snapshot) {
    if (item === null || typeof item !== "object") {
      continue;
    }
    const entry = item as Record<string, unknown>;
    if (stringField(entry, "conversationId") !== bucket) {
      continue;
    }
    const providerSessionId = stringField(entry, "providerSessionId");
    const createdAt = numberField(entry, "createdAt");
    if (providerSessionId !== undefined && createdAt !== undefined) {
      return { providerSessionId, createdAt };
    }
  }
  return undefined;
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function formatSessionAge(createdAt: number | undefined, nowMs: number): string {
  if (createdAt === undefined) {
    return "unknown";
  }
  const elapsedSeconds = Math.max(0, Math.floor((nowMs - createdAt) / 1000));
  if (elapsedSeconds < 60) {
    return `${elapsedSeconds}s`;
  }
  const elapsedMinutes = Math.floor(elapsedSeconds / 60);
  if (elapsedMinutes < 60) {
    return `${elapsedMinutes}m`;
  }
  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 48) {
    return `${elapsedHours}h`;
  }
  return `${Math.floor(elapsedHours / 24)}d`;
}

function stringFieldAsList(record: Record<string, unknown>, key: string): string[] {
  const value = stringField(record, key);
  return value === undefined ? [] : [value];
}

/** ` --config <path>` when a non-default config is in play, else empty. */
function configFlag(target: InstanceTarget): string {
  const defaultPath = resolve(target.cwd, "mono-agent.config.json");
  return target.configPath === defaultPath ? "" : ` --config ${shellCommandArgument(target.configPath)}`;
}

function commandFlags(target: InstanceTarget): string {
  return `${configFlag(target)}${target.envFile === undefined ? "" : ` --env-file ${shellCommandArgument(target.envFile)}`}`;
}

function shellCommandArgument(value: string): string {
  return /^[a-zA-Z0-9_./:@%+=,-]+$/u.test(value) ? value : `'${value.replaceAll("'", `'"'"'`)}'`;
}

export interface FilesystemLifecycleLockOptions {
  readonly pid?: number;
  readonly now?: () => number;
  /**
   * Permanent pre-v0.9.0 owner-record compatibility. v0.9.0 and later write
   * process incarnation identity into every lifecycle-lock owner record.
   */
  readonly isProcessAlive?: (pid: number) => boolean;
  readonly processIncarnation?: ProcessIncarnation;
  readonly isSameProcessIncarnation?: SameProcessIncarnation;
  readonly ownerlessGraceMs?: number;
  readonly randomToken?: () => string;
  /** Deterministic seam immediately after the final identity check. */
  readonly beforeStaleLockRename?: () => Promise<void>;
}

export async function acquireFilesystemLifecycleLock(
  target: InstanceTarget,
  options: FilesystemLifecycleLockOptions = {},
): Promise<(() => Promise<void>) | undefined> {
  const pid = options.pid ?? process.pid;
  const now = options.now ?? (() => Date.now());
  const isProcessAlive = options.isProcessAlive ?? processIsAlive;
  const ownerlessGraceMs = options.ownerlessGraceMs ?? 5 * 60_000;
  const randomToken = options.randomToken ?? randomUUID;
  validateOwnerPrivateLockInputs("Lifecycle lock", pid, ownerlessGraceMs);
  const managedRoot = dirname(target.paths.logDir);
  const locksDir = resolve(managedRoot, "locks");
  for (const path of [managedRoot, locksDir]) {
    await ensureOwnerPrivateLaunchdDirectory(path);
  }

  const lockDir = resolve(locksDir, `${target.label}.lock`);
  const held = await acquireOwnerPrivateLock({
    path: lockDir,
    label: "Lifecycle lock",
    schemaTag: "mono-agent.filesystem-lifecycle-lock.v1",
    ownerlessGraceMs,
    maxAcquireAttempts: 4,
    pid,
    now,
    randomToken,
    ...(options.processIncarnation === undefined ? {} : { processIncarnation: options.processIncarnation }),
    ...(options.isSameProcessIncarnation === undefined
      ? {}
      : { isSameProcessIncarnation: options.isSameProcessIncarnation }),
    parseLegacyOwner: (record) => {
      if (typeof record.pid !== "number" || !Number.isSafeInteger(record.pid) || record.pid <= 0) return undefined;
      const incarnation = processIncarnationFromJson(record.incarnation);
      return {
        pid: record.pid,
        ...(incarnation === undefined ? {} : { incarnation }),
      };
    },
    // Permanent pre-v0.9.0 compatibility: a skipped-version upgrade can
    // encounter crash debris without incarnation identity indefinitely.
    // All owner records written since v0.9.0 use the stronger shared schema.
    allowCurrentUserLegacyOwnerMode: true,
    isLegacyProcessAlive: isProcessAlive,
    invalidOwner: "ownerless",
    livenessError: () => "assume-live",
    ...(options.beforeStaleLockRename === undefined
      ? {}
      : { beforeStaleRename: options.beforeStaleLockRename }),
    staleRace: "return",
    stalePath: ({ now: staleAt, pid: stalePid, token }) =>
      resolve(locksDir, `${target.label}.stale-${staleAt}-${stalePid}-${token}`),
    releasedPath: ({ now: releasedAt, pid: ownerPid, token }) =>
      resolve(locksDir, `${target.label}.released-${releasedAt}-${ownerPid}-${token}`),
    abandonedPath: ({ now: abandonedAt, pid: ownerPid, token }) =>
      resolve(locksDir, `${target.label}.abandoned-${abandonedAt}-${ownerPid}-${token}`),
  });
  return held === undefined ? undefined : () => held.release();
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isErrno(error, "EPERM");
  }
}

async function probeTuiEndpoint(source: TraceSourceListItem): Promise<boolean> {
  const baseUrl = tuiEndpoint(source);
  if (baseUrl === undefined) return false;
  let url: URL;
  try {
    url = new URL(`${baseUrl.replace(/\/+$/u, "")}/v1/info`);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" || !isLoopbackHostname(url.hostname)) return false;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
    // Authenticated adapters return 401/403 without the secret. That still
    // proves the advertised loopback listener is reachable; an open endpoint
    // additionally proves it belongs to the expected worker pid.
    if (response.status === 401 || response.status === 403) return true;
    if (!response.ok) return false;
    const body = await response.json() as { pid?: unknown };
    return typeof source.pid === "number" && body.pid === source.pid;
  } catch {
    return false;
  }
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "::1" || hostname === "localhost";
}

function tuiEndpoint(source: TraceSourceListItem): string | undefined {
  const channels = source.metadata?.channels;
  if (channels === null || typeof channels !== "object") return undefined;
  const tui = (channels as Record<string, unknown>).tui;
  if (tui === null || typeof tui !== "object") return undefined;
  const record = tui as Record<string, unknown>;
  return record.kind === "running" && typeof record.baseUrl === "string" && record.baseUrl.trim().length > 0
    ? record.baseUrl
    : undefined;
}

function formatChannels(source: TraceSourceListItem): string[] {
  const channels = source.metadata?.channels;
  if (channels === null || typeof channels !== "object") {
    return [];
  }
  return Object.entries(channels as Record<string, unknown>).map(([id, value]) => {
    const { kind, text } = describeChannel(value);
    return `  ${ui.channelBadge(kind)}${ui.style.bold(id.padEnd(11))} ${text}`;
  });
}

export function describeChannel(value: unknown): { kind: string; text: string } {
  if (value === null || typeof value !== "object") {
    return { kind: "unknown", text: formatChannelFactValue(value) };
  }
  const record = value as Record<string, unknown>;
  const kind = typeof record.kind === "string" ? record.kind : "unknown";
  if (kind === "running") {
    // Route every fact through the shared recursive formatter so a nested object
    // (e.g. the webhook `invokeUrls` map) never renders as `[object Object]` —
    // the E4 bug that persisted on this backgrounded-start summary path after the
    // `status`-line render was fixed.
    const facts = Object.entries(record)
      .filter(([key]) => key !== "kind")
      .map(([key, fact]) => `${key}=${formatChannelFactValue(fact)}`)
      .join(" ");
    return { kind, text: facts.length === 0 ? "running" : `running (${facts})` };
  }
  const reason = typeof record.reason === "string" ? record.reason : "";
  return { kind, text: reason.length === 0 ? kind : `${kind}: ${reason}` };
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === code;
}
